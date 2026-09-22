/**
 * V2EX 官方 API 适配器（R4-W3）。
 * 零 electron 依赖；HTTP 通过注入的 FetchLike 完成，便于单测（对齐 html.ts 风格）。
 *
 * 数据源实测（2026-09-19，curl）：
 * - GET https://www.v2ex.com/api/topics/latest.json → 200，JSON 数组恒 40 帖。
 * - topic id 随创建单调递增（当页 newest 1243180 > oldest 1243131）。
 * - 公共 API 未认证限速约 120 次/小时；默认 60s 轮询 = 60/h 在限内。
 *
 * 防护条款（对齐 ADR 5）：
 * - 挑战检测双信号走共享 sources/challenge.ts（403 或 cf-mitigated: challenge
 *   → ChallengeError；R4-W4 从本地副本切换为共享实现，语义不变）。
 * - 0 条视为异常：latest 恒 40 帖，0 条 = 端点改版或被拦的异常形态。
 * - 429 走普通失败退避（不进 challenged 态），错误消息提示调大轮询间隔。
 */

import type { SourceAdapter } from '../types'
import { assertNotChallenged } from './challenge'
import { toExcerpt } from './rss'
import type { FetchLike } from '../../net/http-types'
import type { Topic } from '../../../shared/types'

export const DEFAULT_BASE_URL = 'https://www.v2ex.com'

/** latest 端点路径（挂在 baseUrl 下，单测/镜像可覆盖） */
const LATEST_PATH = '/api/topics/latest.json'

const REQUEST_TIMEOUT_MS = 10_000

/** 真实浏览器 UA（实测可用）；API 端点要 JSON 而非 HTML */
const REQUEST_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json'
}

/** API 单帖原始形态（仅声明消费的字段） */
interface V2exTopicItem {
  id?: number
  title?: string
  url?: string
  /** 帖子正文（Markdown 纯文本；Topic.excerpt 的数据源，截断见 toExcerpt） */
  content?: string
  /** unix 秒 */
  created?: number
  /** unix 秒（最后回复时间，优先作 lastActiveAt） */
  last_touched?: number
  member?: { username?: string } | null
  node?: { name?: string; title?: string } | null
}

/** unix 秒 → ISO 字符串；非有限正数（含缺失）返回 null */
function unixSecondsToIso(sec: unknown): string | null {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return null
  const date = new Date(sec * 1000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** 单帖映射；非对象条目或缺有效数值 id 的条目返回 null（上游恒有，防御性兜底） */
function mapTopic(item: unknown, baseUrl: string): Topic | null {
  if (typeof item !== 'object' || item === null) return null
  const raw = item as V2exTopicItem
  if (typeof raw.id !== 'number' || !Number.isFinite(raw.id)) return null
  // 摘要按空省略键（Topic.excerpt 可选；toExcerpt 共享 rss adapter 的清洗口径）
  const excerpt = toExcerpt(raw.content ?? '')
  const username = raw.member?.username ?? ''
  return {
    id: String(raw.id),
    // adapter 不感知来源归属：engine 处理时按来源盖章（D2/D3）
    sourceId: '',
    title: raw.title ?? '',
    url: raw.url ?? '',
    author: username,
    category: raw.node?.title ?? '',
    categorySlug: raw.node?.name ?? '',
    pinned: false, // latest 端点无置顶语义
    // 优先最后回复时间（last_touched），缺则退发帖时间（created），都缺则 null
    lastActiveAt: unixSecondsToIso(raw.last_touched) ?? unixSecondsToIso(raw.created),
    ...(excerpt !== '' ? { excerpt } : {}),
    // 作者个人主页（issue #2 建议一 authorUrl 数据源）：username 非空才构造，
    // 与 excerpt 同款"空则不落键"约定
    ...(username.trim() !== '' ? { authorUrl: `${baseUrl}/member/${username}` } : {})
  }
}

export interface V2exSourceOptions {
  fetchJson: FetchLike
  /**
   * 来源 id（稳定 slug）：seen 去重键前缀、state 键、状态键以此为准（D3）。
   * 装配方传 config.sources 里的 id；默认 'v2ex'。
   */
  id?: string
  /** 默认 https://www.v2ex.com；单测/镜像可覆盖 */
  baseUrl?: string
}

export class V2exSourceAdapter implements SourceAdapter {
  readonly id: string
  readonly name = 'V2EX'
  /**
   * W3 能力声明：V2EX topic id 随创建单调递增（2026-09-19 实测 latest 一页
   * newest 1243180 > oldest 1243131，/t/{id} 由服务端递增分配），
   * engine 据此做 "新帖 vs 回复顶起旧帖" 的 id 阈值过滤。
   */
  readonly creationOrderedIds = true

  private readonly fetchJson: FetchLike
  private readonly baseUrl: string

  constructor(options: V2exSourceOptions) {
    this.id = options.id ?? 'v2ex'
    this.fetchJson = options.fetchJson
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
  }

  async fetchLatest(): Promise<Topic[]> {
    const url = `${this.baseUrl}${LATEST_PATH}`
    // fetchJson reject（网络错误 / 超时 abort）原样上抛，不吞不改
    const res = await this.fetchJson(url, {
      method: 'GET',
      headers: { ...REQUEST_HEADERS },
      timeoutMs: REQUEST_TIMEOUT_MS
    })

    // 挑战双信号，任一命中即 ChallengeError（先于其他状态码分支，ADR 5；
    // 共享实现见 sources/challenge.ts，R4-W4 起与 html/rss adapter 同一口径）
    assertNotChallenged(res.status, res.headers)
    if (res.status === 429) {
      // 公共 API 未认证限速 ~120 次/小时；走普通失败退避，提示调大轮询间隔
      throw new Error(
        'v2ex rate limit hit (HTTP 429): unauthenticated API allows ~120 req/h; ' +
          'increase poll interval (default 60s = 60/h is within limit)'
      )
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`v2ex latest request failed: HTTP ${res.status}`)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(res.body)
    } catch (err) {
      throw new Error(`v2ex latest response is not valid JSON: ${(err as Error).message}`)
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`v2ex latest response is not a JSON array (got ${typeof parsed})`)
    }

    const topics = parsed.map((item) => mapTopic(item, this.baseUrl)).filter((t): t is Topic => t !== null)
    if (topics.length === 0) {
      // 0 条 ≠ 无新帖：latest 恒 40 帖，0 条 = 端点改版或被拦的异常形态
      throw new Error(`parsed 0 topics from ${url} (endpoint change or challenge page)`)
    }
    return topics
  }
}
