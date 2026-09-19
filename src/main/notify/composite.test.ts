/**
 * CompositeNotifier 单测：全部通道为 mock（零网络），覆盖扇出 / 路由 / 聚合
 * （DEC-9 坑9）/ 广播 / report 透传（report 为 R6-W2 加在 HitMessageInput 上
 * 的 per-channel 结果回调：各通道 sendHit 内部自报，composite 只透传 input、
 * 不重复调用——见 composite.ts 文件头）。
 */

import { describe, expect, it, vi } from 'vitest'
import type { RoutingRule, RoutingWhen, Topic } from '@shared/types'
import type { HitMessageInput, Notifier } from './types'
import { CompositeNotifier } from './composite'

// ---- fixtures ------------------------------------------------------------

const topic: Topic = {
  id: '936634',
  sourceId: 'nodeseek',
  title: '出 海尔冰箱 9成新',
  url: 'https://www.nodeseek.com/post-936634-1',
  author: '张三',
  category: '交易',
  categorySlug: 'trade',
  pinned: false,
  lastActiveAt: null
}

const v2exTopic: Topic = { ...topic, sourceId: 'v2ex' }

interface MockOpts {
  /** 三方法全失败（throw 该值；类型为 unknown 以覆盖非 Error 抛出） */
  fail?: unknown
  /** 仅 sendHit 失败 */
  failHit?: unknown
  /** 仅 sendRaw 失败 */
  failRaw?: unknown
  /** 仅 sendTest 失败 */
  failTest?: unknown
  /** sendHit 的人为异步延迟（串行保序验证用） */
  delayHitMs?: number
  /** 共享事件日志（串行顺序断言用） */
  events?: string[]
  /** sendHit 时的钩子（mock 里调 input.report 的落点） */
  onHit?: (input: HitMessageInput) => void
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 可记录调用的 mock 通道：hits/raws 为收到的入参，tests() 为 sendTest 次数 */
function mockNotifier(id: string, opts: MockOpts = {}): {
  notifier: Notifier
  hits: HitMessageInput[]
  raws: string[]
  tests: () => number
} {
  const hits: HitMessageInput[] = []
  const raws: string[] = []
  let testCount = 0
  const notifier: Notifier = {
    id,
    async sendHit(input) {
      opts.events?.push(`${id}:hit:start`)
      if (opts.delayHitMs !== undefined) await sleep(opts.delayHitMs)
      hits.push(input)
      opts.onHit?.(input)
      opts.events?.push(`${id}:hit:end`)
      const err = opts.failHit ?? opts.fail
      if (err !== undefined) throw err
    },
    async sendRaw(text) {
      raws.push(text)
      const err = opts.failRaw ?? opts.fail
      if (err !== undefined) throw err
    },
    async sendTest() {
      testCount++
      const err = opts.failTest ?? opts.fail
      if (err !== undefined) throw err
    }
  }
  return { notifier, hits, raws, tests: () => testCount }
}

function r(id: string, when: RoutingWhen, channelIds: string[]): RoutingRule {
  return { id, when, channelIds }
}

/** 空路由（= 不路由，全员广播）的 composite 快捷构造 */
function withNoRouting(notifiers: Notifier[]): CompositeNotifier {
  return new CompositeNotifier(notifiers, { getRouting: () => [] })
}

// ---- 用例 ----------------------------------------------------------------

describe('CompositeNotifier', () => {
  it('id 固定为 composite（仅日志用途，不是 ChannelConfig.id）', () => {
    const c = withNoRouting([])
    expect(c.id).toBe('composite')
  })

  it('sendHit 无路由：广播全部通道，且 input 按引用原样透传（同一对象）', async () => {
    const a = mockNotifier('a')
    const b = mockNotifier('b')
    const c = withNoRouting([a.notifier, b.notifier])
    const input: HitMessageInput = { topic, matchedKeywords: ['冰箱'] }
    await c.sendHit(input)

    expect(a.hits).toHaveLength(1)
    expect(b.hits).toHaveLength(1)
    expect(a.hits[0]).toBe(input) // 引用相同：report 等附加字段不被剥离
    expect(b.hits[0]).toBe(input)
  })

  it('路由命中：只发 channelIds 命中的通道，其余通道零调用', async () => {
    const a = mockNotifier('a')
    const b = mockNotifier('b')
    let routing: RoutingRule[] = [r('to-b', { sourceId: 'nodeseek' }, ['b'])]
    const c = new CompositeNotifier([a.notifier, b.notifier], { getRouting: () => routing })
    await c.sendHit({ topic, matchedKeywords: ['冰箱'] })

    expect(a.hits).toHaveLength(0)
    expect(b.hits).toHaveLength(1)
    expect(routing).toHaveLength(1) // getRouting 不被实现改动
  })

  it('路由全部未命中（null）→ 广播全部通道', async () => {
    const a = mockNotifier('a')
    const b = mockNotifier('b')
    const routing: RoutingRule[] = [r('v2ex-only', { sourceId: 'v2ex' }, ['b'])]
    const c = new CompositeNotifier([a.notifier, b.notifier], { getRouting: () => routing })
    await c.sendHit({ topic, matchedKeywords: ['冰箱'] }) // sourceId=nodeseek 不命中

    expect(a.hits).toHaveLength(1)
    expect(b.hits).toHaveLength(1)
  })

  it('matchedBy 推导：matchedKeywords 非空 → literal，命中 matchedBy:[literal] 规则', async () => {
    const a = mockNotifier('a')
    const b = mockNotifier('b')
    const routing: RoutingRule[] = [r('lit', { matchedBy: ['literal'] }, ['b'])]
    const c = new CompositeNotifier([a.notifier, b.notifier], { getRouting: () => routing })
    await c.sendHit({ topic, matchedKeywords: ['vps'] })

    expect(a.hits).toHaveLength(0)
    expect(b.hits).toHaveLength(1)
  })

  it('matchedBy 推导：无关键词无规则 → semantic，命中 matchedBy:[semantic] 规则；不命中 literal 规则时广播', async () => {
    const a = mockNotifier('a')
    const b = mockNotifier('b')
    const semRouting: RoutingRule[] = [r('sem', { matchedBy: ['semantic'] }, ['b'])]
    const c1 = new CompositeNotifier([a.notifier, b.notifier], { getRouting: () => semRouting })
    await c1.sendHit({ topic, matchedKeywords: [], semanticReason: '和兴趣相关' })
    expect(a.hits).toHaveLength(0)
    expect(b.hits).toHaveLength(1)

    const litRouting: RoutingRule[] = [r('lit', { matchedBy: ['literal'] }, ['b'])]
    const c2 = new CompositeNotifier([a.notifier, b.notifier], { getRouting: () => litRouting })
    await c2.sendHit({ topic, matchedKeywords: [], semanticReason: '和兴趣相关' })
    expect(a.hits).toHaveLength(1) // 未命中 → 广播
    expect(b.hits).toHaveLength(2)
  })

  it('matchedBy 推导：规则字段非空 → rule，ruleId 条件按 matchedRuleId（规则 id）路由', async () => {
    const a = mockNotifier('a')
    const b = mockNotifier('b')
    const routing: RoutingRule[] = [r('cheap', { ruleId: 'cheap-vps' }, ['b'])]
    const c = new CompositeNotifier([a.notifier, b.notifier], { getRouting: () => routing })
    await c.sendHit({ topic, matchedKeywords: [], matchedRuleId: 'cheap-vps' })

    expect(a.hits).toHaveLength(0)
    expect(b.hits).toHaveLength(1)
  })

  it('label ≠ id 的规则命中：when.ruleId 按规则 id 命中、按 label 不命中（路由不读展示 label）', async () => {
    // when.ruleId = 规则 id 'r1'：matchedRuleId='r1'（label 是 '便宜VPS'）→ 命中
    const a = mockNotifier('a')
    const b = mockNotifier('b')
    const byId: RoutingRule[] = [r('cheap', { ruleId: 'r1' }, ['b'])]
    const c1 = new CompositeNotifier([a.notifier, b.notifier], { getRouting: () => byId })
    await c1.sendHit({ topic, matchedKeywords: [], matchedRule: '便宜VPS', matchedRuleId: 'r1' })
    expect(a.hits).toHaveLength(0)
    expect(b.hits).toHaveLength(1)

    // when.ruleId = label '便宜VPS'（配错的口径）：ctx.ruleId='r1' 严格不等 → 不命中 → 广播
    const byLabel: RoutingRule[] = [r('cheap', { ruleId: '便宜VPS' }, ['b'])]
    const c2 = new CompositeNotifier([a.notifier, b.notifier], { getRouting: () => byLabel })
    await c2.sendHit({ topic, matchedKeywords: [], matchedRule: '便宜VPS', matchedRuleId: 'r1' })
    expect(a.hits).toHaveLength(1) // 未命中 → 广播
    expect(b.hits).toHaveLength(2) // 广播也发 b
  })

  it('matchedRuleId=null/undefined（旧形状只带 label）→ ctx.ruleId=null，带 ruleId 条件的规则永不命中 → 广播', async () => {
    const a = mockNotifier('a')
    const b = mockNotifier('b')
    const routing: RoutingRule[] = [r('cheap', { ruleId: 'r1' }, ['b'])]
    const c = new CompositeNotifier([a.notifier, b.notifier], { getRouting: () => routing })
    // matchedBy 仍推导为 rule（matchedRule 非空），但路由 id 缺失 → 严格相等不成立
    await c.sendHit({ topic, matchedKeywords: [], matchedRule: '便宜VPS' })

    expect(a.hits).toHaveLength(1)
    expect(b.hits).toHaveLength(1)
  })

  it('ruleId 条件对 literal 命中（matchedRule=null）不生效 → 广播', async () => {
    const a = mockNotifier('a')
    const b = mockNotifier('b')
    const routing: RoutingRule[] = [r('cheap', { ruleId: 'cheap-vps' }, ['b'])]
    const c = new CompositeNotifier([a.notifier, b.notifier], { getRouting: () => routing })
    await c.sendHit({ topic, matchedKeywords: ['vps'], matchedRule: null })

    expect(a.hits).toHaveLength(1)
    expect(b.hits).toHaveLength(1)
  })

  it('sourceId 路由：v2ex 来源的帖只发指定通道', async () => {
    const a = mockNotifier('a')
    const b = mockNotifier('b')
    const routing: RoutingRule[] = [r('v2ex', { sourceId: 'v2ex' }, ['b'])]
    const c = new CompositeNotifier([a.notifier, b.notifier], { getRouting: () => routing })
    await c.sendHit({ topic: v2exTopic, matchedKeywords: ['vps'] })

    expect(a.hits).toHaveLength(0)
    expect(b.hits).toHaveLength(1)
  })

  it('getRouting 每次发送现读：改路由后第二次发送按新规则走', async () => {
    const a = mockNotifier('a')
    const b = mockNotifier('b')
    let routing: RoutingRule[] = []
    const c = new CompositeNotifier([a.notifier, b.notifier], { getRouting: () => routing })
    await c.sendHit({ topic, matchedKeywords: ['x'] })
    expect(a.hits).toHaveLength(1)
    expect(b.hits).toHaveLength(1)

    routing = [r('to-b', { sourceId: 'nodeseek' }, ['b'])]
    await c.sendHit({ topic, matchedKeywords: ['x'] })
    expect(a.hits).toHaveLength(1) // 第二次不再广播 a
    expect(b.hits).toHaveLength(2)
  })

  it('串行保序：前一通道的 sendHit 完成后，下一通道才开始', async () => {
    const events: string[] = []
    const a = mockNotifier('a', { delayHitMs: 15, events })
    const b = mockNotifier('b', { events })
    const c = withNoRouting([a.notifier, b.notifier])
    await c.sendHit({ topic, matchedKeywords: ['x'] })

    expect(events).toEqual(['a:hit:start', 'a:hit:end', 'b:hit:start', 'b:hit:end'])
  })

  it('单通道失败不中断其余通道：失败通道之后的通道仍收到，整体 resolve', async () => {
    const a = mockNotifier('a', { failHit: new Error('boom-a') })
    const b = mockNotifier('b')
    const c = withNoRouting([a.notifier, b.notifier])
    await expect(c.sendHit({ topic, matchedKeywords: ['x'] })).resolves.toBeUndefined()

    expect(a.hits).toHaveLength(1) // 失败通道也确实被尝试过
    expect(b.hits).toHaveLength(1)
  })

  it('全部失败 → throw 聚合错误，消息逐通道列出（精确串）', async () => {
    const a = mockNotifier('a', { failHit: new Error('boom-a') })
    const b = mockNotifier('b', { failHit: new Error('boom-b') })
    const c = withNoRouting([a.notifier, b.notifier])
    let caught: unknown
    await c.sendHit({ topic, matchedKeywords: ['x'] }).catch((e: unknown) => {
      caught = e
    })

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('all channels failed: a: boom-a; b: boom-b')
  })

  it('非 Error 抛出（reject 字符串）→ String() 进聚合消息', async () => {
    const a = mockNotifier('a', { failHit: 'plain-string-failure' })
    const c = withNoRouting([a.notifier])
    await expect(c.sendHit({ topic, matchedKeywords: ['x'] })).rejects.toThrow(
      'all channels failed: a: plain-string-failure'
    )
  })

  it('无通道（notifiers 为空）→ sendHit throw no channel available', async () => {
    const c = withNoRouting([])
    await expect(c.sendHit({ topic, matchedKeywords: ['x'] })).rejects.toThrow('no channel available')
  })

  it('路由目标无匹配 notifier（规则指向未装配的通道 id）→ no channel available', async () => {
    const a = mockNotifier('a')
    const routing: RoutingRule[] = [r('ghost', { sourceId: 'nodeseek' }, ['ghost-channel'])]
    const c = new CompositeNotifier([a.notifier], { getRouting: () => routing })
    await expect(c.sendHit({ topic, matchedKeywords: ['x'] })).rejects.toThrow('no channel available')
    expect(a.hits).toHaveLength(0)
  })

  it('规则 channelIds 含重复 id（未 sanitize 输入）→ 目标通道只收一次', async () => {
    const a = mockNotifier('a')
    const routing: RoutingRule[] = [r('dup', { sourceId: 'nodeseek' }, ['a', 'a'])]
    const c = new CompositeNotifier([a.notifier], { getRouting: () => routing })
    await c.sendHit({ topic, matchedKeywords: ['x'] })

    expect(a.hits).toHaveLength(1)
  })

  it('构造后外层数组变动不影响扇出集合（构造时浅拷贝）', async () => {
    const a = mockNotifier('a')
    const b = mockNotifier('b')
    const arr = [a.notifier]
    const c = new CompositeNotifier(arr, { getRouting: () => [] })
    arr.push(b.notifier) // 事后塞入不生效
    await c.sendHit({ topic, matchedKeywords: ['x'] })

    expect(a.hits).toHaveLength(1)
    expect(b.hits).toHaveLength(0)
  })

  it('sendRaw 广播全部通道、不走路由（命中当前上下文的路由规则也不劫走日报）', async () => {
    const a = mockNotifier('a')
    const b = mockNotifier('b')
    const routing: RoutingRule[] = [r('to-b', { matchedBy: ['literal'] }, ['b'])]
    const c = new CompositeNotifier([a.notifier, b.notifier], { getRouting: () => routing })
    await c.sendRaw('# ForumWatch 日报')

    expect(a.raws).toEqual(['# ForumWatch 日报'])
    expect(b.raws).toEqual(['# ForumWatch 日报'])
  })

  it('sendRaw 聚合：单通道失败 resolve；全部失败 throw 聚合错误', async () => {
    const okA = mockNotifier('a')
    const failB = mockNotifier('b', { failRaw: new Error('raw-b') })
    const c1 = withNoRouting([okA.notifier, failB.notifier])
    await expect(c1.sendRaw('日报')).resolves.toBeUndefined()
    expect(okA.raws).toEqual(['日报'])
    expect(failB.raws).toEqual(['日报']) // 失败通道也被尝试

    const failA = mockNotifier('a', { failRaw: new Error('raw-a') })
    const c2 = withNoRouting([failA.notifier, failB.notifier])
    await expect(c2.sendRaw('日报')).rejects.toThrow('all channels failed: a: raw-a; b: raw-b')
  })

  it('sendTest 广播全部通道；单通道失败（其余成功）仍 resolve 且全通道都被调用', async () => {
    const a = mockNotifier('a', { failTest: new Error('test-a') })
    const b = mockNotifier('b')
    const c = withNoRouting([a.notifier, b.notifier])
    await expect(c.sendTest()).resolves.toBeUndefined()

    expect(a.tests()).toBe(1)
    expect(b.tests()).toBe(1)
  })

  it('sendTest 全部失败 → throw；无通道 → no channel available', async () => {
    const a = mockNotifier('a', { failTest: new Error('test-a') })
    const b = mockNotifier('b', { failTest: new Error('test-b') })
    const c = withNoRouting([a.notifier, b.notifier])
    await expect(c.sendTest()).rejects.toThrow('all channels failed: a: test-a; b: test-b')

    await expect(withNoRouting([]).sendTest()).rejects.toThrow('no channel available')
  })

  it('report 透传：各通道经 input.report 自报逐通道结果，composite 不额外调用（次数=通道数）', async () => {
    const report = vi.fn<NonNullable<HitMessageInput['report']>>()
    const a = mockNotifier('a', {
      onHit: (input) => {
        input.report?.('a', true, undefined)
      }
    })
    const b = mockNotifier('b', {
      failHit: new Error('boom-b'),
      onHit: (input) => {
        input.report?.('b', false, 'boom-b')
      }
    })
    const c = withNoRouting([a.notifier, b.notifier])
    const input: HitMessageInput = { topic, matchedKeywords: ['x'], report }
    await expect(c.sendHit(input)).resolves.toBeUndefined() // a 成功 → resolve

    // 串行下两条自报按通道顺序到达；composite 未混入自己的调用
    expect(report.mock.calls).toEqual([
      ['a', true, undefined],
      ['b', false, 'boom-b']
    ])
    expect(report).toHaveBeenCalledTimes(2)
  })

  it('通道不调用 report 时 composite 也不合成上报（report 恒不被调）', async () => {
    const report = vi.fn<NonNullable<HitMessageInput['report']>>()
    const a = mockNotifier('a')
    const c = withNoRouting([a.notifier])
    await c.sendHit({ topic, matchedKeywords: ['x'], report })
    expect(report).not.toHaveBeenCalled()
  })
})
