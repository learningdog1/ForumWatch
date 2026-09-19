import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeBackoffMs, MAX_BACKOFF_MS, PollScheduler } from './poller'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.restoreAllMocks() // 还原 Math.random spy
  vi.useRealTimers()
})

describe('computeBackoffMs', () => {
  it('n=0 → base', () => {
    expect(computeBackoffMs(0, 60_000)).toBe(60_000)
  })

  it('每次失败翻倍（2^n 递增）', () => {
    expect(computeBackoffMs(1, 60_000)).toBe(120_000)
    expect(computeBackoffMs(2, 60_000)).toBe(240_000)
    expect(computeBackoffMs(3, 60_000)).toBe(480_000)
  })

  it('封顶 30 分钟', () => {
    expect(MAX_BACKOFF_MS).toBe(1_800_000)
    expect(computeBackoffMs(5, 60_000)).toBe(1_800_000) // 1_920_000 被封顶
    expect(computeBackoffMs(50, 60_000)).toBe(1_800_000)
    expect(computeBackoffMs(3, 3_600_000)).toBe(1_800_000) // base 本身超帽
  })

  it('负数按 0 处理', () => {
    expect(computeBackoffMs(-3, 60_000)).toBe(60_000)
  })
})

describe('PollScheduler', () => {
  it('start 后 interval 到点触发 onTick，settle 后重排下一轮', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5) // 抖动系数 = 1，恰好 interval
    const onTick = vi.fn(async () => {})
    const scheduler = new PollScheduler({ intervalSec: 60, onTick })

    scheduler.start()
    expect(scheduler.isRunning).toBe(true)
    expect(onTick).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(onTick).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(onTick).toHaveBeenCalledTimes(2)
  })

  it('onTick 未完成时不重叠触发；完成后才从当前时刻重排', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const onTick = vi.fn(() => gate)
    const scheduler = new PollScheduler({ intervalSec: 60, onTick })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onTick).toHaveBeenCalledTimes(1)

    // 在途期间时间流逝数个周期也不得重叠触发
    await vi.advanceTimersByTimeAsync(300_000)
    expect(onTick).toHaveBeenCalledTimes(1)

    release()
    await vi.advanceTimersByTimeAsync(0) // flush microtasks → settle → 重排

    await vi.advanceTimersByTimeAsync(59_999)
    expect(onTick).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(onTick).toHaveBeenCalledTimes(2)
  })

  it('抖动下界：Math.random()=0 → interval * (1 - jitter)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const onTick = vi.fn(async () => {})
    const onScheduled = vi.fn()
    const t0 = Date.now()
    const scheduler = new PollScheduler({ intervalSec: 60, onTick, onScheduled })

    scheduler.start()
    expect(onScheduled).toHaveBeenCalledTimes(1)
    expect(onScheduled).toHaveBeenCalledWith(t0 + 48_000) // 60s * 0.8

    await vi.advanceTimersByTimeAsync(47_999)
    expect(onTick).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onTick).toHaveBeenCalledTimes(1)
  })

  it('抖动上界：Math.random()→1 → 恰好 interval * (1 + jitter)，不超过', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999) // 0.999 < 1，更严格
    const onTick = vi.fn(async () => {})
    const onScheduled = vi.fn()
    const t0 = Date.now()
    const scheduler = new PollScheduler({ intervalSec: 60, onTick, onScheduled })

    scheduler.start()
    const nextPollAt = onScheduled.mock.calls[0][0]
    expect(nextPollAt).toBeLessThanOrEqual(t0 + 72_000) // 不超过 60s * 1.2
    expect(nextPollAt).toBe(t0 + 71_976) // 60_000 * (1 + 0.998 * 0.2)

    await vi.advanceTimersByTimeAsync(72_000)
    expect(onTick).toHaveBeenCalledTimes(1)
  })

  it('intervalSec 低于 minIntervalSec（默认 15）被钳制', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const onTick = vi.fn(async () => {})
    const onScheduled = vi.fn()
    const t0 = Date.now()
    const scheduler = new PollScheduler({ intervalSec: 5, onTick, onScheduled })

    scheduler.start()
    expect(onScheduled).toHaveBeenCalledWith(t0 + 15_000)

    await vi.advanceTimersByTimeAsync(14_999)
    expect(onTick).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onTick).toHaveBeenCalledTimes(1)
  })

  it('runNow：取消待定计时立即执行，并从当前时刻重排', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const onTick = vi.fn(async () => {})
    const scheduler = new PollScheduler({ intervalSec: 60, onTick })

    scheduler.start()
    scheduler.runNow() // 60s 待定计时被取消，立即执行
    expect(onTick).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(59_999) // 原 60s 计时不应再触发
    expect(onTick).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1) // runNow 后重排的 60s 到点
    expect(onTick).toHaveBeenCalledTimes(2)
  })

  it('tick 在途时 runNow 被忽略', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const onTick = vi.fn(() => gate)
    const scheduler = new PollScheduler({ intervalSec: 60, onTick })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(60_000)
    scheduler.runNow()
    scheduler.runNow()
    expect(onTick).toHaveBeenCalledTimes(1)

    release()
    await vi.advanceTimersByTimeAsync(0)
  })

  it('stop：取消待定计时，此后不再触发，isRunning=false', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const onTick = vi.fn(async () => {})
    const scheduler = new PollScheduler({ intervalSec: 60, onTick })

    scheduler.start()
    scheduler.stop() // 尚未到点
    expect(scheduler.isRunning).toBe(false)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(onTick).not.toHaveBeenCalled()
  })

  it('stop 后在途 tick 结束不再重排', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const onTick = vi.fn(() => gate)
    const scheduler = new PollScheduler({ intervalSec: 60, onTick })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(60_000)
    scheduler.stop()
    release()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(onTick).toHaveBeenCalledTimes(1)
    expect(scheduler.isRunning).toBe(false)
  })

  it('setIntervalSec 只影响下一次排程', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const onTick = vi.fn(async () => {})
    const onScheduled = vi.fn()
    const scheduler = new PollScheduler({ intervalSec: 60, onTick, onScheduled })

    const t0 = Date.now()
    scheduler.start()
    expect(onScheduled).toHaveBeenLastCalledWith(t0 + 60_000)

    scheduler.setIntervalSec(120) // 已排定的 60s 计时不受影响，仍按 60s 到点
    await vi.advanceTimersByTimeAsync(59_999)
    expect(onTick).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onTick).toHaveBeenCalledTimes(1) // 第一轮按旧值 60s 触发
    await vi.advanceTimersByTimeAsync(0) // settle → 重排，用新值 120s
    expect(onScheduled).toHaveBeenLastCalledWith(t0 + 60_000 + 120_000)
  })
})
