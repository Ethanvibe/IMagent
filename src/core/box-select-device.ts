// src/core/box-select-device.ts
// BoxSelectDevice — DesktopDevice 的"用户手动框选区域 + 单会话模式"实现。
//
// 与 RPADevice 的关系：两者都实现同一 DesktopDevice 接口、由 GenericChannelSession 统一驱动。
// 区别在于"如何知道 chatMain / inputBox 在屏幕上哪里"：
//   - RPADevice  : 用 VLM 在线推理 wechat / wework 的布局，并主动扫红点切换会话。
//   - BoxSelectDevice: 用户在框选向导里手动画 3 个矩形（contactList / chatMain / inputBox）。
//     运行时只对当前已经打开的对话窗口做"chatMain pixel diff → 输入框回复"，
//     不去点 contactList 切换会话。适用于飞书 / 钉钉 / Slack / Telegram 等
//     非 wechat 场景，以及 wechat VLM 检测失败时的兜底策略。
//
// 坐标系统一约定：BoxRegions 里的矩形都是逻辑像素的绝对屏幕坐标，与 captureScreenRegion、
// humanLikeMove、screen.getDisplayMatching 一致；裁剪到物理像素的换算由 captureScreenRegion 内部处理。

import { DesktopDevice } from './device'
import { AppType, BoxRegions, ScreenRect } from './rpa/types'
import {
  BBox,
  clearLayoutCache,
  getInputAreaFromCache,
  LayoutCache,
  setLayoutCache
} from './rpa/vision-utils'
import { captureChatMainArea, captureScreenRegion, calculateRedDotPercentage } from './rpa/screenshot-utils'
import { Jimp, intToRGBA } from 'jimp'
import {
  activeUnreadByClickAction,
  clickUnreadContactAction,
  sendReplyByCoordsAction
} from './rpa/input-utils'
import { comparePngBuffers } from './rpa/image-compare'

function rectCenter(rect: ScreenRect): [number, number] {
  return [rect.x + rect.width / 2, rect.y + rect.height / 2]
}

// ── 圆形小红点检测辅助函数 ──
// 用连通域分析（BFS flood fill）找到红色像素簇，再验证每个簇是否为标准圆形。

function isPixelRed(r: number, g: number, b: number, a: number): boolean {
  if (a <= 128) return false
  return r > 150 && r > g * 1.5 && r > b * 1.5
}

interface RedDotInfo {
  centerX: number       // 物理像素坐标
  centerY: number
  diameter: number      // 估算直径（物理像素）
  pixelCount: number
  screenX: number       // 逻辑屏幕坐标
  screenY: number
}

/**
 * BFS flood fill 找到图像中所有连通的红色像素簇。
 */
function findRedComponents(image: any, width: number, height: number): Array<{
  minX: number; minY: number; maxX: number; maxY: number
  pixelCount: number; centerX: number; centerY: number
}> {
  const visited = new Uint8Array(width * height)
  const components: Array<{
    minX: number; minY: number; maxX: number; maxY: number
    pixelCount: number; centerX: number; centerY: number
  }> = []

  for (let sy = 0; sy < height; sy++) {
    for (let sx = 0; sx < width; sx++) {
      if (visited[sy * width + sx]) continue
      const rgba = intToRGBA(image.getPixelColor(sx, sy))
      if (!isPixelRed(rgba.r, rgba.g, rgba.b, rgba.a)) continue

      const queue: number[] = [sy * width + sx]
      visited[sy * width + sx] = 1
      let minX = sx, maxX = sx, minY = sy, maxY = sy
      let count = 0

      while (queue.length > 0) {
        const idx = queue.shift()!
        const cx = idx % width
        const cy = Math.floor(idx / width)
        count++
        if (cx < minX) minX = cx
        if (cx > maxX) maxX = cx
        if (cy < minY) minY = cy
        if (cy > maxY) maxY = cy

        const neighbors = [
          [cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]
        ]
        for (const [nx, ny] of neighbors) {
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
          const nIdx = ny * width + nx
          if (visited[nIdx]) continue
          const nRgba = intToRGBA(image.getPixelColor(nx, ny))
          if (!isPixelRed(nRgba.r, nRgba.g, nRgba.b, nRgba.a)) continue
          visited[nIdx] = 1
          queue.push(nIdx)
        }
      }

      components.push({
        minX, minY, maxX, maxY,
        pixelCount: count,
        centerX: (minX + maxX) / 2,
        centerY: (minY + maxY) / 2
      })
    }
  }

  return components
}

/**
 * 从连通域中筛选"标准圆形"小红点。
 * 判定：宽高比 ≈ 1:1、填充率接近 π/4 ≈ 0.785、尺寸 5~28 逻辑像素。
 */
function findCircularRedDots(
  image: any,
  width: number,
  height: number,
  scaleFactor: number,
  contactListRect: { x: number; y: number; width: number; height: number }
): RedDotInfo[] {
  const components = findRedComponents(image, width, height)
  const dots: RedDotInfo[] = []

  const minDiameterLogical = 5
  const maxDiameterLogical = 28

  console.log(`[CircleDetect] found ${components.length} red components`)

  for (const comp of components) {
    const compW = comp.maxX - comp.minX + 1
    const compH = comp.maxY - comp.minY + 1
    const bboxArea = compW * compH
    const fillRatio = comp.pixelCount / bboxArea

    // 1) 宽高比
    const aspectRatio = Math.min(compW, compH) / Math.max(compW, compH)
    if (aspectRatio < 0.6) continue

    // 2) 填充率
    if (fillRatio < 0.45 || fillRatio > 0.95) continue

    // 3) 尺寸范围
    const diameter = (compW + compH) / 2
    const diameterLogical = diameter / scaleFactor
    if (diameterLogical < minDiameterLogical || diameterLogical > maxDiameterLogical) continue

    // 4) 圆形度（pixelCount / (π * r²)）
    const radius = diameter / 2
    const circleArea = Math.PI * radius * radius
    const circularity = comp.pixelCount / circleArea
    if (circularity < 0.5 || circularity > 1.3) continue

    const screenX = contactListRect.x + comp.centerX / scaleFactor
    const screenY = contactListRect.y + comp.centerY / scaleFactor
    console.log(
      `[CircleDetect] ✓ dot at physical(${comp.centerX.toFixed(0)},${comp.centerY.toFixed(0)}) ` +
      `diameter=${diameterLogical.toFixed(1)} logical px, fill=${fillRatio.toFixed(2)}, circ=${circularity.toFixed(2)}`
    )
    dots.push({
      centerX: comp.centerX,
      centerY: comp.centerY,
      diameter: Math.round(diameter),
      pixelCount: comp.pixelCount,
      screenX,
      screenY
    })
  }

  return dots
}

export class BoxSelectDevice implements DesktopDevice {
  private appType: AppType = 'generic'
  private regions: BoxRegions | null
  private chatBaseline: Buffer | null = null
  private friendList: string = ''
  private visionConfig: { baseURL: string; model: string; apiKey: string } | null = null

  constructor(regions: BoxRegions | null = null, friendList: string = '', visionConfig?: { baseURL: string; model: string; apiKey: string }) {
    this.regions = regions
    this.friendList = friendList
    this.visionConfig = visionConfig || null
  }

  setAppType(appType: AppType): void {
    this.appType = appType
  }

  // BoxSelectDevice 不需要视觉密钥；保留 no-op 以满足接口（engine:updateConfig 会调）。
  setApiKey(apiKey: string): void {
    void apiKey
  }

  setFriendList(friendList: string): void {
    this.friendList = friendList
  }

  setVisionConfig(config: { baseURL: string; model: string; apiKey: string }): void {
    this.visionConfig = config
  }

  setRegions(regions: BoxRegions | null): void {
    this.regions = regions
  }

  getRegions(): BoxRegions | null {
    return this.regions
  }

  // ── 生命周期 ──
  onSessionStop(): void {
    clearLayoutCache(this.appType)
    this.chatBaseline = null
  }

  // ── 感知层 ──

  async measureLayout(): Promise<{ success: boolean; error?: string }> {
    if (!this.regions) {
      return { success: false, error: '尚未保存框选区域，请先完成框选向导' }
    }

    // 保持 box-select 既有三框模型；measureLayout 只负责把这些测量结果写入 LayoutCache。
    const required: Array<[string, ScreenRect | null | undefined]> = [
      ['contactList', this.regions.contactList],
      ['chatMain', this.regions.chatMain],
      ['inputBox', this.regions.inputBox]
    ]
    for (const [name, rect] of required) {
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        return { success: false, error: `框选区域 ${name} 无效，请重新框选` }
      }
    }

    const chatMainCenter = rectCenter(this.regions.chatMain)
    const inputBoxCenter = rectCenter(this.regions.inputBox)
    // Derive chat entrance and first contact from contactList region
    // 与 hasUnreadMessage / findFriendWithUnread 一致：跳过第一行（header），第一个联系人在第二行
    const cl = this.regions.contactList
    const estimatedRowHeight = 65 // logical pixels per contact row
    const firstContactTopY = cl.y + estimatedRowHeight
    const firstContactCenterY = cl.y + estimatedRowHeight + estimatedRowHeight / 2
    const entranceBbox: BBox = { x: cl.x, y: firstContactTopY, width: cl.width, height: estimatedRowHeight }
    const entranceCoords: [number, number] = [cl.x + cl.width / 2, firstContactCenterY]
    const firstContactBbox: BBox = { x: cl.x, y: firstContactTopY, width: cl.width, height: estimatedRowHeight }
    const firstContactCoords: [number, number] = [cl.x + cl.width / 2, firstContactCenterY]

    const layout: LayoutCache = {
      chatEntranceArea: { bbox: entranceBbox, coordinates: entranceCoords, source: 'box-select' },
      firstContact: { bbox: firstContactBbox, coordinates: firstContactCoords, source: 'box-select' },
      searchInputBox: null,
      headerArea: null,
      chatMainArea: {
        rect: this.regions.chatMain,
        coordinates: chatMainCenter,
        source: 'box-select'
      },
      messageInputArea: {
        rect: this.regions.inputBox,
        coordinates: inputBoxCenter,
        source: 'box-select'
      },
      timestamp: Date.now(),
      appType: this.appType
    }
    setLayoutCache(this.appType, layout)
    return { success: true }
  }

  // 把 chatMain 区域截图作为"会话上下文"返回给 provider VLM 分析。
  // 比起 RPADevice 整窗截图，这里更聚焦于聊天内容，省 token 且与目标 app 无关。
  async screenshot(): Promise<string> {
    const image = await captureChatMainArea(this.appType)
    if (!image) {
      throw new Error('chatMain 截图失败')
    }
    return image.toDataURL()
  }

  // ── 圆形小红点未读检测 ──
  // 扫描整个 contactList 区域，用连通域分析找到标准圆形小红点。
  // 找到就点击小红点所在位置，消灭所有未读。
  async hasUnreadMessage(): Promise<{
    hasUnread: boolean
    chatEntranceArea?: { bbox: BBox; coordinates: [number, number] }
  }> {
    if (!this.regions?.contactList) return { hasUnread: false }

    try {
      const captured = await captureScreenRegion(this.regions.contactList)
      if (!captured || !captured.screenshotBase64) return { hasUnread: false }

      const scaleFactor = captured.display?.scaleFactor || 1
      const image = await Jimp.read(
        Buffer.from(captured.screenshotBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64')
      )
      const { width, height } = image.bitmap

      const dots = findCircularRedDots(image, width, height, scaleFactor, this.regions.contactList)
      console.log(`[BoxSelectDevice] hasUnreadMessage: found ${dots.length} circular red dot(s)`)

      if (dots.length === 0) {
        return { hasUnread: false }
      }

      // 点击第一个小红点（从上到下排序后最上面的）
      dots.sort((a, b) => a.screenY - b.screenY)
      const dot = dots[0]
      console.log(
        `[BoxSelectDevice] hasUnreadMessage: clicking red dot at screen(${dot.screenX.toFixed(0)}, ${dot.screenY.toFixed(0)}), ` +
        `diameter=${dot.diameter} physical px, ${dots.length} total dots`
      )

      return {
        hasUnread: true,
        chatEntranceArea: {
          bbox: {
            x: dot.screenX - 30,
            y: dot.screenY - 30,
            width: 60,
            height: 60
          },
          coordinates: [dot.screenX, dot.screenY]
        }
      }
    } catch (err) {
      console.warn('[BoxSelectDevice] hasUnreadMessage scan failed:', err)
      return { hasUnread: false }
    }
  }

  // 检查当前点击的联系人是否有未读消息（通知标记）。
  async isChatContactUnread(): Promise<{
    isUnread: boolean
    firstContactCoords?: [number, number]
  }> {
    if (!this.regions?.contactList) return { isUnread: false }

    try {
      const captured = await captureScreenRegion(this.regions.contactList)
      if (!captured || !captured.screenshotBase64) return { isUnread: false }

      // 扫描整个 contactList 区域
      const percentage = await calculateRedDotPercentage(captured.screenshotBase64, false)
      console.log(`[BoxSelectDevice] isChatContactUnread: red dot percentage = ${percentage?.toFixed(2) ?? 'null'}%`)

      if (percentage !== null && percentage > 0.3) {
        const firstContactY = this.regions.contactList.y + this.regions.contactList.height * 0.08
        const contactX = this.regions.contactList.x + this.regions.contactList.width / 2
        return {
          isUnread: true,
          firstContactCoords: [contactX, firstContactY]
        }
      }

      return { isUnread: false }
    } catch {
      return { isUnread: false }
    }
  }

  // box-select 没有 VLM 缓存可清；no-op。
  clearUnreadCache(): void {
    // intentionally empty
  }

  // ── 好友名单专用未读检测（圆形小红点） ──
  // 扫描 contactList 找标准圆形小红点。发现就点击，消灭所有未读。
  async findFriendWithUnread(friendNames: string[]): Promise<{
    hasUnread: boolean
    chatEntranceArea?: { bbox: BBox; coordinates: [number, number] }
  }> {
    if (!friendNames.length) return { hasUnread: false }
    if (!this.regions?.contactList) return { hasUnread: false }

    try {
      const captured = await captureScreenRegion(this.regions.contactList)
      if (!captured || !captured.screenshotBase64) return { hasUnread: false }

      const scaleFactor = captured.display?.scaleFactor || 1
      const image = await Jimp.read(
        Buffer.from(captured.screenshotBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64')
      )
      const { width, height } = image.bitmap

      const dots = findCircularRedDots(image, width, height, scaleFactor, this.regions.contactList)
      console.log(`[BoxSelectDevice] findFriendWithUnread: found ${dots.length} circular red dot(s)`)

      if (dots.length === 0) {
        return { hasUnread: false }
      }

      // 点击最上面的小红点
      dots.sort((a, b) => a.screenY - b.screenY)
      const dot = dots[0]
      console.log(
        `[BoxSelectDevice] findFriendWithUnread: clicking dot at screen(${dot.screenX.toFixed(0)}, ${dot.screenY.toFixed(0)}), ` +
        `${dots.length} total`
      )

      return {
        hasUnread: true,
        chatEntranceArea: {
          bbox: {
            x: dot.screenX - 30,
            y: dot.screenY - 30,
            width: 60,
            height: 60
          },
          coordinates: [dot.screenX, dot.screenY]
        }
      }
    } catch (err) {
      console.warn('[BoxSelectDevice] findFriendWithUnread failed:', err)
      return { hasUnread: false }
    }
  }

  // ── chatMainArea Diff ──

  async setChatBaseline(): Promise<boolean> {
    const image = await captureChatMainArea(this.appType)
    if (!image) {
      console.warn('[BoxSelectDevice] baseline 设置失败: chatMain 截图为空')
      return false
    }
    this.chatBaseline = image.toPNG()
    return true
  }

  async hasChatAreaChanged(): Promise<{ hasDiff: boolean; hasBaseline: boolean }> {
    if (!this.chatBaseline) return { hasDiff: false, hasBaseline: false }

    const image = await captureChatMainArea(this.appType)
    if (!image) {
      return { hasDiff: false, hasBaseline: true }
    }
    const current = image.toPNG()
    const cmp = comparePngBuffers(this.chatBaseline, current, {
      threshold: 0.1,
      changeThreshold: 0.5
    })
    return { hasDiff: cmp.hasChanged && !cmp.identical, hasBaseline: true }
  }

  clearChatBaseline(): void {
    this.chatBaseline = null
  }

  // ── 聊天区域左右气泡结构验证 ──
  // 验证聊天区域是否有"左侧消息 + 右侧消息"的双向对话结构。
  // 纯像素分析：左侧找白色/浅色气泡（对方消息），右侧找绿色气泡（我的消息）。
  // 只有左右都有气泡才是真正的联系人对话，排除公众号、文件传输助手等。
  async hasLeftRightBubbleStructure(): Promise<boolean> {
    if (!this.regions?.chatMain) return false

    try {
      const image = await captureChatMainArea(this.appType)
      if (!image) return false

      const { width, height } = image.bitmap

      // 扫描区域：垂直方向跳过顶部（可能有时间/系统消息）和底部（输入框区域）
      const scanTop = Math.round(height * 0.1)
      const scanBottom = Math.round(height * 0.9)
      const midX = Math.round(width / 2)

      let leftBubblePixels = 0  // 左侧浅色气泡（白/浅灰，对方消息）
      let rightBubblePixels = 0 // 右侧绿色气泡（我的消息）
      let totalScanned = 0

      // 每隔 2 像素采样，提高速度
      for (let y = scanTop; y < scanBottom; y += 2) {
        for (let x = 0; x < width; x += 2) {
          totalScanned++
          const rgba = intToRGBA(image.getPixelColor(x, y))
          if (rgba.a <= 128) continue
          const { r, g, b } = rgba

          // 左侧区域（x < midX）：白色/浅色气泡 → 对方消息
          // 特征：r/g/b 都较高（>200），且颜色中性（三色接近）
          if (x < midX) {
            const isLight = r > 200 && g > 200 && b > 200
            const isNeutral = Math.abs(r - g) < 25 && Math.abs(r - b) < 25
            if (isLight && isNeutral) leftBubblePixels++
          }

          // 右侧区域（x >= midX）：绿色气泡 → 我的消息
          // 特征：g 值最高，明显大于 r 和 b
          if (x >= midX) {
            const isGreenish = g > 120 && g > r * 1.15 && g > b * 1.05
            // 排除太暗的像素（阴影/边框）
            const notTooDark = r + g + b > 300
            if (isGreenish && notTooDark) rightBubblePixels++
          }
        }
      }

      const halfScanArea = totalScanned / 2 || 1
      const leftPct = (leftBubblePixels / halfScanArea) * 100
      const rightPct = (rightBubblePixels / halfScanArea) * 100

      console.log(
        `[BoxSelectDevice] bubble check: left=${leftPct.toFixed(2)}% (threshold 0.8%), ` +
        `right=${rightPct.toFixed(2)}% (threshold 0.8%)`
      )

      // 两侧都需要有足够的气泡像素才算"左右对话结构"
      return leftPct > 0.8 && rightPct > 0.8
    } catch (err) {
      console.warn('[BoxSelectDevice] hasLeftRightBubbleStructure failed:', err)
      return false
    }
  }

  // ── 动作层 ──

  async sendMessage(text: string): Promise<void> {
    const inputArea = getInputAreaFromCache(this.appType)
    if (!inputArea) throw new Error('尚未测量输入框区域')
    const [x, y] = inputArea.coordinates
    const ok = await sendReplyByCoordsAction(x, y, text)
    if (!ok) throw new Error('发送消息失败')
  }

  // BoxSelectDevice 始终用单击切换会话（双击只适用于 RPA 路线的微信场景）
  async activeUnreadByClick(coordinates: [number, number]): Promise<void> {
    await activeUnreadByClickAction(coordinates, this.appType, 'single')
  }

  async clickUnreadContact(coordinates: [number, number]): Promise<void> {
    await clickUnreadContactAction(coordinates)
  }

  async clickAt(x: number, y: number): Promise<void> {
    await clickUnreadContactAction([x, y])
  }
}
