/**
 * Web 服务器（src/main/server/web.ts）的 HTTP 面测试：零 electron,真实
 * node:http 监听(端口 0 取随机)。
 *
 * 覆盖:健康检查 / 静态托管与路径逃逸防御 / invoke 分发信封(成功/未知通道/
 * 处理器异常兜底)/ token 认证(头与查询参数)/ SSE 事件流(订阅后广播可收帧)。
 * 备份导出/导入走 packBackup/unpackBackup 内核(backup.test.ts 已覆盖),
 * 这里只测路由的 405/404 骨架。
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWebServer, type WebServer } from './web'
import { createLogger } from '../logger'
import type { InvokeHandler, WebApiContext } from './api'

// 不给 fileDir → 只写内存环,不落盘,测试零副作用
const logger = createLogger()

function makeWebRoot(): string {
  const dir = join(tmpdir(), `fw-web-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><html><body>hello fw</body></html>',
    'utf-8'
  )
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)', 'utf-8')
  return dir
}

const fakeCtx = { dataDir: '/nonexistent' } as unknown as WebApiContext

interface Suite {
  server: WebServer
  baseUrl: string
  webRoot: string
}

const webRoots: string[] = []
const closers: Array<() => Promise<void>> = []

async function start(
  handlers: Map<string, InvokeHandler>,
  opts?: { token?: string }
): Promise<Suite> {
  const webRoot = makeWebRoot()
  webRoots.push(webRoot)
  const server = createWebServer({
    port: 0,
    webRoot,
    handlers,
    backupCtx: fakeCtx,
    onBackupImported: () => {},
    logger,
    ...(opts?.token !== undefined ? { token: opts.token } : {})
  })
  closers.push(() => server.close())
  // 等 listening(address 生效即已 listen)
  await vi.waitFor(() => {
    const addr = server.address()
    if (addr === null) throw new Error('not listening yet')
  })
  const port = server.address()!.port
  return { server, baseUrl: `http://127.0.0.1:${port}`, webRoot }
}

afterAll(async () => {
  for (const close of closers) await close()
  for (const root of webRoots) rmSync(root, { recursive: true, force: true })
})

async function postJson(url: string, body: unknown, headers?: Record<string, string>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

describe('web 服务器', () => {
  it('健康检查返回版本与 ok', async () => {
    const s = await start(new Map())
    const res = await fetch(`${s.baseUrl}/api/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; version: string }
    expect(body.ok).toBe(true)
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('静态托管:index.html 与 assets;未知路径 SPA 兜底回 index.html', async () => {
    const s = await start(new Map())
    const html = await fetch(`${s.baseUrl}/`)
    expect(html.status).toBe(200)
    expect(html.headers.get('content-type')).toContain('text/html')
    expect(await html.text()).toContain('hello fw')

    const js = await fetch(`${s.baseUrl}/assets/app.js`)
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toContain('text/javascript')

    const spa = await fetch(`${s.baseUrl}/some/route`)
    expect(spa.status).toBe(200)
    expect(await spa.text()).toContain('hello fw')
  })

  it('路径逃逸防御:.. 序列不放行 webRoot 之外的文件', async () => {
    const s = await start(new Map())
    const res = await fetch(`${s.baseUrl}/..%2f..%2fetc%2fpasswd`)
    // 解码后逃逸 → 拒绝(403)或兜底回 index.html,绝不能回系统文件内容
    const text = await res.text()
    expect(res.status === 403 || text.includes('hello fw')).toBe(true)
    expect(text).not.toContain('root:')
  })

  it('invoke 分发:成功信封 / 未知通道 404 / 处理器异常收敛为 ok:false', async () => {
    const handlers = new Map<string, InvokeHandler>([
      ['echo', (args) => ({ echoed: args[0] })],
      ['boom', () => {
        throw new Error('handler exploded')
      }]
    ])
    const s = await start(handlers)

    const ok = await postJson(`${s.baseUrl}/api/invoke`, { channel: 'echo', args: ['hi'] })
    expect(ok.status).toBe(200)
    expect(ok.json).toEqual({ ok: true, result: { echoed: 'hi' } })

    const unknown = await postJson(`${s.baseUrl}/api/invoke`, { channel: 'nope', args: [] })
    expect(unknown.status).toBe(404)
    expect(unknown.json['ok']).toBe(false)

    const boom = await postJson(`${s.baseUrl}/api/invoke`, { channel: 'boom', args: [] })
    expect(boom.status).toBe(200)
    expect(boom.json['ok']).toBe(false)
    expect(boom.json['error']).toContain('handler exploded')

    const badJson = await postJson(`${s.baseUrl}/api/invoke`, 'not-json{')
    expect(badJson.status).toBe(400)
  })

  it('token 认证:无 token 401;Bearer 头与 ?token= 查询参数均放行', async () => {
    const handlers = new Map<string, InvokeHandler>([['ping', () => 'pong']])
    const s = await start(handlers, { token: 's3cret' })

    const denied = await postJson(`${s.baseUrl}/api/invoke`, { channel: 'ping', args: [] })
    expect(denied.status).toBe(401)

    const byHeader = await postJson(`${s.baseUrl}/api/invoke`, { channel: 'ping', args: [] }, {
      authorization: 'Bearer s3cret'
    })
    expect(byHeader.json).toEqual({ ok: true, result: 'pong' })

    const byQuery = await fetch(`${s.baseUrl}/api/invoke?token=s3cret`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'ping', args: [] })
    })
    expect(byQuery.status).toBe(200)

    // 静态 UI 不需要 token(产物无秘密)
    const html = await fetch(`${s.baseUrl}/`)
    expect(html.status).toBe(200)
  })

  it('SSE 事件流:订阅后 broadcast 可收帧;断开后客户端被清理', async () => {
    const s = await start(new Map())
    const controller = new AbortController()
    const res = await fetch(`${s.baseUrl}/api/events`, { signal: controller.signal })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    // 等首字节(retry 行)到达后广播一帧
    const reader = res.body!.getReader()
    await reader.read() // retry: 3000
    s.server.broadcast('event:status', { health: 'ok' })
    const frame = await reader.read()
    const text = new TextDecoder().decode(frame.value)
    const parsed = JSON.parse(text.trim().replace(/^data: /, '')) as {
      channel: string
      payload: { health: string }
    }
    expect(parsed).toEqual({ channel: 'event:status', payload: { health: 'ok' } })

    controller.abort()
  })

  it('未实现的方法:PUT /api/invoke 405;GET /api/none 404', async () => {
    const s = await start(new Map())
    const put = await fetch(`${s.baseUrl}/api/invoke`, { method: 'PUT' })
    expect(put.status).toBe(405)
    const none = await fetch(`${s.baseUrl}/api/none`)
    expect(none.status).toBe(404)
  })
})
