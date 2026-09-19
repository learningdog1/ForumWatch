/**
 * 结构化价格规则（纯函数、零 IO、零 electron 依赖，对齐 matcher.ts 风格）。
 *
 * R5-P1a：从标题提取结构化交易信息（周期/价格/流量），再逐条评估
 * PriceRuleConfig（R5-P0 契约，条件 AND、首条命中即返回）。
 *
 * 总原则「宁缺勿错」：识别不了的形态（双月付/季付/半年付、裸数字价格如
 * 「年付 88」的 88、永久套餐等）一律不产出字段，让规则不命中，
 * 而不是猜一个近似值喂给 maxPrice/minTrafficGB 比较。
 */
import type { PriceRuleConfig } from '../../shared/types'

/** 从标题提取出的结构化交易信息（全部字段可选） */
export interface DealInfo {
  cycle?: 'yearly' | 'monthly'
  price?: { amount: number; currency: 'CNY' | 'USD' }
  /** 统一换算成 GB（T×1024、M÷1024），保留一位小数；「不限流量」不设此字段 */
  trafficGB?: number
}

/** 一条价格规则的命中结果（evaluateRules 首条命中返回） */
export interface RuleMatch {
  ruleId: string
  label: string | null
  /** 命中时的提取结果；规则不含提取类条件时可能是空对象（title 无可提取字段） */
  deal: DealInfo
}

/**
 * 数字口径：千分位（1,299）优先匹配，退回普通整数/小数（9.9、1024）。
 * 千分位放前面，避免 \d+ 只吃到「1,299」开头的 1。
 */
const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`

/**
 * 价格（取标题里**首个**匹配，币种由命中形态决定）：
 * - CNY：¥99 / ￥99 / 99元 / 99 块
 * - USD：$9.9 / 9.9刀 / USD 20
 * `1,299元/年` 这类价格与周期分离的写法由本正则与周期正则各自独立提取。
 * 多价格标题（「对比：甲 ¥99/年 vs 乙 $20/年」）取首个——简单可预测，
 * 这类标题建议用户加 keywords 缩小范围，而不是让提取器猜「最便宜」。
 * `99元素` 不算价格（负向断言挡掉「XX元素」这类误报）。
 * 注意：裸数字（如「年付88」的 88）没有币种标记，**不**提取。
 */
const PRICE_RE = new RegExp(
  String.raw`[¥￥]\s*(${NUM})` + // ¥99 / ￥ 99
    String.raw`|\$\s*(${NUM})` + // $9.9 / $ 15
    String.raw`|(${NUM})\s*[元块](?!素)` + // 99元 / 99 块
    String.raw`|(${NUM})\s*刀` + // 9.9刀
    String.raw`|\busd\s*(${NUM})`, // USD 20
  'i'
)

/**
 * 流量（取首个匹配，统一换算 GB）：
 * - `500G` / `500GB` → 500；`0.5T` / `1TB` → ×1024；`1024M` / `512M` → ÷1024
 *   （M 级换算后保留一位小数：512M → 0.5，1024M → 1）
 * - `500G 流量` / `500GB traffic` 紧跟中英文后缀同样命中
 * - `不限流量` / `unlimited` 视为无约束，**不设 trafficGB**（不返回 Infinity）
 * 防误报的闸门：
 * - 数字前不能是字母——挡掉配置串 `2C2G` 里的「2G」（那是内存不是流量）
 * - 单位后不能跟 ASCII 字母或「内」——挡掉带宽 `500Mbps` / `10Gbps`
 *   （注意 MB 会先撞上 Mbps 的 Mb 前缀，只挡 b/B 兜不住，须挡全部字母），
 *   顺带挡掉 `2G内存` 这类紧跟内存字样的写法；`2GB RAM`（带空格）仍可能
 *   误读为流量，是已知残余，靠规则侧 keywords 缩小范围兜底
 */
const TRAFFIC_RE = new RegExp(
  String.raw`(?<![A-Za-z])(${NUM})\s*(TB|GB|MB|T|G|M)(?![A-Za-z内])`,
  'i'
)

/**
 * 年付口径（命中即 yearly）：
 * 年付 / 每年 / 一年 / 包年 / N年（数字或中文数字，如 3年、两年、十年）/
 * `X/年`（1,299元/年）/ annual / per year / yr / yearly
 * 闸门：
 * - `年付` 前不能是 半/季/双——「半年付」本轮不识别（宁缺勿错）
 * - `annual` 前不能是字母或连字符——挡掉「semi-annual」（= 半年付）
 * - `N年` 前不能是数字且 N 至多 3 位——挡掉「2023年」这类年份写法
 */
const YEARLY_RE =
  /(?<![半季双])年付|每年|包年|一年|(?<![0-9两二三四五六七八九十])[0-9两二三四五六七八九十]{1,3}年|\/年|(?<![A-Za-z-])annual|per\s*year|\byr\b|\byearly\b/i

/**
 * 月付口径（命中即 monthly）：
 * 月付（含 N月付，如 3月付）/ 每月 / `X/月`（15元/月）/ monthly / per month / mo
 * 闸门：
 * - `月付` 前不能是 半/季/双——「双月付」「季付」本轮不识别（宁缺勿错）
 * - 裸「一月」不识别（与一月份歧义，须带「付」字才算月付）
 * - `mo` 须是独立词（\b），避免命中 monitor/demo 之类的子串
 */
const MONTHLY_RE = /(?<![半季双])月付|每月|\/月|monthly|per\s*month|\bmo\b/i

/** 千分位数字串转数值：去逗号后 parseFloat */
function toAmount(raw: string): number {
  return Number.parseFloat(raw.replace(/,/g, ''))
}

/**
 * 从标题提取结构化交易信息；一个字段都提取不到 → null。
 *
 * 周期与价格独立提取（「年付」与「¥99」可分离出现）；同年付与月付信号
 * 同时出现时取 yearly（固定优先级，行为可预测）。
 */
export function extractDeal(title: string): DealInfo | null {
  const deal: DealInfo = {}

  if (YEARLY_RE.test(title)) deal.cycle = 'yearly'
  else if (MONTHLY_RE.test(title)) deal.cycle = 'monthly'

  const price = PRICE_RE.exec(title)
  if (price) {
    // 五个捕获组对应五种价格形态，哪组有值就是哪种币种
    const cny1 = price[1]
    const usd1 = price[2]
    const cny2 = price[3]
    const usd2 = price[4]
    const usd3 = price[5]
    if (cny1 !== undefined) deal.price = { amount: toAmount(cny1), currency: 'CNY' }
    else if (usd1 !== undefined) deal.price = { amount: toAmount(usd1), currency: 'USD' }
    else if (cny2 !== undefined) deal.price = { amount: toAmount(cny2), currency: 'CNY' }
    else if (usd2 !== undefined) deal.price = { amount: toAmount(usd2), currency: 'USD' }
    else if (usd3 !== undefined) deal.price = { amount: toAmount(usd3), currency: 'USD' }
  }

  const traffic = TRAFFIC_RE.exec(title)
  if (traffic) {
    const amount = toAmount(traffic[1])
    const unit = traffic[2].toUpperCase()
    let gb: number
    if (unit === 'T' || unit === 'TB') gb = amount * 1024
    else if (unit === 'M' || unit === 'MB') gb = amount / 1024
    else gb = amount
    deal.trafficGB = Math.round(gb * 10) / 10
  }

  return deal.cycle === undefined && deal.price === undefined && deal.trafficGB === undefined
    ? null
    : deal
}

/** keywords 前置过滤（口径对齐 matcher.matchTopic：trim、小写、子串、任一命中） */
function keywordsMatch(lowerTitle: string, keywords: string[] | undefined): boolean {
  if (!keywords || keywords.length === 0) return true // 空 = 不限（契约注释）
  for (const raw of keywords) {
    const kw = raw.trim().toLowerCase()
    if (kw.length === 0) continue
    if (lowerTitle.includes(kw)) return true
  }
  return false
}

/**
 * 逐条评估价格规则，**首条命中即返回**；全不命中（含空列表/全 disabled）→ null。
 *
 * 条件之间 AND；一条规则声明了某条件但标题提取不到对应字段 = 不命中
 * （保守：提取不到不算满足）。任一条件都不声明的 enabled 规则视为全匹配，
 * 命中时 deal 为空对象——是否允许这种「全匹配规则」由配置侧 sanitize 把关。
 * currency 未声明时按 'any' 处理（不过滤币种）。
 */
export function evaluateRules(title: string, rules: PriceRuleConfig[]): RuleMatch | null {
  const deal = extractDeal(title) ?? {}
  const lowerTitle = title.toLowerCase()

  for (const rule of rules) {
    if (!rule.enabled) continue

    if (!keywordsMatch(lowerTitle, rule.keywords)) continue

    if (rule.cycle !== 'any' && deal.cycle !== rule.cycle) continue

    if (rule.maxPrice !== undefined) {
      const p = deal.price
      if (p === undefined) continue // 声明了价格上限但提取不到价格 = 不命中
      const cur = rule.currency ?? 'any'
      if (cur !== 'any' && p.currency !== cur) continue
      if (p.amount > rule.maxPrice) continue
    }

    if (rule.minTrafficGB !== undefined) {
      if (deal.trafficGB === undefined || deal.trafficGB < rule.minTrafficGB) continue
    }

    return { ruleId: rule.id, label: rule.label ?? rule.id, deal }
  }
  return null
}
