/**
 * FileFeedbackStore 单测（R7-W4）：记票/改票/撤销语义、正负例各自环形 100
 * 独立淘汰、recentForPrompt ≤8 截取（新→旧）、feedback.json tmp+rename 原子写
 * （无 tmp 残留）、损坏备份重建不崩、单条坏数据跳过、内存模式、持久化往返。
 *
 * 不用 fake timers：ts 直接由注入的假时钟（自增计数器）决定，确定性断言。
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FEEDBACK_FILE_NAME,
  FEEDBACK_PROMPT_TAKE,
  FEEDBACK_RING_CAPACITY,
  FileFeedbackStore
} from './feedback'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rss-monitor-feedback-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

/** 自增假时钟：每次调用 +1ms（ts 严格递增，断言"最新/最老"不依赖真实时间） */
function tickClock(): { now: () => number; peek: () => number } {
  let t = 1_700_000_000_000
  return {
    now: () => t++,
    peek: () => t
  }
}

describe('记票 / 改票 / 撤销', () => {
  it('新键追加：get 返回完整条目（key/title/direction/ts）', () => {
    const clock = tickClock()
    const store = new FileFeedbackStore({ now: clock.now })
    const tUsed = clock.peek() // vote 内 now() 消费的正是当前计数（随后自增）
    store.vote('nodeseek:1', '出闲置 NAS', 'negative')
    expect(store.get('nodeseek:1')).toEqual({
      key: 'nodeseek:1',
      title: '出闲置 NAS',
      direction: 'negative',
      ts: new Date(tUsed).toISOString()
    })
  })

  it('改票：同键再投覆盖方向、刷新 ts 与标题，不产生第二条', () => {
    const clock = tickClock()
    const store = new FileFeedbackStore({ now: clock.now })
    store.vote('nodeseek:1', '旧标题', 'positive')
    store.vote('nodeseek:1', '新标题', 'negative')
    const entry = store.get('nodeseek:1')
    expect(entry).toBeDefined()
    expect(entry!.direction).toBe('negative')
    expect(entry!.title).toBe('新标题')
    // ts 刷新：改票时间严格晚于首投
    expect(entry!.ts > new Date(1_700_000_000_000).toISOString()).toBe(true)
    // recentForPrompt 只有负例一份（改票不占双份）
    expect(store.recentForPrompt()).toEqual({ positive: [], negative: ['新标题'] })
  })

  it('undo：存在 → true 且移除；不存在 → false（幂等，无副作用）', () => {
    const store = new FileFeedbackStore()
    expect(store.undo('nodeseek:404')).toBe(false)
    store.vote('nodeseek:1', 't', 'positive')
    expect(store.undo('nodeseek:1')).toBe(true)
    expect(store.get('nodeseek:1')).toBeUndefined()
    expect(store.undo('nodeseek:1')).toBe(false)
  })

  it('recentForPrompt 空态：{positive:[], negative:[]}', () => {
    expect(new FileFeedbackStore().recentForPrompt()).toEqual({ positive: [], negative: [] })
  })

  it('recentForPrompt：各取最近 ≤8 条，新→旧（顺序即队列尾→头）', () => {
    const store = new FileFeedbackStore()
    for (let i = 0; i < 10; i++) store.vote(`nodeseek:${i}`, `p${i}`, 'positive')
    for (let i = 0; i < 10; i++) store.vote(`v2ex:${i}`, `n${i}`, 'negative')
    expect(store.recentForPrompt()).toEqual({
      positive: ['p9', 'p8', 'p7', 'p6', 'p5', 'p4', 'p3', 'p2'],
      negative: ['n9', 'n8', 'n7', 'n6', 'n5', 'n4', 'n3', 'n2']
    })
    expect(FEEDBACK_PROMPT_TAKE).toBe(8)
  })
})

describe('环形上限（正/负例各 100，独立计数）', () => {
  it(`正例第 ${FEEDBACK_RING_CAPACITY + 1} 条淘汰最老正例；负例不受影响`, () => {
    const store = new FileFeedbackStore()
    store.vote('nodeseek:base-neg', 'neg-title', 'negative')
    for (let i = 0; i <= FEEDBACK_RING_CAPACITY; i++) {
      store.vote(`nodeseek:${i}`, `p${i}`, 'positive')
    }
    expect(store.get('nodeseek:0')).toBeUndefined() // 最老正例被淘汰
    expect(store.get('nodeseek:1')).toBeDefined()
    expect(store.get(`nodeseek:${FEEDBACK_RING_CAPACITY}`)).toBeDefined()
    // 负例独立计数：未被正例的淘汰波及
    expect(store.get('nodeseek:base-neg')).toBeDefined()
  })

  it('负例独立淘汰：第 101 条负例淘汰最老负例，正例不受影响', () => {
    const store = new FileFeedbackStore()
    store.vote('nodeseek:base-pos', 'pos-title', 'positive')
    for (let i = 0; i <= FEEDBACK_RING_CAPACITY; i++) {
      store.vote(`nodeseek:${i}`, `n${i}`, 'negative')
    }
    expect(store.get('nodeseek:0')).toBeUndefined()
    expect(store.get('nodeseek:base-pos')).toBeDefined()
  })

  it('改票不占双份：positive→negative 后正例名额腾出、负例占一席', () => {
    const store = new FileFeedbackStore()
    for (let i = 0; i < FEEDBACK_RING_CAPACITY; i++) {
      store.vote(`nodeseek:p${i}`, `p${i}`, 'positive')
    }
    // 队首正例改投负例：正例 99 条、负例 1 条
    store.vote('nodeseek:p0', 'p0', 'negative')
    expect(store.get('nodeseek:p0')!.direction).toBe('negative')
    // 再补 2 条正例到 101 条：淘汰的是此时最老的正例 p1（p0 已不在正例队列）
    store.vote('nodeseek:p100', 'p100', 'positive')
    store.vote('nodeseek:p101', 'p101', 'positive')
    expect(store.get('nodeseek:p1')).toBeUndefined()
    expect(store.get('nodeseek:p0')).toBeDefined() // 负例身份存活
  })
})

describe('持久化（feedback.json，tmp+rename 原子写）', () => {
  it('vote 落盘 + 新实例读回（往返一致）；目录里只有 feedback.json，无 tmp 残留', async () => {
    const clock = tickClock()
    const store = new FileFeedbackStore({ filePath: join(dir, FEEDBACK_FILE_NAME), now: clock.now })
    store.vote('nodeseek:1', '想要这条', 'positive')
    store.vote('v2ex:2', '不想要这条', 'negative')

    // 原子写证据：目录里只有最终文件（rename 后 tmp 不在），内容可解析
    const names = await readdir(dir)
    expect(names).toEqual([FEEDBACK_FILE_NAME])
    const onDisk = JSON.parse(await readFile(join(dir, FEEDBACK_FILE_NAME), 'utf-8')) as {
      schemaVersion: number
      entries: Array<{ key: string; direction: string }>
    }
    expect(onDisk.schemaVersion).toBe(1)
    expect(onDisk.entries).toHaveLength(2)

    // 新实例（懒加载）读回同一份状态
    const reloaded = new FileFeedbackStore({ filePath: join(dir, FEEDBACK_FILE_NAME) })
    expect(reloaded.get('nodeseek:1')!.direction).toBe('positive')
    expect(reloaded.get('v2ex:2')!.direction).toBe('negative')
    expect(reloaded.recentForPrompt()).toEqual({
      positive: ['想要这条'],
      negative: ['不想要这条']
    })
  })

  it('dataDir 构造：feedback.json 落在其下', async () => {
    const store = new FileFeedbackStore({ dataDir: dir })
    store.vote('nodeseek:1', 't', 'positive')
    expect(existsSync(join(dir, FEEDBACK_FILE_NAME))).toBe(true)
  })

  it('undo 后落盘反映删除（新实例读不回被撤销的票）', async () => {
    const filePath = join(dir, FEEDBACK_FILE_NAME)
    const store = new FileFeedbackStore({ filePath })
    store.vote('nodeseek:1', 't', 'positive')
    store.undo('nodeseek:1')
    expect(new FileFeedbackStore({ filePath }).get('nodeseek:1')).toBeUndefined()
  })

  it('损坏（非法 JSON）：备份 .corrupt-* 后空集重建，不抛；再投票落合法文件', async () => {
    const filePath = join(dir, FEEDBACK_FILE_NAME)
    await writeFile(filePath, '{{{not json', 'utf-8')
    const store = new FileFeedbackStore({ filePath })
    expect(store.recentForPrompt()).toEqual({ positive: [], negative: [] })
    expect(store.get('any')).toBeUndefined()

    store.vote('nodeseek:1', 't', 'negative')
    const reParsed = JSON.parse(await readFile(filePath, 'utf-8')) as { entries: unknown[] }
    expect(reParsed.entries).toHaveLength(1)
    // 备份文件存在（.corrupt- 前缀）
    const names = await readdir(dir)
    expect(names.some((n) => n.startsWith(`${FEEDBACK_FILE_NAME}.corrupt-`))).toBe(true)
  })

  it('损坏（信封形状不对，如缺 schemaVersion）：同样备份重建', async () => {
    const filePath = join(dir, FEEDBACK_FILE_NAME)
    await writeFile(filePath, JSON.stringify({ entries: [{ key: 'a:b' }] }), 'utf-8')
    const store = new FileFeedbackStore({ filePath })
    expect(store.get('a:b')).toBeUndefined()
  })

  it('单条坏数据只跳过该条，好条目照常收编', async () => {
    const filePath = join(dir, FEEDBACK_FILE_NAME)
    const good = { key: 'nodeseek:2', title: 't2', direction: 'negative', ts: '2026-09-19T00:00:00Z' }
    const payload = {
      schemaVersion: 1,
      entries: [
        { key: '', title: 'x', direction: 'positive', ts: 'x' }, // 空 key
        { key: 'nodeseek:1', title: 't', direction: 'side-ways', ts: 'x' }, // 非法方向
        { key: 'nodeseek:3', direction: 'positive', ts: 'x' }, // 缺 title
        'garbage-string', // 非对象
        good
      ]
    }
    await writeFile(filePath, JSON.stringify(payload), 'utf-8')
    const store = new FileFeedbackStore({ filePath })
    expect(store.get('nodeseek:2')).toEqual(good)
    expect(store.get('nodeseek:1')).toBeUndefined()
    expect(store.recentForPrompt().negative).toEqual(['t2'])
  })

  it('盘上超限收编：两方向各只保留最新 100 条', async () => {
    const filePath = join(dir, FEEDBACK_FILE_NAME)
    const entries = []
    for (let i = 0; i < FEEDBACK_RING_CAPACITY + 20; i++) {
      entries.push({
        key: `nodeseek:${i}`,
        title: `p${i}`,
        direction: 'positive' as const,
        ts: new Date(1_700_000_000_000 + i).toISOString()
      })
    }
    await writeFile(filePath, JSON.stringify({ schemaVersion: 1, entries }), 'utf-8')
    const store = new FileFeedbackStore({ filePath })
    expect(store.get('nodeseek:0')).toBeUndefined() // 最老 20 条被淘汰
    expect(store.get('nodeseek:19')).toBeUndefined()
    expect(store.get('nodeseek:20')).toBeDefined()
    expect(store.get(`nodeseek:${FEEDBACK_RING_CAPACITY + 19}`)).toBeDefined()
  })

  it('内存模式（无 filePath/dataDir）：vote/undo/recentForPrompt 全可用，不写盘不抛', () => {
    const store = new FileFeedbackStore()
    store.vote('nodeseek:1', 't', 'positive')
    expect(store.recentForPrompt().positive).toEqual(['t'])
    expect(() => store.vote('nodeseek:2', 't2', 'negative')).not.toThrow()
    expect(store.undo('nodeseek:1')).toBe(true)
  })
})
