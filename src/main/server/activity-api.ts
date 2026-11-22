/**
 * 高并发社区活动 HTTP API 路由与预序列化响应缓存层（零 Electron、零第三方框架依赖）。
 *
 * 面向两类调用方：
 * 1. **客户端高频并发读取**（Anode `/Volumes/2T/Applications/Data/code/orca/nodeseek` 等）：
 *    - `GET /healthz` / `GET /api/v1/health`：极速探活（兼容 `OverseasIntelApiClient.checkHealth`）
 *    - `GET /api/v1/activities`：分页 + 状态/分类/来源/关键词/增量时间过滤
 *    - `GET /api/v1/activities/:id`：单条活动详情（含 1 楼 Markdown 正文与外链列表；支持完整 `id` 或裸 `topicId`）
 *    - 性能栈：内存 `ActivityReadView` → `effectiveRevision` 驱动的 LRU 预序列化 `Buffer` + 预压缩 `Gzip`
 *      缓存 → `ETag` (`If-None-Match` → `304`) / `Last-Modified` → 可选 `AES-256-GCM` 加密信封。
 * 2. **管理端人工维护**（仅挂载在管理端口，受 `FW_WEB_TOKEN` 保护，绝不挂到公开只读 Worker）：
 *    - `GET    /api/v1/admin/activities`：列出含未发布/已下线在内的全部活动记录
 *    - `POST   /api/v1/admin/activities`：手动创建活动
 *    - `POST   /api/v1/admin/activities/ingest`：输入帖子 URL 一键抓取提炼入库，或触发立即扫描
 *    - `PATCH  /api/v1/admin/activities/:id`（兼容 `PUT`）：编辑标题/摘要/时间/置顶/上下线/手动结单
 *    - `DELETE /api/v1/admin/activities/:id`：删除并写入墓碑（防自动轮询复活）
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { constants as zlibConstants, gzipSync } from 'node:zlib'
import pkg from '../../../package.json'
import type { ActivityKind, ActivityTimeStatus } from '../../shared/types'
import type { Logger } from '../logger'
import type { ActivityCollector } from '../activity/collector'
import {
  resolveActivityStatus,
  type ActivityQuery,
  type ActivityReadView,
  type ActivityStore,
  type AdminCreateInput,
  type AdminPatchInput
} from '../activity/store'
import {
  ActivityClientAuthenticator,
  encryptActivityEnvelope
} from './activity-crypto'
import { IpRateLimiter } from './rate-limit'

const MAX_ADMIN_BODY_BYTES = 512 * 1024
const RESPONSE_CACHE_MAX_ENTRIES = 256
const GZIP_MIN_BYTES = 512

interface CachedPayload {
  etag: string
  lastModified: string | null
  plainBuffer: Buffer
  gzipBuffer: Buffer | null
}

/**
 * 基于 `effectiveRevision` 的 O(1) 整体失效 + LRU 预序列化/预压缩响应缓存。
 */
class ActivityResponseCache {
  private readonly maxEntries: number
  private currentRevision = ''
  private readonly map = new Map<string, CachedPayload>()

  constructor(maxEntries = RESPONSE_CACHE_MAX_ENTRIES) {
    this.maxEntries = maxEntries
  }

  getOrBuild(
    revision: string,
    updatedAtMs: number,
    key: string,
    buildObject: () => unknown
  ): CachedPayload {
    if (revision !== this.currentRevision) {
      this.map.clear()
      this.currentRevision = revision
    }
    const hit = this.map.get(key)
    if (hit !== undefined) {
      this.map.delete(key)
      this.map.set(key, hit)
      return hit
    }

    const jsonText = JSON.stringify(buildObject())
    const plainBuffer = Buffer.from(jsonText, 'utf-8')
    const gzipBuffer =
      plainBuffer.length >= GZIP_MIN_BYTES
        ? gzipSync(plainBuffer, { level: zlibConstants.Z_BEST_SPEED })
        : null
    const hash = createHash('sha1')
      .update(revision)
      .update('|')
      .update(key)
      .update('|')
      .update(plainBuffer)
      .digest('hex')
      .slice(0, 16)
    const etag = `"fw-${hash}"`
    const lastModified = updatedAtMs > 0 ? new Date(updatedAtMs).toUTCString() : null

    const entry: CachedPayload = { etag, lastModified, plainBuffer, gzipBuffer }
    this.map.set(key, entry)
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
    return entry
  }
}

export interface ActivityAdminDeps {
  store: ActivityStore
  collector?: ActivityCollector
  isAdminAuthorized: (req: IncomingMessage) => boolean
  triggerScanNow?: () => void
}

export interface ActivityApiOptions {
  readView: ActivityReadView
  authenticator?: ActivityClientAuthenticator
  rateLimiter?: IpRateLimiter
  corsOrigin?: string
  admin?: ActivityAdminDeps
  nowMs?: () => number
  logger?: Logger
}

export interface ActivityApiHandler {
  /**
   * 尝试处理请求：路径属于活动 API 或 `/healthz` 时返回 `true`（已写出响应），
   * 否则返回 `false` 交由上层服务器继续路由。
   */
  tryHandle(req: IncomingMessage, res: ServerResponse): boolean
}

export function applyHighConcurrencyServerTuning(
  server: Server,
  opts?: { requestTimeoutMs?: number }
): void {
  // 保持略高于常见反代（Nginx/Cloudflare/ALB 默认 60s）的 keep-alive 超时，避免连接池竞态 502
  server.keepAliveTimeout = 65_000
  server.headersTimeout = 66_000
  server.requestTimeout = opts?.requestTimeoutMs ?? 15_000
  server.maxHeadersCount = 64
}

export function createActivityApiHandler(opts: ActivityApiOptions): ActivityApiHandler {
  const nowMs = opts.nowMs ?? (() => Date.now())
  const auth = opts.authenticator ?? new ActivityClientAuthenticator()
  const limiter = opts.rateLimiter ?? new IpRateLimiter({ requestsPerMinute: 0 })
  const corsOrigin = opts.corsOrigin ?? '*'
  const cache = new ActivityResponseCache()

  const corsHeaders: Record<string, string> = {
    'access-control-allow-origin': corsOrigin,
    'access-control-allow-methods': 'GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS',
    'access-control-allow-headers':
      'Authorization, Content-Type, If-None-Match, If-Modified-Since, X-Timestamp, X-Nonce, X-Signature, X-Response-Enc',
    'access-control-expose-headers': 'ETag, Last-Modified, Retry-After, Date'
  }

  const sendError = (
    res: ServerResponse,
    status: number,
    code: string,
    message: string,
    extraHeaders?: Record<string, string>
  ): void => {
    const body = Buffer.from(
      JSON.stringify({
        ok: false,
        error: { code, message }
      }),
      'utf-8'
    )
    res.writeHead(status, {
      ...corsHeaders,
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
      ...extraHeaders
    })
    res.end(body)
  }

  const sendAdminJson = (res: ServerResponse, status: number, payload: unknown): void => {
    const body = Buffer.from(JSON.stringify(payload), 'utf-8')
    res.writeHead(status, {
      ...corsHeaders,
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store'
    })
    res.end(body)
  }

  const serveCachedRead = (
    req: IncomingMessage,
    res: ServerResponse,
    entry: CachedPayload,
    encryptResponse: boolean
  ): void => {
    const cacheControl = auth.isAuthRequired()
      ? 'private, no-cache'
      : 'public, max-age=5, stale-while-revalidate=30'

    // 1. ETag / If-None-Match 命中 → 零字节 304（明文与加密模式均支持）
    const inm = req.headers['if-none-match']
    if (typeof inm === 'string' && matchesIfNoneMatch(inm, entry.etag)) {
      res.writeHead(304, {
        ...corsHeaders,
        etag: entry.etag,
        ...(entry.lastModified !== null ? { 'last-modified': entry.lastModified } : {}),
        'cache-control': cacheControl
      })
      res.end()
      return
    }

    // 2. If-Modified-Since 兜底条件请求（仅在未传 If-None-Match 时启用 RFC 语义）
    if (inm === undefined && entry.lastModified !== null) {
      const ims = req.headers['if-modified-since']
      if (typeof ims === 'string') {
        const imsMs = Date.parse(ims)
        const lmMs = Date.parse(entry.lastModified)
        if (Number.isFinite(imsMs) && Number.isFinite(lmMs) && lmMs <= imsMs) {
          res.writeHead(304, {
            ...corsHeaders,
            etag: entry.etag,
            'last-modified': entry.lastModified,
            'cache-control': cacheControl
          })
          res.end()
          return
        }
      }
    }

    const isHead = req.method === 'HEAD'

    // 3. AES-256-GCM 加密信封输出（OverseasApiCrypto 兼容格式，每次新随机 96-bit IV）
    if (encryptResponse && auth.aesKey !== null) {
      const encryptedBuf = encryptActivityEnvelope(auth.aesKey, entry.plainBuffer)
      res.writeHead(200, {
        ...corsHeaders,
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(encryptedBuf.length),
        etag: entry.etag,
        ...(entry.lastModified !== null ? { 'last-modified': entry.lastModified } : {}),
        'cache-control': 'private, no-store',
        'x-content-encrypted': 'AES-256-GCM'
      })
      res.end(isHead ? undefined : encryptedBuf)
      return
    }

    // 4. 明文 JSON 输出（优先复用预压缩 Gzip Buffer）
    const acceptEnc = String(req.headers['accept-encoding'] ?? '')
    const useGzip = entry.gzipBuffer !== null && /\bgzip\b/i.test(acceptEnc)
    const outBuf = useGzip ? entry.gzipBuffer! : entry.plainBuffer

    res.writeHead(200, {
      ...corsHeaders,
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(outBuf.length),
      vary: 'Accept-Encoding',
      ...(useGzip ? { 'content-encoding': 'gzip' } : {}),
      etag: entry.etag,
      ...(entry.lastModified !== null ? { 'last-modified': entry.lastModified } : {}),
      'cache-control': cacheControl
    })
    res.end(isHead ? undefined : outBuf)
  }

  const handlePublicRead = (
    req: IncomingMessage,
    res: ServerResponse,
    rawUrl: string,
    url: URL
  ): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, 'METHOD_NOT_ALLOWED', '仅支持 GET / HEAD 请求')
      return
    }

    const rate = limiter.check(req)
    if (!rate.allowed) {
      sendError(
        res,
        429,
        'RATE_LIMITED',
        `请求过于频繁，请 ${rate.retryAfterSec} 秒后重试`,
        { 'retry-after': String(rate.retryAfterSec) }
      )
      return
    }

    const authOutcome = auth.verify(req, rawUrl)
    if (!authOutcome.ok) {
      sendError(res, 401, authOutcome.code, authOutcome.message, {
        'www-authenticate': 'Bearer'
      })
      return
    }

    const now = nowMs()
    const rev = opts.readView.getEffectiveRevision(now)
    const updatedAt = opts.readView.getUpdatedAtEpochMillis()
    const path = url.pathname

    if (path === '/api/v1/activities' || path === '/api/v1/activities/') {
      const query = parsePublicActivityQuery(url.searchParams)
      const cacheKey =
        `list|p=${query.page}|ps=${query.pageSize}|st=${query.status}|` +
        `k=${query.kind ?? ''}|src=${query.sourceId ?? ''}|q=${query.q ?? ''}|ua=${query.updatedAfter ?? 0}`
      const entry = cache.getOrBuild(rev, updatedAt, cacheKey, () =>
        opts.readView.queryPublic(query, now)
      )
      serveCachedRead(req, res, entry, authOutcome.encryptResponse)
      return
    }

    const prefix = '/api/v1/activities/'
    if (path.startsWith(prefix)) {
      const rawId = path.slice(prefix.length)
      if (rawId === '' || rawId.includes('/')) {
        sendError(res, 404, 'NOT_FOUND', '未找到对应的活动接口')
        return
      }
      let decodedId: string
      try {
        decodedId = decodeURIComponent(rawId).trim()
      } catch {
        sendError(res, 400, 'BAD_ID', '活动 ID 编码无效')
        return
      }
      if (decodedId === '') {
        sendError(res, 404, 'NOT_FOUND', '未找到对应的活动记录')
        return
      }

      const detail = opts.readView.getPublicDetail(decodedId, now)
      if (detail === null) {
        sendError(res, 404, 'NOT_FOUND', '未找到对应的活动记录')
        return
      }
      const cacheKey = `detail|id=${detail.id}`
      const entry = cache.getOrBuild(rev, detail.updatedAtEpochMillis, cacheKey, () => ({
        ok: true,
        updatedAtEpochMillis: detail.updatedAtEpochMillis,
        serverTimeEpochMillis: now,
        item: detail
      }))
      serveCachedRead(req, res, entry, authOutcome.encryptResponse)
      return
    }

    sendError(res, 404, 'NOT_FOUND', '未找到对应的活动接口')
  }

  const handleAdmin = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL
  ): Promise<void> => {
    const admin = opts.admin
    if (!admin) {
      sendError(res, 404, 'NOT_FOUND', '当前端口未挂载管理接口')
      return
    }
    if (!admin.isAdminAuthorized(req)) {
      sendError(res, 401, 'UNAUTHORIZED', '管理接口鉴权失败', {
        'www-authenticate': 'Bearer'
      })
      return
    }

    const path = url.pathname.replace(/\/+$/, '') || '/'
    const now = nowMs()

    if (path === '/api/v1/admin/activities') {
      if (req.method === 'GET') {
        const records = admin.store.listAllAdmin()
        sendAdminJson(res, 200, {
          ok: true,
          total: records.length,
          items: records.map((r) => ({
            ...r,
            status: resolveActivityStatus(r, now)
          }))
        })
        return
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req, res, MAX_ADMIN_BODY_BYTES, sendError)
        if (body === null) return
        try {
          const created = admin.store.createManual(normalizeAdminCreate(body))
          sendAdminJson(res, 201, {
            ok: true,
            item: { ...created, status: resolveActivityStatus(created, now) }
          })
        } catch (err) {
          sendError(
            res,
            400,
            'INVALID_PAYLOAD',
            err instanceof Error ? err.message : String(err)
          )
        }
        return
      }
      sendError(res, 405, 'METHOD_NOT_ALLOWED', '不支持的请求方法')
      return
    }

    if (path === '/api/v1/admin/activities/ingest') {
      if (req.method !== 'POST') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', '仅支持 POST 请求')
        return
      }
      const body = await readJsonBody(req, res, MAX_ADMIN_BODY_BYTES, sendError)
      if (body === null) return
      if (body['scanCurrentSources'] === true) {
        admin.triggerScanNow?.()
        sendAdminJson(res, 200, { ok: true, triggeredScan: true })
        return
      }
      const targetUrl = typeof body['url'] === 'string' ? body['url'].trim() : ''
      if (targetUrl === '') {
        sendError(res, 400, 'MISSING_URL', '请提供帖子 url 或设置 scanCurrentSources=true')
        return
      }
      if (!admin.collector) {
        sendError(res, 501, 'COLLECTOR_UNAVAILABLE', '当前实例未启用采集器')
        return
      }
      try {
        const sourceId = typeof body['sourceId'] === 'string' ? body['sourceId'] : undefined
        const force = body['force'] !== false
        const ingested = await admin.collector.ingestUrl(targetUrl, { sourceId, force })
        sendAdminJson(res, 200, {
          ok: true,
          item: { ...ingested, status: resolveActivityStatus(ingested, nowMs()) }
        })
      } catch (err) {
        sendError(
          res,
          422,
          'INGEST_FAILED',
          err instanceof Error ? err.message : String(err)
        )
      }
      return
    }

    const itemPrefix = '/api/v1/admin/activities/'
    if (url.pathname.startsWith(itemPrefix)) {
      const rawId = url.pathname.slice(itemPrefix.length).replace(/\/+$/, '')
      if (rawId === '' || rawId.includes('/')) {
        sendError(res, 404, 'NOT_FOUND', '未找到管理路径')
        return
      }
      let id: string
      try {
        id = decodeURIComponent(rawId).trim()
      } catch {
        sendError(res, 400, 'BAD_ID', '活动 ID 编码无效')
        return
      }

      if (req.method === 'PATCH' || req.method === 'PUT') {
        const body = await readJsonBody(req, res, MAX_ADMIN_BODY_BYTES, sendError)
        if (body === null) return
        try {
          const updated = admin.store.updateAdmin(id, normalizeAdminPatch(body))
          if (!updated) {
            sendError(res, 404, 'NOT_FOUND', `未找到活动: ${id}`)
            return
          }
          sendAdminJson(res, 200, {
            ok: true,
            item: { ...updated, status: resolveActivityStatus(updated, nowMs()) }
          })
        } catch (err) {
          sendError(
            res,
            400,
            'INVALID_PAYLOAD',
            err instanceof Error ? err.message : String(err)
          )
        }
        return
      }

      if (req.method === 'DELETE') {
        const deleted = admin.store.deleteAdmin(id)
        if (!deleted) {
          sendError(res, 404, 'NOT_FOUND', `未找到活动: ${id}`)
          return
        }
        sendAdminJson(res, 200, { ok: true, deleted: true, id })
        return
      }

      sendError(res, 405, 'METHOD_NOT_ALLOWED', '不支持的请求方法')
      return
    }

    sendError(res, 404, 'NOT_FOUND', '未找到管理接口')
  }

  return {
    tryHandle(req: IncomingMessage, res: ServerResponse): boolean {
      const rawUrl = req.url ?? '/'
      const url = new URL(rawUrl, 'http://localhost')
      const path = url.pathname

      const isHealth = path === '/healthz' || path === '/api/v1/health'
      const isPublicActivities =
        path === '/api/v1/activities' || path.startsWith('/api/v1/activities/')
      const isAdminActivities =
        path === '/api/v1/admin/activities' || path.startsWith('/api/v1/admin/activities/')

      if (!isHealth && !isPublicActivities && !isAdminActivities) {
        return false
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders)
        res.end()
        return true
      }

      if (isHealth) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', '仅支持 GET / HEAD')
          return true
        }
        const payload = Buffer.from(
          JSON.stringify({
            ok: true,
            status: 'ok',
            version: pkg.version,
            activities: opts.readView.size(),
            uptimeSec: Math.round(process.uptime())
          }),
          'utf-8'
        )
        res.writeHead(200, {
          ...corsHeaders,
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(payload.length),
          'cache-control': 'no-store'
        })
        res.end(req.method === 'HEAD' ? undefined : payload)
        return true
      }

      if (isPublicActivities) {
        handlePublicRead(req, res, rawUrl, url)
        return true
      }

      void handleAdmin(req, res, url).catch((err) => {
        opts.logger?.error(
          `activity admin api error (${req.method} ${path}): ${err instanceof Error ? err.message : String(err)}`
        )
        if (!res.headersSent) {
          sendError(res, 500, 'INTERNAL_ERROR', '服务器内部错误')
        } else {
          res.end()
        }
      })
      return true
    }
  }
}

export interface PublicActivityServerOptions extends ActivityApiOptions {
  port: number
  host?: string
}

export interface PublicActivityServer {
  address(): { host: string; port: number } | null
  close(): Promise<void>
}

/**
 * 独立高并发公开只读 API 服务器（用于 `--api-port` / 多进程 Cluster Worker）。
 * 物理隔离后台管理面：此端口只响应 `/healthz` 与 `/api/v1/activities*`。
 */
export function createPublicActivityServer(
  opts: PublicActivityServerOptions
): PublicActivityServer {
  const api = createActivityApiHandler({
    ...opts,
    admin: undefined // 公开端口强制剥离管理面
  })

  const server = createServer((req, res) => {
    try {
      if (api.tryHandle(req, res)) return
      const body = Buffer.from(
        JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'not found' } }),
        'utf-8'
      )
      res.writeHead(404, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.length),
        'cache-control': 'no-store'
      })
      res.end(body)
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end('{"ok":false,"error":{"code":"INTERNAL_ERROR","message":"internal error"}}')
      } else {
        res.end()
      }
    }
  })

  applyHighConcurrencyServerTuning(server)

  let listening: { host: string; port: number } | null = null
  server.on('listening', () => {
    const addr = server.address()
    listening =
      addr !== null && typeof addr === 'object'
        ? { host: addr.address, port: addr.port }
        : null
    opts.logger?.info(
      `public activity api listening on http://${listening?.host ?? opts.host ?? '0.0.0.0'}:${listening?.port ?? opts.port} (pid=${process.pid})`
    )
  })

  server.listen(opts.port, opts.host ?? '0.0.0.0')

  return {
    address: () => listening,
    close: () =>
      new Promise((resolveClose) => {
        server.close(() => resolveClose())
        setTimeout(resolveClose, 1000).unref()
      })
  }
}

function matchesIfNoneMatch(headerVal: string, etag: string): boolean {
  const trimmed = headerVal.trim()
  if (trimmed === '*') return true
  const stripWeak = (v: string): string => v.trim().replace(/^W\//i, '')
  const target = stripWeak(etag)
  for (const part of trimmed.split(',')) {
    if (stripWeak(part) === target) return true
  }
  return false
}

function parsePublicActivityQuery(params: URLSearchParams): ActivityQuery {
  const rawPage = Number(params.get('page') ?? '1')
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1

  const rawPageSize = Number(params.get('page_size') ?? params.get('pageSize') ?? '20')
  const pageSize =
    Number.isFinite(rawPageSize) && rawPageSize >= 1
      ? Math.min(100, Math.floor(rawPageSize))
      : 20

  const rawStatus = (params.get('status') ?? 'all').trim().toLowerCase()
  const status: ActivityQuery['status'] =
    rawStatus === 'ongoing' ||
    rawStatus === 'upcoming' ||
    rawStatus === 'ended' ||
    rawStatus === 'active'
      ? (rawStatus as ActivityTimeStatus | 'active')
      : 'all'

  const kind = params.get('kind')?.trim() || undefined
  const sourceId = (params.get('source_id') ?? params.get('sourceId'))?.trim() || undefined
  const q = params.get('q')?.trim().slice(0, 100) || undefined
  const rawUpdatedAfter = Number(params.get('updated_after') ?? params.get('updatedAfter') ?? '0')
  const updatedAfter =
    Number.isFinite(rawUpdatedAfter) && rawUpdatedAfter > 0 ? Math.trunc(rawUpdatedAfter) : undefined

  return { page, pageSize, status, kind, sourceId, q, updatedAfter }
}

function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number,
  sendError: (res: ServerResponse, status: number, code: string, msg: string) => void
): Promise<Record<string, unknown> | null> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = []
    let size = 0
    let aborted = false
    req.on('data', (chunk: Buffer) => {
      if (aborted) return
      size += chunk.length
      if (size > maxBytes) {
        aborted = true
        req.destroy()
        sendError(res, 413, 'PAYLOAD_TOO_LARGE', '请求体超出大小上限')
        resolvePromise(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (aborted) return
      try {
        const text = Buffer.concat(chunks).toString('utf-8')
        const parsed: unknown = text.trim() === '' ? {} : JSON.parse(text)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          sendError(res, 400, 'INVALID_JSON', '请求体必须是 JSON 对象')
          resolvePromise(null)
          return
        }
        resolvePromise(parsed as Record<string, unknown>)
      } catch {
        sendError(res, 400, 'INVALID_JSON', '请求体 JSON 解析失败')
        resolvePromise(null)
      }
    })
    req.on('error', () => {
      if (!aborted) resolvePromise(null)
    })
  })
}

function normalizeAdminCreate(body: Record<string, unknown>): AdminCreateInput {
  return {
    ...(typeof body['id'] === 'string' ? { id: body['id'] } : {}),
    title: typeof body['title'] === 'string' ? body['title'] : '',
    ...(typeof body['summary'] === 'string' ? { summary: body['summary'] } : {}),
    ...(typeof body['sourceUrl'] === 'string' ? { sourceUrl: body['sourceUrl'] } : {}),
    ...(typeof body['organizer'] === 'string' ? { organizer: body['organizer'] } : {}),
    ...(body['organizerUrl'] === null || typeof body['organizerUrl'] === 'string'
      ? { organizerUrl: body['organizerUrl'] as string | null }
      : {}),
    ...(body['startsAtEpochMillis'] === null || typeof body['startsAtEpochMillis'] === 'number'
      ? { startsAtEpochMillis: body['startsAtEpochMillis'] as number | null }
      : {}),
    ...(body['endsAtEpochMillis'] === null || typeof body['endsAtEpochMillis'] === 'number'
      ? { endsAtEpochMillis: body['endsAtEpochMillis'] as number | null }
      : {}),
    ...(typeof body['forceEnded'] === 'boolean' ? { forceEnded: body['forceEnded'] } : {}),
    ...(typeof body['published'] === 'boolean' ? { published: body['published'] } : {}),
    ...(typeof body['pinned'] === 'boolean' ? { pinned: body['pinned'] } : {}),
    ...(typeof body['kind'] === 'string' ? { kind: body['kind'] as ActivityKind } : {}),
    ...(typeof body['sourceId'] === 'string' ? { sourceId: body['sourceId'] } : {}),
    ...(body['topicId'] === null || typeof body['topicId'] === 'string'
      ? { topicId: body['topicId'] as string | null }
      : {}),
    ...(typeof body['category'] === 'string' ? { category: body['category'] } : {}),
    ...(typeof body['categorySlug'] === 'string' ? { categorySlug: body['categorySlug'] } : {}),
    ...(body['luckyUrl'] === null || typeof body['luckyUrl'] === 'string'
      ? { luckyUrl: body['luckyUrl'] as string | null }
      : {}),
    ...(body['drawFloor'] === null || typeof body['drawFloor'] === 'number'
      ? { drawFloor: body['drawFloor'] as number | null }
      : {}),
    ...(body['prize'] === null || typeof body['prize'] === 'string'
      ? { prize: body['prize'] as string | null }
      : {}),
    ...(body['participation'] === null || typeof body['participation'] === 'string'
      ? { participation: body['participation'] as string | null }
      : {}),
    ...(Array.isArray(body['tags'])
      ? { tags: body['tags'].filter((t): t is string => typeof t === 'string') }
      : {}),
    ...(typeof body['bodyMarkdown'] === 'string' ? { bodyMarkdown: body['bodyMarkdown'] } : {})
  }
}

function normalizeAdminPatch(body: Record<string, unknown>): AdminPatchInput {
  const out: AdminPatchInput = {}
  if (typeof body['title'] === 'string') out.title = body['title']
  if (typeof body['summary'] === 'string') out.summary = body['summary']
  if (typeof body['sourceUrl'] === 'string') out.sourceUrl = body['sourceUrl']
  if (typeof body['organizer'] === 'string') out.organizer = body['organizer']
  if (body['organizerUrl'] === null || typeof body['organizerUrl'] === 'string') {
    out.organizerUrl = body['organizerUrl'] as string | null
  }
  if (body['startsAtEpochMillis'] === null || typeof body['startsAtEpochMillis'] === 'number') {
    out.startsAtEpochMillis = body['startsAtEpochMillis'] as number | null
  }
  if (body['endsAtEpochMillis'] === null || typeof body['endsAtEpochMillis'] === 'number') {
    out.endsAtEpochMillis = body['endsAtEpochMillis'] as number | null
  }
  if (typeof body['forceEnded'] === 'boolean') out.forceEnded = body['forceEnded']
  if (typeof body['published'] === 'boolean') out.published = body['published']
  if (typeof body['pinned'] === 'boolean') out.pinned = body['pinned']
  if (typeof body['kind'] === 'string') out.kind = body['kind'] as ActivityKind
  if (body['luckyUrl'] === null || typeof body['luckyUrl'] === 'string') {
    out.luckyUrl = body['luckyUrl'] as string | null
  }
  if (body['drawFloor'] === null || typeof body['drawFloor'] === 'number') {
    out.drawFloor = body['drawFloor'] as number | null
  }
  if (body['prize'] === null || typeof body['prize'] === 'string') {
    out.prize = body['prize'] as string | null
  }
  if (body['participation'] === null || typeof body['participation'] === 'string') {
    out.participation = body['participation'] as string | null
  }
  if (Array.isArray(body['tags'])) {
    out.tags = body['tags'].filter((t): t is string => typeof t === 'string')
  }
  if (typeof body['bodyMarkdown'] === 'string') out.bodyMarkdown = body['bodyMarkdown']
  return out
}
