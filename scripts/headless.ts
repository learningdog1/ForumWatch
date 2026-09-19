/**
 * headless 内核直跑（ADR 2）：不经 Electron，node 直接装配并运行监控内核。
 * 用 tsx 运行：`npm run engine:headless -- [flags]`（src/main 下相对导入，scripts 里
 * 同样用相对路径 `../src/main/...`）。
 *
 * 用法：
 *   npm run engine:headless -- --once --config /tmp/nsm-smoke   # 单轮冒烟
 *   npm run engine:headless -- --config ./data/headless         # 常驻直到 Ctrl-C
 *   npm run engine:headless -- --duration 600 --interval 30     # 跑 10 分钟，30s 一轮
 *
 * 目录结构 `<dir>/{config.json, seen.json, state.json, hits/, pipeline/, reports/,
 * logs/, feedback.json}`；首次运行生成默认 config.json（chmod 600 由 ConfigStore
 * 保证）并提示填写关键词与 telegram。环境变量 `NSM_BOT_TOKEN` / `NSM_CHAT_ID`
 * 可快速注入 telegram 凭据（只进内存不落盘）。
 *
 * Telegram 遥控（R9-W1，DEC-6）：常驻模式且 notify.remoteControl.enabled 时起
 * BotCommandController（getUpdates 长轮询接收 /status /pause /resume /poll /
 * /help；接线与桌面 runtime 同款，见 src/main/notify/bot-commands.ts）；`--once`
 * 单轮冒烟不接（进程即退）。
 *
 * AI 能力（D4/D5 + 第三轮锐评，与桌面装配方同款接线）：第三 aiClient
 * （defaultTimeoutMs 30s，proxyScope='all' 时走代理）→ AiProvider /
 * SemanticEvaluator（R7-W4 起构造注入 FileFeedbackStore 的 recentForPrompt，
 * DEC-5 反馈进 system prompt）/ CommentGenerator / HitsStore /
 * DailyReportService（reportsDir=<dir>/reports）；engine deps 注入 evaluator +
 * commentaryGenerator + hitsStore。常驻模式起日报自循环定时器（sleep ∈
 * [60s, 30min]，复用 nextCheckAt）；`--once` 模式跳过日报（单轮冒烟不产文件、
 * 不推送）。
 *
 * 配置热重载（R8-C）：配置消费全部是 **store 访问器**风格（对齐桌面 runtime：
 * getEffective = store.get() + env 合并 + --interval 临时覆盖，每次现读），
 * 常驻模式用 watchConfigDir 监听 <dir>（去抖 500ms）——config.json 变化后
 * diff 顶层键，有变化才重载：log `config reloaded (key changes: ...)` 并由
 * rebuildDerived 差异重建派生实例（proxy 三 client / composite notifier，
 * 对齐桌面 applyConfigSideEffects 思路）。轮询间隔经 engine 每轮 finishRound
 * 的 setIntervalSec 自然生效；--interval CLI 覆盖**仍最高优先**（启动参数意图，
 * 热重载合并时保留）。`--once` 单轮语义不起 watch。已知取舍（既有语义不动）：
 * seen 容量构造期定死，增删来源下次重启才扩容。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ConfigStore, MIN_POLL_INTERVAL_SEC } from '../src/main/config/store'
import { PlainSecretBox } from '../src/main/config/secrets'
import { watchConfigDir, type ConfigDirWatcher } from '../src/main/config/watch'
import { HttpClient, redactProxyUrl } from '../src/main/net/http'
import type { FetchLike } from '../src/main/net/http-types'
import { AiProvider } from '../src/main/ai/provider'
import { SemanticEvaluator } from '../src/main/ai/evaluator'
import { FileFeedbackStore } from '../src/main/ai/feedback'
import { CommentGenerator } from '../src/main/ai/commentary'
import { DailyReportService } from '../src/main/ai/daily-report'
import { FileSeenStore, seenCapacityForSources } from '../src/main/monitor/dedup'
import { MonitorEngine } from '../src/main/monitor/engine'
import { DispositionStore, PIPELINE_DIR_NAME } from '../src/main/monitor/dispositions'
import { HitsStore, HITS_DIR_NAME } from '../src/main/monitor/hits-store'
import { PollScheduler } from '../src/main/monitor/poller'
import { HtmlSourceAdapter } from '../src/main/monitor/sources/html'
import { RssSourceAdapter } from '../src/main/monitor/sources/rss'
import { V2exSourceAdapter } from '../src/main/monitor/sources/v2ex'
import { FileEngineState } from '../src/main/monitor/state'
import type { SourceAdapter } from '../src/main/monitor/types'
import { TelegramNotifier } from '../src/main/notify/telegram'
import { BarkNotifier } from '../src/main/notify/bark'
import { NtfyNotifier } from '../src/main/notify/ntfy'
import { WebhookNotifier } from '../src/main/notify/webhook'
import { CompositeNotifier } from '../src/main/notify/composite'
import { BotCommandController } from '../src/main/notify/bot-commands'
import { isChannelReady, telegramCredentialsOf, type Notifier } from '../src/main/notify/types'
import { createLogger } from '../src/main/logger'
import type { AppConfig, EngineStatus, HitRecord, ChannelConfig, SourceConfig } from '../src/shared/types'

const USAGE = `usage: npm run engine:headless -- [--config <dir>] [--once] [--duration <sec>] [--interval <sec>]
  --config <dir>     数据目录（config/seen/state/logs），默认 ./data/headless
  --once             跑一轮后退出（打印本轮统计；抓取失败才退出码 1）
  --duration <sec>   运行指定秒数后优雅退出（默认直到 Ctrl-C）
  --interval <sec>   临时覆盖轮询间隔（钳到 >=15s），不写回配置；热重载后仍最高优先
env: NSM_BOT_TOKEN / NSM_CHAT_ID  注入 telegram 凭据（不落盘）`

interface CliArgs {
  configDir: string
  once: boolean
  durationSec: number | null
  intervalSec: number | null
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    configDir: './data/headless',
    once: false,
    durationSec: null,
    intervalSec: null
  }
  const needValue = (flag: string, i: number): string => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) {
      console.error(`missing value for ${flag}\n${USAGE}`)
      process.exit(2)
    }
    return v
  }
  const needNumber = (flag: string, raw: string): number => {
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) {
      console.error(`invalid value for ${flag}: ${raw}\n${USAGE}`)
      process.exit(2)
    }
    return n
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--config') args.configDir = needValue(a, i++)
    else if (a === '--once') args.once = true
    else if (a === '--duration') args.durationSec = needNumber(a, needValue(a, i++))
    else if (a === '--interval')
      args.intervalSec = needNumber(a, needValue(a, i++))
    else {
      console.error(`unknown argument: ${a}\n${USAGE}`)
      process.exit(2)
    }
  }
  return args
}

/** 三个 HttpClient 的打包形状（R8-C：`clients` 是热重载整体替换的槽位） */
interface ClientTriple {
  site: HttpClient
  tg: HttpClient
  ai: HttpClient
}

/** 顶层键 diff：变了的键名列表（JSON 逐键比对；仅供日志摘要与"是否真变了"判定） */
function diffTopLevelKeys(a: AppConfig, b: AppConfig): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  const out: string[] = []
  for (const k of keys) {
    const va = JSON.stringify((a as unknown as Record<string, unknown>)[k])
    const vb = JSON.stringify((b as unknown as Record<string, unknown>)[k])
    if (va !== vb) out.push(k)
  }
  return out
}

/** 就绪通道集合的重建签名（R8-C，与 runtime.ts 同款）：`type:id` 按序拼接 */
function readyChannelSignature(cfg: AppConfig): string {
  return cfg.channels
    .filter((ch) => isChannelReady(ch))
    .map((ch) => `${ch.type}:${ch.id}`)
    .join('|')
}

async function main(): Promise<number | null> {
  const args = parseArgs(process.argv.slice(2))
  const dir = resolve(args.configDir)
  const logsDir = join(dir, 'logs')
  mkdirSync(logsDir, { recursive: true })

  const logger = createLogger({ fileDir: logsDir })
  // console 全量镜像（带时间戳）：info→log / warn→warn / error→error
  logger.onLog((e) => {
    const line = `${e.ts} [${e.level}] ${e.msg}`
    if (e.level === 'error') console.error(line)
    else if (e.level === 'warn') console.warn(line)
    else console.log(line)
  })

  // ---- 配置：磁盘 + 环境变量合并（env 不落盘）+ --interval 临时覆盖 ----------
  // R8-C：不再做"启动时 effective 快照"——getEffective() 每次现读 store 并叠加
  // 两层固定覆盖（env 凭据 / CLI interval），watch 重载只改 store 内存值即可
  // 全链路生效（与桌面 runtime 的 getConfig = store.get() 访问器同款）。
  const configPath = join(dir, 'config.json')
  // R9-W2（DEC-10）凭据加密落盘：headless 显式注入 PlainSecretBox（明文读写，
  // 无 OS 密钥库可用）。坑10 互操作：若本目录的 config.json 是桌面版写的密文盘
  // （enc:v1: 字段），load 时这些字段按"未配置"处理（''）并报一条 error——
  // 凭据干净地失效，而不是把 base64 密文当 token 发出去；用户在本机桌面版
  // 重新保存或手工回填明文即可。
  const store = new ConfigStore(configPath, { secretBox: new PlainSecretBox() })
  const firstRun = !existsSync(configPath)
  let diskConfig = store.load() // 热重载 diff 基准（盘上 sanitize 后配置，R8-C）
  if (firstRun) {
    store.save(diskConfig) // 物化默认配置（chmod 600），便于用户直接编辑
    logger.info(`first run: default config written to ${configPath}`)
    logger.info(
      'fill includeKeywords / excludeKeywords and telegram (botToken, chatId) there, ' +
        'or export NSM_BOT_TOKEN / NSM_CHAT_ID; then rerun'
    )
  }

  const envToken = (process.env['NSM_BOT_TOKEN'] ?? '').trim()
  const envChat = (process.env['NSM_CHAT_ID'] ?? '').trim()
  if (envToken !== '' || envChat !== '') {
    logger.info('telegram credentials merged from NSM_BOT_TOKEN / NSM_CHAT_ID (env only, not persisted)')
  }

  // R6-W1（DEC-9）：env 凭据覆盖**第一个** telegram 通道的 botToken/chatId
  // （单 telegram 通道时代与旧 effective.telegram 合并完全等价：env 非空优先、
  // 否则保留盘上值；enabled 不动——用户显式关掉的通道不被 env 偷偷唤醒）。
  // 多 telegram 通道时只覆盖首个（多通道的 env 注入语义 W4 定）。
  // R8-C：env 注入只进内存不落盘——落在 getEffective 合并层，热重载后同样叠加。
  const mergeEnvTelegram = (channels: ChannelConfig[]): ChannelConfig[] => {
    if (envToken === '' && envChat === '') return channels
    const idx = channels.findIndex((ch) => ch.type === 'telegram')
    if (idx === -1) return channels
    const next = [...channels]
    const ch = next[idx] as Extract<ChannelConfig, { type: 'telegram' }>
    next[idx] = {
      ...ch,
      botToken: envToken !== '' ? envToken : ch.botToken,
      chatId: envChat !== '' ? envChat : ch.chatId
    }
    return next
  }

  // 当前生效配置访问器：store 现读 + env 合并 + --interval 临时覆盖（不写回）。
  // CLI --interval **最高优先**（启动参数意图）：热重载换盘上 pollIntervalSec 也
  // 压不过它——重载只改 store 内存值，本访问器每次都重新叠加 CLI 覆盖。
  const applyOverrides = (cfg: AppConfig): AppConfig => ({
    ...cfg,
    channels: mergeEnvTelegram(cfg.channels),
    ...(args.intervalSec !== null
      ? { pollIntervalSec: Math.max(MIN_POLL_INTERVAL_SEC, args.intervalSec) }
      : {})
  })
  const getEffective = (): AppConfig => applyOverrides(store.get())
  if (args.intervalSec !== null) {
    logger.info(
      `poll interval overridden by --interval: ${getEffective().pollIntervalSec}s (not persisted; survives config reload)`
    )
  }

  // ---- 三个 HttpClient：按 proxyScope 路由（telegram-only → site/ai 直连；D6） ----
  // R8-C：clients 是**可整体替换的槽位**（let）——所有闭包（adapter fetch /
  // notifier post / aiProvider post）经 `clients.xxx` 现取实例，rebuildDerived
  // 换新后旧闭包自动指向新 client；构造失败 fail-fast（启动期，退出码 1）。
  const mkClients = (cfg: AppConfig): ClientTriple => {
    const siteProxyUrl = cfg.proxyScope === 'all' ? cfg.proxyUrl : ''
    return {
      site: new HttpClient({ proxyUrl: siteProxyUrl }),
      tg: new HttpClient({ proxyUrl: cfg.proxyUrl }),
      ai: new HttpClient({ proxyUrl: siteProxyUrl, defaultTimeoutMs: 30_000 })
    }
  }
  let clients: ClientTriple
  try {
    clients = mkClients(getEffective())
  } catch (err) {
    logger.error(
      `invalid proxy url "${redactProxyUrl(getEffective().proxyUrl)}": ${err instanceof Error ? err.message : String(err)}`
    )
    logger.close()
    return 1
  }
  // rebuildDerived 的差异基准（构造参数即当前生效值）
  let lastSiteProxy = getEffective().proxyScope === 'all' ? getEffective().proxyUrl : ''
  let lastTgProxy = getEffective().proxyUrl

  // ---- adapter 工厂 + getSources 访问器（R4-W4，与 runtime.ts 同款） ------------
  // 按当前 config.sources 逐项构造（D3 访问器语义）：nodeseek/v2ex 按 id 惰性单例，
  // rss 按项实例、url/label 变更时重建。R8-C 起配置热重载：getSources 每轮现读
  // getEffective().sources（增删/启停来源即时生效），缓存形状与桌面装配一致；
  // fetch 闭包经 clients 槽位现取 client（proxy 热重建后旧 adapter 自动用新栈）。
  // --once 模式在 fetch 时点统计（此刻 seen 尚未被本轮 add 污染），去重键与
  // engine 同口径 `${sourceId}:${topic.id}`（D2）；多来源下 fetched/fresh 为
  // 全来源聚合求和（单来源时与旧口径一致）。
  let nodeseekAdapter: HtmlSourceAdapter | null = null
  const v2exAdapters = new Map<string, V2exSourceAdapter>()
  const rssAdapters = new Map<
    string,
    { url: string; label: string; adapter: RssSourceAdapter }
  >()
  let fetchedCount = 0
  let freshCount = 0
  const onceHits: HitRecord[] = []
  const buildAdapter = (s: SourceConfig): SourceAdapter => {
    if (s.type === 'nodeseek') {
      if (nodeseekAdapter === null) {
        nodeseekAdapter = new HtmlSourceAdapter({
          fetchHtml: (url, init) => clients.site.get(url, init)
        })
      }
      return nodeseekAdapter
    }
    if (s.type === 'v2ex') {
      let adapter = v2exAdapters.get(s.id)
      if (adapter === undefined) {
        adapter = new V2exSourceAdapter({
          fetchJson: (url, init) => clients.site.get(url, init),
          id: s.id
        })
        v2exAdapters.set(s.id, adapter)
      }
      return adapter
    }
    const cached = rssAdapters.get(s.id)
    if (cached !== undefined && cached.url === s.url && cached.label === (s.label ?? '')) {
      return cached.adapter
    }
    const adapter = new RssSourceAdapter({
      id: s.id,
      url: s.url,
      ...(s.label !== undefined ? { label: s.label } : {}),
      fetchFn: (url, init) => clients.site.get(url, init)
    })
    rssAdapters.set(s.id, { url: s.url, label: s.label ?? '', adapter })
    return adapter
  }
  const getSources = (): SourceAdapter[] => {
    const out: SourceAdapter[] = []
    for (const s of getEffective().sources) {
      if (!s.enabled) continue
      const adapter = buildAdapter(s)
      if (!args.once) {
        out.push(adapter)
        continue
      }
      out.push({
        id: adapter.id,
        name: adapter.name,
        // W3/D9：包装层必须透传能力声明，否则 --once 模式 engine 看不到
        // creationOrderedIds、旧帖过滤整段失效（R4-W4 泛化到全部 adapter 类型）
        creationOrderedIds: adapter.creationOrderedIds,
        fetchLatest: async () => {
          const topics = await adapter.fetchLatest()
          fetchedCount += topics.length
          freshCount += topics.filter((t) => !seen.has(`${adapter.id}:${t.id}`)).length
          return topics
        }
      })
    }
    return out
  }

  // R6-W4 多通道推送装配（与 runtime.ts 同款）：为就绪通道（isChannelReady）
  // 构造发送器，包 CompositeNotifier 做路由扇出。client 路由同 runtime：
  // telegram 走 tgClient（恒代理作用域），bark/ntfy/webhook 走 siteClient
  // （proxyScope='all' 才有代理，telegram-only 时直连）。R8-C 起通道集合可热变：
  // notifierImpl 是可替换槽位（let），engine/日报持有下方稳定壳；发送器凭据经
  // getConfig 每次**发送前**现读（channelById → getEffective），路由经 composite
  // 的 getRouting 现读——只有就绪通道集合变化才需要重建 composite。
  const channelById = (id: string) => getEffective().channels.find((ch) => ch.id === id)
  const buildNotifiers = (cfg: AppConfig): Notifier[] => {
    const post: FetchLike = (url, init) => clients.site.post(url, init)
    const out: Notifier[] = []
    for (const ch of cfg.channels) {
      if (!isChannelReady(ch)) continue
      if (ch.type === 'telegram') {
        out.push(
          new TelegramNotifier({
            id: ch.id,
            post: (url, init) => clients.tg.post(url, init),
            getConfig: () => {
              const cur = channelById(ch.id)
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
              const cur = channelById(ch.id)
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
              const cur = channelById(ch.id)
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
              const cur = channelById(ch.id)
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
  let notifierImpl = new CompositeNotifier(buildNotifiers(getEffective()), {
    getRouting: () => getEffective().routing
  })
  let lastReadyChannels = readyChannelSignature(getEffective())
  // 稳定壳（R8-C，与 runtime.ts 的 NotifierShell 同思路）：engine / 日报持有的
  // 引用永不变；rebuildDerived 换 notifierImpl 槽位，扇出集合即热替换。
  const notifier: Notifier = {
    get id(): string {
      return notifierImpl.id
    },
    sendHit: (input) => notifierImpl.sendHit(input),
    sendRaw: (text) => notifierImpl.sendRaw(text),
    sendTest: () => notifierImpl.sendTest()
  }

  // ---- AI 装配（D4/D5 + 第三轮锐评）：provider / evaluator / 锐评 / hits / 日报 -
  // provider 的 getConfig / post 均现读（getEffective / clients 槽位）——AI 配置
  // （baseUrl/apiKey/model）与代理热重载免重建 provider；evaluator / 锐评与
  // provider 的依赖关系不含配置快照，热重载无需重建。
  const aiProvider = new AiProvider({
    post: (url, init) => clients.ai.post(url, init),
    getConfig: () => getEffective().ai.provider
  })
  // R7-W4（DEC-5，与 runtime.ts 同款）：<dir>/feedback.json + evaluator 构造注入
  // getFeedbackExamples（每次评估现读；headless 无 IPC，反馈文件可手工编辑）
  const feedbackStore = new FileFeedbackStore({ dataDir: dir })
  const evaluator = new SemanticEvaluator({
    provider: aiProvider,
    getFeedbackExamples: () => feedbackStore.recentForPrompt()
  })
  // 锐评生成器与 evaluator 共用同一 provider 实例；provider 未配置时由
  // engine 的闸拦下（装配层无需判断，与 evaluator 同款无条件注入风格）
  const commentaryGenerator = new CommentGenerator({ provider: aiProvider })
  const hitsStore = new HitsStore(join(dir, HITS_DIR_NAME))
  const reportService = new DailyReportService({
    provider: aiProvider,
    hits: hitsStore,
    notifier: { sendRaw: (text) => notifier.sendRaw(text) },
    getConfig: () => getEffective(),
    logger,
    reportsDir: join(dir, 'reports')
  })

  const seen = new FileSeenStore(
    join(dir, 'seen.json'),
    // seen 容量随来源数扩容（ultrabrain 坑12）；容量构造期定死（既有语义，R8-C
    // 不动）：热重载增删来源后下次重启生效，不为它重构 engine deps
    seenCapacityForSources(getEffective().sources.length)
  )
  seen.load()
  // 处置流水（R7-W1，与 runtime.ts 同款）：<dir>/pipeline/<date>.jsonl + 内存环
  const dispositions = new DispositionStore({ dataDir: join(dir, PIPELINE_DIR_NAME) })
  const engineState = new FileEngineState(join(dir, 'state.json'))
  engineState.load()

  // ---- 热重载副作用（R8-C，对齐桌面 applyConfigSideEffects 的差异重建思路） ------
  // 只在配置**真正变化**的键相关时动作，避免无关重载（如只改关键词）无谓中断
  // 在途请求（close 旧 client 会中断其上在途请求，与桌面 setProxy 同款代价）：
  // - proxyUrl / proxyScope 变 → 三 client 整体重建（close 旧 + 建新；槽位替换，
  //   adapter / notifier / provider 的闭包自动用新栈）；ai 与 site 同代理值
  //   （proxyScope='all' 才带），一并重建；
  // - 就绪通道集合（readyChannelSignature）变 → 重建 composite notifier
  //   （凭据/启停/路由都现读，不需重建）；旧 composite 无 close/destroy，丢弃即可。
  // 单项失败只记日志（非法代理 → 该 client 直连兜底），不阻断其余项。
  const mkClientsSafely = (cfg: AppConfig): ClientTriple => {
    const one = (proxyUrl: string, label: string, defaultTimeoutMs?: number): HttpClient => {
      try {
        return new HttpClient({ proxyUrl, ...(defaultTimeoutMs !== undefined ? { defaultTimeoutMs } : {}) })
      } catch (err) {
        logger.error(
          `invalid ${label} proxy url "${redactProxyUrl(proxyUrl)}", falling back to direct: ` +
            `${err instanceof Error ? err.message : String(err)}`
        )
        return new HttpClient(defaultTimeoutMs !== undefined ? { defaultTimeoutMs } : {})
      }
    }
    const siteProxyUrl = cfg.proxyScope === 'all' ? cfg.proxyUrl : ''
    return {
      site: one(siteProxyUrl, 'site'),
      tg: one(cfg.proxyUrl, 'telegram'),
      ai: one(siteProxyUrl, 'ai', 30_000)
    }
  }
  const rebuildDerived = (eff: AppConfig): void => {
    const siteProxy = eff.proxyScope === 'all' ? eff.proxyUrl : ''
    if (siteProxy !== lastSiteProxy || eff.proxyUrl !== lastTgProxy) {
      const old = clients
      clients = mkClientsSafely(eff)
      old.site.close()
      old.tg.close()
      old.ai.close()
      lastSiteProxy = siteProxy
      lastTgProxy = eff.proxyUrl
      logger.info(
        `proxy clients rebuilt (site/ai=${redactProxyUrl(siteProxy) || 'direct'} ` +
          `tg=${redactProxyUrl(eff.proxyUrl) || 'direct'} scope=${eff.proxyScope})`
      )
    }
    const signature = readyChannelSignature(eff)
    if (signature !== lastReadyChannels) {
      notifierImpl = new CompositeNotifier(buildNotifiers(eff), {
        getRouting: () => getEffective().routing
      })
      lastReadyChannels = signature
      logger.info(`notify fan-out rebuilt (ready channels: [${signature}] or none)`)
    }
    // Telegram 遥控对齐（R9-W1）：enabled × telegram 凭据就绪变化 → start/stop
    // （controller 在常驻模式才有；--once 已早退不会走到 rebuildDerived）
    alignRemoteControl(eff)
  }

  // ---- watch 回调：重读盘 → diff 顶层键 → 无变化静默（seen/state 等无关写入） ---
  const onConfigDirChanged = (): void => {
    try {
      const nextDisk = store.load() // 损坏容错：备份 + 默认配置，不抛（ADR 3）
      const changed = diffTopLevelKeys(diskConfig, nextDisk)
      if (changed.length === 0) return
      // diff 只对盘上配置做；env / CLI 覆盖是常量叠加（applyOverrides 每次现算）
      diskConfig = nextDisk
      rebuildDerived(applyOverrides(nextDisk))
      logger.info(`config reloaded (key changes: ${changed.join(', ')})`)
    } catch (err) {
      logger.error(`config reload failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  let engine!: MonitorEngine
  let lastStatusLine = ''
  const printStatus = (s: EngineStatus): void => {
    const line =
      `desired=${s.desired} health=${s.health} nextPollAt=${s.nextPollAt ?? '-'} totalHits=${s.totalHits} ` +
      `ai=${s.ai.effectiveMode}/${s.ai.degraded}`
    if (line === lastStatusLine) return
    lastStatusLine = line
    console.log(`${new Date().toISOString()} status: ${line}`)
  }

  const scheduler = new PollScheduler({
    // 构造期初值；此后 engine 每轮 finishRound 按当时 getConfig().pollIntervalSec
    // 调 setIntervalSec——热重载改间隔在下一轮排程自然生效（CLI --interval 经
    // getEffective 叠加，仍最高优先）
    intervalSec: getEffective().pollIntervalSec,
    onTick: () => engine.pollOnce(),
    onScheduled: (nextPollAtMs) => engine.noteScheduled(nextPollAtMs)
  })

  engine = new MonitorEngine({
    getSources,
    // R5-P2a：per-source 过滤访问器（R8-C 起热重载现读 getEffective）
    getSourceFilters: (sourceId) =>
      getEffective().sources.find((s) => s.id === sourceId)?.filters,
    seen,
    state: engineState,
    notifier,
    // 热更新（R8-C）：闭包每次现读 store（+env/CLI 覆盖），watch 重载后下一轮生效
    getConfig: () => getEffective(),
    scheduler,
    logger,
    semanticEvaluator: evaluator,
    commentaryGenerator,
    hitsStore,
    dispositions,
    onStatus: printStatus,
    ...(args.once ? { onHit: (h: HitRecord) => onceHits.push(h) } : {})
  })

  // ---- --once：单轮后打印统计并退出（跳过日报；不起 watch：单轮语义） -----------
  if (args.once) {
    await engine.pollOnce()
    const st = engine.getStatus()
    const notified = onceHits.filter((h) => h.notifiedAt !== null).length
    const failed = onceHits.filter((h) => h.notifyError !== null).length
    const muted = onceHits.length - notified - failed
    console.log(
      `once summary: fetched=${fetchedCount} fresh=${freshCount} hits=${onceHits.length} ` +
        `notified=${notified} failed=${failed} muted-or-unconfigured=${muted} ` +
        `ai=mode:${st.ai.effectiveMode}/degraded:${st.ai.degraded}/calls:${st.ai.callsToday}`
    )
    clients.site.close()
    clients.tg.close()
    clients.ai.close()
    // 给日志 appendFile 一拍落盘再退出（尾部丢失本可容忍，尽量保住）
    await new Promise((r) => setTimeout(r, 100))
    logger.close()
    // 退出码语义：仅抓取本身失败（backoff/challenged）为 1；telegram 未配置/推送失败均 0
    return st.health === 'ok' ? 0 : 1
  }

  // ---- 常驻模式 ------------------------------------------------------------
  engine.start()
  logger.info(
    `engine started (dir=${dir} interval=${getEffective().pollIntervalSec}s ` +
      `keywords=${getEffective().includeKeywords.length}in/${getEffective().excludeKeywords.length}out ` +
      `proxy=${redactProxyUrl(getEffective().proxyUrl) || 'direct'} scope=${getEffective().proxyScope})`
  )

  // ---- Telegram 遥控（R9-W1，与 runtime.ts 同款接线） --------------------------
  // post 经 clients.tg 槽位现取（proxy 热重建后自动用新栈）；getEnabled/
  // getCredentials 每轮循环现读 getEffective（env 凭据注入同样生效）；翻 false/
  // 凭据失效由 controller 自退，翻 true 由 rebuildDerived（热重载）在这里对齐。
  // 生命周期独立于 engine desired（坑8 第二条）；--once 模式不接（进程即退）。
  const botCommands = new BotCommandController({
    getEnabled: () => {
      const rc = getEffective().notify.remoteControl
      return { enabled: rc.enabled, allowedChatIds: rc.allowedChatIds }
    },
    getCredentials: () => {
      const creds = telegramCredentialsOf(getEffective().channels)
      return creds.botToken !== '' && creds.chatId !== '' ? creds : null
    },
    post: (url, init) => clients.tg.post(url, init),
    getStatus: () => engine.getStatus(),
    pause: () => engine.pause(),
    resume: () => engine.resume(),
    runNow: () => engine.runNow(),
    log: logger
  })
  const alignRemoteControl = (eff: AppConfig): void => {
    const creds = telegramCredentialsOf(eff.channels)
    const shouldRun =
      eff.notify.remoteControl.enabled && creds.botToken !== '' && creds.chatId !== ''
    if (shouldRun) {
      if (!botCommands.isRunning) botCommands.start()
    } else if (botCommands.isRunning) {
      botCommands.stop()
    }
  }
  alignRemoteControl(getEffective())

  // 配置热重载 watch（R8-C）：监听 <dir>（macOS rename 换 inode，盯目录才不丢），
  // 500ms 去抖；回调内自行 diff，seen/state 等无关写入不触发重载动作。
  const watcher: ConfigDirWatcher = watchConfigDir(dir, onConfigDirChanged)
  logger.info(`config watch started (dir=${dir}, edit ${configPath} to hot-reload)`)

  // 日报自循环定时器（D5，与桌面 runtime 同款）：sleep = clamp(nextCheckAt-now, 60s, 30min)
  let reportTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const scheduleReportTimer = (): void => {
    if (stopped) return
    const sleep = Math.min(
      30 * 60_000,
      Math.max(60_000, reportService.nextCheckAt() - Date.now())
    )
    reportTimer = setTimeout(() => {
      void reportService
        .tick(engine.getStatus().desired === 'running')
        .then((ran) => {
          if (ran) logger.info('daily report generated by timer tick')
        })
        .catch((err: unknown) => {
          logger.error(`daily report tick failed: ${err instanceof Error ? err.message : String(err)}`)
        })
        .finally(scheduleReportTimer)
    }, sleep)
  }
  scheduleReportTimer()
  logger.info(
    `daily report timer started (timeHHMM=${getEffective().ai.dailyReport.timeHHMM} ` +
      `enabled=${getEffective().ai.dailyReport.enabled})`
  )

  const shutdown = (reason: string): void => {
    if (stopped) return
    stopped = true
    console.log(`${new Date().toISOString()} shutting down (${reason})`)
    watcher.close() // 先停热重载：退出路径不再触发重载动作
    if (reportTimer !== null) clearTimeout(reportTimer)
    botCommands.stop() // 显式停遥控长轮询（坑8：退出不留悬挂的 getUpdates 消费者）
    engine.pause()
    void (async () => {
      try {
        await seen.flush()
      } finally {
        clients.site.close()
        clients.tg.close()
        clients.ai.close()
        logger.close()
        process.exit(0)
      }
    })()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  if (args.durationSec !== null) {
    setTimeout(() => shutdown(`--duration ${args.durationSec}s elapsed`), args.durationSec * 1000)
  }
  return null // 常驻由 scheduler / 日报计时器保活
}

void main().then(
  (code) => {
    if (code !== null) process.exit(code)
  },
  (err) => {
    console.error('fatal:', err)
    process.exit(1)
  }
)
