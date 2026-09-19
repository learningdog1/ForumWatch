/**
 * 状态卡：大号状态徽标（与 deriveTrayLabel 同优先级派生）+ 四格指标 + 最近错误。
 * 下次轮询在已暂停时按契约忽略 nextPollAt（pause 后它保留旧值），显示 "—"。
 */
import { deriveTrayLabel } from '@shared/ipc'
import type { EngineStatus } from '@shared/types'
import { deriveRunState } from '../lib/status'
import { formatRelative } from '../lib/time'

function Metric(props: { k: string; v: string; tone?: 'warn' | 'err'; title?: string }) {
  return (
    <div className={`metric${props.tone != null ? ` ${props.tone}` : ''}`} title={props.title}>
      <div className="k">{props.k}</div>
      <div className="v">{props.v}</div>
    </div>
  )
}

export function StatusCard(props: { status: EngineStatus; now: number }) {
  const { status, now } = props
  const state = deriveRunState(status)
  const paused = status.desired === 'paused'

  return (
    <section className="card statuscard" title={deriveTrayLabel(status)}>
      <div className="statuscard-head">
        <span className={`state-pill tone-${state.key}`}>
          <span className="dot" />
          {state.label}
        </span>
      </div>
      <div className="metrics">
        <Metric k="上次轮询" v={formatRelative(status.lastPollAt, now)} title={status.lastPollAt ?? undefined} />
        <Metric
          k="下次轮询"
          v={paused ? '—' : formatRelative(status.nextPollAt, now)}
          title={paused ? '已暂停，不排程' : (status.nextPollAt ?? undefined)}
        />
        <Metric
          k="连续失败"
          v={`${status.consecutiveFailures} 次`}
          tone={status.consecutiveFailures > 0 ? 'warn' : undefined}
        />
        <Metric k="累计命中" v={`${status.totalHits} 条`} />
      </div>
      {status.lastError != null && (
        <div className="lasterr" title={status.lastError}>
          最近错误：{status.lastError}
        </div>
      )}
    </section>
  )
}
