/**
 * 实时命中流（Watchtower 步骤 J，概念稿 .feed/.feed-row 形制）：监控台右栏的
 * 命中阅读面。活列表机制自 HitList.tsx（步骤 J 前身，已退役）整体迁入，行为
 * 逐条保留（ia §5.1，阅读优先于新鲜度）：
 * - 「正在阅读」= 列表 scrollTop > 8px，或 10 秒内有过滚动/点击/键盘交互。
 * - 阅读中到达的命中不插入 DOM：以「冻结锚」（变更前的顶行 key）把新到行
 *   挡在渲染之外，只进角标计数（语境句 + role=status，不抢焦点，+99 封顶）；
 *   点击角标或滚回顶部一次性并入。锚被 200 环挤出时放弃冻结整列表并入。
 * - 列表在顶且无交互 → 新命中直接前插（useApi 单源订阅，onHit 事件驱动）。
 * - 键盘（§6.1）：j/k、↑/↓ 移动选中行，Enter 激活选中行（feed 行 = 打开命中
 *   详情抽屉），1/2 投 👍/👎（feed 行投票在抽屉内，无目标时静默 no-op）；
 *   容器是唯一 Tab 停靠点（roving 由内部 data-hit-index 承载）。
 *
 * NEW 徽标（步骤 J）：真实事件驱动——自订阅 window.api.onHit，事件到达的行
 * 7 秒内挂 fresh（HitRow feed 变体渲染 .new-tag）；过期由定时器链收口重渲染。
 * 滑入动画（概念 .feed-row.enter）：纯 CSS 挂在 .feed.is-live 容器上，仅本页
 * active 时生效（keep-alive hidden 页 display:none 会压掉动画中间帧；行按
 * key 复用不重挂载，已入列的旧行不会重播）。
 * 空态三态联动保留：从未命中（去设置）/ 本会话无新（立即轮询，暂停时禁用）。
 */
import { useEffect, useRef, useState } from 'react'
import type { HitRecord } from '@shared/types'
import { EmptyState } from './EmptyState'
import { ErrorBar } from './ErrorBar'
import { HitRow, hitRowKey } from './HitRow'
import { IconRefresh } from './icons'
import { formatClock } from '../lib/time'

/** 活列表口径（ia §5.1）：scrollTop 阈值 / 交互记忆窗口 / 角标封顶 */
const READING_SCROLL_PX = 8
const INTERACTION_WINDOW_MS = 10_000
const BADGE_CAP = 99
/** 内存环容量（与 useApi.MAX_HITS 同口径；卡头 aux 环满提示用） */
const RING_SIZE = 200
/** onHit 事件后 NEW 徽标保留时长（概念稿演示节奏 7s，对齐真实事件判定） */
const FRESH_MS = 7000

/** 一次事件到达的记录：freshUntil（NEW 徽标到期）+ arrivedAt（滑入动画基准） */
interface Arrival {
  freshUntil: number
  arrivedAt: number
}

export function LiveFeed(props: {
  /** 新→旧（useApi 单源下发，onHit 事件前插） */
  hits: HitRecord[]
  /** 持久累计命中数（EngineStatus.totalHits）：与内存列表口径不同，空态联动展示 */
  totalHits: number
  /** keep-alive 活跃性：hidden 页停用滑入动画（display:none 压动画中间帧） */
  active?: boolean
  onRunNow: () => void
  runNowDisabled: boolean
  /** 命中面读取失败原因（错误 ≠ 空：旧数据保留，错误条叠卡顶） */
  error?: string | null
  /** 错误条重试（重新拉取全量） */
  onRetry?: () => void
  /** 从未命中空态的「去设置监控内容」出口（App 层切页 + 设置锚点深链） */
  onGoSettings?: () => void
  /** 推送失败 ✗ 深链：跳去向页搜索该帖标题——排障动线一跳化 */
  onPushErrorClick?: (hit: HitRecord) => void
}) {
  const { hits } = props
  const scrollRef = useRef<HTMLDivElement | null>(null)
  /** 最近一次用户交互时刻（滚动/指针/键盘）——「10 秒内有交互」判阅读中 */
  const lastInteractRef = useRef(0)
  /** 上一帧顶行 key：阅读中出现新到达时，冻结锚取它（新行全部落在它上面） */
  const prevTopRef = useRef<string | null>(null)
  const [anchorId, setAnchorId] = useState<string | null>(null)
  const [selIdx, setSelIdx] = useState(-1)
  /** onHit 事件到达登记（key → 到达信息）；驱动 NEW 徽标的事件驱动真实判定 */
  const arrivalsRef = useRef<Map<string, Arrival>>(new Map())
  /** 到期收口的重渲染信号（Map 是 ref 不触发渲染，靠这个 tick） */
  const [, setArrivalTick] = useState(0)
  const expiryTimerRef = useRef<number | null>(null)

  // onHit 订阅：仅用于 NEW 徽标与滑入动画的事件登记（列表数据仍走 props.hits
  // 单源——App 层 useApi 已按事件前插，这里不重复维护数据）
  useEffect(() => {
    const off = window.api.onHit((h) => {
      const now = Date.now()
      arrivalsRef.current.set(hitRowKey(h), { freshUntil: now + FRESH_MS, arrivedAt: now })
      scheduleExpiry()
      setArrivalTick((t) => t + 1)
    })
    return () => {
      off()
      if (expiryTimerRef.current != null) window.clearTimeout(expiryTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 最早到期时刻的定时器链：到点清理过期登记并重渲染（徽标消失） */
  function scheduleExpiry(): void {
    const next = earliestExpiry()
    if (next == null) return
    if (expiryTimerRef.current != null) window.clearTimeout(expiryTimerRef.current)
    expiryTimerRef.current = window.setTimeout(() => {
      expiryTimerRef.current = null
      const now = Date.now()
      for (const [key, a] of arrivalsRef.current) {
        if (a.freshUntil <= now) arrivalsRef.current.delete(key)
      }
      scheduleExpiry()
      setArrivalTick((t) => t + 1)
    }, Math.max(0, next - Date.now()))
  }

  function earliestExpiry(): number | null {
    let min: number | null = null
    for (const a of arrivalsRef.current.values()) {
      if (min == null || a.freshUntil < min) min = a.freshUntil
    }
    return min
  }

  const anchorIdx = anchorId == null ? -1 : hits.findIndex((h) => hitRowKey(h) === anchorId)
  const frozen = anchorId != null && anchorIdx > 0
  const visible = frozen ? hits.slice(anchorIdx) : hits
  const newCount = frozen ? anchorIdx : 0

  function isReading(): boolean {
    const el = scrollRef.current
    if (el == null) return false
    return (
      el.scrollTop > READING_SCROLL_PX ||
      Date.now() - lastInteractRef.current < INTERACTION_WINDOW_MS
    )
  }

  // 新到达 × 阅读中 → 冻结；未冻结时持续记忆当前顶行
  useEffect(() => {
    if (anchorId != null) return
    const top = hits.length > 0 ? hitRowKey(hits[0]) : null
    if (
      top != null &&
      prevTopRef.current != null &&
      top !== prevTopRef.current &&
      isReading()
    ) {
      setAnchorId(prevTopRef.current)
      return
    }
    prevTopRef.current = top
  }, [hits, anchorId])

  function mergePending(): void {
    setAnchorId(null)
    prevTopRef.current = hits.length > 0 ? hitRowKey(hits[0]) : null
    const el = scrollRef.current
    if (el != null) el.scrollTop = 0
  }

  function handleScroll(): void {
    const el = scrollRef.current
    if (el == null) return
    lastInteractRef.current = Date.now()
    // 回顶 = 并入（ia §5.1：回顶/点击一次性并入）
    if (anchorId != null && el.scrollTop <= READING_SCROLL_PX) mergePending()
  }

  function moveSel(delta: number): void {
    const n = visible.length
    if (n === 0) return
    const cur = selIdx
    const next = cur < 0 ? (delta > 0 ? 0 : n - 1) : Math.min(n - 1, Math.max(0, cur + delta))
    setSelIdx(next)
    // 等 React 提交后再滚，避免对旧 DOM 查询
    window.requestAnimationFrame(() => {
      scrollRef.current
        ?.querySelector(`[data-hit-index="${next}"]`)
        ?.scrollIntoView({ block: 'nearest' })
    })
  }

  /** 选中行内目标的代点（Enter 激活行本体 = feed 行打开抽屉；1/2 投票走真实
      按钮，feed 行投票在抽屉内、无目标时 querySelector 落空即 no-op） */
  function clickInRow(idx: number, selector: string): void {
    const row = scrollRef.current?.querySelector(`[data-hit-index="${idx}"]`)
    if (row == null) return
    if (selector === '') (row as HTMLElement).click()
    else row.querySelector<HTMLButtonElement>(selector)?.click()
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.nativeEvent.isComposing) return
    lastInteractRef.current = Date.now()
    const key = e.key
    if (key === 'j' || key === 'J' || key === 'ArrowDown') {
      e.preventDefault()
      moveSel(1)
    } else if (key === 'k' || key === 'K' || key === 'ArrowUp') {
      e.preventDefault()
      moveSel(-1)
    } else if (key === 'Enter') {
      e.preventDefault()
      if (selIdx >= 0) clickInRow(selIdx, '')
    } else if (key === '1') {
      e.preventDefault()
      if (selIdx >= 0) clickInRow(selIdx, '[data-vote="positive"]')
    } else if (key === '2') {
      e.preventDefault()
      if (selIdx >= 0) clickInRow(selIdx, '[data-vote="negative"]')
    }
  }

  // 列表缩短（环挤出/并入）时收口选中行
  useEffect(() => {
    if (selIdx >= visible.length) setSelIdx(visible.length === 0 ? -1 : visible.length - 1)
  }, [visible.length, selIdx])

  const now = Date.now()
  const isFresh = (key: string): boolean => {
    const a = arrivalsRef.current.get(key)
    return a != null && now < a.freshUntil
  }

  const badge =
    newCount > 0 ? (
      <button
        type="button"
        className="live-pill"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        onClick={mergePending}
      >
        {/* live 点为纯装饰（aria-hidden），role=status 语境句文案不动 */}
        <span className="live-dot" aria-hidden="true" />
        {newCount > BADGE_CAP
          ? `+${BADGE_CAP}+ 条新命中 · 点击并入`
          : `+${newCount} 条新命中 · 点击并入`}
      </button>
    ) : null

  return (
    <section className="panel panel-feed">
      <div className="panel-h">
        <span className="panel-h-group">
          <h3>实时命中流</h3>
          {visible.length > 0 && <span className="panel-count num">{visible.length} 条</span>}
          <span className="panel-h-aux">
            本会话 · 最多 {RING_SIZE} 条 · 重启后清空
            {hits.length >= RING_SIZE
              ? ` · 已满 ${RING_SIZE} · 更早记录被挤出，完整历史见「历史命中」`
              : ''}
          </span>
        </span>
        <span className="ph-tag">Live Feed</span>
        {badge}
      </div>
      {props.error != null && (
        <ErrorBar
          message={`实时命中读取失败：${props.error} · 已有 ${hits.length} 条仍显示`}
          onRetry={props.onRetry}
        />
      )}
      <div
        className={`feed${props.active !== false ? ' is-live' : ''}`}
        ref={scrollRef}
        tabIndex={0}
        aria-label="实时命中流：j/k 或上下键移动，Enter 打开命中详情，1/2 投反馈"
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
        onPointerDown={() => {
          lastInteractRef.current = Date.now()
        }}
      >
        {hits.length === 0 ? (
          props.totalHits > 0 ? (
            <EmptyState
              title="启动后还没有新命中"
              hint={`累计已命中 ${props.totalHits} 条；本列表只保留本次运行，重启后清空。完整记录见「历史命中」，当日总结见「日报」`}
              action={
                <button
                  type="button"
                  className="btn"
                  disabled={props.runNowDisabled}
                  title={
                    props.runNowDisabled ? '已暂停：先恢复监控' : '忽略等待，立即补一轮轮询'
                  }
                  onClick={props.onRunNow}
                >
                  <IconRefresh size={14} />
                  立即轮询
                </button>
              }
            />
          ) : (
            <EmptyState
              title="还没有命中"
              hint="配置关键词、价格规则或 AI 兴趣描述后，命中的新帖会实时出现在这里"
              action={
                props.onGoSettings != null && (
                  <button type="button" className="btn" onClick={props.onGoSettings}>
                    去设置监控内容
                  </button>
                )
              }
            />
          )
        ) : (
          visible.map((hit, i) => {
            const key = hitRowKey(hit)
            return (
              <HitRow
                key={key}
                hit={hit}
                variant="feed"
                fresh={isFresh(key)}
                index={i}
                time={formatClock(hit.notifiedAt ?? hit.topic.lastActiveAt)}
                timeTitle={hit.notifiedAt ?? hit.topic.lastActiveAt ?? undefined}
                selected={i === selIdx}
                onRowPointerDown={() => setSelIdx(i)}
                onPushErrorClick={props.onPushErrorClick}
              />
            )
          })
        )}
      </div>
    </section>
  )
}
