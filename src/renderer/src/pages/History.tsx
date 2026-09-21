/**
 * 历史命中页（R10 阶段 3，history.md 三区骨架，整页重写）：
 * Z0 页题（PageHeader：更新于 HH:mm:ss + 统一刷新——两个数据面一次重拉）
 * → Z1 可折叠统计画像卡（固定近 14 天口径：四指标 + 14 天 sparkbar + 方式占比
 * + 来源 Top5 / 关键词榜展开区 + 零命中概要行常显；折叠记忆 localStorage）
 * → Z2 命中记录卡（card-grow 吃满剩余高：筛选工具条 + 服务端分页列表 + 分页栏；
 * 本页唯一滚动区在列表）。整页不滚动，高度不足由 card-grow 的 min-height 兜底
 * 自然回退（监控台同机制）。
 *
 * 双窗口口径规则（audit #4 的解，全页最高优先级文案）：Z1 卡头 aux 恒显
 * 「近 14 天固定窗口 · 不随下方筛选变化」（title 讲设计意图），Z2 卡头 aux 恒显
 * 当前筛选窗口——列表筛选变化时 Z1 数字纹丝不动。
 *
 * 加载态（audit #5 / §5.2）：非首载（筛选/翻页/防抖/刷新）保留旧数据 + 列表
 * 压暗 + 卡头「查询中…」（>1s 才出现），禁整屏替换；首载无旧数据才允许文字型
 * 占位。错误 ≠ 空（§5.3）：列表/统计各自错误条 + 重试 + 旧数据保留，失败绝不
 * 落入「没有历史命中」空态；来源下拉备料失败不再静默（尾部不可选项说明）。
 *
 * 保留机制：搜索 300ms 防抖、筛选变化回第一页、越界自动收口、请求序号守卫
 * （列表与统计各一套）、IME 组合不触发单键。行渲染消费阶段 1 的共用 HitRow
 * （含投票、通道化后静音文案），本地复刻段已删除（audit #12）。
 * 键盘（§4.1）：/ 聚焦搜索、Esc 清空/还焦、PageUp/Down 翻页、j/k 与 ↑/↓ 行
 * 移动、Enter 打开焦点行原帖、页码框 Enter 跳页（Pager 内）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import type { HitQueryResult, StatsResult } from '@shared/ipc'
import { EmptyState } from '../components/EmptyState'
import { ErrorBar } from '../components/ErrorBar'
import { HitRow, hitRowKey } from '../components/HitRow'
import { PageHeader } from '../components/PageHeader'
import { Pager, fmtNum } from '../components/Pager'
import { StatSparkbar } from '../components/StatSparkbar'
import { IconChevronDown, IconRefresh, IconSearch } from '../components/icons'
import { localDate } from '../lib/time'
import { sourceLabel } from '../lib/status'

/** 统计区窗口（天，与主进程 getStats 缺省一致；显式传避免两侧漂移） */
const STATS_DAYS = 14
/** 搜索框防抖（ms） */
const SEARCH_DEBOUNCE_MS = 300
/** 「查询中…」指示延迟出现阈值（ia §5.1 progressive-loading） */
const BUSY_INDICATOR_MS = 1_000
/** 关键词命中榜默认展示条数（超出折叠「另有 N 个未展示 + 展开全部」） */
const KEYWORD_RANK_LIMIT = 8
/** 统计折叠记忆的 localStorage 键（history.md §4.2-6） */
const STATS_COLLAPSED_KEY = 'fw.history.statsCollapsed'
/** 「全部」窗口的起始日（从最早落盘记录查起；主进程同口径下限） */
const ALL_FROM = '2000-01-01'
/** 默认页大小档（Pager 三档之一） */
const DEFAULT_PAGE_SIZE = 50

type MatchedBy = 'literal' | 'semantic' | 'rule' | 'matchall'

const MB_OPTIONS: { value: MatchedBy; label: string }[] = [
  { value: 'literal', label: '字面' },
  { value: 'semantic', label: '语义' },
  { value: 'rule', label: '规则' },
  { value: 'matchall', label: '全匹配' }
]

/** 日期快捷 chips（单选；自定义激活时展开两个 date input） */
type WinKey = 'today' | 'd7' | 'd14' | 'd30' | 'all' | 'custom'

const WIN_OPTIONS: { key: WinKey; label: string; title?: string }[] = [
  { key: 'today', label: '今天' },
  { key: 'd7', label: '近 7 天' },
  { key: 'd14', label: '近 14 天' },
  { key: 'd30', label: '近 30 天' },
  { key: 'all', label: '全部', title: '从最早落盘记录（2000-01-01 起）查起' },
  { key: 'custom', label: '自定义' }
]

/** 数据驱动的宽度变量（--w）类型出口：比例/像素宽度是数据不是 token，样式仍由类承载 */
type BarVars = CSSProperties & { '--w'?: string }

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** n/total 百分比文案；total=0 → '—' */
function pct(n: number, total: number): string {
  if (total <= 0) return '—'
  return `${Math.round((n / total) * 100)}%`
}

/** 近 N 天的起始本地日期（含端点：today-(N-1) .. today） */
function daysAgoLocal(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return localDate(d)
}

/** 含端点的天数（窗口 aux 用）；无效区间按 1 天计 */
function dayCountInclusive(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00`)
  const b = Date.parse(`${to}T00:00:00`)
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 1
  return Math.round((b - a) / 86_400_000) + 1
}

/** 历史行时间戳：'MM-DD HH:mm'（跨日视图带日期） */
function formatHistoryStamp(iso: string | null): string {
  if (iso == null || iso === '') return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 时间列 title：绝对时间戳 'YYYY-MM-DD HH:mm:ss'（相对展示旁保留绝对值） */
function formatHistoryTitle(iso: string | null): string | undefined {
  if (iso == null || iso === '') return undefined
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return undefined
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** 简易防抖值（搜索框用；hooks/ 目录不在本阶段改动清单，就地内联） */
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}

/** 折叠记忆（默认折叠，history.md §7 细化 1；读写失败按默认） */
function readStatsCollapsed(): boolean {
  try {
    return window.localStorage.getItem(STATS_COLLAPSED_KEY) !== '0'
  } catch {
    return true
  }
}

// ---- Z1 统计画像子块 ---------------------------------------------------------

/** 四命中方式占比：堆叠比例条（宽度 = 占比）+ 图例行（数字 + 比例） */
function MatchedByBreakdown(props: { stats: StatsResult }) {
  const { byMatchedBy, total } = props.stats
  const rows: { key: MatchedBy; label: string; count: number }[] = [
    { key: 'literal', label: '字面', count: byMatchedBy.literal },
    { key: 'semantic', label: '语义', count: byMatchedBy.semantic },
    { key: 'rule', label: '规则', count: byMatchedBy.rule },
    { key: 'matchall', label: '全匹配', count: byMatchedBy.matchall }
  ]
  return (
    <div>
      <div className="stackbar">
        {rows.map((r) =>
          r.count > 0 ? (
            <span
              key={r.key}
              className={`stack-seg ${r.key}`}
              style={{ '--w': pct(r.count, total) } as BarVars}
              title={`${r.label} ${fmtNum(r.count)}（${pct(r.count, total)}）`}
            />
          ) : null
        )}
      </div>
      <div className="legend">
        {rows.map((r) => (
          <span key={r.key}>
            <span className={`lg-dot ${r.key}`} />
            {r.label} <span className="num">{fmtNum(r.count)}</span>（{pct(r.count, total)}）
          </span>
        ))}
      </div>
    </div>
  )
}

/** 来源分布 Top 5（条形 + 计数；展开区） */
function SourceRank(props: { stats: StatsResult }) {
  const { bySource, total } = props.stats
  const top = bySource.slice(0, 5)
  const srcMax = Math.max(1, ...top.map((s) => s.count))
  return (
    <div>
      <div className="cb-title">
        来源分布 Top {Math.min(5, bySource.length)}
        {bySource.length > 5 ? `（共 ${bySource.length} 个）` : ''}
      </div>
      <div className="rank-list">
        {top.map((s) => (
          <div className="rank-item" key={s.sourceId}>
            <span className="rk-name" title={sourceLabel(s.sourceId)}>
              {sourceLabel(s.sourceId)}
            </span>
            <span
              className="rk-bar"
              style={{ '--w': `${Math.round((s.count / srcMax) * 90)}px` } as BarVars}
            />
            <span className="rk-val num" title={`${s.count} 条（${pct(s.count, total)}）`}>
              {fmtNum(s.count)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 关键词命中榜（只列命中词，降序；超 8 条折叠「另有 N 个未展示 + 展开全部」；
    零命中词不在此列——概要行常显承载，避免折叠时藏住修剪决策入口） */
function KeywordRank(props: { stats: StatsResult; kwExpanded: boolean; onToggleKw: () => void }) {
  const hitKeywords = props.stats.keywordHits.filter((k) => k.zeroHit !== true)
  const shown = props.kwExpanded ? hitKeywords : hitKeywords.slice(0, KEYWORD_RANK_LIMIT)
  const kwMax = Math.max(1, ...hitKeywords.map((k) => k.count))
  return (
    <div>
      <div className="cb-title">关键词命中榜</div>
      <div className="rank-list">
        {shown.map((k) => (
          <div className="rank-item" key={k.keyword} title={`命中 ${k.count} 次`}>
            <span className="rk-name">{k.keyword}</span>
            <span
              className="rk-bar"
              style={{ '--w': `${Math.round((k.count / kwMax) * 90)}px` } as BarVars}
            />
            <span className="rk-val num">{fmtNum(k.count)}</span>
          </div>
        ))}
        {hitKeywords.length > KEYWORD_RANK_LIMIT && (
          <div className="rank-more">
            <span>
              {props.kwExpanded
                ? `共 ${hitKeywords.length} 个`
                : `· 另有 ${hitKeywords.length - KEYWORD_RANK_LIMIT} 个未展示`}
            </span>
            <button type="button" className="disp-link" onClick={props.onToggleKw}>
              {props.kwExpanded ? '收起' : '展开全部'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/** 零命中概要行（折叠时常显——流 4 的行动入口不因折叠而隐藏）；
    锚点深链在设置页阶段 5 就绪前降级为切设置页 */
function ZeroRow(props: { stats: StatsResult; onGoSettings?: () => void }) {
  const { keywordHits } = props.stats
  if (keywordHits.length === 0) return null
  const zero = keywordHits.filter((k) => k.zeroHit === true)
  if (zero.length === 0) {
    return (
      <div className="zero-row">
        <span>配置的命中词在窗口内均有过命中</span>
      </div>
    )
  }
  return (
    <div className="zero-row">
      <span>零命中关键词 {zero.length} 个 —— 窗口内从未命中，考虑移除或改写：</span>
      {zero.map((k) => (
        <span
          key={k.keyword}
          className="zero-chip"
          title="统计窗口内零命中：考虑移除或改写该关键词"
        >
          {k.keyword} · 未命中
        </span>
      ))}
      {props.onGoSettings != null && (
        <button
          type="button"
          className="disp-link"
          title="打开 设置 → 监控内容 → 关键词"
          onClick={props.onGoSettings}
        >
          去调整关键词
        </button>
      )}
    </div>
  )
}

// ---- 页面 -------------------------------------------------------------------

export function History(props: {
  onGoSettings?: () => void
  /** 日报「命中明细 →」深链（对象每次新建：同一天可重复触发）；null=无待消费深链 */
  initialDate?: { date: string; seq: number } | null
  /** keep-alive 活跃性：隐藏页停跳 useNow（降负） */
  active?: boolean
}) {
  const today = localDate()
  const defaultFrom = daysAgoLocal(6) // 默认近 7 天（含端点）

  // 筛选态（变更时回到第一页）
  const [win, setWin] = useState<WinKey>('d7')
  const [customFrom, setCustomFrom] = useState(defaultFrom)
  const [customTo, setCustomTo] = useState(today)
  const [sourceId, setSourceId] = useState('')
  const [mb, setMb] = useState<MatchedBy[]>([])
  const [text, setText] = useState('')
  const debouncedText = useDebounced(text, SEARCH_DEBOUNCE_MS)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [reloadTick, setReloadTick] = useState(0)

  // 数据态（列表）
  const [loading, setLoading] = useState(true)
  /** 首载是否已结束（结束后查询一律「保留旧数据 + 局部 busy」，不再整屏替换） */
  const [hasLoaded, setHasLoaded] = useState(false)
  const [result, setResult] = useState<HitQueryResult>({ total: 0, items: [] })
  const [listError, setListError] = useState<string | null>(null)
  // 数据态（统计）
  const [stats, setStats] = useState<StatsResult | null>(null)
  /** 统计面板的加载失败原因（null=正常；有旧数据则保留展示 + 错误条） */
  const [statsError, setStatsError] = useState<string | null>(null)
  const [statsBusy, setStatsBusy] = useState(true)
  const [configSourceIds, setConfigSourceIds] = useState<string[]>([])
  /** 来源下拉备料失败（不再静默：尾部不可选项说明 + 失焦重试） */
  const [sourceOptionsFailed, setSourceOptionsFailed] = useState(false)
  /** 两个数据面上次成功读取的时刻（页头「更新于」） */
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  /** 手动刷新的转圈（点击置位，两数据面都落定后自动清除） */
  const [spin, setSpin] = useState(false)
  /** 卡头「查询中…」指示（>1s 才出现） */
  const [busyVisible, setBusyVisible] = useState(false)

  // 折叠态与榜单展开
  const [statsCollapsed, setStatsCollapsed] = useState(readStatsCollapsed)
  const [kwExpanded, setKwExpanded] = useState(false)

  /** 请求序号守卫：慢响应不得覆盖更新的查询状态（列表与统计各一套） */
  const reqSeq = useRef(0)
  const statsSeq = useRef(0)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const [selIdx, setSelIdx] = useState(-1)

  /** 生效窗口（chips 模式 → from/to；「全部」从 2000-01-01 查起） */
  const { from, to } = useMemo(() => {
    switch (win) {
      case 'today':
        return { from: today, to: today }
      case 'd14':
        return { from: daysAgoLocal(13), to: today }
      case 'd30':
        return { from: daysAgoLocal(29), to: today }
      case 'all':
        return { from: ALL_FROM, to: today }
      case 'custom':
        return { from: customFrom, to: customTo }
      default:
        return { from: defaultFrom, to: today }
    }
  }, [win, customFrom, customTo, today, defaultFrom])

  // 来源下拉：配置来源 ∪ 统计里出现过的来源（已删来源仍有历史数据）
  const sourceOptions = useMemo(() => {
    const ids = new Set<string>(configSourceIds)
    for (const s of stats?.bySource ?? []) ids.add(s.sourceId)
    return [...ids].sort()
  }, [configSourceIds, stats])

  // 来源下拉备料（失败置提示态，失焦重试）
  function loadSourceOptions(): void {
    void window.api
      .getConfig()
      .then((cfg) => {
        setConfigSourceIds(cfg.sources.map((s) => s.id))
        setSourceOptionsFailed(false)
      })
      .catch(() => setSourceOptionsFailed(true))
  }
  useEffect(() => {
    loadSourceOptions()
  }, [])

  // 列表查询：筛选/页码/页大小/刷新变化即拉（服务端过滤 + 分页）。
  // 非首载保留旧数据（仅置 loading 供压暗与指示，不整屏替换）；失败置错误条。
  useEffect(() => {
    const seq = ++reqSeq.current
    setLoading(true)
    void window.api
      .queryHits({
        fromDate: from,
        toDate: to,
        sourceId: sourceId === '' ? undefined : sourceId,
        matchedBy: mb.length === 0 ? undefined : mb,
        text: debouncedText === '' ? undefined : debouncedText,
        limit: pageSize,
        offset: page * pageSize
      })
      .then((r) => {
        if (seq !== reqSeq.current) return
        setResult(r)
        setListError(null)
        setUpdatedAt(new Date().toISOString())
        setLoading(false)
        setHasLoaded(true)
      })
      .catch((e: unknown) => {
        if (seq !== reqSeq.current) return
        // 错误 ≠ 空：旧结果保留（错误条在筛选行下），绝不落入「没有历史命中」空态
        setListError(errText(e))
        setLoading(false)
        setHasLoaded(true)
      })
  }, [from, to, sourceId, mb, debouncedText, page, pageSize, reloadTick])

  // 筛选变化 → 回第一页（分页自身不触发；已有页码时随后由列表查询兜底重拉）
  useEffect(() => {
    setPage(0)
  }, [from, to, sourceId, mb, debouncedText])

  // 筛选收窄导致当前页越界 → 收口到最后一页
  const pageCount = Math.max(1, Math.ceil(result.total / pageSize))
  useEffect(() => {
    if (page >= pageCount) setPage(pageCount - 1)
  }, [page, pageCount])

  // 翻页/换窗口：选中行与滚动位置重置（keep-alive 的跨页保持不受影响）
  useEffect(() => {
    setSelIdx(-1)
    scrollRef.current?.scrollTo({ top: 0 })
  }, [page, from, to, sourceId, mb, debouncedText, pageSize])

  // 统计面板：挂载 + 手动刷新时拉（固定近 14 天口径，不随列表筛选变化）。
  // 失败置错误态（错误条 + 重试入口，旧数据保留展示），成功清除错误态。
  useEffect(() => {
    const seq = ++statsSeq.current
    setStatsBusy(true)
    void window.api
      .getStats(STATS_DAYS)
      .then((s) => {
        if (seq !== statsSeq.current) return
        setStats(s)
        setStatsError(null)
        setUpdatedAt(new Date().toISOString())
        setStatsBusy(false)
      })
      .catch((e: unknown) => {
        if (seq !== statsSeq.current) return
        setStatsError(errText(e))
        setStatsBusy(false)
      })
  }, [reloadTick])

  // 「查询中…」>1s 才出现（ia §5.1 progressive-loading；完成即隐）
  useEffect(() => {
    if (!loading || !hasLoaded) {
      setBusyVisible(false)
      return
    }
    const timer = window.setTimeout(() => setBusyVisible(true), BUSY_INDICATOR_MS)
    return () => window.clearTimeout(timer)
  }, [loading, hasLoaded])

  // 刷新转圈：点击置位，两数据面都落定后清除
  useEffect(() => {
    if (!spin || loading || statsBusy) return
    setSpin(false)
  }, [spin, loading, statsBusy])

  function toggleMb(value: MatchedBy): void {
    setMb((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]))
  }

  function toggleStats(): void {
    setStatsCollapsed((v) => {
      const next = !v
      try {
        window.localStorage.setItem(STATS_COLLAPSED_KEY, next ? '1' : '0')
      } catch {
        /* 隐私模式等写失败：本次会话内仍生效，不记忆 */
      }
      return next
    })
  }

  /** 统一刷新：重拉统计与列表两个数据面 */
  function refresh(): void {
    setSpin(true)
    setReloadTick((t) => t + 1)
  }

  function resetFilters(): void {
    setWin('d7')
    setCustomFrom(defaultFrom)
    setCustomTo(today)
    setSourceId('')
    setMb([])
    setText('')
  }

  /** sparkbar 点柱 = 单日窗口（from=to=该日），日期 chips 落到「自定义」 */
  function pickDay(day: string): void {
    setCustomFrom(day)
    setCustomTo(day)
    setWin('custom')
  }

  // 日报「命中明细 →」深链（reports.md §7-5）：预填单日窗口（from=to=该日），
  // 落「自定义」。入参对象带 seq（每次深链新建对象），用户改过筛选后再点
  // 同一天也会重新触发——不能退化为按日期字符串比较
  useEffect(() => {
    const day = props.initialDate?.date
    if (day == null || day === '') return
    setCustomFrom(day)
    setCustomTo(day)
    setWin('custom')
  }, [props.initialDate])

  // 键盘行移动（HitList 同范式：roving 由 data-hit-index 承载）
  function moveSel(delta: number): void {
    const n = result.items.length
    if (n === 0) return
    const next =
      selIdx < 0 ? (delta > 0 ? 0 : n - 1) : Math.min(n - 1, Math.max(0, selIdx + delta))
    setSelIdx(next)
    window.requestAnimationFrame(() => {
      scrollRef.current
        ?.querySelector(`[data-hit-index="${next}"]`)
        ?.scrollIntoView({ block: 'nearest' })
    })
  }

  /** 选中行内的按钮代点（Enter 开原帖走真实点击，语义零复制） */
  function clickInRow(idx: number, selector: string): void {
    scrollRef.current
      ?.querySelector<HTMLButtonElement>(`[data-hit-index="${idx}"] ${selector}`)
      ?.click()
  }

  function handleListKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void {
    if (e.nativeEvent.isComposing) return
    const key = e.key
    if (key === 'j' || key === 'J' || key === 'ArrowDown') {
      e.preventDefault()
      moveSel(1)
    } else if (key === 'k' || key === 'K' || key === 'ArrowUp') {
      e.preventDefault()
      moveSel(-1)
    } else if (key === 'Enter') {
      e.preventDefault()
      if (selIdx >= 0) clickInRow(selIdx, '.hit-title')
    }
  }

  // 页级单键（§4.1）：/ 聚焦搜索、Esc 清空/还焦、PageUp/Down 翻页；
  // 焦点在输入控件内不抢键；IME 组合期不触发；keep-alive 隐藏页不越页生效
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return
      if (rootRef.current == null || rootRef.current.closest('[hidden]') != null) return
      const el = document.activeElement
      const inInput =
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable)
      if (e.key === 'Escape') {
        // 搜索框内：有文字先清空，已空则失焦还焦给列表
        if (el === searchRef.current) {
          if (text !== '') {
            setText('')
            return
          }
          scrollRef.current?.focus()
        }
        return
      }
      if (e.key === '/') {
        if (inInput) return
        e.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (e.key === 'PageUp' || e.key === 'PageDown') {
        if (inInput) return
        e.preventDefault() // 抑制列表容器原生翻滚，页码翻页优先
        const next = page + (e.key === 'PageDown' ? 1 : -1)
        if (next >= 0 && next < pageCount) setPage(next)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const dirty =
    win !== 'd7' || sourceId !== '' || mb.length > 0 || text !== '' || debouncedText !== ''

  const failPct = stats !== null ? Math.round(stats.pushFailRate * 100) : 0

  /** 14 天窗口铺满（byDay 只含有命中日；旧 → 新，供 sparkbar） */
  const sparkDays = useMemo(() => {
    const byDate = new Map((stats?.byDay ?? []).map((d) => [d.date, d.count]))
    const out: { date: string; count: number }[] = []
    for (let i = STATS_DAYS - 1; i >= 0; i--) {
      const date = daysAgoLocal(i)
      out.push({ date, count: byDate.get(date) ?? 0 })
    }
    return out
  }, [stats])

  /** Z2 卡头 aux：恒显当前筛选窗口（与统计 14 天固定窗口解耦——两数字不打架） */
  const windowAux =
    win === 'all'
      ? `窗口 全部 · 共 ${fmtNum(result.total)} 条`
      : `窗口 ${from.slice(5)} ～ ${to.slice(5)} · ${dayCountInclusive(from, to)} 天 · 共 ${fmtNum(result.total)} 条`

  /** 列表空态三态（§5.1）：默认窗口空 / 筛选后空 / 本页为空（越界收口兜底） */
  function renderEmpty(): ReactNode {
    if (result.total === 0) {
      if (!dirty) {
        return (
          <EmptyState
            title="近 7 天没有命中记录"
            hint="命中由监控运行时自动落盘，重启不会丢。若刚改过关键词或兴趣描述，等下一轮轮询后再来看。"
            action={
              <span className="empty-state-actions">
                <button type="button" className="btn" onClick={() => setWin('d30')}>
                  扩大到近 30 天
                </button>
                {props.onGoSettings != null && (
                  <button type="button" className="btn" onClick={props.onGoSettings}>
                    去配置关键词
                  </button>
                )}
              </span>
            }
          />
        )
      }
      return (
        <EmptyState
          title="当前筛选条件下没有命中"
          hint="换个日期范围、来源或命中方式试试；也可以直接搜标题或命中词。"
          action={
            <button type="button" className="btn" onClick={resetFilters}>
              重置筛选
            </button>
          }
        />
      )
    }
    return (
      <EmptyState
        title="本页没有记录"
        hint="筛选收窄后页码已自动收口，回到第一页看看。"
        action={
          <button type="button" className="btn" onClick={() => setPage(0)}>
            回到第一页
          </button>
        }
      />
    )
  }

  return (
    <div className="page page-history" ref={rootRef}>
      {/* Z0 · 页题区：页面身份 + 两个数据面的统一刷新与数据时刻 */}
      <PageHeader
        title="历史命中"
        subtitle="全部命中记录与统计画像 · 数据保存在本机，手动刷新查看最新"
        updatedAt={updatedAt}
        stale={false}
        updatedTitle="两个数据面（统计与记录）上次成功读取的时间"
        paused={props.active === false}
        actions={
          <button
            type="button"
            className={`btn${spin ? ' refreshing' : ''}`}
            disabled={spin}
            onClick={refresh}
            title="重新读取统计画像与命中记录"
          >
            <IconRefresh size={14} />
            刷新
          </button>
        }
      />

      {/* Z1 · 统计画像卡：固定近 14 天口径，不随下方列表筛选变化 */}
      <section className="card">
        <div className="card-head">
          <span className="card-head-group">
            <span className="card-title">统计画像</span>
            <span
              className="card-title-aux"
              title="统计是长期画像（帮你修剪关键词、看来源结构），列表是查询视图；两者口径独立，数字不同属正常"
            >
              近 {STATS_DAYS} 天固定窗口 · 不随下方筛选变化
            </span>
          </span>
          <button
            type="button"
            className="stat-detail-toggle"
            aria-expanded={!statsCollapsed}
            title={
              statsCollapsed
                ? '展开查看来源分布与关键词命中榜'
                : '隐藏来源分布与关键词命中榜，只留指标与趋势'
            }
            onClick={toggleStats}
          >
            {statsCollapsed ? '来源分布 · 关键词榜' : '收起来源与榜单'}
            <IconChevronDown size={12} />
          </button>
        </div>
        {statsError != null && (
          <ErrorBar
            message={`统计读取失败：${statsError}${stats != null ? '—— 以下为上次成功读取的数据' : ''}`}
            onRetry={refresh}
          />
        )}
        {statsBusy && stats == null && statsError == null && (
          /* 首载谱系同款（§C-10）：旋转图标 + 文案，不做骨架 */
          <div className="empty disp-loading">
            <IconRefresh size={12} />
            正在读取统计…
          </div>
        )}
        {stats != null && (
          <>
            <div className="metrics">
              <div className="metric" title="近 14 天落盘命中总数">
                <div className="k">总命中</div>
                <div className="v num">{fmtNum(stats.total)}</div>
              </div>
              <div
                className={`metric${failPct > 0 ? ' warn' : ''}`}
                title="推送尝试中 notifyError 非空的占比"
              >
                <div className="k">推送失败率</div>
                <div className="v num">{stats.total === 0 ? '—' : `${failPct}%`}</div>
              </div>
              <div
                className="metric"
                title={`近 ${STATS_DAYS} 天中有 ${stats.byDay.length} 天出现过命中`}
              >
                <div className="k">有命中天数</div>
                <div className="v num">{stats.byDay.length} 天</div>
              </div>
              <div
                className="metric"
                title="近 14 天产出过命中的来源个数（含已删除但留有历史数据的来源）"
              >
                <div className="k">来源数</div>
                <div className="v num">{stats.bySource.length}</div>
              </div>
            </div>
            <div className="chart-row">
              <div className="chart-block">
                <div className="cb-title">每日命中（近 {STATS_DAYS} 天）</div>
                <StatSparkbar days={sparkDays} onPickDay={pickDay} />
              </div>
              <div className="chart-block">
                <div className="cb-title">命中方式占比</div>
                <MatchedByBreakdown stats={stats} />
              </div>
            </div>
            {!statsCollapsed && (
              <div className="stats-detail">
                {stats.total === 0 ? (
                  <div className="src-empty">
                    近 14 天没有任何命中记录。命中在监控运行且关键词 / 兴趣 / 规则匹配时产生。
                  </div>
                ) : (
                  <div className="rank-cols">
                    <SourceRank stats={stats} />
                    <KeywordRank
                      stats={stats}
                      kwExpanded={kwExpanded}
                      onToggleKw={() => setKwExpanded((v) => !v)}
                    />
                  </div>
                )}
              </div>
            )}
            <ZeroRow stats={stats} onGoSettings={props.onGoSettings} />
          </>
        )}
      </section>

      {/* Z2 · 命中记录卡（card-grow 吃满剩余高；本页主任务区，唯一滚动在列表） */}
      <section className="card card-grow">
        <div className="card-head">
          <span className="card-head-group">
            <span className="card-title">命中记录</span>
            <span className="card-title-aux">{windowAux}</span>
            {busyVisible && (
              <span className="busy-ind">
                <IconRefresh size={12} />
                查询中…
              </span>
            )}
          </span>
        </div>
        <div className="filter-bar">
          <div className="tb-row">
            <div className="log-chips" role="group" aria-label="日期窗口（单选）">
              {WIN_OPTIONS.map((w) => (
                <button
                  type="button"
                  key={w.key}
                  className={`log-chip${win === w.key ? ' on' : ''}`}
                  aria-pressed={win === w.key}
                  title={w.title}
                  onClick={() => {
                    // 进入自定义：预填当前窗口，不从空区间开始
                    if (w.key === 'custom' && win !== 'custom') {
                      setCustomFrom(from)
                      setCustomTo(to)
                    }
                    setWin(w.key)
                  }}
                >
                  {w.label}
                </button>
              ))}
            </div>
            {win === 'custom' && (
              <span className="input-row">
                <input
                  type="date"
                  className="input"
                  value={customFrom}
                  max={today}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  aria-label="起始日期（含）"
                />
                <span className="card-count">至</span>
                <input
                  type="date"
                  className="input"
                  value={customTo}
                  max={today}
                  onChange={(e) => setCustomTo(e.target.value)}
                  aria-label="截止日期（含）"
                />
              </span>
            )}
            <select
              className="input disp-source"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              onBlur={() => {
                // 备料失败：失焦立即重试一次；连续失败保持提示不升级打扰
                if (sourceOptionsFailed) loadSourceOptions()
              }}
              aria-label="按来源筛选"
            >
              <option value="">全部来源</option>
              {sourceOptions.map((id) => (
                <option key={id} value={id}>
                  {sourceLabel(id)}
                </option>
              ))}
              {sourceOptionsFailed && (
                <option disabled value="__sourceLoadFailed__">
                  （来源清单读取失败，仅显示历史出现过的来源）
                </option>
              )}
            </select>
            <div className="log-chips" role="group" aria-label="命中方式（多选）">
              {MB_OPTIONS.map((o) => (
                <button
                  type="button"
                  key={o.value}
                  className={`log-chip${mb.includes(o.value) ? ' on' : ''}`}
                  aria-pressed={mb.includes(o.value)}
                  title={`筛选/取消筛选${o.label}命中`}
                  onClick={() => toggleMb(o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          <div className="tb-row">
            <span className="search-box">
              <IconSearch size={12} />
              <input
                ref={searchRef}
                className="input"
                placeholder="搜索标题、命中词、规则名"
                aria-label="搜索标题、命中词、规则名"
                title="按子串匹配，300ms 防抖；快捷键 /"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </span>
            {dirty && (
              <button
                type="button"
                className="btn"
                onClick={resetFilters}
                title="恢复默认：近 7 天 · 全部来源 · 全部命中方式"
              >
                重置筛选
              </button>
            )}
          </div>
        </div>
        {listError != null && (
          <ErrorBar
            message={`命中记录读取失败：${listError}${
              result.items.length > 0 ? ' · 以上为上次成功读取的数据' : ''
            }`}
            onRetry={refresh}
          />
        )}
        <div
          className={`hit-scroll${loading && hasLoaded ? ' list-dim' : ''}`}
          ref={scrollRef}
          tabIndex={0}
          aria-busy={loading ? true : undefined}
          aria-label="历史命中列表：j/k 或上下键移动，Enter 打开原帖，PageUp/Down 翻页"
          onKeyDown={handleListKeyDown}
        >
          {!hasLoaded ? (
            // 首载（无旧数据）= 旋转图标 + 文案（三态谱系 §C-10：与去向页/日报页
            // 同款 disp-loading 范式）；本地 IPC 快速返回，不做骨架
            <div className="empty disp-loading">
              <IconRefresh size={12} />
              正在读取历史记录…
            </div>
          ) : listError != null && result.items.length === 0 ? (
            <EmptyState
              title="读取失败"
              hint={listError}
              action={
                <button type="button" className="btn" onClick={refresh}>
                  重试
                </button>
              }
            />
          ) : result.items.length === 0 ? (
            renderEmpty()
          ) : (
            result.items.map((hit, i) => {
              const stamp = hit.notifiedAt ?? hit.topic.lastActiveAt
              return (
                <HitRow
                  key={hitRowKey(hit)}
                  hit={hit}
                  index={i}
                  time={formatHistoryStamp(stamp)}
                  timeWide
                  timeTitle={formatHistoryTitle(stamp)}
                  selected={i === selIdx}
                  onRowPointerDown={() => setSelIdx(i)}
                />
              )
            })
          )}
        </div>
        <Pager
          page={page}
          pageCount={pageCount}
          total={result.total}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </section>
    </div>
  )
}
