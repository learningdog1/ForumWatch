/**
 * 去向页（R10 阶段 2，dispositions.md 五区骨架，整页重写）：
 * Zone A 页头（数据面徽标「实时 · 最近 200 条」/「某日 · 落盘文件」+ 数据截至 +
 * 暂停自刷/刷新；页题 = 侧栏导航 label「去向」，B-2 页头契约）→ 单卡列表
 * （TASTE-UPGRADE §B-6 与历史页同构：卡头「判定记录」+ 窗口 aux + 查询指示 →
 * 卡内筛选条 .filter-bar（五分组 chips + 计数右锚 / 来源显示名下拉 / 日期 /
 * 搜索 300ms 防抖 / 重置，搜索与重置相对位置与历史页一致）→ Zone C 状态条
 * （错误 / 并入 / 口径提示互斥，优先级 错误 > 新记录 > 口径）→ Zone D 判定
 * 列表（唯一滚动区，行展开 = 完整原因 + 同帖轨迹 + 按 outcome 的「去调整」
 * 出口）→ Zone E 分段加载条（历史日全量返回 150+150，不做触底自动加载））。
 *
 * 保留资产：OUTCOME_GROUPS 分组、请求序号守卫 loadSeq、跨午夜 sticky 日期
 * 分隔、「回实时」条件显示、IME 处理；OUTCOME_LABELS / badgeTone 迁至
 * DispositionRow（值原样）。行渲染明确不并入 HitList（结构不同，杜绝第二份拷贝）。
 *
 * 错误 ≠ 空（REDESIGN §6.3）：dispositionsRecent / dispositionsDay 失败进独立
 * 错误条（旧数据保留 + 重试），绝不落入「还没有判定记录」空态。
 *
 * 自刷三态暂停（ia §5.1 + dispositions.md §3.5）：悬停列表（移开 2s 自动恢复）/
 * 筛选激活（清筛选自动恢复）/ 手动（显式恢复）；暂停期新记录一律进「并入 N 条
 * 新记录」角标不插列表（阶段 1 活列表范式，点击/回顶一次性并入）。keep-alive
 * 挂载：页面不活跃或窗口隐藏时不自刷，恢复可见立即刷一次。
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Disposition } from '@shared/ipc'
import { DispositionRow, dispositionKey } from '../components/DispositionRow'
import type { DispositionSettingsAnchor } from '../components/DispositionRow'
import { EmptyState } from '../components/EmptyState'
import { ErrorBar } from '../components/ErrorBar'
import { LiveBadge } from '../components/LiveBadge'
import { PageHeader } from '../components/PageHeader'
import { IconPause, IconPlay, IconRefresh, IconSearch } from '../components/icons'
import { sourceLabel } from '../lib/status'
import { formatClock, formatDayLabel, localDate } from '../lib/time'

/** 实时视图的自动刷新间隔（内存环数据面，IPC 廉益） */
const AUTO_REFRESH_MS = 10_000
/** 搜索防抖（对齐 History 惯例） */
const SEARCH_DEBOUNCE_MS = 300
/** 历史日分段渲染步长（首屏 150，继续加载 +150；不虚拟化、不触底自动加载） */
const SEGMENT_SIZE = 150
/** 实时环容量（并入后裁齐口径） */
const RING_SIZE = 200
/** 悬停暂停的移开自动恢复延时 */
const HOVER_RESUME_MS = 2_000
/** 「列表在顶」阈值（回顶 = 并入，活列表规则） */
const TOP_PX = 8
/** 最近一次列表交互的「阅读中」窗口（§6.1 统一规则：scrollTop 超阈或窗口内有交互） */
const INTERACTION_WINDOW_MS = 10_000
/** 「N 条新」角标计数封顶（阶段 1 范式） */
const BADGE_CAP = 99
/** 轨迹跳转落点高亮时长 */
const FLASH_MS = 1_600
/** 卡头「查询中…」指示延迟出现阈值（与历史页同款，ia §5.1 progressive-loading） */
const BUSY_INDICATOR_MS = 1_000

/** outcome 分组（chips 单选）；组内为该组包含的 outcome 集合（R7-W1 资产原样） */
const OUTCOME_GROUPS = [
  { id: 'all', label: '全部', outcomes: null },
  { id: 'push', label: '推送结果', outcomes: ['pushed', 'push-failed', 'muted'] },
  {
    id: 'blocked',
    label: '已拦截',
    outcomes: ['filtered', 'old-below-threshold', 'pinned', 'excluded', 'similar-swallowed']
  },
  { id: 'miss', label: '未命中', outcomes: ['miss', 'semantic-miss', 'semantic-below-threshold'] },
  { id: 'hold', label: '挂起中', outcomes: ['deferred', 'deferred-skip', 'semantic-pending'] }
] as const

type GroupId = (typeof OUTCOME_GROUPS)[number]['id']

/** 数字键 1..5 → 分组（键盘表；单键无修饰，与 Cmd+1..5 全局切页不冲突） */
const GROUP_KEYS: GroupId[] = OUTCOME_GROUPS.map((g) => g.id)

/** 计数千分位（dispositions.md §2.2：数字一律 mono + tabular-nums 防抖动） */
function fmtNum(n: number): string {
  return n.toLocaleString('zh-CN')
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 监控台「✗ 推送失败」→ 本页的搜索深链载荷（App 层构造） */
export interface DispositionsDeepLink {
  /** 预填的搜索文本（帖标题） */
  text: string
  /** 递增序号：同值深链可重复触发 */
  seq: number
}

interface DispositionsProps {
  /** keep-alive：当前页是否活跃（false = 挂载但隐藏：停自刷/动画，恢复活跃立即刷一次） */
  active?: boolean
  /** 搜索深链：切回实时数据面 + 清筛选 + 预填标题（排障动线一跳化，dispositions.md §4.1） */
  deepLink?: DispositionsDeepLink | null
  /** 引擎是否运行中（「还没有判定记录」空态在未运行时给「查看监控台」出口） */
  running?: boolean
  onGoDashboard?: () => void
  /** 展开态「去调整」出口 → 设置页锚点（锚点定位在设置页阶段接入，先切页） */
  onGoAnchor?: (anchor: DispositionSettingsAnchor) => void
}

export function Dispositions(props: DispositionsProps) {
  const { deepLink } = props
  const active = props.active !== false

  const [items, setItems] = useState<Disposition[]>([])
  /** 数据面切换（实时↔某日、日↔日）或首载：文字型加载态，旧数据面数据不留（§3.2） */
  const [faceLoading, setFaceLoading] = useState(true)
  /** 同数据面刷新（自刷/手动/防抖后查询）：列表原地保留，仅按钮转圈（§3.2） */
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 数据截至（最近一次成功读取时刻；暂停期常驻标注） */
  const [asOf, setAsOf] = useState<string | null>(null)

  const [group, setGroup] = useState<GroupId>('all')
  const [sourceId, setSourceId] = useState('')
  /** 空 = 实时最近（内存环）；有值 = 查该本地日的持久化流水 */
  const [day, setDay] = useState('')
  const dayRef = useRef(day)
  dayRef.current = day
  /** 请求序号守卫（R7-W1 资产）：切日/手动/自刷并发时，慢响应不得覆盖新状态 */
  const loadSeq = useRef(0)

  const [searchInput, setSearchInput] = useState('')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [selIdx, setSelIdx] = useState(-1)
  /** 历史日分段渲染条数 */
  const [shown, setShown] = useState(SEGMENT_SIZE)
  /** 暂停期承接的新记录（角标，不插列表） */
  const [pendingNew, setPendingNew] = useState<Disposition[]>([])
  const [hoverPaused, setHoverPaused] = useState(false)
  /** 手动暂停（显式恢复） */
  const [autoPaused, setAutoPaused] = useState(false)
  const [flashKey, setFlashKey] = useState<string | null>(null)
  /** 卡头「查询中…」指示（同面刷新 >1s 才出现；与历史页同款） */
  const [busyVisible, setBusyVisible] = useState(false)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const itemsRef = useRef<Disposition[]>([])
  const hoverResumeRef = useRef<number | null>(null)
  const flashTimerRef = useRef<number | null>(null)

  const today = localDate()
  const isDay = day !== ''

  // 活列表门控用的即时引用（监听器/回调避免闭包过期）
  const pausedRef = useRef(false)
  /** 列表最近一次交互（点击/键盘）时刻：10s 内有交互 = 阅读中（§6.1 统一规则，
      键盘用户 scrollTop=0 也不被自刷顶移） */
  const lastInteractRef = useRef(0)

  /** 应用一次成功读取：历史日/切面整表替换；实时面同刷按活列表门控决定
   *  「直接前插」还是「进角标」（暂停中 / 列表不在顶 / 10s 内有交互 → 不插列表） */
  const applyFresh = useCallback(
    (fresh: Disposition[], targetDay: string, faceSwitch: boolean): void => {
      if (faceSwitch || targetDay !== '') {
        itemsRef.current = fresh
        setItems(fresh)
        return
      }
      if (
        pausedRef.current ||
        (scrollRef.current?.scrollTop ?? 0) > TOP_PX ||
        Date.now() - lastInteractRef.current < INTERACTION_WINDOW_MS
      ) {
        // 实时面被门控（ia §5.1 阅读优先）：新记录进角标承接，列表原地不动
        const known = new Set(itemsRef.current.map(dispositionKey))
        const incoming = fresh.filter((d) => !known.has(dispositionKey(d)))
        if (incoming.length === 0) return
        setPendingNew((prev) => {
          const seen = new Set(prev.map(dispositionKey))
          const add = incoming.filter((d) => !seen.has(dispositionKey(d)))
          if (add.length === 0) return prev
          return [...prev, ...add].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
        })
        return
      }
      itemsRef.current = fresh
      setItems(fresh)
    },
    []
  )

  const load = useCallback(
    async (targetDay: string, opts?: { faceSwitch?: boolean }): Promise<void> => {
      const seq = ++loadSeq.current
      const faceSwitch = opts?.faceSwitch === true
      if (faceSwitch) {
        setFaceLoading(true)
        setItems([])
        itemsRef.current = []
        setPendingNew([])
        setExpanded(new Set())
        setSelIdx(-1)
      } else {
        setBusy(true)
      }
      try {
        const list =
          targetDay === ''
            ? await window.api.dispositionsRecent()
            : await window.api.dispositionsDay(targetDay)
        if (seq !== loadSeq.current) return
        // 两个数据面都返回旧→新（写入序）；展示时间倒序（新→旧）
        const fresh = list.slice().reverse()
        setError(null)
        setAsOf(new Date().toISOString())
        applyFresh(fresh, targetDay, faceSwitch)
      } catch (e) {
        // 错误 ≠ 空：旧数据保留（错误条在 Zone C），绝不伪造空态（audit #1）
        if (seq !== loadSeq.current) return
        setError(errText(e))
      } finally {
        if (seq === loadSeq.current) {
          setFaceLoading(false)
          setBusy(false)
        }
      }
    },
    [applyFresh]
  )

  // 数据面切换（含首载与「回实时」）；历史日分段条数重置
  useEffect(() => {
    void load(day, { faceSwitch: true })
  }, [day, load])
  useEffect(() => {
    setShown(SEGMENT_SIZE)
  }, [day])

  const groupOutcomes = useMemo(() => {
    const g = OUTCOME_GROUPS.find((x) => x.id === group)
    return g !== undefined && g.outcomes !== null ? new Set<string>(g.outcomes) : null
  }, [group])

  const sourceOptions = useMemo(() => {
    const ids = new Set<string>()
    for (const d of items) ids.add(d.sourceId)
    return [...ids].sort()
  }, [items])

  /** 筛选在已加载全量数据上计算（含分段未渲染部分，dispositions.md §3.4） */
  const filtered = useMemo(() => {
    const q = query.toLowerCase()
    return items.filter(
      (d) =>
        (groupOutcomes === null || groupOutcomes.has(d.outcome)) &&
        (sourceId === '' || d.sourceId === sourceId) &&
        (q === '' ||
          d.title.toLowerCase().includes(q) ||
          (d.detail != null && d.detail.toLowerCase().includes(q)))
    )
  }, [items, groupOutcomes, sourceId, query])

  /** 历史日只渲染已分段部分；实时面全量（恒 ≤200） */
  const rendered = useMemo(
    () => (isDay ? filtered.slice(0, shown) : filtered),
    [isDay, filtered, shown]
  )

  // 筛选激活 = 暂停自刷（清筛选自动恢复）；输入中的搜索词即时生效（防抖前就停）
  const filterActive = group !== 'all' || sourceId !== '' || query !== ''
  const filterTyping = searchInput.trim() !== ''
  const paused = !isDay && (autoPaused || hoverPaused || filterActive || filterTyping)
  pausedRef.current = paused

  // 同帖轨迹索引（正序；items 变化时重算）
  const trackByTitle = useMemo(() => {
    const m = new Map<string, Disposition[]>()
    for (const d of items) {
      const list = m.get(d.title)
      if (list != null) list.push(d)
      else m.set(d.title, [d])
    }
    for (const list of m.values()) list.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
    return m
  }, [items])

  // 列表缩短（环挤出/切面/筛选）时收口选中行
  useEffect(() => {
    if (selIdx >= rendered.length) setSelIdx(rendered.length === 0 ? -1 : rendered.length - 1)
  }, [rendered.length, selIdx])

  // 实时面 10s 自刷：页面不活跃 / 窗口隐藏 / 暂停期一律不刷（挂机降负）
  useEffect(() => {
    if (!active || isDay || paused) return
    const timer = window.setInterval(() => {
      if (document.hidden) return
      void load(dayRef.current)
    }, AUTO_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [active, isDay, paused, load])

  const prevActiveRef = useRef(active)
  useEffect(() => {
    const was = prevActiveRef.current
    prevActiveRef.current = active
    // 恢复活跃（keep-alive 切回）立即刷一次
    if (!was && active) void load(dayRef.current)
  }, [active, load])

  // 窗口从托盘恢复可见：实时面立即刷一次（自刷定时器在 hidden 期不触发）
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.hidden) return
      if (!active || dayRef.current !== '' || pausedRef.current) return
      void load(dayRef.current)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [active, load])

  // 搜索防抖（300ms；IME 组合中的输入不会触发单键快捷键，见键盘层）
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(searchInput.trim()), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  // 同面刷新的「查询中…」>1s 才出现（历史页同款；完成即隐，避免 10s 自刷闪烁）
  useEffect(() => {
    if (!busy) {
      setBusyVisible(false)
      return
    }
    const timer = window.setTimeout(() => setBusyVisible(true), BUSY_INDICATOR_MS)
    return () => window.clearTimeout(timer)
  }, [busy])

  // 深链（监控台推送失败 ✗）：回实时数据面 + 清筛选 + 预填标题搜索
  useEffect(() => {
    if (deepLink == null) return
    setGroup('all')
    setSourceId('')
    setDay('')
    setSearchInput(deepLink.text)
    setQuery(deepLink.text.trim())
    setExpanded(new Set())
    setSelIdx(-1)
  }, [deepLink])

  // 悬停暂停：移开 2s 自动恢复（dispositions.md §3.5）
  useEffect(() => {
    return () => {
      if (hoverResumeRef.current != null) window.clearTimeout(hoverResumeRef.current)
      if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current)
    }
  }, [])

  // 切页后列表 display:none 不派发 mouseleave：悬停暂停态在此清除，
  // 否则切回时鼠标未再移入列表，自刷会静默停摆（评审 P2）
  useEffect(() => {
    if (active) return
    if (hoverResumeRef.current != null) {
      window.clearTimeout(hoverResumeRef.current)
      hoverResumeRef.current = null
    }
    setHoverPaused(false)
  }, [active])

  function handleListMouseEnter(): void {
    if (hoverResumeRef.current != null) {
      window.clearTimeout(hoverResumeRef.current)
      hoverResumeRef.current = null
    }
    if (!hoverPaused) setHoverPaused(true)
  }

  function handleListMouseLeave(): void {
    if (hoverResumeRef.current != null) window.clearTimeout(hoverResumeRef.current)
    hoverResumeRef.current = window.setTimeout(() => {
      hoverResumeRef.current = null
      setHoverPaused(false)
    }, HOVER_RESUME_MS)
  }

  /** 并入角标承接的新记录（点击角标 / 滚回顶部触发；一次性批量入场） */
  function mergePending(): void {
    if (pendingNew.length === 0) return
    const merged = [...pendingNew, ...itemsRef.current].slice(0, RING_SIZE)
    itemsRef.current = merged
    setItems(merged)
    setPendingNew([])
  }

  function handleScroll(): void {
    const el = scrollRef.current
    if (el == null) return
    // 回顶 = 并入（ia §5.1）
    if (el.scrollTop <= TOP_PX && pendingNew.length > 0) mergePending()
  }

  function toggleKey(key: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleAt(idx: number): void {
    const rec = rendered[idx]
    if (rec != null) toggleKey(dispositionKey(rec))
  }

  /** 轨迹点击：滚动 + 高亮到对应行（分段未渲染到的先扩段） */
  function jumpToRecord(target: Disposition): void {
    const idx = filtered.findIndex((d) => dispositionKey(d) === dispositionKey(target))
    if (idx < 0) return
    if (idx >= shown) setShown(idx + 1)
    setSelIdx(idx)
    const key = dispositionKey(target)
    setFlashKey(key)
    if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current)
    flashTimerRef.current = window.setTimeout(() => setFlashKey(null), FLASH_MS)
    window.requestAnimationFrame(() => {
      scrollRef.current
        ?.querySelector(`[data-disp-index="${idx}"]`)
        ?.scrollIntoView({
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
            ? 'auto'
            : 'smooth',
          block: 'center'
        })
    })
  }

  function moveSel(delta: number): void {
    const n = rendered.length
    if (n === 0) return
    const next =
      selIdx < 0 ? (delta > 0 ? 0 : n - 1) : Math.min(n - 1, Math.max(0, selIdx + delta))
    setSelIdx(next)
    // 等 React 提交后再查 DOM，避免对旧列表查询
    window.requestAnimationFrame(() => {
      const row = scrollRef.current?.querySelector(`[data-disp-index="${next}"]`)
      row?.scrollIntoView({ block: 'nearest' })
      if (row instanceof HTMLElement) row.focus({ preventScroll: true })
    })
  }

  function clearFilters(): void {
    setGroup('all')
    setSourceId('')
    setSearchInput('')
    setQuery('')
  }

  function backToLive(): void {
    setDay('')
  }

  // 页级单键（dispositions.md §4.3）：焦点不在输入控件、非 IME/修饰键、本页可见
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return
      // keep-alive：切走的页面 hidden，单键不越页生效
      if (rootRef.current == null || rootRef.current.closest('[hidden]') != null) return
      const el = document.activeElement
      const inInput =
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable)
      // Esc 逐级退（输入框内也生效）：清空搜索 → 收起展开行 → 焦点回列表
      if (e.key === 'Escape') {
        if (searchInput !== '') {
          setSearchInput('')
          setQuery('')
          return
        }
        if (expanded.size > 0) {
          setExpanded(new Set())
          return
        }
        if (rendered.length > 0) setSelIdx(0)
        scrollRef.current?.focus()
        return
      }
      if (e.key === '/') {
        if (inInput) return
        e.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (inInput) return
      const key = e.key
      const lower = key.toLowerCase()
      if (key === 'j' || key === 'ArrowDown') {
        e.preventDefault()
        moveSel(1)
      } else if (key === 'k' || key === 'ArrowUp') {
        e.preventDefault()
        moveSel(-1)
      } else if (key === 'Enter') {
        // 焦点在行按钮上时由原生 click 展开，不双触发
        if (el instanceof HTMLElement && el.closest('.disp-row-main') != null) return
        if (selIdx >= 0) toggleAt(selIdx)
      } else if (lower === 'r') {
        e.preventDefault()
        if (!busy && !faceLoading) void load(dayRef.current)
      } else if (lower === 'p') {
        // 仅实时数据面有自刷可暂停
        if (dayRef.current === '') {
          e.preventDefault()
          setAutoPaused((v) => !v)
        }
      } else if (key >= '1' && key <= '5') {
        e.preventDefault()
        setGroup(GROUP_KEYS[Number(key) - 1])
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const countText = filterActive
    ? `筛选 ${fmtNum(filtered.length)} / ${fmtNum(items.length)}`
    : `${fmtNum(items.length)} 条`

  /** 卡头 aux：当前数据面窗口（历史页「窗口 …」同构；计数由筛选行 tb-count 承载） */
  const headAux = isDay
    ? `窗口 ${formatDayLabel(day, today)} · 落盘文件`
    : '窗口 实时 · 最近 200 条'

  const showAsOf = paused || isDay || error != null

  const strip =
    error != null ? (
      isDay ? (
        <ErrorBar
          message={`读取 ${day} 的落盘记录失败${items.length > 0 ? ' · 以下为先前读取的数据' : ''}`}
          detail={error}
          onRetry={() => void load(day)}
          extra={
            <button type="button" className="btn" onClick={backToLive}>
              回实时
            </button>
          }
        />
      ) : (
        <ErrorBar
          message={`读取实时记录失败 · ${
            items.length > 0 ? `以下为截至 ${formatClock(asOf)} 的数据` : '未获取到任何数据'
          }`}
          detail={items.length === 0 ? error : undefined}
          onRetry={() => void load('')}
        />
      )
    ) : pendingNew.length > 0 ? (
      <button
        type="button"
        className="live-pill"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        onClick={mergePending}
      >
        ↑ 并入{' '}
        {pendingNew.length > BADGE_CAP ? (
          <span className="num">{BADGE_CAP}+</span>
        ) : (
          <span className="num">{pendingNew.length}</span>
        )}{' '}
        条新记录
      </button>
    ) : isDay && day === today ? (
      <div className="notebar" role="note">
        今天的记录先写内存环（最近 200 条），落盘文件可能不含最新几条 ——
        <button type="button" className="btn" onClick={backToLive}>
          查看实时
        </button>
      </div>
    ) : null

  function renderEmpty(): ReactNode {
    if (filterActive) {
      return (
        <EmptyState
          title="当前筛选下没有记录"
          hint="换个分组或来源、清空搜索试试；挂起中的帖子等免打扰结束或摘要到点后会迁移为推送结果。"
          action={
            <button type="button" className="btn" onClick={clearFilters}>
              清空筛选
            </button>
          }
        />
      )
    }
    if (isDay) {
      return (
        <EmptyState
          title="该日没有落盘的判定记录"
          hint="落盘文件保留 7 天，更早的已清理；当天没有任何帖子经过判定管线时也不会产生文件。"
          action={
            <button type="button" className="btn" onClick={backToLive}>
              查看实时
            </button>
          }
        />
      )
    }
    return (
      <EmptyState
        title="还没有判定记录"
        hint="应用开始监控后，每条帖子在过滤、匹配、推送各环节的去向都会记在这里——为什么没推送，在这里查。"
        action={
          props.running === false && props.onGoDashboard != null ? (
            <button type="button" className="btn" onClick={props.onGoDashboard}>
              查看监控台
            </button>
          ) : undefined
        }
      />
    )
  }

  /** 跨午夜 sticky 日期分隔（实时面；历史日单日无分隔） */
  const rowsWithSeps = useMemo(() => {
    const out: Array<{ sep: string | null; rec: Disposition }> = []
    let last = ''
    for (const d of rendered) {
      const k = localDate(new Date(d.ts))
      if (!isDay && k !== last) {
        out.push({ sep: formatDayLabel(k, today), rec: d })
        last = k
      } else {
        out.push({ sep: null, rec: d })
      }
    }
    return out
  }, [rendered, isDay, today])

  return (
    <div className="page page-dispositions" ref={rootRef}>
      {/* Zone A · 页头（页题 = 侧栏导航 label「去向」，B-2 页头契约） */}
      <PageHeader
        title="去向"
        subtitle="每条帖子的判定结果 · 为什么没推送，在这里查"
        paused={!active}
        actions={
          <>
            <LiveBadge
              state={isDay ? 'disk' : paused ? 'paused' : 'live'}
              label={isDay ? `${formatDayLabel(day, today)} · 落盘文件` : '实时 · 最近 200 条'}
              asOf={showAsOf ? asOf : null}
            />
            {!isDay && (
              <button
                type="button"
                className="btn"
                onClick={() => setAutoPaused((v) => !v)}
                title={
                  autoPaused
                    ? '恢复 10 秒自动刷新（快捷键 P）'
                    : '暂停 10 秒自动刷新，避免阅读时列表重排（快捷键 P）'
                }
              >
                {autoPaused ? <IconPlay size={14} /> : <IconPause size={14} />}
                {autoPaused ? '自刷已暂停 · 恢复' : '暂停自刷'}
              </button>
            )}
            <button
              type="button"
              className={`btn${busy ? ' refreshing' : ''}`}
              disabled={faceLoading}
              onClick={() => void load(day)}
              title="立即读取最新判定记录（快捷键 R）"
            >
              <IconRefresh size={14} />
              刷新
            </button>
          </>
        }
      />

      {/* 判定记录列表卡（§B-6 与历史页同构：卡头 → 卡内筛选条 → 状态条 →
          唯一滚动区 → 分段加载条；工具条不再外置成卡） */}
      <section className="card card-disp-list">
        <div className="card-head">
          <span className="card-head-group">
            <span className="card-title">判定记录</span>
            <span className="card-title-aux">{headAux}</span>
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
            <div className="log-chips" role="group" aria-label="去向分组筛选（单选）">
              {OUTCOME_GROUPS.map((g) => (
                <button
                  type="button"
                  key={g.id}
                  className={`log-chip${group === g.id ? ' on' : ''}`}
                  aria-pressed={group === g.id}
                  onClick={() => setGroup(g.id)}
                >
                  {g.label}
                </button>
              ))}
            </div>
            <span className="tb-count num">{countText}</span>
          </div>
          <div className="tb-row">
            <select
              className="input disp-source"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              aria-label="按来源筛选"
            >
              <option value="">全部来源</option>
              {sourceOptions.map((id) => (
                <option key={id} value={id}>
                  {sourceLabel(id)}
                </option>
              ))}
            </select>
            <input
              type="date"
              className="input disp-date"
              value={day}
              max={today}
              onChange={(e) => setDay(e.target.value)}
              aria-label="按日期查落盘记录"
              title="留空 = 实时视图；选择日期 = 该日落盘文件（保留 7 天）"
            />
            {isDay && (
              <button type="button" className="btn" onClick={backToLive}>
                回实时
              </button>
            )}
            <span className="search-box">
              <IconSearch size={12} />
              <input
                ref={searchRef}
                className="input"
                placeholder="搜索标题或原因…"
                aria-label="搜索判定记录"
                title="匹配标题与原因全文（快捷键 /）"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
            </span>
            {filterActive && (
              <button
                type="button"
                className="btn"
                onClick={clearFilters}
                title="恢复默认：全部分组 · 全部来源 · 清空搜索"
              >
                重置筛选
              </button>
            )}
          </div>
        </div>

        {/* Zone C · 状态条（错误 / 并入 / 口径提示，互斥栈叠） */}
        {strip != null && <div className="disp-strip">{strip}</div>}

        {/* Zone D · 判定记录列表（唯一滚动区） */}
        <div
          className="disp-scroll"
          ref={scrollRef}
          tabIndex={0}
          aria-busy={faceLoading || busy ? true : undefined}
          aria-label="判定记录列表：j/k 或上下键移动，Enter 展开原因"
          onMouseEnter={handleListMouseEnter}
          onMouseLeave={handleListMouseLeave}
          onScroll={handleScroll}
          onPointerDownCapture={() => {
            lastInteractRef.current = Date.now()
          }}
          onKeyDownCapture={() => {
            lastInteractRef.current = Date.now()
          }}
        >
          {faceLoading ? (
            <div className="empty disp-loading">
              <IconRefresh size={12} />
              正在读取判定记录…
            </div>
          ) : error != null && items.length === 0 ? (
            // 错误与空态严格互斥：读取失败不落入「还没有判定记录」（§2.5）
            <div className="empty" />
          ) : items.length === 0 || rendered.length === 0 ? (
            renderEmpty()
          ) : (
            rowsWithSeps.map(({ sep, rec }, i) => (
              <Fragment key={dispositionKey(rec)}>
                {sep != null && <div className="day-sep">── {sep} ──</div>}
                <DispositionRow
                  record={rec}
                  index={i}
                  expanded={expanded.has(dispositionKey(rec))}
                  selected={i === selIdx}
                  flash={flashKey != null && flashKey === dispositionKey(rec)}
                  track={trackByTitle.get(rec.title) ?? [rec]}
                  onToggle={() => {
                    // 指针点击同步 roving 选中位（阶段 1 HitList 同范式）
                    setSelIdx(i)
                    toggleKey(dispositionKey(rec))
                  }}
                  onTrackJump={jumpToRecord}
                  onGoAnchor={props.onGoAnchor}
                />
              </Fragment>
            ))
          )}
        </div>
        {isDay && items.length > 0 && (
          <div className="load-more-bar">
            <span>
              已显示 <span className="num">{fmtNum(Math.min(shown, filtered.length))}</span> /{' '}
              <span className="num">{fmtNum(filtered.length)}</span> 条
            </span>
            {shown < filtered.length && (
              <button
                type="button"
                className="btn"
                onClick={() => setShown((s) => s + SEGMENT_SIZE)}
              >
                继续加载 +{SEGMENT_SIZE}
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
