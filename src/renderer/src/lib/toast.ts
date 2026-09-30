/**
 * 全局 Toast 发布订阅（Watchtower 步骤 E；概念稿 §3.11 形制的 JS 半边）。
 *
 * 模块契约：
 * - showToast(message)   任意模块调用，向当前订阅者广播一条 toast。多次相同
 *                        消息各自入列（不去重、不限流——语义去重是调用方的事）。
 * - subscribeToast(cb)   订阅 toast 流；返回退订函数。渲染端由 <ToastHost/>
 *                        （App 根部挂载一次）长期持有，业务侧只管 showToast。
 *
 * 行为细则：
 * 1. 模块级 Set 发布订阅，无 React context（本仓库既定风格，同款手法见
 *    lib/theme.ts 的 onThemeChange）；ToastHost 未挂载时消息静默丢弃
 *    （web-shim 无头模式 / 测试环境不炸、不堆积）。
 * 2. 模块顶层零副作用（只建一个空 Set），浏览器模式与 Electron 两用，
 *    禁 import Electron/Node 模块。
 * 3. 消息是纯字符串：调用方拼好文案再进来（与 ErrorBar 的 message 口径
 *    一致），本模块不做富文本 / 不带语义档位（成功失败同一形制，概念稿
 *    toast 本就单形制）。
 */
export type ToastListener = (message: string) => void

const listeners = new Set<ToastListener>()

/** 广播一条 toast；重复消息不去重，按调用次数各自入列 */
export function showToast(message: string): void {
  for (const notify of listeners) notify(message)
}

/** 订阅 toast 流；返回退订函数（ToastHost 卸载时调用） */
export function subscribeToast(cb: ToastListener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
