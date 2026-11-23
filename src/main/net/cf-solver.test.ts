import { describe, expect, it } from 'vitest'
import {
  buildCookieSession,
  CfSolvingFetch,
  createCfSolvingFetch,
  FlareSolverrClient,
  FlareSolverrError,
  parseSolution
} from './cf-solver'
import type { FetchLike, HttpRequestInit, HttpResponse } from './http-types'

/** 假 FlareSolverr 端点：记录命令序列，按脚本出响应 */
class FakeFlareSolverr {
  readonly calls: Array<Record<string, unknown>> = []
  /** request.get 的应答脚本（按序消费；耗尽后重复最后一项） */
  script: Array<HttpResponse | Error> = []

  readonly transport: FetchLike = async (_url, init) => {
    const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>
    this.calls.push(body)
    const cmd = body['cmd']
    if (cmd === 'sessions.create' || cmd === 'sessions.destroy') {
      return { status: 200, headers: {}, body: JSON.stringify({ status: 'ok', message: '' }) }
    }
    const next = this.script.shift() ?? this.script[this.script.length - 1]
    if (next instanceof Error) throw next
    return next
  }

  get requestCalls(): Array<Record<string, unknown>> {
    return this.calls.filter((c) => c['cmd'] === 'request.get')
  }
}

function okSolution(overrides: Partial<{
  response: string
  userAgent: string
  cookies: Array<{ name: string; value: string; expires?: number }>
  status: number
}> = {}): HttpResponse {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({
      status: 'ok',
      message: 'Challenge solved!',
      solution: {
        url: 'https://www.nodeseek.com/',
        status: overrides.status ?? 200,
        response: overrides.response ?? '<html>ok</html>',
        cookies: overrides.cookies ?? [
          { name: 'cf_clearance', value: 'clr-1', expires: 4_000_000_000 },
          { name: 'session', value: 'abc' }
        ],
        userAgent: overrides.userAgent ?? 'Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0.0.0'
      }
    })
  }
}

function errPayload(message: string): HttpResponse {
  return { status: 200, headers: {}, body: JSON.stringify({ status: 'error', message }) }
}

const CHALLENGED: HttpResponse = {
  status: 403,
  headers: { 'cf-mitigated': 'challenge' },
  body: '<html>Just a moment...</html>'
}

/** 可编程假站点 fetch：按 URL 首次挑战、带对 cookie/UA 即放行 */
class FakeSite {
  readonly seen: Array<{ url: string; init?: HttpRequestInit }> = []
  /** 判定函数：给 (url, init) 返回响应；默认按 cookie 是否含 cf_clearance 放行 */
  respond: (url: string, init?: HttpRequestInit) => Promise<HttpResponse> = async (_url, init) => {
    const cookie = init?.headers?.['cookie'] ?? ''
    if (cookie.includes('cf_clearance')) {
      return { status: 200, headers: { 'content-type': 'text/html' }, body: '<html>pass</html>' }
    }
    return CHALLENGED
  }

  readonly fetch: FetchLike = async (url, init) => {
    this.seen.push({ url, init })
    return this.respond(url, init)
  }
}

describe('buildCookieSession（cookie 串与到期计算）', () => {
  it('拼 name=value 串，取最早持久 expires（秒→毫秒）', () => {
    const { cookieHeader, expiresAtMs } = buildCookieSession([
      { name: 'cf_clearance', value: 'a', expires: 3000 },
      { name: 'sid', value: 'b', expires: 2000 },
      { name: 'ephemeral', value: 'c', expires: -1 }
    ])
    expect(cookieHeader).toBe('cf_clearance=a; sid=b; ephemeral=c')
    expect(expiresAtMs).toBe(2_000_000)
  })

  it('无持久 cookie → expiresAtMs null；无名字条目跳过', () => {
    const { cookieHeader, expiresAtMs } = buildCookieSession([
      { name: 'sid', value: 'x' },
      { name: '', value: 'y' },
      { value: 'z' }
    ])
    expect(cookieHeader).toBe('sid=x')
    expect(expiresAtMs).toBeNull()
  })
})

describe('parseSolution（/v1 载荷解析）', () => {
  it('ok 载荷 → CfSolution', () => {
    const sol = parseSolution(JSON.parse(okSolution().body))
    expect(sol.body).toBe('<html>ok</html>')
    expect(sol.cookieHeader).toContain('cf_clearance=clr-1')
    expect(sol.status).toBe(200)
    expect(sol.expiresAtMs).toBe(4_000_000_000 * 1000)
  })

  it('error 载荷 / 非 object / 缺 response / 缺 userAgent → FlareSolverrError', () => {
    expect(() => parseSolution({ status: 'error', message: 'boom' })).toThrow(FlareSolverrError)
    expect(() => parseSolution('x')).toThrow(FlareSolverrError)
    expect(() =>
      parseSolution({ status: 'ok', solution: { response: '', userAgent: 'ua' } })
    ).toThrow(FlareSolverrError)
    expect(() =>
      parseSolution({ status: 'ok', solution: { response: 'body', userAgent: '' } })
    ).toThrow(FlareSolverrError)
  })

  it('浏览器侧仍 4xx（求解成功但源站拒绝）→ 报错不计成功', () => {
    expect(() =>
      parseSolution(JSON.parse(okSolution({ status: 403 }).body))
    ).toThrow(/status 403/)
  })
})

describe('FlareSolverrClient（会话生命周期）', () => {
  it('首次 solve 懒建会话：sessions.destroy→create→request.get 一次到位', async () => {
    const fake = new FakeFlareSolverr()
    fake.script = [okSolution()]
    const client = new FlareSolverrClient({
      baseUrl: 'http://fs:8191/v1',
      session: 'forumwatch',
      transport: fake.transport
    })
    const sol = await client.solve('https://www.nodeseek.com/')
    expect(sol.cookieHeader).toContain('cf_clearance=clr-1')
    const cmds = fake.calls.map((c) => c['cmd'])
    expect(cmds).toEqual(['sessions.destroy', 'sessions.create', 'request.get'])
    // 二次 solve 复用会话（不再 create）
    fake.script = [okSolution()]
    await client.solve('https://www.nodeseek.com/post-1-1')
    expect(fake.calls.filter((c) => c['cmd'] === 'sessions.create')).toHaveLength(1)
  })

  it('会话级错误（Session not found）→ 销毁重建后重试一次成功', async () => {
    const fake = new FakeFlareSolverr()
    fake.script = [errPayload('Error: Session does not exist'), okSolution()]
    const client = new FlareSolverrClient({
      baseUrl: 'http://fs:8191/v1',
      session: 'forumwatch',
      transport: fake.transport
    })
    const sol = await client.solve('https://www.nodeseek.com/')
    expect(sol.body).toBe('<html>ok</html>')
    // 首建 create ×1 + 重建 destroy/create ×1
    expect(fake.calls.filter((c) => c['cmd'] === 'sessions.create')).toHaveLength(2)
    expect(fake.requestCalls).toHaveLength(2)
  })

  it('"Challenge not solved!"（确定性失败）→ 不重建会话直接抛', async () => {
    const fake = new FakeFlareSolverr()
    fake.script = [errPayload('Error: Challenge not solved! Error: Detected as a bot')]
    const client = new FlareSolverrClient({
      baseUrl: 'http://fs:8191/v1',
      session: 'forumwatch',
      transport: fake.transport
    })
    await expect(client.solve('https://www.nodeseek.com/')).rejects.toThrow(/not solved/)
    expect(fake.calls.filter((c) => c['cmd'] === 'request.get')).toHaveLength(1)
  })

  it('通道 HTTP 500 属 transient：重建重试一次，再失败放弃', async () => {
    const fake = new FakeFlareSolverr()
    fake.script = [
      { status: 500, headers: {}, body: 'oops' },
      { status: 500, headers: {}, body: 'oops' }
    ]
    const client = new FlareSolverrClient({
      baseUrl: 'http://fs:8191/v1',
      session: 'forumwatch',
      transport: fake.transport
    })
    await expect(client.solve('https://x/')).rejects.toThrow(FlareSolverrError)
    expect(fake.calls.filter((c) => c['cmd'] === 'request.get')).toHaveLength(2)
  })
})

describe('CfSolvingFetch（挑战自动破盾装饰器）', () => {
  function mkMocks(): { fake: FakeFlareSolverr; site: FakeSite } {
    const fake = new FakeFlareSolverr()
    fake.script = [okSolution()]
    return { fake, site: new FakeSite() }
  }

  function mk(opts: Partial<Parameters<typeof createCfSolvingFetch>[1]> & {
    base?: FetchLike
    solver?: FlareSolverrClient
  } = {}): { fetch: FetchLike; fake: FakeFlareSolverr; site: FakeSite } {
    const { fake, site } = mkMocks()
    const solver =
      opts.solver ??
      new FlareSolverrClient({
        baseUrl: 'http://fs:8191/v1',
        session: 'forumwatch',
        transport: fake.transport
      })
    const base = opts.base ?? site.fetch
    const impl = new CfSolvingFetch(base, {
      solver,
      now: opts.now ?? (() => 1_000_000),
      minTtlMs: opts.minTtlMs ?? 60_000,
      maxTtlMs: opts.maxTtlMs ?? 45 * 60_000,
      failureCooldownMs: opts.failureCooldownMs ?? 120_000
    })
    return { fetch: (url, init) => impl.fetch(url, init), fake, site }
  }

  it('未配置挑战：普通响应原样透传，不碰 solver', async () => {
    const { fetch, fake, site } = mk()
    site.respond = async () => ({ status: 200, headers: {}, body: 'plain' })
    const res = await fetch('https://www.nodeseek.com/')
    expect(res.body).toBe('plain')
    expect(fake.calls).toHaveLength(0)
  })

  it('被挑战 → FlareSolverr 求解并返回浏览器直出响应体', async () => {
    const { fetch } = mk()
    const res = await fetch('https://www.nodeseek.com/')
    expect(res.status).toBe(200)
    expect(res.body).toBe('<html>ok</html>')
  })

  it('求解成功后：后续请求走直连快路径（注入 solver 返回的原样 UA + cookie），不再求解', async () => {
    const { fetch, fake, site } = mk()
    await fetch('https://www.nodeseek.com/')
    expect(fake.requestCalls).toHaveLength(1)
    const res = await fetch('https://www.nodeseek.com/post-1-1')
    expect(res.body).toBe('<html>pass</html>')
    expect(fake.requestCalls).toHaveLength(1) // 没有再解
    const init = site.seen[site.seen.length - 1]?.init
    expect(init?.headers?.['user-agent']).toBe(
      'Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0.0.0'
    )
    expect(init?.headers?.['cookie']).toContain('cf_clearance=clr-1')
  })

  it('缓存到期（时钟推进越过 expires）→ 弃用快路径头，裸直连', async () => {
    let now = 1_000_000
    const { fetch, site } = mk({ now: () => now })
    await fetch('https://www.nodeseek.com/')
    now = 1_000_000 + 46 * 60_000 // 越过 maxTtl 兜底
    await fetch('https://www.nodeseek.com/')
    const init = site.seen[site.seen.length - 1]?.init
    expect(init?.headers?.['cookie']).toBeUndefined()
  })

  it('快路径会话失效（带旧 cookie 仍被挑战）→ 自动重新求解刷新', async () => {
    const fake = new FakeFlareSolverr()
    fake.script = [
      okSolution({ cookies: [{ name: 'cf_clearance', value: 'old', expires: 4_000_000_000 }] }),
      okSolution({ cookies: [{ name: 'cf_clearance', value: 'new', expires: 4_000_000_000 }] })
    ]
    const site = new FakeSite()
    const solver = new FlareSolverrClient({
      baseUrl: 'http://fs:8191/v1',
      session: 'forumwatch',
      transport: fake.transport
    })
    const impl = new CfSolvingFetch(site.fetch, { solver, now: () => 1_000_000 })
    const fetch = (url: string, init?: HttpRequestInit) => impl.fetch(url, init)

    await fetch('https://www.nodeseek.com/') // 首次挑战 → 解出 old
    site.respond = async (_url, init) => {
      // 服务端注销了 old：带 old 一律挑战，带 new 放行
      return (init?.headers?.['cookie'] ?? '').includes('new')
        ? { status: 200, headers: {}, body: '<html>pass2</html>' }
        : CHALLENGED
    }
    const res = await fetch('https://www.nodeseek.com/') // 快路径被拒 → 重解 → new
    expect(res.body).toBe('<html>ok</html>')
    const res2 = await fetch('https://www.nodeseek.com/') // 新会话直连放行
    expect(res2.body).toBe('<html>pass2</html>')
    expect(fake.requestCalls).toHaveLength(2)
  })

  it('求解失败 → 原样返回被挑战响应（调用方按 ChallengeError 熔断），静默期内不再撞 solver', async () => {
    const fake = new FakeFlareSolverr()
    fake.script = [{ status: 503, headers: {}, body: 'down' }]
    const site = new FakeSite()
    const solver = new FlareSolverrClient({
      baseUrl: 'http://fs:8191/v1',
      session: 'forumwatch',
      transport: fake.transport
    })
    const impl = new CfSolvingFetch(site.fetch, {
      solver,
      now: () => 1_000_000,
      failureCooldownMs: 120_000
    })
    const fetch = (url: string, init?: HttpRequestInit) => impl.fetch(url, init)

    const res = await fetch('https://www.nodeseek.com/')
    expect(res.status).toBe(403) // 原样
    const res2 = await fetch('https://www.nodeseek.com/')
    expect(res2.status).toBe(403) // 静默期内零 solver 调用
    expect(fake.requestCalls).toHaveLength(2) // 首次（destroy/create + get + 重试 get）后即静默
  })

  it('base 网络错误原样上抛（不吞不改）', async () => {
    const { fetch } = mk({
      base: async () => {
        throw new Error('ECONNRESET')
      }
    })
    await expect(fetch('https://www.nodeseek.com/')).rejects.toThrow('ECONNRESET')
  })
})
