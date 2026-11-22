/**
 * 候选活动帖 1 楼详情按需抓取与解析器（零 Electron，HTTP 经注入 FetchLike 完成）。
 *
 * 设计要点：
 * 1. **双通道精准解析 NodeSeek 帖子详情（对齐客户端 Anode `TempScriptParser` + `NodeSeekHtmlParser`）**：
 *    - 主路径：提取 `<script id="temp-script" type="application/json">` 的 Base64 UTF-8 JSON，
 *      直接拿到楼主 1 楼（`floorIndex === 0`）原始 `markdown`、精确发帖时间 `time.createdDate`、
 *      楼主 uid/name、帖子标题与分类及 `locked` 状态。
 *    - 兜底路径：识别私有帖 / 等级受限帖 / 需登录帖（返回 `accessRestriction` 提示而不报错），
 *      或从 `.nsk-post .post-content, article.post-content` DOM 提取正文与超链接（含 `/lucky?...`）。
 * 2. **温和限速 + Cloudflare 熔断保护**：
 *    - 串行队列单并发，两次详情请求间隔 ≥ `minIntervalMs`（默认 2500ms + 随机抖动），绝不并发扫站；
 *    - 一旦遭遇 `ChallengeError`（403 / `cf-mitigated: challenge`），立即触发 5 分钟熔断冷却，
 *      冷却期内零网络请求、直接返回降级结果，由上层退回纯标题入库，绝不顶风硬撞反爬。
 */
import * as cheerio from 'cheerio'
import { assertNotChallenged } from '../monitor/sources/challenge'
import { ChallengeError } from '../monitor/types'
import type { FetchLike } from '../net/http-types'

const REQUEST_TIMEOUT_MS = 10_000
const MAX_MARKDOWN_CHARS = 8_000
const DEFAULT_MIN_INTERVAL_MS = 2_500
const DEFAULT_JITTER_MS = 800
const DEFAULT_CHALLENGE_COOLDOWN_MS = 5 * 60_000

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'zh-CN,zh;q=0.9'
}

export interface ParsedTopicDetail {
  title?: string
  author?: string
  authorUrl?: string
  category?: string
  categorySlug?: string
  createdAtEpochMillis: number | null
  markdown: string
  locked: boolean
  /** 私有帖 / 等级限制 / 需登录提示（非空表示无公开正文可读） */
  accessRestriction: string | null
}

export type DetailFetchResult =
  | { ok: true; detail: ParsedTopicDetail }
  | { ok: false; reason: string; challenged?: boolean }

export interface DetailFetcherOptions {
  fetchHtml: FetchLike
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  minIntervalMs?: number
  jitterMs?: number
  challengeCooldownMs?: number
}

interface TempScriptComment {
  floorIndex?: unknown
  markdown?: unknown
  time?: { createdDate?: unknown } | null
  poster?: { uid?: unknown; member_id?: unknown; name?: unknown; member_name?: unknown } | null
}

interface TempScriptPostData {
  postId?: unknown
  title?: unknown
  category?: unknown
  categoryWord?: unknown
  locked?: unknown
  op?: { uid?: unknown; member_id?: unknown; name?: unknown; member_name?: unknown } | null
  comments?: unknown
}

/**
 * 纯函数：解析 NodeSeek（或通用论坛）帖子详情页 HTML，提取 1 楼 Markdown 与发布时间。
 */
export function parseTopicDetailHtml(
  html: string,
  pageUrl: string = 'https://www.nodeseek.com'
): ParsedTopicDetail {
  const origin = safeOrigin(pageUrl)
  const $ = cheerio.load(html)

  // 1. NodeSeek <script id="temp-script"> Base64 JSON 优先路径
  const tempScriptRaw =
    $('script#temp-script[type="application/json"]').first().html() ??
    $('script#temp-script').first().html()

  if (tempScriptRaw !== null && tempScriptRaw.trim() !== '') {
    const decoded = decodeTempScriptPostData(tempScriptRaw.trim())
    if (decoded !== null) {
      const comments = Array.isArray(decoded.comments)
        ? (decoded.comments as TempScriptComment[])
        : []
      const opening =
        comments.find((c) => Number(c?.floorIndex) === 0) ?? comments[0] ?? null
      let markdown = typeof opening?.markdown === 'string' ? opening.markdown.trim() : ''
      if (markdown === '') {
        markdown = extractDomContentMarkdown($, origin)
      }
      const createdRaw =
        typeof opening?.time?.createdDate === 'string' ? opening.time.createdDate.trim() : ''
      const createdMs = createdRaw !== '' ? parseTimestampMs(createdRaw) : null
      const opUid = toPositiveInt(
        decoded.op?.uid ?? decoded.op?.member_id ?? opening?.poster?.uid ?? opening?.poster?.member_id
      )
      const opName = firstNonEmpty(
        decoded.op?.name,
        decoded.op?.member_name,
        opening?.poster?.name,
        opening?.poster?.member_name
      )
      const locked = isTruthyWebsiteFlag(decoded.locked)
      return {
        ...(typeof decoded.title === 'string' && decoded.title.trim() !== ''
          ? { title: decoded.title.trim() }
          : {}),
        ...(opName !== null ? { author: opName } : {}),
        ...(opUid !== null ? { authorUrl: `${origin}/space/${opUid}` } : {}),
        ...(typeof decoded.categoryWord === 'string' && decoded.categoryWord.trim() !== ''
          ? { category: decoded.categoryWord.trim() }
          : {}),
        ...(typeof decoded.category === 'string' && decoded.category.trim() !== ''
          ? { categorySlug: decoded.category.trim() }
          : {}),
        createdAtEpochMillis: createdMs,
        markdown: markdown.slice(0, MAX_MARKDOWN_CHARS),
        locked,
        accessRestriction: null
      }
    }
  }

  // 2. 访问受限检测（私有帖 / 等级不足 / 未登录）
  const restriction = detectNodeSeekAccessRestriction($)
  if (restriction !== null) {
    return {
      createdAtEpochMillis: null,
      markdown: '',
      locked: false,
      accessRestriction: restriction
    }
  }

  // 3. DOM 兜底路径（NodeSeek .post-content / V2EX .topic_content / 通用 article）
  const markdown = extractDomContentMarkdown($, origin)
  const timeAttr =
    $('.nsk-post time[datetime]').first().attr('datetime') ??
    $('time[datetime]').first().attr('datetime') ??
    ''
  const createdMs = timeAttr.trim() !== '' ? parseTimestampMs(timeAttr.trim()) : null
  const pageTitle = $('h1').first().text().trim()

  return {
    ...(pageTitle !== '' ? { title: pageTitle } : {}),
    createdAtEpochMillis: createdMs,
    markdown: markdown.slice(0, MAX_MARKDOWN_CHARS),
    locked: false,
    accessRestriction: null
  }
}

function decodeTempScriptPostData(encodedBase64: string): TempScriptPostData | null {
  try {
    const cleaned = encodedBase64.replace(/\s+/g, '')
    const utf8 = Buffer.from(cleaned, 'base64').toString('utf-8')
    const parsed = JSON.parse(utf8) as { postData?: unknown }
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.postData === 'object' && parsed.postData !== null) {
      return parsed.postData as TempScriptPostData
    }
    return null
  } catch {
    return null
  }
}

function detectNodeSeekAccessRestriction($: cheerio.CheerioAPI): string | null {
  const forumBody = $('#nsk-body-left').first().length > 0 ? $('#nsk-body-left').first() : $('#nsk-body').first()
  if (forumBody.length === 0) return null
  if (forumBody.find('.nsk-post, .post-content').length > 0) return null

  const text = forumBody.text().replace(/\s+/g, ' ').trim()
  const lvMatch = /查看本帖需要\s*Lv\s*(\d+)/i.exec(text)
  if (lvMatch?.[1] === '255' || text.includes('本帖已经被用户设为私有')) {
    return '本帖已被设为私有，需对应权限查看详情'
  }
  if (lvMatch !== null || (text.includes('权限不足') && text.includes('升级您的用户等级'))) {
    return lvMatch?.[1] ? `需 NodeSeek Lv${lvMatch[1]} 及以上权限查看详情` : '需更高用户等级查看详情'
  }
  if (text.includes('需要注册用户才能查看')) {
    return '需登录论坛账号后查看详情'
  }
  return null
}

function extractDomContentMarkdown($: cheerio.CheerioAPI, origin: string): string {
  const container =
    $('.nsk-post .post-content').first().length > 0
      ? $('.nsk-post .post-content').first()
      : $('article.post-content, .post-content, .topic_content, article, main').first()

  if (container.length === 0) return ''

  const clone = container.clone()
  clone.find('script, style, noscript').remove()

  // 保留超链接为 Markdown `[text](url)`，确保 `/lucky?...` 和活动链接不丢失
  clone.find('a[href]').each((_, el) => {
    const a = $(el)
    const rawHref = (a.attr('href') ?? '').trim()
    if (rawHref === '' || rawHref.startsWith('javascript:')) return
    const absUrl = toAbsoluteUrl(rawHref, origin)
    const label = a.text().replace(/\s+/g, ' ').trim() || absUrl
    a.replaceWith(`[${label}](${absUrl})`)
  })

  clone.find('br').replaceWith('\n')
  clone.find('p, div, li, h1, h2, h3, h4, blockquote, tr').each((_, el) => {
    $(el).append('\n')
  })

  return clone
    .text()
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function toAbsoluteUrl(href: string, origin: string): string {
  if (/^https?:\/\//i.test(href)) return href
  if (href.startsWith('//')) return `https:${href}`
  if (href.startsWith('/')) return `${origin}${href}`
  return `${origin}/${href}`
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return 'https://www.nodeseek.com'
  }
}

function parseTimestampMs(raw: string): number | null {
  const ms = Date.parse(raw)
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

function toPositiveInt(val: unknown): number | null {
  const n = typeof val === 'number' ? val : typeof val === 'string' ? Number(val.trim()) : NaN
  return Number.isInteger(n) && n > 0 ? n : null
}

function firstNonEmpty(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return null
}

function isTruthyWebsiteFlag(val: unknown): boolean {
  return val === true || val === 1 || val === '1' || val === 'true'
}

/**
 * 带串行限速与 Cloudflare 熔断冷却的 1 楼详情抓取器。
 */
export class TopicDetailFetcher {
  private readonly fetchHtml: FetchLike
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number
  private readonly minIntervalMs: number
  private readonly jitterMs: number
  private readonly challengeCooldownMs: number

  private tail: Promise<void> = Promise.resolve()
  private lastFetchAtMs = Number.NEGATIVE_INFINITY
  private challengedUntilMs = 0

  constructor(opts: DetailFetcherOptions) {
    this.fetchHtml = opts.fetchHtml
    this.now = opts.now ?? (() => Date.now())
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.random = opts.random ?? (() => Math.random())
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
    this.jitterMs = opts.jitterMs ?? DEFAULT_JITTER_MS
    this.challengeCooldownMs = opts.challengeCooldownMs ?? DEFAULT_CHALLENGE_COOLDOWN_MS
  }

  isChallengedCooldown(): boolean {
    return this.now() < this.challengedUntilMs
  }

  fetchDetail(url: string): Promise<DetailFetchResult> {
    if (!/^https?:\/\//i.test(url.trim())) {
      return Promise.resolve({ ok: false, reason: 'invalid url' })
    }
    if (this.isChallengedCooldown()) {
      return Promise.resolve({
        ok: false,
        reason: 'detail fetcher in Cloudflare challenge cooldown',
        challenged: true
      })
    }
    const task = this.tail.then(() => this.runSingleFetch(url.trim()))
    this.tail = task.then(
      () => undefined,
      () => undefined
    )
    return task
  }

  private async runSingleFetch(url: string): Promise<DetailFetchResult> {
    if (this.isChallengedCooldown()) {
      return {
        ok: false,
        reason: 'detail fetcher in Cloudflare challenge cooldown',
        challenged: true
      }
    }

    const elapsed = this.now() - this.lastFetchAtMs
    const targetGap =
      this.minIntervalMs +
      (this.jitterMs > 0 ? Math.floor(this.random() * this.jitterMs) : 0)
    if (elapsed < targetGap) {
      await this.sleep(targetGap - elapsed)
    }
    this.lastFetchAtMs = this.now()

    try {
      const res = await this.fetchHtml(url, {
        method: 'GET',
        headers: { ...BROWSER_HEADERS },
        timeoutMs: REQUEST_TIMEOUT_MS
      })
      assertNotChallenged(res.status, res.headers)
      if (res.status < 200 || res.status >= 300) {
        return { ok: false, reason: `HTTP ${res.status}` }
      }
      const detail = parseTopicDetailHtml(res.body, url)
      return { ok: true, detail }
    } catch (err) {
      if (err instanceof ChallengeError) {
        this.challengedUntilMs = this.now() + this.challengeCooldownMs
        return { ok: false, reason: err.message, challenged: true }
      }
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  }
}
