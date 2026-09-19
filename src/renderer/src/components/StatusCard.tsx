/**
 * 状态卡：大号状态徽标（与 deriveTrayLabel 同优先级派生）+ 四格指标
 * + 来源状态（per-source：健康点 / 最近成功 / 退避倒计时）
 * + AI 状态（生效模式徽标 / 降级提示 / 今日调用 / 最近错误）
 * + 操作条（子卡底部右对齐：暂停 danger / 测试灰描边 / 立即轮询主按钮）。
 * 下次轮询在已暂停时按契约忽略 nextPollAt（pause 后它保留旧值），显示 "—"。
 *
 * AI 展示口径（W2-c）：看 effectiveMode（实际生效）而非 config.ai.matchMode；
 * degraded 三态；lastAiError 在评估成功后由主进程自动清空。
 */
import { deriveTrayLabel } from '@shared/ipc'
import type { AiRuntimeStatus, EngineStatus, SourceStatus } from '@shared/types'
import { deriveRunState, matchModeLabel, sourceLabel, sourceToneKey } from '../lib/status'
import { formatCountdown, formatRelative } from '../lib/time'
import { IconBroadcast, IconDot, IconPause, IconPlay, IconRefresh, IconSend, IconSparkles } from './icons'

/** 操作条（Dashboard 注入；按钮逻辑留在页面层，状态卡只管摆放与分级） */
export interface StatusActions {
  paused: boolean
  busy: boolean
  onPauseToggle(): void
  onRunNow(): void
  onSendTest(): void
  feedback: { kind: 'ok' | 'err' | 'pending'; text: string } | null
}

function Metric(props: { k: string; v: string; tone?: 'warn' | 'err'; title?: string }) {
  return (
    <div className={`metric${props.tone != null ? ` ${props.tone}` : ''}`} title={props.title}>
      <div className="k">{props.k}</div>
      <div className="v">{props.v}</div>
    </div>
  )
}

/** 单个来源行：健康点 + 名称 + 健康文案（退避中带 mm:ss 倒计时）+ 最近成功 */
function SourceRow(props: { s: SourceStatus; now: number }) {
  const { s, now } = props
  const cooldown = s.cooldownUntil != null ? formatCountdown(Date.parse(s.cooldownUntil) - now) : null
  const tone = sourceToneKey(s)
  const healthText =
    tone === 'ok'
      ? '正常'
      : tone === 'backoff'
        ? cooldown != null
          ? `退避中 ${cooldown}`
          : '退避中'
        : '被拦截'
  return (
    <div className="src-row" title={s.lastError ?? undefined}>
      <span className={`src-dot tone-${tone}`}>
        <IconDot size={8} />
      </span>
      <span className="src-name">{sourceLabel(s.sourceId)}</span>
      <span className={`src-health tone-${tone} num`}>{healthText}</span>
      <span className="src-last" title={s.lastSuccessAt ?? undefined}>
        {s.lastSuccessAt == null ? '尚未成功' : `成功 ${formatRelative(s.lastSuccessAt, now)}`}
      </span>
    </div>
  )
}

/** AI 运行态块：生效模式 + 今日调用 + 降级提示 + 最近错误 */
function AiBlock(props: { ai: AiRuntimeStatus }) {
  const { ai } = props
  const semanticActive = ai.effectiveMode !== 'literal'
  return (
    <div className="subblock">
      <div className="subblock-title">
        <IconSparkles size={14} />
        <span>AI 匹配</span>
      </div>
      <div className="ai-row">
        <span className={`ai-mode${semanticActive ? ' ai' : ''}`}>
          {matchModeLabel(ai.effectiveMode)}
        </span>
        <span className="ai-calls num" title="今日语义评估调用 / 每日上限">
          今日 {ai.callsToday}/{ai.dailyLimit}
        </span>
      </div>
      {ai.degraded === 'unconfigured' && (
        <div className="ai-degraded warn">AI 未配置，语义监控停用</div>
      )}
      {ai.degraded === 'quota-exhausted' && (
        <div className="ai-degraded warn">今日 AI 配额用尽，已降级字面匹配</div>
      )}
      {ai.lastAiError != null && (
        <div className="ai-err" title={ai.lastAiError}>
          最近错误：{ai.lastAiError}
        </div>
      )}
    </div>
  )
}

/** 操作条：子卡底部右对齐（暂停 danger / 测试灰描边 / 立即轮询主按钮） */
function SubActions(props: { actions: StatusActions }) {
  const { actions } = props
  return (
    <div className="subactions">
      <button
        type="button"
        className={`btn${actions.paused ? '' : ' btn-danger'}`}
        disabled={actions.busy}
        onClick={actions.onPauseToggle}
      >
        {actions.paused ? <IconPlay size={14} /> : <IconPause size={14} />}
        {actions.paused ? '恢复监控' : '暂停监控'}
      </button>
      <button type="button" className="btn" disabled={actions.busy} onClick={actions.onSendTest}>
        <IconSend size={14} />
        发送测试通知
      </button>
      <button
        type="button"
        className="btn btn-primary"
        disabled={actions.busy || actions.paused}
        title={actions.paused ? '已暂停：先恢复监控' : '忽略等待，立即补一轮轮询'}
        onClick={actions.onRunNow}
      >
        <IconRefresh size={14} />
        立即轮询
      </button>
      {actions.feedback != null && (
        <span className={`feedback ${actions.feedback.kind}`}>{actions.feedback.text}</span>
      )}
    </div>
  )
}

export function StatusCard(props: { status: EngineStatus; now: number; actions: StatusActions }) {
  const { status, now, actions } = props
  const state = deriveRunState(status)

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
          v={status.desired === 'paused' ? '—' : formatRelative(status.nextPollAt, now)}
          title={status.desired === 'paused' ? '已暂停，不排程' : (status.nextPollAt ?? undefined)}
        />
        <Metric
          k="连续失败"
          v={`${status.consecutiveFailures} 次`}
          tone={status.consecutiveFailures > 0 ? 'warn' : undefined}
        />
        <Metric k="累计命中" v={`${status.totalHits} 条`} />
      </div>
      <div className="substatus">
        <div className="subblock">
          <div className="subblock-title">
            <IconBroadcast size={14} />
            <span>来源</span>
          </div>
          {status.sources.length === 0 ? (
            <div className="src-empty">暂无来源状态</div>
          ) : (
            status.sources.map((s) => <SourceRow key={s.sourceId} s={s} now={now} />)
          )}
        </div>
        <AiBlock ai={status.ai} />
        <SubActions actions={actions} />
      </div>
      {status.lastError != null && (
        <div className="lasterr" title={status.lastError}>
          最近错误：{status.lastError}
        </div>
      )}
    </section>
  )
}
