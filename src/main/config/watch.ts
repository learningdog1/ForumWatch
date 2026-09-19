/**
 * 配置目录监听（R8-C headless 配置热重载内核）。
 *
 * - **监听目录而非文件**：macOS 上原子写（ConfigStore 的 tmp + rename）会换
 *   inode，`fs.watch` 盯文件会在 rename 后丢事件；盯目录则子项的
 *   rename/change 都以目录事件冒泡，换 inode 无感。
 * - **500ms 去抖**：一次保存（tmp 创建 + rename + 旧 tmp 清理）会触发一小阵
 *   事件风暴，去抖把它们合并为恰好一次回调。
 * - **`fs.watch` 出错不抛**（目录不存在等）：记 noop 返回——headless 首启时
 *   目录可能还没建（首启流程随后 mkdir + 写默认配置），监听失败只意味着
 *   本次运行没有热重载，不该让进程起不来。
 * - `close()` 幂等：取消在途去抖计时器 + 关底层 watcher，重复调用无副作用。
 *
 * 零 electron 依赖；fs 与定时器可注入（测试/装配用）。注意本函数只负责
 * "目录里有事发生"这一信号，不区分文件——config 目录里 seen.json/state.json
 * 每轮都会写，调用方（headless 装配方）需要自行 diff 配置内容后决定是否
 * 真正重载。
 */
import { watch } from 'node:fs'

/** 默认去抖窗口：事件风暴（tmp+rename+unlink 连发）合并为一次回调 */
export const DEFAULT_WATCH_DEBOUNCE_MS = 500

/** 底层 watcher 的最小结构面（fs.FSWatcher 的结构子集；测试可注入假件） */
export interface DirWatcherHandle {
  close(): void
}

/** 可注入的目录监听函数（默认 node:fs 的 watch） */
export type WatchDirFn = (
  dir: string,
  listener: (event: string, filename: string | Buffer | null) => void
) => DirWatcherHandle

export interface WatchConfigDirOptions {
  /** 去抖窗口毫秒，默认 500 */
  debounceMs?: number
  /** 目录监听函数注入（默认 fs.watch；测试可换假件） */
  fsWatch?: WatchDirFn
  /** 定时器注入（默认 setTimeout） */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown
  /** 清定时器注入（默认 clearTimeout） */
  clear?: (handle: unknown) => void
}

export interface ConfigDirWatcher {
  /** 停止监听并清理在途去抖计时器；幂等 */
  close(): void
}

/**
 * 监听目录变化（去抖后回调 onChange）。
 *
 * - 监听构造期出错（目录不存在 / 权限不足等）：不抛，返回已 noop 的 watcher
 *   （close 幂等）——调用方无需 try/catch。
 * - 回调语义：事件静默 ≥ debounceMs 后恰好触发一次；窗口内新事件重置计时器。
 * - close 后不再触发回调（在途去抖计时器一并取消）。
 */
export function watchConfigDir(
  dir: string,
  onChange: () => void,
  opts: WatchConfigDirOptions = {}
): ConfigDirWatcher {
  const debounceMs = opts.debounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS
  const fsWatch: WatchDirFn = opts.fsWatch ?? defaultWatch
  const setTimeoutFn = opts.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clear = opts.clear ?? ((handle: unknown) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]))

  let closed = false
  let debounceHandle: unknown = null
  let inner: DirWatcherHandle | null = null

  const cancelDebounce = (): void => {
    if (debounceHandle !== null) {
      clear(debounceHandle)
      debounceHandle = null
    }
  }

  try {
    inner = fsWatch(dir, () => {
      if (closed) return
      cancelDebounce()
      debounceHandle = setTimeoutFn(() => {
        debounceHandle = null
        if (!closed) onChange()
      }, debounceMs)
    })
  } catch {
    // 目录不存在等：noop（headless 首启目录可能还没建）。close 仍可安全调用。
    return { close: () => {} }
  }

  // watcher 运行期错误（目录被删等）：吞掉防 uncaught exception——
  // 热重载是尽力而为的增强能力，不应拖垮常驻进程。
  try {
    ;(inner as { on?: (event: 'error', cb: (err: Error) => void) => unknown }).on?.(
      'error',
      () => {}
    )
  } catch {
    // 假件没有 on：忽略
  }

  return {
    close(): void {
      if (closed) return
      closed = true
      cancelDebounce()
      try {
        inner?.close()
      } catch {
        // 底层已关/失效：幂等语义
      }
      inner = null
    }
  }
}

/** 默认监听实现：node:fs 的 watch（包一层以满足 WatchDirFn 的结构签名） */
const defaultWatch: WatchDirFn = (dir, listener) => watch(dir, listener)
