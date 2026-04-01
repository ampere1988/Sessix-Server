export type PairingState = 'open' | 'closed'

export interface PairingManagerOpts {
  token: string
  serverName: string
  version: string
  defaultDuration?: number
  onStateChange: (state: PairingState) => void
}

export class PairingManager {
  private _state: PairingState = 'closed'
  private timer: ReturnType<typeof setTimeout> | null = null
  private deadline = 0
  private token: string
  private serverName: string
  private version: string
  private defaultDuration: number
  private onStateChange: (state: PairingState) => void

  constructor(opts: PairingManagerOpts) {
    this.token = opts.token
    this.serverName = opts.serverName
    this.version = opts.version
    this.defaultDuration = opts.defaultDuration ?? 300_000
    this.onStateChange = opts.onStateChange
  }

  get state(): PairingState {
    return this._state
  }

  open(duration?: number): void {
    const ms = duration ?? this.defaultDuration
    if (this.timer) clearTimeout(this.timer)
    this._state = 'open'
    this.deadline = Date.now() + ms
    this.timer = setTimeout(() => this.close(), ms)
    this.onStateChange('open')
  }

  close(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this._state === 'closed') return
    this._state = 'closed'
    this.deadline = 0
    this.onStateChange('closed')
  }

  tryPair(): { token: string; serverName: string; version: string } | null {
    if (this._state !== 'open') return null
    const result = { token: this.token, serverName: this.serverName, version: this.version }
    this.close()
    return result
  }

  updateToken(newToken: string): void {
    this.token = newToken
  }

  getRemainingSeconds(): number {
    if (this._state !== 'open') return 0
    return Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000))
  }

  destroy(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
