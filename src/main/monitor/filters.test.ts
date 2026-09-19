/**
 * applySourceFilters 单测（R5-P2a per-source 过滤纯函数）。
 * 覆盖：分类白名单（显示名/slug 双口径、大小写）、分类黑名单（exclude 优先）、
 * 作者黑名单（大小写）、无 filters / 空对象全过、空条目与空字段防御。
 */
import { describe, expect, it } from 'vitest'
import type { SourceFilters, Topic } from '../../shared/types'
import { applySourceFilters } from './filters'

function topic(overrides: Partial<Topic> = {}): Topic {
  return {
    id: '1',
    sourceId: '',
    title: 'title',
    url: 'https://example.com/post-1-1',
    author: 'alice',
    category: '交易',
    categorySlug: 'trade',
    pinned: false,
    lastActiveAt: null,
    ...overrides
  }
}

describe('applySourceFilters：无过滤配置', () => {
  it('filters=undefined：恒通过（默认行为不变）', () => {
    expect(applySourceFilters(topic(), undefined)).toBe(true)
    expect(applySourceFilters(topic({ category: '', categorySlug: '', author: '' }), undefined)).toBe(true)
  })

  it('空对象（三列表全空，sanitize 后不会落这种形态，防御）：恒通过', () => {
    expect(applySourceFilters(topic(), {})).toBe(true)
    expect(
      applySourceFilters(topic(), { includeCategories: [], excludeCategories: [], blockedAuthors: [] })
    ).toBe(true)
  })
})

describe('applySourceFilters：分类白名单 includeCategories', () => {
  const filters: SourceFilters = { includeCategories: ['trade', '交易'] }

  it('显示名命中（原文）', () => {
    expect(applySourceFilters(topic(), filters)).toBe(true)
  })

  it('slug 命中（同一分类的另一种写法）', () => {
    expect(applySourceFilters(topic({ category: '瞎写的', categorySlug: 'trade' }), filters)).toBe(true)
  })

  it('大小写不敏感：配置 Trade / 帖子 trade；配置 trade / 帖子 TRADE', () => {
    expect(applySourceFilters(topic({ categorySlug: 'Trade' }), { includeCategories: ['trade'] })).toBe(true)
    expect(applySourceFilters(topic({ category: 'TRADE' }), { includeCategories: ['trade'] })).toBe(true)
  })

  it('分类不在白名单（显示名与 slug 都不命中）→ 滤掉', () => {
    expect(applySourceFilters(topic({ category: '闲聊', categorySlug: 'chat' }), filters)).toBe(false)
  })

  it('帖子无分类（显示名与 slug 均空）：白名单非空时不与任何条目相等 → 滤掉', () => {
    expect(applySourceFilters(topic({ category: '', categorySlug: '' }), filters)).toBe(false)
  })
})

describe('applySourceFilters：分类黑名单 excludeCategories', () => {
  it('显示名命中（大小写不敏感）→ 否决', () => {
    expect(applySourceFilters(topic(), { excludeCategories: ['交易'] })).toBe(false)
    expect(applySourceFilters(topic({ category: '交易' }), { excludeCategories: ['TRADE'] })).toBe(false)
  })

  it('slug 命中 → 否决', () => {
    expect(applySourceFilters(topic({ category: '完全对不上', categorySlug: 'trade' }), {
      excludeCategories: ['trade']
    })).toBe(false)
  })

  it('不命中 → 通过', () => {
    expect(applySourceFilters(topic(), { excludeCategories: ['chat', '闲聊'] })).toBe(true)
  })

  it('exclude 优先于 include：include 命中但 exclude 也命中 → 否决', () => {
    const both: SourceFilters = { includeCategories: ['trade'], excludeCategories: ['trade'] }
    expect(applySourceFilters(topic(), both)).toBe(false)
    // exclude 命中的是 slug、include 命中的是显示名（同一分类）→ 仍否决
    expect(
      applySourceFilters(topic({ category: '交易', categorySlug: 'trade' }), {
        includeCategories: ['交易'],
        excludeCategories: ['TRADE']
      })
    ).toBe(false)
  })
})

describe('applySourceFilters：作者黑名单 blockedAuthors', () => {
  it('命中（大小写不敏感）→ 否决', () => {
    expect(applySourceFilters(topic(), { blockedAuthors: ['alice'] })).toBe(false)
    expect(applySourceFilters(topic({ author: 'Alice' }), { blockedAuthors: ['ALICE'] })).toBe(false)
  })

  it('不命中 → 通过', () => {
    expect(applySourceFilters(topic(), { blockedAuthors: ['bob', 'carol'] })).toBe(true)
  })

  it('与分类白名单叠加：分类过了但作者在黑名单 → 否决', () => {
    expect(
      applySourceFilters(topic(), { includeCategories: ['trade'], blockedAuthors: ['alice'] })
    ).toBe(false)
  })
})

describe('applySourceFilters：条目清洗防御', () => {
  it('配置条目为空白串：跳过不参与匹配（不误伤空字段帖子）', () => {
    // sanitize 已去空，这里防手写配置/旧数据：空串条目不得与空分类相等
    expect(
      applySourceFilters(topic({ category: '', categorySlug: '' }), { excludeCategories: ['  '] })
    ).toBe(true)
    expect(applySourceFilters(topic(), { blockedAuthors: [''] })).toBe(true)
  })

  it('配置条目带空白：trim 后比较', () => {
    expect(applySourceFilters(topic(), { blockedAuthors: ['  alice  '] })).toBe(false)
    expect(applySourceFilters(topic(), { includeCategories: ['  trade '] })).toBe(true)
  })
})
