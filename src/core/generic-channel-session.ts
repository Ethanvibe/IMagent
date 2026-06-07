// src/core/generic-channel-session.ts
// 通用 ChannelSession — 驱动 DesktopDevice，具体位置来源由设备测量后写入 LayoutCache。
//
// 设计原则：本文件只依赖 DesktopDevice 接口。所有微信特定的行为（如 layoutCache 清理、
// VLM bbox 状态同步）都封装到具体设备的 onSessionStart / onSessionStop / clearUnreadCache
// 里，使 channel session 在不同设备之间真正可复用。

import { DesktopDevice } from './device'
import { ChannelContext, ChannelSession, ProviderEvent, SessionEvent } from './session-types'
import { startOcrInit, ocrScreenshotWithPosition } from './ocr'

export interface GenericChannelState {
  measuredAt: number | null
  latestChatBaseline: number | null
}

export function createInitialGenericChannelState(): GenericChannelState {
  return {
    measuredAt: null,
    latestChatBaseline: null
  }
}

export class GenericChannelSession implements ChannelSession<GenericChannelState> {
  private readonly retryDelayMs = 5000
  private consecutiveUnreadFailures = 0

  constructor(
    private readonly device: DesktopDevice,
    private replyDelayMs: number = 3000,
    private obsidianPath: string = '',
    private friendList: string = ''
  ) {}

  async onStart(ctx: ChannelContext<GenericChannelState>): Promise<void> {
    this.device.setAppType(ctx.appType)
    this.device.clearChatBaseline()
    this.consecutiveUnreadFailures = 0
    this.resetState(ctx.state)
    await this.device.onSessionStart?.()

    // Start OCR worker initialization in background (non-blocking)
    startOcrInit()

    ctx.host.enqueue({ type: 'bootstrap' })
  }

  async onStop(ctx: ChannelContext<GenericChannelState>): Promise<void> {
    this.device.clearChatBaseline()
    this.consecutiveUnreadFailures = 0
    await this.device.onSessionStop?.()
    this.resetState(ctx.state)
  }

  async onEvent(event: SessionEvent, ctx: ChannelContext<GenericChannelState>): Promise<void> {
    this.device.setAppType(ctx.appType)

    switch (event.type) {
      case 'bootstrap': {
        ctx.host.log('thinking', '正在识别聊天窗口布局...')
        const result = await this.device.measureLayout()

        if (!result.success) {
          ctx.host.log('error', `${result.error || '界面识别失败'}，引擎无法启动`)
          await ctx.host.stopSession('bootstrap_failed')
          return
        }

        ctx.state.measuredAt = Date.now()
        ctx.host.log('thinking', '聊天窗口识别完成')
        ctx.host.enqueue({ type: 'observe_chat' })
        break
      }

      case 'observe_chat': {
        let screenshot: string
        try {
          screenshot = await this.device.screenshot()
        } catch (err: any) {
          ctx.host.log('error', `截图失败: ${err?.message || err}，等待重试`)
          ctx.host.enqueue({ type: 'wait_retry', reason: 'screenshot_failed', delayMs: this.retryDelayMs })
          break
        }
        void this.forwardProviderEvents(screenshot, ctx)
        break
      }

      case 'provider.thinking':
        ctx.host.log('thinking', event.content)
        break

      case 'provider.reply_text':
        try {
          if (this.replyDelayMs > 0) {
            ctx.host.log('thinking', `等待 ${this.replyDelayMs / 1000} 秒后发送回复...`)
            await this.sleep(this.replyDelayMs)
          }
          await this.device.sendMessage(event.content)
          ctx.host.log('reply', event.content)
          await this.device.setChatBaseline()
          ctx.state.latestChatBaseline = Date.now()
          ctx.host.enqueue({ type: 'check_unread' })
        } catch (err: any) {
          ctx.host.log('error', `发送消息失败: ${err?.message || err}，等待重试`)
          ctx.host.enqueue({ type: 'wait_retry', reason: 'send_failed', delayMs: this.retryDelayMs })
        }
        break

      case 'provider.skip':
        ctx.host.log('skip', '本轮无需回复')
        try {
          await this.device.setChatBaseline()
        } catch { /* ignore */ }
        ctx.state.latestChatBaseline = Date.now()
        ctx.host.enqueue({ type: 'check_unread' })
        break

      case 'provider.error':
        ctx.host.log('error', `回复服务异常：${event.error}`)
        ctx.host.enqueue({
          type: 'wait_retry',
          reason: 'provider_error',
          delayMs: this.retryDelayMs
        })
        break

      case 'check_unread': {
        try {
          const diffResult = await this.device.hasChatAreaChanged()
          if (diffResult.hasDiff) {
            ctx.host.log('thinking', '检测到当前对话有新消息')
            ctx.host.enqueue({ type: 'observe_chat' })
            break
          }

          // 始终用圆形小红点检测扫描整个联系人列表
          const unreadResult = await this.device.hasUnreadMessage()

          if (!unreadResult.hasUnread) {
            ctx.host.enqueue({
              type: 'wait_retry',
              reason: 'no_unread',
              delayMs: this.retryDelayMs
            })
            break
          }

          const chatEntranceCoords = unreadResult.chatEntranceArea?.coordinates
          if (!chatEntranceCoords) {
            ctx.host.log('error', '检测到未读消息，但未找到聊天入口位置')
            ctx.host.enqueue({
              type: 'wait_retry',
              reason: 'missing_chat_entrance',
              delayMs: this.retryDelayMs
            })
            break
          }

          ctx.host.log('thinking', '检测到小红点，正在尝试打开会话')
          await this.device.activeUnreadByClick(chatEntranceCoords)
          await this.sleep(150 + Math.random() * 100)

          const openResult = await this.tryOpenUnreadConversation(ctx)
          if (openResult === 'opened') {
            // 验证是真实的左右对话（排除公众号、文件传输助手等）
            if (this.device.hasLeftRightBubbleStructure) {
              const isRealChat = await this.device.hasLeftRightBubbleStructure()
              if (!isRealChat) {
                ctx.host.log('skip', '不是真实的左右对话，跳过')
                ctx.host.enqueue({ type: 'check_unread' })
                break
              }
            }

            // 检查联系人是否在"不回复名单"中
            const skipNames = this.getSkipNames()
            if (skipNames.length > 0) {
              const contactName = await this.extractContactName(ctx)
              if (contactName) {
                const matched = skipNames.find(n => contactName.includes(n) || n.includes(contactName))
                if (matched) {
                  ctx.host.log('skip', `"${contactName}" 在不回复名单中，跳过`)
                  ctx.host.enqueue({ type: 'check_unread' })
                  break
                }
              }
            }

            ctx.host.enqueue({ type: 'observe_chat' })
            break
          }

          ctx.host.enqueue({
            type: 'wait_retry',
            reason: openResult,
            delayMs: this.retryDelayMs
          })
        } catch (err: any) {
          ctx.host.log('error', `未读检测异常: ${err?.message || err}，等待重试`)
          ctx.host.enqueue({ type: 'wait_retry', reason: 'check_unread_error', delayMs: this.retryDelayMs })
        }
        break
      }

      case 'wait_retry':
        ctx.host.log('skip', '等待下一轮未读检测')
        ctx.host.schedule(
          event.reason === 'provider_error' ? { type: 'observe_chat' } : { type: 'check_unread' },
          event.delayMs ?? this.retryDelayMs
        )
        break
    }
  }

  private async forwardProviderEvents(
    screenshot: string,
    ctx: ChannelContext<GenericChannelState>
  ): Promise<void> {
    try {
      console.log('[Session] calling provider with screenshot...')
      ctx.host.log('thinking', '正在分析聊天内容...')

      // Try OCR first to extract text with left/right position info.
      // If OCR succeeds, the provider uses text mode (more reliable, no 400 errors).
      // If OCR fails, we fall back to image mode (provider sends screenshot as image_url).
      let ocrText = ''
      try {
        ocrText = await ocrScreenshotWithPosition(screenshot)
        console.log('[Session] OCR result:', ocrText ? `${ocrText.length} chars` : 'empty')
        if (ocrText) {
          console.log('[Session] OCR preview:', ocrText.slice(0, 200))
        }
      } catch (ocrErr: any) {
        console.warn('[Session] OCR failed, will use image mode:', ocrErr?.message || ocrErr)
      }

      const providerInput = {
        screenshot,
        appType: ctx.appType,
        ocrText: ocrText || undefined,
        obsidianPath: this.obsidianPath || undefined,
        friendList: this.friendList || undefined
      }
      console.log('[Session] provider input:', JSON.stringify({
        hasScreenshot: !!screenshot,
        screenshotLen: screenshot?.length || 0,
        hasOcrText: !!ocrText,
        ocrTextLen: ocrText?.length || 0,
        appType: ctx.appType,
        obsidianPath: this.obsidianPath || '(none)',
        hasFriendList: !!this.friendList
      }))

      let eventCount = 0
      for await (const event of ctx.host.runProvider(providerInput)) {
        eventCount++
        console.log(`[Session] provider event #${eventCount}:`, event.type, event.type === 'reply_text' ? event.content?.slice(0, 50) : '')
        if (!ctx.host.isRunning()) {
          console.log('[Session] session stopped during provider iteration')
          break
        }

        const sessionEvent = this.mapProviderEvent(event)
        if (sessionEvent) {
          ctx.host.enqueue(sessionEvent)
        }
      }
      console.log(`[Session] provider finished, total events: ${eventCount}`)
      if (eventCount === 0) {
        ctx.host.log('error', 'AI 服务没有返回任何结果，请检查 API 配置')
        ctx.host.enqueue({ type: 'provider.error', error: 'AI 服务没有返回任何结果' })
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[Session] forwardProviderEvents error:', message, error instanceof Error ? error.stack : '')
      ctx.host.log('error', `处理异常: ${message}`)
      ctx.host.enqueue({ type: 'provider.error', error: message })
    }
  }

  private mapProviderEvent(event: ProviderEvent): SessionEvent | null {
    switch (event.type) {
      case 'thinking':
        return { type: 'provider.thinking', content: event.content }
      case 'reply_text':
        return { type: 'provider.reply_text', content: event.content }
      case 'skip':
        return { type: 'provider.skip' }
      case 'error':
        return { type: 'provider.error', error: event.error }
      default:
        return null
    }
  }

  private resetState(state: GenericChannelState): void {
    state.measuredAt = null
    state.latestChatBaseline = null
  }

  private async tryOpenUnreadConversation(
    ctx: ChannelContext<GenericChannelState>
  ): Promise<'opened' | 'contact_not_ready'> {
    let contactResult = await this.device.isChatContactUnread()

    if (!contactResult.isUnread) {
      ctx.host.log('thinking', '当前会话没有新消息，正在重新检测...')
      await this.sleep(1000)

      const recheckResult = await this.device.hasUnreadMessage()
      const recheckCoords = recheckResult.chatEntranceArea?.coordinates

      if (!recheckResult.hasUnread || !recheckCoords) {
        ctx.host.log('skip', '重新检测后无未读消息，等待下一轮')
        return 'contact_not_ready'
      }

      ctx.host.log('thinking', '仍检测到未读消息，正在再次尝试打开会话')
      await this.device.activeUnreadByClick(recheckCoords)
      await this.sleep(500)
      contactResult = await this.device.isChatContactUnread()
    }

    if (!contactResult.isUnread) {
      this.consecutiveUnreadFailures += 1

      if (this.consecutiveUnreadFailures >= 3) {
        ctx.host.log(
          'thinking',
          `连续 ${this.consecutiveUnreadFailures} 次检测失败，正在重置未读识别状态`
        )
        this.device.clearUnreadCache()
        this.consecutiveUnreadFailures = 0
        await this.sleep(500)

        contactResult = await this.device.isChatContactUnread()
        if (!contactResult.isUnread) {
          ctx.host.log('thinking', '重置后仍未成功，正在再次尝试打开会话')
          const retryUnread = await this.device.hasUnreadMessage()
          const retryCoords = retryUnread.chatEntranceArea?.coordinates

          if (!retryUnread.hasUnread || !retryCoords) {
            ctx.host.log('skip', '重置后仍未找到可用会话入口，等待下一轮')
            return 'contact_not_ready'
          }

          await this.device.activeUnreadByClick(retryCoords)
          await this.sleep(500)
          contactResult = await this.device.isChatContactUnread()

          if (!contactResult.isUnread) {
            ctx.host.log('skip', '最终检测仍失败，放弃当前轮未读切换')
            return 'contact_not_ready'
          }
        }
      } else {
        ctx.host.log(
          'skip',
          `会话切换检测失败（第 ${this.consecutiveUnreadFailures} 次），等待下一轮`
        )
        return 'contact_not_ready'
      }
    }

    this.consecutiveUnreadFailures = 0

    if (!contactResult.firstContactCoords) {
      ctx.host.log('skip', '未找到联系人位置，等待下一轮')
      return 'contact_not_ready'
    }

    ctx.host.log('thinking', '正在打开未读会话')
    await this.device.clickUnreadContact(contactResult.firstContactCoords)
    await this.sleep(500 + Math.random() * 300)
    this.device.clearChatBaseline()
    ctx.state.latestChatBaseline = null
    return 'opened'
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /** 从好友名单字段获取"不回复名单" */
  private getSkipNames(): string[] {
    if (!this.friendList) return []
    return this.friendList
      .split(/[\n\r]+/)
      .map(n => n.trim())
      .filter(n => n.length > 0)
  }

  /**
   * 从聊天头部提取联系人名称（用于不回复名单过滤）。
   * 用 OCR 识别聊天区域文字，取最上面的非空行作为联系人名称候选。
   */
  private async extractContactName(
    ctx: ChannelContext<GenericChannelState>
  ): Promise<string> {
    try {
      const screenshot = await this.device.screenshot()
      const ocrText = await ocrScreenshotWithPosition(screenshot)
      if (!ocrText) return ''
      // 取 OCR 结果的前几行（头部区域 = 联系人名称位置）
      const lines = ocrText.split('\n').map(l => l.replace(/^\[(左|右)\]\s*/, '').trim()).filter(l => l.length > 0)
      if (lines.length === 0) return ''
      // 第一行通常是联系人/群名称
      return lines[0]
    } catch (err: any) {
      console.warn('[Session] extractContactName failed:', err?.message || err)
      return ''
    }
  }
}
