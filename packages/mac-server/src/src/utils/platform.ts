import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

export const isWindows = process.platform === 'win32'

/**
 * 跨平台杀进程
 *
 * Windows: taskkill /PID /T /F（杀进程树）
 * Unix: SIGTERM → 超时 SIGKILL
 */
export function killProcessCrossPlatform(
  proc: ChildProcess,
  timeoutMs = 3000,
): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve()
      return
    }

    const onExit = () => {
      clearTimeout(timer)
      resolve()
    }
    proc.once('exit', onExit)

    if (isWindows) {
      if (proc.pid) {
        spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
      }
    } else {
      proc.kill('SIGTERM')
    }

    const timer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        if (!isWindows) {
          proc.kill('SIGKILL')
        }
      }
      resolve()
    }, timeoutMs)
  })
}

/**
 * 判断进程退出码是否为正常退出
 */
export function isNormalExit(code: number | null, signal: string | null): boolean {
  if (code === 0) return true
  if (isWindows) {
    return code === 1
  }
  return code === 143 || signal === 'SIGTERM'
}
