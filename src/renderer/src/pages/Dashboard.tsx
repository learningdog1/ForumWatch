/**
 * 监控台：状态卡 + 操作按钮（暂停/恢复、立即轮询、发送测试通知）
 * + 最近命中列表 + 运行日志。数据全部来自 useApi（全量 + 增量）。
 */
import { useState } from 'react'
import { HitList } from '../components/HitList'
import { LogView } from '../components/LogView'
import { StatusCard } from '../components/StatusCard'
import { IconPause, IconPlay, IconRefresh, IconSend } from '../components/icons'
import type { ApiState } from '../hooks/useApi'
import { useNow } from '../hooks/useNow'

type Feedback = { kind: 'ok' | 'err' | 'pending'; text: string }

export function Dashboard(props: ApiState) {
  const { status, hits, logs } = props
  const now = useNow(1000)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  const paused = status.desired === 'paused'

  async function control(cmd: 'pause' | 'resume' | 'runNow'): Promise<void> {
    setBusy(true)
    try {
      setFeedback(null)
      await window.api.engineControl(cmd)
    } finally {
      setBusy(false)
    }
  }

  async function sendTest(): Promise<void> {
    setBusy(true)
    setFeedback({ kind: 'pending', text: '正在发送测试消息…' })
    try {
      const r = await window.api.engineControl('sendTest')
      setFeedback(
        r.ok
          ? { kind: 'ok', text: '✓ 测试消息已发送，请在 Telegram 中查收' }
          : { kind: 'err', text: `发送失败：${r.error}` }
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page page-dashboard">
      <StatusCard status={status} now={now} />

      <section className="card">
        <div className="actions">
          <button type="button" className="btn" disabled={busy} onClick={() => void control(paused ? 'resume' : 'pause')}>
            {paused ? <IconPlay size={14} /> : <IconPause size={14} />}
            {paused ? '恢复监控' : '暂停监控'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || paused}
            title={paused ? '已暂停：先恢复监控' : '忽略等待，立即补一轮轮询'}
            onClick={() => void control('runNow')}
          >
            <IconRefresh size={14} />
            立即轮询
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void sendTest()}>
            <IconSend size={14} />
            发送测试通知
          </button>
          {feedback != null && <span className={`feedback ${feedback.kind}`}>{feedback.text}</span>}
        </div>
      </section>

      <HitList hits={hits} />
      <LogView logs={logs} />
    </div>
  )
}
