import { describe, expect, it, vi } from 'vitest'
import { ChallengeError } from '../types'
import { DEFAULT_BASE_URL, V2exSourceAdapter } from './v2ex'
import type { HttpRequestInit, HttpResponse } from '../../net/http-types'

/**
 * 实测形态的 mock（2026-09-19 curl /api/topics/latest.json）：
 * id 1243131–1243180 区间、url /t/{id}、member/node 嵌套、created/last_touched unix 秒。
 * member/node 各带契约外多余字段，验证只取 username / name / title。
 */
const fullItem = {
  id: 1243180,
  title: '有没有好用的 RSS 阅读器推荐',
  url: 'https://www.v2ex.com/t/1243180',
  content: '正文内容，映射为 Topic.excerpt（截断见 rss adapter 的 toExcerpt）',
  replies: 12,
  created: 1700000000,
  last_touched: 1700000061,
  member: { id: 1, username: 'alice', avatar: 'https://cdn.v2ex.com/avatar/a.png' },
  node: {
    id: 2,
    name: 'qna',
    title: '问与答',
    url: 'https://www.v2ex.com/go/qna',
    title_alternative: 'Questions and Answers'
  }
}

function makeResponse(partial: Partial<HttpResponse> = {}): HttpResponse {
  return { status: 200, headers: {}, body: JSON.stringify([fullItem]), ...partial }
}

function okFetch(body: string = JSON.stringify([fullItem])) {
  return vi.fn(
    async (_url: string, _init?: HttpRequestInit): Promise<HttpResponse> =>
      makeResponse({ body })
  )
}

describe('V2exSourceAdapter.fetchLatest', () => {
  it('请求 latest 端点，带浏览器 UA 与 10s 超时；默认 id/name/能力声明', async () => {
    const fetchJson = okFetch()
    const adapter = new V2exSourceAdapter({ fetchJson })
    // D3：id 是 seen 前缀 / state 键 / 状态键的稳定 slug
    expect(adapter.id).toBe('v2ex')
    expect(adapter.name).toBe('V2EX')
    // W3：id 随创建单调递增（实测 newest 1243180 > oldest 1243131）
    expect(adapter.creationOrderedIds).toBe(true)

    const topics = await adapter.fetchLatest()
    expect(topics).toHaveLength(1)

    expect(fetchJson).toHaveBeenCalledTimes(1)
    const [url, init] = fetchJson.mock.calls[0]
    expect(url).toBe(`${DEFAULT_BASE_URL}/api/topics/latest.json`)
    expect(init?.method).toBe('GET')
    expect(init?.timeoutMs).toBe(10_000)
    expect(init?.headers?.['User-Agent']).toMatch(/^Mozilla\/5\.0 \(Macintosh/)
    expect(init?.headers?.Accept).toBe('application/json')
  })

  it('字段映射全断言（member/node 嵌套取对字段，id 数字转字符串，pinned 恒 false）', async () => {
    const adapter = new V2exSourceAdapter({ fetchJson: okFetch() })
    const topics = await adapter.fetchLatest()
    expect(topics[0]).toEqual({
      id: '1243180',
      sourceId: '', // adapter 不盖章，engine 处理时按来源补（D2/D3）
      title: '有没有好用的 RSS 阅读器推荐',
      url: 'https://www.v2ex.com/t/1243180',
      author: 'alice',
      // issue #2 建议一：username 非空 → 会员页链接
      authorUrl: 'https://www.v2ex.com/member/alice',
      category: '问与答',
      categorySlug: 'qna',
      pinned: false,
      lastActiveAt: '2023-11-14T22:14:21.000Z', // last_touched=1700000061
      excerpt: '正文内容，映射为 Topic.excerpt（截断见 rss adapter 的 toExcerpt）'
    })
  })

  it('authorUrl：username 缺失 / 空串 → 不落键；baseUrl 注入随 baseUrl 构造', async () => {
    const fetchJson = okFetch(
      JSON.stringify([
        { ...fullItem, id: 1243176, member: null },
        { ...fullItem, id: 1243175, member: { username: '   ' } }
      ])
    )
    const topics = await new V2exSourceAdapter({ fetchJson }).fetchLatest()
    expect('authorUrl' in topics[0]!).toBe(false)
    expect('authorUrl' in topics[1]!).toBe(false)

    const mirror = await new V2exSourceAdapter({
      fetchJson: okFetch(),
      baseUrl: 'https://mirror.example'
    }).fetchLatest()
    expect(mirror[0].authorUrl).toBe('https://mirror.example/member/alice')
  })

  it('content 缺失 / 空白 → 不写 excerpt 键（undefined 容忍约定）', async () => {
    const noContent = { ...fullItem, id: 1243178 }
    delete (noContent as Partial<typeof fullItem>).content
    const blankContent = { ...fullItem, id: 1243177, content: '   ' }
    const fetchJson = vi.fn(
      async (): Promise<HttpResponse> => ({ status: 200, headers: {}, body: JSON.stringify([noContent, blankContent]) })
    )
    const topics = await new V2exSourceAdapter({ fetchJson }).fetchLatest()
    expect('excerpt' in topics[0]!).toBe(false)
    expect('excerpt' in topics[1]!).toBe(false)
  })

  it('member/node 缺失 → author 与 category/categorySlug 兜底空串', async () => {
    const bare = {
      id: 1243179,
      title: '裸帖',
      url: 'https://www.v2ex.com/t/1243179',
      created: 1700000000
    }
    const fetchJson = okFetch(JSON.stringify([bare]))
    const topics = await new V2exSourceAdapter({ fetchJson }).fetchLatest()
    expect(topics[0].author).toBe('')
    expect(topics[0].category).toBe('')
    expect(topics[0].categorySlug).toBe('')
  })

  it('lastActiveAt 优先 last_touched，缺则 created，都缺则 null', async () => {
    const fetchJson = okFetch(
      JSON.stringify([
        { id: 1, title: 'a', url: 'https://www.v2ex.com/t/1', created: 1700000000, last_touched: 1700000061 },
        { id: 2, title: 'b', url: 'https://www.v2ex.com/t/2', created: 1700000000 },
        { id: 3, title: 'c', url: 'https://www.v2ex.com/t/3' }
      ])
    )
    const topics = await new V2exSourceAdapter({ fetchJson }).fetchLatest()
    expect(topics[0].lastActiveAt).toBe('2023-11-14T22:14:21.000Z') // last_touched
    expect(topics[1].lastActiveAt).toBe('2023-11-14T22:13:20.000Z') // created 兜底
    expect(topics[2].lastActiveAt).toBeNull()
  })

  it('构造传入自定义 id（装配方用 config.sources 里的 id）', () => {
    const adapter = new V2exSourceAdapter({ fetchJson: okFetch(), id: 'v2ex-mirror' })
    expect(adapter.id).toBe('v2ex-mirror')
    expect(adapter.name).toBe('V2EX')
  })

  it('baseUrl 注入覆盖请求 URL', async () => {
    const fetchJson = okFetch()
    await new V2exSourceAdapter({ fetchJson, baseUrl: 'https://mirror.example' }).fetchLatest()
    expect(fetchJson.mock.calls[0][0]).toBe('https://mirror.example/api/topics/latest.json')
  })

  it('HTTP 403 → ChallengeError', async () => {
    const fetchJson = vi.fn(
      async (_url: string, _init?: HttpRequestInit): Promise<HttpResponse> =>
        makeResponse({ status: 403, body: '' })
    )
    const adapter = new V2exSourceAdapter({ fetchJson })
    const error: unknown = await adapter.fetchLatest().then(
      () => undefined,
      (err: unknown) => err
    )
    expect(error).toBeInstanceOf(ChallengeError)
    expect(error instanceof Error && error.name).toBe('ChallengeError')
  })

  it('200 但响应头 cf-mitigated: challenge → ChallengeError', async () => {
    const fetchJson = vi.fn(
      async (_url: string, _init?: HttpRequestInit): Promise<HttpResponse> =>
        makeResponse({ headers: { 'cf-mitigated': 'challenge' }, body: '' })
    )
    const adapter = new V2exSourceAdapter({ fetchJson })
    await expect(adapter.fetchLatest()).rejects.toThrow(ChallengeError)
  })

  it('HTTP 429 → 普通错误，消息含 rate limit 与调大轮询间隔提示', async () => {
    const fetchJson = vi.fn(
      async (_url: string, _init?: HttpRequestInit): Promise<HttpResponse> =>
        makeResponse({ status: 429, body: '' })
    )
    const adapter = new V2exSourceAdapter({ fetchJson })
    const error: unknown = await adapter.fetchLatest().then(
      () => undefined,
      (err: unknown) => err
    )
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(ChallengeError)
    expect(error instanceof Error && error.message).toContain('rate limit')
    expect(error instanceof Error && error.message).toContain('poll interval')
  })

  it('空数组（0 条）→ 抛错（latest 恒 40 帖，0 条是异常形态）', async () => {
    const fetchJson = okFetch('[]')
    const adapter = new V2exSourceAdapter({ fetchJson })
    await expect(adapter.fetchLatest()).rejects.toThrow(/parsed 0 topics/)
  })

  it('非 2xx 且非挑战 → 普通错误（含状态码）', async () => {
    const fetchJson = vi.fn(
      async (_url: string, _init?: HttpRequestInit): Promise<HttpResponse> =>
        makeResponse({ status: 500, body: 'oops' })
    )
    const adapter = new V2exSourceAdapter({ fetchJson })
    const error: unknown = await adapter.fetchLatest().then(
      () => undefined,
      (err: unknown) => err
    )
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(ChallengeError)
    expect(error instanceof Error && error.message).toContain('500')
  })

  it('坏 JSON → 抛错', async () => {
    const fetchJson = okFetch('{"id": 1243180, "title": "截断的') // 缺右引号与括号，JSON.parse 必败
    const adapter = new V2exSourceAdapter({ fetchJson })
    await expect(adapter.fetchLatest()).rejects.toThrow(/not valid JSON/)
  })

  it('合法 JSON 但非数组 → 抛错', async () => {
    const fetchJson = okFetch('{"error": "something wrong"}')
    const adapter = new V2exSourceAdapter({ fetchJson })
    await expect(adapter.fetchLatest()).rejects.toThrow(/not a JSON array/)
  })

  it('fetchJson reject → 原样上抛（同一错误实例）', async () => {
    const boom = new Error('network down')
    const fetchJson = vi.fn(
      async (_url: string, _init?: HttpRequestInit): Promise<HttpResponse> => {
        throw boom
      }
    )
    const adapter = new V2exSourceAdapter({ fetchJson })
    await expect(adapter.fetchLatest()).rejects.toBe(boom)
  })
})
