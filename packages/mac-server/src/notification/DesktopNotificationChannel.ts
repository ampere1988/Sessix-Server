import { execFile } from 'node:child_process'

export interface NotificationPayload {
  title: string
  body: string
  subtitle?: string
  sound?: string
  /** iOS App 图标角标数字 */
  badge?: number
  /** iOS/watchOS 通知类别标识，用于 actionable 通知按钮 */
  categoryId?: string
  /** 附加数据，用于未来通知 Action */
  data?: Record<string, unknown>
}

export interface NotificationChannel {
  send(payload: NotificationPayload): Promise<void>
  isAvailable(): boolean
}

/**
 * macOS 本地通知渠道（临时方案）
 *
 * 使用 osascript 发送系统通知。
 * 未来 Mac App 打包后替换为 UserNotifications.framework。
 */
export class DesktopNotificationChannel implements NotificationChannel {
  isAvailable(): boolean {
    return process.platform === 'darwin'
  }

  send(payload: NotificationPayload): Promise<void> {
    if (!this.isAvailable()) return Promise.resolve()

    const title = payload.title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const body = payload.body.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const sound = payload.sound ?? 'Ping'

    const script = `display notification "${body}" with title "${title}" sound name "${sound}"`

    return new Promise((resolve) => {
      execFile('osascript', ['-e', script], (err) => {
        if (err) {
          console.warn('[DesktopNotificationChannel] Send notification failed:', err.message)
        }
        resolve()
      })
    })
  }
}
