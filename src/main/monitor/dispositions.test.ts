/**
 * DispositionStore 单测（R7-W1）：去重语义（同 outcome 不重记 / 迁移才记）、
 * 内存环 500 淘汰、jsonl 日分桶追加与 readDay 坏行跳过、7 天保留清理、
 * append 回调模式、prune 的 observedSources 守卫。
 *
 * 不用 fake timers：写入是 fire-and-forget 串行队列（logger writeTail 模式），
 * 测试用 store.flush() 确定性排空；日期分桶/清理用注入的假时钟（now）。
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DISPOSITION_RING_CAPACITY,
  DispositionStore,
  PIPELINE_DIR_NAME
} from './dispositions'
import { formatLocalDate } from './hits-store'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rss-monitor-dispositions-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

/** 固定时刻的注入时钟：base epoch + 偏移毫秒（默认零） */
function clockAt(base: number): (offsetMs?: number) => number {
  return (offsetMs = 0) => base + offsetMs
}

describe('去重语义（DEC-3：同 outcome 不重记，迁移才记）', () => {
  it('键首次出现记录；同 outcome 重复调用不追加（重试/重评轮不刷屏）', () => {
    const store = new DispositionStore()
    store.record('nodeseek', '1', 't1', 'push-failed', 'tg down')
    store.record('nodeseek', '1', 't1', 'push-failed', 'tg down')
    store.record('nodeseek', '1', 't1', 'push-failed', 'tg down again') // detail 变也不记
    const recs = store.recent(100)
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({
      sourceId: 'nodeseek',
      topicId: '1',
      title: 't1',
      outcome: 'push-failed',
      detail: 'tg down'
    })
  })

  it('outcome 变化（状态迁移）追加新记录，形成处置轨迹', () => {
    const store = new DispositionStore()
    store.record('nodeseek', '1', 't1', 'miss')
    store.record('nodeseek', '1', 't1', 'deferred', 'quiet-hours')
    store.record('nodeseek', '1', 't1', 'deferred-skip')
    store.record('nodeseek', '1', 't1', 'pushed')
    store.record('nodeseek', '1', 't1', 'pushed') // 终态重入不记
    const recs = store.recent(100)
    expect(recs.map((r) => r.outcome)).toEqual(['miss', 'deferred', 'deferred-skip', 'pushed'])
    expect(recs[1].detail).toBe('quiet-hours')
    expect(recs[3].detail).toBeUndefined()
  })

  it('不同 source 同 topicId 是不同键，互不去重', () => {
    const store = new DispositionStore()
    store.record('nodeseek', '9', 't', 'miss')
    store.record('v2ex', '9', 't', 'miss')
    expect(store.recent(100)).toHaveLength(2)
  })

  it('detail 省略/空串不落键（jsonl 不出现 "detail":undefined）', async () => {
    const dataDir = join(dir, PIPELINE_DIR_NAME)
    const store = new DispositionStore({ dataDir })
    store.record('s', '1', 't', 'pinned')
    store.record('s', '2', 't', 'pinned', '')
    await store.flush()
    const raw = await readFile(join(dataDir, `${formatLocalDate()}.jsonl`), 'utf-8')
    expect(raw).not.toContain('undefined')
    expect(raw.split('\n').filter((l) => l.trim() !== '')).toHaveLength(2)
  })
})

describe('内存环', () => {
  it(`容量 ${DISPOSITION_RING_CAPACITY}：超限淘汰最老；recent(limit) 取尾部`, () => {
    const store = new DispositionStore()
    for (let i = 0; i < DISPOSITION_RING_CAPACITY + 7; i++) {
      store.record('s', String(i), `t${i}`, 'miss')
    }
    const all = store.recent(DISPOSITION_RING_CAPACITY + 100)
    expect(all).toHaveLength(DISPOSITION_RING_CAPACITY)
    expect(all[0].topicId).toBe('7') // 最老的 0-6 被淘汰
    expect(all[all.length - 1].topicId).toBe(String(DISPOSITION_RING_CAPACITY + 6))
    // 默认 limit=200 取最近 200 条
    const tail = store.recent()
    expect(tail).toHaveLength(200)
    expect(tail[0].topicId).toBe(String(DISPOSITION_RING_CAPACITY + 7 - 200))
  })

  it('recent 返回拷贝：外部改动不影响内部', () => {
    const store = new DispositionStore()
    store.record('s', '1', 't', 'miss')
    const snapshot = store.recent()
    snapshot.pop()
    expect(store.recent()).toHaveLength(1)
  })
})

describe('jsonl 持久化（本地时区日分桶追加）', () => {
  it('record 落 pipeline/YYYY-MM-DD.jsonl；跨本地日分桶；readDay 按行序（旧→新）', async () => {
    // 2026-09-18 23:30（本地时区）—— 东八/西五区都落在 09-18 桶
    const base = new Date(2026, 8, 18, 23, 30, 0, 0).getTime()
    const dataDir = join(dir, PIPELINE_DIR_NAME)
    const store = new DispositionStore({ dataDir, now: clockAt(base) })
    store.record('s', '1', 't1', 'miss')
    store.record('s', '2', 't2', 'pushed')
    await store.flush()
    // 推进到次日 00:30（+1h）—— 09-19 桶
    const store2 = new DispositionStore({ dataDir, now: clockAt(base + 60 * 60_000) })
    store2.record('s', '3', 't3', 'muted')
    await store2.flush()

    const day1 = await store2.readDay('2026-09-18')
    expect(day1.map((r) => r.topicId)).toEqual(['1', '2'])
    const day2 = await store2.readDay('2026-09-19')
    expect(day2.map((r) => r.topicId)).toEqual(['3'])
    expect(day2[0]).toMatchObject({ outcome: 'muted', sourceId: 's', title: 't3' })
  })

  it('readDay：文件不存在 → []；坏行/形状不符/outcome 非法跳过，好行保留', async () => {
    const dataDir = join(dir, PIPELINE_DIR_NAME)
    await mkdir(dataDir, { recursive: true })
    const good = JSON.stringify({
      ts: '2026-09-18T10:00:00.000Z',
      sourceId: 's',
      topicId: '1',
      title: 't',
      outcome: 'pushed'
    })
    const lines = [
      '{ corrupt !!!', // JSON 坏行
      JSON.stringify({ ts: 'x', sourceId: 's', topicId: '2', title: 't', outcome: 'nope' }), // outcome 非法
      JSON.stringify({ ts: 'x', sourceId: 's', title: 't' }), // 缺 topicId
      good,
      '' // 空行
    ]
    await writeFile(join(dataDir, '2026-09-18.jsonl'), lines.join('\n') + '\n', 'utf-8')
    const store = new DispositionStore({ dataDir })
    const recs = await store.readDay('2026-09-18')
    expect(recs).toHaveLength(1)
    expect(recs[0].topicId).toBe('1')
    expect(await store.readDay('2020-01-01')).toEqual([])
  })

  it('append 回调模式：给了回调则不走文件（dataDir 也给时回调优先）', async () => {
    const append = vi.fn()
    const dataDir = join(dir, PIPELINE_DIR_NAME)
    const store = new DispositionStore({ dataDir, append, now: clockAt(Date.now()) })
    store.record('s', '1', 't', 'miss')
    store.record('s', '1', 't', 'pushed') // 迁移
    store.record('s', '1', 't', 'pushed') // 去重
    await store.flush()
    expect(append).toHaveBeenCalledTimes(2)
    expect(append.mock.calls[1][0]).toMatchObject({ outcome: 'pushed' })
    expect(existsSync(join(dataDir, `${formatLocalDate()}.jsonl`))).toBe(false)
  })

  it('append 回调抛错被消化（不向上抛），内存环照常', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const append = vi.fn(() => {
      throw new Error('sink down')
    })
    const store = new DispositionStore({ append })
    expect(() => store.record('s', '1', 't', 'miss')).not.toThrow()
    expect(store.recent()).toHaveLength(1)
    expect(errSpy).toHaveBeenCalled()
  })
})

describe('7 天保留清理（对齐 logger 模式：构造时触发）', () => {
  it('文件名日期早于（now - 7 天）那天的删除；边界当天（= cutoff）保留；无关文件不动', async () => {
    const dataDir = join(dir, PIPELINE_DIR_NAME)
    await mkdir(dataDir, { recursive: true })
    // now = 2026-09-19 10:00 → cutoff = 2026-09-12
    const now = new Date(2026, 8, 19, 10, 0, 0, 0).getTime()
    for (const name of [
      '2026-09-10.jsonl', // < cutoff：删
      '2026-09-11.jsonl', // < cutoff：删
      '2026-09-12.jsonl', // = cutoff：保留（logger 语义：早于 cutoff 才删）
      '2026-09-18.jsonl', // 保留
      'not-a-date.txt', // 不匹配形状：不动
      '2026-09-19.jsonl' // 今天：保留
    ]) {
      await writeFile(join(dataDir, name), '{}\n', 'utf-8')
    }
    new DispositionStore({ dataDir, now: clockAt(now) })
    expect(existsSync(join(dataDir, '2026-09-10.jsonl'))).toBe(false)
    expect(existsSync(join(dataDir, '2026-09-11.jsonl'))).toBe(false)
    expect(existsSync(join(dataDir, '2026-09-12.jsonl'))).toBe(true)
    expect(existsSync(join(dataDir, '2026-09-18.jsonl'))).toBe(true)
    expect(existsSync(join(dataDir, '2026-09-19.jsonl'))).toBe(true)
    expect(existsSync(join(dataDir, 'not-a-date.txt'))).toBe(true)
  })
})

describe('prune（轮末键清理，observedSources 守卫）', () => {
  it('已观测 source 的键滚出首页 → 清；仍在页面（keepKeys）→ 留；未观测 source → 留', () => {
    const store = new DispositionStore()
    store.record('a', '1', 't', 'miss') // 仍在页面
    store.record('a', '2', 't', 'pushed') // 已滚出首页，source a 已观测 → 清
    store.record('b', '1', 't', 'miss') // 已滚出首页，但 source b 未观测 → 留

    store.prune(new Set(['a:1']), new Set(['a']))
    // a:2 被清后，同键再遇 miss 不被误判为重复（重置后首条重新记录）
    store.record('a', '2', 't', 'miss')
    const recs = store.recent(100)
    expect(recs.map((r) => `${r.sourceId}:${r.topicId}:${r.outcome}`)).toEqual([
      'a:1:miss',
      'a:2:pushed',
      'b:1:miss',
      'a:2:miss'
    ])
  })

  it('空 Map 时 no-op；keepKeys 含键即保留（不看 observedSources）', () => {
    const store = new DispositionStore()
    expect(() => store.prune(new Set(), new Set())).not.toThrow()
    store.record('a', '1', 't', 'miss')
    store.prune(new Set(['a:1']), new Set()) // 未观测任何 source：全保留
    store.record('a', '1', 't', 'miss') // 键仍在 → 去重
    expect(store.recent(100)).toHaveLength(1)
  })
})
