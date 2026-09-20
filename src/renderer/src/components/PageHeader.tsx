/**
 * 页头（R10 共用组件，R12 版式在 primitives）：页题 26/700 + 副题 14/text-2 +
 * 「更新于」时间戳与 stale 检测（字号/色档全由样式层给，组件不内联）。
 * - updatedAt 为 null/undefined 表示该页尚无数据，不渲染更新行。
 * - 超过 staleAfterMs（默认 90s，监控台口径）未更新 → 琥珀显式标注
 *   「· 可能滞后」（REDESIGN §8-B：标实时必有据，不假装实时）。
 * - stale=false 可整页关闭 stale 判定（监控台在已暂停/退避时用：低频事件属正常，
 *   不误报滞后——dashboard.md §3.1）。
 * - 相对新鲜度每秒重算由 useNow 驱动（窗口隐藏时自动停跳）。
 */
import type { ReactNode } from 'react'
import { useNow } from '../hooks/useNow'
import { formatClock } from '../lib/time'

interface PageHeaderProps {
  /** 页题（h1，每页唯一） */
  title: string
  /** 副题：一句话说清本页价值 */
  subtitle?: string
  /** 数据更新时间（ISO 字符串）；null=尚无数据 */
  updatedAt?: string | null
  /** 判定为 stale 的阈值毫秒数，默认 90s */
  staleAfterMs?: number
  /** 是否启用 stale 判定（默认启用）；暂停/退避等低频场景传 false，手动刷新档（历史命中）也传 false */
  stale?: boolean
  /** 「更新于」的 title 文案；缺省显示 updatedAt 原文（历史页传语义说明「两个数据面…」） */
  updatedTitle?: string
  /** 页级隐藏（keep-alive 不活跃）时停跳 useNow，隐藏页不每秒重渲染 */
  paused?: boolean
  /** 右侧操作区（刷新按钮、实时徽标等） */
  actions?: ReactNode
}

export function PageHeader(props: PageHeaderProps) {
  const now = useNow(1000, props.paused === true)
  const staleAfterMs = props.staleAfterMs ?? 90_000
  const updatedAt = props.updatedAt
  const stale =
    props.stale !== false &&
    updatedAt != null &&
    updatedAt !== '' &&
    now - Date.parse(updatedAt) > staleAfterMs
  const staleSec = Math.round(staleAfterMs / 1000)

  return (
    <header className="pagehead">
      <div className="pagehead-main">
        <h1 className="page-title">{props.title}</h1>
        {props.subtitle != null && <div className="page-subtitle">{props.subtitle}</div>}
        {updatedAt != null && updatedAt !== '' && (
          <div
            className={`page-updated${stale ? ' stale' : ''}`}
            title={
              stale
                ? `超过 ${staleSec} 秒未收到引擎事件，数据可能滞后；引擎仍在后台轮询`
                : (props.updatedTitle ?? updatedAt)
            }
          >
            {stale
              ? `更新于 ${formatClock(updatedAt)} · 可能滞后`
              : `更新于 ${formatClock(updatedAt)}`}
          </div>
        )}
      </div>
      {props.actions != null && <div className="pagehead-actions">{props.actions}</div>}
    </header>
  )
}
