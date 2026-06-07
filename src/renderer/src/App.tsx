import { useState, useCallback, useRef, useEffect } from 'react'
import './index.css'

/* ─── Types ─── */

interface LogEntry {
  time: string
  type: 'thinking' | 'reply' | 'skip' | 'error'
  content: string
}

type EngineStatus = 'idle' | 'running' | 'error'
type AppType = 'wechat' | 'wework' | 'dingtalk' | 'lark' | 'slack' | 'telegram' | 'generic'
type CaptureStrategy = 'auto' | 'vlm' | 'box-select'

interface ScreenRect { x: number; y: number; width: number; height: number }
interface BoxRegions {
  contactList: ScreenRect
  chatMain: ScreenRect
  inputBox: ScreenRect
  unreadIndicator: ScreenRect | null
  displayId?: number
  scaleFactor?: number
  capturedAt: number
}

interface InstalledProviderInfo {
  id: string; name: string; version: string; entryFile: string; installedAt: string
}

interface AppSettings {
  locale: 'zh' | 'en'
  appType: AppType
  vision: { apiKey: string }
  chatProvider: {
    manifestUrl: string
    installed: InstalledProviderInfo | null
    config: Record<string, any>
  }
  defaultCaptureStrategy: CaptureStrategy
  capture: Partial<Record<AppType, { strategy: CaptureStrategy; regions: BoxRegions | null }>>
  obsidianPath?: string
  friendList?: string
  replyDelay?: number
}

/* ─── Provider definitions ─── */

interface ProviderDef {
  id: string; name: string; desc: string
  baseURL: string; defaultModel: string
  keyPlaceholder: string
}

const PROVIDERS: ProviderDef[] = [
  {
    id: 'deepseek', name: 'DeepSeek',
    desc: 'deepseek.com 提供的大语言模型',
    baseURL: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-v4-pro',
    keyPlaceholder: 'sk-...'
  },
  {
    id: 'minimax', name: 'MiniMax',
    desc: 'MiniMax 大语言模型',
    baseURL: 'https://api.minimax.chat/v1',
    defaultModel: 'MiniMax-Text-01',
    keyPlaceholder: 'eyJ...'
  },
  {
    id: 'xiaomi', name: '小米 MiMo',
    desc: '小米大模型',
    baseURL: 'https://api.xiaomi.com/v1',
    defaultModel: 'mimo-v1',
    keyPlaceholder: '小米 API Key'
  },
  {
    id: 'volcengine-ark', name: '豆包 Seed',
    desc: '火山方舟 (字节跳动)',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-seed-2-0-lite-260215',
    keyPlaceholder: '火山方舟 API Key'
  }
]

const APP_TYPE_LABELS: Record<AppType, string> = {
  wechat: '微信', wework: '企业微信', dingtalk: '钉钉',
  lark: '飞书', slack: 'Slack', telegram: 'Telegram', generic: '其他'
}

const DEFAULT_PROMPT = `你是一个智能聊天助手。根据聊天内容，生成合适的回复。

规则：
1. 只输出回复文字，不要解释
2. 如果是系统消息、红包等非对话内容，输出 [SKIP]
3. 回复要自然、口语化，像真人对话
4. 不确定时，生成一条简短友好的回复`

/* ─── Icons ─── */
const PlayIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v14l11-7-11-7z" /></svg>
const StopIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>

/* ─── App ─── */

function App() {
  const isSettingsWindow = new URLSearchParams(window.location.search).get('window') === 'settings'
  const [status, setStatus] = useState<EngineStatus>('idle')
  const [activated, setActivated] = useState<boolean | null>(null) // null = checking

  useEffect(() => {
    const cleanup = window.electron?.on('engine:state', (data: { status: 'running' | 'idle' }) => {
      setStatus(data.status === 'running' ? 'running' : 'idle')
    })
    return cleanup
  }, [])

  // 启动时检查激活状态
  useEffect(() => {
    void (async () => {
      const result = await window.electron?.invoke('license:status')
      setActivated(!!result?.activated)
    })()
  }, [])

  // 还在检查中
  if (activated === null) {
    return <div className="app"><div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#64748b' }}>加载中...</div></div>
  }

  // 未激活 → 显示激活界面
  if (!activated) {
    return <div className="app"><ActivationScreen onActivated={() => setActivated(true)} /><Toast /></div>
  }

  if (isSettingsWindow) {
    return <div className="app settings-window"><MainPage status={status} setStatus={setStatus} /><Toast /></div>
  }

  return (
    <div className="app">
      <MainPage status={status} setStatus={setStatus} />
      <Toast />
    </div>
  )
}

/* ─── Activation Screen ─── */

function ActivationScreen({ onActivated }: { onActivated: () => void }) {
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleActivate = useCallback(async () => {
    if (!code.trim()) { setError('请输入激活码'); return }
    setLoading(true)
    setError('')
    try {
      const result = await window.electron?.invoke('license:activate', code.trim())
      if (result?.success) {
        showToast('激活成功', 'success')
        onActivated()
      } else {
        setError(result?.error || '激活码无效')
      }
    } catch (err: any) {
      setError('激活失败，请重试')
    } finally {
      setLoading(false)
    }
  }, [code, onActivated])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', padding: 32 }}>
      <div style={{
        width: 48, height: 48, borderRadius: 14,
        background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 22, fontWeight: 800, color: '#fff', marginBottom: 20
      }}>1</div>
      <h2 style={{ fontSize: 20, fontWeight: 700, color: '#e2e8f0', marginBottom: 6 }}>欢迎使用 1peng</h2>
      <p style={{ fontSize: 13, color: '#64748b', marginBottom: 28, textAlign: 'center' }}>请输入激活码以开始使用</p>
      <div style={{ width: '100%', maxWidth: 320 }}>
        <input
          className="form-input"
          type="text"
          value={code}
          onChange={(e) => { setCode(e.target.value.toUpperCase()); setError('') }}
          placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXX"
          disabled={loading}
          onKeyDown={(e) => { if (e.key === 'Enter') handleActivate() }}
          style={{ textAlign: 'center', fontFamily: 'monospace', fontSize: 13, letterSpacing: 1, marginBottom: 12 }}
        />
        {error && <div style={{ fontSize: 12, color: '#ef4444', textAlign: 'center', marginBottom: 8 }}>{error}</div>}
        <button
          className="btn btn-primary"
          onClick={handleActivate}
          disabled={loading || !code.trim()}
          style={{ width: '100%', padding: '10px 0', fontSize: 14, justifyContent: 'center' }}
        >
          {loading ? '验证中...' : '激活'}
        </button>
      </div>
    </div>
  )
}

/* ─── Single unified page ─── */

function MainPage({ status, setStatus }: { status: EngineStatus; setStatus: (s: EngineStatus) => void }) {
  /* — form state — */
  const [providerId, setProviderId] = useState('deepseek')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_PROMPT)
  const [obsidianPath, setObsidianPath] = useState('')
  const [friendList, setFriendList] = useState('')
  const [replyDelay, setReplyDelay] = useState(3)
  const [appType, setAppType] = useState<AppType>('wechat')
  const [regions, setRegions] = useState<BoxRegions | null>(null)
  const [openingWizard, setOpeningWizard] = useState(false)

  /* — logs — */
  const [logs, setLogs] = useState<LogEntry[]>([])
  const logRef = useRef<HTMLDivElement>(null)

  const provider = PROVIDERS.find((p) => p.id === providerId) || PROVIDERS[0]

  /* — load settings on mount — */
  useEffect(() => {
    void (async () => {
      const s = (await window.electron?.invoke('settings:getAll')) as AppSettings | undefined
      if (!s) return
      setAppType(s.appType || 'wechat')
      setObsidianPath(s.obsidianPath || '')
      setFriendList(s.friendList || '')
      setReplyDelay(s.replyDelay ?? 3)
      // restore provider
      const activeId = s.chatProvider.manifestUrl?.startsWith('builtin://')
        ? s.chatProvider.manifestUrl.slice('builtin://'.length)
        : s.chatProvider.installed?.id || 'deepseek'
      setProviderId(activeId)
      const prov = PROVIDERS.find((p) => p.id === activeId) || PROVIDERS[0]
      setModel(s.chatProvider.config?.model || prov.defaultModel)
      setBaseURL(s.chatProvider.config?.baseURL || prov.baseURL)
      setApiKey(s.chatProvider.config?.apiKey || s.vision?.apiKey || '')
      setSystemPrompt(s.chatProvider.config?.systemPrompt || DEFAULT_PROMPT)
      // load capture regions
      const r = (await window.electron?.invoke('capture:getRegions', s.appType || 'wechat')) as BoxRegions | null
      setRegions(r ?? null)
    })()
  }, [])

  /* — log listener — */
  const addLog = useCallback((type: LogEntry['type'], content: string) => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false })
    setLogs((prev) => [...prev.slice(-99), { time, type, content }])
  }, [])

  useEffect(() => {
    const cleanup = window.electron?.on('engine:log', (data: { type: string; content: string }) => {
      addLog(data.type as LogEntry['type'], data.content)
    })
    return cleanup
  }, [addLog])

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }, [logs])

  useEffect(() => {
    const cleanup = window.electron?.on(
      'capture:regions-updated',
      (data: { appType: AppType; regions: BoxRegions | null }) => {
        if (data.appType === appType) setRegions(data.regions)
      }
    )
    return cleanup
  }, [appType])

  /* — provider change — */
  const handleProviderChange = useCallback((id: string) => {
    setProviderId(id)
    const prov = PROVIDERS.find((p) => p.id === id) || PROVIDERS[0]
    setModel(prov.defaultModel)
    setBaseURL(prov.baseURL)
  }, [])

  /* — save config — */
  const saveConfig = useCallback(async () => {
    await window.electron?.invoke('settings:set', {
      vision: { apiKey },
      chatProvider: {
        manifestUrl: `builtin://${providerId}`,
        installed: null,
        config: { apiKey, model, baseURL, systemPrompt }
      },
      obsidianPath,
      friendList,
      replyDelay,
      appType
    })
    await window.electron?.invoke('engine:updateConfig',
      await window.electron?.invoke('settings:getAll')
    )
    showToast('配置已保存', 'success')
  }, [apiKey, model, baseURL, systemPrompt, obsidianPath, friendList, replyDelay, providerId, appType])

  /* — start / stop — */
  const handleStart = useCallback(async () => {
    if (!apiKey) { showToast('请先填写 API 密钥', 'error'); return }
    if (!baseURL) { showToast('请先填写接口地址', 'error'); return }
    if (!model) { showToast('请先填写模型名称', 'error'); return }
    await saveConfig()
    const result = await window.electron?.invoke('engine:start',
      await window.electron?.invoke('settings:getAll')
    )
    if (result?.success) {
      setStatus('running')
      showToast('已启动', 'success')
    } else {
      setStatus('error')
      showToast(result?.error || '启动失败', 'error')
    }
  }, [apiKey, saveConfig, setStatus])

  const handleStop = useCallback(async () => {
    await window.electron?.invoke('engine:stop')
    setStatus('idle')
    showToast('已停止', 'success')
  }, [setStatus])

  /* — box-select wizard — */
  const handleOpenWizard = useCallback(async () => {
    setOpeningWizard(true)
    try {
      const result = (await window.electron?.invoke('capture:openSetupWizard', { appType })) as
        { success: boolean; reason?: string; regions?: BoxRegions } | undefined
      if (result?.success && result.regions) {
        setRegions(result.regions)
        showToast('已保存框选区域', 'success')
      } else {
        showToast('框选已取消', 'error')
      }
    } finally { setOpeningWizard(false) }
  }, [appType])

  const running = status === 'running'

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ padding: '18px 20px 10px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8,
          background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 16, fontWeight: 700, color: '#fff'
        }}>1</div>
        <span style={{ fontSize: 18, fontWeight: 700, color: '#e2e8f0' }}>1peng</span>
        <span style={{ fontSize: 12, color: '#64748b', marginLeft: 'auto' }}>
          {running ? '● 运行中' : '○ 待机'}
        </span>
      </div>

      {/* Scrollable config area */}
      <div style={{ flex: 1, overflow: 'auto', padding: '0 20px 8px' }}>
        {/* Quick-fill provider chips */}
        <div style={{ marginBottom: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {PROVIDERS.map((p) => (
            <button key={p.id} onClick={() => {
              if (!running) handleProviderChange(p.id)
            }} style={{
              padding: '3px 10px', fontSize: 11, borderRadius: 12, border: 'none', cursor: running ? 'default' : 'pointer',
              background: providerId === p.id ? 'rgba(99,102,241,0.3)' : 'rgba(255,255,255,0.06)',
              color: providerId === p.id ? '#a5b4fc' : '#94a3b8',
              transition: 'all 0.15s'
            }}>{p.name}</button>
          ))}
          <span style={{ fontSize: 11, color: '#475569', alignSelf: 'center', marginLeft: 4 }}>点击快速填入</span>
        </div>

        {/* API Key */}
        <div className="card" style={{ marginBottom: 8 }}>
          <div className="card-title">API 密钥</div>
          <input className="form-input" type="password" value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={provider.keyPlaceholder || '输入你的 API Key'} disabled={running} autoComplete="off" />
        </div>

        {/* Base URL */}
        <div className="card" style={{ marginBottom: 8 }}>
          <div className="card-title">接口地址</div>
          <input className="form-input" type="text" value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
            placeholder="https://api.deepseek.com/v1" disabled={running} />
        </div>

        {/* Model */}
        <div className="card" style={{ marginBottom: 8 }}>
          <div className="card-title">模型名称</div>
          <input className="form-input" type="text" value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="例如 deepseek-chat" disabled={running} />
        </div>

        {/* Target app + box-select */}
        <div className="card" style={{ marginBottom: 8 }}>
          <div className="card-title">聊天窗口</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select className="form-input" value={appType}
              onChange={(e) => {
                const next = e.target.value as AppType
                setAppType(next)
                window.electron?.invoke('settings:set', { appType: next })
                window.electron?.invoke('capture:getRegions', next).then(
                  (r: BoxRegions | null | undefined) => setRegions(r ?? null)
                )
              }} disabled={running || openingWizard} style={{ flex: 1 }}>
              {(Object.keys(APP_TYPE_LABELS) as AppType[]).map((t) =>
                <option key={t} value={t}>{APP_TYPE_LABELS[t]}</option>
              )}
            </select>
            <button className="btn btn-primary" onClick={handleOpenWizard}
              disabled={running || openingWizard} style={{ whiteSpace: 'nowrap', fontSize: 12, padding: '4px 12px' }}>
              {openingWizard ? '打开中...' : regions ? '重新框选' : '框选区域'}
            </button>
          </div>
          <div className="form-hint" style={{
            marginTop: 6, display: 'flex', alignItems: 'center', gap: 6,
            color: regions ? '#94a3b8' : '#fbbf24', fontSize: 11
          }}>
            <span style={{
              display: 'inline-block', width: 7, height: 7, borderRadius: 999,
              background: regions ? '#34d399' : '#fbbf24'
            }} />
            {regions ? '已框选完成' : '请先框选聊天窗口区域'}
          </div>
        </div>

        {/* Advanced: prompt + Obsidian */}
        <details style={{ marginBottom: 8 }}>
          <summary style={{ fontSize: 12, color: '#64748b', cursor: 'pointer', padding: '4px 0', userSelect: 'none' }}>
            高级设置（延迟回复、提示词、知识库）
          </summary>
          <div style={{ marginTop: 6 }}>
            <div className="card" style={{ marginBottom: 8 }}>
              <div className="card-title">延迟回复（秒）</div>
              <input className="form-input" type="number" min={0} max={30} value={replyDelay}
                onChange={(e) => setReplyDelay(Number(e.target.value) || 0)}
                disabled={running} style={{ width: 80 }} />
              <div className="form-hint" style={{ color: '#64748b', marginTop: 4, fontSize: 11 }}>
                生成回复后等待几秒再发送，更像真人。0 = 立即发送
              </div>
            </div>
            <div className="card" style={{ marginBottom: 8 }}>
              <div className="card-title">系统提示词</div>
              <textarea className="form-input" value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={3} placeholder="输入提示词，指导 AI 如何回复..." />
            </div>
            <div className="card" style={{ marginBottom: 8 }}>
              <div className="card-title">不回复名单</div>
              <textarea className="form-input" value={friendList}
                onChange={(e) => setFriendList(e.target.value)}
                rows={2} placeholder="输入不需要自动回复的联系人名字，每行一个&#10;例如：&#10;文件传输助手&#10;公司群&#10;留空则回复所有消息" disabled={running} />
              <div className="form-hint" style={{ color: '#64748b', marginTop: 4, fontSize: 11 }}>
                自动消灭所有小红点并回复，但名单中的联系人不做回复。
              </div>
            </div>
            <div className="card" style={{ marginBottom: 8 }}>
              <div className="card-title">Obsidian 知识库路径</div>
              <input className="form-input" type="text" value={obsidianPath}
                onChange={(e) => setObsidianPath(e.target.value)}
                placeholder="例如：D:\MyVault 或留空不使用" disabled={running} />
            </div>
          </div>
        </details>

        {/* Logs */}
        <div className="card">
          <div className="card-title">运行日志</div>
          <div className="message-log" ref={logRef} style={{ maxHeight: 140 }}>
            {logs.length === 0 ? (
              <div className="message-log-empty">暂无日志</div>
            ) : (
              logs.map((entry, i) => (
                <div className="log-entry" key={i}>
                  <span className="log-time">{entry.time}</span>
                  <span className={`log-type ${entry.type}`}>{entry.type}</span>
                  <span>{entry.content}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Bottom bar */}
      <div style={{
        padding: '8px 20px 12px', display: 'flex', justifyContent: 'center',
        borderTop: '1px solid rgba(255,255,255,0.06)'
      }}>
        {running ? (
          <button className="btn btn-primary" onClick={handleStop}
            style={{ minWidth: 120, padding: '6px 24px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13 }}>
            <StopIcon /> 停止
          </button>
        ) : (
          <button className="btn btn-primary" onClick={handleStart}
            style={{ minWidth: 120, padding: '6px 24px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13 }}>
            <PlayIcon /> 启动
          </button>
        )}
      </div>
    </div>
  )
}

/* ─── Toast ─── */

let _showToast: ((msg: string, type: 'success' | 'error') => void) | null = null
function showToast(msg: string, type: 'success' | 'error') { _showToast?.(msg, type) }

function Toast() {
  const [visible, setVisible] = useState(false)
  const [message, setMessage] = useState('')
  const [type, setType] = useState<'success' | 'error'>('success')
  const timerRef = useRef<number | undefined>(undefined)

  _showToast = useCallback((msg: string, t: 'success' | 'error') => {
    setMessage(msg); setType(t); setVisible(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setVisible(false), 2500)
  }, [])

  return <div className={`toast ${type} ${visible ? 'show' : ''}`}>{message}</div>
}

export default App
