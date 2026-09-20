/**
 * 运行日志（Zone D，dashboard.md §3.4）：等宽滚动区 + 级别筛选 chips（单选，
 * 计数 mono、aria-pressed；L 键聚焦，←/→ 在 chips 间移动）+ 复制按钮
 * （复制当前筛选下全部行，格式 HH:mm:ss LEVEL msg；反馈 = 图标原位互换 +
 * 文字恒「复制」+ 数量瞬时放 title，1.5s 复原，按钮宽度零跳动 §C-9）。
 * 自动跟随（audit §5.7.2 资产，原样保留）：贴底时新日志滚到底；用户上滚即
 * 暂停跟随（卡头行内提示），滚回底部自动恢复；切筛选集合时贴底跟随不中断。
 * stick 真值放 ref（scroll 事件高频读写），state 只用于渲染提示。
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { LogEntry, LogLevel } from '@shared/types'
import { formatClock } from '../lib/time'
import { EmptyState } from './EmptyState'
import { ErrorBar } from './ErrorBar'
import { IconCheck, IconCopy, IconX } from './icons'

const BOTTOM_TOLERANCE_PX = 10
/** 复制成功反馈的复原延时 */
const COPY_FEEDBACK_MS = 1500

type LevelFilter = 'all' | LogLevel

/** dot：级别 tone 点档（§3.1 级别 chip 组走 tone 三档；色不单用，点+标签同现） */
const LEVEL_CHIPS: { key: LevelFilter; label: string; dot?: 'warn' | 'error' }[] = [
  { key: 'all', label: '全部' },
  { key: 'info', label: '信息' },
  { key: 'warn', label: '警告', dot: 'warn' },
  { key: 'error', label: '错误', dot: 'error' }
]

export function LogView(props: {
  /** 旧→新（useApi 单源下发） */
  logs: LogEntry[]
  /** 日志面读取失败原因（错误 ≠ 空：旧数据保留，错误条叠卡顶） */
  error?: string | null
  onRetry?: () => void
  /** 级别筛选 chips 容器 ref（Dashboard 的 L 键聚焦用） */
  chipGroupRef?: RefObject<HTMLDivElement | null>
}) {
  const { logs } = props
  const boxRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)
  const [stick, setStick] = useState(true)
  const [filter, setFilter] = useState<LevelFilter>('all')
  /** null=空闲；数字=已复制条数；false=复制失败 */
  const [copied, setCopied] = useState<number | false | null>(null)
  const copyTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current)
    }
  }, [])

  const counts = useMemo(() => {
    const c: Record<LevelFilter, number> = { all: logs.length, info: 0, warn: 0, error: 0 }
    for (const l of logs) c[l.level] += 1
    return c
  }, [logs])

  const filtered = useMemo(
    () => (filter === 'all' ? logs : logs.filter((l) => l.level === filter)),
    [logs, filter]
  )

  // 跟随：新日志或切筛选集合时，贴底状态下都滚到底（切更小集合跟随不中断）
  useEffect(() => {
    const el = boxRef.current
    if (el != null && stickRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [filtered, filter])

  function handleScroll(): void {
    const el = boxRef.current
    if (el == null) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_TOLERANCE_PX
    if (atBottom !== stickRef.current) {
      stickRef.current = atBottom
      setStick(atBottom)
    }
  }

  function handleChipKeys(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const chips = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('.log-chip')
    )
    if (chips.length === 0) return
    const cur = chips.indexOf(document.activeElement as HTMLButtonElement)
    // 无焦点基准（L 键刚聚焦容器）时两个方向都落第一枚
    const base = cur < 0 ? 0 : cur + (e.key === 'ArrowRight' ? 1 : -1)
    const next = ((base % chips.length) + chips.length) % chips.length
    chips[next]?.focus()
  }

  async function copyLogs(): Promise<void> {
    const text = filtered
      .map((l) => `${formatClock(l.ts)} ${l.level} ${l.msg}`)
      .join('\n')
    let ok = false
    try {
      await navigator.clipboard.writeText(text)
      ok = true
    } catch {
      ok = false
    }
    if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current)
    setCopied(ok ? filtered.length : false)
    copyTimerRef.current = window.setTimeout(() => setCopied(null), COPY_FEEDBACK_MS)
  }

  /** 复制按钮 title：数量/失败信息瞬时放这里（按钮文字恒「复制」，§C-9） */
  const copyTitle =
    copied === null
      ? '复制当前筛选下的全部日志'
      : copied === false
        ? '复制失败'
        : `已复制 ${copied} 条`

  return (
    <section className="card card-grow card-logs">
      <div className="card-head log-toolbar">
        <span className="card-title">运行日志</span>
        <div
          className="log-chips"
          role="group"
          aria-label="日志级别筛选"
          tabIndex={-1}
          ref={props.chipGroupRef}
          onKeyDown={handleChipKeys}
        >
          {LEVEL_CHIPS.map((c) => (
            <button
              type="button"
              key={c.key}
              className={`log-chip${filter === c.key ? ' on' : ''}`}
              aria-pressed={filter === c.key}
              onClick={() => setFilter(c.key)}
            >
              {c.dot != null && <span className={`lvl-dot ${c.dot}`} aria-hidden="true" />}
              {c.label} <span className="num">{counts[c.key]}</span>
            </button>
          ))}
        </div>
        <span className={stick ? 'log-follow' : 'log-follow follow-paused'}>
          {/* 跟随状态点：翠=实时跟随 / 琥珀=已暂停（点+文字同现，色不单用） */}
          <span className={`follow-dot${stick ? ' on' : ''}`} aria-hidden="true" />
          {stick ? '跟随中' : '已暂停跟随 · 滚到底部恢复'}
        </span>
        <button
          type="button"
          className={`btn log-copy${copied === false ? ' err' : copied != null ? ' ok' : ''}`}
          title={copyTitle}
          disabled={filtered.length === 0}
          onClick={() => void copyLogs()}
        >
          {/* 图标原位互换（复制→成功✓/失败✗），文字恒「复制」——宽度零跳动（§C-9） */}
          {copied === false ? (
            <IconX size={12} />
          ) : copied != null ? (
            <IconCheck size={12} />
          ) : (
            <IconCopy size={12} />
          )}
          复制
        </button>
      </div>
      {props.error != null && (
        <ErrorBar message={`运行日志读取失败：${props.error}`} onRetry={props.onRetry} />
      )}
      <div className="logview" ref={boxRef} onScroll={handleScroll}>
        {logs.length === 0 ? (
          <EmptyState title="暂无日志" hint="启动监控后，抓取与推送的运行记录会显示在这里" />
        ) : filtered.length === 0 ? (
          <div className="empty">当前筛选下无日志</div>
        ) : (
          filtered.map((entry, i) => (
            <div className={`log-line ${entry.level}`} key={`${entry.ts}-${i}`}>
              <span className="t">{formatClock(entry.ts)}</span>
              {entry.msg}
            </div>
          ))
        )}
      </div>
    </section>
  )
}
