/**
 * TopicArchiveStore 单测（R17）：日分桶落档（formatLocalDate 本地时区口径）、
 * 同键进程内只落一行、重启语义（新实例从文件重建去重集）、readRange 跨日合并
 * + 读侧 key 去重首见优先、坏行跳过、35 天保留清理（构造时 + 写入路径跨日翻转）、
 * append 失败回滚去重键（同帖可重录）、day 字段随写入固化、coveredDays（含
 * sourceIds 过滤口径）、readonly 模式。
 *
 * 不用 fake timers：写入是 fire-and-forget 串行队列（writeTail 模式），测试用
 * store.flush() 确定性排空；日期分桶/清理用注入的假时钟（now）。
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TopicArchiveStore, TOPICS_DIR_NAME } from './topics-store'
import { formatLocalDate } from './hits-store'
import type { Topic } from '../../shared/types'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rss-monitor-topics-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

/** 固定时刻的注入时钟：base epoch + 偏移毫秒（默认零） */
function clockAt(base: number): (offsetMs?: number) => number {
  return (offsetMs = 0) => base + offsetMs
}

function topic(id: string, overrides: Partial<Topic> = {}): Topic {
  return {
    id,
    sourceId: 'nodeseek', // engine 在 unseen 循环前已盖章，这里直接给成品形状
    title: `title-${id}`,
    url: `https://example.com/post-${id}-1`,
    author: 'alice',
    category: '交易',
    categorySlug: 'trade',
    pinned: false,
    lastActiveAt: null,
    ...overrides
  }
}

describe('record 落档（本地时区日分桶）', () => {
  it('record 落 topics/YYYY-MM-DD.jsonl；跨本地日分桶；行形状是 TopicRecord', async () => {
    // 2026-09-18 23:30（本地时区）—— 东八/西五区都落在 09-18 桶
    const base = new Date(2026, 8, 18, 23, 30, 0, 0).getTime()
    const dataDir = join(dir, TOPICS_DIR_NAME)
    const store = new TopicArchiveStore({ dataDir, now: clockAt(base) })
    store.record(topic('1'), new Date(base))
    store.record(topic('2', { pinned: true, excerpt: '摘要内容' }), new Date(base))
    await store.flush()

    const raw = await readFile(join(dataDir, '2026-09-18.jsonl'), 'utf-8')
    const lines = raw.split('\n').filter((l) => l.trim() !== '')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toMatchObject({
      key: 'nodeseek:1',
      sourceId: 'nodeseek',
      topicId: '1',
      title: 'title-1',
      url: 'https://example.com/post-1-1',
      author: 'alice',
      category: '交易',
      categorySlug: 'trade',
      pinned: false,
      lastActiveAt: null,
      firstSeenAt: new Date(base).toISOString(),
      day: '2026-09-18' // 归属日随写入固化（读取侧优先用它，改时区不漂移）
    })
    expect(JSON.parse(lines[0]!).excerpt).toBeUndefined() // 无摘要不落键
    expect(JSON.parse(lines[1]!)).toMatchObject({ key: 'nodeseek:2', pinned: true, excerpt: '摘要内容' })

    // 推进到次日 00:30（+1h）—— 09-19 桶
    const store2 = new TopicArchiveStore({ dataDir, now: clockAt(base + 60 * 60_000) })
    store2.record(topic('3'), new Date(base + 60 * 60_000))
    await store2.flush()
    expect(existsSync(join(dataDir, '2026-09-19.jsonl'))).toBe(true)
    const day2 = await store2.readDay('2026-09-19')
    expect(day2.map((r) => r.topicId)).toEqual(['3'])
    expect(day2[0]!.day).toBe('2026-09-19') // 新日桶的行带当时的本地日
  })

  it('默认 now（不传第二参）用注入时钟决定日桶与 firstSeenAt', async () => {
    const base = new Date(2026, 8, 20, 12, 0, 0, 0).getTime()
    const dataDir = join(dir, TOPICS_DIR_NAME)
    const store = new TopicArchiveStore({ dataDir, now: clockAt(base) })
    store.record(topic('1')) // 无 now 参 → this.now()
    await store.flush()
    const recs = await store.readDay(formatLocalDate(new Date(base)))
    expect(recs).toHaveLength(1)
    expect(recs[0]!.firstSeenAt).toBe(new Date(base).toISOString())
  })

  it('无 dataDir（纯内存）：不落盘、不炸，键去重照常', async () => {
    const store = new TopicArchiveStore()
    store.record(topic('1'))
    store.record(topic('1'))
    expect(await store.readDay(formatLocalDate())).toEqual([])
    expect(store.listDays()).toEqual([])
    await expect(store.flush()).resolves.toBeUndefined()
  })
})

describe('写侧去重（同 key 进程内只落一行；重启语义）', () => {
  it('同 key 进程内重复 record（重评轮/重试轮重入）只落一行', async () => {
    const dataDir = join(dir, TOPICS_DIR_NAME)
    const store = new TopicArchiveStore({ dataDir })
    store.record(topic('1'))
    store.record(topic('1')) // 同帖第二轮重入
    store.record(topic('1', { title: '标题变了也不落' })) // 同键即同帖，字段变化不重落
    await store.flush()
    const recs = await store.readDay(formatLocalDate())
    expect(recs).toHaveLength(1)
    expect(recs[0]!.title).toBe('title-1')
  })

  it('不同 source 同 topicId 是不同键，互不去重', async () => {
    const dataDir = join(dir, TOPICS_DIR_NAME)
    const store = new TopicArchiveStore({ dataDir })
    store.record(topic('9', { sourceId: 'nodeseek' }))
    store.record(topic('9', { sourceId: 'v2ex' }))
    await store.flush()
    expect(await store.readDay(formatLocalDate())).toHaveLength(2)
  })

  it('重启语义：新实例从现有日桶重建去重集，同 key 不再落（首见即入集）', async () => {
    const dataDir = join(dir, TOPICS_DIR_NAME)
    const store = new TopicArchiveStore({ dataDir })
    store.record(topic('1'))
    store.record(topic('2'))
    await store.flush()

    // 模拟重启：全新实例（构造期 rebuildKeySet 读盘）
    const store2 = new TopicArchiveStore({ dataDir })
    store2.record(topic('1')) // 已在盘上 → 重建的 Set 挡住
    store2.record(topic('3')) // 新帖 → 落
    await store2.flush()
    const recs = await store2.readDay(formatLocalDate())
    expect(recs.map((r) => r.topicId).sort()).toEqual(['1', '2', '3'])
  })
})

describe('readDay / readRange 读取', () => {
  it('readDay：文件不存在 → []；坏行/形状不符跳过，好行保留', async () => {
    const dataDir = join(dir, TOPICS_DIR_NAME)
    await mkdir(dataDir, { recursive: true })
    const good = JSON.stringify({
      key: 's:1',
      sourceId: 's',
      topicId: '1',
      title: 't',
      url: 'u',
      author: 'a',
      category: 'c',
      categorySlug: 'cs',
      firstSeenAt: '2026-09-18T10:00:00.000Z'
    })
    const lines = [
      '{ corrupt !!!', // JSON 坏行
      JSON.stringify({ key: 's:2', sourceId: 's', title: 't' }), // 缺必填字段
      JSON.stringify('just a string'), // 非对象
      good,
      '' // 空行
    ]
    await writeFile(join(dataDir, '2026-09-18.jsonl'), lines.join('\n') + '\n', 'utf-8')
    const store = new TopicArchiveStore({ dataDir })
    const recs = await store.readDay('2026-09-18')
    expect(recs).toHaveLength(1)
    expect(recs[0]!.topicId).toBe('1')
    expect(await store.readDay('2020-01-01')).toEqual([])
  })

  it('readRange：跨日合并（旧→新）+ key 去重首见优先；fromDate>toDate 空区间', async () => {
    const dataDir = join(dir, TOPICS_DIR_NAME)
    await mkdir(dataDir, { recursive: true })
    // 09-17 有 s:1（首见）；09-18 有 s:1 的重档（seen 环淘汰场景）+ s:2
    const day17 = [JSON.stringify({ ...baseRec('s:1'), firstSeenAt: '2026-09-17T01:00:00.000Z' })]
    const day18 = [
      JSON.stringify({ ...baseRec('s:2'), firstSeenAt: '2026-09-18T02:00:00.000Z' }),
      JSON.stringify({ ...baseRec('s:1'), firstSeenAt: '2026-09-18T03:00:00.000Z' }) // 重档行
    ]
    await writeFile(join(dataDir, '2026-09-17.jsonl'), day17.join('\n') + '\n', 'utf-8')
    await writeFile(join(dataDir, '2026-09-18.jsonl'), day18.join('\n') + '\n', 'utf-8')

    const store = new TopicArchiveStore({ dataDir })
    const range = await store.readRange('2026-09-16', '2026-09-19')
    // 首见优先：s:1 取 09-17 那行（firstSeenAt 更早），s:2 在其后
    expect(range.map((r) => r.key)).toEqual(['s:1', 's:2'])
    expect(range[0]!.firstSeenAt).toBe('2026-09-17T01:00:00.000Z')
    expect(await store.readRange('2026-09-19', '2026-09-16')).toEqual([])
  })

  it('readRange 区间过滤：只取 [from,to] 内的日桶（含两端）', async () => {
    const dataDir = join(dir, TOPICS_DIR_NAME)
    await mkdir(dataDir, { recursive: true })
    for (const d of ['2026-09-16', '2026-09-17', '2026-09-18']) {
      await writeFile(
        join(dataDir, `${d}.jsonl`),
        JSON.stringify(baseRec(`s:${d.slice(-2)}`)) + '\n',
        'utf-8'
      )
    }
    const store = new TopicArchiveStore({ dataDir })
    const range = await store.readRange('2026-09-17', '2026-09-17')
    expect(range.map((r) => r.key)).toEqual(['s:17'])
  })
})

describe('listDays / coveredDays', () => {
  it('listDays 新→旧，只认 YYYY-MM-DD.jsonl 形状', async () => {
    const dataDir = join(dir, TOPICS_DIR_NAME)
    await mkdir(dataDir, { recursive: true })
    for (const name of ['2026-09-18.jsonl', '2026-09-16.jsonl', 'not-a-date.txt', '2026-09-17.md']) {
      await writeFile(join(dataDir, name), '{}\n', 'utf-8')
    }
    const store = new TopicArchiveStore({ dataDir })
    expect(store.listDays()).toEqual(['2026-09-18', '2026-09-16'])
  })

  it('coveredDays 只数有数据的天（全坏行 = 无数据）；旧→新；区间过滤', async () => {
    const dataDir = join(dir, TOPICS_DIR_NAME)
    await mkdir(dataDir, { recursive: true })
    await writeFile(
      join(dataDir, '2026-09-16.jsonl'),
      JSON.stringify(baseRec('s:16')) + '\n',
      'utf-8'
    )
    await writeFile(join(dataDir, '2026-09-17.jsonl'), '{ corrupt !!!\n', 'utf-8') // 坏行 → 无数据
    await writeFile(
      join(dataDir, '2026-09-18.jsonl'),
      JSON.stringify(baseRec('s:18')) + '\n',
      'utf-8'
    )
    const store = new TopicArchiveStore({ dataDir })
    expect(await store.coveredDays('2026-09-16', '2026-09-19')).toEqual([
      '2026-09-16',
      '2026-09-18'
    ])
    expect(await store.coveredDays('2026-09-19', '2026-09-20')).toEqual([])
  })
})

describe('35 天保留清理（构造时触发）', () => {
  it('文件名日期早于（now - 35 天）那天的删除；边界当天（= cutoff）保留；无关文件不动', async () => {
    const dataDir = join(dir, TOPICS_DIR_NAME)
    await mkdir(dataDir, { recursive: true })
    // now = 2026-09-21 10:00 → cutoff = 2026-08-17
    const now = new Date(2026, 8, 21, 10, 0, 0, 0).getTime()
    for (const name of [
      '2026-08-15.jsonl', // < cutoff：删
      '2026-08-16.jsonl', // < cutoff：删
      '2026-08-17.jsonl', // = cutoff：保留（早于 cutoff 才删）
      '2026-09-20.jsonl', // 保留
      'not-a-date.txt' // 不匹配形状：不动
    ]) {
      await writeFile(join(dataDir, name), '{}\n', 'utf-8')
    }
    new TopicArchiveStore({ dataDir, now: clockAt(now) })
    expect(existsSync(join(dataDir, '2026-08-15.jsonl'))).toBe(false)
    expect(existsSync(join(dataDir, '2026-08-16.jsonl'))).toBe(false)
    expect(existsSync(join(dataDir, '2026-08-17.jsonl'))).toBe(true)
    expect(existsSync(join(dataDir, '2026-09-20.jsonl'))).toBe(true)
    expect(existsSync(join(dataDir, 'not-a-date.txt'))).toBe(true)
  })
})

describe('写入路径的跨日保留清理（常驻进程不重启也清旧文件）', () => {
  it('构造后新增的过期文件：跨本地日的首次写入顺带清理；同日重复写入不重跑', async () => {
    const base = new Date(2026, 8, 21, 10, 0, 0, 0).getTime() // 09-21 10:00
    const dataDir = join(dir, TOPICS_DIR_NAME)
    const store = new TopicArchiveStore({ dataDir, now: clockAt(base) })
    // 构造后再放入过期文件（模拟构造清理之后才出现的残留——常驻进程场景）
    const stale = join(dataDir, '2026-08-10.jsonl')
    await writeFile(stale, JSON.stringify(baseRec('s:stale')) + '\n', 'utf-8')
    store.record(topic('1'), new Date(base))
    await store.flush()
    expect(existsSync(stale)).toBe(true) // 同日写入不触发清理（构造期已跑过）
    // 跨日：次日 09:30 的写入顺带清掉过期文件，且不影响本次写入
    store.record(topic('2'), new Date(base + 24 * 60 * 60_000))
    await store.flush()
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(join(dataDir, '2026-09-22.jsonl'))).toBe(true)
    expect(await store.readDay('2026-09-22')).toHaveLength(1)
  })
})

describe('append 失败回滚去重键（否则该帖永久丢失）', () => {
  it('写失败（EISDIR）：键被移除，同帖下轮 record 重试成功', async () => {
    const base = new Date(2026, 8, 18, 12, 0, 0, 0).getTime()
    const dataDir = join(dir, TOPICS_DIR_NAME)
    const dayFile = join(dataDir, '2026-09-18.jsonl')
    // 用同名目录占位让 appendFile 必败（EISDIR）——真实文件系统注入失败，零 mock
    await mkdir(dayFile, { recursive: true })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = new TopicArchiveStore({ dataDir, now: clockAt(base) })
    store.record(topic('1'), new Date(base))
    await store.flush()
    expect(errSpy).toHaveBeenCalled() // 失败留痕（构造期对该目录 readFileSync 的报错或 append 报错）
    // 移除占位目录后同帖再 record：键已被回滚 → 重录成功（不是被 Set 挡住永久丢）
    const { rmSync } = await import('node:fs')
    rmSync(dayFile, { recursive: true })
    store.record(topic('1'), new Date(base))
    await store.flush()
    const recs = await store.readDay('2026-09-18')
    expect(recs).toHaveLength(1)
    expect(recs[0]!.topicId).toBe('1')
  })
})

describe('coveredDays 的 sourceIds 过滤口径（覆盖率 D 对齐配置来源）', () => {
  it('只数「来源集内有记录」的天；空数组/缺省 = 不过滤（现状口径）', async () => {
    const dataDir = join(dir, TOPICS_DIR_NAME)
    await mkdir(dataDir, { recursive: true })
    const line = (sourceId: string, id: string) =>
      `${JSON.stringify({ ...baseRec(`${sourceId}:${id}`), sourceId })}\n`
    // 09-16 只有 nodeseek；09-17 只有 v2ex；09-18 两者都有
    await writeFile(join(dataDir, '2026-09-16.jsonl'), line('nodeseek', 'a'), 'utf-8')
    await writeFile(join(dataDir, '2026-09-17.jsonl'), line('v2ex', 'b'), 'utf-8')
    await writeFile(join(dataDir, '2026-09-18.jsonl'), line('nodeseek', 'c') + line('v2ex', 'd'), 'utf-8')
    const store = new TopicArchiveStore({ dataDir })
    // 只统计 nodeseek：09-17（只有 v2ex）不算 covered
    expect(await store.coveredDays('2026-09-16', '2026-09-18', ['nodeseek'])).toEqual([
      '2026-09-16',
      '2026-09-18'
    ])
    // 只统计 v2ex：09-16 不算
    expect(await store.coveredDays('2026-09-16', '2026-09-18', ['v2ex'])).toEqual([
      '2026-09-17',
      '2026-09-18'
    ])
    // 多来源并集
    expect(await store.coveredDays('2026-09-16', '2026-09-18', ['nodeseek', 'v2ex'])).toEqual([
      '2026-09-16',
      '2026-09-17',
      '2026-09-18'
    ])
    // 空数组 = 不过滤（全部来源——与 category-report 的空 sourceIds 语义一致）
    expect(await store.coveredDays('2026-09-16', '2026-09-18', [])).toEqual([
      '2026-09-16',
      '2026-09-17',
      '2026-09-18'
    ])
    // 缺省 = 现状口径
    expect(await store.coveredDays('2026-09-16', '2026-09-18')).toHaveLength(3)
  })
})

describe('readonly 模式（样例脚本：绝不写用户数据目录）', () => {
  it('不建目录、不清理旧文件、record 短路；读取照常', async () => {
    const dataDir = join(dir, TOPICS_DIR_NAME)
    await mkdir(dataDir, { recursive: true })
    // 预置一个"过期"文件：readonly 构造不得删它
    const oldFile = join(dataDir, '2020-01-01.jsonl')
    await writeFile(oldFile, JSON.stringify(baseRec('s:old')) + '\n', 'utf-8')

    const store = new TopicArchiveStore({ dataDir, readonly: true })
    store.record(topic('1'))
    store.record(topic('2'))
    await store.flush()
    expect(existsSync(join(dataDir, `${formatLocalDate()}.jsonl`))).toBe(false)
    expect(existsSync(oldFile)).toBe(true)
    expect(await store.readDay('2020-01-01')).toHaveLength(1)
    expect(store.listDays()).toEqual(['2020-01-01'])
  })
})

/** 测试用最小合法 TopicRecord（readRange/coveredDays 的盘上预置） */
function baseRec(key: string): Record<string, unknown> {
  return {
    key,
    sourceId: 's',
    topicId: key.split(':')[1] ?? key,
    title: `t-${key}`,
    url: 'u',
    author: 'a',
    category: 'c',
    categorySlug: 'cs',
    pinned: false,
    lastActiveAt: null,
    firstSeenAt: '2026-09-18T00:00:00.000Z'
  }
}
