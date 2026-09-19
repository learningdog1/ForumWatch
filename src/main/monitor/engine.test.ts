/**
 * MonitorEngine 全量单测：source/notifier 全 mock、seen/state 走真实 FileSeenStore /
 * FileEngineState（tmpdir）、scheduler 用真实 PollScheduler（fake timers）、
 * matchTopic 用真实现。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { MonitorEngine } from './engine'
import { computeBackoffMs, PollScheduler } from './poller'
import { FileSeenStore } from './dedup'
import { FileEngineState } from './state'
import { ChallengeError, type SourceAdapter } from './types'
import { TelegramError } from '../notify/telegram'
import { createLogger, type Logger } from '../logger'
import { DEFAULT_APP_CONFIG, type AppConfig, type Topic } from '../../shared/types'

let dir: string

beforeEach(async () => {
  vi.useFakeTimers()
  dir = await mkdtemp(join(tmpdir(), 'rss-monitor-engine-'))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

function topic(id: string, overrides: Partial<Topic> = {}): Topic {
  return {
    id,
    title: `title-${id}`,
    url: `https://example.com/post-${id}-1`,
    author: 'alice',
    category: '闲聊',
    categorySlug: 'chat',
    pinned: false,
    lastActiveAt: null,
    ...overrides
  }
}

interface Harness {
  engine: MonitorEngine
  scheduler: PollScheduler
  fetchLatest: Mock
  sendHit: Mock
  sendTest: Mock
  seen: FileSeenStore
  state: FileEngineState
  config: AppConfig
  logger: Logger
  /** 已触发的 pollOnce promise（start/resume 间接触发时用它 drain） */
  ticks: Promise<void>[]
  onHit: Mock
  onStatus: Mock
}

function build(
  opts: {
    config?: Partial<AppConfig>
    impl?: () => Promise<Topic[]>
    /** 覆盖 getConfig（F7：注入抛错版本） */
    getConfig?: () => AppConfig
    /** 覆盖 seen 文件路径（F9：指向不可写路径让 flush 失败） */
    seenPath?: string
  } = {}
): Harness {
  const config: AppConfig = {
    ...structuredClone(DEFAULT_APP_CONFIG),
    includeKeywords: ['羊毛'],
    excludeKeywords: ['广告'],
    telegram: { botToken: 'T', chatId: 'C' },
    ...opts.config
  }

  const logger = createLogger() // 纯内存 logger
  const seen = new FileSeenStore(opts.seenPath ?? join(dir, 'seen.json'))
  seen.load()
  const state = new FileEngineState(join(dir, 'state.json'))
  state.load()

  const sendHit = vi.fn(async () => {})
  const sendTest = vi.fn(async () => {})
  const onHit = vi.fn()
  const onStatus = vi.fn()
  const ticks: Promise<void>[] = []

  const fetchLatest = vi.fn(opts.impl ?? (async () => [] as Topic[]))
  const source: SourceAdapter = { name: 'fake-source', fetchLatest }

  let engine!: MonitorEngine
  const scheduler = new PollScheduler({
    intervalSec: config.pollIntervalSec, // DEFAULT 60
    jitterRatio: 0, // 测试要精确断言间隔
    onTick: () => {
      const p = engine.pollOnce()
      ticks.push(p)
      return p
    },
    onScheduled: (ms) => engine.noteScheduled(ms)
  })

  engine = new MonitorEngine({
    source,
    seen,
    state,
    notifier: { sendHit, sendTest },
    getConfig: opts.getConfig ?? (() => config),
    scheduler,
    logger,
    onHit,
    onStatus
  })

  return {
    engine,
    scheduler,
    fetchLatest,
    sendHit,
    sendTest,
    seen,
    state,
    config,
    logger,
    ticks,
    onHit,
    onStatus
  }
}

describe('首启基线（防通知风暴）', () => {
  it('首轮：全部入 seen、绝不推送、baselineDone 持久化、状态 ok', async () => {
    const h = build({ impl: async () => [topic('1', { title: '羊毛线索' }), topic('2'), topic('3')] })
    await h.engine.pollOnce()

    expect(h.sendHit).not.toHaveBeenCalled()
    expect(h.onHit).not.toHaveBeenCalled()
    expect(h.seen.has('1')).toBe(true)
    expect(h.seen.has('2')).toBe(true)
    expect(h.seen.has('3')).toBe(true)
    // 去重集已落盘（新实例可见）
    const seen2 = new FileSeenStore(join(dir, 'seen.json'))
    seen2.load()
    expect(seen2.size()).toBe(3)
    expect(h.state.get().baselineDone).toBe(true)

    const st = h.engine.getStatus()
    expect(st.health).toBe('ok')
    expect(st.desired).toBe('running')
    expect(st.lastPollAt).not.toBeNull()
    expect(st.lastSuccessAt).not.toBeNull()
    expect(st.consecutiveFailures).toBe(0)
    expect(st.totalHits).toBe(0)
    expect(st.nextPollAt).toBeNull() // 未启动排程，没有下次轮询时刻
  })

  it('首轮抓取失败：baselineDone 保持 false，成功轮补做基线（仍绝不推送）', async () => {
    const h = build({
      impl: async () => {
        throw new Error('net down')
      }
    })
    await h.engine.pollOnce()
    expect(h.engine.getStatus().health).toBe('backoff')
    expect(h.state.get().baselineDone).toBe(false)

    h.fetchLatest.mockImplementation(async () => [topic('1', { title: '羊毛大促' })])
    await h.engine.pollOnce()
    expect(h.sendHit).not.toHaveBeenCalled() // 补做基线，不是推送
    expect(h.seen.has('1')).toBe(true)
    expect(h.state.get().baselineDone).toBe(true)
  })

  it('seen 损坏重建 + baselineDone=true → 强制补基线（ADR 8.9）：首轮无 sendHit、全部入集', async () => {
    // 第一个引擎完成基线：state.baselineDone=true，seen 已落盘
    const h = build({ impl: async () => [topic('1')] })
    await h.engine.pollOnce()
    expect(h.state.get().baselineDone).toBe(true)

    // seen.json 损坏 → FileSeenStore 重建（rebuiltFromCorrupt=true）
    await writeFile(join(dir, 'seen.json'), '{ corrupt !!!', 'utf-8')
    const seen2 = new FileSeenStore(join(dir, 'seen.json'))
    seen2.load()
    expect(seen2.rebuiltFromCorrupt).toBe(true)

    // 新引擎装配（state 仍是 baselineDone=true）：构造时重置为 false 并 warn
    const engine2 = new MonitorEngine({
      source: { name: 'fake', fetchLatest: h.fetchLatest },
      seen: seen2,
      state: h.state,
      notifier: { sendHit: h.sendHit, sendTest: h.sendTest },
      getConfig: () => h.config,
      scheduler: h.scheduler,
      logger: h.logger
    })
    expect(h.state.get().baselineDone).toBe(false)
    expect(
      h.logger.getRecent().some((e) => e.level === 'warn' && e.msg.includes('seen store rebuilt'))
    ).toBe(true)

    // 首轮按基线处理：整页只入集不推送
    h.fetchLatest.mockImplementation(async () => [topic('1'), topic('2', { title: '羊毛' })])
    await engine2.pollOnce()
    expect(h.sendHit).not.toHaveBeenCalled()
    expect(h.onHit).not.toHaveBeenCalled()
    expect(seen2.has('1')).toBe(true)
    expect(seen2.has('2')).toBe(true)
    expect(h.state.get().baselineDone).toBe(true)
  })

  it('seen 损坏重建但 baselineDone=false：无需重置，行为不变（首启基线照做）', async () => {
    await writeFile(join(dir, 'seen.json'), '{ corrupt !!!', 'utf-8')
    const h = build({ impl: async () => [topic('1', { title: '羊毛' })] })
    expect(h.seen.rebuiltFromCorrupt).toBe(true)
    expect(h.state.get().baselineDone).toBe(false)
    await h.engine.pollOnce() // 基线
    expect(h.sendHit).not.toHaveBeenCalled()
    expect(h.seen.has('1')).toBe(true)
  })
})

describe('正常轮', () => {
  it('新帖命中 → sendHit 收到正确 (topic, kws)；置顶跳过；排除词否决；totalHits 累计', async () => {
    const h = build({ impl: async () => [topic('1'), topic('2')] })
    await h.engine.pollOnce() // 基线

    // 页面顺序：最新在前
    h.fetchLatest.mockImplementation(async () => [
      topic('5', { title: '最新羊毛' }),
      topic('4', { title: '羊毛置顶', pinned: true }),
      topic('3', { title: '羊毛广告' }),
      topic('2'),
      topic('1')
    ])
    await h.engine.pollOnce()

    expect(h.sendHit).toHaveBeenCalledTimes(1)
    expect(h.sendHit.mock.calls[0][0].id).toBe('5')
    expect(h.sendHit.mock.calls[0][1]).toEqual(['羊毛'])

    // 置顶与被排除的都只入去重集
    expect(h.seen.has('4')).toBe(true)
    expect(h.seen.has('3')).toBe(true)

    const st = h.engine.getStatus()
    expect(st.totalHits).toBe(1)
    expect(st.health).toBe('ok')

    const hits = h.engine.getRecentHits()
    expect(hits).toHaveLength(1)
    expect(hits[0].topic.id).toBe('5')
    expect(hits[0].matchedKeywords).toEqual(['羊毛'])
    expect(hits[0].notifiedAt).not.toBeNull() // 推送成功态
    expect(hits[0].notifyError).toBeNull()
    expect(h.onHit).toHaveBeenCalledTimes(1)
  })

  it('推送顺序旧→新：页面最新在前，处理时反转', async () => {
    const h = build({ impl: async () => [topic('1')] })
    await h.engine.pollOnce()
    h.fetchLatest.mockImplementation(async () => [
      topic('9', { title: '羊毛九' }), // 最新
      topic('8', { title: '羊毛八' }),
      topic('1')
    ])
    await h.engine.pollOnce()

    expect(h.onHit.mock.calls.map((c) => (c[0] as { topic: Topic }).topic.id)).toEqual(['8', '9'])
    expect(h.engine.getRecentHits().map((x) => x.topic.id)).toEqual(['8', '9'])
    expect(h.sendHit.mock.calls.map((c) => (c[0] as Topic).id)).toEqual(['8', '9'])
  })

  it('单个推送失败不中断本轮：后续 topic 仍处理，HitRecord 记 notifyError', async () => {
    const h = build({ impl: async () => [topic('1')] })
    await h.engine.pollOnce()
    h.fetchLatest.mockImplementation(async () => [
      topic('4', { title: '羊毛D' }),
      topic('3', { title: '羊毛C' }),
      topic('2', { title: '羊毛B' })
    ])
    h.sendHit
      .mockRejectedValueOnce(new TelegramError('telegram send failed after 3 attempts: HTTP 400'))
      .mockResolvedValueOnce(undefined)

    await h.engine.pollOnce()

    expect(h.sendHit).toHaveBeenCalledTimes(3) // 失败后 3、4 仍被尝试
    const hits = h.engine.getRecentHits()
    expect(hits.map((x) => x.topic.id)).toEqual(['2', '3', '4'])
    expect(hits[0].notifiedAt).toBeNull()
    expect(hits[0].notifyError).toContain('telegram send failed')
    expect(hits[1].notifiedAt).not.toBeNull()
    expect(hits[1].notifyError).toBeNull()
    expect(h.engine.getStatus().health).toBe('ok') // 推送失败 ≠ 轮询失败
    expect(h.engine.getStatus().totalHits).toBe(3)
    // ADR 8.10：真实失败的 2 不入去重集（下轮重试）；成功的 3/4 入集
    expect(h.seen.has('2')).toBe(false)
    expect(h.seen.has('3')).toBe(true)
    expect(h.seen.has('4')).toBe(true)
  })

  it('notifyEnabled=false：命中不推送，notifiedAt/notifyError 均为 null（静音态）', async () => {
    const h = build({ impl: async () => [topic('1')], config: { notifyEnabled: false } })
    await h.engine.pollOnce()
    h.fetchLatest.mockImplementation(async () => [topic('2', { title: '羊毛' }), topic('1')])
    await h.engine.pollOnce()

    expect(h.sendHit).not.toHaveBeenCalled()
    const hits = h.engine.getRecentHits()
    expect(hits).toHaveLength(1)
    expect(hits[0].notifiedAt).toBeNull()
    expect(hits[0].notifyError).toBeNull()
    expect(h.engine.getStatus().totalHits).toBe(1)
    // 静音是用户主动行为：照常入集，不进入重试
    expect(h.seen.has('2')).toBe(true)
  })

  it('telegram 未配置：同静音态，不调用 sendHit', async () => {
    const h = build({
      impl: async () => [topic('1')],
      config: { telegram: { botToken: '', chatId: '' } }
    })
    await h.engine.pollOnce()
    h.fetchLatest.mockImplementation(async () => [topic('2', { title: '羊毛' }), topic('1')])
    await h.engine.pollOnce()

    expect(h.sendHit).not.toHaveBeenCalled()
    expect(h.engine.getRecentHits()[0]).toMatchObject({ notifiedAt: null, notifyError: null })
    expect(h.engine.getStatus().totalHits).toBe(1)
  })

  it('getRecentHits 环形 200 条：第 201 条起淘汰最老', async () => {
    const h = build({ impl: async () => [topic('0')] })
    await h.engine.pollOnce() // 基线：1 条
    // 205 条新帖全部命中；页面顺序最新在前（304 → 100）
    h.fetchLatest.mockImplementation(async () =>
      Array.from({ length: 205 }, (_, i) => topic(String(304 - i), { title: '羊毛' }))
    )
    await h.engine.pollOnce()

    expect(h.engine.getStatus().totalHits).toBe(205)
    const hits = h.engine.getRecentHits()
    expect(hits).toHaveLength(200)
    expect(hits[0].topic.id).toBe('105') // 100..104 被淘汰
    expect(hits[199].topic.id).toBe('304')
  })

  it('sendTestNotification 透传 notifier.sendTest', async () => {
    const h = build()
    await h.engine.sendTestNotification()
    expect(h.sendTest).toHaveBeenCalledTimes(1)
  })
})

describe('推送失败重试（ADR 8.10）', () => {
  it('失败不入集 → 下轮重试成功后入集，全程只 emit 两次（失败一次 + 成功一次）', async () => {
    const h = build({ impl: async () => [topic('1')] })
    await h.engine.pollOnce() // 基线
    h.fetchLatest.mockImplementation(async () => [topic('2', { title: '羊毛' }), topic('1')])
    h.sendHit.mockRejectedValueOnce(new TelegramError('telegram send failed after 3 attempts'))

    // 第 1 轮：真实推送失败 → 不入集，emit 失败态一次
    await h.engine.pollOnce()
    expect(h.sendHit).toHaveBeenCalledTimes(1)
    expect(h.seen.has('2')).toBe(false)
    expect(h.onHit).toHaveBeenCalledTimes(1)
    let hits = h.engine.getRecentHits()
    expect(hits).toHaveLength(1)
    expect(hits[0].notifyError).toContain('telegram send failed')
    expect(hits[0].notifiedAt).toBeNull()

    // 第 2 轮：同帖仍在首页 → 重试成功 → 入集，emit 最终态一次
    await h.engine.pollOnce()
    expect(h.sendHit).toHaveBeenCalledTimes(2)
    expect(h.seen.has('2')).toBe(true)
    expect(h.onHit).toHaveBeenCalledTimes(2) // 失败一次 + 成功一次
    hits = h.engine.getRecentHits()
    expect(hits).toHaveLength(2)
    expect(hits[1].notifiedAt).not.toBeNull()
    expect(hits[1].notifyError).toBeNull()

    // 第 3 轮：已入集，不再处理
    await h.engine.pollOnce()
    expect(h.sendHit).toHaveBeenCalledTimes(2)
    expect(h.onHit).toHaveBeenCalledTimes(2)
  })

  it('连续多轮同失败态：只 emit/log 一次，不刷屏；失败原因变化才再 emit', async () => {
    const h = build({ impl: async () => [topic('1')] })
    await h.engine.pollOnce()
    h.fetchLatest.mockImplementation(async () => [topic('2', { title: '羊毛' }), topic('1')])
    h.sendHit.mockRejectedValue(new TelegramError('telegram send failed'))

    await h.engine.pollOnce() // 首次失败：emit 1 次
    await h.engine.pollOnce() // 同失败态：不再 emit
    await h.engine.pollOnce() // 同失败态：不再 emit
    expect(h.onHit).toHaveBeenCalledTimes(1)
    expect(h.sendHit).toHaveBeenCalledTimes(3) // 但每轮都真重试了
    expect(h.seen.has('2')).toBe(false) // 始终不入集

    // 失败原因变化（不同失败态）：再 emit 一次
    h.sendHit.mockRejectedValue(new TelegramError('different failure'))
    await h.engine.pollOnce()
    expect(h.onHit).toHaveBeenCalledTimes(2)
  })

  it('待重试的帖子转为静音（notifyEnabled=false）：入集并 emit 静音最终态，不再重试', async () => {
    const h = build({ impl: async () => [topic('1')] })
    await h.engine.pollOnce()
    h.fetchLatest.mockImplementation(async () => [topic('2', { title: '羊毛' }), topic('1')])
    h.sendHit.mockRejectedValueOnce(new TelegramError('telegram send failed'))
    await h.engine.pollOnce() // 失败：1 次 emit
    expect(h.onHit).toHaveBeenCalledTimes(1)

    h.config.notifyEnabled = false
    await h.engine.pollOnce() // 静音最终态：emit 1 次并入集
    expect(h.sendHit).toHaveBeenCalledTimes(1) // 静音轮不调用 sendHit
    expect(h.seen.has('2')).toBe(true)
    expect(h.onHit).toHaveBeenCalledTimes(2)
    const last = h.onHit.mock.calls[h.onHit.mock.calls.length - 1]![0] as {
      notifiedAt: string | null
      notifyError: string | null
    }
    expect(last.notifiedAt).toBeNull()
    expect(last.notifyError).toBeNull()
  })
})

describe('失败与健康流转', () => {
  it('ChallengeError → health=challenged，间隔按指数退避放大', async () => {
    const h = build({ impl: async () => [topic('1')] })
    await h.engine.pollOnce() // 基线成功
    const spy = vi.spyOn(h.scheduler, 'setIntervalSec')

    h.fetchLatest.mockRejectedValue(new ChallengeError('nodeseek challenge: status=403'))
    await h.engine.pollOnce()
    let st = h.engine.getStatus()
    expect(st.health).toBe('challenged')
    expect(st.consecutiveFailures).toBe(1)
    expect(st.lastError).toContain('challenge')
    expect(spy).toHaveBeenLastCalledWith(computeBackoffMs(1, 60_000) / 1000) // 120

    await h.engine.pollOnce()
    st = h.engine.getStatus()
    expect(st.consecutiveFailures).toBe(2)
    expect(spy).toHaveBeenLastCalledWith(computeBackoffMs(2, 60_000) / 1000) // 240
    expect(st.health).toBe('challenged')
  })

  it('一般 Error → health=backoff；成功后复位 ok 且间隔回配置值', async () => {
    const h = build({ impl: async () => [topic('1')] })
    await h.engine.pollOnce()
    const spy = vi.spyOn(h.scheduler, 'setIntervalSec')

    h.fetchLatest.mockRejectedValueOnce(new Error('network down'))
    await h.engine.pollOnce()
    let st = h.engine.getStatus()
    expect(st.health).toBe('backoff')
    expect(st.consecutiveFailures).toBe(1)
    expect(st.lastError).toBe('network down')
    expect(spy).toHaveBeenLastCalledWith(120)

    h.fetchLatest.mockResolvedValueOnce([topic('2'), topic('1')])
    await h.engine.pollOnce()
    st = h.engine.getStatus()
    expect(st.health).toBe('ok')
    expect(st.consecutiveFailures).toBe(0)
    expect(st.lastError).toBeNull()
    expect(spy).toHaveBeenLastCalledWith(60) // 配置值
  })

  it('失败轮 seen/state 不动：去重集与 baseline 不被破坏', async () => {
    const h = build({ impl: async () => [topic('1'), topic('2')] })
    await h.engine.pollOnce() // 基线
    h.fetchLatest.mockRejectedValueOnce(new Error('boom'))
    await h.engine.pollOnce()
    expect(h.seen.size()).toBe(2)
    expect(h.state.get().baselineDone).toBe(true)
    expect(h.state.get().totalHits).toBe(0)
  })

  it('getConfig 抛错也走失败收尾：health=backoff、lastError 记录、按上次间隔退避', async () => {
    const h = build({
      impl: async () => [topic('1')],
      getConfig: () => {
        throw new Error('config store broken')
      }
    })
    await h.engine.pollOnce()
    const st = h.engine.getStatus()
    expect(st.health).toBe('backoff')
    expect(st.lastError).toContain('config store broken')
    expect(st.consecutiveFailures).toBe(1)
  })

  it('getConfig 抛错时退避基数用最近一次成功的间隔（默认 60s）', async () => {
    const cfg30: AppConfig = {
      ...structuredClone(DEFAULT_APP_CONFIG),
      includeKeywords: ['羊毛'],
      pollIntervalSec: 30,
      telegram: { botToken: 'T', chatId: 'C' }
    }
    let broken = false
    const h = build({
      impl: async () => [topic('1')],
      getConfig: () => {
        if (broken) throw new Error('config store broken')
        return cfg30
      }
    })
    const spy = vi.spyOn(h.scheduler, 'setIntervalSec')
    await h.engine.pollOnce() // 基线成功，lastIntervalSec=30
    broken = true
    await h.engine.pollOnce() // getConfig 抛错
    expect(h.engine.getStatus().health).toBe('backoff')
    expect(spy).toHaveBeenLastCalledWith(computeBackoffMs(1, 30_000) / 1000)
  })

  it('seen flush 失败：logger.warn 提示重启后可能重复，不影响本轮健康判定', async () => {
    // 用同名文件挡住 seen.json 的父目录，mkdir 失败 → flush 返回 false
    await writeFile(join(dir, 'blocker'), 'x', 'utf-8')
    const h = build({ impl: async () => [topic('1')], seenPath: join(dir, 'blocker', 'seen.json') })
    await h.engine.pollOnce() // 基线轮，flush 失败
    const st = h.engine.getStatus()
    expect(st.health).toBe('ok') // flush 失败 ≠ 轮询失败
    expect(
      h.logger
        .getRecent()
        .some((e) => e.level === 'warn' && e.msg.includes('seen flush failed'))
    ).toBe(true)
    expect(h.state.get().baselineDone).toBe(true)
  })
})

describe('生命周期与 desired 状态', () => {
  it('start：立即首轮（基线），settle 后 nextPollAt = now + interval', async () => {
    const h = build({ impl: async () => [topic('1')] })
    const t0 = Date.now()
    h.engine.start()
    expect(h.fetchLatest).toHaveBeenCalledTimes(1) // runNow 同步触发

    await Promise.all(h.ticks)
    const st = h.engine.getStatus()
    expect(st.nextPollAt).toBe(new Date(t0 + 60_000).toISOString())
    expect(st.health).toBe('ok')
  })

  it('pause/resume：desired 转换、scheduler.stop 生效、resume 立即补一轮', async () => {
    const h = build({ impl: async () => [topic('1')] })
    h.engine.start()
    await Promise.all(h.ticks)

    h.engine.pause()
    expect(h.engine.getStatus().desired).toBe('paused')
    expect(h.engine.getStatus().health).toBe('ok') // pause 不动 health
    expect(h.scheduler.isRunning).toBe(false)

    const calls = h.fetchLatest.mock.calls.length
    await vi.advanceTimersByTimeAsync(600_000)
    expect(h.fetchLatest.mock.calls.length).toBe(calls) // 停摆

    h.engine.resume()
    expect(h.engine.getStatus().desired).toBe('running')
    await Promise.all(h.ticks)
    expect(h.fetchLatest.mock.calls.length).toBe(calls + 1) // 立即补一轮
  })

  it('runNow：paused 时是 no-op（系统事件不得唤醒用户暂停的引擎）', async () => {
    const h = build({ impl: async () => [topic('1')] })
    h.engine.start()
    await Promise.all(h.ticks)
    h.engine.pause()

    const calls = h.fetchLatest.mock.calls.length
    h.engine.runNow()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.fetchLatest.mock.calls.length).toBe(calls)
    expect(h.engine.getStatus().desired).toBe('paused')
  })

  it('getStatus 返回快照：外部改动不影响引擎内部', async () => {
    const h = build({ impl: async () => [topic('1')] })
    const s1 = h.engine.getStatus()
    s1.totalHits = 999
    s1.health = 'backoff'
    expect(h.engine.getStatus().totalHits).toBe(0)
    expect(h.engine.getStatus().health).toBe('ok')
  })

  it('totalHits 跨实例恢复：从持久化 state 读取初值', async () => {
    const h = build({ impl: async () => [topic('1')] })
    await h.engine.pollOnce() // 基线
    h.fetchLatest.mockImplementation(async () => [topic('2', { title: '羊毛' }), topic('1')])
    await h.engine.pollOnce()
    expect(h.engine.getStatus().totalHits).toBe(1)
    expect(h.state.get().totalHits).toBe(1)

    const state2 = new FileEngineState(join(dir, 'state.json'))
    state2.load()
    const engine2 = new MonitorEngine({
      source: { name: 'fake', fetchLatest: async () => [] as Topic[] },
      seen: h.seen,
      state: state2,
      notifier: { sendHit: h.sendHit, sendTest: h.sendTest },
      getConfig: () => h.config,
      scheduler: h.scheduler,
      logger: createLogger()
    })
    expect(engine2.getStatus().totalHits).toBe(1)
  })

  it('onStatus 在状态变化时发出（含失败与恢复）', async () => {
    const h = build({ impl: async () => [topic('1')] })
    await h.engine.pollOnce()
    h.fetchLatest.mockRejectedValueOnce(new Error('x'))
    await h.engine.pollOnce()
    h.fetchLatest.mockResolvedValueOnce([topic('1')])
    await h.engine.pollOnce()
    const statuses = h.onStatus.mock.calls.map((c) => c[0] as ReturnType<MonitorEngine['getStatus']>)
    expect(statuses.some((s) => s.health === 'ok')).toBe(true)
    expect(statuses.some((s) => s.health === 'backoff')).toBe(true)
  })
})
