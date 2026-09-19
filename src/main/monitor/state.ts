/**
 * 引擎状态持久化（ADR 3：`userData/state.json` 的内核侧实现）。
 *
 * - 只存跨进程必须保留的两件事：首启基线是否完成（baselineDone）、累计命中数（totalHits）。
 * - 纯 JSON + `schemaVersion`，原子写（同目录 tmp + `renameSync`，模式同 config store：
 *   失败时清理 tmp 后**向上抛**，由调用方决定是否提示；engine 侧会 catch 并记日志）。
 * - 损坏容错（读失败 / 非法 JSON / 形状或版本不认识）→ 备份 `{file}.corrupt-{ts}`
 *   后回默认值，绝不抛。形状校验是严格的：三个字段缺一即算损坏。
 * - 文件不含敏感信息，不做 chmod 600（config store 才需要）。
 *
 * 零 electron 依赖，可在 node 下单测与 headless 直跑。
 */
import { randomInt } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface EngineState {
  schemaVersion: 1
  /** 首启基线是否已完成：false 时下一轮成功抓取只入去重集不推送（防通知风暴） */
  baselineDone: boolean
  /** 累计命中数（跨进程累计） */
  totalHits: number
}

export const DEFAULT_ENGINE_STATE: EngineState = {
  schemaVersion: 1,
  baselineDone: false,
  totalHits: 0
}

const STATE_SCHEMA_VERSION = 1

export class FileEngineState {
  private readonly filePath: string
  private state: EngineState | null = null

  constructor(filePath: string) {
    this.filePath = filePath
  }

  /**
   * 同步从磁盘加载：
   * - 文件缺失 → 默认值；
   * - 损坏（读失败 / 非法 JSON / 形状不对）→ 备份 `.corrupt-{ts}` 后回默认值，不抛。
   */
  load(): EngineState {
    this.state = this.readFromDisk()
    return { ...this.state }
  }

  /** 取当前状态（未 load 过则先 load）；返回拷贝，外部改动不污染内部 */
  get(): EngineState {
    if (this.state === null) this.load()
    return { ...(this.state as EngineState) }
  }

  /**
   * 浅合并更新 + 原子落盘（tmp + rename）。
   * `schemaVersion` 恒写 1；`totalHits` 非法值（非有限正数）回退当前值。
   * 写失败时清理 tmp 后向上抛，内存值不变。
   */
  set(patch: Partial<EngineState>): void {
    const current = this.get()
    const next: EngineState = {
      schemaVersion: STATE_SCHEMA_VERSION,
      baselineDone:
        patch.baselineDone === undefined ? current.baselineDone : patch.baselineDone === true,
      totalHits: normalizeTotalHits(
        patch.totalHits !== undefined ? patch.totalHits : current.totalHits,
        current.totalHits
      )
    }
    this.writeAtomically(JSON.stringify(next, null, 2))
    this.state = next
  }

  // ---- 内部实现 ----------------------------------------------------------

  private writeAtomically(payload: string): void {
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${randomInt(0, 0xffffff).toString(36)}`
    mkdirSync(dirname(this.filePath), { recursive: true })
    try {
      writeFileSync(tmpPath, payload, 'utf-8')
      renameSync(tmpPath, this.filePath)
    } catch (err) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // tmp 清理失败可忽略
      }
      throw err
    }
  }

  private readFromDisk(): EngineState {
    if (!existsSync(this.filePath)) return { ...DEFAULT_ENGINE_STATE }

    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf-8')
    } catch (err) {
      console.error(`[state] cannot read ${this.filePath}, using defaults:`, err)
      return { ...DEFAULT_ENGINE_STATE }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return this.backupCorruptAndDefault(raw)
    }
    if (!isEngineState(parsed)) return this.backupCorruptAndDefault(raw)
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      baselineDone: parsed.baselineDone,
      totalHits: parsed.totalHits
    }
  }

  /** 把损坏内容备份到 `{file}.corrupt-{ts}`；备份本身失败也只打日志 */
  private backupCorruptAndDefault(content: string): EngineState {
    const backupPath = `${this.filePath}.corrupt-${Date.now()}`
    try {
      writeFileSync(backupPath, content, 'utf-8')
      console.error(`[state] engine state corrupt, backed up to ${backupPath}; using defaults`)
    } catch (err) {
      console.error(`[state] engine state corrupt and backup to ${backupPath} failed:`, err)
    }
    return { ...DEFAULT_ENGINE_STATE }
  }
}

/** 严格形状校验：`{schemaVersion:1, baselineDone:boolean, totalHits:有限数>=0}` */
function isEngineState(raw: unknown): raw is EngineState {
  if (typeof raw !== 'object' || raw === null) return false
  const s = raw as Partial<EngineState>
  return (
    s.schemaVersion === STATE_SCHEMA_VERSION &&
    typeof s.baselineDone === 'boolean' &&
    typeof s.totalHits === 'number' &&
    Number.isFinite(s.totalHits) &&
    s.totalHits >= 0
  )
}

function normalizeTotalHits(value: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback
}
