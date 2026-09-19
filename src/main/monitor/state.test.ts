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
    expect(s.getFor('nodeseek')).toEqual({ baselineDone: false, totalHits: 0 })
    expect(await readdir(dir)).toEqual([])
  })

  it('未 load 直接 getFor：等价于先 load 默认值', () => {
    const s = new FileEngineState(path)
    expect(s.getFor('nodeseek')).toEqual({ baselineDone: false, totalHits: 0 })
    expect(s.getFor('anything-else')).toEqual({ baselineDone: false, totalHits: 0 })
  })

  it('roundtrip：setFor 原子落盘 v2 形状，新实例 load 读回相同值', async () => {
    const s = new FileEngineState(path)
    s.setFor('nodeseek', { baselineDone: true })
    s.setFor('nodeseek', { totalHits: 42 })

    expect(s.getFor('nodeseek')).toEqual({ baselineDone: true, totalHits: 42 })
    const raw = JSON.parse(await readFile(path, 'utf-8'))
    expect(raw).toEqual({
      schemaVersion: 2,
      sources: { nodeseek: { baselineDone: true, totalHits: 42 } }
    })

    const s2 = new FileEngineState(path)
    s2.load()
    expect(s2.getFor('nodeseek')).toEqual({ baselineDone: true, totalHits: 42 })
  })

  it('多来源互不干扰：setFor 各自独立、未写过的来源给默认值', async () => {
    const s = new FileEngineState(path)
    s.setFor('nodeseek', { baselineDone: true, totalHits: 7 })
    s.setFor('another', { baselineDone: true, totalHits: 3 })
    expect(s.getFor('nodeseek')).toEqual({ baselineDone: true, totalHits: 7 })
    expect(s.getFor('another')).toEqual({ baselineDone: true, totalHits: 3 })
    expect(s.getFor('third')).toEqual({ baselineDone: false, totalHits: 0 })

    // 落盘 & 重读
    const s2 = new FileEngineState(path)
    s2.load()
    expect(s2.getFor('nodeseek').totalHits).toBe(7)
    expect(s2.getFor('another').totalHits).toBe(3)
    expect(s2.getFor('third')).toEqual({ baselineDone: false, totalHits: 0 })
  })

  it('setFor 是合并语义：未给的字段保留当前值', () => {
    const s = new FileEngineState(path)
    s.setFor('nodeseek', { baselineDone: true, totalHits: 7 })
    s.setFor('nodeseek', { totalHits: 9 })
    expect(s.getFor('nodeseek')).toEqual({ baselineDone: true, totalHits: 9 })
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
    expect(s.getFor('nodeseek')).toEqual({ baselineDone: true, totalHits: 13 })
    // 迁移后 setFor 落盘为 v2
    s.setFor('nodeseek', { totalHits: 14 })
    const raw = JSON.parse(await readFile(path, 'utf-8'))
    expect(raw).toEqual({
      schemaVersion: 2,
      sources: { nodeseek: { baselineDone: true, totalHits: 14 } }
    })
    expect((await readdir(dir)).some((n) => n.includes('.corrupt-'))).toBe(false)
  })

  it('损坏文件（非法 JSON）：备份 .corrupt- 后回默认', async () => {
    await writeFile(path, '{not json', 'utf-8')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const s = new FileEngineState(path)
    expect(() => s.load()).not.toThrow()
    expect(s.getFor('nodeseek')).toEqual({ baselineDone: false, totalHits: 0 })

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
    expect(s.getFor('nodeseek')).toEqual({ baselineDone: false, totalHits: 0 })
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
    expect(s.getFor('nodeseek')).toEqual({ baselineDone: false, totalHits: 3 })
  })
})
