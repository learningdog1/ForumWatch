/**
 * 监控引擎：轮询循环的装配核心（ADR 2：零 electron import；D3：单引擎多来源）。
 *
 * 每轮语义（per source，互相独立 try/catch——一个 source 失败不影响后续）：
 * 重读配置 → 遍历 getSources()（访问器，配置热更新语义）→ 退避冷却中的 source
 * 跳过本轮 → fetchLatest → topic.sourceId 盖章（adapter 不感知归属）→
 * 首启基线（只入去重集不推送，ADR 8.5 防通知风暴；per-source 独立）→
 * 新帖按页面逆序处理（推送顺序旧→新）→ 置顶只入集（ADR 8.5）→
 * 匹配管线（D4，逐条）：排除词字面一票否决 → literal 命中即推送（不走 AI）→
 * 生效模式含 semantic 时剩余帖进 AI 批评（cap 12/批，verdict 三态：
 * hit 推送 / miss 入 seen / 未决不入 seen 下轮重评）→
 * 尝试推送（单个失败不中断本轮；真实失败不入集下轮重试，ADR 8.10）→
 * 该 source 轮末 flush/prune/按 source 持久化 totalHits。
 *
 * AI 运行态（AiRuntimeStatus，engine 内存维护、getStatus 派生）：
 * - configured = provider 三项齐备（每轮从 cfg.ai.provider 读，热更新）；
 * - unconfigured（mode 含语义但 provider 未配）→ effectiveMode='literal'，
 *   不算失败；语义帖按字面档处理（未命中入 seen）。
 * - callsToday 本地自然日滚动（formatLocalDate 判日）；达 DAILY_AI_CALL_LIMIT(300)
 *   → degraded='quota-exhausted'，当日后续轮降级 literal-only，log 一次。
 * - evaluate 抛错（含 AiProviderError）→ 该批全部未决（不入 seen）、记
 *   lastAiError、**不动 consecutiveFailures**（AI 故障 ≠ 抓取故障，D4）。
 * - interests 为空 → 引擎侧直接跳过 AI 批（不调 evaluator、不计 callsToday，
 *   F3）：语义帖全部按未命中入 seen（与 evaluator 快速全 miss 的现状一致），
 *   不算 unconfigured。
 * - verdict 缓存（D4 坑⑥，F2）：语义命中但推送失败的帖 reason 存内存 Map
 *   （semanticVerdicts），下轮**不重进 AI 批**、按已判 hit 直接重试推送；
 *   推送成功/转静音后清除；帖子滚出首页即随轮末清理回收（F5）。
 *
 * per-source 运行态（SourceRuntime，内存）：health / lastSuccessAt / lastError /
 * consecutiveFailures / cooldownUntilMs——同一退避曲线 computeBackoffMs（含
 * ChallengeError：health='challenged' 但同样进冷却，避免每轮硬撞 Cloudflare）。
 * 失败只影响该 source；持久化部分（baselineDone / totalHits）走 state.getFor/setFor。
 *
 * 全局聚合（每轮收尾 finishRound 派生，既有消费方——托盘/UI——不破）：
 * health = 各 source 最差（challenged > backoff > ok；无 source → ok）；
 * consecutiveFailures 取最差、lastError 取最新、lastSuccessAt 取最新；
 * EngineStatus.sources 填 per-source 快照。scheduler 间隔 =
 * max(配置间隔, ceil(最差 source 剩余退避/1000))——D3 已知限制：某 source 退避中、
 * 其他健康时全局间隔被抬高；所有 source 健康时回到配置值。
 *
 * 状态模型（ADR 7）：desired（用户意图，唯一可写）× health（内核观测，自动流转）正交。
 * pause 只改 desired 并 stop 排程器，health 不动；getStatus 返回实时快照。
 *
 * 接线约定（桌面 / headless 装配方必读）：
 * - **getSources 必须是访问器**（每轮重读，不能构造期定死数组，否则配置热更新断裂，
 *   D3 坑清单①）：装配方按 config.sources[].enabled 过滤，未注册的 id log warn 跳过。
 * - scheduler 由装配方创建并注入：`onTick` 绑 `engine.pollOnce()`、
 *   `onScheduled` 绑 `engine.noteScheduled(ms)`（epoch ms → ISO 填 nextPollAt）。
 *   构造顺序用 `let engine` 闭包即可（onTick 调用时才解引用）。
 * - PollScheduler 会吞掉 onTick 的异常——本引擎在 pollOnce 内部自行消化，绝不向上抛。
 * - getConfig / getSources 抛错无法归因到单个 source：归到当前全部 source 头上
 *   （一个 source 都没有时记孤儿失败，聚合层兜底展示）。
 * - powerMonitor resume 等系统事件调 `engine.runNow()`：内部尊重 desired，
 *   用户暂停（pause）期间是 no-op，不会被系统事件偷偷唤醒。
 * - HttpClient 与代理路由由装配方负责，本引擎只面向注入的 sources 与 notifier；
 *   semanticEvaluator / hitsStore 同样由装配方注入（缺省 = 不做语义、不落命中）。
 */
import { isExcluded, matchTopic } from './matcher'
import { computeBackoffMs, type PollScheduler } from './poller'
import type { FileSeenStore } from './dedup'
import { formatLocalDate } from './hits-store'
import type { FileEngineState, SourceEngineState } from './state'
import { ChallengeError, type SourceAdapter } from './types'
import type { SemanticEvaluator } from '../ai/evaluator'
import { MAX_SEMANTIC_BATCH } from '../ai/evaluator'
import type { Logger } from '../logger'
import {
  DEFAULT_APP_CONFIG,
  INITIAL_ENGINE_STATUS,
  type AiRuntimeStatus,
  type AppConfig,
  type EngineStatus,
  type HealthState,
  type HitRecord,
  type MatchMode,
  type SourceStatus,
  type Topic
} from '../../shared/types'

/** 命中记录内存环形容量（getRecentHits 给 UI 的上限） */
export const HIT_RING_CAPACITY = 200

/** AI 每日调用上限（D4：常量 300，v2 不进配置） */
export const DAILY_AI_CALL_LIMIT = 300

/**
 * 全局去重键 = `${sourceId}:${topic.id}`（D2/D3）。与 v1 seen.json 迁移的前缀口径
 * 等价：nodeseek 的键恒为 `nodeseek:{id}`（dedup.ts 的 NODESEEK_SEEN_KEY_PREFIX
 * 只在 v1 裸 id 迁移处使用，这里的一般化拼法与其一致，防漂移）。
 */
const seenKeyFor = (sourceId: string, topicId: string): string => `${sourceId}:${topicId}`

/** seen 键 → sourceId 部分（首个冒号前；pruneRetryMaps 判断键归属用，F5） */
const sourceIdOfKey = (key: string): string => key.slice(0, key.indexOf(':'))

/** 聚合 health 取最差的排序权重（challenged > backoff > ok） */
const HEALTH_SEVERITY: Record<HealthState, number> = { ok: 0, backoff: 1, challenged: 2 }

/** 单个 source 的运行态（内存，进程生命周期；持久化部分在 FileEngineState） */
interface SourceRuntime {
  health: HealthState
  lastSuccessAt: string | null
  lastError: string | null
  /** lastError 的记录时刻（epoch ms）：聚合层取「最新错误」的排序键 */
  lastErrorAtMs: number
  consecutiveFailures: number
  /** 退避截止（epoch ms）；null = 无退避。冷却中的轮次该 source 被跳过 */
  cooldownUntilMs: number | null
  /** 是否已对该 source 执行过 re-baseline 检查（seen rebuiltFromCorrupt × baselineDone） */
  baselineChecked: boolean
}

export interface EngineDeps {
  /**
   * 数据源访问器：每轮重读（配置热更新语义；enabled 过滤由装配方做，D3）。
   * 返回空数组 = 没有可用来源，pollOnce 安全通过（不算失败）。
   */
  getSources: () => SourceAdapter[]
  /** 去重集（装配方启动时 load；engine 每轮 has/add、轮末 flush+prune） */
  seen: FileSeenStore
  /** 引擎状态持久化（per-source baselineDone / totalHits；按 sourceId getFor/setFor） */
  state: FileEngineState
  /** Telegram 推送（TelegramNotifier 结构满足此接口；单测可全 mock） */
  notifier: {
    sendHit(topic: Topic, matchedKeywords: string[]): Promise<void>
    sendTest(): Promise<void>
  }
  /** 每轮轮询前重读的配置访问器（装配方保证热更新） */
  getConfig: () => AppConfig
  /** 装配方创建并注入：onTick 绑 engine.pollOnce、onScheduled 绑 engine.noteScheduled */
  scheduler: PollScheduler
  logger: Logger
  /**
   * 语义评估器（D4；可选——不注入 = 语义档永远不可用，语义帖按字面档处理）。
   * engine 只依赖 evaluate 接口（SemanticEvaluator 结构类型）。
   */
  semanticEvaluator?: SemanticEvaluator
  /**
   * 命中持久化（D5 hits/<date>.jsonl；可选）。每次 emit onHit 的同处 append；
   * append 失败只 log warn 不中断（调用方 catch，hits-store 的 append 会 reject）。
   */
  hitsStore?: { append(hit: HitRecord, now?: Date): Promise<void> }
  /** 状态变化回调（desired/health/nextPollAt 等每次变化后发出实时快照） */
  onStatus?: (s: EngineStatus) => void
  /** 命中回调（推送尝试 settle 后发出；含推送失败与静音两种非成功态） */
  onHit?: (h: HitRecord) => void
  /** 测试注入假时钟（epoch ms）；默认 Date.now */
  now?: () => number
}

export class MonitorEngine {
  private readonly deps: EngineDeps
  private readonly now: () => number
  /** 命中内存环形（旧→新） */
  private readonly hits: HitRecord[] = []
  /**
   * 推送失败待重试的 topic：全局去重键 -> 上次失败原因（ADR 8.10）。
   * 真实推送失败不入去重集、下轮自然重试；同键同失败态只 emit/log 一次
   * （防每轮刷屏），成功或转静音后清除并 emit 最终态。
   */
  private readonly pendingNotifyErrors = new Map<string, string>()
  /**
   * 已判 hit 但推送失败中的语义帖缓存（D4 坑⑥，F2）：seen 键 -> AI 判定理由。
   * 下轮该帖仍在首页时不重进 AI 批（不耗配额、不冒改变判定风险），直接按
   * 已判 hit 走 processHit 重试；推送成功/转静音清除；帖子滚出首页随轮末
   * 清理回收（pruneRetryMaps，F5）。与 pendingNotifyErrors 是两套机制：后者
   * 是全部命中共用的「失败原因去重 emit」表，前者只服务语义档的 verdict 复用。
   */
  private readonly semanticVerdicts = new Map<string, { reason: string | null }>()
  /** sourceId -> 运行态（含热更新后加入的 source；移除的 source 保留卡但退出聚合） */
  private readonly runtimes = new Map<string, SourceRuntime>()
  /** sourceId -> 本轮新增命中数（轮末按 source 持久化 totalHits 后清零） */
  private readonly pendingHits = new Map<string, number>()
  /** 无法归因到任何 source 的失败（getConfig/getSources 抛错）且当时无 source 的兜底 */
  private configFailures = 0
  private configLastError: string | null = null
  /** 最近一次成功读到的轮询间隔：getConfig 抛错时退避计算仍可用（默认 60s） */
  private lastIntervalSec: number = DEFAULT_APP_CONFIG.pollIntervalSec
  /** AI 运行态（内存；configured/mode 每轮从配置刷新，见 updateAiConfig） */
  private aiConfigured = false
  private aiMode: MatchMode = 'literal'
  /** 今日语义评估调用数（本地自然日滚动：aiCallsDay 用 formatLocalDate 判日） */
  private aiCallsToday = 0
  private aiCallsDay = ''
  /** 最近一次评估错误消息（provider 已脱敏）；评估成功后清空 */
  private aiLastError: string | null = null
  /** 当日配额耗尽是否已 log 过（防每轮刷屏；本地日翻转清零） */
  private aiQuotaLogged = false
  private status: EngineStatus

  constructor(deps: EngineDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
    this.status = { ...INITIAL_ENGINE_STATUS }
    // 建卡：totalHits 聚合初值（各 source 的持久化累计）+ per-source re-baseline
    // 检查。getSources 抛错不让构造失败——首轮 pollOnce 会按全局失败收尾。
    try {
      for (const adapter of deps.getSources()) this.ensureRuntime(adapter.id)
    } catch (err) {
      deps.logger.error(`cannot enumerate sources at construction: ${describeError(err)}`)
    }
  }

  /** desired='running' 并立即触发首轮（首启基线在这一轮完成） */
  start(): void {
    this.status.desired = 'running'
    this.emitStatus()
    this.deps.scheduler.runNow()
  }

  /** desired='paused' 并停止排程；health 等观测维度不动（ADR 7 正交） */
  pause(): void {
    this.status.desired = 'paused'
    this.deps.scheduler.stop()
    this.emitStatus()
  }

  /** desired='running' 并立即补一轮（对已 stop 的排程器等价重启） */
  resume(): void {
    this.status.desired = 'running'
    this.emitStatus()
    this.deps.scheduler.runNow()
  }

  /**
   * 系统事件（powerMonitor resume / 解锁屏幕）补轮询入口。
   * 尊重用户意图：desired='paused' 时是 no-op——暂停的引擎不会被系统事件唤醒。
   */
  runNow(): void {
    if (this.status.desired !== 'running') return
    this.deps.scheduler.runNow()
  }

  /** 透传 notifier.sendTest（UI「发送测试消息」用）；异常由调用方处理 */
  async sendTestNotification(): Promise<void> {
    await this.deps.notifier.sendTest()
  }

  /** 实时状态快照（新对象，调用方改动不影响引擎内部）；ai 段每次派生（观测面） */
  getStatus(): EngineStatus {
    return { ...INITIAL_ENGINE_STATUS, ...this.status, ai: this.deriveAiStatus() }
  }

  /** 内存命中环形（旧→新顺序），给 UI 展示；返回拷贝 */
  getRecentHits(): HitRecord[] {
    return this.hits.slice()
  }

  /**
   * scheduler.onScheduled 的落点：epoch ms → ISO 写入 EngineStatus.nextPollAt。
   * 由装配方在构造 PollScheduler 时绑定为 onScheduled 回调。
   */
  noteScheduled(nextPollAtMs: number): void {
    this.status.nextPollAt = new Date(nextPollAtMs).toISOString()
    this.emitStatus()
  }

  /**
   * 单轮完整轮询：遍历全部 source，每个独立 try/catch（一个挂不影响后续）。
   * 所有异常在此消化、绝不向上抛（排程器吞异常，见类注释）：
   * - 抓取成功（含基线/无新帖）→ 该 source 复位（health=ok、failures=0、无冷却）；
   * - ChallengeError → 该 source health='challenged'；其他异常 → 'backoff'；
   *   两者都 failures++ 并进独立冷却（computeBackoffMs 曲线），seen/state 不动；
   * - 冷却中的 source 本轮跳过（不动 failures，下一轮再看）；
   * - getConfig/getSources 抛错 → 全局失败收尾（归到全部当前 source / 孤儿兜底）。
   * 全部 source 都在冷却（或没有任何 source）时：不产出新观测，直接聚合收尾。
   * 测试与 --once 脚本也可以直调。
   */
  async pollOnce(): Promise<void> {
    this.status.lastPollAt = this.isoNow()

    let cfg: AppConfig
    let adapters: SourceAdapter[]
    try {
      // getConfig / getSources 都在 try 内：读取异常无法归因到单个 source
      cfg = this.deps.getConfig()
      this.lastIntervalSec = cfg.pollIntervalSec
      this.updateAiConfig(cfg)
      adapters = this.deps.getSources()
    } catch (err) {
      const activeIds = this.failUnattributed(err)
      this.finishRound(this.lastIntervalSec, activeIds)
      return
    }
    this.configFailures = 0
    this.configLastError = null

    const activeIds: string[] = []
    /** 本轮实际抓到的全部 topic 的 seen 键（F5 轮末清理的保留集） */
    const roundTopicKeys = new Set<string>()
    /** 本轮实际执行了 pollSource 的 source（冷却跳过的不算——没有观测） */
    const observedSources = new Set<string>()
    for (const adapter of adapters) {
      const rt = this.ensureRuntime(adapter.id)
      if (!activeIds.includes(adapter.id)) activeIds.push(adapter.id)
      // 退避冷却中：本轮跳过该 source（sleep，不动 failures/health）
      if (rt.cooldownUntilMs !== null && this.now() < rt.cooldownUntilMs) continue
      observedSources.add(adapter.id)
      try {
        await this.pollSource(adapter, cfg, roundTopicKeys)
        this.succeedSource(rt)
      } catch (err) {
        this.failSource(adapter.id, rt, err, cfg.pollIntervalSec)
      }
    }
    this.pruneRetryMaps(roundTopicKeys, observedSources)
    this.finishRound(cfg.pollIntervalSec, activeIds)
  }

  // ---- 内部实现 ----------------------------------------------------------

  /**
   * 每轮从配置刷新 AI 派生态：configured = provider 三项（baseUrl/apiKey/model，
   * trim 后）均非空；mode = cfg.ai.matchMode。配额日翻转也在此检查。
   */
  private updateAiConfig(cfg: AppConfig): void {
    const p = cfg.ai.provider
    this.aiConfigured =
      p.baseUrl.trim() !== '' && p.apiKey.trim() !== '' && p.model.trim() !== ''
    this.aiMode = cfg.ai.matchMode
    this.rollAiDay()
  }

  /** callsToday 的本地自然日翻转（formatLocalDate 判日，D5 坑清单④） */
  private rollAiDay(): void {
    const today = formatLocalDate(new Date(this.now()))
    if (this.aiCallsDay !== today) {
      this.aiCallsDay = today
      this.aiCallsToday = 0
      this.aiQuotaLogged = false
    }
  }

  /**
   * 派生 AiRuntimeStatus（getStatus / pollSource 共用同一口径）：
   * - 未配置 provider → degraded='unconfigured'，effectiveMode='literal'（不管
   *   cfg mode 是什么——语义档整体降级，不算失败）；
   * - mode 含语义且当日配额耗尽 → degraded='quota-exhausted'，effectiveMode='literal'；
   * - 其余 → effectiveMode=cfg mode，degraded='none'。
   * interests 为空不算 unconfigured（evaluator 会全量判 miss，不调 API）。
   */
  private deriveAiStatus(): AiRuntimeStatus {
    const base = {
      configured: this.aiConfigured,
      callsToday: this.aiCallsToday,
      dailyLimit: DAILY_AI_CALL_LIMIT,
      lastAiError: this.aiLastError
    }
    if (!this.aiConfigured) {
      return { ...base, effectiveMode: 'literal', degraded: 'unconfigured' }
    }
    if (this.aiMode !== 'literal' && this.aiCallsToday >= DAILY_AI_CALL_LIMIT) {
      return { ...base, effectiveMode: 'literal', degraded: 'quota-exhausted' }
    }
    return { ...base, effectiveMode: this.aiMode, degraded: 'none' }
  }

  /**
   * 轮询单个 source 的完整管线（D4 匹配管线逐条）：
   * 盖章 → 基线判断 → 新帖逆序处理（排除词否决 → literal → 语义候选收集）→
   * 语义批评估（每批 ≤ MAX_SEMANTIC_BATCH，verdict 三态处理）→
   * 轮末 flush/prune/按 source 持久化 totalHits。
   * 推送顺序：literal 命中按页面逆序（旧→新）在遍历中即时推送；语义命中在其后
   * 按批内顺序（旧→新）推送——批式评估天然滞后一轮内位置，跨档顺序不保证。
   * 异常上抛给 pollOnce 的 per-source catch。
   */
  private async pollSource(
    adapter: SourceAdapter,
    cfg: AppConfig,
    roundTopicKeys: Set<string>
  ): Promise<void> {
    const topics = await adapter.fetchLatest()

    // sourceId 盖章（处理前）：adapter 不感知来源归属（D2/D3）
    for (const t of topics) t.sourceId = adapter.id
    // 本轮观测到的 topic 键登记（F5 轮末清理的保留集）
    for (const t of topics) roundTopicKeys.add(seenKeyFor(adapter.id, t.id))

    // 首启基线（ADR 8.5）：整页只入去重集不推送，防通知风暴（per-source 独立）
    if (!this.deps.state.getFor(adapter.id).baselineDone) {
      for (const t of topics) this.deps.seen.add(seenKeyFor(adapter.id, t.id))
      await this.flushSeenOrFail()
      this.persistState(adapter.id, { baselineDone: true })
      this.deps.logger.info(`source ${adapter.id}: baseline captured (${topics.length} topics)`)
      return
    }

    const unseen = topics.filter((t) => !this.deps.seen.has(seenKeyFor(adapter.id, t.id)))
    const effective = this.deriveAiStatus().effectiveMode
    const literalActive = effective === 'literal' || effective === 'both'
    const semanticActive =
      (effective === 'semantic' || effective === 'both') &&
      this.deps.semanticEvaluator !== undefined
    /** 语义候选（页面顺序旧→新）：遍历后按批评估 */
    const aiPending: Topic[] = []

    // 页面最新在前 → 逆序处理，推送顺序旧→新
    for (const topic of [...unseen].reverse()) {
      const key = seenKeyFor(adapter.id, topic.id)
      if (topic.pinned) {
        // 置顶是旧帖：入去重集但绝不推送
        this.deps.seen.add(key)
        continue
      }
      // 排除词字面一票否决（D4：永远先于 AI；语义模式下同样否决）
      if (isExcluded(topic, cfg.excludeKeywords)) {
        this.deps.seen.add(key)
        continue
      }
      // literal 档（mode 含 literal 时生效；语义档未配置/配额耗尽也会降到这里）
      if (literalActive) {
        const { matched, matchedKeywords } = matchTopic(
          topic,
          cfg.includeKeywords,
          cfg.excludeKeywords
        )
        if (matched) {
          await this.processHit(topic, matchedKeywords, cfg)
          continue
        }
      }
      // 语义档（mode 含 semantic 且 AI operational）：进批，verdict 决定去向。
      // 已判 hit 但推送失败中的帖（D4 坑⑥，F2）：不重进 AI 批——用缓存的
      // verdict 直接按已判 hit 重试推送（省一次调用，也不冒判定翻转的风险）
      if (semanticActive) {
        const cachedVerdict = this.semanticVerdicts.get(key)
        if (cachedVerdict !== undefined) {
          await this.processHit(topic, [], cfg, 'semantic', cachedVerdict.reason)
          continue
        }
        aiPending.push(topic)
        continue
      }
      // 字面档未命中（或语义不可用降级字面后未命中）：与未命中同待遇入 seen
      this.deps.seen.add(key)
    }

    if (aiPending.length > 0) {
      await this.evaluateSemantic(adapter.id, aiPending, cfg)
    }

    await this.flushSeenOrFail()
    this.deps.seen.prune()
    // totalHits 按 source 持久化（本轮 delta；无新增不写盘）
    const delta = this.pendingHits.get(adapter.id) ?? 0
    if (delta > 0) {
      this.persistState(adapter.id, {
        totalHits: this.deps.state.getFor(adapter.id).totalHits + delta
      })
      this.pendingHits.set(adapter.id, 0)
    }
  }

  /**
   * 语义批评估（D4）：候选按 MAX_SEMANTIC_BATCH 切片逐批调 evaluator。
   * interests 为空 → 直接短路（F3）：不调 evaluator、不计 callsToday，全部
   * 按语义未命中入 seen（evaluator 本就快速全 miss，引擎侧跳过更干净，
   * 行为一致只是不再空转计数）。
   * verdict 三态：
   * - hit=true → processHit(matchedBy='semantic'，semanticReason=reason)；
   *   其中推送真失败的 reason 会进 semanticVerdicts 缓存（坑⑥，见 pollSource）；
   * - hit=false → 入 seen（与字面未命中同待遇，不再重评）；
   * - 无 verdict（未决）→ 不入 seen，下轮重评（帖子滚出首页即止，对齐 8.10）。
   * evaluate 整体抛错 → 该批全部未决 + 记 lastAiError + log warn，
   * **不动 consecutiveFailures**（AI 故障 ≠ 抓取故障）。每次真实调用计入
   * callsToday（含失败的调用），达 DAILY_AI_CALL_LIMIT 后本轮剩余批放弃
   * （未决），后续轮降级 literal-only。
   */
  private async evaluateSemantic(
    sourceId: string,
    topics: Topic[],
    cfg: AppConfig
  ): Promise<void> {
    const evaluator = this.deps.semanticEvaluator
    if (evaluator === undefined) return
    if (cfg.ai.interests.length === 0) {
      // F3：空兴趣 = 语义档永不命中（镜像字面档防风暴规则）——不入 AI 批
      for (const topic of topics) this.deps.seen.add(seenKeyFor(sourceId, topic.id))
      return
    }
    for (let i = 0; i < topics.length; i += MAX_SEMANTIC_BATCH) {
      const batch = topics.slice(i, i + MAX_SEMANTIC_BATCH)
      this.rollAiDay()
      if (this.aiCallsToday >= DAILY_AI_CALL_LIMIT) {
        if (!this.aiQuotaLogged) {
          this.aiQuotaLogged = true
          this.deps.logger.warn(
            `AI daily call limit reached (${DAILY_AI_CALL_LIMIT}), ` +
              'semantic matching degraded to literal-only for the rest of the day'
          )
        }
        break // 剩余批保持未决：下一轮按降级后的 literal-only 语义处理
      }
      this.aiCallsToday++
      try {
        const verdicts = await evaluator.evaluate(batch, cfg.ai.interests)
        this.aiLastError = null // 评估成功：清掉历史错误（恢复观测）
        for (const topic of batch) {
          const verdict = verdicts.get(seenKeyFor(sourceId, topic.id))
          if (verdict === undefined) continue // 未决：不入 seen，下轮重评
          if (verdict.hit) {
            await this.processHit(topic, [], cfg, 'semantic', verdict.reason)
          } else {
            this.deps.seen.add(seenKeyFor(sourceId, topic.id))
          }
        }
      } catch (err) {
        this.aiLastError = describeError(err)
        this.deps.logger.warn(
          `semantic evaluation failed (${batch.length} topics undecided, ` +
            `will retry next poll): ${this.aiLastError}`
        )
      }
    }
  }

  /** 取（或建）source 运行态；建卡时并入其持久化 totalHits（含热更新新增的 source） */
  private ensureRuntime(sourceId: string): SourceRuntime {
    let rt = this.runtimes.get(sourceId)
    if (rt === undefined) {
      rt = {
        health: 'ok',
        lastSuccessAt: null,
        lastError: null,
        lastErrorAtMs: 0,
        consecutiveFailures: 0,
        cooldownUntilMs: null,
        baselineChecked: false
      }
      this.runtimes.set(sourceId, rt)
      this.status.totalHits += this.deps.state.getFor(sourceId).totalHits
    }
    if (!rt.baselineChecked) {
      this.rebaselineIfNeeded(sourceId)
      rt.baselineChecked = true
    }
    return rt
  }

  /**
   * seen 损坏重建后强制补基线（ADR 8.9，per-source）：seen 备份重建 = 空集，若该
   * source 的 baselineDone 仍为 true，下一轮会把整页当新帖推送（单页 mini 风暴）
   * ——重置为 false，下一轮按基线处理（全量入集不推送）。
   */
  private rebaselineIfNeeded(sourceId: string): void {
    if (!this.deps.seen.rebuiltFromCorrupt) return
    if (!this.deps.state.getFor(sourceId).baselineDone) return // 本来就要做基线，无需处理
    try {
      this.deps.state.setFor(sourceId, { baselineDone: false })
      this.deps.logger.warn(`seen store rebuilt, re-baselining source ${sourceId}`)
    } catch (err) {
      this.deps.logger.error(
        `cannot reset baselineDone after seen rebuild (source ${sourceId}): ${describeError(err)}`
      )
    }
  }

  /** 单个 source 成功收尾：复位失败计数/冷却/错误，health=ok */
  private succeedSource(rt: SourceRuntime): void {
    rt.health = 'ok'
    rt.consecutiveFailures = 0
    rt.cooldownUntilMs = null
    rt.lastError = null
    rt.lastSuccessAt = this.isoNow()
  }

  /**
   * 单个 source 失败收尾：区分挑战与普通失败，独立指数退避（记 cooldownUntil，
   * 不动全局 scheduler 间隔——全局间隔由 finishRound 按 max 规则统一收口）。
   */
  private failSource(
    sourceId: string,
    rt: SourceRuntime,
    err: unknown,
    baseIntervalSec: number
  ): void {
    rt.consecutiveFailures++
    rt.lastError = err instanceof Error ? err.message : String(err)
    rt.lastErrorAtMs = this.now()
    if (err instanceof ChallengeError) {
      rt.health = 'challenged'
      this.deps.logger.warn(`source ${sourceId} challenged: ${rt.lastError}`)
    } else {
      rt.health = 'backoff'
      this.deps.logger.error(
        `source ${sourceId} poll failed (${rt.consecutiveFailures} consecutive): ${rt.lastError}`
      )
    }
    rt.cooldownUntilMs =
      this.now() + computeBackoffMs(rt.consecutiveFailures, Math.max(0, baseIntervalSec) * 1000)
  }

  /**
   * 无法归因到单个 source 的失败（getConfig / getSources 抛错）：算到当前全部
   * source 头上（没有配置它们谁都轮询不了）；连 source 列表都拿不到且没有任何
   * 已知 source 时，记入孤儿失败（聚合层兜底展示，避免空转却显示 ok）。
   * @returns 参与本轮聚合的 source id 列表
   */
  private failUnattributed(err: unknown): string[] {
    let ids: string[]
    try {
      ids = this.deps.getSources().map((a) => a.id)
    } catch {
      ids = [...this.runtimes.keys()]
    }
    if (ids.length === 0) {
      this.configFailures++
      this.configLastError = describeError(err)
      this.deps.logger.error(`poll failed (no sources available): ${this.configLastError}`)
      return ids
    }
    // getConfig 抛错时用最近一次成功读到的间隔（默认 60s）做退避基数
    for (const id of ids) {
      this.failSource(id, this.ensureRuntime(id), err, this.lastIntervalSec)
    }
    return ids
  }

  /**
   * 轮末收尾：聚合 per-source 运行态到全局字段 + 重算 scheduler 间隔 + emit。
   * 只聚合 activeIds 内的 source——热更新移除的 source 不再影响聚合与间隔
   * （否则残留冷却会把全局间隔永久抬上去）。孤儿失败（无任何 source 且配置层
   * 报错）在聚合层兜底呈现。
   */
  private finishRound(baseIntervalSec: number, activeIds: string[]): void {
    const nowMs = this.now()
    const sources: SourceStatus[] = []
    let health: HealthState = 'ok'
    let consecutiveFailures = 0
    let lastError: string | null = null
    let lastErrorAtMs = -1
    let lastSuccessAt: string | null = null
    let maxRemainingMs = 0

    for (const id of activeIds) {
      const rt = this.runtimes.get(id)
      if (rt === undefined) continue
      sources.push({
        sourceId: id,
        health: rt.health,
        lastSuccessAt: rt.lastSuccessAt,
        lastError: rt.lastError,
        consecutiveFailures: rt.consecutiveFailures,
        cooldownUntil:
          rt.cooldownUntilMs === null ? null : new Date(rt.cooldownUntilMs).toISOString()
      })
      if (HEALTH_SEVERITY[rt.health] > HEALTH_SEVERITY[health]) health = rt.health
      consecutiveFailures = Math.max(consecutiveFailures, rt.consecutiveFailures)
      if (rt.lastError !== null && rt.lastErrorAtMs >= lastErrorAtMs) {
        lastError = rt.lastError
        lastErrorAtMs = rt.lastErrorAtMs
      }
      if (rt.lastSuccessAt !== null && (lastSuccessAt === null || rt.lastSuccessAt > lastSuccessAt)) {
        lastSuccessAt = rt.lastSuccessAt
      }
      if (rt.cooldownUntilMs !== null) {
        maxRemainingMs = Math.max(maxRemainingMs, rt.cooldownUntilMs - nowMs)
      }
    }

    // 没有任何 source 时的孤儿失败（配置层报错且无可归因 source）
    if (activeIds.length === 0 && this.configFailures > 0) {
      health = 'backoff'
      consecutiveFailures = this.configFailures
      lastError = this.configLastError
    }

    this.status.health = health
    this.status.consecutiveFailures = consecutiveFailures
    this.status.lastError = lastError
    this.status.lastSuccessAt = lastSuccessAt
    this.status.sources = sources
    this.deps.scheduler.setIntervalSec(
      Math.max(baseIntervalSec, Math.ceil(Math.max(0, maxRemainingMs) / 1000))
    )
    this.emitStatus()
  }

  /** 轮末去重集落盘；失败只 warn（重启后可能重复推送），不影响本轮健康判定 */
  private async flushSeenOrFail(): Promise<void> {
    if (!(await this.deps.seen.flush())) {
      this.deps.logger.warn('seen flush failed — duplicates possible after restart')
    }
  }

  /**
   * 轮末清理重试缓存（F5）：pendingNotifyErrors / semanticVerdicts 只保留本轮
   * 仍出现在页面上的帖子的键——帖子滚出首页后重试已无意义，删掉防 Map 常驻。
   * 只裁本轮**实际抓取过**的 source（observedSources）：冷却中被跳过的 source
   * 本轮没有观测，其键保留到下一轮，避免冷却窗口内误删仍在首页的帖子状态。
   */
  private pruneRetryMaps(roundTopicKeys: Set<string>, observedSources: Set<string>): void {
    if (this.pendingNotifyErrors.size > 0) {
      for (const key of [...this.pendingNotifyErrors.keys()]) {
        if (!roundTopicKeys.has(key) && observedSources.has(sourceIdOfKey(key))) {
          this.pendingNotifyErrors.delete(key)
        }
      }
    }
    if (this.semanticVerdicts.size > 0) {
      for (const key of [...this.semanticVerdicts.keys()]) {
        if (!roundTopicKeys.has(key) && observedSources.has(sourceIdOfKey(key))) {
          this.semanticVerdicts.delete(key)
        }
      }
    }
  }

  /**
   * 处理一条命中的新帖：尝试推送 → 组 HitRecord → 计数入环 → emit onHit。
   * 推送结果语义（ADR 8.10）：
   * - **成功 / 静音**（notifyEnabled=false 或 telegram 未配置）→ 入去重集。
   *   静音是用户主动行为，不重试；
   * - **真实推送失败**（notifier 抛错）→ **不**入去重集，下轮自然重试
   *   （帖子滚出首页第 1 页即止，天然有界）；同键同失败态只 emit/log 一次，
   *   成功或转静音后清除待重试标记并 emit 最终态。
   * 推送失败不中断本轮后续 topic。重试去重键 = 全局键 `${sourceId}:${topicId}`
   * （跨 source 同 id 帖子不互相吞 emit）。
   * matchedBy：literal（字面管线，matchedKeywords 非空）/ semantic（语义管线，
   * matchedKeywords 恒空数组，semanticReason 带 AI 判定理由或 null）。
   */
  private async processHit(
    topic: Topic,
    matchedKeywords: string[],
    cfg: AppConfig,
    matchedBy: 'literal' | 'semantic' = 'literal',
    semanticReason: string | null = null
  ): Promise<void> {
    let notifiedAt: string | null = null
    let notifyError: string | null = null
    const configured = cfg.telegram.botToken !== '' && cfg.telegram.chatId !== ''
    if (cfg.notifyEnabled && configured) {
      try {
        await this.deps.notifier.sendHit(topic, matchedKeywords)
        notifiedAt = this.isoNow()
      } catch (err) {
        notifiedAt = null
        notifyError = err instanceof Error ? err.message : String(err)
      }
    }

    const key = seenKeyFor(topic.sourceId, topic.id)

    if (notifyError !== null) {
      // 真实推送失败：不入去重集（下轮重试）；同失败态只 emit/log 一次
      const prevError = this.pendingNotifyErrors.get(key)
      if (prevError !== notifyError) {
        this.pendingNotifyErrors.set(key, notifyError)
      } else {
        return
      }
      // 语义命中额外缓存 verdict（D4 坑⑥，F2）：下轮绕过 AI 批直接重试本判定
      if (matchedBy === 'semantic') this.semanticVerdicts.set(key, { reason: semanticReason })
      const hit: HitRecord = {
        topic,
        matchedKeywords,
        matchedBy,
        semanticReason,
        notifiedAt: null,
        notifyError
      }
      this.recordHit(hit)
      this.deps.logger.error(
        `notify failed for topic ${key} "${topic.title}": ${notifyError} (will retry next poll)`
      )
      this.deps.onHit?.(hit)
      return
    }

    // 成功或静音：入去重集；曾在失败重试中的清除标记（上面已 emit 过失败态，
    // 这里 emit 最终态），静音态两字段均 null（HitRecord 语义不变）。verdict
    // 缓存一并清除（重试收口，防 Map 常驻，F2/F5）
    this.pendingNotifyErrors.delete(key)
    this.semanticVerdicts.delete(key)
    this.deps.seen.add(key)
    const hit: HitRecord = {
      topic,
      matchedKeywords,
      matchedBy,
      semanticReason,
      notifiedAt,
      notifyError: null
    }
    this.recordHit(hit)
    if (notifiedAt !== null) {
      if (matchedBy === 'semantic') {
        this.deps.logger.info(
          `hit pushed (semantic): "${topic.title}" (reason: ${semanticReason ?? 'n/a'})`
        )
      } else {
        this.deps.logger.info(
          `hit pushed: "${topic.title}" (keywords: ${matchedKeywords.join(', ')})`
        )
      }
    } else {
      this.deps.logger.info(`hit muted (notify disabled or telegram unconfigured): "${topic.title}"`)
    }
    this.deps.onHit?.(hit)
  }

  /** 计入 totalHits（聚合 + 该 source 的待持久化 delta）并压入内存环形（超容量淘汰最老） */
  private recordHit(hit: HitRecord): void {
    this.status.totalHits++
    const sid = hit.topic.sourceId
    this.pendingHits.set(sid, (this.pendingHits.get(sid) ?? 0) + 1)
    this.hits.push(hit)
    if (this.hits.length > HIT_RING_CAPACITY) this.hits.shift()
    // 命中持久化（D5）：与 emit onHit 同处；append 失败只 warn 不中断
    if (this.deps.hitsStore !== undefined) {
      void this.deps.hitsStore.append(hit, new Date(this.now())).catch((err: unknown) => {
        this.deps.logger.warn(`hits append failed: ${describeError(err)}`)
      })
    }
  }

  /** 持久化某 source 的引擎状态；落盘失败只记日志不改变本轮健康判定（下一轮再试） */
  private persistState(sourceId: string, patch: Partial<SourceEngineState>): void {
    try {
      this.deps.state.setFor(sourceId, patch)
    } catch (err) {
      this.deps.logger.error(
        `persist engine state failed (source ${sourceId}): ${describeError(err)}`
      )
    }
  }

  private emitStatus(): void {
    this.deps.onStatus?.(this.getStatus())
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString()
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
