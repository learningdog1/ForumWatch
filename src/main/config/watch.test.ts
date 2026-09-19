import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchConfigDir, type WatchDirFn } from './watch'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rss-monitor-watch-'))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 等到条件成立（轮询；真实 fs.watch 事件经 libuv 异步到达） */
async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met before timeout')
    await sleep(25)
  }
}

describe('watchConfigDir（真实 tmp 目录）', () => {
  it('写文件触发回调：去抖后恰好一次', async () => {
    const calls: number[] = []
    const w = watchConfigDir(dir, () => calls.push(Date.now()), { debounceMs: 80 })
    await sleep(50) // watcher 就绪（事件订阅在 libuv 侧生效）

    await writeFile(join(dir, 'config.json'), '{"a":1}', 'utf-8')
    await until(() => calls.length === 1)
    // 去抖窗口过后不再有新回调（恰好一次，不是每个事件一次）
    await sleep(300)
    expect(calls.length).toBe(1)
    w.close()
  })

  it('事件风暴合并：同一去抖窗口内连写多次仍只一次回调', async () => {
    let calls = 0
    const w = watchConfigDir(
      dir,
      () => {
        calls++
      },
      { debounceMs: 120 }
    )
    await sleep(50)

    // 模拟 ConfigStore 原子写 + 同轮 seen/state 写入的事件风暴
    await writeFile(join(dir, 'config.json.tmp-1'), 'x', 'utf-8')
    await sleep(30)
    await writeFile(join(dir, 'config.json.tmp-2'), 'x', 'utf-8')
    await sleep(30)
    await writeFile(join(dir, 'seen.json'), 'y', 'utf-8')
    await until(() => calls === 1)
    await sleep(400)
    expect(calls).toBe(1) // 三次事件合并为一次回调
    w.close()
  })

  it('rename 替换文件触发回调（macOS 换 inode 的原子写路径）', async () => {
    let calls = 0
    const target = join(dir, 'config.json')
    await writeFile(target, '{"schemaVersion":3}', 'utf-8')
    const w = watchConfigDir(dir, () => {
      calls++
    })
    await sleep(50)

    // 原子替换：写 tmp 后 rename 覆盖目标（watch 目录才能看到 rename；watch 文件会丢）
    const tmp = join(dir, 'config.json.tmp')
    await writeFile(tmp, '{"schemaVersion":3,"config":{}}', 'utf-8')
    await rename(tmp, target)
    await until(() => calls === 1)
    await sleep(300)
    expect(calls).toBe(1)
    w.close()
  })

  it('close 后不再触发，且幂等', async () => {
    let calls = 0
    const w = watchConfigDir(
      dir,
      () => {
        calls++
      },
      { debounceMs: 60 }
    )
    await sleep(50)

    w.close()
    w.close() // 幂等

    await writeFile(join(dir, 'config.json'), '{}', 'utf-8')
    await sleep(400)
    expect(calls).toBe(0)
  })

  it('close 取消在途去抖计时器（事件已到但未满窗口）', async () => {
    let calls = 0
    const w = watchConfigDir(
      dir,
      () => {
        calls++
      },
      { debounceMs: 200 }
    )
    await sleep(50)

    await writeFile(join(dir, 'config.json'), '{}', 'utf-8')
    await sleep(50) // < debounceMs：事件应已到、计时器在跑
    w.close()
    await sleep(400)
    expect(calls).toBe(0)
  })

  it('目录不存在：构造不抛，close 不抛', () => {
    const missing = join(dir, 'no-such-subdir')
    const w = watchConfigDir(missing, () => {}) // 构造抛错即测试失败
    expect(() => w.close()).not.toThrow()
  })

  it('目录后建：构造期 noop 不会因 late mkdir 复活（热重载下次启动再生效）', async () => {
    const missing = join(dir, 'late-subdir')
    let calls = 0
    const w = watchConfigDir(missing, () => {
      calls++
    })
    await mkdir(missing)
    await writeFile(join(missing, 'config.json'), '{}', 'utf-8')
    await sleep(400)
    expect(calls).toBe(0) // noop watcher 不监听，符合"构造失败记 noop"规格
    w.close()
  })
})

describe('watchConfigDir（注入 fs 与定时器：去抖窗口确定性验证）', () => {
  /** 注入假 fsWatch：捕获 listener 供手动派发事件 */
  function fakeWatch(): { fn: WatchDirFn; emit: () => void; handles: Array<{ close(): void }> } {
    let listener: ((event: string, filename: string | null) => void) | null = null
    const handles: Array<{ close(): void }> = []
    return {
      fn: (_dir, l) => {
        listener = l
        const h = { close: () => {} }
        handles.push(h)
        return h
      },
      emit: () => listener?.('change', 'config.json'),
      handles
    }
  }

  it('窗口内第二次事件重置计时器：延后触发且只触发一次', () => {
    vi.useFakeTimers()
    const fw = fakeWatch()
    let calls = 0
    const w = watchConfigDir(
      '/any/dir',
      () => {
        calls++
      },
      { debounceMs: 500, fsWatch: fw.fn }
    )
    expect(fw.handles.length).toBe(1)

    fw.emit()
    vi.advanceTimersByTime(400) // 未满窗口
    expect(calls).toBe(0)
    fw.emit() // 重置计时器
    vi.advanceTimersByTime(400) // 距上次事件 400ms：仍未满重置后的 500ms
    expect(calls).toBe(0)
    vi.advanceTimersByTime(100) // 满 500ms
    expect(calls).toBe(1)
    vi.advanceTimersByTime(5000)
    expect(calls).toBe(1) // 恰好一次
    w.close()
  })

  it('回调触发后新事件开启新一轮去抖', () => {
    vi.useFakeTimers()
    const fw = fakeWatch()
    let calls = 0
    const w = watchConfigDir(
      '/any/dir',
      () => {
        calls++
      },
      { debounceMs: 500, fsWatch: fw.fn }
    )

    fw.emit()
    vi.advanceTimersByTime(500)
    expect(calls).toBe(1)
    fw.emit()
    vi.advanceTimersByTime(500)
    expect(calls).toBe(2)
    w.close()
  })

  it('注入的 fsWatch 抛错：构造不抛（noop watcher），close 幂等', () => {
    const throwing: WatchDirFn = () => {
      throw new Error('ENOENT')
    }
    const w = watchConfigDir('/missing', () => {}, { fsWatch: throwing }) // 抛错即测试失败
    expect(() => w.close()).not.toThrow()
  })
})
