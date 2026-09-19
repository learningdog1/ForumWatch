/**
 * 语义监控评估器（D4）：把一轮剩余未命中的帖子打包成一次 LLM 批式评估。
 *
 * - 批式单请求：一次 chat 调用评估 ≤ MAX_BATCH 条帖子（engine 负责切片；
 *   本模块只做防御性断言，> MAX_BATCH 直接抛——切片错误越早暴露越好）。
 * - interests 为空 → **不调 API**，直接返回全量 Map（全部 hit:false）——
 *   镜像 matcher 的"包含词为空永不匹配"：语义档空兴趣 = 永不命中（防风暴）。
 * - topics 为空 → 空 Map，同样不调 API。
 * - 协议：jsonMode（response_format json_object）+ 兜底从响应文本里提取首个
 *   平衡 `{...}` 块再 parse（有的 OpenAI 兼容端不支持 json_object）；
 *   仍解析不出 → AiProviderError('bad-json')，调用方把该批全部视为未决。
 * - 返回 Map 键 = `${topic.sourceId}:${topic.id}`（与 engine 的全局去重键同口径）；
 *   **只有 AI 明确给了裁决的帖子在 Map 里**：hit=false 也是已裁决（engine 据此入
 *   seen）；Map 里没有的键 = 未决（engine 不入 seen，下轮重评）。
 * - 响应缺 key / hit 非布尔 → 跳过该项（视为未决），不炸整批。
 *
 * 零 electron 依赖；provider 由外部注入（单测全 mock）。
 */
import type { Topic } from '../../shared/types'
import { AiProviderError, type AiProvider } from './provider'

/** 单次评估的帖子上限（D4 cap 12；engine 切片，这里防御性断言） */
export const MAX_SEMANTIC_BATCH = 12

/** 评估请求超时（D4：pollOnce 内联 await，30s 级别里取 15s） */
const EVALUATE_TIMEOUT_MS = 15000
/** 评估请求 max_tokens（12 帖 × 每条一句理由的规模） */
const EVALUATE_MAX_TOKENS = 2000

export interface SemanticVerdict {
  hit: boolean
  /** AI 的一句话判定理由；hit=false 或模型未给出时为 null */
  reason: string | null
}

export interface SemanticEvaluatorDeps {
  provider: Pick<AiProvider, 'chat'>
  /** 测试注入假时钟（当前实现不读时钟，保留给未来节流/冷却用） */
  now?: () => number
}

/** D4 协议：system 提示词（中文，宁可漏报不要误报，只输出 JSON） */
const SYSTEM_PROMPT =
  '你是论坛帖子筛选器。仅当帖子标题与任一兴趣**明确相关**才判 hit=true；' +
  '宁可漏报不要误报。只输出 JSON，不要任何其他文本。'

export class SemanticEvaluator {
  private readonly provider: Pick<AiProvider, 'chat'>

  constructor(deps: SemanticEvaluatorDeps) {
    this.provider = deps.provider
  }

  /**
   * 批量评估。返回 Map，键 = `${topic.sourceId}:${topic.id}`；
   * 只有"AI 明确给了裁决"的帖子在 Map 里（verdict.hit=false 也是已裁决）；
   * 整体失败（网络/超时/JSON 解析不出）抛 AiProviderError——调用方把该批
   * 全部视为未决。
   */
  async evaluate(topics: Topic[], interests: string[]): Promise<Map<string, SemanticVerdict>> {
    // 空兴趣 = 永不命中：不调 API，全量判 hit:false（镜像字面档防风暴规则）
    if (interests.length === 0) {
      const all = new Map<string, SemanticVerdict>()
      for (const t of topics) all.set(verdictKey(t), { hit: false, reason: null })
      return all
    }
    if (topics.length === 0) return new Map()
    if (topics.length > MAX_SEMANTIC_BATCH) {
      throw new Error(
        `semantic batch too large: ${topics.length} > ${MAX_SEMANTIC_BATCH} (caller must slice)`
      )
    }

    const user = JSON.stringify({
      interests,
      topics: topics.map((t) => ({
        key: verdictKey(t),
        title: t.title,
        category: t.category
      }))
    })
    const content = await this.provider.chat({
      system: SYSTEM_PROMPT,
      user,
      jsonMode: true,
      timeoutMs: EVALUATE_TIMEOUT_MS,
      maxTokens: EVALUATE_MAX_TOKENS
    })

    const parsed = parseVerdictResponse(content)
    const verdicts = parsed.verdicts
    const out = new Map<string, SemanticVerdict>()
    const knownKeys = new Set(topics.map(verdictKey))
    for (const item of verdicts) {
      if (item === null || typeof item !== 'object') continue
      const key = (item as { key?: unknown }).key
      const hit = (item as { hit?: unknown }).hit
      if (typeof key !== 'string' || typeof hit !== 'boolean') continue // 缺 key / hit 非布尔：跳过
      if (!knownKeys.has(key)) continue // 模型幻觉出的未知键：跳过
      const rawReason = (item as { reason?: unknown }).reason
      out.set(key, {
        hit,
        reason: hit && typeof rawReason === 'string' ? rawReason : null
      })
    }
    return out
  }
}

/** Map 键 / 协议里的 key：与 engine 全局去重键同口径（D2/D3） */
function verdictKey(t: Topic): string {
  return `${t.sourceId}:${t.id}`
}

interface VerdictResponseShape {
  verdicts: unknown[]
}

/**
 * 解析模型输出：先直接 JSON.parse；失败则提取首个平衡 `{...}` 块（字符串里的
 * 花括号不计深度）再 parse；都不行抛 bad-json。顶层非对象或 verdicts 非数组
 * 同样抛 bad-json。
 */
function parseVerdictResponse(content: string): VerdictResponseShape {
  let data: unknown = tryParse(content)
  if (data === undefined) {
    const block = extractFirstBalancedBlock(content)
    if (block !== null) data = tryParse(block)
  }
  if (data === undefined) {
    throw new AiProviderError(
      `semantic evaluation response is not valid JSON: ${excerpt(content)}`,
      'bad-json'
    )
  }
  if (typeof data !== 'object' || data === null || !Array.isArray((data as { verdicts?: unknown }).verdicts)) {
    throw new AiProviderError(
      `semantic evaluation response missing verdicts array: ${excerpt(content)}`,
      'bad-json'
    )
  }
  return data as VerdictResponseShape
}

function tryParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * 提取文本中首个平衡的 `{...}` 块（跳过 JSON 字符串字面量里的花括号）。
 * 找不到闭合（截断输出）返回 null。注意提取的是**首个**平衡块——前缀垃圾
 * 文本（"好的，以下是结果："）与后缀（"希望有帮助"）都被剥掉。
 */
function extractFirstBalancedBlock(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** 错误消息里的响应摘录（前 160 字符；内容是模型输出，无密钥风险，截断防刷屏） */
function excerpt(s: string): string {
  return s.trim().slice(0, 160)
}
