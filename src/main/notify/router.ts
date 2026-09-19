/**
 * 通道路由器（第六轮 R6-W3；DEC-7：声明式首条命中）。
 *
 * 纯函数、零依赖（config/网络/时钟都不感知）：给定一次命中的路由上下文与当前
 * 生效的 RoutingRule[]，决定这次命中该发往哪些通道 id。
 *
 * 语义（与 config/store.ts sanitizeRouting 的清洗结果配套）：
 * - 逐条**按序**评估，声明的条件之间 AND：
 *   - `when.sourceId` 存在 → 须与 ctx.sourceId 严格相等；
 *   - `when.matchedBy` 存在 → 须包含 ctx.matchedBy（数组是"枚举白名单"不是单值；
 *     键缺失 = 不限；空数组在 sanitize 不会落键，但纯函数按字面语义处理为
 *     "什么方式都不匹配"——永不命中）；
 *   - `when.ruleId` 存在 → 须与 ctx.ruleId 严格相等。注意 ctx.ruleId 只在
 *     matchedBy==='rule' 时非 null（literal/semantic 命中的帖子 ruleId 恒 null，
 *     与 engine.processHit 的传参约定一致），而 when.ruleId 是非空字符串——
 *     严格相等天然保证**带 ruleId 条件的规则对 literal/semantic 命中永不匹配**，
 *     无需额外分支。
 * - **首条命中**即返回该规则的 channelIds（顺序保留、去重、返回新数组——不动
 *   入参规则对象）。声明式路由不做优先级加权，数组顺序即优先级（sanitize 按用户
 *   给出的顺序重建，UI 侧拖动排序 = 改数组顺序）。
 * - 无任何规则命中（含空规则列表）→ 返回 **null**。调用方（composite）语义：
 *   null = 走默认 = 全部就绪通道（不路由，R6 之前的全员广播行为）。
 *
 * sanitize 已保证：when 至少声明一个条件（全空整条弃）、channelIds 非空且全部
 * 悬挂引用已剔除；但本函数对未清洗输入（测试直构造）同样按上述字面语义工作。
 */

import type { RoutingRule, RoutingWhen } from '@shared/types'

/**
 * 一次命中的路由上下文（composite 从 HitMessageInput 推导，见 composite.ts
 * 的 routeContextOf）：sourceId 来自 topic，matchedBy/ruleId 来自命中方式。
 */
export interface RouteContext {
  /** 帖子来源 id（= topic.sourceId） */
  sourceId: string
  /** 命中方式：literal / semantic / rule */
  matchedBy: 'literal' | 'semantic' | 'rule'
  /** 命中的价格规则 id；literal/semantic 命中恒为 null */
  ruleId: string | null
}

/**
 * 解析一次命中该发往的通道 id 列表。
 *
 * @returns 首条命中规则的 channelIds（去重、新数组）；无命中 → null（= 默认
 * 全体通道，由调用方解释）
 */
export function resolveChannelIds(ctx: RouteContext, rules: RoutingRule[]): string[] | null {
  for (const rule of rules) {
    if (whenMatches(ctx, rule.when)) {
      return dedupeChannelIds(rule.channelIds)
    }
  }
  return null
}

/** 单条 when 的 AND 匹配：未声明的条件是通配，声明的逐一核对 */
function whenMatches(ctx: RouteContext, when: RoutingWhen): boolean {
  if (when.sourceId !== undefined && when.sourceId !== ctx.sourceId) return false
  if (when.matchedBy !== undefined && !when.matchedBy.includes(ctx.matchedBy)) return false
  // 严格相等蕴含"ruleId 条件只在 matchedBy==='rule' 时可命中"：
  // literal/semantic 的 ctx.ruleId 是 null，非空字符串的 when.ruleId 永不相等
  if (when.ruleId !== undefined && when.ruleId !== ctx.ruleId) return false
  return true
}

/** 顺序保留去重（返回新数组，不改入参规则） */
function dedupeChannelIds(ids: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}
