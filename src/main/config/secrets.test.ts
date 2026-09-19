import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG, type AppConfig } from '../../shared/types'
import {
  decryptSecretFields,
  encryptSecretFields,
  PlainSecretBox,
  SECRET_FIELD_PATHS,
  SECRET_MARKER,
  type SecretBox
} from './secrets'

/** 构造一份带全部四种敏感字段（+ 无敏感字段的 ntfy 通道）的配置 */
function cfg(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...structuredClone(DEFAULT_APP_CONFIG), ...overrides }
}

function fullSecretsCfg(): AppConfig {
  return cfg({
    ai: {
      ...cfg().ai,
      provider: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-live', model: 'm1' }
    },
    channels: [
      { id: 'tg', type: 'telegram', enabled: true, botToken: '111:abc', chatId: '-100' },
      { id: 'bark', type: 'bark', enabled: true, deviceKey: 'dk-1', serverUrl: 'https://bark.example.com' },
      { id: 'ntfy', type: 'ntfy', enabled: true, topic: 'forumwatch' },
      { id: 'hook', type: 'webhook', enabled: true, url: 'https://example.com/hook', secret: 's3cret' }
    ]
  })
}

/**
 * 可配置 fake box：密文形状 `enc:v1:<prefix><plain>)`（prefix 可自定，
 * 供"换一个解不开的 box"场景用）；decrypt 不认的密文 → null。
 */
function fakeBox(prefix = 'fake('): SecretBox {
  return {
    isAvailable: () => true,
    encrypt: (plain) => `${SECRET_MARKER}${prefix}${plain})`,
    decrypt: (stored) => {
      if (!stored.startsWith(SECRET_MARKER)) return stored
      const inner = stored.slice(SECRET_MARKER.length)
      return inner.startsWith(prefix) && inner.endsWith(')') ? inner.slice(prefix.length, -1) : null
    }
  }
}

describe('PlainSecretBox', () => {
  it('isAvailable()=false、encrypt→null（调用方存明文）', () => {
    const box = new PlainSecretBox()
    expect(box.isAvailable()).toBe(false)
    expect(box.encrypt('anything')).toBeNull()
  })

  it('decrypt：不带 marker 原样返回（明文兼容）；带 marker → null（坑10：密文=未配置）', () => {
    const box = new PlainSecretBox()
    expect(box.decrypt('plain-token')).toBe('plain-token')
    expect(box.decrypt('')).toBe('')
    expect(box.decrypt(`${SECRET_MARKER}base64ciphertext`)).toBeNull()
  })
})

describe('SECRET_FIELD_PATHS', () => {
  it('单一事实源覆盖四种通道敏感字段（telegram/bark/webhook + ai）', () => {
    expect(SECRET_FIELD_PATHS).toContain('ai.provider.apiKey')
    expect(SECRET_FIELD_PATHS).toContain('channels[].botToken') // telegram
    expect(SECRET_FIELD_PATHS).toContain('channels[].deviceKey') // bark
    expect(SECRET_FIELD_PATHS).toContain('channels[].secret') // webhook
    expect(SECRET_FIELD_PATHS).toHaveLength(4)
  })
})

describe('encryptSecretFields', () => {
  it('字段表全覆盖：apiKey/botToken/deviceKey/secret 加密带 marker，ntfy 与非敏感字段不动', () => {
    const input = fullSecretsCfg()
    const out = encryptSecretFields(input, fakeBox())
    expect(out.ai.provider.apiKey).toBe(`${SECRET_MARKER}fake(sk-live)`)
    expect((out.channels[0] as { botToken: string }).botToken).toBe(`${SECRET_MARKER}fake(111:abc)`)
    expect((out.channels[1] as { deviceKey: string }).deviceKey).toBe(`${SECRET_MARKER}fake(dk-1)`)
    expect((out.channels[3] as { secret?: string }).secret).toBe(`${SECRET_MARKER}fake(s3cret)`)
    // ntfy 无敏感字段：整项原引用复用
    expect(out.channels[2]).toBe(input.channels[2])
    // 非敏感字段不动
    expect(out.ai.provider.baseUrl).toBe('https://api.example.com/v1')
    expect(out.ai.provider.model).toBe('m1')
    expect((out.channels[0] as { chatId: string }).chatId).toBe('-100')
    expect((out.channels[3] as { url: string }).url).toBe('https://example.com/hook')
  })

  it('双加密防护：已带 marker 的字段跳过（不二次加密）', () => {
    const already = fullSecretsCfg()
    already.ai.provider.apiKey = `${SECRET_MARKER}fake(sk-live)`
    ;(already.channels[0] as { botToken: string }).botToken = `${SECRET_MARKER}fake(111:abc)`
    const out = encryptSecretFields(already, fakeBox())
    expect(out.ai.provider.apiKey).toBe(`${SECRET_MARKER}fake(sk-live)`)
    expect((out.channels[0] as { botToken: string }).botToken).toBe(`${SECRET_MARKER}fake(111:abc)`)
  })

  it('空字段不加密（未配置态原样保留）', () => {
    const input = cfg() // 默认配置：apiKey/botToken 全空
    const out = encryptSecretFields(input, fakeBox())
    expect(out.ai.provider.apiKey).toBe('')
    expect(out.channels).toEqual(DEFAULT_APP_CONFIG.channels)
  })

  it('box 不可用：原样返回（明文存储降级）', () => {
    const input = fullSecretsCfg()
    const out = encryptSecretFields(input, new PlainSecretBox())
    expect(out).toEqual(input)
  })

  it('不改入参（返回新对象）', () => {
    const input = fullSecretsCfg()
    const snapshot = structuredClone(input)
    encryptSecretFields(input, fakeBox())
    expect(input).toEqual(snapshot)
  })
})

describe('decryptSecretFields', () => {
  it('读写内核往返：加密结果可解回明文（四种字段 + marker 识别）', () => {
    const plain = fullSecretsCfg()
    const round = decryptSecretFields(encryptSecretFields(plain, fakeBox()), fakeBox())
    expect(round).toEqual(plain)
  })

  it('明文盘兼容：不带 marker 的值原样透传', () => {
    const plain = fullSecretsCfg()
    const out = decryptSecretFields(plain, fakeBox())
    expect(out).toEqual(plain)
  })

  it('解密失败置空串，report.anyFailed=true（整次调用一个标志，调用方据此报一条 error）', () => {
    const input = encryptSecretFields(fullSecretsCfg(), fakeBox())
    // 换一个解不开的 box（prefix 不同）：全部密文 → null
    const report: { anyFailed: boolean } = { anyFailed: false }
    const out = decryptSecretFields(input, fakeBox('other('), report)
    expect(report.anyFailed).toBe(true)
    expect(out.ai.provider.apiKey).toBe('')
    expect((out.channels[0] as { botToken: string }).botToken).toBe('')
    expect((out.channels[1] as { deviceKey: string }).deviceKey).toBe('')
    expect((out.channels[3] as { secret?: string }).secret).toBe('')
    // 非敏感字段不受解密失败影响
    expect(out.ai.provider.model).toBe('m1')
    expect((out.channels[3] as { url: string }).url).toBe('https://example.com/hook')
  })

  it('混合盘：部分明文部分密文——明文原样、密文正常解', () => {
    const mixed = fullSecretsCfg()
    mixed.ai.provider.apiKey = `${SECRET_MARKER}fake(sk-live)`
    // botToken 保持明文
    const out = decryptSecretFields(mixed, fakeBox())
    expect(out.ai.provider.apiKey).toBe('sk-live')
    expect((out.channels[0] as { botToken: string }).botToken).toBe('111:abc')
  })

  it('PlainSecretBox 读密文：字段置空串 + anyFailed（坑10 headless 互操作语义）', () => {
    const input = encryptSecretFields(fullSecretsCfg(), fakeBox())
    const report: { anyFailed: boolean } = { anyFailed: false }
    const out = decryptSecretFields(input, new PlainSecretBox(), report)
    expect(out.ai.provider.apiKey).toBe('')
    expect((out.channels[0] as { botToken: string }).botToken).toBe('')
    expect(report.anyFailed).toBe(true)
    // 同一个 PlainSecretBox 读明文：不置失败标志
    const report2: { anyFailed: boolean } = { anyFailed: false }
    decryptSecretFields(fullSecretsCfg(), new PlainSecretBox(), report2)
    expect(report2.anyFailed).toBe(false)
  })

  it('webhook secret 缺键（可选字段）与空字符串：不动、不报失败', () => {
    const input = fullSecretsCfg()
    delete (input.channels[3] as { secret?: string }).secret
    const report: { anyFailed: boolean } = { anyFailed: false }
    const out = decryptSecretFields(input, fakeBox(), report)
    expect('secret' in (out.channels[3] as object)).toBe(false)
    expect(report.anyFailed).toBe(false)
  })

  it('不改入参（返回新对象）', () => {
    const input = encryptSecretFields(fullSecretsCfg(), fakeBox())
    const snapshot = structuredClone(input)
    decryptSecretFields(input, fakeBox())
    expect(input).toEqual(snapshot)
  })
})
