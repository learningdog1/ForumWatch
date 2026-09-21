/**
 * per-source 匹配覆盖的生效配置解析（R13）：纯函数、零 IO、零 electron 依赖
 * （对齐 matcher.ts / filters.ts / rules.ts 先例，ADR 2）。
 *
 * 单一事实源：引擎 pollSource（engine.ts）与诊断面 matchTest / getStats
 * （desktop/ipc.ts）**共用本实现**——per-source 覆盖若两处各自解析，测试台
 * 会给出与引擎相反的结论、统计会漏报 per-source 关键词的零命中（诊断面漂移）。
 *
 * 字段级回退语义（见 shared/types.ts 的 SourceMatchingConfig 契约）：
 * `cfg.sources.find(s => s.id === sourceId)?.matching` 的对应字段 ?? 全局值。
 * sanitize（store.ts sanitizeSourceMatching）保证：清洗后空列表 / 非法值一律
 * 不落键，因此这里的 undefined 判定与「未覆盖」语义一致；未知 sourceId
 * 同样整体回退全局。
 */
import type { AppConfig, MatchMode } from '../../shared/types'

/** resolveSourceMatching 的返回形状：六个匹配输入的生效值（全部已解析，无可选） */
export interface EffectiveSourceMatching {
  /** 生效包含词（per-source 覆盖 ?? 全局 includeKeywords） */
  includeKeywords: string[]
  /** 生效排除词（per-source 覆盖 ?? 全局 excludeKeywords） */
  excludeKeywords: string[]
  /** 生效匹配模式（per-source 覆盖 ?? 全局 ai.matchMode；Provider 未配置的降级在引擎侧派生） */
  matchMode: MatchMode
  /** 生效兴趣描述（per-source 覆盖 ?? 全局 ai.interests） */
  interests: string[]
  /** 生效语义置信度阈值（per-source 覆盖 ?? 全局 ai.semanticThreshold） */
  semanticThreshold: number
  /** 来源级全匹配（R13-2：仅 per-source 可开，无全局对应项，未覆盖恒 false） */
  matchAll: boolean
}

/**
 * 解析某来源的生效匹配配置：六字段一次读取。
 * 数组按 sanitize 后的引用直接透传（调用方只读不写；引擎与 ipc 均不 mutate）。
 */
export function resolveSourceMatching(cfg: AppConfig, sourceId: string): EffectiveSourceMatching {
  const m = cfg.sources.find((s) => s.id === sourceId)?.matching
  return {
    includeKeywords: m?.includeKeywords ?? cfg.includeKeywords,
    excludeKeywords: m?.excludeKeywords ?? cfg.excludeKeywords,
    matchMode: m?.matchMode ?? cfg.ai.matchMode,
    interests: m?.interests ?? cfg.ai.interests,
    semanticThreshold: m?.semanticThreshold ?? cfg.ai.semanticThreshold,
    matchAll: m?.matchAll === true
  }
}
