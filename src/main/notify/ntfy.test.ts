/**
 * NtfyNotifier 单测：post/now/sleep 全部注入 mock，零网络、零真实等待。
 * 风格对齐 telegram.test.ts（makeHarness 假时钟 + handler(callIndex)）。
 *
 * 另覆盖 R6-W2 types.ts 扩容面：channelCredentialsComplete 的 ntfy 分支与
 * isChannelReady 对 ntfy 的放开（IMPLEMENTED_CHANNEL_TYPES 扩为四类型）。
 */

import { describe, expect, it } from 'vitest'
import type { HttpResponse, HttpRequestInit, FetchLike } from '../net/http-types'
import type { Topic } from '@shared/types'
import type { NtfyConfig } from './ntfy'
import { NtfyNotifier } from './ntfy'
import { formatHitSummaryLine, truncateTitle } from './bark'
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

const defaultConfig: NtfyConfig = { topic: 'forumwatch-hits' }

const okRes: HttpResponse = { status: 200, headers: {}, body: '{"id":"x1","time":1}' }
const serverErrRes: HttpResponse = { status: 500, headers: {}, body: 'internal server error' }
const tooManyRes: HttpResponse = { status: 429, headers: {}, body: 'too many requests' }

interface Harness {
  notifier: NtfyNotifier
  /** 每次 post 的入参 */
  calls: Array<{ url: string; init?: HttpRequestInit }>
  /** 每次 sleep 的毫秒数 */
  sleeps: number[]
  setConfig: (c: NtfyConfig) => void
}

/** handler(callIndex) 返回 HttpResponse 或抛错；now/sleep 为假时钟（sleep 推进时钟） */
function makeHarness(
  handler: (callIndex: number) => HttpResponse,
  config: NtfyConfig = defaultConfig
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

  const notifier = new NtfyNotifier({
    id: 'my-ntfy',
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

describe('NtfyNotifier', () => {
  it('sendHit 成功：官方默认根端点，JSON publish 字段齐全（topic/title/message/click/tags）', async () => {
    const h = makeHarness(() => okRes)
    await h.notifier.sendHit({ topic, matchedKeywords: ['冰箱'] })

    expect(h.calls.length).toBe(1)
    expect(h.calls[0]?.url).toBe('https://ntfy.sh')
    const init = h.calls[0]?.init
    expect(init?.method).toBe('POST')
    expect(init?.headers?.['content-type']).toBe('application/json')
    const body = bodyOf(h)
    expect(body.topic).toBe('forumwatch-hits')
    expect(body.title).toBe(topic.title)
    expect(body.message).toBe(formatHitSummaryLine(topic, ['冰箱']))
    expect(body.click).toBe(topic.url)
    expect(body.tags).toEqual(['bell'])
    expect(h.sleeps).toEqual([]) // 首条不等待
  })

  it('自定义 serverUrl：以其根路径为端点（去尾斜杠，不拼接 /push 等路径）', async () => {
    const h = makeHarness(() => okRes, { serverUrl: 'https://ntfy.internal:2586/', topic: 't1' })
    await h.notifier.sendHit({ topic, matchedKeywords: ['x'] })
    expect(h.calls[0]?.url).toBe('https://ntfy.internal:2586')
    expect(bodyOf(h).topic).toBe('t1')
  })

  it('sendHit 标题与正文走共用截断/摘要（超长标题 60 单元；语义命中摘要行）', async () => {
    const h = makeHarness(() => okRes)
    const longTopic: Topic = { ...topic, title: '冰'.repeat(100) }
    await h.notifier.sendHit({
      topic: longTopic,
      matchedKeywords: [],
      semanticReason: '价格疑似低于市价'
    })
    const body = bodyOf(h)
    expect(body.title).toBe(truncateTitle(longTopic.title))
    expect(body.message).toBe('[交易] 张三<b> · 语义命中: 价格疑似低于市价')
  })

  it('规则命中：message 用命中规则行', async () => {
    const h = makeHarness(() => okRes)
    await h.notifier.sendHit({ topic, matchedKeywords: [], matchedRule: '白菜月付' })
    expect(bodyOf(h).message).toBe('[交易] 张三<b> · 命中规则: 白菜月付')
  })

  it('topic.url 为空串时 body 不带 click 字段', async () => {
    const h = makeHarness(() => okRes)
    await h.notifier.sendHit({ topic: { ...topic, url: '' }, matchedKeywords: ['x'] })
    expect(bodyOf(h)).not.toHaveProperty('click')
  })

  it('sendRaw 成功：标题固定 ForumWatch、正文原文透传、无 click 字段', async () => {
    const h = makeHarness(() => okRes)
    const raw = '# ForumWatch 监控日报\n今日无命中'
    await h.notifier.sendRaw(raw)
    const body = bodyOf(h)
    expect(body).toEqual({
      topic: 'forumwatch-hits',
      title: 'ForumWatch',
      message: raw,
      tags: ['bell']
    })
    expect(h.sleeps).toEqual([]) // 首条不限流等待
  })

  it('sendTest 成功：固定测试文案（对齐 telegram 测试消息措辞风格）', async () => {
    const h = makeHarness(() => okRes)
    await h.notifier.sendTest()
    expect(bodyOf(h).title).toBe('ForumWatch')
    expect(bodyOf(h).message).toBe('✅ ForumWatch 测试消息（ntfy）')
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
    expect((caught as Error).message).toContain('ntfy send failed after 3 attempts')
    expect((caught as Error).message).toContain('HTTP 500')
    expect((caught as Error).message).toContain('internal server error')
    expect(h.calls.length).toBe(3)
    expect(h.sleeps).toEqual([1000, 2000])
  })

  it('429 无 retry_after 特殊处理：与普通失败同走 1s/2s 退避（ntfy JSON publish 无结构化字段）', async () => {
    const h = makeHarness(() => tooManyRes)
    await expect(h.notifier.sendTest()).rejects.toThrow(/HTTP 429/)
    expect(h.calls.length).toBe(3)
    expect(h.sleeps).toEqual([1000, 2000])
  })

  it('网络异常同样 3 次尝试后抛 Error（消息含异常名）', async () => {
    const h = makeHarness(() => {
      throw new TypeError('fetch failed: ENOTFOUND')
    })
    await expect(h.notifier.sendTest()).rejects.toThrow(/TypeError: fetch failed/)
    expect(h.calls.length).toBe(3)
    expect(h.sleeps).toEqual([1000, 2000])
  })

  it('report 回调（成功态）：sendHit 最终成功 → report(id, true) 恰一次', async () => {
    const h = makeHarness(() => okRes)
    const calls: Array<[string, boolean, string?]> = []
    await h.notifier.sendHit({
      topic,
      matchedKeywords: ['x'],
      report: (channelId, ok, error) => calls.push([channelId, ok, error])
    })
    expect(calls).toEqual([['my-ntfy', true, undefined]])
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
    ).rejects.toThrow(/ntfy send failed/)
    expect(calls).toEqual([
      ['my-ntfy', false, 'ntfy send failed after 3 attempts: HTTP 500: internal server error']
    ])
  })

  it('未配置 topic → 立即抛 ntfy not configured，不发请求不等待，report 报失败', async () => {
    const h = makeHarness(() => okRes, { topic: '' })
    const calls: Array<[string, boolean, string?]> = []
    await expect(
      h.notifier.sendHit({
        topic,
        matchedKeywords: ['x'],
        report: (channelId, ok, error) => calls.push([channelId, ok, error])
      })
    ).rejects.toThrow('ntfy not configured')
    expect(h.calls.length).toBe(0)
    expect(h.sleeps).toEqual([])
    expect(calls).toEqual([['my-ntfy', false, 'ntfy not configured']])
  })

  it('getConfig 热更新：换 topic/serverUrl 后下一次发送即生效', async () => {
    const h = makeHarness(() => okRes)
    await h.notifier.sendTest()
    h.setConfig({ serverUrl: 'https://new-ntfy.example.com', topic: 'topic-2' })
    await h.notifier.sendTest()
    expect(h.calls[1]?.url).toBe('https://new-ntfy.example.com')
    expect(bodyOf(h, 1).topic).toBe('topic-2')
  })

  it('温和防抖：连续两次发送，第二次等待 200ms（非 telegram 的 1050ms 硬限速）', async () => {
    const h = makeHarness(() => okRes)
    await Promise.all([h.notifier.sendRaw('第一段'), h.notifier.sendRaw('第二段')])
    expect(h.calls.length).toBe(2)
    expect(h.sleeps).toEqual([200])
    const bodies = h.calls.map((c) => JSON.parse(c.init?.body ?? '{}') as { message: string })
    expect(bodies.map((b) => b.message)).toEqual(['第一段', '第二段']) // 保序
  })

  it('R6-W2：实现 Notifier 接口——id 来自构造、sendHit/sendRaw/sendTest 具名存在', async () => {
    const h = makeHarness(() => okRes)
    expect(h.notifier.id).toBe('my-ntfy')
    const n: { id: string; sendHit: unknown; sendRaw: unknown; sendTest: unknown } = h.notifier
    expect(typeof n.sendHit).toBe('function')
    expect(typeof n.sendRaw).toBe('function')
    expect(typeof n.sendTest).toBe('function')
  })
})

describe('通道就绪判定（R6-W2：ntfy 分支放开）', () => {
  const ntfyCh = (topicName: string, enabled = true) => ({
    id: 'my-ntfy',
    type: 'ntfy' as const,
    enabled,
    topic: topicName
  })

  it('channelCredentialsComplete：topic 非空（trim 后）才算齐备', () => {
    expect(channelCredentialsComplete(ntfyCh('alerts'))).toBe(true)
    expect(channelCredentialsComplete(ntfyCh(' alerts '))).toBe(true)
    expect(channelCredentialsComplete(ntfyCh(''))).toBe(false)
    expect(channelCredentialsComplete(ntfyCh('   '))).toBe(false)
  })

  it('isChannelReady：IMPLEMENTED_CHANNEL_TYPES 扩容后 enabled+凭据齐备的 ntfy 就绪', () => {
    expect(isChannelReady(ntfyCh('alerts'))).toBe(true)
    expect(isChannelReady(ntfyCh('alerts', false))).toBe(false) // enabled 仍参与判定
    expect(isChannelReady(ntfyCh(''))).toBe(false)
  })
})
