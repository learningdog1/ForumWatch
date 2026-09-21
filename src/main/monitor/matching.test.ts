/**
 * resolveSourceMatching（R13 per-source 匹配覆盖的生效配置解析）单测：
 * 回退矩阵直测——每字段 覆盖/未覆盖 × 全局有值/空 的组合、未知 sourceId 回退全局。
 * 引擎与 ipc 诊断面共用本函数（防口径分叉），这里锁定字段级回退语义本身。
 */
import { describe, expect, it } from 'vitest'
import { resolveSourceMatching } from './matching'
import { DEFAULT_APP_CONFIG, type AppConfig } from '../../shared/types'

function cfg(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...structuredClone(DEFAULT_APP_CONFIG), ...overrides }
}

describe('resolveSourceMatching（R13 字段级回退矩阵）', () => {
  it('无 matching（旧配置形状）→ 生效值全部等于全局值（matchAll 恒 false）', () => {
    const c = cfg({
      includeKeywords: ['vps'],
      excludeKeywords: ['广告'],
      ai: {
        ...DEFAULT_APP_CONFIG.ai,
        matchMode: 'both',
        interests: ['自建主机'],
        semanticThreshold: 0.3
      }
    })
    const m = resolveSourceMatching(c, 'nodeseek')
    expect(m).toEqual({
      includeKeywords: ['vps'],
      excludeKeywords: ['广告'],
      matchMode: 'both',
      interests: ['自建主机'],
      semanticThreshold: 0.3,
      matchAll: false
    })
  })

  it('未知 sourceId → 整体回退全局（等价未覆盖）', () => {
    const c = cfg({
      sources: [{ id: 'nodeseek', type: 'nodeseek', enabled: true, matching: { matchMode: 'semantic' } }]
    })
    expect(resolveSourceMatching(c, 'not-exist').matchMode).toBe(c.ai.matchMode)
    expect(resolveSourceMatching(c, 'not-exist').includeKeywords).toBe(c.includeKeywords)
  })

  it('每字段独立回退：覆盖了包含词与模式，未覆盖的排除词/兴趣/阈值仍取全局', () => {
    const c = cfg({
      includeKeywords: ['全局词'],
      excludeKeywords: ['全局排除'],
      ai: {
        ...DEFAULT_APP_CONFIG.ai,
        matchMode: 'literal',
        interests: ['全局兴趣'],
        semanticThreshold: 0.5
      },
      sources: [
        {
          id: 'lowendtalk-offers',
          type: 'rss',
          enabled: true,
          url: 'https://lowendtalk.com/discussions/feed.rss',
          matching: { includeKeywords: ['vps'], matchMode: 'semantic' }
        }
      ]
    })
    const m = resolveSourceMatching(c, 'lowendtalk-offers')
    expect(m.includeKeywords).toEqual(['vps']) // 覆盖：替换
    expect(m.matchMode).toBe('semantic') // 覆盖
    expect(m.excludeKeywords).toEqual(['全局排除']) // 未覆盖：全局
    expect(m.interests).toEqual(['全局兴趣']) // 未覆盖：全局
    expect(m.semanticThreshold).toBe(0.5) // 未覆盖：全局
  })

  it('全局为空时未覆盖字段解析为空（语义档空兴趣短路等的输入面）', () => {
    const c = cfg({ sources: [{ id: 'v2ex', type: 'v2ex', enabled: true, matching: { matchMode: 'both' } }] })
    const m = resolveSourceMatching(c, 'v2ex')
    expect(m.includeKeywords).toEqual([])
    expect(m.excludeKeywords).toEqual([])
    expect(m.interests).toEqual([])
    expect(m.semanticThreshold).toBe(0)
    expect(m.matchMode).toBe('both') // 唯一覆盖字段生效
  })

  it('五字段全覆盖：全部生效（替换语义，不合并全局）', () => {
    const c = cfg({
      includeKeywords: ['全局包含'],
      excludeKeywords: ['全局排除'],
      ai: {
        ...DEFAULT_APP_CONFIG.ai,
        matchMode: 'literal',
        interests: ['全局兴趣'],
        semanticThreshold: 0.1
      },
      sources: [
        {
          id: 'rss-x',
          type: 'rss',
          enabled: true,
          url: 'https://example.com/feed',
          matching: {
            includeKeywords: ['dedicated'],
            excludeKeywords: ['giveaway'],
            matchMode: 'both',
            interests: ['独服 deals'],
            semanticThreshold: 0.8
          }
        }
      ]
    })
    expect(resolveSourceMatching(c, 'rss-x')).toEqual({
      includeKeywords: ['dedicated'],
      excludeKeywords: ['giveaway'],
      matchMode: 'both',
      interests: ['独服 deals'],
      semanticThreshold: 0.8,
      matchAll: false
    })
  })

  it('matchAll（R13-2）：仅 true 生效，未设置/false 恒解析为 false（无全局对应项）', () => {
    const base = {
      id: 'lowendtalk-offers',
      type: 'rss' as const,
      enabled: true,
      url: 'https://lowendtalk.com/discussions/feed.rss'
    }
    const c = cfg({
      sources: [
        { ...base, id: 'on', matching: { matchAll: true } },
        { ...base, id: 'off-explicit', matching: { matchAll: false } },
        { ...base, id: 'off-other', matching: { includeKeywords: ['vps'] } }
      ]
    })
    expect(resolveSourceMatching(c, 'on').matchAll).toBe(true)
    expect(resolveSourceMatching(c, 'off-explicit').matchAll).toBe(false)
    expect(resolveSourceMatching(c, 'off-other').matchAll).toBe(false)
    expect(resolveSourceMatching(c, 'not-exist').matchAll).toBe(false)
  })

  it('?? 语义锁定：手工构造的空数组覆盖值生效（空数组不是 nullish）——正常路径由 sanitize 保证空列表不落键', () => {
    // 契约链：sanitizeSourceMatching 清洗后空列表不落键（= 未覆盖 = 回退全局），
    // 因此正常读到的配置里不会出现空数组覆盖；但 resolve 本身用 ?? 判定——
    // 空数组不是 nullish，手工构造（未经 sanitize 的调用方，如测试）会被当
    // "已覆盖"。锁定该行为，防止实现悄悄改成"空则回退"（与 sanitize 职责重叠）。
    const c = cfg({
      includeKeywords: ['全局词'],
      sources: [
        {
          id: 'a',
          type: 'v2ex',
          enabled: true,
          matching: { includeKeywords: [] }
        }
      ] as AppConfig['sources']
    })
    expect(resolveSourceMatching(c, 'a').includeKeywords).toEqual([])
  })
})
