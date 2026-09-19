import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HitRecord, Topic } from '../../shared/types'
import { formatLocalDate, HitsStore, HITS_DIR_NAME } from './hits-store'

let dir: string // 模拟 <userData>/hits（构造函数收 hits 目录本身）
let store: HitsStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forumwatch-hits-'))
  store = new HitsStore(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function makeTopic(id: string): Topic {
  return {
    id,
    sourceId: 'nodeseek',
    title: `title-${id}`,
    url: `https://www.nodeseek.com/post-${id}-1`,
    author: 'someone',
    category: '交易',
    categorySlug: 'trade',
    pinned: false,
    lastActiveAt: '2026-09-19T10:00:00+08:00'
  }
}

function makeHit(id: string, matchedBy: 'literal' | 'semantic' = 'literal'): HitRecord {
  return {
    topic: makeTopic(id),
    matchedKeywords: matchedBy === 'literal' ? ['vps'] : [],
    matchedBy,
    semanticReason: matchedBy === 'semantic' ? '与兴趣描述中的自建主机话题相关' : null,
    notifiedAt: '2026-09-19T10:00:01+08:00',
    notifyError: null
  }
}

describe('formatLocalDate（本地时区口径）', () => {
  it('月/日补零', () => {
    expect(formatLocalDate(new Date(2026, 0, 5, 3, 7))).toBe('2026-01-05')
    expect(formatLocalDate(new Date(2026, 10, 20))).toBe('2026-11-20')
  })

  it('23:59 边界仍属当天', () => {
    expect(formatLocalDate(new Date(2026, 8, 19, 23, 59))).toBe('2026-09-19')
  })

  it('本地 00:30 不漂移到 UTC 日期（误用 toISOString().slice 会差一天）', () => {
    // 本地构造 2026-09-19 00:30：东八区机器上 UTC 是 2026-09-18 16:30，
    // toISOString().slice(0,10) 会得到 '2026-09-18'（错误口径）。
    const d = new Date(2026, 8, 19, 0, 30)
    expect(formatLocalDate(d)).toBe('2026-09-19')
    // 无论测试机处于哪个时区：只要 UTC 日期与本地日期不同，结果必须取本地那份
    const utcDate = d.toISOString().slice(0, 10)
    if (utcDate !== '2026-09-19') {
      expect(formatLocalDate(d)).not.toBe(utcDate)
    }
  })

  it('默认参数返回今天（与显式 new Date() 一致）', () => {
    expect(formatLocalDate()).toBe(formatLocalDate(new Date()))
  })
})

describe('HitsStore', () => {
  it('目录名常量', () => {
    expect(HITS_DIR_NAME).toBe('hits')
  })

  it('append→readDay 往返：多条、顺序保持（旧→新）、v2 字段原样', async () => {
    const now = new Date(2026, 8, 19, 12, 0)
    const a = makeHit('1', 'literal')
    const b = makeHit('2', 'semantic')
    const c = makeHit('3', 'literal')
    await store.append(a, now)
    await store.append(b, now)
    await store.append(c, now)

    const hits = await store.readDay('2026-09-19')
    expect(hits.map((h) => h.topic.id)).toEqual(['1', '2', '3'])
    expect(hits[0]).toEqual(a)
    expect(hits[1].matchedBy).toBe('semantic')
    expect(hits[1].matchedKeywords).toEqual([])
    expect(hits[1].semanticReason).toBe('与兴趣描述中的自建主机话题相关')
    expect(hits[2].topic.sourceId).toBe('nodeseek')

    // 文件形态：一行一个 JSON + 换行，ISO 时间戳原样字符串
    const raw = await readFile(join(dir, '2026-09-19.jsonl'), 'utf-8')
    const lines = raw.split('\n')
    expect(lines).toHaveLength(4) // 3 行内容 + 末尾空串（尾随 \n）
    expect(JSON.parse(lines[0])).toEqual(a)
    expect(raw.endsWith('\n')).toBe(true)
  })

  it('跨天分桶：不同 now 落到不同文件', async () => {
    await store.append(makeHit('1'), new Date(2026, 8, 18, 23, 59))
    await store.append(makeHit('2'), new Date(2026, 8, 19, 0, 1))
    await store.append(makeHit('3'), new Date(2026, 8, 19, 8, 0))

    expect((await store.readDay('2026-09-18')).map((h) => h.topic.id)).toEqual(['1'])
    expect((await store.readDay('2026-09-19')).map((h) => h.topic.id)).toEqual(['2', '3'])

    const files = (await readdir(dir)).sort()
    expect(files).toEqual(['2026-09-18.jsonl', '2026-09-19.jsonl'])
  })

  it('readDay：文件不存在 → []', async () => {
    expect(await store.readDay('2030-01-01')).toEqual([])
  })

  it('坏行容错：中间行是垃圾 / 形状不对的行都被跳过，其余照常返回', async () => {
    const good1 = makeHit('1')
    const good2 = makeHit('2')
    // 手工拼一个文件：好行 / 垃圾（非法 JSON）/ 合法 JSON 但不是 HitRecord / 好行（无尾随换行）
    const raw =
      `${JSON.stringify(good1)}\n` +
      `{"broken": 这不是JSON\n` +
      `{"foo": "bar"}\n` +
      `{"topic": {"id": 123}}\n` +
      JSON.stringify(good2)
    await writeFile(join(dir, '2026-09-19.jsonl'), raw, 'utf-8')

    const hits = await store.readDay('2026-09-19')
    expect(hits).toEqual([good1, good2])
  })

  it('listDays：新→旧排序，无关文件名被忽略', async () => {
    await store.append(makeHit('1'), new Date(2026, 8, 18))
    await store.append(makeHit('2'), new Date(2026, 8, 1))
    await store.append(makeHit('3'), new Date(2026, 8, 19))
    // 无关文件：不同扩展名 / 日期不补零 / 多余后缀 / 普通文本
    await writeFile(join(dir, '2026-09-19.md'), '', 'utf-8')
    await writeFile(join(dir, '2026-9-9.jsonl'), '', 'utf-8')
    await writeFile(join(dir, '2026-09-19.jsonl.bak'), '', 'utf-8')
    await writeFile(join(dir, 'notes.txt'), '', 'utf-8')

    expect(store.listDays()).toEqual(['2026-09-19', '2026-09-18', '2026-09-01'])
  })

  it('listDays：目录不存在 → []', () => {
    expect(new HitsStore(join(dir, 'not-exist')).listDays()).toEqual([])
  })
})
