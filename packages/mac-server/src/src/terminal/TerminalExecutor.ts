import { spawn, type ChildProcess } from 'node:child_process'
import { v4 as uuidv4 } from 'uuid'
import { isWindows, killProcessCrossPlatform } from '../utils/platform.js'
import type { ServerEvent } from '@sessix/shared'

const EXEC_TIMEOUT_MS = 5 * 60 * 1000

export class TerminalExecutor {
  private processes = new Map<string, ChildProcess>()
  private eventCallbacks: Array<(event: ServerEvent) => void> = []

  onEvent(callback: (event: ServerEvent) => void): () => void {
    this.eventCallbacks.push(callback)
    return () => {
      const idx = this.eventCallbacks.indexOf(callback)
      if (idx !== -1) this.eventCallbacks.splice(idx, 1)
    }
  }

  private emit(event: ServerEvent): void {
    for (const cb of this.eventCallbacks) {
      try { cb(event) } catch (err) {
        console.error('[TerminalExecutor] Event callback error:', err)
      }
    }
  }

  exec(sessionId: string, command: string, cwd: string): string {
    const execId = uuidv4()

    const shell = isWindows ? 'powershell' : 'bash'
    const args = isWindows ? ['-Command', command] : ['-c', command]

    const proc = spawn(shell, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    this.processes.set(execId, proc)

    proc.stdout?.on('data', (chunk: Buffer) => {
      this.emit({
        type: 'terminal_output',
        sessionId,
        execId,
        stream: 'stdout',
        data: chunk.toString(),
      })
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      this.emit({
        type: 'terminal_output',
        sessionId,
        execId,
        stream: 'stderr',
        data: chunk.toString(),
      })
    })

    proc.on('exit', (code, signal) => {
      clearTimeout(timer)
      this.processes.delete(execId)
      this.emit({
        type: 'terminal_exit',
        sessionId,
        execId,
        code,
        signal,
      })
    })

    const timer = setTimeout(() => {
      if (this.processes.has(execId)) {
        killProcessCrossPlatform(proc)
      }
    }, EXEC_TIMEOUT_MS)

    console.log(`[TerminalExecutor] exec ${execId}: ${command.substring(0, 100)} (cwd: ${cwd})`)
    return execId
  }

  kill(execId: string): void {
    const proc = this.processes.get(execId)
    if (proc) {
      killProcessCrossPlatform(proc)
      console.log(`[TerminalExecutor] kill ${execId}`)
    }
  }

  destroy(): void {
    for (const [execId, proc] of this.processes) {
      killProcessCrossPlatform(proc)
      console.log(`[TerminalExecutor] cleanup ${execId}`)
    }
    this.processes.clear()
    this.eventCallbacks.length = 0
  }
}
