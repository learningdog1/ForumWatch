/**
 * 设置页 Zone A 子导航（settings.md §1.2/§3.2/§5.2）：152px 锚点栏。
 * - 任务定位，不是路由（不拆数据面、不复制 draft——保住 draft 单源）；
 * - 点击平滑滚动到组头（scroll-margin-top 防遮挡）；
 * - 组级 dirty 圆点由 12 段配置 → 组映射驱动（12 段定义在 Settings.tsx）；
 * - ↑/↓ 在组项间移动焦点（roving；激活项 aria-current="true"）。
 * 纯渲染组件，dirty/active 状态全部由 Settings.tsx 下发。
 */
import { useRef, type KeyboardEvent } from 'react'

export interface SettingsNavItem {
  /** 组锚点 id（即组元素的 DOM id，如 set-grp-monitor） */
  id: string
  label: string
  /** 本组任一配置段 dirty */
  dirty: boolean
}

export function SettingsNav(props: {
  groups: ReadonlyArray<SettingsNavItem>
  /** 当前 scrollspy 激活组 id */
  active: string
  /** 整页加载中 / 读取失败时置灰不可点（§4.2/§4.3） */
  disabled?: boolean
  onJump: (groupId: string) => void
}) {
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, i: number): void {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const next = e.key === 'ArrowDown' ? i + 1 : i - 1
    itemRefs.current[next]?.focus()
  }

  return (
    <nav className="settings-nav" aria-label="设置分组导航">
      {props.groups.map((g, i) => (
        <button
          key={g.id}
          ref={(el) => {
            itemRefs.current[i] = el
          }}
          type="button"
          className={`snav-item${props.active === g.id ? ' active' : ''}`}
          aria-current={props.active === g.id ? 'true' : undefined}
          disabled={props.disabled === true}
          onClick={() => props.onJump(g.id)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {g.label}
          {g.dirty && <span className="snav-dot" title="本组有未保存修改" />}
        </button>
      ))}
    </nav>
  )
}
