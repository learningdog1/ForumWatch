/**
 * 状态卡（Zone B，dashboard.md §3.2）：大号状态徽标（与 deriveTrayLabel 同优先级
 * 派生）+ 四格指标（数值 fs-32/700 mono，R12 display 档）+ 来源状态（per-source：健康点 / 最近成功 /
 * 退避倒计时；全局被拦时标题给 aux 解释）+ AI 状态（生效模式徽标 / 计数 /
 * 降级提示 / 最近 AI 错误）+ 挂起行（PendingRow，audit #6：语义常显
 * 不藏 title，无「立即补发」——引擎无此 IPC，不虚构）+ 最近错误 + 操作条。
 *
 * 下次轮询在已暂停时按契约忽略 nextPollAt（pause 后它保留旧值），显示 "—"。
 * AI 展示口径（W2-c）：看 effectiveMode（实际生效）而非 config.ai.matchMode。
 * 操作条（§3.2 表）：任何引擎态至多一个实底主按钮（运行中=立即轮询 /
 * 已暂停=恢复监控）；暂停是可逆高频操作，降为 danger 描边。
 */
import { useState } from 'react'
import { deriveTrayLabel } from '@shared/ipc'
import type { AiRuntimeStatus, EngineStatus, SourceStatus } from '@shared/types'
import { deriveRunState, matchModeLabel, sourceLabel, sourceToneKey } from '../lib/status'
import { formatCountdown, formatRelative } from '../lib/time'
import { ErrorBar } from './ErrorBar'
import {
  IconBroadcast,
  IconCheck,
  IconChevronDown,
  IconClock,
  IconDot,
  IconPause,
  IconPlay,
  IconRefresh,
  IconSend,
  IconSparkles,
  IconX
} from './icons'

/** 千分位（挂起/累计上千是正常形态，tnum 原样展示） */
const fmtNum = (n: number): string => n.toLocaleString('zh-CN')

/** 操作条（Dashboard 注入；按钮逻辑留在页面层，状态卡只管摆放与分级） */
export interface StatusActions {
  paused: boolean
  busy: boolean
  /** 正在执行的命令（对应按钮转圈；null=空闲） */
  busyCmd: 'pause' | 'resume' | 'runNow' | 'sendTest' | null
  onPauseToggle(): void
  onRunNow(): void
  onSendTest(): void
  feedback: { kind: 'ok' | 'err' | 'pending'; text: string; retry?: () => void } | null
}

/** tone 档：warn/err = 语义色文字；live = 倒计时格 wash 底（实时感锚，纯视觉） */
function Metric(props: {
  k: string;
  v: string;
  tone?: 'warn' | 'err' | 'live';
  title?: string;
}) {
  return (
    <div className={`metric${props.tone != null ? ` ${props.tone}` : ''}`} title={props.title}>
      <div className="k">{props.k}</div>
      <div className="v num">{props.v}</div>
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

/** AI 运行态块：生效模式 + 今日调用（含锐评，纯计数无上限）+ 降级提示 + 最近错误 */
function AiBlock(props: { ai: AiRuntimeStatus }) {
  const { ai } = props
  const semanticActive = ai.effectiveMode !== 'literal'
  return (
    <div className="subblock">
      <div className="subblock-title ai">
        <IconSparkles size={14} />
        <span>AI 匹配</span>
      </div>
      <div className="ai-row">
        <span className={`ai-mode${semanticActive ? ' ai' : ''}`}>
          {matchModeLabel(ai.effectiveMode)}
        </span>
        <span className="ai-calls num" title="今日 AI 调用（语义评估 + 锐评，锐评一次计入两者；纯计数，无每日上限）">
          今日调用 {ai.callsToday}
        </span>
      </div>
      <div className="ai-row">
        <span
          className="ai-calls num"
          title="今日锐评调用次数（已计入今日总调用；与语义评估均无每日上限）"
        >
          其中锐评 {ai.commentaryToday ?? 0}
        </span>
      </div>
      {ai.degraded === 'unconfigured' && (
        <div className="ai-degraded">AI 未配置 · 语义监控停用，仅字面与规则命中</div>
      )}
      {ai.lastAiError != null && (
        <div className="ai-err" title={ai.lastAiError}>
          最近 AI 错误：{ai.lastAiError}
        </div>
      )}
    </div>
  )
}

/**
 * 挂起行（audit #6 的修法，原 Dashboard 独立弱条并入状态卡）：
 * 主句 + 常显短说明（不藏 title）+ 可展开详情三行；N=0 整行不显示。
 * 挂起上千条是免打扰过夜的正常形态，计数 tnum 原样展示。
 */
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

/** 操作反馈（§4 行内三态）：aria-live；失败带 [重试]（原命令重发） */
function Feedback(props: NonNullable<StatusActions['feedback']>) {
  const fb = props
  return (
    <span className={`feedback ${fb.kind}`} aria-live="polite">
      {fb.kind === 'ok' && <IconCheck size={12} />}
      {fb.kind === 'err' && <IconX size={12} />}
      {fb.text}
      {fb.retry != null && (
        <button type="button" className="feedback-retry" onClick={fb.retry}>
          重试
        </button>
      )}
    </span>
  )
}

/** 操作条：子卡底部右对齐（运行中：暂停 danger 描边 / 测试次级 / 立即轮询主按钮；
    已暂停：恢复监控升唯一主按钮，立即轮询 disabled 且降为中性钮——§2.1 同视图
    至多一个实底主按钮）。busy 按钮转圈、文字不替换。 */
function SubActions(props: { actions: StatusActions }) {
  const { actions } = props
  const busyCmd = actions.busy ? actions.busyCmd : null
  const pauseBusy = busyCmd === (actions.paused ? 'resume' : 'pause')
  return (
    <div className="subactions">
      <button
        type="button"
        className={`btn${actions.paused ? ' btn-primary' : ' btn-danger'}${pauseBusy ? ' busy' : ''}`}
        disabled={actions.busy}
        onClick={actions.onPauseToggle}
        title={actions.paused ? '恢复轮询，按设置间隔排程 (P)' : '暂停轮询与推送判定；托盘仍驻留 (P)'}
      >
        {pauseBusy ? null : actions.paused ? <IconPlay size={14} /> : <IconPause size={14} />}
        {actions.paused ? '恢复监控' : '暂停监控'}
      </button>
      <button
        type="button"
        className={`btn${busyCmd === 'sendTest' ? ' busy' : ''}`}
        disabled={actions.busy}
        onClick={actions.onSendTest}
        title="向全部就绪通道广播一条测试消息，不走路由 (T)"
      >
        {busyCmd === 'sendTest' ? null : <IconSend size={14} />}
        发送测试通知
      </button>
      <button
        type="button"
        className={`btn${actions.paused ? '' : ' btn-primary'}${busyCmd === 'runNow' ? ' busy' : ''}`}
        disabled={actions.busy || actions.paused}
        title={actions.paused ? '已暂停：先恢复监控' : '忽略等待，立即补一轮轮询 (R)'}
        onClick={actions.onRunNow}
      >
        {busyCmd === 'runNow' ? null : <IconRefresh size={14} />}
        立即轮询
      </button>
    </div>
  )
}

export function StatusCard(props: {
  status: EngineStatus
  now: number
  actions: StatusActions
  /** 状态面读取失败原因（错误 ≠ 空：旧快照保留，错误条叠卡顶） */
  error?: string | null
  onRetry?: () => void
}) {
  const { status, now, actions } = props
  const state = deriveRunState(status)
  const pending = status.pendingNotifyCount ?? 0

  return (
    <section className="card statuscard" title={deriveTrayLabel(status)}>
      {props.error != null && (
        <ErrorBar message={`运行状态读取失败：${props.error}`} onRetry={props.onRetry} />
      )}
      <div className="statuscard-head">
        <span className={`state-pill tone-${state.key}`}>
          {/* running 态点稍大一档（实时感的静态表达；无限循环动画为红线 §4-8 禁用） */}
          <span className={`dot${state.key === 'running' ? ' live' : ''}`} />
          {state.label}
        </span>
        {actions.feedback != null && <Feedback {...actions.feedback} />}
      </div>
      <div className="metrics">
        <Metric
          k="上次轮询"
          v={formatRelative(status.lastPollAt, now)}
          title={status.lastPollAt ?? undefined}
        />
        <Metric
          k="下次轮询"
          v={status.desired === 'paused' ? '—' : formatRelative(status.nextPollAt, now)}
          tone={status.desired === 'paused' ? undefined : 'live'}
          title={status.desired === 'paused' ? '已暂停，不排程' : (status.nextPollAt ?? undefined)}
        />
        <Metric
          k="连续失败"
          v={`${status.consecutiveFailures} 次`}
          tone={status.consecutiveFailures > 0 ? 'warn' : undefined}
          title={
            status.consecutiveFailures >= 5
              ? `连续失败 ${status.consecutiveFailures} 次 · 详见下方最近错误与运行日志`
              : undefined
          }
        />
        <Metric
          k="累计命中"
          v={`${fmtNum(status.totalHits)} 条`}
          title="跨重启累计；下方『最近命中』仅本会话 200 条"
        />
      </div>
      <div className="substatus">
        <div className="subblock">
          <div className="subblock-title">
            <IconBroadcast size={14} />
            <span>来源</span>
            {state.key === 'challenged' && (
              <span
                className="subblock-aux"
                title="全局被拦不影响其他来源：聚合健康取各来源最差，单来源仍独立轮询"
              >
                个别来源被拦不影响其他来源
              </span>
            )}
          </div>
          {status.sources.length === 0 ? (
            <div className="src-empty">暂无启用中的来源 · 去设置添加</div>
          ) : (
            status.sources.map((s) => <SourceRow key={s.sourceId} s={s} now={now} />)
          )}
        </div>
        <AiBlock ai={status.ai} />
      </div>
      {pending > 0 && <PendingRow count={pending} />}
      {status.lastError != null && (
        <div className="lasterr" title={status.lastError}>
          <IconX size={12} />
          最近错误：{status.lastError}
        </div>
      )}
      <SubActions actions={actions} />
    </section>
  )
}
