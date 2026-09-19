/**
 * Bark 推送（iOS APNs 通道，R6-W2 实现 Notifier 接口）。
 *
 * - 网络 post 由外部注入（FetchLike，生产传 HttpClient 封装），本模块零直接网络依赖；
 *   凭据经 getConfig 访问器注入（每次发送前重读，支持热更新）——对齐 telegram.ts。
 * - 端点 `POST {serverUrl ?? 'https://api.day.app'}/push`，JSON body 携带
 *   device_key/title/body/url/group。**成功口径比 2xx 更严**：Bark 网关 HTTP 200
 *   时业务码也可能非 200（如 device_key 失效），须响应 JSON `code === 200` 才算
 *   成功；否则按失败重试，错误消息带响应的 message 字段。
 * - 防抖：无 telegram 的 1050ms 硬限速（Bark 无单 chat 1 msg/s 约束），仅保留
 *   串行队列 + 两次实际发送间隔 >= 200ms 的温和防抖（官方网关对高频推送有
 *   频控，200ms 足够个人监控量级）。
 * - 失败（网络异常 / 非 2xx / code !== 200）：共 3 次尝试，间隔 1s / 2s，仍失败
 *   抛 Error（message 带最后一次失败原因，风格对齐 telegram 的错误消息）。
 * - now / sleep 可注入：单测用假时钟，不真睡。
 * - R6-W2 HitMessageInput.report：sendHit 最终成功/失败各回调一次（失败含
 *   「凭据未配置」与「重试耗尽」两类；回调后失败照常向上抛）。
 */

import type { FetchLike, HttpRequestInit, HttpResponse } from '../net/http-types'
import type { Topic } from '@shared/types'
import type { HitMessageInput, Notifier } from './types'

/** Bark 发送所需配置（BarkChannelConfig 的热更新访问器形状；id/enabled 归装配层） */
export interface BarkConfig {
  /** 自建服务器 base；空/缺省 = 官方 https://api.day.app */
  serverUrl?: string
  deviceKey: string
}

export interface BarkDeps {
  /** 通道 id（Notifier.id，per-channel 推送明细的键） */
  id: string
  /** 注入的 HTTP POST（生产传 HttpClient 的封装） */
  post: FetchLike
  /** 引擎侧读取当前配置（支持热更新，每次发送前重读） */
  getConfig: () => BarkConfig
  /** 测试注入假时钟；默认 Date.now */
  now?: () => number
  /** 测试注入假 sleep；默认真睡 setTimeout */
  sleep?: (ms: number) => Promise<void>
}

/** 标题截断上限（UTF-16 code unit 数；60 对中文标题已是完整两句） */
export const BARK_TITLE_MAX_CHARS = 60

const DEFAULT_SERVER_URL = 'https://api.day.app'
const MAX_ATTEMPTS = 3
/** 温和防抖：两次实际发送的间隔下限（远松于 telegram 的 1050ms 硬限速） */
const MIN_SEND_INTERVAL_MS = 200

/**
 * 代理字符安全截断（对齐 ai/commentary.ts 的 truncateUtf16Safe 习惯：若截断点
 * 落在代理对中间，丢弃末尾的高代理半字符，避免送出非法 UTF-16 孤立代理项）。
 */
export function truncateTitle(title: string, maxChars: number = BARK_TITLE_MAX_CHARS): string {
  if (title.length <= maxChars) return title
  const sliced = title.slice(0, maxChars)
  const last = sliced.charCodeAt(sliced.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced
}

/**
 * 命中摘要一行（bark body / ntfy message 共用的文案格式，本文件先落地）：
 * `[分类] 作者 · 命中: {关键词}` / `· 命中规则: {label}`（规则命中优先，对齐
 * telegram formatHitMessage 的行选择逻辑）/ `· 语义命中: {理由}`（语义命中无
 * 词无规则时的兜底行；semanticReason 缺省则止于「语义命中」）。
 */
export function formatHitSummaryLine(
  topic: Topic,
  matchedKeywords: string[],
  matchedRule?: string | null,
  semanticReason?: string | null
): string {
  const who = `[${topic.category}] ${topic.author}`
  if (typeof matchedRule === 'string' && matchedRule.length > 0) {
    return `${who} · 命中规则: ${matchedRule}`
  }
  if (matchedKeywords.length > 0) {
    return `${who} · 命中: ${matchedKeywords.join(', ')}`
  }
  const reason =
    typeof semanticReason === 'string' && semanticReason.length > 0 ? `: ${semanticReason}` : ''
  return `${who} · 语义命中${reason}`
}

/** Bark 响应体判定：ok = code===200；bad-code 携带 code/message 供错误消息引用 */
type BarkBodyVerdict =
  | { ok: true }
  | { ok: false; reason: 'bad-code'; code?: number; message?: string }
  | { ok: false; reason: 'bad-json'; bodyHead: string }

function parseBarkBody(body: string): BarkBodyVerdict {
  let data: { code?: unknown; message?: unknown }
  try {
    data = JSON.parse(body) as { code?: unknown; message?: unknown }
  } catch {
    return { ok: false, reason: 'bad-json', bodyHead: body.slice(0, 100) }
  }
  const code = typeof data?.code === 'number' ? data.code : undefined
  const message = typeof data?.message === 'string' ? data.message : undefined
  if (code === 200) return { ok: true }
  return {
    ok: false,
    reason: 'bad-code',
    ...(code !== undefined ? { code } : {}),
    ...(message !== undefined ? { message } : {})
  }
}

/** 发送端点：自定义 serverUrl（去尾斜杠）或官方默认 */
function barkEndpoint(serverUrl: string | undefined): string {
  const base = (serverUrl ?? '').trim().replace(/\/+$/, '')
  return `${base === '' ? DEFAULT_SERVER_URL : base}/push`
}

export class BarkNotifier implements Notifier {
  readonly id: string
  private readonly post: FetchLike
  private readonly getConfig: () => BarkConfig
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  /** 串行队列尾部（永远是已 settle 的 promise），保证发送严格排队 */
  private tail: Promise<void> = Promise.resolve()
  private lastSendAt = Number.NEGATIVE_INFINITY

  constructor(deps: BarkDeps) {
    this.id = deps.id
    this.post = deps.post
    this.getConfig = deps.getConfig
    this.now = deps.now ?? (() => Date.now())
    this.sleep =
      deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  }

  /** 命中推送：report 回调只在最终结果落定后触发一次（成功/失败两态） */
  async sendHit(input: HitMessageInput): Promise<void> {
    try {
      await this.enqueue(() => {
        const cfg = this.requireConfig()
        const payload: Record<string, unknown> = {
          device_key: cfg.deviceKey,
          title: truncateTitle(input.topic.title),
          body: formatHitSummaryLine(
            input.topic,
            input.matchedKeywords,
            input.matchedRule,
            input.semanticReason
          ),
          ...(input.topic.url !== '' ? { url: input.topic.url } : {}),
          group: 'ForumWatch'
        }
        return this.deliver(barkEndpoint(cfg.serverUrl), payload)
      })
      input.report?.(this.id, true)
    } catch (err) {
      input.report?.(this.id, false, err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  async sendTest(): Promise<void> {
    await this.enqueue(() => this.deliverPlainText('✅ ForumWatch 测试消息（bark）'))
  }

  /** 纯文本通知（日报等）：标题固定 'ForumWatch'，正文原文透传 */
  async sendRaw(text: string): Promise<void> {
    await this.enqueue(() => this.deliverPlainText(text))
  }

  /** 标题 'ForumWatch' 的纯文本载荷（sendRaw/sendTest 共用形状；不带帖子 url） */
  private async deliverPlainText(text: string): Promise<void> {
    const cfg = this.requireConfig()
    await this.deliver(barkEndpoint(cfg.serverUrl), {
      device_key: cfg.deviceKey,
      title: 'ForumWatch',
      body: text,
      group: 'ForumWatch'
    })
  }

  /** 凭据未配置 fail-fast（engine 侧 configured 闸正常情况下已拦下，这里兜底） */
  private requireConfig(): BarkConfig {
    const cfg = this.getConfig()
    if (cfg.deviceKey.trim() === '') {
      throw new Error('bark not configured')
    }
    return cfg
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

  /** 防抖：距上次发送不足 200ms 则先睡差值（用注入的 now/sleep） */
  private async throttle(): Promise<void> {
    const wait = MIN_SEND_INTERVAL_MS - (this.now() - this.lastSendAt)
    if (wait > 0) await this.sleep(wait)
    this.lastSendAt = this.now()
  }

  /** 发送 + 3 次重试（1s/2s）；成功 = HTTP 2xx 且响应 JSON code===200 */
  private async deliver(url: string, payload: Record<string, unknown>): Promise<void> {
    await this.throttle()

    const init: HttpRequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }

    let lastDetail = ''
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) await this.sleep((attempt - 1) * 1000) // 1s / 2s

      let res: HttpResponse
      try {
        res = await this.post(url, init)
      } catch (err) {
        lastDetail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        continue
      }

      if (res.status >= 200 && res.status < 300) {
        const parsed = parseBarkBody(res.body)
        if (parsed.ok) return // 成功
        // 2xx 但业务码非 200（device_key 失效等）：按失败重试，详情带 message 字段
        lastDetail =
          parsed.reason === 'bad-code'
            ? `HTTP ${res.status} (code=${parsed.code ?? 'non-number'}): ${parsed.message ?? '<no message field>'}`
            : `HTTP ${res.status}: invalid JSON body: ${parsed.bodyHead}`
        continue
      }

      lastDetail = `HTTP ${res.status}: ${res.body}`
    }

    throw new Error(
      `bark send failed after ${MAX_ATTEMPTS} attempts: ${lastDetail.slice(0, 200)}`
    )
  }
}
