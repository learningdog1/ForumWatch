/**
 * ntfy 推送（R6-W2 实现 Notifier 接口）。
 *
 * - 网络 post 由外部注入（FetchLike，生产传 HttpClient 封装），本模块零直接网络依赖；
 *   凭据经 getConfig 访问器注入（每次发送前重读，支持热更新）——对齐 telegram.ts。
 * - 端点 `POST {serverUrl ?? 'https://ntfy.sh'}`（服务器根路径，ntfy 的 JSON
 *   publish 模式：topic 写在 body 里），body 携带 topic/title/message/click/tags。
 *   **成功口径即 HTTP 2xx**（ntfy 无 bark 那层业务码包装）。
 * - 防抖：无 telegram 的 1050ms 硬限速，仅串行队列 + 两次实际发送间隔 >= 200ms
 *   的温和防抖（自建 ntfy 常与 ForumWatch 同机部署，无需硬限速）。
 * - 失败（网络异常 / 非 2xx）：共 3 次尝试，间隔 1s / 2s，仍失败抛 Error（message
 *   带最后一次失败原因，风格对齐 telegram 的错误消息）。429 无特殊处理——ntfy
 *   的 JSON publish 不回 Retry-After 结构化字段，统一走常规退避。
 * - now / sleep 可注入：单测用假时钟，不真睡。
 * - R6-W2 HitMessageInput.report：sendHit 最终成功/失败各回调一次（失败含
 *   「凭据未配置」与「重试耗尽」两类；回调后失败照常向上抛）。
 */

import type { FetchLike, HttpRequestInit, HttpResponse } from '../net/http-types'
import type { HitMessageInput, Notifier } from './types'
import { formatHitSummaryLine, truncateTitle } from './bark'

/** ntfy 发送所需配置（NtfyChannelConfig 的热更新访问器形状；id/enabled 归装配层） */
export interface NtfyConfig {
  /** 自建服务器 base；空/缺省 = 官方 https://ntfy.sh */
  serverUrl?: string
  topic: string
}

export interface NtfyDeps {
  /** 通道 id（Notifier.id，per-channel 推送明细的键） */
  id: string
  /** 注入的 HTTP POST（生产传 HttpClient 的封装） */
  post: FetchLike
  /** 引擎侧读取当前配置（支持热更新，每次发送前重读） */
  getConfig: () => NtfyConfig
  /** 测试注入假时钟；默认 Date.now */
  now?: () => number
  /** 测试注入假 sleep；默认真睡 setTimeout */
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_SERVER_URL = 'https://ntfy.sh'
const MAX_ATTEMPTS = 3
/** 温和防抖：两次实际发送的间隔下限（远松于 telegram 的 1050ms 硬限速） */
const MIN_SEND_INTERVAL_MS = 200
/** ntfy 消息标签：铃铛（客户端通知提示音/图标沿用各自默认） */
const TAGS = ['bell']

/** 发送端点：自定义 serverUrl（去尾斜杠，根路径即 publish 端点）或官方默认 */
function ntfyEndpoint(serverUrl: string | undefined): string {
  const base = (serverUrl ?? '').trim().replace(/\/+$/, '')
  return base === '' ? DEFAULT_SERVER_URL : base
}

export class NtfyNotifier implements Notifier {
  readonly id: string
  private readonly post: FetchLike
  private readonly getConfig: () => NtfyConfig
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  /** 串行队列尾部（永远是已 settle 的 promise），保证发送严格排队 */
  private tail: Promise<void> = Promise.resolve()
  private lastSendAt = Number.NEGATIVE_INFINITY

  constructor(deps: NtfyDeps) {
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
          topic: cfg.topic,
          title: truncateTitle(input.topic.title),
          message: formatHitSummaryLine(
            input.topic,
            input.matchedKeywords,
            input.matchedRule,
            input.semanticReason
          ),
          ...(input.topic.url !== '' ? { click: input.topic.url } : {}),
          tags: [...TAGS]
        }
        return this.deliver(ntfyEndpoint(cfg.serverUrl), payload)
      })
      input.report?.(this.id, true)
    } catch (err) {
      input.report?.(this.id, false, err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  async sendTest(): Promise<void> {
    await this.enqueue(() => this.deliverPlainText('✅ ForumWatch 测试消息（ntfy）'))
  }

  /** 纯文本通知（日报等）：标题固定 'ForumWatch'，正文原文透传 */
  async sendRaw(text: string): Promise<void> {
    await this.enqueue(() => this.deliverPlainText(text))
  }

  /** 标题 'ForumWatch' 的纯文本载荷（sendRaw/sendTest 共用形状；不带 click） */
  private async deliverPlainText(text: string): Promise<void> {
    const cfg = this.requireConfig()
    await this.deliver(ntfyEndpoint(cfg.serverUrl), {
      topic: cfg.topic,
      title: 'ForumWatch',
      message: text,
      tags: [...TAGS]
    })
  }

  /** 凭据未配置 fail-fast（engine 侧 configured 闸正常情况下已拦下，这里兜底） */
  private requireConfig(): NtfyConfig {
    const cfg = this.getConfig()
    if (cfg.topic.trim() === '') {
      throw new Error('ntfy not configured')
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

  /** 发送 + 3 次重试（1s/2s）；成功 = HTTP 2xx */
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

      if (res.status >= 200 && res.status < 300) return // 成功

      lastDetail = `HTTP ${res.status}: ${res.body}`
    }

    throw new Error(
      `ntfy send failed after ${MAX_ATTEMPTS} attempts: ${lastDetail.slice(0, 200)}`
    )
  }
}
