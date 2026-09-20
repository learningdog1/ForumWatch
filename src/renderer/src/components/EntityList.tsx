/**
 * L2 实体行列表容器（阶段 5b，settings.md §4.4/§5.3）：来源 / 通道 / 价格
 * 规则 / 路由四类列表的统一外壳——
 * - 自然高度（.card-scroll 嵌套滚动已废止），>8 条折叠为前 8 条 +
 *   「展开全部 N 条」（展开后按钮变「收起」）；
 * - 行本体由 render 回调提供（四类卡的摘要行 + 展开编辑区结构不同，容器只管
 *   列表框、行分隔线与折叠脚行）。
 *
 * 待删除标记协议（L1 删除不弹确认，§3.5）：数据源在 Settings（保存栏 M 计数、
 * 保存时剔除、放弃修改还原都在那一层），卡只读标记渲染「待删除」态并上报
 * 删除 / 撤销意图——draft 数组不落 _del 之类脏标记，保存载荷形状不变。
 */
import { useEffect, useState, type ReactNode } from 'react'

/** 折叠阈值（settings.md §4.4：四类列表统一 8 条） */
export const LIST_COLLAPSE_THRESHOLD = 8

/** L1 待删除态的卡侧协议（四张实体卡 props 并入；意图由 Settings 裁决） */
export interface PendingDeleteSlot {
  /** 已标记「待删除」的实体 id（保存后从配置消失；放弃修改可还原） */
  pendingDelete: ReadonlySet<string>
  /** 删除按钮：已保存过的行转待删除标记，未保存过的新行直接移除 */
  onMarkDelete: (id: string) => void
  /** 撤销删除：去掉待删除标记（保存前可无限还原） */
  onUndoDelete: (id: string) => void
}

export function EntityList<T>(props: {
  items: T[]
  rowKey: (item: T) => string
  /** 行级附加类（「待删除」态等由行容器承载——删除线/压暗作用整行） */
  rowClass?: (item: T) => string
  /** 行内容（摘要行 + 可选展开区）；index 为全量列表下标（路由上下移要用） */
  render: (item: T, index: number) => ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const over = props.items.length > LIST_COLLAPSE_THRESHOLD
  const visible = over && !expanded ? props.items.slice(0, LIST_COLLAPSE_THRESHOLD) : props.items
  return (
    <div className="entity-list">
      {visible.map((item, i) => (
        <div className={`entity-row${props.rowClass?.(item) ?? ''}`} key={props.rowKey(item)}>
          {props.render(item, i)}
        </div>
      ))}
      {over && (
        <div className="ent-collapse">
          {!expanded && <span>已显示前 {LIST_COLLAPSE_THRESHOLD} 条</span>}
          <button
            type="button"
            className="ent-btn"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? '收起' : `展开全部 ${props.items.length} 条`}
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Esc 收起当前展开的行内编辑（settings.md §5.4 Esc 链：保存栏确认条 → 行内
 * 编辑 → 导入确认层，就近优先）。各卡只收自己的展开行；保存栏确认条开着时
 * 让位（.sb-confirm 是 Settings 与各卡之间的 DOM 契约，同 scrollspy 查询
 * .settings-group 的既有模式）；IME 组合期不接管；设置页处于 keep-alive 隐藏
 * 态时不响应（Esc 属于当前可见页面）。
 */
export function useEscCollapse(active: boolean, collapse: () => void): void {
  useEffect(() => {
    if (!active) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.isComposing) return
      if (document.querySelector('.savebar .sb-confirm') != null) return
      const page = document.querySelector('.page-settings')
      if (page != null && page.closest('[hidden]') != null) return
      collapse()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, collapse])
}
