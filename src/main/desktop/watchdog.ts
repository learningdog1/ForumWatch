/**
 * 引擎看门狗（R8-A 任务一，E2 自愈）：监测「desired=running 但轮询时刻已严重超期」
 * 的挂死形态并主动补轮询。
 *
 * 覆盖的故障形态：PollScheduler 的 setTimeout 因主进程事件循环阻塞 / 定时器丢失 /
 * 异常状态组合而不再触发时，EngineStatus.nextPollAt 会停留在过去——引擎不会自愈，
 * 监控静默失效。watchdog 以独立定时器旁路观察该信号，超期即调 runNow()
 * （内部经 engine.runNow → scheduler.runNow，幂等且尊重 desired）强制补一轮，
 * 让排程循环重新起步。
 *
 * 触发条件（三者同时满足才触发）：
 * - `desired === 'running'`（用户暂停期间引擎本来就不排程，nextPollAt 停留是正常态，
 *   不得触发）；
 * - `nextPollAt != null`（null = 无排程——从未启动 / 已暂停，同样不触发）；
 * - `now > nextPollAt + max(intervalMs * 2, 90s)`（宽限窗吸收正常抖动：排程器
 *   jitter、在途 tick 的重排延迟、休眠唤醒的补偿轮询；interval 由装配方从
 *   config.pollIntervalSec 现读，EngineStatus 不携带它）。
 *
 * 触发动作：log error（含超期时长；60s 内重复触发只计数不 log，防每 30s 一条的
 * 刷屏——见 LOG_SUPPRESS_WINDOW_MS）→ 调 runNow() → 计数。
 *
 * 实现约束：零 electron 依赖（ADR 2：内核/桌面共享模块不 import electron——本模块
 * 放 desktop/ 目录仅因它属于桌面装配的观测件，headless 接线由后续包补）；时钟与
 * 定时器均可注入（now / setTimer），单测用假时钟驱动触发矩阵，不起真实计时器。
 * 定时器用自循环 setTimeout（每轮检查完重排下一个 30s），不用 setInterval——
 * 对齐 PollScheduler / 日报定时器的重排模式（ADR 8.1：壁钟漂移不积累误差）。
 *
 * 状态暴露：getStatus() 返回 `{ lastTriggeredAt, count }`，由 runtime 装配方挂到
 * EngineStatus.watchdog（快照对象上附加字段再广播，见 runtime.emitStatus）——
 * engine 自身不写该字段（status 是 engine 的事实源，watchdog 是 runtime 侧观测）。
 */

/** 检查周期：每 30s 观察一次 nextPollAt 是否超期 */
export const WATCHDOG_CHECK_INTERVAL_MS = 30_000

/** 宽限窗下限：max(interval*2, 90s) 的 90s——短间隔配置（如 15s）也不至于频繁误触发 */
export const WATCHDOG_MIN_GRACE_MS = 90_000

/** 详情日志抑制窗：60s 内的重复触发只计数不 log（防每 30s 一条刷屏） */
export const WATCHDOG_LOG_SUPPRESS_WINDOW_MS = 60_000

/** 可清除的定时器句柄（setTimer 注入方返回；默认实现包 Node 的 setTimeout） */
export interface WatchdogTimerHandle {
  clear(): void
}

/** watchdog 依赖的最小日志面（Logger 结构子集，便于单测注入收集器） */
export interface WatchdogLogger {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
}

export interface EngineWatchdogDeps {
  /** 引擎实时状态快照（装配方绑 engine.getStatus） */
  getStatus(): EngineStatusLike
  /** 立即补一轮（装配方绑 engine.runNow；watchdog 不感知其内部 desired 语义） */
  runNow(): Promise<void> | void
  /** 当前轮询间隔（ms）；EngineStatus 不携带 interval，由装配方从 config 现读 */
  getIntervalMs(): number
  /** 日志接收器（warn/error/info 最小面） */
  log: WatchdogLogger
  /** 测试注入假时钟（epoch ms）；默认 Date.now */
  now?: () => number
  /** 测试注入假定时器；默认 setTimeout（自循环重排，见 scheduleCheck） */
  setTimer?: (cb: () => void, delayMs: number) => WatchdogTimerHandle
}

/** getStatus 依赖的最小状态面（EngineStatus 的结构子集） */
export interface EngineStatusLike {
  desired: 'running' | 'paused'
  nextPollAt: string | null
}

/** 对外暴露的 watchdog 状态（EngineStatus.watchdog 的形状） */
export interface WatchdogStatus {
  /** 最近一次触发时刻 ISO；null = 从未触发 */
  lastTriggeredAt: string | null
  /** 累计触发次数 */
  count: number
}

export class EngineWatchdog {
  private readonly deps: EngineWatchdogDeps
  private readonly now: () => number
  private readonly setTimer: (cb: () => void, delayMs: number) => WatchdogTimerHandle
  private timer: WatchdogTimerHandle | null = null
  private started = false
  /** 累计触发次数（EngineStatus.watchdog.count 的事实源） */
  private triggerCount = 0
  /** 最近一次触发时刻（epoch ms；null = 从未触发） */
  private lastTriggeredAtMs: number | null = null
  /** 最近一次**详情日志**时刻（epoch ms）；60s 抑制窗的基准，与触发时刻解耦 */
  private lastDetailLoggedAtMs: number | null = null

  constructor(deps: EngineWatchdogDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
    this.setTimer =
      deps.setTimer ??
      ((cb, delayMs) => {
        const t = setTimeout(cb, delayMs)
        return { clear: () => clearTimeout(t) }
      })
  }

  /** 启动检查循环（30s 一个检查周期）；幂等 */
  start(): void {
    if (this.started) return
    this.started = true
    this.scheduleCheck()
  }

  /** 停止检查循环并清掉待定计时器；幂等（已触发的观测计数保留在实例上） */
  stop(): void {
    this.started = false
    if (this.timer !== null) {
      this.timer.clear()
      this.timer = null
    }
  }

  get isRunning(): boolean {
    return this.started
  }

  /** 观测面快照（runtime 装配方挂到 EngineStatus.watchdog 上） */
  getStatus(): WatchdogStatus {
    return {
      lastTriggeredAt:
        this.lastTriggeredAtMs === null ? null : new Date(this.lastTriggeredAtMs).toISOString(),
      count: this.triggerCount
    }
  }

  // ---- 内部实现 ----------------------------------------------------------

  /** 自循环重排：每个检查周期结束（或被 stop）后排下一个 30s 计时器 */
  private scheduleCheck(): void {
    if (!this.started) return
    this.timer = this.setTimer(() => {
      this.timer = null
      try {
        this.checkOnce(this.now())
      } catch (err) {
        // 观察失败（getStatus 抛错等）不破坏循环：记日志后照常重排
        this.deps.log.error(`watchdog check threw: ${err instanceof Error ? err.message : String(err)}`)
      }
      this.scheduleCheck()
    }, WATCHDOG_CHECK_INTERVAL_MS)
  }

  /**
   * 单次检查（触发矩阵的实现，测试直调点）：
   * 条件不满足 / desired paused / nextPollAt null / 未超宽限窗 → 直接返回。
   * 触发：计数 + 记时刻 → 抑制窗外的首次（或距上次详情 ≥60s）log error（含超期
   * 时长）→ 调 runNow()（同步抛错记日志；异步 reject 也兜住）。
   */
  private checkOnce(nowMs: number): void {
    const status = this.deps.getStatus()
    if (status.desired !== 'running') return
    if (status.nextPollAt === null) return
    const nextPollMs = Date.parse(status.nextPollAt)
    if (Number.isNaN(nextPollMs)) return // 非法时刻字符串：无从判超期，保守跳过
    const graceMs = Math.max(this.deps.getIntervalMs() * 2, WATCHDOG_MIN_GRACE_MS)
    const deadline = nextPollMs + graceMs
    if (nowMs <= deadline) return

    const overdueMs = nowMs - nextPollMs
    this.triggerCount++
    this.lastTriggeredAtMs = nowMs
    if (
      this.lastDetailLoggedAtMs === null ||
      nowMs - this.lastDetailLoggedAtMs >= WATCHDOG_LOG_SUPPRESS_WINDOW_MS
    ) {
      this.lastDetailLoggedAtMs = nowMs
      this.deps.log.error(
        `engine watchdog triggered: poll overdue by ${Math.round(overdueMs / 1000)}s ` +
          `(nextPollAt=${status.nextPollAt}, interval=${Math.round(this.deps.getIntervalMs() / 1000)}s, ` +
          `grace=${Math.round(graceMs / 1000)}s); forcing runNow() to self-heal ` +
          `(trigger #${this.triggerCount})`
      )
    }
    try {
      const maybePromise = this.deps.runNow()
      if (maybePromise instanceof Promise) {
        void maybePromise.catch((err: unknown) => {
          this.deps.log.error(
            `watchdog runNow() rejected: ${err instanceof Error ? err.message : String(err)}`
          )
        })
      }
    } catch (err) {
      this.deps.log.error(
        `watchdog runNow() threw: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
}
