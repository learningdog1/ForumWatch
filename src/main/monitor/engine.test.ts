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
import type { SemanticEvaluator, SemanticVerdict } from '../ai/evaluator'
import { TelegramError } from '../notify/telegram'
import { createLogger, type Logger } from '../logger'
import { DEFAULT_APP_CONFIG, type AppConfig, type HitRecord, type Topic } from '../../shared/types'

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
    sourceId: '', // adapter 不盖章；engine 处理前按 adapter.id 盖章（D2/D3）
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

/** 假时钟推进（fake timers 同步冻结 Date.now）：用于跨过 per-source 退避冷却 */
function advanceMs(ms: number): void {
  vi.advanceTimersByTime(ms)
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
  /** getSources 返回的活数组：splice/push 即可模拟配置热更新 */
  sources: SourceAdapter[]
}

function build(
  opts: {
    config?: Partial<AppConfig>
    impl?: () => Promise<Topic[]>
    /** 多 source 场景：直接给 adapter 列表（默认单个 id='nodeseek'） */
    sources?: SourceAdapter[]
    /** 覆盖 getConfig（F7：注入抛错版本） */
    getConfig?: () => AppConfig
    /** 覆盖 seen 文件路径（F9：指向不可写路径让 flush 失败） */
    seenPath?: string
    /** 引擎构造前对 seen/state 预置（per-source 基线等场景） */
    preSeed?: (seen: FileSeenStore, state: FileEngineState) => void
    /** 语义评估器 mock（D4；缺省不注入 = 语义档不可用） */
    evaluator?: { evaluate: Mock }
    /** 命中持久化 mock（D5） */
    hitsStore?: { append: Mock }
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
  opts.preSeed?.(seen, state)

  const sendHit = vi.fn(async () => {})
  const sendTest = vi.fn(async () => {})
  const onHit = vi.fn()
  const onStatus = vi.fn()
  const ticks: Promise<void>[] = []

  const fetchLatest = vi.fn(opts.impl ?? (async () => [] as Topic[]))
  const sources: SourceAdapter[] =
    opts.sources ?? [{ id: 'nodeseek', name: 'NodeSeek', fetchLatest }]

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
    getSources: () => sources, // 访问器：热更新语义（D3）
    seen,
    state,
    notifier: { sendHit, sendTest },
    getConfig: opts.getConfig ?? (() => config),
    scheduler,
    logger,
    onHit,
    onStatus,
    // D4/D5：mock 对象结构满足 SemanticEvaluator / hitsStore 的结构类型
    ...(opts.evaluator !== undefined
      ? { semanticEvaluator: opts.evaluator as unknown as SemanticEvaluator }
      : {}),
    ...(opts.hitsStore !== undefined ? { hitsStore: opts.hitsStore } : {})
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
    onStatus,
    sources
  }
}

describe('首启基线（防通知风暴）', () => {
  it('首轮：全部入 seen、绝不推送、baselineDone 持久化、状态 ok', async () => {
    const h = build({ impl: async () => [topic('1', { title: '羊毛线索' }), topic('2'), topic('3')] })
    await h.engine.pollOnce()

    expect(h.sendHit).not.toHaveBeenCalled()
    expect(h.onHit).not.toHaveBeenCalled()
    expect(h.seen.has('nodeseek:1')).toBe(true)
    expect(h.seen.has('nodeseek:2')).toBe(true)
    expect(h.seen.has('nodeseek:3')).toBe(true)
    // 去重集已落盘（新实例可见）
    const seen2 = new FileSeenStore(join(dir, 'seen.json'))
    seen2.load()
    expect(seen2.size()).toBe(3)
    expect(h.state.getFor('nodeseek').baselineDone).toBe(true)

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
    expect(h.state.getFor('nodeseek').baselineDone).toBe(false)

    // 失败后该 source 进冷却（120s）：越过冷却再轮（冷却中的轮次会跳过它）
    advanceMs(computeBackoffMs(1, 60_000))
    h.fetchLatest.mockImplementation(async () => [topic('1', { title: '羊毛大促' })])
    await h.engine.pollOnce()
    expect(h.sendHit).not.toHaveBeenCalled() // 补做基线，不是推送
    expect(h.seen.has('nodeseek:1')).toBe(true)
    expect(h.state.getFor('nodeseek').baselineDone).toBe(true)
  })

  it('seen 损坏重建 + baselineDone=true → 强制补基线（ADR 8.9）：首轮无 sendHit、全部入集', async () => {
    // 第一个引擎完成基线：state.baselineDone=true，seen 已落盘
    const h = build({ impl: async () => [topic('1')] })
    await h.engine.pollOnce()
    expect(h.state.getFor('nodeseek').baselineDone).toBe(true)

    // seen.json 损坏 → FileSeenStore 重建（rebuiltFromCorrupt=true）
    await writeFile(join(dir, 'seen.json'), '{ corrupt !!!', 'utf-8')
    const seen2 = new FileSeenStore(join(dir, 'seen.json'))
    seen2.load()
    expect(seen2.rebuiltFromCorrupt).toBe(true)

    // 新引擎装配（state 仍是 baselineDone=true）：构造时重置为 false 并 warn
    const engine2 = new MonitorEngine({
      getSources: () => [{ id: 'nodeseek', name: 'fake', fetchLatest: h.fetchLatest }],
      seen: seen2,
      state: h.state,
      notifier: { sendHit: h.sendHit, sendTest: h.sendTest },
      getConfig: () => h.config,
      scheduler: h.scheduler,
      logger: h.logger
    })
    expect(h.state.getFor('nodeseek').baselineDone).toBe(false)
    expect(
      h.logger.getRecent().some((e) => e.level === 'warn' && e.msg.includes('seen store rebuilt'))
    ).toBe(true)

    // 首轮按基线处理：整页只入集不推送
    h.fetchLatest.mockImplementation(async () => [topic('1'), topic('2', { title: '羊毛' })])
    await engine2.pollOnce()
    expect(h.sendHit).not.toHaveBeenCalled()
    expect(h.onHit).not.toHaveBeenCalled()
    expect(seen2.has('nodeseek:1')).toBe(true)
    expect(seen2.has('nodeseek:2')).toBe(true)
    expect(h.state.getFor('nodeseek').baselineDone).toBe(true)
  })

  it('seen 损坏重建但 baselineDone=false：无需重置，行为不变（首启基线照做）', async () => {
    await writeFile(join(dir, 'seen.json'), '{ corrupt !!!', 'utf-8')
    const h = build({ impl: async () => [topic('1', { title: '羊毛' })] })
    expect(h.seen.rebuiltFromCorrupt).toBe(true)
    expect(h.state.getFor('nodeseek').baselineDone).toBe(false)
    await h.engine.pollOnce() // 基线
    expect(h.sendHit).not.toHaveBeenCalled()
    expect(h.seen.has('nodeseek:1')).toBe(true)
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
    expect(h.seen.has('nodeseek:4')).toBe(true)
    expect(h.seen.has('nodeseek:3')).toBe(true)

    const st = h.engine.getStatus()
    expect(st.totalHits).toBe(1)
    expect(st.health).toBe('ok')

    const hits = h.engine.getRecentHits()
    expect(hits).toHaveLength(1)
    expect(hits[0].topic.id).toBe('5')
    expect(hits[0].matchedKeywords).toEqual(['羊毛'])
    // v2：当前只有字面管线；语义评估（D4）W2 接入后此处按模式断言
    expect(hits[0].matchedBy).toBe('literal')
    expect(hits[0].semanticReason).toBeNull()
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
    expect(h.seen.has('nodeseek:2')).toBe(false)
    expect(h.seen.has('nodeseek:3')).toBe(true)
    expect(h.seen.has('nodeseek:4')).toBe(true)
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
    expect(h.seen.has('nodeseek:2')).toBe(true)
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
    expect(h.seen.has('nodeseek:2')).toBe(false)
    expect(h.onHit).toHaveBeenCalledTimes(1)
    let hits = h.engine.getRecentHits()
    expect(hits).toHaveLength(1)
    expect(hits[0].notifyError).toContain('telegram send failed')
    expect(hits[0].notifiedAt).toBeNull()

    // 第 2 轮：同帖仍在首页 → 重试成功 → 入集，emit 最终态一次
    await h.engine.pollOnce()
    expect(h.sendHit).toHaveBeenCalledTimes(2)
    expect(h.seen.has('nodeseek:2')).toBe(true)
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
    expect(h.seen.has('nodeseek:2')).toBe(false) // 始终不入集

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
    expect(h.seen.has('nodeseek:2')).toBe(true)
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
  it('ChallengeError → health=challenged，间隔按指数退避放大（冷却剩余折进全局间隔）', async () => {
    const h = build({ impl: async () => [topic('1')] })
    await h.engine.pollOnce() // 基线成功
    const spy = vi.spyOn(h.scheduler, 'setIntervalSec')

    h.fetchLatest.mockRejectedValue(new ChallengeError('nodeseek challenge: status=403'))
    await h.engine.pollOnce()
    let st = h.engine.getStatus()
    expect(st.health).toBe('challenged')
    expect(st.consecutiveFailures).toBe(1)
    expect(st.lastError).toContain('challenge')
    // 全局间隔 = max(配置 60, 冷却剩余 120s)
    expect(spy).toHaveBeenLastCalledWith(computeBackoffMs(1, 60_000) / 1000) // 120

    // 冷却结束后的失败轮才再计一次（冷却中的轮次跳过该 source）
    advanceMs(computeBackoffMs(1, 60_000))
    await h.engine.pollOnce()
    st = h.engine.getStatus()
    expect(st.consecutiveFailures).toBe(2)
    expect(spy).toHaveBeenLastCalledWith(computeBackoffMs(2, 60_000) / 1000) // 240
    expect(st.health).toBe('challenged')
    expect(st.sources[0]).toMatchObject({ sourceId: 'nodeseek', health: 'challenged' })
    expect(st.sources[0].cooldownUntil).not.toBeNull()
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

    // 越过冷却（120s）后成功 → 复位
    advanceMs(computeBackoffMs(1, 60_000))
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
    expect(h.state.getFor('nodeseek').baselineDone).toBe(true)
    expect(h.state.getFor('nodeseek').totalHits).toBe(0)
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
    expect(h.state.getFor('nodeseek').baselineDone).toBe(true)
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
    expect(h.state.getFor('nodeseek').totalHits).toBe(1)

    const state2 = new FileEngineState(join(dir, 'state.json'))
    state2.load()
    const engine2 = new MonitorEngine({
      getSources: () => [{ id: 'nodeseek', name: 'fake', fetchLatest: async () => [] as Topic[] }],
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
    advanceMs(computeBackoffMs(1, 60_000)) // 越过冷却
    h.fetchLatest.mockResolvedValueOnce([topic('1')])
    await h.engine.pollOnce()
    const statuses = h.onStatus.mock.calls.map((c) => c[0] as ReturnType<MonitorEngine['getStatus']>)
    expect(statuses.some((s) => s.health === 'ok')).toBe(true)
    expect(statuses.some((s) => s.health === 'backoff')).toBe(true)
  })
})

describe('多来源（D3：单引擎循环多 source）', () => {
  it('双 source：一个被挑战一个正常 → 正常的仍被处理推送，全局 health=challenged', async () => {
    const fetchA = vi.fn(async () => {
      throw new ChallengeError('cf challenge: status=403')
    })
    const fetchB = vi.fn(async () => [topic('b1')])
    const h = build({
      sources: [
        { id: 'forumA', name: 'Forum A', fetchLatest: fetchA },
        { id: 'forumB', name: 'Forum B', fetchLatest: fetchB }
      ]
    })
    // 第 1 轮：A 失败（challenged，进冷却）；B 首启基线（不推送）
    await h.engine.pollOnce()
    expect(h.sendHit).not.toHaveBeenCalled()
    expect(h.seen.has('forumB:b1')).toBe(true)
    expect(h.state.getFor('forumB').baselineDone).toBe(true)

    // 第 2 轮：A 冷却中被跳过；B 出新帖 → 照常命中推送
    fetchB.mockResolvedValue([topic('b2', { title: '羊毛B' }), topic('b1')])
    await h.engine.pollOnce()
    expect(fetchA).toHaveBeenCalledTimes(1) // 冷却中未被重试
    expect(h.sendHit).toHaveBeenCalledTimes(1)
    expect(h.sendHit.mock.calls[0][0]).toMatchObject({ id: 'b2', sourceId: 'forumB' })
    expect(h.seen.has('forumB:b2')).toBe(true)
    expect(h.state.getFor('forumB').totalHits).toBe(1) // per-source 累计

    // 全局聚合：health 取最差；per-source 快照各自独立
    const st = h.engine.getStatus()
    expect(st.health).toBe('challenged')
    expect(st.consecutiveFailures).toBe(1)
    expect(st.lastError).toContain('challenge')
    expect(st.sources.map((s) => s.sourceId)).toEqual(['forumA', 'forumB'])
    const [sa, sb] = st.sources
    expect(sa).toMatchObject({ sourceId: 'forumA', health: 'challenged', consecutiveFailures: 1, lastSuccessAt: null })
    expect(sa.cooldownUntil).not.toBeNull()
    expect(sb).toMatchObject({ sourceId: 'forumB', health: 'ok', consecutiveFailures: 0, cooldownUntil: null })
    expect(sb.lastSuccessAt).not.toBeNull()
  })

  it('冷却中的 source 被跳过：不重复抓取、failures 不增；越过后恢复轮询', async () => {
    const h = build({ impl: async () => [topic('1')] })
    await h.engine.pollOnce() // 基线成功
    h.fetchLatest.mockRejectedValue(new Error('net down'))
    await h.engine.pollOnce() // 失败 1：冷却 = now + 120s
    expect(h.engine.getStatus().consecutiveFailures).toBe(1)
    expect(h.fetchLatest).toHaveBeenCalledTimes(2)

    await h.engine.pollOnce() // 冷却中：本轮跳过该 source
    expect(h.fetchLatest).toHaveBeenCalledTimes(2)
    expect(h.engine.getStatus().consecutiveFailures).toBe(1) // 不动 failures
    expect(h.engine.getStatus().sources[0]?.cooldownUntil).not.toBeNull()

    advanceMs(computeBackoffMs(1, 60_000)) // 越过冷却
    h.fetchLatest.mockResolvedValue([topic('1')])
    await h.engine.pollOnce()
    expect(h.fetchLatest).toHaveBeenCalledTimes(3)
    expect(h.engine.getStatus().health).toBe('ok')
  })

  it('sourceId 盖章与 seen 前缀按 source 隔离（键 = `${sourceId}:${topic.id}`）', async () => {
    const fetchA = vi.fn(async () => [topic('1', { title: '羊毛AA' })])
    const fetchB = vi.fn(async () => [topic('1', { title: '羊毛BB' })])
    const h = build({
      sources: [
        { id: 'aa', name: 'A', fetchLatest: fetchA },
        { id: 'bb', name: 'B', fetchLatest: fetchB }
      ]
    })
    // 两个 source 都未基线：首轮全量入集（各自的 `${sourceId}:${id}` 键）不推送
    await h.engine.pollOnce()
    expect(h.sendHit).not.toHaveBeenCalled()
    expect(h.seen.has('aa:1')).toBe(true)
    expect(h.seen.has('bb:1')).toBe(true)
    expect(h.seen.has('nodeseek:1')).toBe(false) // 无串键

    // 第 2 轮各出新帖（同 topic.id）：互不干扰，engine 处理前各自盖章
    fetchA.mockResolvedValue([topic('2', { title: '羊毛A2' })])
    fetchB.mockResolvedValue([topic('2', { title: '羊毛B2' })])
    await h.engine.pollOnce()
    expect(h.sendHit).toHaveBeenCalledTimes(2)
    expect(h.sendHit.mock.calls.map((c) => (c[0] as Topic).sourceId).sort()).toEqual(['aa', 'bb'])
    expect(h.seen.has('aa:2')).toBe(true)
    expect(h.seen.has('bb:2')).toBe(true)
    for (const x of h.engine.getRecentHits()) {
      expect(['aa', 'bb']).toContain(x.topic.sourceId) // HitRecord 里的 topic 同样带章
    }
  })

  it('per-source baseline 独立：A 已基线、B 未基线 → B 首轮全量入集不推送，A 正常推送', async () => {
    const fetchA = vi.fn(async () => [topic('a0'), topic('a1', { title: '羊毛A' })])
    const fetchB = vi.fn(async () => [topic('b1', { title: '羊毛B' })])
    const h = build({
      sources: [
        { id: 'aa', name: 'A', fetchLatest: fetchA },
        { id: 'bb', name: 'B', fetchLatest: fetchB }
      ],
      preSeed: (seen, state) => {
        state.setFor('aa', { baselineDone: true })
        seen.add('aa:a0') // A 的存量帖已在集：只有 a1 是新的
      }
    })
    await h.engine.pollOnce()
    // A 已基线：a1 命中正常推送；B 未基线：整页（含会命中的 b1）只入集不推送
    expect(h.sendHit).toHaveBeenCalledTimes(1)
    expect(h.sendHit.mock.calls[0][0]).toMatchObject({ id: 'a1', sourceId: 'aa' })
    expect(h.seen.has('bb:b1')).toBe(true)
    expect(h.state.getFor('bb').baselineDone).toBe(true) // B 本轮完成基线

    // B 基线后，下一轮新帖才走正常推送管线
    fetchB.mockResolvedValue([topic('b2', { title: '羊毛B2' })])
    await h.engine.pollOnce()
    expect(h.sendHit).toHaveBeenCalledTimes(2)
    expect(h.sendHit.mock.calls[1][0]).toMatchObject({ id: 'b2', sourceId: 'bb' })
  })

  it('全局 scheduler 间隔 = max(配置间隔, 最差 source 剩余退避)；全部健康回配置值', async () => {
    const fetchA = vi.fn(async () => [topic('a1')])
    const fetchB = vi.fn(async () => [topic('b1')])
    const h = build({
      sources: [
        { id: 'forumA', name: 'A', fetchLatest: fetchA },
        { id: 'forumB', name: 'B', fetchLatest: fetchB }
      ]
    })
    const spy = vi.spyOn(h.scheduler, 'setIntervalSec')
    await h.engine.pollOnce() // 双 source 基线成功
    expect(spy).toHaveBeenLastCalledWith(60) // 全部健康：配置值

    // A 失败（backoff 120s）、B 健康：全局间隔抬到最差剩余退避
    fetchA.mockRejectedValue(new Error('a down'))
    await h.engine.pollOnce()
    expect(spy).toHaveBeenLastCalledWith(120)

    // 冷却过半（剩余 60s）：间隔随剩余退避回落，但不再低于配置值
    advanceMs(60_000)
    await h.engine.pollOnce() // A 跳过、B 成功
    expect(spy).toHaveBeenLastCalledWith(60)
    expect(fetchA).toHaveBeenCalledTimes(2) // A 冷却中未重试

    // A 冷却结束并恢复：全部健康 → 回配置值
    advanceMs(60_000)
    fetchA.mockResolvedValue([topic('a1')])
    await h.engine.pollOnce()
    expect(fetchA).toHaveBeenCalledTimes(3)
    expect(spy).toHaveBeenLastCalledWith(60)
    expect(h.engine.getStatus().health).toBe('ok')
  })

  it('getSources 返回空数组：pollOnce 安全通过，不算失败', async () => {
    const h = build()
    h.sources.splice(0, h.sources.length) // 模拟配置里没有任何可用来源
    await h.engine.pollOnce()
    const st = h.engine.getStatus()
    expect(st.health).toBe('ok')
    expect(st.consecutiveFailures).toBe(0)
    expect(st.lastError).toBeNull()
    expect(st.sources).toEqual([])
    expect(st.lastSuccessAt).toBeNull() // 没有实际抓取，不算成功
    expect(h.fetchLatest).not.toHaveBeenCalled()
  })
})

describe('语义评估管线（D4）', () => {
  /** 已配置好的 AI 段（provider 三项齐备） */
  function aiConfig(overrides: Partial<AppConfig['ai']> = {}): AppConfig['ai'] {
    return {
      provider: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-k', model: 'm' },
      matchMode: 'both',
      interests: ['自建主机'],
      dailyReport: { enabled: false, timeHHMM: '22:00' },
      ...overrides
    }
  }

  it("both 模式：literal 命中不走 AI（evaluate 不被调），matchedBy='literal'", async () => {
    const evaluate = vi.fn(
      async (_topics: Topic[], _interests: string[]) => new Map<string, SemanticVerdict>()
    )
    const h = build({
      impl: async () => [topic('1')],
      config: { ai: aiConfig({ matchMode: 'both' }) },
      evaluator: { evaluate }
    })
    await h.engine.pollOnce() // 基线
    h.fetchLatest.mockImplementation(async () => [topic('2', { title: '羊毛大促' }), topic('1')])
    await h.engine.pollOnce()

    expect(evaluate).not.toHaveBeenCalled()
    expect(h.sendHit).toHaveBeenCalledTimes(1)
    const hits = h.engine.getRecentHits()
    expect(hits[0]).toMatchObject({ matchedBy: 'literal', semanticReason: null, matchedKeywords: ['羊毛'] })
    expect(h.seen.has('nodeseek:2')).toBe(true)
  })

  it("AI 命中：processHit 走 semantic 分支，matchedBy='semantic'、matchedKeywords=[]、semanticReason 透传", async () => {
    const evaluate = vi.fn(
      async (_topics: Topic[], _interests: string[]) =>
        new Map<string, SemanticVerdict>([
          ['nodeseek:2', { hit: true, reason: '与自建主机兴趣明确相关' }]
        ])
    )
    const h = build({
      impl: async () => [topic('1')],
      config: { ai: aiConfig({ matchMode: 'semantic' }) },
      evaluator: { evaluate }
    })
    await h.engine.pollOnce() // 基线
    h.fetchLatest.mockImplementation(async () => [topic('2', { title: '出手一台家用小主机' }), topic('1')])
    await h.engine.pollOnce()

    expect(evaluate).toHaveBeenCalledTimes(1)
    const [topicsArg, interestsArg] = evaluate.mock.calls[0]!
    expect(topicsArg.map((t) => t.id)).toEqual(['2'])
    expect(topicsArg[0].sourceId).toBe('nodeseek') // 盖章后才进批
    expect(interestsArg).toEqual(['自建主机'])

    expect(h.sendHit).toHaveBeenCalledTimes(1)
    expect(h.sendHit.mock.calls[0][1]).toEqual([]) // semantic 命中不带关键词
    const hits = h.engine.getRecentHits()
    expect(hits[0]).toMatchObject({
      matchedBy: 'semantic',
      matchedKeywords: [],
      semanticReason: '与自建主机兴趣明确相关'
    })
    expect(hits[0].notifiedAt).not.toBeNull()
    expect(h.seen.has('nodeseek:2')).toBe(true)
    const st = h.engine.getStatus()
    expect(st.ai).toMatchObject({ configured: true, effectiveMode: 'semantic', degraded: 'none', callsToday: 1 })
  })

  it('verdict hit:false：入 seen（与字面未命中同待遇），下轮不再重评', async () => {
    const evaluate = vi.fn(
      async (_topics: Topic[], _interests: string[]) =>
        new Map<string, SemanticVerdict>([['nodeseek:2', { hit: false, reason: null }]])
    )
    const h = build({
      impl: async () => [topic('1')],
      config: { ai: aiConfig({ matchMode: 'semantic' }) },
      evaluator: { evaluate }
    })
    await h.engine.pollOnce()
    h.fetchLatest.mockImplementation(async () => [topic('2'), topic('1')])
    await h.engine.pollOnce()
    expect(evaluate).toHaveBeenCalledTimes(1)
    expect(h.seen.has('nodeseek:2')).toBe(true)
    expect(h.sendHit).not.toHaveBeenCalled()

    await h.engine.pollOnce() // 同帖在首页：已入 seen，不进批
    expect(evaluate).toHaveBeenCalledTimes(1)
  })

  it('未决（Map 缺键）：不入 seen，下轮重评；>12 帖自动切片（12+1 两批）', async () => {
    const evaluate = vi.fn(
      async (_topics: Topic[], _interests: string[]) => new Map<string, SemanticVerdict>()
    ) // 全部未决
    const h = build({
      impl: async () => [topic('0')],
      config: { ai: aiConfig({ matchMode: 'semantic' }) },
      evaluator: { evaluate }
    })
    await h.engine.pollOnce() // 基线
    // 13 条新帖（页面最新在前）：期望 2 批（12 + 1），批内顺序旧→新
    const fresh = Array.from({ length: 13 }, (_, i) => topic(String(20 - i)))
    h.fetchLatest.mockImplementation(async () => [...fresh, topic('0')])
    await h.engine.pollOnce()

    expect(evaluate).toHaveBeenCalledTimes(2)
    const sizes = evaluate.mock.calls.map(([t]) => t.length)
    expect(sizes).toEqual([12, 1])
    expect(evaluate.mock.calls[0]![0][0].id).toBe('8') // 批内最旧
    for (const t of fresh) expect(h.seen.has(`nodeseek:${t.id}`)).toBe(false) // 未决不入 seen

    await h.engine.pollOnce() // 全部重评
    expect(evaluate).toHaveBeenCalledTimes(4)
    expect(h.seen.size()).toBe(1) // 仍只有基线那条
  })

  it('evaluate 抛错：该批全部未决（不入 seen）、lastAiError 记录、consecutiveFailures 不动、health 不受影响', async () => {
    const evaluate = vi.fn(
      async (_topics: Topic[], _interests: string[]): Promise<Map<string, SemanticVerdict>> => {
        throw new Error('AI provider network error: fetch failed')
      }
    )
    const h = build({
      impl: async () => [topic('1')],
      config: { ai: aiConfig({ matchMode: 'semantic' }) },
      evaluator: { evaluate }
    })
    await h.engine.pollOnce() // 基线
    h.fetchLatest.mockImplementation(async () => [topic('2'), topic('1')])
    await h.engine.pollOnce()

    expect(evaluate).toHaveBeenCalledTimes(1)
    expect(h.seen.has('nodeseek:2')).toBe(false)
    const st = h.engine.getStatus()
    expect(st.health).toBe('ok') // AI 故障 ≠ 抓取故障
    expect(st.consecutiveFailures).toBe(0)
    expect(st.ai.lastAiError).toContain('AI provider network error')
    expect(st.ai.callsToday).toBe(1) // 失败的调用也计数
    expect(
      h.logger.getRecent().some((e) => e.level === 'warn' && e.msg.includes('semantic evaluation failed'))
    ).toBe(true)

    // 恢复：评估成功后 lastAiError 清空
    evaluate.mockImplementation(async (_topics: Topic[], _interests: string[]) =>
      new Map<string, SemanticVerdict>([['nodeseek:2', { hit: false, reason: null }]])
    )
    await h.engine.pollOnce()
    expect(h.engine.getStatus().ai.lastAiError).toBeNull()
  })

  it('每日配额 300：达限后降级 literal-only（不再调 evaluate），未决帖按字面语义入 seen，log 一次', async () => {
    const evaluate = vi.fn(
      async (_topics: Topic[], _interests: string[]) => new Map<string, SemanticVerdict>()
    ) // 全部未决 → 每轮重评
    const h = build({
      impl: async () => [topic('0')],
      config: { ai: aiConfig({ matchMode: 'semantic' }) },
      evaluator: { evaluate }
    })
    await h.engine.pollOnce() // 基线
    // 13 条新帖 = 2 批/轮；未决不入 seen → 每轮固定 2 次调用
    const fresh = Array.from({ length: 13 }, (_, i) => topic(String(20 - i)))
    h.fetchLatest.mockImplementation(async () => [...fresh, topic('0')])
    await h.engine.pollOnce() // callsToday = 2
    // 再跑 148 轮 → 2 + 148*2 = 298
    for (let r = 0; r < 148; r++) await h.engine.pollOnce()
    expect(h.engine.getStatus().ai.callsToday).toBe(298)
    expect(h.seen.size()).toBe(1) // 13 帖全部未决，仍在集外

    // 第 150 轮：页面新增 25 条（共 38 未决 = 4 批）；批 1/2 调用后 callsToday=300，
    // 批 3 触发达限 break + log（剩余 14 帖保持未决）
    const more = Array.from({ length: 25 }, (_, i) => topic(String(50 - i)))
    h.fetchLatest.mockImplementation(async () => [...more, ...fresh, topic('0')])
    await h.engine.pollOnce()
    expect(evaluate).toHaveBeenCalledTimes(300)
    expect(h.engine.getStatus().ai.callsToday).toBe(300)
    expect(h.engine.getStatus().ai.degraded).toBe('quota-exhausted')
    expect(h.seen.size()).toBe(1)

    // 下一轮：配额耗尽 → 降级 literal-only，evaluate 不再被调，未命中帖全部入 seen
    await h.engine.pollOnce()
    expect(evaluate).toHaveBeenCalledTimes(300)
    const st = h.engine.getStatus()
    expect(st.ai).toMatchObject({ degraded: 'quota-exhausted', effectiveMode: 'literal', callsToday: 300 })
    expect(h.seen.size()).toBe(39) // 38 新帖 + 基线帖
    const quotaLogs = h.logger
      .getRecent()
      .filter((e) => e.msg.includes('AI daily call limit reached'))
    expect(quotaLogs).toHaveLength(1)
  })

  it('unconfigured：mode=semantic 但 provider 未配 → effectiveMode=literal、degraded=unconfigured、不算失败', async () => {
    const evaluate = vi.fn(
      async (_topics: Topic[], _interests: string[]) => new Map<string, SemanticVerdict>()
    )
    const h = build({
      impl: async () => [topic('1')],
      config: {
        ai: aiConfig({ matchMode: 'semantic', provider: { baseUrl: '', apiKey: '', model: '' } })
      },
      evaluator: { evaluate }
    })
    await h.engine.pollOnce() // 基线
    h.fetchLatest.mockImplementation(async () => [topic('2'), topic('1')])
    await h.engine.pollOnce()

    expect(evaluate).not.toHaveBeenCalled() // 降级字面档，语义批不存在
    expect(h.sendHit).not.toHaveBeenCalled() // 字面未命中（标题不含关键词）
    expect(h.seen.has('nodeseek:2')).toBe(true) // 字面档未命中入 seen
    const st = h.engine.getStatus()
    expect(st.ai).toMatchObject({
      configured: false,
      effectiveMode: 'literal',
      degraded: 'unconfigured',
      lastAiError: null
    })
    expect(st.health).toBe('ok')
    expect(st.consecutiveFailures).toBe(0)
  })

  it('纯 semantic 模式：标题即使字面可命中也不走字面管线，仍进 AI（字面结果不被改变）', async () => {
    const evaluate = vi.fn(
      async (_topics: Topic[], _interests: string[]) =>
        new Map<string, SemanticVerdict>([['nodeseek:2', { hit: false, reason: null }]])
    )
    const h = build({
      impl: async () => [topic('1')],
      config: { ai: aiConfig({ matchMode: 'semantic' }) },
      evaluator: { evaluate }
    })
    await h.engine.pollOnce()
    h.fetchLatest.mockImplementation(async () => [topic('2', { title: '羊毛大促' }), topic('1')])
    await h.engine.pollOnce()

    expect(evaluate).toHaveBeenCalledTimes(1) // 进了 AI（ despite 字面可命中）
    expect(evaluate.mock.calls[0]![0].map((t) => t.id)).toEqual(['2'])
    expect(h.sendHit).not.toHaveBeenCalled() // AI 判 miss → 不推送
    expect(h.seen.has('nodeseek:2')).toBe(true)
  })

  it('排除词一票否决先于 AI：被否决帖不进批、入 seen', async () => {
    const evaluate = vi.fn(
      async (_topics: Topic[], _interests: string[]) => new Map<string, SemanticVerdict>()
    )
    const h = build({
      impl: async () => [topic('1')],
      config: { ai: aiConfig({ matchMode: 'semantic' }) },
      evaluator: { evaluate }
    })
    await h.engine.pollOnce()
    h.fetchLatest.mockImplementation(async () => [topic('2', { title: '小主机广告' }), topic('1')])
    await h.engine.pollOnce()

    expect(evaluate).not.toHaveBeenCalled() // 排除词否决：不进语义批
    expect(h.seen.has('nodeseek:2')).toBe(true)
    expect(h.sendHit).not.toHaveBeenCalled()
  })

  it('interests 为空且 mode 含 semantic：不降级 unconfigured，语义批照走（evaluator 自身全判 miss）', async () => {
    const evaluate = vi.fn(
      async (_topics: Topic[], _interests: string[]) =>
        new Map<string, SemanticVerdict>([['nodeseek:2', { hit: false, reason: null }]])
    )
    const h = build({
      impl: async () => [topic('1')],
      config: { ai: aiConfig({ matchMode: 'both', interests: [] }) },
      evaluator: { evaluate }
    })
    await h.engine.pollOnce()
    h.fetchLatest.mockImplementation(async () => [topic('2'), topic('1')])
    await h.engine.pollOnce()

    expect(evaluate).toHaveBeenCalledTimes(1)
    const st = h.engine.getStatus()
    expect(st.ai).toMatchObject({ configured: true, effectiveMode: 'both', degraded: 'none' })
    expect(h.seen.has('nodeseek:2')).toBe(true) // miss 入 seen
  })

  it('hitsStore.append：每次命中被调用且收到 HitRecord；append 抛错只 warn，不影响推送与 onHit', async () => {
    const append = vi.fn(async (_hit: HitRecord, _now?: Date) => {
      throw new Error('EACCES: permission denied')
    })
    const h = build({
      impl: async () => [topic('1')],
      config: { includeKeywords: ['羊毛'] },
      hitsStore: { append }
    })
    await h.engine.pollOnce() // 基线
    h.fetchLatest.mockImplementation(async () => [topic('2', { title: '羊毛' }), topic('1')])
    await h.engine.pollOnce()

    expect(append).toHaveBeenCalledTimes(1)
    const [hitArg, nowArg] = append.mock.calls[0] as [HitRecord, Date]
    expect(hitArg.topic.id).toBe('2')
    expect(hitArg.matchedBy).toBe('literal')
    expect(nowArg).toBeInstanceOf(Date)
    // 推送不受 append 失败影响
    expect(h.sendHit).toHaveBeenCalledTimes(1)
    expect(h.onHit).toHaveBeenCalledTimes(1)
    expect(h.engine.getRecentHits()).toHaveLength(1)
    expect(h.seen.has('nodeseek:2')).toBe(true)
    expect(
      h.logger.getRecent().some((e) => e.level === 'warn' && e.msg.includes('hits append failed'))
    ).toBe(true)
  })
})
