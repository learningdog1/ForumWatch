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
 * - 裁决元素可带 score（R5-P2b 置信度，0-1）：缺失/非数字回退 1.0（旧模型
 *   行为完全不变——hit 就命中），数值钳到 [0,1]；**score 不参与元素合法性
 *   判定**（缺 score 的元素仍是合法裁决，D11 兼容链不受影响）。
 * - **裁决数组定位（W3 线上修复）**：实测有模型无视提示词用 `{"results":[...]}`
 *   回包，旧代码只认 `verdicts` → bad-json → 整批未决每轮重评（空转调用+刷错误
 *   日志）。现按兼容顺序定位：显式键 `verdicts` → 显式键 `results` → 兜底扫描
 *   顶层所有数组值取首个含合法元素的；候选必须至少含 1 个合法元素（对象且
 *   key 为 string 且 hit 为 boolean），防误吞模型回显的 interests 字符串数组。
 *
 * 零 electron 依赖；provider 由外部注入（单测全 mock）。
 * R7-W4（DEC-5）反馈闭环：构造 deps 可选注入 getFeedbackExamples（正负例
 * 标题，通常接 FileFeedbackStore.recentForPrompt），每次评估现读并追加在
 * SYSTEM_PROMPT 尾部（格式与护栏见 buildFeedbackSection）；无反馈时 prompt
 * 与基线逐字节一致。engine 不动——反馈只经本模块进 prompt。
 */
import type { Topic } from '../../shared/types'
import { AiProviderError, type AiProvider } from './provider'

/** 单次评估的帖子上限（D4 cap 12；engine 切片，这里防御性断言） */
export const MAX_SEMANTIC_BATCH = 12

/**
 * 评估请求超时（R15 从 15s 放宽到 30s：线上实测 12 帖批量经网关到推理型
 * 模型常超 15s——15s 掐断是语义评估失败的第二大来源；pollOnce 内联 await，
 * PollScheduler 防重叠，30s 只会拉长本轮、不会叠加并发）
 */
const EVALUATE_TIMEOUT_MS = 30000
/** 评估请求 max_tokens（12 帖 × 每条一句理由的规模） */
const EVALUATE_MAX_TOKENS = 2000

export interface SemanticVerdict {
  hit: boolean
  /**
   * AI 自报的置信度（R5-P2b，0-1 浮点；1 = 非常确定相关）。
   * 解析规则：缺失/非数字 → 回退 1.0（旧模型行为完全不变——hit 就命中）；
   * 数值钳到 [0,1]（>1 → 1，<0 → 0）。engine 只在 hit=true 时消费它
   * （cfg.ai.semanticThreshold 过闸）；hit=false 时仅透传、不参与判定。
   */
  score: number
  /** AI 的一句话判定理由；hit=false 或模型未给出时为 null */
  reason: string | null
}

export interface SemanticEvaluatorDeps {
  provider: Pick<AiProvider, 'chat'>
  /** 测试注入假时钟（当前实现不读时钟，保留给未来节流/冷却用） */
  now?: () => number
  /**
   * R7-W4（DEC-5）反馈闭环：正负例标题访问器（通常接 FileFeedbackStore 的
   * recentForPrompt，新→旧各 ≤8 条）。**每次 evaluate 现读**——投票/改票/
   * 撤销后下一次评估即生效。缺省 / 返回空时 system prompt 与基线逐字节一致
   * （旧测试零回归）；标题换行剥离 + 总长护栏见 buildFeedbackSection。
   */
  getFeedbackExamples?: () => { positive: string[]; negative: string[] }
}

/**
 * D4 协议：system 提示词（中文，宁可漏报不要误报，只输出 JSON）。
 * W3 收紧：给出精确输出示例并钉死键名 `verdicts`——线上实测模型会自作主张
 * 换键名（"results"），示例是对此最直接的免疫。
 * R5-P2b：示例的每个裁决元素钉死 `"score"` 键（0-1 置信度，1 = 非常确定
 * 相关，不确定给低分）——同样的免疫逻辑：示例是对换键名行为最直接的防线；
 * "仅当明确相关才判 hit=true" 的既有原则不变（score 是补充信号，不是放行）。
 */
const SYSTEM_PROMPT =
  '你是论坛帖子筛选器。仅当帖子标题与任一兴趣**明确相关**才判 hit=true；' +
  '宁可漏报不要误报。只输出 JSON，不要任何其他文本（不要 markdown 代码围栏、' +
  '不要解释）。输出的顶层键名必须是 "verdicts"，其值为数组；数组每个元素形如 ' +
  '{"key":"<原样返回输入里的 key>","hit":true 或 false,' +
  '"score":0 到 1 的小数（你对这条裁决的置信度，1 = 非常确定相关，不确定给低分），' +
  '"reason":"一句话理由"}。完整输出示例：' +
  '{"verdicts":[{"key":"nodeseek:1","hit":true,"score":0.95,"reason":"与自建主机相关"},' +
  '{"key":"nodeseek:2","hit":false,"score":0.1}]}。'

// ---- R7-W4（DEC-5）反馈注入段 ------------------------------------------------

/** 负例段头（列表项随后，每行一个标题） */
const FEEDBACK_NEGATIVE_HEADER = '\n以下标题用户明确表示不想要，判定时宁可判不相关：'
/** 正例段头 */
const FEEDBACK_POSITIVE_HEADER = '\n以下标题用户明确表示想要，同类新帖可判相关：'
/** 注入段总长护栏（字符）：超出按条截断（段头保留，条目整条取舍，绝不截半条） */
const FEEDBACK_SECTION_MAX_CHARS = 2000

/**
 * 组装反馈注入段（追加在 SYSTEM_PROMPT 之后；两段都空 → 空串 = 不追加，
 * 无反馈路径的 system prompt 与基线逐字节一致）。
 * - 段序：负例在前、正例在后（负例是"宁可判不相关"的强信号，优先呈现）；
 *   只有负例或只有正例时只注入存在的段。
 * - 标题清洗：剥离换行（\r\n 归一为空格）+ trim——帖子标题里的换行会被模型
 *   读成伪造的新列表项（prompt 注入面），清洗后每条恒为单行。
 * - 长度护栏：注入段总长 > 2000 字符时按条截断——段头必留，条目逐条入账直到
 *   预算耗尽（条目序 = 调用方给的新→旧，截掉的是最旧的）。
 */
function buildFeedbackSection(positive: string[], negative: string[]): string {
  const blocks: Array<{ header: string; titles: string[] }> = []
  if (negative.length > 0) blocks.push({ header: FEEDBACK_NEGATIVE_HEADER, titles: negative })
  if (positive.length > 0) blocks.push({ header: FEEDBACK_POSITIVE_HEADER, titles: positive })
  if (blocks.length === 0) return ''
  const rendered = blocks
    .map((b) => [b.header, ...b.titles.map((t) => `- ${sanitizeFeedbackTitle(t)}`)].join('\n'))
    .join('')
  if (rendered.length <= FEEDBACK_SECTION_MAX_CHARS) return rendered
  let budget = FEEDBACK_SECTION_MAX_CHARS
  const parts: string[] = []
  for (const b of blocks) {
    if (b.header.length > budget) break
    parts.push(b.header)
    budget -= b.header.length
    for (const t of b.titles) {
      const line = `\n- ${sanitizeFeedbackTitle(t)}`
      if (line.length > budget) break
      parts.push(line)
      budget -= line.length
    }
  }
  return parts.join('')
}

/** 反馈标题清洗：剥离换行（防注入伪造列表项）+ trim；清洗后为空的条目丢弃 */
function sanitizeFeedbackTitle(title: string): string {
  return title.replace(/[\r\n]+/g, ' ').trim()
}

/** accessor 返回值的防御性归一：非数组按空；非字符串 / 清洗后空的条目丢弃 */
function normalizeFeedbackTitles(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const t of list) {
    if (typeof t !== 'string') continue
    if (sanitizeFeedbackTitle(t) === '') continue
    out.push(t)
  }
  return out
}

export class SemanticEvaluator {
  private readonly provider: Pick<AiProvider, 'chat'>
  private readonly getFeedbackExamples: (() => { positive: string[]; negative: string[] }) | undefined

  constructor(deps: SemanticEvaluatorDeps) {
    this.provider = deps.provider
    this.getFeedbackExamples = deps.getFeedbackExamples
  }

  /**
   * 每次评估组装 system prompt：基线 SYSTEM_PROMPT +（有反馈且非空时）
   * DEC-5 反馈注入段。无 accessor / 反馈为空 → 恒返回基线常量
   * （与 R7-W4 之前的 system prompt 逐字节一致，旧路径零回归）。
   */
  private buildSystemPrompt(): string {
    if (this.getFeedbackExamples === undefined) return SYSTEM_PROMPT
    const raw = this.getFeedbackExamples()
    const positive = normalizeFeedbackTitles(raw?.positive)
    const negative = normalizeFeedbackTitles(raw?.negative)
    const section = buildFeedbackSection(positive, negative)
    return section === '' ? SYSTEM_PROMPT : SYSTEM_PROMPT + section
  }

  /**
   * 批量评估。返回 Map，键 = `${topic.sourceId}:${topic.id}`；
   * 只有"AI 明确给了裁决"的帖子在 Map 里（verdict.hit=false 也是已裁决）；
   * 整体失败（网络/超时/JSON 解析不出）抛 AiProviderError——调用方把该批
   * 全部视为未决。
   *
   * opts.useThinking（R15，由 engine 从 cfg.ai.evaluation 透传）：缺省/false =
   * 直出模式——请求附 thinking 禁用参数（评估是短 JSON 判定任务，推理型模型
   * 的思考 token 拖长延迟且吃 max_tokens 预算，是超时主因之一；与
   * commentary 的直出模式同款）；true = 保留模型默认思考行为（旧语义）。
   */
  async evaluate(
    topics: Topic[],
    interests: string[],
    opts: { useThinking?: boolean } = {}
  ): Promise<Map<string, SemanticVerdict>> {
    // 空兴趣 = 永不命中：不调 API，全量判 hit:false（镜像字面档防风暴规则）
    if (interests.length === 0) {
      const all = new Map<string, SemanticVerdict>()
      for (const t of topics) all.set(verdictKey(t), { hit: false, score: 1, reason: null })
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
      system: this.buildSystemPrompt(),
      user,
      jsonMode: true,
      timeoutMs: EVALUATE_TIMEOUT_MS,
      maxTokens: EVALUATE_MAX_TOKENS,
      disableThinking: opts.useThinking !== true
    })

    const parsed = parseVerdictResponse(content)
    const verdicts = parsed.verdicts
    const out = new Map<string, SemanticVerdict>()
    const knownKeys = new Set(topics.map(verdictKey))
    for (const item of verdicts) {
      if (!isValidVerdictItem(item)) continue // 缺 key / hit 非布尔：跳过
      if (!knownKeys.has(item.key)) continue // 模型幻觉出的未知键：跳过
      const rawReason = (item as { reason?: unknown }).reason
      out.set(item.key, {
        hit: item.hit,
        score: normalizeScore((item as { score?: unknown }).score),
        reason: item.hit && typeof rawReason === 'string' ? rawReason : null
      })
    }
    return out
  }
}

/**
 * score 字段归一（R5-P2b）：缺失/非数字 → 回退 1.0（旧模型行为完全不变——
 * hit 就命中，D11 兼容）；数字钳到 [0,1]。**score 缺失不影响元素合法性**
 * （isValidVerdictItem 只看 key/hit，缺 score 的元素仍是合法裁决）。
 * Number.isFinite 守卫：JSON 文本出不了 NaN/Infinity，这里纯防御（万一调用方
 * 程序化构造），非有限数按"坏值"走回退而不是钳位（钳 NaN 会产出 NaN，
 * NaN >= 任何阈值恒 false，会静默吞 hit）。
 */
function normalizeScore(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 1.0
  return Math.min(1, Math.max(0, raw))
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
 * 花括号不计深度）再 parse；都不行抛 bad-json。顶层非对象或定位不到可用裁决
 * 数组同样抛 bad-json（错误消息列出实际顶层键名，便于排查模型换了什么键名）。
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
  const verdicts = extractVerdictArray(data)
  if (verdicts === null) {
    throw new AiProviderError(
      `semantic evaluation response missing verdicts array, top-level keys: ${describeTopLevel(data)}; content: ${excerpt(content)}`,
      'bad-json'
    )
  }
  return { verdicts }
}

/**
 * 按兼容顺序定位裁决数组（W3 线上修复）：显式键 `verdicts` → 显式键 `results`
 * → 兜底扫描顶层所有数组值。任何候选都必须**至少含 1 个合法元素**才可用——
 * 空数组与纯字符串数组（模型原样回显的 interests）都跳过继续找；这同时保证
 * 选中 verdicts/results 时不会是"解析成功但零裁决"的静默未决。都无 → null。
 */
function extractVerdictArray(data: unknown): unknown[] | null {
  if (typeof data !== 'object' || data === null) return null
  const obj = data as Record<string, unknown>
  if (isValidVerdictArray(obj.verdicts)) return obj.verdicts
  if (isValidVerdictArray(obj.results)) return obj.results
  for (const value of Object.values(obj)) {
    if (isValidVerdictArray(value)) return value
  }
  return null
}

/** 候选数组可用性：是数组且至少含 1 个合法元素 */
function isValidVerdictArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.some(isValidVerdictItem)
}

/**
 * 单个裁决元素合法性：对象且 key 为 string 且 hit 为 boolean。
 * R5-P2b：score 不参与判定（缺失/非法只影响 normalizeScore 的回退值，
 * 不让元素变未决——旧模型不带 score 的回包仍全量可解析）。
 */
function isValidVerdictItem(item: unknown): item is { key: string; hit: boolean } {
  if (typeof item !== 'object' || item === null) return false
  const { key, hit } = item as { key?: unknown; hit?: unknown }
  return typeof key === 'string' && typeof hit === 'boolean'
}

/** 错误消息里的顶层键名清单（非对象标类型，空对象标 (empty object)） */
function describeTopLevel(data: unknown): string {
  if (typeof data !== 'object' || data === null) return `(non-object ${typeof data})`
  const keys = Object.keys(data).join(',')
  return keys === '' ? '(empty object)' : keys
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
