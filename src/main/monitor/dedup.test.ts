import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SEEN_CAPACITY,
  FileSeenStore,
  SEEN_CAPACITY_PER_EXTRA_SOURCE,
  SeenStore,
  seenCapacityForSources
} from './dedup'

let dir: string
let storePath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rss-monitor-dedup-'))
  storePath = join(dir, 'state.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('seenCapacityForSources（多源容量推导，ultrabrain 坑12）', () => {
  it('单源恒 1000（含 1），与 v2 行为一致', () => {
    expect(seenCapacityForSources(1)).toBe(DEFAULT_SEEN_CAPACITY)
    expect(seenCapacityForSources(1)).toBe(1000)
  })

  it('多源线性扩容：1000 + 500 × (sourceCount - 1)', () => {
    expect(seenCapacityForSources(2)).toBe(1500)
    expect(seenCapacityForSources(3)).toBe(2000)
    expect(seenCapacityForSources(5)).toBe(1000 + SEEN_CAPACITY_PER_EXTRA_SOURCE * 4)
  })

  it('垃圾输入（0 / 负数 / 非整数 / 非有限数）钳到单源基线或向下取整', () => {
    expect(seenCapacityForSources(0)).toBe(1000) // max(0, -1) = 0
    expect(seenCapacityForSources(-3)).toBe(1000)
    expect(seenCapacityForSources(2.9)).toBe(1500) // floor(2.9)=2 → 1 个额外源
    expect(seenCapacityForSources(Number.NaN)).toBe(1000) // 非有限数按单源兜底
    expect(seenCapacityForSources(Number.POSITIVE_INFINITY)).toBe(1000)
  })
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

  it('serialize/deserialize 往返保持条目与顺序（盘上恒为 v2）', () => {
    const s = new SeenStore(10)
    const t = 1_700_000_000_000
    s.add('nodeseek:x', t)
    s.add('nodeseek:y', t + 1)
    const raw = s.serialize()
    expect(raw.schemaVersion).toBe(2)
    expect(raw.seen).toEqual([
      { id: 'nodeseek:x', addedAt: t },
      { id: 'nodeseek:y', addedAt: t + 1 }
    ])
    const revived = SeenStore.deserialize(JSON.parse(JSON.stringify(raw)), 10)
    expect(revived.size()).toBe(2)
    expect(revived.has('nodeseek:x')).toBe(true)
    expect(revived.has('nodeseek:y')).toBe(true)
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
      { schemaVersion: 3, seen: [] }, // 未知版本（v2 起合法版本是 1|2）
      { schemaVersion: '1', seen: [] },
      { seen: [] },
      { schemaVersion: 2, seen: 'not-array' },
      { schemaVersion: 2, seen: null },
      { schemaVersion: 1, seen: 'not-array' },
      { schemaVersion: 1, seen: null }
    ]
    for (const g of garbage) {
      const s = SeenStore.deserialize(g)
      expect(s.size()).toBe(0)
    }
  })

  it('deserialize v1（裸 id）：每条前缀化为 nodeseek:{id}', () => {
    const raw = {
      schemaVersion: 1,
      seen: [
        { id: '936634', addedAt: 123 },
        { id: '936635', addedAt: 456 }
      ]
    }
    const s = SeenStore.deserialize(raw)
    expect(s.size()).toBe(2)
    expect(s.has('nodeseek:936634')).toBe(true)
    expect(s.has('nodeseek:936635')).toBe(true)
    expect(s.has('936634')).toBe(false) // 裸 id 不再命中
    expect(s.serialize().schemaVersion).toBe(2) // 再落盘即 v2
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
    expect(s.has('nodeseek:ok')).toBe(true)
  })

  it('deserialize 超出 capacity 时只保留最新的部分（v1 前缀化不改变淘汰语义）', () => {
    const seen = Array.from({ length: 10 }, (_, i) => ({ id: `i${i}`, addedAt: i }))
    const s = SeenStore.deserialize({ schemaVersion: 1, seen }, 3)
    expect(s.size()).toBe(3)
    expect(s.has('nodeseek:i0')).toBe(false)
    expect(s.has('nodeseek:i1')).toBe(false)
    expect(s.has('nodeseek:i7')).toBe(true)
    expect(s.has('nodeseek:i8')).toBe(true)
    expect(s.has('nodeseek:i9')).toBe(true)
  })
})

describe('FileSeenStore（文件 backed）', () => {
  it('load→add→flush→重新 new+load 能读到（盘上 schemaVersion 2）', async () => {
    const s1 = new FileSeenStore(storePath)
    s1.load()
    expect(s1.has('nodeseek:936634')).toBe(false)
    s1.add('nodeseek:936634')
    s1.add('nodeseek:936635')
    await s1.flush()

    const s2 = new FileSeenStore(storePath)
    s2.load()
    expect(s2.has('nodeseek:936634')).toBe(true)
    expect(s2.has('nodeseek:936635')).toBe(true)
    expect(s2.has('nodeseek:999999')).toBe(false)
    expect(s2.size()).toBe(2)

    // 盘上文件带 schemaVersion（v2）
    const onDisk = JSON.parse(await readFile(storePath, 'utf-8'))
    expect(onDisk.schemaVersion).toBe(2)
    expect(onDisk.seen).toHaveLength(2)
  })

  it('v1 文件（裸 id）：load 前缀化成功、不置 rebuiltFromCorrupt；flush 落 v2', async () => {
    await writeFile(
      storePath,
      JSON.stringify({
        schemaVersion: 1,
        seen: [
          { id: '123', addedAt: 1_700_000_000_000 },
          { id: '456', addedAt: 1_700_000_000_001 }
        ]
      }),
      'utf-8'
    )
    const s = new FileSeenStore(storePath)
    expect(() => s.load()).not.toThrow()
    // 裸 id 视为 nodeseek:{id}
    expect(s.has('nodeseek:123')).toBe(true)
    expect(s.has('nodeseek:456')).toBe(true)
    expect(s.has('123')).toBe(false)
    expect(s.has('456')).toBe(false)
    expect(s.size()).toBe(2)
    // v1 是成功加载，不是损坏重建（不触发补基线）
    expect(s.rebuiltFromCorrupt).toBe(false)
    // 无 .corrupt- 备份产生
    expect((await readdir(dir)).some((f) => f.includes('.corrupt-'))).toBe(false)

    // 下次 flush 自然落 v2（id 已带前缀）
    await s.flush()
    const onDisk = JSON.parse(await readFile(storePath, 'utf-8'))
    expect(onDisk.schemaVersion).toBe(2)
    expect(onDisk.seen).toEqual([
      { id: 'nodeseek:123', addedAt: 1_700_000_000_000 },
      { id: 'nodeseek:456', addedAt: 1_700_000_000_001 }
    ])
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

  it('rebuiltFromCorrupt：损坏/缺文件/健康文件三种 load 的标志位', async () => {
    // 缺文件：不是损坏重建
    const missing = new FileSeenStore(join(dir, 'nope.json'))
    missing.load()
    expect(missing.rebuiltFromCorrupt).toBe(false)

    // 健康文件：不是损坏重建
    const healthy = new FileSeenStore(storePath)
    healthy.add('a')
    await healthy.flush()
    const reloaded = new FileSeenStore(storePath)
    reloaded.load()
    expect(reloaded.rebuiltFromCorrupt).toBe(false)
    expect(reloaded.size()).toBe(1)

    // 损坏文件：是损坏重建
    await writeFile(storePath, '{ corrupt !!!', 'utf-8')
    const corrupt = new FileSeenStore(storePath)
    corrupt.load()
    expect(corrupt.rebuiltFromCorrupt).toBe(true)
    expect(corrupt.size()).toBe(0)
  })

  it.skipIf(process.platform === 'win32')(
    '损坏备份文件权限 0o600（darwin/linux）',
    async () => {
      await writeFile(storePath, '{ this is not json !!!', 'utf-8')
      new FileSeenStore(storePath).load()
      const files = await readdir(dir)
      const backup = files.find((f) => f.startsWith('state.json.corrupt-'))
      expect(backup).toBeDefined()
      expect(statSync(join(dir, backup!)).mode & 0o777).toBe(0o600)
    }
  )

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

  it('flush 返回值：成功 true；写失败（父路径被同名文件挡住）false 且不抛', async () => {
    const good = new FileSeenStore(storePath)
    good.add('a')
    await expect(good.flush()).resolves.toBe(true)

    // dirname 是一个普通文件 → mkdir 失败 → flush 返回 false
    await writeFile(join(dir, 'blocker'), 'x', 'utf-8')
    const bad = new FileSeenStore(join(dir, 'blocker', 'seen.json'))
    bad.add('a')
    await expect(bad.flush()).resolves.toBe(false)
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
    expect(s.has('nodeseek:stale')).toBe(true)
    s.prune(now)
    expect(s.has('nodeseek:stale')).toBe(false)
    expect(s.has('nodeseek:recent')).toBe(true)
    await s.flush()
    const onDisk = JSON.parse(await readFile(storePath, 'utf-8'))
    expect(onDisk.seen).toEqual([{ id: 'nodeseek:recent', addedAt: now - 60_000 }])
  })
})
