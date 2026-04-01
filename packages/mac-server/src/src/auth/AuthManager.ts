import { spawn } from 'child_process'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { findClaudePath } from '../utils/claudePath.js'

const execFileAsync = promisify(execFile)
const CLAUDE_PATH = findClaudePath()

/** 登录进程最大存活时间（5 分钟） */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

export interface AuthStatus {
  loggedIn: boolean
  email?: string
  authMethod?: string
}

/**
 * AuthManager — 管理 Claude CLI 认证状态
 *
 * 功能：
 * 1. 检查当前登录状态（claude auth status）
 * 2. 启动登录流程（claude auth login），捕获 URL
 * 3. 接收用户提交的授权码，写入 stdin 完成登录
 */
export class AuthManager extends EventEmitter {
  private loginProcess: ChildProcess | null = null
  private loginTimeout: NodeJS.Timeout | null = null
  private urlSent = false

  /** 检查当前 Claude CLI 认证状态（异步，不阻塞事件循环） */
  async checkAuth(): Promise<AuthStatus> {
    try {
      const { stdout } = await execFileAsync(CLAUDE_PATH, ['auth', 'status'], {
        timeout: 10_000,
      })
      const parsed = JSON.parse(stdout.trim())
      return {
        loggedIn: !!parsed.loggedIn,
        email: parsed.email,
        authMethod: parsed.authMethod,
      }
    } catch {
      return { loggedIn: false }
    }
  }

  /** 启动登录流程，捕获 URL 并通过事件推送 */
  async startLogin(): Promise<void> {
    // 如果已有登录进程在运行，先清理
    if (this.loginProcess) {
      this.loginProcess.kill()
      this.loginProcess = null
    }
    this.clearLoginTimeout()
    this.urlSent = false

    // BROWSER=echo 阻止打开浏览器，URL 会输出到 stdout
    const proc = spawn(CLAUDE_PATH, ['auth', 'login'], {
      env: { ...process.env, BROWSER: 'echo' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.loginProcess = proc

    const handleOutput = (data: Buffer) => {
      const text = data.toString()
      console.log(`[AuthManager] login output: ${text.trim()}`)

      // 只发送一次 URL（避免 stdout/stderr 重复触发）
      if (!this.urlSent) {
        const url = this.extractUrl(text)
        if (url) {
          this.urlSent = true
          console.log(`[AuthManager] 捕获到登录 URL: ${url}`)
          this.emit('login_url', url)
        }
      }
    }

    proc.stdout?.on('data', handleOutput)
    proc.stderr?.on('data', handleOutput)

    proc.on('exit', (code) => {
      console.log(`[AuthManager] login process exited with code ${code}`)
      this.loginProcess = null
      this.clearLoginTimeout()

      this.checkAuth().then((status) => {
        if (status.loggedIn) {
          this.emit('login_result', { success: true })
        } else if (code !== 0) {
          this.emit('login_result', { success: false, error: `Exit code: ${code}` })
        }
      })
    })

    proc.on('error', (err) => {
      console.error(`[AuthManager] login process error:`, err.message)
      this.loginProcess = null
      this.clearLoginTimeout()
      this.emit('login_result', { success: false, error: err.message })
    })

    // 超时保护：5 分钟后自动 kill
    this.loginTimeout = setTimeout(() => {
      if (this.loginProcess) {
        console.warn('[AuthManager] login process timed out, killing')
        this.loginProcess.kill()
        this.loginProcess = null
        this.emit('login_result', { success: false, error: 'Login timed out' })
      }
    }, LOGIN_TIMEOUT_MS)
  }

  /** 提交授权码到登录进程的 stdin */
  submitCode(code: string): boolean {
    if (!this.loginProcess?.stdin?.writable) {
      console.warn('[AuthManager] No active login process')
      return false
    }

    console.log(`[AuthManager] 提交授权码`)
    this.loginProcess.stdin.write(code + '\n')
    return true
  }

  /** 是否有登录进程在运行 */
  get isLoginInProgress(): boolean {
    return this.loginProcess !== null
  }

  /** 清理资源 */
  destroy(): void {
    this.clearLoginTimeout()
    if (this.loginProcess) {
      this.loginProcess.kill()
      this.loginProcess = null
    }
    this.removeAllListeners()
  }

  private clearLoginTimeout(): void {
    if (this.loginTimeout) {
      clearTimeout(this.loginTimeout)
      this.loginTimeout = null
    }
  }

  /** 从文本中提取 URL */
  private extractUrl(text: string): string | null {
    const match = text.match(/https?:\/\/[^\s"'<>]+/)
    return match ? match[0] : null
  }
}
