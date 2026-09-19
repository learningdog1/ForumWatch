/**
 * HttpClient 单测：全部走 127.0.0.1 临时 node:http server，零外网。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { HttpClient, redactProxyUrl, resolveDispatcherSpec } from './http'

let server: http.Server
let baseUrl: string

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? '/'
    if (url === '/hello') {
      // 故意用大小写混合的 header 名，验证返回的键统一小写
      res.writeHead(200, { 'Content-Type': 'text/plain', 'X-MiXeD-CaSe': 'HeAdErVaLuE' })
      res.end('hello world')
      return
    }
    if (url === '/echo' && req.method === 'POST') {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            method: req.method,
            body: Buffer.concat(chunks).toString('utf8'),
            contentType: req.headers['content-type'] ?? null
          })
        )
      })
      return
    }
    if (url === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('too late')
      }, 300)
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections() // 掐掉 undici keep-alive 连接，否则 close() 回调不会触发
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** 找一个确定没人监听的本地端口（listen(0) 拿到后立刻关闭） */
async function findClosedPort(): Promise<number> {
  const probe = http.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address() as AddressInfo
  probe.close()
  await once(probe, 'close')
  return port
}

/** 把 Error（含 cause 链）拍平成字符串，便于对 abort/timeout 做宽容匹配 */
function flattenError(e: unknown): string {
  if (!(e instanceof Error)) return String(e)
  let s = `${e.name} ${e.message}`
  let cause = (e as Error & { cause?: unknown }).cause
  while (cause instanceof Error) {
    s += ` ${cause.name} ${cause.message}`
    cause = (cause as Error & { cause?: unknown }).cause
  }
  return s
}

describe('redactProxyUrl（日志脱敏）', () => {
  it('带 user:pass 凭据：凭据替换为 ***，scheme/host/port 保留', () => {
    expect(redactProxyUrl('http://user:pass@127.0.0.1:7890')).toBe('http://***@127.0.0.1:7890')
    expect(redactProxyUrl('socks5h://alice:s3cret@host:1080')).toBe('socks5h://***@host:1080')
    expect(redactProxyUrl('socks5://bob%40x:p%40ss@proxy.example.com')).toBe(
      'socks5://***@proxy.example.com'
    )
  })

  it('只有 user 没有 pass 的凭据同样脱敏', () => {
    expect(redactProxyUrl('http://user@proxy.example.com:8080')).toBe(
      'http://***@proxy.example.com:8080'
    )
  })

  it('无凭据：原样返回', () => {
    expect(redactProxyUrl('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
    expect(redactProxyUrl('socks5h://host:1080')).toBe('socks5h://host:1080')
  })

  it('空串/非法输入：原样返回不抛', () => {
    expect(redactProxyUrl('')).toBe('')
    expect(redactProxyUrl('garbage')).toBe('garbage')
    expect(redactProxyUrl('http://')).toBe('http://')
  })

  it('路径/查询里的 @ 不被误伤', () => {
    expect(redactProxyUrl('http://host/p@a/th?q=u@v')).toBe('http://host/p@a/th?q=u@v')
  })
})

describe('resolveDispatcherSpec（纯函数）', () => {
  it('空串 / 空白 = 直连', () => {
    expect(resolveDispatcherSpec('')).toEqual({ kind: 'direct' })
    expect(resolveDispatcherSpec('   ')).toEqual({ kind: 'direct' })
  })

  it('http:// 与 https:// → ProxyAgent', () => {
    expect(resolveDispatcherSpec('http://127.0.0.1:8080')).toEqual({
      kind: 'http-proxy',
      uri: 'http://127.0.0.1:8080'
    })
    expect(resolveDispatcherSpec('https://proxy.example.com')).toEqual({
      kind: 'http-proxy',
      uri: 'https://proxy.example.com'
    })
  })

  it('socks5:// → socks 规格，带认证与默认端口', () => {
    expect(resolveDispatcherSpec('socks5://user:pass%40x@h:1080')).toEqual({
      kind: 'socks5',
      scheme: 'socks5',
      host: 'h',
      port: 1080,
      userId: 'user',
      password: 'pass@x'
    })
    expect(resolveDispatcherSpec('socks5://1.2.3.4')).toEqual({
      kind: 'socks5',
      scheme: 'socks5',
      host: '1.2.3.4',
      port: 1080
    })
  })

  it('socks5h:// 也接受（socks 库对域名总是远端解析，行为一致）', () => {
    expect(resolveDispatcherSpec('socks5h://proxy.local:7890')).toEqual({
      kind: 'socks5',
      scheme: 'socks5h',
      host: 'proxy.local',
      port: 7890
    })
  })

  it('非法 scheme / 缺 host / 语法错误 → 抛清晰 Error', () => {
    expect(() => resolveDispatcherSpec('socks4://1.2.3.4:1080')).toThrow(/unsupported proxy scheme/)
    expect(() => resolveDispatcherSpec('ftp://1.2.3.4:21')).toThrow(/unsupported proxy scheme/)
    expect(() => resolveDispatcherSpec('not a url')).toThrow(/cannot parse/)
    // socks5 是非 special scheme，空 host 能被 URL 解析但必须拒绝
    expect(() => resolveDispatcherSpec('socks5://')).toThrow(/missing host/)
    expect(() => resolveDispatcherSpec('socks5:///only/path')).toThrow(/missing host/)
    expect(() => resolveDispatcherSpec('socks5://h:notaport')).toThrow(/cannot parse/)
  })
})

describe('HttpClient（本地 server 往返）', () => {
  it('get：status / header 键小写 / body', async () => {
    const client = new HttpClient()
    const res = await client.get(`${baseUrl}/hello`)
    expect(res.status).toBe(200)
    expect(res.headers['x-mixed-case']).toBe('HeAdErVaLuE')
    expect(res.headers['content-type']).toContain('text/plain')
    expect(Object.keys(res.headers).every((k) => k === k.toLowerCase())).toBe(true)
    expect(res.body).toBe('hello world')
    client.close()
  })

  it('post：方法 / body / 请求头透传', async () => {
    const client = new HttpClient()
    const res = await client.post(`${baseUrl}/echo`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ping: 1 })
    })
    expect(res.status).toBe(201)
    const parsed = JSON.parse(res.body) as {
      method: string
      body: string
      contentType: string
    }
    expect(parsed.method).toBe('POST')
    expect(JSON.parse(parsed.body)).toEqual({ ping: 1 })
    expect(parsed.contentType).toBe('application/json')
    client.close()
  })

  it('非 2xx 不抛错，调用方看 status', async () => {
    const client = new HttpClient()
    const res = await client.get(`${baseUrl}/nope`)
    expect(res.status).toBe(404)
    expect(res.body).toBe('not found')
    client.close()
  })

  it('timeoutMs 生效：server 睡 300ms，50ms 超时抛 Timeout/Abort', async () => {
    const client = new HttpClient()
    let caught: unknown
    await client.get(`${baseUrl}/slow`, { timeoutMs: 50 }).catch((e: unknown) => {
      caught = e
    })
    expect(caught).toBeInstanceOf(Error)
    expect(flattenError(caught)).toMatch(/timeout|abort/i)
    client.close()
  })

  it('close 后请求抛错', async () => {
    const client = new HttpClient()
    client.close()
    client.close() // 幂等
    await expect(client.get(`${baseUrl}/hello`)).rejects.toThrow(/closed/i)
  })

  it('构造期非法代理 URL → 抛错', () => {
    expect(() => new HttpClient({ proxyUrl: 'socks4://1.2.3.4:1080' })).toThrow(
      /unsupported proxy scheme/
    )
  })

  it('setProxy 热切换：非法 URL 抛错且不改状态；切换后请求确实走新 dispatcher', async () => {
    const closedPort = await findClosedPort()
    const client = new HttpClient()

    // 直连可用
    await expect(client.get(`${baseUrl}/hello`)).resolves.toMatchObject({ status: 200 })
    expect(client.activeProxyUrl).toBe('')

    // 非法 URL：抛错，状态不变，请求仍直连成功
    expect(() => client.setProxy('garbage')).toThrow(/cannot parse/)
    expect(client.activeProxyUrl).toBe('')
    await expect(client.get(`${baseUrl}/hello`)).resolves.toMatchObject({ status: 200 })

    // 切到不可达的 socks5 代理：请求走新 dispatcher（连代理失败）→ 抛错
    client.setProxy(`socks5://127.0.0.1:${closedPort}`)
    expect(client.activeProxyUrl).toBe(`socks5://127.0.0.1:${closedPort}`)
    await expect(client.get(`${baseUrl}/hello`)).rejects.toThrow()

    // 切到不可达的 http 代理：同样失败（ProxyAgent 路径）
    client.setProxy(`http://127.0.0.1:${closedPort}`)
    await expect(client.get(`${baseUrl}/hello`)).rejects.toThrow()

    // 切回直连：立即恢复
    client.setProxy('')
    expect(client.activeProxyUrl).toBe('')
    await expect(client.get(`${baseUrl}/hello`)).resolves.toMatchObject({ status: 200 })

    client.close()
  })
})
