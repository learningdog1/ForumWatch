/**
 * Telegram Bot 双向遥控内核（R9-W1，DEC-6 + 坑8 三条接线纪律）。
 *
 * 通过 bot 的 getUpdates 长轮询接收指令（/status /pause /resume /poll /help），
 * 用 sendMessage 回复——远程暂停/恢复/补一轮监控，手机上即可操作。
 *
 * 坑8 三条纪律（违反任何一条都会出事）：
 * 1. **绝不进 TelegramNotifier 的 1050ms 串行队列**：长轮询 getUpdates 一挂
 *   25s，进了 enqueue 会把命中推送全部堵死。本模块用自己的 post 直调
 *   Telegram API，与推送通道完全独立；
 * 2. **controller 生命周期独立于 engine desired**：/pause /resume 只翻转
 *   engine 的 desired，绝不停本监听循环——暂停了才更需要 /resume 遥控回来；
 * 3. **409 的两个来源都要处理**：启动先 deleteWebhook（drop_pending_updates=
 *   false，清掉历史 webhook 设置；失败仅 warn 不阻塞）；运行中 getUpdates
 *   返回 409（另一个实例/工具在轮询同一 bot）→ log error（同消息 5 分钟去重）
 *   + sleep 60s 退避重试，不崩不退出。
 *
 * 其他契约：
 * - **allowlist 硬闸**：message.chat.id 不在 allowedChatIds（字符串精确比较，
 *   负数群 id 原样合法）且不等于当前主 Chat ID（getCredentials 的 chatId，
 *   隐含允许）→ 完全忽略（不回复），log warn 一分钟去重。未授权会话得不到
 *   任何回声，无法探测 bot 存活。
 *   注意 Telegram 的 chat.id 恒为数字（私聊正整数、群组 -100 开头负数），配置里
 *   填 @username 之类非数字值永远无法与数字字符串精确相等——start 时对这类值
 *   warn 一次提示（不改变匹配行为；chatId 不是秘密，warn 原样带值便于排查）。
 * - offset 内存推进，不持久化：重启从 0 重新拉（getUpdates 无 offset 返回
 *   最新一批，够用）。
 * - 运行中配置现读（getEnabled / getCredentials 每轮循环重读）：enabled 翻
 *   false 或凭据失效 → 循环自动退出（log info）；翻 true 由装配方经
 *   applyConfigSideEffects 对齐（controller 无法自举发现开启）。
 * - 网络 post 由外部注入（FetchLike，生产传 tgClient 封装）；now / sleep 可
 *   注入，单测用假时钟不真睡。零 electron 依赖（ADR 2）。
 * - 非 message 更新（edited_message / callback_query 等）与非指令文本一律忽略；
 *   未知指令回复提示（区别于静默忽略的普通文本）。群聊里 `/cmd@botname` 后缀
 *   剥离后按裸指令匹配。
 */

import type { FetchLike, HttpRequestInit, HttpResponse } from '../net/http-types'
import type { EngineStatus } from '../../shared/types'

/** getUpdates 长轮询的服务端挂起秒数（Telegram 上限 50，取 25 折中） */
export const LONG_POLL_TIMEOUT_SEC = 25
/** getUpdates 请求的整体 HTTP 超时：长轮询 25s + 10s 网络余量 */
export const LONG_POLL_HTTP_TIMEOUT_MS = 35_000
/** 409 / 网络失败 / 非 2xx 的退避间隔（坑8 第三条：不崩不退出，睡 60s 再试） */
export const POLL_ERROR_BACKOFF_MS = 60_000
/** 未授权会话 warn 的去重窗（1 分钟内同消息只 log 一次） */
export const ALLOWLIST_WARN_DEDUP_MS = 60_000
/** 409 错误 log 的去重窗（仿 pendingNotifyErrors：同错误消息 5 分钟只 log 一次） */
export const CONFLICT_LOG_DEDUP_MS = 5 * 60_000

/** controller 依赖的最小日志面（Logger 结构子集，便于单测注入收集器） */
export interface BotCommandLogger {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
}

export interface BotCommandControllerDeps {
  /** 遥控开关与允许清单（每轮循环现读，配置热更新语义） */
  getEnabled: () => { enabled: boolean; allowedChatIds: string[] }
  /** 第一个就绪 telegram 通道的凭据；null = 无就绪通道（循环自动退出） */
  getCredentials: () => { botToken: string; chatId: string } | null
  /** Telegram API 调用（生产传 tgClient 封装；绝不进 TelegramNotifier 的队列） */
  post: FetchLike
  /** 引擎实时状态快照（/status 文案组装） */
  getStatus: () => EngineStatus
  /** /pause：翻转 desired（不停本监听循环——坑8 第二条） */
  pause: () => void
  /** /resume：翻转 desired 并补一轮 */
  resume: () => void
  /** /poll：立即补一轮（engine.runNow 内部尊重 desired，暂停期 no-op） */
  runNow: () => Promise<void> | void
  log: BotCommandLogger
  /** 测试注入假时钟（epoch ms）；默认 Date.now */
  now?: () => number
  /** 测试注入假 sleep；默认真睡 setTimeout */
  sleep?: (ms: number) => Promise<void>
}

/** Telegram getUpdates 返回的单条更新（本模块只消费 message.text + chat.id） */
interface TgUpdate {
  update_id: number
  message?: { chat?: { id?: unknown }; text?: unknown }
}

/** Telegram chat id 的合法形态：数字字符串（私聊正数 / 群组 -100 开头负数） */
const NUMERIC_CHAT_ID_RE = /^-?\d+$/

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

/** 指令解析结果：'/status@fw_bot 参数' → 'status'；非指令文本 / 空指令 → null */
export function parseCommandName(text: string): string | null {
  if (!text.startsWith('/')) return null
  const firstToken = text.slice(1).split(/\s+/, 1)[0] ?? ''
  // 群聊里指令带 @botname 后缀（/status@fw_bot）：剥掉再匹配
  const name = firstToken.split('@', 1)[0].toLowerCase()
  return name === '' ? null : name
}

/** /status 文案（中文紧凑，从 EngineStatus 组装；导出供单测直测文案） */
export function formatStatusReply(s: EngineStatus): string {
  const desiredText = s.desired === 'paused' ? '已暂停' : '运行中'
  const healthText =
    s.health === 'ok' ? '正常' : s.health === 'backoff' ? '失败退避中' : 'CF 挑战中'
  const nextText =
    s.desired === 'paused'
      ? '—（已暂停）'
      : s.nextPollAt === null
        ? '未排程'
        : formatDateTime(s.nextPollAt)
  const modeText =
    s.ai.effectiveMode === 'literal'
      ? '字面'
      : s.ai.effectiveMode === 'semantic'
        ? '语义'
        : '字面+语义'
  const degradedText =
    s.ai.degraded === 'unconfigured'
      ? '（Provider 未配置，已降级字面）'
      : s.ai.degraded === 'quota-exhausted'
        ? '（当日配额耗尽，已降级字面）'
        : ''
  return [
    '📊 ForumWatch 状态',
    `引擎: ${desiredText} · 健康: ${healthText}`,
    `下次轮询: ${nextText}`,
    `累计命中: ${s.totalHits} · 挂起待推: ${s.pendingNotifyCount ?? 0} 条`,
    `AI 模式: ${modeText}${degradedText}`
  ].join('\n')
}

/** ISO → 本地 'MM-DD HH:MM:SS'（无法解析时原样返回） */
function formatDateTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const d = new Date(t)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** /help 文案 */
const HELP_REPLY = [
  'ℹ️ ForumWatch 遥控指令：',
  '/status — 查看运行状态',
  '/pause — 暂停监控',
  '/resume — 恢复监控',
  '/poll — 立即轮询一轮',
  '/help — 显示本帮助'
].join('\n')

/** 409 错误文案（坑8 第三条；同消息 5 分钟去重 emit） */
const CONFLICT_ERROR_MESSAGE =
  'telegram getUpdates returned 409: bot 正被其他 getUpdates 消费者占用' +
  '（例如你自己在跑另一个实例或设过 webhook）；60s 后自动重试。' +
  '若你同时用其他工具轮询同一 bot，请停掉一边。'

export class BotCommandController {
  private readonly deps: BotCommandControllerDeps
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  /** 运行标志（stop / 配置失效置 false；循环每轮检查） */
  private running = false
  /** 运行代次号：防止 stop→start 快速切换后旧循环借新标志复活（双循环） */
  private runSeq = 0
  /** 当前运行的 AbortController（stop 时 abort 在途长轮询） */
  private abort: AbortController | null = null
  /** 当前（或最近一次）循环的 settle promise；stop 后等待退出用 */
  private loopDone: Promise<void> = Promise.resolve()
  /** getUpdates offset（内存推进，不持久化） */
  private offset = 0
  /** 去重日志的上次 emit 时刻（消息 → epoch ms；409 5min / 未授权 warn 1min） */
  private readonly dedupLast = new Map<string, number>()

  constructor(deps: BotCommandControllerDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
    this.sleep =
      deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  }

  /** 循环是否在跑（装配方对齐 start/stop 的判定面） */
  get isRunning(): boolean {
    return this.running
  }

  /**
   * 启动指令监听。enabled=false 或凭据缺失 → **noop**（不 log、不发请求）。
   * 已在运行 → 幂等 noop。启动流程：非数字 chat id 配置告警（warn，不改匹配
   * 行为）→ deleteWebhook（清历史 webhook，坑8 第三条的另一半来源；失败仅
   * warn）→ 长轮询循环。
   */
  start(): void {
    if (this.running) return
    if (!this.deps.getEnabled().enabled) return
    const creds = this.deps.getCredentials()
    if (creds === null) return
    this.warnNonNumericChatIds(creds)
    this.running = true
    this.offset = 0
    this.dedupLast.clear()
    this.abort = new AbortController()
    const myRun = ++this.runSeq
    this.loopDone = this.loop(myRun)
    this.deps.log.info('telegram remote control started (long-polling getUpdates)')
  }

  /**
   * 停止：abort 在途长轮询 + 置 running=false（循环在下一个检查点退出）。
   * 幂等。同步返回（不等待循环排干——退出路径不因网络挂起而卡住）。
   */
  stop(): void {
    if (!this.running) return
    this.running = false
    this.abort?.abort()
    this.abort = null
    this.deps.log.info('telegram remote control stopped')
  }

  /** 等待当前循环退出（测试/优雅关闭用；未运行时立即 resolve） */
  waitStopped(): Promise<void> {
    return this.loopDone
  }

  // ---- 内部实现 ----------------------------------------------------------

  /**
   * 非数字 chat id 配置告警（启动时一次）：Telegram 的 chat.id 恒为数字字符串，
   * allowlist 按字符串精确比较，@username / 别名之类的值永远无法命中——配置侧
   * 静默失效，这里 warn 提示排查（不改变匹配行为；chatId 不是秘密，原样带值）。
   */
  private warnNonNumericChatIds(creds: { chatId: string }): void {
    const mainChatId = creds.chatId.trim()
    if (mainChatId !== '' && !NUMERIC_CHAT_ID_RE.test(mainChatId)) {
      this.deps.log.warn(
        `telegram remote control: chatId "${mainChatId}" 不是数字 id（私聊为正数、群组为 -100 开头负数），` +
          '可能与 allowlist 的字符串精确比较永远无法命中'
      )
    }
    for (const raw of this.deps.getEnabled().allowedChatIds) {
      const id = raw.trim()
      if (id !== '' && !NUMERIC_CHAT_ID_RE.test(id)) {
        this.deps.log.warn(
          `telegram remote control: allowedChatIds 含非数字 id "${id}"（chat.id 恒为数字，` +
            '字符串精确比较永远无法命中；应填数字 id，群组为 -100 开头）'
        )
      }
    }
  }

  /** 主循环：每轮现读配置（enabled/凭据失效自动退出）→ getUpdates → 逐条处理 */
  private async loop(myRun: number): Promise<void> {
    const alive = (): boolean => this.running && this.runSeq === myRun
    // 本轮运行的 AbortController（start() 刚创建）：整个循环生命周期共用——
    // stop() 置 this.abort=null 后，退避 sleep 仍能经它立即解除（不能每处现读
    // this.abort，否则 stop 后的 sleepOrAbort 拿不到信号真睡满 60s）。
    const abort = this.abort as AbortController

    try {
      await this.runLoop(alive, abort)
    } finally {
      // 自然退出（配置失效）也必须落 running=false：否则装配方按 isRunning 对齐
      // 时会误判"还在跑"，翻 true 后不再 start（遥控从此哑掉）。被新 run 取代
      // （stop→start 快速切换）时不动新 run 的标志。
      if (this.runSeq === myRun) this.running = false
    }
  }

  private async runLoop(alive: () => boolean, abort: AbortController): Promise<void> {
    // 坑8 第三条（前半）：先清可能存在的历史 webhook，否则 getUpdates 恒 409。
    // 失败仅 warn——webhook 本就不存在时 Telegram 也返回 ok，真失败不值得阻塞。
    await this.deleteWebhookSafely(abort.signal)
    if (!alive()) return

    while (alive()) {
      // 配置热更新语义：每轮现读。enabled 翻 false / 凭据失效 → 自动退出
      // （翻 true 由装配方 applyConfigSideEffects 触发 start，不自举）。
      const enabledCfg = this.deps.getEnabled()
      const creds = this.deps.getCredentials()
      if (!enabledCfg.enabled || creds === null) {
        this.deps.log.info(
          'telegram remote control: disabled or credentials missing — listener exiting'
        )
        break
      }

      let res: HttpResponse
      try {
        res = await this.deps.post(this.getUpdatesUrl(creds.botToken), {
          method: 'POST',
          signal: abort.signal,
          timeoutMs: LONG_POLL_HTTP_TIMEOUT_MS
        })
      } catch (err) {
        if (!alive()) break // stop() abort 在途请求：正常退出路径
        this.dedupLog('warn', `getUpdates request failed: ${describeError(err)}（60s 后重试）`)
        await this.sleepInterruptible(abort.signal, POLL_ERROR_BACKOFF_MS)
        continue
      }

      if (res.status === 409) {
        // 坑8 第三条：同错误消息 5 分钟只 log 一次；期间继续退避轮询，不崩不退出
        this.dedupLog('error', CONFLICT_ERROR_MESSAGE, CONFLICT_LOG_DEDUP_MS)
        await this.sleepInterruptible(abort.signal, POLL_ERROR_BACKOFF_MS)
        continue
      }
      if (res.status < 200 || res.status >= 300) {
        this.dedupLog(
          'warn',
          `getUpdates failed: HTTP ${res.status}: ${clip(res.body)}（60s 后重试）`
        )
        await this.sleepInterruptible(abort.signal, POLL_ERROR_BACKOFF_MS)
        continue
      }

      let updates: TgUpdate[]
      try {
        const parsed = JSON.parse(res.body) as { ok?: boolean; result?: TgUpdate[] }
        if (parsed.ok !== true || !Array.isArray(parsed.result)) {
          throw new Error('unexpected getUpdates payload')
        }
        updates = parsed.result
      } catch (err) {
        this.dedupLog(
          'warn',
          `getUpdates payload parse failed: ${describeError(err)}（60s 后重试）`
        )
        await this.sleepInterruptible(abort.signal, POLL_ERROR_BACKOFF_MS)
        continue
      }

      // 允许清单：配置列表 + 主 chatId 隐含（每轮现读，热更新）
      const allowed = new Set(enabledCfg.allowedChatIds)
      allowed.add(creds.chatId.trim())

      let maxUpdateId = 0
      for (const u of updates) {
        if (typeof u.update_id === 'number' && u.update_id > maxUpdateId) {
          maxUpdateId = u.update_id
        }
        try {
          await this.handleUpdate(u, allowed, creds.botToken)
        } catch (err) {
          // 单条处理失败不中断整轮（offset 已推进，下轮继续）
          this.deps.log.warn(
            `bot update handling failed (update_id=${u.update_id}): ${describeError(err)}`
          )
        }
      }
      // offset 推进：max(update_id)+1；处理失败的更新也确认（防毒丸更新死循环）
      if (maxUpdateId > 0) this.offset = maxUpdateId + 1
    }
  }

  /** 单条更新：只认 message.text；allowlist 硬闸；指令分派；回复 sendMessage */
  private async handleUpdate(
    u: TgUpdate,
    allowed: Set<string>,
    botToken: string
  ): Promise<void> {
    const text = typeof u.message?.text === 'string' ? u.message.text : undefined
    if (text === undefined) return // edited_message / callback / 无文本：忽略
    const chatId = u.message?.chat?.id
    if (typeof chatId !== 'number') return
    const chatIdStr = String(chatId)

    if (!allowed.has(chatIdStr)) {
      // 硬闸：不回复（未授权会话得不到任何回声）；warn 一分钟去重
      this.dedupLog(
        'warn',
        `bot command ignored: chat ${chatIdStr} not in allowlist`,
        ALLOWLIST_WARN_DEDUP_MS
      )
      return
    }

    const trimmed = text.trim()
    if (trimmed === '') return
    const name = parseCommandName(trimmed)
    if (name === null) return // 非指令文本：忽略

    const reply = this.executeCommand(name)
    if (reply !== null) await this.sendReply(botToken, chatIdStr, reply)
  }

  /** 指令分派（纯同步：engine 调用 + 文案组装）；未知指令 → 提示文案 */
  private executeCommand(name: string): string | null {
    switch (name) {
      case 'status':
        return formatStatusReply(this.deps.getStatus())
      case 'pause':
        this.deps.pause()
        return '⏸ 已暂停监控（停止轮询；发 /resume 恢复）'
      case 'resume':
        this.deps.resume()
        return '▶️ 已恢复监控'
      case 'poll':
        try {
          const maybe = this.deps.runNow()
          if (maybe instanceof Promise) {
            void maybe.catch((err: unknown) => {
              this.deps.log.warn(`bot /poll runNow rejected: ${describeError(err)}`)
            })
          }
          return '🔄 已触发一轮轮询'
        } catch (err) {
          this.deps.log.error(`bot /poll runNow threw: ${describeError(err)}`)
          return `❌ 触发失败：${err instanceof Error ? err.message : String(err)}`
        }
      case 'help':
        return HELP_REPLY
      default:
        return `未知指令：/${name}\n发送 /help 查看可用指令`
    }
  }

  /** 回复（sendMessage，自己的 post 直调——绝不进推送队列，坑8 第一条） */
  private async sendReply(botToken: string, chatId: string, text: string): Promise<void> {
    const init: HttpRequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    }
    try {
      const res = await this.deps.post(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        init
      )
      if (res.status < 200 || res.status >= 300) {
        this.deps.log.warn(
          `bot reply sendMessage failed: HTTP ${res.status}: ${clip(res.body)}`
        )
      }
    } catch (err) {
      this.deps.log.warn(`bot reply sendMessage failed: ${describeError(err)}`)
    }
  }

  /** 启动前清历史 webhook（409 的另一半来源，坑8）；失败仅 warn 不阻塞 */
  private async deleteWebhookSafely(signal: AbortSignal): Promise<void> {
    const creds = this.deps.getCredentials()
    if (creds === null) return
    try {
      const res = await this.deps.post(
        `https://api.telegram.org/bot${creds.botToken}/deleteWebhook?drop_pending_updates=false`,
        { method: 'POST', signal }
      )
      if (res.status < 200 || res.status >= 300) {
        this.deps.log.warn(
          `deleteWebhook failed (historical webhook may cause 409): HTTP ${res.status}: ${clip(res.body)}`
        )
      }
    } catch (err) {
      this.deps.log.warn(`deleteWebhook failed: ${describeError(err)}`)
    }
  }

  private getUpdatesUrl(botToken: string): string {
    const base = `https://api.telegram.org/bot${botToken}/getUpdates?timeout=${LONG_POLL_TIMEOUT_SEC}`
    return this.offset > 0 ? `${base}&offset=${this.offset}` : base
  }

  /** 同消息去重日志（默认 1 分钟窗；409 用 5 分钟窗）。Map 超限整体重置（防涨） */
  private dedupLog(
    level: 'warn' | 'error',
    msg: string,
    windowMs: number = ALLOWLIST_WARN_DEDUP_MS
  ): void {
    const t = this.now()
    const last = this.dedupLast.get(msg)
    if (last !== undefined && t - last < windowMs) return
    if (this.dedupLast.size > 256) this.dedupLast.clear()
    this.dedupLast.set(msg, t)
    if (level === 'error') this.deps.log.error(msg)
    else this.deps.log.warn(msg)
  }

  /** 可中断 sleep：本轮运行的 abort 触发即解除等待（stop 后不用真睡满 60s） */
  private async sleepInterruptible(signal: AbortSignal, ms: number): Promise<void> {
    if (signal.aborted) return
    await Promise.race([
      this.sleep(ms),
      new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    ])
  }
}

/** 响应体裁剪（日志用；与 telegram.ts 的 200 字符口径一致） */
function clip(body: string): string {
  return body.slice(0, 200)
}
