/**
 * 轻量更新检查（R8-B / E1）：GitHub Releases latest 轮询。
 *
 * - **零 electron 依赖**（对齐 ADR 2：可移植内核风格；装配在 desktop/ipc.ts，
 *   fetch/时钟/日志全部构造注入，node 下单测直跑）。放 desktop/ 下是因为它只被
 *   桌面装配层消费（headless 无更新检查需求），不代表它可以 import electron。
 * - 数据面：GET `https://api.github.com/repos/${repo}/releases/latest`，
 *   **必须带 User-Agent 头**（GitHub API 强制要求，无 UA 一律 403）。
 *   发布产物由 .github/workflows/release.yml 产出（tag v* → gh-release），
 *   所以 latest release 的 tag 即版本号（v 前缀 + 点分数字）。
 * - 版本比较：自实现 compareSemver（v/V 前缀容忍、点分数字、缺段补 0）——
 *   项目无 semver 依赖，引入整个包为了一次三段比较不值。
 * - 失败语义：网络失败 / 非 2xx / JSON 坏 / 载荷形状不对 → **静默 null**，
 *   只 log warn（更新检查绝不该打扰用户，更不该炸）；「已最新」同样返回 null。
 *   三态的区分记在 lastOutcome（IPC getUpdateStatus / checkUpdate 据此如实展示）。
 * - start()：启动延迟 15s + 每 24h 轮询，setTimeout 自循环（对齐 runtime.ts 日报
 *   定时器 / poller 的重排模式）；stop() 清计时器并使在途轮次不再重排。
 */
import type { FetchLike } from '../net/http-types'

/**
 * 更新检查的仓库坐标（'owner/name'）。
 *
 * 本仓库当前未配置 git remote（实测 `git remote -v` 为空），这里按仓库自身证据
 * 推导：package.json author / electron-builder appId（com.colmidad.forumwatch）
 * / name（forumwatch）→ colmidad/forumwatch；.github/workflows/release.yml 证明
 * 发布走 GitHub Releases（tag v*）。若实际 remote 与此不符，改这一个常量即可。
 */
export const UPDATE_REPO = 'colmidad/forumwatch'

/** 更新检查 API 端点（repo 注入；导出常量供测试断言 URL 拼接） */
export const GITHUB_LATEST_RELEASE_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`

/** start() 启动延迟：15s（避开启动期网络争用；应用起来再查） */
export const UPDATE_INITIAL_DELAY_MS = 15_000
/** start() 轮询间隔：24h */
export const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000
/**
 * 单次检查的整体超时（ms），以 init.timeoutMs 交给注入的 fetchFn（ipc.ts 的
 * directFetch 会转成 AbortSignal.timeout）：不带超时的裸 fetch 挂到 TCP 超时
 * 为止（分钟级），15s 未响应按失败静默收敛（下次轮询再试）。
 */
export const UPDATE_CHECK_TIMEOUT_MS = 15_000

/** 有新版时的检查结果（latest > current 才产生） */
export interface UpdateCheckResult {
  current: string
  /** 最新 release 的 tag（原样，通常带 v 前缀） */
  latest: string
  /** 发布页地址（html_url；UI 的「打开下载页」经 openExternal 打开） */
  downloadUrl: string
}

/**
 * 一次检查的完整结局（三态 + 时间戳；check() 每次都会刷新，手动/定时共用）。
 * IPC 的 UpdateCheckStatus 由装配方从这里翻译。
 */
export type UpdateOutcome =
  | { kind: 'available'; checkedAt: number; current: string; latest: string; downloadUrl: string }
  | { kind: 'up-to-date'; checkedAt: number; current: string; latest: string }
  | { kind: 'error'; checkedAt: number; current: string; error: string }

/**
 * 语义化版本比较（自实现，非严格 semver）：
 * - 容忍 `v` / `V` 前缀（GitHub release tag 惯例）；
 * - 点分数字，最多比三段，**缺段补 0**（`1.2` ≡ `1.2.0` ≡ `1.2.0.0`，第四段起忽略）；
 * - 空串 / 非数字段按 0 处理（比较工具不因垃圾 tag 抛错）；
 * - 返回 <0（a<b）/ 0（相等）/ >0（a>b），与 Array.sort comparator 同约定。
 */
export function compareSemver(a: string, b: string): number {
  const pa = semverParts(a)
  const pb = semverParts(b)
  for (let i = 0; i < 3; i++) {
    const d = pa[i] - pb[i]
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

/** tag → 三段数字（v 前缀剥掉、split('.')、Number() 非有限数按 0、缺段补 0） */
function semverParts(v: string): [number, number, number] {
  const segs = v.trim().replace(/^[vV]/, '').split('.')
  const out: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    const n = Number(segs[i])
    out[i] = Number.isFinite(n) ? Math.floor(n) : 0
  }
  return out
}

/**
 * GitHub latest release 载荷 → { tag, url }：`tag_name` / `html_url` 都须为非空
 * 字符串，其余任何形状（null / 非对象 / 缺字段 / 字段类型不对）返回 null。
 */
export function parseLatestRelease(json: unknown): { tag: string; url: string } | null {
  if (typeof json !== 'object' || json === null) return null
  const o = json as { tag_name?: unknown; html_url?: unknown }
  if (typeof o.tag_name !== 'string' || o.tag_name === '') return null
  if (typeof o.html_url !== 'string' || o.html_url === '') return null
  return { tag: o.tag_name, url: o.html_url }
}

export interface UpdateCheckerDeps {
  /** 当前应用版本（桌面装配传 app.getVersion()） */
  currentVersion: string
  /** 'owner/name' 仓库坐标（默认 UPDATE_REPO；注入便于测试） */
  repo: string
  /** 注入的 fetch（FetchLike，同 http-types；测试换假实现） */
  fetchFn: FetchLike
  /** 注入时钟（epoch ms），默认 Date.now */
  now?: () => number
  /** 注入日志（只用 warn：失败静默但可观测） */
  log?: { warn(msg: string): void }
  /** 覆盖调度延迟（默认 15s / 24h；测试用） */
  delays?: { initialMs?: number; intervalMs?: number }
}

export class UpdateChecker {
  private readonly current: string
  private readonly repo: string
  private readonly fetchFn: FetchLike
  private readonly now: () => number
  private readonly log: { warn(msg: string): void }
  private readonly initialMs: number
  private readonly intervalMs: number
  /** 最近一次检查的结局；null = 从未检查过 */
  private last: UpdateOutcome | null = null
  /** 待定计时器（null = 未在轮询） */
  private timer: ReturnType<typeof setTimeout> | null = null
  /** 轮询代数：stop()/重新 start() 自增，使在途轮次的闭包失效不再重排 */
  private loopId = 0

  constructor(deps: UpdateCheckerDeps) {
    this.current = deps.currentVersion
    this.repo = deps.repo
    this.fetchFn = deps.fetchFn
    this.now = deps.now ?? (() => Date.now())
    this.log = deps.log ?? { warn: (msg) => console.warn(msg) }
    this.initialMs = deps.delays?.initialMs ?? UPDATE_INITIAL_DELAY_MS
    this.intervalMs = deps.delays?.intervalMs ?? UPDATE_INTERVAL_MS
  }

  /**
   * 单次检查：GET latest release（带 UA 头）。latest > current → 结果对象；
   * 已最新 / 一切失败 → null（失败 log warn，绝不抛）。无论哪种结局都刷新
   * lastOutcome（手动检查与定时轮询共用这一条写路径）。
   */
  async check(): Promise<UpdateCheckResult | null> {
    try {
      const res = await this.fetchFn(`https://api.github.com/repos/${this.repo}/releases/latest`, {
        headers: {
          // GitHub API 强制 UA；标识应用与版本，便于排查
          'User-Agent': `ForumWatch-UpdateCheck/${this.current}`
        },
        // 检查整体超时（防裸 fetch 挂到 TCP 超时；适配层转 AbortSignal.timeout）
        timeoutMs: UPDATE_CHECK_TIMEOUT_MS
      })
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`HTTP ${String(res.status)}`)
      }
      let json: unknown
      try {
        json = JSON.parse(res.body)
      } catch {
        throw new Error('latest release 响应不是合法 JSON')
      }
      const parsed = parseLatestRelease(json)
      if (parsed === null) {
        throw new Error('latest release 载荷缺少 tag_name / html_url')
      }
      if (compareSemver(parsed.tag, this.current) <= 0) {
        this.last = {
          kind: 'up-to-date',
          checkedAt: this.now(),
          current: this.current,
          latest: parsed.tag
        }
        return null
      }
      const result: UpdateCheckResult = {
        current: this.current,
        latest: parsed.tag,
        downloadUrl: parsed.url
      }
      this.last = {
        kind: 'available',
        checkedAt: this.now(),
        current: result.current,
        latest: result.latest,
        downloadUrl: result.downloadUrl
      }
      return result
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      this.last = { kind: 'error', checkedAt: this.now(), current: this.current, error }
      this.log.warn(`update check failed: ${error}`)
      return null
    }
  }

  /**
   * 启动定时轮询：initialMs 后首轮，此后每轮 check 完成再排 intervalMs
   * （setTimeout 自循环，对齐项目内 poller / 日报定时器模式）。幂等（已启动
   * no-op）。每轮结束把最新 outcome 回调给 onResult（listener 抛异常不扩散）。
   */
  start(onResult?: (outcome: UpdateOutcome) => void): void {
    if (this.timer !== null) return
    const myLoop = ++this.loopId
    const run = async (): Promise<void> => {
      await this.check()
      if (onResult !== undefined && this.last !== null) {
        try {
          onResult(this.last)
        } catch {
          /* listener 异常不打断轮询 */
        }
      }
      if (myLoop !== this.loopId) return // stop() 已发生（或被新一轮 start 取代）
      this.timer = setTimeout(() => void run(), this.intervalMs)
    }
    this.timer = setTimeout(() => void run(), this.initialMs)
  }

  /** 停止轮询：清待定计时器 + 使在途轮次完成後不再重排。幂等。 */
  stop(): void {
    this.loopId++
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** 是否正在轮询（测试用） */
  isRunning(): boolean {
    return this.timer !== null
  }

  /** 最近一次检查的结局（null = 从未检查）；返回的是内部引用，调用方勿改 */
  lastOutcome(): UpdateOutcome | null {
    return this.last
  }
}
