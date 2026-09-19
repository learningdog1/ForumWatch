/**
 * 免打扰时段 + 摘要模式的纯时间逻辑内核（第六轮 R6-W1q，DEC-11）。
 *
 * 只做区间判定与时刻计算：零 electron、零 IO，时钟由调用方注入（engine 用
 * deps.now 的假时钟模式单测；本模块只收 Date）。引擎侧的队列/挂起/重试语义
 * 全在 engine.ts（deferredHits），本模块不感知队列存在。
 *
 * 区间语义（半开区间 [start, end)，本地时区）：
 * - 恰在 start 时刻 → 窗内（true）；恰在 end 时刻 → 窗外（false）。免打扰从
 *   start:00 起效、到 end:00 失效——边界不重叠、判定无歧义。
 * - start < end：普通时段窗（09:00-17:00）。
 * - start > end：跨午夜窗（23:00-08:00 = 当日 23:00 → 次日 08:00）。
 * - start === end：**定死恒 false**（空区间）——用户把起止设成同值若解释成
 *   全天会变成永久静默，意外后果太重；按空区间处理让配置错误自然失效。
 *
 * decideNotifyAction 的分派（engine processHit 推送前与 flush due 判定共用）：
 * - digest 模式：恒 defer（摘要模式不即时推任何东西）；nextFlushAt = 下一次
 *   digest 批边界（lastDigestFlushAt + interval，由 engine 维护并传入；未开过
 *   批窗口时 null）。**quietHours 不与 digest 叠加**——摘要模式本身已是低打扰
 *   形态，digest 计时器是唯一释放闸。
 * - instant 模式：quietHours.enabled 且当前时刻窗内 → defer（reason=
 *   'quiet-hours'，nextFlushAt = 窗尾 epoch ms）；否则不 defer（原即时路径）。
 */

import type { NotifyConfig } from '../../shared/types'

/** decideNotifyAction 的判定结果（engine 据此走挂起或即时路径） */
export interface NotifyAction {
  /** true = 本次命中不即时推送（进挂起队列） */
  defer: boolean
  /** 判定原因：'instant' 即时 / 'quiet-hours' 免打扰窗内 / 'digest' 摘要模式 */
  reason: 'instant' | 'quiet-hours' | 'digest'
  /**
   * 下一次可冲刷时刻（epoch ms）：quiet-hours = 窗尾；digest = 下一批边界。
   * null = 不挂起（instant）或 digest 尚无批窗口起点（engine 未传 lastFlushAt）。
   */
  nextFlushAt: number | null
}

/**
 * 'HH:MM' → 当日分钟数（0-1439）。sanitize 保证配置侧恒为合法两位 HH:MM；
 * 这里防御式容忍一位时（'9:30'），非法（格式/越界）返回 null——调用方按
 * "无法判定"处理（inQuietHours 对 null 恒 false = 不静默，宁可放行）。
 */
export function hhmmToMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (m === null) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** 当前时刻是否在 [start, end) 免打扰窗内（本地时区；跨午夜/不跨/同值语义见文件头） */
export function inQuietHours(hhmm: string, start: string, end: string): boolean {
  const t = hhmmToMinutes(hhmm)
  const s = hhmmToMinutes(start)
  const e = hhmmToMinutes(end)
  if (t === null || s === null || e === null) return false
  if (s === e) return false // 同值 = 空区间，恒不静默（见文件头）
  if (s < e) return t >= s && t < e
  return t >= s || t < e // 跨午夜：[start,24:00) ∪ [00:00,end)
}

/**
 * 若当前处于免打扰窗内，返回窗尾的 epoch ms；否则 null。
 * 跨午夜窗的窗尾在"明天"（23:30 挂起 → 次日 08:00）；午夜后挂在当日尾
 * （02:00 → 当日 08:00）。用"今日候选时刻 <= now 则进一天"归一两分支，
 * 不依赖调用方先判断自己处在跨午夜窗的前半还是后半。
 */
export function nextQuietEnd(now: Date, start: string, end: string): number | null {
  const pad2 = (n: number): string => String(n).padStart(2, '0')
  const hhmm = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`
  if (!inQuietHours(hhmm, start, end)) return null
  const e = hhmmToMinutes(end)
  if (e === null) return null
  const candidate = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    Math.floor(e / 60),
    e % 60,
    0,
    0
  )
  // 窗内此刻必早于窗尾；candidate <= now 只会发生在跨午夜窗的午夜前半段
  // （尾在明天），推进一天。
  if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1)
  return candidate.getTime()
}

/**
 * 下一次 digest 批冲刷时刻：lastFlushAt + interval 分钟（interval 防御式钳 >= 1，
 * sanitize 已保证 [1,120]）。engine 维护 lastDigestFlushAt（批首条挂起时刻或
 * 上次冲刷时刻），批边界由此纯函数唯一计算。
 */
export function nextDigestFlush(lastFlushAt: number, intervalMin: number): number {
  return lastFlushAt + Math.max(1, intervalMin) * 60_000
}

/**
 * 推送策略判定（engine 每次命中推送前 + 挂起队列 due 检查共用；见文件头分派）。
 * @param cfg 配置的 notify 段
 * @param now 当前时刻（时钟由调用方注入）
 * @param lastFlushAt engine 维护的 digest 批窗口锚点（上次冲刷或本批首条挂起时刻）；
 *        null = 尚未开过批窗口（digest 的 nextFlushAt 给 null，engine 侧自行起锚）
 */
export function decideNotifyAction(
  cfg: NotifyConfig,
  now: Date,
  lastFlushAt: number | null = null
): NotifyAction {
  if (cfg.mode === 'digest') {
    return {
      defer: true,
      reason: 'digest',
      nextFlushAt: lastFlushAt !== null ? nextDigestFlush(lastFlushAt, cfg.digestIntervalMin) : null
    }
  }
  const qh = cfg.quietHours
  if (qh.enabled) {
    const pad2 = (n: number): string => String(n).padStart(2, '0')
    const hhmm = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`
    if (inQuietHours(hhmm, qh.startHHMM, qh.endHHMM)) {
      return { defer: true, reason: 'quiet-hours', nextFlushAt: nextQuietEnd(now, qh.startHHMM, qh.endHHMM) }
    }
  }
  return { defer: false, reason: 'instant', nextFlushAt: null }
}
