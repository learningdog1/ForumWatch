/**
 * 监控引擎：轮询循环的装配核心（ADR 2：零 electron import）。
 *
 * 每轮语义：重读配置 → fetchLatest → 首启基线（只入去重集不推送，ADR 8.5 防通知风暴）
 * → 新帖按页面逆序处理（推送顺序旧→新）→ 置顶只入集（ADR 8.5）→ matchTopic 命中
 * → 尝试推送（单个失败不中断本轮；真实失败不入集下轮重试，ADR 8.10）→
 * 轮末 flush/prune/持久化 totalHits。
 *
 * 状态模型（ADR 7）：desired（用户意图，唯一可写）× health（内核观测，自动流转）正交。
 * pause 只改 desired 并 stop 排程器，health 不动；getStatus 返回实时快照。
 *
 * 接线约定（桌面 / headless 装配方必读）：
 * - scheduler 由装配方创建并注入：`onTick` 绑 `engine.pollOnce()`、
 *   `onScheduled` 绑 `engine.noteScheduled(ms)`（epoch ms → ISO 填 nextPollAt）。
 *   构造顺序用 `let engine` 闭包即可（onTick 调用时才解引用）。
 * - PollScheduler 会吞掉 onTick 的异常——本引擎在 pollOnce 内部自行 try/catch：
 *   失败时 consecutiveFailures++ 且 `setIntervalSec(computeBackoffMs(failures, base)/1000)`，
 *   成功时复位 `setIntervalSec(cfg.pollIntervalSec)`；onTick settle 后才重排，
 *   setIntervalSec 恰在下一次排程前生效。
 * - `ChallengeError` 用 instanceof 判：进 health='challenged'，不走普通退避。
 * - getConfig 每轮轮询前重读，装配方负责配置热更新语义（IPC 改配置即换返回值）。
 * - powerMonitor resume 等系统事件调 `engine.runNow()`：内部尊重 desired，
 *   用户暂停（pause）期间是 no-op，不会被系统事件偷偷唤醒。
 * - 两个 HttpClient（site 抓取 / tg 推送）与代理路由由装配方负责，本引擎只面向
 *   注入的 source 与 notifier，不感知网络。
 */
import { matchTopic } from './matcher'
import { computeBackoffMs, type PollScheduler } from './poller'
import type { FileSeenStore } from './dedup'
import type { FileEngineState, EngineState } from './state'
import { ChallengeError, type SourceAdapter } from './types'
import type { Logger } from '../logger'
import {
  DEFAULT_APP_CONFIG,
  INITIAL_ENGINE_STATUS,
  type AppConfig,
  type EngineStatus,
  type HitRecord,
  type Topic
} from '../../shared/types'

/** 命中记录内存环形容量（getRecentHits 给 UI 的上限） */
export const HIT_RING_CAPACITY = 200

export interface EngineDeps {
  /** 数据源（HtmlSourceAdapter 或未来 RSS/API 备选实现） */
  source: SourceAdapter
  /** 去重集（装配方启动时 load；engine 每轮 has/add、轮末 flush+prune） */
  seen: FileSeenStore
  /** 引擎状态持久化（baselineDone / totalHits；engine 构造时读取 totalHits 初值） */
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
   * 推送失败待重试的 topic：id -> 上次失败原因（ADR 8.10）。
   * 真实推送失败不入去重集、下轮自然重试；同 id 同失败态只 emit/log 一次
   * （防每轮刷屏），成功或转静音后清除并 emit 最终态。
   */
  private readonly pendingNotifyErrors = new Map<string, string>()
  /** 最近一次成功读到的轮询间隔：getConfig 抛错时退避计算仍可用（默认 60s） */
  private lastIntervalSec: number = DEFAULT_APP_CONFIG.pollIntervalSec
  private status: EngineStatus

  constructor(deps: EngineDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
    // totalHits 跨进程累计：从持久化 state 恢复（未 load 过则 get 内部会 load）
    this.status = { ...INITIAL_ENGINE_STATUS, totalHits: deps.state.get().totalHits }
    this.rebaselineIfNeeded()
  }

  /**
   * seen 损坏重建后强制补基线（ADR 8.9）：seen 备份重建 = 空集，若 baselineDone
   * 仍为 true，下一轮会把整页当新帖推送（单页 mini 风暴）——重置为 false，
   * 下一轮按基线处理（全量入集不推送）。
   */
  private rebaselineIfNeeded(): void {
    if (!this.deps.seen.rebuiltFromCorrupt) return
    if (!this.deps.state.get().baselineDone) return // 本来就要做基线，无需处理
    try {
      this.deps.state.set({ baselineDone: false })
      this.deps.logger.warn('seen store rebuilt, re-baselining')
    } catch (err) {
      this.deps.logger.error(
        `cannot reset baselineDone after seen rebuild: ${err instanceof Error ? err.message : String(err)}`
      )
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

  /** 实时状态快照（新对象，调用方改动不影响引擎内部） */
  getStatus(): EngineStatus {
    return { ...INITIAL_ENGINE_STATUS, ...this.status }
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
   * 单轮完整轮询。所有异常在此消化、绝不向上抛（排程器吞异常，见类注释）：
   * - 抓取成功（含基线/无新帖）→ health='ok'、失败计数复位、间隔回配置值；
   * - ChallengeError → health='challenged'；其他异常 → health='backoff'；
   *   两者都 consecutiveFailures++ 并按指数退避放大下一轮间隔；seen/state 不动。
   * 测试与 --once 脚本也可以直调。
   */
  async pollOnce(): Promise<void> {
    this.status.lastPollAt = this.isoNow()
    try {
      // getConfig 也在 try 内：配置读取异常同样走失败收尾（health/backoff/lastError）
      const cfg = this.deps.getConfig()
      this.lastIntervalSec = cfg.pollIntervalSec
      const topics = await this.deps.source.fetchLatest()

      // 首启基线（ADR 8.5）：整页只入去重集不推送，防通知风暴
      if (!this.deps.state.get().baselineDone) {
        for (const t of topics) this.deps.seen.add(t.id)
        await this.flushSeenOrFail()
        this.persistState({ baselineDone: true })
        this.deps.logger.info(`baseline captured (${topics.length} topics)`)
        this.finishSuccess(cfg)
        return
      }

      const unseen = topics.filter((t) => !this.deps.seen.has(t.id))
      // 页面最新在前 → 逆序处理，推送顺序旧→新
      for (const topic of [...unseen].reverse()) {
        if (topic.pinned) {
          // 置顶是旧帖：入去重集但绝不推送
          this.deps.seen.add(topic.id)
          continue
        }
        const { matched, matchedKeywords } = matchTopic(
          topic,
          cfg.includeKeywords,
          cfg.excludeKeywords
        )
        if (!matched) {
          this.deps.seen.add(topic.id)
          continue
        }
        await this.processHit(topic, matchedKeywords, cfg)
      }

      await this.flushSeenOrFail()
      this.deps.seen.prune()
      this.persistState({ totalHits: this.status.totalHits })
      this.finishSuccess(cfg)
    } catch (err) {
      this.finishFailure(err)
    }
  }

  // ---- 内部实现 ----------------------------------------------------------

  /** 轮末去重集落盘；失败只 warn（重启后可能重复推送），不影响本轮健康判定 */
  private async flushSeenOrFail(): Promise<void> {
    if (!(await this.deps.seen.flush())) {
      this.deps.logger.warn('seen flush failed — duplicates possible after restart')
    }
  }

  /**
   * 处理一条命中的新帖：尝试推送 → 组 HitRecord → 计数入环 → emit onHit。
   * 推送结果语义（ADR 8.10）：
   * - **成功 / 静音**（notifyEnabled=false 或 telegram 未配置）→ 入去重集。
   *   静音是用户主动行为，不重试；
   * - **真实推送失败**（notifier 抛错）→ **不**入去重集，下轮自然重试
   *   （帖子滚出首页第 1 页即止，天然有界）；同 id 同失败态只 emit/log 一次，
   *   成功或转静音后清除待重试标记并 emit 最终态。
   * 推送失败不中断本轮后续 topic。
   */
  private async processHit(
    topic: Topic,
    matchedKeywords: string[],
    cfg: AppConfig
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

    if (notifyError !== null) {
      // 真实推送失败：不入去重集（下轮重试）；同失败态只 emit/log 一次
      const prevError = this.pendingNotifyErrors.get(topic.id)
      if (prevError === notifyError) return
      this.pendingNotifyErrors.set(topic.id, notifyError)
      const hit: HitRecord = { topic, matchedKeywords, notifiedAt: null, notifyError }
      this.recordHit(hit)
      this.deps.logger.error(
        `notify failed for topic ${topic.id} "${topic.title}": ${notifyError} (will retry next poll)`
      )
      this.deps.onHit?.(hit)
      return
    }

    // 成功或静音：入去重集；曾在失败重试中的清除标记（上面已 emit 过失败态，
    // 这里 emit 最终态），静音态两字段均 null（HitRecord 语义不变）
    this.pendingNotifyErrors.delete(topic.id)
    this.deps.seen.add(topic.id)
    const hit: HitRecord = { topic, matchedKeywords, notifiedAt, notifyError: null }
    this.recordHit(hit)
    if (notifiedAt !== null) {
      this.deps.logger.info(
        `hit pushed: "${topic.title}" (keywords: ${matchedKeywords.join(', ')})`
      )
    } else {
      this.deps.logger.info(`hit muted (notify disabled or telegram unconfigured): "${topic.title}"`)
    }
    this.deps.onHit?.(hit)
  }

  /** 计入 totalHits 并压入内存环形（超容量淘汰最老） */
  private recordHit(hit: HitRecord): void {
    this.status.totalHits++
    this.hits.push(hit)
    if (this.hits.length > HIT_RING_CAPACITY) this.hits.shift()
  }

  /** 成功收尾：复位失败计数、health=ok，下一轮间隔回配置值 */
  private finishSuccess(cfg: AppConfig): void {
    this.status.consecutiveFailures = 0
    this.status.health = 'ok'
    this.status.lastSuccessAt = this.isoNow()
    this.status.lastError = null
    this.deps.scheduler.setIntervalSec(cfg.pollIntervalSec)
    this.emitStatus()
  }

  /** 失败收尾：区分挑战与普通失败，按指数退避放大下一轮间隔 */
  private finishFailure(err: unknown): void {
    this.status.consecutiveFailures++
    this.status.lastError = err instanceof Error ? err.message : String(err)
    if (err instanceof ChallengeError) {
      this.status.health = 'challenged'
      this.deps.logger.warn(`poll challenged: ${this.status.lastError}`)
    } else {
      this.status.health = 'backoff'
      this.deps.logger.error(
        `poll failed (${this.status.consecutiveFailures} consecutive): ${this.status.lastError}`
      )
    }
    // getConfig 抛错时用最近一次成功读到的间隔（默认 60s）做退避基数
    const backoffSec =
      computeBackoffMs(this.status.consecutiveFailures, this.lastIntervalSec * 1000) / 1000
    this.deps.scheduler.setIntervalSec(backoffSec)
    this.emitStatus()
  }

  /** 持久化引擎状态；落盘失败只记日志不改变本轮健康判定（下一轮再试） */
  private persistState(patch: Partial<EngineState>): void {
    try {
      this.deps.state.set(patch)
    } catch (err) {
      this.deps.logger.error(
        `persist engine state failed: ${err instanceof Error ? err.message : String(err)}`
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
