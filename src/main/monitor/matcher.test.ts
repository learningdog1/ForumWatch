import { describe, expect, it } from 'vitest'
import type { Topic } from '../../shared/types'
import { matchTopic } from './matcher'

function topic(title: string): Topic {
  return {
    id: '1',
    sourceId: '',
    title,
    url: 'https://www.nodeseek.com/post-1-1',
    author: 'someone',
    category: '交易',
    categorySlug: 'trade',
    pinned: false,
    lastActiveAt: null
  }
}

describe('matchTopic', () => {
  it('包含列表为空 → 永不匹配（防通知风暴）', () => {
    const r = matchTopic(topic('Cheap VPS Big Sale'), [], [])
    expect(r.matched).toBe(false)
    expect(r.matchedKeywords).toEqual([])
  })

  it('单包含词命中', () => {
    const r = matchTopic(topic('Cheap VPS Big Sale'), ['vps'], [])
    expect(r.matched).toBe(true)
    expect(r.matchedKeywords).toEqual(['vps'])
  })

  it('多包含词 OR 语义：任一命中即匹配，并记录所有命中的词', () => {
    const r = matchTopic(topic('Cheap VPS Big Sale'), ['nas', 'vps', 'pve'], [])
    expect(r.matched).toBe(true)
    expect(r.matchedKeywords).toEqual(['vps'])
  })

  it('多个包含词同时命中的都记录', () => {
    const r = matchTopic(topic('NAS converted to PVE all-in-one'), ['nas', 'pve'], [])
    expect(r.matched).toBe(true)
    expect(r.matchedKeywords).toEqual(['nas', 'pve'])
  })

  it('未命中任何包含词 → 不匹配', () => {
    const r = matchTopic(topic('Want to buy a second-hand router'), ['vps', 'nas'], [])
    expect(r.matched).toBe(false)
    expect(r.matchedKeywords).toEqual([])
  })

  it('排除词否决：优先级最高，且 matchedKeywords 为空', () => {
    const r = matchTopic(topic('Cheap VPS Big Sale'), ['vps'], ['sale'])
    expect(r.matched).toBe(false)
    expect(r.matchedKeywords).toEqual([])
  })

  it('排除词否决优先于包含词，即使包含词也命中', () => {
    const r = matchTopic(topic('VPS test report'), ['vps'], ['vps'])
    expect(r.matched).toBe(false)
    expect(r.matchedKeywords).toEqual([])
  })

  it('大小写不敏感：VPS vs vps', () => {
    const r1 = matchTopic(topic('cheap vps sale'), ['VPS'], [])
    expect(r1.matched).toBe(true)
    expect(r1.matchedKeywords).toEqual(['VPS']) // 保留关键词原始写法

    const r2 = matchTopic(topic('Cheap VPS Sale'), ['vps'], [])
    expect(r2.matched).toBe(true)
    expect(r2.matchedKeywords).toEqual(['vps'])

    const r3 = matchTopic(topic('Cheap VPS Sale'), [], ['SALE'])
    expect(r3.matched).toBe(false)
  })

  it('关键词两端空格被清理；纯空格关键词等于没有', () => {
    const r = matchTopic(topic('cheap vps sale'), ['  vps  '], ['   '])
    expect(r.matched).toBe(true)
    expect(r.matchedKeywords).toEqual(['vps'])
  })

  it('包含词全为空白 → 视为空列表，永不匹配', () => {
    const r = matchTopic(topic('anything'), ['   ', '\t', ''], [])
    expect(r.matched).toBe(false)
    expect(r.matchedKeywords).toEqual([])
  })

  it('命中词去重：同一词重复出现只记一次（不区分大小写）', () => {
    const r = matchTopic(topic('vps VPS Vps'), ['VPS', 'vps', 'Vps '], [])
    expect(r.matched).toBe(true)
    expect(r.matchedKeywords).toEqual(['VPS'])
  })

  it('中文关键词子串匹配', () => {
    const r = matchTopic(topic('【外包】廉价 VPS 年付'), ['外包', '羊毛'], [])
    expect(r.matched).toBe(true)
    expect(r.matchedKeywords).toEqual(['外包'])
  })

  it('只匹配 title：其他字段命中不算', () => {
    const t = topic('nothing interesting here')
    t.author = 'vps-seller'
    t.category = 'vps'
    const r = matchTopic(t, ['vps'], [])
    expect(r.matched).toBe(false)
  })
})

describe('词条内 && AND 语义（R14）', () => {
  it('AND 词条：全部词命中才算命中', () => {
    const hit = matchTopic(topic('搬瓦工 香港 年付 55 折'), ['搬瓦工 && 香港'], [])
    expect(hit.matched).toBe(true)
    expect(hit.matchedKeywords).toEqual(['搬瓦工 && 香港']) // 原始写法整条记录

    const miss = matchTopic(topic('搬瓦工 美西 年付促销'), ['搬瓦工 && 香港'], [])
    expect(miss.matched).toBe(false)
    expect(miss.matchedKeywords).toEqual([])
  })

  it('AND 词条与其他词条仍是 OR：(A && B) 或 C', () => {
    const viaAnd = matchTopic(topic('Cheap 搬瓦工 香港 deal'), ['搬瓦工 && 香港', '甲骨文'], [])
    expect(viaAnd.matched).toBe(true)
    expect(viaAnd.matchedKeywords).toEqual(['搬瓦工 && 香港'])

    const viaOr = matchTopic(topic('Oracle 甲骨文 free tier'), ['搬瓦工 && 香港', '甲骨文'], [])
    expect(viaOr.matched).toBe(true)
    expect(viaOr.matchedKeywords).toEqual(['甲骨文'])

    const neither = matchTopic(topic('搬瓦工 美西'), ['搬瓦工 && 香港', '甲骨文'], [])
    expect(neither.matched).toBe(false)
  })

  it('AND 词条命中时记录原始写法（大小写保留）', () => {
    const r = matchTopic(topic('BandwagonHost HKG 55 折'), ['Bandwagon && HKG'], [])
    expect(r.matched).toBe(true)
    expect(r.matchedKeywords).toEqual(['Bandwagon && HKG'])
  })

  it('三个及以上词的 AND 词条', () => {
    const r = matchTopic(topic('年付 搬瓦工 香港 55'), ['搬瓦工 && 香港 && 年付'], [])
    expect(r.matched).toBe(true)
    const miss = matchTopic(topic('月付 搬瓦工 香港'), ['搬瓦工 && 香港 && 年付'], [])
    expect(miss.matched).toBe(false)
  })

  it('全角 ＆＆ 与两边带空格的单个 & 同样是 AND 分隔符', () => {
    expect(matchTopic(topic('vps 香港 特价'), ['vps＆＆香港'], []).matched).toBe(true)
    expect(matchTopic(topic('vps 香港 特价'), ['vps & 香港'], []).matched).toBe(true)
    expect(matchTopic(topic('vps 美西 特价'), ['vps & 香港'], []).matched).toBe(false)
  })

  it('单个紧邻 & 不拆分：AT&T 是普通关键词', () => {
    expect(matchTopic(topic('AT&T fiber 优惠'), ['AT&T'], []).matched).toBe(true)
    expect(matchTopic(topic('AT fiber 优惠'), ['AT&T'], []).matched).toBe(false)
  })

  it('宽容形态：词条只剩一个有效词（A && / && A）退化为普通关键词', () => {
    expect(matchTopic(topic('cheap vps sale'), ['vps &&'], []).matched).toBe(true)
    expect(matchTopic(topic('cheap vps sale'), ['&& vps'], []).matched).toBe(true)
    expect(matchTopic(topic('anything'), ['&& &&'], []).matched).toBe(false)
  })

  it('排除词条同样支持 AND：两词都在标题里才否决', () => {
    const vetoed = matchTopic(topic('福利 转发 抽奖 vps'), ['vps'], ['福利 && 转发'])
    expect(vetoed.matched).toBe(false)

    const kept = matchTopic(topic('福利专区 vps 促销'), ['vps'], ['福利 && 转发'])
    expect(kept.matched).toBe(true)
  })
})
