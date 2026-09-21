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
 * - callsToday 本地自然日滚动（formatLocalDate 判日）；**纯观测计数，不设每日
 *   上限**（调用频率自然受轮询间隔与每批 cap 12 约束，超量风险由 API 侧
 *   计费/限流兜底）。
 * - evaluate 抛错（含 AiProviderError）→ 该批全部未决（不入 seen）、记
 *   lastAiError、**不动 consecutiveFailures**（AI 故障 ≠ 抓取故障，D4）。
 * - interests 为空 → 引擎侧直接跳过 AI 批（不调 evaluator、不计 callsToday，
 *   F3）：语义帖全部按未命中入 seen（与 evaluator 快速全 miss 的现状一致），
 *   不算 unconfigured。
 * - verdict 缓存（D4 坑⑥，F2）：语义命中但推送失败的帖 reason 存内存 Map
 *   （semanticVerdicts），下轮**不重进 AI 批**、按已判 hit 直接重试推送；
 *   推送成功/转静音后清除；帖子滚出首页即随轮末清理回收（F5）。
 * - 锐评（第三轮）：processHit 内 sendHit 之前按三条件生成（开关开 / provider
 *   已配置），任一不满足 → commentary=null 不打 LLM；真调
 *   generate 即双计数（callsToday 与 commentaryToday 各 +1，成败都计——
 *   generate 内部消化异常）。锐评与语义评估共享 300 总桶、无独立子限额
 *   （先到先得；commentaryToday 仅作观测计数）。
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
 * - per-source 匹配覆盖（R13）：pollSource 经 matching.ts 的
 *   resolveSourceMatching(cfg, sourceId) 解析生效值（include/exclude/
 *   matchMode/interests/threshold 五字段，未覆盖回退全局），替换全部六个
 *   消费点（语义档门控 / 排除词 / 字面匹配 / 语义批的 interests·阈值闸·
 *   处置流水 detail）。**价格规则与 AI 锐评不参与覆盖（恒用全局配置）**。
 *   R13-2 追加第六字段 matchAll（来源级全匹配，仅 per-source 可开）：开启时
 *   过闸新帖直接命中（matchedBy='matchall'），literal/语义档整体跳过，
 *   见 pollSource 第 6.5 步注释。
 *   注意与 getSourceFilters 的 accessor 先例形态不同——有意不新增
 *   getSourceMatching accessor：cfg 每轮 pollOnce 重读已是热更新语义，且全部
 *   同类匹配输入本就从 cfg 读，accessor 只增装配面（runtime/headless/test
 *   三处）无行为收益；filters 的既有 accessor 保留不动，后来者勿"统一"。
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
 * 免打扰 + 摘要模式（R6-W1q，DEC-11 挂起语义；纯时间逻辑在 notify/queue.ts）：
 * - processHit 推送前（相似闸之后、仅 notifyEnabled 且有就绪通道的推送分支内）
 *   decideNotifyAction 判定 defer（免打扰窗内 / digest 模式恒挂起）→ 帖子进
 *   内存挂起队列 deferredHits（坑6：**不入 seen、不 recordHit、不入相似窗**——
 *   否则 flush 前下轮会被当旧帖吞掉 / hits 每轮重复追加）；payload 自含全量
 *   （含 match 时已生成的锐评，flush 不重打 LLM）。
 * - unseen 处理链开头查挂起集：已在队列的帖整帖跳过（不重新匹配/不重评估/不入
 *   seen），等 flush 收口——否则免打扰结束的那轮会绕过队列直接即时推送，与
 *   flush 双发。
 * - flush 只随轮询 piggyback（pollOnce 开头检查 due）：暂停期间无轮询 → 无
 *   flush，恢复后首轮补发。digest 批窗口锚点 lastDigestFlushAt（批首条挂起
 *   时刻或上次冲刷时刻），due = 锚点 + digestIntervalMin 到点；instant 模式的
 *   挂起条目在 decideNotifyAction 不再 defer（窗结束/quiet 热更新关掉）时冲刷。
 * - flush 逐条推送：成功 = seen.add + recordHit(notifiedAt=now) + 相似窗入窗
 *   （对齐即时路径成功后的三个动作）；失败重试，3 次后落 notifyError 终态 +
 *   seen.add（防重新匹配死循环）；冲刷时刻已静音 → 按静音终态出队（静音不重试）。
 * - 挂起超 24h → recordHit(notifyError='deferred timeout') + seen.add + 出队
 *   （有界内存；挂点对齐 pruneRetryMaps）。
 * - 队列是内存态：重启丢队列是接受的语义——未入 seen 的挂起帖若仍在第 1 页，
 *   重启后会被重新匹配（窗内重新入队 / 窗外直接即时推送），自愈且不双发。
 *
 * 全局聚合（每轮收尾 finishRound 派生，既有消费方——托盘/UI——不破）：
 * health = 各 source 最差（challenged > backoff > ok；无 source → ok）；
 * consecutiveFailures 取最差、lastError 取最新、lastSuccessAt 取最新；
 * EngineStatus.sources 填 per-source 快照。scheduler 间隔恒为配置值——退避
 * 只作用于冷却中的 source 本身（pollOnce 轮内跳过，冷却结束后的下一个 tick
 * 重试），不拖慢其他健康 source（D3 原全局抬高行为已按此修正）。
 *
 * 处置流水（R7-W1"为什么没推送"观测面，可选 deps.dispositions——不注入 = 零行为）：
 * unseen 处理链每个分支出口与挂起 flush 收口都向 store 上报一条 Disposition
 * （出口→outcome 映射见 noteDisposition 各调用点）；去重语义（同帖同 outcome 不
 * 重记、迁移才记）与 pipeline/ JSONL 持久化在 dispositions.ts。store 的键清理与
 * pruneRetryMaps 同调用点、同 observedSources 守卫（见 pollOnce）。
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
import { resolveSourceMatching } from './matching'
import { evaluateRules } from './rules'
import { findSimilarTo, normalizeTitle, type SimilarityMatch } from './similarity'
import type { DispositionOutcome } from './dispositions'
import { computeBackoffMs, type PollScheduler } from './poller'
import type { FileSeenStore } from './dedup'
import { formatLocalDate } from './hits-store'
import type { FileEngineState, SourceEngineState } from './state'
import { ChallengeError, type SourceAdapter } from './types'
import type { SemanticEvaluator } from '../ai/evaluator'
import { MAX_SEMANTIC_BATCH } from '../ai/evaluator'
import type { CommentGenerator } from '../ai/commentary'
import type { Notifier } from '../notify/types'
import type { HitMessageInput } from '../notify/types'
import { anyChannelReady } from '../notify/types'
import { decideNotifyAction, nextDigestFlush } from '../notify/queue'
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
 * 挂起推送的最长滞留（R6-W1q / DEC-11）：24h。超时条目按
 * notifyError='deferred timeout' 落终态（recordHit + seen.add + 出队）——
 * 有界内存保证（挂起队列是内存态，不靠 roundTopicKeys 裁剪：挂起帖滚出
 * 首页后仍应等到 flush / 超时，不能像重试缓存那样被清理）。
 */
export const DEFERRED_HIT_TIMEOUT_MS = 24 * 60 * 60 * 1000

/** 挂起条目 flush 推送失败的重试上限（DEC-11：第 3 次失败落 notifyError 终态） */
export const DEFERRED_FLUSH_MAX_ATTEMPTS = 3

/**
 * 语义评估退避曲线（R13-3）：第 n 次连续失败冷却 BASE × 2^(n-1)，
 * 封顶 CAP（30s → 1m → 2m → 4m → 8m → 10m…）；任一批评估成功即全部复位。
 * 冷却期内 evaluateSemantic 零调用（新帖累积为未决，冷却结束随下一轮批量重评）。
 */
export const SEMANTIC_BACKOFF_BASE_MS = 30_000
export const SEMANTIC_BACKOFF_CAP_MS = 600_000
/**
 * 未决帖重评轮次上限（R13-3）：同一帖连续 SEMANTIC_MAX_UNDECIDED_ROUNDS 轮
 * 拿不到裁决（评估失败/回包缺项/冷却期跳过都计一轮），第 N 轮起降级字面判定
 * 收口——命中即推（matchedBy='literal'）、未中入 seen，防无限重评与静默丢失。
 */
export const SEMANTIC_MAX_UNDECIDED_ROUNDS = 5

/**
 * 挂起队列条目（DEC-11）：payload 自含 flush 所需全量信息——topic/关键词/
 * 规则/语义理由/锐评（锐评在 match 时已生成，flush 直接用不再重打 LLM）。
 */
interface DeferredHit {
  payload: HitMessageInput & { matchedBy: 'literal' | 'semantic' | 'rule' | 'matchall' }
  /** 首次挂起时刻（epoch ms；24h 超时 prune 的基准，重试不刷新） */
  addedAt: number
  /** flush 推送失败计数；达 DEFERRED_FLUSH_MAX_ATTEMPTS 落终态出队 */
  attempts: number
}

/** DeferredHit → HitRecord（flush 的成功/失败/超时三态收口共用一个组装口径） */
function deferredHitRecord(
  entry: DeferredHit,
  notifiedAt: string | null,
  notifyError: string | null,
  notifyDetail?: Record<string, { ok: boolean; error?: string }>
): HitRecord {
  const p = entry.payload
  return {
    topic: p.topic,
    matchedKeywords: p.matchedKeywords,
    matchedBy: p.matchedBy,
    semanticReason: p.semanticReason ?? null,
    matchedRule: p.matchedBy === 'rule' ? (p.matchedRule ?? null) : null,
    commentary: p.commentary ?? null,
    notifiedAt,
    notifyError,
    ...(notifyDetail !== undefined && Object.keys(notifyDetail).length > 0 ? { notifyDetail } : {})
  }
}

/**
 * per-channel 推送明细收集器（R6-W4，processHit 即时路径与 flushDeferred 共用）：
 * `report` 挂进 HitMessageInput，各通道 sendHit 最终结果落定后自报（composite
 * 原样透传 input 不重复调用）；detail 按上报顺序累积（= composite 串行扇出序）。
 * 至少一条记录时 HitRecord 才落 notifyDetail 键（静音路径不调 sendHit → 无键）。
 */
interface NotifyDetailCollector {
  /** 挂进 HitMessageInput.report 的回调（约定不抛，通道实现保证） */
  report: (channelId: string, ok: boolean, error?: string) => void
  /** 已收集的明细（实时读；sendHit settle 后不再变） */
  readonly detail: Record<string, { ok: boolean; error?: string }>
  /** 首个失败通道的错误（失败路径聚合 notifyError 的取值优先级）；无失败 → undefined */
  firstError(): string | undefined
}

function createNotifyDetailCollector(): NotifyDetailCollector {
  const detail: Record<string, { ok: boolean; error?: string }> = {}
  return {
    report: (channelId, ok, error) => {
      detail[channelId] = ok ? { ok } : { ok, error: error ?? 'unknown channel error' }
    },
    detail,
    firstError: () => {
      for (const v of Object.values(detail)) {
        if (!v.ok) return v.error ?? 'unknown channel error'
      }
      return undefined
    }
  }
}

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
   * 推送器（R6-W1 起为 Notifier 接口——通道无关抽象，本轮实现只有
   * TelegramNotifier；W3 router/composite 在引擎外侧扇出，engine 不感知通道数）。
   * sendHit 收 HitMessageInput 单参对象（topic/matchedKeywords/commentary/
   * matchedRule/matchedRuleId/semanticReason——后三者的规则/语义字段仅对应命中
   * 方式非 null，与 commentary 同款"不留 undefined"约定）。单测可全 mock。
   */
  notifier: Notifier
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
  /**
   * 处置流水（R7-W1"为什么没推送"观测面；可选——不注入 = 零行为，引擎逻辑
   * 逐字节不变）。record 在 unseen 处理链每个分支出口与挂起 flush 收口处调用
   * （去重/迁移判定由 DispositionStore 负责，engine 只上报）；prune 与
   * pruneRetryMaps 同调用点、同 roundTopicKeys/observedSources 守卫——帖子滚出
   * 首页后清掉其 lastOutcome 键，防重启后同 id 新帖首条处置被误判重复。
   */
  dispositions?: {
    record(
      sourceId: string,
      topicId: string,
      title: string,
      outcome: DispositionOutcome,
      detail?: string
    ): void
    prune?(keepKeys: Set<string>, observedSources: Set<string>): void
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
   * 下轮该帖仍在首页时不重进 AI 批（不多打调用、不冒改变判定风险，也**不再过
   * 阈值**——过闸是既成事实），直接按已判 hit 走 processHit 重试；推送成功/
   * 转静音清除；帖子滚出首页随轮末清理回收（pruneRetryMaps，F5）。与
   * pendingNotifyErrors 是两套机制：后者是全部命中共用的「失败原因去重 emit」
   * 表，前者只服务语义档的 verdict 复用。缓存值只存 reason：重试路径不读
   * score（不再过闸），无需保存。
   */
  private readonly semanticVerdicts = new Map<string, { reason: string | null }>()
  /**
   * 免打扰/digest 挂起队列（R6-W1q，DEC-11）：全局去重键 → DeferredHit。
   * 挂起帖**不入 seen**（坑6：入了会被下轮当旧帖/已处理吞掉）、不 recordHit
   * （flush 前不产生 HitRecord，否则每轮重复追加）、不入相似窗（没推过不算
   * "已推"）。unseen 处理链开头按本队列跳过（等 flush 收口）。插入序 = Map
   * 迭代序 = flush 顺序。内存态：重启丢队列，自愈语义见类注释。
   */
  private readonly deferredHits = new Map<string, DeferredHit>()
  /**
   * digest 批窗口锚点（epoch ms）：上一批的冲刷时刻，或空队列重启批时的首条
   * 挂起时刻。due = now >= nextDigestFlush(锚点, interval)（notify/queue.ts 纯
   * 计算）。null = 尚未开过批窗口。instant 模式不使用（免打扰挂起靠窗尾判定）。
   */
  private lastDigestFlushAt: number | null = null
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
   * 纯观测计数：与 aiCallsToday 共用 300 总桶、无独立子限额（先到先得）；
   * 每次真调 generate 时与 aiCallsToday 同时 +1。
   */
  private commentaryToday = 0
  private aiCallsDay = ''
  /** 最近一次评估错误消息（provider 已脱敏）；评估成功后清空 */
  private aiLastError: string | null = null
  /**
   * 语义评估连续失败数（R13-3）：驱动指数退避——第 n 次连续失败冷却
   * SEMANTIC_BACKOFF_BASE_MS × 2^(n-1)（封顶 CAP）；任一批成功即清零。
   * 防上游限流/故障时的重试风暴：冷却期 evaluateSemantic 不发任何请求。
   */
  private aiConsecutiveFailures = 0
  /** 语义评估退避冷却截止时刻（epoch ms；null = 无冷却） */
  private aiCooldownUntilMs: number | null = null
  /**
   * 未决帖重评轮次计数（R13-3）：键 = seen 键，值 = 已连续未决轮数。
   * 达 SEMANTIC_MAX_UNDECIDED_ROUNDS 后降级字面判定收口（防未决帖无限
   * 重评与滚出首页静默丢失）；裁决落定（hit/miss）即删键；轮末随
   * pruneRetryMaps 同款键集清理。
   */
  private semanticUndecidedRounds = new Map<string, number>()
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
    return {
      ...INITIAL_ENGINE_STATUS,
      ...this.status,
      // R6-W4：挂起待推送条数随快照下发（免打扰/digest 可观测性；旧读者容忍缺失）
      pendingNotifyCount: this.deferredHits.size,
      ai: this.deriveAiStatus()
    }
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

    // 挂起队列冲刷检查（R6-W1q，DEC-11）：piggyback 语义——只随轮询触发，无独立
    // 定时器；暂停（pause）期间无轮询 → 无 flush，恢复后的首轮 pollOnce 在这里
    // 补发。getConfig 抛错的早退轮不冲刷（拿不到 notify 策略，宁可多等一轮）。
    // **队列空时不得 await**：保持 pollOnce 到 fetchLatest 的同步调用深度
    // （start() 的同步首轮语义，既有契约——见 similarityWindowReady 注释）；
    // 有挂起条目才让出微任务。
    if (this.deferredHits.size > 0) await this.flushDeferredIfDue(cfg)

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
    // 处置流水键清理（R7-W1）：与 pruneRetryMaps 同调用点、同守卫——已滚出首页
    // 的帖子其 lastOutcome 不会再变化，清掉防重启后同 id 新帖首条处置被误判重复
    this.deps.dispositions?.prune?.(roundTopicKeys, observedSources)
    // 挂起队列 24h 超时收口（R6-W1q）：时间维度的有界内存保证，不依赖
    // roundTopicKeys/observedSources——超时就是超时，与帖子是否还在首页无关。
    this.pruneDeferredHits()
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
   * trim 后）均非空；mode = cfg.ai.matchMode。计数日翻转也在此检查。
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
    }
  }

  /**
   * 派生 AiRuntimeStatus（getStatus / pollSource 共用同一口径）：
   * - 未配置 provider → degraded='unconfigured'，effectiveMode='literal'（不管
   *   cfg mode 是什么——语义档整体降级，不算失败）；
   * - 其余 → effectiveMode=cfg mode，degraded='none'。无每日配额语义（不设上限）。
   * interests 为空不算 unconfigured（evaluator 会全量判 miss，不调 API）。
   */
  private deriveAiStatus(): AiRuntimeStatus {
    const base = {
      configured: this.aiConfigured,
      callsToday: this.aiCallsToday,
      commentaryToday: this.commentaryToday,
      lastAiError: this.aiLastError,
      semanticCooldownUntil:
        this.aiCooldownUntilMs !== null ? new Date(this.aiCooldownUntilMs).toISOString() : null
    }
    if (!this.aiConfigured) {
      return { ...base, effectiveMode: 'literal', degraded: 'unconfigured' }
    }
    // R13-3：退避冷却进行中 → degraded='backoff'（冷却期零调用，新帖累积未决）
    if (this.aiCooldownUntilMs !== null && this.now() < this.aiCooldownUntilMs) {
      return { ...base, effectiveMode: this.aiMode, degraded: 'backoff' }
    }
    return { ...base, effectiveMode: this.aiMode, degraded: 'none' }
  }

  /**
   * 轮询单个 source 的完整管线（unseen 处理链的最终顺序，ultrabrain 裁定）：
   * 盖章（1）→ per-source 过滤（2，R5-P2a：滤帖入 seen 不推送不评估）→
   * 基线判断（W3：基线轮末同轮初始化 id 阈值）→ 存量升级静默初始化轮
   * （W3：baselineDone=true 但阈值 null 时整页入 seen 不推送）→ 新帖逆序处理
   * （挂起队列成员整帖跳过(0，R6-W1q DEC-11：已在 deferredHits 的帖等 flush，
   * 不重新匹配) → 旧帖 id 过滤(3) → 置顶(4) → 排除词否决(5) → 价格规则(6，
   * R5-P2a：先于 literal、命中即得) → literal(7) → 语义候选收集(9)）→
   * 命中帖推送前统一过相似降噪闸（8，R5-P2a：与 48h 已推窗口相似 → 入 seen
   * 不推）→ 语义批评估 → 轮末 flush/prune/prevUnseenKeys 轮换/阈值推进与
   * totalHits 合并持久化。
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
    // per-source 匹配覆盖（R13）：五字段生效值（未覆盖回退全局）。直读 cfg.sources
    // 而非新增 deps accessor——cfg 每轮 pollOnce 重读已是热更新语义，且全部同类
    // 匹配输入本就从 cfg 读；差异说明见类头 R13 段（勿与 getSourceFilters 统一）。
    const m = resolveSourceMatching(cfg, adapter.id)
    // 门控按 per-source 生效模式派生（镜像 deriveAiStatus 的降级口径：Provider 未
    // 配置时语义档整体降级字面，this.aiConfigured 每轮 updateAiConfig 从配置刷新）。
    // 全局 AiRuntimeStatus.effectiveMode 观测面不动（仍是全局口径——per-source
    // 覆盖后托盘/UI 显示的模式可能与该来源实际门控不符，见 usage.md 口径差提示）。
    const effectiveMode: MatchMode = this.aiConfigured ? m.matchMode : 'literal'
    const literalActive = effectiveMode === 'literal' || effectiveMode === 'both'
    const semanticActive =
      (effectiveMode === 'semantic' || effectiveMode === 'both') &&
      this.deps.semanticEvaluator !== undefined
    /** 语义候选（页面顺序旧→新）：遍历后按批评估 */
    const aiPending: Topic[] = []
    // per-source 过滤配置（R5-P2a 第 2 步）：访问器每轮重读（配置热更新语义），
    // 未注入/undefined = 不过滤
    const sourceFilters = this.deps.getSourceFilters?.(adapter.id)

    // 页面最新在前 → 逆序处理，推送顺序旧→新
    for (const topic of [...unseen].reverse()) {
      const key = seenKeyFor(adapter.id, topic.id)
      // 挂起队列成员检查（R6-W1q，DEC-11 坑6）：已在挂起队列的帖**整帖跳过**——
      // 不重新匹配/不重评估/不入 seen（它已在队列里等 flush 收口）。插点在 unseen
      // 循环最顶部（先于 per-source 过滤/id 阈值/置顶/排除词），与 semanticVerdicts
      // 缓存查询同款"命中前拦截"模式但覆盖**全部**命中方式：literal/rule 命中的
      // 挂起帖若重新走匹配，免打扰结束的那轮会绕过队列直接即时推送——与 flush
      // 双发。prevUnseenKeys 豁免集对挂起键同样生效（它们在本轮 unseen 集里），
      // 但队列成员资格本身就是更强的豁免，双保险。
      if (this.deferredHits.has(key)) {
        this.noteDisposition(topic, 'deferred-skip')
        continue
      }
      // per-source 过滤（R5-P2a 第 2 步，先于 id 阈值——ultrabrain 裁定管线顺序）：
      // 分类白/黑名单（显示名或 slug 双口径）与作者黑名单。被滤帖入 seen 不推送
      // 不评估（与旧帖阈值同款语义）。
      if (sourceFilters !== undefined && !applySourceFilters(topic, sourceFilters)) {
        this.deps.seen.add(key)
        swallowedByFilters++
        this.noteDisposition(
          topic,
          'filtered',
          `分类「${topic.category || '—'}」/ 作者「${topic.author || '—'}」`
        )
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
          this.noteDisposition(topic, 'old-below-threshold', `id ${numericId} ≤ 阈值 ${threshold}`)
          continue
        }
      }
      if (topic.pinned) {
        // 置顶是旧帖（第 4 步）：入去重集但绝不推送
        this.deps.seen.add(key)
        this.noteDisposition(topic, 'pinned')
        continue
      }
      // 排除词字面一票否决（第 5 步，D4：永远先于 AI；语义模式下同样否决）。
      // R13：用 per-source 生效排除词（未覆盖 = 全局列表）
      if (isExcluded(topic, m.excludeKeywords)) {
        this.deps.seen.add(key)
        const excludedWord = findExcludedWord(topic, m.excludeKeywords)
        this.noteDisposition(
          topic,
          'excluded',
          excludedWord !== undefined ? `命中排除词「${excludedWord}」` : undefined
        )
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
          await this.processHit(
            topic,
            [],
            cfg,
            'rule',
            null,
            ruleMatch.label,
            ruleMatch.ruleId
          )
          continue
        }
      }
      // 来源级全匹配（R13-2 第 6.5 步，价格规则之后）：matchAll 覆盖开启时
      // 过闸新帖直接命中（matchedBy='matchall'），literal/语义档整体跳过——
      // 规则放前面保留 'rule' 归因（同一帖只记一种命中方式，规则优先）。
      // matchMode/includeKeywords/interests/semanticThreshold 覆盖对本帖全部
      // 不参与；四道闸与相似降噪（processHit 内）照常否决——全匹配 ≠ 全推送。
      if (m.matchAll) {
        await this.processHit(topic, [], cfg, 'matchall')
        continue
      }
      // literal 档（第 7 步；mode 含 literal 时生效；语义档未配置也降到这里）。
      // R13：包含/排除词都用 per-source 生效值（未覆盖 = 全局列表）
      if (literalActive) {
        const { matched, matchedKeywords } = matchTopic(
          topic,
          m.includeKeywords,
          m.excludeKeywords
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
      this.noteDisposition(topic, 'miss')
      this.deps.seen.add(key)
    }

    if (aiPending.length > 0) {
      await this.evaluateSemantic(
        adapter.id,
        aiPending,
        cfg,
        m.interests,
        m.semanticThreshold,
        m.includeKeywords
      )
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
   * R13：interests / semanticThreshold 改由调用方传 per-source 生效值
   * （pollSource 经 resolveSourceMatching 解析；未覆盖 = 全局 ai 段的值），
   * 本方法不再读 cfg.ai 的这两段——同一轮不同 source 可用不同兴趣与阈值；
   * cfg 本身仍透传给 processHit（相似降噪/挂起/推送等全局策略）。
   * verdict 三态（R5-P2b：hit 的去留多一道置信度闸）：
   * - hit=true **且 score >= semanticThreshold** → processHit(matchedBy=
   *   'semantic'，semanticReason=reason)；threshold=0（默认）时 score>=0 恒真 =
   *   行为不变。其中推送真失败的 reason 会进 semanticVerdicts 缓存（坑⑥，见
   *   pollSource）——缓存的是**已过闸**的 verdict，重试轮直接重推、不再过阈值；
   * - hit=false，或 hit=true 但 score < 阈值 → 入 seen（与字面未命中同待遇，
   *   不再重评；低置信 hit 不推送、不写语义理由/任何记录，只 log 一条观测）；
   * - 无 verdict（未决）→ 不入 seen，下轮重评（帖子滚出首页即止，对齐 8.10）。
   *   R13-3：未决轮次计数 +1，连续 SEMANTIC_MAX_UNDECIDED_ROUNDS 轮未决则
   *   降级字面判定收口（见 settleUndecided）——不再无限重评、不再静默滚丢。
   * evaluate 整体抛错 → 该批全部未决 + 记 lastAiError + **指数退避**（R13-3：
   * 连续失败翻倍冷却至封顶，冷却期零调用防重试风暴）+ log warn，
   * **不动 consecutiveFailures**（AI 故障 ≠ 抓取故障）。每次真实调用计入
   * callsToday（含失败的调用；纯观测计数，无每日上限）。
   * includeKeywords 为该来源生效包含词（R13-3 新增入参）：未决超限降级字面
   * 判定的输入（排除词已在 pollSource 四道闸过掉，这里不重复）。
   */
  private async evaluateSemantic(
    sourceId: string,
    topics: Topic[],
    cfg: AppConfig,
    interests: string[],
    semanticThreshold: number,
    includeKeywords: string[]
  ): Promise<void> {
    const evaluator = this.deps.semanticEvaluator
    if (evaluator === undefined) return
    if (interests.length === 0) {
      // F3：空兴趣 = 语义档永不命中（镜像字面档防风暴规则）——不入 AI 批
      for (const topic of topics) {
        this.deps.seen.add(seenKeyFor(sourceId, topic.id))
        this.noteDisposition(topic, 'semantic-miss', '兴趣描述为空：语义档永不命中')
      }
      return
    }
    // R13-3 退避冷却：上游连续失败后的指数冷却期内**零调用**——直接按未决
    // 挂起（轮次照常累计，超限走降级收口），冷却结束随下一轮批量重评。
    if (this.aiCooldownUntilMs !== null && this.now() < this.aiCooldownUntilMs) {
      for (const topic of topics) {
        await this.settleUndecided(sourceId, topic, cfg, includeKeywords, 'AI 评估退避中（上游连续失败，本轮不调用）')
      }
      return
    }
    for (let i = 0; i < topics.length; i += MAX_SEMANTIC_BATCH) {
      const batch = topics.slice(i, i + MAX_SEMANTIC_BATCH)
      this.rollAiDay()
      this.aiCallsToday++
      try {
        const verdicts = await evaluator.evaluate(batch, interests)
        this.aiLastError = null // 评估成功：清掉历史错误（恢复观测）
        // R13-3：成功即复位退避（连续失败计数与冷却一并清零）
        this.aiConsecutiveFailures = 0
        this.aiCooldownUntilMs = null
        for (const topic of batch) {
          const verdict = verdicts.get(seenKeyFor(sourceId, topic.id))
          if (verdict === undefined) {
            // 未决：不入 seen，下轮重评（R13-3：轮次计数 + 超限降级收口）
            await this.settleUndecided(sourceId, topic, cfg, includeKeywords, 'AI 未给出该帖裁决（未决）')
            continue
          }
          this.semanticUndecidedRounds.delete(seenKeyFor(sourceId, topic.id)) // 裁决落定：清轮次
          if (verdict.hit && verdict.score >= semanticThreshold) {
            await this.processHit(topic, [], cfg, 'semantic', verdict.reason)
          } else {
            // hit=false，或 hit=true 但置信度 < semanticThreshold（R5-P2b）：
            // 都按不相关处理——入 seen 不再重评、不推送、语义理由不写任何记录。
            // threshold=0（默认）时 score >= 0 恒真 = 行为与阈值特性引入前完全一致。
            if (verdict.hit) {
              this.deps.logger.info(
                `semantic hit below confidence threshold ` +
                  `(${verdict.score} < ${semanticThreshold}): "${topic.title}"`
              )
              this.noteDisposition(
                topic,
                'semantic-below-threshold',
                `置信度 ${verdict.score} < 阈值 ${semanticThreshold}`
              )
            } else {
              this.noteDisposition(
                topic,
                'semantic-miss',
                verdict.reason !== null ? `AI 判定不相关：${verdict.reason}` : 'AI 判定不相关'
              )
            }
            this.deps.seen.add(seenKeyFor(sourceId, topic.id))
          }
        }
      } catch (err) {
        this.aiLastError = describeError(err)
        // R13-3 指数退避：连续失败翻倍冷却至封顶（指数封 2^10 防溢出），
        // 冷却期内不再打上游——把"失败→下轮全量重发→更失败"的风暴断掉。
        this.aiConsecutiveFailures += 1
        const backoffMs = Math.min(
          SEMANTIC_BACKOFF_BASE_MS * 2 ** Math.min(this.aiConsecutiveFailures - 1, 10),
          SEMANTIC_BACKOFF_CAP_MS
        )
        this.aiCooldownUntilMs = this.now() + backoffMs
        for (const topic of batch) {
          await this.settleUndecided(sourceId, topic, cfg, includeKeywords, 'AI 评估失败，进入退避冷却')
        }
        this.deps.logger.warn(
          `semantic evaluation failed (${batch.length} topics undecided, ` +
            `backoff ${Math.round(backoffMs / 1000)}s until ` +
            `${new Date(this.aiCooldownUntilMs).toISOString()}): ${this.aiLastError}`
        )
      }
    }
  }

  /**
   * 未决帖的轮次收口（R13-3）：轮次 +1 后若仍 < SEMANTIC_MAX_UNDECIDED_ROUNDS，
   * 记 pending 处置等下一轮重评；达到上限则**降级字面判定**收口——用该来源的
   * 生效包含词做一次字面匹配（镜像 Provider 未配置的整体降级语义），命中即推
   * （matchedBy='literal'）、未中入 seen 记 giveup 处置。防的是：上游长时间
   * 故障/限流下，未决帖要么无限重评烧调用、要么滚出首页被静默丢弃。
   */
  private async settleUndecided(
    sourceId: string,
    topic: Topic,
    cfg: AppConfig,
    includeKeywords: string[],
    pendingDetail: string
  ): Promise<void> {
    const key = seenKeyFor(sourceId, topic.id)
    const rounds = (this.semanticUndecidedRounds.get(key) ?? 0) + 1
    if (rounds < SEMANTIC_MAX_UNDECIDED_ROUNDS) {
      this.semanticUndecidedRounds.set(key, rounds)
      this.noteDisposition(topic, 'semantic-pending', pendingDetail)
      return
    }
    this.semanticUndecidedRounds.delete(key)
    const { matched, matchedKeywords } = matchTopic(topic, includeKeywords, [])
    if (matched) {
      await this.processHit(topic, matchedKeywords, cfg) // matchedBy='literal'
      return
    }
    this.deps.seen.add(key)
    this.noteDisposition(
      topic,
      'semantic-miss',
      `AI 连续 ${rounds} 轮未决，降级字面判定：未命中（防重试风暴/静默丢失）`
    )
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
   * 由 pollOnce 轮内跳过生效——全局 scheduler 间隔恒为配置值，不受单 source 退避影响）。
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
   * 只聚合 activeIds 内的 source——热更新移除的 source 不再影响聚合
   * （否则残留冷却会让状态里挂着已下线的 source）。孤儿失败（无任何 source
   * 且配置层报错）在聚合层兜底呈现。
   * scheduler 间隔恒为配置值：退避不抬高全局节奏，只通过 per-source
   * cooldownUntil 让 pollOnce 轮内跳过该 source（冷却结束后的下一个 tick 重试），
   * 一个 source 被拦/故障不会拖慢其他健康 source 的轮询。
   */
  private finishRound(baseIntervalSec: number, activeIds: string[]): void {
    const sources: SourceStatus[] = []
    let health: HealthState = 'ok'
    let consecutiveFailures = 0
    let lastError: string | null = null
    let lastErrorAtMs = -1
    let lastSuccessAt: string | null = null

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
    this.deps.scheduler.setIntervalSec(baseIntervalSec)
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
    if (this.semanticUndecidedRounds.size > 0) {
      for (const key of [...this.semanticUndecidedRounds.keys()]) {
        if (!roundTopicKeys.has(key) && observedSources.has(sourceIdOfKey(key))) {
          this.semanticUndecidedRounds.delete(key)
        }
      }
    }
  }

  // ---- 免打扰/digest 挂起队列（R6-W1q，DEC-11） -----------------------------

  /**
   * 挂起队列到点冲刷检查（每轮 pollOnce 开头调用；piggyback 语义见调用点注释）。
   * due 判定按**当前**配置（热更新语义）：
   * - digest 模式：now >= nextDigestFlush(lastDigestFlushAt, interval)（批窗口
   *   计时器；锚点 null 视为 due——防御，正常路径首条挂起时已起锚，不给队列
   *   被无锚点卡死留门）；
   * - instant 模式（免打扰挂起的条目）：decideNotifyAction 不再 defer——窗已
   *   结束，或 quietHours 被热更新关掉——即 due；
   * - 已静音（notifyEnabled=false / 无就绪通道）：恒 due——静音是终态，挂起
   *   条目按静音收口（flushDeferred 内处理），不为一个永远不会发生的推送空等。
   * 模式热切换（digest↔instant）不逐条区分挂起原因：队列在"当前策略放行"或
   * "当前 digest 计时器到点"时整体冲刷，条目不携带各自的释放时刻，语义最简。
   */
  private async flushDeferredIfDue(cfg: AppConfig): Promise<void> {
    if (this.deferredHits.size === 0) return
    const nowMs = this.now()
    const muted = !(cfg.notifyEnabled && anyChannelReady(cfg.channels))
    let due: boolean
    if (muted) {
      due = true
    } else if (cfg.notify.mode === 'digest') {
      due =
        this.lastDigestFlushAt === null ||
        nowMs >= nextDigestFlush(this.lastDigestFlushAt, cfg.notify.digestIntervalMin)
    } else {
      due = !decideNotifyAction(cfg.notify, new Date(nowMs)).defer
    }
    if (due) await this.flushDeferred(cfg)
  }

  /**
   * 冲刷挂起队列（DEC-11）：按插入序（Map 迭代序）逐条收口。单条语义：
   * - 推送成功：seen.add + recordHit（notifiedAt=冲刷时刻，完整 payload 字段）
   *   + 相似窗入窗——对齐即时路径成功后的三个动作；
   * - 推送失败：attempts++；未达上限（3）留队列下次 flush 重试（锐评已在
   *   match 时生成，重试不重打 LLM；失败中间态只 log 不 emit，防刷屏——与
   *   即时路径"同失败态只 emit 一次"同一精神）；达上限 → recordHit
   *   （notifiedAt=null、notifyError=最后错误）+ **seen.add**（防下轮重新匹配
   *   死循环）+ 出队 + emit 终态；
   * - 冲刷时刻已静音（热更新结果）：按静音终态出队（notifiedAt/notifyError
   *   均 null，对齐即时路径的 mute 语义——静音不重试）。
   * 全队列处理完：lastDigestFlushAt = now（digest 批窗口重开；instant 模式
   * 写入也无害——切回 digest 时从新锚点起算）。
   * 重启丢队列是接受的语义（内存态）：未入 seen 的挂起帖若仍在第 1 页，重启后
   * 会被重新匹配——窗内重新入队、窗外直接即时推送（自愈，不双发：旧进程已死）。
   */
  private async flushDeferred(cfg: AppConfig): Promise<void> {
    if (this.deferredHits.size === 0) return
    // 相似窗就位保障：与 processHit 同款（flush 可能先于本轮首个 processHit
    // 触碰窗口；构造期 promise 此后已 settle，await 零成本）
    await this.similarityWindowReady
    const muted = !(cfg.notifyEnabled && anyChannelReady(cfg.channels))
    for (const [key, entry] of [...this.deferredHits.entries()]) {
      if (muted) {
        this.deferredHits.delete(key)
        this.deps.seen.add(key)
        const hit = deferredHitRecord(entry, null, null)
        this.recordHit(hit)
        this.deps.logger.info(`deferred hit muted at flush: "${entry.payload.topic.title}"`)
        this.noteDisposition(entry.payload.topic, 'muted', '挂起期间推送被关闭（静音收口）')
        this.deps.onHit?.(hit)
        continue
      }
      // per-channel 明细（R6-W4）：report 挂在发送时的浅拷贝上，不回写挂起
      // payload（重试轮各自重新收集，detail 不跨轮残留）
      const collector = createNotifyDetailCollector()
      try {
        await this.deps.notifier.sendHit({ ...entry.payload, report: collector.report })
        this.deferredHits.delete(key)
        this.deps.seen.add(key)
        const hit = deferredHitRecord(entry, this.isoNow(), null, collector.detail)
        this.recordHit(hit)
        this.pushedTitles.push({
          title: normalizeTitle(entry.payload.topic.title),
          at: this.now()
        })
        this.deps.logger.info(`deferred hit pushed: "${entry.payload.topic.title}"`)
        this.noteDisposition(entry.payload.topic, 'pushed')
        this.deps.onHit?.(hit)
      } catch (err) {
        entry.attempts++
        // 失败聚合语义与即时路径一致：首个失败通道的错误优先，无明细（通道未接
        // report / 单 notifier mock）回退抛错消息
        const msg = collector.firstError() ?? describeError(err)
        if (entry.attempts >= DEFERRED_FLUSH_MAX_ATTEMPTS) {
          this.deferredHits.delete(key)
          this.deps.seen.add(key)
          const hit = deferredHitRecord(entry, null, msg, collector.detail)
          this.recordHit(hit)
          this.deps.logger.error(
            `deferred hit flush failed ${entry.attempts} times, giving up ` +
              `(notifyError recorded): "${entry.payload.topic.title}": ${msg}`
          )
          this.noteDisposition(entry.payload.topic, 'push-failed', `flush ${entry.attempts} 次失败：${msg}`)
          this.deps.onHit?.(hit)
        } else {
          this.deps.logger.warn(
            `deferred hit flush failed (attempt ${entry.attempts}/${DEFERRED_FLUSH_MAX_ATTEMPTS}), ` +
              `will retry next flush: "${entry.payload.topic.title}": ${msg}`
          )
        }
      }
    }
    this.lastDigestFlushAt = this.now()
  }

  /**
   * 挂起队列超时收口（DEC-11，挂点对齐 pruneRetryMaps 的调用点）：挂起超过
   * DEFERRED_HIT_TIMEOUT_MS(24h) 的条目 recordHit（notifyError='deferred
   * timeout'）+ seen.add（防重新匹配）+ 出队。时间维度裁剪，不看
   * roundTopicKeys/observedSources——挂起帖滚出首页不构成放弃它的理由
   * （与重试缓存语义相反），24h 是唯一的界。
   */
  private pruneDeferredHits(): void {
    if (this.deferredHits.size === 0) return
    const cutoff = this.now() - DEFERRED_HIT_TIMEOUT_MS
    for (const [key, entry] of [...this.deferredHits.entries()]) {
      if (entry.addedAt >= cutoff) continue
      this.deferredHits.delete(key)
      this.deps.seen.add(key)
      const hit = deferredHitRecord(entry, null, 'deferred timeout')
      this.recordHit(hit)
      this.deps.logger.warn(
        `deferred hit timed out after 24h (notifyError recorded): "${entry.payload.topic.title}"`
      )
      this.noteDisposition(entry.payload.topic, 'push-failed', 'deferred timeout')
      this.deps.onHit?.(hit)
    }
  }

  /**
   * 处理一条命中的新帖：相似降噪闸 → 生成锐评（第三轮）→ 免打扰/digest 挂起
   * 判定（R6-W1q，DEC-11：defer 则入内存队列不入 seen/不 recordHit/不入相似窗，
   * 等 flush——见 flushDeferred）→ 尝试推送 → 组 HitRecord → 计数入环 →
   * emit onHit。
   *
   * 相似降噪（R5-P2a 第 8 步，作用于**所有**命中方式推送前）：cfg.similarity.enabled
   * 时与"近期已推"窗口比对标题，相似 → 入 seen 不推送不 emit 不计 HitRecord
   * （不是命中），log info + 引擎计数；重试在途的键一并清（推送已无意义）。
   * enabled=false 时整段跳过（行为与升级前一致）。
   *
   * 推送结果语义（ADR 8.10）：
   * - **成功 / 静音**（notifyEnabled=false 或无就绪通道，R6-W1 起通道化判定）
   *   → 入去重集。静音是用户主动行为，不重试；
   * - **真实推送失败**（notifier 抛错）→ **不**入去重集，下轮自然重试
   *   （帖子滚出首页第 1 页即止，天然有界）；同键同失败态只 emit/log 一次，
   *   成功或转静音后清除待重试标记并 emit 最终态。
   * 推送失败不中断本轮后续 topic。重试去重键 = 全局键 `${sourceId}:${topicId}`
   * （跨 source 同 id 帖子不互相吞 emit）。
   * matchedBy：literal（字面管线，matchedKeywords 非空）/ semantic（语义管线，
   * matchedKeywords 恒空数组，semanticReason 带 AI 判定理由或 null）/ rule（价格
   * 规则管线，matchedKeywords 恒空数组，matchedRule 带规则 label——id 无 label
   * 时即 id，rules.ts 的 RuleMatch.label 已归一；matchedRuleId 带规则 id，供
   * router 的 when.ruleId 路由用——两字段同源同生，label ≠ id 时路由只认 id）。
   * commentary：sendHit 之前生成（无论推送是否会被静音——HitRecord/内存环仍要
   * 展示）；恒 string|null，不留 undefined、不写空串（见 maybeGenerateCommentary）。
   * 相似降噪闸在锐评生成**之前**（吞并的帖子不打 LLM、不白耗调用）。
   */
  private async processHit(
    topic: Topic,
    matchedKeywords: string[],
    cfg: AppConfig,
    matchedBy: 'literal' | 'semantic' | 'rule' | 'matchall' = 'literal',
    semanticReason: string | null = null,
    matchedRule: string | null = null,
    matchedRuleId: string | null = null
  ): Promise<void> {
    // 窗口重建就位保障（R5-P2a 第 11 步）：构造期发起的重建在这里被 await——
    // 首轮推送（含相似检查）前窗口必须就位；此后 promise 已 settle，await 零成本。
    // 放在 processHit 而非 pollOnce 顶部：保持 pollOnce 到 fetchLatest 的同步
    // 调用深度（start() 的同步首轮语义，既有契约），基线轮也没有推送可等。
    await this.similarityWindowReady
    // 相似降噪（第 8 步）：与近窗内已推送帖相似 → 入 seen 不推送
    if (cfg.similarity.enabled) {
      const similar = this.findSimilarRecentlyPushed(topic.title, cfg)
      if (similar !== null) {
        const swallowedKey = seenKeyFor(topic.sourceId, topic.id)
        this.deps.seen.add(swallowedKey)
        // 重试在途的键一并收口（相似帖已被更早的推送覆盖，重试无意义）
        this.pendingNotifyErrors.delete(swallowedKey)
        this.semanticVerdicts.delete(swallowedKey)
        this.similarSwallowedCount++
        this.deps.logger.info(
          `similar topic swallowed: ${topic.title} ` +
            `(similar to recently pushed "${similar.title}", score ${similar.score.toFixed(2)})`
        )
        this.noteDisposition(
          topic,
          'similar-swallowed',
          `与 48h 内已推送的「${similar.title}」相似（${similar.score.toFixed(2)} ≥ 阈值 ${cfg.similarity.threshold}）`
        )
        return
      }
    }
    const commentary = await this.maybeGenerateCommentary(topic, cfg)
    let notifiedAt: string | null = null
    let notifyError: string | null = null
    // per-channel 推送明细收集（R6-W4）：各通道 sendHit 最终结果落定后经
    // input.report 自报（composite 透传不重复调用），成功/失败路径的
    // HitRecord 据此落 notifyDetail 键（至少一条记录时才落；静音路径不调
    // sendHit → 无键）。
    const collector = createNotifyDetailCollector()
    // configured 判定（R6-W1 起通道化）：任一 enabled 且凭据齐备的**已实现**通道
    // （本轮仅 telegram，notify/types.isChannelReady 的单一事实源）。单 telegram
    // 通道时代与旧 cfg.telegram.botToken/chatId 直读完全等价；notifyEnabled 静音
    // 语义不动（静音 = 已配置但用户关闸，仍入 seen 不重试）。
    const configured = anyChannelReady(cfg.channels)
    if (cfg.notifyEnabled && configured) {
      // 免打扰/digest 挂起判定（R6-W1q，DEC-11）：在推送分支内、相似闸与锐评
      // 生成之后——静音/未配置不走 defer（下方 mute 路径原样），锐评在 match 时
      // 已生成并随 payload 挂起（flush 不再重打 LLM）。挂起 = 不入 seen /
      // 不 recordHit / 不入相似窗（坑6），直接返回等 flush。
      const deferAction = decideNotifyAction(
        cfg.notify,
        new Date(this.now()),
        this.lastDigestFlushAt
      )
      if (deferAction.defer) {
        const deferKey = seenKeyFor(topic.sourceId, topic.id)
        // digest 批窗口锚点：仅当队列从空开始（新批）且上一窗口已到期/从未开过
        // 时重开——否则沿用既有锚点，连续命中下批窗口不被无限续期（防饿死）。
        const deferNow = this.now()
        if (
          deferAction.reason === 'digest' &&
          this.deferredHits.size === 0 &&
          (this.lastDigestFlushAt === null ||
            deferNow >= nextDigestFlush(this.lastDigestFlushAt, cfg.notify.digestIntervalMin))
        ) {
          this.lastDigestFlushAt = deferNow
        }
        this.deferredHits.set(deferKey, {
          payload: {
            topic,
            matchedKeywords,
            commentary,
            matchedRule: matchedBy === 'rule' ? matchedRule : null,
            matchedRuleId: matchedBy === 'rule' ? matchedRuleId : null,
            semanticReason,
            matchedBy
          },
          addedAt: deferNow,
          attempts: 0
        })
        this.deps.logger.info(`hit deferred (${deferAction.reason}): "${topic.title}"`)
        this.noteDisposition(topic, 'deferred', deferAction.reason)
        return
      }
      try {
        // matchedRule 仅 rule 命中传 label（telegram 侧渲染「命中规则」行），
        // matchedRuleId 同源带规则 id（router 的 when.ruleId 路由用）；semanticReason
        // 语义命中带 AI 理由、其余恒 null——三字段与挂起 payload 形状对齐（bark/
        // nfy/webhook 通道即时/挂起两路径消费一致）；其余命中方式恒传 null（与
        // commentary 同款"不留 undefined"约定）；report 挂外层 collector（成功/
        // 失败两路径的 HitRecord 共用同一明细）
        await this.deps.notifier.sendHit({
          topic,
          matchedKeywords,
          commentary,
          matchedRule: matchedBy === 'rule' ? matchedRule : null,
          matchedRuleId: matchedBy === 'rule' ? matchedRuleId : null,
          semanticReason,
          report: collector.report
        })
        notifiedAt = this.isoNow()
      } catch (err) {
        notifiedAt = null
        // 聚合 notifyError：首个失败通道的错误优先（单通道时代与抛错消息等价）；
        // 无明细（通道未接 report / 单 notifier mock）回退抛错消息（既有语义）
        notifyError = collector.firstError() ?? describeError(err)
      }
    }

    const key = seenKeyFor(topic.sourceId, topic.id)

    if (notifyError !== null) {
      // 真实推送失败：不入去重集（下轮重试）；不入相似窗口（第 10 步——窗口语义
      // 是"用户已收到"）；同失败态只 emit/log 一次。处置流水在 prevError 去重
      // 之前上报——重试轮同 outcome 的刷屏由 DispositionStore 的键去重拦下
      // （R7-W1），失败原因变化时 detail 也会更新到流水里。
      this.noteDisposition(topic, 'push-failed', notifyError)
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
        notifyError,
        ...(Object.keys(collector.detail).length > 0 ? { notifyDetail: collector.detail } : {})
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
      notifyError: null,
      ...(Object.keys(collector.detail).length > 0 ? { notifyDetail: collector.detail } : {})
    }
    // 处置终态（R7-W1）：成功推送 / 静音。重试在途的帖子此前是 push-failed，
    // 这里覆盖为终态（store 按 outcome 迁移追加一条）。
    this.noteDisposition(topic, notifiedAt !== null ? 'pushed' : 'muted')
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
      this.deps.logger.info(`hit muted (notify disabled or no channel ready): "${topic.title}"`)
    }
    this.deps.onHit?.(hit)
  }

  /**
   * 命中帖锐评（第三轮）：三条件全部满足才真调 generate，否则 commentary=null
   * 且不打 LLM：
   * - deps.commentaryGenerator 已注入（旧装配/测试不注入 = 恒 null，行为不变）；
   * - cfg.ai.commentary.enabled === true（恒存在恒布尔，防御式严格比较）；
   * - provider 齐备（this.aiConfigured，每轮 updateAiConfig 从配置刷新）。
   * 模式透传（R12）：cfg.ai.commentary.useThinking === true 走思考模式（旧
   * 语义：预算 2000、单发不重试），否则（缺省含旧配置）直出模式——禁思考
   * 参数 + 预算 200 + 失败自动重试一次；防御式严格比较。
   * 无每日配额语义（不设上限）。真调用前后双计数（callsToday++ /
   * commentaryToday++，均为纯观测计数）：generate 内部消化一切异常，调用即
   * 计数无论成败；推送失败重试轮 generate 会被再次调用并计数，但其内部缓存
   * 保证不再打 LLM。generate 绝不抛（模块保证），无需 try/catch。
   */
  private async maybeGenerateCommentary(topic: Topic, cfg: AppConfig): Promise<string | null> {
    const gen = this.deps.commentaryGenerator
    if (gen === undefined) return null
    if (cfg.ai.commentary.enabled !== true) return null
    if (!this.aiConfigured) return null
    this.rollAiDay()
    this.aiCallsToday++
    this.commentaryToday++
    return await gen.generate(topic, { useThinking: cfg.ai.commentary.useThinking === true })
  }

  // ---- 相似降噪窗口（R5-P2a 第 8/10/11 步） --------------------------------

  /**
   * 标题与"近期已推"窗口的相似判定（DEC-4），带命中明细（观测面用）。
   * 窗口条目在入窗时已 normalizeTitle（findSimilarTo 的契约：recentTitles 须传
   * 已归一化串）；待判标题传原始串，函数内部自行归一。窗口为空恒 null。
   * 检查时跳过已超出 48h 的条目——轮末 prune 之外的时刻（如长睡眠恢复后的
   * 首轮）窗口里可能还留着过期条目，48h 契约以**判定时点**为准（过期放行）。
   */
  private findSimilarRecentlyPushed(title: string, cfg: AppConfig): SimilarityMatch | null {
    if (this.pushedTitles.length === 0) return null
    const cutoff = this.now() - SIMILARITY_WINDOW_MS
    const inWindow = this.pushedTitles.filter((e) => e.at >= cutoff)
    if (inWindow.length === 0) return null
    return findSimilarTo(
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

  /**
   * 处置流水出口（R7-W1）：unseen 链分支出口 / flush 收口的统一上报点。
   * 未注入 deps.dispositions 时零行为。detail 裁剪到 120 字符防长 AI 理由刷屏。
   */
  private noteDisposition(
    topic: Topic,
    outcome: DispositionOutcome,
    detail?: string
  ): void {
    const sink = this.deps.dispositions
    if (sink === undefined) return
    sink.record(
      topic.sourceId,
      topic.id,
      topic.title,
      outcome,
      detail !== undefined && detail !== '' ? clipDetail(detail) : undefined
    )
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

/** 处置流水 detail 上限（R7-W1）：超长 AI 理由/错误消息截断，防 jsonl 单行失控 */
const DISPOSITION_DETAIL_MAX = 120

function clipDetail(s: string): string {
  return s.length <= DISPOSITION_DETAIL_MAX ? s : `${s.slice(0, DISPOSITION_DETAIL_MAX - 1)}…`
}

/**
 * 排除词命中词查找（R7-W1，仅处置流水 detail 用）：返回首个在标题中命中的
 * 排除词（trim/小写/子串，与 matcher.isExcluded 同口径）。判定本身仍是
 * isExcluded——本函数只在 isExcluded 已判 true 后取词，两处口径漂移最多丢
 * detail，不影响行为。
 */
function findExcludedWord(topic: Topic, excludeKeywords: string[]): string | undefined {
  const title = topic.title.toLowerCase()
  for (const raw of excludeKeywords) {
    const kw = raw.trim().toLowerCase()
    if (kw.length > 0 && title.includes(kw)) return kw
  }
  return undefined
}
