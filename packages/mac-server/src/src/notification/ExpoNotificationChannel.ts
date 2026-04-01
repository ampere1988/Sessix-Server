import type { WebSocket } from 'ws'
import type { NotificationSoundPreferences } from '@sessix/shared'
import type { NotificationChannel, NotificationPayload } from './DesktopNotificationChannel.js'
import { t } from '../i18n/index.js'

const EXPO_PUSH_API = 'https://exp.host/--/api/v2/push/send'

/**
 * Expo Push 通知渠道
 *
 * 通过 Expo Push API 向已注册的设备发送推送通知。
 * 支持多个 token（一台 Mac 可以连多台手机）。
 * 当设备的 WebSocket 连接仍活跃时（app 在前台），跳过推送。
 *
 * 数据流：Mac Server → Expo Push API → APNs → iPhone
 */
export class ExpoNotificationChannel implements NotificationChannel {
  private tokens: Set<string> = new Set()
  /** push token → WebSocket 连接映射，用于前台抑制 */
  private tokenWsMap = new Map<string, WebSocket>()
  /** per-token 通知音效偏好 */
  private soundPreferences = new Map<string, NotificationSoundPreferences>()

  isAvailable(): boolean {
    return this.tokens.size > 0
  }

  addToken(token: string, ws?: WebSocket): void {
    this.tokens.add(token)
    if (ws) this.tokenWsMap.set(token, ws)
    console.log(`[ExpoNotificationChannel] ${t('notification.tokenRegistered', { count: this.tokens.size })}`)
  }

  removeToken(token: string): void {
    this.tokens.delete(token)
    this.tokenWsMap.delete(token)
    this.soundPreferences.delete(token)
    console.log(`[ExpoNotificationChannel] ${t('notification.tokenRemoved', { count: this.tokens.size })}`)
  }

  /** 更新某个 token 的音效偏好 */
  setSoundPreferences(prefs: NotificationSoundPreferences): void {
    // 应用到所有已注册的 token（单用户场景，通常只有一个 token）
    for (const token of this.tokens) {
      this.soundPreferences.set(token, prefs)
    }
    console.log(`[ExpoNotificationChannel] ${t('notification.soundPrefsUpdated')}`)
  }

  async send(payload: NotificationPayload): Promise<void> {
    if (this.tokens.size === 0) return

    // 过滤掉 WebSocket 仍活跃的设备（app 在前台，已通过 WS 收到实时事件）
    const offlineTokens = Array.from(this.tokens).filter((token) => {
      const ws = this.tokenWsMap.get(token)
      // 没有关联 ws 或 ws 已断开 → 需要推送
      return !ws || ws.readyState !== ws.OPEN
    })

    if (offlineTokens.length === 0) return

    const messages = offlineTokens.map((to) => {
      let sound: string | null = payload.sound ?? 'default'

      // 根据 per-token 偏好覆盖音效
      const prefs = this.soundPreferences.get(to)
      if (prefs) {
        const notifType = (payload.data?.type as string) ?? ''
        if (notifType === 'approval_request' && prefs.approval) sound = prefs.approval
        else if (notifType === 'task_complete' && prefs.taskComplete) sound = prefs.taskComplete
        else if (notifType === 'task_error' && prefs.taskError) sound = prefs.taskError
      }

      // Expo Push API sound 字段：'default' | null | 打包的文件名
      const pushSound = sound === 'none' ? null : sound

      return {
        to,
        title: payload.title,
        subtitle: payload.subtitle,
        body: payload.body,
        badge: payload.badge,
        sound: pushSound,
        categoryId: payload.categoryId,
        data: payload.data ?? {},
      }
    })

    try {
      console.log(`[ExpoNotificationChannel] ${t('notification.sendingPush')} (${offlineTokens.length}/${this.tokens.size} devices)`, offlineTokens)
      const res = await fetch(EXPO_PUSH_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(messages),
      })

      const body = await res.json()
      if (!res.ok) {
        console.warn(`[ExpoNotificationChannel] ${t('notification.pushApiError')}`, res.status, JSON.stringify(body))
      } else {
        // 检查每个 ticket 的状态，记录失败的推送
        if (!Array.isArray(body?.data)) {
          console.warn(`[ExpoNotificationChannel] ${t('notification.pushApiFormatError')}`, JSON.stringify(body))
          return
        }
        for (const ticket of body.data) {
          if (ticket.status === 'error') {
            console.error(`[ExpoNotificationChannel] ${t('notification.pushFailed')} ${ticket.message} (${ticket.details?.error ?? 'unknown'})`)
          }
        }
      }
    } catch (err) {
      console.warn(`[ExpoNotificationChannel] ${t('notification.sendFailed')}`, err)
    }
  }
}
