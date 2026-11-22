/**
 * 社区活动内存索引存储 + 异步原子持久化 + 多进程只读副本视图（零 Electron）。
 *
 * 高并发核心设计：
 * 1. **读路径 100% 纯内存（零磁盘 I/O）**：所有客户端查询（`queryPublic` / `getPublicDetail`）
 *    直接在内存 Map 与预排序索引上完成，单次查询耗时微秒级；
 * 2. **时间状态零陈旧修订号（`getEffectiveRevision`）**：除数据变更自增 `revision` 外，
 *    自动收集全部已发布活动的 `startsAtEpochMillis` / `endsAtEpochMillis` 边界点，
 *    二分计算当前已跨过的边界数拼入 `effectiveRevision`——无需后台轮询改状态，活动到点开奖/截止的
 *    那一毫秒起 `ETag` 与响应缓存自动平滑失效，绝不返回过期的 `ongoing` 状态；
 * 3. **写路径异步去抖原子落盘（tmp + rename）**：新增/编辑活动只改内存并排队合并写盘，
 *    绝不阻塞 HTTP 事件循环；退出时 `flush()` 保证零丢数据；
 * 4. **Cluster 多进程副本同步（`exportSnapshot` / `ReplicaActivityView`）**：主进程变更后可将
 *    轻量快照广播给 N 个只读 API Worker，Worker 拥有完全一致的内存查询与缓存失效能力。
 */
import { randomInt } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  ActivityDetail,
  ActivityFeedPage,
  ActivityItem,
  ActivityKind,
  ActivityLabeledLink,
  ActivityTimeStatus
} from '../../shared/types'

export const ACTIVITIES_DIR_NAME = 'activities'
export const ACTIVITIES_FILE_NAME = 'activities.json'

const SCHEMA_VERSION = 1
const MAX_AUTO_ITEMS = 2_000
const MAX_TOMBSTONES = 5_000
const MAX_EVALUATED_KEYS = 5_000
const PERSIST_DEBOUNCE_MS = 100

const VALID_KINDS = new Set<ActivityKind>([
  'lottery',
  'giveaway',
  'promo',
  'event',
  'floor',
  'other'
])

/** 内部持久化记录（比公开契约多管理态字段：published / forceEnded / origin / manualOverride） */
export interface ActivityRecord {
  id: string
  sourceId: string
  topicId: string | null
  title: string
  summary: string
  sourceUrl: string
  organizer: string
  organizerUrl: string | null
  startsAtEpochMillis: number | null
  endsAtEpochMillis: number | null
  forceEnded: boolean
  published: boolean
  pinned: boolean
  kind: ActivityKind
  category: string
  categorySlug: string
  luckyUrl: string | null
  drawFloor: number | null
  prize: string | null
  participation: string | null
  tags: string[]
  bodyMarkdown: string
  externalLinks: ActivityLabeledLink[]
  origin: 'auto' | 'manual'
  manualOverride: boolean
  createdAtEpochMillis: number
  updatedAtEpochMillis: number
}

export interface ActivityQuery {
  page?: number
  pageSize?: number
  /** 'active' = ongoing ∪ upcoming；'all' 或缺省 = 全部已发布 */
  status?: 'all' | 'active' | ActivityTimeStatus
  /** 单个或逗号分隔多个 kind */
  kind?: string
  sourceId?: string
  q?: string
  updatedAfter?: number
}

export interface ActivitySnapshotPayload {
  revision: number
  updatedAtEpochMillis: number
  records: ActivityRecord[]
}

/** 只读查询面（主进程 ActivityStore 与 Cluster Worker 的 ReplicaActivityView 共用） */
export interface ActivityReadView {
  getEffectiveRevision(nowMs?: number): string
  getUpdatedAtEpochMillis(): number
  queryPublic(query: ActivityQuery, nowMs?: number): ActivityFeedPage
  getPublicDetail(idOrTopicId: string, nowMs?: number): ActivityDetail | null
  size(): number
}

export interface AutoUpsertInput {
  id: string
  sourceId: string
  topicId: string
  title: string
  summary: string
  sourceUrl: string
  organizer: string
  organizerUrl?: string | null
  startsAtEpochMillis?: number | null
  endsAtEpochMillis?: number | null
  forceEnded?: boolean
  kind?: ActivityKind
  category?: string
  categorySlug?: string
  luckyUrl?: string | null
  drawFloor?: number | null
  prize?: string | null
  participation?: string | null
  tags?: string[]
  bodyMarkdown?: string
  externalLinks?: ActivityLabeledLink[]
}

export interface AdminCreateInput {
  id?: string
  title: string
  summary?: string
  sourceUrl?: string
  organizer?: string
  organizerUrl?: string | null
  startsAtEpochMillis?: number | null
  endsAtEpochMillis?: number | null
  forceEnded?: boolean
  published?: boolean
  pinned?: boolean
  kind?: ActivityKind
  sourceId?: string
  topicId?: string | null
  category?: string
  categorySlug?: string
  luckyUrl?: string | null
  drawFloor?: number | null
  prize?: string | null
  participation?: string | null
  tags?: string[]
  bodyMarkdown?: string
  externalLinks?: ActivityLabeledLink[]
}

export interface AdminPatchInput {
  title?: string
  summary?: string
  sourceUrl?: string
  organizer?: string
  organizerUrl?: string | null
  startsAtEpochMillis?: number | null
  endsAtEpochMillis?: number | null
  forceEnded?: boolean
  published?: boolean
  pinned?: boolean
  kind?: ActivityKind
  luckyUrl?: string | null
  drawFloor?: number | null
  prize?: string | null
  participation?: string | null
  tags?: string[]
  bodyMarkdown?: string
  externalLinks?: ActivityLabeledLink[]
}

interface DiskEnvelope {
  schemaVersion: number
  updatedAtEpochMillis: number
  items: ActivityRecord[]
  tombstones: string[]
  evaluatedKeys: string[]
}

/**
 * 动态计算某条记录在 `nowMs` 时刻的活动状态。
 */
export function resolveActivityStatus(rec: ActivityRecord, nowMs: number): ActivityTimeStatus {
  if (rec.forceEnded) return 'ended'
  if (rec.endsAtEpochMillis !== null && nowMs >= rec.endsAtEpochMillis) return 'ended'
  if (rec.startsAtEpochMillis !== null && nowMs < rec.startsAtEpochMillis) return 'upcoming'
  return 'ongoing'
}

function statusSortRank(status: ActivityTimeStatus): number {
  switch (status) {
    case 'ongoing':
      return 0
    case 'upcoming':
      return 1
    case 'ended':
      return 2
  }
}

function toPublicItem(rec: ActivityRecord, nowMs: number): ActivityItem {
  return {
    id: rec.id,
    title: rec.title,
    summary: rec.summary,
    sourceUrl: rec.sourceUrl,
    organizer: rec.organizer,
    organizerUrl: rec.organizerUrl,
    startsAtEpochMillis: rec.startsAtEpochMillis,
    endsAtEpochMillis: rec.endsAtEpochMillis,
    status: resolveActivityStatus(rec, nowMs),
    kind: rec.kind,
    pinned: rec.pinned,
    sourceId: rec.sourceId,
    topicId: rec.topicId,
    category: rec.category,
    categorySlug: rec.categorySlug,
    luckyUrl: rec.luckyUrl,
    drawFloor: rec.drawFloor,
    prize: rec.prize,
    participation: rec.participation,
    tags: rec.tags.slice(),
    createdAtEpochMillis: rec.createdAtEpochMillis,
    updatedAtEpochMillis: rec.updatedAtEpochMillis
  }
}

function toPublicDetail(rec: ActivityRecord, nowMs: number): ActivityDetail {
  return {
    ...toPublicItem(rec, nowMs),
    bodyMarkdown: rec.bodyMarkdown,
    externalLinks: rec.externalLinks.map((l) => ({ text: l.text, url: l.url }))
  }
}

/** 统计已跨过的有序边界点数量（二分查找，O(log N)） */
function countCrossedTransitions(sortedPoints: readonly number[], nowMs: number): number {
  let lo = 0
  let hi = sortedPoints.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (sortedPoints[mid]! <= nowMs) lo = mid + 1
    else hi = mid
  }
  return lo
}

function buildTransitionPoints(records: Iterable<ActivityRecord>): number[] {
  const pts: number[] = []
  for (const r of records) {
    if (!r.published || r.forceEnded) continue
    if (r.startsAtEpochMillis !== null) pts.push(r.startsAtEpochMillis)
    if (r.endsAtEpochMillis !== null) pts.push(r.endsAtEpochMillis)
  }
  pts.sort((a, b) => a - b)
  return pts
}

function executePublicQuery(
  publishedRecords: readonly ActivityRecord[],
  updatedAtEpochMillis: number,
  query: ActivityQuery,
  nowMs: number
): ActivityFeedPage {
  const page =
    typeof query.page === 'number' && Number.isFinite(query.page)
      ? Math.max(1, Math.floor(query.page))
      : 1
  const pageSize =
    typeof query.pageSize === 'number' && Number.isFinite(query.pageSize)
      ? Math.min(100, Math.max(1, Math.floor(query.pageSize)))
      : 20

  const sourceFilter =
    typeof query.sourceId === 'string' && query.sourceId.trim() !== ''
      ? query.sourceId.trim()
      : null

  const kindSet =
    typeof query.kind === 'string' && query.kind.trim() !== ''
      ? new Set(
          query.kind
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter((s) => VALID_KINDS.has(s as ActivityKind))
        )
      : null

  const qLower =
    typeof query.q === 'string' && query.q.trim() !== '' ? query.q.trim().toLowerCase() : null

  const updatedAfter =
    typeof query.updatedAfter === 'number' && Number.isFinite(query.updatedAfter) && query.updatedAfter > 0
      ? query.updatedAfter
      : null

  const statusFilter = query.status ?? 'all'

  const counts = { all: 0, ongoing: 0, upcoming: 0, ended: 0 }
  const matched: Array<{ rec: ActivityRecord; status: ActivityTimeStatus }> = []

  for (const rec of publishedRecords) {
    if (sourceFilter !== null && rec.sourceId !== sourceFilter) continue
    if (kindSet !== null && kindSet.size > 0 && !kindSet.has(rec.kind)) continue
    if (updatedAfter !== null && rec.updatedAtEpochMillis <= updatedAfter) continue
    if (qLower !== null && !recordMatchesQuery(rec, qLower)) continue

    const st = resolveActivityStatus(rec, nowMs)
    counts.all++
    counts[st]++

    if (statusFilter === 'active') {
      if (st !== 'ongoing' && st !== 'upcoming') continue
    } else if (statusFilter !== 'all' && st !== statusFilter) {
      continue
    }
    matched.push({ rec, status: st })
  }

  // 排序：置顶优先 → 状态优先级（ongoing > upcoming > ended）→ 最新活动优先
  matched.sort((a, b) => {
    if (a.rec.pinned !== b.rec.pinned) return a.rec.pinned ? -1 : 1
    const rankDiff = statusSortRank(a.status) - statusSortRank(b.status)
    if (rankDiff !== 0) return rankDiff
    const timeA = a.rec.startsAtEpochMillis ?? a.rec.createdAtEpochMillis
    const timeB = b.rec.startsAtEpochMillis ?? b.rec.createdAtEpochMillis
    if (timeA !== timeB) return timeB - timeA
    return b.rec.updatedAtEpochMillis - a.rec.updatedAtEpochMillis
  })

  const total = matched.length
  const offset = (page - 1) * pageSize
  const slice = matched.slice(offset, offset + pageSize)
  const hasMore = offset + slice.length < total

  return {
    ok: true,
    updatedAtEpochMillis,
    serverTimeEpochMillis: nowMs,
    page,
    pageSize,
    page_size: pageSize,
    total,
    hasMore,
    has_more: hasMore,
    counts,
    items: slice.map(({ rec, status }) => ({
      ...toPublicItem(rec, nowMs),
      status
    }))
  }
}

function recordMatchesQuery(rec: ActivityRecord, qLower: string): boolean {
  if (rec.title.toLowerCase().includes(qLower)) return true
  if (rec.summary.toLowerCase().includes(qLower)) return true
  if (rec.organizer.toLowerCase().includes(qLower)) return true
  if (rec.prize !== null && rec.prize.toLowerCase().includes(qLower)) return true
  for (const tag of rec.tags) {
    if (tag.toLowerCase().includes(qLower)) return true
  }
  return false
}

export interface ActivityStoreOptions {
  /** 存储目录（`<dataDir>/activities`）；缺省 = 纯内存（单测零文件副作用） */
  dataDir?: string
  now?: () => number
  onChanged?: (snapshot: ActivitySnapshotPayload) => void
}

export class ActivityStore implements ActivityReadView {
  private readonly filePath: string | undefined
  private readonly now: () => number
  private readonly onChanged?: (snapshot: ActivitySnapshotPayload) => void

  private readonly byId = new Map<string, ActivityRecord>()
  /** 辅助索引：裸 topicId（如 '936634'）-> id（优先 nodeseek 来源） */
  private readonly byTopicId = new Map<string, string>()
  private publishedCache: ActivityRecord[] = []
  private transitionPointsMs: number[] = []

  private readonly tombstones = new Set<string>()
  private readonly evaluatedKeys = new Set<string>()

  private revision = 1
  private updatedAtEpochMillis = 0

  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private writeTail: Promise<void> = Promise.resolve()
  private dirty = false

  constructor(opts: ActivityStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now())
    this.onChanged = opts.onChanged
    if (opts.dataDir !== undefined) {
      try {
        mkdirSync(opts.dataDir, { recursive: true })
        this.filePath = join(opts.dataDir, ACTIVITIES_FILE_NAME)
        this.loadFromDisk()
      } catch (err) {
        console.error(`[activities] cannot initialize ${opts.dataDir}, using memory-only:`, err)
        this.filePath = undefined
      }
    }
  }

  size(): number {
    return this.byId.size
  }

  getUpdatedAtEpochMillis(): number {
    return this.updatedAtEpochMillis
  }

  getEffectiveRevision(nowMs: number = this.now()): string {
    const crossed = countCrossedTransitions(this.transitionPointsMs, nowMs)
    return `${this.revision}:${crossed}`
  }

  hasEvaluated(key: string): boolean {
    return this.evaluatedKeys.has(key) || this.tombstones.has(key) || this.byId.has(key)
  }

  markEvaluated(key: string): void {
    if (this.evaluatedKeys.has(key)) return
    this.evaluatedKeys.add(key)
    while (this.evaluatedKeys.size > MAX_EVALUATED_KEYS) {
      const oldest = this.evaluatedKeys.values().next().value
      if (oldest === undefined) break
      this.evaluatedKeys.delete(oldest)
    }
    this.schedulePersist()
  }

  isTombstoned(id: string): boolean {
    return this.tombstones.has(id)
  }

  getRecord(id: string): ActivityRecord | null {
    const rec = this.byId.get(id)
    return rec ? structuredClone(rec) : null
  }

  listAllAdmin(): ActivityRecord[] {
    const all = Array.from(this.byId.values()).map((r) => structuredClone(r))
    all.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return b.updatedAtEpochMillis - a.updatedAtEpochMillis
    })
    return all
  }

  queryPublic(query: ActivityQuery, nowMs: number = this.now()): ActivityFeedPage {
    return executePublicQuery(this.publishedCache, this.updatedAtEpochMillis, query, nowMs)
  }

  getPublicDetail(idOrTopicId: string, nowMs: number = this.now()): ActivityDetail | null {
    const key = idOrTopicId.trim()
    if (key === '') return null
    const direct = this.byId.get(key)
    if (direct && direct.published) {
      return toPublicDetail(direct, nowMs)
    }
    const mappedId = this.byTopicId.get(key)
    if (mappedId !== undefined) {
      const target = this.byId.get(mappedId)
      if (target && target.published) {
        return toPublicDetail(target, nowMs)
      }
    }
    return null
  }

  /**
   * 自动采集入库/更新：
   * - 若已被管理员删除（tombstones）或做过人工编辑（manualOverride=true），静默跳过不覆盖；
   * - 新活动入库或字段有实质变化时更新索引、递增 revision 并触发异步持久化。
   */
  upsertAuto(input: AutoUpsertInput, opts?: { force?: boolean }): ActivityRecord | null {
    const id = input.id.trim()
    if (id === '' || input.title.trim() === '') return null
    if (!opts?.force && this.tombstones.has(id)) return null

    const existing = this.byId.get(id)
    if (existing && existing.manualOverride && !opts?.force) {
      return structuredClone(existing)
    }

    const nowMs = this.now()
    if (opts?.force) {
      this.tombstones.delete(id)
    }

    const next: ActivityRecord = {
      id,
      sourceId: input.sourceId.trim() || 'nodeseek',
      topicId: input.topicId.trim() || null,
      title: input.title.trim().slice(0, 300),
      summary: input.summary.trim().slice(0, 500),
      sourceUrl: input.sourceUrl.trim(),
      organizer: input.organizer.trim().slice(0, 100),
      organizerUrl: input.organizerUrl ?? existing?.organizerUrl ?? null,
      startsAtEpochMillis:
        input.startsAtEpochMillis !== undefined
          ? sanitizeOptionalEpoch(input.startsAtEpochMillis)
          : (existing?.startsAtEpochMillis ?? null),
      endsAtEpochMillis:
        input.endsAtEpochMillis !== undefined
          ? sanitizeOptionalEpoch(input.endsAtEpochMillis)
          : (existing?.endsAtEpochMillis ?? null),
      forceEnded: input.forceEnded ?? existing?.forceEnded ?? false,
      published: existing?.published ?? true,
      pinned: existing?.pinned ?? false,
      kind: input.kind && VALID_KINDS.has(input.kind) ? input.kind : (existing?.kind ?? 'other'),
      category: (input.category ?? existing?.category ?? '').trim(),
      categorySlug: (input.categorySlug ?? existing?.categorySlug ?? '').trim(),
      luckyUrl: input.luckyUrl !== undefined ? input.luckyUrl : (existing?.luckyUrl ?? null),
      drawFloor: input.drawFloor !== undefined ? input.drawFloor : (existing?.drawFloor ?? null),
      prize: input.prize !== undefined ? input.prize : (existing?.prize ?? null),
      participation:
        input.participation !== undefined ? input.participation : (existing?.participation ?? null),
      tags: sanitizeTags(input.tags ?? existing?.tags ?? []),
      bodyMarkdown: (input.bodyMarkdown ?? existing?.bodyMarkdown ?? '').slice(0, 8_000),
      externalLinks: sanitizeLinks(input.externalLinks ?? existing?.externalLinks ?? []),
      origin: existing?.origin ?? 'auto',
      manualOverride: opts?.force ? false : (existing?.manualOverride ?? false),
      createdAtEpochMillis: existing?.createdAtEpochMillis ?? nowMs,
      updatedAtEpochMillis: nowMs
    }

    this.byId.set(id, next)
    this.evaluatedKeys.add(id)
    this.pruneAutoIfNeeded(nowMs)
    this.commitMutation(nowMs)
    return structuredClone(next)
  }

  /**
   * 首页列表零请求状态同步：若已入库且尚未结束的活动在论坛首页标题变为「已开奖 / 已结束」，
   * 立即将其标记为 `forceEnded=true` 并同步最新标题。
   */
  syncEndedFromFeedTitle(id: string, latestTitle: string, nowMs: number = this.now()): boolean {
    const rec = this.byId.get(id)
    if (!rec || !rec.published) return false
    const cleanTitle = latestTitle.trim().slice(0, 300)
    const alreadyEnded = resolveActivityStatus(rec, nowMs) === 'ended'
    if (alreadyEnded && rec.title === cleanTitle) return false

    rec.forceEnded = true
    if (rec.endsAtEpochMillis === null || rec.endsAtEpochMillis > nowMs) {
      rec.endsAtEpochMillis = nowMs
    }
    if (!rec.manualOverride && cleanTitle !== '') {
      rec.title = cleanTitle
    }
    rec.updatedAtEpochMillis = nowMs
    this.commitMutation(nowMs)
    return true
  }

  /** 管理员手动创建活动 */
  createManual(input: AdminCreateInput): ActivityRecord {
    const title = input.title.trim().slice(0, 300)
    if (title === '') {
      throw new Error('activity title must not be empty')
    }
    const nowMs = this.now()
    const rawId = input.id?.trim() ?? ''
    const id =
      rawId !== ''
        ? rawId.replace(/[^\w:-]/g, '-').slice(0, 80)
        : `manual:${nowMs.toString(36)}-${randomInt(0, 0xffff).toString(36)}`

    this.tombstones.delete(id)
    const rec: ActivityRecord = {
      id,
      sourceId: (input.sourceId?.trim() || 'manual').slice(0, 40),
      topicId: input.topicId?.trim() || null,
      title,
      summary: (input.summary ?? '').trim().slice(0, 500),
      sourceUrl: (input.sourceUrl ?? '').trim(),
      organizer: (input.organizer ?? '').trim().slice(0, 100),
      organizerUrl: input.organizerUrl?.trim() || null,
      startsAtEpochMillis: sanitizeOptionalEpoch(input.startsAtEpochMillis),
      endsAtEpochMillis: sanitizeOptionalEpoch(input.endsAtEpochMillis),
      forceEnded: input.forceEnded === true,
      published: input.published !== false,
      pinned: input.pinned === true,
      kind: input.kind && VALID_KINDS.has(input.kind) ? input.kind : 'event',
      category: (input.category ?? '').trim(),
      categorySlug: (input.categorySlug ?? '').trim(),
      luckyUrl: input.luckyUrl?.trim() || null,
      drawFloor:
        typeof input.drawFloor === 'number' && Number.isInteger(input.drawFloor) && input.drawFloor > 0
          ? input.drawFloor
          : null,
      prize: input.prize?.trim() || null,
      participation: input.participation?.trim() || null,
      tags: sanitizeTags(input.tags ?? []),
      bodyMarkdown: (input.bodyMarkdown ?? '').slice(0, 8_000),
      externalLinks: sanitizeLinks(input.externalLinks ?? []),
      origin: 'manual',
      manualOverride: true,
      createdAtEpochMillis: nowMs,
      updatedAtEpochMillis: nowMs
    }
    this.byId.set(id, rec)
    this.commitMutation(nowMs)
    return structuredClone(rec)
  }

  /** 管理员局部编辑（置 manualOverride=true，防止后台自动采集回写覆盖） */
  updateAdmin(id: string, patch: AdminPatchInput): ActivityRecord | null {
    const rec = this.byId.get(id.trim())
    if (!rec) return null
    const nowMs = this.now()

    if (patch.title !== undefined) {
      const t = patch.title.trim().slice(0, 300)
      if (t === '') throw new Error('activity title must not be empty')
      rec.title = t
    }
    if (patch.summary !== undefined) rec.summary = patch.summary.trim().slice(0, 500)
    if (patch.sourceUrl !== undefined) rec.sourceUrl = patch.sourceUrl.trim()
    if (patch.organizer !== undefined) rec.organizer = patch.organizer.trim().slice(0, 100)
    if (patch.organizerUrl !== undefined) rec.organizerUrl = patch.organizerUrl?.trim() || null
    if (patch.startsAtEpochMillis !== undefined) {
      rec.startsAtEpochMillis = sanitizeOptionalEpoch(patch.startsAtEpochMillis)
    }
    if (patch.endsAtEpochMillis !== undefined) {
      rec.endsAtEpochMillis = sanitizeOptionalEpoch(patch.endsAtEpochMillis)
    }
    if (patch.forceEnded !== undefined) rec.forceEnded = patch.forceEnded === true
    if (patch.published !== undefined) rec.published = patch.published === true
    if (patch.pinned !== undefined) rec.pinned = patch.pinned === true
    if (patch.kind !== undefined && VALID_KINDS.has(patch.kind)) rec.kind = patch.kind
    if (patch.luckyUrl !== undefined) rec.luckyUrl = patch.luckyUrl?.trim() || null
    if (patch.drawFloor !== undefined) {
      rec.drawFloor =
        typeof patch.drawFloor === 'number' && Number.isInteger(patch.drawFloor) && patch.drawFloor > 0
          ? patch.drawFloor
          : null
    }
    if (patch.prize !== undefined) rec.prize = patch.prize?.trim() || null
    if (patch.participation !== undefined) rec.participation = patch.participation?.trim() || null
    if (patch.tags !== undefined) rec.tags = sanitizeTags(patch.tags)
    if (patch.bodyMarkdown !== undefined) rec.bodyMarkdown = patch.bodyMarkdown.slice(0, 8_000)
    if (patch.externalLinks !== undefined) rec.externalLinks = sanitizeLinks(patch.externalLinks)

    rec.manualOverride = true
    rec.updatedAtEpochMillis = nowMs
    this.commitMutation(nowMs)
    return structuredClone(rec)
  }

  /** 管理员删除活动（自动采集来源记入 tombstones，防止后续轮询复活） */
  deleteAdmin(id: string): boolean {
    const cleanId = id.trim()
    const existing = this.byId.get(cleanId)
    if (!existing) return false
    this.byId.delete(cleanId)
    if (existing.origin === 'auto') {
      this.tombstones.add(cleanId)
      while (this.tombstones.size > MAX_TOMBSTONES) {
        const oldest = this.tombstones.values().next().value
        if (oldest === undefined) break
        this.tombstones.delete(oldest)
      }
    }
    this.commitMutation(this.now())
    return true
  }

  exportSnapshot(): ActivitySnapshotPayload {
    return {
      revision: this.revision,
      updatedAtEpochMillis: this.updatedAtEpochMillis,
      records: Array.from(this.byId.values()).map((r) => structuredClone(r))
    }
  }

  async flush(): Promise<void> {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    if (this.dirty) {
      this.enqueuePersist()
    }
    await this.writeTail
  }

  // ---- 内部索引与持久化 ----------------------------------------------------

  private commitMutation(nowMs: number): void {
    this.revision++
    this.updatedAtEpochMillis = Math.max(this.updatedAtEpochMillis, nowMs)
    this.rebuildIndexes()
    this.schedulePersist()
    this.onChanged?.(this.exportSnapshot())
  }

  private rebuildIndexes(): void {
    this.byTopicId.clear()
    const pub: ActivityRecord[] = []
    for (const rec of this.byId.values()) {
      if (rec.published) {
        pub.push(rec)
        if (rec.topicId !== null && rec.topicId !== '') {
          // 优先映射 nodeseek 的裸 topicId，其余来源仅在无冲突时写入
          if (!this.byTopicId.has(rec.topicId) || rec.sourceId === 'nodeseek') {
            this.byTopicId.set(rec.topicId, rec.id)
          }
        }
      }
    }
    this.publishedCache = pub
    this.transitionPointsMs = buildTransitionPoints(pub)
  }

  private pruneAutoIfNeeded(nowMs: number): void {
    if (this.byId.size <= MAX_AUTO_ITEMS) return
    const candidates: ActivityRecord[] = []
    for (const rec of this.byId.values()) {
      if (rec.pinned || rec.origin === 'manual' || rec.manualOverride) continue
      candidates.push(rec)
    }
    // 优先淘汰已结束且最老的自动采集记录
    candidates.sort((a, b) => {
      const aEnded = resolveActivityStatus(a, nowMs) === 'ended' ? 0 : 1
      const bEnded = resolveActivityStatus(b, nowMs) === 'ended' ? 0 : 1
      if (aEnded !== bEnded) return aEnded - bEnded
      return a.updatedAtEpochMillis - b.updatedAtEpochMillis
    })
    const excess = this.byId.size - MAX_AUTO_ITEMS
    for (let i = 0; i < excess && i < candidates.length; i++) {
      this.byId.delete(candidates[i]!.id)
    }
  }

  private loadFromDisk(): void {
    if (this.filePath === undefined || !existsSync(this.filePath)) return
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf-8')
    } catch (err) {
      console.error(`[activities] cannot read ${this.filePath}, starting empty:`, err)
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.backupCorrupt(raw)
      return
    }

    if (!isValidEnvelope(parsed)) {
      this.backupCorrupt(raw)
      return
    }

    this.updatedAtEpochMillis =
      typeof parsed.updatedAtEpochMillis === 'number' && Number.isFinite(parsed.updatedAtEpochMillis)
        ? parsed.updatedAtEpochMillis
        : 0

    for (const item of parsed.items) {
      const clean = sanitizeDiskRecord(item)
      if (clean !== null) this.byId.set(clean.id, clean)
    }
    for (const t of parsed.tombstones) {
      if (typeof t === 'string' && t.trim() !== '') this.tombstones.add(t.trim())
    }
    for (const k of parsed.evaluatedKeys) {
      if (typeof k === 'string' && k.trim() !== '') this.evaluatedKeys.add(k.trim())
    }
    this.rebuildIndexes()
  }

  private backupCorrupt(raw: string): void {
    if (this.filePath === undefined) return
    const backup = `${this.filePath}.corrupt-${this.now()}`
    try {
      writeFileSync(backup, raw, 'utf-8')
      console.error(`[activities] corrupt store backed up to ${backup}; starting empty`)
    } catch (err) {
      console.error(`[activities] corrupt store backup failed:`, err)
    }
  }

  private schedulePersist(): void {
    if (this.filePath === undefined) return
    this.dirty = true
    if (this.persistTimer !== null) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      if (this.dirty) this.enqueuePersist()
    }, PERSIST_DEBOUNCE_MS)
    this.persistTimer.unref?.()
  }

  private enqueuePersist(): void {
    if (this.filePath === undefined) return
    this.dirty = false
    const target = this.filePath
    const envelope: DiskEnvelope = {
      schemaVersion: SCHEMA_VERSION,
      updatedAtEpochMillis: this.updatedAtEpochMillis,
      items: Array.from(this.byId.values()),
      tombstones: Array.from(this.tombstones),
      evaluatedKeys: Array.from(this.evaluatedKeys)
    }
    const payload = JSON.stringify(envelope, null, 2)
    this.writeTail = this.writeTail
      .then(async () => {
        const tmp = `${target}.tmp-${process.pid}-${randomInt(0, 0xffffff).toString(36)}`
        await mkdir(dirname(target), { recursive: true })
        try {
          await writeFile(tmp, payload, 'utf-8')
          await rename(tmp, target)
        } catch (err) {
          await unlink(tmp).catch(() => undefined)
          throw err
        }
      })
      .catch((err) => {
        console.error(`[activities] persist failed for ${target}:`, err)
      })
  }
}

/**
 * Cluster Worker 进程的纯内存只读副本视图（接收主进程 IPC 推送的快照）。
 */
export class ReplicaActivityView implements ActivityReadView {
  private readonly now: () => number
  private revision = 0
  private updatedAtEpochMillis = 0
  private readonly byId = new Map<string, ActivityRecord>()
  private readonly byTopicId = new Map<string, string>()
  private publishedCache: ActivityRecord[] = []
  private transitionPointsMs: number[] = []

  constructor(now?: () => number) {
    this.now = now ?? (() => Date.now())
  }

  applySnapshot(snapshot: ActivitySnapshotPayload): void {
    this.revision = snapshot.revision
    this.updatedAtEpochMillis = snapshot.updatedAtEpochMillis
    this.byId.clear()
    this.byTopicId.clear()
    const pub: ActivityRecord[] = []
    for (const r of snapshot.records) {
      this.byId.set(r.id, r)
      if (r.published) {
        pub.push(r)
        if (r.topicId !== null && r.topicId !== '') {
          if (!this.byTopicId.has(r.topicId) || r.sourceId === 'nodeseek') {
            this.byTopicId.set(r.topicId, r.id)
          }
        }
      }
    }
    this.publishedCache = pub
    this.transitionPointsMs = buildTransitionPoints(pub)
  }

  size(): number {
    return this.byId.size
  }

  getUpdatedAtEpochMillis(): number {
    return this.updatedAtEpochMillis
  }

  getEffectiveRevision(nowMs: number = this.now()): string {
    const crossed = countCrossedTransitions(this.transitionPointsMs, nowMs)
    return `${this.revision}:${crossed}`
  }

  queryPublic(query: ActivityQuery, nowMs: number = this.now()): ActivityFeedPage {
    return executePublicQuery(this.publishedCache, this.updatedAtEpochMillis, query, nowMs)
  }

  getPublicDetail(idOrTopicId: string, nowMs: number = this.now()): ActivityDetail | null {
    const key = idOrTopicId.trim()
    if (key === '') return null
    const direct = this.byId.get(key)
    if (direct && direct.published) return toPublicDetail(direct, nowMs)
    const mappedId = this.byTopicId.get(key)
    if (mappedId !== undefined) {
      const target = this.byId.get(mappedId)
      if (target && target.published) return toPublicDetail(target, nowMs)
    }
    return null
  }
}

function isValidEnvelope(raw: unknown): raw is DiskEnvelope {
  if (typeof raw !== 'object' || raw === null) return false
  const o = raw as Record<string, unknown>
  return (
    o['schemaVersion'] === SCHEMA_VERSION &&
    Array.isArray(o['items']) &&
    Array.isArray(o['tombstones']) &&
    (o['evaluatedKeys'] === undefined || Array.isArray(o['evaluatedKeys']))
  )
}

function sanitizeOptionalEpoch(val: number | null | undefined): number | null {
  if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) return null
  return Math.trunc(val)
}

function sanitizeTags(tags: readonly string[]): string[] {
  const out: string[] = []
  for (const t of tags) {
    if (typeof t !== 'string') continue
    const s = t.trim().slice(0, 24)
    if (s !== '' && !out.includes(s)) out.push(s)
    if (out.length >= 6) break
  }
  return out
}

function sanitizeLinks(links: readonly ActivityLabeledLink[]): ActivityLabeledLink[] {
  const out: ActivityLabeledLink[] = []
  const seen = new Set<string>()
  for (const l of links) {
    if (typeof l !== 'object' || l === null) continue
    const url = typeof l.url === 'string' ? l.url.trim() : ''
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
    seen.add(url)
    const text = typeof l.text === 'string' && l.text.trim() !== '' ? l.text.trim().slice(0, 80) : '相关链接'
    out.push({ text, url })
    if (out.length >= 12) break
  }
  return out
}

function sanitizeDiskRecord(raw: unknown): ActivityRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r['id'] !== 'string' || r['id'].trim() === '') return null
  if (typeof r['title'] !== 'string' || r['title'].trim() === '') return null
  const kindRaw = typeof r['kind'] === 'string' ? (r['kind'] as ActivityKind) : 'other'
  return {
    id: r['id'].trim(),
    sourceId: typeof r['sourceId'] === 'string' && r['sourceId'] !== '' ? r['sourceId'] : 'nodeseek',
    topicId: typeof r['topicId'] === 'string' && r['topicId'] !== '' ? r['topicId'] : null,
    title: r['title'].trim(),
    summary: typeof r['summary'] === 'string' ? r['summary'] : '',
    sourceUrl: typeof r['sourceUrl'] === 'string' ? r['sourceUrl'] : '',
    organizer: typeof r['organizer'] === 'string' ? r['organizer'] : '',
    organizerUrl: typeof r['organizerUrl'] === 'string' ? r['organizerUrl'] : null,
    startsAtEpochMillis: sanitizeOptionalEpoch(r['startsAtEpochMillis'] as number | null),
    endsAtEpochMillis: sanitizeOptionalEpoch(r['endsAtEpochMillis'] as number | null),
    forceEnded: r['forceEnded'] === true,
    published: r['published'] !== false,
    pinned: r['pinned'] === true,
    kind: VALID_KINDS.has(kindRaw) ? kindRaw : 'other',
    category: typeof r['category'] === 'string' ? r['category'] : '',
    categorySlug: typeof r['categorySlug'] === 'string' ? r['categorySlug'] : '',
    luckyUrl: typeof r['luckyUrl'] === 'string' ? r['luckyUrl'] : null,
    drawFloor:
      typeof r['drawFloor'] === 'number' && Number.isInteger(r['drawFloor']) && r['drawFloor'] > 0
        ? r['drawFloor']
        : null,
    prize: typeof r['prize'] === 'string' ? r['prize'] : null,
    participation: typeof r['participation'] === 'string' ? r['participation'] : null,
    tags: Array.isArray(r['tags']) ? sanitizeTags(r['tags'] as string[]) : [],
    bodyMarkdown: typeof r['bodyMarkdown'] === 'string' ? r['bodyMarkdown'].slice(0, 8_000) : '',
    externalLinks: Array.isArray(r['externalLinks'])
      ? sanitizeLinks(r['externalLinks'] as ActivityLabeledLink[])
      : [],
    origin: r['origin'] === 'manual' ? 'manual' : 'auto',
    manualOverride: r['manualOverride'] === true,
    createdAtEpochMillis:
      typeof r['createdAtEpochMillis'] === 'number' && Number.isFinite(r['createdAtEpochMillis'])
        ? r['createdAtEpochMillis']
        : 0,
    updatedAtEpochMillis:
      typeof r['updatedAtEpochMillis'] === 'number' && Number.isFinite(r['updatedAtEpochMillis'])
        ? r['updatedAtEpochMillis']
        : 0
  }
}
