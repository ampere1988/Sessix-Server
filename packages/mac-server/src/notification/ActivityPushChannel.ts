/**
 * ActivityKit Push 通知渠道
 *
 * 通过 APNs HTTP/2 直接发送 ActivityKit push notification，
 * 用于在 App 后台时更新 Live Activity 内容。
 *
 * 注意：ActivityKit push 使用独立的 push token（不同于普通推送 token），
 * 由 Activity 启动时生成，通过 pushTokenUpdates 获取。
 */

import * as http2 from 'node:http2'
import * as fs from 'node:fs'
import * as crypto from 'node:crypto'

export interface ActivityPushConfig {
  /** Apple Developer Team ID */
  teamId: string
  /** APNs Auth Key ID */
  keyId: string
  /** APNs Auth Key (.p8) 文件路径 */
  authKeyPath: string
  /** 是否使用沙箱环境（开发模式） */
  sandbox?: boolean
}

export class ActivityPushChannel {
  /** sessionId -> activityPushToken */
  private tokens = new Map<string, string>()

  private teamId: string
  private keyId: string
  private authKey: string
  private apnsHost: string

  /** 缓存的 JWT token + 过期时间 */
  private cachedJwt: { token: string; expiresAt: number } | null = null

  /** 复用的 HTTP/2 长连接 */
  private http2Client: http2.ClientHttp2Session | null = null

  constructor(config: ActivityPushConfig) {
    this.teamId = config.teamId
    this.keyId = config.keyId
    this.authKey = fs.readFileSync(config.authKeyPath, 'utf-8')
    this.apnsHost = config.sandbox
      ? 'api.sandbox.push.apple.com'
      : 'api.push.apple.com'
    console.log(`[ActivityPushChannel] Initialized (${config.sandbox ? 'sandbox' : 'production'} mode)`)
  }

  /** 获取或新建 HTTP/2 长连接 */
  private getHttp2Client(): http2.ClientHttp2Session {
    if (this.http2Client && !this.http2Client.destroyed && !this.http2Client.closed) {
      return this.http2Client
    }
    this.http2Client = http2.connect(`https://${this.apnsHost}`)
    this.http2Client.on('error', (err) => {
      console.warn('[ActivityPushChannel] HTTP/2 connection error, will reconnect on next request:', err.message)
      this.http2Client?.destroy()
      this.http2Client = null
    })
    this.http2Client.on('close', () => {
      this.http2Client = null
    })
    return this.http2Client
  }

  /** 注册 Activity push token */
  addToken(sessionId: string, token: string): void {
    this.tokens.set(sessionId, token)
    console.log(`[ActivityPushChannel] Token registered: session=${sessionId}`)
  }

  /** 移除 Activity push token */
  removeToken(sessionId: string): void {
    this.tokens.delete(sessionId)
  }

  /** 发送 content-state 更新到指定会话的 Live Activity */
  async updateActivity(sessionId: string, contentState: Record<string, unknown>): Promise<void> {
    const token = this.tokens.get(sessionId)
    if (!token) return

    const payload = {
      aps: {
        timestamp: Math.floor(Date.now() / 1000),
        event: 'update',
        'content-state': contentState,
      },
    }

    try {
      await this.sendToAPNs(token, payload)
    } catch (err) {
      console.warn(`[ActivityPushChannel] Update failed session=${sessionId}:`, err)
    }
  }

  /** 发送带通知的 content-state 更新（审批请求时使用） */
  async updateActivityWithAlert(
    sessionId: string,
    contentState: Record<string, unknown>,
    alert: { title: string; body: string },
  ): Promise<void> {
    const token = this.tokens.get(sessionId)
    if (!token) return

    const payload = {
      aps: {
        timestamp: Math.floor(Date.now() / 1000),
        event: 'update',
        'content-state': contentState,
        alert,
        sound: 'default',
      },
    }

    try {
      await this.sendToAPNs(token, payload)
    } catch (err) {
      console.warn(`[ActivityPushChannel] Alert update failed session=${sessionId}:`, err)
    }
  }

  /** 结束指定会话的 Live Activity */
  async endActivity(sessionId: string, contentState: Record<string, unknown>): Promise<void> {
    const token = this.tokens.get(sessionId)
    if (!token) return

    const payload = {
      aps: {
        timestamp: Math.floor(Date.now() / 1000),
        event: 'end',
        'content-state': contentState,
      },
    }

    try {
      await this.sendToAPNs(token, payload)
    } catch (err) {
      console.warn(`[ActivityPushChannel] End failed session=${sessionId}:`, err)
    }
    this.tokens.delete(sessionId)
  }

  /** 检查是否有指定会话的 token */
  hasToken(sessionId: string): boolean {
    return this.tokens.has(sessionId)
  }

  /** 发送 APNs HTTP/2 请求 */
  private async sendToAPNs(deviceToken: string, payload: unknown): Promise<void> {
    const topic = 'com.kachun.sessix.push-type.liveactivity'
    const jwt = this.getJWT()
    const payloadStr = JSON.stringify(payload)

    return new Promise<void>((resolve, reject) => {
      let client: http2.ClientHttp2Session
      try {
        client = this.getHttp2Client()
      } catch (err) {
        return reject(err)
      }

      const req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        'authorization': `bearer ${jwt}`,
        'apns-topic': topic,
        'apns-push-type': 'liveactivity',
        'apns-priority': '10',
        'apns-expiration': String(Math.floor(Date.now() / 1000) + 30),
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payloadStr),
      })

      let statusCode = 0
      let responseData = ''

      req.on('response', (headers) => {
        statusCode = Number(headers[':status'] ?? 0)
      })

      req.on('data', (chunk) => {
        responseData += chunk
      })

      req.on('end', () => {
        if (statusCode === 200) {
          resolve()
        } else {
          // 连接可能已损坏，重置以便下次重建
          if (statusCode === 0) {
            this.http2Client?.destroy()
            this.http2Client = null
          }
          reject(new Error(`APNs returned ${statusCode}: ${responseData}`))
        }
      })

      req.on('error', (err) => {
        reject(err)
      })

      req.write(payloadStr)
      req.end()
    })
  }

  /** 生成或获取缓存的 APNs JWT token */
  private getJWT(): string {
    const now = Math.floor(Date.now() / 1000)

    // JWT 有效期 50 分钟（Apple 限制 60 分钟）
    if (this.cachedJwt && this.cachedJwt.expiresAt > now) {
      return this.cachedJwt.token
    }

    const header = Buffer.from(JSON.stringify({
      alg: 'ES256',
      kid: this.keyId,
    })).toString('base64url')

    const claims = Buffer.from(JSON.stringify({
      iss: this.teamId,
      iat: now,
    })).toString('base64url')

    const signingInput = `${header}.${claims}`
    const sign = crypto.createSign('SHA256')
    sign.update(signingInput)
    const signature = sign.sign(this.authKey, 'base64url')

    const token = `${signingInput}.${signature}`
    this.cachedJwt = { token, expiresAt: now + 3000 } // 50 分钟

    return token
  }
}
