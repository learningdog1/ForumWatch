import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileSeenStore, SeenStore } from './dedup'

let dir: string
let storePath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rss-monitor-dedup-'))
  storePath = join(dir, 'state.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('SeenStore（纯内存）', () => {
  it('基础 has/add/size', () => {
    const s = new SeenStore(10)
    expect(s.size()).toBe(0)
    expect(s.has('a')).toBe(false)
    s.add('a')
    expect(s.has('a')).toBe(true)
    expect(s.size()).toBe(1)
  })

  it('容量环形淘汰：加第 1001 个挤掉第 1 个', () => {
    const s = new SeenStore() // 默认 1000
    for (let i = 1; i <= 1000; i++) s.add(`id-${i}`)
    expect(s.size()).toBe(1000)
    expect(s.has('id-1')).toBe(true)
    s.add('id-1001')
    expect(s.size()).toBe(1000) // 不超容量
    expect(s.has('id-1')).toBe(false) // 最老的被淘汰
    expect(s.has('id-2')).toBe(true)
    expect(s.has('id-1001')).toBe(true)
  })

  it('小容量同样成立：capacity=3 时第 4 个挤掉第 1 个', () => {
    const s = new SeenStore(3)
    s.add('a')
    s.add('b')
    s.add('c')
    s.add('d')
    expect(s.size()).toBe(3)
    expect(s.has('a')).toBe(false)
    expect(s.has('b')).toBe(true)
    expect(s.has('c')).toBe(true)
    expect(s.has('d')).toBe(true)
  })

  it('重复 add 同一 id 不增长容量，且刷新时间戳移到队尾', () => {
    const s = new SeenStore(2)
    const t0 = 1000
    s.add('a', t0)
    s.add('b', t0)
    s.add('a', t0 + 50) // 刷新 a：等效"最近见过"
    expect(s.size()).toBe(2)
    s.add('c', t0 + 60) // 此时最老的是 b，应淘汰 b 而不是 a
    expect(s.has('a')).toBe(true)
    expect(s.has('b')).toBe(false)
    expect(s.has('c')).toBe(true)
  })

  it('pruneOlderThan 淘汰超龄条目并返回淘汰数', () => {
    const s = new SeenStore(100)
    s.add('old1', 0)
    s.add('old2', 1000)
    s.add('fresh', 90_000)
    const pruned = s.pruneOlderThan(60_000, 100_000) // 年龄 > 60s 的淘汰
    expect(pruned).toBe(2)
    expect(s.has('old1')).toBe(false)
    expect(s.has('old2')).toBe(false)
    expect(s.has('fresh')).toBe(true)
    expect(s.size()).toBe(1)
  })

  it('serialize/deserialize 往返保持条目与顺序', () => {
    const s = new SeenStore(10)
    const t = 1_700_000_000_000
    s.add('x', t)
    s.add('y', t + 1)
    const raw = s.serialize()
    expect(raw.schemaVersion).toBe(1)
    expect(raw.seen).toEqual([
      { id: 'x', addedAt: t },
      { id: 'y', addedAt: t + 1 }
    ])
    const revived = SeenStore.deserialize(JSON.parse(JSON.stringify(raw)), 10)
    expect(revived.size()).toBe(2)
    expect(revived.has('x')).toBe(true)
    expect(revived.has('y')).toBe(true)
    expect(revived.serialize()).toEqual(raw)
  })

  it('deserialize 坏数据返回空 store 且不抛', () => {
    const garbage: unknown[] = [
      null,
      undefined,
      42,
      'nope',
      [],
      {},
      { schemaVersion: 2, seen: [] },
      { schemaVersion: '1', seen: [] },
      { seen: [] },
      { schemaVersion: 1, seen: 'not-array' },
      { schemaVersion: 1, seen: null }
    ]
    for (const g of garbage) {
      const s = SeenStore.deserialize(g)
      expect(s.size()).toBe(0)
    }
  })

  it('deserialize 跳过单条坏条目，只收合法条目', () => {
    const raw = {
      schemaVersion: 1,
      seen: [
        { id: 'ok', addedAt: 123 },
        { id: '', addedAt: 1 }, // 空 id
        { id: 7, addedAt: 1 }, // id 非字符串
        { id: 'no-time' }, // addedAt 缺失
        { id: 'nan', addedAt: Number.NaN }, // addedAt 非有限数
        null, // 非对象
        'junk'
      ]
    }
    const s = SeenStore.deserialize(raw)
    expect(s.size()).toBe(1)
    expect(s.has('ok')).toBe(true)
  })

  it('deserialize 超出 capacity 时只保留最新的部分', () => {
    const seen = Array.from({ length: 10 }, (_, i) => ({ id: `i${i}`, addedAt: i }))
    const s = SeenStore.deserialize({ schemaVersion: 1, seen }, 3)
    expect(s.size()).toBe(3)
    expect(s.has('i0')).toBe(false)
    expect(s.has('i1')).toBe(false)
    expect(s.has('i7')).toBe(true)
    expect(s.has('i8')).toBe(true)
    expect(s.has('i9')).toBe(true)
  })
})

describe('FileSeenStore（文件 backed）', () => {
  it('load→add→flush→重新 new+load 能读到', async () => {
    const s1 = new FileSeenStore(storePath)
    s1.load()
    expect(s1.has('936634')).toBe(false)
    s1.add('936634')
    s1.add('936635')
    await s1.flush()

    const s2 = new FileSeenStore(storePath)
    s2.load()
    expect(s2.has('936634')).toBe(true)
    expect(s2.has('936635')).toBe(true)
    expect(s2.has('999999')).toBe(false)
    expect(s2.size()).toBe(2)

    // 盘上文件带 schemaVersion
    const onDisk = JSON.parse(await readFile(storePath, 'utf-8'))
    expect(onDisk.schemaVersion).toBe(1)
    expect(onDisk.seen).toHaveLength(2)
  })

  it('文件缺失 = 空集，load 不抛不建文件', () => {
    const s = new FileSeenStore(join(dir, 'nope.json'))
    expect(() => s.load()).not.toThrow()
    expect(s.size()).toBe(0)
  })

  it('损坏 JSON：load 不抛、生成 .corrupt- 备份、从空开始', async () => {
    await writeFile(storePath, '{ this is not json !!!', 'utf-8')
    const s = new FileSeenStore(storePath)
    expect(() => s.load()).not.toThrow()
    expect(s.size()).toBe(0)
    const files = await readdir(dir)
    const backups = files.filter((f) => f.startsWith('state.json.corrupt-'))
    expect(backups.length).toBe(1)
    expect(await readFile(join(dir, backups[0]!), 'utf-8')).toBe('{ this is not json !!!')
  })

  it('合法 JSON 但 schema 不认识：同样备份并从空开始', async () => {
    await writeFile(storePath, JSON.stringify({ schemaVersion: 99, seen: [{ id: 'x', addedAt: 1 }] }), 'utf-8')
    const s = new FileSeenStore(storePath)
    expect(() => s.load()).not.toThrow()
    expect(s.size()).toBe(0)
    expect((await readdir(dir)).some((f) => f.startsWith('state.json.corrupt-'))).toBe(true)
  })

  it('flush 后目录里没有 .tmp- 残留', async () => {
    const s = new FileSeenStore(storePath)
    s.add('a')
    s.add('b')
    await s.flush()
    const files = await readdir(dir)
    expect(files.some((f) => f.includes('.tmp-'))).toBe(false)
    expect(files).toContain('state.json')
  })

  it('prune 清理超过保留期的旧条目（文件里预置老时间戳）', async () => {
    const now = Date.now()
    const week = 7 * 24 * 60 * 60 * 1000
    await writeFile(
      storePath,
      JSON.stringify({
        schemaVersion: 1,
        seen: [
          { id: 'stale', addedAt: now - week - 1000 }, // 超 7 天
          { id: 'recent', addedAt: now - 60_000 }
        ]
      }),
      'utf-8'
    )
    const s = new FileSeenStore(storePath)
    s.load()
    expect(s.has('stale')).toBe(true)
    s.prune(now)
    expect(s.has('stale')).toBe(false)
    expect(s.has('recent')).toBe(true)
    await s.flush()
    const onDisk = JSON.parse(await readFile(storePath, 'utf-8'))
    expect(onDisk.seen).toEqual([{ id: 'recent', addedAt: now - 60_000 }])
  })
})
