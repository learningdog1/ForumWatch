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
  fetchLatest(): Promise<Topic[]>
}
