/**
 * 引擎状态持久化（ADR 3：`userData/state.json` 的内核侧实现；D2：v2 按 source 拆分）。
 *
 * - 只存跨进程必须保留的事情（per-source）：首启基线是否完成（baselineDone）、
 *   累计命中数（totalHits）、见过的最大发帖 id（maxSeenTopicId，W3 为
 *   "新帖 vs 回复顶起旧帖" 过滤做的存储地基——NodeSeek 首页按最后回复排序，
 *   旧帖被回复顶回首页会被误判新帖，引擎用 id ≤ 阈值的 unseen 帖当旧帖跳过）。
 *   v1 的顶层两字段在 load 时整体迁移到 `sources['nodeseek']`——v1 时代只有
 *   NodeSeek 一个来源。
 * - 纯 JSON + `schemaVersion`，原子写（同目录 tmp + `renameSync`，模式同 config store：
 *   失败时清理 tmp 后**向上抛**，由调用方决定是否提示；engine 侧会 catch 并记日志）。
 * - 损坏容错（读失败 / 非法 JSON / 形状或版本不认识）→ 备份 `{file}.corrupt-{ts}`
 *   后回默认值，绝不抛。形状校验分层：envelope 与 baselineDone/totalHits 严格
 *   （字段缺一/类型不对即算损坏）；maxSeenTopicId **宽容**——schemaVersion 仍为 2，
 *   旧 v2 文件缺该字段合法（读作 null），单条目值非法也只把**该条目的该字段**
 *   按 null 处理，条目与整文件不判损坏（阈值丢了可以重建，不值得核弹整文件）。
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
  /**
   * 见过的最大发帖 id（W3 存储地基）：引擎把 id ≤ 该阈值的 unseen 帖当"被回复顶起
   * 的旧帖"跳过。null = 无阈值（旧 v2 文件缺字段 / 首启基线前的默认 / 显式重置）。
   */
  maxSeenTopicId: number | null
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
   * `{baselineDone:false, totalHits:0, maxSeenTopicId:null}`（新来源首启照做基线）。
   * 返回拷贝。
   */
  getFor(sourceId: string): SourceEngineState {
    if (this.sources === null) this.load()
    const entry = (this.sources as Record<string, SourceEngineState>)[sourceId]
    if (entry === undefined) return { baselineDone: false, totalHits: 0, maxSeenTopicId: null }
    return { ...entry }
  }

  /**
   * 浅合并更新某来源的状态 + 原子落盘（tmp + rename）。
   * `schemaVersion` 恒写 2；`totalHits` 非法值（非有限非负数）回退当前值；
   * `maxSeenTopicId` patch 里 **undefined = 保持当前值不变**（engine 每有命中就
   * setFor totalHits，这里不保持的话阈值刚写就会被清掉），显式 null = 写 null
   * （重置阈值），非法 number（非有限/负/非安全整数）回退当前值。
   * 写失败时清理 tmp 后向上抛，内存值不变。
   */
  setFor(sourceId: string, patch: Partial<SourceEngineState>): void {
    if (this.sources === null) this.load()
    const current = this.getFor(sourceId)
    // 显式逐字段重构（不 spread patch）：保证三个已知字段全部落位，未知字段丢弃
    const next: SourceEngineState = {
      baselineDone:
        patch.baselineDone === undefined ? current.baselineDone : patch.baselineDone === true,
      totalHits: normalizeTotalHits(
        patch.totalHits !== undefined ? patch.totalHits : current.totalHits,
        current.totalHits
      ),
      maxSeenTopicId: normalizeMaxSeenTopicId(patch.maxSeenTopicId, current.maxSeenTopicId)
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
    // v1 → v2：顶层两字段整体归属 nodeseek（v1 时代唯一来源）；v1 无阈值概念，null
    if (isV1State(parsed)) {
      return {
        [NODESEEK_SOURCE_ID]: {
          baselineDone: parsed.baselineDone,
          totalHits: parsed.totalHits,
          maxSeenTopicId: null
        }
      }
    }
    if (!isV2State(parsed)) return this.backupCorruptAndDefault(raw)
    // maxSeenTopicId 宽容收编：逐条目把缺失/非法值归一为 null（条目本身已通过
    // baselineDone/totalHits 严格校验；阈值是第三轮新增字段，旧 v2 文件缺它合法）
    const sources: Record<string, SourceEngineState> = {}
    for (const [id, entry] of Object.entries(parsed.sources)) {
      sources[id] = {
        baselineDone: entry.baselineDone,
        totalHits: entry.totalHits,
        maxSeenTopicId: coerceMaxSeenTopicId((entry as { maxSeenTopicId?: unknown }).maxSeenTopicId)
      }
    }
    return sources
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

/**
 * v2 形状校验（envelope + 严格字段）：`{schemaVersion:2, sources:Record<string,
 * {baselineDone, totalHits}>}`，任一条目的 baselineDone/totalHits 坏即整体损坏。
 * **maxSeenTopicId 不参与本判定**——缺失/非法由 readFromDisk 逐条目按 null 收编
 * （第三轮新增字段，旧 v2 文件缺它合法，不能核弹整文件）。
 */
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

/** 阈值合法值：有限、非负、安全整数（topic id 语义，小数/Infinity/2^53+ 均非法） */
function isValidMaxSeenTopicId(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && Number.isFinite(value) && value >= 0
  )
}

/** 读路径收编：合法值原样保留，缺失/非法一律 null（宽容，不判损坏） */
function coerceMaxSeenTopicId(value: unknown): number | null {
  return isValidMaxSeenTopicId(value) ? value : null
}

/**
 * 写路径归一：undefined = 保持当前值（engine 每有命中就 setFor totalHits，
 * 不保持的话阈值刚写就会被清）；null = 显式重置；非法 number 回退当前值。
 */
function normalizeMaxSeenTopicId(
  value: number | null | undefined,
  fallback: number | null
): number | null {
  if (value === undefined) return fallback
  if (value === null) return null
  return isValidMaxSeenTopicId(value) ? value : fallback
}
