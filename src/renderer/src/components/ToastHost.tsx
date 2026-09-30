/**
 * 全局 Toast 宿主（Watchtower 步骤 E；概念稿 §3.11 + JS :623-624）。
 * - App 根部挂载一次；消费 lib/toast 订阅流，业务侧只调 showToast()。
 * - 每条生命周期：入场滑入（overlays.css toast-in）→ 停留 2600ms → 加
 *   .out 淡出 380ms → 移除。相同消息不去重，纵向堆叠。
 * - 无障碍：每条 role="status" + aria-live="polite"（Chromium 对整节点
 *   插入的 status 区域会播报；wrap 容器不设活动区，避免堆叠时重复播报）。
 * - prefers-reduced-motion：base.css 全局熔断（0.01ms 技术）把入场/淡出
 *   变为瞬时，JS 计时不变——退场等待期元素已不可见，观感即「瞬时出现/消失」。
 * - 计时器每条自持（useEffect 清理），宿主卸载即全部中止，无悬挂 setState。
 */
import { useCallback, useEffect, useState } from 'react'
import { subscribeToast } from '../lib/toast'

interface ToastItem {
  id: number
  message: string
}

/** 自增序号（模块级，跨多次订阅周期不复用也无妨——只作 React key） */
let seq = 0

/** 单条 toast：挂载即起表，卸载即清表（deps 稳定，新 toast 入列不会重启旧计时） */
function ToastEntry({ item, onRemove }: { item: ToastItem; onRemove: (id: number) => void }) {
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    const hide = window.setTimeout(() => setLeaving(true), 2600)
    const remove = window.setTimeout(() => onRemove(item.id), 2600 + 380)
    return () => {
      window.clearTimeout(hide)
      window.clearTimeout(remove)
    }
  }, [item.id, onRemove])

  return (
    <div className={leaving ? 'toast out' : 'toast'} role="status" aria-live="polite">
      {item.message}
    </div>
  )
}

/** Toast 宿主：挂载一次（App.tsx 根部渲染）；样式全在 styles/overlays.css */
export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([])

  useEffect(
    () =>
      subscribeToast((message) => {
        setItems((prev) => [...prev, { id: ++seq, message }])
      }),
    []
  )

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((it) => it.id !== id))
  }, [])

  return (
    <div className="toast-wrap">
      {items.map((item) => (
        <ToastEntry key={item.id} item={item} onRemove={remove} />
      ))}
    </div>
  )
}
