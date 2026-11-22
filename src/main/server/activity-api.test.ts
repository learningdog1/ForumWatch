import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { ActivityFeedPage } from '../../shared/types'
import { ActivityStore } from '../activity/store'
import { createLogger } from '../logger'
import {
  ActivityClientAuthenticator,
  decryptActivityEnvelope,
  deriveAesKey,
  deriveHmacKey,
  signCanonicalRequest
} from './activity-crypto'
import { createPublicActivityServer, type PublicActivityServer } from './activity-api'
import type { WebApiContext } from './api'
import { IpRateLimiter } from './rate-limit'
import { createWebServer, type WebServer } from './web'

const logger = createLogger()
const fakeBackupCtx = { dataDir: '/nonexistent' } as unknown as WebApiContext

const closers: Array<() => Promise<void>> = []
const tempDirs: string[] = []

function makeWebRoot(): string {
  const dir = join(tmpdir(), `fw-act-web-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>ui</body></html>', 'utf-8')
  tempDirs.push(dir)
  return dir
}

afterAll(async () => {
  for (const close of closers) await close()
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('活动 HTTP API（公开只读 + ETag/Gzip + OverseasApiCrypto 加密 + 管理端 CRUD + 并发压测）', () => {
  it('管理端受 FW_WEB_TOKEN 保护，而客户端 /api/v1/activities 支持公开只读、ETag 304 与 Gzip', async () => {
    let clock = 1_795_000_000_000
    const store = new ActivityStore({ now: () => clock })
    const webRoot = makeWebRoot()

    const web: WebServer = createWebServer({
      port: 0,
      host: '127.0.0.1',
      webRoot,
      token: 'admin-super-secret',
      handlers: new Map(),
      backupCtx: fakeBackupCtx,
      onBackupImported: () => undefined,
      activity: {
        readView: store,
        adminStore: store,
        nowMs: () => clock
      },
      logger
    })
    closers.push(() => web.close())
    await vi.waitFor(() => {
      if (web.address() === null) throw new Error('waiting listen')
    })
    const baseUrl = `http://127.0.0.1:${web.address()!.port}`

    // 1. /healthz 免鉴权探活（对齐客户端 checkHealth）
    const health = await fetch(`${baseUrl}/healthz`)
    expect(health.status).toBe(200)
    expect((await health.json()) as { status: string }).toMatchObject({ ok: true, status: 'ok' })

    // 2. 管理写接口未带 FW_WEB_TOKEN → 401
    const unauthAdmin = await fetch(`${baseUrl}/api/v1/admin/activities`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '非法写入' })
    })
    expect(unauthAdmin.status).toBe(401)

    // 3. 管理端带 Bearer FW_WEB_TOKEN 创建多条活动（生成足够大的载荷触发预压缩 Gzip）
    for (let i = 1; i <= 6; i++) {
      const created = await fetch(`${baseUrl}/api/v1/admin/activities`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer admin-super-secret'
        },
        body: JSON.stringify({
          id: `nodeseek:${9000 + i}`,
          sourceId: 'nodeseek',
          topicId: String(9000 + i),
          title: `【抽奖 #${i}】NodeSeek 社区黑五福利送 HK BGP 年付小鸡`,
          summary: `第 ${i} 期福利派送，本帖评论即可参与官方随机数抽奖，每人限一次。`,
          sourceUrl: `https://www.nodeseek.com/post-${9000 + i}-1`,
          organizer: `sponsor_${i}`,
          startsAtEpochMillis: clock - 10_000,
          endsAtEpochMillis: clock + i * 60_000,
          kind: 'lottery',
          pinned: i === 6,
          bodyMarkdown: `## 活动详情 #${i}\n欢迎全体坛友参与！`
        })
      })
      expect(created.status).toBe(201)
    }

    // 4. 客户端无需 FW_WEB_TOKEN 即可读取活动流，置顶排第一，且字段对齐 ForumWatchActivityItem
    const listRes = await fetch(`${baseUrl}/api/v1/activities?page=1&page_size=5&status=ongoing`)
    expect(listRes.status).toBe(200)
    const etag1 = listRes.headers.get('etag')
    expect(etag1).toBeTruthy()
    const page = (await listRes.json()) as ActivityFeedPage
    expect(page.ok).toBe(true)
    expect(page.total).toBe(6)
    expect(page.hasMore).toBe(true)
    expect(page.items).toHaveLength(5)
    expect(page.items[0]?.id).toBe('nodeseek:9006') // pinned=true 置顶优先
    expect(page.items[0]).toMatchObject({
      title: '【抽奖 #6】NodeSeek 社区黑五福利送 HK BGP 年付小鸡',
      sourceUrl: 'https://www.nodeseek.com/post-9006-1',
      organizer: 'sponsor_6',
      status: 'ongoing'
    })

    // 5. 条件请求 If-None-Match 命中 → 304 Not Modified
    const cachedRes = await fetch(`${baseUrl}/api/v1/activities?page=1&page_size=5&status=ongoing`, {
      headers: { 'if-none-match': etag1! }
    })
    expect(cachedRes.status).toBe(304)

    // 6. 时钟跨过第 1 条活动的截止时刻后，无需写操作 ETag 自动失效并返回最新 ongoing 计数
    clock += 65_000
    const afterExpireRes = await fetch(
      `${baseUrl}/api/v1/activities?page=1&page_size=5&status=ongoing`,
      { headers: { 'if-none-match': etag1! } }
    )
    expect(afterExpireRes.status).toBe(200)
    const afterExpirePage = (await afterExpireRes.json()) as ActivityFeedPage
    expect(afterExpirePage.counts.ongoing).toBe(5)
    expect(afterExpirePage.counts.ended).toBe(1)

    // 7. 详情接口同时支持 URL 编码完整 id 与裸 topicId
    const detailByTopic = await fetch(`${baseUrl}/api/v1/activities/9006`)
    expect(detailByTopic.status).toBe(200)
    const detailBody = (await detailByTopic.json()) as {
      ok: boolean
      item: { id: string; bodyMarkdown: string }
    }
    expect(detailBody.item.id).toBe('nodeseek:9006')
    expect(detailBody.item.bodyMarkdown).toContain('活动详情 #6')

    // 8. 管理端下线/删除活动立即在公开读取面隐藏
    const patchRes = await fetch(`${baseUrl}/api/v1/admin/activities/nodeseek%3A9006`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer admin-super-secret'
      },
      body: JSON.stringify({ published: false })
    })
    expect(patchRes.status).toBe(200)
    const hiddenDetail = await fetch(`${baseUrl}/api/v1/activities/9006`)
    expect(hiddenDetail.status).toBe(404)
  })

  it('兼容 Anode OverseasApiCrypto：HMAC-SHA256 请求签名 + 防重放 + AES-256-GCM 加密信封端到端验证', async () => {
    const nowMs = 1_795_100_000_000
    const masterSecret = 'orca-nodeseek-shared-master-secret-2026'
    const hmacKey = deriveHmacKey(masterSecret)
    const aesKey = deriveAesKey(masterSecret)

    const store = new ActivityStore({ now: () => nowMs })
    store.createManual({
      id: 'nodeseek:777777',
      sourceId: 'nodeseek',
      topicId: '777777',
      title: '【加密通道测试】周年庆百台小鸡大抽奖',
      summary: '端到端 AES-256-GCM 加密信封验证',
      sourceUrl: 'https://www.nodeseek.com/post-777777-1',
      organizer: 'nodeseek_official',
      startsAtEpochMillis: nowMs - 1_000,
      endsAtEpochMillis: nowMs + 86_400_000,
      kind: 'event'
    })

    const pub: PublicActivityServer = createPublicActivityServer({
      port: 0,
      host: '127.0.0.1',
      readView: store,
      authenticator: new ActivityClientAuthenticator({
        secret: masterSecret,
        requireEncryption: true,
        nowMs: () => nowMs
      }),
      nowMs: () => nowMs,
      logger
    })
    closers.push(() => pub.close())
    await vi.waitFor(() => {
      if (pub.address() === null) throw new Error('waiting public server')
    })
    const baseUrl = `http://127.0.0.1:${pub.address()!.port}`

    // 未签名或仅带 Bearer（强制加密模式下不允许明文 Bearer）→ 401
    const plainAttempt = await fetch(`${baseUrl}/api/v1/activities`, {
      headers: { authorization: `Bearer ${masterSecret}` }
    })
    expect(plainAttempt.status).toBe(401)

    // 构造标准 OverseasApiCrypto 签名头
    const pathWithQuery = '/api/v1/activities?page=1&page_size=10'
    const tsSec = String(Math.floor(nowMs / 1000))
    const nonce = '0123456789abcdef0123456789abcdef'
    const sig = signCanonicalRequest(hmacKey, 'GET', pathWithQuery, tsSec, nonce)

    const encRes = await fetch(`${baseUrl}${pathWithQuery}`, {
      headers: {
        'x-timestamp': tsSec,
        'x-nonce': nonce,
        'x-signature': sig
      }
    })
    expect(encRes.status).toBe(200)
    expect(encRes.headers.get('x-content-encrypted')).toBe('AES-256-GCM')
    const rawEnvelope = await encRes.text()
    expect(rawEnvelope).not.toContain('周年庆百台小鸡大抽奖') // 线上密文不泄露明文

    const decryptedJson = decryptActivityEnvelope(aesKey, rawEnvelope)
    const decodedPage = JSON.parse(decryptedJson) as ActivityFeedPage
    expect(decodedPage.items).toHaveLength(1)
    expect(decodedPage.items[0]?.title).toBe('【加密通道测试】周年庆百台小鸡大抽奖')

    // 同一 Nonce 重放请求 → 401 NONCE_REPLAYED
    const replayRes = await fetch(`${baseUrl}${pathWithQuery}`, {
      headers: {
        'x-timestamp': tsSec,
        'x-nonce': nonce,
        'x-signature': sig
      }
    })
    expect(replayRes.status).toBe(401)
    expect(((await replayRes.json()) as { error: { code: string } }).error.code).toBe(
      'NONCE_REPLAYED'
    )

    // 独立公开端口物理隔离后台管理面：访问 /api/v1/admin/* 恒 404
    const adminOnPublic = await fetch(`${baseUrl}/api/v1/admin/activities`)
    expect(adminOnPublic.status).toBe(404)
  })

  it('IP 令牌桶限流与 500 并发突发吞吐验证', async () => {
    const nowMs = 1_795_200_000_000
    const store = new ActivityStore({ now: () => nowMs })
    for (let i = 1; i <= 25; i++) {
      store.createManual({
        id: `nodeseek:${i}`,
        sourceId: 'nodeseek',
        topicId: String(i),
        title: `并发压测活动条目 #${i}`,
        summary: '纯内存预序列化 Buffer + Gzip + ETag 缓存压测载荷',
        sourceUrl: `https://www.nodeseek.com/post-${i}-1`,
        organizer: 'bench',
        endsAtEpochMillis: nowMs + 3600_000
      })
    }

    // 1. 验证限流器超额返回 429 + Retry-After
    const limitedServer = createPublicActivityServer({
      port: 0,
      host: '127.0.0.1',
      readView: store,
      rateLimiter: new IpRateLimiter({ requestsPerMinute: 60, burst: 2, nowMs: () => nowMs }),
      nowMs: () => nowMs
    })
    closers.push(() => limitedServer.close())
    await vi.waitFor(() => {
      if (limitedServer.address() === null) throw new Error('waiting listen')
    })
    const limitedUrl = `http://127.0.0.1:${limitedServer.address()!.port}/api/v1/activities`
    expect((await fetch(limitedUrl)).status).toBe(200)
    expect((await fetch(limitedUrl)).status).toBe(200)
    const r429 = await fetch(limitedUrl)
    expect(r429.status).toBe(429)
    expect(Number(r429.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)

    // 2. 500 并发突发请求（含 250 个明文/Gzip 读取 + 250 个 If-None-Match 304 读取）全部零报错快速完成
    const highQpsServer = createPublicActivityServer({
      port: 0,
      host: '127.0.0.1',
      readView: store,
      rateLimiter: new IpRateLimiter({ requestsPerMinute: 0 }),
      nowMs: () => nowMs
    })
    closers.push(() => highQpsServer.close())
    await vi.waitFor(() => {
      if (highQpsServer.address() === null) throw new Error('waiting listen')
    })
    const benchUrl = `http://127.0.0.1:${highQpsServer.address()!.port}/api/v1/activities?page=1&page_size=20`
    const warm = await fetch(benchUrl)
    const etag = warm.headers.get('etag')!
    await warm.arrayBuffer()

    const startMs = performance.now()
    const statuses = await Promise.all(
      Array.from({ length: 500 }, (_, idx) =>
        fetch(
          benchUrl,
          idx % 2 === 0 ? undefined : { headers: { 'if-none-match': etag } }
        ).then(async (r) => {
          await r.arrayBuffer()
          return r.status
        })
      )
    )
    const elapsedMs = performance.now() - startMs
    expect(statuses.filter((s) => s === 200)).toHaveLength(250)
    expect(statuses.filter((s) => s === 304)).toHaveLength(250)
    expect(elapsedMs).toBeLessThan(5_000)
  })
})
