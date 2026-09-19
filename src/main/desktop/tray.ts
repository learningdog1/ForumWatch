/**
 * 托盘（ADR 8.3 / 8.4）：常驻形态的主入口。
 * - 图标 resources/icons/tray.png：同目录 tray@2x.png 由 Electron 按 DPI 自动取。
 *   Template 命名才跟随深浅色——本应用用彩色图标，接受不跟随（ADR 8.3）。
 * - tooltip 与"暂停/恢复"菜单文案由 (desired, health) 派生（deriveTrayLabel），
 *   每次 engine onStatus 后 rebuild setContextMenu。
 * - mac 点击托盘 = 切换主窗口显隐。
 * - powerMonitor resume 后重设一次图标（社区已知的唤醒后托盘图标消失 bug 兜底）。
 */
import { app, dialog, Menu, nativeImage, powerMonitor, shell, Tray } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { deriveTrayLabel } from '../../shared/ipc'
import type { EngineStatus } from '../../shared/types'
import type { DesktopRuntime } from './runtime'
import { resolveResource } from './resources'
import { getMainWindow, showMainWindow } from './window'

let tray: Tray | null = null
let iconPath = ''
let currentStatus: EngineStatus | null = null

export function createTray(rt: DesktopRuntime): Tray {
  iconPath = resolveResource('icons/tray.png')
  const icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) rt.logger.warn(`tray icon missing or empty: ${iconPath}`)

  tray = new Tray(icon)
  currentStatus = rt.engine.getStatus()
  tray.setToolTip(deriveTrayLabel(currentStatus))
  rebuildMenu(rt)

  // mac：点击托盘图标切换主窗口显隐（win 上左键默认弹菜单，click 也触发，行为无害）
  tray.on('click', () => toggleMainWindow())

  // ADR 8.3：唤醒后托盘图标可能消失，resume 时重设一次兜底
  powerMonitor.on('resume', () => {
    if (tray !== null && !tray.isDestroyed()) {
      tray.setImage(nativeImage.createFromPath(iconPath))
    }
  })

  // 订阅 engine 状态 → 更新 tooltip 与菜单文案（主进程是唯一事实源，ADR 2）
  rt.onStatus((status) => {
    currentStatus = status
    if (tray === null || tray.isDestroyed()) return
    tray.setToolTip(deriveTrayLabel(status))
    rebuildMenu(rt)
  })

  return tray
}

/** 退出前销毁托盘，避免残留幽灵图标 */
export function destroyTray(): void {
  if (tray !== null) {
    tray.destroy()
    tray = null
  }
}

// ---- 内部实现 ------------------------------------------------------------

function toggleMainWindow(): void {
  const win = getMainWindow()
  if (win === null || win.isDestroyed()) {
    showMainWindow()
    return
  }
  if (win.isVisible() && win.isFocused()) win.hide()
  else showMainWindow()
}

function rebuildMenu(rt: DesktopRuntime): void {
  if (tray === null || tray.isDestroyed()) return
  tray.setContextMenu(buildMenu(rt))
}

function buildMenu(rt: DesktopRuntime): Menu {
  const paused = currentStatus?.desired === 'paused'
  const toggleItem: MenuItemConstructorOptions = paused
    ? { label: '恢复监控', click: () => rt.engine.resume() }
    : { label: '暂停监控', click: () => rt.engine.pause() }

  const template: MenuItemConstructorOptions[] = [
    { label: '显示主窗口', click: () => showMainWindow() },
    { type: 'separator' },
    toggleItem,
    // runNow 尊重 desired：暂停期间是 no-op（内核语义）
    { label: '立即轮询', click: () => rt.engine.runNow() },
    {
      label: '发送测试通知',
      click: () => {
        void rt.engine.sendTestNotification().catch((err) => {
          dialog.showErrorBox(
            '测试通知失败',
            err instanceof Error ? err.message : String(err)
          )
        })
      }
    },
    { type: 'separator' },
    { label: '在 Finder 中打开配置目录', click: () => void shell.openPath(rt.userDataDir) },
    { label: '退出', click: () => app.quit() }
  ]
  return Menu.buildFromTemplate(template)
}
