/**
 * 统一错误条（R10 共用组件，REDESIGN §6.3：错误是一等公民）。
 * - 加载失败 ≠ 空数据：错误条叠在数据面顶部，旧数据保留不替换；
 * - role="alert" 即时播报；onRetry 提供时渲染「重试」按钮；
 * - detail：可选第二行 12px 弱一档原文（如 IPC 错误信息，dispositions.md §2.5）；
 * - extra：可选补充动作（渲染在重试之后，如历史日错误条的「回实时」副链接）。
 */
import type { ReactNode } from 'react'
import { IconRefresh, IconX } from './icons'

interface ErrorBarProps {
  /** 面向用户的一句话失败原因（不说技术黑话） */
  message: string
  /** 失败原文（IPC error 等）；单独一行小字 */
  detail?: string
  /** 重试回调；缺省不渲染重试按钮 */
  onRetry?: () => void
  /** 重试按钮文案，默认「重试」 */
  retryLabel?: string
  /** 重试之外的补充动作（副链接等） */
  extra?: ReactNode
}

export function ErrorBar(props: ErrorBarProps) {
  return (
    <div className="errorbar" role="alert">
      <IconX size={12} />
      <span className="msg">
        {props.message}
        {props.detail != null && props.detail !== '' && (
          <span className="errorbar-detail">{props.detail}</span>
        )}
      </span>
      {props.onRetry != null && (
        <button type="button" className="btn" onClick={props.onRetry}>
          <IconRefresh size={12} />
          {props.retryLabel ?? '重试'}
        </button>
      )}
      {props.extra}
    </div>
  )
}
