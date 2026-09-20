/**
 * Telegram Bot 推送（ADR 8.6；D5 增补 sendRaw；R6-W1 实现 Notifier 接口）。
 *
 * - 网络 post 由外部注入（FetchLike，生产传 HttpClient 封装），本模块零直接网络依赖。
 * - 限流：内部串行队列，两次实际发送间隔 >= 1050ms。放弃 20 msg/min 全局限流——
 *   1050ms 间隔 + 尊重 429 的 retry_after 已满足个人监控量级（每轮命中个位数）。
 * - sendHit / sendTest 走 HTML parse_mode（用户内容一律 escapeHtml）；
 *   sendRaw（D5 日报）纯文本：不转义、不带 parse_mode，与命中推送共用队列与限流。
 * - 429：读响应体 parameters.retry_after，等 (min(retry_after, 60) + 0.5)s 后重试
 *   （封顶 60s：过大的 retry_after 不允许长时间阻塞轮询线程上的后续推送）。
 * - 其他失败（网络异常 / 非 2xx 非 429）：共 3 次尝试，间隔 1s / 2s，仍失败抛 TelegramError
 *   （message 带最后一次响应 body 前 200 字符）。
 * - now / sleep 可注入：单测用假时钟，不真睡。
 * - R6-W1：外壳 `implements Notifier`（sendHit 改收 HitMessageInput 单参对象；
 *   新增只读 id），内部队列/限速/429/重试/格式化逻辑与改造前逐行为一致——
 *   这是既有 342 测试的看家资产，只动外壳不动管线。
 * - R6-W4：sendHit 补 report 回调接线（最终成功/失败各一次，对齐 bark/ntfy/
 *   webhook 的口径），engine 据此收集 HitRecord.notifyDetail 的 per-channel 明细。
 */

import type { FetchLike, HttpResponse, HttpRequestInit } from '../net/http-types'
import type { TelegramConfig, Topic } from '@shared/types'
import { scrubSecret } from '../ai/provider'
import type { HitMessageInput, Notifier } from './types'

export class TelegramError extends Error {
  constructor(
    msg: string,
    public readonly retryAfterSec?: number
  ) {
    super(msg)
    this.name = 'TelegramError'
  }
}

export interface TelegramDeps {
  /**
   * 通道 id（R6-W1：Notifier.id，per-channel 推送明细的键）。单 telegram 通道
   * 时代装配方恒传 'telegram'；W3 router 落盘 notifyDetail 时以它为键。
   */
  id: string
  /** 注入的 HTTP POST（生产传 HttpClient 的封装） */
  post: FetchLike
  /**
   * 引擎侧读取当前凭据（支持热更新，每次发送前重读）。静态通道配置
   * （headless/测试快照）直接传 `() => ({ botToken, chatId })` 包装。
   */
  getConfig: () => TelegramConfig
  /** 测试注入假时钟；默认 Date.now */
  now?: () => number
  /** 测试注入假 sleep；默认真睡 setTimeout */
  sleep?: (ms: number) => Promise<void>
}

/** HTML parse_mode 下用户内容必须转义（& 先于 < >） */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 「🎯 语义命中」行 AI 理由的长度上限（字符）：LLM 理由偶发长段，防刷屏（与处置流水 detail 上限同值） */
const HIT_REASON_MAX_CHARS = 120

function clipHitReason(s: string): string {
  return s.length <= HIT_REASON_MAX_CHARS ? s : `${s.slice(0, HIT_REASON_MAX_CHARS - 1)}…`
}

/**
 * 命中推送文案（HTML）；标题/分类/作者/关键词/锐评均为用户（或 LLM）内容，一律过 escapeHtml。
 *
 * @param commentary AI 锐评（第三轮，可选）：**非空字符串**时在「🎯 命中」行之后插一行
 *   `💬 锐评: {commentary}`（转义后）；null / undefined / 空串时整行省略——两参调用
 *   的输出与升级前逐字节一致（引擎侧未生成锐评时直接不传即可）。
 * @param matchedRule 命中的价格规则 label（第五轮，可选）：**非空字符串**（= matchedBy
 *   'rule'——规则命中恒有 label，rules.ts 的 RuleMatch.label 已归一为 label ?? id）
 *   时「🎯 命中」行改为 `🎯 命中规则: {matchedRule}`（转义后）；null / undefined /
 *   空串（= literal/semantic 命中）时保持 `🎯 命中: {keywords}` 原样。
 * @param semanticReason 语义命中的 AI 判定理由（可选）：matchedKeywords 为空且理由
 *   非空时「🎯 命中」行改为 `🎯 语义命中: {semanticReason}`（截 HIT_REASON_MAX_CHARS
 *   后转义；与 bark/ntfy 的 `· 语义命中: {理由}` 同口径）——语义推送不再出现空白的
 *   「🎯 命中: 」行。理由缺失（AI 未给）时仅显示 `🎯 语义命中`。
 *
 * 摘要行（topic.excerpt，RSS/V2EX 来源提供）：非空字符串时在标题行之后插
 * `📄 {excerpt}`（转义后）。动机：链接预览卡片由 Telegram 服务端抓取目标页生成，
 * 抓取失败（站点拦 Telegram 爬虫）时消息只剩三行显得异常短小——摘要让消息正文
 * 自含内容，不再依赖预览的成败。excerpt 为空/缺失（nodeseek 列表页无摘要、旧
 * 记录）时整行省略，消息与无摘要时代逐字节一致。
 */
export function formatHitMessage(
  topic: Topic,
  matchedKeywords: string[],
  commentary?: string | null,
  matchedRule?: string | null,
  semanticReason?: string | null
): string {
  const hitLine =
    typeof matchedRule === 'string' && matchedRule.length > 0
      ? `🎯 命中规则: ${escapeHtml(matchedRule)}`
      : matchedKeywords.length > 0
        ? `🎯 命中: ${matchedKeywords.map(escapeHtml).join(', ')}`
        : typeof semanticReason === 'string' && semanticReason.length > 0
          ? `🎯 语义命中: ${escapeHtml(clipHitReason(semanticReason))}`
          : `🎯 语义命中`
  const lines = [`🔔 <b>${escapeHtml(topic.title)}</b>`]
  if (typeof topic.excerpt === 'string' && topic.excerpt.length > 0) {
    lines.push(`📄 ${escapeHtml(topic.excerpt)}`)
  }
  lines.push(`📁 ${escapeHtml(topic.category)} · 👤 ${escapeHtml(topic.author)}`, hitLine)
  if (typeof commentary === 'string' && commentary.length > 0) {
    lines.push(`💬 锐评: ${escapeHtml(commentary)}`)
  }
  lines.push(`🔗 <a href="${topic.url}">打开帖子</a>`)
  return lines.join('\n')
}

const MAX_ATTEMPTS = 3
/** Telegram 单 chat 限 ~1 msg/s，取 1050ms 留余量 */
const MIN_SEND_INTERVAL_MS = 1050
/** 429 retry_after 的等待封顶（秒）：过大的值不得长时间阻塞后续推送 */
const MAX_RETRY_AFTER_SEC = 60

/** 从 429 响应体里解析 parameters.retry_after；无/非法则 undefined */
function parseRetryAfterSec(body: string): number | undefined {
  try {
    const data = JSON.parse(body) as {
      parameters?: { retry_after?: unknown }
    }
    const v = data?.parameters?.retry_after
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
    return undefined
  } catch {
    return undefined
  }
}

export class TelegramNotifier implements Notifier {
  readonly id: string
  private readonly post: FetchLike
  private readonly getConfig: () => TelegramConfig
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  /** 串行队列尾部（永远是已 settle 的 promise），保证发送严格排队 */
  private tail: Promise<void> = Promise.resolve()
  private lastSendAt = Number.NEGATIVE_INFINITY

  constructor(deps: TelegramDeps) {
    this.id = deps.id
    this.post = deps.post
    this.getConfig = deps.getConfig
    this.now = deps.now ?? (() => Date.now())
    this.sleep =
      deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  }

  /**
   * 命中推送（HTML parse_mode；R6-W1 起收 HitMessageInput 单参对象，字段与旧
   * 四参签名一一对应：topic/matchedKeywords/commentary/matchedRule）。commentary
   * 与 matchedRule 可选：不传 / null / 空串时消息与少参版本逐字节一致。
   * R6-W4 report 接线（对齐 bark/ntfy/webhook 的口径）：sendHit 最终结果落定后
   * 回调一次 `input.report?.(this.id, true/false, error?)`，失败回调后照常上抛。
   */
  async sendHit(input: HitMessageInput): Promise<void> {
    try {
      await this.enqueue(() =>
        this.deliver(
          formatHitMessage(
            input.topic,
            input.matchedKeywords,
            input.commentary,
            input.matchedRule,
            input.semanticReason
          ),
          'HTML'
        )
      )
      input.report?.(this.id, true)
    } catch (err) {
      input.report?.(this.id, false, err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  async sendTest(): Promise<void> {
    await this.enqueue(() => this.deliver('✅ ForumWatch 测试消息', 'HTML'))
  }

  /**
   * 纯文本发送（D5 日报用）：**不做 HTML 转义、不带 parse_mode**——markdown
   * 日报以纯文本呈现（链接退化为裸 URL，TG 原生可点）。复用同一串行队列 /
   * 1050ms 限流 / 429 retry_after 语义，与命中推送互相排队。
   */
  async sendRaw(text: string): Promise<void> {
    await this.enqueue(() => this.deliver(text, null))
  }

  /** 排队执行；前一个任务失败不阻塞后一个 */
  private enqueue(op: () => Promise<void>): Promise<void> {
    const run = this.tail.then(op)
    this.tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /** 限流：距上次发送不足 1050ms 则先睡差值（用注入的 now/sleep） */
  private async throttle(): Promise<void> {
    const wait = MIN_SEND_INTERVAL_MS - (this.now() - this.lastSendAt)
    if (wait > 0) await this.sleep(wait)
    this.lastSendAt = this.now()
  }

  /** @param parseMode 'HTML'（命中/测试消息）或 null（sendRaw 纯文本，不带 parse_mode） */
  private async deliver(text: string, parseMode: 'HTML' | null): Promise<void> {
    const cfg = this.getConfig()
    if (!cfg.botToken || !cfg.chatId) {
      throw new TelegramError('telegram not configured')
    }

    await this.throttle()

    const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`
    const init: HttpRequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text,
        ...(parseMode !== null ? { parse_mode: parseMode } : {}),
        link_preview_options: { is_disabled: false }
      })
    }

    let delayBeforeNext = 0
    let lastDetail = ''
    let lastRetryAfterSec: number | undefined

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) await this.sleep(delayBeforeNext)

      let res: HttpResponse
      try {
        res = await this.post(url, init)
      } catch (err) {
        lastDetail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        lastRetryAfterSec = undefined
        delayBeforeNext = attempt * 1000 // 1s / 2s
        continue
      }

      if (res.status >= 200 && res.status < 300) return // 成功

      if (res.status === 429) {
        const retryAfter = parseRetryAfterSec(res.body)
        lastRetryAfterSec = retryAfter
        lastDetail = `HTTP 429 (retry_after=${retryAfter ?? 'unknown'}s): ${res.body}`
        // 尊重服务端指示但封顶 60s；无 retry_after 时退化为常规退避
        delayBeforeNext =
          retryAfter !== undefined ? (Math.min(retryAfter, MAX_RETRY_AFTER_SEC) + 0.5) * 1000 : attempt * 1000
        continue
      }

      lastDetail = `HTTP ${res.status}: ${res.body}`
      lastRetryAfterSec = undefined
      delayBeforeNext = attempt * 1000 // 1s / 2s
    }

    // 错误详情脱敏：botToken 在 URL 路径里，URL 解析失败类 fetch 异常的消息可能
    // 回显完整 URL → token 明文绝不能进 notifyError/日志。先抹（scrubSecret，与
    // ai/provider 的 apiKey 同款口径）后截 200（先抹后截，截断边界也不残留
    // 完整 token）；cfg.botToken 在 deliver 顶部已判非空。
    throw new TelegramError(
      `telegram send failed after ${MAX_ATTEMPTS} attempts: ${scrubSecret(lastDetail, cfg.botToken).slice(0, 200)}`,
      lastRetryAfterSec
    )
  }
}
