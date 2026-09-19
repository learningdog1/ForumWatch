/**
 * 桌面运行时装配（ADR 2：主进程只做装配，内核零 electron 依赖）。
 * 装配链对齐 scripts/headless.ts 的接线模板：
 *
 *   logger（userData/logs）→ ConfigStore → 三 HttpClient（按 proxyScope 路由：
 *   'telegram-only' → site/ai 恒直连、tg 走代理；'all' → 都带；aiClient 默认
 *   超时 30s，D6）→ HtmlSourceAdapter / TelegramNotifier → AiProvider /
 *   SemanticEvaluator / DailyReportService（reportsDir=<userData>/reports）→
 *   FileSeenStore / FileEngineState / HitsStore（<userData>/hits）→
 *   PollScheduler（onTick 绑 engine.pollOnce、onScheduled 绑 engine.noteScheduled，
 *   不绑则 nextPollAt 恒 null）→ MonitorEngine（deps 注入 evaluator + hitsStore）。
 *
 * 配置热更新：engine 每轮 pollOnce 调 getConfig()（→ store.get()），IPC saveConfig
 * 落盘后 store 内存值即换新；网络副作用由 applyConfigSideEffects 同步（三个
 * client 的 setProxy——仅代理值变化时调用，避免无谓中断在途请求——+ 开机自启）。
 *
 * 日报定时器（D5）：startup() 起一个自循环 setTimeout——每轮 sleep =
 * clamp(nextCheckAt - now, 60s, 30min)（下限保证跨天/补做及时，上限防休眠期
 * 漂移后空转密集唤醒）；到点调 reportSvc.tick(desired)。app quit（shutdown）
 * 清理。powerMonitor resume 时 onPowerResume() 补一轮 tick（睡眠跨过触发时刻
 * 的补偿路径，D5「启动/resume 时检查」）。
 *
 * 生命周期：startup() = engine.start()（launch 即开始监控，desired 默认 running）；
 * shutdown() 在 app 的 before-quit 与 will-quit 之间调用（退出路径统一走这里）：
 * engine.pause → 停日报定时器 → seen flush → clients close → logger close。
 */
import { app } from 'electron'
import { join } from 'node:path'
import { ConfigStore } from '../config/store'
import { createLogger, type Logger } from '../logger'
import { HttpClient, redactProxyUrl } from '../net/http'
import { AiProvider } from '../ai/provider'
import { SemanticEvaluator } from '../ai/evaluator'
import { DailyReportService } from '../ai/daily-report'
import { FileSeenStore } from '../monitor/dedup'
import { MonitorEngine } from '../monitor/engine'
import { HitsStore, HITS_DIR_NAME } from '../monitor/hits-store'
import { PollScheduler } from '../monitor/poller'
import { FileEngineState } from '../monitor/state'
import { HtmlSourceAdapter } from '../monitor/sources/html'
import type { SourceAdapter } from '../monitor/types'
import { TelegramNotifier } from '../notify/telegram'
import type { AppConfig, EngineStatus, HitRecord } from '../../shared/types'
import type { EventBroadcaster } from './ipc'

/** 日报定时器 sleep 下限：即使 nextCheckAt 很近也至少 60s 一查（防空转） */
const REPORT_TIMER_MIN_SLEEP_MS = 60_000
/** 日报定时器 sleep 上限：休眠漂移后最多 30min 兜底重查一次 */
const REPORT_TIMER_MAX_SLEEP_MS = 30 * 60_000

export class DesktopRuntime {
  /** userData 目录（config.json / seen.json / state.json / logs 都在其下） */
  readonly userDataDir: string
  readonly logger: Logger
  readonly store: ConfigStore
  readonly engine: MonitorEngine
  readonly aiProvider: AiProvider
  readonly reportService: DailyReportService
  private readonly siteClient: HttpClient
  private readonly tgClient: HttpClient
  private readonly aiClient: HttpClient
  private readonly seen: FileSeenStore
  private readonly statusListeners = new Set<(s: EngineStatus) => void>()
  private readonly hitListeners = new Set<(h: HitRecord) => void>()
  /** 上次已生效的代理（site/tg/ai），applyConfigSideEffects 据此只在变化时 setProxy */
  private lastSiteProxy: string | null = null
  private lastTgProxy: string | null = null
  private lastAiProxy: string | null = null
  /** 日报定时器句柄（startup 起、shutdown 清；自循环重排） */
  private reportTimer: ReturnType<typeof setTimeout> | null = null
  private shutdownStarted = false

  /** 由 initRuntime 创建（必须在 app.whenReady 之后）；不要直接 new */
  constructor(broadcaster: EventBroadcaster) {
    this.userDataDir = app.getPath('userData')
    this.logger = createLogger({ fileDir: join(this.userDataDir, 'logs') })

    this.store = new ConfigStore(join(this.userDataDir, 'config.json'))
    const initial = this.store.load()

    // 三 client（ADR 6 / D6 / headless 同款）：'telegram-only' → site/ai 直连、
    // tg 走代理；'all' → 都带。aiClient 默认超时 30s（日报/语义评估的 LLM 延迟）
    const siteProxy = initial.proxyScope === 'all' ? initial.proxyUrl : ''
    const aiProxy = siteProxy
    this.siteClient = createClientSafely(siteProxy, this.logger, 'site')
    this.tgClient = createClientSafely(initial.proxyUrl, this.logger, 'telegram')
    this.aiClient = createClientSafely(aiProxy, this.logger, 'ai', 30_000)
    // 构造参数即当前生效值：记录之，构造尾的 applyConfigSideEffects 不会重复 setProxy
    this.lastSiteProxy = siteProxy
    this.lastTgProxy = initial.proxyUrl
    this.lastAiProxy = aiProxy

    // adapter 注册表：source id → adapter（v2 仅 nodeseek；新增来源类型在此登记工厂）。
    // 固定单实例（无内部可变状态，fetchHtml 闭包引 siteClient）；getSources 每轮
    // 重读 config.sources 过滤 enabled——配置热更新即生效，不在构造期定死数组（D3）。
    const nodeseekAdapter = new HtmlSourceAdapter({
      fetchHtml: (url, init) => this.siteClient.get(url, init)
    })
    const adapters = new Map<string, SourceAdapter>([[nodeseekAdapter.id, nodeseekAdapter]])
    const getSources = (): SourceAdapter[] => {
      const out: SourceAdapter[] = []
      for (const s of this.store.get().sources) {
        if (!s.enabled) continue
        const adapter = adapters.get(s.id)
        if (adapter === undefined) {
          this.logger.warn(`no adapter registered for source "${s.id}", skipping`)
          continue
        }
        out.push(adapter)
      }
      return out
    }
    const notifier = new TelegramNotifier({
      post: (url, init) => this.tgClient.post(url, init),
      getConfig: () => this.store.get().telegram
    })

    // AI 装配（D4/D6）：provider 每次调用重读 store（热更新）；evaluator 批式评估；
    // 日报服务读 hits JSONL、写 <userData>/reports、推送走 sendRaw、广播给渲染端
    this.aiProvider = new AiProvider({
      post: (url, init) => this.aiClient.post(url, init),
      getConfig: () => this.store.get().ai.provider
    })
    const evaluator = new SemanticEvaluator({ provider: this.aiProvider })
    const hitsStore = new HitsStore(join(this.userDataDir, HITS_DIR_NAME))
    this.reportService = new DailyReportService({
      provider: this.aiProvider,
      hits: hitsStore,
      notifier: { sendRaw: (text) => notifier.sendRaw(text) },
      getConfig: () => this.store.get(),
      logger: this.logger,
      reportsDir: join(this.userDataDir, 'reports'),
      onGenerated: (info) => broadcaster.report(info)
    })

    this.seen = new FileSeenStore(join(this.userDataDir, 'seen.json'))
    this.seen.load()
    const engineState = new FileEngineState(join(this.userDataDir, 'state.json'))
    engineState.load()

    // scheduler ↔ engine 互引：let engine + 闭包延迟解引用（headless.ts 同款模板）
    let engine!: MonitorEngine
    const scheduler = new PollScheduler({
      intervalSec: this.store.get().pollIntervalSec,
      onTick: () => engine.pollOnce(),
      onScheduled: (nextPollAtMs) => engine.noteScheduled(nextPollAtMs)
    })

    engine = new MonitorEngine({
      getSources,
      seen: this.seen,
      state: engineState,
      notifier,
      // 热更新：闭包每次读 store 当前值，IPC save 后无需重建 engine
      getConfig: () => this.store.get(),
      scheduler,
      logger: this.logger,
      semanticEvaluator: evaluator,
      hitsStore,
      onStatus: (s) => this.emitStatus(s),
      onHit: (h) => this.emitHit(h)
    })
    this.engine = engine

    // 第一个订阅者是 IPC 广播器（onStatus/onHit 转发给渲染进程）
    this.statusListeners.add((s) => broadcaster.status(s))
    this.hitListeners.add((h) => broadcaster.hit(h))

    // 初始配置的副作用同步（开机自启标志等；proxy 与构造参数一致，幂等）
    this.applyConfigSideEffects(this.store.get())
    this.logger.info(`desktop runtime initialized (userData=${this.userDataDir})`)
  }

  /** 订阅 engine 状态（IPC 广播 / 托盘 / powerSaveBlocker 共用同一事实源） */
  onStatus(cb: (s: EngineStatus) => void): () => void {
    this.statusListeners.add(cb)
    return () => {
      this.statusListeners.delete(cb)
    }
  }

  /** 订阅命中记录（推送尝试 settle 后发出，含失败与静音两种非成功态） */
  onHit(cb: (h: HitRecord) => void): () => void {
    this.hitListeners.add(cb)
    return () => {
      this.hitListeners.delete(cb)
    }
  }

  /** desired=running 并立即触发首轮（首启基线在这一轮完成）+ 起日报定时器 */
  startup(): void {
    this.engine.start()
    this.startReportTimer()
    this.logger.info('engine started: monitoring begins (desired=running)')
  }

  /**
   * powerMonitor resume（睡眠唤醒）入口：立即补一轮轮询 + 一次日报 tick
   * （睡眠可能跨过当天 timeHHMM，唤醒补做，D5）。desired 语义由
   * engine.runNow / reportSvc.tick 入参内部尊重。
   */
  onPowerResume(): void {
    this.engine.runNow()
    void this.runReportTick()
  }

  /**
   * 配置副作用（保存配置后同步调用）：
   * - 三个 HttpClient 的 setProxy（'telegram-only' → site/ai 恒直连）——**仅代理值
   *   变化时调用**：setProxy 会销毁重建 dispatcher、中断在途请求，保存无关配置
   *   （如只改关键词）不应打断网络；
   * - 开机自启（app.setLoginItemSettings）。
   * 单项失败只记日志，不阻断其余项。
   */
  applyConfigSideEffects(cfg: AppConfig): void {
    const siteProxy = cfg.proxyScope === 'all' ? cfg.proxyUrl : ''
    if (siteProxy !== this.lastSiteProxy) {
      try {
        this.siteClient.setProxy(siteProxy)
        this.lastSiteProxy = siteProxy
      } catch (err) {
        this.logger.error(`set site proxy failed (${redactProxyUrl(siteProxy) || 'direct'}): ${describe(err)}`)
      }
    }
    if (cfg.proxyUrl !== this.lastTgProxy) {
      try {
        this.tgClient.setProxy(cfg.proxyUrl)
        this.lastTgProxy = cfg.proxyUrl
      } catch (err) {
        this.logger.error(
          `set telegram proxy failed (${redactProxyUrl(cfg.proxyUrl) || 'direct'}): ${describe(err)}`
        )
      }
    }
    const aiProxy = siteProxy
    if (aiProxy !== this.lastAiProxy) {
      try {
        this.aiClient.setProxy(aiProxy)
        this.lastAiProxy = aiProxy
      } catch (err) {
        this.logger.error(
          `set ai proxy failed (${redactProxyUrl(aiProxy) || 'direct'}): ${describe(err)}`
        )
      }
    }
    try {
      // 值未变化时跳过：dev 下对未签名 Electron 调 setLoginItemSettings 会被
      // macOS 拒绝（Electron C++ 层记 "Operation not permitted"），避免无谓调用
      const current = app.getLoginItemSettings()
      if (current.openAtLogin !== cfg.launchAtLogin) {
        app.setLoginItemSettings({ openAtLogin: cfg.launchAtLogin })
      }
    } catch (err) {
      this.logger.error(`setLoginItemSettings failed: ${describe(err)}`)
    }
  }

  /** 退出路径统一走这里（before-quit 与 will-quit 之间调用）；幂等 */
  async shutdown(): Promise<void> {
    if (this.shutdownStarted) return
    this.shutdownStarted = true
    this.stopReportTimer()
    try {
      this.engine.pause() // 停排程；状态事件同时驱动 powerSaveBlocker 释放
    } catch (err) {
      console.error(`[runtime] engine.pause failed: ${describe(err)}`)
    }
    // flush 不再向上抛（失败返回 false）——退出路径只补一条日志
    if (!(await this.seen.flush())) {
      console.error('[runtime] seen flush failed during shutdown')
    }
    this.siteClient.close()
    this.tgClient.close()
    this.aiClient.close()
    // 给 logger 的 appendFile 写队列留一拍落盘（同 headless 先例；尾部丢失本可容忍）
    await new Promise((resolve) => setTimeout(resolve, 100))
    this.logger.close()
  }

  // ---- 内部实现 ----------------------------------------------------------

  /** 日报自循环定时器（D5）：执行后按 nextCheckAt 重排；sleep ∈ [60s, 30min] */
  private startReportTimer(): void {
    if (this.reportTimer !== null || this.shutdownStarted) return
    const schedule = (): void => {
      // tick 在途时 shutdown 已把句柄清掉：这里不得再排新计时器
      if (this.shutdownStarted) {
        this.reportTimer = null
        return
      }
      const sleep = Math.min(
        REPORT_TIMER_MAX_SLEEP_MS,
        Math.max(REPORT_TIMER_MIN_SLEEP_MS, this.reportService.nextCheckAt() - Date.now())
      )
      this.reportTimer = setTimeout(() => {
        void this.runReportTick().finally(schedule)
      }, sleep)
    }
    schedule()
    this.logger.info('daily report timer started')
  }

  private stopReportTimer(): void {
    if (this.reportTimer !== null) {
      clearTimeout(this.reportTimer)
      this.reportTimer = null
    }
  }

  /** 单次 tick（desired 从 engine 实时快照取；tick 自身条件不满足时是 no-op） */
  private async runReportTick(): Promise<void> {
    const desiredRunning = this.engine.getStatus().desired === 'running'
    try {
      const ran = await this.reportService.tick(desiredRunning)
      if (ran) this.logger.info('daily report generated by timer tick')
    } catch (err) {
      // generate 失败（文件写失败等）：attempts 上限兜底，定时器继续跑
      this.logger.error(`daily report tick failed: ${describe(err)}`)
    }
  }

  private emitStatus(s: EngineStatus): void {
    for (const cb of [...this.statusListeners]) {
      try {
        cb(s)
      } catch (err) {
        this.logger.error(`onStatus listener threw: ${describe(err)}`)
      }
    }
  }

  private emitHit(h: HitRecord): void {
    for (const cb of [...this.hitListeners]) {
      try {
        cb(h)
      } catch (err) {
        this.logger.error(`onHit listener threw: ${describe(err)}`)
      }
    }
  }
}

let singleton: DesktopRuntime | null = null

/** 初始化并返回运行时单例（app.whenReady 之后调用一次） */
export function initRuntime(broadcaster: EventBroadcaster): DesktopRuntime {
  if (singleton !== null) throw new Error('DesktopRuntime already initialized')
  singleton = new DesktopRuntime(broadcaster)
  return singleton
}

/** 取运行时单例；未初始化时抛清晰错误（装配顺序错误的信号） */
export function getRuntime(): DesktopRuntime {
  if (singleton === null) {
    throw new Error(
      'DesktopRuntime not initialized: call initRuntime() inside app.whenReady() first'
    )
  }
  return singleton
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** HttpClient 构造对非法代理 URL 会抛（fail-fast）；装配期降级为直连并记日志 */
function createClientSafely(
  proxyUrl: string,
  logger: Logger,
  label: string,
  defaultTimeoutMs?: number
): HttpClient {
  try {
    return new HttpClient({ proxyUrl, ...(defaultTimeoutMs !== undefined ? { defaultTimeoutMs } : {}) })
  } catch (err) {
    logger.error(
      `invalid ${label} proxy url "${redactProxyUrl(proxyUrl)}", falling back to direct: ${describe(err)}`
    )
    return new HttpClient(
      defaultTimeoutMs !== undefined ? { defaultTimeoutMs } : {}
    )
  }
}
