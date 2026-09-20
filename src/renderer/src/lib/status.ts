/**
 * UI 展示态派生：优先级与 shared/ipc.ts 的 deriveTrayLabel 完全一致——
 * desired 优先（用户意图覆盖观测），其次 challenged → backoff → 运行中。
 * pause 后 nextPollAt 保留旧值属内核已知行为，展示一律走本派生而非读 nextPollAt。
 */
import type { EngineStatus, MatchMode, SourceStatus } from '@shared/types'

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

/**
 * 来源 id → 展示名：全应用唯一映射（R10 阶段 2 升级为单源，REDESIGN §6.7 /
 * audit #9——去向 / 历史命中 / 监控台状态卡与命中行共用；设置路由下拉阶段 5 接入）。
 * 内置 id 全集与 lib/presets.ts 的来源预设对齐；用户自建 RSS 来源（任意 slug）
 * 无内置映射，原样展示 id。
 */
const SOURCE_LABELS: Record<string, string> = {
  nodeseek: 'NodeSeek',
  v2ex: 'V2EX',
  'linux-do': 'Linux.do',
  lowendtalk: 'LowEndTalk'
}

export function sourceLabel(id: string): string {
  return SOURCE_LABELS[id] ?? id
}

/** 匹配模式 → 中文徽标文案 */
export function matchModeLabel(mode: MatchMode): string {
  if (mode === 'semantic') return '语义'
  if (mode === 'both') return '叠加'
  return '字面'
}

/** 来源健康 → 语气 key（与 tone-* CSS 类对应） */
export function sourceToneKey(s: SourceStatus): 'ok' | 'backoff' | 'challenged' {
  return s.health
}
