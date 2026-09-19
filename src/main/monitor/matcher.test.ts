import { describe, expect, it } from 'vitest'
import type { Topic } from '../../shared/types'
import { matchTopic } from './matcher'

function topic(title: string): Topic {
  return {
    id: '1',
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
