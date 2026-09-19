/**
 * UI 展示态派生：优先级与 shared/ipc.ts 的 deriveTrayLabel 完全一致——
 * desired 优先（用户意图覆盖观测），其次 challenged → backoff → 运行中。
 * pause 后 nextPollAt 保留旧值属内核已知行为，展示一律走本派生而非读 nextPollAt。
 */
import type { EngineStatus } from '@shared/types'

export type RunStateKey = 'paused' | 'challenged' | 'backoff' | 'running'

export interface RunState {
  key: RunStateKey
  label: string
}

export function deriveRunState(s: EngineStatus): RunState {
  if (s.desired === 'paused') return { key: 'paused', label: '已暂停' }
  if (s.health === 'challenged') return { key: 'challenged', label: 'Cloudflare 拦截' }
  if (s.health === 'backoff') return { key: 'backoff', label: '退避重试中' }
  return { key: 'running', label: '运行中' }
}
