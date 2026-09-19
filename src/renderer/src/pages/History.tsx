/**
 * 历史命中页（R7-W2+W3）：hits/*.jsonl 的跨日浏览器 + 统计面板。
 *
 * - 统计区（R7-W3）：getStats(14) 近 14 天聚合——总数/失败率/命中日/来源数四个
 *   指标块、三命中方式占比（数字 + 堆叠比例条）、来源分布 Top、关键词命中榜
 *   （零命中关键词灰字标注"未命中，考虑移除"）。窗口固定 14 天，与列表筛选
 *   无关（列表是查询视图，统计是画像）。
 * - 列表（R7-W2）：queryHits 服务端过滤（日期范围含两端默认近 7 天 / 来源 /
 *   命中方式多选 / 标题+命中词+规则名搜索），分页每页 50（上一页/下一页，
 *   显示 total）。行渲染对齐 HitList 风格（该组件 props 面向监控台空态与
 *   立即轮询，不适配历史分页，故本地复刻行渲染：matchedBy 徽标 / 规则 label /
 *   semanticReason / notifyError 红字 hover）。
 * - 数据面全部走 invoke（无事件订阅，历史文件静态），手动「刷新」重拉两个
 *   数据面；搜索框 300ms 防抖后再查询。请求带序号守卫，慢响应不覆盖新状态。
 * - 全部样式复用既有类（.metrics/.substatus/.hit/.chip 等），本工作包不改
 *   global.css；个别尺寸/配色走内联 style（HitList 规则徽标先例）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { HitQueryResult, StatsResult } from '@shared/ipc'
import type { HitRecord } from '@shared/types'
import { EmptyState } from '../components/EmptyState'
import { IconRefresh } from '../components/icons'
import { localDate } from '../lib/time'
import { sourceLabel } from '../lib/status'

/** 列表分页大小（规格固定 50） */
const PAGE_SIZE = 50
/** 统计区窗口（天，与主进程 getStats 缺省一致；显式传避免两侧漂移） */
const STATS_DAYS = 14
/** 搜索框防抖（ms） */
const SEARCH_DEBOUNCE_MS = 300
/** 关键词命中榜最多展示条数（配置词可能很多，其余折叠计数） */
const KEYWORD_RANK_LIMIT = 20

type MatchedBy = 'literal' | 'semantic' | 'rule'

const MB_OPTIONS: { value: MatchedBy; label: string }[] = [
  { value: 'literal', label: '字面' },
  { value: 'semantic', label: '语义' },
  { value: 'rule', label: '规则' }
]

/** 三档命中方式 → 比例条/图例用色（语义 AI 紫、规则绿，对齐 HitList 徽标） */
const MB_COLOR: Record<MatchedBy, string> = {
  literal: 'var(--text-2)',
  semantic: 'var(--ai)',
  rule: 'var(--ok)'
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

/** 历史行时间戳：'MM-DD HH:mm'（跨日视图带日期；秒级精度见 title 原文） */
function formatHistoryStamp(iso: string | null): string {
  if (iso == null || iso === '') return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 简易防抖值（搜索框用；hooks/ 目录不在本工作包改动清单，就地内联） */
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}

// ---- 行渲染（对齐 components/HitList.tsx 的视觉，本地复刻见文件头注释） ----

function PushState(props: { hit: HitRecord }) {
  const { hit } = props
  if (hit.notifiedAt !== null) {
    return (
      <span className="push ok" title={`已推送于 ${hit.notifiedAt}`}>
        ✓ 已推送
      </span>
    )
  }
  if (hit.notifyError !== null) {
    return (
      <span className="push err" title={hit.notifyError}>
        ✗ 推送失败
      </span>
    )
  }
  return (
    <span className="push muted" title="命中已记录但未推送：推送总开关关闭，或无就绪通道">
      − 静音
    </span>
  )
}

function MatchInfo(props: { hit: HitRecord }) {
  const { hit } = props
  const commentary = hit.commentary ?? null
  const commentaryLine =
    commentary !== null && commentary !== '' ? (
      <span className="ai-reason" title={commentary}>
        💬 {commentary}
      </span>
    ) : null
  if (hit.matchedBy === 'semantic') {
    return (
      <span className="hit-how semantic">
        <span className="how-badge">语义</span>
        {hit.semanticReason != null && (
          <span className="ai-reason" title={hit.semanticReason}>
            AI: {hit.semanticReason}
          </span>
        )}
        {commentaryLine}
      </span>
    )
  }
  if (hit.matchedBy === 'rule') {
    // 旧 hits/*.jsonl 行无 matchedRule 字段（可选），缺失等价"只显规则徽标"
    const matchedRule = hit.matchedRule ?? null
    return (
      <span className="hit-how rule">
        <span
          className="how-badge"
          style={{
            borderColor: 'color-mix(in srgb, var(--ok) 45%, transparent)',
            color: 'var(--ok)'
          }}
        >
          规则
        </span>
        {matchedRule != null && matchedRule !== '' && (
          <span className="ai-reason" title={`命中规则：${matchedRule}`}>
            {matchedRule}
          </span>
        )}
        {commentaryLine}
      </span>
    )
  }
  return (
    <span className="hit-how">
      <span className="how-badge">字面</span>
      <span className="chips">
        {hit.matchedKeywords.map((kw) => (
          <span className="chip" key={kw} title={`命中词：${kw}`}>
            {kw}
          </span>
        ))}
      </span>
      {commentaryLine}
    </span>
  )
}

function HistoryRow(props: { hit: HitRecord }) {
  const { hit } = props
  const stamp = hit.notifiedAt ?? hit.topic.lastActiveAt
  return (
    <div className="hit">
      <time className="num" style={{ width: 88 }} title={stamp ?? undefined}>
        {formatHistoryStamp(stamp)}
      </time>
      <span className="src-badge" title={`来源：${sourceLabel(hit.topic.sourceId)}`}>
        {sourceLabel(hit.topic.sourceId)}
      </span>
      <span className="cat" title={`分类：${hit.topic.category}`}>
        {hit.topic.category}
      </span>
      <button
        type="button"
        className="hit-title"
        title={`打开：${hit.topic.title}`}
        onClick={() => {
          void window.api.openExternal(hit.topic.url)
        }}
      >
        {hit.topic.title}
      </button>
      <MatchInfo hit={hit} />
      <PushState hit={hit} />
    </div>
  )
}

// ---- 统计区（R7-W3） --------------------------------------------------------

/** 三命中方式占比：堆叠比例条 + 图例行（数字 + 比例） */
function MatchedByBreakdown(props: { stats: StatsResult }) {
  const { byMatchedBy, total } = props.stats
  const rows: { key: MatchedBy; label: string; count: number }[] = [
    { key: 'literal', label: '字面', count: byMatchedBy.literal },
    { key: 'semantic', label: '语义', count: byMatchedBy.semantic },
    { key: 'rule', label: '规则', count: byMatchedBy.rule }
  ]
  return (
    <div className="subblock">
      <div className="subblock-title">命中方式占比</div>
      {/* 堆叠比例条：三段着色，宽度 = 占比；total=0 时只显空槽 */}
      <div
        style={{
          display: 'flex',
          height: 8,
          borderRadius: 4,
          overflow: 'hidden',
          border: '1px solid var(--border)',
          background: 'var(--chip-bg)'
        }}
      >
        {rows.map(
          (r) =>
            r.count > 0 && (
              <div
                key={r.key}
                style={{ width: pct(r.count, total), background: MB_COLOR[r.key] }}
                title={`${r.label} ${r.count}（${pct(r.count, total)}）`}
              />
            )
        )}
      </div>
      {rows.map((r) => (
        <div className="src-row" key={r.key}>
          <span className="how-badge" style={{ color: MB_COLOR[r.key], borderColor: MB_COLOR[r.key] }}>
            {r.label}
          </span>
          <span className="src-name num">{r.count}</span>
          <span className="src-last num">{pct(r.count, total)}</span>
        </div>
      ))}
    </div>
  )
}

/** 来源分布 Top（条形 + 计数） */
function SourceTop(props: { stats: StatsResult }) {
  const { bySource, total } = props.stats
  const top = bySource.slice(0, 5)
  return (
    <div className="subblock">
      <div className="subblock-title">
        来源分布 Top {top.length}
        {bySource.length > top.length && `（共 ${bySource.length} 个）`}
      </div>
      {top.length === 0 ? (
        <div className="src-empty">窗口内暂无命中</div>
      ) : (
        top.map((s) => (
          <div className="src-row" key={s.sourceId}>
            <span className="src-badge" title={s.sourceId}>
              {sourceLabel(s.sourceId)}
            </span>
            <span
              style={{
                flex: '1 1 40px',
                height: 6,
                borderRadius: 3,
                overflow: 'hidden',
                background: 'var(--chip-bg)'
              }}
            >
              <span
                style={{
                  display: 'block',
                  height: '100%',
                  width: pct(s.count, total),
                  background: 'var(--accent)'
                }}
              />
            </span>
            <span className="src-last num" title={`${s.count} 条（${pct(s.count, total)}）`}>
              {s.count}
            </span>
          </div>
        ))
      )}
    </div>
  )
}

/** 关键词命中榜：命中词计数降序；零命中关键词灰字标注（附尾） */
function KeywordRank(props: { stats: StatsResult }) {
  const { keywordHits } = props.stats
  const shown = keywordHits.slice(0, KEYWORD_RANK_LIMIT)
  return (
    <div className="subblock" style={{ gridColumn: '1 / -1' }}>
      <div className="subblock-title">
        关键词命中榜
        {keywordHits.length > shown.length && (
          <span style={{ fontWeight: 400 }}> · 另有 {keywordHits.length - shown.length} 个未展示</span>
        )}
      </div>
      {shown.length === 0 ? (
        <div className="src-empty">窗口内暂无命中，且未配置包含词</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 14px' }}>
          {shown.map((k) =>
            k.zeroHit ? (
              <span
                className="src-row"
                key={k.keyword}
                style={{ padding: 0, color: 'var(--text-3)' }}
                title="统计窗口内零命中：考虑移除或改写该关键词"
              >
                <span className="chip" style={{ background: 'var(--chip-bg)', color: 'var(--text-3)' }}>
                  {k.keyword}
                </span>
                <span style={{ fontSize: 'var(--fs-12)' }}>未命中，考虑移除</span>
              </span>
            ) : (
              <span className="src-row" key={k.keyword} style={{ padding: 0 }} title={`命中 ${k.count} 次`}>
                <span className="chip">{k.keyword}</span>
                <span className="num" style={{ color: 'var(--text-2)' }}>
                  {k.count}
                </span>
              </span>
            )
          )}
        </div>
      )}
    </div>
  )
}

// ---- 页面 -------------------------------------------------------------------

export function History() {
  const today = localDate()
  const defaultFrom = daysAgoLocal(6) // 默认近 7 天（含端点）

  // 筛选态（变更时回到第一页）
  const [from, setFrom] = useState(defaultFrom)
  const [to, setTo] = useState(today)
  const [sourceId, setSourceId] = useState('')
  const [mb, setMb] = useState<MatchedBy[]>([])
  const [text, setText] = useState('')
  const debouncedText = useDebounced(text, SEARCH_DEBOUNCE_MS)
  const [page, setPage] = useState(0)
  const [reloadTick, setReloadTick] = useState(0)

  // 数据态
  const [loading, setLoading] = useState(true)
  const [result, setResult] = useState<HitQueryResult>({ total: 0, items: [] })
  const [stats, setStats] = useState<StatsResult | null>(null)
  const [configSourceIds, setConfigSourceIds] = useState<string[]>([])
  /** 请求序号守卫：慢响应不得覆盖更新的查询状态 */
  const reqSeq = useRef(0)

  // 来源下拉：配置来源 ∪ 统计里出现过的来源（已删来源仍有历史数据）
  const sourceOptions = useMemo(() => {
    const ids = new Set<string>(configSourceIds)
    for (const s of stats?.bySource ?? []) ids.add(s.sourceId)
    return [...ids].sort()
  }, [configSourceIds, stats])

  // 列表查询：筛选或页码变化即拉（服务端过滤 + 分页）
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
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE
      })
      .then((r) => {
        if (seq !== reqSeq.current) return
        setResult(r)
        setLoading(false)
      })
      .catch(() => {
        if (seq !== reqSeq.current) return
        setResult({ total: 0, items: [] })
        setLoading(false)
      })
  }, [from, to, sourceId, mb, debouncedText, page, reloadTick])

  // 筛选变化 → 回第一页（分页自身不触发；已有页码时随后由列表查询兜底重拉）
  useEffect(() => {
    setPage(0)
  }, [from, to, sourceId, mb, debouncedText])

  // 筛选收窄导致当前页越界 → 收口到最后一页
  const pageCount = Math.max(1, Math.ceil(result.total / PAGE_SIZE))
  useEffect(() => {
    if (page >= pageCount) setPage(pageCount - 1)
  }, [page, pageCount])

  // 统计面板：挂载 + 手动刷新时拉（固定近 14 天口径）
  useEffect(() => {
    void window.api
      .getStats(STATS_DAYS)
      .then((s) => setStats(s))
      .catch(() => setStats(null))
  }, [reloadTick])

  // 来源下拉备料（一次性）
  useEffect(() => {
    void window.api
      .getConfig()
      .then((cfg) => setConfigSourceIds(cfg.sources.map((s) => s.id)))
      .catch(() => {})
  }, [])

  function toggleMb(value: MatchedBy): void {
    setMb((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]))
  }

  const dirty =
    from !== defaultFrom || to !== today || sourceId !== '' || mb.length > 0 || text !== ''

  const failPct = stats !== null ? Math.round(stats.pushFailRate * 100) : 0

  return (
    <div className="page page-dashboard">
      {/* 统计面板（R7-W3）：固定近 14 天画像，与下方列表筛选解耦 */}
      <section className="card">
        <div className="card-head">
          <span className="card-title">统计面板 · 近 {STATS_DAYS} 天</span>
          <span className="card-count">
            <button
              type="button"
              className="btn"
              onClick={() => setReloadTick((t) => t + 1)}
              title="重拉统计与列表"
            >
              <IconRefresh size={14} />
              刷新
            </button>
          </span>
        </div>
        {stats === null ? (
          <div className="empty">正在加载统计…</div>
        ) : (
          <>
            <div className="metrics">
              <div className="metric">
                <div className="k">总命中</div>
                <div className="v num">{stats.total}</div>
              </div>
              <div className={`metric${failPct > 0 ? ' warn' : ''}`}>
                <div className="k">推送失败率</div>
                <div className="v num">
                  {stats.total === 0 ? '—' : `${failPct}%`}
                </div>
              </div>
              <div className="metric">
                <div className="k">命中日</div>
                <div className="v num">{stats.byDay.length} 天</div>
              </div>
              <div className="metric">
                <div className="k">来源数</div>
                <div className="v num">{stats.bySource.length}</div>
              </div>
            </div>
            <div className="substatus">
              <MatchedByBreakdown stats={stats} />
              <SourceTop stats={stats} />
            </div>
            <div className="substatus">
              <KeywordRank stats={stats} />
            </div>
          </>
        )}
      </section>

      {/* 历史命中列表（R7-W2）：服务端过滤 + 分页 */}
      <section className="card card-grow">
        <div className="card-head">
          <span className="card-title">历史命中</span>
          <span className="card-count num">
            共 {result.total} 条 · 第 {page + 1} / {pageCount} 页
          </span>
        </div>
        <div className="actions">
          <div className="input-row">
            <input
              type="date"
              className="input"
              value={from}
              max={today}
              onChange={(e) => setFrom(e.target.value)}
              aria-label="起始日期（含）"
            />
            <span className="card-count">至</span>
            <input
              type="date"
              className="input"
              value={to}
              max={today}
              onChange={(e) => setTo(e.target.value)}
              aria-label="截止日期（含）"
            />
          </div>
          <select
            className="input"
            style={{ width: 130 }}
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
          <div className="quick">
            {MB_OPTIONS.map((o) => (
              <button
                type="button"
                key={o.value}
                className={`btn${mb.includes(o.value) ? ' active' : ''}`}
                onClick={() => toggleMb(o.value)}
                title={`${mb.includes(o.value) ? '取消筛选' : '筛选'}${o.label}命中`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <input
            className="input"
            style={{ width: 180 }}
            placeholder="搜索标题 / 命中词 / 规则名"
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="搜索标题、命中词或规则名"
          />
          {dirty && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setFrom(defaultFrom)
                setTo(today)
                setSourceId('')
                setMb([])
                setText('')
              }}
            >
              重置筛选
            </button>
          )}
        </div>
        <div className="card-scroll">
          {loading ? (
            <div className="empty">正在加载历史命中…</div>
          ) : result.items.length === 0 ? (
            <EmptyState
              title={result.total === 0 ? '该条件下没有历史命中' : '本页为空'}
              hint={
                result.total === 0
                  ? '换个日期范围、来源或命中方式试试；命中记录按天持久化在本地，重启不会丢'
                  : '筛选收窄后页码已收口，回到第一页看看'
              }
            />
          ) : (
            result.items.map((hit) => (
              <HistoryRow key={`${hit.topic.sourceId}:${hit.topic.id}`} hit={hit} />
            ))
          )}
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            上一页
          </button>
          <span className="card-count num">
            第 {page + 1} / {pageCount} 页 · 共 {result.total} 条 · 每页 {PAGE_SIZE} 条
          </span>
          <button
            type="button"
            className="btn"
            disabled={page + 1 >= pageCount}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </button>
        </div>
      </section>
    </div>
  )
}
