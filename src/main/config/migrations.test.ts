import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG, type ChannelConfig } from '../../shared/types'
import {
  migrateConfigEnvelope,
  MIGRATOR_TARGET_VERSION,
  normalizeLegacyChannels
} from './migrations'

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

/** 合成的默认 telegram 通道形状（R6-W1 读兼容：旧 telegram 凭据 → channels[0]） */
const synthesizedChannel = (botToken: string, chatId: string): ChannelConfig => ({
  id: 'telegram',
  type: 'telegram',
  enabled: true,
  botToken,
  chatId
})

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
    expect((out as { telegram?: unknown }).telegram).toEqual({ botToken: '111:abc', chatId: '-100200' })
    expect(out.notifyEnabled).toBe(false)
    expect(out.launchAtLogin).toBe(true)

    // R6-W1 读兼容：v1 的 telegram 凭据映射为 channels[0]（telegram 键本身保留
    // 到 sanitize 才剔除——迁移链只做映射不做剔除）
    expect(out.channels).toEqual([synthesizedChannel('111:abc', '-100200')])

    // 新增 v2 字段为默认值，v3 不再改动
    expect(out.sources).toEqual([{ id: 'nodeseek', type: 'nodeseek', enabled: true }])
    expect(out.ai).toEqual(DEFAULT_APP_CONFIG.ai)
    expect(out.notify).toEqual(DEFAULT_APP_CONFIG.notify)
    expect(out.routing).toEqual([])
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
    expect((out as { telegram?: unknown }).telegram).toEqual({ botToken: '111:abc', chatId: '-100200' })
    // R6-W1 读兼容：v2 的 telegram 凭据同样映射为 channels[0]
    expect(out.channels).toEqual([synthesizedChannel('111:abc', '-100200')])
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

  it('v3 残缺 config（缺 sources/ai）也透传：兜底留给 merge DEFAULT + sanitize（R6-W1 channels 除外——normalize 保证非空）', () => {
    const out = migrateConfigEnvelope({ schemaVersion: MIGRATOR_TARGET_VERSION, config: { pollIntervalSec: 30 } })
    expect(out).toEqual({
      pollIntervalSec: 30,
      // 无 channels 无旧 telegram → 默认空凭据 telegram 通道（对齐 DEFAULT）
      channels: DEFAULT_APP_CONFIG.channels
    } as ReturnType<typeof migrateConfigEnvelope>)
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

describe('normalizeLegacyChannels（R6-W1 盘上读兼容，DEC-9）', () => {
  /** 旧 v3 盘上 config 形状：telegram 段仍在、无 channels/notify/routing */
  type PreR6Input = Record<string, unknown>

  it('旧 v3 带 telegram（无 channels）→ 合成 channels[0]（id=telegram、enabled、凭据 trim）', () => {
    const legacy: PreR6Input = {
      pollIntervalSec: 45,
      telegram: { botToken: ' 111:abc ', chatId: ' -100200 ' }
    }
    const out = normalizeLegacyChannels(legacy as never)
    expect(out.channels).toEqual([synthesizedChannel('111:abc', '-100200')])
  })

  it('无 telegram 无 channels → 默认空凭据 telegram 通道（对齐 DEFAULT.channels）', () => {
    const out = normalizeLegacyChannels({ pollIntervalSec: 45 } as never)
    expect(out.channels).toEqual(DEFAULT_APP_CONFIG.channels)
    // 旧 telegram 键为空对象（两者都没有的边角）同样落默认
    const out2 = normalizeLegacyChannels({ telegram: {} } as never)
    expect(out2.channels).toEqual(DEFAULT_APP_CONFIG.channels)
  })

  it('已有 channels → 原样保留（忽略残留 telegram 键，双轨否决）', () => {
    const channels: ChannelConfig[] = [
      { id: 'tg-main', type: 'telegram', enabled: true, botToken: 'new', chatId: 'c1' },
      { id: 'my-bark', type: 'bark', enabled: false, deviceKey: 'k' }
    ]
    const out = normalizeLegacyChannels({
      channels,
      telegram: { botToken: 'stale-old-token', chatId: 'old' }
    } as never)
    expect(out.channels).toEqual(channels)
    expect(out.channels[0]).not.toBe(channels[0]) // 项是新建的：不与入参共享引用
  })

  it('任一凭据非空即触发合成（半截凭据也迁——交给 configured 判定拦）', () => {
    const out = normalizeLegacyChannels({ telegram: { botToken: '', chatId: '-100200' } } as never)
    expect(out.channels).toEqual([synthesizedChannel('', '-100200')])
  })

  it('channels 非数组（垃圾）→ 视为缺失，走 telegram/默认路径', () => {
    const out = normalizeLegacyChannels({
      channels: 'garbage',
      telegram: { botToken: 't', chatId: 'c' }
    } as never)
    expect(out.channels).toEqual([synthesizedChannel('t', 'c')])
  })

  it('旧 v3 信封整体迁移：telegram → channels 合成（load 路径端到端）', () => {
    const out = migrateConfigEnvelope({
      schemaVersion: MIGRATOR_TARGET_VERSION,
      config: {
        pollIntervalSec: 45,
        includeKeywords: ['vps'],
        telegram: { botToken: '111:abc', chatId: '-100200' }
      }
    })
    expect(out.channels).toEqual([synthesizedChannel('111:abc', '-100200')])
    expect(out.includeKeywords).toEqual(['vps'])
  })
})
