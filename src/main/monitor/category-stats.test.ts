/**
 * category-stats 单测（R17）：分类×日矩阵、作者 Top、同帖归并（normalizeTitle）、
 * extractDeal 行情聚合（分位数/样本数/币种分组/流量中位/零样本）、dayOfRecord
 * 归属日口径（优先记录内 day 字段，旧记录回退 firstSeenAt 重算）。
 * 纯函数直测，无 IO、无时钟注入（firstSeenAt 的本地日由本地 Date 构造保证）。
 */
import { describe, expect, it } from 'vitest'
import { buildCategoryStats, dayOfRecord, localDateOfIso } from './category-stats'
import type { TopicRecord } from '../../shared/types'

function rec(
  id: string,
  overrides: Partial<TopicRecord> = {}
): TopicRecord {
  return {
    key: `nodeseek:${id}`,
    sourceId: 'nodeseek',
    topicId: id,
    title: `title-${id}`,
    url: `https://example.com/post-${id}-1`,
    author: 'alice',
    category: '交易',
    categorySlug: 'trade',
    pinned: false,
    lastActiveAt: null,
    firstSeenAt: '2026-09-18T10:00:00',
    ...overrides
  }
}

describe('分类×日矩阵', () => {
  it('按 firstSeenAt 本地日聚合；分类按首见序；帖数计数正确；days 旧→新', () => {
    const stats = buildCategoryStats([
      rec('1', { firstSeenAt: '2026-09-19T09:00:00', category: '交易' }),
      rec('2', { firstSeenAt: '2026-09-18T23:00:00', category: '情报' }),
      rec('3', { firstSeenAt: '2026-09-18T08:00:00', category: '交易' }),
      rec('4', { firstSeenAt: '2026-09-19T10:00:00', category: '交易' })
    ])
    expect(stats.total).toBe(4)
    expect(stats.matrix.days).toEqual(['2026-09-18', '2026-09-19'])
    // 首见序：09-18 先见"交易"（rec3），后见"情报"（rec2）
    expect(stats.matrix.categories).toEqual(['交易', '情报'])
    expect(stats.matrix.counts).toEqual([
      [1, 1], // 09-18：交易 1、情报 1
      [2, 0] // 09-19：交易 2、情报 0
    ])
  })

  it('dayOfRecord：优先记录内 day 字段（写入时固化的本地日），矩阵按它分桶——事后改时区不重算漂移', () => {
    // firstSeenAt 是 UTC 20:00：在东八区按当前时区重算会落到 09-19；day 固化 09-18
    const stats = buildCategoryStats([
      rec('1', { firstSeenAt: '2026-09-18T20:00:00.000Z', day: '2026-09-18' }),
      rec('2', { firstSeenAt: '2026-09-19T20:00:00.000Z', day: '2026-09-19' })
    ])
    expect(stats.matrix.days).toEqual(['2026-09-18', '2026-09-19'])
    expect(stats.matrix.counts).toEqual([[1], [1]])
  })

  it('dayOfRecord：旧记录无 day 字段回退 firstSeenAt 当前时区重算；day 字段形状损坏同样回退', () => {
    // 无 day（v0.8.0 前期行）：与 localDateOfIso 逐字节一致（向后兼容）
    expect(dayOfRecord(rec('1', { firstSeenAt: '2026-09-18T10:00:00' }))).toBe(
      localDateOfIso('2026-09-18T10:00:00')
    )
    // 损坏形状（非日期键）：不当权威值用，回退重算
    expect(
      dayOfRecord(rec('2', { firstSeenAt: '2026-09-18T10:00:00', day: 'garbage' }))
    ).toBe(localDateOfIso('2026-09-18T10:00:00'))
    expect(dayOfRecord(rec('3', { firstSeenAt: '2026-09-18T10:00:00', day: '' }))).toBe(
      localDateOfIso('2026-09-18T10:00:00')
    )
  })

  it('分类空串归「未分类」（来源解析失败的观测面）', () => {
    const stats = buildCategoryStats([
      rec('1', { category: '', categorySlug: '' }),
      rec('2', { category: '交易' })
    ])
    expect(stats.matrix.categories).toEqual(['未分类', '交易'])
    expect(stats.matrix.counts).toEqual([[1, 1]])
  })

  it('空输入：零维矩阵、空榜单', () => {
    const stats = buildCategoryStats([])
    expect(stats.total).toBe(0)
    expect(stats.matrix).toEqual({ days: [], categories: [], counts: [] })
    expect(stats.topAuthors).toEqual([])
    expect(stats.repeatedTitles).toEqual([])
    expect(stats.dealGroups).toEqual([])
  })
})

describe('作者 Top', () => {
  it('计数降序、并列稳定；默认上限 10；空作者归「（匿名）」', () => {
    const records: TopicRecord[] = [
      ...Array.from({ length: 5 }, (_, i) => rec(String(i), { author: 'bob' })),
      ...Array.from({ length: 3 }, (_, i) => rec(`1${i}`, { author: 'alice' })),
      rec('20', { author: 'carol' }),
      rec('21', { author: '' })
    ]
    const stats = buildCategoryStats(records)
    expect(stats.topAuthors.map((a) => a.author)).toEqual(['bob', 'alice', 'carol', '（匿名）'])
    expect(stats.topAuthors[0]).toEqual({ author: 'bob', count: 5 })
    const capped = buildCategoryStats(
      Array.from({ length: 15 }, (_, i) => rec(String(i), { author: `u${i}` })),
      { topAuthorLimit: 3 }
    )
    expect(capped.topAuthors).toHaveLength(3)
  })
})

describe('同帖归并（normalizeTitle 归一后出现 ≥2 次）', () => {
  it('装饰级变体归并为同帖；计数降序；单次出现的标题不进榜', () => {
    const stats = buildCategoryStats([
      rec('1', { title: '99元/年 便宜VPS' }),
      // 全角斜杠/全角字母/装饰叹号 → normalizeTitle 归一后同为 "99元 年 便宜vps"
      rec('2', { title: '99元／年 便宜ｖｐｓ！' }),
      rec('3', { title: '免费机器测评' }),
      rec('4', { title: '免费机器测评（补充）' }) // 归一后含"补充"→不同串，不归并
    ])
    expect(stats.repeatedTitles).toHaveLength(1)
    expect(stats.repeatedTitles[0]!.count).toBe(2)
    expect(stats.repeatedTitles[0]!.title).toBe('99元/年 便宜VPS') // 组内首个原始标题
  })
})

describe('extractDeal 行情聚合', () => {
  it('按 cycle×currency 分组：样本数/最低/P25/中位/P75/最高 + 组内流量中位', () => {
    const yearlyCny = ['年付 ¥100 500G', '年付 ¥200 1T', '年付 ¥300', '年付 ¥400 200G']
    const stats = buildCategoryStats(
      yearlyCny.map((title, i) => rec(String(i), { title }))
    )
    expect(stats.dealGroups).toHaveLength(1)
    const g = stats.dealGroups[0]!
    expect(g.group).toBe('yearly×CNY')
    expect(g.samples).toBe(4)
    expect(g.min).toBe(100)
    expect(g.max).toBe(400)
    expect(g.median).toBe(250)
    expect(g.p25).toBe(175) // 线性插值：(4-1)*0.25=0.75 → 100+(200-100)*0.75
    expect(g.p75).toBe(325)
    expect(g.trafficMedianGB).toBe(500) // 流量样本 [500,1024,200] → 中位 500
  })

  it('流量中位取组内有流量样本的中位数；组内无流量 → null', () => {
    // 有流量样本：500、1024（1T）、200 → 排序 [200,500,1024] 中位 500
    const withTraffic = buildCategoryStats(
      ['年付 ¥100 500G', '年付 ¥200 1T', '年付 ¥300 200G'].map((title, i) =>
        rec(String(i), { title })
      )
    )
    expect(withTraffic.dealGroups[0]!.trafficMedianGB).toBe(500)
    // 无流量样本
    const noTraffic = buildCategoryStats(
      ['年付 ¥100', '年付 ¥300'].map((title, i) => rec(String(i), { title }))
    )
    expect(noTraffic.dealGroups[0]!.trafficMedianGB).toBeNull()
  })

  it('币种/周期独立分组：CNY/USD、yearly/monthly、无周期归 any；样本数降序', () => {
    const stats = buildCategoryStats([
      rec('1', { title: '年付 ¥100' }),
      rec('2', { title: '年付 ¥120' }),
      rec('3', { title: '$10/yr 优惠' }),
      rec('4', { title: '月付 ¥30' })
    ])
    expect(stats.dealGroups.map((g) => g.group)).toEqual(['yearly×CNY', 'monthly×CNY', 'yearly×USD'])
    expect(stats.dealGroups[0]!.samples).toBe(2)
    expect(stats.dealGroups[2]!.currency).toBe('USD')
    // 无周期但有价格 → any
    const anyCycle = buildCategoryStats([rec('1', { title: '特价 ¥50 出' })])
    expect(anyCycle.dealGroups[0]!.group).toBe('any×CNY')
  })

  it('零样本：没有可解析价格的标题 → dealGroups 为空（上层写「未解析出结构化价格」）', () => {
    const stats = buildCategoryStats([
      rec('1', { title: '纯讨论帖无价格' }),
      rec('2', { title: '年付 88' }) // 裸数字无币种标记，rules 宁缺勿错不提取
    ])
    expect(stats.dealGroups).toEqual([])
  })
})
