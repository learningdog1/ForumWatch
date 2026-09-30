/**
 * 去向页（Watchtower 步骤 L，concept.html dispositions 屏一比一重做）：
 * 页头（eyebrow「Dispositions」+ 衬线大题「去向」+ 副题「这是可观测性，不是
 * 垃圾场 —— 14 类处置原因，每条帖子都有交代」（类数取 DISPOSITION_OUTCOMES
 * 真实长度）+ 右侧 chip「今日 N 条处置」（dispositionsDay(today) 落盘真实计数，
 * 与实时环口径独立）→ 分布段（.dist 7 段堆叠分布条 + .legend 可点 pill 组名
 * 计数；点击 = 设该组筛选 + 回顶，再点同组取消）→ 筛选条 .bar 两行（行一：
 * 搜索 / 7 组 chips + 全部 / 清除筛选；行二：来源下拉 / 日期 / 回实时 / 计数）
 * → 主表 .tbl（时间 / 来源 / 帖子 · 解释 / 原因（组色点 + 组名）/ ›，行展开
 * 跨列行 = 完整原因 + 同帖轨迹 + 按 outcome 的「去调整」出口）→ 分段加载条。
 *
 * 7 组映射（DISPOSITION_GROUPS，DispositionRow.tsx 单一事实源，分布条 / legend /
 * chips / 原因列同一映射联动）：未命中 = miss+semantic-miss；排除词否决 =
 * excluded；来源过滤 = filtered+old-below-threshold+pinned；评分不足 =
 * semantic-below-threshold；重复·限频 = similar-swallowed；挂起中 =
 * deferred+deferred-skip+semantic-pending；推送结果 = pushed+push-failed+muted
 * ——14 类真实 outcome 全覆盖（Record 全键编译期保证）。分布计数用当前数据面
 * 已加载全量（items，与主表同源），不另起请求。
 *
 * 机制全量保留（自查见各注）：活列表门控（active prop 停自刷/恢复即刷/窗口
 * 恢复可见即刷）、并入角标（点击/回顶一次性并入，悬停暂停移开 2s 自动恢复）、
 * deepLink 搜索深链（回实时 + 清筛选 + 预填标题）、历史日分段加载（150+150，
 * 不触底自动加载）、请求序号守卫 loadSeq（慢响应不覆盖新状态）、Esc 逐级退
 * （搜索词 → 收起展开行 → 焦点回列表）、键盘 0=全部 / 1..7=组筛选 / j/k 移动 /
 * Enter 展开 / R 刷新 / P 暂停 / / 聚焦搜索、错误 ≠ 空（旧数据保留 + 错误条 +
 * 重试，绝不落入空态）、空态出口（onGoDashboard / onGoAnchor）。
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { DISPOSITION_OUTCOMES } from '@shared/ipc'
import type { Disposition } from '@shared/ipc'
import { DispositionRow, dispositionKey } from '../components/DispositionRow'
import {
  DISPOSITION_GROUPS,
  OUTCOME_LABELS,
  dispositionGroupOf
} from '../components/DispositionRow'
import type { DispositionGroupId, DispositionSettingsAnchor } from '../components/DispositionRow'
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

/** 去向筛选值：'all' = 不按组过滤；其余为 7 组 id（DISPOSITION_GROUPS） */
type GroupFilter = 'all' | DispositionGroupId

/** 数字键 → 分组（键盘表；1..7 = 七组，0 = 全部；单键无修饰，与 Cmd+1..5 全局切页不冲突） */
const GROUP_KEYS: DispositionGroupId[] = DISPOSITION_GROUPS.map((g) => g.id)

/** 计数千分位（dispositions.md §2.2：数字一律 mono + tabular-nums 防抖动） */
function fmtNum(n: number): string {
  return n.toLocaleString('zh-CN')
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 减速动效偏好（legend 回顶平滑滚动让位，jumpToRecord 同款口径） */
function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
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
  /** 页头 chip「今日 N 条处置」：dispositionsDay(today) 落盘计数（null=未取到，
      读取失败隐藏 chip，不伪造 0） */
  const [todayCount, setTodayCount] = useState<number | null>(null)

  const [group, setGroup] = useState<GroupFilter>('all')
  const [sourceId, setSourceId] = useState('')
  /** 空 = 实时最近（内存环）；有值 = 查该本地日的持久化流水 */
  const [day, setDay] = useState('')
  const dayRef = useRef(day)
  dayRef.current = day
  /** 请求序号守卫（R7-W1 资产）：切日/手动/自刷并发时，慢响应不得覆盖新状态 */
  const loadSeq = useRef(0)
  /** 今日计数请求序号守卫（与列表守卫独立：chip 迟到不碍列表） */
  const todaySeq = useRef(0)

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
  /** 页头 chip 的取数日（跨午夜会话：随 today 重取，ref 供定时器/回调取现值） */
  const todayRef = useRef(today)
  todayRef.current = today
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
        // 错误 ≠ 空：旧数据保留（错误条在状态条），绝不伪造空态（audit #1）
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

  /** 页头 chip「今日 N 条处置」：dispositionsDay(今日) 落盘文件计数（独立请求，
      与列表数据面解耦——实时环只保 200 条且跨日，落盘文件才是当日全量口径；
      失败置 null 隐藏 chip，不显示假 0） */
  const loadTodayCount = useCallback((dateLocal: string): void => {
    const seq = ++todaySeq.current
    void window.api
      .dispositionsDay(dateLocal)
      .then((list) => {
        if (seq !== todaySeq.current) return
        setTodayCount(list.length)
      })
      .catch(() => {
        if (seq !== todaySeq.current) return
        setTodayCount(null)
      })
  }, [])

  /** 统一刷新（手动按钮 / R 键）：列表 + 今日计数两个数据面一起拉 */
  const refreshAll = useCallback((): void => {
    void load(dayRef.current)
    loadTodayCount(todayRef.current)
  }, [load, loadTodayCount])

  // 数据面切换（含首载与「回实时」）；历史日分段条数重置
  useEffect(() => {
    void load(day, { faceSwitch: true })
  }, [day, load])
  useEffect(() => {
    setShown(SEGMENT_SIZE)
  }, [day])

  // 首载取一次今日计数（挂载即取；后续随自刷/手动刷新/恢复活跃续命）
  useEffect(() => {
    loadTodayCount(todayRef.current)
  }, [loadTodayCount])

  const groupOutcomes = useMemo(() => {
    if (group === 'all') return null
    const g = DISPOSITION_GROUPS.find((x) => x.id === group)
    return g != null ? new Set<string>(g.outcomes) : null
  }, [group])

  const sourceOptions = useMemo(() => {
    const ids = new Set<string>()
    for (const d of items) ids.add(d.sourceId)
    return [...ids].sort()
  }, [items])

  /** 7 组分布计数（分布条 / legend / chips 三者同源：当前数据面已加载全量 items，
      不另起请求；与主表筛选前的分母一致） */
  const groupCounts = useMemo(() => {
    const counts = new Map<DispositionGroupId, number>()
    for (const g of DISPOSITION_GROUPS) counts.set(g.id, 0)
    for (const d of items) {
      const gid = dispositionGroupOf(d.outcome).id
      counts.set(gid, (counts.get(gid) ?? 0) + 1)
    }
    return counts
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

  // 实时面 10s 自刷：页面不活跃 / 窗口隐藏 / 暂停期一律不刷（挂机降负）；
  // 今日计数 chip 同节拍续命（同一本地 IPC 廉益）
  useEffect(() => {
    if (!active || isDay || paused) return
    const timer = window.setInterval(() => {
      if (document.hidden) return
      void load(dayRef.current)
      loadTodayCount(todayRef.current)
    }, AUTO_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [active, isDay, paused, load, loadTodayCount])

  const prevActiveRef = useRef(active)
  useEffect(() => {
    const was = prevActiveRef.current
    prevActiveRef.current = active
    // 恢复活跃（keep-alive 切回）立即刷一次（列表 + 今日计数）
    if (!was && active) {
      void load(dayRef.current)
      loadTodayCount(todayRef.current)
    }
  }, [active, load, loadTodayCount])

  // 窗口从托盘恢复可见：实时面立即刷一次（自刷定时器在 hidden 期不触发）
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.hidden) return
      if (!active || dayRef.current !== '' || pausedRef.current) return
      void load(dayRef.current)
      loadTodayCount(todayRef.current)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [active, load, loadTodayCount])

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

  /** legend pill / 筛选 chip 共用的组切换（单选 + 再点取消） */
  function toggleGroup(g: DispositionGroupId): void {
    setGroup((prev) => (prev === g ? 'all' : g))
  }

  /** legend pill 点击：设该组筛选 + 回顶（概念稿 dispoLegend 行为；回顶顺带
      触发活列表的「回顶 = 并入」） */
  function legendClick(g: DispositionGroupId): void {
    toggleGroup(g)
    scrollRef.current?.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
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
          behavior: prefersReducedMotion() ? 'auto' : 'smooth',
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
        // 焦点在行上时由行自身 onKeyDown 展开（tr 契约），不双触发
        if (el instanceof HTMLElement && el.closest('[data-disp-index]') != null) return
        if (selIdx >= 0) toggleAt(selIdx)
      } else if (lower === 'r') {
        e.preventDefault()
        if (!busy && !faceLoading) refreshAll()
      } else if (lower === 'p') {
        // 仅实时数据面有自刷可暂停
        if (dayRef.current === '') {
          e.preventDefault()
          setAutoPaused((v) => !v)
        }
      } else if (key === '0') {
        e.preventDefault()
        setGroup('all')
      } else if (key >= '1' && key <= '7') {
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

  /** 表头 aux：当前数据面窗口（历史页「窗口 …」同构；计数由筛选行右锚承载） */
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

  /** 跨午夜 sticky 日期分隔（实时面；历史日单日无分隔）——表内渲染为跨列行 */
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
      {/* 页头：eyebrow + 衬线大题 + 副题（类数取真实 outcome 全集）+ 今日计数 chip
          + 数据面徽标 + 自刷暂停 / 刷新 */}
      <PageHeader
        title="去向"
        eyebrow="Dispositions"
        subtitle={`这是可观测性，不是垃圾场 —— ${DISPOSITION_OUTCOMES.length} 类处置原因，每条帖子都有交代`}
        paused={!active}
        actions={
          <>
            {todayCount != null && (
              <span
                className="count-chip num"
                title="今日落盘流水（pipeline/今日.jsonl）的真实计数；实时列表只保最近 200 条且可跨日，两者口径独立"
              >
                今日 {fmtNum(todayCount)} 条处置
              </span>
            )}
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
              className="btn"
              disabled={faceLoading}
              onClick={refreshAll}
              title="立即读取最新判定记录与今日计数（快捷键 R）"
            >
              <IconRefresh size={14} />
              刷新
            </button>
          </>
        }
      />

      {/* 分布段：.dist 7 段堆叠分布条（组占比宽）+ .legend 可点 pill（组名 + 计数；
          与下方筛选 chips、表原因列同一映射联动；计数 = 当前数据面已加载全量） */}
      <section className="panel dist-panel" aria-label="去向分布（按 7 组）">
        <div className="dist" aria-hidden="true">
          {DISPOSITION_GROUPS.map((g) => {
            const n = groupCounts.get(g.id) ?? 0
            if (n === 0) return null
            return (
              <i
                key={g.id}
                className={`g-${g.id}`}
                style={{ '--w': String(n) } as CSSProperties}
                title={`${g.label} ${fmtNum(n)} 条`}
              />
            )
          })}
        </div>
        <div className="legend" role="group" aria-label="按去向组筛选（点击筛选，再点取消）">
          {DISPOSITION_GROUPS.map((g, i) => {
            const n = groupCounts.get(g.id) ?? 0
            const on = group === g.id
            return (
              <button
                type="button"
                key={g.id}
                className={`lg g-${g.id}${on ? ' on' : ''}`}
                aria-pressed={on}
                title={`筛选「${g.label}」（${g.outcomes.map((o) => OUTCOME_LABELS[o]).join('、')}）· 快捷键 ${i + 1} · 再点一次取消`}
                onClick={() => legendClick(g.id)}
              >
                <i className={`rdot g-${g.id}`} aria-hidden="true" />
                {g.label} <b className="num">{fmtNum(n)}</b>
              </button>
            )
          })}
        </div>
      </section>

      {/* 筛选条 .bar 行一：搜索 / 7 组 chips（+ 全部）/ 清除筛选 */}
      <div className="bar">
        <label className="search-wrap">
          <IconSearch size={14} />
          <input
            ref={searchRef}
            className="ipt"
            placeholder="快速定位：标题 / 解释 …"
            aria-label="搜索判定记录"
            title="匹配标题与解释全文（快捷键 /）"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </label>
        <div className="filter-chips" role="group" aria-label="去向分组筛选（单选，再点取消）">
          <button
            type="button"
            className={`filter-chip${group === 'all' ? ' on' : ''}`}
            aria-pressed={group === 'all'}
            title="不按去向组过滤（快捷键 0）"
            onClick={() => setGroup('all')}
          >
            全部
          </button>
          {DISPOSITION_GROUPS.map((g, i) => (
            <button
              type="button"
              key={g.id}
              className={`filter-chip${group === g.id ? ' on' : ''}`}
              aria-pressed={group === g.id}
              title={`筛选「${g.label}」（${g.outcomes.map((o) => OUTCOME_LABELS[o]).join('、')}）· 快捷键 ${i + 1} · 再点一次取消`}
              onClick={() => toggleGroup(g.id)}
            >
              {g.label}
            </button>
          ))}
        </div>
        {filterActive && (
          <button
            type="button"
            className="disp-link"
            onClick={clearFilters}
            title="恢复默认：全部分组 · 全部来源 · 清空搜索"
          >
            清除筛选
          </button>
        )}
      </div>

      {/* 筛选条 .bar 行二：来源下拉 / 日期（空 = 实时；有值 = 该日落盘）/ 回实时 / 计数 */}
      <div className="bar">
        <select
          className="sel disp-source"
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
          className="ipt dt"
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
        <span className="tb-count num">{countText}</span>
      </div>

      {/* 主表面板：面板头（窗口口径 + 查询指示）→ 状态条（错误 / 并入 / 口径提示）
          → 唯一滚动区 .disp-scroll（活列表规则）→ 分段加载条 */}
      <section className="panel disp-panel">
        <div className="panel-h">
          <span className="panel-h-group">
            <h3>判定记录</h3>
            <span className="panel-h-aux">{headAux}</span>
            {busyVisible && (
              <span className="busy-ind">
                <IconRefresh size={12} />
                查询中…
              </span>
            )}
          </span>
          <span className="ph-tag">Pipeline</span>
        </div>

        {/* 状态条（错误 / 并入 / 口径提示互斥栈叠；空态不占位） */}
        {strip != null && <div className="disp-strip">{strip}</div>}

        {/* 唯一滚动区（行为按 ia §5.1 活列表规则） */}
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
            <table className="tbl">
              <thead>
                <tr>
                  <th className="th-time">时间</th>
                  <th className="th-src">来源</th>
                  <th>帖子 · 解释</th>
                  <th className="th-reason">原因</th>
                  <th className="th-caret" aria-label="展开指示" />
                </tr>
              </thead>
              <tbody>
                {rowsWithSeps.map(({ sep, rec }, i) => (
                  <Fragment key={dispositionKey(rec)}>
                    {sep != null && (
                      <tr className="day-sep-row">
                        <td colSpan={5}>── {sep} ──</td>
                      </tr>
                    )}
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
                ))}
              </tbody>
            </table>
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
