/**
 * per-source 过滤（R5-P2a，v3 filters 契约的引擎消费方）。
 *
 * 纯函数、零 IO、零 electron 依赖（对齐 matcher.ts / rules.ts 风格，ADR 2）。
 * 语义见 shared/types.ts 的 SourceFilters 契约注释：
 * - includeCategories 非空 = 分类白名单：帖子的分类**显示名或 slug** 命中任一
 *   才算候选（大小写不敏感、字面相等——非子串/正则）；为空/缺失 = 不限分类。
 * - excludeCategories = 分类黑名单：命中任一（显示名或 slug）直接否决，
 *   与 include 同时给出时 exclude 优先（对齐全局 excludeKeywords 一票否决风格）。
 * - blockedAuthors = 作者黑名单：作者名命中任一（大小写不敏感）一票否决。
 *
 * 被 filter 的帖子在 engine 的 unseen 处理链里**入 seen 不推送不评估**
 * （与旧帖阈值同款语义，管线位置：sourceId 盖章之后、id 阈值之前——ultrabrain
 * 裁定的最终管线顺序第 2 步）。
 */
import type { SourceFilters, Topic } from '../../shared/types'

/** 匹配口径：trim + 小写后的字面相等（配置侧 sanitize 已 trim/去空，这里防御性再 trim） */
function norm(s: string): string {
  return s.trim().toLowerCase()
}

/**
 * 列表内是否任一条与 value 命中（trim + 小写相等；空条目跳过）。
 * 空 列表 = 无约束（恒 false，由调用方决定语义）。
 */
function matchesAny(value: string, list: string[] | undefined): boolean {
  if (list === undefined) return false
  const v = norm(value)
  if (v === '') return false // 帖子侧字段缺失（如 RSS 无分类）：不与任何条目相等
  for (const raw of list) {
    const item = norm(raw)
    if (item === '') continue
    if (v === item) return true
  }
  return false
}

/**
 * 帖子的分类（显示名或 slug）是否命中列表中的任一条。
 * 显示名与 slug 是同一分类的两种写法（"交易" / "trade"），任一命中即算。
 */
function categoryMatches(topic: Topic, list: string[] | undefined): boolean {
  return matchesAny(topic.category, list) || matchesAny(topic.categorySlug, list)
}

/**
 * per-source 过滤判定（纯函数）。
 *
 * @param topic 待判帖子（只读 category / categorySlug / author）
 * @param filters 该 source 的过滤配置；undefined / 三列表全空 = 不过滤（恒 true）
 * @returns true = 保留（继续走匹配管线）；false = 滤掉（调用方入 seen、不推送不评估）
 */
export function applySourceFilters(
  topic: Topic,
  filters: SourceFilters | undefined
): boolean {
  if (filters === undefined) return true
  // 分类白名单：非空时必须命中其一（显示名或 slug 双口径）
  if (filters.includeCategories !== undefined && filters.includeCategories.length > 0) {
    if (!categoryMatches(topic, filters.includeCategories)) return false
  }
  // 分类黑名单：任一命中（显示名或 slug）一票否决——与 include 并存时优先
  if (categoryMatches(topic, filters.excludeCategories)) return false
  // 作者黑名单：任一命中一票否决
  if (matchesAny(topic.author, filters.blockedAuthors)) return false
  return true
}
