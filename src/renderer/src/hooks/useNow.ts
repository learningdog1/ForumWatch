/**
 * 跳动的当前时刻（默认每秒）：驱动"38 秒后"这类相对时间每秒重算。
 * R10 挂机降负（两级）：
 * - 窗口隐藏（进托盘）时停跳；恢复可见立即刷新一次；
 * - keep-alive 页级隐藏（active=false，元素 display:none 不派发事件）由
 *   消费方把自身 active 态传入 paused——停跳即停掉隐藏页每秒一次的重渲染。
 */
import { useEffect, useState } from 'react'

export function useNow(intervalMs = 1000, paused = false): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = (): void => {
      if (document.hidden || paused) return
      setNow(Date.now())
    }
    const onVisibility = (): void => {
      if (!document.hidden && !paused) setNow(Date.now())
    }
    const id = window.setInterval(tick, intervalMs)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [intervalMs, paused])
  return now
}
