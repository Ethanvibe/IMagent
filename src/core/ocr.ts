/**
 * OCR utility — extracts readable text from chat screenshots.
 * Uses tesseract.js (worker_threads, Node.js adapter).
 * Language data is bundled locally in resources/tesseract-data/
 * so no network download is needed at runtime.
 *
 * Key design: all async operations have timeouts so OCR failures
 * never block the main auto-reply pipeline.
 */

let _worker: any = null
let _ready = false
let _initFailed = false
let _initPromise: Promise<any> | null = null

function getLocalLangPath(): string {
  const path = require('path')

  if ((process as any).resourcesPath) {
    const unpackedPath = path.join(
      (process as any).resourcesPath,
      'app.asar.unpacked',
      'resources',
      'tesseract-data'
    )
    try {
      const fs = require('fs')
      if (fs.existsSync(unpackedPath)) return unpackedPath
    } catch { /* ignore */ }

    return path.join((process as any).resourcesPath, 'tesseract-data')
  }

  try {
    const { app } = require('electron')
    return path.join(app.getAppPath(), 'resources', 'tesseract-data')
  } catch {
    return path.join(__dirname, '..', '..', 'resources', 'tesseract-data')
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => {
      console.warn(`[OCR] ${label} timed out after ${ms}ms`)
      resolve(null)
    }, ms))
  ])
}

async function initWorker(): Promise<any> {
  if (_ready && _worker) return _worker
  if (_initFailed) return null

  try {
    const tesseract = await import('tesseract.js')
    const { createWorker } = tesseract.default ?? tesseract

    let cachePath: string
    try {
      const { app } = require('electron')
      const path = require('path')
      cachePath = path.join(app.getPath('userData'), 'tesseract-cache')
    } catch {
      const path = require('path')
      const os = require('os')
      cachePath = path.join(os.tmpdir(), 'tesseract-cache')
    }

    const langPath = getLocalLangPath()
    console.log('[OCR] initializing with langPath:', langPath)

    // Use eng+chi_sim for Chinese chat app support
    const worker = await createWorker('eng+chi_sim', 1, { cachePath, langPath })
    _worker = worker
    _ready = true
    console.log('[OCR] worker ready (eng+chi_sim)')
    return worker
  } catch (err) {
    console.error('[OCR] init failed:', err)
    _initFailed = true
    return null
  }
}

/**
 * Start OCR worker initialization in the background.
 * Call this early (e.g., on engine start) so the worker is ready by the time we need it.
 */
export function startOcrInit(): void {
  if (_initPromise || _ready || _initFailed) return
  console.log('[OCR] starting background initialization...')
  _initPromise = initWorker().catch((err) => {
    console.error('[OCR] background init error:', err)
    _initFailed = true
  })
}

function getWorker(): Promise<any> {
  if (_ready && _worker) return Promise.resolve(_worker)
  if (_initFailed) return Promise.resolve(null)
  if (_initPromise) return _initPromise.then(() => _worker)
  // Not started yet — start now
  startOcrInit()
  return _initPromise!.then(() => _worker)
}

function prepareImageData(base64Image: string): Buffer | string {
  const idx = base64Image.indexOf('base64,')
  if (idx !== -1) {
    return Buffer.from(base64Image.slice(idx + 'base64,'.length), 'base64')
  }
  return base64Image
}

/**
 * Extract text from a base64-encoded screenshot (PNG / JPEG).
 * Has built-in timeout to never block the main pipeline.
 * Returns empty string if OCR is unavailable, not ready, or fails.
 */
export async function ocrScreenshot(base64Image: string): Promise<string> {
  try {
    const w = await withTimeout(getWorker(), 12000, 'init')
    if (!w) {
      console.log('[OCR] worker not available, skipping')
      return ''
    }

    const imgData = prepareImageData(base64Image)
    const result = await withTimeout(w.recognize(imgData), 15000, 'recognize')
    if (!result) return ''
    return (result?.data?.text ?? '').trim()
  } catch (err) {
    console.error('[OCR] error:', err)
    return ''
  }
}

/**
 * Check if a character is CJK (Chinese/Japanese/Korean).
 * CJK text doesn't use spaces between characters.
 */
function isCJK(text: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(text)
}

/**
 * Extract text from a screenshot WITH position information (left/right).
 *
 * In chat apps:
 *   - Left side = contact's messages (对方)
 *   - Right side = user's own messages (我)
 *
 * Returns formatted text like:
 *   对方：你好啊
 *   我：你好，最近怎么样？
 *   对方：挺好的
 *
 * Returns empty string if OCR is unavailable or fails.
 */
export async function ocrScreenshotWithPosition(base64Image: string): Promise<string> {
  try {
    const w = await withTimeout(getWorker(), 12000, 'init')
    if (!w) {
      console.log('[OCR] worker not available for position OCR')
      return ''
    }

    const imgData = prepareImageData(base64Image)
    const result = await withTimeout(w.recognize(imgData), 20000, 'recognize-with-position')
    if (!result || !result.data) return ''

    const words = result.data.words
    if (!words || words.length === 0) {
      // Fallback: return plain text without position info
      return (result.data.text ?? '').trim()
    }

    const imgWidth = result.data.words[0]?.bbox?.x1 !== undefined
      ? Math.max(...words.map((w: any) => w.bbox.x1))
      : 0

    // Get image dimensions from the recognition result
    // The rightmost x1 value approximates image width
    const maxX = Math.max(...words.map((wrd: any) => Math.max(wrd.bbox.x0, wrd.bbox.x1)))
    const midX = maxX / 2

    // Group consecutive words on the same side
    type Side = 'left' | 'right'
    const groups: { side: Side; text: string }[] = []

    let currentSide: Side | null = null
    let currentText = ''

    for (const word of words) {
      const center = (word.bbox.x0 + word.bbox.x1) / 2
      const side: Side = center < midX ? 'left' : 'right'
      const wordText = word.text.trim()
      if (!wordText) continue

      if (side !== currentSide) {
        if (currentText) {
          groups.push({ side: currentSide!, text: currentText.trim() })
        }
        currentSide = side
        currentText = wordText
      } else {
        // For CJK languages, don't add space between words
        if (isCJK(wordText) || isCJK(currentText.slice(-2))) {
          currentText += wordText
        } else {
          currentText += ' ' + wordText
        }
      }
    }
    if (currentText) {
      groups.push({ side: currentSide!, text: currentText.trim() })
    }

    // Filter out noise: require groups to have at least 2 characters
    const filtered = groups.filter(g => g.text.length >= 2)
    if (filtered.length < 2) {
      console.log(`[OCR] too few groups (${filtered.length}), OCR quality too low`)
      return ''
    }

    // Check total text length - need enough content to be useful
    const totalText = filtered.map(g => g.text).join('')
    if (totalText.length < 15) {
      console.log(`[OCR] total text too short (${totalText.length} chars), skipping`)
      return ''
    }

    const lines = filtered.map(g => {
      const prefix = g.side === 'left' ? '对方：' : '我：'
      return prefix + g.text
    })

    const output = lines.join('\n')
    console.log(`[OCR] position OCR: ${filtered.length} groups, ${output.length} chars`)
    return output
  } catch (err) {
    console.error('[OCR] position OCR error:', err)
    return ''
  }
}

/** Terminate the background worker (call on app quit). */
export async function terminateOcr(): Promise<void> {
  if (_worker) {
    await _worker.terminate().catch(() => { /* ignore */ })
    _worker = null
    _ready = false
  }
}
