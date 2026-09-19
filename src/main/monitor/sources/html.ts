/**
 * NodeSeek 首页 SSR HTML 适配器（ADR 5 主路径）。
 * 零 electron 依赖；HTTP 通过注入的 FetchLike 完成，便于单测。
 *
 * 防护条款（ADR 5）：
 * - 挑战检测双信号：HTTP 403 或 `cf-mitigated` 响应头含 `challenge` → ChallengeError。
 * - 0 条 ≠ 无新帖：解析出 0 个 item 视为页面改版或被拦，抛错告警。
 */

import * as cheerio from 'cheerio'
import { ChallengeError, type SourceAdapter } from '../types'
import type { FetchLike } from '../../net/http-types'
import type { Topic } from '../../../shared/types'

export const DEFAULT_BASE_URL = 'https://www.nodeseek.com'

const REQUEST_TIMEOUT_MS = 10_000

/** 真实浏览器头（裸 HTTP 客户端 + Mozilla UA 实测可拿到 SSR 首页） */
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'zh-CN,zh;q=0.9'
}

/** DOM 选择器集中一处：页面改版只改这里 */
const SELECTORS = {
  postItem: 'ul.post-list > li.post-list-item',
  titleLink: '.post-title a[href^="/post-"]',
  /** 置顶标记两口径：title 属性或 svg use #pin */
  pinnedSpan: '.post-title span[title="置顶"]',
  pinnedIcon: '.post-title use[href="#pin"]',
  author: '.post-info .info-author a',
  lastActiveTime: '.post-info .info-last-comment-time time[datetime]',
  category: '.post-info a.post-category'
} as const

/** `/post-{id}-{seq}` 链接（seq 为分页楼层号，url 统一回退到第 1 页） */
const POST_LINK_RE = /^\/post-(\d+)-\d+/
/** `/categories/{slug}`，如 photo-share 含连字符 */
const CATEGORY_LINK_RE = /^\/categories\/([A-Za-z0-9_-]+)/

/**
 * 解析 NodeSeek 首页（?sort=createTime）HTML 为 Topic 列表。
 * 纯函数：不抛错、不网络。0 条不在此处报错（由调用方决定语义），
 * 拿不到帖子 id 的行直接跳过。
 */
export function parseHomepage(html: string, baseUrl: string = DEFAULT_BASE_URL): Topic[] {
  const $ = cheerio.load(html)
  const topics: Topic[] = []

  $(SELECTORS.postItem).each((_, element) => {
    const item = $(element)
    const titleLink = item.find(SELECTORS.titleLink).first()
    const postMatch = POST_LINK_RE.exec(titleLink.attr('href') ?? '')
    if (!postMatch) return

    const categoryLink = item.find(SELECTORS.category).first()
    const categoryMatch = CATEGORY_LINK_RE.exec(categoryLink.attr('href') ?? '')
    const id = postMatch[1]

    topics.push({
      id,
      title: titleLink.text().trim(),
      url: `${baseUrl}/post-${id}-1`,
      author: item.find(SELECTORS.author).first().text().trim(),
      category: categoryLink.text().trim(),
      categorySlug: categoryMatch ? categoryMatch[1] : '',
      pinned:
        item.find(SELECTORS.pinnedSpan).length > 0 || item.find(SELECTORS.pinnedIcon).length > 0,
      lastActiveAt: item.find(SELECTORS.lastActiveTime).first().attr('datetime') ?? null
    })
  })

  return topics
}

export interface HtmlSourceOptions {
  fetchHtml: FetchLike
  /** 默认 https://www.nodeseek.com；单测/自托管镜像可覆盖 */
  baseUrl?: string
}

export class HtmlSourceAdapter implements SourceAdapter {
  readonly name = 'nodeseek-homepage-html'

  private readonly fetchHtml: FetchLike
  private readonly baseUrl: string

  constructor(options: HtmlSourceOptions) {
    this.fetchHtml = options.fetchHtml
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
  }

  async fetchLatest(): Promise<Topic[]> {
    const url = `${this.baseUrl}/?sort=createTime`
    // fetchHtml reject（网络错误 / 超时 abort）原样上抛，不吞不改
    const res = await this.fetchHtml(url, {
      method: 'GET',
      headers: { ...BROWSER_HEADERS },
      timeoutMs: REQUEST_TIMEOUT_MS
    })

    // 挑战双信号，任一命中即 ChallengeError（ADR 5）
    const mitigated = res.headers['cf-mitigated'] ?? ''
    if (res.status === 403 || mitigated.toLowerCase().includes('challenge')) {
      throw new ChallengeError(
        `nodeseek challenge: status=${res.status} cf-mitigated=${mitigated || '(none)'}`
      )
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`nodeseek homepage request failed: HTTP ${res.status}`)
    }

    const topics = parseHomepage(res.body, this.baseUrl)
    if (topics.length === 0) {
      // 0 条 ≠ 无新帖：NodeSeek 是 Nuxt SSR，改版或被 CF 拦的首表现象就是 0 条
      throw new Error(`parsed 0 topics from ${url} (layout change or challenge page)`)
    }
    return topics
  }
}
