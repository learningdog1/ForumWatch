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
 * 目录结构 `<dir>/{config.json, seen.json, state.json, hits/, reports/, logs/}`；
 * 首次运行生成默认 config.json（chmod 600 由 ConfigStore 保证）并提示填写关键词与
 * telegram。环境变量 `NSM_BOT_TOKEN` / `NSM_CHAT_ID` 可快速注入 telegram 凭据
 * （只进内存不落盘）。
 *
 * AI 能力（D4/D5，与桌面装配方同款接线）：第三 aiClient（defaultTimeoutMs 30s，
 * proxyScope='all' 时走代理）→ AiProvider / SemanticEvaluator / HitsStore /
 * DailyReportService（reportsDir=<dir>/reports）；engine deps 注入 evaluator +
 * hitsStore。常驻模式起日报自循环定时器（sleep ∈ [60s, 30min]，复用 nextCheckAt）；
 * `--once` 模式跳过日报（单轮冒烟不产文件、不推送）。
 *
 * 限制（有意为之）：配置为启动时快照，headless 不做热更新（桌面装配方经 IPC 负责）；
 * 改配置请重启进程。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ConfigStore, MIN_POLL_INTERVAL_SEC } from '../src/main/config/store'
import { HttpClient, redactProxyUrl } from '../src/main/net/http'
import { AiProvider } from '../src/main/ai/provider'
import { SemanticEvaluator } from '../src/main/ai/evaluator'
import { DailyReportService } from '../src/main/ai/daily-report'
import { FileSeenStore } from '../src/main/monitor/dedup'
import { MonitorEngine } from '../src/main/monitor/engine'
import { HitsStore, HITS_DIR_NAME } from '../src/main/monitor/hits-store'
import { PollScheduler } from '../src/main/monitor/poller'
import { HtmlSourceAdapter } from '../src/main/monitor/sources/html'
import { FileEngineState } from '../src/main/monitor/state'
import type { SourceAdapter } from '../src/main/monitor/types'
import { TelegramNotifier } from '../src/main/notify/telegram'
import { createLogger } from '../src/main/logger'
import type { AppConfig, EngineStatus, HitRecord } from '../src/shared/types'

const USAGE = `usage: npm run engine:headless -- [--config <dir>] [--once] [--duration <sec>] [--interval <sec>]
  --config <dir>     数据目录（config/seen/state/logs），默认 ./data/headless
  --once             跑一轮后退出（打印本轮统计；抓取失败才退出码 1）
  --duration <sec>   运行指定秒数后优雅退出（默认直到 Ctrl-C）
  --interval <sec>   临时覆盖轮询间隔（钳到 >=15s），不写回配置
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
  const configPath = join(dir, 'config.json')
  const store = new ConfigStore(configPath)
  const firstRun = !existsSync(configPath)
  const diskConfig = store.load()
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

  const effective: AppConfig = {
    ...diskConfig,
    telegram: {
      botToken: envToken !== '' ? envToken : diskConfig.telegram.botToken,
      chatId: envChat !== '' ? envChat : diskConfig.telegram.chatId
    },
    ...(args.intervalSec !== null
      ? { pollIntervalSec: Math.max(MIN_POLL_INTERVAL_SEC, args.intervalSec) }
      : {})
  }
  if (args.intervalSec !== null) {
    logger.info(`poll interval overridden by --interval: ${effective.pollIntervalSec}s (not persisted)`)
  }

  // ---- 三个 HttpClient：按 proxyScope 路由（telegram-only → site/ai 直连；D6） ----
  const siteProxyUrl = effective.proxyScope === 'all' ? effective.proxyUrl : ''
  let siteClient: HttpClient
  let tgClient: HttpClient
  let aiClient: HttpClient
  try {
    siteClient = new HttpClient({ proxyUrl: siteProxyUrl })
    tgClient = new HttpClient({ proxyUrl: effective.proxyUrl })
    aiClient = new HttpClient({ proxyUrl: siteProxyUrl, defaultTimeoutMs: 30_000 })
  } catch (err) {
    logger.error(
      `invalid proxy url "${redactProxyUrl(effective.proxyUrl)}": ${err instanceof Error ? err.message : String(err)}`
    )
    logger.close()
    return 1
  }

  const source = new HtmlSourceAdapter({ fetchHtml: (url, init) => siteClient.get(url, init) })
  const notifier = new TelegramNotifier({
    post: (url, init) => tgClient.post(url, init),
    getConfig: () => effective.telegram
  })

  // ---- AI 装配（D4/D5）：provider / evaluator / hits / 日报服务 ----------------
  const aiProvider = new AiProvider({
    post: (url, init) => aiClient.post(url, init),
    getConfig: () => effective.ai.provider
  })
  const evaluator = new SemanticEvaluator({ provider: aiProvider })
  const hitsStore = new HitsStore(join(dir, HITS_DIR_NAME))
  const reportService = new DailyReportService({
    provider: aiProvider,
    hits: hitsStore,
    notifier: { sendRaw: (text) => notifier.sendRaw(text) },
    getConfig: () => effective,
    logger,
    reportsDir: join(dir, 'reports')
  })

  const seen = new FileSeenStore(join(dir, 'seen.json'))
  seen.load()
  const engineState = new FileEngineState(join(dir, 'state.json'))
  engineState.load()

  // ---- getSources 访问器：每轮按 config.sources 过滤 enabled（D3） ------------
  // v2 仅 nodeseek 一个 adapter；未注册 id log warn 跳过。--once 模式在 fetch
  // 时点统计（此刻 seen 尚未被本轮 add 污染），去重键与 engine 同口径
  // `${sourceId}:${topic.id}`（D2）。
  let fetchedCount = 0
  let freshCount = 0
  const onceHits: HitRecord[] = []
  const getSources = (): SourceAdapter[] => {
    const out: SourceAdapter[] = []
    for (const s of effective.sources) {
      if (!s.enabled) continue
      if (s.id !== source.id) {
        logger.warn(`no adapter registered for source "${s.id}", skipping`)
        continue
      }
      if (!args.once) {
        out.push(source)
        continue
      }
      out.push({
        id: source.id,
        name: source.name,
        // W3：包装层必须透传能力声明，否则 --once 模式 engine 看不到
        // creationOrderedIds、旧帖过滤整段失效
        creationOrderedIds: source.creationOrderedIds,
        fetchLatest: async () => {
          const topics = await source.fetchLatest()
          fetchedCount = topics.length
          freshCount = topics.filter((t) => !seen.has(`${source.id}:${t.id}`)).length
          return topics
        }
      })
    }
    return out
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
    intervalSec: effective.pollIntervalSec,
    onTick: () => engine.pollOnce(),
    onScheduled: (nextPollAtMs) => engine.noteScheduled(nextPollAtMs)
  })

  engine = new MonitorEngine({
    getSources,
    seen,
    state: engineState,
    notifier,
    getConfig: () => effective,
    scheduler,
    logger,
    semanticEvaluator: evaluator,
    hitsStore,
    onStatus: printStatus,
    ...(args.once ? { onHit: (h: HitRecord) => onceHits.push(h) } : {})
  })

  // ---- --once：单轮后打印统计并退出（跳过日报：冒烟不产文件不推送） -----------
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
    siteClient.close()
    tgClient.close()
    aiClient.close()
    // 给日志 appendFile 一拍落盘再退出（尾部丢失本可容忍，尽量保住）
    await new Promise((r) => setTimeout(r, 100))
    logger.close()
    // 退出码语义：仅抓取本身失败（backoff/challenged）为 1；telegram 未配置/推送失败均 0
    return st.health === 'ok' ? 0 : 1
  }

  // ---- 常驻模式 ------------------------------------------------------------
  engine.start()
  logger.info(
    `engine started (dir=${dir} interval=${effective.pollIntervalSec}s ` +
      `keywords=${effective.includeKeywords.length}in/${effective.excludeKeywords.length}out ` +
      `proxy=${redactProxyUrl(effective.proxyUrl) || 'direct'} scope=${effective.proxyScope})`
  )

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
    `daily report timer started (timeHHMM=${effective.ai.dailyReport.timeHHMM} ` +
      `enabled=${effective.ai.dailyReport.enabled})`
  )

  const shutdown = (reason: string): void => {
    if (stopped) return
    stopped = true
    console.log(`${new Date().toISOString()} shutting down (${reason})`)
    if (reportTimer !== null) clearTimeout(reportTimer)
    engine.pause()
    void (async () => {
      try {
        await seen.flush()
      } finally {
        siteClient.close()
        tgClient.close()
        aiClient.close()
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
