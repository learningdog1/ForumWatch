/**
 * 今日回顾页：当天（或历史某天）的 AI 日报。
 * - 左侧日期栏：listDailyReports 的日期（新→旧，取最近 14 个）点击切换；
 *   「今天」恒定置顶展示（未生成时带提示态），为手动生成留入口。
 * - 正文：日报 markdown 的**纯文本行渲染**（不引 markdown 库）——
 *   #/##/### 标题、- 列表、空行分段；生成时间与命中数摘要从日报
 *   头部尽力解析（LLM 输出不含则不展示，不强求）。
 * - 空态（今天还没有日报）：雷达插画 + 「立即生成」（generateDailyReport，
 *   loading 态，成功后刷新正文与日期栏）。
 * - 订阅 onDailyReport：主进程定时生成完成时自动刷新（跨过 timeHHMM 的场景）。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { DailyReportInfo } from '@shared/types'
import { EmptyState } from '../components/EmptyState'
import { IconRefresh } from '../components/icons'
import { formatDayLabel, localDate } from '../lib/time'

type Msg = { kind: 'ok' | 'err' | 'pending'; text: string }

/** 日报正文头部尽力解析：命中数摘要（"共 N 条" / "今日无命中"） */
function parseHitsSummary(md: string): string | null {
  const head = md.split('\n').slice(0, 10).join('\n')
  const m = /共\s*(\d+)\s*条/.exec(head)
  if (m != null) return `共 ${m[1]} 条命中`
  if (head.includes('今日无命中')) return '今日无命中'
  return null
}

/** 日报 markdown → 按行分块渲染（标题 / 列表 / 段落；不解析行内样式） */
function renderDoc(md: string): ReactNode[] {
  const blocks: ReactNode[] = []
  let para: string[] = []
  let list: string[] = []

  const flushPara = (): void => {
    if (para.length > 0) {
      blocks.push(
        <p key={`p${blocks.length}`} className="doc-p">
          {para.join(' ')}
        </p>
      )
      para = []
    }
  }
  const flushList = (): void => {
    if (list.length > 0) {
      blocks.push(
        <ul key={`l${blocks.length}`} className="doc-list">
          {list.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      )
      list = []
    }
  }

  for (const raw of md.split('\n')) {
    const line = raw.trimEnd()
    if (line.trim() === '') {
      flushPara()
      flushList()
      continue
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (bullet != null) {
      flushPara()
      list.push(bullet[1].trim())
      continue
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading != null) {
      flushPara()
      flushList()
      const level = heading[1].length
      blocks.push(
        <div key={`h${blocks.length}`} className={`doc-h${level}`}>
          {heading[2].trim()}
        </div>
      )
      continue
    }
    para.push(line.trim())
  }
  flushPara()
  flushList()
  return blocks
}

export function Reports() {
  const today = localDate()
  const [dates, setDates] = useState<string[]>([])
  const [selected, setSelected] = useState<string>(today)
  const [report, setReport] = useState<DailyReportInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [genMsg, setGenMsg] = useState<Msg | null>(null)
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  const loadReport = useCallback(async (date: string): Promise<void> => {
    setLoading(true)
    try {
      setReport(await window.api.getDailyReport(date))
    } catch {
      setReport(null)
    } finally {
      setLoading(false)
    }
  }, [])

  const refreshDates = useCallback((): void => {
    void window.api
      .listDailyReports()
      .then((r) => setDates(r.dates))
      .catch(() => {})
  }, [])

  useEffect(() => {
    void loadReport(selected)
  }, [selected, loadReport])

  useEffect(() => {
    refreshDates()
    // 主进程生成完成（定时触发或本页手动触发）→ 自动刷新
    return window.api.onDailyReport((r) => {
      setDates((prev) => (prev.includes(r.date) ? prev : [r.date, ...prev]))
      if (r.date === selectedRef.current) setReport(r)
    })
  }, [refreshDates])

  async function generate(): Promise<void> {
    setGenerating(true)
    setGenMsg({ kind: 'pending', text: '正在生成今日日报（AI 总结）…' })
    try {
      const r = await window.api.generateDailyReport()
      if (r.ok) {
        setGenMsg({ kind: 'ok', text: '✓ 已生成，并按配置推送' })
        await loadReport(selectedRef.current)
        refreshDates()
      } else {
        setGenMsg({ kind: 'err', text: `生成失败：${r.error}` })
      }
    } finally {
      setGenerating(false)
    }
  }

  const historyDates = dates.filter((d) => d !== today).slice(0, 14)
  const hasReport = report?.markdown != null && report.markdown.trim() !== ''
  const summary = hasReport ? parseHitsSummary(report!.markdown!) : null

  return (
    <div className="page page-reports">
      <aside className="report-rail">
        <div className="report-rail-title">日报</div>
        <button
          type="button"
          className={`report-date${selected === today ? ' active' : ''}`}
          onClick={() => setSelected(today)}
        >
          <span className="label">{formatDayLabel(today, today, true)}</span>
          {!dates.includes(today) && <span className="sub">未生成</span>}
        </button>
        {historyDates.length > 0 && <div className="report-rail-sep">更早</div>}
        {historyDates.map((d) => (
          <button
            type="button"
            key={d}
            className={`report-date${selected === d ? ' active' : ''}`}
            onClick={() => setSelected(d)}
          >
            <span className="label">{formatDayLabel(d, today, true)}</span>
          </button>
        ))}
      </aside>

      <section className="card card-grow report-card">
        <div className="report-head">
          <span className="report-title">{formatDayLabel(selected, today)}</span>
          {summary != null && <span className="report-summary num">{summary}</span>}
        </div>
        <div className="report-body card-scroll">
          {loading ? (
            <div className="empty">正在加载日报…</div>
          ) : hasReport ? (
            <div className="doc">{renderDoc(report!.markdown!)}</div>
          ) : selected === today ? (
            <EmptyState
              title="今天的日报还没生成"
              hint="到了设置里的每日总结时间会自动生成；也可以现在就总结今天已命中的帖子"
              action={
                <div className="report-gen">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={generating}
                    onClick={() => void generate()}
                  >
                    <IconRefresh size={14} />
                    {generating ? '生成中…' : '立即生成'}
                  </button>
                  {genMsg != null && <span className={`feedback ${genMsg.kind}`}>{genMsg.text}</span>}
                </div>
              }
            />
          ) : (
            <EmptyState title="该日没有日报" hint="那天可能还没开始使用每日总结，或错过的时间点不回溯补做" />
          )}
        </div>
      </section>
    </div>
  )
}
