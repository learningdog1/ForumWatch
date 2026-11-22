/**
 * 社区活动初筛与确定性结构化提取（零网络、零 Electron、纯函数）。
 *
 * 设计职责：
 * 1. `prescreenActivityTopic`：在每轮监控新帖中以微秒级开销初筛出「疑似活动帖」
 *    （抽奖 / 盖楼 / 福利派送 / 社区节日专题 / 限时闪购促销），同时拦截二手单机买卖、
 *    求助提问、曝光吐槽等常见误报，严格控制后续 1 楼详情抓取与 AI 提取的触发频次。
 * 2. `hasEndedTitleMarker`：检测楼主修改标题后的「已开奖 / 已结束」标记，支持引擎每轮
 *    零额外请求自动同步活动结束状态。
 * 3. `extractDeterministicActivitySignals`：从标题 + 1 楼 Markdown/文本中提取开奖链接
 *    （`nodeseek.com/lucky?...`）、目标楼层、起止时间戳、奖品、参与方式、清洗摘要与外链，
 *    既作为 AI 精筛的结构化辅助信号，也在未配 AI / AI 故障时提供完整确定性兜底。
 */
import { isExcluded, matchTopic } from '../monitor/matcher'
import type { ActivityKind, ActivityLabeledLink, Topic } from '../../shared/types'

export interface PrescreenOptions {
  includeKeywords?: string[]
  excludeKeywords?: string[]
}

export interface PrescreenResult {
  matched: boolean
  kindHint: ActivityKind
  reason: string
}

/** 永不作为活动的分类 slug（曝光 / 沙盒） */
const BLOCKED_CATEGORY_SLUGS = new Set(['expose', 'sandbox', 'meaningless'])

/** 强抽奖信号（即使在交易/日常分区也放行） */
const STRONG_LOTTERY_RE =
  /抽奖|抽个|抽送|抽一台|抽两台|抽几个|抽\s*\d+\s*[个台份名位]|开奖|roll\s*个|\broll\b|nodeseek\.com\/lucky/i

/** 盖楼互动信号 */
const FLOOR_ACTIVITY_RE = /盖楼|踩楼|抢楼|t楼|楼层抽奖|满\s*\d+\s*楼/i

/** 福利派送信号 */
const GIVEAWAY_RE =
  /白送|免费送|送小鸡|送鸡|送一台|送几个|送码|送邀请码|送鸡腿|发鸡腿|散财|派送|免费领|0元领|零元领|\bgiveaway\b|\bfreebie\b/i

/** 社区/节日/官方活动信号 */
const COMMUNITY_EVENT_RE =
  /周年庆|庆典|节日福利|中秋(?:节|福利|活动)|国庆(?:节|福利|活动)|春节(?:福利|活动)|除夕(?:福利|活动)|跨年(?:福利|活动)|元旦(?:福利|活动)|圣诞(?:节|福利|活动)|元宵(?:节|福利|活动)|端午(?:节|福利|活动)|双十一|双11|618活动|黑五|black\s*friday|cyber\s*monday|有奖征文|挑战赛|打卡活动|官方活动|社区活动|专题活动/i

/** 标题带显式活动角标，如【活动】[福利]【抽奖】 */
const EXPLICIT_BRACKET_TAG_RE = /^[【\[（(]\s*(?:抽奖|福利|活动|派送|盖楼|送鸡|白嫖|闪购|秒杀|giveaway)\s*[】\]）)]/i

/** 限时促销信号 */
const PROMO_ACTIVITY_RE =
  /闪购|秒杀|限时特惠|限时优惠|限时福利|限时活动|首发特惠|首发福利|开业活动|开业特惠|内测福利|公测福利|免单活动|半价活动|\bflash\s*sale\b/i

/** 泛「活动 / 福利」词（需通过反误报闸门才放行） */
const SOFT_ACTIVITY_RE = /福利|活动/

/** 二手交易贴特征（无强抽奖/白送信号时拦截） */
const SECONDARY_TRADE_NOISE_RE =
  /(?:^|[【\[\s])(?:收|求购|诚收|高价收|慢收|出|明盘|剩余价值|溢价出|折价出|带价|push出|原油出)(?:[】\]\s]|一台|一个|小鸡|$)|剩余价值/i

/** 纯提问 / 求助 / 吐槽 / 避雷贴特征（无显式活动角标时拦截） */
const QUESTION_OR_RANT_NOISE_RE =
  /(?:请问|求问|请教|求助|有没有人|有人知道|怎么回事|为什么|避雷|曝光|骗子|翻车|挂人|吐槽|水一贴|评测一下)/i

/** 标题已结束/已开奖标记（支持首页列表零请求自动把进行中活动同步为 ended） */
const ENDED_TITLE_MARKER_RE =
  /已开奖|开奖完毕|开奖结束|已结束|活动结束|已截止|已抽完|已送完|已领完|抽奖结束|[【\[(]\s*(?:已开|已结|结束|截止)\s*[】\])]/i

/**
 * 判定标题是否已标明活动/抽奖结束。
 */
export function hasEndedTitleMarker(title: string): boolean {
  return ENDED_TITLE_MARKER_RE.test(title)
}

/**
 * 对单条论坛帖子做快速初筛，决定是否进入活动详情抓取与结构化入库管线。
 */
export function prescreenActivityTopic(topic: Topic, opts?: PrescreenOptions): PrescreenResult {
  const title = topic.title.trim()
  if (title.length === 0) {
    return { matched: false, kindHint: 'other', reason: '空标题' }
  }

  const slug = topic.categorySlug.trim().toLowerCase()
  if (BLOCKED_CATEGORY_SLUGS.has(slug)) {
    return { matched: false, kindHint: 'other', reason: `分类「${slug}」不参与活动归集` }
  }

  const excludeKeywords = opts?.excludeKeywords ?? []
  if (excludeKeywords.length > 0 && isExcluded(topic, excludeKeywords)) {
    return { matched: false, kindHint: 'other', reason: '命中活动排除词' }
  }

  // 用户自定义包含词优先放行
  const includeKeywords = opts?.includeKeywords ?? []
  if (includeKeywords.length > 0) {
    const custom = matchTopic(topic, includeKeywords, [])
    if (custom.matched) {
      return {
        matched: true,
        kindHint: inferKindFromTitle(title),
        reason: `命中自定义活动词: ${custom.matchedKeywords.join(', ')}`
      }
    }
  }

  const hasExplicitTag = EXPLICIT_BRACKET_TAG_RE.test(title)
  const isStrongLottery = STRONG_LOTTERY_RE.test(title)
  const isFloor = FLOOR_ACTIVITY_RE.test(title)
  const isGiveaway = GIVEAWAY_RE.test(title)

  // 强信号（抽奖 / 盖楼 / 明确白送 / 显式角标）：仅在纯提问避雷且无显式角标时拦一下
  if (hasExplicitTag || isStrongLottery || isFloor || isGiveaway) {
    if (!hasExplicitTag && QUESTION_OR_RANT_NOISE_RE.test(title) && /[?？]$/.test(title)) {
      return { matched: false, kindHint: 'other', reason: '疑问句求助贴' }
    }
    const kindHint: ActivityKind = isFloor
      ? 'floor'
      : isStrongLottery
        ? 'lottery'
        : isGiveaway
          ? 'giveaway'
          : inferKindFromTitle(title)
    return { matched: true, kindHint, reason: `命中强活动特征 (${kindHint})` }
  }

  // 二手买卖/求购在非强抽奖场景一律拦截
  if (SECONDARY_TRADE_NOISE_RE.test(title) || slug === 'trade') {
    return { matched: false, kindHint: 'other', reason: '常规二手交易/求购贴' }
  }

  // 纯提问/吐槽拦截
  if (QUESTION_OR_RANT_NOISE_RE.test(title) || /[?？]$/.test(title)) {
    return { matched: false, kindHint: 'other', reason: '提问或讨论贴' }
  }

  if (COMMUNITY_EVENT_RE.test(title)) {
    return { matched: true, kindHint: 'event', reason: '命中社区/节日活动特征' }
  }

  if (PROMO_ACTIVITY_RE.test(title)) {
    return { matched: true, kindHint: 'promo', reason: '命中限时促销活动特征' }
  }

  // 推广/情报分类下的泛「福利 / 活动」贴
  if ((slug === 'promotion' || slug === 'info') && SOFT_ACTIVITY_RE.test(title)) {
    return {
      matched: true,
      kindHint: slug === 'promotion' ? 'promo' : 'event',
      reason: `「${topic.category || slug}」分类含福利/活动关键词`
    }
  }

  return { matched: false, kindHint: 'other', reason: '未命中活动特征' }
}

function inferKindFromTitle(title: string): ActivityKind {
  if (FLOOR_ACTIVITY_RE.test(title)) return 'floor'
  if (STRONG_LOTTERY_RE.test(title)) return 'lottery'
  if (GIVEAWAY_RE.test(title)) return 'giveaway'
  if (PROMO_ACTIVITY_RE.test(title)) return 'promo'
  if (COMMUNITY_EVENT_RE.test(title)) return 'event'
  return 'other'
}

// ---- 1 楼正文与标题确定性信号提取 --------------------------------------------

export interface DeterministicSignalInput {
  title: string
  markdown?: string
  sourceUrl: string
  /** 帖子发布时间或首次观测时间（epoch ms），用作相对时间的锚点 */
  baseTimeMs: number
}

export interface DeterministicActivitySignals {
  kind: ActivityKind
  summary: string
  luckyUrl: string | null
  drawFloor: number | null
  startsAtEpochMillis: number | null
  endsAtEpochMillis: number | null
  prize: string | null
  participation: string | null
  tags: string[]
  externalLinks: ActivityLabeledLink[]
  alreadyEnded: boolean
}

const LUCKY_URL_ABS_RE = /https?:\/\/(?:www\.)?nodeseek\.com\/lucky[^\s)"'>\]<`]*/i
const LUCKY_URL_REL_RE = /(?<![A-Za-z0-9_/-])\/lucky\?[^\s)"'>\]<`]+/i

const DRAW_FLOOR_PATTERNS: readonly RegExp[] = [
  /(?:开奖楼层|截止楼层|目标楼层|开奖层数)\s*[:：为是]?\s*(\d{2,6})\s*(?:楼|层|l\b)?/i,
  /(?:满|盖到|顶到|踩到|截止至?|抽到)\s*(\d{2,6})\s*(?:楼|层|l\b)/i,
  /(\d{2,6})\s*(?:楼|层|l)\s*(?:开奖|截止|结束|自动开)/i
]

const PRIZE_LINE_RE =
  /(?:奖品|奖项|福利内容|赠送|抽送|奖池)\s*[:：]\s*([^\n]{2,120})/i
const PARTICIPATION_LINE_RE =
  /(?:参与方式|参与条件|参与规则|抽奖规则|活动规则|回复规则)\s*[:：]\s*([^\n]{2,140})/i

const MD_IMAGE_RE = /!\[[^\]]*]\([^)\n]+\)/g
const MD_LINK_RE = /\[([^\]]+)]\((https?:\/\/[^)\s]+)\)/g
const RAW_URL_RE = /https?:\/\/[^\s)"'>\]<`]+/g

/**
 * 从标题与 1 楼 Markdown 中提取确定性活动元数据。
 */
export function extractDeterministicActivitySignals(
  input: DeterministicSignalInput
): DeterministicActivitySignals {
  const title = input.title.trim()
  const rawBody = (input.markdown ?? '').trim()
  const combined = rawBody !== '' ? `${title}\n${rawBody}` : title

  const luckyUrl = extractLuckyUrl(combined)
  const luckyMeta = luckyUrl !== null ? parseLuckyUrlParams(luckyUrl) : { timeMs: null, floor: null }

  const drawFloor = luckyMeta.floor ?? extractDrawFloor(combined)
  const alreadyEnded = hasEndedTitleMarker(title)

  const textEndMs = extractEndTimestampMs(combined, input.baseTimeMs)
  const textStartMs = extractStartTimestampMs(combined, input.baseTimeMs)

  const startsAtEpochMillis =
    textStartMs ?? (Number.isFinite(input.baseTimeMs) && input.baseTimeMs > 0 ? input.baseTimeMs : null)

  let endsAtEpochMillis = luckyMeta.timeMs ?? textEndMs
  if (
    endsAtEpochMillis !== null &&
    startsAtEpochMillis !== null &&
    endsAtEpochMillis < startsAtEpochMillis - 60_000
  ) {
    // 防止误抓帖子里的历史日期导致结束时间早于发帖时间
    endsAtEpochMillis = null
  }
  if (alreadyEnded && (endsAtEpochMillis === null || endsAtEpochMillis > input.baseTimeMs)) {
    endsAtEpochMillis = input.baseTimeMs
  }

  let kind = inferKindFromTitle(title)
  if (kind === 'other') {
    if (luckyUrl !== null) kind = 'lottery'
    else if (drawFloor !== null) kind = 'floor'
    else kind = inferKindFromTitle(combined.slice(0, 400))
  }

  const prize = extractLabeledLine(rawBody, PRIZE_LINE_RE)
  const participation = extractLabeledLine(rawBody, PARTICIPATION_LINE_RE)
  const externalLinks = extractExternalLinks(rawBody, luckyUrl)
  const summary = buildCleanSummary(title, rawBody, { prize, participation, drawFloor })
  const tags = deriveActivityTags(title, combined, kind, luckyUrl !== null)

  return {
    kind,
    summary,
    luckyUrl,
    drawFloor,
    startsAtEpochMillis,
    endsAtEpochMillis,
    prize,
    participation,
    tags,
    externalLinks,
    alreadyEnded
  }
}

function extractLuckyUrl(text: string): string | null {
  const abs = LUCKY_URL_ABS_RE.exec(text)
  if (abs) return stripTrailingPunct(abs[0])
  const rel = LUCKY_URL_REL_RE.exec(text)
  if (rel) return `https://www.nodeseek.com${stripTrailingPunct(rel[0])}`
  return null
}

function stripTrailingPunct(url: string): string {
  return url.replace(/[.,;!?，。；！？）)】\]]+$/, '')
}

function parseLuckyUrlParams(luckyUrl: string): { timeMs: number | null; floor: number | null } {
  try {
    const parsed = new URL(luckyUrl)
    let timeMs: number | null = null
    for (const key of ['time', 'drawTime', 'endTime', 'ts', 'timestamp']) {
      const val = parsed.searchParams.get(key)?.trim()
      if (!val) continue
      if (/^\d{13}$/.test(val)) {
        timeMs = Number(val)
        break
      }
      if (/^\d{10}$/.test(val)) {
        timeMs = Number(val) * 1000
        break
      }
      const parsedDate = Date.parse(val)
      if (Number.isFinite(parsedDate) && parsedDate > 0) {
        timeMs = parsedDate
        break
      }
    }
    let floor: number | null = null
    for (const key of ['floor', 'maxFloor', 'targetFloor', 'endFloor']) {
      const val = parsed.searchParams.get(key)?.trim()
      if (val && /^\d{1,6}$/.test(val)) {
        const n = Number(val)
        if (n >= 2) {
          floor = n
          break
        }
      }
    }
    return { timeMs, floor }
  } catch {
    return { timeMs: null, floor: null }
  }
}

function extractDrawFloor(text: string): number | null {
  for (const re of DRAW_FLOOR_PATTERNS) {
    const m = re.exec(text)
    if (m && m[1]) {
      const n = Number.parseInt(m[1], 10)
      if (Number.isInteger(n) && n >= 5 && n <= 500_000) return n
    }
  }
  return null
}

function extractLabeledLine(text: string, re: RegExp): string | null {
  if (!text) return null
  const m = re.exec(text)
  if (!m || !m[1]) return null
  const clean = stripMarkdownInline(m[1]).trim()
  return clean.length > 0 ? clean.slice(0, 120) : null
}

/**
 * 提取活动截止 / 开奖时间戳（epoch ms）：
 * 1. 显式前导词 + 完整日期时间：`开奖时间：2026-11-25 20:00` / `截止：2026/11/25 23:59:59`
 * 2. 显式前导词 + 月日时间：`截止时间：11月25日 20:00` / `11-25 22:00 开奖`
 * 3. 相对日期 + 时刻：`今晚 22:00 开奖` / `明天 12:00 截止` / `后天 20点开奖`
 * 4. 相对时长：`24小时后开奖` / `2小时后截止` / `3天后开奖`
 */
function extractEndTimestampMs(text: string, baseTimeMs: number): number | null {
  const base = Number.isFinite(baseTimeMs) && baseTimeMs > 0 ? new Date(baseTimeMs) : new Date()

  // 1a. 区间写法：`活动时间：2026-11-20 10:00 至 2026-11-25 23:59`（取右端）
  const rangeFull =
    /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\s*(?:至|到|~|—|--|-)\s*(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(
      text
    )
  if (rangeFull) {
    return buildLocalEpochMs(
      Number(rangeFull[4]),
      Number(rangeFull[5]),
      Number(rangeFull[6]),
      rangeFull[7] !== undefined ? Number(rangeFull[7]) : 23,
      rangeFull[8] !== undefined ? Number(rangeFull[8]) : 59,
      rangeFull[9] !== undefined ? Number(rangeFull[9]) : 59
    )
  }

  // 1b. 前导词 + YYYY-MM-DD [HH:MM[:SS]]
  const labeledFull =
    /(?:开奖时间|截止时间|结束时间|截止日期|活动截止|抽奖截止|开奖|截止|结束)\s*[:：为是于]?\s*(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:\s+(\d{1,2})(?:[:：点时](\d{1,2}))?(?::(\d{1,2}))?)?/i.exec(
      text
    )
  if (labeledFull) {
    return buildLocalEpochMs(
      Number(labeledFull[1]),
      Number(labeledFull[2]),
      Number(labeledFull[3]),
      labeledFull[4] !== undefined ? Number(labeledFull[4]) : 23,
      labeledFull[5] !== undefined ? Number(labeledFull[5]) : 59,
      labeledFull[6] !== undefined ? Number(labeledFull[6]) : 0
    )
  }

  // 1c. YYYY-MM-DD HH:MM 后置「开奖/截止/结束」
  const trailingFull =
    /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?\s+(\d{1,2})(?:[:：点时](\d{1,2}))?\s*分?\s*(?:开奖|截止|结束|自动开奖)/.exec(
      text
    )
  if (trailingFull) {
    return buildLocalEpochMs(
      Number(trailingFull[1]),
      Number(trailingFull[2]),
      Number(trailingFull[3]),
      Number(trailingFull[4]),
      trailingFull[5] !== undefined ? Number(trailingFull[5]) : 0,
      0
    )
  }

  // 2a. 前导词 + MM月DD日 [HH:MM]
  const labeledMd =
    /(?:开奖时间|截止时间|结束时间|活动截止|开奖|截止)\s*[:：为是于]?\s*(\d{1,2})(?:月|[-/.])(\d{1,2})日?(?:\s*(?:晚上|下午|中午|凌晨)?\s*(\d{1,2})(?:[:：点时](\d{1,2}))?)?/.exec(
      text
    )
  if (labeledMd) {
    return resolveMonthDayEpochMs(
      base,
      Number(labeledMd[1]),
      Number(labeledMd[2]),
      labeledMd[3] !== undefined ? adjustPeriodHour(Number(labeledMd[3]), labeledMd[0]) : 23,
      labeledMd[4] !== undefined ? Number(labeledMd[4]) : labeledMd[3] !== undefined ? 0 : 59
    )
  }

  // 2b. MM月DD日 HH:MM 后置「开奖/截止」
  const trailingMd =
    /(\d{1,2})月(\d{1,2})[日号]?\s*(?:晚上|下午|中午|凌晨)?\s*(\d{1,2})(?:[:：点时](\d{1,2}))?\s*分?\s*(?:开奖|截止|结束)/.exec(
      text
    )
  if (trailingMd) {
    return resolveMonthDayEpochMs(
      base,
      Number(trailingMd[1]),
      Number(trailingMd[2]),
      adjustPeriodHour(Number(trailingMd[3]), trailingMd[0]),
      trailingMd[4] !== undefined ? Number(trailingMd[4]) : 0
    )
  }

  // 3. 相对天 + 时刻：`今晚 22:00 开奖` / `明天中午12点开奖`
  const relDay =
    /(今天|今日|今晚|明天|明日|明晚|后天)\s*(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2})(?:[:：点时](\d{1,2}))?\s*分?\s*(?:开奖|截止|结束)?/.exec(
      text
    )
  if (relDay && /开奖|截止|结束|抽/.test(text)) {
    const dayWord = relDay[1]!
    const period = relDay[2] ?? (dayWord.endsWith('晚') ? '晚上' : '')
    const dayOffset = dayWord.startsWith('明') ? 1 : dayWord === '后天' ? 2 : 0
    const hour = adjustPeriodHour(Number(relDay[3]), period)
    const minute = relDay[4] !== undefined ? Number(relDay[4]) : 0
    const d = new Date(base)
    d.setDate(d.getDate() + dayOffset)
    d.setHours(hour, minute, 0, 0)
    return d.getTime()
  }

  // 4. 相对时长：`24小时后开奖` / `3天后截止` / `30分钟后开奖`
  const relDur =
    /(\d{1,3}(?:\.\d+)?)\s*(分钟|小时|个小时|h|天|日)\s*(?:后|之后|内)\s*(?:开奖|截止|结束|自动开奖)/i.exec(
      text
    )
  if (relDur) {
    const num = Number.parseFloat(relDur[1]!)
    const unit = relDur[2]!.toLowerCase()
    if (Number.isFinite(num) && num > 0) {
      const mult =
        unit === '分钟'
          ? 60_000
          : unit === '天' || unit === '日'
            ? 86_400_000
            : 3_600_000
      return Math.round(base.getTime() + num * mult)
    }
  }

  return null
}

function extractStartTimestampMs(text: string, _baseTimeMs: number): number | null {
  const m =
    /(?:开始时间|活动开始)\s*[:：为是于]?\s*(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:\s+(\d{1,2})(?:[:：点时](\d{1,2}))?)?/.exec(
      text
    )
  if (!m) return null
  return buildLocalEpochMs(
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    m[4] !== undefined ? Number(m[4]) : 0,
    m[5] !== undefined ? Number(m[5]) : 0,
    0
  )
}

function adjustPeriodHour(hour: number, context: string): number {
  if (hour >= 1 && hour <= 11 && /下午|傍晚|晚上|今晚|明晚/.test(context)) {
    return hour + 12
  }
  if (hour === 12 && /凌晨/.test(context)) {
    return 0
  }
  return Math.min(23, Math.max(0, hour))
}

function buildLocalEpochMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): number | null {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null
  }
  const d = new Date(year, month - 1, day, hour, minute, second, 0)
  return Number.isFinite(d.getTime()) ? d.getTime() : null
}

function resolveMonthDayEpochMs(
  base: Date,
  month: number,
  day: number,
  hour: number,
  minute: number
): number | null {
  let year = base.getFullYear()
  let candidate = buildLocalEpochMs(year, month, day, hour, minute, 0)
  if (candidate === null) return null
  // 跨年兼容：12 月末发帖写「1月2日开奖」时自动进位到下一年
  if (candidate < base.getTime() - 30 * 86_400_000) {
    year += 1
    candidate = buildLocalEpochMs(year, month, day, hour, minute, 0)
  }
  return candidate
}

function extractExternalLinks(
  markdown: string,
  luckyUrl: string | null
): ActivityLabeledLink[] {
  const out: ActivityLabeledLink[] = []
  const seen = new Set<string>()
  const pushLink = (text: string, rawUrl: string): void => {
    const cleanUrl = stripTrailingPunct(rawUrl.trim())
    if (!/^https?:\/\//i.test(cleanUrl)) return
    // 跳过常见图片图床后缀
    if (/\.(?:png|jpe?g|gif|webp|svg|avif)(?:\?.*)?$/i.test(cleanUrl)) return
    if (seen.has(cleanUrl)) return
    seen.add(cleanUrl)
    out.push({ text: text.trim().slice(0, 60) || '相关链接', url: cleanUrl })
  }

  if (luckyUrl !== null) {
    pushLink('官方随机数开奖链接', luckyUrl)
  }

  MD_LINK_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = MD_LINK_RE.exec(markdown)) !== null) {
    if (out.length >= 10) break
    pushLink(match[1] ?? '', match[2] ?? '')
  }

  if (out.length < 10) {
    RAW_URL_RE.lastIndex = 0
    while ((match = RAW_URL_RE.exec(markdown)) !== null) {
      if (out.length >= 10) break
      pushLink('活动链接', match[0])
    }
  }
  return out
}

function stripMarkdownInline(raw: string): string {
  return raw
    .replace(MD_IMAGE_RE, '')
    .replace(MD_LINK_RE, '$1')
    .replace(RAW_URL_RE, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_~>#|]+/g, ' ')
    .replace(/:[a-zA-Z]{2,5}\d{2,4}:/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildCleanSummary(
  title: string,
  markdown: string,
  meta: { prize: string | null; participation: string | null; drawFloor: number | null }
): string {
  const pieces: string[] = []
  if (meta.prize) pieces.push(`奖品：${meta.prize}`)
  if (meta.participation) pieces.push(`规则：${meta.participation}`)
  if (meta.drawFloor !== null && !pieces.some((p) => p.includes(String(meta.drawFloor)))) {
    pieces.push(`满 ${meta.drawFloor} 楼开奖`)
  }
  if (pieces.length > 0) {
    return pieces.join(' · ').slice(0, 220)
  }

  if (markdown.trim() !== '') {
    const lines = markdown
      .split(/\r?\n/)
      .map(stripMarkdownInline)
      .filter((l) => l.length >= 4 && l !== title)
    const joined = lines.slice(0, 3).join('；').trim()
    if (joined.length > 0) {
      return joined.length > 220 ? `${joined.slice(0, 219)}…` : joined
    }
  }
  return ''
}

function deriveActivityTags(
  title: string,
  combined: string,
  kind: ActivityKind,
  hasLuckyUrl: boolean
): string[] {
  const tags: string[] = []
  const push = (t: string): void => {
    if (!tags.includes(t) && tags.length < 5) tags.push(t)
  }
  switch (kind) {
    case 'lottery':
      push('抽奖')
      break
    case 'floor':
      push('盖楼')
      break
    case 'giveaway':
      push('福利派送')
      break
    case 'promo':
      push('限时特惠')
      break
    case 'event':
      push('社区活动')
      break
    default:
      break
  }
  if (hasLuckyUrl) push('官方开奖')
  if (/小鸡|vps|服务器|云主机|独服|nat/i.test(combined)) push('VPS')
  if (/鸡腿/.test(combined)) push('鸡腿')
  if (/邀请码|invite/i.test(combined)) push('邀请码')
  if (/免单|白嫖|免费/i.test(title)) push('免费福利')
  return tags
}
