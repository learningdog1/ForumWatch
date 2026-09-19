/**
 * 内联 SVG 图标系统（D8 ①）：统一 stroke 1.5 / currentColor / 16 与 20 两档
 * size，16×16 设计栅格（20 档按 viewBox 等比放大）。替换历史 emoji。
 *
 * 约定：
 * - 线性图标默认 fill="none" stroke="currentColor"；个别实心件（播放三角、
 *   雷达中心点）显式 fill + stroke="none"。
 * - 雷达族的信号点用 var(--accent)——图标随主题换色，无需 per-call 传色。
 * - 全部 aria-hidden：文本标签由相邻文案提供。
 */
import type { CSSProperties, SVGProps } from 'react'

export interface IconProps {
  /** 渲染尺寸（px），默认 16；20 为第二档 */
  size?: number
  className?: string
  style?: CSSProperties
}

function svgProps(props: IconProps): SVGProps<SVGSVGElement> {
  const size = props.size ?? 16
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    className: props.className,
    style: props.style,
    'aria-hidden': true
  }
}

/* ── 侧栏 tab ─────────────────────────────────────────────────── */

/** 监控台：心跳脉冲线 */
export function IconPulse(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M1.5 8.5h3L6.3 4l3.4 8 1.8-3.5h3" />
    </svg>
  )
}

/** 今日回顾：文档 */
export function IconReport(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M4 1.5h5l3 3v10H4z" />
      <path d="M9 1.5v3h3" />
      <path d="M6 8h4M6 10.5h4" />
    </svg>
  )
}

/** 设置：滑杆 */
export function IconSliders(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M2 4.5h3.5M9 4.5h5M2 8h6M11.75 8h2.25M2 11.5h3.5M9 11.5h5" />
      <circle cx="7.25" cy="4.5" r="1.75" />
      <circle cx="10" cy="8" r="1.75" />
      <circle cx="7.25" cy="11.5" r="1.75" />
    </svg>
  )
}

/* ── 品牌 / 雷达族（与 design/icon-simple.svg 同源：环 + 针 + 信号点） ── */

/** 品牌 / 状态雷达小图 */
export function IconRadar(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle cx="8" cy="8.5" r="6" />
      <circle cx="8" cy="8.5" r="3.1" />
      <path d="M8 8.5 12.1 5" />
      <circle cx="8" cy="8.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="11.4" cy="3.9" r="1.3" fill="var(--accent)" stroke="none" />
    </svg>
  )
}

/** 空态插画：雷达扫描（64 档，环线跟随 text-3、信号点 accent） */
export function IllustrationRadar(props: IconProps) {
  const size = props.size ?? 64
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
      style={props.style}
      aria-hidden
    >
      <circle cx="32" cy="35" r="22" />
      <circle cx="32" cy="35" r="12" />
      <path d="M32 35 44.5 24" />
      <circle cx="32" cy="35" r="3" fill="currentColor" stroke="none" />
      <circle cx="42.5" cy="20.5" r="4" fill="var(--accent)" stroke="none" />
    </svg>
  )
}

/* ── 按钮 / 操作 ───────────────────────────────────────────────── */

export function IconPause(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M5.5 3.5v9M10.5 3.5v9" />
    </svg>
  )
}

export function IconPlay(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M5.5 3.2v9.6L12.6 8z" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function IconRefresh(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M14 8a6 6 0 1 1-1.76-4.24" />
      <path d="M14 2.5V6h-3.5" />
    </svg>
  )
}

export function IconSend(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M14 2.2 2.2 7.4l4.5 2 2 4.5z" />
      <path d="M6.7 9.4 14 2.2" />
    </svg>
  )
}

/** 测试连接：闪电 */
export function IconBolt(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M8.8 1.5 3.4 9h3.6l-.8 5.5L11.6 7H8z" />
    </svg>
  )
}

export function IconCheck(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M3 8.6 6.4 12 13 4.6" />
    </svg>
  )
}

export function IconX(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
    </svg>
  )
}

export function IconEye(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8 11.9 12.2 8 12.2 1.8 8 1.8 8z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  )
}

export function IconEyeOff(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8 11.9 12.2 8 12.2 1.8 8 1.8 8z" />
      <circle cx="8" cy="8" r="2" />
      <path d="M2.5 13.5 13.5 2.5" />
    </svg>
  )
}

/* ── 域图标 ────────────────────────────────────────────────────── */

/** AI：四角星光 */
export function IconSparkles(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M7.5 1.5c.55 3 1.45 3.9 4.5 4.5-3.05.6-3.95 1.5-4.5 4.5-.55-3-1.45-3.9-4.5-4.5 3.05-.6 3.95-1.5 4.5-4.5Z" />
      <path d="M12.4 9.7c.28 1.25.75 1.72 2 2-1.25.28-1.72.75-2 2-.28-1.25-.75-1.72-2-2 1.25-.28 1.72-.75 2-2Z" />
    </svg>
  )
}

/** 来源：广播信号（来源徽标 / 来源状态行） */
export function IconBroadcast(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M5 8.2a4.2 4.2 0 0 1 6 0" />
      <path d="M2.8 5.8a7.4 7.4 0 0 1 10.4 0" />
      <circle cx="8" cy="11" r="1.7" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function IconCalendar(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <rect x="2.5" y="3" width="11" height="10.5" rx="1.5" />
      <path d="M2.5 6.25h11M5.5 1.5v2.6M10.5 1.5v2.6" />
    </svg>
  )
}

export function IconClock(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 4.8V8l2.4 1.6" />
    </svg>
  )
}

/** 语义命中：气泡（AI 判定理由前缀可用） */
export function IconBubble(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M13.5 7.2c0 2.9-2.5 5.2-5.5 5.2-.7 0-1.4-.12-2-.34L2.5 13l1-3.1a4.9 4.9 0 0 1-.9-2.7C2.6 4.3 5.1 2 8 2s5.5 2.3 5.5 5.2Z" />
    </svg>
  )
}

/** 状态点（来源健康等小圆点；纯 fill） */
export function IconDot(props: IconProps) {
  const size = props.size ?? 8
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      className={props.className}
      style={props.style}
      aria-hidden
    >
      <circle cx="8" cy="8" r="4" />
    </svg>
  )
}
