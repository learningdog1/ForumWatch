/**
 * 分类报告的确定性统计（R17）——纯函数、零 IO、零 electron 依赖
 * （对齐 rules.ts / similarity.ts 风格）。
 *
 * 输入是 TopicRecord[]（topics-store 读出的、**已过滤**的分类内帖子——过滤
 * （来源/分类/置顶）在 category-report.ts 做，本模块不做业务过滤）；输出直接
 * 可拼进 markdown 的结构。全部确定性：同一输入恒同一输出（AI 降级时报告的
 * 统计段与 LLM 可用时完全一致，模板模式不缺数）。
 *
 * 价格行情：全部标题跑 rules.ts 的 extractDeal，按 cycle×currency 聚合
 * （样本数 / 最低 / P25 / 中位 / P75 / 最高 + 组内流量中位）——VPS 优惠价格
 * 行情的分位表。零样本时上层如实写「未解析出结构化价格」。
 */
import type { TopicRecord } from '../../shared/types'
import { extractDeal, type DealInfo } from './rules'
import { normalizeTitle } from './similarity'

/**
 * 分类×日帖量矩阵：days 旧→新、categories 按首见序，
 * counts[dayIndex][categoryIndex] = 该日该分类的帖数。
 * 记录的"日"取 dayOfRecord（**优先记录内 day 字段**=写入时本地日，旧记录回退
 * firstSeenAt 的当前时区本地日重算——不能用 ISO slice，D5 坑④）。
 */
export interface CategoryDayMatrix {
  days: string[]
  categories: string[]
  counts: number[][]
}

/** 作者 Top 榜条目 */
export interface AuthorCount {
  author: string
  count: number
}

/** 同帖多发（热门信号）条目：normalizeTitle 归一后出现 ≥ minCount 次 */
export interface RepeatedTitle {
  /** 组内首个原始标题（展示用） */
  title: string
  count: number
}

/** 一个 cycle×currency 分组的价格行情 */
export interface DealStatGroup {
  /** 分组键 `${cycle ?? 'any'}×${currency}`，如 "yearly×CNY" */
  group: string
  /** 周期（'yearly' | 'monthly' | 'any'——any = 标题没解析出周期但有价格） */
  cycle: 'yearly' | 'monthly' | 'any'
  currency: 'CNY' | 'USD'
  /** 样本数（有价格的帖子数） */
  samples: number
  min: number
  p25: number
  median: number
  p75: number
  max: number
  /** 组内流量中位（GB）；组内无流量数据 → null */
  trafficMedianGB: number | null
}

/** 全部确定性统计的聚合结果（报告渲染的直接输入） */
export interface CategoryStats {
  total: number
  matrix: CategoryDayMatrix
  topAuthors: AuthorCount[]
  repeatedTitles: RepeatedTitle[]
  dealGroups: DealStatGroup[]
}

/**
 * ISO 时刻 → 本地 'YYYY-MM-DD'（与 hits-store formatLocalDate 同口径；解析失败回
 * 空串）。报告附录的按日分组与这里的矩阵共用（导出给 category-report.ts 复用，
 * 防两处口径漂移）。禁止 ISO slice——那是 UTC 日期（D5 坑④）。
 */
export function localDateOfIso(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 本地日期键形状（dayOfRecord 对记录内 day 字段的防御性校验） */
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 记录归属日（统计/附录的按日分桶读取口径）：**优先记录内 day 字段**——写入时
 * 已固化的本地日，读取/统计事后改时区也不会把历史记录重算进别的日桶（写入时
 * TZ 与读取时 TZ 不一致时的归日漂移）；旧记录（无 day 字段，v0.8.0 前期行）或
 * 字段损坏回退 firstSeenAt 按当前时区重算（向后兼容，与 matchedRule 等可选
 * 字段同款约定——消费方必须容忍缺失）。
 */
export function dayOfRecord(rec: TopicRecord): string {
  if (typeof rec.day === 'string' && DAY_KEY_RE.test(rec.day)) return rec.day
  return localDateOfIso(rec.firstSeenAt)
}

/**
 * 分位（线性插值）：sorted须升序。q∈[0,1]，0=min、0.5=中位、1=max。
 * 空数组返回 NaN（调用方保证非空）。
 */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN
  if (sorted.length === 1) return sorted[0]!
  const pos = (sorted.length - 1) * q
  const lower = Math.floor(pos)
  const upper = Math.ceil(pos)
  if (lower === upper) return sorted[lower]!
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (pos - lower)
}

/**
 * 全量统计（渲染前的唯一入口）：
 * - matrix：按 dayOfRecord 归属日聚合（优先记录内 day，见其注释）；分类空串归「未分类」（来源解析失败的
 *   观测面，覆盖率行的姊妹信号）。
 * - topAuthors：计数降序、并列按首见序（Map 保序）；上限 limit（默认 10）。
 * - repeatedTitles：normalizeTitle 归一后出现 ≥ minCount（默认 2）次的组，
 *   计数降序、并列按首见序。
 * - dealGroups：extractDeal 解析出价格的记录按 cycle×currency 聚合（cycle 缺失
 *   归 'any'）；组内流量中位取该组有 trafficGB 的样本（无 → null）。
 *   排序按 samples 降序、并列按组键字典序（输出稳定）。
 */
export function buildCategoryStats(
  records: TopicRecord[],
  opts: { topAuthorLimit?: number; repeatedMinCount?: number } = {}
): CategoryStats {
  const topAuthorLimit = opts.topAuthorLimit ?? 10
  const repeatedMinCount = opts.repeatedMinCount ?? 2

  // ---- 分类×日矩阵 ----
  const days: string[] = []
  const dayIndex = new Map<string, number>()
  const categories: string[] = []
  const catIndex = new Map<string, number>()
  const counts: number[][] = []
  const bump = (day: string, category: string): void => {
    let di = dayIndex.get(day)
    if (di === undefined) {
      di = days.length
      dayIndex.set(day, di)
      days.push(day)
      counts.push([])
    }
    const cat = category !== '' ? category : '未分类'
    let ci = catIndex.get(cat)
    if (ci === undefined) {
      ci = categories.length
      catIndex.set(cat, ci)
      categories.push(cat)
    }
    counts[di]![ci] = (counts[di]![ci] ?? 0) + 1
  }
  // 先按本地日稳定排序再聚合：days 旧→新（firstSeenAt 序）；归属日优先记录内
  // day 字段（dayOfRecord——写入时本地日，改时区不漂移）
  const byDay = new Map<string, TopicRecord[]>()
  for (const rec of records) {
    const day = dayOfRecord(rec)
    const list = byDay.get(day)
    if (list === undefined) byDay.set(day, [rec])
    else list.push(rec)
  }
  for (const day of [...byDay.keys()].sort()) {
    // 日内按 firstSeenAt 时刻排序：分类首见序 = 时间序（真实存档本就时间序，
    // 这里防御调用方乱序传入）
    const dayRecs = [...byDay.get(day)!].sort(
      (a, b) => (Date.parse(a.firstSeenAt) || 0) - (Date.parse(b.firstSeenAt) || 0)
    )
    for (const rec of dayRecs) bump(day, rec.category)
  }
  // 行补齐到全分类宽（bump 只创建被碰过的槽；渲染要稠密矩阵，未触达 = 0）
  for (let i = 0; i < counts.length; i++) {
    counts[i] = Array.from({ length: categories.length }, (_, j) => counts[i]![j] ?? 0)
  }

  // ---- 作者 Top ----
  const authorCounts = new Map<string, number>()
  for (const rec of records) {
    const a = rec.author !== '' ? rec.author : '（匿名）'
    authorCounts.set(a, (authorCounts.get(a) ?? 0) + 1)
  }
  const topAuthors: AuthorCount[] = [...authorCounts.entries()]
    .map(([author, count]) => ({ author, count }))
    // 并列按码点序（不用 localeCompare——ICU 大小版本间排序不稳定，报告要确定性）
    .sort((a, b) => b.count - a.count || (a.author < b.author ? -1 : a.author > b.author ? 1 : 0))
    .slice(0, topAuthorLimit)

  // ---- 同帖多发（归一标题聚合） ----
  const titleGroups = new Map<string, { title: string; count: number }>()
  for (const rec of records) {
    const norm = normalizeTitle(rec.title)
    if (norm.length === 0) continue // 纯符号标题无归一形，不参与聚合
    const g = titleGroups.get(norm)
    if (g === undefined) titleGroups.set(norm, { title: rec.title, count: 1 })
    else g.count++
  }
  const repeatedTitles: RepeatedTitle[] = [...titleGroups.values()]
    .filter((g) => g.count >= repeatedMinCount)
    .sort((a, b) => b.count - a.count || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0))

  // ---- 价格行情（extractDeal 聚合） ----
  const dealBuckets = new Map<
    string,
    {
      cycle: 'yearly' | 'monthly' | 'any'
      currency: 'CNY' | 'USD'
      prices: number[]
      traffic: number[]
    }
  >()
  for (const rec of records) {
    const deal: DealInfo | null = extractDeal(rec.title)
    if (deal === null || deal.price === undefined) continue // 无价格样本不进分组
    const cycle = deal.cycle ?? 'any'
    const key = `${cycle}×${deal.price.currency}`
    let b = dealBuckets.get(key)
    if (b === undefined) {
      b = { cycle, currency: deal.price.currency, prices: [], traffic: [] }
      dealBuckets.set(key, b)
    }
    b.prices.push(deal.price.amount)
    if (deal.trafficGB !== undefined) b.traffic.push(deal.trafficGB)
  }
  const dealGroups: DealStatGroup[] = [...dealBuckets.entries()]
    .map(([group, b]) => {
      const sorted = [...b.prices].sort((x, y) => x - y)
      const trafficSorted = [...b.traffic].sort((x, y) => x - y)
      return {
        group,
        cycle: b.cycle,
        currency: b.currency,
        samples: sorted.length,
        min: sorted[0]!,
        p25: quantile(sorted, 0.25),
        median: quantile(sorted, 0.5),
        p75: quantile(sorted, 0.75),
        max: sorted[sorted.length - 1]!,
        trafficMedianGB:
          trafficSorted.length > 0 ? round1(quantile(trafficSorted, 0.5)) : null
      }
    })
    .sort((a, b) => b.samples - a.samples || (a.group < b.group ? -1 : 1))

  return { total: records.length, matrix: { days, categories, counts }, topAuthors, repeatedTitles, dealGroups }
}

/** 一位小数四舍五入（流量中位展示口径，与 rules.ts 的 trafficGB 同款） */
function round1(n: number): number {
  return Math.round(n * 10) / 10
}
