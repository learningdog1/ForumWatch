/**
 * TelegramNotifier 单测：post/now/sleep 全部注入 mock，零网络、零真实等待。
 */

import { describe, expect, it } from 'vitest'
import type { HttpResponse, HttpRequestInit, FetchLike } from '../net/http-types'
import type { TelegramConfig, Topic } from '@shared/types'
import { escapeHtml, formatHitMessage, TelegramError, TelegramNotifier } from './telegram'

const topic: Topic = {
  id: '936634',
  sourceId: '',
  title: '出 <script>& 海尔冰箱 "9成新"',
  url: 'https://www.nodeseek.com/post-936634-1',
  author: '张三<b>',
  category: '交易',
  categorySlug: 'trade',
  pinned: false,
  lastActiveAt: null
}

const defaultConfig: TelegramConfig = { botToken: '123456:AA-token', chatId: '-100200' }

const okRes: HttpResponse = { status: 200, headers: {}, body: '{"ok":true,"result":{"message_id":42}}' }
const tooManyRes: HttpResponse = {
  status: 429,
  headers: {},
  body: '{"ok":false,"error_code":429,"description":"Too Many Requests","parameters":{"retry_after":3}}'
}
const serverErrRes: HttpResponse = {
  status: 500,
  headers: {},
  body: '{"ok":false,"error_code":500,"description":"Internal Server Error"}'
}

interface Harness {
  notifier: TelegramNotifier
  /** 每次 post 的入参 */
  calls: Array<{ url: string; init?: HttpRequestInit }>
  /** 每次 sleep 的毫秒数 */
  sleeps: number[]
  setConfig: (c: TelegramConfig) => void
}

/**
 * handler(callIndex) 返回 HttpResponse 或抛错；now/sleep 为假时钟（sleep 推进时钟）。
 */
function makeHarness(
  handler: (callIndex: number) => HttpResponse,
  config: TelegramConfig = defaultConfig
): Harness {
  const calls: Array<{ url: string; init?: HttpRequestInit }> = []
  const sleeps: number[] = []
  let clock = 0
  let cfg = config

  const post: FetchLike = (url, init) => {
    const idx = calls.length
    calls.push({ url, init })
    try {
      return Promise.resolve(handler(idx))
    } catch (e) {
      return Promise.reject(e)
    }
  }

  const notifier = new TelegramNotifier({
    post,
    getConfig: () => cfg,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    }
  })

  return { notifier, calls, sleeps, setConfig: (c) => (cfg = c) }
}

describe('escapeHtml', () => {
  it('& < > 全转义，& 先处理', () => {
    expect(escapeHtml('<script>&')).toBe('&lt;script&gt;&amp;')
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
    expect(escapeHtml('plain 纯文本 123')).toBe('plain 纯文本 123')
  })
})

describe('formatHitMessage', () => {
  it('四行结构：标题转义加粗 / 分类作者 / 命中词 / 帖子链接', () => {
    const msg = formatHitMessage(topic, ['冰箱', '便宜&实惠'])
    const expected = [
      `🔔 <b>${escapeHtml(topic.title)}</b>`,
      `📁 交易 · 👤 ${escapeHtml('张三<b>')}`,
      `🎯 命中: 冰箱, 便宜&amp;实惠`,
      `🔗 <a href="https://www.nodeseek.com/post-936634-1">打开帖子</a>`
    ].join('\n')
    expect(msg).toBe(expected)
    // 标题里的原始 <script> 不得出现
    expect(msg).not.toContain('<script>')
  })
})

describe('TelegramNotifier', () => {
  it('sendHit 成功：URL 带 token，JSON body 字段齐全，保留链接预览', async () => {
    const h = makeHarness(() => okRes)
    await h.notifier.sendHit(topic, ['冰箱'])

    expect(h.calls.length).toBe(1)
    expect(h.calls[0]?.url).toBe('https://api.telegram.org/bot123456:AA-token/sendMessage')
    const init = h.calls[0]?.init
    expect(init?.method).toBe('POST')
    expect(init?.headers?.['content-type']).toBe('application/json')
    const body = JSON.parse(init?.body ?? '{}') as {
      chat_id: string
      text: string
      parse_mode: string
      link_preview_options: { is_disabled: boolean }
    }
    expect(body.chat_id).toBe('-100200')
    expect(body.text).toBe(formatHitMessage(topic, ['冰箱']))
    expect(body.parse_mode).toBe('HTML')
    expect(body.link_preview_options).toEqual({ is_disabled: false })
    expect(h.sleeps).toEqual([]) // 首条不等待
  })

  it('sendTest 成功：固定文案', async () => {
    const h = makeHarness(() => okRes)
    await h.notifier.sendTest()
    const body = JSON.parse(h.calls[0]?.init?.body ?? '{}') as { text: string }
    expect(body.text).toBe('✅ ForumWatch 测试消息')
  })

  it('429 后按 min(retry_after, 60)+0.5s 等待并重试成功', async () => {
    const h = makeHarness((i) => (i === 0 ? tooManyRes : okRes))
    await h.notifier.sendTest()

    expect(h.calls.length).toBe(2)
    expect(h.sleeps).toEqual([3500]) // (min(3, 60) + 0.5) * 1000
  })

  it('429 retry_after 过大（如 300s）：等待封顶 60s，不长时间阻塞', async () => {
    const hugeRetry: HttpResponse = {
      status: 429,
      headers: {},
      body: '{"ok":false,"error_code":429,"parameters":{"retry_after":300}}'
    }
    const h = makeHarness((i) => (i === 0 ? hugeRetry : okRes))
    await h.notifier.sendTest()

    expect(h.calls.length).toBe(2)
    expect(h.sleeps).toEqual([60500]) // (min(300, 60) + 0.5) * 1000
  })

  it('连续 3 次非 429 失败 → TelegramError，含 body 前 200 字符与 1s/2s 退避', async () => {
    const h = makeHarness(() => serverErrRes)
    let caught: unknown
    await h.notifier.sendTest().catch((e: unknown) => {
      caught = e
    })

    expect(caught).toBeInstanceOf(TelegramError)
    const err = caught as TelegramError
    expect(err.message).toContain('after 3 attempts')
    expect(err.message).toContain('HTTP 500')
    expect(err.message).toContain('Internal Server Error')
    expect(err.retryAfterSec).toBeUndefined()
    expect(h.calls.length).toBe(3)
    expect(h.sleeps).toEqual([1000, 2000])
  })

  it('网络异常同样 3 次尝试后抛 TelegramError', async () => {
    const h = makeHarness(() => {
      throw new TypeError('fetch failed: ECONNREFUSED')
    })
    await expect(h.notifier.sendTest()).rejects.toThrow(TelegramError)
    expect(h.calls.length).toBe(3)
    expect(h.sleeps).toEqual([1000, 2000])
  })

  it('连续 3 次 429 → TelegramError 且带 retryAfterSec', async () => {
    const h = makeHarness(() => tooManyRes)
    let caught: unknown
    await h.notifier.sendTest().catch((e: unknown) => {
      caught = e
    })
    expect(caught).toBeInstanceOf(TelegramError)
    expect((caught as TelegramError).retryAfterSec).toBe(3)
    expect(h.sleeps).toEqual([3500, 3500]) // 每次尝试后都按 retry_after 等待
  })

  it('未配置 token/chatId → 立即抛 TelegramError，不发请求不等待', async () => {
    const h = makeHarness(() => okRes, { botToken: '', chatId: '-100200' })
    await expect(h.notifier.sendHit(topic, ['冰箱'])).rejects.toThrow('telegram not configured')
    expect(h.calls.length).toBe(0)
    expect(h.sleeps).toEqual([])

    h.setConfig({ botToken: 'T', chatId: '' })
    await expect(h.notifier.sendTest()).rejects.toThrow(TelegramError)
    expect(h.calls.length).toBe(0)
  })

  it('限流队列：连续两次 sendHit，第二次等待 >= 1050ms', async () => {
    const h = makeHarness(() => okRes)
    const topic2: Topic = { ...topic, id: '936635', url: 'https://www.nodeseek.com/post-936635-1' }

    await Promise.all([h.notifier.sendHit(topic, ['a']), h.notifier.sendHit(topic2, ['b'])])

    expect(h.calls.length).toBe(2)
    // 全部成功场景下唯一的 sleep 就是限流等待（第二条消息进入时距上一条 0ms）
    expect(h.sleeps).toEqual([1050])
  })
})
