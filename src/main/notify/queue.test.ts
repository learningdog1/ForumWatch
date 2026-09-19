/**
 * R6-W1q 纯时间逻辑单测：免打扰区间矩阵（跨午夜/不跨/边界/同值）、窗尾计算、
 * digest 边界、decideNotifyAction 分派。全部用显式构造的本地时区 Date（不依赖
 * 真实时区跑测机器——断言只看小时分钟语义与 epoch 差值）。
 */
import { describe, expect, it } from 'vitest'
import {
  decideNotifyAction,
  hhmmToMinutes,
  inQuietHours,
  nextDigestFlush,
  nextQuietEnd
} from './queue'
import type { NotifyConfig } from '../../shared/types'

/** 本地时区某日的某时刻（省得每个用例手写 new Date(y, m, d, h, min)） */
function at(h: number, m: number, day = 10): Date {
  return new Date(2026, 8, day, h, m, 0, 0) // 2026-09-10（本地）
}

function notifyCfg(overrides: Partial<NotifyConfig> = {}): NotifyConfig {
  const base: NotifyConfig = {
    mode: 'instant',
    digestIntervalMin: 15,
    quietHours: { enabled: false, startHHMM: '23:00', endHHMM: '08:00' }
  }
  return {
    ...base,
    ...overrides,
    quietHours: { ...base.quietHours, ...(overrides.quietHours ?? {}) }
  }
}

describe('hhmmToMinutes', () => {
  it('合法 HH:MM → 当日分钟数（容忍一位时）', () => {
    expect(hhmmToMinutes('00:00')).toBe(0)
    expect(hhmmToMinutes('23:59')).toBe(23 * 60 + 59)
    expect(hhmmToMinutes('08:05')).toBe(8 * 60 + 5)
    expect(hhmmToMinutes('9:30')).toBe(9 * 60 + 30)
  })
  it('非法输入 → null（格式 / 越界 / 非串垃圾）', () => {
    expect(hhmmToMinutes('24:00')).toBeNull()
    expect(hhmmToMinutes('12:60')).toBeNull()
    expect(hhmmToMinutes('1230')).toBeNull()
    expect(hhmmToMinutes('')).toBeNull()
    expect(hhmmToMinutes('ab:cd')).toBeNull()
  })
})

describe('inQuietHours（区间矩阵）', () => {
  // 跨午夜 23:00-08:00
  it('跨午夜窗：午夜后段窗内（02:00 / 07:59）', () => {
    expect(inQuietHours('02:00', '23:00', '08:00')).toBe(true)
    expect(inQuietHours('07:59', '23:00', '08:00')).toBe(true)
  })
  it('跨午夜窗：午夜前段窗内（23:00 / 23:59）', () => {
    expect(inQuietHours('23:00', '23:00', '08:00')).toBe(true)
    expect(inQuietHours('23:59', '23:00', '08:00')).toBe(true)
  })
  it('跨午夜窗：窗外（中午 12:00 / 早 08:00 后一刻）', () => {
    expect(inQuietHours('12:00', '23:00', '08:00')).toBe(false)
    expect(inQuietHours('08:00', '23:00', '08:00')).toBe(false)
    expect(inQuietHours('22:59', '23:00', '08:00')).toBe(false)
  })
  // 不跨午夜 09:00-17:00
  it('不跨午夜窗：窗内（09:00 / 12:30 / 16:59）', () => {
    expect(inQuietHours('09:00', '09:00', '17:00')).toBe(true)
    expect(inQuietHours('12:30', '09:00', '17:00')).toBe(true)
    expect(inQuietHours('16:59', '09:00', '17:00')).toBe(true)
  })
  it('不跨午夜窗：窗外（08:59 / 17:00 / 17:01）', () => {
    expect(inQuietHours('08:59', '09:00', '17:00')).toBe(false)
    expect(inQuietHours('17:00', '09:00', '17:00')).toBe(false)
    expect(inQuietHours('17:01', '09:00', '17:00')).toBe(false)
  })
  // 边界（半开区间的两端）
  it('边界：恰在 start → 窗内；恰在 end → 窗外（半开 [start, end)）', () => {
    expect(inQuietHours('13:00', '13:00', '15:00')).toBe(true)
    expect(inQuietHours('15:00', '13:00', '15:00')).toBe(false)
  })
  // 同值区间
  it('start === end：恒 false（空区间，同值配置不得变成永久静默）', () => {
    expect(inQuietHours('02:00', '08:00', '08:00')).toBe(false)
    expect(inQuietHours('08:00', '08:00', '08:00')).toBe(false)
    expect(inQuietHours('23:30', '23:00', '23:00')).toBe(false)
  })
  // 近全天窗
  it('00:00-23:59 近全天窗：00:00 与 23:58 均窗内（23:59 = end 边界，窗外）', () => {
    expect(inQuietHours('00:00', '00:00', '23:59')).toBe(true)
    expect(inQuietHours('23:58', '00:00', '23:59')).toBe(true)
    expect(inQuietHours('23:59', '00:00', '23:59')).toBe(false)
    expect(inQuietHours('12:00', '00:00', '23:59')).toBe(true)
  })
  it('非法输入 → 恒 false（宁可放行不静默）', () => {
    expect(inQuietHours('25:00', '23:00', '08:00')).toBe(false)
    expect(inQuietHours('12:00', 'bad', '08:00')).toBe(false)
    expect(inQuietHours('12:00', '23:00', 'nope')).toBe(false)
  })
})

describe('nextQuietEnd', () => {
  it('跨午夜窗午夜后段：02:00 → 当日 08:00 的 epoch', () => {
    const now = at(2, 0)
    expect(nextQuietEnd(now, '23:00', '08:00')).toBe(at(8, 0).getTime())
  })
  it('跨午夜窗午夜前段：23:30 → 次日 08:00 的 epoch', () => {
    const now = at(23, 30)
    expect(nextQuietEnd(now, '23:00', '08:00')).toBe(at(8, 0, 11).getTime())
  })
  it('不跨午夜窗：14:00（13:00-15:00）→ 当日 15:00', () => {
    expect(nextQuietEnd(at(14, 0), '13:00', '15:00')).toBe(at(15, 0).getTime())
  })
  it('恰在 start（窗内）→ 当日窗尾；恰在 end（窗外）→ null', () => {
    expect(nextQuietEnd(at(13, 0), '13:00', '15:00')).toBe(at(15, 0).getTime())
    expect(nextQuietEnd(at(15, 0), '13:00', '15:00')).toBeNull()
  })
  it('窗外时刻 → null', () => {
    expect(nextQuietEnd(at(12, 0), '13:00', '15:00')).toBeNull()
    expect(nextQuietEnd(at(12, 0), '23:00', '08:00')).toBeNull()
  })
})

describe('nextDigestFlush', () => {
  it('lastFlushAt + interval 分钟（15min）', () => {
    expect(nextDigestFlush(1_000_000, 15)).toBe(1_000_000 + 15 * 60_000)
  })
  it('interval 防御式钳 >= 1（0/负数按 1 分钟）', () => {
    expect(nextDigestFlush(1_000_000, 0)).toBe(1_000_000 + 60_000)
    expect(nextDigestFlush(1_000_000, -5)).toBe(1_000_000 + 60_000)
  })
})

describe('decideNotifyAction', () => {
  it('instant + quietHours 关：不挂起（默认配置 = 旧行为）', () => {
    expect(decideNotifyAction(notifyCfg(), at(23, 30))).toEqual({
      defer: false,
      reason: 'instant',
      nextFlushAt: null
    })
  })
  it('instant + quiet 开 + 窗外：不挂起', () => {
    const cfg = notifyCfg({ quietHours: { enabled: true, startHHMM: '23:00', endHHMM: '08:00' } })
    expect(decideNotifyAction(cfg, at(12, 0))).toEqual({
      defer: false,
      reason: 'instant',
      nextFlushAt: null
    })
  })
  it('instant + quiet 开 + 窗内：挂起，nextFlushAt = 窗尾', () => {
    const cfg = notifyCfg({ quietHours: { enabled: true, startHHMM: '23:00', endHHMM: '08:00' } })
    expect(decideNotifyAction(cfg, at(23, 30))).toEqual({
      defer: true,
      reason: 'quiet-hours',
      nextFlushAt: at(8, 0, 11).getTime()
    })
  })
  it('instant + quiet 开 + 恰在 end：不挂起（半开区间）', () => {
    const cfg = notifyCfg({ quietHours: { enabled: true, startHHMM: '23:00', endHHMM: '08:00' } })
    expect(decideNotifyAction(cfg, at(8, 0)).defer).toBe(false)
  })
  it('digest：恒挂起，nextFlushAt = lastFlushAt + interval', () => {
    const cfg = notifyCfg({ mode: 'digest' })
    const last = at(10, 0).getTime()
    expect(decideNotifyAction(cfg, at(10, 5), last)).toEqual({
      defer: true,
      reason: 'digest',
      nextFlushAt: at(10, 15).getTime()
    })
  })
  it('digest + 未传 lastFlushAt：nextFlushAt = null（引擎尚未开批窗口）', () => {
    const cfg = notifyCfg({ mode: 'digest' })
    expect(decideNotifyAction(cfg, at(10, 5))).toEqual({
      defer: true,
      reason: 'digest',
      nextFlushAt: null
    })
  })
  it('digest + quiet 开 + 窗内：仍是 digest（quietHours 不与摘要叠加）', () => {
    const cfg = notifyCfg({
      mode: 'digest',
      quietHours: { enabled: true, startHHMM: '23:00', endHHMM: '08:00' }
    })
    const action = decideNotifyAction(cfg, at(2, 0), at(1, 0).getTime())
    expect(action.reason).toBe('digest')
    expect(action.defer).toBe(true)
    expect(action.nextFlushAt).toBe(at(1, 15).getTime()) // digest 边界，不是 08:00 窗尾
  })
})
