/**
 * HTTP 层最小契约：监控内核（html adapter）与网络层（undici 封装）之间的注入边界。
 * 保持与 fetch 相近但不直接依赖 undici 类型，便于单测 mock。
 */

export interface HttpResponse {
  status: number
  /** header 名统一小写 */
  headers: Record<string, string>
  body: string
}

export interface HttpRequestInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
  /** 请求整体超时；由实现方转换为 AbortSignal.timeout */
  timeoutMs?: number
}

export type FetchLike = (url: string, init?: HttpRequestInit) => Promise<HttpResponse>
