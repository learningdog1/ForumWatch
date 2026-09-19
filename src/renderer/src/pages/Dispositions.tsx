/**
 * 处置流水页（R7-W1："为什么没推送"）。
 * - 数据：dispositionsRecent（内存环最近 200，实时视图）/ dispositionsDay（某本地日
 *   的 pipeline JSONL）；两者都按时间倒序展示。10s 轻量自动刷新（实时视图）。
 * - 筛选：outcome 分组 chips（全部/推送结果/已拦截/未命中/挂起中，单选）+
 *   来源下拉（从数据派生）+ 日期选择（空 = 实时最近；选日期 = 查当天持久化记录）。
 * - 行：时间 / 来源徽标 / 标题 / outcome 徽标（成功绿·失败红·挂起琥珀·其余灰）/
 *   detail 小字（命中词、AI 理由、score 与阈值、失败原因等）。
 * - 全部样式复用既有类（.hit/.how-badge/.quick/.chip 等），本工作包不改 global.css。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Disposition, DispositionOutcome } from '@shared/ipc'
import { EmptyState } from '../components/EmptyState'
import { IconRefresh } from '../components/icons'
import { formatClock, localDate } from '../lib/time'

/** 实时视图的自动刷新间隔（内存环数据面，IPC 廉益） */
const AUTO_REFRESH_MS = 10_000

/** outcome 分组（chips 单选）；组内为该组包含的 outcome 集合 */
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

/** outcome → 徽标文案 */
const OUTCOME_LABELS: Record<DispositionOutcome, string> = {
  pushed: '已推送',
  'push-failed': '推送失败',
  muted: '静音',
  deferred: '已挂起',
  'deferred-skip': '挂起中',
  'semantic-pending': '语义待判',
  filtered: '来源过滤',
  'old-below-threshold': '旧帖',
  pinned: '置顶',
  excluded: '排除词',
  'similar-swallowed': '相似去重',
  miss: '未命中',
  'semantic-miss': '语义未中',
  'semantic-below-threshold': '置信度低'
}

/** outcome → 徽标配色（.feedback.ok/.err/.warn/.muted 的两类选择器盖过 .how-badge 底色） */
function badgeTone(outcome: DispositionOutcome): string {
  if (outcome === 'pushed') return 'feedback ok'
  if (outcome === 'push-failed') return 'feedback err'
  if (
    outcome === 'deferred' ||
    outcome === 'deferred-skip' ||
    outcome === 'semantic-pending' ||
    outcome === 'semantic-below-threshold'
  ) {
    return 'feedback warn'
  }
  return 'feedback muted'
}

export function Dispositions() {
  const [items, setItems] = useState<Disposition[]>([])
  const [loading, setLoading] = useState(true)
  const [group, setGroup] = useState<GroupId>('all')
  const [sourceId, setSourceId] = useState('')
  /** 空 = 实时最近（内存环）；有值 = 查该本地日的持久化流水 */
  const [day, setDay] = useState('')
  const dayRef = useRef(day)
  dayRef.current = day

  const load = useCallback(async (targetDay: string): Promise<void> => {
    setLoading(true)
    try {
      const list =
        targetDay === '' ? await window.api.dispositionsRecent() : await window.api.dispositionsDay(targetDay)
      // 两个数据面都返回旧→新（写入序）；展示时间倒序（新→旧）
      setItems(list.slice().reverse())
    } catch {
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(day)
  }, [day, load])

  // 实时视图轻量自动刷新（查历史日的文件是静态的，不必刷）
  useEffect(() => {
    if (day !== '') return
    const timer = window.setInterval(() => {
      void load(dayRef.current)
    }, AUTO_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [day, load])

  const groupOutcomes = useMemo(() => {
    const g = OUTCOME_GROUPS.find((x) => x.id === group)
    return g !== undefined && g.outcomes !== null ? new Set<string>(g.outcomes) : null
  }, [group])

  const sourceOptions = useMemo(() => {
    const ids = new Set<string>()
    for (const d of items) ids.add(d.sourceId)
    return [...ids].sort()
  }, [items])

  const filtered = useMemo(
    () =>
      items.filter(
        (d) =>
          (groupOutcomes === null || groupOutcomes.has(d.outcome)) &&
          (sourceId === '' || d.sourceId === sourceId)
      ),
    [items, groupOutcomes, sourceId]
  )

  const today = localDate()

  return (
    <div className="page page-dashboard">
      <section className="card card-grow">
        <div className="card-head">
          <span className="card-title">处置流水</span>
          <span className="card-count">
            {day === '' ? '最近 200 条 · 实时' : `${day === today ? '今天' : day} · 历史文件`}
            {filtered.length !== items.length ? ` · 筛选 ${filtered.length}/${items.length}` : ''}
          </span>
        </div>
        <div className="actions">
          <div className="quick">
            {OUTCOME_GROUPS.map((g) => (
              <button
                type="button"
                key={g.id}
                className={`btn${group === g.id ? ' active' : ''}`}
                onClick={() => setGroup(g.id)}
              >
                {g.label}
              </button>
            ))}
          </div>
          <div className="input-row">
            <select
              className="input"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              aria-label="按来源筛选"
            >
              <option value="">全部来源</option>
              {sourceOptions.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </div>
          <div className="input-row">
            <input
              type="date"
              className="input"
              value={day}
              max={today}
              onChange={(e) => setDay(e.target.value)}
              aria-label="按日期查历史流水"
            />
            {day !== '' && (
              <button type="button" className="btn" onClick={() => setDay('')}>
                回实时
              </button>
            )}
          </div>
          <button type="button" className="btn" onClick={() => void load(day)}>
            <IconRefresh size={14} />
            刷新
          </button>
        </div>
        <div className="card-scroll">
          {loading ? (
            <div className="empty">正在加载处置流水…</div>
          ) : filtered.length === 0 ? (
            <EmptyState
              title={items.length === 0 ? '还没有处置记录' : '当前筛选下没有记录'}
              hint={
                items.length === 0
                  ? '监控运行后，每条新帖在过滤、匹配、推送各环节的去向会记录在这里——"为什么没推送"在这里查'
                  : '换个分组或来源试试；挂起中的帖子等免打扰结束/摘要到点后会迁移为推送结果'
              }
            />
          ) : (
            filtered.map((d, i) => (
              <div className="hit" key={`${d.ts}-${d.sourceId}-${d.topicId}-${i}`}>
                <time>{formatClock(d.ts)}</time>
                <span className="src-badge" title={d.sourceId}>
                  {d.sourceId}
                </span>
                <span className="hit-title" title={d.title}>
                  {d.title}
                </span>
                {d.detail !== undefined && (
                  <span className="ai-reason" title={d.detail}>
                    {d.detail}
                  </span>
                )}
                <span className="push">
                  <span className={`how-badge ${badgeTone(d.outcome)}`}>
                    {OUTCOME_LABELS[d.outcome]}
                  </span>
                </span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  )
}
