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
 * - 思考禁用（R12 引入、R16 扩多方言）：req.disableThinking=true 时请求体附
 *   THINKING_DISABLE_FIELDS 三方言参数组；带参遇 400 → 去参重试一次并按
 *   provider 签名记住该端点（换配置自动复位重学），严格端点自愈不破功能。
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
  /**
   * 上游明示的等待秒数（429 的 parameters.retry_after；R15）：调用方可取
   * max(自身退避, retry_after) 决定冷却。其余错误类型恒 undefined。
   */
  readonly retryAfterSec?: number

  constructor(
    message: string,
    public readonly kind: AiProviderErrorKind,
    retryAfterSec?: number
  ) {
    super(message)
    this.name = 'AiProviderError'
    if (retryAfterSec !== undefined) this.retryAfterSec = retryAfterSec
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
  /**
   * true 时请求体附**多方言**思考禁用参数组（R16）：智谱 GLM/OpenRouter 的
   * `thinking`、SiliconFlow/DashScope（Qwen3 系）的 `enable_thinking`、
   * vLLM/SGLang 的 `chat_template_kwargs`——一次全发，端点各取所认、互不
   * 冲突；宽松端点忽略不认识的，严格端点（OpenAI 官方等对未知参数 400）由
   * chat 内的去参重试兜底（见 THINKING_REJECT_LEARN 说明）。
   * **仅显式要求时下发**（语义评估/锐评直出模式默认 true）。
   */
  disableThinking?: boolean
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
 * 思考禁用参数组（R16 多方言）：三种主流方言一次全发——
 * - `thinking: {"type":"disabled"}`：智谱 GLM 系 / OpenRouter 风格；
 * - `enable_thinking: false`：SiliconFlow / DashScope（Qwen3 系混合思考模型）；
 * - `chat_template_kwargs: {"enable_thinking": false}`：vLLM / SGLang 自托管。
 * 端点各取所认：认识哪个按哪个禁，不认识的多数字段被静默忽略；严格校验
 * 未知参数的端点会 400，由 chat 的去参重试兜底（自愈后本进程不再发这些参数）。
 */
const THINKING_DISABLE_FIELDS: Readonly<Record<string, unknown>> = {
  thinking: { type: 'disabled' },
  enable_thinking: false,
  chat_template_kwargs: { enable_thinking: false }
}

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
  /**
   * 「该端点对思考禁用参数回 400」的记忆（R16）：值 = 学习时的 provider 配置
   * 签名（`baseUrl|model|apiKey`）。带思考参数遇 400 → 去参重试一次并记下
   * 签名——同端点的后续调用直接不带思考参数（不再反复 400）；换端点/模型/
   * 密钥（签名变化）自动复位重学。进程内存态：重启后第一次调用重新探测，
   * 代价至多一次多余的 400。null = 尚未学到任何拒绝。
   */
  private thinkingRejectedSignature: string | null = null

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

    const basePayload: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user }
      ],
      temperature: 0,
      stream: false
    }
    if (req.jsonMode === true) basePayload.response_format = { type: 'json_object' }
    if (req.maxTokens !== undefined) basePayload.max_tokens = req.maxTokens

    // R16：带思考禁用参数组（多方言）当且仅当调用方要求且该端点未学到拒绝
    const providerSignature = `${baseUrl}|${model}|${apiKey}`
    const sendThinkingDisable =
      req.disableThinking === true && this.thinkingRejectedSignature !== providerSignature

    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const postOnce = async (payload: Record<string, unknown>): Promise<HttpResponse> => {
      const init: HttpRequestInit = {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        timeoutMs
      }
      try {
        return await this.post(`${baseUrl}/chat/completions`, init)
      } catch (err) {
        if (isAbortLike(err)) {
          throw new AiProviderError(`AI provider request timed out after ${timeoutMs}ms`, 'timeout')
        }
        const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        throw new AiProviderError(`AI provider network error: ${scrubSecret(detail, apiKey)}`, 'network')
      }
    }

    let payload: Record<string, unknown> = { ...basePayload }
    if (sendThinkingDisable) Object.assign(payload, THINKING_DISABLE_FIELDS)
    let res = await postOnce(payload)

    // R16 自愈兜底：带了思考参数却 400——多半是端点严格校验未知参数（OpenAI
    // 官方等）。记住该端点并去参原样重试一次：宽松端点各取所认、严格端点自愈，
    // 「任何模型」都能用。重试仍 400（真实坏请求）则照常走错误分类上抛——
    // 兜底只吸收"参数不被认识"这一种情形，不掩盖真错误。
    if (res.status === 400 && sendThinkingDisable) {
      this.thinkingRejectedSignature = providerSignature
      res = await postOnce({ ...basePayload })
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
        'rate-limit',
        retryAfter
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
