/**
 * 监控台：状态卡（含来源/AI 状态与操作条）+ 最近命中列表 + 运行日志。
 * 数据全部来自 useApi（全量 + 增量）；按钮逻辑在本层，
 * 摆放与分级（danger/普通/主按钮）在 StatusCard 的 subactions。
 * R6-W4：状态卡下方补「挂起待推送」一行（status.pendingNotifyCount > 0 时显示
 * ——免打扰/摘要模式挂起队列的可观测性；StatusCard 组件不在本轮改动清单，
 * 暂以独立行呈现，数值随状态快照实时下发）。
 */
import { useState } from 'react'
import { HitList } from '../components/HitList'
import { LogView } from '../components/LogView'
import { StatusCard } from '../components/StatusCard'
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
      <StatusCard
        status={status}
        now={now}
        actions={{
          paused,
          busy,
          onPauseToggle: () => void control(paused ? 'resume' : 'pause'),
          onRunNow: () => void control('runNow'),
          onSendTest: () => void sendTest(),
          feedback
        }}
      />

      {(status.pendingNotifyCount ?? 0) > 0 && (
        <div
          className="notice muted-notice"
          title="免打扰时段内或摘要模式下挂起的命中：不入已读、暂不计数，免打扰窗尾 / 摘要到点后合并推送（重启丢弃，仍在首页的帖子会重新处理）"
        >
          ⏳ 挂起待推送: {status.pendingNotifyCount} 条
        </div>
      )}

      <HitList
        hits={hits}
        totalHits={status.totalHits}
        runNowDisabled={busy || paused}
        onRunNow={() => void control('runNow')}
      />
      <LogView logs={logs} />
    </div>
  )
}
