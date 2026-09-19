/**
 * 时间格式化（纯函数）：本地 HH:mm:ss + 中文相对时间（"38 秒后" / "12 秒前"）。
 * 相对时间需要每秒重算，由 useNow 提供跳动的当前时刻。
 */

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 本地时区 HH:mm:ss；空/无效给 "—" */
export function formatClock(iso: string | null | undefined): string {
  if (iso == null || iso === '') return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

function humanizeDuration(absSec: number): string {
  if (absSec < 60) return `${absSec} 秒`
  const minutes = Math.round(absSec / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} 小时`
  return `${Math.round(hours / 24)} 天`
}

/**
 * 相对时间：未来 → "N 秒/分钟/小时 后"；过去 → "… 前"；±3 秒内 → 即将/刚刚。
 * 空 / 无效给 "—"（nextPollAt 为 null 且未暂停等场景）。
 */
export function formatRelative(iso: string | null | undefined, nowMs: number): string {
  if (iso == null || iso === '') return '—'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  const diffSec = Math.round((t - nowMs) / 1000)
  if (Math.abs(diffSec) < 3) return diffSec >= 0 ? '即将' : '刚刚'
  return `${humanizeDuration(Math.abs(diffSec))}${diffSec > 0 ? '后' : '前'}`
}

/** 剩余毫秒 → "mm:ss"（来源退避倒计时用）；已到期/无效给 null */
export function formatCountdown(remainMs: number): string | null {
  if (!Number.isFinite(remainMs) || remainMs <= 0) return null
  const totalSec = Math.ceil(remainMs / 1000)
  if (totalSec >= 3600) {
    return `${Math.floor(totalSec / 3600)}:${pad2(Math.floor((totalSec % 3600) / 60))}:${pad2(totalSec % 60)}`
  }
  return `${pad2(Math.floor(totalSec / 60))}:${pad2(totalSec % 60)}`
}

/** 本地时区 'YYYY-MM-DD'（日报日期口径与主进程一致：绝不用 ISO slice） */
export function localDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 'YYYY-MM-DD' → 展示标签："今天 · 09-19 周五" 这类；无效原样返回 */
export function formatDayLabel(date: string, todayStr: string): string {
  const d = new Date(`${date}T00:00:00`)
  if (Number.isNaN(d.getTime())) return date
  const weekdays = ['日', '一', '二', '三', '四', '五', '六']
  const md = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  const weekday = `周${weekdays[d.getDay()]}` as const
  if (date === todayStr) return `今天 · ${md} ${weekday}`
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  if (date === localDate(yesterday)) return `昨天 · ${md} ${weekday}`
  return `${md} ${weekday}`
}
