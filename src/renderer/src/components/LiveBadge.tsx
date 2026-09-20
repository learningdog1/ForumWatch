/**
 * 实时徽标（R10 共用组件，REDESIGN §8-B：标「实时」必须有据）。
 * - live=自动刷新进行中（绿）；paused=悬停/筛选/手动暂停（琥珀）；
 *   disk=落盘文件数据面（中性灰，去向页历史日——静态文件，不假装实时）；
 * - asOf 提供时显示「数据截至 HH:mm:ss」，暂停期常驻标注；
 * - 纯色点 + 文字，无动画；role="status" 不抢焦点。
 */
import { formatClock } from '../lib/time'

interface LiveBadgeProps {
  state: 'live' | 'paused' | 'disk'
  /** 覆盖默认文案（默认：实时 / 已暂停 / 落盘文件） */
  label?: string
  /** 数据截至时间（ISO 字符串） */
  asOf?: string | null
}

export function LiveBadge(props: LiveBadgeProps) {
  const text =
    props.label ?? (props.state === 'live' ? '实时' : props.state === 'paused' ? '已暂停' : '落盘文件')
  return (
    <span className={`livebadge ${props.state}`} role="status">
      <span className="livebadge-dot" />
      {text}
      {props.asOf != null && props.asOf !== '' && (
        <span className="asof">数据截至 {formatClock(props.asOf)}</span>
      )}
    </span>
  )
}
