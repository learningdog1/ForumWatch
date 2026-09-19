import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { ChallengeError } from '../types'
import { DEFAULT_BASE_URL, HtmlSourceAdapter, parseHomepage } from './html'
import type { HttpRequestInit, HttpResponse } from '../../net/http-types'

const fixtureHtml: string = readFileSync(
  fileURLToPath(new URL('../fixtures/homepage.html', import.meta.url)),
  'utf-8'
)

function makeResponse(partial: Partial<HttpResponse> = {}): HttpResponse {
  return { status: 200, headers: {}, body: fixtureHtml, ...partial }
}

function okFetch(body: string = fixtureHtml) {
  return vi.fn(
    async (_url: string, _init?: HttpRequestInit): Promise<HttpResponse> =>
      makeResponse({ body })
  )
}

describe('parseHomepage', () => {
  it('解析真实首页 fixture：≥40 条，id/url 一致', () => {
    const topics = parseHomepage(fixtureHtml)
    expect(topics.length).toBeGreaterThanOrEqual(40)
    expect(topics).toHaveLength(49)
    for (const topic of topics) {
      expect(topic.id).toMatch(/^\d+$/)
      expect(topic.url).toBe(`${DEFAULT_BASE_URL}/post-${topic.id}-1`)
    }
  })

  it('第二个帖子字段齐全（非置顶、有分类与活跃时间）', () => {
    const second = parseHomepage(fixtureHtml)[1]
    expect(second).toEqual({
      id: '936634',
      sourceId: '', // adapter 不盖章，engine 处理时按来源补（D2/D3）
      title: '收一个oracle圣荷西',
      url: 'https://www.nodeseek.com/post-936634-1',
      author: '没想好',
      category: '交易',
      categorySlug: 'trade',
      pinned: false,
      lastActiveAt: '2026-09-19T03:47:55.000Z'
    })
  })

  it('第一个帖子（iLatency公测…）是置顶', () => {
    const first = parseHomepage(fixtureHtml)[0]
    expect(first.id).toBe('832584')
    expect(first.title).toContain('iLatency公测')
    expect(first.pinned).toBe(true)
    expect(first.categorySlug).toBe('dev')
  })

  it('自定义 baseUrl 生成绝对链接', () => {
    const topics = parseHomepage(fixtureHtml, 'http://localhost:1234')
    expect(topics[1].url).toBe('http://localhost:1234/post-936634-1')
  })

  it('空字符串 / 无关 HTML → []（不抛错）', () => {
    expect(parseHomepage('')).toEqual([])
    expect(parseHomepage('<html><body><h1>hello</h1></body></html>')).toEqual([])
  })
})

describe('HtmlSourceAdapter.fetchLatest', () => {
  it('请求 ?sort=createTime，带浏览器头与 10s 超时', async () => {
    const fetchHtml = okFetch()
    const adapter = new HtmlSourceAdapter({ fetchHtml })
    expect(adapter.name).toBeTruthy()

    const topics = await adapter.fetchLatest()
    expect(topics).toHaveLength(49)

    expect(fetchHtml).toHaveBeenCalledTimes(1)
    const [url, init] = fetchHtml.mock.calls[0]
    expect(url).toBe('https://www.nodeseek.com/?sort=createTime')
    expect(init?.method).toBe('GET')
    expect(init?.timeoutMs).toBe(10_000)
    expect(init?.headers?.['User-Agent']).toMatch(/^Mozilla\/5\.0 \(Macintosh/)
    expect(init?.headers?.Accept).toBe('text/html,application/xhtml+xml')
    expect(init?.headers?.['Accept-Language']).toBe('zh-CN,zh;q=0.9')
  })

  it('baseUrl 注入覆盖请求 URL 与 Topic.url', async () => {
    const fetchHtml = okFetch()
    const adapter = new HtmlSourceAdapter({ fetchHtml, baseUrl: 'https://mirror.example' })
    const topics = await adapter.fetchLatest()
    expect(fetchHtml.mock.calls[0][0]).toBe('https://mirror.example/?sort=createTime')
    expect(topics[0].url).toMatch(/^https:\/\/mirror\.example\/post-\d+-1$/)
  })

  it('解析出 0 条 → 抛错（0 条不是无新帖）', async () => {
    const fetchHtml = okFetch('<html><body>nothing here</body></html>')
    const adapter = new HtmlSourceAdapter({ fetchHtml })
    await expect(adapter.fetchLatest()).rejects.toThrow(/parsed 0 topics/)
  })

  it('HTTP 403 → ChallengeError', async () => {
    const fetchHtml = vi.fn(
      async (_url: string, _init?: HttpRequestInit): Promise<HttpResponse> =>
        makeResponse({ status: 403, body: '' })
    )
    const adapter = new HtmlSourceAdapter({ fetchHtml })
    const error: unknown = await adapter.fetchLatest().then(
      () => undefined,
      (err: unknown) => err
    )
    expect(error).toBeInstanceOf(ChallengeError)
    expect(error instanceof Error && error.name).toBe('ChallengeError')
  })

  it('200 但响应头 cf-mitigated: challenge → ChallengeError', async () => {
    const fetchHtml = vi.fn(
      async (_url: string, _init?: HttpRequestInit): Promise<HttpResponse> =>
        makeResponse({ headers: { 'cf-mitigated': 'challenge' }, body: '' })
    )
    const adapter = new HtmlSourceAdapter({ fetchHtml })
    await expect(adapter.fetchLatest()).rejects.toThrow(ChallengeError)
  })

  it('非 2xx 且非挑战 → 普通错误（含状态码）', async () => {
    const fetchHtml = vi.fn(
      async (_url: string, _init?: HttpRequestInit): Promise<HttpResponse> =>
        makeResponse({ status: 500, body: 'oops' })
    )
    const adapter = new HtmlSourceAdapter({ fetchHtml })
    const error: unknown = await adapter.fetchLatest().then(
      () => undefined,
      (err: unknown) => err
    )
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(ChallengeError)
    expect(error instanceof Error && error.message).toContain('500')
  })

  it('fetchHtml reject → 原样上抛（同一错误实例）', async () => {
    const boom = new Error('network down')
    const fetchHtml = vi.fn(
      async (_url: string, _init?: HttpRequestInit): Promise<HttpResponse> => {
        throw boom
      }
    )
    const adapter = new HtmlSourceAdapter({ fetchHtml })
    await expect(adapter.fetchLatest()).rejects.toBe(boom)
  })
})
