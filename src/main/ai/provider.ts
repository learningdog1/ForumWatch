/**
 * LLM Provider 客户端（docs/decisions.md D6）：OpenAI 兼容 /chat/completions，
 * 支撑语义监控评估（W2）与 AI 日报。
 *
 * - 网络 post 由外部注入（FetchLike，生产传 HttpClient 的 aiClient 封装），本模块
 *   零直接网络依赖，单测全 mock。
 * - 配置每次调用重读（getConfig，支持热更新）；Provider 三项（baseUrl/apiKey/model）
 *   任一为空 → AiProviderError('AI provider not configured', 'unconfigured')，不发请求
 *   （调用方据此把语义档降级为字面档）。
 * - baseUrl sanitize：trim + 去全部尾斜杠，请求时拼 /chat/completions。
 * - 密钥安全（D6）：Authorization 头只进请求、绝不进任何错误消息；错误详情引用
 *   响应体/异常文本时先做明文替换（scrubSecret）再截断摘录（先抹后截，截断边界
 *   也不残留完整密钥）；需要展示配置时用 redactSecret。
 * - 超时：req.timeoutMs ?? 30000 写入 init.timeoutMs 传给 post（HttpClient 会转成
 *   AbortSignal.timeout）；AbortError/TimeoutError（name 或 message 含 timeout/abort）
 *   归类 timeout，其余 fetch 异常归类 network。
 */

import type { FetchLike, HttpRequestInit, HttpResponse } from '../net/http-types'
import type { AiProviderConfig } from '@shared/types'

/** AI 错误分类：调用方按 kind 决定降级（unconfigured）或重试/退避策略 */
export type AiProviderErrorKind =
  | 'unconfigured'
  | 'network'
  | 'timeout'
  | 'auth'
  | 'rate-limit'
  | 'http'
  | 'bad-json'

export class AiProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: AiProviderErrorKind
  ) {
    super(message)
    this.name = 'AiProviderError'
  }
}

/** 密钥脱敏（D6）：≤8 字符全 ***，否则前3+***+后2。apiKey/敏感 token 通用。 */
export function redactSecret(s: string): string {
  return s.length <= 8 ? '***' : `${s.slice(0, 3)}***${s.slice(-2)}`
}

export interface ChatRequest {
  /** system 提示（角色/输出契约） */
  system: string
  /** user 消息（待评估内容 / 日报素材） */
  user: string
  /** true 时带 response_format:{type:'json_object'}（要求模型输出合法 JSON） */
  jsonMode?: boolean
  /** 请求整体超时毫秒；默认 30000 */
  timeoutMs?: number
  /** 可选 max_tokens 上限 */
  maxTokens?: number
}

export interface AiProviderDeps {
  /** 注入的 HTTP POST（生产传 HttpClient 的 aiClient 封装） */
  post: FetchLike
  /** 每次调用重读当前 Provider 配置（热更新） */
  getConfig: () => AiProviderConfig
}

const DEFAULT_TIMEOUT_MS = 30000
const BODY_EXCERPT_LEN = 200

/**
 * 把文本中出现的密钥明文整体替换为 ***（密钥为空串时原样返回；本模块保证密钥非空）。
 * 导出供其他模块复用同款口径（如 telegram.ts 对 botToken 的错误详情脱敏——
 * token 在 URL 路径里，fetch 异常消息可能回显完整 URL）。
 */
export function scrubSecret(text: string, secret: string): string {
  return secret === '' ? text : text.split(secret).join('***')
}

/** 错误消息里的响应体摘录：先抹掉可能回显的密钥明文，再截前 200 字符 */
function excerptBody(body: string, apiKey: string): string {
  return scrubSecret(body, apiKey).slice(0, BODY_EXCERPT_LEN)
}

/** fetch 异常归类：AbortError/TimeoutError（name 或 message 含 timeout/abort）为超时 */
function isAbortLike(err: unknown): boolean {
  const name = err instanceof Error ? err.name : ''
  const message = err instanceof Error ? err.message : String(err)
  const hay = `${name} ${message}`.toLowerCase()
  return hay.includes('timeout') || hay.includes('abort')
}

/** 429 响应体里解析 parameters.retry_after（秒）；无/非法返回 undefined */
function parseRetryAfterSec(body: string): number | undefined {
  try {
    const data = JSON.parse(body) as { parameters?: { retry_after?: unknown } }
    const v = data?.parameters?.retry_after
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
    return undefined
  } catch {
    return undefined
  }
}

/** 防御式取 choices[0].message.content；任何一环缺失/非字符串返回 undefined */
function extractContent(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const choices = (data as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const choice = choices[0]
  if (choice === null || typeof choice !== 'object') return undefined
  const message = (choice as { message?: unknown }).message
  if (message === null || typeof message !== 'object') return undefined
  const content = (message as { content?: unknown }).content
  return typeof content === 'string' ? content : undefined
}

export class AiProvider {
  private readonly post: FetchLike
  private readonly getConfig: () => AiProviderConfig

  constructor(deps: AiProviderDeps) {
    this.post = deps.post
    this.getConfig = deps.getConfig
  }

  /** 单轮对话：返回 assistant 消息文本（choices[0].message.content） */
  async chat(req: ChatRequest): Promise<string> {
    const cfg = this.getConfig()
    const baseUrl = cfg.baseUrl.trim().replace(/\/+$/, '')
    const apiKey = cfg.apiKey.trim()
    const model = cfg.model.trim()
    if (baseUrl === '' || apiKey === '' || model === '') {
      throw new AiProviderError('AI provider not configured', 'unconfigured')
    }

    const payload: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user }
      ],
      temperature: 0,
      stream: false
    }
    if (req.jsonMode === true) payload.response_format = { type: 'json_object' }
    if (req.maxTokens !== undefined) payload.max_tokens = req.maxTokens

    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const init: HttpRequestInit = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      timeoutMs
    }

    let res: HttpResponse
    try {
      res = await this.post(`${baseUrl}/chat/completions`, init)
    } catch (err) {
      if (isAbortLike(err)) {
        throw new AiProviderError(`AI provider request timed out after ${timeoutMs}ms`, 'timeout')
      }
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      throw new AiProviderError(`AI provider network error: ${scrubSecret(detail, apiKey)}`, 'network')
    }

    if (res.status === 401 || res.status === 403) {
      throw new AiProviderError(
        `AI provider auth failed (HTTP ${res.status}): ${excerptBody(res.body, apiKey)}`,
        'auth'
      )
    }
    if (res.status === 429) {
      const retryAfter = parseRetryAfterSec(res.body)
      const hint = retryAfter !== undefined ? `, retry_after=${retryAfter}s` : ''
      throw new AiProviderError(
        `AI provider rate limited (HTTP 429${hint}): ${excerptBody(res.body, apiKey)}`,
        'rate-limit'
      )
    }
    if (res.status < 200 || res.status >= 300) {
      throw new AiProviderError(
        `AI provider HTTP ${res.status}: ${excerptBody(res.body, apiKey)}`,
        'http'
      )
    }

    let data: unknown
    try {
      data = JSON.parse(res.body)
    } catch {
      throw new AiProviderError(
        `AI provider returned invalid JSON (HTTP ${res.status}): ${excerptBody(res.body, apiKey)}`,
        'bad-json'
      )
    }
    const content = extractContent(data)
    if (content === undefined) {
      throw new AiProviderError(
        `AI provider response missing choices[0].message.content (HTTP ${res.status})`,
        'bad-json'
      )
    }
    return content
  }

  /** 连通性测试：最小对话；任何失败抛 AiProviderError（消息已脱敏） */
  async testConnection(): Promise<void> {
    await this.chat({
      system: 'You are a connectivity test agent.',
      user: 'Reply with exactly: ok'
    })
  }
}
