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

  it('带锐评：💬 行插在「🎯 命中」行之后、链接行之前，内容过 escapeHtml（含 <>&）', () => {
    const msg = formatHitMessage(topic, ['冰箱'], '这价格 <敢> 再低点 & 我就冲')
    const expected = [
      `🔔 <b>${escapeHtml(topic.title)}</b>`,
      `📁 交易 · 👤 ${escapeHtml('张三<b>')}`,
      `🎯 命中: 冰箱`,
      `💬 锐评: 这价格 &lt;敢&gt; 再低点 &amp; 我就冲`,
      `🔗 <a href="https://www.nodeseek.com/post-936634-1">打开帖子</a>`
    ].join('\n')
    expect(msg).toBe(expected)
    // 锐评里的原始 <敢> 不得出现（LLM 输出同样按不可信内容转义）
    expect(msg).not.toContain('<敢>')
    expect(msg).not.toContain(' & ')
  })

  it('回归：不传 / undefined / null / 空串锐评时，消息与两参版本逐字节一致（仍是四行）', () => {
    const baseline = formatHitMessage(topic, ['冰箱', '便宜&实惠'])
    expect(baseline.split('\n')).toHaveLength(4) // 现状：四行、无 💬 行
    expect(baseline).not.toContain('锐评')
    expect(formatHitMessage(topic, ['冰箱', '便宜&实惠'], undefined)).toBe(baseline)
    expect(formatHitMessage(topic, ['冰箱', '便宜&实惠'], null)).toBe(baseline)
    expect(formatHitMessage(topic, ['冰箱', '便宜&实惠'], '')).toBe(baseline)
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

  it('sendHit 第三参透传：锐评进 body.text，与 formatHitMessage 三参版本一致', async () => {
    const h = makeHarness(() => okRes)
    const commentary = '便宜 <但> 要谨慎 & 快冲'
    await h.notifier.sendHit(topic, ['冰箱'], commentary)

    expect(h.calls.length).toBe(1)
    const body = JSON.parse(h.calls[0]?.init?.body ?? '{}') as {
      text: string
      parse_mode: string
    }
    expect(body.text).toBe(formatHitMessage(topic, ['冰箱'], commentary))
    expect(body.text).toContain('💬 锐评: 便宜 &lt;但&gt; 要谨慎 &amp; 快冲')
    expect(body.parse_mode).toBe('HTML')
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

  it('sendRaw 成功：进队发送、原文透传、不带 parse_mode（<b> 不被解析为实体）', async () => {
    const h = makeHarness(() => okRes)
    const raw = '# ForumWatch 监控日报\n\n今日无命中 <b>字面量</b>\nhttps://example.com/r/2026-09-19'
    await h.notifier.sendRaw(raw)

    expect(h.calls.length).toBe(1)
    const body = JSON.parse(h.calls[0]?.init?.body ?? '{}') as {
      text: string
      parse_mode?: string
    }
    expect(body.text).toBe(raw) // 不做 HTML 转义
    expect(body.parse_mode).toBeUndefined() // 纯文本：无 parse_mode
    expect(h.sleeps).toEqual([]) // 首条不限流等待
  })

  it('sendRaw 与 sendHit 共用同一串行队列与 1050ms 限流', async () => {
    const h = makeHarness(() => okRes)
    await Promise.all([h.notifier.sendRaw('日报第一段'), h.notifier.sendRaw('日报第二段')])
    expect(h.calls.length).toBe(2)
    expect(h.sleeps).toEqual([1050]) // 第二段按限流间隔排队
    const bodies = h.calls.map((c) => JSON.parse(c.init?.body ?? '{}') as { text: string })
    expect(bodies.map((b) => b.text)).toEqual(['日报第一段', '日报第二段']) // 保序
  })
})
