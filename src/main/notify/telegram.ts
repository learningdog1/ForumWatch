/**
 * Telegram Bot 推送（ADR 8.6；D5 增补 sendRaw）。
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
 */

import type { FetchLike, HttpResponse, HttpRequestInit } from '../net/http-types'
import type { TelegramConfig, Topic } from '@shared/types'

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
  /** 注入的 HTTP POST（生产传 HttpClient 的封装） */
  post: FetchLike
  /** 引擎侧读取当前配置（支持热更新，每次发送前重读） */
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
 */
export function formatHitMessage(
  topic: Topic,
  matchedKeywords: string[],
  commentary?: string | null,
  matchedRule?: string | null
): string {
  const hitLine =
    typeof matchedRule === 'string' && matchedRule.length > 0
      ? `🎯 命中规则: ${escapeHtml(matchedRule)}`
      : `🎯 命中: ${matchedKeywords.map(escapeHtml).join(', ')}`
  const lines = [
    `🔔 <b>${escapeHtml(topic.title)}</b>`,
    `📁 ${escapeHtml(topic.category)} · 👤 ${escapeHtml(topic.author)}`,
    hitLine
  ]
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

export class TelegramNotifier {
  private readonly post: FetchLike
  private readonly getConfig: () => TelegramConfig
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  /** 串行队列尾部（永远是已 settle 的 promise），保证发送严格排队 */
  private tail: Promise<void> = Promise.resolve()
  private lastSendAt = Number.NEGATIVE_INFINITY

  constructor(deps: TelegramDeps) {
    this.post = deps.post
    this.getConfig = deps.getConfig
    this.now = deps.now ?? (() => Date.now())
    this.sleep =
      deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  }

  /**
   * 命中推送（HTML parse_mode）。第三参 commentary（AI 锐评）与第四参 matchedRule
   * （价格规则 label，第五轮）可选：不传 / null / 空串时消息与少参版本逐字节一致，
   * 既有调用方（engine）无需改动即可升到本签名。
   */
  async sendHit(
    topic: Topic,
    matchedKeywords: string[],
    commentary?: string | null,
    matchedRule?: string | null
  ): Promise<void> {
    await this.enqueue(() =>
      this.deliver(formatHitMessage(topic, matchedKeywords, commentary, matchedRule), 'HTML')
    )
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

    throw new TelegramError(
      `telegram send failed after ${MAX_ATTEMPTS} attempts: ${lastDetail.slice(0, 200)}`,
      lastRetryAfterSec
    )
  }
}
