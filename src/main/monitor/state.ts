/**
 * 引擎状态持久化（ADR 3：`userData/state.json` 的内核侧实现；D2：v2 按 source 拆分）。
 *
 * - 只存跨进程必须保留的两件事（per-source）：首启基线是否完成（baselineDone）、
 *   累计命中数（totalHits）。v1 的顶层两字段在 load 时整体迁移到
 *   `sources['nodeseek']`——v1 时代只有 NodeSeek 一个来源。
 * - 纯 JSON + `schemaVersion`，原子写（同目录 tmp + `renameSync`，模式同 config store：
 *   失败时清理 tmp 后**向上抛**，由调用方决定是否提示；engine 侧会 catch 并记日志）。
 * - 损坏容错（读失败 / 非法 JSON / 形状或版本不认识）→ 备份 `{file}.corrupt-{ts}`
 *   后回默认值，绝不抛。形状校验是严格的：字段缺一/类型不对即算损坏。
 * - 文件不含敏感信息，不做 chmod 600（config store 才需要）。
 *
 * 零 electron 依赖，可在 node 下单测与 headless 直跑。
 */
import { randomInt } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * nodeseek 的状态键（D2）。两个消费方共用一个常量，防止漂移：
 * - v1 state.json 顶层 `{baselineDone, totalHits}` 迁移时落到 `sources['nodeseek']`
 *   （v1 时代只有 NodeSeek 一个来源）；
 * - v2 阶段 engine 读写 nodeseek 的状态（W2 泛化为 per-source id）。
 */
export const NODESEEK_SOURCE_ID = 'nodeseek'

/** 单个来源的引擎状态 */
export interface SourceEngineState {
  /** 首启基线是否已完成：false 时该来源下一轮成功抓取只入去重集不推送（防通知风暴） */
  baselineDone: boolean
  /** 该来源累计命中数（跨进程累计） */
  totalHits: number
}

/** 持久化文件形状（v2：per-source 拆分） */
export interface EngineState {
  schemaVersion: 2
  sources: Record<string, SourceEngineState>
}

export const DEFAULT_ENGINE_STATE: EngineState = { schemaVersion: 2, sources: {} }

const STATE_SCHEMA_VERSION = 2

export class FileEngineState {
  private readonly filePath: string
  private sources: Record<string, SourceEngineState> | null = null

  constructor(filePath: string) {
    this.filePath = filePath
  }

  /**
   * 同步从磁盘加载：
   * - 文件缺失 → 默认值（空 sources）；
   * - v1（顶层 baselineDone/totalHits）→ 迁移为 `sources['nodeseek']`；
   * - 损坏（读失败 / 非法 JSON / 形状不对）→ 备份 `.corrupt-{ts}` 后回默认值，不抛。
   */
  load(): void {
    this.sources = this.readFromDisk()
  }

  /**
   * 取某来源的状态（未 load 过则先 load）。来源无记录时返回默认值
   * `{baselineDone:false, totalHits:0}`（新来源首启照做基线）。返回拷贝。
   */
  getFor(sourceId: string): SourceEngineState {
    if (this.sources === null) this.load()
    const entry = (this.sources as Record<string, SourceEngineState>)[sourceId]
    if (entry === undefined) return { baselineDone: false, totalHits: 0 }
    return { ...entry }
  }

  /**
   * 浅合并更新某来源的状态 + 原子落盘（tmp + rename）。
   * `schemaVersion` 恒写 2；`totalHits` 非法值（非有限非负数）回退当前值。
   * 写失败时清理 tmp 后向上抛，内存值不变。
   */
  setFor(sourceId: string, patch: Partial<SourceEngineState>): void {
    if (this.sources === null) this.load()
    const current = this.getFor(sourceId)
    const next: SourceEngineState = {
      baselineDone:
        patch.baselineDone === undefined ? current.baselineDone : patch.baselineDone === true,
      totalHits: normalizeTotalHits(
        patch.totalHits !== undefined ? patch.totalHits : current.totalHits,
        current.totalHits
      )
    }
    const sources = { ...(this.sources as Record<string, SourceEngineState>), [sourceId]: next }
    this.writeAtomically(JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION, sources }, null, 2))
    this.sources = sources
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

  private readFromDisk(): Record<string, SourceEngineState> {
    if (!existsSync(this.filePath)) return { ...DEFAULT_ENGINE_STATE.sources }

    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf-8')
    } catch (err) {
      console.error(`[state] cannot read ${this.filePath}, using defaults:`, err)
      return { ...DEFAULT_ENGINE_STATE.sources }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return this.backupCorruptAndDefault(raw)
    }
    // v1 → v2：顶层两字段整体归属 nodeseek（v1 时代唯一来源）
    if (isV1State(parsed)) {
      return { [NODESEEK_SOURCE_ID]: { baselineDone: parsed.baselineDone, totalHits: parsed.totalHits } }
    }
    if (!isV2State(parsed)) return this.backupCorruptAndDefault(raw)
    return { ...parsed.sources }
  }

  /** 把损坏内容备份到 `{file}.corrupt-{ts}`；备份本身失败也只打日志 */
  private backupCorruptAndDefault(content: string): Record<string, SourceEngineState> {
    const backupPath = `${this.filePath}.corrupt-${Date.now()}`
    try {
      writeFileSync(backupPath, content, 'utf-8')
      console.error(`[state] engine state corrupt, backed up to ${backupPath}; using defaults`)
    } catch (err) {
      console.error(`[state] engine state corrupt and backup to ${backupPath} failed:`, err)
    }
    return { ...DEFAULT_ENGINE_STATE.sources }
  }
}

/** v1 严格形状校验：`{schemaVersion:1, baselineDone:boolean, totalHits:有限数>=0}` */
function isV1State(raw: unknown): raw is { baselineDone: boolean; totalHits: number } {
  if (typeof raw !== 'object' || raw === null) return false
  const s = raw as { schemaVersion?: unknown; baselineDone?: unknown; totalHits?: unknown }
  return (
    s.schemaVersion === 1 &&
    typeof s.baselineDone === 'boolean' &&
    isFiniteTotalHits(s.totalHits)
  )
}

/** v2 严格形状校验：`{schemaVersion:2, sources:Record<string, {baselineDone, totalHits}>}`，任一条目坏即整体损坏 */
function isV2State(raw: unknown): raw is EngineState {
  if (typeof raw !== 'object' || raw === null) return false
  const s = raw as Partial<EngineState>
  if (s.schemaVersion !== STATE_SCHEMA_VERSION) return false
  if (typeof s.sources !== 'object' || s.sources === null) return false
  for (const entry of Object.values(s.sources)) {
    if (typeof entry !== 'object' || entry === null) return false
    if (typeof entry.baselineDone !== 'boolean') return false
    if (!isFiniteTotalHits(entry.totalHits)) return false
  }
  return true
}

function isFiniteTotalHits(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function normalizeTotalHits(value: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback
}
