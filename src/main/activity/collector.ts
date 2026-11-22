/**
 * 社区活动后台采集编排器（连接 MonitorEngine → 初筛 → 1 楼详情 → AI 提取 → ActivityStore）。
 *
 * 关键架构边界：
 * - `observeRound` 为同步微秒级方法，在 `MonitorEngine.pollSource` 内调用**零阻塞**——
 *   慢路径（1 楼 HTTP 抓取与 LLM 结构化提取）全部进入有界异步后台队列串行消费，
 *   绝不拖慢论坛监控主循环与 Telegram 即时推送延迟；
 * - 首启种子（`MAX_BASELINE_SEED = 6`）：新部署服务器首次启动且活动库为空时，即使处于
 *   防推送风暴的基线轮，也会从首页挑出最多 6 条未结束的活动贴入库，开箱即有真实数据；
 * - 零请求状态同步：每轮扫描首页列表标题，若已入库活动标题变为「已开奖 / 已结束」，
 *   立即更新为 `ended`。
 */
import { DEFAULT_ACTIVITY_CONFIG, type AppConfig, type Topic } from '../../shared/types'
import type { Logger } from '../logger'
import type { ActivityAiExtractor } from './ai-extractor'
import type { TopicDetailFetcher } from './detail-fetcher'
import {
  extractDeterministicActivitySignals,
  hasEndedTitleMarker,
  prescreenActivityTopic
} from './prescreen'
import type { ActivityRecord, ActivityStore } from './store'

const MAX_PENDING_QUEUE = 60
const MAX_BASELINE_SEED = 6

export interface ObserveRoundContext {
  isBaseline: boolean
  idFilter: boolean
  oldThreshold: number | null
  prevUnseenKeys: ReadonlySet<string>
  /** 常规轮未进 seen 的新候选（不传则回退 topics） */
  unseenTopics?: Topic[]
  now?: Date
}

export interface ActivityCollectorDeps {
  store: ActivityStore
  detailFetcher: TopicDetailFetcher
  aiExtractor?: ActivityAiExtractor
  getConfig: () => AppConfig
  logger: Logger
  now?: () => number
}

interface QueuedCandidate {
  topic: Topic
  force: boolean
  enqueuedAtMs: number
}

const NODESEEK_POST_URL_RE = /\/post-(\d+)(?:-\d+)?/i

export class ActivityCollector {
  private readonly store: ActivityStore
  private readonly detailFetcher: TopicDetailFetcher
  private readonly aiExtractor?: ActivityAiExtractor
  private readonly getConfig: () => AppConfig
  private readonly logger: Logger
  private readonly now: () => number

  private readonly pendingQueue: QueuedCandidate[] = []
  private readonly inFlightKeys = new Set<string>()
  private workerPromise: Promise<void> | null = null
  private stopped = false

  constructor(deps: ActivityCollectorDeps) {
    this.store = deps.store
    this.detailFetcher = deps.detailFetcher
    this.aiExtractor = deps.aiExtractor
    this.getConfig = deps.getConfig
    this.logger = deps.logger
    this.now = deps.now ?? (() => Date.now())
  }

  /**
   * 引擎每轮抓到页面帖子列表后的非阻塞回调。
   */
  observeRound(sourceId: string, topics: Topic[], ctx: ObserveRoundContext): void {
    if (this.stopped || topics.length === 0) return
    const nowMs = ctx.now ? ctx.now.getTime() : this.now()

    // 1. 首页标题「已开奖/已结束」零请求状态同步（即便活动自动采集关闭也保持已有记录准确）
    for (const t of topics) {
      if (hasEndedTitleMarker(t.title)) {
        const key = `${sourceId}:${t.id}`
        if (this.store.syncEndedFromFeedTitle(key, t.title, nowMs)) {
          this.logger.info(`activity marked ended from feed title: ${key} "${t.title}"`)
        }
      }
    }

    const cfg = this.getConfig()
    const actCfg = cfg.activity ?? DEFAULT_ACTIVITY_CONFIG
    if (!actCfg.enabled) return
    if (actCfg.sourceIds.length > 0 && !actCfg.sourceIds.includes(sourceId)) return

    // 2. 首启基线轮：仅当活动库完全为空时挑最多 MAX_BASELINE_SEED 条未结束活动做冷启动种子
    if (ctx.isBaseline) {
      if (this.store.size() > 0) return
      let seeded = 0
      for (const rawTopic of topics) {
        if (seeded >= MAX_BASELINE_SEED) break
        const topic: Topic = { ...rawTopic, sourceId }
        if (hasEndedTitleMarker(topic.title)) continue
        const key = `${sourceId}:${topic.id}`
        if (this.store.hasEvaluated(key) || this.inFlightKeys.has(key)) continue
        const pre = prescreenActivityTopic(topic, {
          includeKeywords: actCfg.includeKeywords,
          excludeKeywords: actCfg.excludeKeywords
        })
        if (!pre.matched) continue
        if (this.enqueueTopic(topic, false, nowMs)) {
          seeded++
        }
      }
      if (seeded > 0) {
        this.logger.info(`activity baseline seed queued ${seeded} candidate topic(s) from ${sourceId}`)
      }
      return
    }

    // 3. 常规轮询：仅遍历 unseen 候选新帖（跳过被回复顶回首页的旧帖与基线旧帖）
    const candidates = ctx.unseenTopics ?? topics
    for (const rawTopic of [...candidates].reverse()) {
      const topic: Topic = { ...rawTopic, sourceId }
      const key = `${sourceId}:${topic.id}`
      if (this.store.hasEvaluated(key) || this.inFlightKeys.has(key)) continue

      if (ctx.idFilter && ctx.oldThreshold !== null && !ctx.prevUnseenKeys.has(key)) {
        const numId = parsePositiveInt(topic.id)
        if (numId !== null && numId <= ctx.oldThreshold) continue
      }

      const pre = prescreenActivityTopic(topic, {
        includeKeywords: actCfg.includeKeywords,
        excludeKeywords: actCfg.excludeKeywords
      })
      if (!pre.matched) continue

      this.enqueueTopic(topic, false, nowMs)
    }
  }

  /**
   * 管理员手动按帖子 URL 抓取并提取入库（无视初筛与历史墓碑）。
   */
  async ingestUrl(rawUrl: string, opts?: { sourceId?: string; force?: boolean }): Promise<ActivityRecord> {
    const cleanUrl = rawUrl.trim()
    if (!/^https?:\/\//i.test(cleanUrl)) {
      throw new Error('需要合法的 http(s) 帖子链接')
    }
    const parsedUrl = new URL(cleanUrl)
    const isNodeSeek = parsedUrl.hostname === 'nodeseek.com' || parsedUrl.hostname.endsWith('.nodeseek.com')
    const nsMatch = NODESEEK_POST_URL_RE.exec(parsedUrl.pathname)
    const sourceId = opts?.sourceId?.trim() || (isNodeSeek ? 'nodeseek' : parsedUrl.hostname.replace(/[^\w-]/g, '-'))
    const topicId =
      nsMatch?.[1] ??
      (parsedUrl.pathname.replace(/^\/+|\/+$/g, '').replace(/[^\w-]/g, '-') || String(this.now()))
    const canonicalUrl =
      isNodeSeek && nsMatch?.[1] ? `${parsedUrl.origin}/post-${nsMatch[1]}-1` : cleanUrl

    const syntheticTopic: Topic = {
      id: topicId,
      sourceId,
      title: cleanUrl,
      url: canonicalUrl,
      author: '',
      category: '',
      categorySlug: '',
      pinned: false,
      lastActiveAt: null
    }

    const record = await this.processCandidate({
      topic: syntheticTopic,
      force: opts?.force !== false,
      enqueuedAtMs: this.now()
    })
    if (!record) {
      throw new Error('未能从该链接提取到有效活动信息')
    }
    return record
  }

  /** 等待当前队列排空（测试与优雅退出使用） */
  async drain(): Promise<void> {
    while (this.workerPromise !== null) {
      await this.workerPromise
    }
  }

  stop(): void {
    this.stopped = true
    this.pendingQueue.length = 0
    this.inFlightKeys.clear()
  }

  private enqueueTopic(topic: Topic, force: boolean, nowMs: number): boolean {
    const key = `${topic.sourceId}:${topic.id}`
    if (!force && (this.inFlightKeys.has(key) || this.store.hasEvaluated(key))) {
      return false
    }
    if (this.pendingQueue.length >= MAX_PENDING_QUEUE) {
      this.logger.warn(`activity candidate queue full (${MAX_PENDING_QUEUE}), dropping ${key}`)
      return false
    }
    this.inFlightKeys.add(key)
    this.pendingQueue.push({ topic, force, enqueuedAtMs: nowMs })
    this.ensureWorker()
    return true
  }

  private ensureWorker(): void {
    if (this.workerPromise !== null || this.stopped) return
    this.workerPromise = this.runQueueLoop().finally(() => {
      this.workerPromise = null
      if (!this.stopped && this.pendingQueue.length > 0) {
        this.ensureWorker()
      }
    })
  }

  private async runQueueLoop(): Promise<void> {
    while (!this.stopped && this.pendingQueue.length > 0) {
      const item = this.pendingQueue.shift()!
      const key = `${item.topic.sourceId}:${item.topic.id}`
      try {
        await this.processCandidate(item)
      } catch (err) {
        this.logger.warn(
          `activity candidate processing failed (${key}): ${err instanceof Error ? err.message : String(err)}`
        )
      } finally {
        this.inFlightKeys.delete(key)
      }
    }
  }

  private async processCandidate(candidate: QueuedCandidate): Promise<ActivityRecord | null> {
    const { topic, force, enqueuedAtMs } = candidate
    const key = `${topic.sourceId}:${topic.id}`
    const cfg = this.getConfig()
    const actCfg = cfg.activity ?? DEFAULT_ACTIVITY_CONFIG

    let title = topic.title.trim()
    let author = topic.author.trim()
    let authorUrl = topic.authorUrl ?? null
    let category = topic.category.trim()
    let categorySlug = topic.categorySlug.trim()
    let markdown = topic.excerpt?.trim() ?? ''
    let createdAtMs: number | null = null
    let locked = false
    let accessRestriction: string | null = null

    // 1. 按需抓取 1 楼详情页（带限速与 CF 熔断降级）
    if ((actCfg.fetchDetail || force) && topic.url.trim() !== '') {
      const fetched = await this.detailFetcher.fetchDetail(topic.url)
      if (fetched.ok) {
        const d = fetched.detail
        if (d.title && (title === '' || title === topic.url)) title = d.title
        if (d.author && author === '') author = d.author
        if (d.authorUrl && authorUrl === null) authorUrl = d.authorUrl
        if (d.category && category === '') category = d.category
        if (d.categorySlug && categorySlug === '') categorySlug = d.categorySlug
        if (d.markdown !== '') markdown = d.markdown
        createdAtMs = d.createdAtEpochMillis
        locked = d.locked
        accessRestriction = d.accessRestriction
      } else {
        this.logger.info(
          `activity detail fetch degraded to title-only (${key}): ${fetched.reason}`
        )
      }
    }

    if (title === '') return null

    const referenceTimeMs =
      createdAtMs ??
      (topic.lastActiveAt ? safeParseMs(topic.lastActiveAt) : null) ??
      enqueuedAtMs

    // 2. 确定性提取（开奖链接 / 目标楼层 / 时间表达式 / 基础摘要）
    const det = extractDeterministicActivitySignals({
      title,
      markdown,
      sourceUrl: topic.url,
      baseTimeMs: referenceTimeMs
    })

    // 3. AI 精筛与结构化增强（可选；未配 AI 或失败自动回退 det）
    let aiVerdict = null
    if (actCfg.useAiExtraction && this.aiExtractor !== undefined) {
      aiVerdict = await this.aiExtractor.extract({
        title,
        author,
        category,
        markdown: markdown || (accessRestriction ?? ''),
        referenceTimeMs
      })
    }

    if (aiVerdict !== null && !aiVerdict.isActivity && !force) {
      this.store.markEvaluated(key)
      this.logger.info(`activity candidate rejected by AI filter: ${key} "${title}"`)
      return null
    }

    const startsAtEpochMillis = aiVerdict?.startsAtEpochMillis ?? det.startsAtEpochMillis
    // luckyUrl 内嵌的精确开奖时间戳优先级最高，其次取 AI 提取时间，最后取确定性正则时间
    const endsAtEpochMillis =
      det.luckyUrl !== null && det.endsAtEpochMillis !== null
        ? det.endsAtEpochMillis
        : (aiVerdict?.endsAtEpochMillis ?? det.endsAtEpochMillis)

    const participation =
      aiVerdict?.participation ??
      det.participation ??
      accessRestriction ??
      null

    const summary =
      aiVerdict?.summary ||
      det.summary ||
      (accessRestriction ? `${accessRestriction}` : '')

    const mergedTags = mergeTags(det.tags, aiVerdict?.tags ?? [])

    const saved = this.store.upsertAuto(
      {
        id: key,
        sourceId: topic.sourceId,
        topicId: topic.id,
        title,
        summary,
        sourceUrl: topic.url,
        organizer: aiVerdict?.organizer || author || topic.sourceId,
        organizerUrl: authorUrl,
        startsAtEpochMillis,
        endsAtEpochMillis,
        forceEnded: det.alreadyEnded || locked,
        kind: aiVerdict?.kind && aiVerdict.kind !== 'other' ? aiVerdict.kind : det.kind,
        category,
        categorySlug,
        luckyUrl: det.luckyUrl,
        drawFloor: det.drawFloor ?? aiVerdict?.drawFloor ?? null,
        prize: aiVerdict?.prize ?? det.prize,
        participation,
        tags: mergedTags,
        bodyMarkdown: markdown,
        externalLinks: det.externalLinks
      },
      { force }
    )

    if (saved) {
      this.logger.info(
        `activity stored: ${saved.id} [${saved.kind}] "${saved.title}"` +
          (saved.endsAtEpochMillis !== null
            ? ` endsAt=${new Date(saved.endsAtEpochMillis).toISOString()}`
            : '')
      )
    }
    return saved
  }
}

function parsePositiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function safeParseMs(iso: string): number | null {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

function mergeTags(a: readonly string[], b: readonly string[]): string[] {
  const out: string[] = []
  for (const t of [...a, ...b]) {
    const clean = t.trim()
    if (clean !== '' && !out.includes(clean) && out.length < 6) {
      out.push(clean)
    }
  }
  return out
}
