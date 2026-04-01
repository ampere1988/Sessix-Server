import { readdir, readFile, stat, open } from 'fs/promises'
import { createInterface } from 'readline'
import { join } from 'path'
import { homedir } from 'os'
import type { Project, HistoricalSession, ClaudeStreamEvent, Result } from '@sessix/shared'

// ============================================
// ProjectReader — 扫描 ~/.claude/projects/ 读取项目和会话
// ============================================

/** Claude 项目目录的根路径 */
const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')

/**
 * 返回指定会话对应的 JSONL 文件绝对路径（文件不一定存在）
 */
export function getSessionFilePath(projectPath: string, sessionId: string): string {
  return join(CLAUDE_PROJECTS_DIR, encodeDirName(projectPath), `${sessionId}.jsonl`)
}

/**
 * 扫描 ~/.claude/projects/ 目录，返回所有项目列表
 *
 * 目录结构：
 *   ~/.claude/projects/
 *     ├── -Users-huge-Project-Sessix/   ← 破折号替代斜杠的路径编码
 *     │   ├── abc123.jsonl               ← 会话文件
 *     │   └── def456.jsonl
 *     └── -Users-huge-Project-Other/
 *         └── ghi789.jsonl
 *
 * @returns 项目列表，包含每个项目的会话数量
 */
export async function getProjects(): Promise<Result<Project[]>> {
  try {
    // 检查目录是否存在
    const dirExists = await directoryExists(CLAUDE_PROJECTS_DIR)
    if (!dirExists) {
      return { ok: true, value: [] }
    }

    // 读取所有子目录
    const entries = await readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
    const projects: Project[] = []

    for (const entry of entries) {
      // 只处理目录，跳过文件和隐藏目录
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue
      }

      // 解码项目路径（Claude Code 使用破折号替代斜杠编码路径）
      const encodedPath = entry.name
      const decodedPath = decodeDirName(encodedPath)

      // 提取项目名称（路径的最后一段）
      const name = decodedPath.split('/').filter(Boolean).pop() ?? encodedPath

      // 统计该项目下的会话数量，并获取最近一次会话文件的修改时间
      const projectDir = join(CLAUDE_PROJECTS_DIR, encodedPath)
      const { count: sessionCount, latestMtime } = await countJsonlFilesWithMtime(projectDir)

      projects.push({
        id: encodedPath,
        path: decodedPath,
        name,
        sessionCount,
        lastActiveAt: latestMtime,
      })
    }

    // 按名称排序
    projects.sort((a, b) => a.name.localeCompare(b.name))

    return { ok: true, value: projects }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    }
  }
}

/**
 * 获取指定项目路径下的所有会话 ID 列表
 *
 * @param projectPath - 项目的绝对路径（解码后的）
 * @returns 会话 ID 列表（即 .jsonl 文件名去掉后缀）
 */
export async function getSessionsForProject(projectPath: string): Promise<Result<string[]>> {
  try {
    // 将项目路径编码为目录名（破折号替代斜杠）
    const encodedPath = encodeDirName(projectPath)
    const projectDir = join(CLAUDE_PROJECTS_DIR, encodedPath)

    // 检查目录是否存在
    const dirExists = await directoryExists(projectDir)
    if (!dirExists) {
      return { ok: true, value: [] }
    }

    // 读取 .jsonl 文件列表
    const entries = await readdir(projectDir, { withFileTypes: true })
    const sessionIds: string[] = []

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        // 去掉 .jsonl 后缀作为 session ID
        const sessionId = entry.name.slice(0, -6)
        sessionIds.push(sessionId)
      }
    }

    // 按文件修改时间倒序排列（最近的在前）
    const sessionWithMtime = await Promise.all(
      sessionIds.map(async (id) => {
        const filePath = join(projectDir, `${id}.jsonl`)
        try {
          const fileStat = await stat(filePath)
          return { id, mtime: fileStat.mtimeMs }
        } catch {
          return { id, mtime: 0 }
        }
      }),
    )
    sessionWithMtime.sort((a, b) => b.mtime - a.mtime)

    return { ok: true, value: sessionWithMtime.map((s) => s.id) }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    }
  }
}

/**
 * 获取指定项目的历史会话列表，限制最近 20 条
 *
 * 优先从 sessions-index.json 读取（包含 summary 等丰富信息），
 * 读取失败时回退到扫描 .jsonl 文件。
 */
export async function getHistoricalSessions(projectPath: string): Promise<Result<HistoricalSession[]>> {
  try {
    const encodedPath = encodeDirName(projectPath)
    const projectDir = join(CLAUDE_PROJECTS_DIR, encodedPath)

    const dirExists = await directoryExists(projectDir)
    if (!dirExists) {
      return { ok: true, value: [] }
    }

    // 扫描所有 .jsonl 文件和 UUID 目录，按 mtime 建立映射
    const entries = await readdir(projectDir, { withFileTypes: true })
    const jsonlFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl'))

    // 用 mtime 映射，供后续合并使用
    const mtimeMap = new Map<string, number>()
    for (const entry of jsonlFiles) {
      const sessionId = entry.name.slice(0, -6)
      const filePath = join(projectDir, entry.name)
      try {
        const fileStat = await stat(filePath)
        mtimeMap.set(sessionId, fileStat.mtimeMs)
      } catch {
        mtimeMap.set(sessionId, 0)
      }
    }

    // 新格式：UUID 目录（无对应 .jsonl 时单独计入）
    const uuidDirs = entries.filter(
      (e) => e.isDirectory() && UUID_RE.test(e.name) && !mtimeMap.has(e.name),
    )
    for (const entry of uuidDirs) {
      try {
        const fileStat = await stat(join(projectDir, entry.name))
        mtimeMap.set(entry.name, fileStat.mtimeMs)
      } catch {
        mtimeMap.set(entry.name, 0)
      }
    }

    // 优先尝试从 sessions-index.json 读取（有 summary 等丰富信息）
    const indexPath = join(projectDir, 'sessions-index.json')
    const sessionMap = new Map<string, HistoricalSession>()

    try {
      const indexContent = await readFile(indexPath, 'utf-8')
      const indexData = JSON.parse(indexContent) as {
        version: number
        entries: Array<{
          sessionId: string
          fileMtime?: number
          summary?: string
          firstPrompt?: string
          messageCount?: number
          modified?: string
        }>
      }

      if (indexData.version === 1 && Array.isArray(indexData.entries)) {
        for (const entry of indexData.entries) {
          // 优先使用磁盘上的实际 mtime（比索引里的更可靠）
          const mtime = mtimeMap.get(entry.sessionId)
            ?? entry.fileMtime
            ?? (entry.modified ? new Date(entry.modified).getTime() : 0)
          sessionMap.set(entry.sessionId, {
            sessionId: entry.sessionId,
            lastModified: mtime,
            summary: entry.summary,
            firstPrompt: entry.firstPrompt,
            messageCount: entry.messageCount,
          })
        }

        // 对 index 中有 messageCount（>0）但缺少 summary/firstPrompt 的条目，
        // 尝试从对应 .jsonl 文件补充提取第一条提示词
        await Promise.all(
          Array.from(sessionMap.values())
            .filter(s => (s.messageCount ?? 0) > 0 && !s.summary && !s.firstPrompt)
            .map(async (s) => {
              const filePath = join(projectDir, `${s.sessionId}.jsonl`)
              const firstPrompt = await extractFirstPrompt(filePath).catch(() => undefined)
              if (firstPrompt) s.firstPrompt = firstPrompt
            })
        )
      }
    } catch {
      // sessions-index.json 不存在或解析失败，继续用扫描结果
    }

    // 合并：将索引中没有的条目（.jsonl 文件或 UUID 目录）补充进来
    const uuidDirSet = new Set(uuidDirs.map((e) => e.name))
    for (const [sessionId, mtime] of mtimeMap) {
      if (!sessionMap.has(sessionId)) {
        if (uuidDirSet.has(sessionId)) {
          // UUID 目录格式：无顶层对话，标记 messageCount=-1 以区分
          sessionMap.set(sessionId, { sessionId, lastModified: mtime, messageCount: -1 })
        } else {
          const filePath = join(projectDir, `${sessionId}.jsonl`)
          const firstPrompt = await extractFirstPrompt(filePath).catch(() => undefined)
          sessionMap.set(sessionId, { sessionId, lastModified: mtime, firstPrompt })
        }
      }
    }

    const sessions = Array.from(sessionMap.values())
      .filter(s => {
        // 忽略完全空的会话（如 VS Code 新建但未发消息的会话）
        if (s.messageCount === 0) return false
        // UUID 目录格式（messageCount=-1）：保留
        if (s.messageCount === -1) return true
        if (s.firstPrompt === undefined && s.messageCount === undefined) return false
        return true
      })
    sessions.sort((a, b) => b.lastModified - a.lastModified)
    return { ok: true, value: sessions }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    }
  }
}

/**
 * 读取指定会话的 JSONL 文件，提取对话消息
 *
 * JSONL 格式（Claude Code 原生）：
 * - type: 'user' / 'assistant' / 'progress' / 'queue-operation' / 'file-history-snapshot'
 * - message: { role, content }（仅 user/assistant 有）
 *
 * 我们提取 user 和 assistant 类型的消息，映射为 ClaudeStreamEvent 格式。
 */
export async function getSessionHistory(
  projectPath: string,
  sessionId: string,
): Promise<Result<ClaudeStreamEvent[]>> {
  try {
    const encodedPath = encodeDirName(projectPath)
    const filePath = join(CLAUDE_PROJECTS_DIR, encodedPath, `${sessionId}.jsonl`)

    const raw = await readFile(filePath, 'utf-8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null
      throw err
    })
    if (raw === null) return { ok: false, error: new Error('ENOENT') }
    const lines = raw.split('\n').filter((l) => l.trim())

    const events: ClaudeStreamEvent[] = []

    for (const line of lines) {
      try {
        const obj = JSON.parse(line)
        const type = obj.type

        if (type === 'user' && obj.message) {
          // 过滤掉系统命令消息
          const msgContent = obj.message.content
          if (typeof msgContent === 'string') {
            if (msgContent.includes('<local-command') || msgContent.includes('<command-name>')) continue
          } else if (Array.isArray(msgContent)) {
            // 跳过只包含 tool_result 的消息（不可读）
            const hasText = msgContent.some(
              (b: any) => b.type === 'text' && !b.text?.includes('<local-command') && !b.text?.includes('<command-name>'),
            )
            if (!hasText) continue
          }

          // 规范化 content 为数组格式（JSONL 中 user content 可能是字符串）
          const normalizedContent = typeof msgContent === 'string'
            ? [{ type: 'text' as const, text: msgContent }]
            : Array.isArray(msgContent)
              ? msgContent.filter((b: any) => b.type === 'text' && typeof b.text === 'string')
              : []

          if (normalizedContent.length === 0) continue

          events.push({
            type: 'user',
            message: {
              ...obj.message,
              content: normalizedContent,
            },
            session_id: sessionId,
          })
        } else if (type === 'assistant' && obj.message) {
          // 保留 text、tool_use 和 thinking 块
          const content = (obj.message.content ?? []).filter(
            (b: any) => b.type === 'text' || b.type === 'tool_use' || b.type === 'thinking',
          )
          if (content.length === 0) continue

          events.push({
            type: 'assistant',
            message: {
              id: obj.message.id ?? obj.uuid ?? `hist-${events.length}`,
              model: obj.message.model ?? 'unknown',
              role: 'assistant',
              content,
              stop_reason: obj.message.stop_reason,
              usage: obj.message.usage,
            },
            session_id: sessionId,
          })
        }
      } catch {
        // 跳过无法解析的行
      }
    }

    // 从 JSONL 数据中合成一个 result 事件，提供 token 统计摘要
    if (events.length > 0) {
      let totalInputTokens = 0
      let totalOutputTokens = 0
      for (const ev of events) {
        if (ev.type === 'assistant' && ev.message.usage) {
          totalInputTokens += ev.message.usage.input_tokens ?? 0
          totalOutputTokens += ev.message.usage.output_tokens ?? 0
        }
      }
      if (totalInputTokens > 0 || totalOutputTokens > 0) {
        events.push({
          type: 'result',
          subtype: 'success',
          is_error: false,
          duration_ms: 0,
          num_turns: events.filter((e) => e.type === 'user').length,
          result: '',
          session_id: sessionId,
          usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
        })
      }
    }

    return { ok: true, value: events }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    }
  }
}

// ============================================
// 内部工具函数
// ============================================

/**
 * 从 JSONL 文件中提取第一条 user 消息的文本作为标题
 * 使用流式读取，只读取前 20 行以避免加载整个大文件到内存
 */
async function extractFirstPrompt(filePath: string): Promise<string | undefined> {
  let fileHandle
  try {
    fileHandle = await open(filePath, 'r')
    const rl = createInterface({
      input: fileHandle.createReadStream({ encoding: 'utf-8' }),
      crlfDelay: Infinity,
    })

    let lineCount = 0
    for await (const line of rl) {
      if (++lineCount > 20) break
      if (!line.trim()) continue
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'user' && obj.message) {
          const msgContent = obj.message.content
          let text = ''
          if (typeof msgContent === 'string') {
            text = msgContent
          } else if (Array.isArray(msgContent)) {
            const textBlock = msgContent.find((b: any) => b.type === 'text' && typeof b.text === 'string')
            text = textBlock?.text ?? ''
          }
          // 过滤系统消息
          if (text && !text.includes('<local-command') && !text.includes('<command-name>')) {
            // 先整块移除 <ide_opened_file>...</ide_opened_file>（含文件内容）
            text = text.replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/gi, '')
            // 再清理残余标签
            text = text.replace(/<[^>]+>/g, '').trim()
            rl.close()
            return text.length > 80 ? text.slice(0, 80) + '...' : text
          }
        }
      } catch { /* skip unparseable line */ }
    }
  } catch { /* file read error */ }
  finally {
    await fileHandle?.close()
  }
  return undefined
}

/**
 * 解码 Claude Code 的项目目录名
 * 格式：破折号替代斜杠，例如 "-Users-huge-Project-Sessix" → "/Users/huge/Project/Sessix"
 * 特殊情况：连续破折号 "--" 表示原始路径中包含破折号
 */
function decodeDirName(dirName: string): string {
  // 先处理连续破折号（转义的破折号），用占位符暂存
  const placeholder = '\x00'
  const escaped = dirName.replace(/--/g, placeholder)
  // 单破折号替代斜杠
  const decoded = escaped.replace(/-/g, '/')
  // 还原转义的破折号
  return decoded.replace(new RegExp(placeholder, 'g'), '-')
}

/**
 * 编码路径为 Claude Code 的目录名格式
 */
function encodeDirName(path: string): string {
  // 先转义路径中的破折号为双破折号
  const escaped = path.replace(/-/g, '--')
  // 斜杠替换为单破折号
  return escaped.replace(/\//g, '-')
}

/**
 * 检查目录是否存在
 */
async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const s = await stat(dirPath)
    return s.isDirectory()
  } catch {
    return false
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 统计目录下的会话数量，并返回最新修改时间。
 * 支持两种格式：
 *   - 旧格式：<uuid>.jsonl 文件
 *   - 新格式：<uuid>/ 目录（无对应 .jsonl，新版 Claude Code subagent 模式）
 */
async function countJsonlFilesWithMtime(dirPath: string): Promise<{ count: number; latestMtime: number }> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    const jsonlNames = new Set(
      entries
        .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
        .map((e) => e.name.slice(0, -6)),
    )

    // UUID 目录中，若已有对应的 .jsonl 文件则不重复计数
    const uuidDirs = entries.filter(
      (e) => e.isDirectory() && UUID_RE.test(e.name) && !jsonlNames.has(e.name),
    )

    let latestMtime = 0
    const allEntries = [
      ...entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl')),
      ...uuidDirs,
    ]
    for (const entry of allEntries) {
      try {
        const fileStat = await stat(join(dirPath, entry.name))
        if (fileStat.mtimeMs > latestMtime) latestMtime = fileStat.mtimeMs
      } catch { /* ignore */ }
    }
    return { count: jsonlNames.size + uuidDirs.length, latestMtime }
  } catch {
    return { count: 0, latestMtime: 0 }
  }
}
