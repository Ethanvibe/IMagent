import { createRequire } from 'node:module'

const _require = createRequire(import.meta.url)

const DEFAULT_MODEL = 'mimo-v1'
const DEFAULT_BASE_URL = 'https://api.xiaomi.com/v1'
const DEFAULT_PROMPT = `你是一个智能聊天助手。根据提供的聊天内容，生成合适的回复。

## 规则
1. 只输出回复文字，不要解释、不要添加多余内容
2. 防自我循环：如果最后一条消息是"我"发送的（右侧气泡），必须输出 [SKIP]
3. 如果最新消息是系统消息、群公告、红包、转账等非对话消息，输出 [SKIP]
4. 如果无法判断是否需要回复，输出 [SKIP]
5. 回复要自然、口语化，像真人对话`

const TEXT_MODE_PROMPT = `你是一个智能聊天助手。根据提供的聊天文字内容，生成合适的回复。

聊天内容中，消息以"对方："或"我："为前缀标注：
- "对方："开头 = 联系人发来的消息（显示在聊天窗口左侧）
- "我："开头 = 我自己发出的消息（显示在聊天窗口右侧）

## 规则
1. 只输出回复文字，不要解释、不要添加多余内容
2. 针对最后一条"对方："消息生成自然得体的回复
3. 如果最后一条消息是"我："开头的，说明是我自己说的，输出 [SKIP]
4. 如果最后一条消息是系统消息、群公告、红包、转账等非对话内容，输出 [SKIP]
5. 回复要自然、口语化，像真人对话，简短即可
6. 如果不确定是否需要回复，就生成一条简短友好的回复`

export const manifest = {
  id: 'xiaomi',
  apiVersion: 1
}

export function createProvider(context) {
  const providerConfig = context && context.providerConfig ? context.providerConfig : {}

  return {
    async *run(input) {
      if (!input || !input.screenshot) {
        yield { type: 'skip' }
        return
      }

      const apiKey = providerConfig.apiKey
      if (!apiKey) {
        yield { type: 'error', error: '聊天服务缺少接口密钥' }
        return
      }

      yield { type: 'thinking', content: '正在分析聊天内容...' }

      try {
        const reply = await requestReply({
          screenshot: input.screenshot,
          ocrText: input.ocrText,
          apiKey,
          model: providerConfig.model || DEFAULT_MODEL,
          baseURL: providerConfig.baseURL || DEFAULT_BASE_URL,
          systemPrompt: providerConfig.systemPrompt || DEFAULT_PROMPT,
          obsidianPath: input.obsidianPath
        })

        if (!reply || reply.trim() === '[SKIP]') {
          yield { type: 'skip' }
          return
        }

        yield { type: 'reply_text', content: reply.trim() }
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        if (context && context.host && typeof context.host.log === 'function') {
          context.host.log(`provider error: ${message}`)
        }
        yield { type: 'error', error: message || '聊天服务调用失败' }
      }
    }
  }
}

function extractChatMessage(ocrText) {
  if (!ocrText) return ''
  const lines = ocrText.split('\n').map(l => l.trim()).filter(l => l.length > 0)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('对方：')) return lines[i].slice(3).trim()
  }
  return lines[lines.length - 1] || ''
}

function extractKeywords(text) {
  if (!text) return []
  const cleaned = text.replace(/[，。！？、；：""''（）【】《》\s,.!?;:'"()\[\]{}<>]/g, ' ')
  const tokens = cleaned.split(/\s+/).filter(t => t.length >= 2 && !/^\d+$/.test(t))
  const stopWords = new Set(['的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这'])
  const keywords = new Set()
  for (const token of tokens) {
    if (token.length >= 2 && !stopWords.has(token)) keywords.add(token)
    if (token.length > 2) {
      for (let i = 0; i < token.length - 1; i++) keywords.add(token.slice(i, i + 2))
    }
  }
  return [...keywords].slice(0, 15)
}

function searchObsidianKnowledge(obsidianPath, chatMessage) {
  if (!obsidianPath || !chatMessage) return ''
  obsidianPath = obsidianPath.trim()
  console.log(`[Knowledge] === searchKnowledge START === path: "${obsidianPath}", query: "${chatMessage.slice(0, 100)}"`)
  try {
    let fs, pathModule
    try {
      fs = _require('fs')
      pathModule = _require('path')
    } catch (loadErr) {
      console.error('[Knowledge] FAILED to load fs/path:', loadErr.message)
      return ''
    }

    if (!fs.existsSync(obsidianPath)) {
      console.warn(`[Knowledge] path does not exist: "${obsidianPath}"`)
      return ''
    }

    const pathStat = fs.statSync(obsidianPath)

    // Handle single .md file directly
    if (pathStat.isFile() && obsidianPath.toLowerCase().endsWith('.md')) {
      try {
        const content = fs.readFileSync(obsidianPath, 'utf-8')
        const fileName = pathModule.basename(obsidianPath)
        console.log(`[Knowledge] single file mode: "${fileName}" (${content.length} chars)`)
        if (!content.trim()) return ''
        const truncated = content.slice(0, 2000)
        return `\n\n## 知识库检索结果（来自 Obsidian 笔记 - ${fileName}）\n\n${truncated}\n\n---\n\n**重要**：请优先参考上方知识库中的内容来回复。如果知识库中有与对方问题相关的信息，请使用知识库的内容作答。如果知识库中没有相关信息，则根据聊天内容正常回复。`
      } catch (e) {
        console.error('[Knowledge] single file read error:', e.message)
        return ''
      }
    }

    if (!pathStat.isDirectory()) {
      console.warn(`[Knowledge] path is neither a file nor directory: "${obsidianPath}"`)
      return ''
    }

    function findMdFiles(dir, depth) {
      if (depth > 5) return []
      let results = []
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          const full = pathModule.join(dir, entry.name)
          if (entry.isDirectory() && !entry.name.startsWith('.')) {
            results = results.concat(findMdFiles(full, depth + 1))
          } else if (entry.isFile() && entry.name.endsWith('.md')) {
            results.push({ path: full, name: entry.name })
          }
        }
      } catch (e) { /* skip */ }
      return results
    }

    const allFiles = findMdFiles(obsidianPath, 0)
    console.log(`[Knowledge] found ${allFiles.length} .md files`)
    if (allFiles.length === 0) return ''

    const keywords = extractKeywords(chatMessage)
    console.log(`[Knowledge] keywords: [${keywords.join(', ')}]`)
    if (keywords.length === 0) return ''

    const scored = []
    for (const file of allFiles) {
      try {
        const content = fs.readFileSync(file.path, 'utf-8')
        const lowerContent = content.toLowerCase()
        let score = 0
        const matchedKeywords = []
        for (const kw of keywords) {
          const count = (lowerContent.match(new RegExp(kw.toLowerCase(), 'g')) || []).length
          if (count > 0) {
            score += count
            matchedKeywords.push(kw)
          }
        }
        if (score > 0) scored.push({ path: file.path, name: file.name, score, content, matchedKeywords })
      } catch { /* skip */ }
    }

    if (scored.length === 0) {
      console.log('[Knowledge] no matching files found')
      return ''
    }

    scored.sort((a, b) => b.score - a.score)
    const topFiles = scored.slice(0, 5)
    console.log(`[Knowledge] top matches: ${topFiles.map(f => `${f.name}(${f.score},[${f.matchedKeywords.join(',')}])`).join(', ')}`)

    let context = ''
    for (const file of topFiles) {
      const content = file.content.slice(0, 800)
      context += `\n### ${file.name} (相关度: ${file.score})\n${content}\n`
      if (context.length > 3000) break
    }

    if (!context) return ''
    console.log(`[Knowledge] === searchKnowledge END === ${context.length} chars from ${topFiles.length} files`)
    return `\n\n## 知识库检索结果（来自 Obsidian 笔记）\n${context}\n\n---\n\n**重要**：请优先参考上方知识库中的内容来回复。如果知识库中有与对方问题相关的信息，请使用知识库的内容作答。如果知识库中没有相关信息，则根据聊天内容正常回复。`
  } catch (e) {
    console.error('[Knowledge] searchObsidianKnowledge CRASHED:', e.message)
    return ''
  }
}

async function extractMessageFromScreenshot(screenshot, apiKey, model, baseURL) {
  try {
    console.log('[Provider] extracting message from screenshot for KB search...')
    const imageUrl = normalizeImageUrl(screenshot)
    const body = {
      model,
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: imageUrl } },
        { type: 'text', text: '请只提取截图中聊天窗口里对方（左侧气泡）发来的最后一条消息的文字内容。只输出消息文字，不要任何解释、前缀或引号。如果看不到对方消息，回复"无"。' }
      ]}],
      stream: false
    }
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!response.ok) {
      console.warn(`[Provider] message extraction failed: ${response.status}`)
      return ''
    }
    const json = await response.json()
    const content = json?.choices?.[0]?.message?.content || ''
    const result = content.trim()
    if (result === '无' || result.length < 2) return ''
    console.log(`[Provider] extracted message: "${result.slice(0, 100)}"`)
    return result
  } catch (e) {
    console.warn('[Provider] extractMessageFromScreenshot error:', e.message)
    return ''
  }
}

async function requestReply({ screenshot, ocrText, apiKey, model, baseURL, systemPrompt, obsidianPath }) {
  const prompt = systemPrompt || DEFAULT_PROMPT
  if (obsidianPath) console.log(`[Provider] obsidianPath received: "${obsidianPath}"`)

  // RAG-style knowledge base search
  let chatMessage = extractChatMessage(ocrText)

  // If OCR didn't provide text, use vision API to extract message for KB search
  if (!chatMessage && obsidianPath) {
    chatMessage = await extractMessageFromScreenshot(screenshot, apiKey, model, baseURL)
  }

  let knowledgeContext = ''
  if (obsidianPath && chatMessage) {
    try {
      knowledgeContext = searchObsidianKnowledge(obsidianPath, chatMessage)
      if (knowledgeContext) {
        console.log(`[Provider] Knowledge base: ${knowledgeContext.length} chars of matching content`)
      } else {
        console.log(`[Provider] Knowledge base: no matching content for "${chatMessage.slice(0, 50)}"`)
      }
    } catch (e) {
      console.error('[Provider] knowledge search error:', e.message)
    }
  } else if (obsidianPath && !chatMessage) {
    console.log('[Provider] KB search skipped: no chat message available')
  }

  // Always try image mode first
  const userContent = [
    { type: 'image_url', image_url: { url: normalizeImageUrl(screenshot) } },
    { type: 'text', text: '请根据截图中聊天窗口的最新消息进行回复。注意：左侧气泡是对方发的消息，右侧气泡是我发的消息。' }
  ]

  const body = { model, messages: [{ role: 'system', content: prompt + knowledgeContext }, { role: 'user', content: userContent }], stream: false }

  let response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

  // Fallback: if image rejected (400)
  if (!response.ok && response.status === 400) {
    if (ocrText) {
      console.log(`[Provider] image rejected, fallback to OCR text (${ocrText.length} chars)`)
      const fallbackBody = {
        model,
        messages: [
          { role: 'system', content: TEXT_MODE_PROMPT + knowledgeContext },
          { role: 'user', content: `以下是从聊天窗口截图中识别出的文字内容：\n\n${ocrText}\n\n请根据以上聊天内容生成回复。` }
        ],
        stream: false
      }
      response = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(fallbackBody)
      })
    } else {
      console.log('[Provider] image rejected, no OCR text, using generic fallback')
      const fallbackBody = {
        model,
        messages: [
          { role: 'system', content: TEXT_MODE_PROMPT + knowledgeContext },
          { role: 'user', content: '请生成一条自然、友好的简短回复消息，用于日常聊天场景。不需要针对特定内容，只需要一条通用的友好回复。' }
        ],
        stream: false
      }
      response = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(fallbackBody)
      })
    }
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    throw new Error(`API request failed: ${response.status} ${response.statusText} ${errText.slice(0, 200)}`)
  }

  const json = await response.json()
  return json && json.choices && json.choices[0] && json.choices[0].message
    ? json.choices[0].message.content || ''
    : ''
}

function normalizeImageUrl(screenshot) {
  const rawBase64 = stripBase64Prefix(screenshot)
  if (rawBase64.startsWith('http')) return rawBase64
  return `data:image/png;base64,${rawBase64}`
}

function stripBase64Prefix(base64) {
  const idx = String(base64).indexOf('base64,')
  return idx !== -1 ? String(base64).slice(idx + 'base64,'.length) : String(base64)
}
