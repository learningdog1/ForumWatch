/**
 * 日报页（R10 阶段 4，reports.md 详稿）：
 * - 日期栏（zone A）：「今天」恒置顶 + **全部**历史日期（「展开更早（N）」，不再
 *   截断 14 天）+「跳到日期」月历（无日报日也可选，临时插入描边行区分）；
 * - 双数据面独立错误（zone B2）：listDailyReports（日期栏备料）与 getDailyReport
 *   （正文）各自 ErrorBar + 重试 + 请求序号守卫——失败绝不落入「该日没有日报」
 *   空态，错误与空态严格互斥；切日期时旧正文保留 + 压暗（§3.1）；
 * - 页头（zone Z0）：PageHeader「日报」（TASTE-UPGRADE §B-2 页头契约——五页一个
 *   范式，h1 是「日报」而非日期）；「更新于」为本会话内首次成功读取/重新生成该
 *   日报的时刻（组件 state 自记，切日期即重置；DailyReportInfo 无生成时刻字段，
 *   渲染层拿不到历史日的生成时间，无会话记录时传 null 不渲染更新行）；
 * - 卡头（zone B1）：两级标题（日题 22/700 display 档 + 生成模式/完整性元信息行，
 *   元信息从 markdown 尽力解析，解析不到走静态副题）+ 操作组（重新生成/复制全文/命中明细→）；
 * - 正文（zone B3）：ReportDoc 渲染器（行内语法/模板行结构化/分组 chips/截断提示）；
 * - 重新生成：全应用唯一行内确认场景（覆盖重写 + 再推送，不可逆层）——行内确认条
 *   非模态，Esc / 点击条外取消；生成成功文案诚实化：渲染层无法证实是否推送，不说；
 * - 文档版活列表（§3.2）：阅读中（滚动离开顶部）新版到达不替换正文，角标
 *   「已生成新版本 · 点击查看」承接，点击或回滚到顶部才载入；
 * - 键盘（§4.2）：←/→ 逐日切换、T 回今天、Esc 取消确认（IME 组合期不触发）；
 * - 零命中日报是已生成的日报：正文正常渲染，不走 EmptyState 大组件。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { DailyReportInfo } from '@shared/types'
import { EmptyState } from '../components/EmptyState'
import { ErrorBar } from '../components/ErrorBar'
import { PageHeader } from '../components/PageHeader'
import { ReportDoc, parseReport } from '../components/ReportDoc'
import { IconCalendar, IconCheck, IconCopy, IconRefresh, IconX } from '../components/icons'
import { formatDayLabel, localDate } from '../lib/time'

/** 折叠态日期栏显示的历史天数（IA 流 4：不截断，超出走「展开更早（N）」） */
const RAIL_COLLAPSED_DAYS = 14
/** 文档版活列表：正文滚动超过该值视为「阅读中」，新版到达不替换（§3.2） */
const READING_SCROLL_PX = 40
/** 「✓ 已复制 / 复制失败」反馈停留时长（§2.2） */
const COPY_FEEDBACK_MS = 1500

/** 生成反馈（行内三态，§2.3；retry=true 时附 [重试] 按钮） */
type Msg = { kind: 'ok' | 'err' | 'pending'; text: string; retry?: boolean }

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 相邻日（±1 天）：逐日移动不跳过无日报日；越出今天（未来）原地不动（§4.2） */
function shiftDay(date: string, delta: number, today: string): string {
  const d = new Date(`${date}T00:00:00`)
  if (Number.isNaN(d.getTime())) return date
  d.setDate(d.getDate() + delta)
  const next = localDate(d)
  return delta > 0 && next > today ? date : next
}

export function Reports(props: { onGoHistory?: (date: string) => void }) {
  const today = localDate()
  const [dates, setDates] = useState<string[]>([])
  /** 日期栏数据面（listDailyReports）的失败原因；null=正常 */
  const [datesError, setDatesError] = useState<string | null>(null)
  const [expandedOld, setExpandedOld] = useState(false)
  const [selected, setSelected] = useState<string>(() => localDate())
  const [report, setReport] = useState<DailyReportInfo | null>(null)
  /** 正文数据面（getDailyReport）的失败原因；null=正常（旧正文保留展示） */
  const [reportError, setReportError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [genMsg, setGenMsg] = useState<Msg | null>(null)
  /** 重新生成行内确认条（全应用唯一确认场景，§2.5） */
  const [confirmOpen, setConfirmOpen] = useState(false)
  /** 文档版活列表：阅读中到达的新版（§3.2），null=无待并入版本 */
  const [newVersion, setNewVersion] = useState<DailyReportInfo | null>(null)
  /** 「复制全文」的行内反馈（ok/err），1.5s 后清除 */
  const [copyMsg, setCopyMsg] = useState<'ok' | 'err' | null>(null)
  /** 页头「更新于」：本会话内首次成功读取/重新生成该日报的时刻（§B-2；组件
      state 自记、切日期即重置——DailyReportInfo 无生成时刻字段，渲染层拿不到
      历史日的生成时间，无记录时保持 null，PageHeader 对 null 不渲染更新行） */
  const [loadedAt, setLoadedAt] = useState<string | null>(null)

  // 事件订阅闭包读最新状态用的镜像 ref（订阅只挂一次）
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const generatingRef = useRef(generating)
  generatingRef.current = generating
  /** 当前正文是否为选中日期的已渲染日报（活列表判据） */
  const docCurrentRef = useRef(false)

  /** 请求序号守卫：慢响应不得覆盖更新的日期状态（History 同范式） */
  const reqSeq = useRef(0)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const copyTimerRef = useRef<number | null>(null)
  const confirmRef = useRef<HTMLDivElement | null>(null)
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null)
  const regenBtnRef = useRef<HTMLButtonElement | null>(null)
  const prevFocusRef = useRef<Element | null>(null)

  const hasReport = report != null && report.markdown != null && report.markdown.trim() !== ''
  docCurrentRef.current = hasReport && report!.date === selected

  /** 元信息（卡头行 2 + aux 胶囊）从 markdown 尽力解析（§5.4） */
  const parsed = useMemo(
    () => (hasReport ? parseReport(report!.markdown!) : null),
    [hasReport, report]
  )

  const loadReport = useCallback((date: string): void => {
    const seq = ++reqSeq.current
    setLoading(true)
    void window.api
      .getDailyReport(date)
      .then((r) => {
        if (seq !== reqSeq.current) return
        setReport(r)
        setReportError(null)
        setNewVersion(null)
        setLoading(false)
        setLoadedAt(new Date().toISOString())
      })
      .catch((e: unknown) => {
        if (seq !== reqSeq.current) return
        // 错误 ≠ 空：旧正文保留（压暗示 stale），绝不落入「该日没有日报」空态
        setReportError(errText(e))
        setLoading(false)
      })
  }, [])

  const refreshDates = useCallback((): void => {
    void window.api
      .listDailyReports()
      .then((r) => {
        setDates(r.dates)
        setDatesError(null)
      })
      .catch((e: unknown) => setDatesError(errText(e)))
  }, [])

  // 切日：关确认条/清反馈/弃角标，拉新正文（守卫防慢响应错配）；页头「更新于」
  // 随之重置，待新正文成功到达再记时刻（§B-2：切日期即重置）
  useEffect(() => {
    setConfirmOpen(false)
    setGenMsg(null)
    setNewVersion(null)
    setLoadedAt(null)
    loadReport(selected)
  }, [selected, loadReport])

  // 挂载：日期栏备料 + 订阅生成事件（定时/手动生成完成 → 自动刷新，机制不回退）
  useEffect(() => {
    refreshDates()
    return window.api.onDailyReport((r) => {
      setDates((prev) => (prev.includes(r.date) ? prev : [r.date, ...prev]))
      if (r.date !== selectedRef.current) return
      // 文档版活列表（§3.2）：空态/生成反馈态直接载入；阅读中不替换，角标承接
      const reading = bodyRef.current != null && bodyRef.current.scrollTop > READING_SCROLL_PX
      if (docCurrentRef.current && reading && !generatingRef.current) {
        setNewVersion(r)
      } else {
        setReport(r)
        setReportError(null)
        setLoading(false)
        setNewVersion(null)
        setLoadedAt(new Date().toISOString())
      }
    })
  }, [refreshDates])

  // 复制反馈定时器清理
  useEffect(
    () => () => {
      if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current)
    },
    []
  )

  // 确认条（§2.5）：focus 移入确认按钮；Esc / 点击条外任意处取消；关闭时焦点归还
  useEffect(() => {
    if (!confirmOpen) return
    prevFocusRef.current = document.activeElement
    confirmBtnRef.current?.focus()
    const onPointerDown = (e: PointerEvent): void => {
      const t = e.target
      if (!(t instanceof Node)) return
      if (confirmRef.current?.contains(t) === true) return
      if (regenBtnRef.current?.contains(t) === true) return // 重新生成按钮自身负责切换
      setConfirmOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.isComposing) setConfirmOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
      // 焦点归还（防 disabled）：确认生成路径里原焦点（重新生成按钮）已 disabled，
      // focus() 会落空到 body——无效时改还日期栏当前项（确认条自身已卸载，不可归还）
      const prev = prevFocusRef.current
      if (
        prev instanceof HTMLButtonElement &&
        document.contains(prev) &&
        !prev.disabled
      ) {
        prev.focus()
        return
      }
      document.querySelector<HTMLButtonElement>('.report-date.active')?.focus()
    }
  }, [confirmOpen])

  /** 并入新版（点击角标或回滚到顶部触发，§3.2） */
  function mergeNewVersion(): void {
    if (newVersion == null) return
    setReport(newVersion)
    setNewVersion(null)
    setReportError(null)
  }

  /** 回滚到顶部 → 自动并入待定新版 */
  function handleBodyScroll(): void {
    if (newVersion == null) return
    if ((bodyRef.current?.scrollTop ?? 0) <= READING_SCROLL_PX) mergeNewVersion()
  }

  /** 「可能不完整」元信息 → 滚到文末截断提示行（§5.4 完整性） */
  function scrollToTruncTip(): void {
    const tip = bodyRef.current?.querySelector('.doc-trunc')
    tip?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
      block: 'end'
    })
  }

  async function generate(): Promise<void> {
    if (generating) return
    setGenerating(true)
    setConfirmOpen(false)
    setGenMsg({ kind: 'pending', text: '正在总结今天已命中的帖子…（AI 生成最长约 30 秒）' })
    try {
      const r = await window.api.generateDailyReport()
      if (r.ok) {
        // 诚实化（§2.3）：是否推送由主进程按配置判定，渲染层无法证实，不声称。
        // 生成只对今天；用户中途切去了历史日则不抢正文，日期栏照常并入新日期
        refreshDates()
        if (selectedRef.current === today) {
          setGenMsg({ kind: 'ok', text: '日报已生成' })
          loadReport(today)
        }
      } else {
        setGenMsg({ kind: 'err', text: `生成失败：${r.error}`, retry: true })
      }
    } catch (e) {
      setGenMsg({ kind: 'err', text: `生成失败：${errText(e)}`, retry: true })
    } finally {
      setGenerating(false)
    }
  }

  function copyAll(): void {
    const md = report?.markdown
    if (md == null) return
    void navigator.clipboard
      .writeText(md)
      .then(() => setCopyMsg('ok'))
      .catch(() => setCopyMsg('err'))
      .finally(() => {
        if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current)
        copyTimerRef.current = window.setTimeout(() => {
          setCopyMsg(null)
          copyTimerRef.current = null
        }, COPY_FEEDBACK_MS)
      })
  }

  /** 日期栏 roving focus：↑/↓ 在日期行间循环移动（§4.2） */
  function handleRailKeyDown(e: ReactKeyboardEvent<HTMLElement>): void {
    if (e.nativeEvent.isComposing) return
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    const btns = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button.report-date')]
    const idx = btns.indexOf(document.activeElement as HTMLButtonElement)
    if (idx < 0) return
    e.preventDefault()
    const next = (idx + (e.key === 'ArrowDown' ? 1 : btns.length - 1)) % btns.length
    btns[next]?.focus()
  }

  /** 正文区键盘（§4.2）：←/→ 逐日切换、T 回今天；焦点在链接/按钮上不抢键 */
  function handleBodyKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void {
    if (e.nativeEvent.isComposing) return
    const el = document.activeElement
    const onControl =
      el instanceof HTMLElement &&
      el !== e.currentTarget &&
      el.closest('a,button,input,select,textarea') != null
    if (onControl) return
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      setSelected(shiftDay(selected, -1, today))
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      setSelected(shiftDay(selected, 1, today))
    } else if (e.key === 't' || e.key === 'T') {
      setSelected(today)
    }
  }

  // ---- 日期栏派生（zone A）----------------------------------------------------

  const historyDates = dates.filter((d) => d !== today)
  const shownHistory = expandedOld ? historyDates : historyDates.slice(0, RAIL_COLLAPSED_DAYS)
  const hiddenCount = historyDates.length - shownHistory.length
  /** 跳到日期选中了列表外的历史日 → 临时插入该行（描边区分「无日报」，§4.1） */
  const railHistory =
    selected !== today && !dates.includes(selected)
      ? [...shownHistory, selected].sort().reverse()
      : shownHistory

  // ---- 卡头派生（zone B1）-----------------------------------------------------

  const hitsSummary = parsed?.hitsSummary ?? null
  const hitCount = parsed?.hitCount ?? null
  let metaLine: string
  if (parsed == null) {
    metaLine = 'AI 每天生成的命中总结 · 可回看历史日期'
  } else if (parsed.mode === 'template') {
    metaLine = '模板模式（AI 生成失败时的降级）'
  } else if (parsed.truncated) {
    // 尾注缺失（自家模板必有尾注）→ 按 LLM 被截断呈现，附「可能」限定（§5.4）
    metaLine = 'AI 总结 · 可能不完整'
  } else if (parsed.mode === 'ai') {
    metaLine = 'AI 总结'
  } else {
    metaLine = 'AI 每天生成的命中总结 · 可回看历史日期'
  }
  /** 今天 && 已有日报 → 重新生成（手动生成只对今天，历史日不给） */
  const canRegen = selected === today && hasReport
  /** 切日/出错且有旧正文 → 保留旧数据 + 压暗（§3.1），禁整区替换为 loading */
  const dimBody = (loading || reportError != null) && hasReport

  return (
    <div className="page page-reports">
      {/* Z0 · 页头（§B-2 页头契约）：页题 = 侧栏 label「日报」；日报是每日快照，
          stale 判定整页关闭（90s 口径是监控台的事件节奏，不适用本页） */}
      <PageHeader
        title="日报"
        subtitle="按日汇总的命中与去向，支持重新生成与推送"
        updatedAt={loadedAt}
        stale={false}
        updatedTitle="本会话内首次读取或重新生成该日报的时间"
      />
      <aside className="report-rail">
        <div className="report-rail-title">日期</div>
        {datesError != null ? (
          // 日期列表读失败（§2.6-2）：仅「今天」置顶行恒可用，其余区域被错误行替代
          <>
            <button
              type="button"
              className={`report-date${selected === today ? ' active' : ''}`}
              onClick={() => setSelected(today)}
              aria-current={selected === today ? 'date' : undefined}
            >
              <span className="label">{formatDayLabel(today, today, true)}</span>
              {!dates.includes(today) && <span className="sub">未生成</span>}
            </button>
            <ErrorBar message="日期列表加载失败" detail={datesError} onRetry={refreshDates} />
          </>
        ) : (
          <nav className="report-rail-list" aria-label="日报日期" onKeyDown={handleRailKeyDown}>
            <button
              type="button"
              className={`report-date${selected === today ? ' active' : ''}`}
              onClick={() => setSelected(today)}
              aria-current={selected === today ? 'date' : undefined}
            >
              <span className="label">{formatDayLabel(today, today, true)}</span>
              {!dates.includes(today) && <span className="sub">未生成</span>}
            </button>
            {historyDates.length > 0 && <div className="report-rail-sep">更早</div>}
            {railHistory.map((d) => (
              <button
                type="button"
                key={d}
                className={`report-date${selected === d ? ' active' : ''}${
                  dates.includes(d) ? '' : ' noreport'
                }`}
                onClick={() => setSelected(d)}
                aria-current={selected === d ? 'date' : undefined}
              >
                <span className="label">{formatDayLabel(d, today, true)}</span>
              </button>
            ))}
          </nav>
        )}
        {datesError == null && hiddenCount > 0 && (
          <button
            type="button"
            className="btn report-rail-more"
            onClick={() => setExpandedOld((v) => !v)}
          >
            {expandedOld ? '收起' : `展开更早（${hiddenCount}）`}
          </button>
        )}
        <label className="report-rail-jump">
          <IconCalendar size={14} />
          跳到日期
          <input
            type="date"
            className="input"
            value={selected}
            max={today}
            onChange={(e) => {
              if (e.target.value !== '') setSelected(e.target.value)
            }}
            aria-label="跳到日期（月历）"
          />
        </label>
      </aside>

      <section className="card card-grow report-card">
        {/* B1 卡头：两级标题（日题 22/700 + 元信息行/确认条）+ 操作组；
            日期降为卡头标题（h2）——页面身份（h1「日报」）归 Z0 PageHeader（§B-2） */}
        <div className="report-head">
          <div className="report-head-main">
            <div className="report-title-row">
              <h2 className="report-title">{formatDayLabel(selected, today)}</h2>
              {loading && hasReport && <IconRefresh size={12} className="report-busy" />}
              {hitsSummary != null && (
                <span className={`report-summary num${hitCount === 0 ? ' muted' : ''}`}>
                  {hitsSummary}
                </span>
              )}
            </div>
            {confirmOpen ? (
              // 行内确认条（§2.5）：非模态，替换元信息行显示；主操作 danger 描边
              <div className="report-confirm" role="alert" ref={confirmRef}>
                <span>重新生成会覆盖当前日报，并按配置再推送一次。确定？</span>
                <button
                  type="button"
                  className="btn btn-danger"
                  ref={confirmBtnRef}
                  disabled={generating}
                  onClick={() => void generate()}
                >
                  确认重新生成
                </button>
                <button type="button" className="btn" onClick={() => setConfirmOpen(false)}>
                  取消
                </button>
                <span className="esc-hint">Esc 取消</span>
              </div>
            ) : parsed?.truncated === true ? (
              <button type="button" className="report-meta report-meta-link" onClick={scrollToTruncTip}>
                {metaLine}
              </button>
            ) : (
              <div className="report-meta">{metaLine}</div>
            )}
          </div>
          <div className="report-actions">
            {canRegen && (
              <button
                type="button"
                className="btn"
                ref={regenBtnRef}
                disabled={generating}
                onClick={() => setConfirmOpen((v) => !v)}
              >
                <IconRefresh size={14} />
                重新生成
              </button>
            )}
            {hasReport && (
              <button type="button" className="btn" onClick={copyAll}>
                <IconCopy size={14} />
                复制全文
              </button>
            )}
            {hasReport && hitCount != null && hitCount > 0 && props.onGoHistory != null && (
              <button
                type="button"
                className="btn"
                title="跳历史命中页并预填该日日期筛选"
                onClick={() => props.onGoHistory?.(selected)}
              >
                命中明细 →
              </button>
            )}
            {copyMsg === 'ok' && (
              <span className="feedback ok" role="status">
                <IconCheck size={12} />
                已复制
              </span>
            )}
            {copyMsg === 'err' && (
              <span className="feedback err" role="alert">
                <IconX size={12} />
                复制失败
              </span>
            )}
          </div>
        </div>

        {/* 文档版活列表角标（§3.2）：一次性 300ms 淡入，点击并入 */}
        {newVersion != null && (
          <button type="button" className="report-newver" role="status" onClick={mergeNewVersion}>
            已生成新版本 · 点击查看
          </button>
        )}

        {/* B2 错误条：读失败 ≠ 没有（旧正文在下方保留并压暗） */}
        {reportError != null && (
          <ErrorBar
            message="日报加载失败"
            detail={reportError}
            onRetry={() => loadReport(selected)}
          />
        )}

        {/* 生成反馈（行内三态，§2.3；成功 status / 失败 alert） */}
        {genMsg != null && (
          <div
            className={`report-feedback feedback ${genMsg.kind}`}
            role={genMsg.kind === 'err' ? 'alert' : 'status'}
          >
            {genMsg.kind === 'ok' && <IconCheck size={12} />}
            {genMsg.kind === 'err' && <IconX size={12} />}
            {genMsg.text}
            {genMsg.retry === true && (
              <button
                type="button"
                className="btn"
                disabled={generating}
                onClick={() => void generate()}
              >
                重试
              </button>
            )}
          </div>
        )}

        {/* B3 正文阅读区：doc 列 560px 居中；B4 状态占位在区内 */}
        <div
          className={`report-body${dimBody ? ' list-dim' : ''}`}
          ref={bodyRef}
          tabIndex={0}
          aria-busy={loading ? true : undefined}
          aria-label="日报正文：左右方向键切换日期，T 回到今天"
          onScroll={handleBodyScroll}
          onKeyDown={handleBodyKeyDown}
        >
          {!loading && reportError == null && !hasReport ? (
            selected === today ? (
              <EmptyState
                title="今天的日报还没生成"
                hint="到了设置里的总结时间会自动生成；也可以现在就总结今天已命中的帖子"
                action={
                  <button
                    type="button"
                    className={`btn btn-primary${generating ? ' busy' : ''}`}
                    disabled={generating}
                    onClick={() => void generate()}
                  >
                    {generating ? null : <IconRefresh size={14} />}
                    立即生成
                  </button>
                }
              />
            ) : (
              <EmptyState
                title="这一天没有日报"
                hint="当天可能还没启用每日总结；错过的自动生成不会回溯补做"
              />
            )
          ) : hasReport ? (
            <ReportDoc
              markdown={report!.markdown!}
              onGoHistory={
                props.onGoHistory != null ? () => props.onGoHistory?.(selected) : undefined
              }
            />
          ) : (
            /* 首载（无旧数据）= 旋转图标 + 文案（三态谱系 §C-10：disp-loading 范式）；
               错误态由上方错误条承载，此处留空区 */
            <div className="empty disp-loading">
              {loading && (
                <>
                  <IconRefresh size={12} />
                  正在加载日报…
                </>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
