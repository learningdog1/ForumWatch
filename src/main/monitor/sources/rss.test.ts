import { describe, expect, it, vi } from 'vitest'
import { ChallengeError } from '../types'
import { RssSourceAdapter, parseFeed } from './rss'
import type { SourceAdapter } from '../types'
import type { HttpRequestInit, HttpResponse } from '../../net/http-types'

/** Discourse 风格 RSS 2.0 真实形态样本：dc:creator、tag: 形式 guid、多 category */
const DISCOURSE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>LINUX DO</title>
    <link>https://linux.do/</link>
    <atom:link href="https://linux.do/latest.rss" rel="self" type="application/rss+xml"/>
    <item>
      <title>软路由选购 &amp; 折腾记录</title>
      <link>https://linux.do/t/topic/778899</link>
      <guid>tag:linux.do,2005:Topic/778899</guid>
      <dc:creator>wuxiaowu</dc:creator>
      <category>开发调优</category>
      <category>福利羊毛</category>
      <pubDate>Fri, 18 Sep 2026 16:30:00 GMT</pubDate>
    </item>
    <item>
      <title>出一张闲置显卡</title>
      <link>https://linux.do/t/gpu-sale/778900/12</link>
      <guid>tag:linux.do,2005:Topic/778900</guid>
      <dc:creator>alice</dc:creator>
      <category>跳蚤市场</category>
      <pubDate>not-a-date</pubDate>
    </item>
    <item>
      <title>无 creator / category / pubDate 的条目</title>
      <link>https://linux.do/t/bare-item/778901</link>
      <guid>tag:linux.do,2005:Topic/778901</guid>
    </item>
  </channel>
</rss>`

/** Atom 样本：link@rel=alternate 优先、无 rel 链接、category@term（含带文本形态） */
const ATOM_FEED = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Forum</title>
  <link href="https://forum.example/"/>
  <updated>2026-09-19T10:00:00Z</updated>
  <entry>
    <title type="html">首发 &amp; 开箱</title>
    <link rel="self" href="https://forum.example/t/first-post/555.json"/>
    <link rel="alternate" href="https://forum.example/t/first-post/555"/>
    <id>tag:forum.example,2026:Post/555</id>
    <author><name>bob</name></author>
    <category term="support"/>
    <updated>2026-09-19T09:00:00Z</updated>
  </entry>
  <entry>
    <title>无 rel 的链接条目</title>
    <link href="https://forum.example/t/second/556"/>
    <id>tag:forum.example,2026:Post/556</id>
    <author><name>carol</name></author>
    <category term="chat">闲聊灌水</category>
    <updated>2026-09-18T08:00:00Z</updated>
  </entry>
</feed>`

const FEED_URL = 'https://linux.do/latest.rss'

function makeResponse(partial: Partial<HttpResponse> = {}): HttpResponse {
  return { status: 200, headers: {}, body: DISCOURSE_RSS, ...partial }
}

function okFetch(body: string = DISCOURSE_RSS) {
  return vi.fn(
    async (_url: string, _init?: HttpRequestInit): Promise<HttpResponse> =>
      makeResponse({ body })
  )
}

/** 拼一条最小 RSS item（id 提取矩阵用） */
function rssItemXml(fields: Record<string, string | undefined>): string {
  const inner = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([tag, value]) => `<${tag}>${value}</${tag}>`)
    .join('')
  return `<?xml version="1.0"?><rss version="2.0"><channel><item>${inner}</item></channel></rss>`
}

describe('parseFeed：RSS 2.0', () => {
  it('Discourse 风格样本：条目数与首条字段全断言', () => {
    const topics = parseFeed(DISCOURSE_RSS, FEED_URL)
    expect(topics).toHaveLength(3)
    expect(topics[0]).toEqual({
      id: '778899',
      sourceId: '', // adapter 不盖章，engine 处理时按来源补（D2/D3）
      title: '软路由选购 & 折腾记录',
      url: 'https://linux.do/t/topic/778899',
      author: 'wuxiaowu',
      category: '开发调优', // 多 category 取首个
      categorySlug: '开发调优', // RSS 无 slug 概念，同 category
      pinned: false, // RSS 无置顶语义
      lastActiveAt: '2026-09-18T16:30:00.000Z'
    })
  })

  it('pubDate 解析失败 → lastActiveAt null；链接带楼层尾段时 guid 仍胜出', () => {
    const topics = parseFeed(DISCOURSE_RSS, FEED_URL)
    expect(topics[1].id).toBe('778900') // link 尾段是 /12，guid 才是主题 id
    expect(topics[1].url).toBe('https://linux.do/t/gpu-sale/778900/12') // url 忠实取 link
    expect(topics[1].lastActiveAt).toBeNull()
  })

  it('缺 creator / category / pubDate → 空串 / 空串 / null', () => {
    const topics = parseFeed(DISCOURSE_RSS, FEED_URL)
    expect(topics[2].author).toBe('')
    expect(topics[2].category).toBe('')
    expect(topics[2].categorySlug).toBe('')
    expect(topics[2].lastActiveAt).toBeNull()
  })
})

describe('parseFeed：摘要提取（description / summary → Topic.excerpt）', () => {
  it('RSS description（CDATA 包 HTML 片段）→ 剥标签 + 压缩空白 + 截断 160', () => {
    const longBody = '字'.repeat(300)
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item>
        <title>带正文摘要的帖子</title>
        <link>https://linux.do/t/topic/100</link>
        <description><![CDATA[<p>想配一台 <b>ALL-IN-ONE</b> 软路由，<br/>预算 500 内。</p><p>${longBody}</p>]]></description>
      </item>
    </channel></rss>`
    const [topic] = parseFeed(xml, FEED_URL)
    const excerpt = topic!.excerpt!
    // CDATA 内容是纯文本（XML 不解析其中的标签），剥标签由 toExcerpt 的 HTML
    // 解析完成；</p><p> 边界拼接无空格（"内。字"）
    expect(excerpt.startsWith('想配一台 ALL-IN-ONE 软路由，预算 500 内。字')).toBe(true)
    expect(excerpt.length).toBe(160)
    expect(excerpt.endsWith('…')).toBe(true)
    expect(excerpt).not.toContain('<')
  })

  it('RSS description 实体转义形态（&lt;p&gt;…）→ 同样剥净并解码实体', () => {
    const xml = rssItemXml({
      title: '转义正文',
      link: 'https://linux.do/t/topic/101',
      // XML 解码一层（&amp;amp; → &amp;），toExcerpt 的 HTML 解析再解码一层（→ &）
      description: '&lt;p&gt;9 成新 &amp;amp; 带发票&lt;/p&gt;'
    })
    const [topic] = parseFeed(xml, FEED_URL)
    expect(topic!.excerpt).toBe('9 成新 & 带发票')
  })

  it('无 description / 纯空白 description → 不写 excerpt 键（undefined 容忍约定）', () => {
    const bare = parseFeed(rssItemXml({ title: '无摘要', link: 'https://linux.do/t/topic/102' }), FEED_URL)
    expect('excerpt' in bare[0]!).toBe(false)
    const blank = parseFeed(
      rssItemXml({ title: '空摘要', link: 'https://linux.do/t/topic/103', description: '   ' }),
      FEED_URL
    )
    expect('excerpt' in blank[0]!).toBe(false)
  })

  it('Atom：summary 优先于 content；两者皆缺不写键', () => {
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>summary 优先</title>
        <link href="https://forum.example/t/200"/>
        <id>tag:forum.example,2026:Post/200</id>
        <summary>短摘要 &amp; 关键信息</summary>
        <content>这是更长的全文 content，不应被采用</content>
      </entry>
      <entry>
        <title>只有 content</title>
        <link href="https://forum.example/t/201"/>
        <id>tag:forum.example,2026:Post/201</id>
        <content>content 退路正文</content>
      </entry>
      <entry>
        <title>两者皆缺</title>
        <link href="https://forum.example/t/202"/>
        <id>tag:forum.example,2026:Post/202</id>
      </entry>
    </feed>`
    const topics = parseFeed(xml, FEED_URL)
    expect(topics[0]!.excerpt).toBe('短摘要 & 关键信息')
    expect(topics[1]!.excerpt).toBe('content 退路正文')
    expect('excerpt' in topics[2]!).toBe(false)
  })
})

describe('parseFeed：Atom', () => {
  it('rel=alternate 优先于 rel=self；author/name 与 category@term 映射', () => {
    const topics = parseFeed(ATOM_FEED, 'https://forum.example/feed.atom')
    expect(topics).toHaveLength(2)
    expect(topics[0]).toEqual({
      id: '555',
      sourceId: '',
      title: '首发 & 开箱',
      url: 'https://forum.example/t/first-post/555',
      author: 'bob',
      category: 'support', // 无文本时用 @term
      categorySlug: 'support',
      pinned: false,
      lastActiveAt: '2026-09-19T09:00:00.000Z'
    })
  })

  it('无 rel 链接可用；category 有文本时 category=文本、slug=term', () => {
    const topics = parseFeed(ATOM_FEED, 'https://forum.example/feed.atom')
    expect(topics[1].url).toBe('https://forum.example/t/second/556')
    expect(topics[1].category).toBe('闲聊灌水')
    expect(topics[1].categorySlug).toBe('chat')
    expect(topics[1].lastActiveAt).toBe('2026-09-18T08:00:00.000Z')
  })
})

describe('parseFeed：id 提取矩阵', () => {
  it('Discourse guid（tag:linux.do,2005:Topic/12345）优先于 link 中的数字', () => {
    const xml = rssItemXml({
      guid: 'tag:linux.do,2005:Topic/12345',
      link: 'https://linux.do/t/slug/99999'
    })
    expect(parseFeed(xml, FEED_URL)[0].id).toBe('12345')
  })

  it('guid 与 link 数字不一致时以 guid 为准（guid 是规范 id）', () => {
    const xml = rssItemXml({
      guid: 'tag:linux.do,2005:Topic/111',
      link: 'https://linux.do/t/slug/222'
    })
    expect(parseFeed(xml, FEED_URL)[0].id).toBe('111')
  })

  it('Vanilla 链接 /discussion/12345/slug（无 guid）', () => {
    const xml = rssItemXml({ link: 'https://forum.example/discussion/12345/slug' })
    expect(parseFeed(xml, FEED_URL)[0].id).toBe('12345')
  })

  it('Discourse 链接 /t/slug/12345（含楼层尾段形态 /t/slug/12345/7）', () => {
    expect(
      parseFeed(rssItemXml({ link: 'https://linux.do/t/slug/12345' }), FEED_URL)[0].id
    ).toBe('12345')
    expect(
      parseFeed(rssItemXml({ link: 'https://linux.do/t/slug/12345/7' }), FEED_URL)[0].id
    ).toBe('12345')
  })

  it('guid 尾部带斜杠也能取数（tag:…/314/）', () => {
    const xml = rssItemXml({ guid: 'tag:x.example,2005:Topic/314/' })
    expect(parseFeed(xml, FEED_URL)[0].id).toBe('314')
  })

  it('guid 非数字但 link 有数字 → 取 link 数字', () => {
    const xml = rssItemXml({ guid: 'not-numeric', link: 'https://h.example/t/topic/424242' })
    expect(parseFeed(xml, FEED_URL)[0].id).toBe('424242')
  })

  it('纯文本 guid 兜底：全无数字时用 guid 原文保证稳定唯一', () => {
    const xml = rssItemXml({
      guid: 'unique-text-guid-xyz',
      link: 'https://h.example/posts/no-numbers-here'
    })
    expect(parseFeed(xml, FEED_URL)[0].id).toBe('unique-text-guid-xyz')
  })

  it('无 guid 且 link 无数字 → 用 link 原文兜底', () => {
    const xml = rssItemXml({ link: 'https://h.example/t/word-only' })
    expect(parseFeed(xml, FEED_URL)[0].id).toBe('https://h.example/t/word-only')
  })
})

describe('parseFeed：命名空间与大小写兼容', () => {
  it('带 atom: 前缀的 feed 按本地名命中', () => {
    const xml = `<?xml version="1.0"?>
<atom:feed xmlns:atom="http://www.w3.org/2005/Atom">
  <atom:entry>
    <atom:title>Prefixed entry</atom:title>
    <atom:link rel="alternate" href="https://p.example/t/x/888"/>
    <atom:id>tag:p.example,2026:Topic/888</atom:id>
    <atom:author><atom:name>dave</atom:name></atom:author>
    <atom:category term="news"/>
    <atom:updated>2026-09-01T00:00:00Z</atom:updated>
  </atom:entry>
</atom:feed>`
    const topics = parseFeed(xml, 'https://p.example/feed.atom')
    expect(topics).toHaveLength(1)
    expect(topics[0]).toEqual({
      id: '888',
      sourceId: '',
      title: 'Prefixed entry',
      url: 'https://p.example/t/x/888',
      author: 'dave',
      category: 'news',
      categorySlug: 'news',
      pinned: false,
      lastActiveAt: '2026-09-01T00:00:00.000Z'
    })
  })

  it('标签大小写不敏感（Title/DC:Creator/PubDate 等大写形态）', () => {
    const xml = `<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
      <item>
        <Title>Case test</Title>
        <Link>https://c.example/t/case/66</Link>
        <Guid>tag:c.example,2005:Topic/66</Guid>
        <DC:Creator>eve</DC:Creator>
        <Category>misc</Category>
        <PubDate>Thu, 17 Sep 2026 00:00:00 GMT</PubDate>
      </item>
    </channel></rss>`
    const topics = parseFeed(xml, 'https://c.example/feed.rss')
    expect(topics).toHaveLength(1)
    expect(topics[0].title).toBe('Case test')
    expect(topics[0].author).toBe('eve')
    expect(topics[0].category).toBe('misc')
    expect(topics[0].lastActiveAt).toBe('2026-09-17T00:00:00.000Z')
  })
})

describe('parseFeed：相对链接与坏输入', () => {
  it('相对链接按 feed 地址补全为绝对', () => {
    const xml = rssItemXml({ link: '/discussion/12345/slug-title' })
    const topics = parseFeed(xml, 'https://forum.example/categories/tech/feed.rss')
    expect(topics[0].url).toBe('https://forum.example/discussion/12345/slug-title')
  })

  it('坏 XML（非 XML 文本 / 空串）→ 抛解析错误', () => {
    expect(() => parseFeed('this is not a feed', FEED_URL)).toThrow(/failed to parse rss\/atom/)
    expect(() => parseFeed('', FEED_URL)).toThrow(/failed to parse rss\/atom/)
  })

  it('合法 XML 但 0 条 → 返回空数组（0 条告警语义由 adapter 承担）', () => {
    const xml = '<?xml version="1.0"?><rss version="2.0"><channel><title>empty</title></channel></rss>'
    expect(parseFeed(xml, FEED_URL)).toEqual([])
  })
})

describe('RssSourceAdapter', () => {
  it('构造：id/url 注入，name 缺省取 host，label 覆盖；不声明 creationOrderedIds', () => {
    const fetchFn = okFetch()
    const adapter: SourceAdapter = new RssSourceAdapter({
      id: 'linuxdo',
      url: 'https://linux.do/latest.rss',
      fetchFn
    })
    expect(adapter.id).toBe('linuxdo')
    expect(adapter.name).toBe('linux.do')
    // 通用 RSS 不保证 id 数值/单调：保守不声明（否则误启 engine 阈值过滤）
    expect('creationOrderedIds' in adapter).toBe(false)
    expect(adapter.creationOrderedIds).toBeUndefined()

    const labeled = new RssSourceAdapter({
      id: 'x',
      url: 'https://linux.do/latest.rss',
      label: 'LINUX DO 论坛',
      fetchFn
    })
    expect(labeled.name).toBe('LINUX DO 论坛')
  })

  it('请求带同款 UA / 10s 超时，Accept 协商 feed 类型', async () => {
    const fetchFn = okFetch()
    const adapter = new RssSourceAdapter({ id: 'linuxdo', url: FEED_URL, fetchFn })

    const topics = await adapter.fetchLatest()
    expect(topics).toHaveLength(3)

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe(FEED_URL)
    expect(init?.method).toBe('GET')
    expect(init?.timeoutMs).toBe(10_000)
    expect(init?.headers?.['User-Agent']).toMatch(/^Mozilla\/5\.0 \(Macintosh/)
    expect(init?.headers?.Accept).toContain('application/rss+xml')
    expect(init?.headers?.['Accept-Language']).toBe('zh-CN,zh;q=0.9')
  })

  it('Atom feed 同样走通（fetchLatest 双形态）', async () => {
    const fetchFn = okFetch(ATOM_FEED)
    const adapter = new RssSourceAdapter({
      id: 'forum',
      url: 'https://forum.example/feed.atom',
      fetchFn
    })
    const topics = await adapter.fetchLatest()
    expect(topics).toHaveLength(2)
    expect(topics[0].id).toBe('555')
  })

  it('HTTP 403 → ChallengeError', async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init?: HttpRequestInit): Promise<HttpResponse> =>
        makeResponse({ status: 403, body: '' })
    )
    const adapter = new RssSourceAdapter({ id: 'x', url: FEED_URL, fetchFn })
    const error: unknown = await adapter.fetchLatest().then(
      () => undefined,
      (err: unknown) => err
    )
    expect(error).toBeInstanceOf(ChallengeError)
    expect(error instanceof Error && error.name).toBe('ChallengeError')
  })

  it('200 但响应头 cf-mitigated: challenge → ChallengeError', async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init?: HttpRequestInit): Promise<HttpResponse> =>
        makeResponse({ headers: { 'cf-mitigated': 'challenge' }, body: '' })
    )
    const adapter = new RssSourceAdapter({ id: 'x', url: FEED_URL, fetchFn })
    await expect(adapter.fetchLatest()).rejects.toThrow(ChallengeError)
  })

  it('非 2xx 且非挑战 → 普通错误（含状态码）', async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init?: HttpRequestInit): Promise<HttpResponse> =>
        makeResponse({ status: 500, body: 'oops' })
    )
    const adapter = new RssSourceAdapter({ id: 'x', url: FEED_URL, fetchFn })
    const error: unknown = await adapter.fetchLatest().then(
      () => undefined,
      (err: unknown) => err
    )
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(ChallengeError)
    expect(error instanceof Error && error.message).toContain('500')
  })

  it('坏 XML（非 XML 文本 / HTML 页面）→ 解析错误或 0 条错误，都不静默', async () => {
    // 纯文本（CF 拦截页常见形态）：连一个 XML 元素都没有 → 解析错误
    const plainFetch = okFetch('this is not a feed - Access denied')
    const plainAdapter = new RssSourceAdapter({ id: 'x', url: FEED_URL, fetchFn: plainFetch })
    await expect(plainAdapter.fetchLatest()).rejects.toThrow(/failed to parse rss\/atom/)

    // 良构 HTML：能解析出元素但 0 条 → 走 0 条告警（同为普通失败退避）
    const htmlFetch = okFetch('<html><body>not a feed</body></html>')
    const htmlAdapter = new RssSourceAdapter({ id: 'x', url: FEED_URL, fetchFn: htmlFetch })
    await expect(htmlAdapter.fetchLatest()).rejects.toThrow(/parsed 0 items/)
  })

  it('解析出 0 条 → 抛错（0 条不是无新帖）', async () => {
    const fetchFn = okFetch(
      '<?xml version="1.0"?><rss version="2.0"><channel><title>empty</title></channel></rss>'
    )
    const adapter = new RssSourceAdapter({ id: 'x', url: FEED_URL, fetchFn })
    await expect(adapter.fetchLatest()).rejects.toThrow(/parsed 0 items/)
  })

  it('fetchFn reject → 原样上抛（同一错误实例）', async () => {
    const boom = new Error('network down')
    const fetchFn = vi.fn(
      async (_url: string, _init?: HttpRequestInit): Promise<HttpResponse> => {
        throw boom
      }
    )
    const adapter = new RssSourceAdapter({ id: 'x', url: FEED_URL, fetchFn })
    await expect(adapter.fetchLatest()).rejects.toBe(boom)
  })
})

describe('RssSourceAdapter：Cloudflare B 计划（双 fetch 降级，R8-A 任务二）', () => {
  /** 主 fetch 403（无 challenge 头）——挑战形态一 */
  function challengeFetch(): ReturnType<typeof vi.fn> {
    return vi.fn(
      async (_url: string, _init?: HttpRequestInit): Promise<HttpResponse> =>
        makeResponse({ status: 403, body: '' })
    )
  }

  it('主 fetch 挑战 + fallback 成功 → 正常返回 topics；重发同一请求；记 info 日志', async () => {
    const primary = challengeFetch()
    const fallback = okFetch() // 200 + DISCOURSE_RSS
    const logs: string[] = []
    const adapter = new RssSourceAdapter({
      id: 'linuxdo',
      url: FEED_URL,
      fetchFn: primary,
      fallbackFetchFn: fallback,
      log: { info: (msg) => logs.push(msg) }
    })

    const topics = await adapter.fetchLatest()
    expect(topics).toHaveLength(3) // 与无降级的成功路径同款产出
    expect(primary).toHaveBeenCalledTimes(1)
    expect(fallback).toHaveBeenCalledTimes(1)

    // 「重发同一请求」：URL / method / headers / 超时与主请求完全一致
    const [pUrl, pInit] = primary.mock.calls[0]
    const [fUrl, fInit] = fallback.mock.calls[0]
    expect(fUrl).toBe(pUrl)
    expect(fUrl).toBe(FEED_URL)
    expect(fInit?.method).toBe(pInit?.method)
    expect(fInit?.timeoutMs).toBe(pInit?.timeoutMs)
    expect(fInit?.headers).toEqual(pInit?.headers)

    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('primary fetch challenged, retrying via browser stack')
    expect(logs[0]).toContain('linuxdo')
  })

  it('能力声明：传 fallbackFetchFn → browserStackFallback === true；不传 → undefined', () => {
    const withFallback = new RssSourceAdapter({
      id: 'x',
      url: FEED_URL,
      fetchFn: okFetch(),
      fallbackFetchFn: okFetch()
    })
    expect(withFallback.browserStackFallback).toBe(true)

    const plain = new RssSourceAdapter({ id: 'x', url: FEED_URL, fetchFn: okFetch() })
    expect(plain.browserStackFallback).toBeUndefined()
  })

  it('双挑战 → 抛 fallback 的 ChallengeError（状态照旧 challenged）', async () => {
    const primary = challengeFetch()
    // fallback 用挑战形态二（200 + cf-mitigated 头）：错误消息可区分来源
    const fallback = vi.fn(
      async (_url: string, _init?: HttpRequestInit): Promise<HttpResponse> =>
        makeResponse({ headers: { 'cf-mitigated': 'challenge' }, body: '' })
    )
    const adapter = new RssSourceAdapter({
      id: 'x',
      url: FEED_URL,
      fetchFn: primary,
      fallbackFetchFn: fallback
    })

    const error: unknown = await adapter.fetchLatest().then(
      () => undefined,
      (err: unknown) => err
    )
    expect(error).toBeInstanceOf(ChallengeError)
    // status=200（fallback 响应的形态）证明抛的是 fallback 的错误，不是主 fetch 的 403
    expect(error instanceof Error && error.message).toContain('status=200')
    expect(error instanceof Error && error.message).toContain('cf-mitigated=challenge')
  })

  it('fallback 普通错误（网络 reject）→ 抛原 ChallengeError（保守：挑战是更准确的诊断）', async () => {
    const primary = challengeFetch()
    const offline = new Error('browser stack offline')
    const fallback = vi.fn(
      async (_url: string, _init?: HttpRequestInit): Promise<HttpResponse> => {
        throw offline
      }
    )
    const adapter = new RssSourceAdapter({
      id: 'x',
      url: FEED_URL,
      fetchFn: primary,
      fallbackFetchFn: fallback
    })

    const error: unknown = await adapter.fetchLatest().then(
      () => undefined,
      (err: unknown) => err
    )
    expect(error).toBeInstanceOf(ChallengeError) // 挑战，不是 offline
    expect(error).not.toBe(offline)
    expect(error instanceof Error && error.message).toContain('status=403') // 主 fetch 的挑战
  })

  it('fallback 非 2xx（500，非挑战）→ 同样抛原 ChallengeError', async () => {
    const primary = challengeFetch()
    const fallback = vi.fn(
      async (_url: string, _init?: HttpRequestInit): Promise<HttpResponse> =>
        makeResponse({ status: 500, body: 'oops' })
    )
    const adapter = new RssSourceAdapter({
      id: 'x',
      url: FEED_URL,
      fetchFn: primary,
      fallbackFetchFn: fallback
    })
    const error: unknown = await adapter.fetchLatest().then(
      () => undefined,
      (err: unknown) => err
    )
    expect(error).toBeInstanceOf(ChallengeError)
    expect(error instanceof Error && error.message).toContain('status=403')
  })

  it('无 fallbackFetchFn → 原行为：挑战直接上抛，不降级', async () => {
    const primary = challengeFetch()
    const adapter = new RssSourceAdapter({ id: 'x', url: FEED_URL, fetchFn: primary })
    await expect(adapter.fetchLatest()).rejects.toThrow(ChallengeError)
    expect(primary).toHaveBeenCalledTimes(1)
  })

  it('主 fetch 普通错误（非挑战）→ 不走 fallback，原样上抛', async () => {
    const primary = vi.fn(
      async (_url: string, _init?: HttpRequestInit): Promise<HttpResponse> =>
        makeResponse({ status: 500, body: 'oops' })
    )
    const fallback = okFetch()
    const adapter = new RssSourceAdapter({
      id: 'x',
      url: FEED_URL,
      fetchFn: primary,
      fallbackFetchFn: fallback
    })
    const error: unknown = await adapter.fetchLatest().then(
      () => undefined,
      (err: unknown) => err
    )
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(ChallengeError)
    expect(error instanceof Error && error.message).toContain('500')
    expect(fallback).not.toHaveBeenCalled()
  })

  it('fallback 200 但解析 0 条（普通错误）→ 抛原 ChallengeError；0 条告警在 fallback 路径同样执行', async () => {
    const primary = challengeFetch()
    const fallback = okFetch(
      '<?xml version="1.0"?><rss version="2.0"><channel><title>empty</title></channel></rss>'
    )
    const adapter = new RssSourceAdapter({
      id: 'x',
      url: FEED_URL,
      fetchFn: primary,
      fallbackFetchFn: fallback
    })
    // fallback 响应走完整防护管线（0 条 → 抛错），但它是普通错误：保守语义下
    // 抛**原** ChallengeError（挑战是更准确的诊断——换栈拿到 200 却解析不出
    // 条目，常见形态恰是 CF 的 JS/interstitial 挑战页）
    const error: unknown = await adapter.fetchLatest().then(
      () => undefined,
      (err: unknown) => err
    )
    expect(error).toBeInstanceOf(ChallengeError)
    expect(error instanceof Error && error.message).toContain('status=403')
  })
})
