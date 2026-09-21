/**
 * 关键词匹配（纯函数、零 IO、零 electron 依赖，ADR 2）。
 *
 * 匹配规则（务必与 README / UI 文案保持一致）：
 * 1. 只对 `topic.title` 做子串匹配；关键词一律 trim、忽略空串。
 * 2. 大小写不敏感（对中文无影响）：比较前统一转小写。
 * 3. **词条之间 OR**：任一词条命中 → matched，命中的词条记入
 *    `matchedKeywords`（保留调用方传入的原始写法，重复词只记一次）。
 * 4. **词条内部 AND（R14）**：一条词条里用 `&&` 连接多个词（如
 *    `搬瓦工 && 香港`，全角 `＆＆` 或两边带空格的单个 `&` / `＆` 亦可）
 *    表示标题**须同时包含**这些词才算该词条命中——「两个或多个关键字
 *    同时命中才推」用这个表达。单个紧邻的 `&`（如 `AT&T`）是普通字符，
 *    不拆分。
 * 5. **包含列表为空 → 永不匹配**：防止用户没配关键词时全量帖子触发通知风暴。
 * 6. **排除词条任一命中 → 直接否决**（优先级最高），AND 语义同上；
 *    此时 `matchedKeywords` 为空。
 */
import type { Topic } from '../../shared/types'

export interface MatchResult {
  matched: boolean
  /** 命中的包含词条（原始写法、去重）；未匹配或被排除词否决时为空数组 */
  matchedKeywords: string[]
}

/**
 * AND 分隔符：两个及以上连续的 `&`/`＆`（可混排），或两边紧邻空白的单个
 * `&`/`＆`（` A & B `）。单个无空格 `&`（`AT&T`）不匹配 → 该词条整体当
 * 普通关键词，避免误拆真实含 & 的词。
 */
const AND_SPLIT = /[&＆]{2,}|\s[&＆]\s/

/**
 * 单条词条（include/exclude 通用）是否命中已小写的标题：按 AND_SPLIT 拆分后
 * 各词 trim、小写、去空，**全部**为子串才算命中；拆完一个有效词都没有 = 不命中。
 * 单词词条退化为普通子串匹配（历史行为不变）。
 */
export function keywordEntryHits(lowerTitle: string, rawEntry: string): boolean {
  const parts = rawEntry
    .split(AND_SPLIT)
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0)
  return parts.length > 0 && parts.every((p) => lowerTitle.includes(p))
}

/**
 * 排除词否决判定（D4：排除词永远先于 AI 一票否决）。
 * 语义模式下 engine 用它单独做否决检查——被否决的帖子直接入 seen，
 * 不进语义评估批。判定口径与 matchTopic 的排除分支一致（trim/小写/子串，
 * 含词条内 `&&` AND 语义）。
 */
export function isExcluded(topic: Topic, excludeKeywords: string[]): boolean {
  const title = topic.title.toLowerCase()
  for (const raw of excludeKeywords) {
    if (keywordEntryHits(title, raw)) return true
  }
  return false
}

/**
 * 判定一条帖子是否命中用户关键词。
 *
 * @param topic 帖子（只读 title）
 * @param includeKeywords 包含词条：词条之间任一命中即候选（词条内 `&&` = 须
 *   全部命中）；空数组永不匹配
 * @param excludeKeywords 排除词条：任一命中直接否决，优先级高于包含词
 */
export function matchTopic(
  topic: Topic,
  includeKeywords: string[],
  excludeKeywords: string[]
): MatchResult {
  if (isExcluded(topic, excludeKeywords)) return { matched: false, matchedKeywords: [] }

  const title = topic.title.toLowerCase()
  if (includeKeywords.length === 0) return { matched: false, matchedKeywords: [] }

  const matchedKeywords: string[] = []
  const seen = new Set<string>()
  for (const raw of includeKeywords) {
    const kw = raw.trim()
    if (kw.length === 0) continue
    const key = kw.toLowerCase()
    if (seen.has(key)) continue // 重复词只记一次
    if (keywordEntryHits(title, kw)) {
      seen.add(key)
      matchedKeywords.push(kw)
    }
  }
  return { matched: matchedKeywords.length > 0, matchedKeywords }
}
