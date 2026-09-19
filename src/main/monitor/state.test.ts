import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileEngineState } from './state'

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rss-monitor-state-'))
  path = join(dir, 'state.json')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('FileEngineState', () => {
  it('文件缺失：load 正常返回，getFor 给默认值，且不产生任何备份文件', async () => {
    const s = new FileEngineState(path)
    expect(() => s.load()).not.toThrow()
    expect(s.getFor('nodeseek')).toEqual({ baselineDone: false, totalHits: 0, maxSeenTopicId: null })
    expect(await readdir(dir)).toEqual([])
  })

  it('未 load 直接 getFor：等价于先 load 默认值', () => {
    const s = new FileEngineState(path)
    expect(s.getFor('nodeseek')).toEqual({ baselineDone: false, totalHits: 0, maxSeenTopicId: null })
    expect(s.getFor('anything-else')).toEqual({ baselineDone: false, totalHits: 0, maxSeenTopicId: null })
  })

  it('roundtrip：setFor 原子落盘 v2 形状，新实例 load 读回相同值', async () => {
    const s = new FileEngineState(path)
    s.setFor('nodeseek', { baselineDone: true })
    s.setFor('nodeseek', { totalHits: 42 })

    expect(s.getFor('nodeseek')).toEqual({ baselineDone: true, totalHits: 42, maxSeenTopicId: null })
    const raw = JSON.parse(await readFile(path, 'utf-8'))
    expect(raw).toEqual({
      schemaVersion: 2,
      sources: { nodeseek: { baselineDone: true, totalHits: 42, maxSeenTopicId: null } }
    })

    const s2 = new FileEngineState(path)
    s2.load()
    expect(s2.getFor('nodeseek')).toEqual({ baselineDone: true, totalHits: 42, maxSeenTopicId: null })
  })

  it('多来源互不干扰：setFor 各自独立、未写过的来源给默认值', async () => {
    const s = new FileEngineState(path)
    s.setFor('nodeseek', { baselineDone: true, totalHits: 7 })
    s.setFor('another', { baselineDone: true, totalHits: 3 })
    expect(s.getFor('nodeseek')).toEqual({ baselineDone: true, totalHits: 7, maxSeenTopicId: null })
    expect(s.getFor('another')).toEqual({ baselineDone: true, totalHits: 3, maxSeenTopicId: null })
    expect(s.getFor('third')).toEqual({ baselineDone: false, totalHits: 0, maxSeenTopicId: null })

    // 落盘 & 重读
    const s2 = new FileEngineState(path)
    s2.load()
    expect(s2.getFor('nodeseek').totalHits).toBe(7)
    expect(s2.getFor('another').totalHits).toBe(3)
    expect(s2.getFor('third')).toEqual({ baselineDone: false, totalHits: 0, maxSeenTopicId: null })
  })

  it('setFor 是合并语义：未给的字段保留当前值', () => {
    const s = new FileEngineState(path)
    s.setFor('nodeseek', { baselineDone: true, totalHits: 7 })
    s.setFor('nodeseek', { totalHits: 9 })
    expect(s.getFor('nodeseek')).toEqual({ baselineDone: true, totalHits: 9, maxSeenTopicId: null })
  })

  it('totalHits 非法值（NaN/负数/Infinity）回退当前值', () => {
    const s = new FileEngineState(path)
    s.setFor('nodeseek', { totalHits: 5 })
    s.setFor('nodeseek', { totalHits: Number.NaN })
    expect(s.getFor('nodeseek').totalHits).toBe(5)
    s.setFor('nodeseek', { totalHits: -3 })
    expect(s.getFor('nodeseek').totalHits).toBe(5)
    s.setFor('nodeseek', { totalHits: Number.POSITIVE_INFINITY })
    expect(s.getFor('nodeseek').totalHits).toBe(5)
  })

  it('v1 文件（顶层 baselineDone/totalHits）：load 迁移到 sources.nodeseek', async () => {
    await writeFile(
      path,
      JSON.stringify({ schemaVersion: 1, baselineDone: true, totalHits: 13 }),
      'utf-8'
    )
    const s = new FileEngineState(path)
    s.load()
    expect(s.getFor('nodeseek')).toEqual({ baselineDone: true, totalHits: 13, maxSeenTopicId: null })
    // 迁移后 setFor 落盘为 v2
    s.setFor('nodeseek', { totalHits: 14 })
    const raw = JSON.parse(await readFile(path, 'utf-8'))
    expect(raw).toEqual({
      schemaVersion: 2,
      sources: { nodeseek: { baselineDone: true, totalHits: 14, maxSeenTopicId: null } }
    })
    expect((await readdir(dir)).some((n) => n.includes('.corrupt-'))).toBe(false)
  })

  it('损坏文件（非法 JSON）：备份 .corrupt- 后回默认', async () => {
    await writeFile(path, '{not json', 'utf-8')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const s = new FileEngineState(path)
    expect(() => s.load()).not.toThrow()
    expect(s.getFor('nodeseek')).toEqual({ baselineDone: false, totalHits: 0, maxSeenTopicId: null })

    const names = await readdir(dir)
    const backup = names.find((n) => n.startsWith('state.json.corrupt-'))
    expect(backup).toBeDefined()
    expect(await readFile(join(dir, backup as string), 'utf-8')).toBe('{not json')
    expect(errSpy).toHaveBeenCalled()
  })

  it('损坏文件（形状不对 / 版本不认识）：同样备份回默认', async () => {
    await writeFile(path, JSON.stringify({ schemaVersion: 3, baselineDone: true }), 'utf-8')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const s = new FileEngineState(path)
    s.load()
    expect(s.getFor('nodeseek').baselineDone).toBe(false)

    const names = await readdir(dir)
    expect(names.some((n) => n.includes('.corrupt-'))).toBe(true)
    expect(errSpy).toHaveBeenCalled()
  })

  it('v2 文件单条来源条目损坏：整体按损坏处理（严格形状校验）', async () => {
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 2,
        sources: {
          nodeseek: { baselineDone: true, totalHits: 5 },
          broken: { baselineDone: 'yes', totalHits: 1 }
        }
      }),
      'utf-8'
    )
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const s = new FileEngineState(path)
    s.load()
    expect(s.getFor('nodeseek')).toEqual({ baselineDone: false, totalHits: 0, maxSeenTopicId: null })
    expect((await readdir(dir)).some((n) => n.includes('.corrupt-'))).toBe(true)
    expect(errSpy).toHaveBeenCalled()
  })

  it('原子写：多次 setFor 后目录里只有 state.json，无 tmp 残留', async () => {
    const s = new FileEngineState(path)
    for (let i = 1; i <= 5; i++) s.setFor('nodeseek', { totalHits: i })
    expect(await readdir(dir)).toEqual(['state.json'])
  })

  it('getFor 返回拷贝：外部改动不污染内部', () => {
    const s = new FileEngineState(path)
    s.setFor('nodeseek', { totalHits: 3 })
    const v = s.getFor('nodeseek')
    v.totalHits = 100
    v.baselineDone = true
    v.maxSeenTopicId = 999
    expect(s.getFor('nodeseek')).toEqual({ baselineDone: false, totalHits: 3, maxSeenTopicId: null })
  })

  // ---- maxSeenTopicId（W3：per-source 发帖 id 阈值）----------------------------

  it('旧 v2 文件（无 maxSeenTopicId 字段）：读出 null，不判损坏（无备份文件、无错误日志）', async () => {
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 2,
        sources: { nodeseek: { baselineDone: true, totalHits: 5 } }
      }),
      'utf-8'
    )
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const s = new FileEngineState(path)
    s.load()
    expect(s.getFor('nodeseek')).toEqual({ baselineDone: true, totalHits: 5, maxSeenTopicId: null })
    expect((await readdir(dir)).some((n) => n.includes('.corrupt-'))).toBe(false)
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('maxSeenTopicId 读写往返：落盘重读保留；setFor 只传 totalHits patch 不丢阈值', async () => {
    const s = new FileEngineState(path)
    s.setFor('nodeseek', { baselineDone: true, totalHits: 1, maxSeenTopicId: 933617 })
    // engine 每有命中就 setFor totalHits——阈值必须穿越这种 patch 存活
    s.setFor('nodeseek', { totalHits: 2 })
    s.setFor('nodeseek', { baselineDone: true })

    expect(s.getFor('nodeseek')).toEqual({ baselineDone: true, totalHits: 2, maxSeenTopicId: 933617 })
    const raw = JSON.parse(await readFile(path, 'utf-8'))
    expect(raw.sources.nodeseek.maxSeenTopicId).toBe(933617)

    const s2 = new FileEngineState(path)
    s2.load()
    expect(s2.getFor('nodeseek').maxSeenTopicId).toBe(933617)
    // s2 上的 totalHits patch 同样不丢阈值
    s2.setFor('nodeseek', { totalHits: 3 })
    expect(s2.getFor('nodeseek').maxSeenTopicId).toBe(933617)
  })

  it('单条目 maxSeenTopicId 非法（字符串/布尔/数组/负数/小数/超安全整数）：该条按 null 收编，整文件合法，其他来源不受影响', async () => {
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 2,
        sources: {
          nodeseek: { baselineDone: true, totalHits: 5, maxSeenTopicId: 'bogus' },
          boolish: { baselineDone: true, totalHits: 1, maxSeenTopicId: true },
          listy: { baselineDone: false, totalHits: 0, maxSeenTopicId: [1, 2] },
          negative: { baselineDone: true, totalHits: 1, maxSeenTopicId: -7 },
          fractional: { baselineDone: false, totalHits: 0, maxSeenTopicId: 1.5 },
          unsafe: { baselineDone: true, totalHits: 3, maxSeenTopicId: Number.MAX_SAFE_INTEGER + 1 },
          healthy: { baselineDone: true, totalHits: 4, maxSeenTopicId: 12345 }
        }
      }),
      'utf-8'
    )
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const s = new FileEngineState(path)
    s.load()
    expect(s.getFor('nodeseek')).toEqual({ baselineDone: true, totalHits: 5, maxSeenTopicId: null })
    expect(s.getFor('boolish').maxSeenTopicId).toBeNull()
    expect(s.getFor('listy').maxSeenTopicId).toBeNull()
    expect(s.getFor('negative').maxSeenTopicId).toBeNull()
    expect(s.getFor('fractional').maxSeenTopicId).toBeNull()
    expect(s.getFor('unsafe').maxSeenTopicId).toBeNull()
    // 其他来源（含合法阈值）不受影响；baselineDone/totalHits 严格字段照常读出
    expect(s.getFor('healthy')).toEqual({ baselineDone: true, totalHits: 4, maxSeenTopicId: 12345 })

    // 整文件合法：无备份、无错误日志；且收编后可正常 setFor 落盘
    expect((await readdir(dir)).some((n) => n.includes('.corrupt-'))).toBe(false)
    expect(errSpy).not.toHaveBeenCalled()
    s.setFor('nodeseek', { totalHits: 6 })
    const raw = JSON.parse(await readFile(path, 'utf-8'))
    expect(raw.sources.nodeseek).toEqual({ baselineDone: true, totalHits: 6, maxSeenTopicId: null })
  })

  it('maxSeenTopicId 显式 null 写入保留；非法 number patch 回退当前值', async () => {
    const s = new FileEngineState(path)
    s.setFor('nodeseek', { maxSeenTopicId: 100 })
    // 非法 number：不写入也不清掉已有阈值
    s.setFor('nodeseek', { maxSeenTopicId: Number.NaN })
    expect(s.getFor('nodeseek').maxSeenTopicId).toBe(100)
    s.setFor('nodeseek', { maxSeenTopicId: -1 })
    expect(s.getFor('nodeseek').maxSeenTopicId).toBe(100)
    s.setFor('nodeseek', { maxSeenTopicId: 3.14 })
    expect(s.getFor('nodeseek').maxSeenTopicId).toBe(100)
    s.setFor('nodeseek', { maxSeenTopicId: Number.POSITIVE_INFINITY })
    expect(s.getFor('nodeseek').maxSeenTopicId).toBe(100)

    // 显式 null = 重置阈值，且穿越后续 patch 保留
    s.setFor('nodeseek', { maxSeenTopicId: null })
    s.setFor('nodeseek', { totalHits: 1 })
    expect(s.getFor('nodeseek').maxSeenTopicId).toBeNull()

    const s2 = new FileEngineState(path)
    s2.load()
    expect(s2.getFor('nodeseek').maxSeenTopicId).toBeNull()
    const raw = JSON.parse(await readFile(path, 'utf-8'))
    expect(raw.sources.nodeseek.maxSeenTopicId).toBeNull()
  })
})
