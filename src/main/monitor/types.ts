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
  readonly name: string
  fetchLatest(): Promise<Topic[]>
}
