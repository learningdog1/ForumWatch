/**
 * 结构化日志（ADR 2 / ADR 3 配套）。
 *
 * - 内存环形缓冲（默认 500 条）：`getRecent()` 给渲染进程 / headless 展示用。
 * - `onLog` 订阅：桌面装配与 headless 用它做 console 镜像；订阅方抛异常不扩散。
 * - 可选文件输出：`fileDir` 给了才写，`log-YYYY-MM-DD.txt` 按天滚动，
 *   创建时清理 7 天前的旧文件。追加写（appendFile）非原子——日志容忍丢失尾部。
 * - 文件写失败只 console.error 不抛，不影响内存缓冲与订阅通知。
 * - `close()` 后停止写文件、清空订阅；内存缓冲仍可记录（进程退出路径的日志不丢）。
 *
 * 零 electron 依赖，可在 node 下单测与 headless 直跑。
 */
import { appendFile } from 'node:fs/promises'
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { LogEntry, LogLevel } from '../../shared/types'

/** 默认内存缓冲条数（环形淘汰上限） */
export const DEFAULT_LOG_BUFFER_CAPACITY = 500

/** 旧日志文件保留天数；创建 logger 时清理更早的 `log-*.txt` */
export const LOG_RETENTION_DAYS = 7

const LOG_FILE_RE = /^log-(\d{4}-\d{2}-\d{2})\.txt$/
const RETENTION_MS = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000

export interface Logger {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
  /** 内存环形缓冲快照（旧→新），给 UI 用；返回拷贝，外部改动不影响内部 */
  getRecent(): LogEntry[]
  /** 订阅每条日志；返回取消订阅函数 */
  onLog(cb: (e: LogEntry) => void): () => void
  /** 停止文件写入、清空订阅；幂等 */
  close(): void
}

export interface CreateLoggerOptions {
  /** 内存缓冲容量，默认 500 */
  bufferCapacity?: number
  /** 给了才写文件：该目录下的 `log-YYYY-MM-DD.txt`，按天滚动 */
  fileDir?: string
  /** 测试注入假时钟；默认 Date.now */
  now?: () => number
}

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  return new RingBufferLogger(opts)
}

class RingBufferLogger implements Logger {
  private readonly capacity: number
  private readonly fileDir: string | undefined
  private readonly now: () => number
  private readonly buffer: LogEntry[] = []
  private readonly listeners = new Set<(e: LogEntry) => void>()
  /** 串行写队列尾（永远是已 settle 的 promise），保证文件行序与产生序一致 */
  private writeTail: Promise<void> = Promise.resolve()
  private fileEnabled: boolean
  private closed = false

  constructor(opts: CreateLoggerOptions) {
    this.capacity = Math.max(1, Math.floor(opts.bufferCapacity ?? DEFAULT_LOG_BUFFER_CAPACITY))
    this.now = opts.now ?? (() => Date.now())
    this.fileDir = opts.fileDir
    this.fileEnabled = opts.fileDir !== undefined
    if (this.fileDir !== undefined) {
      try {
        mkdirSync(this.fileDir, { recursive: true })
        this.cleanupOldFiles()
      } catch (err) {
        console.error(
          `[logger] cannot initialize log dir ${this.fileDir}, file logging disabled:`,
          err
        )
        this.fileEnabled = false
      }
    }
  }

  info(msg: string): void {
    this.log('info', msg)
  }

  warn(msg: string): void {
    this.log('warn', msg)
  }

  error(msg: string): void {
    this.log('error', msg)
  }

  getRecent(): LogEntry[] {
    return this.buffer.slice()
  }

  onLog(cb: (e: LogEntry) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  close(): void {
    this.closed = true
    this.listeners.clear()
  }

  private log(level: LogLevel, msg: string): void {
    const entry: LogEntry = { ts: new Date(this.now()).toISOString(), level, msg }
    this.buffer.push(entry)
    if (this.buffer.length > this.capacity) this.buffer.shift()
    // 拷贝一份再迭代：回调里取消订阅不影响本轮通知
    for (const cb of [...this.listeners]) {
      try {
        cb(entry)
      } catch (err) {
        console.error('[logger] onLog listener threw:', err)
      }
    }
    if (this.fileEnabled && !this.closed) this.appendToFile(entry)
  }

  private appendToFile(entry: LogEntry): void {
    const dir = this.fileDir as string // fileEnabled 为 true 时必已赋值
    const file = join(dir, `log-${localDateStr(this.now())}.txt`)
    const line = `${entry.ts} [${entry.level}] ${entry.msg}\n`
    this.writeTail = this.writeTail
      .then(() => appendFile(file, line, 'utf-8'))
      .catch((err: unknown) => {
        console.error(`[logger] append to ${file} failed:`, err)
      })
  }

  /** 启动清理：文件名日期早于（now - 7 天）那天的旧日志删除；失败只打日志 */
  private cleanupOldFiles(): void {
    const dir = this.fileDir as string
    const cutoff = localDateStr(this.now() - RETENTION_MS)
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch (err) {
      console.error(`[logger] cannot list log dir ${dir} for cleanup:`, err)
      return
    }
    for (const name of names) {
      const match = LOG_FILE_RE.exec(name)
      if (!match || match[1] >= cutoff) continue
      try {
        unlinkSync(join(dir, name))
      } catch (err) {
        console.error(`[logger] cannot remove old log ${name}:`, err)
      }
    }
  }
}

/** epoch ms → 本地时区 YYYY-MM-DD（日志文件名 / 清理阈值统一口径） */
function localDateStr(ms: number): string {
  const d = new Date(ms)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}
