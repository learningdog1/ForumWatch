/**
 * 历史命中右栏（Watchtower 步骤 K，概念稿 .rail 四块面板一比一）：
 * a. 7 日命中趋势 bars7（getStats(14).byDay 的近 7 天切片——「getStats(7) 或现有
 *    等价」取后者，与关键词榜共用一次 14 天拉取；点柱 = 该日单日窗口 pickDay）；
 * b. TOP 关键词横条（stats.keywordHits 命中词降序；折叠态只列 TOP 5，展开态
 *    全量 + 零命中词 chips + 「去调整关键词」深链——旧 Z1 统计卡的折叠记忆
 *    （localStorage fw.history.statsCollapsed）与零命中修剪入口在这里续命）；
 * c. 价格分布横条（当前查询窗口本页 hits 用 extractDeal 复算分桶：<¥10 /
 *    ¥10-20 / ¥20-30 / ¥30-40 / ≥¥40 / 外币·未识别——外币不折算、无价格标题
 *    与外币同桶，口径写在面板 title）；
 * d. 高峰时段 24 格热力（自取近 2 日 queryHits 逐时桶，limit 200 截断口径入
 *    title；色深 = 频次归一，两主题 ≥3 图形对比由 events.css 定向覆写保证）。
 *
 * 统计双窗口口径规则延续：a/b 是固定窗口画像（14 天），不随下方列表筛选变化；
 * c 跟随列表当前页（反映用户眼前所见），d 是固定近 2 日——口径各自写进 title。
 *
 * 另导出 useGripDrag：概念稿 fwMakeDrag 的 React 直译（pointer 捕获 + .on 态 +
 * 双击复位），grip-y（右栏调宽）/grip-x（表格调高）共用；拖拽逻辑在 History.tsx
 * （它持有 grid 与 panel 的 ref），grip-y 元素经 props.gripY 传入本栏收位。
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { HitRecord } from '@shared/types'
import type { StatsResult } from '@shared/ipc'
import { extractDeal } from '@shared/deal'
import { ErrorBar } from './ErrorBar'
import { IconRefresh } from './icons'
import { localDate } from '../lib/time'

/** 数据驱动的宽度/高度变量类型出口（--w/--h/--v 是数据不是 token） */
type RailVars = CSSProperties & { '--w'?: string; '--h'?: string; '--v'?: string }

/** 近 2 日热力拉取的页大小（IPC 单次钳位上限 200；截断口径写入 title） */
const HEAT_LIMIT = 200

/** 关键词榜默认展示条数（折叠态；概念稿 5 行） */
const KW_TOP = 5

/** 旧 Z1 统计卡折叠记忆的 localStorage 键（history.md §4.2-6；键名沿用不迁移） */
const KW_COLLAPSED_KEY = 'fw.history.statsCollapsed'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const

/** 本地日前推 N 天（Date 运算兜底跨月/跨年） */
function daysAgoLocal(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return localDate(d)
}

/** 时区标签（概念稿 ph-tag「UTC+8」的对位；按本机实际偏移如实展示） */
function tzLabel(): string {
  const offsetH = -new Date().getTimezoneOffset() / 60
  const rounded = Math.abs(offsetH % 1) < 0.01 ? String(Math.round(offsetH)) : offsetH.toFixed(1)
  return `UTC${offsetH >= 0 ? '+' : ''}${rounded}`
}

/** 折叠记忆（沿用旧 Z1 语义：默认折叠；读写失败按默认） */
function readKwCollapsed(): boolean {
  try {
    return window.localStorage.getItem(KW_COLLAPSED_KEY) !== '0'
  } catch {
    return true
  }
}

/* ── fwMakeDrag 的 React 直译（概念稿底部 script）────────────────────
   pointerdown 置 .on + setPointerCapture（try/catch，缺捕获环境不炸）+
   preventDefault（防拖拽选中文本）；捕获后 pointermove/up/cancel 持续落在
   grip 自身；双击复位。返回值直接展开到 grip 元素上。 */
export function useGripDrag(
  onMove: (e: { clientX: number; clientY: number }) => void,
  onReset?: () => void
) {
  const onRef = useRef(false)
  return {
    onPointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
      onRef.current = true
      e.currentTarget.classList.add('on')
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        /* 捕获不可用时退化为仅 hover 态拖拽，不炸 */
      }
      e.preventDefault()
    },
    onPointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
      if (onRef.current) onMove(e)
    },
    onPointerUp(e: ReactPointerEvent<HTMLDivElement>): void {
      if (!onRef.current) return
      onRef.current = false
      e.currentTarget.classList.remove('on')
    },
    onPointerCancel(e: ReactPointerEvent<HTMLDivElement>): void {
      if (!onRef.current) return
      onRef.current = false
      e.currentTarget.classList.remove('on')
    },
    onDoubleClick: onReset
  }
}

/* ── a. 7 日命中趋势（概念 .bars7）────────────────────────────────── */

function TrendPanel(props: {
  stats: StatsResult
  today: string
  onPickDay: (date: string) => void
}) {
  const byDate = new Map(props.stats.byDay.map((d) => [d.date, d.count]))
  const days = Array.from({ length: 7 }, (_, k) => {
    const date = daysAgoLocal(6 - k)
    return { date, count: byDate.get(date) ?? 0 }
  })
  const max = Math.max(1, ...days.map((d) => d.count))
  return (
    <section
      className="panel rail-panel"
      title="近 7 天每日命中（getStats 14 天窗口切片）· 固定窗口，不随下方筛选变化 · 点柱查看该日"
    >
      <div className="panel-h">
        <h3>7 日命中趋势</h3>
        <span className="ph-tag">Trend</span>
      </div>
      <div
        className="bars7"
        role="group"
        aria-label="近 7 天每日命中，点击柱把列表窗口设为该日"
      >
        {days.map((d) => {
          const isToday = d.date === props.today
          const wd = WEEKDAYS[new Date(`${d.date}T00:00:00`).getDay()]
          const h = d.count === 0 ? 0 : Math.max(8, Math.round((d.count / max) * 100))
          const style: RailVars = { '--h': `${h}%` }
          return (
            <button
              type="button"
              key={d.date}
              title={`${d.date.slice(5)} 周${wd} · ${d.count} 条 · 点击查看该日`}
              aria-label={`${d.date.slice(5)} 周${wd} ${d.count} 条`}
              onClick={() => props.onPickDay(d.date)}
            >
              <i
                className={`b${isToday ? ' acc' : ''}${d.count === 0 ? ' z' : ''}`}
                style={style}
              />
            </button>
          )
        })}
      </div>
      <div className="lbls">
        {days.map((d) => (
          <span key={d.date}>{WEEKDAYS[new Date(`${d.date}T00:00:00`).getDay()]}</span>
        ))}
      </div>
    </section>
  )
}

/* ── b. TOP 关键词（概念 .kw 横条；折叠记忆 + 零命中修剪入口）──────── */

function KeywordPanel(props: {
  stats: StatsResult
  collapsed: boolean
  onToggle: () => void
  onGoSettings?: () => void
}) {
  const hit = props.stats.keywordHits.filter((k) => k.zeroHit !== true)
  const zero = props.stats.keywordHits.filter((k) => k.zeroHit === true)
  const shown = props.collapsed ? hit.slice(0, KW_TOP) : hit
  const max = Math.max(1, ...hit.map((k) => k.count))
  return (
    <section
      className="panel rail-panel"
      title="近 14 天命中词榜（getStats keywordHits，固定窗口）· 零命中词是修剪关键词的信号"
    >
      <div className="panel-h">
        <h3>TOP 关键词</h3>
        <button
          type="button"
          className="rail-toggle"
          aria-expanded={!props.collapsed}
          onClick={props.onToggle}
          title={
            props.collapsed
              ? `展开全部命中词与零命中词（共 ${hit.length} 个命中词、${zero.length} 个零命中词）`
              : '收起到 TOP 关键词'
          }
        >
          {props.collapsed
            ? `共 ${hit.length} 个${zero.length > 0 ? ` · 零命中 ${zero.length}` : ''} · 展开全部`
            : '收起'}
        </button>
      </div>
      {hit.length === 0 ? (
        <p className="rail-empty">窗口内没有任何关键词命中。</p>
      ) : (
        shown.map((k) => {
          const style: RailVars = { '--w': `${Math.round((k.count / max) * 100)}%` }
          return (
            <div className="kw" key={k.keyword} title={`命中 ${k.count} 次`}>
              <b>{k.keyword}</b>
              <span className="bar-t">
                <i style={style} />
              </span>
              <span className="n num">{k.count}</span>
            </div>
          )
        })
      )}
      {!props.collapsed && zero.length > 0 && (
        <div className="rail-zero">
          <p className="rail-zero-note">
            零命中 {zero.length} 个 —— 窗口内从未命中，考虑移除或改写：
          </p>
          <div className="rail-zero-chips">
            {zero.map((k) => (
              <span
                key={k.keyword}
                className="zero-chip"
                title="统计窗口内零命中：考虑移除或改写该关键词"
              >
                {k.keyword} · 未命中
              </span>
            ))}
          </div>
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
      )}
    </section>
  )
}

/* ── c. 价格分布（概念 .kw 横条 mono 档；extractDeal 复算分桶）────── */

/** 分桶定义：金额档按 CNY 数值，外币（USD）不折算与未提取到价格的标题同桶 */
const PRICE_BUCKETS: { label: string; fx?: boolean; test?: (amount: number) => boolean }[] = [
  { label: '<¥10', test: (n) => n < 10 },
  { label: '¥10-20', test: (n) => n >= 10 && n < 20 },
  { label: '¥20-30', test: (n) => n >= 20 && n < 30 },
  { label: '¥30-40', test: (n) => n >= 30 && n < 40 },
  { label: '≥¥40', test: (n) => n >= 40 },
  { label: '外币·未识别', fx: true }
]

function PricePanel(props: { hits: HitRecord[] }) {
  const counts = PRICE_BUCKETS.map(() => 0)
  for (const hit of props.hits) {
    const deal = extractDeal(hit.topic.title)
    const price = deal?.price
    if (price != null && price.currency === 'CNY') {
      const idx = PRICE_BUCKETS.findIndex((b) => b.test?.(price.amount) === true)
      counts[idx >= 0 ? idx : PRICE_BUCKETS.length - 1] += 1
    } else {
      // 外币不折算；未提取到价格（null）同入末桶——口径写在面板 title
      counts[PRICE_BUCKETS.length - 1] += 1
    }
  }
  const max = Math.max(1, ...counts)
  const panelTitle = `当前查询窗口本页 ${props.hits.length} 条的标题价格复算（extractDeal，与引擎判定同源提取器）· 按金额分桶不分周期 · 外币不折算、未识别价格的标题计入末桶 · 分页未载入的不计`
  return (
    <section className="panel rail-panel" title={panelTitle}>
      <div className="panel-h">
        <h3>价格分布</h3>
        <span className="ph-tag">¥</span>
      </div>
      {PRICE_BUCKETS.map((b, i) => {
        const style: RailVars = { '--w': `${Math.round((counts[i] / max) * 100)}%` }
        return (
          <div className="kw" key={b.label} title={`${b.label} · ${counts[i]} 条`}>
            <b className={`mono${b.fx ? ' fx' : ''}`}>{b.label}</b>
            <span className="bar-t">
              <i style={style} />
            </span>
            <span className="n num">{counts[i]}</span>
          </div>
        )
      })}
    </section>
  )
}

/* ── d. 高峰时段 24 格热力（概念 .heat；近 2 日逐时桶）────────────── */

interface HeatState {
  /** 窗口起（本地日，含端点） */
  from: string
  to: string
  /** 24 小时桶计数 */
  hours: number[]
  /** 实际取回条数（≤200） */
  fetched: number
  /** 窗口过滤后总数（> fetched 即发生截断） */
  total: number
}

function HeatPanel(props: { reloadTick: number; today: string }) {
  const [heat, setHeat] = useState<HeatState | null>(null)
  /** 请求序号守卫：慢响应不得覆盖更新的查询状态 */
  const seqRef = useRef(0)

  useEffect(() => {
    const seq = ++seqRef.current
    const from = daysAgoLocal(1)
    void window.api
      .queryHits({ fromDate: from, toDate: props.today, limit: HEAT_LIMIT, offset: 0 })
      .then((r) => {
        if (seq !== seqRef.current) return
        const hours = new Array<number>(24).fill(0)
        for (const hit of r.items) {
          const ts = hit.notifiedAt ?? hit.topic.lastActiveAt
          if (ts == null || ts === '') continue
          const d = new Date(ts)
          if (Number.isNaN(d.getTime())) continue
          hours[d.getHours()] += 1
        }
        setHeat({ from, to: props.today, hours, fetched: r.items.length, total: r.total })
      })
      .catch(() => {
        /* 契约不抛；防御性吞掉保持上次数据 */
      })
  }, [props.reloadTick, props.today])

  const max = heat == null ? 1 : Math.max(1, ...heat.hours)
  const title =
    heat == null
      ? '近 2 日逐小时命中'
      : `近 2 日（${heat.from.slice(5)}～${heat.to.slice(5)}）逐小时命中 · 取最近 ${heat.fetched} 条${
          heat.total > heat.fetched ? `（窗口共 ${heat.total} 条，超出截断不计）` : ''
        }`
  return (
    <section className="panel rail-panel" title={title}>
      <div className="panel-h">
        <h3>高峰时段</h3>
        <span className="ph-tag">{tzLabel()}</span>
      </div>
      <div className="heat" role="img" aria-label={title}>
        {Array.from({ length: 24 }, (_, h) => {
          const count = heat?.hours[h] ?? 0
          const style: RailVars = { '--v': `${count / max}` }
          return (
            <i
              key={h}
              className={count === 0 ? 'z' : undefined}
              style={style}
              title={`${String(h).padStart(2, '0')}:00–${String(h).padStart(2, '0')}:59 · ${count} 条`}
            />
          )
        })}
      </div>
      <div className="axis">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>23</span>
      </div>
    </section>
  )
}

/* ── 右栏本体 ──────────────────────────────────────────────────────── */

export function HistoryRail(props: {
  /** 统计面（getStats(14) 固定窗口；null=尚未成功读取过） */
  stats: StatsResult | null
  /** 统计读取失败原因（错误 ≠ 空：旧数据保留 + 错误条 + 重试） */
  statsError: string | null
  statsBusy: boolean
  /** 统一刷新（重试入口 + 热力随 reloadTick 重拉） */
  onRefresh: () => void
  /** 点趋势柱 = 该日单日窗口（接 History 的 pickDay 深链） */
  onPickDay: (date: string) => void
  /** 零命中关键词「去调整」出口（App 层切设置页 + 关键词卡锚点深链） */
  onGoSettings?: () => void
  /** 价格分布数据源：当前查询窗口本页 items（与表格所见一致） */
  pageHits: HitRecord[]
  /** 手动刷新 tick（热力近 2 日 fetch 随统一刷新重拉） */
  reloadTick: number
  /** 本地日（跨日时趋势标签与热力窗口自然翻日） */
  today: string
  /** grip-y 元素（左右调右栏宽；拖拽逻辑在 History，经此收位到栏左缘） */
  gripY: ReactNode
}) {
  const [kwCollapsed, setKwCollapsed] = useState(readKwCollapsed)

  function toggleKw(): void {
    setKwCollapsed((v) => {
      const next = !v
      try {
        window.localStorage.setItem(KW_COLLAPSED_KEY, next ? '1' : '0')
      } catch {
        /* 隐私模式等写失败：本次会话内仍生效，不记忆 */
      }
      return next
    })
  }

  return (
    <aside className="rail" aria-label="统计画像">
      {props.gripY}
      {props.statsError != null && (
        <ErrorBar
          message={`统计读取失败：${props.statsError}${
            props.stats != null ? '—— 以下为上次成功读取的数据' : ''
          }`}
          onRetry={props.onRefresh}
        />
      )}
      {props.stats == null && props.statsBusy && props.statsError == null && (
        /* 首载文字型加载态（与去向页/列表首载同款 disp-loading 范式） */
        <div className="rail-loading disp-loading">
          <IconRefresh size={12} />
          正在读取统计…
        </div>
      )}
      {props.stats != null && (
        <>
          <TrendPanel stats={props.stats} today={props.today} onPickDay={props.onPickDay} />
          <KeywordPanel
            stats={props.stats}
            collapsed={kwCollapsed}
            onToggle={toggleKw}
            onGoSettings={props.onGoSettings}
          />
        </>
      )}
      <PricePanel hits={props.pageHits} />
      <HeatPanel reloadTick={props.reloadTick} today={props.today} />
    </aside>
  )
}
