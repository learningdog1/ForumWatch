import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG, type AppConfig } from '../../shared/types'
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
    expect(onDisk.schemaVersion).toBe(1)
    expect(onDisk.config.telegram.botToken).toBe('111:abc')
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

  it('盘上合法信封缺字段：合并默认值得到完整配置', async () => {
    await writeFile(
      configPath,
      JSON.stringify({ schemaVersion: 1, config: { pollIntervalSec: 45 } }),
      'utf-8'
    )
    const loaded = new ConfigStore(configPath).load()
    expect(loaded.pollIntervalSec).toBe(45)
    expect(loaded.telegram).toEqual({ botToken: '', chatId: '' })
    expect(loaded.notifyEnabled).toBe(true)
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
