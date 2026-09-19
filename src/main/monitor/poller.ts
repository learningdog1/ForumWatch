/**
 * 轮询排程 + 指数退避。零 electron 依赖。
 *
 * ADR 8.1：禁止 setInterval（休眠/壁钟漂移会积累误差）——
 * 每次 onTick 的 promise settle 之后才按 `Date.now() + delay` 重排 setTimeout。
 */

/** 指数退避封顶：30 分钟 */
export const MAX_BACKOFF_MS = 30 * 60 * 1000

/**
 * 连续失败 consecutiveFailures 次后的退避间隔：`baseIntervalMs * 2^n`，封顶 30 分钟。
 * n=0（首次成功前的正常轮询，或失败后成功复位）返回 base。
 */
export function computeBackoffMs(consecutiveFailures: number, baseIntervalMs: number): number {
  const n = Math.max(0, Math.floor(consecutiveFailures))
  const base = Math.max(0, baseIntervalMs)
  return Math.min(base * 2 ** n, MAX_BACKOFF_MS)
}

export interface PollSchedulerOptions {
  intervalSec: number
  /** 默认 0.2：实际间隔 = interval * (1 ± jitter) */
  jitterRatio?: number
  /** 默认 15：intervalSec 的钳制下限 */
  minIntervalSec?: number
  /** 完成后才排下一次；实现内部应自行捕获业务异常（见 fireTick） */
  onTick: () => Promise<void>
  /** 每次排程成功后回调下次轮询时刻（epoch ms），engine 据此填 EngineStatus.nextPollAt */
  onScheduled?: (nextPollAtMs: number) => void
}

export class PollScheduler {
  private intervalSec: number
  private readonly jitterRatio: number
  private readonly minIntervalSec: number
  private readonly onTick: () => Promise<void>
  private readonly onScheduled?: (nextPollAtMs: number) => void

  private timer: ReturnType<typeof setTimeout> | null = null
  /** onTick 的 promise 是否在途（防重叠） */
  private ticking = false
  /** 排程器是否处于启动状态（stop 后为 false） */
  private active = false

  constructor(options: PollSchedulerOptions) {
    this.intervalSec = options.intervalSec
    this.jitterRatio = clamp(options.jitterRatio ?? 0.2, 0, 1)
    this.minIntervalSec = options.minIntervalSec ?? 15
    this.onTick = options.onTick
    this.onScheduled = options.onScheduled
  }

  /** 启动：排首个 tick（interval 后）。幂等，重复调用无副作用 */
  start(): void {
    if (this.active) return
    this.active = true
    this.scheduleNext()
  }

  /**
   * 取消待定计时立即执行一轮；tick 已在途则忽略（防重叠）。
   * 对未 start / 已 stop 的排程器等价于启动（如 powerMonitor resume 补一轮后继续循环）。
   */
  runNow(): void {
    if (this.ticking) return
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.active = true
    void this.fireTick()
  }

  /** 停止：取消待定计时；在途 tick 结束后不再重排 */
  stop(): void {
    this.active = false
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** 只影响下一次排程：已排好的计时器不变，下一次 setTimeout 用新值 */
  setIntervalSec(seconds: number): void {
    this.intervalSec = seconds
  }

  get isRunning(): boolean {
    return this.active
  }

  private scheduleNext(): void {
    if (!this.active) return
    const delayMs = this.computeDelayMs()
    this.onScheduled?.(Date.now() + delayMs)
    this.timer = setTimeout(() => {
      void this.fireTick()
    }, delayMs)
  }

  private async fireTick(): Promise<void> {
    this.timer = null
    if (!this.active || this.ticking) return
    this.ticking = true
    try {
      await this.onTick()
    } catch {
      // 排程器不消化业务错误：engine 在 onTick 内部处理失败，
      // 并用 setIntervalSec(computeBackoffMs(...) / 1000) 调整下一轮间隔。
      // 此处吞掉仅为避免 unhandled rejection 打断轮询循环。
    } finally {
      this.ticking = false
      this.scheduleNext() // active=false 时内部直接返回
    }
  }

  /** 有效间隔 = max(intervalSec, minIntervalSec)，加 ±jitter 抖动 */
  private computeDelayMs(): number {
    const effectiveSec = Math.max(this.intervalSec, this.minIntervalSec)
    const jitter = (Math.random() * 2 - 1) * this.jitterRatio // [-ratio, +ratio]
    return Math.max(0, Math.round(effectiveSec * 1000 * (1 + jitter)))
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
