/**
 * 分页栏（R10 阶段 3，history.md §2 Z2 / §4.2）：上一页 / 下一页 + 页码跳转
 * （Enter 生效，钳到 [1, 总页数]）+ 页大小下拉（默认 50/100/200——200 为 IPC
 * 单次钳位上限）+ 总数千分位（mono + tnum 防抖动）。
 *
 * - 切页大小保持数据位置（§4.2-3）：新页码 = floor(当前页起始偏移 / 新档)，
 *   不回第一页；换算在本组件完成，经 onPageChange / onPageSizeChange 成对上报
 *   （React 批处理，消费方只发一次查询）；切档后焦点留在分页栏（原生 select 自然保持）。
 * - 页码输入与外部页码单向同步：外部翻页/跳转/越界收口都会回写输入框；输入
 * 中的值只按 Enter 提交，失焦不误跳、还原为当前页。
 * - PageUp/Down 快捷键的作用域是整页（焦点不在输入控件即可），由页面层挂载，
 *   不在本组件。
 */
import { useEffect, useState } from 'react'

/** 计数千分位（dispositions.md §2.2 同款：数字一律 mono + tabular-nums） */
export function fmtNum(n: number): string {
  return n.toLocaleString('zh-CN')
}

export interface PagerProps {
  /** 当前页（0 起） */
  page: number
  /** 总页数（≥1，由消费方按 total/pageSize 向上取整） */
  pageCount: number
  /** 过滤后总数（与分页无关，服务端返回） */
  total: number
  /** 当前页大小 */
  pageSize: number
  /** 页大小档位（默认 50/100/200） */
  pageSizeOptions?: readonly number[]
  /** 页码变更（0 起；页大小切换的换算也走这里） */
  onPageChange: (page: number) => void
  /** 页大小变更（与换算后的 onPageChange 成对触发） */
  onPageSizeChange: (size: number) => void
}

export function Pager(props: PagerProps) {
  const { page, pageCount, total, pageSize } = props
  const options = props.pageSizeOptions ?? [50, 100, 200]
  const [pageInput, setPageInput] = useState(String(page + 1))

  // 外部页码变化（翻页 / 跳转 / 越界收口）同步回输入框
  useEffect(() => {
    setPageInput(String(page + 1))
  }, [page])

  /** Enter 跳页：钳到 [1, 总页数]；页码未变只还原输入 */
  function jump(): void {
    const n = Math.min(pageCount, Math.max(1, Number.parseInt(pageInput, 10) || 1))
    if (n - 1 !== page) props.onPageChange(n - 1)
    else setPageInput(String(page + 1))
  }

  return (
    <div className="pager">
      <button
        type="button"
        className="btn"
        disabled={page === 0}
        onClick={() => props.onPageChange(page - 1)}
      >
        上一页
      </button>
      <span className="pager-jump">
        第{' '}
        <input
          className="input page-input"
          value={pageInput}
          aria-label="跳转到指定页"
          inputMode="numeric"
          onChange={(e) => setPageInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') {
              e.preventDefault()
              jump()
              e.currentTarget.blur()
            }
          }}
          onBlur={() => setPageInput(String(page + 1))}
        />{' '}
        / <span className="num">{fmtNum(pageCount)}</span> 页
      </span>
      <button
        type="button"
        className="btn"
        disabled={page + 1 >= pageCount}
        onClick={() => props.onPageChange(page + 1)}
      >
        下一页
      </button>
      <label className="pager-size">
        每页
        <select
          className="input pager-select"
          value={pageSize}
          aria-label="每页条数"
          onChange={(e) => {
            const next = Math.max(1, Number.parseInt(e.target.value, 10) || pageSize)
            // 切档保持数据位置：新页码 = floor(当前页起始偏移 / 新档)，不回第一页
            props.onPageChange(Math.floor((page * pageSize) / next))
            props.onPageSizeChange(next)
          }}
        >
          {options.map((n) => (
            <option key={n} value={n}>
              {n} 条
            </option>
          ))}
        </select>
      </label>
      <span className="pager-total">
        共 <span className="num">{fmtNum(total)}</span> 条
      </span>
    </div>
  )
}
