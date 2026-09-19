/**
 * NodeSeek 首页 SSR HTML 适配器（ADR 5 主路径）。
 * 零 electron 依赖；HTTP 通过注入的 FetchLike 完成，便于单测。
 *
 * 防护条款（ADR 5）：
 * - 挑战检测双信号：HTTP 403 或 `cf-mitigated` 响应头含 `challenge` → ChallengeError。
 * - 0 条 ≠ 无新帖：解析出 0 个 item 视为页面改版或被拦，抛错告警。
 */

import * as cheerio from 'cheerio'
import type { SourceAdapter } from '../types'
import { assertNotChallenged } from './challenge'
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
      // adapter 不感知来源归属：engine 处理时按来源盖章（D2/D3）
      sourceId: '',
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
  /** 稳定 slug：seen 前缀 `nodeseek:{id}`（与 v1 seen 迁移共用）、state 键、状态键 */
  readonly id = 'nodeseek'
  readonly name = 'NodeSeek'
  /**
   * W3 能力声明：NodeSeek topic id 随创建单调递增（/post-{id} 递增分配），
   * engine 据此做 "新帖 vs 回复顶起旧帖" 的 id 阈值过滤。
   */
  readonly creationOrderedIds = true

  private readonly fetchHtml: FetchLike
  private readonly baseUrl: string

  constructor(options: HtmlSourceOptions) {
    this.fetchHtml = options.fetchHtml
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
  }

  /**
   * 抓取最新帖子列表（R5-P2a / DEC-8：可选 `opts.pages` 第 2 页补抓）。
   * - opts 缺省 / pages < 2：仅第 1 页（既有行为不变）。
   * - pages >= 2：额外抓第 2 页，两页合并按 topic id 去重保序（第 1 页原序在前，
   *   第 2 页中与第 1 页重复的条目丢弃——覆盖"服务端忽略页参数返回同页内容"的
   *   形态，天然无害）。
   * - **第 2 页抓取失败（含 ChallengeError）不判失败**：整轮按第 1 页成功处理
   *   （log warn）——第 1 页失败才是失败（现状语义）。
   */
  async fetchLatest(opts?: { pages?: number }): Promise<Topic[]> {
    const topics = await this.fetchPage(1)
    if ((opts?.pages ?? 1) < 2) return topics
    let page2: Topic[]
    try {
      page2 = await this.fetchPage(2)
    } catch (err) {
      // 第 2 页是补抓：失败只降级回单页，不污染整轮健康判定（console 先例见
      // hits-store.readDay——本模块零注入 logger）
      const detail = err instanceof Error ? err.message : String(err)
      console.warn(`[nodeseek] page 2 fetch failed, continuing with page 1 only: ${detail}`)
      return topics
    }
    return mergePagesDedupById(topics, page2)
  }

  /** 单页抓取：请求 → 挑战检测 → 解析 → 0 条护栏（抛错语义全部在此） */
  private async fetchPage(page: number): Promise<Topic[]> {
    // 勘误（2026-09-19 实测）：?sort=createTime 参数被服务端忽略——首页真实排序
    // 是「最后回复时间」，旧帖被回复顶回首页属于正常行为。URL 参数保留无害；
    // 「新帖 vs 回复顶起旧帖」的区分由 engine 侧 maxSeenTopicId 阈值过滤承担
    // （W3，见 types.ts 的 creationOrderedIds 能力声明与 engine.ts）。
    // 第 2 页页参数形态沿用 docs/decisions.md 实测记录（`&page-2`），基于现有
    // URL 构造追加。
    const url = this.pageUrl(page)
    // fetchHtml reject（网络错误 / 超时 abort）原样上抛，不吞不改
    const res = await this.fetchHtml(url, {
      method: 'GET',
      headers: { ...BROWSER_HEADERS },
      timeoutMs: REQUEST_TIMEOUT_MS
    })

    // 挑战双信号，任一命中即 ChallengeError（ADR 5；检测逻辑抽至 challenge.ts 共享）
    assertNotChallenged(res.status, res.headers)
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

  /** 页 URL：第 1 页现状不变；第 2 页追加页参数（decisions.md 实测记录形态） */
  private pageUrl(page: number): string {
    return page <= 1
      ? `${this.baseUrl}/?sort=createTime`
      : `${this.baseUrl}/?sort=createTime&page-${page}`
  }
}

/**
 * 两页合并：按 topic id 去重保序——第 1 页原序在前，第 2 页中 id 未出现过的
 * 条目按原序追加（id 与 engine 的全局去重键同口径，是页面内条目的唯一身份）。
 */
function mergePagesDedupById(page1: Topic[], page2: Topic[]): Topic[] {
  const seenIds = new Set(page1.map((t) => t.id))
  const merged = [...page1]
  for (const t of page2) {
    if (seenIds.has(t.id)) continue
    seenIds.add(t.id)
    merged.push(t)
  }
  return merged
}
