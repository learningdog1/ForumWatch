/**
 * Webhook 推送（R6-W2 实现 Notifier 接口）：把命中打包成结构化 JSON POST 给
 * 用户配置的 url，供自建消费端（自动化/归档/二级分发）订阅。
 *
 * - 网络 post 由外部注入（FetchLike，生产传 HttpClient 的封装，timeoutMs 由
 *   HttpClient 转成 AbortSignal.timeout），本模块零直接网络依赖；配置经
 *   getConfig 访问器注入（每次发送前重读，支持热更新）——对齐 telegram.ts。
 * - 命中载荷 `{type:'hit', topic:{...子集}, matchedBy, matchedKeywords,
 *   matchedRule, semanticReason, commentary, ts}`；matchedBy 由输入推导：
 *   matchedKeywords 非空 → 'literal'，matchedRule 非空 → 'rule'，否则
 *   'semantic'（引擎不会同时给词与规则，推导顺序仅是防御性约定）。
 *   sendRaw/sendTest 走 `{type:'raw', text, ts}`。
 * - 鉴权：secret 已配置（非空）时附 `X-ForumWatch-Secret` 头；未配置不发该头。
 * - **5s 超时**（init.timeoutMs=5000）：webhook 消费端是用户自建服务，慢响应
 *   不得拖住推送线程；超时表现为网络异常，同样进重试。
 * - 防抖：无 telegram 的 1050ms 硬限速，仅串行队列 + 两次实际发送间隔 >= 200ms
 *   的温和防抖。
 * - 失败（网络异常 / 非 2xx）：共 3 次尝试，间隔 1s / 2s，仍失败抛 Error（message
 *   带最后一次失败原因，风格对齐 telegram 的错误消息）。
 * - now / sleep 可注入：单测用假时钟，不真睡（now 同时是 payload 的 ts 来源）。
 * - R6-W2 HitMessageInput.report：sendHit 最终成功/失败各回调一次（失败含
 *   「凭据未配置」与「重试耗尽」两类；回调后失败照常向上抛）。
 */

import type { FetchLike, HttpRequestInit, HttpResponse } from '../net/http-types'
import type { HitMessageInput, Notifier } from './types'

/** webhook 发送所需配置（WebhookChannelConfig 的热更新访问器形状；id/enabled 归装配层） */
export interface WebhookConfig {
  url: string
  /** 自定义鉴权头值（头名固定 X-ForumWatch-Secret）；空/缺省 = 不发该头 */
  secret?: string
}

export interface WebhookDeps {
  /** 通道 id（Notifier.id，per-channel 推送明细的键） */
  id: string
  /** 注入的 HTTP POST（生产传 HttpClient 的封装） */
  post: FetchLike
  /** 引擎侧读取当前配置（支持热更新，每次发送前重读） */
  getConfig: () => WebhookConfig
  /** 测试注入假时钟（兼 payload ts 来源）；默认 Date.now */
  now?: () => number
  /** 测试注入假 sleep；默认真睡 setTimeout */
  sleep?: (ms: number) => Promise<void>
}

const MAX_ATTEMPTS = 3
/** 温和防抖：两次实际发送的间隔下限（远松于 telegram 的 1050ms 硬限速） */
const MIN_SEND_INTERVAL_MS = 200
/** 用户自建消费端可能卡死，5s 硬超时（HttpClient 转 AbortSignal.timeout） */
const TIMEOUT_MS = 5000

/** 命中方式的通道无关推导（R6-W2 契约顺序：词 → 规则 → 语义） */
export function deriveMatchedBy(input: HitMessageInput): 'literal' | 'rule' | 'semantic' {
  if (input.matchedKeywords.length > 0) return 'literal'
  if (typeof input.matchedRule === 'string' && input.matchedRule.length > 0) return 'rule'
  return 'semantic'
}

/** 命中载荷的 topic 子集（只给消费端需要的展示/溯源字段，不带 pinned 等内部态） */
function topicPayload(t: HitMessageInput['topic']): Record<string, unknown> {
  return {
    title: t.title,
    url: t.url,
    author: t.author,
    category: t.category,
    categorySlug: t.categorySlug,
    sourceId: t.sourceId
  }
}

export class WebhookNotifier implements Notifier {
  readonly id: string
  private readonly post: FetchLike
  private readonly getConfig: () => WebhookConfig
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  /** 串行队列尾部（永远是已 settle 的 promise），保证发送严格排队 */
  private tail: Promise<void> = Promise.resolve()
  private lastSendAt = Number.NEGATIVE_INFINITY

  constructor(deps: WebhookDeps) {
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
      // ts 取实际出队发送时刻（防抖等待后），消费端拿到的多个通道载荷时序一致
      await this.enqueue(() => {
        const cfg = this.requireConfig()
        const payload: Record<string, unknown> = {
          type: 'hit',
          topic: topicPayload(input.topic),
          matchedBy: deriveMatchedBy(input),
          matchedKeywords: input.matchedKeywords,
          matchedRule: input.matchedRule ?? null,
          semanticReason: input.semanticReason ?? null,
          commentary: input.commentary ?? null,
          ts: this.now()
        }
        return this.deliver(cfg.url, payload, cfg.secret)
      })
      input.report?.(this.id, true)
    } catch (err) {
      input.report?.(this.id, false, err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  async sendTest(): Promise<void> {
    await this.enqueue(() => this.deliverPlainText('✅ ForumWatch 测试消息（webhook）'))
  }

  /** 纯文本通知（日报等）：{type:'raw', text, ts} */
  async sendRaw(text: string): Promise<void> {
    await this.enqueue(() => this.deliverPlainText(text))
  }

  private async deliverPlainText(text: string): Promise<void> {
    const cfg = this.requireConfig()
    await this.deliver(cfg.url, { type: 'raw', text, ts: this.now() }, cfg.secret)
  }

  /** 配置未就绪 fail-fast（engine 侧 configured 闸正常情况下已拦下，这里兜底） */
  private requireConfig(): WebhookConfig {
    const cfg = this.getConfig()
    if (cfg.url.trim() === '') {
      throw new Error('webhook not configured')
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

  /** 发送 + 3 次重试（1s/2s）；成功 = HTTP 2xx；每次请求都带 5s 超时 */
  private async deliver(
    url: string,
    payload: Record<string, unknown>,
    secret: string | undefined
  ): Promise<void> {
    await this.throttle()

    const init: HttpRequestInit = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret !== undefined && secret.trim() !== '' ? { 'X-ForumWatch-Secret': secret } : {})
      },
      body: JSON.stringify(payload),
      timeoutMs: TIMEOUT_MS
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
      `webhook send failed after ${MAX_ATTEMPTS} attempts: ${lastDetail.slice(0, 200)}`
    )
  }
}
