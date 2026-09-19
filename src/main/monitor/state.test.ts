import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ENGINE_STATE, FileEngineState } from './state'

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
  it('文件缺失：load 返回默认值，且不产生任何备份文件', async () => {
    const s = new FileEngineState(path)
    expect(s.load()).toEqual({ schemaVersion: 1, baselineDone: false, totalHits: 0 })
    expect(await readdir(dir)).toEqual([])
  })

  it('未 load 直接 get：等价于先 load 默认值', () => {
    const s = new FileEngineState(path)
    expect(s.get()).toEqual(DEFAULT_ENGINE_STATE)
  })

  it('roundtrip：set 原子落盘，新实例 load 读回相同值', async () => {
    const s = new FileEngineState(path)
    s.set({ baselineDone: true })
    s.set({ totalHits: 42 })

    expect(s.get()).toEqual({ schemaVersion: 1, baselineDone: true, totalHits: 42 })
    const raw = JSON.parse(await readFile(path, 'utf-8'))
    expect(raw).toEqual({ schemaVersion: 1, baselineDone: true, totalHits: 42 })

    const s2 = new FileEngineState(path)
    expect(s2.load()).toEqual({ schemaVersion: 1, baselineDone: true, totalHits: 42 })
  })

  it('set 是合并语义：未给的字段保留当前值', () => {
    const s = new FileEngineState(path)
    s.set({ baselineDone: true, totalHits: 7 })
    s.set({ totalHits: 9 })
    expect(s.get().baselineDone).toBe(true)
    expect(s.get().totalHits).toBe(9)
  })

  it('totalHits 非法值（NaN/负数/Infinity）回退当前值', () => {
    const s = new FileEngineState(path)
    s.set({ totalHits: 5 })
    s.set({ totalHits: Number.NaN })
    expect(s.get().totalHits).toBe(5)
    s.set({ totalHits: -3 })
    expect(s.get().totalHits).toBe(5)
    s.set({ totalHits: Number.POSITIVE_INFINITY })
    expect(s.get().totalHits).toBe(5)
  })

  it('损坏文件（非法 JSON）：备份 .corrupt- 后回默认', async () => {
    await writeFile(path, '{not json', 'utf-8')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const s = new FileEngineState(path)
    expect(s.load()).toEqual({ schemaVersion: 1, baselineDone: false, totalHits: 0 })

    const names = await readdir(dir)
    const backup = names.find((n) => n.startsWith('state.json.corrupt-'))
    expect(backup).toBeDefined()
    expect(await readFile(join(dir, backup as string), 'utf-8')).toBe('{not json')
    expect(errSpy).toHaveBeenCalled()
  })

  it('损坏文件（形状不对 / 版本不认识）：同样备份回默认', async () => {
    await writeFile(path, JSON.stringify({ schemaVersion: 2, baselineDone: true }), 'utf-8')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const s = new FileEngineState(path)
    expect(s.load().baselineDone).toBe(false)

    const names = await readdir(dir)
    expect(names.some((n) => n.includes('.corrupt-'))).toBe(true)
    expect(errSpy).toHaveBeenCalled()
  })

  it('原子写：多次 set 后目录里只有 state.json，无 tmp 残留', async () => {
    const s = new FileEngineState(path)
    for (let i = 1; i <= 5; i++) s.set({ totalHits: i })
    expect(await readdir(dir)).toEqual(['state.json'])
  })

  it('get 返回拷贝：外部改动不污染内部', () => {
    const s = new FileEngineState(path)
    s.set({ totalHits: 3 })
    const v = s.get()
    v.totalHits = 100
    v.baselineDone = true
    expect(s.get()).toEqual({ schemaVersion: 1, baselineDone: false, totalHits: 3 })
  })
})
