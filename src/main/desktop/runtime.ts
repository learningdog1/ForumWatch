/**
 * 桌面运行时装配（ADR 2：主进程只做装配，内核零 electron 依赖）。
 * 装配链对齐 scripts/headless.ts 的接线模板：
 *
 *   logger（userData/logs）→ ConfigStore → 三 HttpClient（按 proxyScope 路由：
 *   'telegram-only' → site/ai 恒直连、tg 走代理；'all' → 都带；aiClient 默认
 *   超时 30s，D6）→ getSources adapter 工厂（按 config.sources 逐项构造：
 *   nodeseek/v2ex 按 id 惰性单例，rss 按项实例、url/label 变更时重建）/
 *   多通道推送装配（R6-W4：buildNotifiers → CompositeNotifier，包稳定壳
 *   NotifierShell 供 engine/日报/ipc 持有，通道集合变化时热替换）→ AiProvider /
 *   SemanticEvaluator（R7-W4 起构造注入 FileFeedbackStore 的 recentForPrompt，
 *   DEC-5 反馈进 system prompt）/ CommentGenerator / DailyReportService
 *   （reportsDir= <userData>/reports）→ FileSeenStore / FileEngineState /
 *   HitsStore（<userData>/hits）/ DispositionStore（<userData>/pipeline，
 *   R7-W1 处置流水）/ FileFeedbackStore（<userData>/feedback.json，R7-W4）→
 *   PollScheduler（onTick 绑 engine.pollOnce、onScheduled 绑 engine.noteScheduled，
 *   不绑则 nextPollAt 恒 null）→ MonitorEngine（deps 注入 evaluator +
 *   commentaryGenerator + hitsStore + dispositions）。
 *
 * 配置热更新：engine 每轮 pollOnce 调 getConfig()（→ store.get()），IPC saveConfig
 * 落盘后 store 内存值即换新；网络副作用由 applyConfigSideEffects 同步（三个
 * client 的 setProxy——仅代理值变化时调用，避免无谓中断在途请求——+ 开机自启）。
 *
 * 日报定时器（D5）：startup() 起一个自循环 setTimeout——每轮 sleep =
 * clamp(nextCheckAt - now, 60s, 30min)（下限保证跨天/补做及时，上限防休眠期
 * 漂移后空转密集唤醒）；到点调 reportSvc.tick(desired)。app quit（shutdown）
 * 清理。powerMonitor resume 时 onPowerResume() 补一轮 tick（睡眠跨过触发时刻
 * 的补偿路径，D5「启动/resume 时检查」）；用户手动 resume（IPC/托盘）也补——
 * emitStatus 里检测 desired paused→running 翻转即 void runReportTick()（F6，
 * 暂停跨过 timeHHMM 的补偿路径）。
 *
 * 生命周期：startup() = engine.start()（launch 即开始监控，desired 默认 running）+
 * 起 watchdog；shutdown() 在 app 的 before-quit 与 will-quit 之间调用（退出路径统一
 * 走这里）：engine.pause → 停 watchdog/日报定时器 → seen flush（备份导入后的
 * pendingRestart 态跳过——见 beginPendingRestart）→ clients close → logger close。
 *
 * 引擎看门狗（R8-A 任务一，E2）：EngineWatchdog 旁路观察 nextPollAt 超期
 * （desired=running 且 now > nextPollAt + max(interval*2, 90s)）并强制 runNow
 * 自愈。观察面经既有状态广播通道下发：emitStatus 在快照对象上附加 watchdog 字段
 * 再发（engine 不写该字段——status 是 engine 的事实源，watchdog 是 runtime 侧
 * 旁路观测；注意 IPC 的 getStatus 拉取路径直读 engine.getStatus()，不带该字段，
 * 广播/拉取两条路径的差异由渲染端按可选字段容忍）。暂停不触发由 watchdog 自身
 * 按 desired 判定，无需随 pause/resume 启停。headless 装配暂不接（后续包重构时补）。
 *
 * RSS 降级 fetch（R8-A 任务二，E3 Cloudflare B 计划）：每个 RssSourceAdapter 注入
 * fallbackFetchFn = Electron net.fetch 的 FetchLike 包装（Chromium 网络栈/系统代理，
 * TLS 指纹与 undici 不同——被 CF 拦的 linux.do/LET 形态 RSS 换栈重发；主 fetch 被
 * 挑战才触发，降级在 adapter 内部完成，engine 不感知）。net.fetch 不走 undici
 * dispatcher：ConfigStore 的 proxyUrl/proxyScope 对它不生效（用系统代理），行为
 * 差异见 createBrowserStackFetch 注释。
 *
 * Telegram 遥控（R9-W1，DEC-6）：BotCommandController 在 engine 之后构造
 * （getEnabled/getCredentials 现读 store，post 走 tgClient，pause/resume/runNow
 * 直绑 engine）；startup 时 enabled 即 start；applyConfigSideEffects 里按
 * enabled × telegram 凭据就绪对齐 start/stop；shutdown 显式 stop（坑8 三条
 * 接线纪律见 notify/bot-commands.ts 文件头）。
 */
import { app, net } from 'electron'
import { join } from 'node:path'
import { ConfigStore } from '../config/store'
import { createLogger, type Logger } from '../logger'
import { HttpClient, redactProxyUrl } from '../net/http'
import { AiProvider } from '../ai/provider'
import { SemanticEvaluator } from '../ai/evaluator'
import { FileFeedbackStore } from '../ai/feedback'
import { CommentGenerator } from '../ai/commentary'
import { DailyReportService } from '../ai/daily-report'
import { FileSeenStore, seenCapacityForSources } from '../monitor/dedup'
import { MonitorEngine } from '../monitor/engine'
import { DispositionStore, PIPELINE_DIR_NAME } from '../monitor/dispositions'
import { HitsStore, HITS_DIR_NAME } from '../monitor/hits-store'
import { PollScheduler } from '../monitor/poller'
import { FileEngineState } from '../monitor/state'
import { HtmlSourceAdapter } from '../monitor/sources/html'
import { RssSourceAdapter } from '../monitor/sources/rss'
import { V2exSourceAdapter } from '../monitor/sources/v2ex'
import type { SourceAdapter } from '../monitor/types'
import { TelegramNotifier } from '../notify/telegram'
import { BarkNotifier } from '../notify/bark'
import { NtfyNotifier } from '../notify/ntfy'
import { WebhookNotifier } from '../notify/webhook'
import { CompositeNotifier } from '../notify/composite'
import { BotCommandController } from '../notify/bot-commands'
import {
  isChannelReady,
  telegramCredentialsOf,
  type HitMessageInput,
  type Notifier
} from '../notify/types'
import type { FetchLike, HttpRequestInit, HttpResponse } from '../net/http-types'
import type { AppConfig, ChannelConfig, EngineStatus, HitRecord } from '../../shared/types'
import type { EventBroadcaster } from './ipc'
import { EngineWatchdog } from './watchdog'
import { createSafeStorageBox } from './safe-storage-box'

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
  /**
   * 语义评估器（R5-P2c 起暴露）：match:test 测试台 handler 复用同一实例
   * （provider 热更新读 store）。原本是构造局部量，仅为测试台依赖升为字段。
   */
  readonly semanticEvaluator: SemanticEvaluator
  /**
   * AI 反馈存储（R7-W4，DEC-5）：<userData>/feedback.json（正/负例各环形 100）。
   * ipc hitFeedback 写入；SemanticEvaluator 经 getFeedbackExamples 现读注入
   * system prompt 尾部。engine 不持有它——反馈只进 evaluator。
   */
  readonly feedbackStore: FileFeedbackStore
  /** 命中存储（R5-P2c 起暴露）：match:test 从近 2 天命中重建"近期已推"标题 */
  readonly hitsStore: HitsStore
  /** 处置流水存储（R7-W1）：engine 各分支出口上报 + ipc 查询（recent/readDay） */
  readonly dispositions: DispositionStore
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
  /**
   * 推送稳定壳（R6-W4）：engine / 日报 / ipc 共用的 Notifier 引用（构造期
   * 创建，永不重建）；通道集合变化时只 replace 壳内 composite。
   */
  private readonly notifierShell: NotifierShell
  /** 上次已生效的就绪通道签名（applyConfigSideEffects 据此只在变化时重建扇出） */
  private lastReadyChannels: string
  /** nodeseek 惰性单例（首次 getSources 命中时构造；id 固定 'nodeseek'） */
  private nodeseekAdapter: HtmlSourceAdapter | null = null
  /** v2ex 按 id 惰性单例（构造签名带 id；常规配置就一项，退化为单例） */
  private readonly v2exAdapters = new Map<string, V2exSourceAdapter>()
  /** rss 按 id 缓存；url/label 指纹不匹配时重建（见 getSources） */
  private readonly rssAdapters = new Map<
    string,
    { url: string; label: string; adapter: RssSourceAdapter }
  >()
  /**
   * 引擎看门狗（R8-A 任务一，E2）：startup 起、shutdown 停；触发条件/动作见
   * watchdog.ts。观察面经 emitStatus 附加到状态广播（EngineStatus.watchdog）。
   */
  private readonly watchdog: EngineWatchdog
  /**
   * Telegram 遥控（R9-W1，DEC-6）：getUpdates 长轮询接收 /status /pause /
   * /resume /poll /help。生命周期独立于 engine desired（坑8 第二条：/pause
   * 后监听继续跑）；start/stop 由 startup/applyConfigSideEffects/shutdown 对齐
   * （enabled × telegram 凭据就绪签名）。
   */
  private readonly botCommands: BotCommandController
  /** startup() 是否已跑（遥控只在 startup 后才允许 start——构造期引擎未起） */
  private startedUp = false
  /** 日报定时器句柄（startup 起、shutdown 清；自循环重排） */
  private reportTimer: ReturnType<typeof setTimeout> | null = null
  /** 上一帧 engine desired（F6：检测 paused→running 翻转补跑日报 tick；null=尚未见帧） */
  private lastDesired: EngineStatus['desired'] | null = null
  /**
   * 备份导入后的"待重启禁写"（R8-B/E4 评审修复）：置位后 shutdown 跳过 seen
   * flush——导入写回的 seen.json 不能在退出时被运行中内存集全量覆盖（见
   * beginPendingRestart）。state 无独立 shutdown 写点（setFor 只随轮询发生，
   * pause 后不再轮询），无需另行守卫。
   */
  private pendingRestart = false
  private shutdownStarted = false

  /** 由 initRuntime 创建（必须在 app.whenReady 之后）；不要直接 new */
  constructor(broadcaster: EventBroadcaster) {
    this.userDataDir = app.getPath('userData')
    this.logger = createLogger({ fileDir: join(this.userDataDir, 'logs') })

    // R9-W2（DEC-10）凭据加密落盘：safeStorage 适配在 desktop 层构造（唯一
    // electron import 点，safe-storage-box.ts）。时机：DesktopRuntime 由
    // index.ts 在 app.whenReady() 之后经 initRuntime 创建，safeStorage 的
    // OS 密钥库此刻已可用——无需懒初始化；不可用（Linux 无密钥库等）时适配
    // 内部降级 PlainSecretBox + warn 一次（凭据明文落盘，0o600 口径不变）。
    this.store = new ConfigStore(join(this.userDataDir, 'config.json'), {
      secretBox: createSafeStorageBox(this.logger)
    })
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

    // adapter 工厂：getSources 访问器内按当前 config.sources 逐项构造（R4-W4，
    // ultrabrain 坑2——v3 判别联合下静态 id→adapter 注册表不成立：rss 的 url/label
    // 是配置数据，必须按项建实例）。三类构造策略：
    // - nodeseek / v2ex：按 id 惰性单例（实例无内部可变状态，闭包引 siteClient；
    //   HtmlSourceAdapter 的 id 固定 'nodeseek'，V2exSourceAdapter 构造签名带 id）；
    // - rss：按 id 缓存 {url, label, adapter}，url/label 变化时重建（它们是构造
    //   参数，变更后旧实例的抓取地址/展示名语义过期）。
    // getSources 每轮重读 config.sources 过滤 enabled（与既有语义一致：enabled=false
    // 不进返回）——配置热更新即生效，不在构造期定死数组（D3）。
    //
    // RSS 降级 fetch（R8-A 任务二，E3）：所有 rss 实例共用一个 Chromium 栈包装
    // （无状态纯函数闭包）；adapter 内部在主 fetch 被 CF 挑战时用它重发同一请求。
    const browserStackFetch = createBrowserStackFetch()
    const getSources = (): SourceAdapter[] => {
      const out: SourceAdapter[] = []
      for (const s of this.store.get().sources) {
        if (!s.enabled) continue
        // 判别联合按 type 收窄：rss 分支里 s.url / s.label 才存在（types.ts v3）
        if (s.type === 'nodeseek') {
          if (this.nodeseekAdapter === null) {
            this.nodeseekAdapter = new HtmlSourceAdapter({
              fetchHtml: (url, init) => this.siteClient.get(url, init)
            })
          }
          out.push(this.nodeseekAdapter)
        } else if (s.type === 'v2ex') {
          const cached = this.v2exAdapters.get(s.id)
          if (cached !== undefined) {
            out.push(cached)
          } else {
            const adapter = new V2exSourceAdapter({
              fetchJson: (url, init) => this.siteClient.get(url, init),
              id: s.id
            })
            this.v2exAdapters.set(s.id, adapter)
            out.push(adapter)
          }
        } else {
          const cached = this.rssAdapters.get(s.id)
          if (cached !== undefined && cached.url === s.url && cached.label === (s.label ?? '')) {
            out.push(cached.adapter)
            continue
          }
          const adapter = new RssSourceAdapter({
            id: s.id,
            url: s.url,
            ...(s.label !== undefined ? { label: s.label } : {}),
            fetchFn: (url, init) => this.siteClient.get(url, init),
            // E3 Cloudflare B 计划：主 fetch（undici 栈）被挑战时换 Chromium 栈
            // 重发同一请求（linux.do/LET 形态的 RSS 源）；能力声明
            // browserStackFallback 由 adapter 构造时自动置 true
            fallbackFetchFn: browserStackFetch,
            log: this.logger
          })
          this.rssAdapters.set(s.id, { url: s.url, label: s.label ?? '', adapter })
          out.push(adapter)
        }
      }
      return out
    }
    // R6-W4 多通道推送装配（DEC-9 收口）：按 initial.channels 为**就绪**通道
    // （isChannelReady）构造发送器，包进 CompositeNotifier（路由扇出 + 聚合），
    // 外面再包 NotifierShell——engine / 日报 / ipc 测试消息持壳，通道集合变化时
    // applyConfigSideEffects 热替换壳内实现（见 NotifierShell 注释）。凭据/
    // 启停/路由全部现读 store（发送时/路由时），只有就绪通道集合变化才重建。
    this.lastReadyChannels = readyChannelSignature(initial)
    this.notifierShell = new NotifierShell(
      new CompositeNotifier(this.buildNotifiers(initial), {
        getRouting: () => this.store.get().routing
      })
    )
    const notifier: Notifier = this.notifierShell

    // AI 装配（D4/D6 + 第三轮锐评）：provider 每次调用重读 store（热更新）；
    // evaluator 批式评估；锐评生成器与 evaluator 共用同一 provider 实例
    // （provider 未配置时由 engine 的闸拦下，装配层无需判断）；日报服务读
    // hits JSONL、写 <userData>/reports、推送走 sendRaw、广播给渲染端
    this.aiProvider = new AiProvider({
      post: (url, init) => this.aiClient.post(url, init),
      getConfig: () => this.store.get().ai.provider
    })
    // R7-W4（DEC-5）反馈闭环：FileFeedbackStore（<userData>/feedback.json）+
    // evaluator 构造注入 getFeedbackExamples（每次评估现读，投票后下一次即生效）
    this.feedbackStore = new FileFeedbackStore({ dataDir: this.userDataDir })
    const evaluator = new SemanticEvaluator({
      provider: this.aiProvider,
      getFeedbackExamples: () => this.feedbackStore.recentForPrompt()
    })
    const commentaryGenerator = new CommentGenerator({ provider: this.aiProvider })
    const hitsStore = new HitsStore(join(this.userDataDir, HITS_DIR_NAME))
    // R5-P2c：测试台 handler（ipc.ts match:test）复用这两个实例，升为只读字段
    this.semanticEvaluator = evaluator
    this.hitsStore = hitsStore
    this.reportService = new DailyReportService({
      provider: this.aiProvider,
      hits: hitsStore,
      notifier: { sendRaw: (text) => notifier.sendRaw(text) },
      getConfig: () => this.store.get(),
      logger: this.logger,
      reportsDir: join(this.userDataDir, 'reports'),
      onGenerated: (info) => broadcaster.report(info)
    })

    // seen 容量随来源数扩容（ultrabrain 坑12：1000 + 500×(n-1)，防容量淘汰先于
    // 时间淘汰击穿）。容量构造期定死：配置增删来源后不自动跟随，下次重启生效
    // （不为它重构 engine deps；期间偏小容量只是环形淘汰更早，无正确性问题）
    this.seen = new FileSeenStore(
      join(this.userDataDir, 'seen.json'),
      seenCapacityForSources(initial.sources.length)
    )
    this.seen.load()
    // 处置流水（R7-W1）：pipeline/<date>.jsonl 持久化 + 内存环；构造时做 7 天保留清理
    this.dispositions = new DispositionStore({
      dataDir: join(this.userDataDir, PIPELINE_DIR_NAME)
    })
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
      // R5-P2a：per-source 过滤访问器（config.sources[].filters，热更新读 store）；
      // 未配置的 source 返回 undefined = 不过滤
      getSourceFilters: (sourceId) =>
        this.store.get().sources.find((s) => s.id === sourceId)?.filters,
      seen: this.seen,
      state: engineState,
      notifier,
      // 热更新：闭包每次读 store 当前值，IPC save 后无需重建 engine
      getConfig: () => this.store.get(),
      scheduler,
      logger: this.logger,
      semanticEvaluator: evaluator,
      commentaryGenerator,
      hitsStore,
      dispositions: this.dispositions,
      onStatus: (s) => this.emitStatus(s),
      onHit: (h) => this.emitHit(h)
    })
    this.engine = engine

    // R8-A 任务一（E2）：engine watchdog——旁路观察 nextPollAt 超期并强制补轮询
    // （自愈挂死的排程循环）。interval 现读 store（配置热更新语义，每次检查时取
    // 当前 pollIntervalSec）；getStatus/runNow 绑 engine 实时快照与立即轮询入口。
    // 生命周期随 engine：startup() 起、shutdown() 停；engine 暂停期间由 watchdog
    // 自身按 desired 判定不触发，无需随 pause/resume 启停。
    this.watchdog = new EngineWatchdog({
      getStatus: () => engine.getStatus(),
      runNow: () => engine.runNow(),
      getIntervalMs: () => this.store.get().pollIntervalSec * 1000,
      log: this.logger
    })

    // Telegram 遥控（R9-W1，DEC-6）：内核零 electron，装配层注入全部依赖。
    // getEnabled/getCredentials 每轮循环现读 store（配置热更新；翻 false/凭据
    // 失效由 controller 自行退出循环，翻 true 由 applyConfigSideEffects 对齐）。
    // post 走 tgClient（自己的直调通道，绝不进 TelegramNotifier 的 1050ms 队列，
    // 坑8 第一条）；pause/resume/runNow 直绑 engine（desired 翻转不影响本监听，
    // 坑8 第二条）。
    this.botCommands = new BotCommandController({
      getEnabled: () => {
        const rc = this.store.get().notify.remoteControl
        return { enabled: rc.enabled, allowedChatIds: rc.allowedChatIds }
      },
      getCredentials: () => {
        const creds = telegramCredentialsOf(this.store.get().channels)
        return creds.botToken !== '' && creds.chatId !== '' ? creds : null
      },
      post: (url, init) => this.tgClient.post(url, init),
      getStatus: () => engine.getStatus(),
      pause: () => engine.pause(),
      resume: () => engine.resume(),
      runNow: () => engine.runNow(),
      log: this.logger
    })

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

  /** desired=running 并立即触发首轮（首启基线在这一轮完成）+ 起 watchdog 与日报定时器 */
  startup(): void {
    this.engine.start()
    this.watchdog.start()
    this.startReportTimer()
    this.startedUp = true
    // R9-W1：startup 后才允许遥控启动（构造期引擎未起，指令来得太早）
    this.alignRemoteControl(this.store.get())
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
   * - 推送扇出热重建（R6-W4）——仅当**就绪通道集合**变化（readyChannelSignature
   *   不一致）时 replace 壳内 composite；通道凭据/启停由发送器的 getConfig 每次
   *   发送前现读、路由由 composite 的 getRouting 现读，均不需要重建；
   * - Telegram 遥控对齐（R9-W1）——enabled × 第一个就绪 telegram 通道的凭据
   *   两个维度任一变化即 start/stop（controller 运行中也会每轮自读配置，这里
   *   负责补"翻 true"的自举与即时停）；
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
    // 推送扇出热重建（R6-W4）：就绪通道集合变化才 replace 壳内 composite
    // （凭据/启停/路由热更新都不需要——getConfig/getRouting 现读，见
    // NotifierShell 注释）。replace 只换壳内引用，engine/日报手里的壳不动。
    const signature = readyChannelSignature(cfg)
    if (signature !== this.lastReadyChannels) {
      this.notifierShell.replace(
        new CompositeNotifier(this.buildNotifiers(cfg), {
          getRouting: () => this.store.get().routing
        })
      )
      this.lastReadyChannels = signature
      this.logger.info(`notify fan-out rebuilt (ready channels: [${signature}] or none)`)
    }
    // Telegram 遥控对齐（R9-W1）：shouldRun 与 isRunning 求差即可——controller
    // 运行中每轮自读 getEnabled/getCredentials（关掉/凭据失效它自退，这里的
    // stop 分支只是让它立即退），翻 true 与凭据就绪只能靠这里自举 start。
    this.alignRemoteControl(cfg)
  }

  /**
   * 遥控 start/stop 对齐（R9-W1）：shouldRun = remoteControl.enabled 且存在
   * 就绪 telegram 通道（telegramCredentialsOf 单一事实源）。startup 之前不
   * start（构造期引擎未起）；shutdownStarted 后不再 start。
   */
  private alignRemoteControl(cfg: AppConfig): void {
    const creds = telegramCredentialsOf(cfg.channels)
    const shouldRun = cfg.notify.remoteControl.enabled && creds.botToken !== '' && creds.chatId !== ''
    if (shouldRun) {
      if (!this.startedUp || this.shutdownStarted) return
      if (!this.botCommands.isRunning) this.botCommands.start()
    } else if (this.botCommands.isRunning) {
      this.botCommands.stop()
    }
  }

  /**
   * 备份导入后的"待重启禁写"（R8-B/E4 评审修复，ipc.ts importBackup 成功路径调用）：
   * 置 pendingRestart 并暂停引擎（desired 翻转，停轮询停定时）。此后：
   * - 运行中的 runtime 不再产生 seen/state 落盘（engine 写点全部在 pollOnce
   *   内，pause 后排程器停、runNow 尊重 desired 不再触发新轮询）；
   * - shutdown() 跳过 seen flush（旧内存集不会在退出时覆盖导入的 seen.json）；
   * - seen/state/engine 内存不热换（重启后从盘加载新值）。config 段例外：
   *   importBackup 随后显式调 store.load() 重读内存（防用户导入后继续在
   *   设置页保存把旧内存配置写回盘上）。
   * 可观测性：info 日志 + UI 导入成功文案提示"监控已暂停，请尽快重启"。
   */
  beginPendingRestart(reason: string): void {
    if (this.shutdownStarted || this.pendingRestart) return
    this.pendingRestart = true
    try {
      this.engine.pause() // 停排程；状态事件同时驱动 powerSaveBlocker 释放
    } catch (err) {
      console.error(`[runtime] engine.pause failed during pendingRestart: ${describe(err)}`)
    }
    this.logger.info(
      `pending restart (${reason}): monitoring paused, seen/state persistence suspended until restart`
    )
  }

  /** 是否处于"待重启禁写"（备份导入后置位；ipc hitFeedback 等写入面据此拒绝） */
  get isPendingRestart(): boolean {
    return this.pendingRestart
  }

  /** 退出路径统一走这里（before-quit 与 will-quit 之间调用）；幂等 */
  async shutdown(): Promise<void> {
    if (this.shutdownStarted) return
    this.shutdownStarted = true
    this.watchdog.stop() // 先停旁路观察：后续 engine.pause 触发的状态广播不再需要触发自愈
    this.botCommands.stop() // 显式停遥控长轮询（坑8：退出不留悬挂的 getUpdates 消费者）
    this.stopReportTimer()
    try {
      this.engine.pause() // 停排程；状态事件同时驱动 powerSaveBlocker 释放
    } catch (err) {
      console.error(`[runtime] engine.pause failed: ${describe(err)}`)
    }
    // 待重启禁写（备份导入）：flush 会用运行中内存集**全量覆盖**盘文件——退出时
    // 它会把导入写回的 seen.json 冲回旧集合，故跳过（重启后直接加载导入文件）。
    // state.json 无 shutdown 写点可跳（见 pendingRestart 字段注释）。
    if (this.pendingRestart) {
      console.info('[runtime] pending restart: skipping seen flush during shutdown')
    } else if (!(await this.seen.flush())) {
      // flush 不再向上抛（失败返回 false）——退出路径只补一条日志
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

  /**
   * 按配置构造**就绪**通道的发送器列表（R6-W4；仅 isChannelReady 通过的通道，
   * 未就绪通道不构造——engine 侧 configured 闸之外，composite 也不给无凭据
   * 通道留扇出位）。client 路由对齐 proxyScope 语义：只有 telegram 走 tgClient
   * （恒代理作用域），bark/ntfy/webhook 走 siteClient——siteClient 的代理随
   * proxyScope 热更新（'all' 才带代理），telegram-only 时三新通道与 site/ai
   * 同待遇直连。getConfig 每次发送前按 id 重读 store：找不到（通道被删）或类型
   * 已变时回空凭据，发送器自身 fail-fast 抛 not configured（正常流程 engine 的
   * configured 闸已拦下，这是签名未变时的兜底）。
   */
  private buildNotifiers(cfg: AppConfig): Notifier[] {
    /** 按 id+type 现读通道（getConfig 访问器的公共形状） */
    const channelNow = (id: string): ChannelConfig | undefined =>
      this.store.get().channels.find((ch) => ch.id === id)
    const post: FetchLike = (url, init) => this.siteClient.post(url, init)
    const out: Notifier[] = []
    for (const ch of cfg.channels) {
      if (!isChannelReady(ch)) continue
      if (ch.type === 'telegram') {
        out.push(
          new TelegramNotifier({
            id: ch.id,
            post: (url, init) => this.tgClient.post(url, init),
            getConfig: () => {
              const cur = channelNow(ch.id)
              return cur !== undefined && cur.type === 'telegram'
                ? { botToken: cur.botToken, chatId: cur.chatId }
                : { botToken: '', chatId: '' }
            }
          })
        )
      } else if (ch.type === 'bark') {
        out.push(
          new BarkNotifier({
            id: ch.id,
            post,
            getConfig: () => {
              const cur = channelNow(ch.id)
              return cur !== undefined && cur.type === 'bark'
                ? { deviceKey: cur.deviceKey, ...(cur.serverUrl !== undefined ? { serverUrl: cur.serverUrl } : {}) }
                : { deviceKey: '' }
            }
          })
        )
      } else if (ch.type === 'ntfy') {
        out.push(
          new NtfyNotifier({
            id: ch.id,
            post,
            getConfig: () => {
              const cur = channelNow(ch.id)
              return cur !== undefined && cur.type === 'ntfy'
                ? { topic: cur.topic, ...(cur.serverUrl !== undefined ? { serverUrl: cur.serverUrl } : {}) }
                : { topic: '' }
            }
          })
        )
      } else {
        out.push(
          new WebhookNotifier({
            id: ch.id,
            post,
            getConfig: () => {
              const cur = channelNow(ch.id)
              return cur !== undefined && cur.type === 'webhook'
                ? { url: cur.url, ...(cur.secret !== undefined ? { secret: cur.secret } : {}) }
                : { url: '' }
            }
          })
        )
      }
    }
    return out
  }

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
    // F6：手动 resume（IPC / 托盘「恢复监控」）desired paused→running 翻转时补跑
    // 一次日报检查——暂停期间可能跨过当天 timeHHMM，恢复即补做（系统 resume 走
    // onPowerResume 已有同款 tick）。runReportTick 内部尊重 desired 与触发条件，
    // 不满足时是 no-op；shutdown 后不再触发新动作。
    if (this.lastDesired === 'paused' && s.desired === 'running' && !this.shutdownStarted) {
      void this.runReportTick()
    }
    this.lastDesired = s.desired
    // R8-A 任务一：watchdog 观测面在快照副本上附加再广播（engine 不写该字段，
    // 最小侵入——不改 engine；watchdog 触发本身会调 runNow → 引擎发新状态，
    // 该字段随下一帧自然带上最新值）
    const enriched: EngineStatus = { ...s, watchdog: this.watchdog.getStatus() }
    for (const cb of [...this.statusListeners]) {
      try {
        cb(enriched)
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

/**
 * 稳定壳（R6-W4）：engine / DailyReportService / ipc 测试消息持有的 Notifier。
 * 四个方法全部委托 `current`；通道集合变化时 applyConfigSideEffects 用
 * `replace()` 换内部 CompositeNotifier——依赖方手里的引用永不变（engine deps
 * 不重建、日报服务不重造），扇出集合却是新的。getRouting 在 composite 构造时
 * 以闭包现读 store（路由热更新免重建），通道凭据经各发送器的 getConfig 访问器
 * 每次发送前现读（凭据热更新同样免重建）——**只有就绪通道集合本身变化才需要
 * replace**（见 readyChannelSignature）。
 */
class NotifierShell implements Notifier {
  private current: Notifier
  constructor(initial: Notifier) {
    this.current = initial
  }
  /** 热替换内部实现（applyConfigSideEffects 的通道集合变化分支） */
  replace(next: Notifier): void {
    this.current = next
  }
  get id(): string {
    return this.current.id
  }
  sendHit(input: HitMessageInput): Promise<void> {
    return this.current.sendHit(input)
  }
  sendRaw(text: string): Promise<void> {
    return this.current.sendRaw(text)
  }
  sendTest(): Promise<void> {
    return this.current.sendTest()
  }
}

/**
 * 就绪通道集合的重建签名（R6-W4）：`type:id` 按序拼接。只看**就绪**通道
 * （isChannelReady：enabled × 已实现类型 × 凭据齐备）——buildNotifiers 只为
 * 就绪通道构造发送器，未就绪通道进出列表不改变扇出集合，不值得为此中断在途
 * 发送重建 composite。签名变化 = 就绪集合变化 = 需要重建；同 id 换类型（手工
 * 编辑 config.json 的边缘情况）也因 type 参与签名而被捕获。
 */
function readyChannelSignature(cfg: AppConfig): string {
  return cfg.channels
    .filter((ch) => isChannelReady(ch))
    .map((ch) => `${ch.type}:${ch.id}`)
    .join('|')
}

/**
 * Electron net.fetch 的 FetchLike 包装（R8-A 任务二，E3 Cloudflare B 计划）。
 * RSS adapter 的降级 fetch：主 fetch（undici/Node 栈）被 CF 挑战时用它**重发同一
 * 请求**——net.fetch 走 **Chromium 网络栈**，TLS 指纹/JA3 与 undici 不同，按指纹
 * 拦截的 Cloudflare 规则（linux.do/LET 形态）在 Chromium 栈下常能直出。
 *
 * **与主栈的行为差异**（观测/排障必读）：
 * - 不走 undici dispatcher：ConfigStore 的 proxyUrl/proxyScope 对它**不生效**，
 *   代理跟随**系统设置**（PAC/系统代理）；
 * - 证书库、HTTP 缓存、HSTS/Alt-Svc 均为 Chromium 会话语义；
 * - 超时语义对齐 HttpClient：timeoutMs → AbortSignal.timeout，外部 signal 经
 *   AbortSignal.any 合并（老运行时缺失 AbortSignal.any 时以 timeout 为准，
 *   同 http.ts mergeSignals 的已知取舍）。
 *
 * 仅 desktop 装配层存在（import electron 不进监控内核，ADR 2）；返回的闭包无状态
 * 可全局共享。web Response → HttpResponse 的映射只覆盖内核消费面：
 * status / headers（键统一小写）/ body 文本。
 */
function createBrowserStackFetch(): FetchLike {
  return async (url: string, init?: HttpRequestInit): Promise<HttpResponse> => {
    let signal = init?.signal
    if (init?.timeoutMs !== undefined) {
      const timeoutSignal = AbortSignal.timeout(init.timeoutMs)
      if (signal !== undefined && typeof AbortSignal.any === 'function') {
        signal = AbortSignal.any([signal, timeoutSignal])
      } else {
        signal = timeoutSignal
      }
    }
    const res = await net.fetch(url, {
      method: init?.method ?? 'GET',
      ...(init?.headers !== undefined ? { headers: init.headers } : {}),
      ...(init?.body !== undefined ? { body: init.body } : {}),
      ...(signal !== undefined ? { signal } : {})
    })
    const headers: Record<string, string> = {}
    res.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value
    })
    const body = await res.text()
    return { status: res.status, headers, body }
  }
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
