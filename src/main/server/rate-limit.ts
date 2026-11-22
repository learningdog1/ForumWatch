/**
 * 高并发低开销令牌桶 IP 限流器（O(1) 均摊，有界内存防随机源 IP 洪泛 OOM）。
 *
 * - 支持 `requestsPerMinute`（RPM）与突发容量 `burst`（缺省 max(20, ceil(rpm / 2))）；
 * - `rpm <= 0` 时完全放行（内网压测或前置 Nginx/Cloudflare 已做限流时可关）；
 * - 代理头（`CF-Connecting-IP` / `X-Real-IP` / `X-Forwarded-For`）仅在 `trustProxy === true`
 *   时采信，默认只认底层 socket 远端 IP，防止直连暴露时客户端伪造请求头绕过限流。
 */
import type { IncomingMessage } from 'node:http'

const DEFAULT_MAX_BUCKETS = 25_000
const IDLE_BUCKET_TTL_MS = 10 * 60_000

interface Bucket {
  tokens: number
  lastRefillMs: number
}

export interface IpRateLimiterOptions {
  /** 每分钟允许请求数；<= 0 表示禁用限流 */
  requestsPerMinute: number
  /** 突发令牌上限；默认 max(20, ceil(rpm / 2)) */
  burst?: number
  /** 最大追踪 IP 数（超出淘汰最久未活跃桶，硬内存护栏） */
  maxBuckets?: number
  /** 是否信任反向代理转发的客户端真实 IP 头 */
  trustProxy?: boolean
  nowMs?: () => number
}

export type RateLimitDecision =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSec: number }

export class IpRateLimiter {
  private readonly enabled: boolean
  private readonly refillPerMs: number
  private readonly burst: number
  private readonly maxBuckets: number
  private readonly trustProxy: boolean
  private readonly nowMs: () => number
  private readonly buckets = new Map<string, Bucket>()
  private opsSinceSweep = 0

  constructor(opts: IpRateLimiterOptions) {
    const rpm = Number.isFinite(opts.requestsPerMinute) ? opts.requestsPerMinute : 0
    this.enabled = rpm > 0
    this.refillPerMs = this.enabled ? rpm / 60_000 : 0
    this.burst =
      opts.burst !== undefined && Number.isFinite(opts.burst) && opts.burst >= 1
        ? Math.floor(opts.burst)
        : Math.max(20, Math.ceil(rpm / 2))
    this.maxBuckets = opts.maxBuckets ?? DEFAULT_MAX_BUCKETS
    this.trustProxy = opts.trustProxy === true
    this.nowMs = opts.nowMs ?? (() => Date.now())
  }

  check(req: IncomingMessage): RateLimitDecision {
    if (!this.enabled) {
      return { allowed: true, remaining: this.burst }
    }
    const ip = extractClientIp(req, this.trustProxy)
    return this.consume(ip)
  }

  consume(key: string): RateLimitDecision {
    if (!this.enabled) {
      return { allowed: true, remaining: this.burst }
    }
    const now = this.nowMs()
    if (++this.opsSinceSweep >= 4_096) {
      this.opsSinceSweep = 0
      this.sweepIdle(now)
    }

    let bucket = this.buckets.get(key)
    if (bucket !== undefined) {
      const elapsed = Math.max(0, now - bucket.lastRefillMs)
      bucket.tokens = Math.min(this.burst, bucket.tokens + elapsed * this.refillPerMs)
      bucket.lastRefillMs = now
      // 刷新 Map 尾序（保持近似 LRU 淘汰序）
      this.buckets.delete(key)
      this.buckets.set(key, bucket)
    } else {
      bucket = { tokens: this.burst, lastRefillMs: now }
      this.buckets.set(key, bucket)
      while (this.buckets.size > this.maxBuckets) {
        const oldestKey = this.buckets.keys().next().value
        if (oldestKey === undefined) break
        this.buckets.delete(oldestKey)
      }
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return { allowed: true, remaining: Math.floor(bucket.tokens) }
    }

    const deficit = 1 - bucket.tokens
    const waitMs = Math.ceil(deficit / this.refillPerMs)
    const retryAfterSec = Math.max(1, Math.ceil(waitMs / 1000))
    return { allowed: false, retryAfterSec }
  }

  private sweepIdle(now: number): void {
    const cutoff = now - IDLE_BUCKET_TTL_MS
    for (const [k, b] of this.buckets) {
      if (b.lastRefillMs < cutoff) this.buckets.delete(k)
      else break
    }
  }
}

export function extractClientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const cfIp = firstHeaderVal(req.headers['cf-connecting-ip'])
    if (cfIp !== null) return cfIp
    const realIp = firstHeaderVal(req.headers['x-real-ip'])
    if (realIp !== null) return realIp
    const xff = firstHeaderVal(req.headers['x-forwarded-for'])
    if (xff !== null) {
      const first = xff.split(',')[0]?.trim()
      if (first) return first
    }
  }
  return req.socket?.remoteAddress ?? 'unknown'
}

function firstHeaderVal(val: string | string[] | undefined): string | null {
  if (typeof val === 'string') {
    const t = val.trim()
    return t !== '' ? t : null
  }
  if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'string') {
    const t = val[0].trim()
    return t !== '' ? t : null
  }
  return null
}
