import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG, type AppConfig, type SourceConfig } from '../../shared/types'
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

  it('telegram 凭据 trim', () => {
    const out = sanitizeConfig(cfg({ telegram: { botToken: ' 123:abc ', chatId: ' -100200 \n' } }))
    expect(out.telegram).toEqual({ botToken: '123:abc', chatId: '-100200' })
  })

  it('返回新对象，不改入参', () => {
    const input = cfg({ includeKeywords: [' vps '], pollIntervalSec: 5 })
    const snapshot = structuredClone(input)
    const out = sanitizeConfig(input)
    expect(input).toEqual(snapshot) // 入参原样
    expect(out).not.toBe(input)
    expect(out.telegram).not.toBe(input.telegram)
    expect(out.ai).not.toBe(input.ai)
    expect(out.sources).not.toBe(input.sources)
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

  it('ai.commentary：唯一默认开的布尔——缺失（旧 v2 配置）→ true，显式 false 保留，非法值 → true', () => {
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
    a.telegram.botToken = 'leak'
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
        telegram: { botToken: 'secret-token', chatId: 'c1' }
      })
    )
    const a = store.get()
    a.includeKeywords.push('leak')
    a.telegram.botToken = 'leak'
    const b = store.get()
    expect(b.includeKeywords).toEqual(['vps'])
    expect(b.telegram.botToken).toBe('secret-token')
    // save 的返回路径同样不受污染（update 内部走 get，一并验证）
    expect(store.update({}).telegram.botToken).toBe('secret-token')
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
      telegram: { botToken: '111:abc', chatId: '-100200' },
      notifyEnabled: false,
      launchAtLogin: true
    })
    new ConfigStore(configPath).save(custom)
    const loaded = new ConfigStore(configPath).load()
    expect(loaded).toEqual(sanitizeConfig(custom))
    expect(loaded.includeKeywords).toEqual(['vps', 'nas'])
    expect(loaded.telegram.chatId).toBe('-100200')
    // 盘上是带 schemaVersion 的信封
    const onDisk = JSON.parse(await readFile(configPath, 'utf-8'))
    expect(onDisk.schemaVersion).toBe(3)
    expect(onDisk.config.telegram.botToken).toBe('111:abc')
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
    expect(loaded.telegram).toEqual({ botToken: '111:abc', chatId: '-100200' })
    expect(loaded.notifyEnabled).toBe(false)
    expect(loaded.launchAtLogin).toBe(true)
    // v2 新增字段为默认值
    expect(loaded.sources).toEqual([{ id: 'nodeseek', type: 'nodeseek', enabled: true }])
    expect(loaded.ai).toEqual(DEFAULT_APP_CONFIG.ai)

    // 保存回写的是 v3 信封（迁移完成后不再回落 v1/v2）
    new ConfigStore(configPath).save(loaded)
    const onDisk = JSON.parse(await readFile(configPath, 'utf-8'))
    expect(onDisk.schemaVersion).toBe(3)
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
    expect(JSON.parse(await readFile(configPath, 'utf-8')).schemaVersion).toBe(3)
  })

  it('update：浅合并顶层字段，telegram 子对象整体替换', () => {
    const store = new ConfigStore(configPath)
    store.save(
      cfg({
        includeKeywords: ['vps'],
        pollIntervalSec: 120,
        telegram: { botToken: 'old-token', chatId: 'old-chat' }
      })
    )

    const next = store.update({ telegram: { botToken: 'new-token', chatId: '' } })
    // telegram 整体替换：chatId 被带上来的空值覆盖，不是残留 old-chat
    expect(next.telegram).toEqual({ botToken: 'new-token', chatId: '' })
    // 其他字段不受影响（浅合并）
    expect(next.includeKeywords).toEqual(['vps'])
    expect(next.pollIntervalSec).toBe(120)

    // 落盘生效
    const reloaded = new ConfigStore(configPath).load()
    expect(reloaded.telegram).toEqual({ botToken: 'new-token', chatId: '' })
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
    expect(loaded.telegram).toEqual({ botToken: '', chatId: '' })
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
    expect(loaded.ai.commentary).toEqual({ enabled: true }) // 新增字段缺失 → 默认开
    expect(loaded.ai.matchMode).toBe('semantic')
    expect(loaded.ai.provider.model).toBe('m')
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

  it('盘上信封 schemaVersion 未知（4）：按损坏备份并回默认', async () => {
    await writeFile(
      configPath,
      JSON.stringify({ schemaVersion: 4, config: { includeKeywords: ['vps'] } }),
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
    store.save(cfg({ telegram: { botToken: 'secret', chatId: '1' } }))
    const mode = statSync(configPath).mode & 0o777
    expect(mode).toBe(0o600)
  })
})
