/**
 * 统一的 IPC 数据源 hook（契约见 src/shared/ipc.ts）：
 * - 挂载时 invoke 拉全量（getStatus / getHits / getLogs），事件（onStatus /
 *   onHit / onLog）只做增量；卸载时全部退订。
 * - hits 状态序为新→旧（内核环形是旧→新，拉全量时反转，事件增量前插），
 *   HitList 直接从头渲染即"新条目从顶部插入"。
 * - logs 保持旧→新（LogView 自动滚底需要自然时间序），UI 侧截最近 200 条。
 * - R10「错误是一等公民」：三个数据面的启动拉取失败不再静默吞掉，暴露为
 *   errors.{status,hits,logs}；订阅事件到达即自动清除对应错误（恢复信号），
 *   retry() 重新触发全量拉取（ErrorBar 的重试按钮用）。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  INITIAL_ENGINE_STATUS,
  type EngineStatus,
  type HitRecord,
  type LogEntry
} from '@shared/types'

const MAX_HITS = 200
/** 日志 UI 侧截留量（R10 对齐 ia §5.1 的 500 环骨架口径，dashboard.md §3.4） */
const MAX_LOGS = 500

export interface ApiErrors {
  /** 状态面启动拉取失败的原因；null=正常 */
  status: string | null
  /** 命中面启动拉取失败的原因；null=正常 */
  hits: string | null
  /** 日志面启动拉取失败的原因；null=正常 */
  logs: string | null
}

export interface ApiState {
  status: EngineStatus
  /** 新→旧 */
  hits: HitRecord[]
  /** 旧→新 */
  logs: LogEntry[]
  /** 各数据面错误态（REDESIGN §6.3：失败 ≠ 空） */
  errors: ApiErrors
  /** 重新拉取全量（ErrorBar 重试） */
  retry: () => void
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function useApi(): ApiState {
  const [status, setStatus] = useState<EngineStatus>(INITIAL_ENGINE_STATUS)
  const [hits, setHits] = useState<HitRecord[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [errors, setErrors] = useState<ApiErrors>({ status: null, hits: null, logs: null })
  // retry 计数：变化即重跑启动全量
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false

    // 启动全量：失败记入对应错误面（不静默吞掉）；成功清除
    void window.api
      .getStatus()
      .then((s) => {
        if (cancelled) return
        setStatus(s)
        setErrors((p) => (p.status ? { ...p, status: null } : p))
      })
      .catch((e: unknown) => {
        if (!cancelled) setErrors((p) => ({ ...p, status: errText(e) }))
      })
    void window.api
      .getHits()
      .then((list) => {
        if (cancelled) return
        setHits(list.slice(-MAX_HITS).reverse())
        setErrors((p) => (p.hits ? { ...p, hits: null } : p))
      })
      .catch((e: unknown) => {
        if (!cancelled) setErrors((p) => ({ ...p, hits: errText(e) }))
      })
    void window.api
      .getLogs()
      .then((list) => {
        if (cancelled) return
        setLogs(list.slice(-MAX_LOGS))
        setErrors((p) => (p.logs ? { ...p, logs: null } : p))
      })
      .catch((e: unknown) => {
        if (!cancelled) setErrors((p) => ({ ...p, logs: errText(e) }))
      })

    // 增量订阅：事件到达视为通道恢复，顺带清错
    const offStatus = window.api.onStatus((s) => {
      setStatus(s)
      setErrors((p) => (p.status ? { ...p, status: null } : p))
    })
    const offHit = window.api.onHit((h) => {
      setHits((prev) => [h, ...prev].slice(0, MAX_HITS))
      setErrors((p) => (p.hits ? { ...p, hits: null } : p))
    })
    const offLog = window.api.onLog((e) => {
      setLogs((prev) =>
        prev.length >= MAX_LOGS ? [...prev.slice(prev.length - MAX_LOGS + 1), e] : [...prev, e]
      )
      setErrors((p) => (p.logs ? { ...p, logs: null } : p))
    })

    return () => {
      cancelled = true
      offStatus()
      offHit()
      offLog()
    }
  }, [nonce])

  const retry = useCallback(() => setNonce((n) => n + 1), [])

  return { status, hits, logs, errors, retry }
}
