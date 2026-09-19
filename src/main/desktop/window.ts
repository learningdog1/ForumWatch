/**
 * 主窗口（ADR 8.4 关窗语义）：
 * - close 事件在非退出路径 preventDefault + hide（关窗进托盘，进程常驻）；
 *   退出路径由入口在 before-quit 置 quitting 标志后放行真正 close。
 * - 单例式管理：createMainWindow 幂等；showMainWindow 无则建、有则 show/focus。
 */
import { BrowserWindow } from 'electron'
import { join } from 'node:path'

let mainWindow: BrowserWindow | null = null
let quitting = false

/** 置退出标志：此后窗口 close 不再 preventDefault（由入口在 before-quit 调用） */
export function setQuitting(value: boolean): void {
  quitting = value
}

export function isQuitting(): boolean {
  return quitting
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/** 创建（或返回已有的）主窗口；幂等 */
export function createMainWindow(): BrowserWindow {
  if (mainWindow !== null && !mainWindow.isDestroyed()) return mainWindow

  const win = new BrowserWindow({
    width: 980,
    height: 700,
    title: 'ForumWatch',
    webPreferences: {
      // electron-vite 的 preload 产物是 CJS：sandbox 默认开启时沙箱 preload 白名单
      // 模块里就有 contextBridge / ipcRenderer，无需关 sandbox。
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // 防御：应用内一律不开新窗口（window.open / target=_blank 全部拒绝）；
  // 外链统一走 IPC openExternal 的 nodeseek.com 白名单
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // ADR 8.4：关窗进托盘（非退出路径）
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl).catch((err) => {
      console.error(`[window] loadURL ${devUrl} failed:`, err)
    })
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html')).catch((err) => {
      console.error('[window] loadFile renderer failed:', err)
    })
  }

  mainWindow = win
  return win
}

/** 显示并聚焦主窗口（无则创建）：托盘菜单 / activate / second-instance 共用入口 */
export function showMainWindow(): void {
  const win = createMainWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}
