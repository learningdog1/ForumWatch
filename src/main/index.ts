/**
 * 主进程入口（桌面装配层）。
 *
 * 职责（ADR 2：内核零 electron 依赖，本文件只做生命周期胶水）：
 * - 单实例锁（ADR 8.4）：抢不到锁直接退出；second-instance 唤起主窗口。
 * - mac 隐藏 Dock 图标（ADR 8.3，托盘常驻形态）。
 * - whenReady 装配顺序：钉死浅色（R12）→ userData 迁移（D1）→ broadcaster → runtime →
 *   IPC handler → 主窗口 → 托盘 → 电源钩子 → runtime.startup()（launch 即开始监控）。
 * - window-all-closed 不退出（托盘常驻，win 也是；退出走托盘菜单 / Cmd+Q）。
 * - 退出路径统一：before-quit 置 quitting 标志 + 异步 runtime.shutdown()，
 *   完成后再次 app.quit() 放行——shutdown 恰发生在 before-quit 与 will-quit 之间。
 * - 进程级兜底：uncaughtException / unhandledRejection 只记日志，
 *   不让内核异常弹原生崩溃框。
 */
import { app, nativeTheme } from 'electron'
import { join } from 'node:path'
import { createBroadcaster, registerIpcHandlers } from './desktop/ipc'
import { migrateUserDataFiles } from './desktop/migrate'
import { attachPowerHooks } from './desktop/power'
import { initRuntime } from './desktop/runtime'
import type { DesktopRuntime } from './desktop/runtime'
import { createTray, destroyTray } from './desktop/tray'
import { createMainWindow, setQuitting, showMainWindow } from './desktop/window'
import type { Logger } from './logger'

// runtime 就绪前用 console 兜底，就绪后写结构化日志
let loggerRef: Logger | null = null
let runtimeRef: DesktopRuntime | null = null

/**
 * userData 首启迁移（D1：NodeSeek Monitor → ForumWatch）。
 * appData 在三平台都是 userData 的父目录，旧目录即 `appData/NodeSeek Monitor`。
 * 必须在 initRuntime 之前执行（runtime 构造即读 userData 下的文件）；
 * 此时 logger 尚未初始化，内部用 console 记录。任何失败只 warn，绝不删旧目录。
 */
function migrateLegacyUserData(): void {
  migrateUserDataFiles({
    legacyDir: join(app.getPath('appData'), 'NodeSeek Monitor'),
    targetDir: app.getPath('userData')
  })
}

function describeError(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err)
}

// 进程级兜底：异常只记日志（logger 可能尚未初始化），不弹崩溃框
process.on('uncaughtException', (err) => {
  const sink = loggerRef ?? console
  sink.error(`uncaughtException: ${describeError(err)}`)
})
process.on('unhandledRejection', (reason) => {
  const sink = loggerRef ?? console
  sink.error(`unhandledRejection: ${describeError(reason)}`)
})

// R12.7：关掉 Chromium 自动反色（auto-dark/force-dark）。固定浅色交付后,若内核仍把
// 浅色页面按系统暗色反相渲染,会出现「钉了浅色仍是黑」的症状；显式禁用该 blink 特性。
app.commandLine.appendSwitch('disable-blink-features', 'WebContentsForceDark')

const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  // 已有实例在跑：立即退出（ADR 8.4 单实例）
  app.quit()
} else {
  // 二次启动：唤起已有实例的主窗口。second-instance 可能早于 whenReady 到达
  // （此时 runtime/窗口尚未装配），非 ready 一律排队到 ready 之后再显示。
  app.on('second-instance', () => {
    if (app.isReady()) showMainWindow()
    else void app.whenReady().then(() => showMainWindow())
  })

  if (process.platform === 'darwin') {
    // ADR 8.3：托盘常驻形态隐藏 Dock 图标——不进 Cmd+Tab / Dock 是预期行为，
    // 应用主入口在托盘（菜单或点击）。
    app.dock?.hide()
  }

  // mac activate（Dock 点击 / 系统重激活）重开主窗口
  app.on('activate', () => showMainWindow())

  // 关窗语义在 window.ts（preventDefault + hide 进托盘），这里全部窗口关闭
  // 后**不退出**：托盘常驻，win 上同样常驻；退出只走托盘菜单 / before-quit 路径。
  app.on('window-all-closed', () => {
    /* 有意 no-op */
  })

  // 退出路径统一：第一次 before-quit preventDefault 并异步 shutdown
  // （engine.pause → seen flush → clients close → logger close），
  // 完成后 destroyTray + 再次 app.quit() 放行——即 shutdown 发生在
  // before-quit 与 will-quit 之间；第二次进入时 quitFlow 非空，直接放行。
  let quitFlow: Promise<void> | null = null
  app.on('before-quit', (event) => {
    setQuitting(true) // 关闭中的窗口不再 preventDefault（ADR 8.4）
    const rt = runtimeRef
    if (rt === null || quitFlow !== null) return
    event.preventDefault()
    quitFlow = rt
      .shutdown()
      .catch((err) => {
        console.error(`[quit] shutdown failed: ${describeError(err)}`)
      })
      .then(() => {
        destroyTray()
        app.quit()
      })
  })

  void app.whenReady().then(() => {
    // R12.7：界面固定浅色（「霁蓝平台」以浅色为唯一交付面）。CSS 层已把暗档
    // 覆盖块停用为主防线；此处同时钉住原生面（菜单/通知等走 AppKit 外观）。
    // 解除钉死：themeSource 改回 'system' 且恢复渲染层三处 @media 原样。
    nativeTheme.themeSource = 'light'
    migrateLegacyUserData() // D1：更名首启迁移，先于一切 userData 读取
    const broadcaster = createBroadcaster()
    const runtime = initRuntime(broadcaster)
    runtimeRef = runtime
    loggerRef = runtime.logger

    registerIpcHandlers(runtime, broadcaster)
    createMainWindow()
    createTray(runtime)
    attachPowerHooks(runtime)
    runtime.startup()
  })
}
