/**
 * 14 柱趋势条（R10 阶段 3，history.md §2 Z1 / §4.2-9）：纯 CSS 柱，无图表库
 * （dsn 禁装饰性图表——本图是决策数据）。byDay 只含有命中的日期，调用方铺满
 * 14 天窗口后传入（旧 → 新）。
 *
 * - 柱高线性映射 max：零命中日 2px 空槽，峰值 40px；44px 可点口径落在整柱
 *   容器上（--hit），与 14 柱窄布局不冲突（history.md §1 焦点/可点红线裁决）。
 * - hover 加深（透明度 +0.1）+ title 带绝对数（`09-19 · 47 条`）。
 * - 点柱 = 把列表窗口设为该单日（趋势上看到峰值 → 想看那天具体是什么，一跳）。
 * - 动态高度不是设计 token：经 --h CSS 变量下发，样式仍由类承载。
 */
import type { CSSProperties } from 'react'

export interface SparkDay {
  /** 本地日期 'YYYY-MM-DD'（旧 → 新） */
  date: string
  count: number
}

/** 柱高数据变量（--h）的类型出口：数据驱动的尺寸，非 token */
type BarVars = CSSProperties & { '--h'?: string }

/** 峰值柱高（44px 柱容器内留 4px 呼吸位；history.md §6 线性映射口径） */
const BAR_MAX_PX = 40

export function StatSparkbar(props: { days: SparkDay[]; onPickDay?: (date: string) => void }) {
  const { days } = props
  const max = Math.max(1, ...days.map((d) => d.count))
  const first = days[0]?.date ?? ''
  const last = days.length > 0 ? days[days.length - 1].date : ''
  return (
    <div>
      <div
        className="sparkbar"
        role="group"
        aria-label="近 14 天每日命中，点击柱把列表窗口设为该日"
      >
        {days.map((d) => {
          const h = d.count === 0 ? 2 : Math.max(4, Math.round((d.count / max) * BAR_MAX_PX))
          const style: BarVars = { '--h': `${h}px` }
          return (
            <button
              type="button"
              key={d.date}
              className="spark-col"
              title={`${d.date.slice(5)} · ${d.count} 条`}
              aria-label={`${d.date.slice(5)} ${d.count} 条`}
              onClick={() => props.onPickDay?.(d.date)}
            >
              <span className={`spark-bar${d.count === 0 ? ' zero' : ''}`} style={style} />
            </button>
          )
        })}
      </div>
      {first !== '' && (
        <div className="spark-labels">
          <span>{first.slice(5)}</span>
          <span>{last.slice(5)}</span>
        </div>
      )}
    </div>
  )
}
