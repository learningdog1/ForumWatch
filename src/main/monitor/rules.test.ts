import { describe, expect, it } from 'vitest'
import type { PriceRuleConfig } from '../../shared/types'
import { evaluateRules, extractDeal } from './rules'

/** 构造一条规则：默认 enabled + cycle 'any'（其余条件不声明），按用例覆盖 */
function rule(over: Partial<PriceRuleConfig> & { id: string }): PriceRuleConfig {
  return { enabled: true, cycle: 'any', ...over }
}

describe('extractDeal', () => {
  it('[年付] ¥99 的小鸡：周期 + CNY 价格独立提取', () => {
    expect(extractDeal('[年付] ¥99 的小鸡')).toEqual({
      cycle: 'yearly',
      price: { amount: 99, currency: 'CNY' }
    })
  })

  it('oracle 白嫖：什么字段都提取不到 → null', () => {
    expect(extractDeal('oracle 白嫖')).toBeNull()
  })

  it('$9.99/yr VPS：USD 小数价格 + yr 年付', () => {
    expect(extractDeal('$9.99/yr VPS')).toEqual({
      cycle: 'yearly',
      price: { amount: 9.99, currency: 'USD' }
    })
  })

  it('月付39元 香港 2C2G：2C2G 是配置不是流量，不得误提取', () => {
    const deal = extractDeal('月付39元 香港 2C2G')
    expect(deal).toEqual({
      cycle: 'monthly',
      price: { amount: 39, currency: 'CNY' }
    })
    expect(deal?.trafficGB).toBeUndefined()
  })

  it('500G流量 月付$5：三字段齐提', () => {
    expect(extractDeal('500G流量 月付$5')).toEqual({
      cycle: 'monthly',
      price: { amount: 5, currency: 'USD' },
      trafficGB: 500
    })
  })

  it('0.5T 大流量：T 级换算 GB（×1024）', () => {
    expect(extractDeal('0.5T 大流量')).toEqual({ trafficGB: 512 })
  })

  it('1024M：M 级换算 GB（÷1024）= 1', () => {
    expect(extractDeal('1024M')).toEqual({ trafficGB: 1 })
  })

  it('512M：M 级换算保留一位小数 = 0.5', () => {
    expect(extractDeal('512M')).toEqual({ trafficGB: 0.5 })
  })

  it('1TB：不带流量字样也识别', () => {
    expect(extractDeal('1TB')).toEqual({ trafficGB: 1024 })
  })

  it('1,299元/年：千分位数字 + /年 周期', () => {
    expect(extractDeal('1,299元/年')).toEqual({
      cycle: 'yearly',
      price: { amount: 1299, currency: 'CNY' }
    })
  })

  it('9.9刀每月：刀 = USD，每月 = monthly', () => {
    expect(extractDeal('9.9刀每月')).toEqual({
      cycle: 'monthly',
      price: { amount: 9.9, currency: 'USD' }
    })
  })

  it('半年付 50：周期不识别（宁缺勿错），裸 50 无币种标记不算价格 → null', () => {
    expect(extractDeal('半年付 50')).toBeNull()
  })

  it('双月付 15元：价格照提，周期不识别', () => {
    expect(extractDeal('双月付 15元')).toEqual({ price: { amount: 15, currency: 'CNY' } })
  })

  it('季付 30元：同上，季付本轮不识别', () => {
    expect(extractDeal('季付 30元')).toEqual({ price: { amount: 30, currency: 'CNY' } })
  })

  it('多价格标题取首个（¥99 在 $20 之前）', () => {
    const deal = extractDeal('对比：甲 ¥99/年 vs 乙 $20/年')
    expect(deal?.price).toEqual({ amount: 99, currency: 'CNY' })
    expect(deal?.cycle).toBe('yearly')
  })

  it('不限流量 年付88：不限流量不设 trafficGB（无约束≠Infinity），裸 88 不算价格', () => {
    const deal = extractDeal('不限流量 年付88')
    expect(deal).toEqual({ cycle: 'yearly' })
    expect(deal?.trafficGB).toBeUndefined()
    expect(deal?.price).toBeUndefined()
  })

  it('unlimited traffic：视为无约束 → null', () => {
    expect(extractDeal('unlimited traffic')).toBeNull()
  })

  it('USD 20：前缀写法', () => {
    expect(extractDeal('USD 20')).toEqual({ price: { amount: 20, currency: 'USD' } })
  })

  it('99 块：块 = CNY，数字与单位间可有空格', () => {
    expect(extractDeal('99 块')).toEqual({ price: { amount: 99, currency: 'CNY' } })
  })

  it('￥88 与 ¥ 88：全角/半角人民币符号都识别', () => {
    expect(extractDeal('￥88')).toEqual({ price: { amount: 88, currency: 'CNY' } })
    expect(extractDeal('¥ 88 包年')).toEqual({
      cycle: 'yearly',
      price: { amount: 88, currency: 'CNY' }
    })
  })

  it('15元/月：/月 周期与价格分离提取', () => {
    expect(extractDeal('15元/月')).toEqual({
      cycle: 'monthly',
      price: { amount: 15, currency: 'CNY' }
    })
  })

  it('500Mbps 大带宽 月付5元：带宽速率不是流量，不得误提取', () => {
    const deal = extractDeal('500Mbps 大带宽 月付5元')
    expect(deal).toEqual({
      cycle: 'monthly',
      price: { amount: 5, currency: 'CNY' }
    })
    expect(deal?.trafficGB).toBeUndefined()
  })

  it('2023年折腾记录：年份不是年付周期', () => {
    expect(extractDeal('2023年折腾记录')).toBeNull()
  })

  it('semi-annual backup：semi-annual 是半年付，不识别为 yearly', () => {
    expect(extractDeal('semi-annual backup')).toBeNull()
  })

  it('3年付 150刀：N年付 = yearly，刀 = USD', () => {
    expect(extractDeal('3年付 150刀')).toEqual({
      cycle: 'yearly',
      price: { amount: 150, currency: 'USD' }
    })
  })

  it('两年一付 240元：中文数字年 = yearly', () => {
    expect(extractDeal('两年一付 240元')).toEqual({
      cycle: 'yearly',
      price: { amount: 240, currency: 'CNY' }
    })
  })

  it('1099元素设计素材：元后接素不算价格', () => {
    expect(extractDeal('1099元素设计素材')).toBeNull()
  })

  it('1月付 8元：N月付 = monthly；裸「一月」不识别（一月份歧义）', () => {
    expect(extractDeal('1月付 8元')).toEqual({
      cycle: 'monthly',
      price: { amount: 8, currency: 'CNY' }
    })
    expect(extractDeal('一月总结')).toBeNull()
  })

  it('$5/mo VPS：mo 独立词 = monthly', () => {
    expect(extractDeal('$5/mo VPS')).toEqual({
      cycle: 'monthly',
      price: { amount: 5, currency: 'USD' }
    })
  })

  it('monitor 便宜货：mo 不是独立词，不算月付', () => {
    expect(extractDeal('monitor 便宜货')).toBeNull()
  })
})

describe('evaluateRules', () => {
  it('空规则列表 → null', () => {
    expect(evaluateRules('[年付] ¥99 的小鸡', [])).toBeNull()
  })

  it('disabled 规则跳过（即使条件满足）', () => {
    const r = rule({ id: 'cheap-yearly', enabled: false, cycle: 'yearly' })
    expect(evaluateRules('[年付] ¥99 的小鸡', [r])).toBeNull()
  })

  it('disabled 在前、enabled 在后 → 取后者', () => {
    const off = rule({ id: 'off', enabled: false, cycle: 'yearly' })
    const on = rule({ id: 'on', cycle: 'monthly' })
    expect(evaluateRules('月付39元 香港 2C2G', [off, on])?.ruleId).toBe('on')
  })

  it('cycle 单条件：yearly 规则命中年付标题，返回完整 RuleMatch', () => {
    const r = rule({ id: 'cheap-yearly', label: '百元内年付', cycle: 'yearly' })
    expect(evaluateRules('[年付] ¥99 的小鸡', [r])).toEqual({
      ruleId: 'cheap-yearly',
      label: '百元内年付',
      deal: { cycle: 'yearly', price: { amount: 99, currency: 'CNY' } }
    })
  })

  it('cycle 不匹配：yearly 规则遇月付标题 → null', () => {
    const r = rule({ id: 'cheap-yearly', cycle: 'yearly' })
    expect(evaluateRules('月付39元 香港 2C2G', [r])).toBeNull()
  })

  it("cycle 'any' 不过滤周期", () => {
    const r = rule({ id: 'any-cycle', cycle: 'any' })
    expect(evaluateRules('月付39元 香港 2C2G', [r])?.ruleId).toBe('any-cycle')
    expect(evaluateRules('[年付] ¥99 的小鸡', [r])?.ruleId).toBe('any-cycle')
  })

  it('maxPrice 命中：金额等于上限也算（≤）', () => {
    const r = rule({ id: 'under-100', maxPrice: 99, currency: 'CNY' })
    expect(evaluateRules('[年付] ¥99 的小鸡', [r])?.ruleId).toBe('under-100')
  })

  it('maxPrice 超上限 → 不命中', () => {
    const r = rule({ id: 'under-50', maxPrice: 50, currency: 'CNY' })
    expect(evaluateRules('[年付] ¥99 的小鸡', [r])).toBeNull()
  })

  it('币种过滤：maxPrice+CNY 时 USD 价不命中', () => {
    const r = rule({ id: 'cny-only', maxPrice: 100, currency: 'CNY' })
    expect(evaluateRules('$9.99/yr VPS', [r])).toBeNull()
  })

  it('currency 未声明按 any：USD 价同样命中', () => {
    const r = rule({ id: 'any-cur', maxPrice: 100 })
    const m = evaluateRules('$9.99/yr VPS', [r])
    expect(m?.ruleId).toBe('any-cur')
    expect(m?.deal.price).toEqual({ amount: 9.99, currency: 'USD' })
  })

  it("currency 'any'：CNY 价命中 USD 阈值规则（按金额数值比）", () => {
    const r = rule({ id: 'any-cur', maxPrice: 700, currency: 'any' })
    expect(evaluateRules('1,299元/年', [r])).toBeNull()
    expect(evaluateRules('¥ 88 包年', [r])?.ruleId).toBe('any-cur')
  })

  it('声明了 maxPrice 但标题提取不到价格 → 不命中（提取不到不算满足）', () => {
    const r = rule({ id: 'under-100', maxPrice: 100, currency: 'CNY' })
    expect(evaluateRules('oracle 白嫖', [r])).toBeNull()
    expect(evaluateRules('不限流量 年付88', [r])).toBeNull() // 裸 88 无币种标记，不算价格
  })

  it('minTrafficGB 命中：等于下限也算（≥）', () => {
    const r = rule({ id: 'big-traffic', minTrafficGB: 500 })
    expect(evaluateRules('500G流量 月付$5', [r])?.ruleId).toBe('big-traffic')
  })

  it('minTrafficGB 不满足 → 不命中', () => {
    const r = rule({ id: 't-level', minTrafficGB: 1024 })
    expect(evaluateRules('500G流量 月付$5', [r])).toBeNull()
  })

  it('声明了 minTrafficGB 但标题提取不到流量 → 不命中（不限流量=无约束≠满足）', () => {
    const r = rule({ id: 'big-traffic', minTrafficGB: 100 })
    expect(evaluateRules('不限流量 年付88', [r])).toBeNull()
  })

  it('keywords 前置：标题不含任何关键词 → 跳过该规则', () => {
    const r = rule({ id: 'kw', keywords: ['香港', '日本'] })
    expect(evaluateRules('月付39元 洛杉矶', [r])).toBeNull()
  })

  it('keywords 任一命中即通过，且大小写不敏感（对齐 matcher 口径）', () => {
    const r = rule({ id: 'kw', keywords: ['HK', 'vps'] })
    expect(evaluateRules('月付39元 香港 2C2G', [r])).toBeNull() // 「香港」≠「HK」
    expect(evaluateRules('cheap VPS 月付39元', [r])?.ruleId).toBe('kw')
  })

  it('keywords 为空数组 = 不限', () => {
    const r = rule({ id: 'no-kw', keywords: [] })
    expect(evaluateRules('随便什么标题', [r])?.ruleId).toBe('no-kw')
  })

  it('AND 组合：周期+价格+币种+流量+关键词全满足才命中', () => {
    const r = rule({
      id: 'hk-monthly-cheap-big',
      cycle: 'monthly',
      maxPrice: 6,
      currency: 'USD',
      minTrafficGB: 500,
      keywords: ['香港', 'HK']
    })
    expect(evaluateRules('500G流量 月付$5 香港机房', [r])?.ruleId).toBe('hk-monthly-cheap-big')
    // 逐个破坏每个条件，均不命中
    expect(evaluateRules('500G流量 年付$5 香港机房', [r])).toBeNull() // cycle 不匹配
    expect(evaluateRules('500G流量 月付$15 香港机房', [r])).toBeNull() // 超价
    expect(evaluateRules('500G流量 月付¥5 香港机房', [r])).toBeNull() // 币种不符
    expect(evaluateRules('200G流量 月付$5 香港机房', [r])).toBeNull() // 流量不足
    expect(evaluateRules('500G流量 月付$5 洛杉矶', [r])).toBeNull() // 关键词不命中
  })

  it('首条命中优先：两条都满足时返回数组中靠前的一条', () => {
    const first = rule({ id: 'first', cycle: 'yearly' })
    const second = rule({ id: 'second', cycle: 'yearly' })
    expect(evaluateRules('[年付] ¥99 的小鸡', [first, second])?.ruleId).toBe('first')
  })

  it('首条不满足时落到后面的规则', () => {
    const strict = rule({ id: 'strict', cycle: 'yearly', maxPrice: 50, currency: 'CNY' })
    const loose = rule({ id: 'loose', cycle: 'yearly' })
    expect(evaluateRules('[年付] ¥99 的小鸡', [strict, loose])?.ruleId).toBe('loose')
  })

  it('label 回退 ruleId（未配置 label）', () => {
    const r = rule({ id: 'no-label', cycle: 'monthly' })
    expect(evaluateRules('月付39元 香港 2C2G', [r])?.label).toBe('no-label')
  })

  it('deal 为 null 时：纯 keywords / cycle-any 规则仍可命中，deal 为空对象', () => {
    const r = rule({ id: 'oracle-watch', keywords: ['oracle'] })
    expect(evaluateRules('oracle 白嫖', [r])).toEqual({
      ruleId: 'oracle-watch',
      label: 'oracle-watch',
      deal: {}
    })
  })
})
