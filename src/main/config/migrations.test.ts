import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG } from '../../shared/types'
import { migrateConfigEnvelope, MIGRATOR_TARGET_VERSION } from './migrations'

/** 一份典型 v1 盘上配置（含 v1 时代的全部字段） */
function v1Config(): Record<string, unknown> {
  return {
    includeKeywords: ['vps', 'nas'],
    excludeKeywords: ['广告'],
    pollIntervalSec: 45,
    proxyUrl: 'http://127.0.0.1:7890',
    proxyScope: 'all',
    telegram: { botToken: '111:abc', chatId: '-100200' },
    notifyEnabled: false,
    launchAtLogin: true
  }
}

/** 一份典型 v2 盘上配置（sources 为 v2 形状：type 恒 'nodeseek'） */
function v2Config(): Record<string, unknown> {
  return {
    includeKeywords: ['vps'],
    excludeKeywords: ['广告'],
    pollIntervalSec: 45,
    proxyUrl: 'http://127.0.0.1:7890',
    proxyScope: 'telegram-only',
    telegram: { botToken: '111:abc', chatId: '-100200' },
    notifyEnabled: true,
    launchAtLogin: false,
    sources: [
      { id: 'nodeseek', type: 'nodeseek', enabled: true },
      { id: 'nodeseek-mirror', type: 'nodeseek', enabled: false }
    ],
    ai: {
      provider: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-x', model: 'deepseek-chat' },
      matchMode: 'semantic',
      interests: ['便宜大内存 VPS'],
      dailyReport: { enabled: true, timeHHMM: '09:30' },
      commentary: { enabled: false }
    }
  }
}

describe('migrateConfigEnvelope', () => {
  it('v1 → v3（链式 v1→v2→v3）：v1 字段原样保留 + sources 默认单项 nodeseek + ai 默认值', () => {
    const v1 = v1Config()
    const out = migrateConfigEnvelope({ schemaVersion: 1, config: v1 })

    // v1 字段逐一保留
    expect(out.includeKeywords).toEqual(['vps', 'nas'])
    expect(out.excludeKeywords).toEqual(['广告'])
    expect(out.pollIntervalSec).toBe(45)
    expect(out.proxyUrl).toBe('http://127.0.0.1:7890')
    expect(out.proxyScope).toBe('all')
    expect(out.telegram).toEqual({ botToken: '111:abc', chatId: '-100200' })
    expect(out.notifyEnabled).toBe(false)
    expect(out.launchAtLogin).toBe(true)

    // 新增 v2 字段为默认值，v3 不再改动
    expect(out.sources).toEqual([{ id: 'nodeseek', type: 'nodeseek', enabled: true }])
    expect(out.ai).toEqual(DEFAULT_APP_CONFIG.ai)
  })

  it('v1 迁移不与入参共享引用（深拷贝）', () => {
    const v1 = v1Config()
    const snapshot = structuredClone(v1)
    const out = migrateConfigEnvelope({ schemaVersion: 1, config: v1 })
    out.includeKeywords.push('leak')
    out.sources[0]!.enabled = false
    out.ai.provider.apiKey = 'leak'
    expect(v1).toEqual(snapshot)
    expect(out.sources).not.toBe(v1.sources) // v1 本就没有 sources，天然新对象
  })

  it('v2 → v3：sources 逐项映射为 NodeseekSourceConfig，其余段原样保留', () => {
    const v2 = v2Config()
    const out = migrateConfigEnvelope({ schemaVersion: 2, config: v2 })

    // 其余段不动（含 ai 全段）
    expect(out.includeKeywords).toEqual(['vps'])
    expect(out.pollIntervalSec).toBe(45)
    expect(out.telegram).toEqual({ botToken: '111:abc', chatId: '-100200' })
    expect(out.ai).toEqual(v2Config().ai)

    // sources 项逐项映射：id/enabled 原样，type 恒 'nodeseek'
    expect(out.sources).toEqual([
      { id: 'nodeseek', type: 'nodeseek', enabled: true },
      { id: 'nodeseek-mirror', type: 'nodeseek', enabled: false }
    ])
  })

  it('v2 → v3 残缺 sources：非数组 / 空数组 / 缺 type / 非对象项 —— 纯变换不校验，残缺透传（sanitize 兜底）', () => {
    // 非数组：整体透传（后续 sanitize 回默认单项）
    const nonArray = migrateConfigEnvelope({
      schemaVersion: 2,
      config: { pollIntervalSec: 30, sources: 'garbage' }
    })
    expect(nonArray.pollIntervalSec).toBe(30)
    expect(nonArray.sources as unknown as string).toBe('garbage')

    // 空数组：透传（sanitize 回默认单项）
    const empty = migrateConfigEnvelope({
      schemaVersion: 2,
      config: { pollIntervalSec: 30, sources: [] }
    })
    expect(empty.pollIntervalSec).toBe(30)
    expect(empty.sources).toEqual([])

    // 缺 type / 非对象项：不裁剪不报错，缺 type 补 'nodeseek'，非对象项原样保留
    const ragged = migrateConfigEnvelope({
      schemaVersion: 2,
      config: {
        sources: [
          { id: 'a', enabled: true }, // 缺 type：v2 语义恒 nodeseek → 补上
          'junk', // 非对象项：原样透传（sanitize 丢弃）
          { id: 'b', type: 'nodeseek', enabled: false },
          null // null 项：原样透传
        ]
      }
    })
    expect(ragged.sources).toEqual([
      { id: 'a', enabled: true, type: 'nodeseek' },
      'junk',
      { id: 'b', type: 'nodeseek', enabled: false },
      null
    ])
  })

  it('v2 → v3 深拷贝：改出参的 sources 项不污染入参', () => {
    const v2 = v2Config()
    const out = migrateConfigEnvelope({ schemaVersion: 2, config: v2 })
    expect(out.sources).not.toBe(v2.sources)
    out.sources[0]!.enabled = false
    expect((v2.sources as { enabled: boolean }[])[0]!.enabled).toBe(true)
  })

  it('v3 → 原样透传（幂等）：不丢字段、不套默认值', () => {
    const v3 = {
      ...structuredClone(DEFAULT_APP_CONFIG),
      includeKeywords: ['羊毛'],
      sources: [
        { id: 'nodeseek', type: 'nodeseek', enabled: true },
        { id: 'v2ex', type: 'v2ex', enabled: false },
        {
          id: 'hn',
          type: 'rss',
          enabled: true,
          url: 'https://hnrss.org/frontpage',
          label: 'HN',
          filters: { includeCategories: ['tech'], blockedAuthors: ['spam'] }
        }
      ],
      ai: {
        provider: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-x', model: 'deepseek-chat' },
        matchMode: 'semantic',
        interests: ['便宜大内存 VPS'],
        dailyReport: { enabled: true, timeHHMM: '09:30' },
        commentary: { enabled: true }
      }
    }
    const out = migrateConfigEnvelope({ schemaVersion: MIGRATOR_TARGET_VERSION, config: v3 })
    expect(out).toEqual(v3)
    // 深拷贝：改出参不污染入参
    out.sources[2]!.filters!.includeCategories!.push('leak')
    expect(v3.sources[2].filters?.includeCategories).toEqual(['tech'])
  })

  it('v3 残缺 config（缺 sources/ai）也透传：兜底留给 merge DEFAULT + sanitize', () => {
    const out = migrateConfigEnvelope({ schemaVersion: MIGRATOR_TARGET_VERSION, config: { pollIntervalSec: 30 } })
    expect(out).toEqual({ pollIntervalSec: 30 } as ReturnType<typeof migrateConfigEnvelope>)
  })

  it('垃圾输入抛 Error：非对象 / 缺 config / 未知 schemaVersion', () => {
    const garbage: unknown[] = [
      null,
      undefined,
      42,
      'json',
      [],
      {},
      { schemaVersion: 1 }, // 缺 config
      { schemaVersion: 1, config: null },
      { schemaVersion: 1, config: 'not-object' },
      { schemaVersion: 4, config: {} }, // 未知版本（合法版本是 1|2|3）
      { schemaVersion: 0, config: {} },
      { schemaVersion: '3', config: {} }, // 版本非数字
      { config: { includeKeywords: [] } } // 缺 schemaVersion
    ]
    for (const g of garbage) {
      expect(() => migrateConfigEnvelope(g)).toThrow(Error)
    }
  })
})
