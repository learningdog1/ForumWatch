/**
 * 去重存储（ADR 3 / ADR 8.5 / D2）。
 *
 * - 去重键 = `${sourceId}:${topic.id}`（v2 起带来源前缀；v1 时代的裸 NodeSeek
 *   帖子 ID 在 load 时前缀化为 `nodeseek:{id}`，见 NODESEEK_SEEN_KEY_PREFIX）。
 * - 内存态：`{id, addedAt}` 顺序队列，超容量时最老的条目被环形淘汰（默认 1000 条，
 *   防止常驻进程无限膨胀）。
 * - 持久化：纯 JSON，原子写（同目录 tmp + `rename`），损坏文件备份成
 *   `{file}.corrupt-{ts}` 后从空集开始，绝不抛出（ADR 3）。
 * - 盘上版本兼容：v1（`schemaVersion:1`，裸 id）与 v2（`schemaVersion:2`，带前缀
 *   id）都能加载。v1 视为**成功加载**（不置 rebuiltFromCorrupt、无需补基线——
 *   键空间只是换了写法，集合没有丢失），下次 flush 自然落 v2。
 *
 * 零 electron 依赖，可在 node 下单测与 headless 直跑（ADR 2）。
 */
import { randomInt } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 去重条目：全局去重键（`${sourceId}:${topic.id}`）+ 入集时间戳（ms epoch） */
export interface SeenEntry {
  id: string
  addedAt: number
}

/** 序列化格式（写盘 JSON 的形状；v2 = id 带来源前缀） */
export interface SeenStoreData {
  schemaVersion: 2
  seen: SeenEntry[]
}

/**
 * nodeseek 的去重键前缀（D2）。两个消费方共用一个常量，防止漂移：
 * - v1 seen.json 裸 id 加载时前缀化为 `nodeseek:{id}`；
 * - v2 阶段 engine 组装 nodeseek 的去重键（W2 泛化为 `${sourceId}:${topicId}`）。
 * 两处必须一致，否则升级用户的旧集合作废、整页重推。
 */
export const NODESEEK_SEEN_KEY_PREFIX = 'nodeseek:'

/** 当前写盘版本 */
const SEEN_SCHEMA_VERSION = 2

/** 默认去重集容量（ADR 8.5：环形淘汰上限 1000 条） */
export const DEFAULT_SEEN_CAPACITY = 1000

/** 默认保留期：超过 7 天未再遇到的 ID 视为过期，可被 prune 清理 */
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 纯内存去重集。`Map` 保留插入顺序：队首即最老，容量超限时从队首环形淘汰。
 */
export class SeenStore {
  private readonly capacity: number
  /** id -> addedAt；Map 迭代顺序 = 插入顺序 = 新旧顺序（先旧后新） */
  private readonly entries = new Map<string, number>()

  constructor(capacity: number = DEFAULT_SEEN_CAPACITY) {
    this.capacity = Math.max(1, Math.floor(capacity))
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  /**
   * 入集。重复 add 同一 id 会刷新其时间戳并移到队尾（视为"最近见过"）；
   * 超容量时最老的条目被环形淘汰。
   */
  add(id: string, now: number = Date.now()): void {
    if (this.entries.has(id)) this.entries.delete(id)
    this.entries.set(id, now)
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  size(): number {
    return this.entries.size
  }

  /**
   * 淘汰"太久未见"的条目：`now - addedAt > cutoffMs` 者被移除。
   * @param cutoffMs 保留时长（ms），如 7 天传 `7*24*3600*1000`
   * @param now 当前时间戳，默认 `Date.now()`（可注入以便测试）
   * @returns 实际淘汰的条数
   */
  pruneOlderThan(cutoffMs: number, now: number = Date.now()): number {
    let pruned = 0
    for (const [id, addedAt] of this.entries) {
      if (now - addedAt > cutoffMs) {
        this.entries.delete(id)
        pruned++
      }
    }
    return pruned
  }

  /** 序列化为可 JSON 化的 plain object（按旧→新顺序；写盘恒为 v2 形状） */
  serialize(): SeenStoreData {
    const seen: SeenEntry[] = []
    for (const [id, addedAt] of this.entries) seen.push({ id, addedAt })
    return { schemaVersion: SEEN_SCHEMA_VERSION, seen }
  }

  /**
   * 从未知数据反序列化，坏数据不抛：
   * - 整体形状错误（非对象 / schemaVersion 不认识 / seen 非数组）→ 空 store；
   * - v1（`schemaVersion:1`，裸 id）→ 每条 id 前缀化 `nodeseek:{id}`（D2）；
   * - 单条坏条目（id 非非空字符串、addedAt 非有限数字）→ 跳过该条；
   * - 条数超出 capacity → 只保留最新的 capacity 条（环形淘汰语义）。
   */
  static deserialize(raw: unknown, capacity: number = DEFAULT_SEEN_CAPACITY): SeenStore {
    const store = new SeenStore(capacity)
    if (!looksCorrupt(raw)) {
      const data = raw as SeenFileShape
      const prefixIds = data.schemaVersion === 1 // v1 裸 id → nodeseek:{id}
      for (const item of data.seen) {
        if (typeof item !== 'object' || item === null) continue
        const { id, addedAt } = item as Partial<SeenEntry>
        if (typeof id !== 'string' || id.length === 0) continue
        if (typeof addedAt !== 'number' || !Number.isFinite(addedAt)) continue
        store.entries.set(prefixIds ? NODESEEK_SEEN_KEY_PREFIX + id : id, addedAt)
      }
      store.evictOverflow()
    }
    return store
  }

  /** 淘汰超出容量的最老条目 */
  private evictOverflow(): void {
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
}

/** 盘上文件的读取形状（v1|v2 共用；schemaVersion 放宽为 number 以便版本判别） */
type SeenFileShape = { schemaVersion: number; seen: unknown[] }

/** 整体形状校验：`{schemaVersion:1|2, seen: SeenEntry[]}` 之外的都算坏数据 */
function looksCorrupt(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return true
  const data = raw as Partial<SeenFileShape>
  if (data.schemaVersion !== 1 && data.schemaVersion !== SEEN_SCHEMA_VERSION) return true
  return !Array.isArray(data.seen)
}

/**
 * 文件 backed 的去重集：内存读改 + 显式 `flush()` 落盘。
 * 调用方节奏：启动 `load()` → 每轮 `has()/add()` → 轮末 `flush()`
 * （flush 写失败返回 false 并打日志，下一轮再试，进程不因此退出）。
 */
export class FileSeenStore {
  private readonly filePath: string
  private readonly capacity: number
  private readonly retentionMs: number
  private store: SeenStore
  /** 本次 load 是否因文件存在但读不出有效内容而以空集开始（见 load） */
  private corruptRebuilt = false

  constructor(
    filePath: string,
    capacity: number = DEFAULT_SEEN_CAPACITY,
    retentionMs: number = DEFAULT_RETENTION_MS
  ) {
    this.filePath = filePath
    this.capacity = capacity
    this.retentionMs = retentionMs
    this.store = new SeenStore(capacity)
  }

  /**
   * 本次 load 是否发生"文件存在但损坏（或不可读）→ 备份后从空集重建"。
   * 装配方据此强制补做基线（engine 会重置 baselineDone，ADR 8.9）：
   * 空 seen × baselineDone=true 会把首页整页当新帖推送（单页 mini 风暴）。
   */
  get rebuiltFromCorrupt(): boolean {
    return this.corruptRebuilt
  }

  /**
   * 同步从磁盘加载（保证 load 返回后 has/add 立即可用）：
   * - 文件缺失 = 空集（首启基线，配合"首轮只入集不推送"）；
   * - v1 文件（裸 id）= **成功加载**：id 前缀化后入集，不置 rebuiltFromCorrupt、
   *   不补基线（集合没丢，只是键的写法升级），下次 flush 自然落 v2；
   * - 文件存在但损坏（非法 JSON / schema 不认识 / 其他读失败）=
   *   备份成 `{file}.corrupt-{ts}` 后从空集开始，不抛（ADR 3），
   *   并置 `rebuiltFromCorrupt = true`（ADR 8.9）。
   */
  load(): void {
    this.corruptRebuilt = false
    if (!existsSync(this.filePath)) return
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf-8')
    } catch (err) {
      console.error(`[dedup] cannot read seen store ${this.filePath}, starting empty:`, err)
      this.corruptRebuilt = true
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.backupCorrupt(raw)
      return
    }
    if (looksCorrupt(parsed)) {
      this.backupCorrupt(raw)
      return
    }
    this.store = SeenStore.deserialize(parsed, this.capacity)
  }

  /** 把损坏内容备份到 `{file}.corrupt-{ts}`；备份本身失败也只打日志 */
  private backupCorrupt(content: string): void {
    this.corruptRebuilt = true
    const backupPath = `${this.filePath}.corrupt-${Date.now()}`
    try {
      writeFileSync(backupPath, content, 'utf-8')
      // 与 config store 同款收紧：备份内容原样保留，权限 600
      chmodSync(backupPath, 0o600)
      console.error(`[dedup] seen store corrupt, backed up to ${backupPath}; starting empty`)
    } catch (err) {
      console.error(`[dedup] seen store corrupt and backup to ${backupPath} failed:`, err)
    }
  }

  has(id: string): boolean {
    return this.store.has(id)
  }

  add(id: string): void {
    this.store.add(id)
  }

  size(): number {
    return this.store.size()
  }

  /** 清理超过保留期（默认 7 天）未再见到的 ID */
  prune(now: number = Date.now()): void {
    this.store.pruneOlderThan(this.retentionMs, now)
  }

  /**
   * 原子落盘：同目录写 `{file}.tmp-{pid}-{rand}` 再 `rename`（ADR 3）。
   * 写失败不抛：返回 `false` 并 console.error——调用方（engine）据此告警，
   * 下一轮 flush 再试。成功返回 `true`。
   */
  async flush(): Promise<boolean> {
    const payload = JSON.stringify(this.store.serialize())
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${randomInt(0, 0xffffff).toString(36)}`
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(tmpPath, payload, 'utf-8')
      await rename(tmpPath, this.filePath)
      return true
    } catch (err) {
      // 残留的 tmp 文件会在下次 flush 被正常流程覆盖/遗留无害，绝不向上抛
      console.error(`[dedup] flush failed (will retry next round):`, err)
      return false
    }
  }
}
