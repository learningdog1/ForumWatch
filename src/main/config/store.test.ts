import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_APP_CONFIG,
  type AppConfig,
  type ChannelConfig,
  type SourceConfig,
  type TelegramChannelConfig
} from '../../shared/types'
import { SECRET_MARKER, type SecretBox } from './secrets'
import { ConfigStore, sanitizeConfig } from './store'

let dir: string
let configPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rss-monitor-config-'))
  configPath = join(dir, 'config.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** 构造一份完整配置（覆盖默认值） */
function cfg(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...structuredClone(DEFAULT_APP_CONFIG), ...overrides }
}

/** 断言用：把 channels[0] 窄化为 telegram 通道（测试夹具首项恒为 telegram 型） */
function tg0(channels: ChannelConfig[]): TelegramChannelConfig {
  return channels[0] as TelegramChannelConfig
}

describe('sanitizeConfig', () => {
  it('关键词数组：trim、去空、去重（不区分大小写保留首现写法）', () => {
    const out = sanitizeConfig(
      cfg({ includeKeywords: ['  vps ', 'VPS', 'vps', '', '   ', '\tnas\t', 'nas'] })
    )
    expect(out.includeKeywords).toEqual(['vps', 'nas'])
  })

  it('pollIntervalSec：非法回 60，低于 15 钳到 15，正常值原样保留', () => {
    expect(sanitizeConfig(cfg({ pollIntervalSec: 5 })).pollIntervalSec).toBe(15)
    expect(sanitizeConfig(cfg({ pollIntervalSec: 14.9 })).pollIntervalSec).toBe(15)
    expect(sanitizeConfig(cfg({ pollIntervalSec: 15 })).pollIntervalSec).toBe(15)
    expect(sanitizeConfig(cfg({ pollIntervalSec: 120 })).pollIntervalSec).toBe(120)
    expect(sanitizeConfig(cfg({ pollIntervalSec: Number.NaN })).pollIntervalSec).toBe(60)
    expect(sanitizeConfig(cfg({ pollIntervalSec: Number.POSITIVE_INFINITY })).pollIntervalSec).toBe(60)
    expect(
      sanitizeConfig(cfg({ pollIntervalSec: '30' as unknown as number })).pollIntervalSec
    ).toBe(60)
  })

  it('proxyUrl：trim；非法 scheme 置空；合法前缀保留（scheme 大小写不敏感）', () => {
    expect(sanitizeConfig(cfg({ proxyUrl: '  http://127.0.0.1:7890  ' })).proxyUrl).toBe(
      'http://127.0.0.1:7890'
    )
    expect(sanitizeConfig(cfg({ proxyUrl: 'socks5://127.0.0.1:1080' })).proxyUrl).toBe(
      'socks5://127.0.0.1:1080'
    )
    // socks5h（远端 DNS）与 http.ts 的 dispatcher 支持面一致，不得被清空
    expect(sanitizeConfig(cfg({ proxyUrl: 'socks5h://host:1080' })).proxyUrl).toBe(
      'socks5h://host:1080'
    )
    expect(sanitizeConfig(cfg({ proxyUrl: 'SOCKS5H://host:1080' })).proxyUrl).toBe(
      'SOCKS5H://host:1080'
    )
    expect(sanitizeConfig(cfg({ proxyUrl: 'HTTPS://example.com:8443' })).proxyUrl).toBe(
      'HTTPS://example.com:8443'
    )
    expect(sanitizeConfig(cfg({ proxyUrl: 'ftp://nope' })).proxyUrl).toBe('')
    expect(sanitizeConfig(cfg({ proxyUrl: '随便填的' })).proxyUrl).toBe('')
    expect(sanitizeConfig(cfg({ proxyUrl: '   ' })).proxyUrl).toBe('')
  })

  it("proxyScope：只认 'all' | 'telegram-only'，非法回退 'telegram-only'", () => {
    expect(sanitizeConfig(cfg({ proxyScope: 'all' })).proxyScope).toBe('all')
    expect(sanitizeConfig(cfg({ proxyScope: 'telegram-only' })).proxyScope).toBe('telegram-only')
    expect(
      sanitizeConfig(cfg({ proxyScope: 'everything' as AppConfig['proxyScope'] })).proxyScope
    ).toBe('telegram-only')
    expect(
      sanitizeConfig(cfg({ proxyScope: undefined as unknown as AppConfig['proxyScope'] })).proxyScope
    ).toBe('telegram-only')
  })

  it('channels：telegram 凭据 trim、enabled 布尔化、id slug 化去重（R6-W1）', () => {
    const out = sanitizeConfig(
      cfg({
        channels: [
          { id: ' telegram ', type: 'telegram', enabled: 1 as unknown as boolean, botToken: ' 123:abc ', chatId: ' -100200 \n' },
          { id: 'telegram', type: 'telegram', enabled: false, botToken: 'x', chatId: 'y' } // slug 后重复 → telegram-2
        ]
      })
    )
    expect(out.channels).toEqual([
      { id: 'telegram', type: 'telegram', enabled: false, botToken: '123:abc', chatId: '-100200' },
      { id: 'telegram-2', type: 'telegram', enabled: false, botToken: 'x', chatId: 'y' }
    ])
  })

  it('channels：非数组 → 默认单项；全弃 → 回默认 telegram 项（列表恒至少一项）', () => {
    expect(sanitizeConfig(cfg({ channels: undefined as unknown as [] })).channels).toEqual(
      DEFAULT_APP_CONFIG.channels
    )
    expect(sanitizeConfig(cfg({ channels: 'garbage' as unknown as [] })).channels).toEqual(
      DEFAULT_APP_CONFIG.channels
    )
    // 全部项非法：非对象 / 未知 type / 非对象项
    expect(
      sanitizeConfig(
        cfg({ channels: [null, 'junk', { type: 'sms', enabled: true } as never] as unknown as [] })
      ).channels
    ).toEqual(DEFAULT_APP_CONFIG.channels)
  })

  it('channels：缺 id 按类型派生（telegram/bark/ntfy/webhook），冲突追加 -2', () => {
    const out = sanitizeConfig(
      cfg({
        channels: [
          { type: 'telegram', enabled: true, botToken: 'a', chatId: 'b' }, // 缺 id → 'telegram'
          { type: 'ntfy', enabled: true, topic: 't1' }, // → 'ntfy'
          { type: 'ntfy', enabled: true, topic: 't2' }, // → 'ntfy-2'
          { id: '  ', type: 'webhook', enabled: true, url: 'https://example.com/hook' } // id 空白 → 'webhook'
        ] as unknown as AppConfig['channels']
      })
    )
    expect(out.channels.map((c) => c.id)).toEqual(['telegram', 'ntfy', 'ntfy-2', 'webhook'])
  })

  it('channels：bark/ntfy serverUrl 非 http(s) 弃字段（缺省=官方默认）；ntfy topic 空 → 整项弃', () => {
    const out = sanitizeConfig(
      cfg({
        channels: [
          { id: 'b1', type: 'bark', enabled: true, deviceKey: ' k ', serverUrl: ' https://bark.example.com ' },
          { id: 'b2', type: 'bark', enabled: true, deviceKey: 'k', serverUrl: 'ftp://nope' }, // 弃字段
          { id: 'n1', type: 'ntfy', enabled: true, topic: ' my-topic ', serverUrl: 'http://ntfy.local' },
          { id: 'n2', type: 'ntfy', enabled: true, topic: '   ' } // topic 空 → 整项弃
        ] as unknown as AppConfig['channels']
      })
    )
    expect(out.channels).toEqual([
      { id: 'b1', type: 'bark', enabled: true, deviceKey: 'k', serverUrl: 'https://bark.example.com' },
      { id: 'b2', type: 'bark', enabled: true, deviceKey: 'k' }, // serverUrl 不落键
      { id: 'n1', type: 'ntfy', enabled: true, topic: 'my-topic', serverUrl: 'http://ntfy.local' }
    ])
    expect('serverUrl' in out.channels[1]!).toBe(false)
  })

  it('channels：webhook url 必须合法 http(s) URL 否则整项弃；secret trim 空不落键', () => {
    const badUrls: unknown[] = [undefined, 'not a url', 'ftp://example.com', 'http://', '   ', 42]
    for (const url of badUrls) {
      const out = sanitizeConfig(
        cfg({
          channels: [
            { id: 'bad', type: 'webhook', enabled: true, url: url as string },
            // 垫底合法项：确认"整项丢弃"不是"全列表回默认"
            { id: 'tg', type: 'telegram', enabled: true, botToken: 'T', chatId: 'C' }
          ] as unknown as AppConfig['channels']
        })
      )
      expect(out.channels).toEqual([
        { id: 'tg', type: 'telegram', enabled: true, botToken: 'T', chatId: 'C' }
      ])
    }
    const out = sanitizeConfig(
      cfg({
        channels: [
          { id: 'w1', type: 'webhook', enabled: true, url: ' https://example.com/hook ', secret: ' s3cret ' },
          { id: 'w2', type: 'webhook', enabled: true, url: 'https://example.com/h2', secret: '   ' }
        ] as unknown as AppConfig['channels']
      })
    )
    expect(out.channels).toEqual([
      { id: 'w1', type: 'webhook', enabled: true, url: 'https://example.com/hook', secret: 's3cret' },
      { id: 'w2', type: 'webhook', enabled: true, url: 'https://example.com/h2' }
    ])
    expect('secret' in out.channels[1]!).toBe(false)
  })

  it('channels：上限 8 条（超出截断）', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `tg-${i}`,
      type: 'telegram' as const,
      enabled: true,
      botToken: `t${i}`,
      chatId: `c${i}`
    }))
    const out = sanitizeConfig(cfg({ channels: many }))
    expect(out.channels).toHaveLength(8)
    expect(out.channels[0]!.id).toBe('tg-0')
    expect(out.channels[7]!.id).toBe('tg-7')
  })

  it('channels：sanitize 白名单剔残留旧顶层 telegram 键（写路径只写新形状，DEC-9）', () => {
    // 手工构造带旧键的输入：sanitize 重建后 telegram 键消失
    const input = cfg({} as Partial<AppConfig>) as AppConfig & { telegram?: unknown }
    input.telegram = { botToken: 'legacy', chatId: 'legacy' }
    const out = sanitizeConfig(input) as AppConfig & { telegram?: unknown }
    expect('telegram' in out).toBe(false)
    // 旧键不影响 channels 的清洗结果
    expect(out.channels).toEqual(DEFAULT_APP_CONFIG.channels)
  })

  it('notify：mode 枚举、digestIntervalMin 钳 [1,120]、quietHours 布尔化 + HH:MM 回退（R6-W1）', () => {
    expect(sanitizeConfig(cfg({ notify: undefined as unknown as AppConfig['notify'] })).notify).toEqual(
      DEFAULT_APP_CONFIG.notify
    )
    expect(
      sanitizeConfig(
        cfg({
          notify: {
            mode: 'digest' as const,
            digestIntervalMin: 30,
            quietHours: { enabled: true, startHHMM: '22:30', endHHMM: '07:15' },
            remoteControl: { enabled: false, allowedChatIds: [] }
          }
        })
      ).notify
    ).toEqual({ mode: 'digest', digestIntervalMin: 30, quietHours: { enabled: true, startHHMM: '22:30', endHHMM: '07:15' }, remoteControl: { enabled: false, allowedChatIds: [] } })

    const modeOf = (m: unknown) =>
      sanitizeConfig(cfg({ notify: { ...cfg().notify, mode: m as never } })).notify.mode
    expect(modeOf('instant')).toBe('instant')
    expect(modeOf('batch')).toBe('instant')
    expect(modeOf(undefined)).toBe('instant')

    const intervalOf = (n: unknown) =>
      sanitizeConfig(cfg({ notify: { ...cfg().notify, digestIntervalMin: n as number } })).notify
        .digestIntervalMin
    expect(intervalOf(0)).toBe(1) // 钳下限
    expect(intervalOf(-5)).toBe(1)
    expect(intervalOf(999)).toBe(120) // 钳上限
    expect(intervalOf(15)).toBe(15)
    expect(intervalOf(Number.NaN)).toBe(15) // 非法回默认
    expect(intervalOf('30' as unknown as number)).toBe(15)

    const hhmmOf = (patch: Record<string, unknown>) =>
      sanitizeConfig(cfg({ notify: { ...cfg().notify, quietHours: { enabled: 1, ...patch } as never } }))
        .notify.quietHours
    expect(hhmmOf({ startHHMM: '24:00', endHHMM: '08:00' })).toEqual({
      enabled: false, // enabled=1 → false（=== true 强制布尔）
      startHHMM: '23:00', // 非法回默认
      endHHMM: '08:00'
    })
    expect(hhmmOf({ startHHMM: '23:00', endHHMM: '9:30' }).endHHMM).toBe('08:00')
    expect(hhmmOf({ startHHMM: '23:00', endHHMM: '08:00' })).toEqual({
      enabled: false,
      startHHMM: '23:00',
      endHHMM: '08:00'
    })
  })

  it('notify.remoteControl：enabled 布尔化（默认关）、allowedChatIds trim/去空/精确去重/上限 10（R9-W1）', () => {
    const rcOf = (patch: Record<string, unknown>) =>
      sanitizeConfig(
        cfg({ notify: { ...cfg().notify, remoteControl: patch as never } })
      ).notify.remoteControl
    // 缺失/非法 → 默认关 + 空清单
    expect(rcOf({})).toEqual({ enabled: false, allowedChatIds: [] })
    expect(rcOf({ enabled: 1, allowedChatIds: 'x' as never })).toEqual({
      enabled: false,
      allowedChatIds: []
    })
    // trim、去空、精确去重（负数群 id 原样保留，不做大小写折叠）
    expect(
      rcOf({
        enabled: true,
        allowedChatIds: [' 100200 ', '', '   ', '-100999', '100200', 42 as never, null as never]
      })
    ).toEqual({ enabled: true, allowedChatIds: ['100200', '-100999'] })
    // 上限 10：超出截断
    expect(
      rcOf({ enabled: true, allowedChatIds: Array.from({ length: 15 }, (_, i) => String(i)) })
        .allowedChatIds
    ).toHaveLength(10)
  })

  it('routing：非数组 → []；悬挂 sourceId/ruleId 剔字段、matchedBy 枚举过滤、when 全空整条弃、channelIds 过滤后空整条弃（DEC-7）', () => {
    const base = cfg({
      sources: [{ id: 'nodeseek', type: 'nodeseek', enabled: true }],
      priceRules: [{ id: 'cheap', enabled: true, cycle: 'any' }],
      channels: [
        { id: 'telegram', type: 'telegram', enabled: true, botToken: 'T', chatId: 'C' },
        { id: 'tg2', type: 'telegram', enabled: true, botToken: 'T2', chatId: 'C2' }
      ]
    })
    const out = sanitizeConfig(
      cfg({
        ...base,
        routing: [
          null as never, // 非对象：丢弃
          'junk' as never, // 非对象：丢弃
          { when: {}, channelIds: ['telegram'] } as never, // 缺 id：丢弃
          // 悬挂 sourceId 剔字段；matchedBy 过滤非法值后非空保留
          {
            id: 'r1',
            when: { sourceId: 'ghost', matchedBy: ['literal', 'bogus', 'rule'] },
            channelIds: ['telegram', 'ghost-channel', 'telegram'] // 悬挂过滤 + 去重
          },
          // ruleId 悬挂剔字段；when 清洗后只剩 matchedBy → 保留
          { id: 'r2', when: { ruleId: 'ghost-rule', matchedBy: ['semantic'] }, channelIds: ['tg2'] },
          // when 清洗后全空 → 整条弃
          { id: 'r3', when: { sourceId: 'ghost', ruleId: 'ghost', matchedBy: [] }, channelIds: ['telegram'] },
          // channelIds 全悬挂 → 整条弃
          { id: 'r4', when: { sourceId: 'nodeseek' }, channelIds: ['nope'] },
          // 合法引用：sourceId/ruleId 都在
          { id: 'r5', when: { sourceId: 'nodeseek', ruleId: 'cheap', matchedBy: ['literal'] }, channelIds: ['telegram'] },
          { id: 'r5', when: { sourceId: 'nodeseek' }, channelIds: ['telegram'] } // 重复 id：丢弃
        ] as unknown as AppConfig['routing']
      })
    )
    expect(out.routing).toEqual([
      { id: 'r1', when: { matchedBy: ['literal', 'rule'] }, channelIds: ['telegram'] },
      { id: 'r2', when: { matchedBy: ['semantic'] }, channelIds: ['tg2'] },
      {
        id: 'r5',
        when: { sourceId: 'nodeseek', matchedBy: ['literal'], ruleId: 'cheap' },
        channelIds: ['telegram']
      }
    ])
  })

  it('routing：空列表合法（= 不路由）；上限 20 条', () => {
    expect(sanitizeConfig(cfg({ routing: [] })).routing).toEqual([])
    expect(sanitizeConfig(cfg({ routing: 'garbage' as unknown as [] })).routing).toEqual([])
    const base = cfg({ channels: [{ id: 'telegram', type: 'telegram', enabled: true, botToken: 'T', chatId: 'C' }] })
    const rules = Array.from({ length: 25 }, (_, i) => ({
      id: `route-${i}`,
      when: { matchedBy: ['literal' as const] },
      channelIds: ['telegram']
    }))
    const out = sanitizeConfig(cfg({ ...base, routing: rules }))
    expect(out.routing).toHaveLength(20)
    expect(out.routing[0]!.id).toBe('route-0')
    expect(out.routing[19]!.id).toBe('route-19')
  })

  it('坑4 回归：save→load 往返不丢 channels/notify/routing（sanitize 白名单完整性）', () => {
    const store = new ConfigStore(configPath)
    store.save(
      cfg({
        channels: [
          { id: 'tg-main', type: 'telegram', enabled: true, botToken: '111:abc', chatId: '-100200' },
          { id: 'my-bark', type: 'bark', enabled: false, deviceKey: 'k', serverUrl: 'https://bark.example.com' },
          { id: 'ntfy-1', type: 'ntfy', enabled: true, topic: 'forumwatch' },
          { id: 'hook', type: 'webhook', enabled: true, url: 'https://example.com/hook', secret: 's' }
        ],
        notify: {
          mode: 'digest',
          digestIntervalMin: 30,
          quietHours: { enabled: true, startHHMM: '23:30', endHHMM: '07:00' },
          remoteControl: { enabled: true, allowedChatIds: ['-100999', '100200'] }
        },
        routing: [
          { id: 'route-1', when: { matchedBy: ['literal'] }, channelIds: ['tg-main'] }
        ]
      })
    )
    const loaded = new ConfigStore(configPath).load()
    expect(loaded.channels).toEqual([
      { id: 'tg-main', type: 'telegram', enabled: true, botToken: '111:abc', chatId: '-100200' },
      { id: 'my-bark', type: 'bark', enabled: false, deviceKey: 'k', serverUrl: 'https://bark.example.com' },
      { id: 'ntfy-1', type: 'ntfy', enabled: true, topic: 'forumwatch' },
      { id: 'hook', type: 'webhook', enabled: true, url: 'https://example.com/hook', secret: 's' }
    ])
    expect(loaded.notify).toEqual({
      mode: 'digest',
      digestIntervalMin: 30,
      quietHours: { enabled: true, startHHMM: '23:30', endHHMM: '07:00' },
      remoteControl: { enabled: true, allowedChatIds: ['-100999', '100200'] }
    })
    expect(loaded.routing).toEqual([
      { id: 'route-1', when: { matchedBy: ['literal'] }, channelIds: ['tg-main'] }
    ])
  })

  it('返回新对象，不改入参', () => {
    const input = cfg({ includeKeywords: [' vps '], pollIntervalSec: 5 })
    const snapshot = structuredClone(input)
    const out = sanitizeConfig(input)
    expect(input).toEqual(snapshot) // 入参原样
    expect(out).not.toBe(input)
    expect(out.channels).not.toBe(input.channels)
    expect(out.notify).not.toBe(input.notify)
    expect(out.routing).not.toBe(input.routing)
    expect(out.ai).not.toBe(input.ai)
    expect(out.sources).not.toBe(input.sources)
    expect(out.priceRules).not.toBe(input.priceRules)
    expect(out.similarity).not.toBe(input.similarity)
  })

  it('ai.baseUrl：trim、去尾斜杠、必须 http(s):// 开头否则置空', () => {
    const aiOf = (url: unknown): string =>
      sanitizeConfig(
        cfg({
          ai: {
            ...cfg().ai,
            provider: { ...cfg().ai.provider, baseUrl: url as string }
          }
        })
      ).ai.provider.baseUrl
    expect(aiOf('  https://api.deepseek.com/v1  ')).toBe('https://api.deepseek.com/v1')
    expect(aiOf('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com/v1')
    expect(aiOf('https://api.deepseek.com/v1///')).toBe('https://api.deepseek.com/v1')
    expect(aiOf('HTTP://localhost:8000/v1/')).toBe('HTTP://localhost:8000/v1')
    expect(aiOf('ftp://nope')).toBe('')
    expect(aiOf('api.deepseek.com/v1')).toBe('')
    expect(aiOf('http://')).toBe('') // 去尾斜杠后只剩 'http:'：不保留
    expect(aiOf('   ')).toBe('')
  })

  it('ai.provider.apiKey/model trim', () => {
    const out = sanitizeConfig(
      cfg({
        ai: {
          ...cfg().ai,
          provider: { baseUrl: '', apiKey: ' sk-abc \n', model: ' deepseek-chat ' }
        }
      })
    )
    expect(out.ai.provider.apiKey).toBe('sk-abc')
    expect(out.ai.provider.model).toBe('deepseek-chat')
  })

  it("ai.matchMode：只认 literal/semantic/both，非法回退 'literal'", () => {
    const modeOf = (m: unknown) =>
      sanitizeConfig(
        cfg({ ai: { ...cfg().ai, matchMode: m as AppConfig['ai']['matchMode'] } })
      ).ai.matchMode
    expect(modeOf('literal')).toBe('literal')
    expect(modeOf('semantic')).toBe('semantic')
    expect(modeOf('both')).toBe('both')
    expect(modeOf('Literal')).toBe('literal')
    expect(modeOf('everything')).toBe('literal')
    expect(modeOf(undefined)).toBe('literal')
  })

  it('ai.interests：每条 trim 去空、单条超 500 字符截断、最多 20 条', () => {
    const interests = [
      '  便宜大内存 VPS  ',
      '', // 去空
      '   ',
      'x'.repeat(600), // 截断到 500
      ...Array.from({ length: 25 }, (_, i) => `interest-${i}`)
    ]
    const out = sanitizeConfig(cfg({ ai: { ...cfg().ai, interests } }))
    expect(out.ai.interests).toHaveLength(20)
    expect(out.ai.interests[0]).toBe('便宜大内存 VPS')
    expect(out.ai.interests[1]).toBe('x'.repeat(500))
    expect(out.ai.interests[19]).toBe('interest-17') // 20 条封顶：interest-18/19 被裁掉
  })

  it('ai.dailyReport：enabled 强制布尔；timeHHMM 非法回 22:00，合法保留', () => {
    const hhmmOf = (t: unknown) =>
      sanitizeConfig(
        cfg({
          ai: {
            ...cfg().ai,
            dailyReport: { enabled: 1 as unknown as boolean, timeHHMM: t as string }
          }
        })
      ).ai.dailyReport
    expect(hhmmOf('09:05')).toEqual({ enabled: false, timeHHMM: '09:05' })
    expect(hhmmOf('23:59').timeHHMM).toBe('23:59')
    expect(hhmmOf('00:00').timeHHMM).toBe('00:00')
    expect(hhmmOf('24:00').timeHHMM).toBe('22:00')
    expect(hhmmOf('12:60').timeHHMM).toBe('22:00')
    expect(hhmmOf('9:05').timeHHMM).toBe('22:00') // 非两位
    expect(hhmmOf('1205').timeHHMM).toBe('22:00')
    expect(hhmmOf('').timeHHMM).toBe('22:00')
    expect(hhmmOf(undefined).timeHHMM).toBe('22:00')
    // enabled 真布尔保留
    const out = sanitizeConfig(
      cfg({ ai: { ...cfg().ai, dailyReport: { enabled: true, timeHHMM: '08:30' } } })
    )
    expect(out.ai.dailyReport).toEqual({ enabled: true, timeHHMM: '08:30' })
  })

  it('ai.commentary：默认开的布尔（与 similarity.enabled 并列）——缺失（旧 v2 配置）→ true，显式 false 保留，非法值 → true', () => {
    // 第三轮之前的 v2 配置：ai 段没有 commentary 字段
    const legacyAi = {
      provider: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk', model: 'm' },
      matchMode: 'both',
      interests: [],
      dailyReport: { enabled: false, timeHHMM: '22:00' }
    }
    const enabledOf = (c: unknown) =>
      sanitizeConfig(cfg({ ai: { ...legacyAi, commentary: c } as unknown as AppConfig['ai'] }))
        .ai.commentary.enabled
    expect(enabledOf(undefined)).toBe(true) // 旧 v2 配置缺失字段 → 默认开
    expect(enabledOf(null)).toBe(true) // commentary 段整体为 null
    expect(enabledOf({})).toBe(true) // 段在但缺 enabled
    expect(enabledOf('false')).toBe(true) // 字符串等非法值 → true（不是 === true 的缺省 false）
    expect(enabledOf(0)).toBe(true)
    expect(enabledOf(true)).toBe(true) // 显式 true 保留
    expect(enabledOf({ enabled: true })).toBe(true)
    expect(enabledOf({ enabled: false })).toBe(false) // 唯一能关掉的方式：显式布尔 false
  })

  it('ai.commentary.useThinking（R12）：**默认关**的布尔——缺失/非法 → false（直出模式），仅显式 true 保留（思考模式）', () => {
    const thinkingOf = (c: unknown) =>
      sanitizeConfig(
        cfg({ ai: { ...cfg().ai, commentary: c as unknown as AppConfig['ai']['commentary'] } })
      ).ai.commentary.useThinking
    expect(thinkingOf(undefined)).toBe(false) // 旧配置缺失 → 直出（新默认行为）
    expect(thinkingOf(null)).toBe(false) // 段整体为 null
    expect(thinkingOf({})).toBe(false) // 段在但缺 useThinking
    expect(thinkingOf({ enabled: true })).toBe(false) // R12 前的配置形状
    expect(thinkingOf('true')).toBe(false) // 字符串等非法值 → false
    expect(thinkingOf(1)).toBe(false)
    expect(thinkingOf({ useThinking: false })).toBe(false) // 显式 false 保留
    expect(thinkingOf({ useThinking: true })).toBe(true) // 唯一开启方式：显式布尔 true
  })

  it('ai.semanticThreshold：非法回 0（默认=行为不变），钳到 [0,1]（不取整）', () => {
    const thrOf = (t: unknown) =>
      sanitizeConfig(cfg({ ai: { ...cfg().ai, semanticThreshold: t as number } })).ai
        .semanticThreshold
    expect(thrOf(0)).toBe(0)
    expect(thrOf(0.65)).toBe(0.65)
    expect(thrOf(0.6789)).toBe(0.6789) // 不保留两位小数（与 similarity.threshold 口径区分）
    expect(thrOf(1)).toBe(1)
    expect(thrOf(1.2)).toBe(1)
    expect(thrOf(-0.3)).toBe(0)
    expect(thrOf(Number.NaN)).toBe(0)
    expect(thrOf(Number.POSITIVE_INFINITY)).toBe(0)
    expect(thrOf(undefined)).toBe(0) // 旧配置缺失 → 默认 0
    expect(thrOf('0.9' as unknown as number)).toBe(0)
  })

  it('similarity.enabled：默认开的布尔——缺失（旧配置）→ true，显式 false 保留，非法 → true', () => {
    const enabledOf = (c: unknown) => sanitizeConfig(cfg({ similarity: c as never })).similarity.enabled
    expect(enabledOf(undefined)).toBe(true) // 旧配置缺失 similarity 段 → 默认开
    expect(enabledOf(null)).toBe(true)
    expect(enabledOf('garbage')).toBe(true)
    expect(enabledOf({})).toBe(true) // 段在但缺 enabled
    expect(enabledOf({ enabled: 1 })).toBe(true) // 非布尔 → true（!== false 方向）
    expect(enabledOf({ enabled: true })).toBe(true)
    expect(enabledOf({ enabled: false })).toBe(false) // 唯一能关掉的方式：显式布尔 false
  })

  it('similarity.threshold：非法回 0.72，钳到 [0,1] 并保留两位小数', () => {
    const thrOf = (t: unknown) =>
      sanitizeConfig(cfg({ similarity: { enabled: true, threshold: t as number } })).similarity
        .threshold
    expect(thrOf(0.72)).toBe(0.72)
    expect(thrOf(0.5)).toBe(0.5)
    expect(thrOf(0)).toBe(0)
    expect(thrOf(1)).toBe(1)
    expect(thrOf(1.5)).toBe(1) // 越界钳制
    expect(thrOf(-0.2)).toBe(0)
    expect(thrOf(0.769)).toBe(0.77) // 保留两位小数
    expect(thrOf(0.999)).toBe(1) // 0.999 四舍五入到 1.00（仍在 [0,1]）
    expect(thrOf(Number.NaN)).toBe(0.72)
    expect(thrOf(Number.POSITIVE_INFINITY)).toBe(0.72)
    expect(thrOf('0.8' as unknown as number)).toBe(0.72)
    expect(thrOf(undefined)).toBe(0.72)
  })

  it('priceRules：非数组 → []（空列表=无规则，是合法状态，不回默认）', () => {
    expect(sanitizeConfig(cfg({ priceRules: undefined as unknown as [] })).priceRules).toEqual([])
    expect(sanitizeConfig(cfg({ priceRules: 'garbage' as unknown as [] })).priceRules).toEqual([])
  })

  it('priceRules：整条清洗全分支（非对象/无可用 id 丢弃、slug 化去重、enabled 布尔化、枚举回 any、label 空不落键、非法数值丢字段、keywords 清洗后空不落键）', () => {
    const out = sanitizeConfig(
      cfg({
        priceRules: [
          null as unknown as never, // 非对象：整条丢弃
          'junk' as unknown as never, // 非对象：整条丢弃
          { cycle: 'yearly' } as unknown as never, // 缺 id：丢弃
          { id: 42 as unknown as string, cycle: 'yearly' } as unknown as never, // id 非字符串：丢弃
          {
            id: ' cheap-vps ', // trim 后 slug 化
            enabled: 1 as unknown as boolean,
            cycle: 'weeKLY' as never, // 枚举大小写敏感：非法回 'any'
            currency: 'usd' as never, // 同上
            label: '  便宜年付 VPS  ',
            maxPrice: 0, // 非正数：丢字段
            minTrafficGB: -5, // 非正数：丢字段
            keywords: ['  VPS  ', 'vps', '', '  ', '大流量']
          },
          { id: 'cheap-vps', cycle: 'monthly' }, // slug 后重复 id：保留首个
          {
            id: 'traffic_rule!', // slug 化：'!' → '-'
            enabled: true,
            cycle: 'monthly',
            currency: 'CNY',
            maxPrice: Number.NaN, // 丢字段
            minTrafficGB: Number.POSITIVE_INFINITY, // 丢字段
            keywords: ['   ', ''] // 清洗后空：不落键
          },
          {
            id: 'ok',
            enabled: true,
            cycle: 'yearly',
            currency: 'USD',
            maxPrice: 99.9,
            minTrafficGB: 0.5,
            label: '   ' // trim 后空：不落键
          }
        ] as unknown as AppConfig['priceRules']
      })
    )
    expect(out.priceRules).toEqual([
      {
        id: 'cheap-vps',
        enabled: false, // enabled=1 → false（=== true 强制布尔）
        cycle: 'any',
        currency: 'any',
        label: '便宜年付 VPS',
        keywords: ['VPS', '大流量']
      },
      { id: 'traffic_rule-', enabled: true, cycle: 'monthly', currency: 'CNY' },
      {
        id: 'ok',
        enabled: true,
        cycle: 'yearly',
        currency: 'USD',
        maxPrice: 99.9,
        minTrafficGB: 0.5
      }
    ])
    // 显式断言"丢字段"是不落键（而非 0/null），对齐 filters 的断言风格
    expect('maxPrice' in out.priceRules[0]!).toBe(false)
    expect('minTrafficGB' in out.priceRules[0]!).toBe(false)
    expect('keywords' in out.priceRules[1]!).toBe(false)
    expect('label' in out.priceRules[2]!).toBe(false)
  })

  it('priceRules：列表上限 20 条（超出截断，按清洗后顺序）', () => {
    const rules = Array.from({ length: 25 }, (_, i) => ({
      id: `rule-${i}`,
      enabled: true,
      cycle: 'any' as const
    }))
    const out = sanitizeConfig(cfg({ priceRules: rules }))
    expect(out.priceRules).toHaveLength(20)
    expect(out.priceRules[0]!.id).toBe('rule-0')
    expect(out.priceRules[19]!.id).toBe('rule-19') // rule-20..24 被裁掉
  })

  it('priceRules keywords：trim、去空、大小写不敏感去重（保留首现写法）、上限 20', () => {
    const kws = [
      '  vps  ',
      'VPS', // 大小写不敏感去重
      '',
      '  ',
      '\t大流量\t',
      ...Array.from({ length: 25 }, (_, i) => `kw-${i}`)
    ]
    const out = sanitizeConfig(cfg({ priceRules: [{ id: 'r1', enabled: true, cycle: 'any', keywords: kws }] }))
    const keywords = out.priceRules[0]!.keywords!
    expect(keywords).toHaveLength(20)
    expect(keywords[0]).toBe('vps')
    expect(keywords[1]).toBe('大流量')
    expect(keywords[19]).toBe('kw-17') // 20 条封顶：kw-18..24 被裁掉
  })

  it('第五轮新字段默认值：priceRules=[]、similarity={enabled:true,threshold:0.72}、ai.semanticThreshold=0', () => {
    const out = sanitizeConfig(cfg())
    expect(out.priceRules).toEqual([])
    expect(out.similarity).toEqual({ enabled: true, threshold: 0.72 })
    expect(out.ai.semanticThreshold).toBe(0)
  })

  it('sources：非数组/空数组 → 默认单项 nodeseek', () => {
    expect(sanitizeConfig(cfg({ sources: [] })).sources).toEqual([
      { id: 'nodeseek', type: 'nodeseek', enabled: true }
    ])
    expect(
      sanitizeConfig(cfg({ sources: undefined as unknown as [] })).sources
    ).toEqual([{ id: 'nodeseek', type: 'nodeseek', enabled: true }])
    expect(
      sanitizeConfig(cfg({ sources: 'nope' as unknown as [] })).sources
    ).toEqual([{ id: 'nodeseek', type: 'nodeseek', enabled: true }])
  })

  it('sources：id slug 化（非法字符替换 -、trim、空则丢弃）、enabled 布尔化、按 id 去重', () => {
    const out = sanitizeConfig(
      cfg({
        sources: [
          { id: ' nodeseek ', type: 'nodeseek', enabled: 1 as unknown as boolean },
          { id: 'node_seek!', type: 'nodeseek', enabled: false },
          { id: 'nodeseek', type: 'nodeseek', enabled: true }, // 重复 id：保留首个
          { id: '   ', type: 'nodeseek', enabled: true }, // trim 后空：丢弃
          { id: 42 as unknown as string, type: 'nodeseek', enabled: true }, // 非字符串：丢弃
          null as unknown as never, // 非对象：丢弃
          { type: 'nodeseek', enabled: true } as unknown as SourceConfig // 缺 id：丢弃
        ]
      })
    )
    expect(out.sources).toEqual([
      { id: 'nodeseek', type: 'nodeseek', enabled: false }, // 首个：enabled=1 → false（强制布尔）
      { id: 'node_seek-', type: 'nodeseek', enabled: false }
    ])
  })

  it('sources：v2ex 合法保留；未知 type 整项丢弃（v3 起不再洗成 nodeseek）', () => {
    const out = sanitizeConfig(
      cfg({
        sources: [
          { id: 'v2ex', type: 'v2ex', enabled: true },
          { id: 'mystery', type: 'discourse' as never, enabled: true },
          { id: 'no-type', enabled: true } as unknown as never
        ]
      })
    )
    expect(out.sources).toEqual([{ id: 'v2ex', type: 'v2ex', enabled: true }])
  })

  it('sources rss：合法 url 保留（url/label trim），label 空则不落键', () => {
    const out = sanitizeConfig(
      cfg({
        sources: [
          {
            id: 'hn',
            type: 'rss',
            enabled: true,
            url: '  https://hnrss.org/frontpage  ',
            label: '  Hacker News  '
          },
          { id: 'blog', type: 'rss', enabled: false, url: 'http://example.com/feed.xml', label: '   ' }
        ]
      })
    )
    expect(out.sources).toEqual([
      { id: 'hn', type: 'rss', enabled: true, url: 'https://hnrss.org/frontpage', label: 'Hacker News' },
      { id: 'blog', type: 'rss', enabled: false, url: 'http://example.com/feed.xml' } // 空 label 不落键
    ])
  })

  it('sources rss：非法 url 整项丢弃（非字符串 / 解析失败 / 非 http(s) / 无 host）', () => {
    const badUrls: unknown[] = [
      undefined, // 缺 url
      'not a url',
      'ftp://example.com/feed',
      'javascript:alert(1)',
      'http://', // 无 host：new URL 抛
      '   ', // trim 后空
      42
    ]
    // 注：'https:///path' 不在列——WHATWG URL 会折叠多余斜杠解析出 host 'path'，
    // 属"能 new URL 且有 host"的合法边角，按规格保留。
    for (const url of badUrls) {
      const out = sanitizeConfig(
        cfg({
          sources: [
            { id: 'bad', type: 'rss', enabled: true, url: url as string },
            // 垫底合法项：确认"整项丢弃"不是"全列表回默认"
            { id: 'v2ex', type: 'v2ex', enabled: true }
          ]
        })
      )
      expect(out.sources).toEqual([{ id: 'v2ex', type: 'v2ex', enabled: true }])
    }
  })

  it('sources rss：缺 id / id 空白时从 url host 派生建议 id（host slug 化）；id 以用户给的为准', () => {
    const out = sanitizeConfig(
      cfg({
        sources: [
          { type: 'rss', enabled: true, url: 'https://example.com/feed.xml' } as never, // 缺 id
          { id: '   ', type: 'rss', enabled: true, url: 'http://other.org/rss' }, // id 空白：派生
          { id: 'custom-id', type: 'rss', enabled: true, url: 'https://third.net/rss' } // 用户 id 优先
        ]
      })
    )
    expect(out.sources).toEqual([
      { id: 'example-com', type: 'rss', enabled: true, url: 'https://example.com/feed.xml' },
      { id: 'other-org', type: 'rss', enabled: true, url: 'http://other.org/rss' },
      { id: 'custom-id', type: 'rss', enabled: true, url: 'https://third.net/rss' }
    ])
  })

  it('sources：id 全列表去重（跨类型），被丢弃的项不占 id', () => {
    const out = sanitizeConfig(
      cfg({
        sources: [
          { id: 'dup', type: 'rss', enabled: true, url: 'not-a-url' }, // 非法 url：丢弃，不占 id
          { id: 'dup', type: 'v2ex', enabled: true }, // 同 id 仍可用（上一项没占住）
          { id: 'dup', type: 'nodeseek', enabled: true }, // 真正的重复：丢弃
          { id: 'nodeseek', type: 'nodeseek', enabled: true }
        ]
      })
    )
    expect(out.sources).toEqual([
      { id: 'dup', type: 'v2ex', enabled: true },
      { id: 'nodeseek', type: 'nodeseek', enabled: true }
    ])
  })

  it('sources filters：三列表各自 trim、去空、大小写不敏感去重（保留首现写法）、每列表截断 100', () => {
    const many = Array.from({ length: 120 }, (_, i) => `cat-${i}`)
    const out = sanitizeConfig(
      cfg({
        sources: [
          {
            id: 'v2ex',
            type: 'v2ex',
            enabled: true,
            filters: {
              includeCategories: ['  Tech  ', 'tech', '', '  ', '\tGo\t'],
              excludeCategories: ['广告', '广告', ' 广告 '],
              blockedAuthors: many
            }
          }
        ]
      })
    )
    expect(out.sources).toEqual([
      {
        id: 'v2ex',
        type: 'v2ex',
        enabled: true,
        filters: {
          includeCategories: ['Tech', 'Go'],
          excludeCategories: ['广告'],
          blockedAuthors: many.slice(0, 100) // 100 条封顶
        }
      }
    ])
  })

  it('sources filters：非对象 / 清洗后全空 → 不落 filters 键（等价无过滤）', () => {
    const out = sanitizeConfig(
      cfg({
        sources: [
          { id: 'a', type: 'v2ex', enabled: true, filters: 'garbage' as never },
          { id: 'b', type: 'v2ex', enabled: true, filters: {} },
          {
            id: 'c',
            type: 'v2ex',
            enabled: true,
            filters: { includeCategories: ['  ', ''], blockedAuthors: [] }
          }
        ]
      })
    )
    expect(out.sources).toEqual([
      { id: 'a', type: 'v2ex', enabled: true },
      { id: 'b', type: 'v2ex', enabled: true },
      { id: 'c', type: 'v2ex', enabled: true }
    ])
    // 显式断言没有 filters 键（而非 filters: {}）
    for (const s of out.sources) expect('filters' in s).toBe(false)
  })

  it('坑4 回归：save→load 往返不丢 filters/url/label（sanitize 重建对象的白名单完整性）', () => {
    const store = new ConfigStore(configPath)
    store.save(
      cfg({
        sources: [
          { id: 'nodeseek', type: 'nodeseek', enabled: true, filters: { includeCategories: ['Trade'] } },
          {
            id: 'hn',
            type: 'rss',
            enabled: true,
            url: 'https://hnrss.org/frontpage',
            label: 'HN',
            filters: { blockedAuthors: ['spam'], excludeCategories: ['meta'] }
          },
          { id: 'v2ex', type: 'v2ex', enabled: false }
        ]
      })
    )
    const loaded = new ConfigStore(configPath).load()
    expect(loaded.sources).toEqual([
      { id: 'nodeseek', type: 'nodeseek', enabled: true, filters: { includeCategories: ['Trade'] } },
      {
        id: 'hn',
        type: 'rss',
        enabled: true,
        url: 'https://hnrss.org/frontpage',
        label: 'HN',
        filters: { blockedAuthors: ['spam'], excludeCategories: ['meta'] }
      },
      { id: 'v2ex', type: 'v2ex', enabled: false }
    ])
  })

  it('sources matching（R13）：各字段清洗往返保留——关键词 trim 去重、枚举/有限数校验、interests 同全局口径', () => {
    const out = sanitizeConfig(
      cfg({
        sources: [
          {
            id: 'lowendtalk-offers',
            type: 'rss',
            enabled: true,
            url: 'https://lowendtalk.com/discussions/feed.rss',
            matching: {
              includeKeywords: ['  vps ', 'VPS', 'dedicated'],
              excludeKeywords: ['giveaway', ' giveaway '],
              matchMode: 'semantic',
              interests: [' 便宜大碗的独服 ', ''],
              semanticThreshold: 0.35
            }
          }
        ]
      })
    )
    expect(out.sources[0]!.matching).toEqual({
      includeKeywords: ['vps', 'dedicated'],
      excludeKeywords: ['giveaway'],
      matchMode: 'semantic',
      interests: ['便宜大碗的独服'],
      semanticThreshold: 0.35
    })
  })

  it('sources matching（R13-2）：matchAll 仅 true 落键，false/非法 = 不落键（不全匹配）', () => {
    const base = { type: 'v2ex' as const, enabled: true }
    const out = sanitizeConfig(
      cfg({
        sources: [
          { id: 'on', ...base, matching: { matchAll: true } },
          { id: 'off', ...base, matching: { matchAll: false } },
          { id: 'junk', ...base, matching: { matchAll: 'yes' as never } },
          // matchAll:true + 其余全空 → matching 键保留（只有全匹配一项覆盖也算覆盖）
          { id: 'solo', ...base, matching: { includeKeywords: [], matchAll: true } }
        ]
      })
    )
    expect(out.sources[0]!.matching).toEqual({ matchAll: true })
    expect(out.sources[1]!.matching).toBeUndefined()
    expect(out.sources[2]!.matching).toBeUndefined()
    expect(out.sources[3]!.matching).toEqual({ matchAll: true })
  })

  it('sources matching：非对象 / 清洗后全空 → 不落 matching 键（等价未覆盖，跟随全局）', () => {
    const out = sanitizeConfig(
      cfg({
        sources: [
          { id: 'a', type: 'v2ex', enabled: true, matching: 'garbage' as never },
          { id: 'b', type: 'v2ex', enabled: true, matching: {} },
          {
            id: 'c',
            type: 'v2ex',
            enabled: true,
            matching: { includeKeywords: ['  ', ''], excludeKeywords: [], interests: [] }
          },
          {
            id: 'd',
            type: 'rss',
            enabled: true,
            url: 'https://example.com/feed',
            // rss 分支同样接入 sanitizeSourceMatching（坑4：两分支都要补）
            matching: { matchMode: 'nonsense' as never, semanticThreshold: Number.NaN }
          }
        ]
      })
    )
    expect(out.sources).toEqual([
      { id: 'a', type: 'v2ex', enabled: true },
      { id: 'b', type: 'v2ex', enabled: true },
      { id: 'c', type: 'v2ex', enabled: true },
      { id: 'd', type: 'rss', enabled: true, url: 'https://example.com/feed' }
    ])
    for (const s of out.sources) expect('matching' in s).toBe(false)
  })

  it('sources matching：非法 matchMode 剔除字段（而非回 literal——覆盖里非法 = 未覆盖）', () => {
    const out = sanitizeConfig(
      cfg({
        sources: [
          {
            id: 'a',
            type: 'v2ex',
            enabled: true,
            matching: { matchMode: 'fuzzy' as never, includeKeywords: ['vps'] }
          }
        ]
      })
    )
    // matchMode 键不存在（undefined = 跟随全局），includeKeywords 保留
    expect(out.sources[0]!.matching).toEqual({ includeKeywords: ['vps'] })
    expect('matchMode' in (out.sources[0]!.matching ?? {})).toBe(false)
  })

  it('sources matching：非法 semanticThreshold 剔除字段（而非回 0），越界钳 [0,1]', () => {
    const out = sanitizeConfig(
      cfg({
        sources: [
          {
            id: 'a',
            type: 'v2ex',
            enabled: true,
            matching: { semanticThreshold: 'high' as never }
          },
          {
            id: 'b',
            type: 'v2ex',
            enabled: true,
            matching: { semanticThreshold: Number.NaN }
          },
          { id: 'c', type: 'v2ex', enabled: true, matching: { semanticThreshold: 1.7 } },
          { id: 'd', type: 'v2ex', enabled: true, matching: { semanticThreshold: -0.2 } }
        ]
      })
    )
    // 非法（非数字 / NaN）= 不落键 = 跟随全局——与全局 clamp01 非法回 0 的口径有意不同
    expect(out.sources[0]!.matching).toBeUndefined()
    expect(out.sources[1]!.matching).toBeUndefined()
    expect(out.sources[2]!.matching).toEqual({ semanticThreshold: 1 })
    expect(out.sources[3]!.matching).toEqual({ semanticThreshold: 0 })
  })

  it('sources matching：nodeseek / v2ex / rss 三类型都接受 matching（坑4 白名单完整性）', () => {
    const out = sanitizeConfig(
      cfg({
        sources: [
          { id: 'nodeseek', type: 'nodeseek', enabled: true, matching: { matchMode: 'both' } },
          { id: 'v2ex', type: 'v2ex', enabled: true, matching: { matchMode: 'semantic' } },
          {
            id: 'rss-x',
            type: 'rss',
            enabled: true,
            url: 'https://example.com/feed',
            matching: { matchMode: 'literal' }
          }
        ]
      })
    )
    expect(out.sources.map((s) => s.matching)).toEqual([
      { matchMode: 'both' },
      { matchMode: 'semantic' },
      { matchMode: 'literal' }
    ])
  })

  it('坑4 回归：save→load 往返不丢 matching（sanitize 重建对象的白名单完整性）；旧配置无 matching 往返不受影响', () => {
    const store = new ConfigStore(configPath)
    store.save(
      cfg({
        sources: [
          {
            id: 'nodeseek',
            type: 'nodeseek',
            enabled: true,
            matching: { includeKeywords: ['vps'], matchMode: 'semantic', semanticThreshold: 0.4 }
          },
          {
            id: 'v2ex',
            type: 'v2ex',
            enabled: true
            // 无 matching：老用户形状，sanitize 后同样不落键
          }
        ]
      })
    )
    const loaded = new ConfigStore(configPath).load()
    expect(loaded.sources).toEqual([
      {
        id: 'nodeseek',
        type: 'nodeseek',
        enabled: true,
        matching: { includeKeywords: ['vps'], matchMode: 'semantic', semanticThreshold: 0.4 }
      },
      { id: 'v2ex', type: 'v2ex', enabled: true }
    ])
    expect('matching' in loaded.sources[1]!).toBe(false)
  })

  it('UI 清空路径（R13）：matching 清成全空（SourceCard patchMatching 删键语义）→ 保存往返不落键（无假 dirty）', () => {
    // 模拟 SourceCard.patchMatching 的落键语义：字段全空时 delete copy.matching
    // （对齐 sanitize），用户在 UI 看到的 sources 形状与保存重载后的形状一致，
    // 保存后 dirty 计数回到 0。这里以纯函数等价链路锁定（node 环境无 DOM，
    // 组件交互本身无法渲染测试——仓库先例见 ReportDoc.test.ts 头注释）。
    const store = new ConfigStore(configPath)
    store.save(
      cfg({
        sources: [
          {
            id: 'nodeseek',
            type: 'nodeseek',
            enabled: true,
            matching: { includeKeywords: ['vps'] }
          }
        ]
      })
    )
    // 用户在「匹配」面板删掉最后一个标签 → patchMatching 全空删键
    const cleared: AppConfig = {
      ...store.get(),
      sources: [{ id: 'nodeseek', type: 'nodeseek', enabled: true }]
    }
    store.save(cleared)
    const loaded = new ConfigStore(configPath).load()
    expect(loaded.sources).toEqual([{ id: 'nodeseek', type: 'nodeseek', enabled: true }])
    expect('matching' in loaded.sources[0]!).toBe(false)
    // 清空后的 draft 与重载值 JSON 等价 = 设置页 dirty 判定（draft vs toDraft(saved)
    // 的 JSON 比对）回到干净态
    expect(JSON.stringify(loaded.sources)).toBe(JSON.stringify(cleared.sources))
  })

  it('坑4 回归：save→load 往返不丢 priceRules/similarity/ai.semanticThreshold（sanitize 白名单完整性）', () => {
    const store = new ConfigStore(configPath)
    store.save(
      cfg({
        priceRules: [
          {
            id: 'cheap-yearly',
            label: '便宜年付',
            enabled: true,
            cycle: 'yearly',
            currency: 'CNY',
            maxPrice: 100,
            minTrafficGB: 50,
            keywords: ['vps']
          }
        ],
        similarity: { enabled: false, threshold: 0.85 },
        ai: { ...cfg().ai, semanticThreshold: 0.6 }
      })
    )
    const loaded = new ConfigStore(configPath).load()
    expect(loaded.priceRules).toEqual([
      {
        id: 'cheap-yearly',
        label: '便宜年付',
        enabled: true,
        cycle: 'yearly',
        currency: 'CNY',
        maxPrice: 100,
        minTrafficGB: 50,
        keywords: ['vps']
      }
    ])
    expect(loaded.similarity).toEqual({ enabled: false, threshold: 0.85 })
    expect(loaded.ai.semanticThreshold).toBe(0.6)
  })

  it('sources 全部项非法：回默认单项（绝不落空列表）', () => {
    const out = sanitizeConfig(
      cfg({ sources: [{ id: '', type: 'nodeseek', enabled: true }, 'junk' as unknown as never] })
    )
    expect(out.sources).toEqual([{ id: 'nodeseek', type: 'nodeseek', enabled: true }])
  })

  it('ai 字段整体损坏（非对象）：sanitize 回全默认 AI 配置', () => {
    const out = sanitizeConfig(cfg({ ai: 'broken' as unknown as AppConfig['ai'] }))
    expect(out.ai).toEqual(DEFAULT_APP_CONFIG.ai)
    const out2 = sanitizeConfig(cfg({ ai: { matchMode: 'both' } as unknown as AppConfig['ai'] }))
    expect(out2.ai).toEqual({
      ...DEFAULT_APP_CONFIG.ai,
      matchMode: 'both',
      provider: { baseUrl: '', apiKey: '', model: '' },
      interests: [],
      dailyReport: { enabled: false, timeHHMM: '22:00' }
    })
  })
})

describe('ConfigStore', () => {
  it('文件缺失：load 返回默认配置深拷贝', () => {
    const store = new ConfigStore(configPath)
    const a = store.load()
    expect(a).toEqual(DEFAULT_APP_CONFIG)
    // 深拷贝：外部改动不污染后续读取
    a.includeKeywords.push('leak')
    tg0(a.channels).botToken = 'leak'
    expect(store.get()).toEqual(DEFAULT_APP_CONFIG)
  })

  it('get() 未 load 过会自动 load', () => {
    const store = new ConfigStore(configPath)
    expect(store.get()).toEqual(DEFAULT_APP_CONFIG)
  })

  it('get() 返回内部状态的深拷贝：外部 mutate 不影响 store', () => {
    const store = new ConfigStore(configPath)
    store.save(
      cfg({
        includeKeywords: ['vps'],
        channels: [{ id: 'telegram', type: 'telegram', enabled: true, botToken: 'secret-token', chatId: 'c1' }]
      })
    )
    const a = store.get()
    a.includeKeywords.push('leak')
    tg0(a.channels).botToken = 'leak'
    const b = store.get()
    expect(b.includeKeywords).toEqual(['vps'])
    expect(tg0(b.channels).botToken).toBe('secret-token')
    // save 的返回路径同样不受污染（update 内部走 get，一并验证）
    expect(tg0(store.update({}).channels).botToken).toBe('secret-token')
  })

  it('默认值 roundtrip：save 默认配置 → 重新 load 得回等价配置', () => {
    const s1 = new ConfigStore(configPath)
    s1.save(cfg())
    const s2 = new ConfigStore(configPath)
    expect(s2.load()).toEqual(DEFAULT_APP_CONFIG)
  })

  it('save→load 往返保留清洗后的自定义配置', async () => {
    const custom = cfg({
      includeKeywords: [' vps ', 'nas'],
      excludeKeywords: ['爆料'],
      pollIntervalSec: 30,
      proxyUrl: 'http://127.0.0.1:7890',
      proxyScope: 'all',
      channels: [{ id: 'telegram', type: 'telegram', enabled: true, botToken: '111:abc', chatId: '-100200' }],
      notifyEnabled: false,
      launchAtLogin: true
    })
    new ConfigStore(configPath).save(custom)
    const loaded = new ConfigStore(configPath).load()
    expect(loaded).toEqual(sanitizeConfig(custom))
    expect(loaded.includeKeywords).toEqual(['vps', 'nas'])
    expect(tg0(loaded.channels).chatId).toBe('-100200')
    // 盘上是带 schemaVersion 的信封
    const onDisk = JSON.parse(await readFile(configPath, 'utf-8'))
    expect(onDisk.schemaVersion).toBe(4)
    expect(onDisk.config.channels[0].botToken).toBe('111:abc')
    // 旧顶层 telegram 键已消失：写路径只写新形状（DEC-9）
    expect('telegram' in onDisk.config).toBe(false)
  })

  it('v1 config 文件落盘后 load 出 v3：v1 字段保留 + sources/ai 补默认', async () => {
    // v1 时代的盘上文件（无 sources/ai 字段）
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        config: {
          includeKeywords: ['vps'],
          excludeKeywords: ['广告'],
          pollIntervalSec: 45,
          proxyUrl: 'http://127.0.0.1:7890',
          proxyScope: 'all',
          telegram: { botToken: '111:abc', chatId: '-100200' },
          notifyEnabled: false,
          launchAtLogin: true
        }
      }),
      'utf-8'
    )
    const loaded = new ConfigStore(configPath).load()
    // v1 字段全部保留
    expect(loaded.includeKeywords).toEqual(['vps'])
    expect(loaded.pollIntervalSec).toBe(45)
    // R6-W1 读兼容：v1 的 telegram 凭据映射为 channels[0]
    expect(loaded.channels).toEqual([
      { id: 'telegram', type: 'telegram', enabled: true, botToken: '111:abc', chatId: '-100200' }
    ])
    expect(loaded.notifyEnabled).toBe(false)
    expect(loaded.launchAtLogin).toBe(true)
    // v2 新增字段为默认值
    expect(loaded.sources).toEqual([{ id: 'nodeseek', type: 'nodeseek', enabled: true }])
    expect(loaded.ai).toEqual(DEFAULT_APP_CONFIG.ai)

    // 保存回写的是 v3 信封（迁移完成后不再回落 v1/v2）
    new ConfigStore(configPath).save(loaded)
    const onDisk = JSON.parse(await readFile(configPath, 'utf-8'))
    expect(onDisk.schemaVersion).toBe(4)
  })

  it('v2 config 文件落盘后 load 出 v3：sources 逐项映射为 nodeseek 形状，其余字段保留', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 2,
        config: {
          pollIntervalSec: 45,
          includeKeywords: ['vps'],
          sources: [
            { id: 'nodeseek', type: 'nodeseek', enabled: true },
            { id: 'nodeseek-mirror', type: 'nodeseek', enabled: false }
          ]
        }
      }),
      'utf-8'
    )
    const loaded = new ConfigStore(configPath).load()
    expect(loaded.pollIntervalSec).toBe(45)
    expect(loaded.includeKeywords).toEqual(['vps'])
    // v2 sources（type 恒 nodeseek）映射后经 sanitize 全部保留
    expect(loaded.sources).toEqual([
      { id: 'nodeseek', type: 'nodeseek', enabled: true },
      { id: 'nodeseek-mirror', type: 'nodeseek', enabled: false }
    ])
    // 再保存即落 v3
    new ConfigStore(configPath).save(loaded)
    expect(JSON.parse(await readFile(configPath, 'utf-8')).schemaVersion).toBe(4)
  })

  it('update：浅合并顶层字段，channels 数组整体替换（R6-W1）', () => {
    const store = new ConfigStore(configPath)
    store.save(
      cfg({
        includeKeywords: ['vps'],
        pollIntervalSec: 120,
        channels: [{ id: 'telegram', type: 'telegram', enabled: true, botToken: 'old-token', chatId: 'old-chat' }]
      })
    )

    const next = store.update({
      channels: [{ id: 'telegram', type: 'telegram', enabled: true, botToken: 'new-token', chatId: '' }]
    })
    // channels 整体替换：chatId 被带上来的空值覆盖，不是残留 old-chat
    expect(next.channels).toEqual([
      { id: 'telegram', type: 'telegram', enabled: true, botToken: 'new-token', chatId: '' }
    ])
    // 其他字段不受影响（浅合并）
    expect(next.includeKeywords).toEqual(['vps'])
    expect(next.pollIntervalSec).toBe(120)

    // 落盘生效
    const reloaded = new ConfigStore(configPath).load()
    expect(reloaded.channels).toEqual([
      { id: 'telegram', type: 'telegram', enabled: true, botToken: 'new-token', chatId: '' }
    ])
    expect(reloaded.includeKeywords).toEqual(['vps'])
  })

  it('update 返回 sanitize 后的生效值', () => {
    const store = new ConfigStore(configPath)
    store.save(cfg())
    const next = store.update({ pollIntervalSec: 5, proxyUrl: 'ftp://bad' })
    expect(next.pollIntervalSec).toBe(15)
    expect(next.proxyUrl).toBe('')
  })

  it('损坏文件：load 不抛、备份 .corrupt-{ts}、返回默认配置', async () => {
    await writeFile(configPath, '{ 这不是 JSON !!!', 'utf-8')
    const store = new ConfigStore(configPath)
    let loaded: AppConfig | null = null
    expect(() => {
      loaded = store.load()
    }).not.toThrow()
    expect(loaded).toEqual(DEFAULT_APP_CONFIG)
    const files = await readdir(dir)
    const backups = files.filter((f) => f.startsWith('config.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(dir, backups[0]!), 'utf-8')).toBe('{ 这不是 JSON !!!')
  })

  it.skipIf(process.platform === 'win32')(
    '损坏备份文件权限 0o600（darwin/linux）——备份含 bot token 等敏感信息',
    async () => {
      await writeFile(configPath, '{ 这不是 JSON !!!', 'utf-8')
      new ConfigStore(configPath).load()
      const files = await readdir(dir)
      const backup = files.find((f) => f.startsWith('config.json.corrupt-'))
      expect(backup).toBeDefined()
      expect(statSync(join(dir, backup!)).mode & 0o777).toBe(0o600)
    }
  )

  it('合法 JSON 但外层形状不对：同样备份并回默认', async () => {
    await writeFile(configPath, JSON.stringify({ includeKeywords: ['vps'] }), 'utf-8')
    const store = new ConfigStore(configPath)
    expect(store.load()).toEqual(DEFAULT_APP_CONFIG)
    expect((await readdir(dir)).some((f) => f.startsWith('config.json.corrupt-'))).toBe(true)
  })

  it('盘上合法信封缺字段：合并默认值得到完整配置（v1/v2 信封同样沿迁移链升到 v3）', async () => {
    await writeFile(
      configPath,
      JSON.stringify({ schemaVersion: 1, config: { pollIntervalSec: 45 } }),
      'utf-8'
    )
    const loaded = new ConfigStore(configPath).load()
    expect(loaded.pollIntervalSec).toBe(45)
    expect(loaded.channels).toEqual(DEFAULT_APP_CONFIG.channels)
    expect(loaded.notifyEnabled).toBe(true)
    expect(loaded.sources).toEqual([{ id: 'nodeseek', type: 'nodeseek', enabled: true }])
    expect(loaded.ai).toEqual(DEFAULT_APP_CONFIG.ai)
  })

  it('盘上 v2 信封缺字段：同样合并默认值（迁移函数透传残缺 config）', async () => {
    await writeFile(
      configPath,
      JSON.stringify({ schemaVersion: 2, config: { pollIntervalSec: 30 } }),
      'utf-8'
    )
    const loaded = new ConfigStore(configPath).load()
    expect(loaded.pollIntervalSec).toBe(30)
    expect(loaded.sources).toEqual([{ id: 'nodeseek', type: 'nodeseek', enabled: true }])
    expect(loaded.ai).toEqual(DEFAULT_APP_CONFIG.ai)
  })

  it('旧 v2 盘上 config（ai 段无 commentary）：load 后锐评默认开，其余 ai 字段保留', async () => {
    // 第三轮之前的 v2 信封：ai 有 provider/matchMode/interests/dailyReport，无 commentary
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 2,
        config: {
          pollIntervalSec: 45,
          ai: {
            provider: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk', model: 'm' },
            matchMode: 'semantic',
            interests: ['自建主机'],
            dailyReport: { enabled: false, timeHHMM: '22:00' }
          }
        }
      }),
      'utf-8'
    )
    const loaded = new ConfigStore(configPath).load()
    expect(loaded.ai.commentary).toEqual({ enabled: true, useThinking: false }) // 新增字段缺失 → 默认开 + 直出模式
    expect(loaded.ai.matchMode).toBe('semantic')
    expect(loaded.ai.provider.model).toBe('m')
  })

  it('旧 v3 盘上 config（无第五轮新字段）：load 后补默认——priceRules=[]、similarity 默认开、semanticThreshold=0', async () => {
    // 第五轮之前的 v3 信封：没有 priceRules / similarity / ai.semanticThreshold
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 3,
        config: {
          pollIntervalSec: 45,
          ai: {
            provider: { baseUrl: '', apiKey: '', model: '' },
            matchMode: 'literal',
            interests: [],
            dailyReport: { enabled: false, timeHHMM: '22:00' },
            commentary: { enabled: true }
          }
        }
      }),
      'utf-8'
    )
    const loaded = new ConfigStore(configPath).load()
    expect(loaded.pollIntervalSec).toBe(45) // 既有字段不受影响
    expect(loaded.priceRules).toEqual([]) // 新增字段缺失 → 默认（空规则）
    expect(loaded.similarity).toEqual({ enabled: true, threshold: 0.72 }) // 缺失 → 默认开
    expect(loaded.ai.semanticThreshold).toBe(0) // 缺失 → 默认 0（行为不变）
  })

  it('盘上 v3 信封（含 rss/v2ex 源）：原样加载后 sanitize 生效', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 3,
        config: {
          sources: [
            { id: 'hn', type: 'rss', enabled: true, url: 'https://hnrss.org/frontpage', label: 'HN' },
            { id: 'bad', type: 'rss', enabled: true, url: 'ftp://nope' },
            { id: 'v2ex', type: 'v2ex', enabled: false }
          ]
        }
      }),
      'utf-8'
    )
    const loaded = new ConfigStore(configPath).load()
    expect(loaded.sources).toEqual([
      { id: 'hn', type: 'rss', enabled: true, url: 'https://hnrss.org/frontpage', label: 'HN' },
      { id: 'v2ex', type: 'v2ex', enabled: false }
    ]) // 非法 url 的 rss 在 sanitize 阶段被丢弃
  })

  // ---- R6-W1 盘上读兼容（DEC-9：读时映射旧 telegram，写时只写新形状） ------------

  it('旧 v3 盘上 config（顶层 telegram、无 channels）：load 合成 channels[0]，其余字段保留', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 3,
        config: {
          pollIntervalSec: 45,
          includeKeywords: ['vps'],
          telegram: { botToken: ' 111:abc ', chatId: '-100200' },
          notifyEnabled: true
        }
      }),
      'utf-8'
    )
    const loaded = new ConfigStore(configPath).load()
    expect(loaded.pollIntervalSec).toBe(45)
    expect(loaded.includeKeywords).toEqual(['vps'])
    // 旧凭据（trim 后）映射为默认 telegram 通道的凭据
    expect(loaded.channels).toEqual([
      { id: 'telegram', type: 'telegram', enabled: true, botToken: '111:abc', chatId: '-100200' }
    ])
    // 第六轮新字段缺失 → 默认
    expect(loaded.notify).toEqual(DEFAULT_APP_CONFIG.notify)
    expect(loaded.routing).toEqual([])
  })

  it('旧 v3 无 telegram 无 channels：load 得默认空凭据 telegram 通道', async () => {
    await writeFile(
      configPath,
      JSON.stringify({ schemaVersion: 3, config: { pollIntervalSec: 45 } }),
      'utf-8'
    )
    const loaded = new ConfigStore(configPath).load()
    expect(loaded.channels).toEqual(DEFAULT_APP_CONFIG.channels)
  })

  it('盘上已有 channels（新代码写入）+ 残留 telegram 键：channels 原样、telegram 被忽略', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 3,
        config: {
          channels: [{ id: 'tg-main', type: 'telegram', enabled: true, botToken: 'new', chatId: 'c1' }],
          telegram: { botToken: 'stale-old', chatId: 'old' }
        }
      }),
      'utf-8'
    )
    const loaded = new ConfigStore(configPath).load()
    expect(loaded.channels).toEqual([
      { id: 'tg-main', type: 'telegram', enabled: true, botToken: 'new', chatId: 'c1' }
    ])
  })

  it('信封往返后旧 telegram 键消失（load 旧盘 → save 只写新形状）', async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 3,
        config: {
          pollIntervalSec: 45,
          telegram: { botToken: '111:abc', chatId: '-100200' }
        }
      }),
      'utf-8'
    )
    const store = new ConfigStore(configPath)
    const loaded = store.load()
    expect(tg0(loaded.channels).botToken).toBe('111:abc')
    store.save(loaded)
    const onDisk = JSON.parse(await readFile(configPath, 'utf-8')) as {
      schemaVersion: number
      config: Record<string, unknown>
    }
    expect(onDisk.schemaVersion).toBe(4)
    expect('telegram' in onDisk.config).toBe(false) // 旧键消失：写路径只写新形状
    expect(onDisk.config['channels']).toEqual([
      { id: 'telegram', type: 'telegram', enabled: true, botToken: '111:abc', chatId: '-100200' }
    ])
  })

  it('盘上信封 schemaVersion 未知（5）：按损坏备份并回默认', async () => {
    await writeFile(
      configPath,
      JSON.stringify({ schemaVersion: 5, config: { includeKeywords: ['vps'] } }),
      'utf-8'
    )
    const store = new ConfigStore(configPath)
    expect(store.load()).toEqual(DEFAULT_APP_CONFIG)
    expect((await readdir(dir)).some((f) => f.startsWith('config.json.corrupt-'))).toBe(true)
  })

  it('保存后没有 .tmp- 残留', async () => {
    const store = new ConfigStore(configPath)
    store.save(cfg({ includeKeywords: ['vps'] }))
    const files = await readdir(dir)
    expect(files.some((f) => f.includes('.tmp-'))).toBe(false)
    expect(files).toContain('config.json')
  })

  it.skipIf(process.platform === 'win32')('保存后文件权限 0o600（darwin/linux）', () => {
    const store = new ConfigStore(configPath)
    store.save(cfg({ channels: [{ id: 'telegram', type: 'telegram', enabled: true, botToken: 'secret', chatId: '1' }] }))
    const mode = statSync(configPath).mode & 0o777
    expect(mode).toBe(0o600)
  })
})

// ---- R9-W2 凭据加密落盘（DEC-10 / 坑10 顺序：读=先解密后 sanitize；写=先 sanitize 后加密） ---

/**
 * fake SecretBox：密文 `enc:v1:fake(<plain>)`；cipherPrefix 可自定（含空格的
 * 版本用于证明 sanitize 不会跑到密文上；不同 prefix 的 box 解不开对方的密文，
 * 用于"解密失败"场景）。
 */
function fakeSecretBox(cipherPrefix = 'fake('): SecretBox {
  return {
    isAvailable: () => true,
    encrypt: (plain) => `${SECRET_MARKER}${cipherPrefix}${plain})`,
    decrypt: (stored) => {
      if (!stored.startsWith(SECRET_MARKER)) return stored
      const inner = stored.slice(SECRET_MARKER.length)
      return inner.startsWith(cipherPrefix) && inner.endsWith(')')
        ? inner.slice(cipherPrefix.length, -1)
        : null
    }
  }
}

/** 四种敏感字段齐备的配置（telegram/bark/webhook + ai；ntfy 无敏感字段） */
function secretLadenCfg(): AppConfig {
  return cfg({
    ai: { ...cfg().ai, provider: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-live', model: 'm1' } },
    channels: [
      { id: 'telegram', type: 'telegram', enabled: true, botToken: '111:abc', chatId: '-100200' },
      { id: 'bark', type: 'bark', enabled: true, deviceKey: 'dk-1' },
      { id: 'ntfy', type: 'ntfy', enabled: true, topic: 'forumwatch' },
      { id: 'hook', type: 'webhook', enabled: true, url: 'https://example.com/hook', secret: 's3cret' }
    ]
  })
}

describe('ConfigStore × SecretBox（R9-W2 凭据加密落盘）', () => {
  it('读写往返：明文进 → 盘上密文（带 marker）→ 内存/重载均明文', async () => {
    const store = new ConfigStore(configPath, { secretBox: fakeSecretBox() })
    store.save(secretLadenCfg())

    // 盘上四种敏感字段全是密文；非敏感字段明文
    const onDisk = JSON.parse(await readFile(configPath, 'utf-8')) as {
      config: { ai: { provider: { apiKey: string } }; channels: Array<Record<string, unknown>> }
    }
    expect(onDisk.config.ai.provider.apiKey).toBe(`${SECRET_MARKER}fake(sk-live)`)
    expect(onDisk.config.channels[0]!['botToken']).toBe(`${SECRET_MARKER}fake(111:abc)`)
    expect(onDisk.config.channels[1]!['deviceKey']).toBe(`${SECRET_MARKER}fake(dk-1)`)
    expect(onDisk.config.channels[3]!['secret']).toBe(`${SECRET_MARKER}fake(s3cret)`)
    expect(onDisk.config.channels[2]!['topic']).toBe('forumwatch') // ntfy 非敏感
    // 信封不写加密标志（派生态不落盘，坑10）
    expect('secretsEncrypted' in onDisk).toBe(false)

    // 内存与重载都是明文（save 后 get 不需要重新 load）
    expect(store.get().ai.provider.apiKey).toBe('sk-live')
    const reloaded = new ConfigStore(configPath, { secretBox: fakeSecretBox() }).load()
    expect(reloaded).toEqual(sanitizeConfig(secretLadenCfg()))
    expect(reloaded.ai.provider.apiKey).toBe('sk-live')
    expect(tg0(reloaded.channels).botToken).toBe('111:abc')
  })

  it('update 后内存仍明文、盘上仍密文（update 内部走 save 同一写路径）', async () => {
    const store = new ConfigStore(configPath, { secretBox: fakeSecretBox() })
    store.save(cfg())
    const next = store.update({
      channels: [{ id: 'telegram', type: 'telegram', enabled: true, botToken: 'new-token', chatId: 'c1' }]
    })
    expect(tg0(next.channels).botToken).toBe('new-token')
    const onDisk = JSON.parse(await readFile(configPath, 'utf-8')) as {
      config: { channels: Array<Record<string, unknown>> }
    }
    expect(onDisk.config.channels[0]!['botToken']).toBe(`${SECRET_MARKER}fake(new-token)`)
  })

  it('旧明文盘兼容读：不带 marker 的值原样透传（不注入 box 的既有语义零变化）', async () => {
    // 用不加密的 store 落一份明文盘（等价于历史版本写出的文件）
    new ConfigStore(configPath).save(secretLadenCfg())
    // 用加密 box 读：明文字段无 marker → 原样
    const loaded = new ConfigStore(configPath, { secretBox: fakeSecretBox() }).load()
    expect(loaded.ai.provider.apiKey).toBe('sk-live')
    expect(tg0(loaded.channels).botToken).toBe('111:abc')
  })

  it('box 不可用（PlainSecretBox）：全程明文读写（缺省注入 = 既有测试语义）', async () => {
    const store = new ConfigStore(configPath)
    store.save(secretLadenCfg())
    const onDisk = JSON.parse(await readFile(configPath, 'utf-8')) as {
      config: { ai: { provider: { apiKey: string } } }
    }
    expect(onDisk.config.ai.provider.apiKey).toBe('sk-live') // 无 marker 明文
    const loaded = new ConfigStore(configPath).load()
    expect(loaded.ai.provider.apiKey).toBe('sk-live')
  })

  it('解密失败：字段置空（未配置）+ 整次 load 恰一条 error 日志', async () => {
    // 用 fake box 落密文盘，再用不同 prefix 的 box 读（全部解不开）
    new ConfigStore(configPath, { secretBox: fakeSecretBox() }).save(secretLadenCfg())
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const loaded = new ConfigStore(configPath, { secretBox: fakeSecretBox('other(') }).load()
      expect(loaded.ai.provider.apiKey).toBe('')
      expect(tg0(loaded.channels).botToken).toBe('')
      expect((loaded.channels[1] as { deviceKey: string }).deviceKey).toBe('')
      // webhook secret 置 '' 后被 sanitize 剔键（未配置态）
      expect('secret' in (loaded.channels[3] as object)).toBe(false)
      // 非敏感字段不受影响
      expect(loaded.ai.provider.model).toBe('m1')
      expect((loaded.channels[2] as { topic: string }).topic).toBe('forumwatch')
      // 去重：多字段失败也只报一条
      const msg = errSpy.mock.calls.map((args) => String(args[0])).filter((m) => m.includes('解密失败'))
      expect(msg).toHaveLength(1)
    } finally {
      errSpy.mockRestore()
    }
  })

  it('坑10 互操作：PlainSecretBox 读密文盘 = 字段未配置 + 一条 error（headless 语义）', () => {
    new ConfigStore(configPath, { secretBox: fakeSecretBox() }).save(secretLadenCfg())
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const loaded = new ConfigStore(configPath).load() // 缺省 PlainSecretBox
      expect(loaded.ai.provider.apiKey).toBe('')
      expect(tg0(loaded.channels).botToken).toBe('')
      expect(
        errSpy.mock.calls.some((args) => String(args[0]).includes('解密失败'))
      ).toBe(true)
    } finally {
      errSpy.mockRestore()
    }
  })

  it('坑10 写序证明：sanitize 只接触明文——输入凭据先 trim 再加密；密文含空格也原样落盘', async () => {
    // 密文含首尾空格的 box：若 sanitize 在加密之后跑，trim 会吃掉这些空格
    const spacedBox: SecretBox = {
      isAvailable: () => true,
      encrypt: (plain) => `${SECRET_MARKER} cipher ${plain} tail `,
      decrypt: (stored) => {
        if (!stored.startsWith(SECRET_MARKER)) return stored
        const inner = stored.slice(SECRET_MARKER.length)
        return inner.startsWith(' cipher ') && inner.endsWith(' tail ')
          ? inner.slice(' cipher '.length, -' tail '.length)
          : null
      }
    }
    const store = new ConfigStore(configPath, { secretBox: spacedBox })
    store.save(
      cfg({
        channels: [{ id: 'telegram', type: 'telegram', enabled: true, botToken: ' 111:abc ', chatId: '-100' }]
      })
    )
    const onDisk = JSON.parse(await readFile(configPath, 'utf-8')) as {
      config: { channels: Array<Record<string, unknown>> }
    }
    // 写序：sanitize（trim 成 111:abc）→ 加密 → 落盘（此后不再有清洗）
    expect(onDisk.config.channels[0]!['botToken']).toBe(`${SECRET_MARKER} cipher 111:abc tail `)
    // 读序：解密（还原 111:abc）→ sanitize（明文上再走一遍也不破坏）
    const loaded = new ConfigStore(configPath, { secretBox: spacedBox }).load()
    expect(tg0(loaded.channels).botToken).toBe('111:abc')
  })
})
