/**
 * 全局命中详情抽屉 store（Watchtower 步骤 I；手法对齐 lib/toast.ts 的模块级
 * 发布订阅——无 React context，本仓库既定风格）。
 *
 * 模块契约：
 * - openDrawer(hit)      任意模块调用（HitRow feed/table 变体的行点击等），向
 *                        当前订阅者广播打开的 HitRecord；顺带记录触发元素
 *                        （closeDrawer 时还原焦点）。
 * - closeDrawer()        关闭（向订阅者广播一次 null）并尽力还原焦点到触发
 *                        元素；已关闭时 no-op（不重复广播、不动焦点）。
 * - subscribeDrawer(cb)  订阅开关流；返回退订函数。宿主 <HitDetailDrawer/>
 *                        （App 根部挂载一次，同 ToastHost 位）长期持有，
 *                        业务侧只管 openDrawer / closeDrawer。
 * - drawerHit()          读当前打开的记录（null = 关闭）。宿主初始态经它对齐
 *                        ——宿主晚于首次 openDrawer 挂载时不丢打开态。
 *
 * 行为细则：
 * 1. 模块级单值 + Set 发布订阅；宿主未挂载时打开态静默保留在 store（挂载后
 *    经 drawerHit() 对齐），不炸不堆积（web-shim 无头模式 / 测试环境安全）。
 * 2. 模块顶层零副作用（只建一个空 Set 与两个 null），浏览器与 Electron 两用，
 *    禁 import Electron/Node 模块。
 * 3. 焦点还原是尽力而为：打开时记录 document.activeElement（焦点落在抽屉
 *    自身内部则保留上一触发元素）；关闭时该元素仍挂在文档上（isConnected）
 *    才 focus()，已随列表重渲染卸载则跳过。
 */
import type { HitRecord } from '@shared/types'

export type DrawerListener = (hit: HitRecord | null) => void

const listeners = new Set<DrawerListener>()

/** 当前打开的命中记录；null = 关闭 */
let current: HitRecord | null = null

/** 打开抽屉时的触发元素（关闭还原焦点用） */
let opener: HTMLElement | null = null

/** 打开命中详情抽屉（已开时换目标：等效「切到另一条」） */
export function openDrawer(hit: HitRecord): void {
  if (typeof document !== 'undefined') {
    const el = document.activeElement
    // 焦点在抽屉内部（宿主打开时自动聚焦抽屉面板）则不覆盖原触发元素
    if (el instanceof HTMLElement && el.closest('.drawer') === null) opener = el
  }
  current = hit
  for (const notify of listeners) notify(current)
}

/** 关闭抽屉并还原焦点到触发元素（若可追且仍在文档上）；已关闭时 no-op */
export function closeDrawer(): void {
  if (current === null) return
  current = null
  for (const notify of listeners) notify(null)
  const el = opener
  opener = null
  if (el != null && el.isConnected) el.focus()
}

/** 读当前打开的命中记录（null = 关闭） */
export function drawerHit(): HitRecord | null {
  return current
}

/** 订阅抽屉开关流；返回退订函数（宿主卸载时调用） */
export function subscribeDrawer(cb: DrawerListener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
