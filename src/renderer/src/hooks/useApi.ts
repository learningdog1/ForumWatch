/**
 * 统一的 IPC 数据源 hook（契约见 src/shared/ipc.ts）：
 * - 挂载时 invoke 拉全量（getStatus / getHits / getLogs），事件（onStatus /
 *   onHit / onLog）只做增量；卸载时全部退订。
 * - hits 状态序为新→旧（内核环形是旧→新，拉全量时反转，事件增量前插），
 *   HitList 直接从头渲染即"新条目从顶部插入"。
 * - logs 保持旧→新（LogView 自动滚底需要自然时间序），UI 侧截最近 200 条。
 */
import { useEffect, useState } from 'react'
import {
  INITIAL_ENGINE_STATUS,
  type EngineStatus,
  type HitRecord,
  type LogEntry
} from '@shared/types'

const MAX_HITS = 200
const MAX_LOGS = 200

export interface ApiState {
  status: EngineStatus
  /** 新→旧 */
  hits: HitRecord[]
  /** 旧→新 */
  logs: LogEntry[]
}

export function useApi(): ApiState {
  const [status, setStatus] = useState<EngineStatus>(INITIAL_ENGINE_STATUS)
  const [hits, setHits] = useState<HitRecord[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])

  useEffect(() => {
    let cancelled = false

    // 启动全量（invoke 不抛，但防窗口销毁时序问题仍 catch 静默）
    void window.api
      .getStatus()
      .then((s) => {
        if (!cancelled) setStatus(s)
      })
      .catch(() => {})
    void window.api
      .getHits()
      .then((list) => {
        if (!cancelled) setHits(list.slice(-MAX_HITS).reverse())
      })
      .catch(() => {})
    void window.api
      .getLogs()
      .then((list) => {
        if (!cancelled) setLogs(list.slice(-MAX_LOGS))
      })
      .catch(() => {})

    // 增量订阅
    const offStatus = window.api.onStatus((s) => setStatus(s))
    const offHit = window.api.onHit((h) =>
      setHits((prev) => [h, ...prev].slice(0, MAX_HITS))
    )
    const offLog = window.api.onLog((e) =>
      setLogs((prev) =>
        prev.length >= MAX_LOGS ? [...prev.slice(prev.length - MAX_LOGS + 1), e] : [...prev, e]
      )
    )

    return () => {
      cancelled = true
      offStatus()
      offHit()
      offLog()
    }
  }, [])

  return { status, hits, logs }
}
