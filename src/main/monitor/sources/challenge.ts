/**
 * 共享的 Cloudflare 挑战检测（ADR 5 防护条款，从 html adapter 抽出）。
 *
 * 挑战双信号：HTTP 403 **或** 响应头 `cf-mitigated: challenge`，二选一命中即抛
 * ChallengeError——engine 据此进 challenged 健康态，而非普通指数退避。
 * 纯函数、零 IO；HTML / RSS / 未来 API adapter 统一复用，保持单一检测口径。
 */

import { ChallengeError } from '../types'

/**
 * 读单个响应头。两种入参形态都支持、键名大小写不敏感：
 * - `Record<string, string>`：本项目 HttpResponse 的约定形态（键统一小写，防御性再降一次）
 * - 标准 `Headers`（fetch 原生响应头，`get` 本身大小写不敏感）
 * 未命中返回 ''。
 */
function readHeader(headers: Record<string, string> | Headers, name: string): string {
  if (headers instanceof Headers) return headers.get(name) ?? ''
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value
  }
  return ''
}

/**
 * 挑战判定（纯谓词，非断言）：HTTP 403 **或** `cf-mitigated` 头值含 `challenge`
 * （大小写不敏感子串匹配）即视为被 Cloudflare 挑战。
 *
 * 供「只想知道是不是挑战、不想要抛错语义」的调用方使用——net 层的 FlareSolverr
 * 破盾装饰器（src/main/net/cf-solver.ts）据此在响应**返回调用方之前**拦截挑战，
 * 与本断言保持同一检测口径（单一事实源）。
 */
export function isChallengeResponse(
  status: number,
  headers: Record<string, string> | Headers
): boolean {
  const mitigated = readHeader(headers, 'cf-mitigated')
  return status === 403 || mitigated.toLowerCase().includes('challenge')
}

/**
 * 挑战断言（非 403 且无 challenge 头时安静返回）：
 * - HTTP 403
 * - `cf-mitigated` 头值含 `challenge`（大小写不敏感的子串匹配，与既有 html 行为一致）
 */
export function assertNotChallenged(
  status: number,
  headers: Record<string, string> | Headers
): void {
  if (isChallengeResponse(status, headers)) {
    const mitigated = readHeader(headers, 'cf-mitigated')
    throw new ChallengeError(
      `cloudflare challenge: status=${status} cf-mitigated=${mitigated || '(none)'}`
    )
  }
}
