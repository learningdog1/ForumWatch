/**
 * AiProvider 单测：post 全程注入 mock，零网络。
 * 覆盖：成功响应与请求体形状 / baseUrl 规范化 / unconfigured / 错误分类
 * （auth、rate-limit、http、network、timeout、bad-json）/ 配置热更新 /
 * redactSecret 边界 / 错误消息不含 apiKey 明文。
 */

import { describe, expect, it } from 'vitest'
import type { FetchLike, HttpRequestInit, HttpResponse } from '../net/http-types'
import type { AiProviderConfig } from '@shared/types'
import { AiProvider, AiProviderError, redactSecret } from './provider'
import type { AiProviderErrorKind } from './provider'

const defaultConfig: AiProviderConfig = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-test-key-1234567890abcdef',
  model: 'deepseek-chat'
}

const okRes: HttpResponse = {
  status: 200,
  headers: {},
  body: JSON.stringify({
    id: 'chatcmpl-x',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: '{"hit":true}' }, finish_reason: 'stop' }]
  })
}

interface Harness {
  provider: AiProvider
  /** 每次 post 的入参 */
  calls: Array<{ url: string; init?: HttpRequestInit }>
  setConfig: (c: AiProviderConfig) => void
}

/** handler(callIndex) 返回 HttpResponse 或抛错 */
function makeHarness(
  handler: (callIndex: number) => HttpResponse,
  config: AiProviderConfig = defaultConfig
): Harness {
  const calls: Array<{ url: string; init?: HttpRequestInit }> = []
  let cfg = config
  const post: FetchLike = (url, init) => {
    const idx = calls.length
    calls.push({ url, init })
    try {
      return Promise.resolve(handler(idx))
    } catch (e) {
      return Promise.reject(e)
    }
  }
  const provider = new AiProvider({ post, getConfig: () => cfg })
  return { provider, calls, setConfig: (c) => (cfg = c) }
}

/** 断言以指定 kind 的 AiProviderError reject，并返回该错误供进一步断言 */
async function expectReject(p: Promise<unknown>, kind: AiProviderErrorKind): Promise<AiProviderError> {
  let caught: unknown
  await p.catch((e: unknown) => {
    caught = e
  })
  expect(caught).toBeInstanceOf(AiProviderError)
  const err = caught as AiProviderError
  expect(err.kind).toBe(kind)
  return err
}

describe('redactSecret', () => {
  it('≤8 字符（含空串）全 ***，>8 取前3+***+后2', () => {
    expect(redactSecret('')).toBe('***')
    expect(redactSecret('abc')).toBe('***')
    expect(redactSecret('12345678')).toBe('***')
    expect(redactSecret('123456789')).toBe('123***89')
    expect(redactSecret('sk-abcdefgh12345678')).toBe('sk-***78')
  })
})

describe('AiProvider.chat', () => {
  it('成功：返回 choices[0].message.content；URL/头/请求体形状齐全，默认超时 30s', async () => {
    const h = makeHarness(() => okRes)
    const content = await h.provider.chat({ system: 'sys-prompt', user: 'user-prompt' })
    expect(content).toBe('{"hit":true}')

    expect(h.calls.length).toBe(1)
    expect(h.calls[0]?.url).toBe('https://api.deepseek.com/v1/chat/completions')
    const init = h.calls[0]?.init
    expect(init?.method).toBe('POST')
    expect(init?.headers?.Authorization).toBe(`Bearer ${defaultConfig.apiKey}`)
    expect(init?.headers?.['Content-Type']).toBe('application/json')
    expect(init?.timeoutMs).toBe(30000)
    const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>
    expect(body.model).toBe('deepseek-chat')
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys-prompt' },
      { role: 'user', content: 'user-prompt' }
    ])
    expect(body.temperature).toBe(0)
    expect(body.stream).toBe(false)
    expect(body.response_format).toBeUndefined() // 非 jsonMode 不带
    expect(body.max_tokens).toBeUndefined() // 未给 maxTokens 不带
  })

  it('jsonMode/maxTokens/timeoutMs：response_format、max_tokens、超时透传', async () => {
    const h = makeHarness(() => okRes)
    await h.provider.chat({ system: 's', user: 'u', jsonMode: true, maxTokens: 512, timeoutMs: 5000 })
    const body = JSON.parse(h.calls[0]?.init?.body ?? '{}') as Record<string, unknown>
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.max_tokens).toBe(512)
    expect(h.calls[0]?.init?.timeoutMs).toBe(5000)
  })

  it('baseUrl 规范化：尾斜杠/空白/多斜杠等价，统一拼 /chat/completions', async () => {
    const variants = [
      'https://api.deepseek.com/v1',
      'https://api.deepseek.com/v1/',
      '  https://api.deepseek.com/v1  ',
      'https://api.deepseek.com/v1//'
    ]
    for (const baseUrl of variants) {
      const h = makeHarness(() => okRes, { ...defaultConfig, baseUrl })
      await h.provider.chat({ system: 's', user: 'u' })
      expect(h.calls[0]?.url).toBe('https://api.deepseek.com/v1/chat/completions')
    }
  })

  it('unconfigured：三项任一为空（或纯空白）→ 抛 unconfigured，不调用 post', async () => {
    const empties: Array<Partial<AiProviderConfig>> = [
      { baseUrl: '' },
      { apiKey: '' },
      { model: '' },
      { baseUrl: '   ' },
      { apiKey: '   ' },
      { model: '   ' }
    ]
    for (const patch of empties) {
      const h = makeHarness(() => okRes, { ...defaultConfig, ...patch })
      const err = await expectReject(h.provider.chat({ system: 's', user: 'u' }), 'unconfigured')
      expect(err.message).toBe('AI provider not configured')
      expect(h.calls.length).toBe(0)
    }
  })

  it('配置热更新：每次调用重读 getConfig', async () => {
    const h = makeHarness(() => okRes)
    await h.provider.chat({ system: 's', user: 'u' })
    h.setConfig({ ...defaultConfig, apiKey: 'sk-another-key-999888777666' })
    await h.provider.chat({ system: 's', user: 'u' })
    expect(h.calls[1]?.init?.headers?.Authorization).toBe('Bearer sk-another-key-999888777666')
    h.setConfig({ ...defaultConfig, model: '' })
    await expectReject(h.provider.chat({ system: 's', user: 'u' }), 'unconfigured')
    expect(h.calls.length).toBe(2) // 第三次未发请求
  })

  it('401/403 → auth，消息含 status', async () => {
    for (const status of [401, 403]) {
      const h = makeHarness(() => ({ status, headers: {}, body: '{"error":{"message":"bad key"}}' }))
      const err = await expectReject(h.provider.chat({ system: 's', user: 'u' }), 'auth')
      expect(err.message).toContain(String(status))
    }
  })

  it('429 带 parameters.retry_after → rate-limit，消息含秒数', async () => {
    const h = makeHarness(() => ({
      status: 429,
      headers: {},
      body: '{"error":{"message":"rate limited"},"parameters":{"retry_after":7}}'
    }))
    const err = await expectReject(h.provider.chat({ system: 's', user: 'u' }), 'rate-limit')
    expect(err.message).toContain('retry_after=7s')
  })

  it('429 无 retry_after → rate-limit，不附秒数', async () => {
    const h = makeHarness(() => ({ status: 429, headers: {}, body: 'too many requests' }))
    const err = await expectReject(h.provider.chat({ system: 's', user: 'u' }), 'rate-limit')
    expect(err.message).not.toContain('retry_after=')
  })

  it('500 → http，消息含 status 与 body 摘录', async () => {
    const h = makeHarness(() => ({ status: 500, headers: {}, body: 'upstream boom' }))
    const err = await expectReject(h.provider.chat({ system: 's', user: 'u' }), 'http')
    expect(err.message).toContain('500')
    expect(err.message).toContain('upstream boom')
  })

  it('fetch reject → network', async () => {
    const h = makeHarness(() => {
      throw new TypeError('fetch failed: ECONNREFUSED')
    })
    const err = await expectReject(h.provider.chat({ system: 's', user: 'u' }), 'network')
    expect(err.message).toContain('ECONNREFUSED')
  })

  it("AbortError/超时异常（name 或 message 命中 abort/timeout）→ timeout，消息含超时毫秒", async () => {
    const h = makeHarness(() => {
      const e = new Error('This operation was aborted')
      e.name = 'AbortError'
      throw e
    })
    const err = await expectReject(
      h.provider.chat({ system: 's', user: 'u', timeoutMs: 1234 }),
      'timeout'
    )
    expect(err.message).toContain('1234')

    const h2 = makeHarness(() => {
      throw new Error('signal timeout exceeded') // 仅 message 命中（name 是普通 Error）
    })
    await expectReject(h2.provider.chat({ system: 's', user: 'u' }), 'timeout')
  })

  it('2xx 垃圾 JSON → bad-json', async () => {
    const h = makeHarness(() => ({ status: 200, headers: {}, body: '<html>gateway junk</html>' }))
    const err = await expectReject(h.provider.chat({ system: 's', user: 'u' }), 'bad-json')
    expect(err.message).toContain('invalid JSON')
  })

  it('2xx 但 content 缺失/非字符串 → bad-json', async () => {
    const bodies = ['{}', '{"choices":[]}', '{"choices":[{"message":{}}]}', '{"choices":[{"message":{"content":null}}]}']
    for (const body of bodies) {
      const h = makeHarness(() => ({ status: 200, headers: {}, body }))
      const err = await expectReject(h.provider.chat({ system: 's', user: 'u' }), 'bad-json')
      expect(err.message).toContain('choices[0].message.content')
    }
  })

  it('错误消息绝不包含 apiKey 明文（响应体回显密钥也被抹掉）', async () => {
    const key = 'sk-live-abcdefghijklmnop'
    const echoBody = `{"error":{"message":"invalid api key ${key}"}}`
    const h = makeHarness(() => ({ status: 500, headers: {}, body: echoBody }), {
      ...defaultConfig,
      apiKey: key
    })
    const err = await expectReject(h.provider.chat({ system: 's', user: 'u' }), 'http')
    expect(err.message).not.toContain(key)
    expect(err.message).toContain('***')
  })
})

describe('AiProvider.testConnection', () => {
  it('成功：发出最小对话（system+user）且正常返回', async () => {
    const h = makeHarness(() => okRes)
    await expect(h.provider.testConnection()).resolves.toBeUndefined()
    expect(h.calls.length).toBe(1)
    expect(h.calls[0]?.url).toBe('https://api.deepseek.com/v1/chat/completions')
    const body = JSON.parse(h.calls[0]?.init?.body ?? '{}') as { messages: Array<{ role: string }> }
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user'])
  })

  it('未配置 → unconfigured 且不发请求', async () => {
    const h = makeHarness(() => okRes, { ...defaultConfig, apiKey: '' })
    await expectReject(h.provider.testConnection(), 'unconfigured')
    expect(h.calls.length).toBe(0)
  })

  it('失败：透传 AiProviderError（已脱敏）', async () => {
    const h = makeHarness(() => ({ status: 401, headers: {}, body: 'unauthorized' }))
    const err = await expectReject(h.provider.testConnection(), 'auth')
    expect(err.message).toContain('401')
  })
})
