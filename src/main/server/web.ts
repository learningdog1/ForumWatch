/**
 * Web 管理界面服务器（Docker 部署;ADR 2 无头内核,零 electron、零新增依赖）。
 *
 * 一个 node:http 服务器承载四件事:
 * 1. 静态托管渲染层构建产物(out/renderer——与桌面版同一套 UI,vite 构建产物
 *    本身浏览器可直跑;浏览器里 window.api 由渲染层 web-shim 提供,见
 *    src/renderer/src/lib/web-shim.ts);
 * 2. POST /api/invoke:DesktopApi 的 invoke 面——{channel, args[]} 查表分发到
 *    api.ts 的处理器,返回 {ok:true,result} | {ok:false,error};
 * 3. GET /api/events:SSE(Server-Sent Events)事件流——evStatus/evHit/evLog/
 *    evDailyReport/evCategoryReport 主→渲染推送通道(桌面版走 webContents.send;
 *    broadcast 是泛型 channel 分发,R17 起新通道零改动接入)。SSE 而非
 *    WebSocket:事件是纯服务端→客户端单向流,EventSource 自带断线重连,
 *    无需引入 ws 依赖与手写帧协议;
 * 4. GET /api/backup/export(下载)/ POST /api/backup/import(上传)——网页端
 *    备份的文件下载/上传形态(桌面版是系统对话框,见 desktop/ipc.ts)。
 *
 * 认证(可选):设置 token 后全部 /api/* 要求 Bearer 头或 ?token= 查询参数
 * (SSE 的 EventSource 无法自定义头,查询参数兜底);静态 UI 本身无秘密可公开。
 * 配置面含 Telegram/AI 凭据且可全量改写,**公网部署务必设 token 或加反代认证**。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, randomInt } from 'node:crypto'
import { chmodSync, createReadStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { packBackup, restorePlan, unpackBackup } from '../backup'
import type { Logger } from '../logger'
import type { InvokeHandler, WebApiContext } from './api'
import { collectBackupSegments, CONFIG_FILE, FEEDBACK_FILE, SEEN_FILE, STATE_FILE } from './api'
import pkg from '../../../package.json'

export interface WebServerOptions {
  /** 监听端口(CMD 注入;容器内默认 8787) */
  port: number
  /** 监听地址;默认 '0.0.0.0'(容器场景必须对外) */
  host?: string
  /** 渲染层构建产物目录(含 index.html) */
  webRoot: string
  /** 可选访问令牌:设置后 /api/* 要求 Bearer 头或 ?token= 查询参数 */
  token?: string
  /** invoke 处理器表(api.ts createInvokeHandlers) */
  handlers: Map<string, InvokeHandler>
  /** 备份导出/导入的上下文(api.ts) */
  backupCtx: WebApiContext
  /** 备份导入成功后的收尾(headless:挂 pendingRestart + 暂停引擎 + 重读配置) */
  onBackupImported: () => void
  logger: Logger
}

export interface WebServer {
  /** 主→渲染事件广播(SSE;无客户端时 no-op) */
  broadcast(channel: string, payload: unknown): void
  /** 实际监听地址(端口 0 时取内核分配值;测试用) */
  address(): { host: string; port: number } | null
  close(): Promise<void>
}

/** 扩展名 → Content-Type(渲染层产物只用到这几类;未知按 octet-stream) */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
}

/** POST 体积上限:invoke 1MB;备份导入 50MB(备份含 seen 全集) */
const MAX_INVOKE_BODY = 1 * 1024 * 1024
const MAX_IMPORT_BODY = 50 * 1024 * 1024

/** SSE 心跳间隔:25s 注释行,防中间层空闲断连 */
const SSE_HEARTBEAT_MS = 25_000

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(text)
}

/** 读取请求体(Uint8Array;超上限返回 null 并回 413) */
function readBody(req: IncomingMessage, res: ServerResponse, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        req.destroy()
        sendJson(res, 413, { ok: false, error: 'payload too large' })
        resolvePromise(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks)))
    req.on('error', () => resolvePromise(Buffer.concat(chunks)))
  })
}

/**
 * 同目录 tmp + rename 原子写(desktop/ipc.ts writeAtomically 同款;备份导入
 * 的段写回用)。mode 给了则先收紧 tmp 权限再 rename。
 */
const writeAtomically = (filePath: string, payload: string, mode?: 0o600): void => {
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomInt(0, 0xffffff).toString(36)}`
  mkdirSync(dirname(filePath), { recursive: true })
  try {
    writeFileSync(tmpPath, payload, mode !== undefined ? { encoding: 'utf-8', mode } : 'utf-8')
    if (mode !== undefined) {
      try {
        chmodSync(tmpPath, mode)
      } catch {
        /* 权限收紧失败不阻断(容器卷可能不支持 POSIX 位) */
      }
    }
    renameSync(tmpPath, filePath)
  } catch (err) {
    try {
      unlinkSync(tmpPath)
    } catch {
      /* tmp 清理失败可忽略 */
    }
    throw err
  }
}

export function createWebServer(opts: WebServerOptions): WebServer {
  const tokenSha = opts.token !== undefined && opts.token !== '' ? createHash('sha256').update(opts.token).digest('hex') : null

  /** 认证:token 未配置恒过;配置后校验 Bearer 头或 ?token=(SSE 用) */
  const authorized = (req: IncomingMessage): boolean => {
    if (tokenSha === null) return true
    const header = req.headers['authorization']
    if (header !== undefined && header.startsWith('Bearer ')) {
      const given = createHash('sha256').update(header.slice('Bearer '.length)).digest('hex')
      if (given === tokenSha) return true
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const q = url.searchParams.get('token')
    if (q !== null && q !== '') {
      return createHash('sha256').update(q).digest('hex') === tokenSha
    }
    return false
  }

  // ---- SSE 客户端集合 + 广播 -------------------------------------------------
  const sseClients = new Set<ServerResponse>()
  const broadcast = (channel: string, payload: unknown): void => {
    if (sseClients.size === 0) return
    const frame = `data: ${JSON.stringify({ channel, payload })}\n\n`
    for (const client of sseClients) {
      try {
        client.write(frame)
      } catch {
        sseClients.delete(client) // 写失败(已断连未及清理)即除名
      }
    }
  }

  // ---- 静态文件 ---------------------------------------------------------------
  const webRootAbs = resolve(opts.webRoot)
  const serveStatic = (res: ServerResponse, urlPath: string): void => {
    let rel = decodeURIComponent(urlPath.split('?')[0] ?? '/')
    if (rel === '/' || rel === '') rel = '/index.html'
    const filePath = normalize(join(webRootAbs, rel))
    // 路径逃逸防御:归一化后必须仍在 webRoot 内
    if (filePath !== webRootAbs && !filePath.startsWith(webRootAbs + sep)) {
      res.writeHead(403).end('forbidden')
      return
    }
    let target = filePath
    try {
      const st = statSync(target)
      if (st.isDirectory()) target = join(target, 'index.html')
    } catch {
      // 文件不存在:SPA 兜底回 index.html(单页应用,前端无路由路径)
      target = join(webRootAbs, 'index.html')
    }
    if (!existsSync(target)) {
      res.writeHead(404).end('not found')
      return
    }
    const ext = extname(target).toLowerCase()
    const type = CONTENT_TYPES[ext] ?? 'application/octet-stream'
    // vite 产物带内容哈希 → 可长缓存;html 恒 no-store(发版即生效)
    const cache = ext === '.html' ? 'no-store' : 'public, max-age=86400'
    res.writeHead(200, { 'content-type': type, 'cache-control': cache })
    createReadStream(target).pipe(res)
  }

  // ---- 备份导出/导入 ----------------------------------------------------------
  const handleBackupExport = (res: ServerResponse): void => {
    try {
      const segments = collectBackupSegments(opts.backupCtx)
      const text = packBackup({
        appVersion: pkg.version,
        config: segments.config,
        seen: segments.seen,
        state: segments.state,
        ...(segments.feedback !== undefined ? { feedback: segments.feedback } : {})
      })
      const filename = `forumwatch-backup-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.json`
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store'
      })
      res.end(text)
      opts.logger.info('backup exported via web (browser download)')
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const handleBackupImport = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readBody(req, res, MAX_IMPORT_BODY)
    if (body === null) return
    try {
      const unpacked = unpackBackup(body.toString('utf-8'))
      if (!unpacked.ok) {
        sendJson(res, 200, { ok: false, error: unpacked.error })
        return
      }
      const dir = opts.backupCtx.dataDir
      const plan = restorePlan(unpacked.data, { appVersion: pkg.version })
      writeAtomically(join(dir, CONFIG_FILE), JSON.stringify(plan.config, null, 2), 0o600)
      if (plan.seen === null) {
        // seen 段无效:删 seen.json,下次启动空集重建 + 补基线(ADR 8.9 同款)
        try {
          unlinkSync(join(dir, SEEN_FILE))
        } catch {
          /* 缺文件即达目的 */
        }
      } else {
        writeAtomically(join(dir, SEEN_FILE), JSON.stringify(plan.seen))
      }
      writeAtomically(join(dir, STATE_FILE), JSON.stringify(plan.state, null, 2))
      if (unpacked.data.feedback !== undefined) {
        writeAtomically(join(dir, FEEDBACK_FILE), JSON.stringify(unpacked.data.feedback, null, 2))
      }
      opts.onBackupImported()
      opts.logger.info(
        `backup imported via web; monitoring paused, container restart required`
      )
      sendJson(res, 200, { ok: true, needsRestart: true })
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  // ---- SSE --------------------------------------------------------------------
  const handleEvents = (req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no' // nginx 反代不缓冲
    })
    res.write('retry: 3000\n\n') // 断线 3s 自动重连
    sseClients.add(res)
    // 断连即除名(req close 覆盖客户端 abort 与服务器 close 双路径)
    req.on('close', () => {
      sseClients.delete(res)
    })
  }

  // ---- invoke 分发 --------------------------------------------------------------
  const handleInvoke = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readBody(req, res, MAX_INVOKE_BODY)
    if (body === null) return
    let parsed: { channel?: unknown; args?: unknown }
    try {
      parsed = JSON.parse(body.toString('utf-8'))
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
      return
    }
    const channel = parsed.channel
    const args = Array.isArray(parsed.args) ? parsed.args : []
    if (typeof channel !== 'string') {
      sendJson(res, 400, { ok: false, error: 'need string channel' })
      return
    }
    const handler = opts.handlers.get(channel)
    if (handler === undefined) {
      sendJson(res, 404, { ok: false, error: `unknown channel: ${channel}` })
      return
    }
    try {
      const result = await handler(args)
      sendJson(res, 200, { ok: true, result })
    } catch (err) {
      // 处理器内部约定不抛(收敛为返回值);这里兜底防线,防漏网异常打断连接
      sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  // ---- 请求路由 ---------------------------------------------------------------
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    try {
      if (path === '/api/health') {
        sendJson(res, 200, { ok: true, version: pkg.version, uptimeSec: Math.round(process.uptime()) })
        return
      }
      // /api/* 一律先过认证(静态 UI 公开)
      if (path.startsWith('/api/')) {
        if (!authorized(req)) {
          res.writeHead(401, { 'www-authenticate': 'Bearer' })
          res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
          return
        }
        // 已知路径的错误方法统一 405(放 invoke 前面,防 POST-only 被误答 404)
        const known =
          (path === '/api/invoke' && req.method === 'POST') ||
          (path === '/api/events' && req.method === 'GET') ||
          (path === '/api/backup/export' && req.method === 'GET') ||
          (path === '/api/backup/import' && req.method === 'POST')
        if (!known && (path === '/api/invoke' || path === '/api/events' || path === '/api/backup/export' || path === '/api/backup/import')) {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (req.method === 'POST' && path === '/api/invoke') {
          void handleInvoke(req, res)
          return
        }
        if (req.method === 'GET' && path === '/api/events') {
          handleEvents(req, res)
          return
        }
        if (req.method === 'GET' && path === '/api/backup/export') {
          handleBackupExport(res)
          return
        }
        if (req.method === 'POST' && path === '/api/backup/import') {
          void handleBackupImport(req, res)
          return
        }
        sendJson(res, 404, { ok: false, error: `no such api: ${path}` })
        return
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        serveStatic(res, path)
        return
      }
      res.writeHead(405).end()
    } catch (err) {
      opts.logger.error(
        `web server error (${req.method} ${path}): ${err instanceof Error ? err.message : String(err)}`
      )
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' })
      else res.end()
    }
  })

  // SSE 心跳:对全部在线客户端写注释行(不产生 message 事件,仅保活)
  const heartbeat = setInterval(() => {
    for (const client of sseClients) {
      try {
        client.write(': ping\n\n')
      } catch {
        sseClients.delete(client)
      }
    }
  }, SSE_HEARTBEAT_MS)
  heartbeat.unref()

  let listening: { host: string; port: number } | null = null
  server.on('listening', () => {
    const addr = server.address()
    listening =
      addr !== null && typeof addr === 'object'
        ? { host: addr.address, port: addr.port }
        : null
    opts.logger.info(
      `web ui listening on http://${listening?.host ?? opts.host ?? '0.0.0.0'}:${listening?.port ?? opts.port}` +
        `${tokenSha !== null ? ' (token protected)' : ''}`
    )
  })

  server.listen(opts.port, opts.host ?? '0.0.0.0')

  return {
    broadcast,
    address: () => listening,
    close: () =>
      new Promise((resolveClose) => {
        clearInterval(heartbeat)
        for (const client of sseClients) {
          try {
            client.end()
          } catch {
            /* 已断连 */
          }
        }
        sseClients.clear()
        server.close(() => resolveClose())
        // 无在途连接时 close 立即回调;SSE 长连接已全部 end,不会悬挂
        setTimeout(resolveClose, 1000).unref()
      })
  }
}
