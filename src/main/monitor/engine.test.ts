/**
 * MonitorEngine 全量单测：source/notifier 全 mock、seen/state 走真实 FileSeenStore /
 * FileEngineState（tmpdir）、scheduler 用真实 PollScheduler（fake timers）、
 * matchTopic 用真实现。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  DAILY_AI_CALL_LIMIT,
  DAILY_COMMENTARY_LIMIT,
  MonitorEngine
} from './engine'
import { computeBackoffMs, PollScheduler } from './poller'
import { FileSeenStore } from './dedup'
import { FileEngineState } from './state'
import { ChallengeError, type SourceAdapter } from './types'
import type { SemanticEvaluator, SemanticVerdict } from '../ai/evaluator'
import { CommentGenerator } from '../ai/commentary'
import type { ChatRequest } from '../ai/provider'
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
    /** 锐评生成器（第三轮；mock 或真实 CommentGenerator 实例；缺省不注入 = 恒无锐评） */
    commentaryGenerator?: Pick<CommentGenerator, 'generate' | 'prune'>
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
    ...(opts.hitsStore !== undefined ? { hitsStore: opts.hitsStore } : {}),
    // 第三轮：锐评生成器可选注入（不注入 = 恒 null，与旧装配行为一致）
    ...(opts.commentaryGenerator !== undefined
      ? { commentaryGenerator: opts.commentaryGenerator }
      : {})
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

/** 观测引擎私有重试 Map 的尺寸（两 Map 无对外 API，测试专用观测面） */
function retryMapSize(
  engine: MonitorEngine,
  name: 'semanticVerdicts' | 'pendingNotifyErrors'
): number {
  return (engine as unknown as Record<string, Map<string, unknown>>)[name]!.size
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
      commentary: { enabled: false },
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

  it('interests 为空（F3）：不调 evaluator、callsToday 不涨，全部按语义未命中入 seen，不降级 unconfigured', async () => {
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
    h.fetchLatest.mockImplementation(async () => [topic('2'), topic('3'), topic('1')])
    await h.engine.pollOnce()

    // 引擎侧短路：连 evaluator 都不进（快速全 miss 也不必走），更不计数
    expect(evaluate).not.toHaveBeenCalled()
    const st = h.engine.getStatus()
    expect(st.ai).toMatchObject({ configured: true, effectiveMode: 'both', degraded: 'none', callsToday: 0 })
    expect(h.seen.has('nodeseek:2')).toBe(true) // 按语义未命中入 seen
    expect(h.seen.has('nodeseek:3')).toBe(true)
    expect(h.sendHit).not.toHaveBeenCalled()

    await h.engine.pollOnce() // 已入 seen：下轮不重评
    expect(evaluate).not.toHaveBeenCalled()
    expect(st.ai.callsToday).toBe(0)
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

describe('语义命中推送失败的 verdict 缓存（D4 坑⑥ / F2）与轮末清理（F5）', () => {
  /** 已配置好的 AI 段（provider 三项齐备） */
  function aiConfig(overrides: Partial<AppConfig['ai']> = {}): AppConfig['ai'] {
    return {
      provider: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-k', model: 'm' },
      matchMode: 'both',
      interests: ['自建主机'],
      dailyReport: { enabled: false, timeHHMM: '22:00' },
      commentary: { enabled: false },
      ...overrides
    }
  }

  it('语义命中×推送失败：reason 进缓存；下轮不进 AI 批直接重试；成功后缓存清除，再下轮不复活', async () => {
    const evaluate = vi.fn(
      async (_topics: Topic[], _interests: string[]) =>
        new Map<string, SemanticVerdict>([['nodeseek:2', { hit: true, reason: '与自建主机相关' }]])
    )
    const h = build({
      impl: async () => [topic('1')],
      config: { ai: aiConfig({ matchMode: 'semantic' }) },
      evaluator: { evaluate }
    })
    await h.engine.pollOnce() // 基线

    // 第 1 轮：AI 判 hit，推送失败 → 不入 seen，verdict 进缓存
    h.fetchLatest.mockImplementation(async () => [topic('2'), topic('1')])
    h.sendHit.mockRejectedValueOnce(new TelegramError('telegram send failed'))
    await h.engine.pollOnce()
    expect(evaluate).toHaveBeenCalledTimes(1)
    expect(h.onHit).toHaveBeenCalledTimes(1)
    expect(h.seen.has('nodeseek:2')).toBe(false)
    expect(retryMapSize(h.engine, 'semanticVerdicts')).toBe(1)
    expect(retryMapSize(h.engine, 'pendingNotifyErrors')).toBe(1)

    // 第 2 轮：同帖仍在首页 → 不调 evaluator（缓存生效），按已判 hit 重试推送成功
    await h.engine.pollOnce()
    expect(evaluate).toHaveBeenCalledTimes(1) // 未重进 AI 批
    expect(h.sendHit).toHaveBeenCalledTimes(2)
    const hits = h.engine.getRecentHits()
    expect(hits[1]).toMatchObject({
      matchedBy: 'semantic',
      matchedKeywords: [],
      semanticReason: '与自建主机相关', // 缓存的 reason 透传
      notifiedAt: expect.any(String),
      notifyError: null
    })
    expect(h.onHit).toHaveBeenCalledTimes(2) // 失败态 + 最终态
    expect(h.seen.has('nodeseek:2')).toBe(true) // 成功入 seen
    expect(retryMapSize(h.engine, 'semanticVerdicts')).toBe(0) // 缓存清除
    expect(retryMapSize(h.engine, 'pendingNotifyErrors')).toBe(0)

    // 第 3 轮：已入 seen 不会复活（不重评、不重推）
    await h.engine.pollOnce()
    expect(evaluate).toHaveBeenCalledTimes(1)
    expect(h.sendHit).toHaveBeenCalledTimes(2)
    expect(h.onHit).toHaveBeenCalledTimes(2)
  })

  it('重试仍失败：缓存保留继续重试（每轮都真推），同失败态仍只 emit 一次', async () => {
    const evaluate = vi.fn(
      async (_topics: Topic[], _interests: string[]) =>
        new Map<string, SemanticVerdict>([['nodeseek:2', { hit: true, reason: '相关' }]])
    )
    const h = build({
      impl: async () => [topic('1')],
      config: { ai: aiConfig({ matchMode: 'semantic' }) },
      evaluator: { evaluate }
    })
    await h.engine.pollOnce()
    h.fetchLatest.mockImplementation(async () => [topic('2'), topic('1')])
    h.sendHit.mockRejectedValue(new TelegramError('telegram send failed'))
    await h.engine.pollOnce() // 首败：emit 1 次
    await h.engine.pollOnce() // 重试仍败（同失败态）：不再 emit，但真重试了
    expect(evaluate).toHaveBeenCalledTimes(1) // 仍不进 AI 批
    expect(h.sendHit).toHaveBeenCalledTimes(2)
    expect(h.onHit).toHaveBeenCalledTimes(1)
    expect(h.seen.has('nodeseek:2')).toBe(false)
    expect(retryMapSize(h.engine, 'semanticVerdicts')).toBe(1) // 缓存保留继续重试
    expect(retryMapSize(h.engine, 'pendingNotifyErrors')).toBe(1)

    // 失败原因变化：再 emit 一次（缓存仍在）
    h.sendHit.mockRejectedValue(new TelegramError('different failure'))
    await h.engine.pollOnce()
    expect(h.sendHit).toHaveBeenCalledTimes(3)
    expect(h.onHit).toHaveBeenCalledTimes(2)
    expect(retryMapSize(h.engine, 'semanticVerdicts')).toBe(1)
  })

  it('字面命中的推送失败不使用 verdict 缓存：照旧走 pendingNotifyErrors 路径，两套机制不串', async () => {
    const evaluate = vi.fn(
      async (_topics: Topic[], _interests: string[]) => new Map<string, SemanticVerdict>()
    )
    const h = build({
      impl: async () => [topic('1')],
      config: { ai: aiConfig({ matchMode: 'both' }) }, // both：字面优先
      evaluator: { evaluate }
    })
    await h.engine.pollOnce()
    h.fetchLatest.mockImplementation(async () => [topic('2', { title: '羊毛大促' }), topic('1')])
    h.sendHit.mockRejectedValueOnce(new TelegramError('telegram send failed'))
    await h.engine.pollOnce() // 字面命中推送失败

    expect(evaluate).not.toHaveBeenCalled() // 字面命中从不进 AI
    expect(retryMapSize(h.engine, 'semanticVerdicts')).toBe(0) // 不写 verdict 缓存
    expect(retryMapSize(h.engine, 'pendingNotifyErrors')).toBe(1) // 只进失败表

    // 第 2 轮：字面管线照旧重试（不走语义路径），成功后两表都清
    await h.engine.pollOnce()
    expect(h.sendHit).toHaveBeenCalledTimes(2)
    expect(h.sendHit.mock.calls[1]![1]).toEqual(['羊毛']) // 仍是字面命中形态
    const hits = h.engine.getRecentHits()
    expect(hits[1]).toMatchObject({ matchedBy: 'literal', matchedKeywords: ['羊毛'] })
    expect(h.seen.has('nodeseek:2')).toBe(true)
    expect(retryMapSize(h.engine, 'semanticVerdicts')).toBe(0)
    expect(retryMapSize(h.engine, 'pendingNotifyErrors')).toBe(0)
  })

  it('F5：失败帖滚出首页 → 轮末清理，pendingNotifyErrors 与 semanticVerdicts 尺寸归零', async () => {
    const evaluate = vi.fn(
      async (_topics: Topic[], _interests: string[]) =>
        new Map<string, SemanticVerdict>([['nodeseek:2', { hit: true, reason: '相关' }]])
    )
    const h = build({
      impl: async () => [topic('1')],
      config: { ai: aiConfig({ matchMode: 'both' }) },
      evaluator: { evaluate }
    })
    await h.engine.pollOnce()
    // 一条语义命中（推送失败）+ 一条字面命中（推送失败）
    h.fetchLatest.mockImplementation(async () => [
      topic('3', { title: '羊毛' }),
      topic('2'),
      topic('1')
    ])
    h.sendHit.mockRejectedValue(new TelegramError('telegram send failed'))
    await h.engine.pollOnce()
    expect(retryMapSize(h.engine, 'semanticVerdicts')).toBe(1)
    expect(retryMapSize(h.engine, 'pendingNotifyErrors')).toBe(2)

    // 下一轮两条帖子都滚出首页：重试已无意义，轮末清理
    h.fetchLatest.mockImplementation(async () => [topic('1')])
    await h.engine.pollOnce()
    expect(retryMapSize(h.engine, 'semanticVerdicts')).toBe(0)
    expect(retryMapSize(h.engine, 'pendingNotifyErrors')).toBe(0)
    expect(h.sendHit).toHaveBeenCalledTimes(2) // 滚出后不再重试
  })
})

describe('旧帖过滤（W3：新帖 vs 回复顶起旧帖，creationOrderedIds 来源）', () => {
  /** 已配置好的 AI 段（provider 三项齐备）——语义未决豁免用例需要 */
  function aiConfig(overrides: Partial<AppConfig['ai']> = {}): AppConfig['ai'] {
    return {
      provider: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-k', model: 'm' },
      matchMode: 'semantic',
      interests: ['自建主机'],
      dailyReport: { enabled: false, timeHHMM: '22:00' },
      commentary: { enabled: false },
      ...overrides
    }
  }

  /** 带 creationOrderedIds 能力声明的假 source（id 随创建单调递增的来源语义） */
  function idOrderedSource(fetchLatest: Mock): SourceAdapter {
    return { id: 'nodeseek', name: 'NodeSeek', creationOrderedIds: true, fetchLatest }
  }

  it('老帖顶起不推送：id ≤ 阈值的 unseen 帖入 seen、无推送；同页新帖（id > 阈值）照常命中推送', async () => {
    const fetchLatest = vi.fn(async () => [topic('1002'), topic('1001'), topic('1000')])
    const h = build({ sources: [idOrderedSource(fetchLatest)] })
    await h.engine.pollOnce() // 基线：阈值同轮初始化为整页 max 1002
    expect(h.state.getFor('nodeseek').maxSeenTopicId).toBe(1002)

    // 下轮页面混入被回复顶回首页的旧帖（id 800，从未入 seen，标题可命中）+ 新帖 1003
    fetchLatest.mockImplementation(async () => [
      topic('1003', { title: '羊毛新帖' }),
      topic('800', { title: '羊毛旧帖被顶起' }),
      topic('1002')
    ])
    await h.engine.pollOnce()

    // 旧帖：入 seen、绝不推送/不进命中管线
    expect(h.seen.has('nodeseek:800')).toBe(true)
    expect(h.sendHit).toHaveBeenCalledTimes(1)
    expect(h.sendHit.mock.calls[0]![0].id).toBe('1003')
    expect(h.engine.getStatus().totalHits).toBe(1)
    // 阈值推进到本页 max；吞并有观测日志
    expect(h.state.getFor('nodeseek').maxSeenTopicId).toBe(1003)
    expect(
      h.logger.getRecent().some((e) => e.level === 'info' && e.msg.includes('old topic(s) swallowed'))
    ).toBe(true)
  })

  it('豁免集（ultrabrain 修正）：id ≤ 阈值但上一轮就在 unseen 流里（推送失败重试中）→ 不被吞，重试路径保持', async () => {
    const fetchLatest = vi.fn(async () => [topic('100')])
    const h = build({ sources: [idOrderedSource(fetchLatest)] })
    await h.engine.pollOnce() // 基线：阈值 100

    // 第 2 轮：新帖 150 命中但推送真实失败 → 不入 seen；轮末阈值追上（推进到 150）
    fetchLatest.mockImplementation(async () => [topic('150', { title: '羊毛' }), topic('100')])
    h.sendHit.mockRejectedValueOnce(new TelegramError('telegram send failed'))
    await h.engine.pollOnce()
    expect(h.seen.has('nodeseek:150')).toBe(false)
    expect(h.state.getFor('nodeseek').maxSeenTopicId).toBe(150)

    // 第 3 轮：150 仍 unseen 且 150 ≤ 阈值 150——豁免集里有它 → 不当旧帖吞，重试成功入集
    await h.engine.pollOnce()
    expect(h.sendHit).toHaveBeenCalledTimes(2)
    expect(h.seen.has('nodeseek:150')).toBe(true)

    // 第 4 轮：已入 seen，不再处理
    await h.engine.pollOnce()
    expect(h.sendHit).toHaveBeenCalledTimes(2)
  })

  it('豁免集（语义未决）：上轮 AI 未决帖（不入 seen）下轮 id ≤ 阈值仍重进 AI 批，不被吞', async () => {
    const evaluate = vi.fn(
      async (_topics: Topic[], _interests: string[]) => new Map<string, SemanticVerdict>()
    ) // 恒未决
    const fetchLatest = vi.fn(async () => [topic('100')])
    const h = build({
      sources: [idOrderedSource(fetchLatest)],
      config: { ai: aiConfig({ matchMode: 'semantic' }) },
      evaluator: { evaluate }
    })
    await h.engine.pollOnce() // 基线：阈值 100

    fetchLatest.mockImplementation(async () => [topic('150', { title: '出手一台小主机' }), topic('100')])
    await h.engine.pollOnce() // 150 进 AI 批未决：不入 seen；阈值推进 150
    expect(evaluate).toHaveBeenCalledTimes(1)
    expect(h.seen.has('nodeseek:150')).toBe(false)
    expect(h.state.getFor('nodeseek').maxSeenTopicId).toBe(150)

    await h.engine.pollOnce() // 150 ≤ 阈值但豁免生效 → 重进 AI 批（而非被吞入 seen）
    expect(evaluate).toHaveBeenCalledTimes(2)
    expect(h.seen.has('nodeseek:150')).toBe(false) // 仍未决
  })

  it('F5：豁免集跨失败轮存活——推送失败 → 抓取失败（冷却）→ 恢复后 id ≤ 阈值仍走重试路径', async () => {
    const fetchLatest = vi.fn(async () => [topic('100')])
    const h = build({ sources: [idOrderedSource(fetchLatest)] })
    await h.engine.pollOnce() // 基线：阈值 100

    // 第 N 轮：新帖 150 命中但推送真实失败 → 不入 seen；轮末阈值推进 150；
    // 帖同时进 pendingNotifyErrors 与豁免集 prevUnseenKeys
    fetchLatest.mockImplementation(async () => [topic('150', { title: '羊毛' }), topic('100')])
    h.sendHit.mockRejectedValueOnce(new TelegramError('telegram send failed'))
    await h.engine.pollOnce()
    expect(h.sendHit).toHaveBeenCalledTimes(1)
    expect(h.seen.has('nodeseek:150')).toBe(false)
    expect(h.state.getFor('nodeseek').maxSeenTopicId).toBe(150)
    expect(retryMapSize(h.engine, 'pendingNotifyErrors')).toBe(1)

    // 第 N+1 轮：fetchLatest 抛错 → 进冷却。source 本轮无观测 → 轮末清理不动
    // 豁免集与 pendingNotifyErrors（prevUnseenKeys 的替换发生在 pollSource 成功
    // 路径里，失败轮原样保留）
    fetchLatest.mockRejectedValueOnce(new Error('net down'))
    await h.engine.pollOnce()
    expect(h.engine.getStatus().health).toBe('backoff')
    expect(h.seen.has('nodeseek:150')).toBe(false)
    expect(retryMapSize(h.engine, 'pendingNotifyErrors')).toBe(1)

    await h.engine.pollOnce() // 冷却中的轮次：跳过该 source（仍无观测）
    expect(fetchLatest).toHaveBeenCalledTimes(3)
    expect(retryMapSize(h.engine, 'pendingNotifyErrors')).toBe(1)

    // 第 N+2 轮：恢复，150 仍 unseen 且 150 ≤ 阈值 150——豁免集跨失败轮仍在 →
    // 走重试路径（processHit/sendHit 再次被调），不被阈值静默吞进 seen
    advanceMs(computeBackoffMs(1, 60_000))
    fetchLatest.mockImplementation(async () => [topic('150', { title: '羊毛' }), topic('100')])
    await h.engine.pollOnce()
    expect(h.sendHit).toHaveBeenCalledTimes(2) // 重试路径，而非静默入 seen
    expect(h.sendHit.mock.calls[1]![0].id).toBe('150')
    expect(h.seen.has('nodeseek:150')).toBe(true) // 重试成功后才入集
    expect(h.engine.getStatus().health).toBe('ok')
  })

  it('存量升级初始化轮：baselineDone=true 且阈值 null → 整页 unseen 入 seen、不推送不评估、阈值写入、log info、健康 ok', async () => {
    const fetchLatest = vi.fn(async () => [topic('937071', { title: '羊毛' }), topic('937070')])
    const h = build({
      sources: [idOrderedSource(fetchLatest)],
      preSeed: (_seen, state) => {
        state.setFor('nodeseek', { baselineDone: true }) // 旧版升级：state 里没有阈值字段
      }
    })
    await h.engine.pollOnce()

    // 含关键词命中的旧帖也不推送、不进命中管线
    expect(h.sendHit).not.toHaveBeenCalled()
    expect(h.onHit).not.toHaveBeenCalled()
    expect(h.seen.has('nodeseek:937070')).toBe(true)
    expect(h.seen.has('nodeseek:937071')).toBe(true)
    expect(h.state.getFor('nodeseek').maxSeenTopicId).toBe(937071)
    expect(
      h.logger
        .getRecent()
        .some((e) => e.level === 'info' && e.msg.includes('id threshold initialized at 937071'))
    ).toBe(true)
    expect(h.engine.getStatus().health).toBe('ok') // 静默初始化轮是正常收尾，不算失败

    // 下轮起阈值生效：顶起的旧帖被吞、新帖照常推送
    fetchLatest.mockImplementation(async () => [
      topic('937072', { title: '羊毛新' }),
      topic('900000', { title: '羊毛旧' })
    ])
    await h.engine.pollOnce()
    expect(h.sendHit).toHaveBeenCalledTimes(1)
    expect(h.sendHit.mock.calls[0]![0].id).toBe('937072')
    expect(h.seen.has('nodeseek:900000')).toBe(true)
  })

  it('F3：升级初始化轮阈值写失败（state.setFor 抛错）→ error 可观测、轮次行为不变、下轮重做初始化', async () => {
    const fetchLatest = vi.fn(async () => [topic('937071', { title: '羊毛' }), topic('937070')])
    const h = build({
      sources: [idOrderedSource(fetchLatest)],
      preSeed: (_seen, state) => {
        state.setFor('nodeseek', { baselineDone: true }) // 旧版升级：state 里没有阈值
      }
    })
    const setForSpy = vi
      .spyOn(h.state, 'setFor')
      .mockImplementation(() => { throw new Error('EACCES: permission denied') })
    await h.engine.pollOnce()

    // 轮次行为不变：静默初始化轮仍正常收尾（不推送不评估、整页入集、健康 ok）
    expect(h.sendHit).not.toHaveBeenCalled()
    expect(h.onHit).not.toHaveBeenCalled()
    expect(h.seen.has('nodeseek:937071')).toBe(true)
    expect(h.seen.has('nodeseek:937070')).toBe(true)
    expect(h.engine.getStatus().health).toBe('ok')
    // 可观测：后果明确的 error（下轮重做）+ 通用持久化 error；原 info 日志保持
    const logs = h.logger.getRecent()
    expect(
      logs.some(
        (e) =>
          e.level === 'error' &&
          e.msg.includes('id threshold persist failed — upgrade init will repeat next round')
      )
    ).toBe(true)
    expect(
      logs.some((e) => e.level === 'error' && e.msg.includes('persist engine state failed'))
    ).toBe(true)
    expect(
      logs.some((e) => e.level === 'info' && e.msg.includes('id threshold initialized at 937071'))
    ).toBe(true)
    // 写失败 → 内存阈值仍 null（setFor 落盘前抛，内存不变）→ 下一轮初始化重做
    expect(h.state.getFor('nodeseek').maxSeenTopicId).toBeNull()

    setForSpy.mockRestore()
    await h.engine.pollOnce() // 同页：初始化重做，阈值这次落盘
    expect(h.state.getFor('nodeseek').maxSeenTopicId).toBe(937071)
    expect(h.sendHit).not.toHaveBeenCalled() // 帖已入 seen，重做轮也不推送
  })

  it('F3：基线轮阈值写失败（state.setFor 抛错）→ error 可观测、控制流不变、下轮重做基线', async () => {
    const fetchLatest = vi.fn(async () => [topic('50', { title: '羊毛' }), topic('40')])
    const h = build({ sources: [idOrderedSource(fetchLatest)] })
    const setForSpy = vi
      .spyOn(h.state, 'setFor')
      .mockImplementation(() => { throw new Error('EACCES: permission denied') })
    await h.engine.pollOnce() // 基线轮：写入失败

    // 控制流不变：仍正常收尾（整页入集不推送、健康 ok）
    expect(h.sendHit).not.toHaveBeenCalled()
    expect(h.seen.has('nodeseek:50')).toBe(true)
    expect(h.seen.has('nodeseek:40')).toBe(true)
    expect(h.engine.getStatus().health).toBe('ok')
    expect(
      h.logger
        .getRecent()
        .some(
          (e) =>
            e.level === 'error' &&
            e.msg.includes('id threshold persist failed — upgrade init will repeat next round')
        )
    ).toBe(true)
    expect(
      h.logger.getRecent().some((e) => e.level === 'info' && e.msg.includes('baseline captured'))
    ).toBe(true)
    expect(h.state.getFor('nodeseek').baselineDone).toBe(false) // 内存未变：下轮重做基线

    setForSpy.mockRestore()
    await h.engine.pollOnce() // 同页重做基线：含关键词的 50 也不推送（基线语义）
    expect(h.sendHit).not.toHaveBeenCalled()
    expect(h.state.getFor('nodeseek').baselineDone).toBe(true)
    expect(h.state.getFor('nodeseek').maxSeenTopicId).toBe(50)
  })

  it('首装基线轮同轮初始化阈值：baselineDone 与整页 max id 同 patch 原子写', async () => {
    const fetchLatest = vi.fn(async () => [topic('50'), topic('40'), topic('30')])
    const h = build({ sources: [idOrderedSource(fetchLatest)] })
    await h.engine.pollOnce()
    expect(h.state.getFor('nodeseek')).toEqual({
      baselineDone: true,
      totalHits: 0,
      maxSeenTopicId: 50
    })
  })

  it('命中轮 totalHits 与阈值推进合并一次写盘：阈值不丢、totalHits 累计（引擎侧口径）', async () => {
    const fetchLatest = vi.fn(async () => [topic('100')])
    const h = build({ sources: [idOrderedSource(fetchLatest)] })
    await h.engine.pollOnce() // 基线：阈值 100

    fetchLatest.mockImplementation(async () => [topic('110', { title: '羊毛' }), topic('100')])
    await h.engine.pollOnce() // 命中（delta 1）+ 阈值推进 110：同一 patch 落盘
    expect(h.state.getFor('nodeseek')).toEqual({
      baselineDone: true,
      totalHits: 1,
      maxSeenTopicId: 110
    })
  })

  it('非数字 id：不过滤、不进阈值（含超安全整数）；整页无合法数值 id 时阈值不推进不回撤', async () => {
    const fetchLatest = vi.fn(async () => [topic('100'), topic('abc'), topic('9007199254740993')])
    const h = build({ sources: [idOrderedSource(fetchLatest)] })
    await h.engine.pollOnce() // 基线：pageMax=100（abc 与超安全整数串均不计入）
    expect(h.state.getFor('nodeseek').maxSeenTopicId).toBe(100)

    // 非数字 / 超安全整数的新 unseen 帖不做数值比较、不被吞：照常走管线（命中推送）
    fetchLatest.mockImplementation(async () => [
      topic('zzz', { title: '羊毛' }),
      topic('9007199254740995', { title: '羊毛大数' }),
      topic('100'),
      topic('abc'),
      topic('9007199254740993')
    ])
    await h.engine.pollOnce()
    expect(h.sendHit).toHaveBeenCalledTimes(2)
    expect(h.sendHit.mock.calls.map((c) => (c[0] as Topic).id).sort()).toEqual([
      '9007199254740995',
      'zzz'
    ])
    expect(h.state.getFor('nodeseek').maxSeenTopicId).toBe(100) // 阈值不含非法 id

    // 整页无合法数值 id：阈值不动，轮次健康不炸
    fetchLatest.mockImplementation(async () => [topic('zzz'), topic('def')])
    await h.engine.pollOnce()
    expect(h.state.getFor('nodeseek').maxSeenTopicId).toBe(100)
    expect(h.engine.getStatus().health).toBe('ok')
  })

  it('整页无非数字 id 且阈值 null：不触发升级初始化轮（pageMax null），正常管线不受影响', async () => {
    const fetchLatest = vi.fn(async () => [topic('abc')]) // 标题不含关键词
    const h = build({
      sources: [idOrderedSource(fetchLatest)],
      preSeed: (_seen, state) => {
        state.setFor('nodeseek', { baselineDone: true }) // 阈值 null + pageMax null
      }
    })
    await h.engine.pollOnce() // 基线外首轮：无 pageMax → 初始化轮跳过，abc 正常处理（未命中入集）
    expect(h.state.getFor('nodeseek').maxSeenTopicId).toBeNull()
    expect(h.seen.has('nodeseek:abc')).toBe(true)
    expect(h.sendHit).not.toHaveBeenCalled()
    fetchLatest.mockImplementation(async () => [topic('def', { title: '羊毛' }), topic('abc')])
    await h.engine.pollOnce() // 仍无 pageMax → def 照常推送（不被任何轮吞掉）
    expect(h.sendHit).toHaveBeenCalledTimes(1)
    expect(h.sendHit.mock.calls[0]![0].id).toBe('def')
    expect(h.seen.has('nodeseek:def')).toBe(true)
  })

  it('pageMax 下降：warn 一行（id 单调性异常信号）；阈值只升不降', async () => {
    const fetchLatest = vi.fn(async () => [topic('100'), topic('90')])
    const h = build({ sources: [idOrderedSource(fetchLatest)] })
    await h.engine.pollOnce() // 基线：阈值 100

    // 下轮高 id 帖滚出首页、整页都是低 id 旧帖：pageMax 90 < 100 → warn；阈值不回撤
    fetchLatest.mockImplementation(async () => [topic('90'), topic('80')])
    await h.engine.pollOnce()
    expect(
      h.logger
        .getRecent()
        .some((e) => e.level === 'warn' && e.msg.includes('page max topic id decreased'))
    ).toBe(true)
    expect(h.state.getFor('nodeseek').maxSeenTopicId).toBe(100)
  })

  it('creationOrderedIds 未声明（undefined）：完全不走过滤——无初始化轮、无阈值写入、低 id unseen 帖照常推送', async () => {
    const h = build({
      impl: async () => [topic('50', { title: '羊毛' }), topic('40')],
      preSeed: (_seen, state) => {
        state.setFor('nodeseek', { baselineDone: true }) // 存量升级形态，但来源未声明能力
      }
    })
    await h.engine.pollOnce()
    // 未声明能力 → 不触发升级初始化轮，低 id 帖照常走管线（命中推送 / 未命中入集）
    expect(h.sendHit).toHaveBeenCalledTimes(1)
    expect(h.sendHit.mock.calls[0]![0].id).toBe('50')
    expect(h.seen.has('nodeseek:40')).toBe(true)
    expect(h.state.getFor('nodeseek').maxSeenTopicId).toBeNull() // 阈值永不写入
    expect(h.logger.getRecent().some((e) => e.msg.includes('id threshold'))).toBe(false)
  })
})

describe('AI 锐评集成（第三轮）', () => {
  /** 已配置好的 AI 段（provider 三项齐备；锐评默认关，按需开） */
  function aiConfig(overrides: Partial<AppConfig['ai']> = {}): AppConfig['ai'] {
    return {
      provider: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-k', model: 'm' },
      matchMode: 'literal',
      interests: [],
      dailyReport: { enabled: false, timeHHMM: '22:00' },
      commentary: { enabled: false },
      ...overrides
    }
  }

  /** mock 锐评生成器（结构满足 Pick<CommentGenerator, 'generate' | 'prune'>） */
  function commentMock(text: string | null = '一句锐评') {
    const generate = vi.fn(async (_t: Topic) => text)
    const prune = vi.fn((_keep: ReadonlySet<string>, _observed?: ReadonlySet<string>) => {})
    return { generate, prune }
  }

  /**
   * 直接操纵引擎内部 AI 计数器（fake 时钟冻结在同一天，不触发翻转清零；
   * 与 retryMapSize 同款"测试专用观测面"先例——跑 300 次语义调用来耗尽配额不划算）。
   */
  function setAiCounters(
    engine: MonitorEngine,
    aiCallsToday: number,
    commentaryToday: number
  ): void {
    const internals = engine as unknown as Record<string, number>
    internals.aiCallsToday = aiCallsToday
    internals.commentaryToday = commentaryToday
  }

  /** 标准两轮流程：基线 → 出一条 literal 命中新帖（title 含默认关键词「羊毛」） */
  async function literalHitRound(h: Awaited<ReturnType<typeof build>>): Promise<void> {
    await h.engine.pollOnce() // 基线
    h.fetchLatest.mockImplementation(async () => [topic('2', { title: '羊毛大促' }), topic('1')])
    await h.engine.pollOnce()
  }

  it('literal 命中：generate 被调（盖章后的 topic）、sendHit 收到第三参、HitRecord.commentary 正确、双计数 +1', async () => {
    const gen = commentMock('犀利点评')
    const h = build({
      impl: async () => [topic('1')],
      config: { ai: aiConfig({ matchMode: 'literal', commentary: { enabled: true } }) },
      commentaryGenerator: gen
    })
    await literalHitRound(h)

    expect(gen.generate).toHaveBeenCalledTimes(1)
    expect(gen.generate.mock.calls[0]![0]).toMatchObject({ id: '2', sourceId: 'nodeseek' })
    expect(h.sendHit).toHaveBeenCalledTimes(1)
    expect(h.sendHit.mock.calls[0]![0].id).toBe('2')
    expect(h.sendHit.mock.calls[0]![1]).toEqual(['羊毛'])
    expect(h.sendHit.mock.calls[0]![2]).toBe('犀利点评') // 第三参
    const hits = h.engine.getRecentHits()
    expect(hits[0].commentary).toBe('犀利点评')
    expect(hits[0].matchedBy).toBe('literal')
    expect(hits[0].notifiedAt).not.toBeNull()
    const st = h.engine.getStatus()
    expect(st.ai.callsToday).toBe(1) // 锐评计入总桶
    expect(st.ai.commentaryToday).toBe(1)
  })

  it('语义命中同样带锐评：evaluate 与 generate 各一次，callsToday=2 / commentaryToday=1', async () => {
    const gen = commentMock('语义锐评')
    const evaluate = vi.fn(
      async (_topics: Topic[], _interests: string[]) =>
        new Map<string, SemanticVerdict>([['nodeseek:2', { hit: true, reason: '与自建主机相关' }]])
    )
    const h = build({
      impl: async () => [topic('1')],
      config: {
        ai: aiConfig({
          matchMode: 'semantic',
          interests: ['自建主机'],
          commentary: { enabled: true }
        })
      },
      evaluator: { evaluate },
      commentaryGenerator: gen
    })
    await h.engine.pollOnce() // 基线
    h.fetchLatest.mockImplementation(async () => [topic('2', { title: '出手一台家用小主机' }), topic('1')])
    await h.engine.pollOnce()

    expect(evaluate).toHaveBeenCalledTimes(1)
    expect(gen.generate).toHaveBeenCalledTimes(1)
    expect(h.sendHit).toHaveBeenCalledTimes(1)
    expect(h.sendHit.mock.calls[0]![2]).toBe('语义锐评')
    const hits = h.engine.getRecentHits()
    expect(hits[0]).toMatchObject({ matchedBy: 'semantic', semanticReason: '与自建主机相关' })
    expect(hits[0].commentary).toBe('语义锐评')
    const st = h.engine.getStatus()
    expect(st.ai.callsToday).toBe(2) // 1 语义评估 + 1 锐评（共用总桶）
    expect(st.ai.commentaryToday).toBe(1)
  })

  it('开关关（commentary.enabled=false）：不调 generate、sendHit 第三参 null、HitRecord.commentary null', async () => {
    const gen = commentMock()
    const h = build({
      impl: async () => [topic('1')],
      config: { ai: aiConfig({ commentary: { enabled: false } }) },
      commentaryGenerator: gen
    })
    await literalHitRound(h)

    expect(gen.generate).not.toHaveBeenCalled()
    expect(h.sendHit).toHaveBeenCalledTimes(1)
    expect(h.sendHit.mock.calls[0]![2]).toBeNull()
    expect(h.engine.getRecentHits()[0].commentary).toBeNull()
    expect(h.engine.getStatus().ai).toMatchObject({ callsToday: 0, commentaryToday: 0 })
  })

  it('provider 未配置：开关开也不调 generate（复用 aiConfigured 口径），推送照常', async () => {
    const gen = commentMock()
    const h = build({
      impl: async () => [topic('1')],
      config: {
        ai: aiConfig({
          provider: { baseUrl: '', apiKey: '', model: '' },
          commentary: { enabled: true }
        })
      },
      commentaryGenerator: gen
    })
    await literalHitRound(h)

    expect(gen.generate).not.toHaveBeenCalled()
    expect(h.sendHit).toHaveBeenCalledTimes(1) // 字面命中照常推送，只是无锐评
    expect(h.sendHit.mock.calls[0]![2]).toBeNull()
    expect(h.engine.getRecentHits()[0].commentary).toBeNull()
    expect(h.engine.getStatus().ai.commentaryToday).toBe(0)
  })

  it('总配额耗尽（callsToday=300）：不调 generate（锐评静默降级），推送照常', async () => {
    const gen = commentMock()
    const h = build({
      impl: async () => [topic('1')],
      config: { ai: aiConfig({ commentary: { enabled: true } }) },
      commentaryGenerator: gen
    })
    await h.engine.pollOnce() // 基线（计数器已按今日登记）
    setAiCounters(h.engine, DAILY_AI_CALL_LIMIT, 0)
    h.fetchLatest.mockImplementation(async () => [topic('2', { title: '羊毛大促' }), topic('1')])
    await h.engine.pollOnce()

    expect(gen.generate).not.toHaveBeenCalled()
    expect(h.sendHit).toHaveBeenCalledTimes(1)
    expect(h.sendHit.mock.calls[0]![2]).toBeNull()
    expect(h.engine.getRecentHits()[0].commentary).toBeNull()
    expect(h.engine.getStatus().ai.callsToday).toBe(DAILY_AI_CALL_LIMIT) // 不再增长
  })

  it('子限额耗尽（commentaryToday=100）：不调 generate；总桶有余量时语义评估照常可用', async () => {
    const gen = commentMock()
    const evaluate = vi.fn(
      async (_topics: Topic[], _interests: string[]) =>
        new Map<string, SemanticVerdict>([['nodeseek:2', { hit: false, reason: null }]])
    )
    const h = build({
      impl: async () => [topic('1')],
      config: {
        ai: aiConfig({ matchMode: 'both', interests: ['自建主机'], commentary: { enabled: true } })
      },
      evaluator: { evaluate },
      commentaryGenerator: gen
    })
    await h.engine.pollOnce() // 基线
    setAiCounters(h.engine, 100, DAILY_COMMENTARY_LIMIT)
    // 3 = literal 命中（推送、锐评降级）；2 = 非字面帖进语义批（miss 入集）
    h.fetchLatest.mockImplementation(async () => [
      topic('3', { title: '羊毛大促' }),
      topic('2', { title: '闲聊杂谈' }),
      topic('1')
    ])
    await h.engine.pollOnce()

    // 子限额只约束锐评：语义评估照常调（总桶 100/300 未耗尽）——两用途无需调序
    expect(evaluate).toHaveBeenCalledTimes(1)
    expect(h.seen.has('nodeseek:2')).toBe(true)
    // 锐评被静默降级：不打 LLM、无锐评推送，但命中本身照常推
    expect(gen.generate).not.toHaveBeenCalled()
    expect(h.sendHit).toHaveBeenCalledTimes(1)
    expect(h.sendHit.mock.calls[0]![0].id).toBe('3')
    expect(h.sendHit.mock.calls[0]![2]).toBeNull()
    expect(h.engine.getRecentHits()[0].commentary).toBeNull()
    expect(h.engine.getStatus().ai).toMatchObject({
      callsToday: 101, // 语义评估 +1；锐评不再计数
      commentaryToday: DAILY_COMMENTARY_LIMIT
    })
  })

  it('跨日翻转：callsToday 与 commentaryToday 一并清零，新日锐评恢复', async () => {
    const gen = commentMock()
    const h = build({
      impl: async () => [topic('1')],
      config: { ai: aiConfig({ commentary: { enabled: true } }) },
      commentaryGenerator: gen
    })
    await literalHitRound(h)
    expect(h.engine.getStatus().ai).toMatchObject({ callsToday: 1, commentaryToday: 1 })

    vi.advanceTimersByTime(48 * 3600 * 1000) // 跨过本地自然日（48h 对 DST 也安全）
    h.fetchLatest.mockImplementation(async () => [topic('3', { title: '羊毛新帖' }), topic('2')])
    await h.engine.pollOnce()

    expect(gen.generate).toHaveBeenCalledTimes(2) // 新日锐评恢复（未被昨日计数卡死）
    expect(h.sendHit.mock.calls[1]![2]).toBe('一句锐评')
    expect(h.engine.getStatus().ai).toMatchObject({ callsToday: 1, commentaryToday: 1 }) // 清零后重新计数
  })

  it('推送失败重试轮：CommentGenerator 内部缓存防二次 LLM，sendHit 仍带原锐评', async () => {
    // 真实 CommentGenerator + mock provider（chat = LLM 打点面），spy generate 观测 engine 侧重调
    const chat = vi.fn(async (_req: ChatRequest) => '原句锐评')
    const gen = new CommentGenerator({ provider: { chat } })
    const generateSpy = vi.spyOn(gen, 'generate')
    const h = build({
      impl: async () => [topic('1')],
      config: { ai: aiConfig({ commentary: { enabled: true } }) },
      commentaryGenerator: gen
    })
    await h.engine.pollOnce() // 基线
    h.fetchLatest.mockImplementation(async () => [topic('2', { title: '羊毛' }), topic('1')])
    h.sendHit.mockRejectedValueOnce(new TelegramError('telegram send failed'))
    await h.engine.pollOnce() // 失败轮：generate 1 次 → LLM 1 次

    expect(generateSpy).toHaveBeenCalledTimes(1)
    expect(chat).toHaveBeenCalledTimes(1)
    expect(h.sendHit.mock.calls[0]![2]).toBe('原句锐评')
    const failed = h.engine.getRecentHits()[0]
    expect(failed.commentary).toBe('原句锐评') // 失败轮 HitRecord 也带锐评
    expect(failed.notifiedAt).toBeNull()
    expect(h.engine.getStatus().ai).toMatchObject({ callsToday: 1, commentaryToday: 1 })

    await h.engine.pollOnce() // 重试轮：engine 再调 generate（缓存命中，不打 LLM）

    expect(generateSpy).toHaveBeenCalledTimes(2)
    expect(chat).toHaveBeenCalledTimes(1) // 缓存生效：无第二次 LLM 调用
    expect(h.sendHit).toHaveBeenCalledTimes(2)
    expect(h.sendHit.mock.calls[1]![2]).toBe('原句锐评') // 仍带原锐评
    const done = h.engine.getRecentHits()[1]
    expect(done.commentary).toBe('原句锐评')
    expect(done.notifiedAt).not.toBeNull()
    expect(h.engine.getStatus().ai).toMatchObject({ callsToday: 2, commentaryToday: 2 }) // 调用即计数
  })

  it('prune：轮末收到 roundTopicKeys（基线/命中轮都调，滚出首页的键不在保留集）', async () => {
    const gen = commentMock()
    const h = build({
      impl: async () => [topic('1')],
      config: { ai: aiConfig({ commentary: { enabled: true } }) },
      commentaryGenerator: gen
    })
    await h.engine.pollOnce() // 基线轮：页面 {1}
    expect(gen.prune).toHaveBeenCalledTimes(1)
    expect(gen.prune.mock.calls[0]![0]).toEqual(new Set(['nodeseek:1']))

    h.fetchLatest.mockImplementation(async () => [topic('2', { title: '羊毛' }), topic('1')])
    await h.engine.pollOnce() // 命中轮：页面 {2,1}
    expect(gen.prune).toHaveBeenCalledTimes(2)
    expect(gen.prune.mock.calls[1]![0]).toEqual(new Set(['nodeseek:1', 'nodeseek:2']))

    h.fetchLatest.mockImplementation(async () => [topic('1')])
    await h.engine.pollOnce() // 2 滚出首页：保留集只剩 {1}
    expect(gen.prune).toHaveBeenCalledTimes(3)
    expect(gen.prune.mock.calls[2]![0]).toEqual(new Set(['nodeseek:1']))
  })

  it('F1：prune 第二参 = observedSources——成功观测轮含该 source，失败/冷却轮为空集', async () => {
    const gen = commentMock()
    const h = build({
      impl: async () => [topic('1')],
      config: { ai: aiConfig({ commentary: { enabled: true } }) },
      commentaryGenerator: gen
    })
    await h.engine.pollOnce() // 成功观测轮
    expect(gen.prune).toHaveBeenCalledTimes(1)
    expect(gen.prune.mock.calls[0]![1]).toEqual(new Set(['nodeseek']))

    h.fetchLatest.mockRejectedValueOnce(new Error('net down'))
    await h.engine.pollOnce() // 抓取失败轮：未观测
    expect(gen.prune).toHaveBeenCalledTimes(2)
    expect(gen.prune.mock.calls[1]![1]).toEqual(new Set())

    await h.engine.pollOnce() // 冷却跳过轮：仍未观测
    expect(gen.prune).toHaveBeenCalledTimes(3)
    expect(gen.prune.mock.calls[2]![1]).toEqual(new Set())
  })

  it('F1：冷却/失败轮（source 未观测）commentary 缓存不被清——恢复轮重试不打 LLM', async () => {
    const chat = vi.fn(async (_req: ChatRequest) => '原句锐评')
    const gen = new CommentGenerator({ provider: { chat } })
    const h = build({
      impl: async () => [topic('1')],
      config: { ai: aiConfig({ commentary: { enabled: true } }) },
      commentaryGenerator: gen
    })
    await h.engine.pollOnce() // 基线

    // 命中轮：推送失败 → nodeseek:2 缓存落位（chat 1 次），帖不入 seen
    h.fetchLatest.mockImplementation(async () => [topic('2', { title: '羊毛' }), topic('1')])
    h.sendHit.mockRejectedValueOnce(new TelegramError('telegram send failed'))
    await h.engine.pollOnce()
    expect(chat).toHaveBeenCalledTimes(1)
    expect(h.seen.has('nodeseek:2')).toBe(false)

    // 失败轮：fetchLatest 抛错 → source 未观测 → observedSources 守卫保住缓存
    h.fetchLatest.mockRejectedValueOnce(new Error('net down'))
    await h.engine.pollOnce()
    expect(h.engine.getStatus().health).toBe('backoff')

    await h.engine.pollOnce() // 冷却中的轮次：跳过该 source（仍未观测）
    expect(h.fetchLatest).toHaveBeenCalledTimes(3) // 基线 + 命中轮 + 失败轮

    // 越过冷却恢复：同帖重试 → 缓存跨故障窗口存活，不再打 LLM
    advanceMs(computeBackoffMs(1, 60_000))
    h.fetchLatest.mockImplementation(async () => [topic('2', { title: '羊毛' }), topic('1')])
    await h.engine.pollOnce()
    expect(h.sendHit).toHaveBeenCalledTimes(2) // processHit/sendHit 重试路径再次被调
    expect(h.sendHit.mock.calls[1]![2]).toBe('原句锐评') // 命中的是缓存里的原句
    expect(chat).toHaveBeenCalledTimes(1) // 关键断言：LLM 未被重打
    expect(h.seen.has('nodeseek:2')).toBe(true)
  })

  it('F1：正常观测轮滚出首页的键被清——该帖再回首页时重新打 LLM', async () => {
    const chat = vi.fn(async (_req: ChatRequest) => '原句锐评')
    const gen = new CommentGenerator({ provider: { chat } })
    const h = build({
      impl: async () => [topic('1')],
      config: { ai: aiConfig({ commentary: { enabled: true } }) },
      commentaryGenerator: gen
    })
    await h.engine.pollOnce() // 基线

    // 命中轮：推送失败 → 缓存落位（chat 1 次），帖不入 seen（待重试）
    h.fetchLatest.mockImplementation(async () => [topic('2', { title: '羊毛' }), topic('1')])
    h.sendHit.mockRejectedValueOnce(new TelegramError('telegram send failed'))
    await h.engine.pollOnce()
    expect(chat).toHaveBeenCalledTimes(1)

    // 正常轮：2 滚出首页（source 已观测）→ 缓存键被 prune 清掉
    h.fetchLatest.mockImplementation(async () => [topic('1')])
    await h.engine.pollOnce()

    // 2 再回首页：仍待重试（未入 seen）→ 重走命中管线 → 缓存已清 → 重新打 LLM
    h.fetchLatest.mockImplementation(async () => [topic('2', { title: '羊毛' }), topic('1')])
    await h.engine.pollOnce()
    expect(chat).toHaveBeenCalledTimes(2)
    expect(h.sendHit).toHaveBeenCalledTimes(2)
    expect(h.sendHit.mock.calls[1]![2]).toBe('原句锐评')
  })

  it('F4：ai.commentaryLimit 随状态下发（锐评上限单一事实源，渲染层不硬编码）', async () => {
    const h = build({ impl: async () => [topic('1')] })
    await h.engine.pollOnce()
    expect(h.engine.getStatus().ai.commentaryLimit).toBe(DAILY_COMMENTARY_LIMIT)
    expect(h.engine.getStatus().ai.commentaryLimit).toBe(100)
  })

  it('deps 未注入 commentaryGenerator：行为与升级前一致（恒 null、sendHit 第三参 null、零计数）', async () => {
    const h = build({
      impl: async () => [topic('1')],
      config: { ai: aiConfig({ commentary: { enabled: true } }) } // 开关开也没用：没注入生成器
    })
    await literalHitRound(h)

    expect(h.sendHit).toHaveBeenCalledTimes(1)
    expect(h.sendHit.mock.calls[0]![2]).toBeNull() // engine 统一传 string|null，不传 undefined
    const hits = h.engine.getRecentHits()
    expect(hits[0].commentary).toBeNull()
    expect('commentary' in hits[0]).toBe(true) // 新记录字段恒存在（值 null，非 undefined）
    expect(h.engine.getStatus().ai).toMatchObject({ callsToday: 0, commentaryToday: 0 })
  })

  it('HitRecord.commentary 恒 string|null：generate 返回 null（负缓存）→ null；推送失败 → 文本保留', async () => {
    // a) generate 返回 null（LLM 失败被模块消化）：sendHit 第三参与 HitRecord 均 null
    const genNull = commentMock(null)
    const h1 = build({
      impl: async () => [topic('1')],
      config: { ai: aiConfig({ commentary: { enabled: true } }) },
      commentaryGenerator: genNull
    })
    await literalHitRound(h1)
    expect(genNull.generate).toHaveBeenCalledTimes(1) // 调用即计数（返回 null 也计）
    expect(h1.sendHit.mock.calls[0]![2]).toBeNull()
    expect(h1.engine.getRecentHits()[0].commentary).toBeNull()
    expect(h1.engine.getStatus().ai).toMatchObject({ callsToday: 1, commentaryToday: 1 })

    // b) 推送失败但锐评已生成：HitRecord.commentary 保留文本，notifiedAt=null
    //    （换 topic id：与 a) 共享同一 tmpdir，seen/state 已含 nodeseek:1/2）
    const gen2 = commentMock('失败轮锐评')
    const h2 = build({
      impl: async () => [topic('9')],
      config: { ai: aiConfig({ commentary: { enabled: true } }) },
      commentaryGenerator: gen2
    })
    await h2.engine.pollOnce() // 基线（state 沿用 a) 的 baselineDone=true，9 为新帖入集）
    h2.fetchLatest.mockImplementation(async () => [topic('10', { title: '羊毛' }), topic('9')])
    h2.sendHit.mockRejectedValueOnce(new TelegramError('telegram send failed'))
    await h2.engine.pollOnce()
    const hit = h2.engine.getRecentHits()[0]
    expect(hit.commentary).toBe('失败轮锐评')
    expect(hit.notifiedAt).toBeNull()
    expect(hit.notifyError).toContain('telegram send failed')
  })
})
