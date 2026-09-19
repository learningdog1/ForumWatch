/**
 * resolveChannelIds 单测（DEC-7：声明式首条命中）：纯函数直测，零 mock。
 */

import { describe, expect, it } from 'vitest'
import type { RoutingRule, RoutingWhen } from '@shared/types'
import { resolveChannelIds, type RouteContext } from './router'

function rule(id: string, when: RoutingWhen, channelIds: string[]): RoutingRule {
  return { id, when, channelIds }
}

const literalCtx: RouteContext = { sourceId: 'nodeseek', matchedBy: 'literal', ruleId: null }
const semanticCtx: RouteContext = { sourceId: 'nodeseek', matchedBy: 'semantic', ruleId: null }
const ruleCtx: RouteContext = { sourceId: 'nodeseek', matchedBy: 'rule', ruleId: 'cheap-vps' }

describe('resolveChannelIds', () => {
  it('空规则列表 → null（= 走默认全员通道，由调用方解释）', () => {
    expect(resolveChannelIds(literalCtx, [])).toBeNull()
  })

  it('无任何规则命中 → null', () => {
    const rules = [rule('only-v2ex', { sourceId: 'v2ex' }, ['tg'])]
    expect(resolveChannelIds(literalCtx, rules)).toBeNull()
  })

  it('首条命中：多条规则都满足时返回**第一条**的 channelIds（数组顺序即优先级）', () => {
    const rules = [
      rule('r1', { sourceId: 'nodeseek' }, ['a']),
      rule('r2-more-specific', { sourceId: 'nodeseek', matchedBy: ['literal'] }, ['b'])
    ]
    expect(resolveChannelIds(literalCtx, rules)).toEqual(['a'])
  })

  it('命中前的失败规则被跳过，后续规则仍可命中', () => {
    const rules = [
      rule('wrong-source', { sourceId: 'v2ex' }, ['a']),
      rule('ok', { sourceId: 'nodeseek' }, ['b'])
    ]
    expect(resolveChannelIds(literalCtx, rules)).toEqual(['b'])
  })

  it('未声明的条件是通配：只声明 sourceId 的规则对任意 matchedBy/ruleId 的同源帖命中', () => {
    const rules = [rule('src-only', { sourceId: 'nodeseek' }, ['a'])]
    expect(resolveChannelIds(literalCtx, rules)).toEqual(['a'])
    expect(resolveChannelIds(semanticCtx, rules)).toEqual(['a'])
    expect(resolveChannelIds(ruleCtx, rules)).toEqual(['a'])
  })

  it('sourceId 条件：须严格相等，其余来源不命中', () => {
    const rules = [rule('ns', { sourceId: 'nodeseek' }, ['a'])]
    const v2exCtx: RouteContext = { ...literalCtx, sourceId: 'v2ex' }
    expect(resolveChannelIds(v2exCtx, rules)).toBeNull()
  })

  it('matchedBy 条件是数组包含：任一枚举命中即过，不在数组的不命中', () => {
    const rules = [rule('lit-or-sem', { matchedBy: ['literal', 'semantic'] }, ['a'])]
    expect(resolveChannelIds(literalCtx, rules)).toEqual(['a'])
    expect(resolveChannelIds(semanticCtx, rules)).toEqual(['a'])
    expect(resolveChannelIds(ruleCtx, rules)).toBeNull()
  })

  it('三条件 AND：全部满足才命中', () => {
    const rules = [
      rule('all-three', { sourceId: 'nodeseek', matchedBy: ['rule'], ruleId: 'cheap-vps' }, ['a'])
    ]
    expect(resolveChannelIds(ruleCtx, rules)).toEqual(['a'])
  })

  it('三条件 AND：任一条件不满足即整条不命中（sourceId / matchedBy / ruleId 各验一次）', () => {
    const rules = [
      rule(
        'all-three',
        { sourceId: 'nodeseek', matchedBy: ['rule'], ruleId: 'cheap-vps' },
        ['a']
      )
    ]
    const wrongSource: RouteContext = { ...ruleCtx, sourceId: 'v2ex' }
    const wrongBy: RouteContext = { sourceId: 'nodeseek', matchedBy: 'literal', ruleId: 'cheap-vps' }
    const wrongRuleId: RouteContext = { sourceId: 'nodeseek', matchedBy: 'rule', ruleId: 'other' }
    expect(resolveChannelIds(wrongSource, rules)).toBeNull()
    expect(resolveChannelIds(wrongBy, rules)).toBeNull()
    expect(resolveChannelIds(wrongRuleId, rules)).toBeNull()
  })

  it('ruleId 条件只在 matchedBy="rule" 时可命中：literal/semantic 的 ctx.ruleId=null 天然不匹配', () => {
    const rules = [rule('by-rule-id', { ruleId: 'cheap-vps' }, ['a'])]
    expect(resolveChannelIds(literalCtx, rules)).toBeNull()
    expect(resolveChannelIds(semanticCtx, rules)).toBeNull()
    expect(resolveChannelIds(ruleCtx, rules)).toEqual(['a'])
    // rule 命中但规则 id 不同：也不命中
    const otherRuleCtx: RouteContext = { sourceId: 'nodeseek', matchedBy: 'rule', ruleId: 'gpu' }
    expect(resolveChannelIds(otherRuleCtx, rules)).toBeNull()
  })

  it('channelIds 去重且保序：返回新数组，不改入参规则对象', () => {
    const r = rule('dup', { sourceId: 'nodeseek' }, ['b', 'a', 'b', 'c', 'a'])
    const result = resolveChannelIds(literalCtx, [r])
    expect(result).toEqual(['b', 'a', 'c'])
    expect(result).not.toBe(r.channelIds) // 新数组
    expect(r.channelIds).toEqual(['b', 'a', 'b', 'c', 'a']) // 入参原样
  })

  it('防御（未经 sanitize 的空 matchedBy 数组）：键已声明但数组为空 → 永不命中', () => {
    const rules = [rule('empty-by', { matchedBy: [] }, ['a'])]
    expect(resolveChannelIds(literalCtx, rules)).toBeNull()
    expect(resolveChannelIds(semanticCtx, rules)).toBeNull()
    expect(resolveChannelIds(ruleCtx, rules)).toBeNull()
  })
})
