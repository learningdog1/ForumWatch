import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG } from '../../shared/types'
import { migrateConfigEnvelope } from './migrations'

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

describe('migrateConfigEnvelope', () => {
  it('v1 → v2：全部 v1 字段原样保留 + sources 默认单项 nodeseek + ai 默认值', () => {
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

    // 新增 v2 字段为默认值
    expect(out.sources).toEqual([{ id: 'nodeseek', type: 'nodeseek', enabled: true }])
    expect(out.ai).toEqual(DEFAULT_APP_CONFIG.ai)
  })

  it('v1 迁移不与入参共享引用（深拷贝）', () => {
    const v1 = v1Config()
    const snapshot = structuredClone(v1)
    const out = migrateConfigEnvelope({ schemaVersion: 1, config: v1 })
    out.includeKeywords.push('leak')
    out.sources[0].enabled = false
    out.ai.provider.apiKey = 'leak'
    expect(v1).toEqual(snapshot)
    expect(out.sources).not.toBe(v1.sources) // v1 本就没有 sources，天然新对象
  })

  it('v2 → 原样透传（不丢字段、不套默认值）', () => {
    const v2 = {
      ...structuredClone(DEFAULT_APP_CONFIG),
      includeKeywords: ['羊毛'],
      ai: {
        provider: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-x', model: 'deepseek-chat' },
        matchMode: 'semantic',
        interests: ['便宜大内存 VPS'],
        dailyReport: { enabled: true, timeHHMM: '09:30' }
      }
    }
    const out = migrateConfigEnvelope({ schemaVersion: 2, config: v2 })
    expect(out).toEqual(v2)
    // 深拷贝：改出参不污染入参
    out.ai.interests.push('leak')
    expect(v2.ai.interests).toEqual(['便宜大内存 VPS'])
  })

  it('v2 残缺 config（缺 sources/ai）也透传：兜底留给 merge DEFAULT + sanitize', () => {
    const out = migrateConfigEnvelope({ schemaVersion: 2, config: { pollIntervalSec: 30 } })
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
      { schemaVersion: 3, config: {} }, // 未知版本
      { schemaVersion: 0, config: {} },
      { schemaVersion: '1', config: {} }, // 版本非数字
      { config: { includeKeywords: [] } } // 缺 schemaVersion
    ]
    for (const g of garbage) {
      expect(() => migrateConfigEnvelope(g)).toThrow(Error)
    }
  })
})
