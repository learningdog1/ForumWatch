import { describe, expect, it, vi } from 'vitest'
import {
  EngineWatchdog,
  WATCHDOG_CHECK_INTERVAL_MS,
  type EngineStatusLike,
  type WatchdogLogger,
  type WatchdogTimerHandle
} from './watchdog'

/** 固定纪元基准（2026-09-19T00:00:00Z），全部场景的 nextPollAt/now 都由它推算 */
const T0 = Date.UTC(2026, 8, 19, 0, 0, 0)
const iso = (ms: number): string => new Date(ms).toISOString()

/**
 * 假时钟 + 单槽假定时器：watchdog 任一时刻至多一个待定计时器（自循环重排），
 * 单槽 + 「未清就再排」守卫同时验证「fire 后必重排 / stop 后必清除」的生命周期。
 */
class FakeClock {
  nowMs: number
  pending: { cb: () => void; delayMs: number } | null = null
  clearedCount = 0
  constructor(startMs: number) {
    this.nowMs = startMs
  }
  readonly now = (): number => this.nowMs
  readonly setTimer = (cb: () => void, delayMs: number): WatchdogTimerHandle => {
    if (this.pending !== null) throw new Error('fake timer: scheduled before previous cleared')
    this.pending = { cb, delayMs }
    return {
      clear: () => {
        if (this.pending !== null) {
          this.pending = null
          this.clearedCount++
        }
      }
    }
  }
  /** 触发当前待定计时器（模拟到点）；fire 后回调内重排的下一个计时器留在槽里 */
  fire(): void {
    const p = this.pending
    if (p === null) throw new Error('fake timer: nothing pending')
    this.pending = null
    p.cb()
  }
}

interface Harness {
  clock: FakeClock
  runNow: ReturnType<typeof vi.fn>
  logs: { level: 'info' | 'warn' | 'error'; msg: string }[]
  /** 已记录的 error 级日志消息（实时读，随 logs 增长） */
  readonly errors: string[]
  wd: EngineWatchdog
}

/** 装配最小依赖的可测 harness；status 是活引用（可变对象），逐场景改字段 */
function setup(
  status: EngineStatusLike,
  opts: { intervalMs?: number; nowMs?: number; runNowImpl?: () => void | Promise<void> } = {}
): Harness {
  const clock = new FakeClock(opts.nowMs ?? T0)
  const runNow = vi.fn(opts.runNowImpl ?? (() => {}))
  const logs: { level: 'info' | 'warn' | 'error'; msg: string }[] = []
  const log: WatchdogLogger = {
    info: (msg) => logs.push({ level: 'info', msg }),
    warn: (msg) => logs.push({ level: 'warn', msg }),
    error: (msg) => logs.push({ level: 'error', msg })
  }
  const wd = new EngineWatchdog({
    getStatus: () => status,
    runNow,
    getIntervalMs: () => opts.intervalMs ?? 60_000,
    log,
    now: clock.now,
    setTimer: clock.setTimer
  })
  // errors 用 getter 实时读（filter 快照会冻结在 setup 时刻）
  return {
    clock,
    runNow,
    logs,
    get errors(): string[] {
      return logs.filter((l) => l.level === 'error').map((l) => l.msg)
    },
    wd
  }
}

/** 起动后烧一个检查周期（把 clock.nowMs 设好后调） */
function runOneCheck(h: Harness): void {
  h.clock.fire()
}

describe('EngineWatchdog：触发矩阵', () => {
  it('超期触发：log error（含超期时长与触发序号）→ 调 runNow → 计数', () => {
    // interval 60s → 宽限 = max(120s, 90s) = 120s；now 超过 T0+120s 即触发
    const h = setup({ desired: 'running', nextPollAt: iso(T0) }, { intervalMs: 60_000 })
    h.wd.start()
    h.clock.nowMs = T0 + 121_000
    runOneCheck(h)

    expect(h.runNow).toHaveBeenCalledTimes(1)
    expect(h.wd.getStatus()).toEqual({ lastTriggeredAt: iso(T0 + 121_000), count: 1 })
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]).toContain('overdue by 121s')
    expect(h.errors[0]).toContain('trigger #1')
  })

  it('未超期不触发：宽限窗内 / 恰好压线（now == nextPollAt + grace）都不触发', () => {
    const h = setup({ desired: 'running', nextPollAt: iso(T0) }, { intervalMs: 60_000 })
    h.wd.start()

    h.clock.nowMs = T0 + 60_000 // 宽限 120s 内
    runOneCheck(h)
    h.clock.nowMs = T0 + 120_000 // 恰好压线：严格大于才触发
    runOneCheck(h)

    expect(h.runNow).not.toHaveBeenCalled()
    expect(h.wd.getStatus()).toEqual({ lastTriggeredAt: null, count: 0 })
    expect(h.errors).toHaveLength(0)
  })

  it('宽限窗下限 90s：短间隔配置不被 interval*2 缩小（10s 间隔 → 宽限 90s 而非 20s）', () => {
    const h = setup({ desired: 'running', nextPollAt: iso(T0) }, { intervalMs: 10_000 })
    h.wd.start()

    h.clock.nowMs = T0 + 20_000 // 若错误地用 interval*2=20s，这里就会误触发
    runOneCheck(h)
    expect(h.runNow).not.toHaveBeenCalled()

    h.clock.nowMs = T0 + 90_000 // 压线不触发
    runOneCheck(h)
    expect(h.runNow).not.toHaveBeenCalled()

    h.clock.nowMs = T0 + 91_000
    runOneCheck(h)
    expect(h.runNow).toHaveBeenCalledTimes(1)
  })

  it('desired=paused 不触发（暂停期间 nextPollAt 停留是正常态）', () => {
    const h = setup({ desired: 'paused', nextPollAt: iso(T0) }, { intervalMs: 60_000 })
    h.wd.start()
    h.clock.nowMs = T0 + 600_000 // 超期 10 分钟
    runOneCheck(h)
    expect(h.runNow).not.toHaveBeenCalled()
    expect(h.wd.getStatus().count).toBe(0)
    expect(h.errors).toHaveLength(0)
  })

  it('nextPollAt=null 不触发（无排程：从未启动 / 暂停不排程）', () => {
    const h = setup({ desired: 'running', nextPollAt: null }, { intervalMs: 60_000 })
    h.wd.start()
    h.clock.nowMs = T0 + 600_000
    runOneCheck(h)
    expect(h.runNow).not.toHaveBeenCalled()
    expect(h.wd.getStatus().count).toBe(0)
  })

  it('长间隔配置走 interval*2：300s 间隔 → 宽限 600s（90s 下限不生效）', () => {
    const h = setup({ desired: 'running', nextPollAt: iso(T0) }, { intervalMs: 300_000 })
    h.wd.start()

    h.clock.nowMs = T0 + 599_000
    runOneCheck(h)
    expect(h.runNow).not.toHaveBeenCalled()

    h.clock.nowMs = T0 + 601_000
    runOneCheck(h)
    expect(h.runNow).toHaveBeenCalledTimes(1)
  })
})

describe('EngineWatchdog：60s 刷屏抑制', () => {
  it('持续超期：30s 后的重复触发只计数不 log；距上次详情 ≥60s 再 log 一次', () => {
    const h = setup({ desired: 'running', nextPollAt: iso(T0) }, { intervalMs: 60_000 })
    h.wd.start()

    // t=121s：首次触发 → log #1
    h.clock.nowMs = T0 + 121_000
    runOneCheck(h)
    expect(h.errors).toHaveLength(1)
    expect(h.wd.getStatus().count).toBe(1)

    // t=151s（距上次详情 30s < 60s）：触发但不 log
    h.clock.nowMs = T0 + 151_000
    runOneCheck(h)
    expect(h.errors).toHaveLength(1)
    expect(h.wd.getStatus().count).toBe(2)
    expect(h.runNow).toHaveBeenCalledTimes(2) // 抑制的只是日志，自愈动作照做

    // t=182s（距首次详情 61s ≥ 60s）：再 log
    h.clock.nowMs = T0 + 182_000
    runOneCheck(h)
    expect(h.errors).toHaveLength(2)
    expect(h.wd.getStatus()).toEqual({ lastTriggeredAt: iso(T0 + 182_000), count: 3 })
    expect(h.errors[1]).toContain('trigger #3')
  })
})

describe('EngineWatchdog：生命周期与容错', () => {
  it('start 排 30s 检查周期（对齐 poller 重排模式）；幂等不双排', () => {
    const h = setup({ desired: 'running', nextPollAt: null })
    h.wd.start()
    expect(h.clock.pending).not.toBeNull()
    expect(h.clock.pending?.delayMs).toBe(WATCHDOG_CHECK_INTERVAL_MS)

    h.wd.start() // 幂等：fake 的「未清就再排」守卫会在此抛错（若双排）
    expect(h.clock.pending?.delayMs).toBe(WATCHDOG_CHECK_INTERVAL_MS)
  })

  it('检查后自循环重排（fire 后槽里是下一个周期）；持续运行多轮', () => {
    const h = setup({ desired: 'running', nextPollAt: iso(T0) }, { intervalMs: 60_000 })
    h.wd.start()
    for (let i = 0; i < 3; i++) {
      runOneCheck(h) // 每轮 fire 后必须已重排，否则下一轮 fire 抛 nothing pending
      expect(h.clock.pending).not.toBeNull()
    }
    expect(h.runNow).not.toHaveBeenCalled() // 宽限内：只循环不触发
  })

  it('stop 清掉待定计时器；之后再无检查（幂等）', () => {
    const h = setup({ desired: 'running', nextPollAt: iso(T0) }, { intervalMs: 60_000 })
    h.wd.start()
    h.wd.stop()
    expect(h.clock.pending).toBeNull()
    expect(h.clock.clearedCount).toBe(1)
    expect(h.wd.isRunning).toBe(false)

    h.wd.stop() // 幂等
    expect(h.clock.clearedCount).toBe(1)
  })

  it('runNow 同步抛错：记 error 不上抛，循环继续（下一周期照常触发）', () => {
    const h = setup(
      { desired: 'running', nextPollAt: iso(T0) },
      {
        intervalMs: 60_000,
        runNowImpl: () => {
          throw new Error('engine exploded')
        }
      }
    )
    h.wd.start()
    h.clock.nowMs = T0 + 121_000
    expect(() => runOneCheck(h)).not.toThrow()
    expect(h.errors.some((m) => m.includes('runNow() threw') && m.includes('engine exploded'))).toBe(
      true
    )
    // 循环未被破坏：下一周期照常重排并可再次触发
    h.clock.nowMs = T0 + 151_000
    runOneCheck(h)
    expect(h.wd.getStatus().count).toBe(2)
  })

  it('runNow 异步 reject：兜住并记日志（无 unhandled rejection）', async () => {
    const h = setup(
      { desired: 'running', nextPollAt: iso(T0) },
      {
        intervalMs: 60_000,
        runNowImpl: () => Promise.reject(new Error('async boom'))
      }
    )
    h.wd.start()
    h.clock.nowMs = T0 + 121_000
    runOneCheck(h)
    await new Promise((resolve) => setTimeout(resolve, 0)) // 等 microtask 队列跑完
    expect(h.errors.some((m) => m.includes('async boom'))).toBe(true)
  })

  it('getStatus 抛错：check 记日志不破坏循环', () => {
    const clock = new FakeClock(T0)
    let status: EngineStatusLike | Error = { desired: 'running', nextPollAt: iso(T0) }
    const logs: { level: 'info' | 'warn' | 'error'; msg: string }[] = []
    const wd = new EngineWatchdog({
      getStatus: () => {
        if (status instanceof Error) throw status
        return status
      },
      runNow: () => {},
      getIntervalMs: () => 60_000,
      log: {
        info: (msg) => logs.push({ level: 'info', msg }),
        warn: (msg) => logs.push({ level: 'warn', msg }),
        error: (msg) => logs.push({ level: 'error', msg })
      },
      now: clock.now,
      setTimer: clock.setTimer
    })
    wd.start()
    status = new Error('status unavailable')
    clock.nowMs = T0 + 121_000
    expect(() => clock.fire()).not.toThrow()
    expect(logs.some((l) => l.level === 'error' && l.msg.includes('watchdog check threw'))).toBe(
      true
    )
    expect(clock.pending).not.toBeNull() // 循环继续
  })
})
