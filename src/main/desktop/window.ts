/**
 * 主窗口（ADR 8.4 关窗语义；界面重构步骤 D 起 closeBehavior 可配）。
 * close 事件三态：
 * - 退出路径（quitting 标志已置，before-quit 置位）：放行真正 close；
 * - closeBehavior='tray'（默认，getCloseBehavior 缺省值）：preventDefault + hide
 *   （关窗进托盘，进程常驻）——ADR 8.4 老用户「不配置就是进托盘」行为不变；
 * - closeBehavior='quit'：放行 close 并 app.quit()。**放行之外必须主动 quit**：
 *   入口的 window-all-closed 是有意 no-op（托盘常驻形态），只放行会停在
 *   「无窗口 + 托盘」的僵死态——借 app.quit() 走 before-quit 统一退出路径
 *   （置 quitting → 异步 runtime.shutdown() → destroyTray → 二次 quit 放行）
 *   才是真实退出（以「真实退出」为准的步骤 D 修正，见 index.ts before-quit）。
 * - 单例式管理：createMainWindow 幂等；showMainWindow 无则建、有则 show/focus。
 * - 窗口 chrome（瞭望塔重设计规格）：设计宽 1360×860、最小 1150×620
 *   （design/redesign/watchtower/concept.html 的 .window min-width 1150 /
 *   设计宽 1360；替换 R10 桌面断点 980×700 / 960×560）。darwin 用
 *   titleBarStyle:'hiddenInset'——红绿灯原生保留、浮在自绘标题栏上；
 *   win/linux 不动 frame，保留原生边框与系统标题栏。
 */
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { AppConfig } from '../../shared/types'

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

/** 已注入的关窗行为访问器：showMainWindow() 重建窗口时不再丢配置
 *  （quit 关窗后 shutdown 窗口期内托盘/二次启动重建的窗口曾回退默认 'tray'） */
let closeBehaviorOf: () => AppConfig['closeBehavior'] = () => 'tray'

/**
 * 创建（或返回已有的）主窗口；幂等。
 * @param opts.getCloseBehavior 关窗行为访问器（步骤 D）：close 时现读 store
 *   （配置热更新，改 closeBehavior 无需重建窗口）；缺省恒 'tray'——未注入方
 *   （测试台 / 早期调用点）与 ADR 8.4 既有语义逐字节等价。
 */
export function createMainWindow(
  opts: { getCloseBehavior?: () => AppConfig['closeBehavior'] } = {}
): BrowserWindow {
  if (mainWindow !== null && !mainWindow.isDestroyed()) return mainWindow
  if (opts.getCloseBehavior != null) closeBehaviorOf = opts.getCloseBehavior
  const getCloseBehavior = closeBehaviorOf

  // 瞭望塔重设计窗口规格（见文件头注释）
  const options: Electron.BrowserWindowConstructorOptions = {
    width: 1360,
    height: 860,
    minWidth: 1150,
    minHeight: 620,
    title: 'ForumWatch',
    webPreferences: {
      // electron-vite 的 preload 产物是 CJS：sandbox 默认开启时沙箱 preload 白名单
      // 模块里就有 contextBridge / ipcRenderer，无需关 sandbox。
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  }
  if (process.platform === 'darwin') {
    // darwin：自绘标题栏但保留原生红绿灯（hiddenInset = 按钮浮在内容上）；
    // win/linux 不动 frame——保留原生边框与系统标题栏
    options.titleBarStyle = 'hiddenInset'
  }

  const win = new BrowserWindow(options)

  // 防御：应用内一律不开新窗口（window.open / target=_blank 全部拒绝）；
  // 外链统一走 IPC openExternal 的 nodeseek.com 白名单
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // ADR 8.4 关窗语义（步骤 D 起可配，三态见文件头）：
  // quitting（before-quit 置位）→ 放行；'quit' → 放行 + app.quit()（只放行
  // 会因 window-all-closed 的 no-op 僵在托盘态，必须走统一退出路径）；其余
  // （'tray'，默认）→ preventDefault + hide 进托盘。
  win.on('close', (event) => {
    if (quitting) return
    if (getCloseBehavior() === 'quit') {
      app.quit() // 不 preventDefault：close 照常完成，quit 流程接管善后
      return
    }
    event.preventDefault()
    win.hide()
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
