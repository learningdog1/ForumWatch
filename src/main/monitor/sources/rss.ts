/**
 * 通用 RSS 2.0 / Atom 适配器（R4-W2，ADR 5 的 RSS 备选路径）。
 * 零 electron 依赖；HTTP 通过注入的 FetchLike 完成（与 html adapter 同款注入风格）。
 *
 * 支持范围：
 * - RSS 2.0：item 的 title/link/guid/dc:creator/category/pubDate。
 * - Atom：entry 的 title/link[@rel=alternate 或无 rel]/id/author/name/category/@term/updated。
 * - 命名空间标签（dc:creator、atom:entry…）按**本地名**匹配——XML 前缀不保证固定。
 *
 * 防护条款（对齐 ADR 5 / html adapter）：
 * - 挑战检测双信号走共享 challenge.ts（403 或 cf-mitigated: challenge → ChallengeError）。
 * - **0 条 ≠ 无新帖**：解析出 0 条视为 feed 改版或被拦的首表现象，抛错走普通失败退避。
 * - 非 2xx（非 403）抛带状态码的 Error；网络异常/超时原样上抛；坏 XML 抛解析错误。
 */

import * as cheerio from 'cheerio'
import type { Cheerio } from 'cheerio'
import type { Element } from 'domhandler'
import type { SourceAdapter } from '../types'
import { assertNotChallenged } from './challenge'
import type { FetchLike } from '../../net/http-types'
import type { Topic } from '../../../shared/types'

const REQUEST_TIMEOUT_MS = 10_000

/** 与 html adapter 同款真实浏览器 UA；Accept 按 feed 语义协商 */
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept:
    'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9'
}

/** 元素本地名：去掉命名空间前缀（dc:creator → creator）、统一小写（按本地名兼容匹配任意前缀） */
function localNameOf(el: { tagName: string }): string {
  const name = el.tagName.toLowerCase()
  return name.slice(name.lastIndexOf(':') + 1)
}

/** guid 尾部 `/12345`：Discourse guid（tag:linux.do,2005:Topic/12345）与 URL 型 guid 同样命中 */
const GUID_TRAILING_ID_RE = /\/(\d+)\/?$/
/** Discourse 主题链接 `/t/{slug}/{id}`（可带 `/{楼层}` 尾段，id 恒取主题段） */
const DISCOURSE_TOPIC_LINK_RE = /\/t\/[^/?#]*\/(\d+)/
/** Vanilla 链接 `/discussion/{id}/{slug}` */
const VANILLA_DISCUSSION_LINK_RE = /\/discussion\/(\d+)/
/** 兜底：路径中首个纯数字段（`/foo/1234/bar`、`/1234`） */
const NUMERIC_PATH_SEGMENT_RE = /(?:^|\/)(\d+)(?=\/|[?#]|$)/

/**
 * 从 guid/link 提取数值 topic id；取不到返回 null。
 * **guid 优先**：Discourse 的 guid（tag:…:Topic/12345）是论坛侧规范 id——guid 与
 * link 都解析出数字且不一致时以 guid 为准（link 可能被 feed 生成器重写或截短）。
 */
function extractNumericTopicId(guid: string, link: string): string | null {
  const guidMatch = GUID_TRAILING_ID_RE.exec(guid)
  if (guidMatch) return guidMatch[1]
  for (const re of [DISCOURSE_TOPIC_LINK_RE, VANILLA_DISCUSSION_LINK_RE, NUMERIC_PATH_SEGMENT_RE]) {
    const linkMatch = re.exec(link)
    if (linkMatch) return linkMatch[1]
  }
  return null
}

/** 相对链接按 feed 地址补全为绝对；补全失败（非法 URL）原样返回 */
function absolutizeUrl(link: string, feedUrl: string): string {
  try {
    return new URL(link, feedUrl).toString()
  } catch {
    return link
  }
}

/** 日期文本 → ISO 字符串；空/解析不了 → null */
function toIsoOrNull(raw: string): string | null {
  if (!raw) return null
  const ts = Date.parse(raw)
  return Number.isNaN(ts) ? null : new Date(ts).toISOString()
}

/** 从一条 item/entry 抽出的原始字段（映射为 Topic 前的中间形态） */
interface FeedItemFields {
  title: string
  link: string
  /** RSS guid / Atom id 的原文 */
  guid: string
  author: string
  category: string
  categorySlug: string
  dateRaw: string
}

/**
 * 解析 RSS 2.0 / Atom feed 为 Topic 列表。纯函数：不网络、不感知挑战。
 * 坏 XML（解析后文档里连一个元素都没有）抛 Error；条数不在此处判错——
 * 0 条的告警语义由 adapter 承担（见 fetchLatest）。
 * guid 与 link 全缺的条目没有稳定身份，直接跳过。
 */
export function parseFeed(xml: string, feedUrl: string): Topic[] {
  const $ = cheerio.load(xml, { xmlMode: true })
  const all = $('*')
  if (all.length === 0) {
    // 空响应 / 纯文本 / 乱码：不是 XML（htmlparser2 宽松解析不抛错，以“零元素”判定）
    throw new Error('failed to parse rss/atom: no xml elements found')
  }

  const topics: Topic[] = []
  all.each((_, node) => {
    // '*' 会命中非元素节点（文本/CDATA/注释），只有元素节点有 tagName
    if (!('tagName' in node)) return
    const entry = $(node)
    const local = localNameOf(node)
    if (local === 'item') {
      const topic = mapToTopic(collectRssItemFields($, entry), feedUrl)
      if (topic) topics.push(topic)
    } else if (local === 'entry') {
      const topic = mapToTopic(collectAtomEntryFields($, entry), feedUrl)
      if (topic) topics.push(topic)
    }
  })
  return topics
}

/**
 * 在 item/entry 的**直接子元素**里按本地名取首个命中者的文本（names 按优先级排序，
 * 取文档中该名的第一个，trim 后返回）。
 */
function fieldText(kids: Cheerio<Element>, ...names: string[]): string {
  for (const name of names) {
    const match = kids.filter((_, child) => localNameOf(child) === name).first()
    if (match.length > 0) return match.text().trim()
  }
  return ''
}

function collectRssItemFields($: cheerio.CheerioAPI, entry: Cheerio<Element>): FeedItemFields {
  const kids = entry.children()
  // RSS <link> 是文本元素；跳过混入的 atom:link 等空文本前缀元素，取首个有文本的
  let link = ''
  kids.filter((_, child) => localNameOf(child) === 'link').each((_, child) => {
    const text = $(child).text().trim()
    if (text && !link) link = text
  })
  const category = fieldText(kids, 'category')
  return {
    title: fieldText(kids, 'title'),
    link,
    guid: fieldText(kids, 'guid'),
    // dc:creator（按本地名 creator 兼容任意前缀与大小写）
    author: fieldText(kids, 'creator'),
    category,
    // RSS 无 slug 概念：categorySlug 同 category
    categorySlug: category,
    dateRaw: fieldText(kids, 'pubdate', 'updated', 'published')
  }
}

function collectAtomEntryFields($: cheerio.CheerioAPI, entry: Cheerio<Element>): FeedItemFields {
  const kids = entry.children()
  // Atom <link> 是带 href 的空元素：取 @rel=alternate 或无 rel 的首个 href
  let link = ''
  kids.filter((_, child) => localNameOf(child) === 'link').each((_, child) => {
    const href = ($(child).attr('href') ?? '').trim()
    if (!href || link) return
    const rel = ($(child).attr('rel') ?? '').trim()
    if (rel === '' || rel === 'alternate') link = href
  })
  const categoryEl = kids.filter((_, child) => localNameOf(child) === 'category').first()
  const term = categoryEl.length > 0 ? (categoryEl.attr('term') ?? '').trim() : ''
  const categoryText = categoryEl.length > 0 ? categoryEl.text().trim() : ''
  return {
    title: fieldText(kids, 'title'),
    link,
    guid: fieldText(kids, 'id'),
    // <author><name>…（按本地名嵌套匹配）
    author: kids
      .filter((_, child) => localNameOf(child) === 'author')
      .children()
      .filter((_, child) => localNameOf(child) === 'name')
      .first()
      .text()
      .trim(),
    // 有文本用文本，缺文本用 @term
    category: categoryText || term,
    // Atom 有 @term 用 term
    categorySlug: term || categoryText,
    dateRaw: fieldText(kids, 'updated', 'published', 'pubdate')
  }
}

function mapToTopic(fields: FeedItemFields, feedUrl: string): Topic | null {
  const numericId = extractNumericTopicId(fields.guid, fields.link)
  // 数值 id > guid 原文 > link 原文：guid 是 feed 的身份元素，文本兜底优先于 link
  const identity = numericId ?? (fields.guid || fields.link || '')
  if (!identity) return null

  return {
    id: identity,
    // adapter 不感知来源归属：engine 处理时按来源盖章（D2/D3，与 html adapter 同款）
    sourceId: '',
    title: fields.title,
    url: fields.link ? absolutizeUrl(fields.link, feedUrl) : '',
    author: fields.author,
    category: fields.category,
    categorySlug: fields.categorySlug,
    // RSS/Atom 无置顶语义，恒 false（html adapter 才有置顶标记）
    pinned: false,
    lastActiveAt: toIsoOrNull(fields.dateRaw)
  }
}

export interface RssSourceOptions {
  /**
   * 稳定 slug：seen 去重键前缀 `${id}:`、state 键、EngineStatus.sources 的
   * sourceId 都以它为准（D3）。必须与 config.sources[].id 对上。
   */
  id: string
  /** feed 地址（RSS 2.0 或 Atom）；条目相对链接以此为基准补全为绝对 */
  url: string
  /** 展示名（日志与 UI）；缺省取 url 的 host */
  label?: string
  /** HTTP 注入（与 html adapter 的 fetchHtml 同款 FetchLike，装配层统一传 undici 封装） */
  fetchFn: FetchLike
}

export class RssSourceAdapter implements SourceAdapter {
  readonly id: string
  readonly name: string
  // 不声明 creationOrderedIds：通用 RSS 的 topic id（guid/link 提取）既不保证是
  // 数值，更不保证随创建单调递增（feed 常按“最近活跃”排序、guid 形态千差万别）。
  // 声明 true 会误启 engine 的 maxSeenTopicId 阈值过滤（W3）——保守走“不过滤”路径
  // （types.ts 契约：未声明的来源完全不走该过滤）。

  private readonly url: string
  private readonly fetchFn: FetchLike

  constructor(options: RssSourceOptions) {
    this.id = options.id
    this.url = options.url
    this.name = options.label ?? hostOf(options.url)
    this.fetchFn = options.fetchFn
  }

  async fetchLatest(): Promise<Topic[]> {
    // fetchFn reject（网络错误 / 超时 abort）原样上抛，不吞不改
    const res = await this.fetchFn(this.url, {
      method: 'GET',
      headers: { ...BROWSER_HEADERS },
      timeoutMs: REQUEST_TIMEOUT_MS
    })

    // 挑战双信号先于一切（ADR 5，共享检测见 challenge.ts）
    assertNotChallenged(res.status, res.headers)
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`rss feed request failed: HTTP ${res.status} (${this.url})`)
    }

    const topics = parseFeed(res.body, this.url)
    if (topics.length === 0) {
      // 0 条 ≠ 无新帖（ADR 5 防护条款）：feed 改版或被拦的首表现象就是 0 条，
      // 宁严勿松，走普通失败退避
      throw new Error(`rss feed parsed 0 items from ${this.url} (layout change or challenge page)`)
    }
    return topics
  }
}

/** url → host；非法 url 原样返回（展示名兜底） */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
