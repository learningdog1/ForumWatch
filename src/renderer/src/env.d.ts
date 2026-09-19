/// <reference types="vite/client" />

/**
 * window.api 类型声明（给渲染进程 UI 用）。
 * 形状单一事实源：src/shared/ipc.ts 的 DesktopApi（IPC 通道契约同文件）。
 * 使用约定见该文件头注释；特别注意 pause 后 nextPollAt 保留旧值，
 * UI 按 desired=paused 派生展示。
 */
import type { DesktopApi } from '../../shared/ipc'

declare global {
  interface Window {
    /** preload（contextIsolation）暴露的白名单 API */
    api: DesktopApi
  }
}

export {}
