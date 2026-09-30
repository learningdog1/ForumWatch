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
import { extractDeal, type DealInfo } from '../../shared/deal'
import { keywordEntryHits } from './matcher'

/*
 * 提取器 extractDeal / DealInfo 已下沉 shared/deal.ts（shared 持有、main 再
 * 导出——DISPOSITION_OUTCOMES / MatchStageResult 先例），正则口径与「宁缺勿错」
 * 语义注释随迁；此处再导出使既有引用方（rules.test / testbench /
 * category-stats / category-report）导入路径零改动。
 */
export { extractDeal }
export type { DealInfo }

/** 一条价格规则的命中结果（evaluateRules 首条命中返回） */
export interface RuleMatch {
  ruleId: string
  label: string | null
  /** 命中时的提取结果；规则不含提取类条件时可能是空对象（title 无可提取字段） */
  deal: DealInfo
}

/** keywords 前置过滤（口径对齐 matcher.matchTopic：trim、小写、子串、词条任一命中；词条内 `&&` = 须全部命中） */
function keywordsMatch(lowerTitle: string, keywords: string[] | undefined): boolean {
  if (!keywords || keywords.length === 0) return true // 空 = 不限（契约注释）
  for (const raw of keywords) {
    if (keywordEntryHits(lowerTitle, raw)) return true
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
