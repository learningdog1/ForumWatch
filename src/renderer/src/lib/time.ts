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
