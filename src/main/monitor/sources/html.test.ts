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
      // issue #2 建议一：作者锚点 /space/{id} → 绝对个人主页链接
      authorUrl: 'https://www.nodeseek.com/space/60246',
      category: '交易',
      categorySlug: 'trade',
      pinned: false,
      lastActiveAt: '2026-09-19T03:47:55.000Z'
    })
  })

  it('作者链接：锚点缺失 / 非 /space/{id} 形态 → 不落 authorUrl 键（推送侧按缺省退化）', () => {
    const noHref = (
      '<html><body><ul class="post-list">' +
      '<li class="post-list-item"><div class="post-title"><a href="/post-100-1">t</a></div>' +
      '<div class="post-info"><span class="info-item info-author"><a>bob</a></span>' +
      '<a href="/categories/trade" class="info-item post-category">交易</a></div></li>' +
      '</ul></body></html>'
    )
    expect(parseHomepage(noHref)[0]).not.toHaveProperty('authorUrl')

    const foreignHref = noHref.replace('<a>bob</a>', '<a href="https://evil.example/u/bob">bob</a>')
    expect(parseHomepage(foreignHref)[0]).not.toHaveProperty('authorUrl')
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
    // authorUrl 同样随 baseUrl 解析（issue #2 建议一）
    expect(topics[1].authorUrl).toBe('http://localhost:1234/space/60246')
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
    // D3：id 是 seen 前缀 / state 键 / 状态键的稳定 slug
    expect(adapter.id).toBe('nodeseek')
    expect(adapter.name).toBe('NodeSeek')

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

describe('HtmlSourceAdapter.fetchLatest 第 2 页补抓（R5-P2a / DEC-8）', () => {
  /** 迷你页：两条帖子（id 见参），结构与 parseHomepage 选择器对齐 */
  function miniPage(idA: string, idB: string): string {
    return (
      '<html><body><ul class="post-list">' +
      `<li class="post-list-item"><div class="post-title"><a href="/post-${idA}-1">页面帖子A</a></div>` +
      '<div class="post-info"><span class="info-item info-author"><a href="/space/1">bob</a></span>' +
      '<a href="/categories/trade" class="info-item post-category">交易</a>' +
      '<a class="info-item info-last-comment-time"><time datetime="2026-09-19T01:00:00.000Z">t</time></a></div></li>' +
      `<li class="post-list-item"><div class="post-title"><a href="/post-${idB}-1">页面帖子B</a></div>` +
      '<div class="post-info"><span class="info-item info-author"><a href="/space/2">carol</a></span>' +
      '<a href="/categories/chat" class="info-item post-category">闲聊</a>' +
      '<a class="info-item info-last-comment-time"><time datetime="2026-09-19T02:00:00.000Z">t</time></a></div></li>' +
      '</ul></body></html>'
    )
  }

  /** 按 URL 分派响应体；第 2 页 URL 含 page-2 */
  function pagedFetch(page1: string, page2: string | Error) {
    return vi.fn(async (url: string, _init?: HttpRequestInit): Promise<HttpResponse> => {
      if (url.includes('page-2')) {
        if (page2 instanceof Error) throw page2
        return makeResponse({ body: page2 })
      }
      return makeResponse({ body: page1 })
    })
  }

  it('pages 缺省 / pages:1：仍只抓一页（现状不变）', async () => {
    const fetchHtml = okFetch()
    const adapter = new HtmlSourceAdapter({ fetchHtml })
    await adapter.fetchLatest()
    await adapter.fetchLatest({ pages: 1 })
    expect(fetchHtml).toHaveBeenCalledTimes(2)
    expect(fetchHtml.mock.calls.map((c) => c[0])).toEqual([
      'https://www.nodeseek.com/?sort=createTime',
      'https://www.nodeseek.com/?sort=createTime'
    ])
  })

  it('pages:2：第 2 页请求 ?sort=createTime&page-2；两页合并按 id 去重保序（第 1 页原序在前）', async () => {
    // 第 1 页：950100、950101；第 2 页：950101（重复）+ 950200（新）
    const fetchHtml = pagedFetch(miniPage('950100', '950101'), miniPage('950101', '950200'))
    const adapter = new HtmlSourceAdapter({ fetchHtml })
    const topics = await adapter.fetchLatest({ pages: 2 })

    expect(fetchHtml).toHaveBeenCalledTimes(2)
    expect(fetchHtml.mock.calls[0][0]).toBe('https://www.nodeseek.com/?sort=createTime')
    expect(fetchHtml.mock.calls[1][0]).toBe('https://www.nodeseek.com/?sort=createTime&page-2')
    expect(topics.map((t) => t.id)).toEqual(['950100', '950101', '950200'])
    // 重复 id 保留第 1 页的条目：第 1 页的 950101 是第二项（帖子B/carol），
    // 第 2 页的 950101 是第一项（帖子A/bob）——后者被丢弃
    expect(topics[1]).toMatchObject({ id: '950101', title: '页面帖子B', author: 'carol' })
    expect(topics[2]).toMatchObject({ id: '950200', title: '页面帖子B', author: 'carol' })
  })

  it('pages:2 且两页内容完全相同（服务端忽略页参数形态）：合并后等价单页', async () => {
    const same = miniPage('950100', '950101')
    const fetchHtml = pagedFetch(same, same)
    const adapter = new HtmlSourceAdapter({ fetchHtml })
    const topics = await adapter.fetchLatest({ pages: 2 })
    expect(topics.map((t) => t.id)).toEqual(['950100', '950101'])
  })

  it('第 2 页网络失败：整轮按第 1 页成功处理（console.warn，不抛）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const fetchHtml = pagedFetch(miniPage('950100', '950101'), new Error('network down'))
      const adapter = new HtmlSourceAdapter({ fetchHtml })
      const topics = await adapter.fetchLatest({ pages: 2 })
      expect(topics.map((t) => t.id)).toEqual(['950100', '950101'])
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('page 2 fetch failed'))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('第 2 页被挑战（403 → ChallengeError）：同样吞并，返回第 1 页', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const fetchHtml = vi.fn(async (url: string, _init?: HttpRequestInit): Promise<HttpResponse> => {
        if (url.includes('page-2')) return makeResponse({ status: 403, body: '' })
        return makeResponse({ body: miniPage('950100', '950101') })
      })
      const adapter = new HtmlSourceAdapter({ fetchHtml })
      const topics = await adapter.fetchLatest({ pages: 2 })
      expect(topics.map((t) => t.id)).toEqual(['950100', '950101'])
      expect(warnSpy).toHaveBeenCalledTimes(1)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('第 1 页失败：原样上抛（现状语义不变，即使 pages:2）', async () => {
    const boom = new Error('network down')
    const fetchHtml = vi.fn(async (_url: string, _init?: HttpRequestInit): Promise<HttpResponse> => {
      throw boom
    })
    const adapter = new HtmlSourceAdapter({ fetchHtml })
    await expect(adapter.fetchLatest({ pages: 2 })).rejects.toBe(boom)
    expect(fetchHtml).toHaveBeenCalledTimes(1) // 第 1 页就失败：不会去抓第 2 页
  })

  it('第 2 页解析 0 条（改版/被拦形态）：视为第 2 页失败，按第 1 页成功收尾', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const fetchHtml = pagedFetch(miniPage('950100', '950101'), '<html><body>nothing</body></html>')
      const adapter = new HtmlSourceAdapter({ fetchHtml })
      const topics = await adapter.fetchLatest({ pages: 2 })
      expect(topics.map((t) => t.id)).toEqual(['950100', '950101'])
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('parsed 0 topics'))
    } finally {
      warnSpy.mockRestore()
    }
  })
})
