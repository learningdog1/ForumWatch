/**
 * 统一 HTTP 客户端（ADR 6）：npm undici 8 的 fetch，支持 http(s)/socks5 代理与运行时热切换。
 *
 * - 统一用 npm undici 的 fetch（不用 Node 全局 fetch——全局是内置 undici 6，跨版本塞
 *   dispatcher 有兼容风险）。
 * - dispatcher 选择：'' → 不传（undici 全局默认 Agent，直连）；http(s):// → ProxyAgent；
 *   socks5:// / socks5h:// → fetch-socks 的 socksDispatcher（注意导出名是小写 s 开头）。
 * - 关于 socks5 与 socks5h：socks 库对非 IP 的目标主机名总是以 domain 形式发给代理端
 *   解析（Socks5HostType.Hostname），因此两种 scheme 在本实现里行为一致（远端 DNS）。
 * - 超时用 AbortSignal.timeout()，外部 signal 通过 AbortSignal.any 合并（Node >= 20.3；
 *   若运行时缺失 AbortSignal.any 则以 timeout 为准——外部 signal 不生效，属已知取舍）。
 * - 非 2xx 不抛错：调用方检查 status。
 */

import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'
import { socksDispatcher } from 'fetch-socks'
import type { HttpRequestInit, HttpResponse } from './http-types'

export interface HttpClientOptions {
  /** 代理 URL：'' = 直连；支持 http:// https:// socks5:// socks5h:// */
  proxyUrl?: string
  /** 默认请求超时（毫秒），可被 init.timeoutMs 覆盖 */
  defaultTimeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15000
/** socks URL 未写端口时的默认端口（社区惯例） */
const SOCKS_DEFAULT_PORT = 1080

/** 代理解析结果：纯函数 resolveDispatcherSpec 的输出，单测直接覆盖 */
export type DispatcherSpec =
  | { kind: 'direct' }
  | { kind: 'http-proxy'; uri: string }
  | {
      kind: 'socks5'
      scheme: 'socks5' | 'socks5h'
      host: string
      port: number
      userId?: string
      password?: string
    }

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * 解析代理 URL 为 dispatcher 构造规格（纯函数，不产生副作用）。
 * '' → direct；http/https → ProxyAgent；socks5/socks5h → fetch-socks。
 * 非法输入（不支持的 scheme / 缺 host / URL 语法错误）抛 Error，消息带原文。
 */
export function resolveDispatcherSpec(proxyUrl: string): DispatcherSpec {
  const trimmed = proxyUrl.trim()
  if (trimmed === '') {
    return { kind: 'direct' }
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`invalid proxy url (cannot parse): ${proxyUrl}`)
  }
  if (!url.hostname) {
    throw new Error(`invalid proxy url (missing host): ${proxyUrl}`)
  }

  switch (url.protocol) {
    case 'http:':
    case 'https:':
      // ProxyAgent 支持 uri 里带 user:pass（自动转 Proxy-Authorization basic）
      return { kind: 'http-proxy', uri: trimmed }

    case 'socks5:':
    case 'socks5h:': {
      const port = url.port === '' ? SOCKS_DEFAULT_PORT : Number(url.port)
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`invalid proxy url (bad port): ${proxyUrl}`)
      }
      return {
        kind: 'socks5',
        scheme: url.protocol === 'socks5:' ? 'socks5' : 'socks5h',
        host: url.hostname,
        port,
        ...(url.username !== '' ? { userId: safeDecode(url.username) } : {}),
        ...(url.password !== '' ? { password: safeDecode(url.password) } : {})
      }
    }

    default:
      throw new Error(
        `unsupported proxy scheme "${url.protocol}" (expected http://, https://, socks5:// or socks5h://): ${proxyUrl}`
      )
  }
}

/** 按 spec 创建 dispatcher；direct 返回 null（undici fetch 不传 dispatcher 即用默认直连） */
function createDispatcher(spec: DispatcherSpec): Dispatcher | null {
  switch (spec.kind) {
    case 'direct':
      return null
    case 'http-proxy':
      return new ProxyAgent({ uri: spec.uri })
    case 'socks5':
      // fetch-socks 的参数是 socks 库的 SocksProxy 形状：{ host, port, type: 4|5, userId?, password? }
      return socksDispatcher({
        host: spec.host,
        port: spec.port,
        type: 5,
        ...(spec.userId !== undefined ? { userId: spec.userId } : {}),
        ...(spec.password !== undefined ? { password: spec.password } : {})
      })
  }
}

function mergeSignals(external: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (!external) {
    return timeoutSignal
  }
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([external, timeoutSignal])
  }
  // 已知取舍：老运行时无 AbortSignal.any 时仅 timeout 生效（外部 signal 被忽略）
  return timeoutSignal
}

export class HttpClient {
  private readonly defaultTimeoutMs: number
  private dispatcher: Dispatcher | null
  private proxyUrl: string
  private closed = false

  constructor(opts: HttpClientOptions = {}) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.proxyUrl = opts.proxyUrl ?? ''
    // 非法代理 URL 在构造期就抛，fail-fast
    this.dispatcher = createDispatcher(resolveDispatcherSpec(this.proxyUrl))
  }

  /** 当前生效的代理 URL（'' = 直连）；测试与集成方可用于观察热切换结果 */
  get activeProxyUrl(): string {
    return this.proxyUrl
  }

  /**
   * 运行时热切换代理（ADR 6：配置变更时销毁重建 dispatcher）。
   * '' = 切回直连。非法 URL 抛 Error 且不改动现有状态。
   * 旧 dispatcher 异步 destroy（进行中的请求会被中断）；未完成请求的归属由调用方自行容忍。
   */
  setProxy(proxyUrl: string): void {
    const trimmed = proxyUrl.trim()
    const next = createDispatcher(resolveDispatcherSpec(trimmed)) // 先构造，非法则原状态不受影响
    const old = this.dispatcher
    this.proxyUrl = trimmed
    this.dispatcher = next
    if (old) {
      void old.destroy().catch(() => {
        /* destroy 失败（如已销毁）无需处理 */
      })
    }
  }

  async get(url: string, init?: HttpRequestInit): Promise<HttpResponse> {
    return this.request('GET', url, init)
  }

  async post(url: string, init?: HttpRequestInit): Promise<HttpResponse> {
    return this.request('POST', url, init)
  }

  /** 释放底层 dispatcher；之后的请求抛错。幂等。 */
  close(): void {
    this.closed = true
    const d = this.dispatcher
    this.dispatcher = null
    if (d) {
      void d.destroy().catch(() => {
        /* ignore */
      })
    }
  }

  private async request(
    method: string,
    url: string,
    init?: HttpRequestInit
  ): Promise<HttpResponse> {
    if (this.closed) {
      throw new Error('HttpClient is closed')
    }
    const timeoutMs = init?.timeoutMs ?? this.defaultTimeoutMs
    const signal = mergeSignals(init?.signal, timeoutMs)

    const res = await undiciFetch(url, {
      method,
      ...(init?.headers !== undefined ? { headers: init.headers } : {}),
      ...(init?.body !== undefined ? { body: init.body } : {}),
      signal,
      ...(this.dispatcher !== null ? { dispatcher: this.dispatcher } : {})
    })

    const headers: Record<string, string> = {}
    res.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value
    })
    const body = await res.text()
    return { status: res.status, headers, body }
  }
}
