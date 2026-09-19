import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger, DEFAULT_LOG_BUFFER_CAPACITY } from './index'
import type { LogEntry } from '../../shared/types'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rss-monitor-logger-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('环形缓冲', () => {
  it('默认容量 500，超限淘汰最老', () => {
    expect(DEFAULT_LOG_BUFFER_CAPACITY).toBe(500)
    const logger = createLogger()
    for (let i = 1; i <= 501; i++) logger.info(`m${i}`)
    const recent = logger.getRecent()
    expect(recent).toHaveLength(500)
    expect(recent[0].msg).toBe('m2') // m1 被淘汰
    expect(recent[499].msg).toBe('m501')
  })

  it('自定义容量 3：5 条只留最后 3 条，level 与 ts 保留', () => {
    const t0 = 1_700_000_000_000
    const logger = createLogger({ bufferCapacity: 3, now: () => t0 })
    logger.info('a')
    logger.warn('b')
    logger.error('c')
    logger.info('d')
    logger.warn('e')
    expect(logger.getRecent().map((e) => e.msg)).toEqual(['c', 'd', 'e'])
    expect(logger.getRecent().map((e) => e.level)).toEqual(['error', 'info', 'warn'])
    expect(logger.getRecent()[0].ts).toBe(new Date(t0).toISOString())
  })

  it('getRecent 返回拷贝：外部改动不影响内部', () => {
    const logger = createLogger()
    logger.info('x')
    const recent = logger.getRecent()
    recent.push({ ts: 'x', level: 'info', msg: 'y' })
    expect(logger.getRecent()).toHaveLength(1)
  })
})

describe('onLog 订阅', () => {
  it('每条日志回调一次；退订后不再回调', () => {
    const logger = createLogger()
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    const off1 = logger.onLog(cb1)
    logger.onLog(cb2)

    logger.info('hello')
    logger.warn('world')
    expect(cb1).toHaveBeenCalledTimes(2)
    expect(cb2).toHaveBeenCalledTimes(2)
    expect(cb1.mock.calls[0][0]).toMatchObject({ level: 'info', msg: 'hello' })

    off1()
    logger.error('after off')
    expect(cb1).toHaveBeenCalledTimes(2)
    expect(cb2).toHaveBeenCalledTimes(3)
  })

  it('订阅方抛异常不影响记录与其他订阅方', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logger = createLogger()
    const received: LogEntry[] = []
    logger.onLog(() => {
      throw new Error('bad subscriber')
    })
    logger.onLog((e) => received.push(e))

    logger.info('still works')
    expect(received).toHaveLength(1)
    expect(logger.getRecent()).toHaveLength(1)
    expect(errSpy).toHaveBeenCalled()
  })

  it('close 后不再通知订阅方，但缓冲仍可记录', () => {
    const logger = createLogger()
    const cb = vi.fn()
    logger.onLog(cb)
    logger.close()
    logger.info('after close')
    expect(cb).not.toHaveBeenCalled()
    expect(logger.getRecent()).toHaveLength(1)
  })
})

describe('文件输出', () => {
  it('fileDir：按天写 log-YYYY-MM-DD.txt，行带 ISO 时间戳与级别；跨天滚动', async () => {
    // 用本地正午构造时间，规避测试机时区导致的日期串偏移
    const day1 = new Date(2026, 8, 19, 12, 0, 0).getTime()
    const day2 = new Date(2026, 8, 20, 12, 0, 0).getTime()
    let nowMs = day1
    const logger = createLogger({ fileDir: dir, now: () => nowMs })

    logger.info('hello')
    logger.error('boom')
    nowMs = day2
    logger.warn('next day')

    await vi.waitFor(async () => {
      const names = await readdir(dir)
      expect(names).toContain('log-2026-09-19.txt')
      expect(names).toContain('log-2026-09-20.txt')
    })

    const file1 = await readFile(join(dir, 'log-2026-09-19.txt'), 'utf-8')
    expect(file1).toContain(`${new Date(day1).toISOString()} [info] hello`)
    expect(file1).toContain(`[error] boom`)
    expect(file1.endsWith('\n')).toBe(true)

    const file2 = await readFile(join(dir, 'log-2026-09-20.txt'), 'utf-8')
    expect(file2).toContain(`[warn] next day`)
    expect(file2).not.toContain('hello')
  })

  it('不给 fileDir：完全不碰文件系统', async () => {
    const logger = createLogger()
    logger.info('memory only')
    expect(logger.getRecent()).toHaveLength(1)
    // dir 是本轮测试的 tmpdir，本用例没有向其写入任何文件
    expect(await readdir(dir)).toEqual([])
  })

  it('创建时清理 7 天前的旧日志；恰好 7 天与非日志文件保留', async () => {
    await writeFile(join(dir, 'log-2026-09-10.txt'), 'old\n') // 9 天前 → 删
    await writeFile(join(dir, 'log-2026-09-12.txt'), 'edge\n') // 恰 7 天 → 留
    await writeFile(join(dir, 'log-2026-09-19.txt'), 'today\n')
    await writeFile(join(dir, 'other.txt'), 'keep\n')

    createLogger({ fileDir: dir, now: () => new Date(2026, 8, 19, 12, 0, 0).getTime() })

    const names = await readdir(dir)
    expect(names).not.toContain('log-2026-09-10.txt')
    expect(names).toContain('log-2026-09-12.txt')
    expect(names).toContain('log-2026-09-19.txt')
    expect(names).toContain('other.txt')
  })

  it('fileDir 指向普通文件：初始化失败不抛，降级为纯内存', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const notADir = join(dir, 'not-a-dir')
    await writeFile(notADir, 'x')

    const logger = createLogger({ fileDir: notADir })
    logger.info('still buffered')

    expect(logger.getRecent()).toHaveLength(1)
    expect(errSpy).toHaveBeenCalled()
  })
})
