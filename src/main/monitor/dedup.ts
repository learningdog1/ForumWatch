/**
 * 去重存储（ADR 3 / ADR 8.5）。
 *
 * - 去重键 = NodeSeek 帖子 ID（字符串）。
 * - 内存态：`{id, addedAt}` 顺序队列，超容量时最老的条目被环形淘汰（默认 1000 条，
 *   防止常驻进程无限膨胀）。
 * - 持久化：纯 JSON（`schemaVersion: 1`），原子写（同目录 tmp + `rename`），
 *   损坏文件备份成 `{file}.corrupt-{ts}` 后从空集开始，绝不抛出（ADR 3）。
 *
 * 零 electron 依赖，可在 node 下单测与 headless 直跑（ADR 2）。
 */
import { randomInt } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 去重条目：帖子 ID + 入集时间戳（ms epoch） */
export interface SeenEntry {
  id: string
  addedAt: number
}

/** 序列化格式（写盘 JSON 的形状） */
export interface SeenStoreData {
  schemaVersion: 1
  seen: SeenEntry[]
}

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

  /** 序列化为可 JSON 化的 plain object（按旧→新顺序） */
  serialize(): SeenStoreData {
    const seen: SeenEntry[] = []
    for (const [id, addedAt] of this.entries) seen.push({ id, addedAt })
    return { schemaVersion: 1, seen }
  }

  /**
   * 从未知数据反序列化，坏数据不抛：
   * - 整体形状错误（非对象 / schemaVersion 不认识 / seen 非数组）→ 空 store；
   * - 单条坏条目（id 非非空字符串、addedAt 非有限数字）→ 跳过该条；
   * - 条数超出 capacity → 只保留最新的 capacity 条（环形淘汰语义）。
   */
  static deserialize(raw: unknown, capacity: number = DEFAULT_SEEN_CAPACITY): SeenStore {
    const store = new SeenStore(capacity)
    if (!isCorruptShape(raw)) {
      for (const item of (raw as SeenStoreData).seen) {
        if (typeof item !== 'object' || item === null) continue
        const { id, addedAt } = item as Partial<SeenEntry>
        if (typeof id !== 'string' || id.length === 0) continue
        if (typeof addedAt !== 'number' || !Number.isFinite(addedAt)) continue
        store.entries.set(id, addedAt)
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

/** 整体形状校验：`{schemaVersion:1, seen: SeenEntry[]}` 之外的都算坏数据 */
function isCorruptShape(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return true
  const data = raw as Partial<SeenStoreData>
  return data.schemaVersion !== 1 || !Array.isArray(data.seen)
}

/**
 * 文件 backed 的去重集：内存读改 + 显式 `flush()` 落盘。
 * 调用方节奏：启动 `load()` → 每轮 `has()/add()` → 轮末 `flush()`
 * （flush 写失败只打日志，下一轮再试，进程不因此退出）。
 */
export class FileSeenStore {
  private readonly filePath: string
  private readonly capacity: number
  private readonly retentionMs: number
  private store: SeenStore

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
   * 同步从磁盘加载（保证 load 返回后 has/add 立即可用）：
   * - 文件缺失 = 空集（首启基线，配合"首轮只入集不推送"）；
   * - 文件存在但损坏（非法 JSON / schema 不认识 / 其他读失败）=
   *   备份成 `{file}.corrupt-{ts}` 后从空集开始，不抛（ADR 3）。
   */
  load(): void {
    if (!existsSync(this.filePath)) return
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf-8')
    } catch (err) {
      console.error(`[dedup] cannot read seen store ${this.filePath}, starting empty:`, err)
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.backupCorrupt(raw)
      return
    }
    if (isCorruptShape(parsed)) {
      this.backupCorrupt(raw)
      return
    }
    this.store = SeenStore.deserialize(parsed, this.capacity)
  }

  /** 把损坏内容备份到 `{file}.corrupt-{ts}`；备份本身失败也只打日志 */
  private backupCorrupt(content: string): void {
    const backupPath = `${this.filePath}.corrupt-${Date.now()}`
    try {
      writeFileSync(backupPath, content, 'utf-8')
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
   * 写失败不抛，只 console.error——下一轮 flush 再试。
   */
  async flush(): Promise<void> {
    const payload = JSON.stringify(this.store.serialize())
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${randomInt(0, 0xffffff).toString(36)}`
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(tmpPath, payload, 'utf-8')
      await rename(tmpPath, this.filePath)
    } catch (err) {
      // 残留的 tmp 文件会在下次 flush 被正常流程覆盖/遗留无害，绝不向上抛
      console.error(`[dedup] flush failed (will retry next round):`, err)
    }
  }
}
