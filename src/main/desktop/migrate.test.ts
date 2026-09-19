/**
 * migrate.ts 单测：tmpdir 模拟新旧 userData 目录，覆盖 D1 迁移的关键分支：
 * 触发条件（旧目录存在 × 新 config.json 不存在）、字节级拷贝、logs/ 不拷、
 * 不覆盖已有目标文件、绝不删旧目录、以及"seen 缺席必须重置 baselineDone"不变式
 * （v1 顶层 / v2 sources 两种 state 形状）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrateUserDataFiles, patchStateForMissingSeen } from './migrate'

let root: string
let legacy: string
let target: string
let logs: string[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fw-migrate-'))
  legacy = join(root, 'legacy')
  target = join(root, 'target')
  mkdirSync(legacy, { recursive: true })
  logs = []
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function put(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content, 'utf-8')
}

function readJson(dir: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, name), 'utf-8')) as Record<string, unknown>
}

function run(): ReturnType<typeof migrateUserDataFiles> {
  return migrateUserDataFiles({
    legacyDir: legacy,
    targetDir: target,
    log: (m) => logs.push(m),
    warn: (m) => logs.push(m)
  })
}

describe('触发条件', () => {
  it('旧目录不存在 → 不迁移，不创建目标目录', () => {
    const result = migrateUserDataFiles({
      legacyDir: join(root, 'nope'),
      targetDir: target,
      log: (m) => logs.push(m),
      warn: (m) => logs.push(m)
    })
    expect(result).toEqual({ ran: false, copied: [], baselineReset: false })
    expect(existsSync(target)).toBe(false)
  })

  it('新目录已有 config.json → 视为已迁移，什么都不拷', () => {
    put(legacy, 'config.json', '{"old":true}')
    put(legacy, 'seen.json', '["1"]')
    put(legacy, 'state.json', '{"schemaVersion":1,"baselineDone":true,"totalHits":3}')
    mkdirSync(target, { recursive: true })
    put(target, 'config.json', '{"new":true}')

    const result = run()
    expect(result.ran).toBe(false)
    expect(existsSync(join(target, 'seen.json'))).toBe(false)
    expect(existsSync(join(target, 'state.json'))).toBe(false)
    expect(readFileSync(join(target, 'config.json'), 'utf-8')).toBe('{"new":true}')
  })
})

describe('完整迁移', () => {
  it('三个文件字节级拷贝、权限 600、logs/ 不拷、旧目录原样保留', () => {
    put(legacy, 'config.json', '{"schemaVersion":1,"config":{"telegram":{"botToken":"secret"}}}')
    put(legacy, 'seen.json', '["101","102"]\n')
    put(legacy, 'state.json', '{"schemaVersion":1,"baselineDone":true,"totalHits":7}')
    mkdirSync(join(legacy, 'logs'), { recursive: true })
    put(legacy, 'logs/log-2026-09-19.txt', 'old log line')

    const result = run()
    expect(result.ran).toBe(true)
    // 顺序（F4）：seen → state → config（config 是「已迁移」标记，最后落位）
    expect(result.copied).toEqual(['seen.json', 'state.json', 'config.json'])
    expect(result.baselineReset).toBe(false)

    for (const name of ['config.json', 'seen.json', 'state.json']) {
      expect(readFileSync(join(target, name), 'utf-8')).toBe(readFileSync(join(legacy, name), 'utf-8'))
      if (process.platform !== 'win32') {
        expect(statSync(join(target, name)).mode & 0o777).toBe(0o600)
      }
      expect(existsSync(join(legacy, name))).toBe(true) // 绝不删旧目录
    }
    expect(existsSync(join(target, 'logs'))).toBe(false) // logs/ 不拷
  })

  it('旧目录缺 state.json / seen.json 时只拷存在的文件', () => {
    put(legacy, 'config.json', '{}')
    const result = run()
    expect(result.copied).toEqual(['config.json'])
    // state.json 也不在（既没拷也没有）：不变式无从触发
    expect(result.baselineReset).toBe(false)
  })

  it('目标已有同名文件 → 跳过不覆盖（迁移幂等）', () => {
    put(legacy, 'config.json', 'legacy-config')
    put(legacy, 'seen.json', 'legacy-seen')
    mkdirSync(target, { recursive: true })
    put(target, 'seen.json', 'target-seen')

    const result = run()
    expect(result.copied).toEqual(['config.json'])
    expect(readFileSync(join(target, 'seen.json'), 'utf-8')).toBe('target-seen')
    expect(readFileSync(join(legacy, 'seen.json'), 'utf-8')).toBe('legacy-seen')
    expect(result.baselineReset).toBe(false) // 目标 seen 在场：无风暴风险
  })
})

describe('不变式：seen 缺席 × state 在场 → 重置 baselineDone', () => {
  it('旧目录本来就没有 seen.json → v1 state 顶层 baselineDone 置 false，totalHits 保留', () => {
    put(legacy, 'config.json', '{}')
    put(legacy, 'state.json', '{"schemaVersion":1,"baselineDone":true,"totalHits":42}')

    const result = run()
    // state 先于 config（F4 顺序）
    expect(result.copied).toEqual(['state.json', 'config.json'])
    expect(result.baselineReset).toBe(true)
    const state = readJson(target, 'state.json')
    expect(state['baselineDone']).toBe(false)
    expect(state['totalHits']).toBe(42)
    expect(state['schemaVersion']).toBe(1)
  })

  it('v2 state（sources Record）→ 每个 source 的 baselineDone 都置 false', () => {
    put(legacy, 'state.json', JSON.stringify({
      schemaVersion: 2,
      sources: {
        nodeseek: { baselineDone: true, totalHits: 5 },
        v2ex: { baselineDone: true, totalHits: 1 }
      }
    }))

    const result = run()
    expect(result.baselineReset).toBe(true)
    const state = readJson(target, 'state.json')
    expect(state['schemaVersion']).toBe(2)
    const sources = state['sources'] as Record<string, { baselineDone: boolean; totalHits: number }>
    expect(sources['nodeseek']).toEqual({ baselineDone: false, totalHits: 5 })
    expect(sources['v2ex']).toEqual({ baselineDone: false, totalHits: 1 })
  })

  it('seen 拷贝失败（旧目录里是目录，读抛 EISDIR）→ 仍走不变式修补并 warn', () => {
    put(legacy, 'config.json', '{}')
    put(legacy, 'state.json', '{"schemaVersion":1,"baselineDone":true,"totalHits":1}')
    mkdirSync(join(legacy, 'seen.json')) // 存在但读不出来：模拟读失败

    const result = run()
    // seen 拷贝失败被跳过：state 与 config 照拷（state 先，F4 顺序）
    expect(result.copied).toEqual(['state.json', 'config.json'])
    expect(result.baselineReset).toBe(true)
    expect(logs.some((m) => m.includes('seen.json'))).toBe(true)
    expect(readJson(target, 'state.json')['baselineDone']).toBe(false)
  })

  it('seen 拷贝成功 → state 原样不动（baselineDone 保持 true）', () => {
    put(legacy, 'config.json', '{}')
    put(legacy, 'seen.json', '["1"]')
    put(legacy, 'state.json', '{"schemaVersion":1,"baselineDone":true,"totalHits":9}')

    const result = run()
    expect(result.copied).toEqual(['seen.json', 'state.json', 'config.json'])
    expect(result.baselineReset).toBe(false)
    expect(readJson(target, 'state.json')['baselineDone']).toBe(true)
  })
})

describe('patchStateForMissingSeen（纯函数）', () => {
  it('非法 JSON / 非对象 / 无 baselineDone 字段 → null', () => {
    expect(patchStateForMissingSeen('not json')).toBeNull()
    expect(patchStateForMissingSeen('"string"')).toBeNull()
    expect(patchStateForMissingSeen('42')).toBeNull()
    expect(patchStateForMissingSeen('{"schemaVersion":1,"totalHits":3}')).toBeNull()
  })

  it('baselineDone 非布尔 → 不动，返回 null', () => {
    expect(patchStateForMissingSeen('{"baselineDone":"yes"}')).toBeNull()
  })

  it('v1：置 false 并保留其余字段', () => {
    const out = patchStateForMissingSeen('{"schemaVersion":1,"baselineDone":true,"totalHits":3}')
    expect(out).not.toBeNull()
    expect(JSON.parse(out as string)).toEqual({ schemaVersion: 1, baselineDone: false, totalHits: 3 })
  })

  it('sources 为数组形态也兼容', () => {
    const out = patchStateForMissingSeen(
      '{"schemaVersion":2,"sources":[{"id":"a","baselineDone":true,"totalHits":2}]}'
    )
    expect(out).not.toBeNull()
    expect(JSON.parse(out as string)).toEqual({
      schemaVersion: 2,
      sources: [{ id: 'a', baselineDone: false, totalHits: 2 }]
    })
  })
})
