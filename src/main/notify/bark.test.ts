/**
 * BarkNotifier 单测：post/now/sleep 全部注入 mock，零网络、零真实等待。
 * 风格对齐 telegram.test.ts（makeHarness 假时钟 + handler(callIndex)）。
 *
 * 另覆盖 R6-W2 types.ts 扩容面：channelCredentialsComplete 的 bark 分支与
 * isChannelReady 对 bark 的放开（IMPLEMENTED_CHANNEL_TYPES 扩为四类型）。
 */

import { describe, expect, it } from 'vitest'
import type { HttpResponse, HttpRequestInit, FetchLike } from '../net/http-types'
import type { Topic } from '@shared/types'
import type { BarkConfig } from './bark'
import { BarkNotifier, formatHitSummaryLine, truncateTitle, BARK_TITLE_MAX_CHARS } from './bark'
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

const defaultConfig: BarkConfig = { deviceKey: 'bark-device-key-1' }

/** Bark 网关成功响应（HTTP 200 + 业务码 200 双重口径） */
const okRes: HttpResponse = {
  status: 200,
  headers: {},
  body: '{"code":200,"message":"success","timestamp":1758268800}'
}
const serverErrRes: HttpResponse = { status: 500, headers: {}, body: 'internal error' }
/** HTTP 200 但业务码非 200（如 device_key 失效）——bark 特有的失败形态 */
const badCodeRes: HttpResponse = {
  status: 200,
  headers: {},
  body: '{"code":400,"message":"device key not found"}'
}

interface Harness {
  notifier: BarkNotifier
  /** 每次 post 的入参 */
  calls: Array<{ url: string; init?: HttpRequestInit }>
  /** 每次 sleep 的毫秒数 */
  sleeps: number[]
  setConfig: (c: BarkConfig) => void
}

/** handler(callIndex) 返回 HttpResponse 或抛错；now/sleep 为假时钟（sleep 推进时钟） */
function makeHarness(
  handler: (callIndex: number) => HttpResponse,
  config: BarkConfig = defaultConfig
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

  const notifier = new BarkNotifier({
    id: 'my-bark',
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

describe('truncateTitle（bark 标题截断）', () => {
  it('长度 ≤ 60 原样返回（中文/ASCII/表情混合）', () => {
    expect(truncateTitle('短标题')).toBe('短标题')
    expect(truncateTitle('a'.repeat(BARK_TITLE_MAX_CHARS))).toBe('a'.repeat(BARK_TITLE_MAX_CHARS))
  })

  it('超长截到 60 个 UTF-16 单元', () => {
    const long = '冰'.repeat(100)
    expect(truncateTitle(long)).toBe('冰'.repeat(60))
    expect(truncateTitle(long).length).toBe(60)
  })

  it('代理字符安全：截断点落在代理对中间时丢弃末尾高代理半字符', () => {
    // 59 个 ASCII + 一个 emoji（2 单元）+ 5 个 ASCII：截到 60 单元正好劈开 emoji
    const t = 'a'.repeat(59) + '😀' + 'bbbbb'
    const out = truncateTitle(t)
    expect(out).toBe('a'.repeat(59))
    expect(out.length).toBe(59)
    // 全 emoji：70 单元 → 60 单元恰为 30 个完整 emoji，无需弃半
    expect(truncateTitle('😀'.repeat(35))).toBe('😀'.repeat(30))
  })
})

describe('formatHitSummaryLine（bark body / ntfy message 共用摘要行）', () => {
  it('字面命中：[分类] 作者 · 命中: 词1, 词2', () => {
    expect(formatHitSummaryLine(topic, ['冰箱', '便宜'])).toBe('[交易] 张三<b> · 命中: 冰箱, 便宜')
  })

  it('规则命中（matchedRule 非空优先，对齐 telegram 的行选择）：· 命中规则: {label}', () => {
    expect(formatHitSummaryLine(topic, [], '白菜月付')).toBe('[交易] 张三<b> · 命中规则: 白菜月付')
    // 词与规则并存时规则行优先（引擎不会两者同给，防御性约定）
    expect(formatHitSummaryLine(topic, ['冰箱'], '白菜月付')).toContain('命中规则: 白菜月付')
  })

  it('语义命中：无词无规则 → · 语义命中（附 reason 时带冒号理由）', () => {
    expect(formatHitSummaryLine(topic, [], null, null)).toBe('[交易] 张三<b> · 语义命中')
    expect(formatHitSummaryLine(topic, [], null, '价格疑似低于市价')).toBe(
      '[交易] 张三<b> · 语义命中: 价格疑似低于市价'
    )
    // 空串 reason 视为无理由（与 telegram 的空串省略习惯一致）
    expect(formatHitSummaryLine(topic, [], null, '')).toBe('[交易] 张三<b> · 语义命中')
  })
})

describe('BarkNotifier', () => {
  it('sendHit 成功：官方默认端点 /push，JSON body 字段齐全（device_key/title/body/url/group）', async () => {
    const h = makeHarness(() => okRes)
    await h.notifier.sendHit({ topic, matchedKeywords: ['冰箱'] })

    expect(h.calls.length).toBe(1)
    expect(h.calls[0]?.url).toBe('https://api.day.app/push')
    const init = h.calls[0]?.init
    expect(init?.method).toBe('POST')
    expect(init?.headers?.['content-type']).toBe('application/json')
    const body = bodyOf(h)
    expect(body.device_key).toBe('bark-device-key-1')
    expect(body.title).toBe(topic.title)
    expect(body.body).toBe(formatHitSummaryLine(topic, ['冰箱']))
    expect(body.url).toBe(topic.url)
    expect(body.group).toBe('ForumWatch')
    expect(h.sleeps).toEqual([]) // 首条不等待
  })

  it('自定义 serverUrl：以其为端点 base，且去尾斜杠', async () => {
    const h = makeHarness(() => okRes, { serverUrl: 'https://bark.example.com/', deviceKey: 'k' })
    await h.notifier.sendHit({ topic, matchedKeywords: ['x'] })
    expect(h.calls[0]?.url).toBe('https://bark.example.com/push')
    expect(bodyOf(h).device_key).toBe('k')
  })

  it('sendHit 标题截断到 60 单元（超长中文标题）', async () => {
    const h = makeHarness(() => okRes)
    const longTopic: Topic = { ...topic, title: '冰'.repeat(100) }
    await h.notifier.sendHit({ topic: longTopic, matchedKeywords: [] })
    expect(bodyOf(h).title).toBe('冰'.repeat(60))
  })

  it('topic.url 为空串时 body 不带 url 字段', async () => {
    const h = makeHarness(() => okRes)
    await h.notifier.sendHit({ topic: { ...topic, url: '' }, matchedKeywords: ['x'] })
    expect(bodyOf(h)).not.toHaveProperty('url')
  })

  it('sendRaw 成功：标题固定 ForumWatch、正文原文透传、group 归组、无 url 字段', async () => {
    const h = makeHarness(() => okRes)
    const raw = '# ForumWatch 监控日报\n今日无命中'
    await h.notifier.sendRaw(raw)
    const body = bodyOf(h)
    expect(body).toEqual({
      device_key: 'bark-device-key-1',
      title: 'ForumWatch',
      body: raw,
      group: 'ForumWatch'
    })
    expect(h.sleeps).toEqual([]) // 首条不限流等待
  })

  it('sendTest 成功：固定测试文案（对齐 telegram 测试消息措辞风格）', async () => {
    const h = makeHarness(() => okRes)
    await h.notifier.sendTest()
    expect(bodyOf(h).title).toBe('ForumWatch')
    expect(bodyOf(h).body).toBe('✅ ForumWatch 测试消息（bark）')
  })

  it('500 → 1s 后重试成功（共 2 次请求）', async () => {
    const h = makeHarness((i) => (i === 0 ? serverErrRes : okRes))
    await h.notifier.sendTest()
    expect(h.calls.length).toBe(2)
    expect(h.sleeps).toEqual([1000])
  })

  it('连续 3 次 500 → throw Error（含通道类型与状态码），退避 1s/2s', async () => {
    const h = makeHarness(() => serverErrRes)
    let caught: unknown
    await h.notifier.sendTest().catch((e: unknown) => {
      caught = e
    })
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('bark send failed after 3 attempts')
    expect((caught as Error).message).toContain('HTTP 500')
    expect(h.calls.length).toBe(3)
    expect(h.sleeps).toEqual([1000, 2000])
  })

  it('HTTP 200 但业务码 400 → 视为失败重试，恢复 code=200 后成功', async () => {
    const h = makeHarness((i) => (i === 0 ? badCodeRes : okRes))
    await h.notifier.sendTest()
    expect(h.calls.length).toBe(2)
    expect(h.sleeps).toEqual([1000])
  })

  it('连续 3 次 2xx 但 code=400 → throw，错误消息带 code 与响应 message 字段', async () => {
    const h = makeHarness(() => badCodeRes)
    let caught: unknown
    await h.notifier.sendTest().catch((e: unknown) => {
      caught = e
    })
    const msg = (caught as Error).message
    expect(msg).toContain('bark send failed after 3 attempts')
    expect(msg).toContain('code=400')
    expect(msg).toContain('device key not found')
    expect(h.calls.length).toBe(3)
  })

  it('2xx 但响应非 JSON → 失败重试，错误消息带 invalid JSON 提示', async () => {
    const notJsonRes: HttpResponse = { status: 200, headers: {}, body: '<html>gateway</html>' }
    const h = makeHarness(() => notJsonRes)
    await expect(h.notifier.sendTest()).rejects.toThrow(/invalid JSON body/)
    expect(h.calls.length).toBe(3)
  })

  it('网络异常同样 3 次尝试后抛 Error（消息含异常名）', async () => {
    const h = makeHarness(() => {
      throw new TypeError('fetch failed: ECONNREFUSED')
    })
    await expect(h.notifier.sendTest()).rejects.toThrow(/TypeError: fetch failed/)
    expect(h.calls.length).toBe(3)
    expect(h.sleeps).toEqual([1000, 2000])
  })

  it('report 回调（成功态）：sendHit 最终成功 → report(id, true) 恰一次、无 error 参', async () => {
    const h = makeHarness(() => okRes)
    const calls: Array<[string, boolean, string?]> = []
    await h.notifier.sendHit({
      topic,
      matchedKeywords: ['x'],
      report: (channelId, ok, error) => calls.push([channelId, ok, error])
    })
    expect(calls).toEqual([['my-bark', true, undefined]])
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
    ).rejects.toThrow(/bark send failed/)
    expect(calls).toEqual([['my-bark', false, 'bark send failed after 3 attempts: HTTP 500: internal error']])
  })

  it('report 回调（中间失败不触发）：500→200 成功只报成功一次', async () => {
    const h = makeHarness((i) => (i === 0 ? serverErrRes : okRes))
    const calls: Array<[string, boolean]> = []
    await h.notifier.sendHit({
      topic,
      matchedKeywords: [],
      report: (channelId, ok) => calls.push([channelId, ok])
    })
    expect(calls).toEqual([['my-bark', true]])
  })

  it('未配置 deviceKey → 立即抛 bark not configured，不发请求不等待，report 报失败', async () => {
    const h = makeHarness(() => okRes, { deviceKey: '' })
    const calls: Array<[string, boolean, string?]> = []
    await expect(
      h.notifier.sendHit({
        topic,
        matchedKeywords: ['x'],
        report: (channelId, ok, error) => calls.push([channelId, ok, error])
      })
    ).rejects.toThrow('bark not configured')
    expect(h.calls.length).toBe(0)
    expect(h.sleeps).toEqual([])
    expect(calls).toEqual([['my-bark', false, 'bark not configured']])
  })

  it('getConfig 热更新：换 deviceKey/serverUrl 后下一次发送即生效', async () => {
    const h = makeHarness(() => okRes)
    await h.notifier.sendTest()
    h.setConfig({ serverUrl: 'https://new-bark.example.com', deviceKey: 'key-2' })
    await h.notifier.sendTest()
    expect(h.calls[1]?.url).toBe('https://new-bark.example.com/push')
    expect(bodyOf(h, 1).device_key).toBe('key-2')
  })

  it('温和防抖：连续两次发送，第二次等待 200ms（非 telegram 的 1050ms 硬限速）', async () => {
    const h = makeHarness(() => okRes)
    await Promise.all([h.notifier.sendRaw('第一段'), h.notifier.sendRaw('第二段')])
    expect(h.calls.length).toBe(2)
    expect(h.sleeps).toEqual([200])
    const bodies = h.calls.map((c) => JSON.parse(c.init?.body ?? '{}') as { body: string })
    expect(bodies.map((b) => b.body)).toEqual(['第一段', '第二段']) // 保序
  })

  it('R6-W2：实现 Notifier 接口——id 来自构造、sendHit/sendRaw/sendTest 具名存在', async () => {
    const h = makeHarness(() => okRes)
    expect(h.notifier.id).toBe('my-bark')
    const n: { id: string; sendHit: unknown; sendRaw: unknown; sendTest: unknown } = h.notifier
    expect(typeof n.sendHit).toBe('function')
    expect(typeof n.sendRaw).toBe('function')
    expect(typeof n.sendTest).toBe('function')
  })
})

describe('通道就绪判定（R6-W2：bark 分支放开）', () => {
  const barkCh = (deviceKey: string, enabled = true) => ({
    id: 'my-bark',
    type: 'bark' as const,
    enabled,
    deviceKey
  })

  it('channelCredentialsComplete：deviceKey 非空（trim 后）才算齐备', () => {
    expect(channelCredentialsComplete(barkCh('k'))).toBe(true)
    expect(channelCredentialsComplete(barkCh(' k '))).toBe(true)
    expect(channelCredentialsComplete(barkCh(''))).toBe(false)
    expect(channelCredentialsComplete(barkCh('   '))).toBe(false)
  })

  it('isChannelReady：IMPLEMENTED_CHANNEL_TYPES 扩容后 enabled+凭据齐备的 bark 就绪', () => {
    expect(isChannelReady(barkCh('k'))).toBe(true)
    expect(isChannelReady(barkCh('k', false))).toBe(false) // enabled 仍参与判定
    expect(isChannelReady(barkCh(''))).toBe(false)
  })
})
