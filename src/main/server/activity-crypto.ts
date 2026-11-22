/**
 * 活动 API 客户端鉴权与加密内核（与客户端 Anode `OverseasApiCrypto` 逐字节兼容）。
 *
 * 协议契约：
 * - 子密钥派生：
 *   - `hmacKey = SHA-256(masterSecret || ":hmac-v1")`
 *   - `aesKey  = SHA-256(masterSecret || ":aes-gcm-v1")`
 * - 请求签名（HMAC-SHA256）：
 *   - 头：`X-Timestamp`（秒级 Unix 时间戳）、`X-Nonce`（随机串）、`X-Signature`（64 位小写 hex）
 *   - Canonical 串：`${METHOD}\n${pathWithQuery}\n${timestampSec}\n${nonce}`
 *   - 防重放：签名验证通过后才写入有界 `NonceReplayGuard`（阻断伪造流量污染重放表的攻击面）
 * - 响应加密信封（AES-256-GCM，96-bit IV + 128-bit Tag 拼接在密文尾部）：
 *   - `{"v":1,"alg":"AES-256-GCM","iv":"<base64>","data":"<base64(ciphertext||tag)>"}`
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto'
import type { IncomingMessage } from 'node:http'

const HMAC_DOMAIN_SUFFIX = Buffer.from(':hmac-v1', 'utf-8')
const AES_DOMAIN_SUFFIX = Buffer.from(':aes-gcm-v1', 'utf-8')
const GCM_IV_BYTES = 12
const GCM_TAG_BYTES = 16
const DEFAULT_MAX_SKEW_SEC = 300
const DEFAULT_MAX_NONCES = 100_000

export interface EncryptedApiEnvelope {
  v: 1
  alg: 'AES-256-GCM'
  iv: string
  data: string
}

export function deriveHmacKey(masterSecret: Buffer | string): Buffer {
  const secretBytes =
    typeof masterSecret === 'string' ? Buffer.from(masterSecret, 'utf-8') : masterSecret
  if (secretBytes.length === 0) {
    throw new Error('Master secret must not be empty')
  }
  return createHash('sha256').update(secretBytes).update(HMAC_DOMAIN_SUFFIX).digest()
}

export function deriveAesKey(masterSecret: Buffer | string): Buffer {
  const secretBytes =
    typeof masterSecret === 'string' ? Buffer.from(masterSecret, 'utf-8') : masterSecret
  if (secretBytes.length === 0) {
    throw new Error('Master secret must not be empty')
  }
  return createHash('sha256').update(secretBytes).update(AES_DOMAIN_SUFFIX).digest()
}

export function buildCanonicalRequest(
  method: string,
  pathWithQuery: string,
  timestampSec: string,
  nonce: string
): string {
  return `${method.trim().toUpperCase()}\n${pathWithQuery}\n${timestampSec}\n${nonce}`
}

export function signCanonicalRequest(
  hmacKey: Buffer,
  method: string,
  pathWithQuery: string,
  timestampSec: string,
  nonce: string
): string {
  const canonical = buildCanonicalRequest(method, pathWithQuery, timestampSec, nonce)
  return createHmac('sha256', hmacKey).update(canonical, 'utf-8').digest('hex')
}

export function encryptActivityEnvelope(
  aesKey: Buffer,
  plaintext: Buffer | string,
  iv: Buffer = randomBytes(GCM_IV_BYTES)
): Buffer {
  if (iv.length !== GCM_IV_BYTES) {
    throw new Error(`Invalid AES-GCM IV length: ${iv.length}`)
  }
  const input = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf-8') : plaintext
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv)
  const encrypted = cipher.update(input)
  const finalBuf = cipher.final()
  const tag = cipher.getAuthTag()
  const combined = Buffer.concat(
    [encrypted, finalBuf, tag],
    encrypted.length + finalBuf.length + tag.length
  )
  const envelope: EncryptedApiEnvelope = {
    v: 1,
    alg: 'AES-256-GCM',
    iv: iv.toString('base64'),
    data: combined.toString('base64')
  }
  return Buffer.from(JSON.stringify(envelope), 'utf-8')
}

export function decryptActivityEnvelope(aesKey: Buffer, rawEnvelope: Buffer | string): string {
  const text = typeof rawEnvelope === 'string' ? rawEnvelope : rawEnvelope.toString('utf-8')
  const parsed = JSON.parse(text) as Partial<EncryptedApiEnvelope>
  if (parsed.v !== 1 || typeof parsed.alg !== 'string' || parsed.alg.toUpperCase() !== 'AES-256-GCM') {
    throw new Error('Unsupported encrypted envelope header')
  }
  if (typeof parsed.iv !== 'string' || typeof parsed.data !== 'string') {
    throw new Error('Missing iv or data in encrypted envelope')
  }
  const iv = Buffer.from(parsed.iv.trim(), 'base64')
  if (iv.length !== GCM_IV_BYTES) {
    throw new Error(`Invalid IV length: ${iv.length}`)
  }
  const cipherWithTag = Buffer.from(parsed.data.trim(), 'base64')
  if (cipherWithTag.length < GCM_TAG_BYTES) {
    throw new Error('Ciphertext shorter than GCM tag')
  }
  const ciphertext = cipherWithTag.subarray(0, cipherWithTag.length - GCM_TAG_BYTES)
  const tag = cipherWithTag.subarray(cipherWithTag.length - GCM_TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', aesKey, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8')
}

/**
 * 有界 Nonce 防重放表（按插入序 Map 实现 O(1) 查重与过期/容量双裁剪）。
 */
export class NonceReplayGuard {
  private readonly seen = new Map<string, number>()
  private readonly ttlSec: number
  private readonly maxEntries: number
  private opsSinceSweep = 0

  constructor(opts?: { ttlSec?: number; maxEntries?: number }) {
    this.ttlSec = opts?.ttlSec ?? DEFAULT_MAX_SKEW_SEC * 2
    this.maxEntries = opts?.maxEntries ?? DEFAULT_MAX_NONCES
  }

  /**
   * 检查并登记 nonce：未见过返回 `true`，重放返回 `false`。
   */
  accept(nonce: string, nowSec: number): boolean {
    if (++this.opsSinceSweep >= 2_048) {
      this.opsSinceSweep = 0
      this.sweepExpired(nowSec)
    }
    const expiresAt = this.seen.get(nonce)
    if (expiresAt !== undefined) {
      if (expiresAt > nowSec) return false
      this.seen.delete(nonce)
    }
    this.seen.set(nonce, nowSec + this.ttlSec)
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value
      if (oldest === undefined) break
      this.seen.delete(oldest)
    }
    return true
  }

  private sweepExpired(nowSec: number): void {
    for (const [k, exp] of this.seen) {
      if (exp <= nowSec) this.seen.delete(k)
      else break // 插入序下后续条目通常更新，扫到未过期即停以保证均摊 O(1)
    }
  }
}

export type ClientAuthOutcome =
  | { ok: true; mode: 'public' | 'bearer' | 'hmac'; encryptResponse: boolean }
  | { ok: false; code: string; message: string }

export interface ActivityClientAuthenticatorOptions {
  /** 客户端共享密钥（空/未设 = 公开免鉴权） */
  secret?: string
  /** 是否强制要求 HMAC 签名 + AES-256-GCM 响应加密信封（对齐海外情报接口） */
  requireEncryption?: boolean
  maxSkewSec?: number
  nowMs?: () => number
}

export class ActivityClientAuthenticator {
  private readonly enabled: boolean
  private readonly requireEncryption: boolean
  private readonly maxSkewSec: number
  private readonly nowMs: () => number
  private readonly secretSha256: Buffer | null
  private readonly hmacKey: Buffer | null
  readonly aesKey: Buffer | null
  private readonly replayGuard: NonceReplayGuard

  constructor(opts: ActivityClientAuthenticatorOptions = {}) {
    const cleanSecret = (opts.secret ?? '').trim()
    this.enabled = cleanSecret !== ''
    this.requireEncryption = this.enabled && opts.requireEncryption === true
    this.maxSkewSec = opts.maxSkewSec ?? DEFAULT_MAX_SKEW_SEC
    this.nowMs = opts.nowMs ?? (() => Date.now())
    this.secretSha256 = this.enabled
      ? createHash('sha256').update(cleanSecret, 'utf-8').digest()
      : null
    this.hmacKey = this.enabled ? deriveHmacKey(cleanSecret) : null
    this.aesKey = this.enabled ? deriveAesKey(cleanSecret) : null
    this.replayGuard = new NonceReplayGuard({ ttlSec: this.maxSkewSec * 2 })
  }

  isAuthRequired(): boolean {
    return this.enabled
  }

  isEncryptionForced(): boolean {
    return this.requireEncryption
  }

  verify(req: IncomingMessage, rawPathWithQuery: string): ClientAuthOutcome {
    const clientWantsEnc =
      String(req.headers['x-response-enc'] ?? '').toLowerCase() === 'aes-256-gcm'

    if (!this.enabled) {
      return { ok: true, mode: 'public', encryptResponse: false }
    }

    // 1. 优先检查 HMAC 三元组头（X-Timestamp + X-Nonce + X-Signature）
    const tsHeader = singleHeader(req.headers['x-timestamp'])
    const nonceHeader = singleHeader(req.headers['x-nonce'])
    const sigHeader = singleHeader(req.headers['x-signature'])

    if (tsHeader !== null || nonceHeader !== null || sigHeader !== null) {
      if (tsHeader === null || nonceHeader === null || sigHeader === null) {
        return {
          ok: false,
          code: 'MISSING_AUTH_HEADERS',
          message: '缺少完整的签名请求头（X-Timestamp / X-Nonce / X-Signature）'
        }
      }
      if (!/^\d{9,12}$/.test(tsHeader)) {
        return { ok: false, code: 'INVALID_TIMESTAMP', message: 'X-Timestamp 格式无效' }
      }
      if (nonceHeader.length < 8 || nonceHeader.length > 128 || !/^[\x21-\x7e]+$/.test(nonceHeader)) {
        return { ok: false, code: 'INVALID_NONCE', message: 'X-Nonce 长度或字符非法' }
      }
      if (!/^[0-9a-fA-F]{64}$/.test(sigHeader)) {
        return { ok: false, code: 'INVALID_SIGNATURE', message: 'X-Signature 格式无效' }
      }

      const nowSec = Math.floor(this.nowMs() / 1000)
      const reqSec = Number(tsHeader)
      if (Math.abs(nowSec - reqSec) > this.maxSkewSec) {
        return {
          ok: false,
          code: 'TIMESTAMP_EXPIRED',
          message: '请求时间戳偏差超出允许窗口，请校准设备时间'
        }
      }

      const expectedHex = signCanonicalRequest(
        this.hmacKey!,
        req.method ?? 'GET',
        rawPathWithQuery,
        tsHeader,
        nonceHeader
      )
      const givenBuf = Buffer.from(sigHeader.toLowerCase(), 'hex')
      const expectedBuf = Buffer.from(expectedHex, 'hex')
      if (givenBuf.length !== expectedBuf.length || !timingSafeEqual(givenBuf, expectedBuf)) {
        return { ok: false, code: 'BAD_SIGNATURE', message: '请求签名校验失败' }
      }

      // 签名通过后才登记 Nonce（防未授权流量冲刷重放表）
      if (!this.replayGuard.accept(nonceHeader, nowSec)) {
        return { ok: false, code: 'NONCE_REPLAYED', message: '检测到重复请求 Nonce' }
      }

      return {
        ok: true,
        mode: 'hmac',
        encryptResponse: this.requireEncryption || clientWantsEnc
      }
    }

    // 2. 若强制加密模式开启，拒绝未签名的 Bearer 明文请求
    if (this.requireEncryption) {
      return {
        ok: false,
        code: 'HMAC_REQUIRED',
        message: '当前服务要求 HMAC-SHA256 签名鉴权'
      }
    }

    // 3. 轻量 Bearer Token 模式（仅在非强制加密模式下允许）
    const authHeader = singleHeader(req.headers['authorization'])
    if (authHeader !== null && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice('Bearer '.length).trim()
      if (token !== '') {
        const givenSha = createHash('sha256').update(token, 'utf-8').digest()
        if (timingSafeEqual(givenSha, this.secretSha256!)) {
          return {
            ok: true,
            mode: 'bearer',
            encryptResponse: clientWantsEnc
          }
        }
      }
      return { ok: false, code: 'INVALID_TOKEN', message: '访问令牌无效' }
    }

    return { ok: false, code: 'UNAUTHORIZED', message: '缺少鉴权凭据' }
  }
}

function singleHeader(val: string | string[] | undefined): string | null {
  if (typeof val === 'string') {
    const trimmed = val.trim()
    return trimmed !== '' ? trimmed : null
  }
  if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'string') {
    const trimmed = val[0].trim()
    return trimmed !== '' ? trimmed : null
  }
  return null
}
