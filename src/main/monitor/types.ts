/**
 * 监控数据源抽象。engine 只面向 SourceAdapter，不感知 HTML/RSS/API 细节
 * （ADR 5：`SourceAdapter` 保留 RSS/API + cookie 备选实现的位置）。
 */

import type { Topic } from '../../shared/types'

/**
 * Cloudflare 挑战信号（HTTP 403 或响应头 `cf-mitigated: challenge`）。
 * 区别于普通失败：命中后 engine 进 challenged 健康态，而非普通指数退避。
 */
export class ChallengeError extends Error {
  constructor(message = 'blocked by Cloudflare challenge') {
    super(message)
    this.name = 'ChallengeError'
  }
}

/** 数据源适配器：一次抓取返回首页最新帖子列表 */
export interface SourceAdapter {
  /**
   * 稳定 slug（如 'nodeseek'）：seen 去重键前缀、state 键、EngineStatus.sources 的
   * sourceId 都以它为准（D3）。必须与 config.sources[].id 对上，装配方按 id 找 adapter。
   */
  readonly id: string
  /** 展示名（如 'NodeSeek'），给日志与 UI */
  readonly name: string
  /**
   * 能力声明（W3 "新帖 vs 回复顶起旧帖"过滤）：该来源的 topic id 是否随创建时间
   * 单调递增。声明 true 时 engine 维护 per-source 的 maxSeenTopicId 阈值
   * （FileEngineState），把 "unseen 且数值 id ≤ 阈值" 的帖子当"被回复顶回首页的
   * 旧帖"跳过（入 seen 不推送）——NodeSeek 首页按**最后回复时间**排序，靠它区分
   * 新帖与顶帖。未声明（undefined）的来源完全不走该过滤（未来 RSS 源的 guid
   * 非数值/非单调，不受影响）。
   */
  readonly creationOrderedIds?: boolean
  /**
   * 能力声明（R8-A 任务二，E3 Cloudflare B 计划）：本 adapter 实例带有**浏览器
   * 网络栈降级 fetch**——主 fetch 被 Cloudflare 挑战（403 / cf-mitigated:
   * challenge）时，adapter 内部用注入的 fallback fetch（Electron net.fetch，
   * Chromium 网络栈/系统代理，TLS 指纹与 undici 不同）重发同一请求。降级完全在
   * adapter 内部完成（成功对 engine 透明；双挑战仍抛 ChallengeError，状态照旧
   * challenged），**engine 不消费本声明**——它仅用于观测/文档：哪些来源实例具备
   * B 计划能力由装配方决定（desktop 传 fallbackFetchFn，headless 暂不传）。
   */
  readonly browserStackFallback?: true
  /**
   * 抓取最新帖子列表（第五轮起，DEC-8：可选 `opts.pages` 请求补抓后续页）。
   * - opts 缺省 / pages 缺省 = 仅第 1 页（既有行为不变）。
   * - 第 2 页起的补抓语义由 R5-P2a 在各 adapter 实现，本轮只定契约：现有零参
   *   实现不改签名也满足本接口（参数更少的方法可赋给参数更多的签名）。
   */
  fetchLatest(opts?: { pages?: number }): Promise<Topic[]>
}
