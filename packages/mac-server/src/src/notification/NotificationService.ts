import { basename } from 'node:path'
import type { ServerEvent, ApprovalRequest, QuestionRequest } from '@sessix/shared'
import type { SessionManager } from '../session/SessionManager.js'
import type { NotificationChannel, NotificationPayload } from './DesktopNotificationChannel.js'
import type { ExpoNotificationChannel } from './ExpoNotificationChannel.js'
import type { ActivityPushChannel } from './ActivityPushChannel.js'
import { t } from '../i18n/index.js'

/**
 * 通知服务
 *
 * 订阅 SessionManager 事件，根据事件类型构造通知内容，
 * 并分发到所有已注册的通知渠道（Mac 本地通知、Expo Push 等）。
 * 同时支持通过 ActivityPushChannel 更新 Live Activity。
 */
export class NotificationService {
  private channelMap = new Map<string, { channel: NotificationChannel; enabled: boolean }>()
  private unsubscribe: (() => void) | null = null
  private activityPushChannel: ActivityPushChannel | null = null
  /** YOLO 模式状态映射：sessionId -> isYoloMode */
  private yoloModeState = new Map<string, boolean>()
  /** 每个会话的最新 assistant 文本消息（用于通知正文预览） */
  private latestAssistantText = new Map<string, string>()
  /** 获取全局待审批总数的回调（跨所有会话） */
  private globalPendingCountProvider: (() => number) | null = null

  constructor(
    private sessionManager: SessionManager,
    private expoChannel: ExpoNotificationChannel | null = null,
  ) {
    this.unsubscribe = sessionManager.onEvent((event) => this.handleEvent(event))
    if (expoChannel) {
      this.channelMap.set('expo', { channel: expoChannel, enabled: true })
    }
  }

  /** 添加通知渠道（id 唯一，可用于后续动态开关） */
  addChannel(id: string, channel: NotificationChannel, enabled = true): void {
    this.channelMap.set(id, { channel, enabled })
  }

  /** 运行时切换指定渠道的启用状态 */
  setChannelEnabled(id: string, enabled: boolean): void {
    const entry = this.channelMap.get(id)
    if (entry) entry.enabled = enabled
  }

  /** 注册手机 push token（连接建立时由 WsBridge 调用） */
  addPushToken(token: string, ws?: import('ws').WebSocket): void {
    this.expoChannel?.addToken(token, ws)
  }

  /** 移除手机 push token（断线时或手机主动注销时调用） */
  removePushToken(token: string): void {
    this.expoChannel?.removeToken(token)
  }

  /** 更新通知音效偏好 */
  setSoundPreferences(prefs: import('@sessix/shared').NotificationSoundPreferences): void {
    this.expoChannel?.setSoundPreferences(prefs)
  }

  /** 设置 ActivityKit Push 渠道（可选，需要 APNs 认证配置） */
  setActivityPushChannel(channel: ActivityPushChannel): void {
    this.activityPushChannel = channel
  }

  /** 注册 ActivityKit push token（由手机端启动 Live Activity 后上报） */
  addActivityPushToken(sessionId: string, token: string): void {
    this.activityPushChannel?.addToken(sessionId, token)
  }

  /** 移除 ActivityKit push token */
  removeActivityPushToken(sessionId: string): void {
    this.activityPushChannel?.removeToken(sessionId)
  }

  /** 设置全局待审批总数提供者 */
  setGlobalPendingCountProvider(provider: () => number): void {
    this.globalPendingCountProvider = provider
  }

  /** 获取全局待审批总数 */
  private getGlobalPendingCount(): number {
    return this.globalPendingCountProvider?.() ?? 0
  }

  /** 更新会话的 YOLO 模式状态 */
  setYoloMode(sessionId: string, enabled: boolean): void {
    this.yoloModeState.set(sessionId, enabled)
  }

  /** 直接触发审批通知（由 ApprovalProxy 回调调用） */
  notifyApproval(request: ApprovalRequest, pendingCount: number): void {
    // YOLO 模式：客户端会自动批准，不发推送
    if (this.yoloModeState.get(request.sessionId)) return

    const sessionTitle = this.getSessionTitle(request.sessionId)

    // 多个待审批时汇总文案
    const title = pendingCount > 1
      ? t('notification.pendingApprovals', { title: sessionTitle, count: pendingCount })
      : sessionTitle
    const body = pendingCount > 1
      ? `🔧 最新: ${request.toolName}: ${request.description}`
      : `🔧 ${request.toolName}: ${request.description}`

    // Live Activity 激活 → 只走 ActivityPushChannel，跳过 Expo Push
    if (this.activityPushChannel?.hasToken(request.sessionId)) {
      const dangerLevel = this.getDangerLevel(request.toolName)
      const isYoloMode = this.getYoloMode(request.sessionId)
      this.activityPushChannel.updateActivityWithAlert(
        request.sessionId,
        {
          status: 'waitingApproval',
          sessionTitle: sessionTitle,
          latestMessage: '',
          approvalInfo: {
            requestId: request.id,
            toolName: request.toolName,
            description: request.description.slice(0, 80),
            dangerLevel,
            pendingCount,
          },
          isYoloMode,
          updatedAt: Date.now(),
        },
        { title, body },
      )
      return // 不走 Expo Push
    }

    // 非 Live Activity → 走 Expo Push
    // badge 使用全局待审批总数（跨所有会话），而非单会话数
    const dangerLevel = this.getDangerLevel(request.toolName)
    const isDangerous = dangerLevel === 'danger' || dangerLevel === 'write'
    const categoryId = isDangerous ? 'APPROVAL_DANGEROUS' : 'APPROVAL_NORMAL'
    const projectName = basename(
      this.sessionManager.getActiveSessions().find((s) => s.id === request.sessionId)?.projectPath ?? '',
    )
    const pushTitle = isDangerous ? `⚠️ ${title}` : title
    const subtitle = `🔧 ${request.toolName}: ${this.extractTarget(request)}`

    this.notify({
      title: pushTitle,
      subtitle,
      body,
      sound: 'default',
      badge: this.getGlobalPendingCount(),
      categoryId,
      data: {
        type: 'approval_request',
        sessionId: request.sessionId,
        requestId: request.id,
        toolName: request.toolName,
        projectName,
        dangerLevel,
      },
    })
  }

  /** 直接触发提问通知（由 server.ts 在 question_request 事件时调用） */
  notifyQuestion(request: QuestionRequest): void {
    const sessionTitle = this.getSessionTitle(request.sessionId)
    const body = `❓ ${request.question.slice(0, 80)}`

    // Live Activity 激活 → 走 ActivityPushChannel
    if (this.activityPushChannel?.hasToken(request.sessionId)) {
      const isYoloMode = this.getYoloMode(request.sessionId)
      this.activityPushChannel.updateActivityWithAlert(
        request.sessionId,
        {
          status: 'waitingApproval',
          sessionTitle,
          latestMessage: request.question.slice(0, 80),
          isYoloMode,
          updatedAt: Date.now(),
        },
        { title: sessionTitle, body },
      )
      return
    }

    // 非 Live Activity → 走 Expo Push
    this.notify({
      title: sessionTitle,
      body,
      sound: 'default',
      badge: this.getGlobalPendingCount(),
      data: {
        type: 'question_request',
        sessionId: request.sessionId,
        requestId: request.id,
      },
    })
  }

  /** 从审批请求中提取操作目标的简短描述 */
  private extractTarget(request: ApprovalRequest): string {
    const input = request.toolInput
    if (input.file_path) return basename(String(input.file_path))
    if (input.command) return String(input.command).slice(0, 40)
    return request.description.slice(0, 40)
  }

  /** 简单的工具危险等级判断 */
  private getDangerLevel(toolName: string): string {
    if (toolName === 'Bash') return 'danger'
    if (['Write', 'Edit', 'NotebookEdit'].includes(toolName)) return 'write'
    return 'safe'
  }

  /** 清理资源 */
  destroy(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.yoloModeState.clear()
    this.latestAssistantText.clear()
  }

  // ============================================
  // 内部方法
  // ============================================

  private handleEvent(event: ServerEvent): void {
    switch (event.type) {
      case 'claude_event': {
        this.trackAssistantText(event.sessionId, event.event)
        break
      }
      case 'claude_events': {
        for (const e of event.events) {
          this.trackAssistantText(event.sessionId, e)
        }
        break
      }
      case 'status_change': {
        if (event.status === 'idle') {
          const sessionTitle = this.getSessionTitle(event.sessionId)
          const latestMsg = this.latestAssistantText.get(event.sessionId)
          const body = latestMsg
            ? `✅ ${latestMsg.slice(0, 80)}`
            : t('notification.taskComplete')
          const isYoloMode = this.getYoloMode(event.sessionId)

          if (this.activityPushChannel?.hasToken(event.sessionId)) {
            this.activityPushChannel.endActivity(event.sessionId, {
              status: 'idle',
              sessionTitle: sessionTitle,
              latestMessage: body,
              isYoloMode,
              updatedAt: Date.now(),
            })
          } else {
            this.notify({
              title: sessionTitle,
              body,
              sound: 'default',
              badge: this.getGlobalPendingCount(),
              data: { type: 'task_complete', sessionId: event.sessionId },
            })
          }
        } else if (event.status === 'error') {
          const sessionTitle = this.getSessionTitle(event.sessionId)
          const latestMsg = this.latestAssistantText.get(event.sessionId)
          const body = latestMsg
            ? `❌ ${latestMsg.slice(0, 80)}`
            : t('notification.taskError')
          const isYoloMode = this.getYoloMode(event.sessionId)

          if (this.activityPushChannel?.hasToken(event.sessionId)) {
            this.activityPushChannel.endActivity(event.sessionId, {
              status: 'error',
              sessionTitle: sessionTitle,
              latestMessage: body,
              isYoloMode,
              updatedAt: Date.now(),
            })
          } else {
            this.notify({
              title: sessionTitle,
              body,
              sound: 'default',
              badge: this.getGlobalPendingCount(),
              data: { type: 'task_error', sessionId: event.sessionId },
            })
          }
        }
        break
      }

      // 其他事件不发通知
    }
  }

  private notify(payload: NotificationPayload): void {
    for (const { channel, enabled } of this.channelMap.values()) {
      if (!enabled) continue
      channel.send(payload).catch((err) => {
        console.error('[NotificationService] Notification send failed:', err)
      })
    }
  }

  /** 从 assistant 事件中提取最新文本消息 */
  private trackAssistantText(sessionId: string, event: import('@sessix/shared').ClaudeStreamEvent): void {
    if (event.type !== 'assistant') return
    const textBlocks = event.message.content.filter((b) => b.type === 'text')
    const lastText = textBlocks[textBlocks.length - 1]
    if (lastText && lastText.type === 'text' && lastText.text.trim()) {
      this.latestAssistantText.set(sessionId, lastText.text.trim())
    }
  }

  /** 获取会话标题：优先 summary，fallback 到项目名 */
  private getSessionTitle(sessionId: string): string {
    const session = this.sessionManager.getActiveSessions().find((s) => s.id === sessionId)
    if (!session) return 'Unknown'
    return session.summary ?? basename(session.projectPath)
  }

  /** 获取会话的 YOLO 模式状态 */
  private getYoloMode(sessionId: string): boolean {
    return this.yoloModeState.get(sessionId) ?? false
  }
}
