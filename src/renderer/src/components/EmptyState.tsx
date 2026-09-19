/**
 * 统一空态（D8 ⑤）：雷达插画 + 引导文案 + 可选操作。
 * HitList / LogView / 今日回顾共用，保证空态语言一致。
 */
import type { ReactNode } from 'react'
import { IllustrationRadar } from './icons'

export function EmptyState(props: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <IllustrationRadar size={44} className="empty-illus" />
      <div className="empty-state-title">{props.title}</div>
      {props.hint != null && <div className="empty-state-hint">{props.hint}</div>}
      {props.action != null && <div className="empty-state-action">{props.action}</div>}
    </div>
  )
}
