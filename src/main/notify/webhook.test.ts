/**
 * WebhookNotifier 单测：post/now/sleep 全部注入 mock，零网络、零真实等待。
 * 风格对齐 telegram.test.ts（makeHarness 假时钟 + handler(callIndex)）。
 *
 * 另覆盖 R6-W2 types.ts 扩容面：channelCredentialsComplete 的 webhook 分支与
 * isChannelReady 对 webhook 的放开（IMPLEMENTED_CHANNEL_TYPES 扩为四类型）。
 */

import { describe, expect, it } from 'vitest'
import type { HttpResponse, HttpRequestInit, FetchLike } from '../net/http-types'
import type { Topic } from '@shared/types'
import type { WebhookConfig } from './webhook'
import { WebhookNotifier, deriveMatchedBy } from './webhook'
import { channelCredentialsComplete, isChannelReady } from './types'

const topic: Topic = {
  id: '936634',
  sourceId: 'nodeseek',
  title: '出 <script>& 海尔冰箱 "9成新"',
  url: 'https://www.nodeseek.com/post-936634-1',
  author: '张三<b>',
  category: '交易',
  categorySlug: 'trade',
  pinned: false,
  lastActiveAt: null
}

const defaultConfig: WebhookConfig = {
  url: 'https://hooks.example.com/forumwatch',
  secret: 's3cret-token'
}

const okRes: HttpResponse = { status: 200, headers: {}, body: '{"received":true}' }
const serverErrRes: HttpResponse = { status: 500, headers: {}, body: 'boom' }
const notFoundRes: HttpResponse = { status: 404, headers: {}, body: 'no such route' }

interface Harness {
  notifier: WebhookNotifier
  /** 每次 post 的入参 */
  calls: Array<{ url: string; init?: HttpRequestInit }>
  /** 每次 sleep 的毫秒数 */
  sleeps: number[]
  setConfig: (c: WebhookConfig) => void
}

/** handler(callIndex) 返回 HttpResponse 或抛错；now/sleep 为假时钟（sleep 推进时钟） */
function makeHarness(
  handler: (callIndex: number) => HttpResponse,
  config: WebhookConfig = defaultConfig
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

  const notifier = new WebhookNotifier({
    id: 'my-webhook',
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

/** 解析第 idx 次 post 的 JSON body */
function bodyOf(h: Harness, idx = 0): Record<string, unknown> {
  return JSON.parse(h.calls[idx]?.init?.body ?? '{}') as Record<string, unknown>
}

describe('deriveMatchedBy（命中方式推导）', () => {
  it('matchedKeywords 非空 → literal；matchedRule 非空 → rule；否则 semantic', () => {
    expect(deriveMatchedBy({ topic, matchedKeywords: ['冰箱'] })).toBe('literal')
    expect(deriveMatchedBy({ topic, matchedKeywords: [], matchedRule: '白菜月付' })).toBe('rule')
    expect(deriveMatchedBy({ topic, matchedKeywords: [] })).toBe('semantic')
    expect(deriveMatchedBy({ topic, matchedKeywords: [], matchedRule: '' })).toBe('semantic')
    expect(deriveMatchedBy({ topic, matchedKeywords: [], matchedRule: null })).toBe('semantic')
  })

  it('词与规则并存（引擎不会出现，防御性约定）→ 按契约顺序取 literal', () => {
    expect(deriveMatchedBy({ topic, matchedKeywords: ['冰箱'], matchedRule: '白菜月付' })).toBe(
      'literal'
    )
  })
})

describe('WebhookNotifier', () => {
  it('sendHit 成功：POST 到配置 url，payload 结构齐全、topic 为展示/溯源子集、ts 来自注入时钟', async () => {
    const h = makeHarness(() => okRes)
    await h.notifier.sendHit({ topic, matchedKeywords: ['冰箱'], commentary: '可以冲' })

    expect(h.calls.length).toBe(1)
    expect(h.calls[0]?.url).toBe('https://hooks.example.com/forumwatch')
    const init = h.calls[0]?.init
    expect(init?.method).toBe('POST')
    expect(init?.headers?.['content-type']).toBe('application/json')
    expect(init?.headers?.['X-ForumWatch-Secret']).toBe('s3cret-token')
    const body = bodyOf(h)
    expect(body.type).toBe('hit')
    // topic 子集：精确六字段，不带 id/pinned/lastActiveAt 等内部态
    expect(body.topic).toEqual({
      title: topic.title,
      url: topic.url,
      author: topic.author,
      category: topic.category,
      categorySlug: topic.categorySlug,
      sourceId: topic.sourceId
    })
    expect((body.topic as Record<string, unknown>).id).toBeUndefined()
    expect(body.matchedBy).toBe('literal')
    expect(body.matchedKeywords).toEqual(['冰箱'])
    expect(body.matchedRule).toBeNull()
    expect(body.semanticReason).toBeNull()
    expect(body.commentary).toBe('可以冲')
    expect(body.ts).toBe(0) // 假时钟起点
    expect(h.sleeps).toEqual([]) // 首条不等待
  })

  it('secret 未配置（缺省/空串）→ 不发 X-ForumWatch-Secret 头', async () => {
    const h1 = makeHarness(() => okRes, { url: 'https://hooks.example.com/hook' })
    await h1.notifier.sendHit({ topic, matchedKeywords: ['x'] })
    expect(h1.calls[0]?.init?.headers).not.toHaveProperty('X-ForumWatch-Secret')

    const h2 = makeHarness(() => okRes, { url: 'https://hooks.example.com/hook', secret: '' })
    await h2.notifier.sendRaw('text')
    expect(h2.calls[0]?.init?.headers).not.toHaveProperty('X-ForumWatch-Secret')
  })

  it('规则/语义命中：matchedBy 与对应字段透传', async () => {
    const h = makeHarness(() => okRes)
    await h.notifier.sendHit({
      topic,
      matchedKeywords: [],
      matchedRule: '白菜月付',
      semanticReason: null,
      commentary: null
    })
    expect(bodyOf(h).matchedBy).toBe('rule')
    expect(bodyOf(h).matchedRule).toBe('白菜月付')

    await h.notifier.sendHit({
      topic,
      matchedKeywords: [],
      semanticReason: '价格疑似低于市价'
    })
    const semanticBody = bodyOf(h, 1)
    expect(semanticBody.matchedBy).toBe('semantic')
    expect(semanticBody.semanticReason).toBe('价格疑似低于市价')
  })

  it('每次请求都带 5s 超时（init.timeoutMs=5000，含重试请求）', async () => {
    const h = makeHarness((i) => (i === 0 ? serverErrRes : okRes))
    await h.notifier.sendHit({ topic, matchedKeywords: ['x'] })
    expect(h.calls.length).toBe(2)
    for (const c of h.calls) {
      expect(c.init?.timeoutMs).toBe(5000)
    }

    const h2 = makeHarness(() => okRes)
    await h2.notifier.sendRaw('text')
    expect(h2.calls[0]?.init?.timeoutMs).toBe(5000)
  })

  it('sendRaw 成功：{type:"raw", text, ts}，同样带鉴权头与超时', async () => {
    const h = makeHarness(() => okRes)
    const raw = '# ForumWatch 监控日报\n今日无命中'
    await h.notifier.sendRaw(raw)
    expect(bodyOf(h)).toEqual({ type: 'raw', text: raw, ts: 0 })
    expect(h.calls[0]?.init?.headers?.['X-ForumWatch-Secret']).toBe('s3cret-token')
    expect(h.calls[0]?.init?.timeoutMs).toBe(5000)
  })

  it('sendTest 成功：固定测试文案（type=raw 形状，对齐 telegram 测试消息措辞风格）', async () => {
    const h = makeHarness(() => okRes)
    await h.notifier.sendTest()
    expect(bodyOf(h).text).toBe('✅ ForumWatch 测试消息（webhook）')
    expect(bodyOf(h).type).toBe('raw')
  })

  it('500 → 1s 后重试成功（共 2 次请求）', async () => {
    const h = makeHarness((i) => (i === 0 ? serverErrRes : okRes))
    await h.notifier.sendTest()
    expect(h.calls.length).toBe(2)
    expect(h.sleeps).toEqual([1000])
  })

  it('连续 3 次非 2xx → throw Error（含通道类型与状态码），退避 1s/2s', async () => {
    const h = makeHarness(() => serverErrRes)
    let caught: unknown
    await h.notifier.sendTest().catch((e: unknown) => {
      caught = e
    })
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('webhook send failed after 3 attempts')
    expect((caught as Error).message).toContain('HTTP 500')
    expect(h.calls.length).toBe(3)
    expect(h.sleeps).toEqual([1000, 2000])

    // 404 同样按普通失败重试（消费端路由配错是最常见的 4xx 场景）
    const h404 = makeHarness(() => notFoundRes)
    await expect(h404.notifier.sendTest()).rejects.toThrow(/HTTP 404/)
    expect(h404.calls.length).toBe(3)
  })

  it('超时表现为网络异常（AbortSignal 由 HttpClient 层转）：3 次尝试后 throw，消息含异常名', async () => {
    const h = makeHarness(() => {
      const err = new Error('The operation was aborted due to timeout')
      err.name = 'TimeoutError'
      throw err
    })
    await expect(h.notifier.sendTest()).rejects.toThrow(/TimeoutError/)
    expect(h.calls.length).toBe(3)
    expect(h.sleeps).toEqual([1000, 2000])
  })

  it('网络异常同样 3 次尝试后抛 Error', async () => {
    const h = makeHarness(() => {
      throw new TypeError('fetch failed: ECONNREFUSED')
    })
    await expect(h.notifier.sendTest()).rejects.toThrow(/webhook send failed after 3 attempts/)
    expect(h.calls.length).toBe(3)
  })

  it('report 回调（成功态）：sendHit 最终成功 → report(id, true) 恰一次、无 error 参', async () => {
    const h = makeHarness(() => okRes)
    const calls: Array<[string, boolean, string?]> = []
    await h.notifier.sendHit({
      topic,
      matchedKeywords: ['x'],
      report: (channelId, ok, error) => calls.push([channelId, ok, error])
    })
    expect(calls).toEqual([['my-webhook', true, undefined]])
  })

  it('report 回调（失败态）：重试耗尽 → report(id, false, error)，且 sendHit 照常抛错', async () => {
    const h = makeHarness(() => serverErrRes)
    const calls: Array<[string, boolean, string?]> = []
    await expect(
      h.notifier.sendHit({
        topic,
        matchedKeywords: ['x'],
        report: (channelId, ok, error) => calls.push([channelId, ok, error])
      })
    ).rejects.toThrow(/webhook send failed/)
    expect(calls).toEqual([
      ['my-webhook', false, 'webhook send failed after 3 attempts: HTTP 500: boom']
    ])
  })

  it('未配置 url → 立即抛 webhook not configured，不发请求不等待，report 报失败', async () => {
    const h = makeHarness(() => okRes, { url: '', secret: 's' })
    const calls: Array<[string, boolean, string?]> = []
    await expect(
      h.notifier.sendHit({
        topic,
        matchedKeywords: ['x'],
        report: (channelId, ok, error) => calls.push([channelId, ok, error])
      })
    ).rejects.toThrow('webhook not configured')
    expect(h.calls.length).toBe(0)
    expect(h.sleeps).toEqual([])
    expect(calls).toEqual([['my-webhook', false, 'webhook not configured']])
  })

  it('getConfig 热更新：换 url/secret 后下一次发送即生效', async () => {
    const h = makeHarness(() => okRes)
    await h.notifier.sendTest()
    h.setConfig({ url: 'https://hooks2.example.com/fw', secret: 'new-secret' })
    await h.notifier.sendTest()
    expect(h.calls[1]?.url).toBe('https://hooks2.example.com/fw')
    expect(h.calls[1]?.init?.headers?.['X-ForumWatch-Secret']).toBe('new-secret')
  })

  it('温和防抖：连续两次发送，第二次等待 200ms（非 telegram 的 1050ms 硬限速）', async () => {
    const h = makeHarness(() => okRes)
    await Promise.all([h.notifier.sendRaw('第一段'), h.notifier.sendRaw('第二段')])
    expect(h.calls.length).toBe(2)
    expect(h.sleeps).toEqual([200])
    const bodies = h.calls.map((c) => JSON.parse(c.init?.body ?? '{}') as { text: string })
    expect(bodies.map((b) => b.text)).toEqual(['第一段', '第二段']) // 保序
  })

  it('R6-W2：实现 Notifier 接口——id 来自构造、sendHit/sendRaw/sendTest 具名存在', async () => {
    const h = makeHarness(() => okRes)
    expect(h.notifier.id).toBe('my-webhook')
    const n: { id: string; sendHit: unknown; sendRaw: unknown; sendTest: unknown } = h.notifier
    expect(typeof n.sendHit).toBe('function')
    expect(typeof n.sendRaw).toBe('function')
    expect(typeof n.sendTest).toBe('function')
  })
})

describe('通道就绪判定（R6-W2：webhook 分支放开）', () => {
  const webhookCh = (url: string, enabled = true) => ({
    id: 'my-webhook',
    type: 'webhook' as const,
    enabled,
    url
  })

  it('channelCredentialsComplete：url 非空（trim 后）才算齐备', () => {
    expect(channelCredentialsComplete(webhookCh('https://hooks.example.com/fw'))).toBe(true)
    expect(channelCredentialsComplete(webhookCh(' https://hooks.example.com/fw '))).toBe(true)
    expect(channelCredentialsComplete(webhookCh(''))).toBe(false)
    expect(channelCredentialsComplete(webhookCh('   '))).toBe(false)
  })

  it('isChannelReady：IMPLEMENTED_CHANNEL_TYPES 扩容后 enabled+凭据齐备的 webhook 就绪', () => {
    expect(isChannelReady(webhookCh('https://hooks.example.com/fw'))).toBe(true)
    expect(isChannelReady(webhookCh('https://hooks.example.com/fw', false))).toBe(false)
    expect(isChannelReady(webhookCh(''))).toBe(false)
  })
})
