/**
 * 统计面板聚合（R7-W3）：computeStats 纯函数的聚合口径。
 *
 * 时间字符串一律用**无时区的本地时刻**（如 '2026-09-18T12:00:00'，ES 规范按
 * 本地时区解析）——正午时刻在任何时区都落在同一天，byDay 的本地日期派生
 * （formatLocalDate）在任意测试机上稳定。
 */
import { describe, expect, it } from 'vitest'
import { computeStats } from './stats'
import type { HitRecord, Topic } from '../../shared/types'

/** 命中记录构造器（可覆盖 topic/匹配/推送各面） */
interface HitSpec {
  id?: string
  sourceId?: string
  matchedBy?: 'literal' | 'semantic' | 'rule'
  keywords?: string[]
  notifiedAt?: string | null
  notifyError?: string | null
  lastActiveAt?: string | null
}

function hit(spec: HitSpec = {}): HitRecord {
  const matchedBy = spec.matchedBy ?? 'literal'
  const topic: Topic = {
    id: spec.id ?? '1',
    sourceId: spec.sourceId ?? 'nodeseek',
    title: `title-${spec.id ?? '1'}`,
    url: 'https://example.com/t/1',
    author: 'someone',
    category: '交易',
    categorySlug: 'trade',
    pinned: false,
    lastActiveAt: spec.lastActiveAt === undefined ? '2026-09-18T12:00:00' : spec.lastActiveAt
  }
  return {
    topic,
    matchedKeywords: spec.keywords ?? (matchedBy === 'literal' ? ['vps'] : []),
    matchedBy,
    semanticReason: matchedBy === 'semantic' ? '与兴趣描述相关' : null,
    notifiedAt: spec.notifiedAt === undefined ? '2026-09-18T12:00:00' : spec.notifiedAt,
    notifyError: spec.notifyError === undefined ? null : spec.notifyError
  }
}

describe('computeStats（R7-W3 统计面板聚合）', () => {
  it('空输入：全零；配置包含词全部列为零命中（保持配置序）', () => {
    const r = computeStats([], { includeKeywords: ['vps', '香港', 'Mega'] })
    expect(r.total).toBe(0)
    expect(r.byDay).toEqual([])
    expect(r.byMatchedBy).toEqual({ literal: 0, semantic: 0, rule: 0 })
    expect(r.bySource).toEqual([])
    expect(r.pushFailRate).toBe(0)
    expect(r.keywordHits).toEqual([
      { keyword: 'vps', count: 0, zeroHit: true },
      { keyword: '香港', count: 0, zeroHit: true },
      { keyword: 'Mega', count: 0, zeroHit: true }
    ])
  })

  it('空配置包含词 + 无命中关键词：keywordHits 为空数组', () => {
    const r = computeStats([], { includeKeywords: [] })
    expect(r.keywordHits).toEqual([])
  })

  it('单日多条：byDay 单条计数 + 三档命中方式分别计数', () => {
    const r = computeStats(
      [
        hit({ id: 'a', matchedBy: 'literal', notifiedAt: '2026-09-18T10:00:00' }),
        hit({ id: 'b', matchedBy: 'literal', notifiedAt: '2026-09-18T11:00:00' }),
        hit({ id: 'c', matchedBy: 'semantic', notifiedAt: '2026-09-18T12:00:00' }),
        hit({ id: 'd', matchedBy: 'rule', notifiedAt: '2026-09-18T13:00:00' })
      ],
      { includeKeywords: [] }
    )
    expect(r.total).toBe(4)
    expect(r.byDay).toEqual([{ date: '2026-09-18', count: 4 }])
    expect(r.byMatchedBy).toEqual({ literal: 2, semantic: 1, rule: 1 })
  })

  it('多日：byDay 新→旧、只含有命中的日期（无命中日不占位）', () => {
    const r = computeStats(
      [
        hit({ id: 'a', notifiedAt: '2026-09-16T12:00:00' }),
        hit({ id: 'b', notifiedAt: '2026-09-18T12:00:00' }),
        hit({ id: 'c', notifiedAt: '2026-09-18T13:00:00' }),
        hit({ id: 'd', notifiedAt: '2026-09-17T12:00:00' })
      ],
      { includeKeywords: [] }
    )
    expect(r.byDay).toEqual([
      { date: '2026-09-18', count: 2 },
      { date: '2026-09-17', count: 1 },
      { date: '2026-09-16', count: 1 }
    ])
  })

  it('byDay 日期派生：notifiedAt 优先；null 回退 lastActiveAt；两者皆无 → 不进 byDay 但计入 total', () => {
    const r = computeStats(
      [
        // 静音命中：notifiedAt=null，用 lastActiveAt 归日
        hit({ id: 'a', notifiedAt: null, lastActiveAt: '2026-09-17T12:00:00' }),
        // notifiedAt 与 lastActiveAt 不同日：以推送时间归日
        hit({ id: 'b', notifiedAt: '2026-09-18T12:00:00', lastActiveAt: '2026-09-10T12:00:00' }),
        // 两者皆无：无可归日期
        hit({ id: 'c', notifiedAt: null, lastActiveAt: null })
      ],
      { includeKeywords: [] }
    )
    expect(r.total).toBe(3)
    expect(r.byDay).toEqual([
      { date: '2026-09-18', count: 1 },
      { date: '2026-09-17', count: 1 }
    ])
  })

  it('bySource：count 降序，并列按 sourceId 字典序（结果确定）', () => {
    const r = computeStats(
      [
        hit({ id: 'a', sourceId: 'nodeseek' }),
        hit({ id: 'b', sourceId: 'rss-b' }),
        hit({ id: 'c', sourceId: 'rss-b' }),
        hit({ id: 'd', sourceId: 'rss-b' }),
        hit({ id: 'e', sourceId: 'v2ex' }),
        hit({ id: 'f', sourceId: 'v2ex' })
      ],
      { includeKeywords: [] }
    )
    expect(r.bySource).toEqual([
      { sourceId: 'rss-b', count: 3 },
      { sourceId: 'v2ex', count: 2 },
      { sourceId: 'nodeseek', count: 1 }
    ])
    // 并列（v2ex 与 rss-b 同为 2）按字典序
    const tie = computeStats(
      [
        hit({ id: 'a', sourceId: 'v2ex' }),
        hit({ id: 'b', sourceId: 'rss-b' })
      ],
      { includeKeywords: [] }
    )
    expect(tie.bySource).toEqual([
      { sourceId: 'rss-b', count: 1 },
      { sourceId: 'v2ex', count: 1 }
    ])
  })

  it('keywordHits：同关键词跨多条累计、count 降序、大小写不敏感归并（展示首见形）', () => {
    const r = computeStats(
      [
        hit({ id: 'a', keywords: ['vps', '香港'] }),
        hit({ id: 'b', keywords: ['VPS'] }),
        hit({ id: 'c', keywords: ['vps'] }),
        hit({ id: 'd', keywords: ['香港'] }),
        hit({ id: 'e', matchedBy: 'semantic' }) // 语义命中无关键词
      ],
      { includeKeywords: [] }
    )
    expect(r.keywordHits).toEqual([
      { keyword: 'vps', count: 3 }, // 'VPS' 归并进首见形 'vps'
      { keyword: '香港', count: 2 }
    ])
  })

  it('keywordHits 并列 count 保持首见序（稳定排序）', () => {
    const r = computeStats(
      [
        hit({ id: 'a', keywords: ['甲'] }),
        hit({ id: 'b', keywords: ['乙'] }),
        hit({ id: 'c', keywords: ['丙'] })
      ],
      { includeKeywords: [] }
    )
    expect(r.keywordHits.map((k) => k.keyword)).toEqual(['甲', '乙', '丙'])
  })

  it('零命中关键词：配置词从未出现 → count=0 + zeroHit 附尾（配置序）；大小写不一致不误报；同形重复只列一次', () => {
    const r = computeStats(
      [
        // 历史记录里是小写 'vps'
        hit({ id: 'a', keywords: ['vps'] })
      ],
      { includeKeywords: ['VPS', '新词', 'vps', '  旧词  '] }
    )
    expect(r.keywordHits).toEqual([
      { keyword: 'vps', count: 1 }, // 配置 'VPS' 与记录 'vps' 视为同一词，不误报零命中
      { keyword: '新词', count: 0, zeroHit: true },
      { keyword: '旧词', count: 0, zeroHit: true } // trim 后展示；'vps' 重复配置不重复列出
    ])
  })

  it('pushFailRate：notifyError 非空占比；null（静音）与空串不算失败；total=0 → 0', () => {
    const r = computeStats(
      [
        hit({ id: 'a', notifiedAt: '2026-09-18T10:00:00', notifyError: 'telegram: timeout' }),
        hit({ id: 'b', notifiedAt: null, notifyError: null }), // 静音：不是失败
        hit({ id: 'c', notifyError: '' }), // 空串：不算失败
        hit({ id: 'd', notifyError: null })
      ],
      { includeKeywords: [] }
    )
    expect(r.total).toBe(4)
    expect(r.pushFailRate).toBe(0.25)
    expect(computeStats([], { includeKeywords: [] }).pushFailRate).toBe(0)
  })
})
