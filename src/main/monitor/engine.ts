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
 * hit 且 score >= ai.semanticThreshold（R5-P2b 置信度闸，0=不过滤）推送 /
 * miss 或低置信 hit 入 seen / 未决不入 seen 下轮重评）→
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
 * - 锐评（第三轮）：processHit 内 sendHit 之前按四条件生成（开关开 / provider
 *   已配置 / 总配额未耗尽 / 子限额 100 未耗尽），任一不满足 → commentary=null
 *   不打 LLM；真调 generate 即双计数（callsToday 与 commentaryToday 各 +1，
 *   成败都计——generate 内部消化异常）。子限额 100 保证语义评估在总桶里至少
 *   剩 200 容量，两用途无需调序（literal 命中先于语义批烧配额是有意的先到先得）。
 *   推送失败重试轮 generate 会被再次调用，但 CommentGenerator 内部缓存（含
 *   失败负缓存）保证不再打 LLM；轮末与 pruneRetryMaps 同调用点、同一
 *   roundTopicKeys 键集与 observedSources 守卫调 prune 清理其缓存（F1）。
 *   deps 未注入生成器 = 恒无锐评，行为与升级前完全一致。
 *
 * per-source 运行态（SourceRuntime，内存）：health / lastSuccessAt / lastError /
 * consecutiveFailures / cooldownUntilMs——同一退避曲线 computeBackoffMs（含
 * ChallengeError：health='challenged' 但同样进冷却，避免每轮硬撞 Cloudflare）。
 * 失败只影响该 source；持久化部分（baselineDone / totalHits / maxSeenTopicId）
 * 走 state.getFor/setFor。
 *
 * 旧帖过滤（W3，仅 creationOrderedIds 来源）：NodeSeek 首页按最后回复时间排序，
 * 旧帖被回复顶回首页会被误判新帖。engine 维护 per-source 阈值 maxSeenTopicId
 * （持久化），unseen 且数值 id ≤ 阈值的帖子按旧帖跳过（入 seen 不推送）。
 * - 阈值初始化两条路径：真·首装在基线轮末同轮写入整页 max id；存量升级
 *   （baselineDone=true 但阈值 null）走静默初始化轮——整页 unseen 全入 seen、
 *   写阈值、不推送不评估，正常收尾返回。
 * - 豁免集 prevUnseenKeys（ultrabrain 修正）：上一轮就在 unseen 处理流里的帖子
 *   （推送失败重试 / 语义未决重评——它们不入 seen）不被阈值吞掉，否则轮末
 *   阈值追上后重试机会被永久杀死。
 * - 阈值只升不降（max(旧阈值, 本页 max 数值 id)），与 seen 重建/baseline 重置
 *   互不影响；pageMax 下降时 warn（id 单调性异常信号）。
 * - 非数字 id（非 /^\d+$/ 或超出安全整数）跳过过滤且不计入阈值。
 *
 * R5-P2a（第五轮引擎确定性管线）：
 * - per-source 过滤（getSourceFilters 访问器，可选依赖）：unseen 链第 2 步，
 *   滤帖入 seen 不推送不评估（filters.ts 纯函数）。
 * - 价格规则（rules.ts）：第 6 步、先于 literal、命中即得（同一帖只记一种命中
 *   方式，规则优先）；matchedBy='rule' + matchedRule（规则 label，无 label 用 id）。
 * - 相似降噪（similarity.ts，DEC-4）：命中帖推送前与 48h"近期已推"窗口比对
 *   （第 8 步，作用于 rule/literal/semantic 全部命中方式；enabled=false 跳过），
 *   相似 → 入 seen 不推送 + log + 内存计数。推送成功入窗（第 10 步，失败/静音
 *   不入），轮末 48h prune；启动自 hits 近 3 天记录重建（第 11 步，构造期发起、
 *   首个 pollOnce 顶部 await 保证就位）。
 * - 第 2 页自适应（DEC-8）：上一轮有效新帖数（进入匹配管线的帖子数）≥ 40 且
 *   health=ok → fetchLatest({pages:2})（第 2 页失败由 adapter 吞并，按第 1 页
 *   成功收尾）；观测面 SourceStatus.page2Fetches（内存累计）。
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
import { applySourceFilters } from './filters'
import { isExcluded, matchTopic } from './matcher'
import { evaluateRules } from './rules'
import { isSimilarToAny, normalizeTitle } from './similarity'
import { computeBackoffMs, type PollScheduler } from './poller'
import type { FileSeenStore } from './dedup'
import { formatLocalDate } from './hits-store'
import type { FileEngineState, SourceEngineState } from './state'
import { ChallengeError, type SourceAdapter } from './types'
import type { SemanticEvaluator } from '../ai/evaluator'
import { MAX_SEMANTIC_BATCH } from '../ai/evaluator'
import type { CommentGenerator } from '../ai/commentary'
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
  type SourceFilters,
  type SourceStatus,
  type Topic
} from '../../shared/types'

/** 命中记录内存环形容量（getRecentHits 给 UI 的上限） */
export const HIT_RING_CAPACITY = 200

/** AI 每日调用上限（D4：常量 300，v2 不进配置） */
export const DAILY_AI_CALL_LIMIT = 300

/**
 * 相似降噪"近期已推"窗口时长（R5-P2a，DEC-4）：48h，引擎侧常量不进配置。
 * 生命周期：推送成功入窗（推送失败/静音不入）；每轮轮末按时间 prune。
 */
export const SIMILARITY_WINDOW_MS = 48 * 60 * 60 * 1000

/**
 * 启动重建窗口读取的天数（R5-P2a 第 11 步）：48h 跨本地日最多涉 3 个日桶
 * （今天 + 前 2 天），读 3 天即完整覆盖；超出 48h 的记录不进窗（窗口不变式）。
 */
const SIMILARITY_REBUILD_DAYS = 3

/**
 * 第 2 页补抓触发阈值（DEC-8）：上一轮**有效新帖数**（过了 id 阈值 + 置顶 +
 * 排除词 + per-source 过滤之后进入匹配管线的帖子数）≥ 此值才请求第 2 页。
 * 40 ≈ NodeSeek 单页 49 条去掉置顶后的全量新页，即"整页都是新帖"的信号。
 */
export const PAGE2_TRIGGER_EFFECTIVE_NEW = 40

/**
 * 锐评每日调用子限额（第三轮：常量 100，v2 不进配置）。与 300 总桶共用
 * callsToday 计数；超限当日静默降级（无锐评推送，不打 LLM）——100 上限保证
 * 语义评估在总桶里至少保留 200 容量，两用途无需调序。
 */
export const DAILY_COMMENTARY_LIMIT = 100

/**
 * 全局去重键 = `${sourceId}:${topic.id}`（D2/D3）。与 v1 seen.json 迁移的前缀口径
 * 等价：nodeseek 的键恒为 `nodeseek:{id}`（dedup.ts 的 NODESEEK_SEEN_KEY_PREFIX
 * 只在 v1 裸 id 迁移处使用，这里的一般化拼法与其一致，防漂移）。
 */
const seenKeyFor = (sourceId: string, topicId: string): string => `${sourceId}:${topicId}`

/** seen 键 → sourceId 部分（首个冒号前；pruneRetryMaps 判断键归属用，F5） */
const sourceIdOfKey = (key: string): string => key.slice(0, key.indexOf(':'))

/**
 * topic id 的数值解析（W3 旧帖过滤）：纯数字字符串且落在安全整数范围才有效
 * （`/^\d+$/` + Number.isSafeInteger；前导零容忍，超大数字串视为非法）。
 * 非法（null）时该帖跳过过滤、不计入阈值计算。
 */
const NUMERIC_TOPIC_ID_RE = /^\d+$/
function parseNumericTopicId(id: string): number | null {
  if (!NUMERIC_TOPIC_ID_RE.test(id)) return null
  const n = Number(id)
  return Number.isSafeInteger(n) ? n : null
}

/** 整页最大合法数值 id（W3 阈值初始化/推进与 pageMax 观测的唯一输入）；无合法数值 id 时 null */
function maxNumericTopicId(topics: Topic[]): number | null {
  let max: number | null = null
  for (const t of topics) {
    const n = parseNumericTopicId(t.id)
    if (n !== null && (max === null || n > max)) max = n
  }
  return max
}

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
  /**
   * W3 旧帖过滤豁免集：上一轮实际进入 unseen 处理循环的键集（含字面/语义/重试
   * 所有路径）。推送失败重试与语义未决的帖子不入 seen，而轮末阈值会追上它们的
   * id——下一轮若无豁免会被 "id ≤ 阈值" 当旧帖入 seen，重试/重评机会被永久吞掉。
   * 每轮成功观测后整集替换为本轮 unseen 键集（替换即裁剪：滚出首页/已入 seen
   * 的键自然消失；冷却或抓取失败的轮次不更新，保留到下一次成功观测——与
   * pruneRetryMaps 同款生命周期）。内存态：进程重启后丢失（重启瞬间在途重试的
   * 帖子会被阈值吞掉，可接受——重试窗口本来就有界）。
   */
  prevUnseenKeys: Set<string>
  /** 上一轮页面的最大合法数值 id（W3 观测：pageMax 下降 warn 的比较基准）；null = 未观测过 */
  lastPageMaxId: number | null
  /**
   * 上一轮**有效新帖数**（R5-P2a / DEC-8 第 2 页自适应的输入）：过了 id 阈值 +
   * 置顶 + 排除词 + per-source 过滤之后**进入匹配管线**（规则/字面/语义）的帖子
   * 数——不是裸 unseen。≥ PAGE2_TRIGGER_EFFECTIVE_NEW(40) 且 health=ok 时下一轮
   * fetchLatest 请求 2 页。轮末成功观测后更新；失败/冷却轮不更新（保留上一次
   * 成功观测值，与 prevUnseenKeys 同款生命周期）。基线/升级初始化轮置 0（整页
   * 吞并，没有帖子进管线）。
   */
  prevEffectiveNewCount: number
  /** 第 2 页补抓累计次数（DEC-8 观测面，内存：SourceStatus.page2Fetches；重启清零） */
  page2Fetches: number
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
  /**
   * per-source 过滤访问器（R5-P2a，可选依赖）：sourceId → 该来源的 SourceFilters
   * （来自 config.sources[].filters；配置热更新语义——engine 每轮 pollSource 取，
   * 装配方闭包读 store 当前值）。未注入 / 返回 undefined = 不过滤（默认行为不变，
   * headless/桌面装配方各接一行）。
   */
  getSourceFilters?: (sourceId: string) => SourceFilters | undefined
  /**
   * Telegram 推送（TelegramNotifier 结构满足此接口；单测可全 mock）。
   * sendHit 第三参 commentary（第三轮 AI 锐评）与第四参 matchedRule（第五轮
   * 价格规则命中的规则 label；literal/semantic 命中恒传 null——不传 undefined）：
   * 两参/三参实现的旧装配方结构兼容无需改动（参数少的方法可赋给参数多的签名）。
   */
  notifier: {
    sendHit(
      topic: Topic,
      matchedKeywords: string[],
      commentary?: string | null,
      matchedRule?: string | null
    ): Promise<void>
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
   * AI 锐评生成器（第三轮；可选——不注入 = 恒无锐评，行为与升级前完全一致）。
   * engine 只依赖 generate/prune 接口（CommentGenerator 结构类型）；generate
   * 的"绝不抛 / 成败皆缓存 / 在途去重"契约由模块自身保证，engine 不 try/catch。
   * prune 收 (roundTopicKeys, observedSources) 两参：与 pruneRetryMaps 同款
   * observedSources 守卫（冷却/失败轮不清缓存，F1）。
   */
  commentaryGenerator?: Pick<CommentGenerator, 'generate' | 'prune'>
  /**
   * 命中持久化（D5 hits/<date>.jsonl；可选）。每次 emit onHit 的同处 append；
   * append 失败只 log warn 不中断（调用方 catch，hits-store 的 append 会 reject）。
   * readRecent（R5-P2a 第 11 步，可选）：启动重建相似降噪窗口的数据源——
   * HitsStore 自带该方法；只注入 { append } 的旧装配/测试结构兼容（缺省 = 窗口
   * 从空开始，行为等于全新安装）。
   */
  hitsStore?: {
    append(hit: HitRecord, now?: Date): Promise<void>
    readRecent?(days: number, now?: Date): Promise<HitRecord[]>
  }
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
   * 已过置信度闸（R5-P2b：score >= semanticThreshold）且已判 hit、但推送失败
   * 中的语义帖缓存（D4 坑⑥，F2）：seen 键 -> AI 判定理由。
   * 下轮该帖仍在首页时不重进 AI 批（不耗配额、不冒改变判定风险，也**不再过
   * 阈值**——过闸是既成事实），直接按已判 hit 走 processHit 重试；推送成功/
   * 转静音清除；帖子滚出首页随轮末清理回收（pruneRetryMaps，F5）。与
   * pendingNotifyErrors 是两套机制：后者是全部命中共用的「失败原因去重 emit」
   * 表，前者只服务语义档的 verdict 复用。缓存值只存 reason：重试路径不读
   * score（不再过闸），无需保存。
   */
  private readonly semanticVerdicts = new Map<string, { reason: string | null }>()
  /** sourceId -> 运行态（含热更新后加入的 source；移除的 source 保留卡但退出聚合） */
  private readonly runtimes = new Map<string, SourceRuntime>()
  /** sourceId -> 本轮新增命中数（轮末按 source 持久化 totalHits 后清零） */
  private readonly pendingHits = new Map<string, number>()
  /**
   * 相似降噪"近期已推"窗口（R5-P2a 第 8/10 步）：成功推送过的标题（normalizeTitle
   * 归一化后）+ 推送时刻（epoch ms），数组旧→新。命中帖推送前与窗口比对，相似则
   * 入 seen 不推送（log info + 计数）。推送失败（pendingNotifyErrors 路径）/静音
   * 不入窗——窗口语义是"用户已收到"。每轮轮末按 48h prune（对齐 pruneRetryMaps
   * 调用点）。内存态：重启靠 hits 重建（similarityWindowReady）。
   */
  private readonly pushedTitles: { title: string; at: number }[] = []
  /**
   * 相似降噪吞并计数（R5-P2a，内存、重启清零；后续 D1 流水再接观测面）。
   * 测试通过 internals 模式观测（同 retryMapSize 先例）。
   */
  private similarSwallowedCount = 0
  /**
   * 启动窗口重建 promise（构造期发起、首个 pollOnce 顶部 await）：保证首轮
   * 推送前窗口已就位——避免重建晚于首轮回填导致跨重启的近重复漏网。
   * 重建内部消化一切异常（fail-safe：失败 = 空窗开始，只 log warn）。
   */
  private readonly similarityWindowReady: Promise<void>
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
  /**
   * 今日锐评调用数（第三轮；与 aiCallsToday 同日键 aiCallsDay 一起翻转清零）。
   * 上限 DAILY_COMMENTARY_LIMIT(100)，超限当日静默降级；每次真调 generate 时
   * 与 aiCallsToday 同时 +1（共用总桶）。
   */
  private commentaryToday = 0
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
    // R5-P2a 第 11 步：启动重建相似降噪窗口（近 3 天 hits、notifiedAt 非空、
    // 仍在 48h 窗口内）。构造期发起（异步，不阻塞构造），首个 pollOnce 顶部 await。
    this.similarityWindowReady = this.rebuildSimilarityWindow()
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
    /**
     * 本轮成功抓取了页面的 source（F1）：冷却跳过或抓取失败的 source 都不算
     * 观测——没有页面数据就没有"滚出首页"的证据，轮末清理不得动其键。
     */
    const observedSources = new Set<string>()
    for (const adapter of adapters) {
      const rt = this.ensureRuntime(adapter.id)
      if (!activeIds.includes(adapter.id)) activeIds.push(adapter.id)
      // 退避冷却中：本轮跳过该 source（sleep，不动 failures/health）
      if (rt.cooldownUntilMs !== null && this.now() < rt.cooldownUntilMs) continue
      try {
        await this.pollSource(adapter, rt, cfg, roundTopicKeys)
        observedSources.add(adapter.id)
        this.succeedSource(rt)
      } catch (err) {
        this.failSource(adapter.id, rt, err, cfg.pollIntervalSec)
      }
    }
    this.pruneRetryMaps(roundTopicKeys, observedSources)
    // 相似降噪窗口轮末 prune（R5-P2a 第 10 步）：只保留仍在 48h 窗口内的条目
    // （时间维度全局裁剪，与 per-source 的 roundTopicKeys 无关；生命周期对齐
    // pruneRetryMaps 的调用点）
    this.pruneSimilarityWindow()
    // 锐评缓存清理（第三轮）：与 pruneRetryMaps 同一调用点、同一 roundTopicKeys
    // 键集与 observedSources 守卫（键注册在 pollSource 的提前 return 之前，基线/
    // 升级初始化轮同样覆盖；冷却跳过的 source 未观测 → 其键保留，F1）；
    // deps 未注入生成器时跳过（可选链）
    this.deps.commentaryGenerator?.prune(roundTopicKeys, observedSources)
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

  /** callsToday / commentaryToday 的本地自然日翻转（formatLocalDate 判日，D5 坑清单④） */
  private rollAiDay(): void {
    const today = formatLocalDate(new Date(this.now()))
    if (this.aiCallsDay !== today) {
      this.aiCallsDay = today
      this.aiCallsToday = 0
      this.commentaryToday = 0
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
      commentaryToday: this.commentaryToday,
      dailyLimit: DAILY_AI_CALL_LIMIT,
      // 锐评子上限随状态下发（F4）：渲染层单一事实源，不硬编码 100
      commentaryLimit: DAILY_COMMENTARY_LIMIT,
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
   * 轮询单个 source 的完整管线（unseen 处理链的最终顺序，ultrabrain 裁定）：
   * 盖章（1）→ per-source 过滤（2，R5-P2a：滤帖入 seen 不推送不评估）→
   * 基线判断（W3：基线轮末同轮初始化 id 阈值）→ 存量升级静默初始化轮
   * （W3：baselineDone=true 但阈值 null 时整页入 seen 不推送）→ 新帖逆序处理
   * （旧帖 id 过滤(3) → 置顶(4) → 排除词否决(5) → 价格规则(6，R5-P2a：先于
   * literal、命中即得) → literal(7) → 语义候选收集(9)）→ 命中帖推送前统一过
   * 相似降噪闸（8，R5-P2a：与 48h 已推窗口相似 → 入 seen 不推）→ 语义批评估 →
   * 轮末 flush/prune/prevUnseenKeys 轮换/阈值推进与 totalHits 合并持久化。
   * 推送顺序：literal/规则命中按页面逆序（旧→新）在遍历中即时推送；语义命中在其后
   * 按批内顺序（旧→新）推送——批式评估天然滞后一轮内位置，跨档顺序不保证。
   * 异常上抛给 pollOnce 的 per-source catch。
   */
  private async pollSource(
    adapter: SourceAdapter,
    rt: SourceRuntime,
    cfg: AppConfig,
    roundTopicKeys: Set<string>
  ): Promise<void> {
    // 第 2 页自适应（R5-P2a / DEC-8 修正口径）：上一轮有效新帖数 ≥ 40 且来源当前
    // 健康（health=ok——challenged/backoff 恢复后的第一轮不补抓，防双倍 CF 暴露）
    // 才请求 2 页。Adapter 不支持 pages（rss/v2ex 收 opts 忽略）时行为不变。
    // page2Fetches 口径 = 引擎发起 2 页请求的次数（内存累计；第 2 页在 adapter
    // 内部失败也计——观测的是"补抓被触发"这个引擎侧事实）。
    const wantPage2 =
      rt.prevEffectiveNewCount >= PAGE2_TRIGGER_EFFECTIVE_NEW && rt.health === 'ok'
    const topics = await adapter.fetchLatest({ pages: wantPage2 ? 2 : 1 })
    if (wantPage2) rt.page2Fetches++

    // sourceId 盖章（处理前）：adapter 不感知来源归属（D2/D3）
    for (const t of topics) t.sourceId = adapter.id
    // 本轮观测到的 topic 键登记（F5 轮末清理的保留集）
    for (const t of topics) roundTopicKeys.add(seenKeyFor(adapter.id, t.id))

    // ---- W3 id 阈值上下文（仅 creationOrderedIds 来源参与；其余来源零行为变化） --
    const idFilter = adapter.creationOrderedIds === true
    const pageMaxId = maxNumericTopicId(topics)
    // pageMax 观测：下降 = id 单调性异常信号（阈值只升不降，不受影响；但值得告警
    // ——可能页面结构变化/抓到异常页/站点 id 语义改变）
    if (idFilter && pageMaxId !== null && rt.lastPageMaxId !== null && pageMaxId < rt.lastPageMaxId) {
      this.deps.logger.warn(
        `source ${adapter.id}: page max topic id decreased (${rt.lastPageMaxId} -> ${pageMaxId}), id monotonicity anomaly`
      )
    }
    if (idFilter) rt.lastPageMaxId = pageMaxId
    const sourceState = this.deps.state.getFor(adapter.id)
    const threshold = idFilter ? sourceState.maxSeenTopicId : null

    // 首启基线（ADR 8.5）：整页只入去重集不推送，防通知风暴（per-source 独立）。
    // W3：基线轮末同轮初始化阈值（整页 max id），与 baselineDone 同 patch 原子写。
    // 取 max(旧阈值, pageMax)——seen 损坏补基线时旧阈值仍在（阈值独立于 seen
    // 重建），历史高点不该被当前页拉低。
    if (!sourceState.baselineDone) {
      for (const t of topics) this.deps.seen.add(seenKeyFor(adapter.id, t.id))
      await this.flushSeenOrFail()
      const initThreshold = idFilter && pageMaxId !== null
      const persisted = this.persistState(adapter.id, {
        baselineDone: true,
        ...(initThreshold ? { maxSeenTopicId: Math.max(threshold ?? 0, pageMaxId) } : {})
      })
      // F3：阈值写入失败可观测——写不进去则下一轮基线/阈值初始化重来一轮；
      // 不改变控制流（仍正常收尾返回）
      if (initThreshold && !persisted) {
        this.deps.logger.error('id threshold persist failed — upgrade init will repeat next round')
      }
      this.deps.logger.info(
        `source ${adapter.id}: baseline captured (${topics.length} topics)` +
          (idFilter && pageMaxId !== null ? `, id threshold initialized at ${pageMaxId}` : '')
      )
      rt.prevUnseenKeys = new Set() // 基线整页入集：无在途帖，豁免集清空
      rt.prevEffectiveNewCount = 0 // 整页吞并：无帖进管线，page2 触发条件复位
      return
    }

    // ---- W3 存量升级静默初始化轮：baselineDone=true 但阈值缺失 ------------------
    // 旧版升级用户首跑（state 里没有 maxSeenTopicId）：若直接走正常管线，页面上
    // 所有"回复顶起/久未见过"的旧帖都会被当新帖评估推送（正是本特性要修的 bug
    // 的存量版）。本轮整页 unseen 全部入 seen、写阈值、不推送不评估，正常收尾
    // 返回（不算失败）；下轮起阈值过滤生效。pageMax 为 null（整页无合法数值 id，
    // 对 NodeSeek 属异常形态）时不做初始化，落回正常管线（阈值仍 null = 不过滤）。
    if (idFilter && threshold === null && pageMaxId !== null) {
      const unseenCount = topics.filter(
        (t) => !this.deps.seen.has(seenKeyFor(adapter.id, t.id))
      ).length
      for (const t of topics) this.deps.seen.add(seenKeyFor(adapter.id, t.id))
      await this.flushSeenOrFail()
      // F3：阈值写入失败可观测——写不进去则下一轮 threshold 仍 null，静默初始化
      // 轮整个重来（帖子已入 seen，重来做的是阈值部分）；控制流不变（正常收尾）
      if (!this.persistState(adapter.id, { maxSeenTopicId: pageMaxId })) {
        this.deps.logger.error('id threshold persist failed — upgrade init will repeat next round')
      }
      this.deps.logger.info(
        `source ${adapter.id}: id threshold initialized at ${pageMaxId}, ` +
          `${unseenCount} topics swallowed (upgrade init)`
      )
      rt.prevUnseenKeys = new Set() // 整页已入集：无在途帖
      rt.prevEffectiveNewCount = 0 // 整页吞并：无帖进管线
      return
    }

    const unseen = topics.filter((t) => !this.deps.seen.has(seenKeyFor(adapter.id, t.id)))
    /** W3：本轮 unseen 键集（轮末整集替换为下一轮的豁免集 prevUnseenKeys） */
    const roundUnseenKeys = new Set(unseen.map((t) => seenKeyFor(adapter.id, t.id)))
    /** W3：本轮被旧帖过滤吞并（入 seen 不推送）的帖子数（观测用） */
    let swallowedOld = 0
    /** R5-P2a：本轮被 per-source 过滤吞并（入 seen 不推送不评估）的帖子数（观测用） */
    let swallowedByFilters = 0
    /** R5-P2a：本轮进入匹配管线（规则/字面/语义）的有效新帖数——page2 自适应的输入 */
    let effectiveNew = 0
    const effective = this.deriveAiStatus().effectiveMode
    const literalActive = effective === 'literal' || effective === 'both'
    const semanticActive =
      (effective === 'semantic' || effective === 'both') &&
      this.deps.semanticEvaluator !== undefined
    /** 语义候选（页面顺序旧→新）：遍历后按批评估 */
    const aiPending: Topic[] = []
    // per-source 过滤配置（R5-P2a 第 2 步）：访问器每轮重读（配置热更新语义），
    // 未注入/undefined = 不过滤
    const sourceFilters = this.deps.getSourceFilters?.(adapter.id)

    // 页面最新在前 → 逆序处理，推送顺序旧→新
    for (const topic of [...unseen].reverse()) {
      const key = seenKeyFor(adapter.id, topic.id)
      // per-source 过滤（R5-P2a 第 2 步，先于 id 阈值——ultrabrain 裁定管线顺序）：
      // 分类白/黑名单（显示名或 slug 双口径）与作者黑名单。被滤帖入 seen 不推送
      // 不评估（与旧帖阈值同款语义）。
      if (sourceFilters !== undefined && !applySourceFilters(topic, sourceFilters)) {
        this.deps.seen.add(key)
        swallowedByFilters++
        continue
      }
      // W3 旧帖过滤（第 3 步）：首页按最后回复排序，被回复顶回首页
      // 的旧帖满足 "unseen 且数值 id ≤ 阈值" → 入 seen 不推送。豁免：上一轮就在
      // unseen 处理流里的帖子（prevUnseenKeys，含推送失败重试/语义未决——他们
      // 不入 seen，而轮末阈值会追上其 id，不豁免会永久吞掉重试机会）。
      // 非数字 id 不过滤（也不进阈值计算）。
      if (idFilter && threshold !== null) {
        const numericId = parseNumericTopicId(topic.id)
        if (numericId !== null && numericId <= threshold && !rt.prevUnseenKeys.has(key)) {
          this.deps.seen.add(key)
          swallowedOld++
          continue
        }
      }
      if (topic.pinned) {
        // 置顶是旧帖（第 4 步）：入去重集但绝不推送
        this.deps.seen.add(key)
        continue
      }
      // 排除词字面一票否决（第 5 步，D4：永远先于 AI；语义模式下同样否决）
      if (isExcluded(topic, cfg.excludeKeywords)) {
        this.deps.seen.add(key)
        continue
      }
      // 过了全部四道闸（per-source / id 阈值 / 置顶 / 排除词）：进入匹配管线，
      // 计入有效新帖数（page2 自适应的输入——不是裸 unseen）
      effectiveNew++
      // 价格规则（R5-P2a 第 6 步）：结构化第三命中通道，先于 literal 评估——
      // 命中即得、不再走 literal（同一帖只记一种命中方式，规则优先）。不受
      // matchMode 门控（matchMode 只管字面关键词 vs AI 语义的分派；规则是零
      // 成本的结构化匹配，semantic-only 模式下同样生效）。规则列表为空时短路
      // （省掉逐标题的正则提取开销）。
      if (cfg.priceRules.length > 0) {
        const ruleMatch = evaluateRules(topic.title, cfg.priceRules)
        if (ruleMatch !== null) {
          await this.processHit(topic, [], cfg, 'rule', null, ruleMatch.label)
          continue
        }
      }
      // literal 档（第 7 步；mode 含 literal 时生效；语义档未配置/配额耗尽也降到这里）
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

    // W3 轮末：本轮 unseen 键集整集替换为下一轮的豁免集（替换即裁剪，生命周期
    // 对齐 pruneRetryMaps：滚出首页/已入 seen 的键自然消失；本轮冷却跳过或抓取
    // 失败的 source 不走到这里，其豁免集原样保留到下一次成功观测）
    rt.prevUnseenKeys = roundUnseenKeys
    // R5-P2a：有效新帖数轮末落位（page2 自适应下一轮的输入；失败/冷却轮走不到
    // 这里，保留上一次成功观测值）
    rt.prevEffectiveNewCount = effectiveNew
    if (swallowedOld > 0) {
      this.deps.logger.info(
        `source ${adapter.id}: ${swallowedOld} old topic(s) swallowed ` +
          `(bumped by replies, id <= threshold ${threshold})`
      )
    }
    if (swallowedByFilters > 0) {
      this.deps.logger.info(
        `source ${adapter.id}: ${swallowedByFilters} topic(s) swallowed by per-source filters`
      )
    }

    await this.flushSeenOrFail()
    this.deps.seen.prune()
    // 轮末持久化（合并为一次 setFor，避免双写）：totalHits delta（无新增不写）+
    // W3 阈值推进 max(旧阈值 ?? 0, pageMax)——仅变化时写入，只升不降（pageMax
    // 低于旧阈值 = 高 id 帖滚出首页，正常现象，不回撤）。
    const delta = this.pendingHits.get(adapter.id) ?? 0
    const patch: Partial<SourceEngineState> = {}
    if (idFilter && pageMaxId !== null && pageMaxId > (threshold ?? 0)) {
      patch.maxSeenTopicId = pageMaxId
    }
    if (delta > 0) {
      patch.totalHits = this.deps.state.getFor(adapter.id).totalHits + delta
      this.pendingHits.set(adapter.id, 0)
    }
    if (patch.maxSeenTopicId !== undefined || patch.totalHits !== undefined) {
      this.persistState(adapter.id, patch)
    }
    if (patch.maxSeenTopicId !== undefined) {
      this.deps.logger.info(
        `source ${adapter.id}: id threshold advanced to ${patch.maxSeenTopicId} (pageMax=${pageMaxId})`
      )
    }
  }

  /**
   * 语义批评估（D4）：候选按 MAX_SEMANTIC_BATCH 切片逐批调 evaluator。
   * interests 为空 → 直接短路（F3）：不调 evaluator、不计 callsToday，全部
   * 按语义未命中入 seen（evaluator 本就快速全 miss，引擎侧跳过更干净，
   * 行为一致只是不再空转计数）。
   * verdict 三态（R5-P2b：hit 的去留多一道置信度闸）：
   * - hit=true **且 score >= cfg.ai.semanticThreshold** → processHit(matchedBy=
   *   'semantic'，semanticReason=reason)；threshold=0（默认）时 score>=0 恒真 =
   *   行为不变。其中推送真失败的 reason 会进 semanticVerdicts 缓存（坑⑥，见
   *   pollSource）——缓存的是**已过闸**的 verdict，重试轮直接重推、不再过阈值；
   * - hit=false，或 hit=true 但 score < 阈值 → 入 seen（与字面未命中同待遇，
   *   不再重评；低置信 hit 不推送、不写语义理由/任何记录，只 log 一条观测）；
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
          if (verdict.hit && verdict.score >= cfg.ai.semanticThreshold) {
            await this.processHit(topic, [], cfg, 'semantic', verdict.reason)
          } else {
            // hit=false，或 hit=true 但置信度 < cfg.ai.semanticThreshold（R5-P2b）：
            // 都按不相关处理——入 seen 不再重评、不推送、语义理由不写任何记录。
            // threshold=0（默认）时 score >= 0 恒真 = 行为与阈值特性引入前完全一致。
            if (verdict.hit) {
              this.deps.logger.info(
                `semantic hit below confidence threshold ` +
                  `(${verdict.score} < ${cfg.ai.semanticThreshold}): "${topic.title}"`
              )
            }
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
        baselineChecked: false,
        prevUnseenKeys: new Set(),
        lastPageMaxId: null,
        prevEffectiveNewCount: 0,
        page2Fetches: 0
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
          rt.cooldownUntilMs === null ? null : new Date(rt.cooldownUntilMs).toISOString(),
        // R5-P2a / DEC-8：第 2 页补抓累计（内存；旧快照读者容忍缺失，这里恒下发）
        page2Fetches: rt.page2Fetches
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
   * 只裁本轮**成功抓取过页面**的 source（observedSources，F1 同款）：冷却中
   * 被跳过或抓取失败的 source 本轮没有观测，其键保留到下一轮，避免冷却/故障
   * 窗口内误删仍在首页的帖子状态。
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
   * 处理一条命中的新帖：相似降噪闸 → 生成锐评（第三轮）→ 尝试推送 →
   * 组 HitRecord → 计数入环 → emit onHit。
   *
   * 相似降噪（R5-P2a 第 8 步，作用于**所有**命中方式推送前）：cfg.similarity.enabled
   * 时与"近期已推"窗口比对标题，相似 → 入 seen 不推送不 emit 不计 HitRecord
   * （不是命中），log info + 引擎计数；重试在途的键一并清（推送已无意义）。
   * enabled=false 时整段跳过（行为与升级前一致）。
   *
   * 推送结果语义（ADR 8.10）：
   * - **成功 / 静音**（notifyEnabled=false 或 telegram 未配置）→ 入去重集。
   *   静音是用户主动行为，不重试；
   * - **真实推送失败**（notifier 抛错）→ **不**入去重集，下轮自然重试
   *   （帖子滚出首页第 1 页即止，天然有界）；同键同失败态只 emit/log 一次，
   *   成功或转静音后清除待重试标记并 emit 最终态。
   * 推送失败不中断本轮后续 topic。重试去重键 = 全局键 `${sourceId}:${topicId}`
   * （跨 source 同 id 帖子不互相吞 emit）。
   * matchedBy：literal（字面管线，matchedKeywords 非空）/ semantic（语义管线，
   * matchedKeywords 恒空数组，semanticReason 带 AI 判定理由或 null）/ rule（价格
   * 规则管线，matchedKeywords 恒空数组，matchedRule 带规则 label——id 无 label
   * 时即 id，rules.ts 的 RuleMatch.label 已归一）。
   * commentary：sendHit 之前生成（无论推送是否会被静音——HitRecord/内存环仍要
   * 展示）；恒 string|null，不留 undefined、不写空串（见 maybeGenerateCommentary）。
   * 相似降噪闸在锐评生成**之前**（吞并的帖子不打 LLM、不耗配额）。
   */
  private async processHit(
    topic: Topic,
    matchedKeywords: string[],
    cfg: AppConfig,
    matchedBy: 'literal' | 'semantic' | 'rule' = 'literal',
    semanticReason: string | null = null,
    matchedRule: string | null = null
  ): Promise<void> {
    // 窗口重建就位保障（R5-P2a 第 11 步）：构造期发起的重建在这里被 await——
    // 首轮推送（含相似检查）前窗口必须就位；此后 promise 已 settle，await 零成本。
    // 放在 processHit 而非 pollOnce 顶部：保持 pollOnce 到 fetchLatest 的同步
    // 调用深度（start() 的同步首轮语义，既有契约），基线轮也没有推送可等。
    await this.similarityWindowReady
    // 相似降噪（第 8 步）：与近窗内已推送帖相似 → 入 seen 不推送
    if (cfg.similarity.enabled && this.isSimilarToRecentlyPushed(topic.title, cfg)) {
      const swallowedKey = seenKeyFor(topic.sourceId, topic.id)
      this.deps.seen.add(swallowedKey)
      // 重试在途的键一并收口（相似帖已被更早的推送覆盖，重试无意义）
      this.pendingNotifyErrors.delete(swallowedKey)
      this.semanticVerdicts.delete(swallowedKey)
      this.similarSwallowedCount++
      this.deps.logger.info(`similar topic swallowed: ${topic.title}`)
      return
    }
    const commentary = await this.maybeGenerateCommentary(topic, cfg)
    let notifiedAt: string | null = null
    let notifyError: string | null = null
    const configured = cfg.telegram.botToken !== '' && cfg.telegram.chatId !== ''
    if (cfg.notifyEnabled && configured) {
      try {
        // 第四参 matchedRule：rule 命中传 label（telegram 侧渲染「命中规则」行），
        // 其余命中方式恒传 null（与 commentary 同款"不留 undefined"约定）
        await this.deps.notifier.sendHit(
          topic,
          matchedKeywords,
          commentary,
          matchedBy === 'rule' ? matchedRule : null
        )
        notifiedAt = this.isoNow()
      } catch (err) {
        notifiedAt = null
        notifyError = err instanceof Error ? err.message : String(err)
      }
    }

    const key = seenKeyFor(topic.sourceId, topic.id)

    if (notifyError !== null) {
      // 真实推送失败：不入去重集（下轮重试）；不入相似窗口（第 10 步——窗口语义
      // 是"用户已收到"）；同失败态只 emit/log 一次
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
        matchedRule: matchedBy === 'rule' ? matchedRule : null,
        commentary,
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
    // 成功推送 → 标题（归一化）连同推送时刻入"近期已推"窗口（R5-P2a 第 10 步；
    // 静音/失败不入——用户没收到的不算"已推"）
    if (notifiedAt !== null) {
      this.pushedTitles.push({ title: normalizeTitle(topic.title), at: this.now() })
    }
    const hit: HitRecord = {
      topic,
      matchedKeywords,
      matchedBy,
      semanticReason,
      matchedRule: matchedBy === 'rule' ? matchedRule : null,
      commentary,
      notifiedAt,
      notifyError: null
    }
    this.recordHit(hit)
    if (notifiedAt !== null) {
      if (matchedBy === 'semantic') {
        this.deps.logger.info(
          `hit pushed (semantic): "${topic.title}" (reason: ${semanticReason ?? 'n/a'})`
        )
      } else if (matchedBy === 'rule') {
        this.deps.logger.info(
          `hit pushed (rule): "${topic.title}" (rule: ${matchedRule ?? 'n/a'})`
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

  /**
   * 命中帖锐评（第三轮）：四条件全部满足才真调 generate，否则 commentary=null
   * 且不打 LLM：
   * - deps.commentaryGenerator 已注入（旧装配/测试不注入 = 恒 null，行为不变）；
   * - cfg.ai.commentary.enabled === true（恒存在恒布尔，防御式严格比较）；
   * - provider 齐备（this.aiConfigured，每轮 updateAiConfig 从配置刷新）；
   * - 总配额 callsToday < DAILY_AI_CALL_LIMIT（与语义评估共用桶）；
   * - 子限额 commentaryToday < DAILY_COMMENTARY_LIMIT（超限当日静默降级：
   *   无锐评推送、不 log——100 子限额保证语义评估在总桶至少剩 200，无需调序）。
   * 真调用前后双计数（callsToday++ / commentaryToday++）：generate 内部消化一切
   * 异常，调用即计数无论成败；推送失败重试轮 generate 会被再次调用并计数，但
   * 其内部缓存保证不再打 LLM。generate 绝不抛（模块保证），无需 try/catch。
   */
  private async maybeGenerateCommentary(topic: Topic, cfg: AppConfig): Promise<string | null> {
    const gen = this.deps.commentaryGenerator
    if (gen === undefined) return null
    if (cfg.ai.commentary.enabled !== true) return null
    if (!this.aiConfigured) return null
    this.rollAiDay()
    if (this.aiCallsToday >= DAILY_AI_CALL_LIMIT) return null
    if (this.commentaryToday >= DAILY_COMMENTARY_LIMIT) return null
    this.aiCallsToday++
    this.commentaryToday++
    return await gen.generate(topic)
  }

  // ---- 相似降噪窗口（R5-P2a 第 8/10/11 步） --------------------------------

  /**
   * 标题是否与"近期已推"窗口里的任一条相似（DEC-4）。
   * 窗口条目在入窗时已 normalizeTitle（isSimilarToAny 的契约：recentTitles 须传
   * 已归一化串）；待判标题传原始串，函数内部自行归一。窗口为空恒 false。
   * 检查时跳过已超出 48h 的条目——轮末 prune 之外的时刻（如长睡眠恢复后的
   * 首轮）窗口里可能还留着过期条目，48h 契约以**判定时点**为准（过期放行）。
   */
  private isSimilarToRecentlyPushed(title: string, cfg: AppConfig): boolean {
    if (this.pushedTitles.length === 0) return false
    const cutoff = this.now() - SIMILARITY_WINDOW_MS
    const inWindow = this.pushedTitles.filter((e) => e.at >= cutoff)
    if (inWindow.length === 0) return false
    return isSimilarToAny(
      title,
      inWindow.map((e) => e.title),
      cfg.similarity.threshold
    )
  }

  /**
   * 轮末窗口 prune：只保留仍在 48h 窗口内的条目（保序过滤）。数组整体按 at
   * 旧→新（入窗序即时间序，重建条目也按 notifiedAt 旧→新追加），但重建 promise
   * 晚于首轮推送 settle 的竞态下可能出现乱序尾巴——用过滤而非头部截断，任何
   * 位置的过期条目都能被清掉。时间维度全局裁剪，与 per-source 的
   * roundTopicKeys 无关。
   */
  private pruneSimilarityWindow(): void {
    if (this.pushedTitles.length === 0) return
    const cutoff = this.now() - SIMILARITY_WINDOW_MS
    const kept = this.pushedTitles.filter((e) => e.at >= cutoff)
    if (kept.length !== this.pushedTitles.length) {
      this.pushedTitles.splice(0, this.pushedTitles.length, ...kept)
    }
  }

  /**
   * 启动重建窗口（第 11 步）：从 hits 存储读近 3 天记录，notifiedAt 非空（= 成功
   * 推送过）且仍在 48h 窗口内的标题（归一化、at=notifiedAt 时刻）回填内存窗口。
   * 3 天读取是数据面（48h 跨本地日最多涉 3 个日桶），48h 过滤是窗口不变式——
   * 超龄记录不进窗。deps 未注入 hitsStore / readRecent（旧装配、测试）或读取
   * 失败：空窗开始（等于全新安装），只 log，绝不抛（构造期调用）。
   */
  private async rebuildSimilarityWindow(): Promise<void> {
    const store = this.deps.hitsStore
    if (store === undefined || store.readRecent === undefined) return
    try {
      const recent = await store.readRecent(SIMILARITY_REBUILD_DAYS, new Date(this.now()))
      const nowMs = this.now()
      for (const hit of recent) {
        if (hit.notifiedAt === null) continue // 只重建成功推送（失败/静音从不入窗）
        const at = Date.parse(hit.notifiedAt)
        if (!Number.isFinite(at)) continue // 防御：坏时间戳跳过
        if (nowMs - at >= SIMILARITY_WINDOW_MS) continue // 48h 不变式
        this.pushedTitles.push({ title: normalizeTitle(hit.topic.title), at })
      }
      if (this.pushedTitles.length > 0) {
        this.deps.logger.info(
          `similarity window rebuilt from recent hits (${this.pushedTitles.length} title(s))`
        )
      }
    } catch (err) {
      this.deps.logger.warn(`similarity window rebuild failed: ${describeError(err)}`)
    }
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

  /**
   * 持久化某 source 的引擎状态；落盘失败只记日志不抛、不改本轮健康判定（下一轮
   * 再试）。@returns 是否落盘成功（F3：调用方可据此对"失败会改变下轮行为"的
   * 写入——基线/升级初始化轮的 id 阈值——补一条更具体的 error 可观测）。
   */
  private persistState(sourceId: string, patch: Partial<SourceEngineState>): boolean {
    try {
      this.deps.state.setFor(sourceId, patch)
      return true
    } catch (err) {
      this.deps.logger.error(
        `persist engine state failed (source ${sourceId}): ${describeError(err)}`
      )
      return false
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
