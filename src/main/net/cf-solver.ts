/**
 * FlareSolverr 破盾层（headless 部署专用）：Cloudflare 挑战自动求解 + 会话复用。
 *
 * 背景：headless Docker 版没有桌面版的 Electron Chromium 栈降级（runtime.ts 的
 * net.fetch B 计划），主 fetch（undici 栈）被 Cloudflare 挑战（403 / cf-mitigated:
 * challenge）后只能 ChallengeError 熔断冷却。本模块在 FetchLike 边界加一层**可选
 * 装饰器**：被挑战时把 URL 交给同机 FlareSolverr（带反检测补丁的真实 Chromium）
 * 求解，直接返回浏览器直出的响应体；同时缓存解得的 cf_clearance cookie + 配套
 * UA，后续请求优先走「直连 + 缓存会话」快路径（一次清障、多轮复用，绝不让每次
 * 请求都过浏览器）。
 *
 * 三条铁律（与 cf_clearance 的绑定语义一致）：
 * 1. **clearance 绑定 UA + IP**：直连快路径必须原样使用 FlareSolverr 返回的 UA
 *    （覆盖调用方的静态 UA 头，一个字符都不改——改 UA = clearance 立即作废）；
 *    FlareSolverr 与本容器同宿主机出口（docker NAT 同公网 IP），天然同 IP。
 * 2. **会话有有效期**（cf_clearance 约 30min~1h）：按 cookie expires 计算缓存到期，
 *    到期弃用快路径回退裸直连；直连再次被挑战则自动重新求解刷新缓存。
 * 3. **FlareSolverr 故障不致命**（宕机 / 会话被治理脚本回收 / 浏览器被 TERM）：
 *    会话级错误销毁重建一次；仍失败进入静默期——期间被挑战的请求**原样返回**
 *    （调用方的 ChallengeError 熔断语义保持不变，绝不顶风硬撞反爬）。
 *
 * 零 Electron 依赖；与 FlareSolverr 的 HTTP 通道经 FetchLike 注入（默认 undici
 * 直连），全逻辑可单测。桌面版不动（已有 Chromium 栈降级）。
 */

import type { FetchLike, HttpRequestInit, HttpResponse } from './http-types'
import { isChallengeResponse } from '../monitor/sources/challenge'

/** FlareSolverr `/v1` 返回的 solution.cookies 单项（仅取本模块关心的字段） */
interface FlareCookie {
  name?: unknown
  value?: unknown
  /** epoch 秒；-1 / 缺失 = 会话期 cookie（浏览器关闭即失效） */
  expires?: unknown
}

interface FlareSolutionRaw {
  status?: unknown
  response?: unknown
  userAgent?: unknown
  cookies?: unknown
}

/** FlareSolverr `/v1` 响应体（status=ok 时） */
interface FlareOk {
  status: 'ok'
  message: string
  solution: FlareSolutionRaw
}

/** FlareSolverr `/v1` 响应体（status=error 时） */
interface FlareErr {
  status: 'error'
  message: string
}

type FlareResponse = FlareOk | FlareErr

/** 求解产物：破盾所需的全部要素（响应体 + 可复用会话） */
export interface CfSolution {
  /** 浏览器直出的响应体（挑战已过） */
  body: string
  /** 与 cf_clearance 配套的 UA（直连复用时必须原样使用） */
  userAgent: string
  /** `name=value; name2=value2` 形式的 cookie 串（含 cf_clearance） */
  cookieHeader: string
  /** cookie 集的最早过期时刻（epoch ms）；无持久 cookie 时为 null */
  expiresAtMs: number | null
  /** 浏览器侧最终 HTTP 状态码 */
  status: number
}

/** FlareSolverr 求解失败（含「挑战未解开」/ 通道故障 / 浏览器侧仍被拒） */
export class FlareSolverrError extends Error {
  /** true = 会话/通道级故障（重建会话可能救回）；false = 确定性失败（重试无意义） */
  readonly transient: boolean

  constructor(message: string, transient = false) {
    super(message)
    this.name = 'FlareSolverrError'
    this.transient = transient
  }
}

export interface FlareSolverrOptions {
  /** FlareSolverr 基地址，含 `/v1`（如 `http://flaresolverr:8191/v1`） */
  baseUrl: string
  /** sticky 会话名（复用同一浏览器实例；空串 = 每次无会话请求，冷启动贵） */
  session?: string
  /** 单次求解预算（毫秒），传给 FlareSolverr maxTimeout；默认 60000 */
  maxTimeoutMs?: number
  /** 与 FlareSolverr 通信的 HTTP 通道（测试注入用；默认 undici 直连） */
  transport?: FetchLike
}

const DEFAULT_SOLVE_TIMEOUT_MS = 60_000
/** 通道往返的额外预算（求解 maxTimeout 之外的网络/封包开销） */
const TRANSPORT_SLACK_MS = 15_000
/** "Challenge not solved!" 这类不可重试错误的特征（FlareSolverr 文案，防御性小写匹配） */
const NOT_SOLVED_RE = /not solved/i

/**
 * 纯函数：FlareSolverr cookies → `name=value; ...` 串 + 最早过期时刻。
 * 无有效 name 的条目跳过；expires <= 0（会话期 cookie）不参与到期计算。
 * 无任何持久 cookie 时 expiresAtMs 为 null（由调用方决定默认 TTL）。
 */
export function buildCookieSession(
  cookies: FlareCookie[]
): { cookieHeader: string; expiresAtMs: number | null } {
  const parts: string[] = []
  let minExpiresSec: number | null = null
  for (const c of cookies) {
    if (typeof c?.name !== 'string' || c.name === '' || typeof c?.value !== 'string') continue
    parts.push(`${c.name}=${c.value}`)
    const exp = typeof c.expires === 'number' && Number.isFinite(c.expires) ? c.expires : 0
    if (exp > 0 && (minExpiresSec === null || exp < minExpiresSec)) {
      minExpiresSec = exp
    }
  }
  return {
    cookieHeader: parts.join('; '),
    expiresAtMs: minExpiresSec === null ? null : minExpiresSec * 1000
  }
}

/** 纯函数：FlareSolverr /v1 JSON → CfSolution；非法/未解开/浏览器侧仍被拒 → FlareSolverrError */
export function parseSolution(raw: unknown): CfSolution {
  if (typeof raw !== 'object' || raw === null) {
    throw new FlareSolverrError('flaresolverr returned non-object payload')
  }
  const res = raw as FlareResponse
  if (res.status !== 'ok' || typeof res.solution !== 'object' || res.solution === null) {
    throw new FlareSolverrError(`flaresolverr error: ${res.status === 'error' ? res.message : 'malformed payload'}`)
  }
  const sol = res.solution
  const body = typeof sol.response === 'string' ? sol.response : ''
  const userAgent = typeof sol.userAgent === 'string' ? sol.userAgent : ''
  const status = typeof sol.status === 'number' ? sol.status : 200
  if (body === '' || userAgent === '') {
    throw new FlareSolverrError('flaresolverr solution missing response/userAgent')
  }
  if (status >= 400) {
    // 浏览器过了挑战但源站仍回 4xx：不是可解的挑战（如 IP 被拉黑），如实报错
    throw new FlareSolverrError(`flaresolverr solved but origin returned status ${status}`)
  }
  const cookies = Array.isArray(sol.cookies) ? (sol.cookies as FlareCookie[]) : []
  const { cookieHeader, expiresAtMs } = buildCookieSession(cookies)
  return { body, userAgent, cookieHeader, expiresAtMs, status }
}

/**
 * FlareSolverr 客户端：sticky 会话懒建 + 会话级错误自愈（销毁重建重试一次）。
 *
 * 会话治理现实（bero69o 部署）：janitor 定时回收非白名单前缀会话、TERM 超 3h 的
 * 浏览器、容器每日重启——会话随时可能凭空消失。因此一切 request.get 错误（除
 * 「挑战未解开」这类确定性失败）都先当会话级故障处理：destroy → create → 重试
 * 一次；再失败才放弃（由上层进入静默期）。
 */
export class FlareSolverrClient {
  private readonly baseUrl: string
  private readonly session: string
  private readonly maxTimeoutMs: number
  private readonly transport: FetchLike
  private sessionReady = false

  constructor(opts: FlareSolverrOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.session = opts.session?.trim() ?? ''
    this.maxTimeoutMs = opts.maxTimeoutMs ?? DEFAULT_SOLVE_TIMEOUT_MS
    // 默认通道：undici 直连（与 HttpClient 无耦合——破盾流量不该走站点代理，
    // FlareSolverr 与站点出口本就同 IP；且避免装饰器装饰自身的递归）
    this.transport =
      opts.transport ??
      (async (url, init) => {
        const { fetch: undiciFetch } = await import('undici')
        const res = await undiciFetch(url, {
          method: init?.method ?? 'POST',
          ...(init?.headers !== undefined ? { headers: init.headers } : {}),
          ...(init?.body !== undefined ? { body: init.body } : {}),
          signal: init?.signal
        })
        const headers: Record<string, string> = {}
        res.headers.forEach((value, name) => {
          headers[name.toLowerCase()] = value
        })
        return { status: res.status, headers, body: await res.text() }
      })
  }

  /** 求解一个 URL（挑战页或被盾接口均可）；失败抛 FlareSolverrError（transient 标记可重试性） */
  async solve(url: string): Promise<CfSolution> {
    if (this.session !== '' && !this.sessionReady) {
      await this.ensureSession()
      this.sessionReady = true
    }
    try {
      return await this.requestGet(url)
    } catch (err) {
      if (!(err instanceof FlareSolverrError) || !err.transient || this.session === '') {
        throw err
      }
      // 会话级故障：销毁重建会话后重试一次（容忍 janitor 回收 / 浏览器被 TERM / 容器重启）
      await this.ensureSession()
      return await this.requestGet(url)
    }
  }

  /** 显式销毁会话（优雅退出用；无会话/已丢失安静通过） */
  async destroySession(): Promise<void> {
    if (this.session === '') return
    this.sessionReady = false
    await this.cmd('sessions.destroy').catch(() => {
      /* 会话不存在 / 通道故障都无需上抛 */
    })
  }

  /** 单次 request.get；ok → CfSolution；失败 → FlareSolverrError（transient=会话级可自愈） */
  private async requestGet(url: string): Promise<CfSolution> {
    const payload: Record<string, unknown> = {
      cmd: 'request.get',
      url,
      maxTimeout: this.maxTimeoutMs
    }
    if (this.session !== '') payload.session = this.session
    const raw = await this.cmd(JSON.stringify(payload))
    if (typeof raw === 'object' && raw !== null && (raw as FlareResponse).status === 'ok') {
      return parseSolution(raw)
    }
    const message =
      typeof raw === 'object' && raw !== null && (raw as FlareErr).message !== undefined
        ? String((raw as FlareErr).message)
        : 'malformed payload'
    if (NOT_SOLVED_RE.test(message)) {
      // 确定性失败（交互式挑战等）：重建会话也不会有不同结果，直接放弃
      throw new FlareSolverrError(`flaresolverr: ${message}`)
    }
    // 会话/浏览器/通道级错误：标记 transient，由 solve 决定是否销毁重建重试
    throw new FlareSolverrError(`flaresolverr transient: ${message}`, true)
  }

  /** 会话存在性收敛：destroy(忽略错误) → create(容忍 already exists) */
  private async ensureSession(): Promise<void> {
    await this.cmd('{"cmd":"sessions.destroy","session":' + JSON.stringify(this.session) + '}').catch(
      () => {
        /* 会话不存在属预期 */
      }
    )
    await this.cmd(
      '{"cmd":"sessions.create","session":' + JSON.stringify(this.session) + '}'
    ).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      if (!/already exist/i.test(msg)) throw err
    })
  }

  /** POST /v1；非 2xx / 坏 JSON 抛 Error；业务 JSON 原样返回（含 status:"error"） */
  private async cmd(body: string): Promise<unknown> {
    const res = await this.transport(this.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      timeoutMs: this.maxTimeoutMs + TRANSPORT_SLACK_MS
    })
    if (res.status < 200 || res.status >= 300) {
      throw new FlareSolverrError(`flaresolverr http ${res.status} at ${this.baseUrl}`, true)
    }
    try {
      return JSON.parse(res.body) as unknown
    } catch {
      throw new FlareSolverrError('flaresolverr returned non-json payload', true)
    }
  }
}

/** 直连快路径缓存的会话（per-origin） */
interface CachedSession {
  cookieHeader: string
  userAgent: string
  expiresAtMs: number
}

export interface CfSolvingFetchOptions {
  solver: FlareSolverrClient
  /** 缓存 TTL 下限（防瞬时到期抖动）；默认 60s */
  minTtlMs?: number
  /** 缓存 TTL 上限（cookie 无 expires 时的兜底有效期）；默认 45min */
  maxTtlMs?: number
  /** 求解失败后的静默期（期间被挑战请求原样返回）；默认 120s */
  failureCooldownMs?: number
  /** 测试注时钟 */
  now?: () => number
  /** 可选日志（headless 装配注入；缺省静默） */
  logger?: { info(msg: string): void; warn(msg: string): void }
}

const DEFAULT_MIN_TTL_MS = 60_000
const DEFAULT_MAX_TTL_MS = 45 * 60_000
const DEFAULT_FAILURE_COOLDOWN_MS = 120_000

/** 纯函数：origin 提取（非法 URL 返回原串作键——不因键退化而丢功能） */
function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

/** 纯函数：把缓存的会话（UA + cookie）注入请求头——UA 强制覆盖（clearance 绑定） */
function withSessionHeaders(
  init: HttpRequestInit | undefined,
  cached: CachedSession
): HttpRequestInit {
  return {
    ...init,
    headers: {
      ...init?.headers,
      'user-agent': cached.userAgent,
      cookie: cached.cookieHeader
    }
  }
}

/**
 * 破盾装饰器：包住任意 FetchLike，挑战自动经 FlareSolverr 求解。
 *
 * 请求流（对调用方完全透明）：
 * 1. 有有效缓存会话 → 直连 + 注入 UA/cookie 快路径；否则裸直连；
 * 2. 响应被挑战（isChallengeResponse，与 ChallengeError 同口径）→ 串行求解：
 *    - 成功：缓存新会话，返回浏览器直出的响应体（status/headers 取求解产物）；
 *    - 失败：静默期内原样返回被挑战响应（调用方按既有语义 ChallengeError 熔断）；
 * 3. 未被挑战 / 网络错误 → 原样返回 / 原样上抛，行为与未装饰时逐字节一致。
 *
 * 求解全局串行：FlareSolverr sticky 会话 = 单浏览器，并发命令会互相干扰；
 * 挑战是稀少事件（仅盾期发生），串行的排队代价可忽略。
 */
export class CfSolvingFetch {
  private readonly base: FetchLike
  private readonly solver: FlareSolverrClient
  private readonly minTtlMs: number
  private readonly maxTtlMs: number
  private readonly failureCooldownMs: number
  private readonly now: () => number
  private readonly logger?: { info(msg: string): void; warn(msg: string): void }
  private readonly sessions = new Map<string, CachedSession>()
  private solveChain: Promise<unknown> = Promise.resolve()
  private lastFailureAtMs = -Infinity

  constructor(base: FetchLike, opts: CfSolvingFetchOptions) {
    this.base = base
    this.solver = opts.solver
    this.minTtlMs = opts.minTtlMs ?? DEFAULT_MIN_TTL_MS
    this.maxTtlMs = opts.maxTtlMs ?? DEFAULT_MAX_TTL_MS
    this.failureCooldownMs = opts.failureCooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS
    this.now = opts.now ?? (() => Date.now())
    this.logger = opts.logger
  }

  async fetch(url: string, init?: HttpRequestInit): Promise<HttpResponse> {
    const origin = originOf(url)
    const cached = this.validSession(origin)
    const res = await this.base(url, cached !== null ? withSessionHeaders(init, cached) : init)
    if (!isChallengeResponse(res.status, res.headers)) {
      return res
    }
    const solved = await this.enqueueSolve(url, origin)
    return solved ?? res
  }

  /** 有效（未过期）的缓存会话；过期即删（惰性回收） */
  private validSession(origin: string): CachedSession | null {
    const cached = this.sessions.get(origin)
    if (cached === undefined) return null
    if (cached.expiresAtMs <= this.now()) {
      this.sessions.delete(origin)
      return null
    }
    return cached
  }

  /** 全局串行求解（同一时刻至多一个浏览器命令在飞） */
  private enqueueSolve(url: string, origin: string): Promise<HttpResponse | null> {
    const run = this.solveChain.then(
      () => this.solveOnce(url, origin),
      () => this.solveOnce(url, origin)
    )
    // 链只承载互斥语义，不向外传播前序错误
    this.solveChain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async solveOnce(url: string, origin: string): Promise<HttpResponse | null> {
    const nowMs = this.now()
    if (nowMs - this.lastFailureAtMs < this.failureCooldownMs) {
      return null
    }
    try {
      const sol = await this.solver.solve(url)
      const expiresAtMs = Math.min(
        Math.max(sol.expiresAtMs ?? nowMs + this.maxTtlMs, nowMs + this.minTtlMs),
        nowMs + this.maxTtlMs
      )
      this.sessions.set(origin, {
        cookieHeader: sol.cookieHeader,
        userAgent: sol.userAgent,
        expiresAtMs
      })
      this.logger?.info(
        `cf-solver: challenge solved via flaresolverr (${origin}); session cached for ${Math.round((expiresAtMs - nowMs) / 1000)}s`
      )
      return {
        status: sol.status,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: sol.body
      }
    } catch (err) {
      this.lastFailureAtMs = nowMs
      const msg = err instanceof Error ? err.message : String(err)
      this.logger?.warn(
        `cf-solver: flaresolverr solve failed (${origin}): ${msg}; backing off ${Math.round(this.failureCooldownMs / 1000)}s (challenge passthrough)`
      )
      return null
    }
  }
}

/** 装饰器工厂：返回与底层同签名的 FetchLike（headless 装配处一行接线） */
export function createCfSolvingFetch(
  base: FetchLike,
  opts: CfSolvingFetchOptions
): FetchLike {
  const impl = new CfSolvingFetch(base, opts)
  return (url, init) => impl.fetch(url, init)
}
