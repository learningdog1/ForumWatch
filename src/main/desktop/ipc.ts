/**
 * 主进程侧 IPC（契约见 src/shared/ipc.ts）：
 * - createBroadcaster：主→渲染事件推送（evStatus / evHit / evLog / evDailyReport），
 *   面向所有存活 webContents 广播，destroyed 的窗口跳过；日志逐条推（内核日志低频，
 *   每轮轮询 1-2 条，无需批量节流），历史用 logs:get 拉全量。
 * - registerIpcHandlers：invoke handler 注册（getConfig / saveConfig / getStatus /
 *   getHits / getLogs / engineControl / openExternal / testAiProvider /
 *   getDailyReport / generateDailyReport / listDailyReports），失败一律收敛为返回值，
 *   绝不向渲染进程抛异常。
 * - AI / 日报通道（W2-c 接入）：testAiProvider 走 provider.testConnection（错误
 *   消息已脱敏，无 apiKey 明文）；getDailyReport/loadReport/list 走
 *   DailyReportService 的文件查询；generateDailyReport 是**手动生成**——跳过
 *   desired 与 attempts 检查、直接覆盖重生成（推送条件在 generate 内部）。
 */
import { BrowserWindow, ipcMain, shell } from 'electron'
import {
  IPC,
  type AiTestResult,
  type DailyReportListResult,
  type EngineControlResult,
  type OpenExternalResult,
  type SaveConfigResult
} from '../../shared/ipc'
import type {
  AppConfig,
  DailyReportInfo,
  EngineStatus,
  HitRecord,
  LogEntry
} from '../../shared/types'
import type { DesktopRuntime } from './runtime'
import { allowedExternalDomains, isHostAllowed } from '../monitor/sources/registry'
import { formatLocalDate } from '../monitor/hits-store'

/** 主→渲染事件推送接口（runtime 把 engine onStatus/onHit / 日报广播转发给它） */
export interface EventBroadcaster {
  status(s: EngineStatus): void
  hit(h: HitRecord): void
  log(e: LogEntry): void
  /** 日报生成完成时推送（DailyReportInfo） */
  report(r: DailyReportInfo): void
}

export function createBroadcaster(): EventBroadcaster {
  const broadcast = (channel: string, payload: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      // 跳过已销毁/已崩溃的窗口（关窗进托盘后可能销毁重建）；
      // send 也包一层 catch——退出时序里 render frame 先于窗口销毁的极端情况
      // 只丢一次推送，不向上冒泡打断 engine 回调链。
      if (win.isDestroyed()) continue
      const wc = win.webContents
      if (wc.isDestroyed() || wc.isCrashed()) continue
      try {
        wc.send(channel, payload)
      } catch {
        /* render frame disposed：跳过该窗口 */
      }
    }
  }
  return {
    status: (s) => broadcast(IPC.evStatus, s),
    hit: (h) => broadcast(IPC.evHit, h),
    log: (e) => broadcast(IPC.evLog, e),
    report: (r) => broadcast(IPC.evDailyReport, r)
  }
}

/**
 * 注册全部 invoke handler 与日志事件流。在 runtime 初始化之后、窗口创建之前调用。
 */
export function registerIpcHandlers(rt: DesktopRuntime, bc: EventBroadcaster): void {
  // 日志事件流：新条目实时推（渲染进程启动时用 getLogs 拉内存环形的全量）
  rt.logger.onLog((entry) => bc.log(entry))

  ipcMain.handle(IPC.getConfig, () => rt.store.get())

  // store.update（浅合并 + sanitize + 原子落盘）——渲染端漏字段时按合并语义
  // 保留现有值，不会意外清空关键词等未提交字段；写盘失败向上抛 → catch 转 {ok:false}
  ipcMain.handle(IPC.saveConfig, (_event, cfg: unknown): SaveConfigResult => {
    try {
      const effective = rt.store.update(cfg as Partial<AppConfig>)
      rt.applyConfigSideEffects(effective)
      return { ok: true, config: effective }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.getStatus, () => rt.engine.getStatus())
  ipcMain.handle(IPC.getHits, () => rt.engine.getRecentHits())
  ipcMain.handle(IPC.getLogs, () => rt.logger.getRecent())

  /**
   * engine:control —— pause 语义（内核上游约定，UI 必读）：
   * - pause 只改 desired，不动 health；
   * - pause 后 nextPollAt 保留旧值（排程器已停但字段不清空），UI 应按
   *   desired=paused 派生展示（忽略 nextPollAt）；
   * - runNow 在 paused 时是 no-op（内核尊重 desired）；
   * - sendTest 异常（TelegramError）在这里 catch 回传 {ok:false, error}。
   */
  ipcMain.handle(IPC.engineControl, async (_event, cmd: unknown): Promise<EngineControlResult> => {
    if (cmd !== 'pause' && cmd !== 'resume' && cmd !== 'runNow' && cmd !== 'sendTest') {
      return { ok: false, error: `unknown command: ${String(cmd)}` }
    }
    try {
      switch (cmd) {
        case 'pause':
          rt.engine.pause()
          break
        case 'resume':
          rt.engine.resume()
          break
        case 'runNow':
          rt.engine.runNow()
          break
        case 'sendTest':
          await rt.engine.sendTestNotification()
          break
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // 仅放行 https 且 host 为已配置（enabled）来源的域或其子域；白名单按
  // config.sources 派生（v2：nodeseek → nodeseek.com；见 monitor/sources/registry）
  ipcMain.handle(IPC.openExternal, async (_event, url: unknown): Promise<OpenExternalResult> => {
    if (typeof url !== 'string') return { ok: false }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { ok: false }
    }
    if (parsed.protocol !== 'https:') return { ok: false }
    if (!isHostAllowed(parsed.hostname, allowedExternalDomains(rt.store.get()))) {
      return { ok: false }
    }
    try {
      await shell.openExternal(parsed.toString())
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })

  // ---- AI / 日报（W2-c 真实实现） -----------------------------------------

  /** invoke() → AiTestResult：最小对话验证 Provider；错误消息 provider 已脱敏 */
  ipcMain.handle(IPC.testAiProvider, async (): Promise<AiTestResult> => {
    try {
      await rt.aiProvider.testConnection()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /** invoke(dateLocal?) → DailyReportInfo：缺省取今天（本地时区），无日报则 markdown:null */
  ipcMain.handle(
    IPC.getDailyReport,
    async (_event, dateLocal?: unknown): Promise<DailyReportInfo> => {
      const date =
        typeof dateLocal === 'string' && dateLocal !== '' ? dateLocal : formatLocalDate()
      return { date, markdown: await rt.reportService.loadReport(date) }
    }
  )

  /**
   * invoke() → EngineControlResult：手动生成本日日报。跳过 desired 与 attempts
   * 检查、覆盖重生成（generate 直接 writeFile 覆盖）；推送条件同 generate 内部
   * （enabled × telegram 配置 × notifyEnabled）。onGenerated 广播由 reportService
   * 构造时的回调发出（broadcaster.report）。
   */
  ipcMain.handle(IPC.generateDailyReport, async (): Promise<EngineControlResult> => {
    try {
      await rt.reportService.generate()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /** invoke() → { dates: string[] }：已有日报的日期列表（新→旧，读 reports/ 目录） */
  ipcMain.handle(IPC.listDailyReports, (): DailyReportListResult => ({
    dates: rt.reportService.listReportDays()
  }))
}
