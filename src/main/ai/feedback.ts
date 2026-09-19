/**
 * AI 反馈闭环存储（R7-W4，DEC-5）：命中行 👍/👎 的正负例持久化内核。
 *
 * - 数据模型：`FeedbackEntry` 一键一票，键 = `${sourceId}:${topicId}`（与 engine
 *   的全局去重键同口径）；同键再投 = **改票**（覆盖方向、刷新 ts 与标题，并移到
 *   队尾——队列位置即时间序），没有第三种状态。`undo(key)` 移除该键的票。
 * - 环形上限：正/负例**各自** 100 条（FEEDBACK_RING_CAPACITY），独立计数，
 *   超限淘汰该方向最老的一条；同一键改票只占新方向一个名额（旧方向计数随之
 *   减少）。
 * - 持久化：`feedback.json`（纯 JSON + schemaVersion），**每操作直写**（对齐
 *   state.ts 的 FileEngineState 模式——投票是低频用户动作，无需去抖），同目录
 *   tmp + renameSync 原子落盘；写失败清理 tmp 后向上抛（调用方决定提示），
 *   内存只在写成功后换新（内存 = 盘上不变式）。文件不含敏感信息，不做
 *   chmod 600（state.ts 先例；config store 才需要）。
 * - 损坏容错（对齐 config/state 先例）：文件读不出 → 日志 + 空集；非法 JSON /
 *   信封形状不对 → 备份 `{file}.corrupt-{ts}` 后从空集开始，绝不抛；单条坏
 *   条目只跳过该条（对齐 seen 的逐条宽容）。加载后超限收编（两方向各留最新
 *   100 条，防手工编辑塞爆）。
 * - `recentForPrompt()`：每方向取最近 ≤8 条标题（新→旧），供 evaluator 注入
 *   SYSTEM_PROMPT 尾部（DEC-5 接线见 evaluator.ts）。
 *
 * 零 electron 依赖，可在 node 下单测与 headless 直跑（ADR 2）。
 */
import { randomInt } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 一条反馈：key = `${sourceId}:${topicId}`（与 engine 去重键同口径） */
export interface FeedbackEntry {
  key: string
  /** 投票时的帖子标题（改票时刷新；原样存，换行剥离在 evaluator 注入时做） */
  title: string
  direction: 'positive' | 'negative'
  /** 投票/改票时刻（ISO 时间戳） */
  ts: string
}

/** 反馈文件名；装配方传 dataDir（join 后落其下）或完整 filePath */
export const FEEDBACK_FILE_NAME = 'feedback.json'

/** 正/负例各自的环形上限（独立计数，淘汰该方向最老的一条） */
export const FEEDBACK_RING_CAPACITY = 100

/** recentForPrompt 每方向取最近条数上限（新→旧） */
export const FEEDBACK_PROMPT_TAKE = 8

const FEEDBACK_SCHEMA_VERSION = 1

export interface FileFeedbackStoreOptions {
  /** feedback.json 完整路径（与 dataDir 二选一，优先） */
  filePath?: string
  /** 数据目录（feedback.json 落其下；与 filePath 二选一） */
  dataDir?: string
  /** 测试注入假时钟（epoch ms）；默认 Date.now */
  now?: () => number
}

/** 盘上信封形状（读路径宽松判型后再逐条校验） */
type FeedbackFileShape = { schemaVersion: number; entries: unknown[] }

export class FileFeedbackStore {
  private readonly filePath: string | undefined
  private readonly now: () => number
  /** 旧→新（追加序；改票 = 删除后重追加，队列位置即时间序）。null = 未加载 */
  private entries: FeedbackEntry[] | null = null

  constructor(opts: FileFeedbackStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now())
    this.filePath =
      opts.filePath !== undefined
        ? opts.filePath
        : opts.dataDir !== undefined
          ? join(opts.dataDir, FEEDBACK_FILE_NAME)
          : undefined
  }

  /**
   * 从磁盘加载（文件缺失 = 空集；损坏 = 备份后空集，见类注释）。
   * 显式调用于启动预热；不调也行——各访问器懒加载。
   */
  load(): void {
    this.entries = this.readFromDisk()
  }

  /**
   * 记票。同 key 已存在 → 改票（覆盖方向、刷新 ts 与标题、移到队尾）；
   * 新键追加。落该方向环形上限时淘汰最老的同方向条目。
   * 写盘失败向上抛（内存不变）；内存模式（无 filePath/dataDir）只更新内存。
   */
  vote(key: string, title: string, direction: 'positive' | 'negative'): void {
    const next = this.entriesCopy().filter((e) => e.key !== key)
    next.push({ key, title, direction, ts: new Date(this.now()).toISOString() })
    evictOverflow(next, direction)
    this.commit(next)
  }

  /** 移除该键的票；返回是否存在（不存在 = 无变更不落盘，幂等）。 */
  undo(key: string): boolean {
    const entries = this.entriesCopy()
    const next = entries.filter((e) => e.key !== key)
    const existed = next.length !== entries.length
    if (existed) this.commit(next)
    return existed
  }

  /** 取某键的当前票（拷贝；无票 undefined） */
  get(key: string): FeedbackEntry | undefined {
    const found = this.loaded().find((e) => e.key === key)
    return found === undefined ? undefined : { ...found }
  }

  /**
   * prompt 注入素材：正/负例各取最近 ≤8 条标题，新→旧（evaluator 逐次现读，
   * 投票/改票/撤销后下一次语义评估即生效——DEC-5 的闭环语义）。
   */
  recentForPrompt(): { positive: string[]; negative: string[] } {
    const positive: string[] = []
    const negative: string[] = []
    const entries = this.loaded()
    for (let i = entries.length - 1; i >= 0; i--) {
      if (positive.length >= FEEDBACK_PROMPT_TAKE && negative.length >= FEEDBACK_PROMPT_TAKE) break
      const e = entries[i]
      if (e.direction === 'positive') {
        if (positive.length < FEEDBACK_PROMPT_TAKE) positive.push(e.title)
      } else if (negative.length < FEEDBACK_PROMPT_TAKE) {
        negative.push(e.title)
      }
    }
    return { positive, negative }
  }

  // ---- 内部实现 ----------------------------------------------------------

  /** 当前条目（未加载则先 load） */
  private loaded(): FeedbackEntry[] {
    if (this.entries === null) this.load()
    return this.entries as FeedbackEntry[]
  }

  /** 深拷贝当前条目（vote/undo 的读改写底稿，失败不污染现值） */
  private entriesCopy(): FeedbackEntry[] {
    return this.loaded().map((e) => ({ ...e }))
  }

  /** 落盘成功后才换内存（内存 = 盘上不变式）；内存模式只换内存 */
  private commit(next: FeedbackEntry[]): void {
    if (this.filePath !== undefined) {
      this.writeAtomically(
        JSON.stringify({ schemaVersion: FEEDBACK_SCHEMA_VERSION, entries: next }, null, 2)
      )
    }
    this.entries = next
  }

  private readFromDisk(): FeedbackEntry[] {
    if (this.filePath === undefined || !existsSync(this.filePath)) return []
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf-8')
    } catch (err) {
      console.error(`[feedback] cannot read ${this.filePath}, starting empty:`, err)
      return []
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return this.backupCorruptAndEmpty(raw)
    }
    if (looksCorrupt(parsed)) return this.backupCorruptAndEmpty(raw)
    const entries: FeedbackEntry[] = []
    for (const item of (parsed as FeedbackFileShape).entries) {
      if (isFeedbackEntryLike(item)) entries.push(item) // 单条坏：跳过，不炸整个文件
    }
    evictOverflow(entries, 'positive')
    evictOverflow(entries, 'negative')
    return entries
  }

  /** 损坏内容备份到 `{file}.corrupt-{ts}`；备份本身失败也只打日志 */
  private backupCorruptAndEmpty(content: string): FeedbackEntry[] {
    const backupPath = `${this.filePath}.corrupt-${Date.now()}`
    try {
      writeFileSync(backupPath, content, 'utf-8')
      console.error(`[feedback] feedback file corrupt, backed up to ${backupPath}; starting empty`)
    } catch (err) {
      console.error(`[feedback] feedback file corrupt and backup to ${backupPath} failed:`, err)
    }
    return []
  }

  /** 同目录 tmp + renameSync 原子落盘（state.ts writeAtomically 同款）；失败清 tmp 后抛 */
  private writeAtomically(payload: string): void {
    const filePath = this.filePath as string
    const tmpPath = `${filePath}.tmp-${process.pid}-${randomInt(0, 0xffffff).toString(36)}`
    mkdirSync(dirname(filePath), { recursive: true })
    try {
      writeFileSync(tmpPath, payload, 'utf-8')
      renameSync(tmpPath, filePath)
    } catch (err) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // tmp 清理失败可忽略（残留无害，下次写会被新 tmp 覆盖或遗留不影响读）
      }
      throw err
    }
  }
}

/** 整体形状校验：`{schemaVersion:1, entries:[]}` 之外的都算坏数据 */
function looksCorrupt(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return true
  const data = raw as Partial<FeedbackFileShape>
  if (data.schemaVersion !== FEEDBACK_SCHEMA_VERSION) return true
  return !Array.isArray(data.entries)
}

/** 单条形状校验：key/title/ts 非空字符串 + direction 枚举 */
function isFeedbackEntryLike(raw: unknown): raw is FeedbackEntry {
  if (typeof raw !== 'object' || raw === null) return false
  const e = raw as Partial<FeedbackEntry>
  return (
    typeof e.key === 'string' &&
    e.key !== '' &&
    typeof e.title === 'string' &&
    (e.direction === 'positive' || e.direction === 'negative') &&
    typeof e.ts === 'string' &&
    e.ts !== ''
  )
}

/**
 * 环形淘汰（原地修改）：direction 方向超过 FEEDBACK_RING_CAPACITY 时，从队首
 * （最老）开始移除该方向的条目直到不超限。只动该方向——正负例独立计数，
 * 淘汰正例不碰负例（反之亦然）。
 */
function evictOverflow(entries: FeedbackEntry[], direction: 'positive' | 'negative'): void {
  let count = 0
  for (const e of entries) if (e.direction === direction) count++
  while (count > FEEDBACK_RING_CAPACITY) {
    const idx = entries.findIndex((e) => e.direction === direction)
    if (idx === -1) break
    entries.splice(idx, 1)
    count--
  }
}
