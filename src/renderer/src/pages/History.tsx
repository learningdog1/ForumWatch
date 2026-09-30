/**
 * 历史命中页（Watchtower 步骤 K，概念稿 history 屏一比一重做）：
 * 页头（eyebrow「History」+ 衬线大题 + 副题 + 右侧计数 chip「近 7 天 · N 条」
 * 与统一刷新）→ 筛选条 .bar 两行（行一：搜索 / 命中方式 chips / 来源下拉 /
 * 日期区间起止；行二：WinKey 快捷窗口 chips + 重置）→ .hist-grid 主表 + 右栏
 * （HistoryRail 四块面板：7 日趋势 / TOP 关键词 / 价格分布 / 高峰时段热力）。
 *
 * 拖拽（概念 fwMakeDrag/localStorage 的 React 直译，useGripDrag 见
 * HistoryRail.tsx）：grip-y 左右调右栏宽（232-460px，fw-rail-w，双击复位 292）；
 * grip-x 上下调表高（220px-自然高，fw-hist-h，双击复位）。
 *
 * 机制全量保留（自查见各注）：请求序号守卫×2（列表/统计，右栏热力自带第三套）、
 * 搜索 300ms 防抖 + IME 组合不触发、筛选变化回第一页、越界自动收口、加载三态
 * （首载文字型 / 非首载保留旧数据 + 压暗 + >1s「查询中…」/ 错误≠空：错误条 +
 * 重试 + 旧数据保留）、空态三态（默认窗口空 / 筛选后空 / 本页空）、键盘表
 * （/ 聚焦搜索、Esc 清空/还焦、PageUp/Down 翻页、j/k 行移动、Enter 开焦点行，
 * 行渲染 HitRow table 变体，roving 契约 j/k/Enter/data-hit-index 原样映射到
 * 表格行，scroll-margin-top 让位粘性表头）、initialDate 深链（日报「命中明细」
 * 单日窗口预填）、WinKey 快捷窗口 chips、pickDay 单日窗口（右栏趋势点柱接入）、
 * 折叠记忆（关键词榜展开态，localStorage fw.history.statsCollapsed——旧 Z1
 * 统计卡折叠记忆的续命位）、来源下拉备料失败不静默（尾部不可选项 + 失焦重试）。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import type { HitQueryResult, StatsResult } from '@shared/ipc'
import { EmptyState } from '../components/EmptyState'
import { ErrorBar } from '../components/ErrorBar'
import { HitRow, hitRowKey } from '../components/HitRow'
import { HistoryRail, useGripDrag } from '../components/HistoryRail'
import { PageHeader } from '../components/PageHeader'
import { Pager, fmtNum } from '../components/Pager'
import { IconRefresh, IconSearch } from '../components/icons'
import { localDate } from '../lib/time'
import { sourceLabel } from '../lib/status'

/** 统计区窗口（天，右栏趋势取其近 7 天切片、关键词榜用全窗口；与主进程
    getStats 缺省一致，显式传避免两侧漂移） */
const STATS_DAYS = 14
/** 搜索框防抖（ms） */
const SEARCH_DEBOUNCE_MS = 300
/** 「查询中…」指示延迟出现阈值（ia §5.1 progressive-loading） */
const BUSY_INDICATOR_MS = 1_000
/** 「全部」窗口的起始日（从最早落盘记录查起；主进程同口径下限） */
const ALL_FROM = '2000-01-01'
/** 默认页大小档（Pager 三档之一） */
const DEFAULT_PAGE_SIZE = 50

/* ── 拖拽记忆的 localStorage 键（概念稿原键名直译）────────────────── */
const RAIL_W_KEY = 'fw-rail-w'
const HIST_H_KEY = 'fw-hist-h'
/** 右栏宽与表高的拖拽边界（概念稿原值：宽 232-460 复位 292；高下限 220） */
const RAIL_W_MIN = 232
const RAIL_W_MAX = 460
const RAIL_W_DEFAULT = 292
const HIST_H_MIN = 220

type MatchedBy = 'literal' | 'semantic' | 'rule' | 'matchall'

/** 命中方式分档（现有真实口径四档；概念「关键词/价格/AI 语义」按映射纪律
    （步骤 G 裁决）落本命名——字面→关键词、规则→价格、语义→AI 语义，不新造档） */
const MB_OPTIONS: { value: MatchedBy; label: string; title: string }[] = [
  { value: 'literal', label: '字面', title: '筛选/取消筛选字面（关键词）命中' },
  { value: 'rule', label: '规则', title: '筛选/取消筛选价格规则命中' },
  { value: 'semantic', label: '语义', title: '筛选/取消筛选 AI 语义命中' },
  { value: 'matchall', label: '全匹配', title: '筛选/取消筛选来源级全匹配命中' }
]

/** 日期快捷 chips（单选；自定义激活时起止 date input 即本窗口） */
type WinKey = 'today' | 'd7' | 'd14' | 'd30' | 'all' | 'custom'

const WIN_OPTIONS: { key: WinKey; label: string; title?: string }[] = [
  { key: 'today', label: '今天' },
  { key: 'd7', label: '近 7 天' },
  { key: 'd14', label: '近 14 天' },
  { key: 'd30', label: '近 30 天' },
  { key: 'all', label: '全部', title: '从最早落盘记录（2000-01-01 起）查起' },
  { key: 'custom', label: '自定义' }
]

/** 各窗口的页头计数 chip 文案（概念「近 7 天 · 241 条」的动态口径版） */
const WIN_CHIP: Record<WinKey, string> = {
  today: '今天',
  d7: '近 7 天',
  d14: '近 14 天',
  d30: '近 30 天',
  all: '全部',
  custom: ''
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 近 N 天的起始本地日期（含端点：today-(N-1) .. today） */
function daysAgoLocal(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return localDate(d)
}

/** 含端点的天数（面板头 aux 用）；无效区间按 1 天计 */
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
  /** 面板头「查询中…」指示（>1s 才出现） */
  const [busyVisible, setBusyVisible] = useState(false)

  /** 请求序号守卫：慢响应不得覆盖更新的查询状态（列表与统计各一套） */
  const reqSeq = useRef(0)
  const statsSeq = useRef(0)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)
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
        // 错误 ≠ 空：旧结果保留（错误条在面板头之下），绝不落入「没有历史命中」空态
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

  /** 统一刷新：重拉统计与列表两个数据面（右栏热力随 reloadTick 同步重拉） */
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

  /** 右栏趋势点柱 = 单日窗口（from=to=该日），日期 chips 落到「自定义」 */
  function pickDay(day: string): void {
    setCustomFrom(day)
    setCustomTo(day)
    setWin('custom')
  }

  /** 编辑起/止日期 = 进入「自定义」窗口（另一端预填当前生效窗口，不从空区间开始） */
  function editDateBound(bound: 'from' | 'to', value: string): void {
    if (value === '') return
    if (bound === 'from') {
      setCustomFrom(value)
      setCustomTo(to)
    } else {
      setCustomFrom(from)
      setCustomTo(value)
    }
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

  // 键盘行移动（roving 由 data-hit-index 承载；行是 HitRow table 变体的 <tr>，
  // 查询/滚动与旧列表契约同款）
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
      // 焦点已在行内时，行自身的 onKeyDown 已激活（开抽屉），不重复代点
      if (e.target instanceof Element && e.target.closest('[data-hit-index]') != null) return
      e.preventDefault()
      if (selIdx >= 0) {
        // 选中行主体的真实点击（语义零复制：走 tr 的 onClick = openDrawer）
        scrollRef.current
          ?.querySelector<HTMLElement>(`[data-hit-index="${selIdx}"]`)
          ?.click()
      }
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

  /** 面板头 aux：恒显当前筛选窗口（与统计固定窗口解耦——两数字不打架） */
  const windowAux =
    win === 'all'
      ? `窗口 全部 · 共 ${fmtNum(result.total)} 条`
      : `窗口 ${from.slice(5)} ～ ${to.slice(5)} · ${dayCountInclusive(from, to)} 天 · 共 ${fmtNum(result.total)} 条`

  /** 页头计数 chip：窗口名动态（概念「近 7 天 · 241 条」；自定义窗口给日期段） */
  const countChip =
    win === 'custom'
      ? `${from.slice(5)}～${to.slice(5)} · ${fmtNum(result.total)} 条`
      : `${WIN_CHIP[win]} · ${fmtNum(result.total)} 条`

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

  /* ── 拖拽（概念稿 fwMakeDrag 的 React 直译）─────────────────────────
     grip-y：railW = clamp(232,460, grid.right - clientX) → grid 的 --rail-w
     （列宽由 CSS 变量承载，232-460 / 复位 292 / 持久化 fw-rail-w）。
     grip-x：h = clamp(220,自然高, clientY - panel.top + 4) → panel.style.height
     （持久化 fw-hist-h；挂 .has-height 让内滚区放开默认 max-height 上限）。
     读写全 try/catch；恢复时不按挂载瞬间的「自然高」截断（数据异步到达，
     挂载时面板尚矮——与概念静态页的差异，存值本身就是合法拖出来的高度）。 */
  const gripYHandlers = useGripDrag(
    (e) => {
      const grid = gridRef.current
      if (grid == null) return
      const w = Math.round(
        Math.min(RAIL_W_MAX, Math.max(RAIL_W_MIN, grid.getBoundingClientRect().right - e.clientX))
      )
      grid.style.setProperty('--rail-w', `${w}px`)
      try {
        window.localStorage.setItem(RAIL_W_KEY, String(w))
      } catch {
        /* 隐私模式等写失败：本次会话内仍生效，不记忆 */
      }
    },
    () => {
      gridRef.current?.style.setProperty('--rail-w', `${RAIL_W_DEFAULT}px`)
      try {
        window.localStorage.removeItem(RAIL_W_KEY)
      } catch {
        /* ignore */
      }
    }
  )

  /** 自然高捕捉：未设显式高度时的面板实高（拖高上限；复位/清空后重捕捉） */
  const naturalHRef = useRef(0)
  const gripXHandlers = useGripDrag(
    (e) => {
      const panel = panelRef.current
      if (panel == null) return
      if (naturalHRef.current === 0) {
        naturalHRef.current =
          panel.style.height === '' ? (panel.offsetHeight || 2000) : 2000
      }
      const h = Math.min(
        naturalHRef.current || 2000,
        Math.max(HIST_H_MIN, e.clientY - panel.getBoundingClientRect().top + 4)
      )
      panel.style.height = `${Math.round(h)}px`
      panel.classList.add('has-height')
      try {
        window.localStorage.setItem(HIST_H_KEY, String(Math.round(h)))
      } catch {
        /* ignore */
      }
    },
    () => {
      const panel = panelRef.current
      if (panel == null) return
      panel.style.height = ''
      panel.classList.remove('has-height')
      naturalHRef.current = 0
      try {
        window.localStorage.removeItem(HIST_H_KEY)
      } catch {
        /* ignore */
      }
    }
  )

  // 记忆恢复（概念 tryRestore 的直译；宽夹取 [232,460]，高夹取下限 220）
  useLayoutEffect(() => {
    try {
      const w = Math.min(
        RAIL_W_MAX,
        Math.max(RAIL_W_MIN, Number(window.localStorage.getItem(RAIL_W_KEY)) || RAIL_W_DEFAULT)
      )
      gridRef.current?.style.setProperty('--rail-w', `${w}px`)
    } catch {
      /* ignore */
    }
    try {
      const h = Number(window.localStorage.getItem(HIST_H_KEY))
      const panel = panelRef.current
      if (!Number.isNaN(h) && h >= HIST_H_MIN && panel != null) {
        panel.style.height = `${Math.round(h)}px`
        panel.classList.add('has-height')
      }
    } catch {
      /* ignore */
    }
  }, [])

  return (
    <div className="page page-history" ref={rootRef}>
      {/* Z0 · 页题区：页面身份 + 窗口计数 chip + 两个数据面的统一刷新与数据时刻 */}
      <PageHeader
        title="历史命中"
        eyebrow="History"
        subtitle="每一条命中都有迹可循 · 点击行查看完整判定链"
        updatedAt={updatedAt}
        stale={false}
        updatedTitle="两个数据面（统计与记录）上次成功读取的时间"
        paused={props.active === false}
        actions={
          <>
            <span
              className="count-chip num"
              title="当前查询窗口的命中总数（跟随筛选即时更新）"
            >
              {countChip}
            </span>
            <button
              type="button"
              className={`btn${spin ? ' busy' : ''}`}
              disabled={spin}
              onClick={refresh}
              title="重新读取统计画像与命中记录"
            >
              {spin ? null : <IconRefresh size={14} />}
              刷新
            </button>
          </>
        }
      />

      {/* 筛选条 .bar 行一：搜索 / 命中方式 / 来源 / 日期区间起止 */}
      <div className="bar">
        <label className="search-wrap">
          <IconSearch size={14} />
          <input
            ref={searchRef}
            className="ipt"
            placeholder="快速定位：标题 / 关键词 …"
            aria-label="搜索标题、命中词、规则名"
            title="按子串匹配，300ms 防抖；快捷键 /"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <div className="filter-chips" role="group" aria-label="命中方式（多选）">
          <button
            type="button"
            className={`filter-chip${mb.length === 0 ? ' on' : ''}`}
            aria-pressed={mb.length === 0}
            title="不按命中方式过滤（全部）"
            onClick={() => setMb([])}
          >
            全部
          </button>
          {MB_OPTIONS.map((o) => (
            <button
              type="button"
              key={o.value}
              className={`filter-chip${mb.includes(o.value) ? ' on' : ''}`}
              aria-pressed={mb.includes(o.value)}
              title={o.title}
              onClick={() => toggleMb(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
        <select
          className="sel hist-source"
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
        <input
          type="date"
          className="ipt dt"
          value={win === 'all' ? '' : from}
          max={today}
          aria-label="起始日期（含）"
          title={
            win === 'all'
              ? '「全部」窗口不设起始界限（显示为空）；选取日期即切换到「自定义」'
              : '起始日期（含）；编辑即切换到「自定义」窗口'
          }
          onChange={(e) => editDateBound('from', e.target.value)}
        />
        <span className="date-sep" aria-hidden="true">
          →
        </span>
        <input
          type="date"
          className="ipt dt"
          value={win === 'all' ? '' : to}
          min={from}
          max={today}
          aria-label="截止日期（含）"
          title="截止日期（含）；编辑即切换到「自定义」窗口"
          onChange={(e) => editDateBound('to', e.target.value)}
        />
      </div>

      {/* 筛选条 .bar 行二：WinKey 快捷窗口 chips（机制保留，并入 bar）+ 重置 */}
      <div className="bar">
        <div className="filter-chips" role="group" aria-label="日期窗口（单选）">
          {WIN_OPTIONS.map((w) => (
            <button
              type="button"
              key={w.key}
              className={`filter-chip${win === w.key ? ' on' : ''}`}
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

      {/* 主体 .hist-grid：左命中记录表（可拖高）+ 右统计栏（可拖宽） */}
      <div className="hist-grid" ref={gridRef}>
        <section
          className="panel hist-panel"
          ref={panelRef}
          title="命中记录 · 底缘可上下拖动调高（双击复位）"
        >
          <div className="panel-h">
            <span className="panel-h-group">
              <h3>命中记录</h3>
              <span className="panel-h-aux" title="当前筛选窗口（统计栏是固定窗口，两者口径独立）">
                {windowAux}
              </span>
              {busyVisible && (
                <span className="busy-ind">
                  <IconRefresh size={12} />
                  查询中…
                </span>
              )}
            </span>
            <span className="ph-tag">Hits</span>
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
            className={`hist-scroll${loading && hasLoaded ? ' list-dim' : ''}`}
            ref={scrollRef}
            tabIndex={0}
            aria-busy={loading ? true : undefined}
            aria-label="历史命中表：j/k 或上下键移动，Enter 查看命中详情，PageUp/Down 翻页"
            onKeyDown={handleListKeyDown}
          >
            {!hasLoaded ? (
              // 首载（无旧数据）= 旋转图标 + 文案（三态谱系 §C-10）；本地 IPC
              // 快速返回，不做骨架
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
              <table className="tbl">
                <thead>
                  <tr>
                    <th>帖子标题</th>
                    <th>来源</th>
                    <th>规则</th>
                    <th>价格</th>
                    <th>时间</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {result.items.map((hit, i) => {
                    const stamp = hit.notifiedAt ?? hit.topic.lastActiveAt
                    return (
                      <HitRow
                        key={hitRowKey(hit)}
                        variant="table"
                        hit={hit}
                        index={i}
                        time={formatHistoryStamp(stamp)}
                        timeTitle={formatHistoryTitle(stamp)}
                        selected={i === selIdx}
                        onRowPointerDown={() => setSelIdx(i)}
                      />
                    )
                  })}
                </tbody>
              </table>
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
          <div
            className="grip-x"
            title="上下拖动调高 · 双击复位"
            {...gripXHandlers}
          />
        </section>

        <HistoryRail
          stats={stats}
          statsError={statsError}
          statsBusy={statsBusy}
          onRefresh={refresh}
          onPickDay={pickDay}
          onGoSettings={props.onGoSettings}
          pageHits={result.items}
          reloadTick={reloadTick}
          today={today}
          gripY={<div className="grip-y" title="左右拖动调宽 · 双击复位" {...gripYHandlers} />}
        />
      </div>
    </div>
  )
}
