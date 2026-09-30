/**
 * 监控台（Watchtower 步骤 J，概念稿 dashboard 屏一比一重做）：
 * 页头（eyebrow「Overview · MM-DD 周X」+ 衬线大题 + 暂停/恢复与立即刷新两钮）
 * → 4 张 stat 卡（今日命中 / 已推送 / AI 判定无关 / 轮询错误；数字 countUp
 * 900ms ease-out，值变化才重滚；spark 内联 SVG 面积小图）→ 运行状态条
 * runstrip（原 StatusCard 的信息全量收编：状态徽标 / 轮询节奏 / 连续失败 /
 * 累计命中 / AI 运行态 / 测试通知 / 挂起 chip / 最近错误 / 操作反馈，一项不丢）
 * → dash-grid 5:7（左「来源健康度」SourceHealth 表 / 右「实时命中流」LiveFeed）
 * → 运行日志（LogView 整宽保留，默认折叠可展开）。
 *
 * 按钮逻辑在本层：control() 统一三态反馈（busy 转圈 → toast+行内 ✓ / 行内 ✗
 * + [重试]；「立即刷新」= 现有 runNow 语义（忽略等待补一轮轮询），不造主进程
 * 不存在的能力）。键盘（§6.1）：P 暂停/恢复、R 立即轮询（暂停时行内反馈）、
 * T 测试通知、L 聚焦日志筛选 chips（折叠态先展开）；单键仅在焦点不在输入
 * 控件、非 IME 组合、且本页可见时生效。
 * 数据：status/hits/logs 来自 useApi（App 层单源订阅）；stats（14 日命中/推送）
 * 与去向逐日（AI 判定无关）由本页自取，请求序号守卫防过期覆盖；配置面
 * （来源方式 + 全局间隔）激活时拉取。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { StatsResult } from '@shared/ipc'
import { deriveTrayLabel } from '@shared/ipc'
import { ErrorBar } from '../components/ErrorBar'
import { LiveFeed } from '../components/LiveFeed'
import { LogView } from '../components/LogView'
import { PageHeader } from '../components/PageHeader'
import { fmtNum } from '../components/Pager'
import { SourceHealth, sourceMethodLabel } from '../components/SourceHealth'
import {
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconChevronDown,
  IconClock,
  IconPause,
  IconPlay,
  IconRefresh,
  IconSend,
  IconX
} from '../components/icons'
import type { ApiState } from '../hooks/useApi'
import { useNow } from '../hooks/useNow'
import { deriveRunState, matchModeLabel } from '../lib/status'
import { showToast } from '../lib/toast'
import { formatClock, formatRelative, localDate } from '../lib/time'

type CtlCmd = 'pause' | 'resume' | 'runNow' | 'sendTest'

/** 失败反馈前缀（§4：「暂停失败 / 恢复失败 / 触发失败 / 发送失败」） */
const CMD_LABEL: Record<CtlCmd, string> = {
  pause: '暂停',
  resume: '恢复',
  runNow: '触发',
  sendTest: '发送'
}

/** 成功 toast 文案（概念稿暂停/刷新按钮的 toast 反馈对位） */
const CMD_TOAST: Record<CtlCmd, string> = {
  pause: '已暂停 · 轮询与推送判定已停止',
  resume: '已恢复 · 按设置间隔继续轮询',
  runNow: '已触发补一轮轮询',
  sendTest: '已发送测试消息 · 请在各通知通道查收'
}

interface CtlState {
  phase: 'idle' | 'busy' | 'ok' | 'err'
  cmd: CtlCmd | null
  /** 完成时刻（成功反馈里的时间戳） */
  doneAt?: string
  /** 失败原因（err 用） */
  error?: string
  /** 完整覆盖默认「{label}失败：」格式的自定义失败文案（如 R 键暂停态提示） */
  message?: string
}

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'] as const

/** 概念稿 eyebrow 日期段「09-30 周二」（MM-DD 两位对齐 time.ts pad2 口径；
    中文周几与 formatDayLabel 同字表，此处按概念形态本地小函数派生） */
function eyebrowDate(d: Date): string {
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `${md} 周${WEEKDAY_LABELS[d.getDay()]}`
}

/** 本地日前推 N 天（Date 运算兜底跨月/跨年，不用毫秒减法防 DST 漂移） */
function dateNDaysAgo(base: string, n: number): string {
  const d = new Date(`${base}T00:00:00`)
  if (Number.isNaN(d.getTime())) return base
  d.setDate(d.getDate() - n)
  return localDate(d)
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 减速动效偏好（countUp 数字滚动让位；Dispositions/Settings 同款口径） */
function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/* ── countUp：900ms ease-out 数字滚动（概念稿 JS 半边）────────────────
   值变化才重滚（settledRef 记已到达值；keep-alive 恢复/无关重渲染零重播）；
   中途变值从当前显示帧续滚；null（未读取）复位为 '—' 档。 */
const COUNTUP_MS = 900

function useCountUp(target: number | null): number | null {
  const [display, setDisplay] = useState<number | null>(null)
  /** 上一次已开始滚动的目标值（与目标相同则不重滚） */
  const settledRef = useRef<number | null>(null)
  /** 当前显示帧（中途变值的续滚起点） */
  const displayRef = useRef<number | null>(null)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    if (rafRef.current != null) {
      window.cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (target == null) {
      settledRef.current = null
      displayRef.current = null
      setDisplay(null)
      return
    }
    if (settledRef.current === target) return
    settledRef.current = target
    // 减速动效（§8-A）：rAF 驱动的滚动不受 base.css 全局熔断（0.01ms 技术）
    // 约束，命中时直接 settle 到终值，不滚动
    if (prefersReducedMotion()) {
      displayRef.current = target
      setDisplay(target)
      return
    }
    const from = displayRef.current ?? 0
    settledRef.current = target
    const t0 = performance.now()
    const step = (t: number): void => {
      const p = Math.min(1, (t - t0) / COUNTUP_MS)
      const eased = 1 - Math.pow(1 - p, 3)
      const v = Math.round(from + (target - from) * eased)
      displayRef.current = v
      setDisplay(v)
      if (p < 1) rafRef.current = window.requestAnimationFrame(step)
      else rafRef.current = null
    }
    rafRef.current = window.requestAnimationFrame(step)
  }, [target])

  useEffect(() => {
    return () => {
      if (rafRef.current != null) window.cancelAnimationFrame(rafRef.current)
    }
  }, [])

  return display
}

/* ── spark 面积小图（概念稿 .spark 内联 SVG 半边）────────────────────
   120×30 viewBox + preserveAspectRatio=none 拉伸；面积 path 填色 + 描边 path
   （.sf/.sl 形制见 dashboard.css，填色走令牌派生）。纯展示图，title 带
   aria-label 同款口径。 */
const SPARK_W = 120
const SPARK_H = 30

function sparkPaths(values: number[]): { area: string; line: string } {
  const max = Math.max(1, ...values)
  const n = values.length
  const pts = values.map((v, i) => {
    const x = n <= 1 ? 0 : (i / (n - 1)) * SPARK_W
    const y = SPARK_H - 2 - (v / max) * (SPARK_H - 6)
    return [x, y] as const
  })
  const line = pts
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(' ')
  return {
    area: `${line} L${SPARK_W} ${SPARK_H} L0 ${SPARK_H} Z`,
    line
  }
}

function Sparkline(props: { values: number[]; tone: 'a' | 's' | 'i'; label: string }) {
  const { area, line } = sparkPaths(props.values)
  return (
    <svg
      className="spark"
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={props.label}
    >
      <title>{props.label}</title>
      <path className={`sf sf-${props.tone}`} d={area} />
      <path className={`sl sl-${props.tone}`} d={line} fill="none" />
    </svg>
  )
}

/** 数据未到时的 spark 槽位占位（保卡片等高；虚线基线 = 该卡无走势数据） */
function SparkPending() {
  return <div className="spark spark-pending" aria-hidden="true" />
}

/** delta 行：较昨日差值（▲/▼ 用 SVG 箭头承载；upIsGood 决定升向是否走 ok 档） */
function DeltaLine(props: { diff: number | null; upIsGood: boolean; title?: string }) {
  const { diff } = props
  if (diff == null) return <p className="delta">统计读取中…</p>
  if (diff === 0) return <p className="delta">与昨日持平</p>
  const up = diff > 0
  return (
    <p className={`delta${up && props.upIsGood ? ' up' : ''}`} title={props.title}>
      {up ? <IconArrowUp size={10} /> : <IconArrowDown size={10} />}
      {`${up ? '+' : '-'}${Math.abs(diff)} 较昨日`}
    </p>
  )
}

/** stat 卡（primitives .stat 壳）：标签 + countUp 数字 + delta + spark */
function StatCard(props: {
  label: string
  value: number | null
  numTitle: string
  cardTitle: string
  delta: ReactNode
  spark: ReactNode
}) {
  return (
    <div className="stat" title={props.cardTitle}>
      <p className="lbl">{props.label}</p>
      <p className="num" title={props.numTitle}>
        {props.value == null ? '—' : fmtNum(props.value)}
      </p>
      {props.delta}
      {props.spark}
    </div>
  )
}

/** 操作反馈（§4 行内三态，自 StatusCard 迁入）：aria-live；失败带 [重试] */
function Feedback(props: {
  kind: 'ok' | 'err' | 'pending'
  text: string
  retry?: () => void
}) {
  return (
    <span className={`feedback ${props.kind}`} aria-live="polite">
      {props.kind === 'ok' && <IconCheck size={12} />}
      {props.kind === 'err' && <IconX size={12} />}
      {props.text}
      {props.retry != null && (
        <button type="button" className="feedback-retry" onClick={props.retry}>
          重试
        </button>
      )}
    </span>
  )
}

/** 挂起行（自 StatusCard 原样迁入，audit #6 语义）：主句 + 常显短说明 +
    可展开详情三行；N=0 整行不显示 */
function PendingRow(props: { count: number }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className="pending-row">
        <IconClock size={14} />
        <span className="pending-main">
          挂起：<span className="num">{fmtNum(props.count)}</span> 条待推送
        </span>
        <span className="pending-note">免打扰 / 摘要模式挂起 · 到点自动合并推送</span>
        <button
          type="button"
          className="pending-toggle"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          详情
          <IconChevronDown size={12} />
        </button>
      </div>
      {open && (
        <div className="pending-detail">
          <div>· 这些帖子已判定命中，但尚未推送：不入已读、暂不计入累计命中。</div>
          <div>· 免打扰时段结束或摘要到点后，挂起命中会自动合并推送。</div>
          <div>· 重启会丢弃挂起队列；仍在论坛首页的帖子会重新处理，不会凭空丢失。</div>
        </div>
      )}
    </>
  )
}

export function Dashboard(
  props: ApiState & {
    onGoSettings?: () => void
    onPushErrorClick?: (title: string) => void
    /** keep-alive 活跃性：隐藏页停跳 useNow（降负），stale 判定随之冻结 */
    active?: boolean
  }
) {
  const { status, hits, logs, errors, retry } = props
  const now = useNow(1000, props.active === false)
  const [ctl, setCtl] = useState<CtlState>({ phase: 'idle', cmd: null })
  const rootRef = useRef<HTMLDivElement | null>(null)
  const logChipsRef = useRef<HTMLDivElement | null>(null)
  /** 运行日志默认折叠（步骤 J：页面收纵向空间，日志按需展开；L 键先展开） */
  const [logsOpen, setLogsOpen] = useState(false)

  const paused = status.desired === 'paused'
  const busy = ctl.phase === 'busy'
  const busyCmd = busy ? ctl.cmd : null
  const state = deriveRunState(status)

  // 「更新于」：任一数据面事件（状态/命中/日志）到达的本地时刻
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  useEffect(() => {
    setUpdatedAt(new Date().toISOString())
  }, [status, hits, logs])

  async function control(cmd: CtlCmd): Promise<void> {
    if (busy) return
    setCtl({ phase: 'busy', cmd })
    try {
      const r = await window.api.engineControl(cmd)
      if (r.ok) {
        setCtl({ phase: 'ok', cmd, doneAt: new Date().toISOString() })
        showToast(CMD_TOAST[cmd])
      } else {
        setCtl({ phase: 'err', cmd, error: r.error })
      }
    } catch (e) {
      // IPC 通道异常（invoke reject）与 ok:false 同走行内失败反馈，不再静默
      setCtl({ phase: 'err', cmd, error: errText(e) })
    }
  }

  // 反馈文案在渲染时派生（resume 成功要读最新 nextPollAt——事件晚于响应到达）
  let feedback: { kind: 'ok' | 'err' | 'pending'; text: string; retry?: () => void } | null =
    null
  if (ctl.phase === 'busy' && ctl.cmd === 'sendTest') {
    feedback = { kind: 'pending', text: '正在发送测试消息…' }
  } else if (ctl.phase === 'ok' && ctl.cmd != null) {
    const doneAt = ctl.doneAt ?? ''
    if (ctl.cmd === 'pause') feedback = { kind: 'ok', text: `已暂停 · ${formatClock(doneAt)}` }
    else if (ctl.cmd === 'resume')
      feedback = {
        kind: 'ok',
        text: `已恢复 · 下次轮询 ${formatRelative(status.nextPollAt, now)}`
      }
    else if (ctl.cmd === 'runNow')
      feedback = { kind: 'ok', text: `已触发补一轮轮询 · ${formatClock(doneAt)}` }
    else feedback = { kind: 'ok', text: '已发送 · 请在各通知通道查收' }
  } else if (ctl.phase === 'err' && ctl.cmd != null) {
    feedback = {
      kind: 'err',
      text: ctl.message ?? `${CMD_LABEL[ctl.cmd]}失败：${ctl.error ?? '未知错误'}`,
      // message 是语义拦截提示（如 R 键在暂停态），重发同命令无意义，不给重试
      retry:
        ctl.message == null ? () => void control(ctl.cmd as CtlCmd) : undefined
    }
  }

  // 页级单键（§6.1）：焦点不在输入控件、非 IME、非修饰键组合、本页可见时生效
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return
      const el = document.activeElement
      if (
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
      )
        return
      // keep-alive：切走的页面 hidden，单键不越页生效
      if (rootRef.current == null || rootRef.current.closest('[hidden]') != null) return
      const key = e.key.toLowerCase()
      if (key === 'p') {
        e.preventDefault()
        void control(paused ? 'resume' : 'pause')
      } else if (key === 'r') {
        e.preventDefault()
        if (paused)
          setCtl({ phase: 'err', cmd: 'runNow', message: '已暂停：先恢复监控' })
        else void control('runNow')
      } else if (key === 't') {
        e.preventDefault()
        void control('sendTest')
      } else if (key === 'l') {
        e.preventDefault()
        // 折叠态先展开（chips 在 hidden 容器里 focus 是 no-op），等提交后聚焦
        if (!logsOpen) setLogsOpen(true)
        window.requestAnimationFrame(() => logChipsRef.current?.focus())
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  /* ── 本页自取数据面 ──────────────────────────────────────────────── */

  // 本地日（每秒重算，跨零点自然翻日触发下方各 effect 重取）
  const todayStr = localDate(new Date(now))
  const yesterdayStr = dateNDaysAgo(todayStr, 1)

  // 配置面：来源方式标签 / 配置展示名 + 全局轮询间隔（激活时拉取——设置页改完切回来能见到新值）
  const [methodById, setMethodById] = useState<Record<string, string> | null>(null)
  const [labelById, setLabelById] = useState<Record<string, string> | null>(null)
  const [intervalSec, setIntervalSec] = useState<number | null>(null)
  useEffect(() => {
    if (props.active === false) return
    let cancelled = false
    void window.api
      .getConfig()
      .then((cfg) => {
        if (cancelled) return
        const map: Record<string, string> = {}
        const labels: Record<string, string> = {}
        for (const s of cfg.sources) {
          map[s.id] = sourceMethodLabel(s.type)
          if (s.type === 'rss' && s.label) labels[s.id] = s.label
        }
        setMethodById(map)
        setLabelById(labels)
        setIntervalSec(cfg.pollIntervalSec)
      })
      .catch(() => {
        /* 配置面失败：方式列退化（来源 id 如实展示）、间隔省略，不伪造 */
      })
    return () => {
      cancelled = true
    }
  }, [props.active])

  // 统计面：getStats(14)（今日/昨日命中与推送 + 14 日 spark）+ getStats(1)（来源
  // 健康度表「今日」列）。命中到达（hits 长度）与累计数变化、跨日时重取；
  // 请求序号守卫防过期覆盖。
  const [stats, setStats] = useState<StatsResult | null>(null)
  const [todayBySource, setTodayBySource] = useState<Record<string, number> | null>(null)
  const statsSeqRef = useRef(0)
  useEffect(() => {
    const seq = ++statsSeqRef.current
    void window.api
      .getStats(14)
      .then((s) => {
        if (seq === statsSeqRef.current) setStats(s)
      })
      .catch(() => {
        /* 契约不抛（失败回零值）；防御性吞掉保持上次数据 */
      })
    void window.api
      .getStats(1)
      .then((s) => {
        if (seq === statsSeqRef.current)
          setTodayBySource(
            Object.fromEntries(s.bySource.map((x) => [x.sourceId, x.count] as const))
          )
      })
      .catch(() => {
        /* 同上 */
      })
  }, [todayStr, status.totalHits, hits.length])

  // 去向面：AI 判定无关（semantic-miss + semantic-below-threshold）近 7 日逐日；
  // dispositionsDay 按日读 JSONL，文件仅保留 7 天——保留期外的日期返回空、
  // 按 0 计（title 注明）。每轮轮询后（lastPollAt 变化）与跨日重取。
  const [aiMiss, setAiMiss] = useState<{ today: number; yesterday: number; spark: number[] } | null>(null)
  const dispSeqRef = useRef(0)
  useEffect(() => {
    const seq = ++dispSeqRef.current
    const days = Array.from({ length: 7 }, (_, k) => dateNDaysAgo(todayStr, 6 - k))
    void Promise.all(days.map((d) => window.api.dispositionsDay(d)))
      .then((lists) => {
        if (seq !== dispSeqRef.current) return
        const counts = lists.map((list) =>
          list.filter(
            (x) => x.outcome === 'semantic-miss' || x.outcome === 'semantic-below-threshold'
          ).length
        )
        setAiMiss({ today: counts[6], yesterday: counts[5], spark: counts })
      })
      .catch(() => {
        /* 契约不抛；防御性吞掉保持 null（显示 '—'，不伪造 0） */
      })
  }, [todayStr, status.lastPollAt])

  // 日志面派生：今日 error 级条数（会话口径——内存环 500 条，重启清空）
  const errToday = useMemo(
    () =>
      logs.filter((l) => l.level === 'error' && localDate(new Date(l.ts)) === todayStr).length,
    [logs, todayStr]
  )

  const byDayMap = useMemo(
    () => new Map((stats?.byDay ?? []).map((d) => [d.date, d.count] as const)),
    [stats]
  )
  const pushedMap = useMemo(
    () => new Map((stats?.pushedByDay ?? []).map((d) => [d.date, d.count] as const)),
    [stats]
  )

  const hitsToday = stats == null ? null : (byDayMap.get(todayStr) ?? 0)
  const hitsYesterday = stats == null ? null : (byDayMap.get(yesterdayStr) ?? 0)
  const pushedToday = stats == null ? null : (pushedMap.get(todayStr) ?? 0)
  const pushedYesterday = stats == null ? null : (pushedMap.get(yesterdayStr) ?? 0)
  const hitsSpark =
    stats == null
      ? null
      : Array.from({ length: 14 }, (_, k) => byDayMap.get(dateNDaysAgo(todayStr, 13 - k)) ?? 0)
  const pushedSpark =
    stats == null
      ? null
      : Array.from({ length: 14 }, (_, k) => pushedMap.get(dateNDaysAgo(todayStr, 13 - k)) ?? 0)

  const hitsNum = useCountUp(hitsToday)
  const pushedNum = useCountUp(pushedToday)
  const aiMissNum = useCountUp(aiMiss == null ? null : aiMiss.today)
  const errNum = useCountUp(errToday)

  const sparkRangeTitle = `近 14 天（${dateNDaysAgo(todayStr, 13).slice(5)} 至 ${todayStr.slice(5)}）`
  const aiSparkRangeTitle = `近 7 天（${dateNDaysAgo(todayStr, 6).slice(5)} 至 ${todayStr.slice(5)}）`

  const pauseBusy = busyCmd === (paused ? 'resume' : 'pause')
  const pending = status.pendingNotifyCount ?? 0
  const ai = status.ai
  const semanticActive = ai.effectiveMode !== 'literal'

  return (
    <div className="page page-dashboard" ref={rootRef}>
      <PageHeader
        title="监控台"
        eyebrow={`Overview · ${eyebrowDate(new Date(now))}`}
        subtitle="现在的运行真相 · 事件实时更新"
        updatedAt={updatedAt}
        stale={status.desired === 'running' && status.health !== 'backoff'}
        paused={props.active === false}
        actions={
          <>
            <button
              type="button"
              className={`btn${paused ? ' btn-primary' : ' btn-danger'}${pauseBusy ? ' busy' : ''}`}
              disabled={busy}
              onClick={() => void control(paused ? 'resume' : 'pause')}
              title={
                paused
                  ? '恢复轮询，按设置间隔排程 (P)'
                  : '暂停轮询与推送判定；托盘仍驻留 (P)'
              }
            >
              {pauseBusy ? null : paused ? <IconPlay size={14} /> : <IconPause size={14} />}
              {paused ? '恢复监控' : '暂停监控'}
            </button>
            <button
              type="button"
              className={`btn${busyCmd === 'runNow' ? ' busy' : ''}`}
              disabled={busy || paused}
              title={paused ? '已暂停：先恢复监控 (R)' : '忽略等待，立即补一轮轮询 (R)'}
              onClick={() => void control('runNow')}
            >
              {busyCmd === 'runNow' ? null : <IconRefresh size={14} />}
              立即刷新
            </button>
          </>
        }
      />

      {/* ── 4 张 stat 卡 ── */}
      <div className="stat-row">
        <StatCard
          label="今日命中"
          value={hitsNum}
          numTitle="今日（本地日）命中数 · getStats(14) 落盘口径"
          cardTitle="今日命中：当日（本地时区）新命中的帖子数"
          delta={
            <DeltaLine
              diff={hitsToday == null || hitsYesterday == null ? null : hitsToday - hitsYesterday}
              upIsGood
              title={`昨日（${yesterdayStr.slice(5)}）：${hitsYesterday ?? '—'} 条`}
            />
          }
          spark={
            hitsSpark != null ? (
              <Sparkline values={hitsSpark} tone="a" label={`${sparkRangeTitle}每日命中`} />
            ) : (
              <SparkPending />
            )
          }
        />
        <StatCard
          label="已推送"
          value={pushedNum}
          numTitle="今日推送成功数（notifiedAt 非空且 notifyError 为空）· getStats(14).pushedByDay 口径"
          cardTitle="已推送：当日推送成功数（静音与推送失败都不算）"
          delta={
            <DeltaLine
              diff={
                pushedToday == null || pushedYesterday == null ? null : pushedToday - pushedYesterday
              }
              upIsGood
              title={`昨日（${yesterdayStr.slice(5)}）：${pushedYesterday ?? '—'} 条`}
            />
          }
          spark={
            pushedSpark != null ? (
              <Sparkline values={pushedSpark} tone="s" label={`${sparkRangeTitle}每日推送成功`} />
            ) : (
              <SparkPending />
            )
          }
        />
        <StatCard
          label="AI 判定无关"
          value={aiMissNum}
          numTitle="今日 AI 判定为无关的帖子数：semantic-miss（判否）+ semantic-below-threshold（置信度低于阈值）之和 · 去向流水逐日口径"
          cardTitle="AI 判定无关：今日被语义评估判否或置信度不足的帖子数"
          delta={
            <DeltaLine
              diff={aiMiss == null ? null : aiMiss.today - aiMiss.yesterday}
              upIsGood={false}
              title={`昨日（${yesterdayStr.slice(5)}）：${aiMiss?.yesterday ?? '—'} 条 · 去向流水仅保留 7 天，更早日期按 0 计`}
            />
          }
          spark={
            aiMiss != null ? (
              <Sparkline
                values={aiMiss.spark}
                tone="i"
                label={`${aiSparkRangeTitle}每日 AI 判定无关（保留期外按 0 计）`}
              />
            ) : (
              <SparkPending />
            )
          }
        />
        <StatCard
          label="轮询错误"
          value={errNum}
          numTitle="今日 error 级日志条数 · 会话口径：日志仅内存保留最近 500 条、重启清空，非历史统计（故无 delta 与走势）"
          cardTitle="轮询错误：本会话今日的 error 级运行日志条数"
          delta={
            <p
              className={`delta${status.consecutiveFailures > 0 ? ' bad' : ''}`}
              title={
                status.consecutiveFailures > 0
                  ? `当前连续失败 ${status.consecutiveFailures} 次 · 最近错误见下方运行状态条与运行日志`
                  : '当前无连续失败'
              }
            >
              {status.consecutiveFailures > 0
                ? `连续失败 ${status.consecutiveFailures} 次`
                : '无连续失败'}
            </p>
          }
          spark={<SparkPending />}
        />
      </div>

      {/* ── 运行状态条（原 StatusCard 信息全量收编）── */}
      <section className="card runstrip" title={deriveTrayLabel(status)}>
        {errors.status != null && (
          <ErrorBar message={`运行状态读取失败：${errors.status}`} onRetry={retry} />
        )}
        <div className="runstrip-main">
          <span className={`state-pill tone-${state.key}`}>
            <span className={`dot${state.key === 'running' ? ' live' : ''}`} />
            {state.label}
          </span>
          <div className="rs-item" title={status.lastPollAt ?? '启动后尚未轮询'}>
            <span className="k">上次轮询</span>
            <span className="v">{formatRelative(status.lastPollAt, now)}</span>
          </div>
          <div
            className="rs-item"
            title={paused ? '已暂停，不排程（pause 后 nextPollAt 保留旧值属内核已知行为）' : (status.nextPollAt ?? undefined)}
          >
            <span className="k">下次轮询</span>
            <span className="v">{paused ? '—' : formatRelative(status.nextPollAt, now)}</span>
          </div>
          <div
            className={`rs-item${status.consecutiveFailures > 0 ? ' warn' : ''}`}
            title={
              status.consecutiveFailures >= 5
                ? `连续失败 ${status.consecutiveFailures} 次 · 详见下方最近错误与运行日志`
                : '连续抓取失败的轮次数（0 = 正常）'
            }
          >
            <span className="k">连续失败</span>
            <span className="v">{status.consecutiveFailures} 次</span>
          </div>
          <div
            className="rs-item"
            title="跨重启累计；「实时命中流」仅本会话 200 条（重启清空）"
          >
            <span className="k">累计命中</span>
            <span className="v">{fmtNum(status.totalHits)} 条</span>
          </div>
          <div
            className="rs-ai"
            title="AI 语义匹配运行态 · 展示实际生效模式（Provider 未配置时自动降级字面，非配置意图）"
          >
            <span className={`ai-pill${semanticActive ? ' ai' : ''}`}>
              {matchModeLabel(ai.effectiveMode)}
            </span>
            <span
              className="num rs-ai-count"
              title="今日 AI 调用（语义评估 + 锐评合计，锐评一次计入两者；纯计数，无每日上限）"
            >
              调用 {ai.callsToday}
            </span>
            <span
              className="num rs-ai-count"
              title="其中锐评调用（已计入今日总调用；与语义评估均无每日上限）"
            >
              锐评 {ai.commentaryToday ?? 0}
            </span>
            {ai.degraded === 'unconfigured' && (
              <span className="rs-ai-deg" title="AI 未配置 · 语义监控停用，仅字面与规则命中">
                未配置
              </span>
            )}
            {ai.degraded === 'backoff' && (
              <span
                className="rs-ai-deg"
                title={
                  ai.semanticCooldownUntil != null
                    ? `AI 评估退避中 · 冷却至 ${ai.semanticCooldownUntil}（上游连续失败，指数冷却，成功即恢复）`
                    : 'AI 评估退避中 · 上游连续失败，暂停调用（指数冷却，成功即恢复）'
                }
              >
                评估退避中
              </span>
            )}
            {ai.lastAiError != null && (
              <span className="rs-ai-err" title={`最近 AI 错误：${ai.lastAiError}`}>
                最近 AI 错误
              </span>
            )}
          </div>
          <div className="runstrip-tail">
            {feedback != null && <Feedback {...feedback} />}
            <button
              type="button"
              className={`btn btn-sm${busyCmd === 'sendTest' ? ' busy' : ''}`}
              disabled={busy}
              onClick={() => void control('sendTest')}
              title="向全部就绪通道广播一条测试消息，不走路由 (T)"
            >
              {busyCmd === 'sendTest' ? null : <IconSend size={12} />}
              发送测试通知
            </button>
          </div>
        </div>
        {pending > 0 && <PendingRow count={pending} />}
        {status.lastError != null && (
          <div className="lasterr" title={status.lastError}>
            <IconX size={12} />
            最近错误：{status.lastError}
          </div>
        )}
      </section>

      {/* ── 5:7 双栏：来源健康度 × 实时命中流 ── */}
      <div className="dash-grid">
        <SourceHealth
          sources={status.sources}
          methodById={methodById}
          labelById={labelById}
          intervalSec={intervalSec}
          todayBySource={todayBySource}
          now={now}
        />
        <LiveFeed
          hits={hits}
          totalHits={status.totalHits}
          active={props.active !== false}
          runNowDisabled={busy || paused}
          onRunNow={() => void control('runNow')}
          error={errors.hits}
          onRetry={retry}
          onGoSettings={props.onGoSettings}
          onPushErrorClick={
            props.onPushErrorClick != null
              ? (hit) => props.onPushErrorClick?.(hit.topic.title)
              : undefined
          }
        />
      </div>

      {/* ── 运行日志（整宽，默认折叠）── */}
      <div className="logsec">
        <button
          type="button"
          className="logsec-toggle"
          aria-expanded={logsOpen}
          onClick={() => setLogsOpen((o) => !o)}
          title={logsOpen ? '折叠运行日志' : '展开运行日志（级别筛选/跟随/复制，L 键聚焦筛选）'}
        >
          <IconChevronDown size={12} />
          {logsOpen ? '折叠运行日志' : '展开运行日志'}
          <span className="num">本会话 {logs.length} 条</span>
        </button>
        <div className="logsec-body" hidden={!logsOpen}>
          <LogView logs={logs} error={errors.logs} onRetry={retry} chipGroupRef={logChipsRef} />
        </div>
      </div>
    </div>
  )
}
