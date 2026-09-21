/**
 * 更新检查单测（R8-B / E1）：compareSemver 矩阵 / parseLatestRelease 形状 /
 * check 三态（fetch 全注入，零网络）/ start 定时轮询（假时钟）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  compareSemver,
  GITHUB_LATEST_RELEASE_URL,
  parseLatestRelease,
  UPDATE_CHECK_TIMEOUT_MS,
  UPDATE_INTERVAL_MS,
  UPDATE_INITIAL_DELAY_MS,
  UpdateChecker,
  type UpdateOutcome
} from './update-check'
import type { FetchLike, HttpRequestInit, HttpResponse } from '../net/http-types'

/** 假 fetch：记录调用（URL/init），按队列回放响应或抛错 */
function fakeFetch(): {
  fetchFn: FetchLike
  calls: { url: string; init?: HttpRequestInit }[]
  queue: (HttpResponse | Error)[]
} {
  const calls: { url: string; init?: HttpRequestInit }[] = []
  const queue: (HttpResponse | Error)[] = []
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const next = queue.shift()
    if (next instanceof Error) throw next
    if (next === undefined) throw new Error('fake fetch: unexpected call')
    return next
  }
  return { fetchFn, calls, queue }
}

const okBody = (payload: unknown): HttpResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify(payload)
})

const release = (tag: string, url = 'https://github.com/colmidad/forumwatch/releases/tag/v9.9.9'): unknown => ({
  tag_name: tag,
  html_url: url,
  name: `ForumWatch ${tag}`,
  assets: []
})

describe('compareSemver（自实现，v 前缀容忍 + 缺段补 0）', () => {
  it('相等矩阵', () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0)
    expect(compareSemver('1.0', '1.0.0')).toBe(0)
    expect(compareSemver('1', '1.0.0')).toBe(0)
    expect(compareSemver('v1.2.3', '1.2.3')).toBe(0)
    expect(compareSemver('V1.2.3', 'v1.2.3')).toBe(0)
    expect(compareSemver('0.2.0', 'v0.2.0')).toBe(0)
  })

  it('大于矩阵', () => {
    expect(compareSemver('1.2.0', '1.1.9')).toBe(1)
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1)
    expect(compareSemver('1.10.0', '1.9.0')).toBe(1) // 段按数值比，非字典序
    expect(compareSemver('1.0.1', '1.0.0')).toBe(1)
    expect(compareSemver('1.0', '0.9.9')).toBe(1)
    expect(compareSemver('v2.0', '1.9.9')).toBe(1)
    expect(compareSemver('0.2.1', '0.2.0')).toBe(1)
  })

  it('小于矩阵（与大于互为相反数）', () => {
    expect(compareSemver('1.1.9', '1.2.0')).toBe(-1)
    expect(compareSemver('1.9.0', '1.10.0')).toBe(-1)
    expect(compareSemver('0.1.0', '0.2.0')).toBe(-1)
    expect(compareSemver('v0.2.0', 'v0.2.1')).toBe(-1)
  })

  it('垃圾输入不抛：空串/非数字段按 0 处理', () => {
    expect(compareSemver('', '0.0.0')).toBe(0)
    expect(compareSemver('x.y.z', '0.0.0')).toBe(0)
    expect(compareSemver(' 1.2.3 ', '1.2.3')).toBe(0)
    // 第四段起忽略（最多比三段）
    expect(compareSemver('1.0.0.9', '1.0.0')).toBe(0)
  })
})

describe('parseLatestRelease（载荷形状）', () => {
  it('正常载荷 → { tag, url }', () => {
    expect(parseLatestRelease(release('v1.2.3', 'https://x/y'))).toEqual({
      tag: 'v1.2.3',
      url: 'https://x/y'
    })
  })

  it('缺字段 → null（tag_name / html_url 任一缺失）', () => {
    expect(parseLatestRelease({ tag_name: 'v1' })).toBeNull()
    expect(parseLatestRelease({ html_url: 'https://x' })).toBeNull()
    expect(parseLatestRelease({})).toBeNull()
  })

  it('null / 非对象 / 字段类型不对 → null', () => {
    expect(parseLatestRelease(null)).toBeNull()
    expect(parseLatestRelease(undefined)).toBeNull()
    expect(parseLatestRelease('v1.2.3')).toBeNull()
    expect(parseLatestRelease([1, 2])).toBeNull()
    expect(parseLatestRelease({ tag_name: 123, html_url: 'https://x' })).toBeNull()
    expect(parseLatestRelease({ tag_name: 'v1', html_url: '' })).toBeNull()
  })
})

describe('UpdateChecker.check（三态，fetch 注入）', () => {
  it('有新版：latest > current → 返回结果并记 available', async () => {
    const ff = fakeFetch()
    ff.queue.push(okBody(release('v0.3.0')))
    const warns: string[] = []
    const checker = new UpdateChecker({
      currentVersion: '0.2.0',
      repo: 'colmidad/forumwatch',
      fetchFn: ff.fetchFn,
      now: () => 1_000,
      log: { warn: (m) => warns.push(m) }
    })
    const r = await checker.check()
    expect(r).toEqual({
      current: '0.2.0',
      latest: 'v0.3.0',
      downloadUrl: 'https://github.com/colmidad/forumwatch/releases/tag/v9.9.9'
    })
    expect(warns).toEqual([])
    // 结局缓存：available + 注入的 now
    expect(checker.lastOutcome()).toEqual({
      kind: 'available',
      checkedAt: 1_000,
      current: '0.2.0',
      latest: 'v0.3.0',
      downloadUrl: 'https://github.com/colmidad/forumwatch/releases/tag/v9.9.9'
    })
  })

  it('已最新（含 v 前缀容忍）：latest ≤ current → null，记 up-to-date', async () => {
    const ff = fakeFetch()
    ff.queue.push(okBody(release('v0.2.0'))) // 相等
    const checker = new UpdateChecker({
      currentVersion: '0.2.0',
      repo: 'colmidad/forumwatch',
      fetchFn: ff.fetchFn,
      now: () => 2_000
    })
    expect(await checker.check()).toBeNull()
    expect(checker.lastOutcome()).toEqual({
      kind: 'up-to-date',
      checkedAt: 2_000,
      current: '0.2.0',
      latest: 'v0.2.0'
    })

    ff.queue.push(okBody(release('v0.1.9'))) // 旧于 current
    expect(await checker.check()).toBeNull()
    expect(checker.lastOutcome()).toMatchObject({ kind: 'up-to-date', latest: 'v0.1.9' })
  })

  it('网络失败：fetch 抛错 → 静默 null + log warn，不抛', async () => {
    const ff = fakeFetch()
    ff.queue.push(new Error('ENETDOWN'))
    const warns: string[] = []
    const checker = new UpdateChecker({
      currentVersion: '0.2.0',
      repo: 'colmidad/forumwatch',
      fetchFn: ff.fetchFn,
      log: { warn: (m) => warns.push(m) }
    })
    expect(await checker.check()).toBeNull()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('ENETDOWN')
    expect(checker.lastOutcome()).toMatchObject({ kind: 'error', error: 'ENETDOWN' })
  })

  it('解析失败三连：非 2xx / 坏 JSON / 载荷缺字段 → 静默 null + error 结局', async () => {
    const mk = (res: HttpResponse): { checker: UpdateChecker; warns: string[] } => {
      const ff = fakeFetch()
      ff.queue.push(res)
      const warns: string[] = []
      const checker = new UpdateChecker({
        currentVersion: '0.2.0',
        repo: 'colmidad/forumwatch',
        fetchFn: ff.fetchFn,
        log: { warn: (m) => warns.push(m) }
      })
      return { checker, warns }
    }
    const http403 = mk({ status: 403, headers: {}, body: '{"message":"rate limited"}' })
    expect(await http403.checker.check()).toBeNull()
    expect(http403.warns[0]).toContain('HTTP 403')

    const badJson = mk({ status: 200, headers: {}, body: 'not-json' })
    expect(await badJson.checker.check()).toBeNull()
    expect(badJson.checker.lastOutcome()).toMatchObject({ kind: 'error' })

    const badShape = mk(okBody({ message: 'Not Found' }))
    expect(await badShape.checker.check()).toBeNull()
    expect(badShape.checker.lastOutcome()).toMatchObject({ kind: 'error' })
  })

  it('请求形状：UA 头必带（GitHub API 要求）+ 端点拼接 owner/name', async () => {
    const ff = fakeFetch()
    ff.queue.push(okBody(release('v1.0.0')))
    const checker = new UpdateChecker({
      currentVersion: '0.2.0',
      repo: 'someone/somerepo',
      fetchFn: ff.fetchFn
    })
    await checker.check()
    expect(ff.calls).toHaveLength(1)
    expect(ff.calls[0].url).toBe('https://api.github.com/repos/someone/somerepo/releases/latest')
    const ua = ff.calls[0].init?.headers?.['User-Agent']
    expect(typeof ua === 'string' && ua.length > 0).toBe(true)
  })

  it('请求形状：整体超时随 init.timeoutMs 下发（裸 fetch 会挂到 TCP 超时）', async () => {
    const ff = fakeFetch()
    ff.queue.push(okBody(release('v1.0.0')))
    const checker = new UpdateChecker({
      currentVersion: '0.2.0',
      repo: 'colmidad/forumwatch',
      fetchFn: ff.fetchFn
    })
    await checker.check()
    expect(ff.calls[0].init?.timeoutMs).toBe(UPDATE_CHECK_TIMEOUT_MS)
  })

  it('导出常量：默认延迟 15s / 24h / 检查超时 15s，端点与 UPDATE_REPO 一致', () => {
    expect(UPDATE_INITIAL_DELAY_MS).toBe(15_000)
    expect(UPDATE_INTERVAL_MS).toBe(24 * 60 * 60 * 1000)
    expect(UPDATE_CHECK_TIMEOUT_MS).toBe(15_000)
    expect(GITHUB_LATEST_RELEASE_URL).toBe(
      'https://api.github.com/repos/learningdog1/ForumWatch/releases/latest'
    )
  })
})

describe('UpdateChecker.start/stop（定时轮询，假时钟）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const mkChecker = (
    warns: string[] = []
  ): { checker: UpdateChecker; ff: ReturnType<typeof fakeFetch> } => {
    const ff = fakeFetch()
    const checker = new UpdateChecker({
      currentVersion: '0.2.0',
      repo: 'colmidad/forumwatch',
      fetchFn: ff.fetchFn,
      log: { warn: (m) => warns.push(m) },
      delays: { initialMs: 100, intervalMs: 1_000 }
    })
    return { checker, ff }
  }

  it('initialMs 后首轮，此后每 intervalMs 一轮；onResult 逐轮回调', async () => {
    const { checker, ff } = mkChecker()
    const outcomes: UpdateOutcome[] = []
    checker.start((o) => outcomes.push(o))
    expect(checker.isRunning()).toBe(true)

    ff.queue.push(okBody(release('v0.3.0')))
    await vi.advanceTimersByTimeAsync(100) // 首轮
    expect(ff.calls).toHaveLength(1)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ kind: 'available', latest: 'v0.3.0' })

    ff.queue.push(okBody(release('v0.2.0')))
    await vi.advanceTimersByTimeAsync(1_000) // 第二轮
    expect(ff.calls).toHaveLength(2)
    expect(outcomes).toHaveLength(2)
    expect(outcomes[1]).toMatchObject({ kind: 'up-to-date' })

    checker.stop()
    expect(checker.isRunning()).toBe(false)
  })

  it('start 前不发包（initialMs 内零调用）', async () => {
    const { checker, ff } = mkChecker()
    await vi.advanceTimersByTimeAsync(99)
    expect(ff.calls).toHaveLength(0)
    expect(checker.lastOutcome()).toBeNull()
    checker.stop()
  })

  it('stop 清计时器：之后不再发包；幂等；start 也幂等', async () => {
    const { checker, ff } = mkChecker()
    const noop = (): void => {}
    checker.start(noop)
    checker.start(noop) // 幂等：不双排
    checker.stop()
    checker.stop() // 幂等
    ff.queue.push(okBody(release('v0.3.0')))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(ff.calls).toHaveLength(0)
  })

  it('轮询中失败不中断循环：下一轮照常', async () => {
    const { checker, ff } = mkChecker()
    checker.start()
    ff.queue.push(new Error('boom'))
    await vi.advanceTimersByTimeAsync(100)
    expect(checker.lastOutcome()).toMatchObject({ kind: 'error', error: 'boom' })
    ff.queue.push(okBody(release('v0.3.0')))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(checker.lastOutcome()).toMatchObject({ kind: 'available' })
    checker.stop()
  })
})
