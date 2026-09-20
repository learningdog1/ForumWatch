/**
 * 内联 SVG 图标系统（D8 ① + TASTE-UPGRADE §C-3 定档）：统一 stroke 1.5 /
 * currentColor，16×16 设计栅格。替换历史 emoji。
 *
 * 尺寸档（按实测用例定死，不新增散值）：
 * - 12  行内文本前缀与反馈符号（✓/✗、搜索前置、加载小旋标）
 * - 14  独立按钮与块图标（主力档：操作条、卡内块图标）
 * - 16  侧栏导航图标（默认档）
 * - 20  品牌图标砖（IconRadar，R12 亮轨 brand tile：单色 currentColor，
 *       宿主 shell.css .brand-icon 给 --rail-bar）
 * - 44  空态插画（IllustrationRadar 实调值；组件默认 64 仅供更大画布复用，
 *       两者均属体系外件，不入线形图标档）
 * - 8   IconDot 状态点（纯 fill 小圆点，体系外件）
 *
 * 约定：
 * - 线性图标默认 fill="none" stroke="currentColor"；个别实心件（播放三角、
 *   雷达中心点）显式 fill + stroke="none"。
 * - 雷达族的信号点用 var(--accent)——图标随主题换色，无需 per-call 传色。
 * - 全部 aria-hidden：文本标签由相邻文案提供。
 */
import type { CSSProperties, SVGProps } from 'react'

export interface IconProps {
  /** 渲染尺寸（px），默认 16；档位见文件头注释（12/14/16/20 线形档） */
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

/** 品牌 / 状态雷达小图（R12：信号点同走 currentColor——品牌标在亮轨上单色
    azure（宿主 shell.css .brand-icon 给 --rail-bar，随模式换相）；
    空态插画 IllustrationRadar 保留双 tone——它落在卡面上，accent 点即品牌信号） */
export function IconRadar(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle cx="8" cy="8.5" r="6" />
      <circle cx="8" cy="8.5" r="3.1" />
      <path d="M8 8.5 12.1 5" />
      <circle cx="8" cy="8.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="11.4" cy="3.9" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
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

/* ── R10 扩展（原型评审后补齐的操作族）────────────────────────── */

/** 搜索（去向页 / 列表搜索框） */
export function IconSearch(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.4 10.4 14 14" />
    </svg>
  )
}

/** 历史命中：时钟 */
export function IconHistory(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3l2 2" />
    </svg>
  )
}

/** 投票：赞同（HitRow 反馈三态） */
export function IconThumbUp(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M2.5 8.3h2v5.4h-2z" />
      <path d="M4.5 8.5 6.6 4.1c.85 0 1.55.65 1.55 1.5l-.25 2.15h3c.8 0 1.4.75 1.24 1.53l-.6 2.65c-.13.58-.65.97-1.24.97H4.5z" />
    </svg>
  )
}

/** 投票：反对（HitRow 反馈三态） */
export function IconThumbDown(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M2.5 7.7h2V2.3h-2z" />
      <path d="M4.5 7.5 6.6 11.9c.85 0 1.55-.65 1.55-1.5l-.25-2.15h3c.8 0 1.4-.75 1.24-1.53l-.6-2.65A1.28 1.28 0 0 0 10.5 3.1H4.5z" />
    </svg>
  )
}

/** 复制（日志复制按钮等） */
export function IconCopy(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.5v-1a.5.5 0 0 0-.5-.5h-7a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5h1" />
    </svg>
  )
}

/** 下拉 / 展开指示 */
export function IconChevronDown(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M4 6.2 8 10.2l4-4" />
    </svg>
  )
}

/** 实体行上移 / 下移（路由规则优先级调整，settings.md §5.3） */
export function IconArrowUp(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M8 13V3" />
      <path d="M3.5 7.5 8 3l4.5 4.5" />
    </svg>
  )
}

export function IconArrowDown(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M8 3v10" />
      <path d="M3.5 8.5 8 13l4.5-4.5" />
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

/** 静音推送态：短横（与 ✓/✗ 同族的最小符号件） */
export function IconMinus(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M3.5 8h9" />
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
