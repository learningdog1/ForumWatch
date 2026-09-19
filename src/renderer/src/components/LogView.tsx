/**
 * 运行日志：等宽滚动区，info 灰 / warn 橙 / error 红。
 * 自动跟随：贴底时新日志滚到底；用户上滚即暂停跟随（卡片头给出行内提示），
 * 重新滚回底部自动恢复。stick 真值放 ref（scroll 事件高频读写），
 * state 只用于渲染提示条。
 */
import { useEffect, useRef, useState } from 'react'
import type { LogEntry } from '@shared/types'
import { formatClock } from '../lib/time'
import { EmptyState } from './EmptyState'

const BOTTOM_TOLERANCE_PX = 10

export function LogView(props: { logs: LogEntry[] }) {
  const { logs } = props
  const boxRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)
  const [stick, setStick] = useState(true)

  useEffect(() => {
    const el = boxRef.current
    if (el != null && stickRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [logs])

  function handleScroll(): void {
    const el = boxRef.current
    if (el == null) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_TOLERANCE_PX
    if (atBottom !== stickRef.current) {
      stickRef.current = atBottom
      setStick(atBottom)
    }
  }

  return (
    <section className="card card-grow">
      <div className="card-head">
        <span className="card-title">运行日志</span>
        {stick ? (
          <span className="card-count">{logs.length > 0 ? `${logs.length} 条 · 自动跟随` : ''}</span>
        ) : (
          <span className="follow-paused">已暂停跟随 · 滚到底部恢复</span>
        )}
      </div>
      <div className="logview" ref={boxRef} onScroll={handleScroll}>
        {logs.length === 0 ? (
          <EmptyState title="暂无日志" hint="启动监控后，抓取与推送的运行记录会显示在这里" />
        ) : (
          logs.map((entry, i) => (
            <div className={`log-line ${entry.level}`} key={`${entry.ts}-${i}`}>
              <span className="t">{formatClock(entry.ts)}</span>
              {entry.msg}
            </div>
          ))
        )}
      </div>
    </section>
  )
}
