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
    id: 'telegram',
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
  it('四行结构：标题转义加粗 / 分类作者 / 命中词 / 帖子链接；命中词加 # 前缀（issue #2 建议二，Telegram hashtag 可点击筛选）', () => {
    const msg = formatHitMessage(topic, ['冰箱', '便宜&实惠'])
    const expected = [
      `🔔 <b>${escapeHtml(topic.title)}</b>`,
      `📁 交易 · 👤 ${escapeHtml('张三<b>')}`,
      `🎯 命中: #冰箱, #便宜&amp;实惠`,
      `🔗 <a href="https://www.nodeseek.com/post-936634-1">打开帖子</a>`
    ].join('\n')
    expect(msg).toBe(expected)
    // 标题里的原始 <script> 不得出现
    expect(msg).not.toContain('<script>')
  })

  it('作者链接（issue #2 建议一）：topic.authorUrl 非空时 👤 渲染为指向个人主页的超链接，href 与作者名均过 escapeHtml', () => {
    const withAuthor: Topic = { ...topic, authorUrl: 'https://www.nodeseek.com/space/9261?x=1&y=2' }
    const msg = formatHitMessage(withAuthor, ['冰箱'])
    const expected = [
      `🔔 <b>${escapeHtml(topic.title)}</b>`,
      `📁 交易 · 👤 <a href="https://www.nodeseek.com/space/9261?x=1&amp;y=2">${escapeHtml('张三<b>')}</a>`,
      `🎯 命中: #冰箱`,
      `🔗 <a href="https://www.nodeseek.com/post-936634-1">打开帖子</a>`
    ].join('\n')
    expect(msg).toBe(expected)
  })

  it('回归：authorUrl 缺失 / undefined / 空串（RSS 来源、旧 hits 记录）→ 👤 行退化为纯文本作者名，逐字节一致', () => {
    const baseline = formatHitMessage(topic, ['冰箱'])
    expect(baseline).toContain(`👤 ${escapeHtml('张三<b>')}`)
    expect(formatHitMessage({ ...topic, authorUrl: undefined }, ['冰箱'])).toBe(baseline)
    expect(formatHitMessage({ ...topic, authorUrl: '' }, ['冰箱'])).toBe(baseline)
  })

  it('带锐评：💬 行插在「🎯 命中」行之后、链接行之前，内容过 escapeHtml（含 <>&）', () => {
    const msg = formatHitMessage(topic, ['冰箱'], '这价格 <敢> 再低点 & 我就冲')
    const expected = [
      `🔔 <b>${escapeHtml(topic.title)}</b>`,
      `📁 交易 · 👤 ${escapeHtml('张三<b>')}`,
      `🎯 命中: #冰箱`,
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

  it('规则命中（第四参 matchedRule 非空）：「🎯 命中」行改为 🎯 命中规则: {label}（转义），关键词行不再出现', () => {
    const msg = formatHitMessage(topic, [], null, '白菜月付 <年付> & 88')
    const expected = [
      `🔔 <b>${escapeHtml(topic.title)}</b>`,
      `📁 交易 · 👤 ${escapeHtml('张三<b>')}`,
      `🎯 命中规则: #白菜月付 &lt;年付&gt; &amp; 88`,
      `🔗 <a href="https://www.nodeseek.com/post-936634-1">打开帖子</a>`
    ].join('\n')
    expect(msg).toBe(expected)
    expect(msg).not.toContain('命中: ') // 关键词行被替换
  })

  it('规则命中 + 锐评并存：💬 行仍在「🎯 命中规则」行之后', () => {
    const msg = formatHitMessage(topic, [], '这价格可以冲', '白菜月付')
    expect(msg.split('\n')).toHaveLength(5)
    expect(msg.split('\n')[2]).toBe('🎯 命中规则: #白菜月付')
    expect(msg.split('\n')[3]).toBe('💬 锐评: 这价格可以冲')
  })

  it('回归：matchedRule 不传 / null / 空串（literal/semantic 命中）→ 与三参版本逐字节一致', () => {
    const baseline = formatHitMessage(topic, ['冰箱'], '锐评')
    expect(formatHitMessage(topic, ['冰箱'], '锐评', undefined)).toBe(baseline)
    expect(formatHitMessage(topic, ['冰箱'], '锐评', null)).toBe(baseline)
    expect(formatHitMessage(topic, ['冰箱'], '锐评', '')).toBe(baseline)
    expect(baseline).toContain('🎯 命中: #冰箱')
  })

  it('摘要行：topic.excerpt 非空时 📄 行插在标题之后、分类作者行之前，内容过 escapeHtml', () => {
    const withExcerpt: Topic = {
      ...topic,
      excerpt: '9 成新海尔冰箱 & <附> 冰柜，自提优先'
    }
    const msg = formatHitMessage(withExcerpt, ['冰箱'])
    const expected = [
      `🔔 <b>${escapeHtml(topic.title)}</b>`,
      `📄 9 成新海尔冰箱 &amp; &lt;附&gt; 冰柜，自提优先`,
      `📁 交易 · 👤 ${escapeHtml('张三<b>')}`,
      `🎯 命中: #冰箱`,
      `🔗 <a href="https://www.nodeseek.com/post-936634-1">打开帖子</a>`
    ].join('\n')
    expect(msg).toBe(expected)
    expect(msg).not.toContain('<附>')
  })

  it('语义命中：关键词为空 + 理由非空 → 「🎯 语义命中: {理由}」（转义 + 截 120），不再出现空白的「🎯 命中: 」', () => {
    const msg = formatHitMessage(topic, [], null, null, 'PT站庆开放注册并免站7天，属于免费可薅的活动 <值得> & 推荐冲')
    const expected = [
      `🔔 <b>${escapeHtml(topic.title)}</b>`,
      `📁 交易 · 👤 ${escapeHtml('张三<b>')}`,
      `🎯 语义命中: PT站庆开放注册并免站7天，属于免费可薅的活动 &lt;值得&gt; &amp; 推荐冲`,
      `🔗 <a href="https://www.nodeseek.com/post-936634-1">打开帖子</a>`
    ].join('\n')
    expect(msg).toBe(expected)
    expect(msg).not.toContain('🎯 命中: ')
    expect(msg).not.toContain('<值得>')

    // 超长理由截断到 120 字符（含尾省略号）
    const long = formatHitMessage(topic, [], null, null, '长'.repeat(300))
    const line = long.split('\n').find((l) => l.startsWith('🎯 语义命中'))!
    expect(line).toBe(`🎯 语义命中: ${'长'.repeat(119)}…`)
  })

  it('语义命中但 AI 未给理由（null/空串）→ 仅显示「🎯 语义命中」无冒号尾巴', () => {
    const msg = formatHitMessage(topic, [], null, null, null)
    expect(msg).toContain('🎯 语义命中\n')
    expect(formatHitMessage(topic, [], null, null, '')).toBe(msg)
  })

  it('回归：literal 命中（关键词非空）不受 semanticReason 影响，不出现语义命中行', () => {
    const baseline = formatHitMessage(topic, ['冰箱'])
    expect(formatHitMessage(topic, ['冰箱'], null, null, '某理由')).toBe(baseline)
    expect(baseline).toContain('🎯 命中: #冰箱')
  })

  it('回归：excerpt 缺失 / undefined / 空串（nodeseek 无摘要、旧记录）→ 无 📄 行，与无摘要时代逐字节一致', () => {
    const baseline = formatHitMessage(topic, ['冰箱'])
    expect(baseline).not.toContain('📄')
    expect(formatHitMessage({ ...topic, excerpt: undefined }, ['冰箱'])).toBe(baseline)
    expect(formatHitMessage({ ...topic, excerpt: '' }, ['冰箱'])).toBe(baseline)
  })
})

describe('TelegramNotifier', () => {
  it('sendHit 成功：URL 带 token，JSON body 字段齐全，保留链接预览', async () => {
    const h = makeHarness(() => okRes)
    await h.notifier.sendHit({ topic, matchedKeywords: ['冰箱'] })

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
    await h.notifier.sendHit({ topic, matchedKeywords: ['冰箱'], commentary })

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

  it('sendHit 第四参透传（R5-P2a）：规则 label 进 body.text 的「命中规则」行，与四参版本一致', async () => {
    const h = makeHarness(() => okRes)
    await h.notifier.sendHit({ topic, matchedKeywords: [], commentary: null, matchedRule: '白菜月付' })
    const body = JSON.parse(h.calls[0]?.init?.body ?? '{}') as { text: string }
    expect(body.text).toBe(formatHitMessage(topic, [], null, '白菜月付'))
    expect(body.text).toContain('🎯 命中规则: #白菜月付')
    expect(body.text).not.toContain('命中: ')
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

  it('fetch 异常消息回显完整请求 URL 时：最终错误不残留 botToken 明文（先抹后截）', async () => {
    // token 在 URL 路径里；模拟 URL 解析失败类异常——消息带完整 URL
    const h = makeHarness(() => {
      throw new TypeError(
        `Invalid URL "https://api.telegram.org/bot${defaultConfig.botToken}/sendMessage"`
      )
    })
    let caught: unknown
    await h.notifier.sendTest().catch((e: unknown) => {
      caught = e
    })

    expect(caught).toBeInstanceOf(TelegramError)
    const msg = (caught as TelegramError).message
    expect(msg).toContain('after 3 attempts')
    expect(msg).not.toContain(defaultConfig.botToken) // token 明文不进 notifyError/日志
    expect(msg).toContain('***') // 明文被整体替换为 ***
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
    await expect(h.notifier.sendHit({ topic, matchedKeywords: ['冰箱'] })).rejects.toThrow(
      'telegram not configured'
    )
    expect(h.calls.length).toBe(0)
    expect(h.sleeps).toEqual([])

    h.setConfig({ botToken: 'T', chatId: '' })
    await expect(h.notifier.sendTest()).rejects.toThrow(TelegramError)
    expect(h.calls.length).toBe(0)
  })

  it('限流队列：连续两次 sendHit，第二次等待 >= 1050ms', async () => {
    const h = makeHarness(() => okRes)
    const topic2: Topic = { ...topic, id: '936635', url: 'https://www.nodeseek.com/post-936635-1' }

    await Promise.all([
      h.notifier.sendHit({ topic, matchedKeywords: ['a'] }),
      h.notifier.sendHit({ topic: topic2, matchedKeywords: ['b'] })
    ])

    expect(h.calls.length).toBe(2)
    // 全部成功场景下唯一的 sleep 就是限流等待（第二条消息进入时距上一条 0ms）
    expect(h.sleeps).toEqual([1050])
  })

  it('R6-W1：实现 Notifier 接口——id 来自构造、sendRaw/sendTest 具名存在', async () => {
    const h = makeHarness(() => okRes)
    expect(h.notifier.id).toBe('telegram')
    // 结构类型自证：实例可赋给 Notifier（编译期保证，这里运行时再点一遍名）
    const n: { id: string; sendHit: unknown; sendRaw: unknown; sendTest: unknown } = h.notifier
    expect(typeof n.sendHit).toBe('function')
    expect(typeof n.sendRaw).toBe('function')
    expect(typeof n.sendTest).toBe('function')
  })

  it('sendRaw 成功：进队发送、原文透传、不带 parse_mode（<b> 不被解析为实体）', async () => {
    const h = makeHarness(() => okRes)
    const raw = '# ForumWatch 监控日报\n\n今日无命中 <b>字面量</b>\nhttps://example.com/r/2026-09-19'
    await h.notifier.sendRaw(raw)

    expect(h.calls.length).toBe(1)
    const body = JSON.parse(h.calls[0]?.init?.body ?? '{}') as {
      text: string
      parse_mode?: string
      link_preview_options?: { is_disabled: boolean }
    }
    expect(body.text).toBe(raw) // 不做 HTML 转义
    expect(body.parse_mode).toBeUndefined() // 纯文本：无 parse_mode
    // R19：报告形态禁用链接预览（首 URL 预览卡对报告是噪音）
    expect(body.link_preview_options).toEqual({ is_disabled: true })
    expect(h.sleeps).toEqual([]) // 首条不限流等待
  })

  it('R19 sendRaw 带 opts.html：以 parse_mode=HTML 发送富文本（报告推送主路径）；空 html 退纯文本', async () => {
    const h = makeHarness(() => okRes)
    await h.notifier.sendRaw('🧠 总评 纯文本兜底', { html: '<b>🧠 总评</b>' })
    await h.notifier.sendRaw('第二段退纯文本', { html: '' })
    expect(h.calls.length).toBe(2)
    const b1 = JSON.parse(h.calls[0]?.init?.body ?? '{}') as {
      text: string
      parse_mode?: string
      link_preview_options?: { is_disabled: boolean }
    }
    expect(b1.text).toBe('<b>🧠 总评</b>')
    expect(b1.parse_mode).toBe('HTML')
    expect(b1.link_preview_options).toEqual({ is_disabled: true })
    const b2 = JSON.parse(h.calls[1]?.init?.body ?? '{}') as { text: string; parse_mode?: string }
    expect(b2.text).toBe('第二段退纯文本')
    expect(b2.parse_mode).toBeUndefined()
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
