/**
 * 关键词匹配（纯函数、零 IO、零 electron 依赖，ADR 2）。
 *
 * 匹配规则（务必与 README / UI 文案保持一致）：
 * 1. 只对 `topic.title` 做子串匹配；关键词一律 trim、忽略空串。
 * 2. 大小写不敏感（对中文无影响）：比较前统一转小写。
 * 3. **包含词任一命中 → matched**（OR 语义），命中的词记入 `matchedKeywords`
 *    （保留调用方传入的原始写法，重复词只记一次）。
 * 4. **包含列表为空 → 永不匹配**：防止用户没配关键词时全量帖子触发通知风暴。
 * 5. **排除词任一命中 → 直接否决**（优先级最高），此时 `matchedKeywords` 为空。
 */
import type { Topic } from '../../shared/types'

export interface MatchResult {
  matched: boolean
  /** 命中的包含词（原始写法、去重）；未匹配或被排除词否决时为空数组 */
  matchedKeywords: string[]
}

/**
 * 判定一条帖子是否命中用户关键词。
 *
 * @param topic 帖子（只读 title）
 * @param includeKeywords 包含词：任一命中即候选；空数组永不匹配
 * @param excludeKeywords 排除词：任一命中直接否决，优先级高于包含词
 */
export function matchTopic(
  topic: Topic,
  includeKeywords: string[],
  excludeKeywords: string[]
): MatchResult {
  const title = topic.title.toLowerCase()

  for (const raw of excludeKeywords) {
    const kw = raw.trim().toLowerCase()
    if (kw.length === 0) continue
    if (title.includes(kw)) return { matched: false, matchedKeywords: [] }
  }

  if (includeKeywords.length === 0) return { matched: false, matchedKeywords: [] }

  const matchedKeywords: string[] = []
  const seen = new Set<string>()
  for (const raw of includeKeywords) {
    const kw = raw.trim()
    if (kw.length === 0) continue
    const key = kw.toLowerCase()
    if (seen.has(key)) continue // 重复词只记一次
    if (title.includes(key)) {
      seen.add(key)
      matchedKeywords.push(kw)
    }
  }
  return { matched: matchedKeywords.length > 0, matchedKeywords }
}
