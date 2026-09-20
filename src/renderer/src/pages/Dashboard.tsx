/**
 * 监控台（dashboard.md §1.1 三段视口高布局）：
 * Zone A 页头（PageHeader：页题 + 副题 + 「更新于」+ 90s stale；已暂停/退避时
 * 低频事件属正常，不判 stale）→ Zone B 状态带（StatusCard，含挂起行）→
 * Zone C 最近命中（HitList）→ Zone D 运行日志（LogView）。整页不滚动（高度
 * 不足时由 C/D 的 min-height 兜底自然回退整页滚动）。
 * 按钮逻辑在本层；control()/sendTest() 统一三态反馈（busy 转圈 → ✓ 成功 /
 * ✗ 失败 + [重试]，audit §5.3 的无 catch 修复）。键盘（§6.1）：P 暂停/恢复、
 * R 立即轮询（暂停时行内反馈）、T 测试通知、L 聚焦日志筛选 chips；单键仅在
 * 焦点不在输入控件、非 IME 组合、且本页可见时生效。
 * 数据全部来自 useApi（全量 + 增量 + 三面错误态），App 层单次调用。
 */
import { useEffect, useRef, useState } from 'react'
import { HitList } from '../components/HitList'
import { LogView } from '../components/LogView'
import { PageHeader } from '../components/PageHeader'
import { StatusCard } from '../components/StatusCard'
import type { ApiState } from '../hooks/useApi'
import { useNow } from '../hooks/useNow'
import { formatClock, formatRelative } from '../lib/time'

type CtlCmd = 'pause' | 'resume' | 'runNow' | 'sendTest'

/** 失败反馈前缀（§4：「暂停失败 / 恢复失败 / 触发失败 / 发送失败」） */
const CMD_LABEL: Record<CtlCmd, string> = {
  pause: '暂停',
  resume: '恢复',
  runNow: '触发',
  sendTest: '发送'
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

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
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

  const paused = status.desired === 'paused'
  const busy = ctl.phase === 'busy'

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
      if (r.ok) setCtl({ phase: 'ok', cmd, doneAt: new Date().toISOString() })
      else setCtl({ phase: 'err', cmd, error: r.error })
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
        logChipsRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  return (
    <div className="page page-dashboard" ref={rootRef}>
      <PageHeader
        title="监控台"
        subtitle="现在的运行真相 · 事件实时更新"
        updatedAt={updatedAt}
        stale={status.desired === 'running' && status.health !== 'backoff'}
        paused={props.active === false}
      />
      <StatusCard
        status={status}
        now={now}
        error={errors.status}
        onRetry={retry}
        actions={{
          paused,
          busy,
          busyCmd: busy ? ctl.cmd : null,
          onPauseToggle: () => void control(paused ? 'resume' : 'pause'),
          onRunNow: () => void control('runNow'),
          onSendTest: () => void control('sendTest'),
          feedback
        }}
      />
      <HitList
        hits={hits}
        totalHits={status.totalHits}
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
      <LogView logs={logs} error={errors.logs} onRetry={retry} chipGroupRef={logChipsRef} />
    </div>
  )
}
