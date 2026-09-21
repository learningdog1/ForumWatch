/**
 * AI 锐评生成器（第三轮）：命中帖推送前让 LLM 对帖子标题写一句中文锐评，
 * 结果写进 HitRecord.commentary（string | null）。
 *
 * - **绝不抛**：网络/超时/未配置/HTTP/bad-json/空响应等一切异常在内部消化为
 *   null——锐评是锦上添花，绝不允许拖垮命中推送主链路（对齐 D5 日报"不许因
 *   LLM 挂掉而失败"的降级哲学，但更彻底：连降级文案都没有，直接无锐评）。
 * - 结果缓存（仅内存 Map，对齐 D4 verdict 的语义）：成功缓存评论文本；**失败
 *   也缓存 null（负缓存，10 分钟 TTL）**——TTL 内同 key 再调用不打 LLM，防
 *   engine 推送重试路径反复打调用；TTL 过期放行重试，供应商恢复后能自愈
 *   （旧语义失败永续，慢供应商恢复后锐评仍全灭）。重启后重生成一次的成本可忽略。
 * - 并发去重：同 key 在途 Promise 复用，防重试路径并发双打。
 * - prune/clear：与 engine 的 pruneRetryMaps 同语义——轮末只保留本轮仍出现
 *   在页面上的帖子的键（`${sourceId}:${id}`，与 seen 键同构）；滚出首页后
 *   缓存已无意义，删掉防 Map 常驻。传入 observedSources 时与 pruneRetryMaps
 *   同款守卫：本轮未观测（冷却跳过/抓取失败）的 source 的键一律保留，避免
 *   冷却窗口内误删仍在首页的帖子的缓存。在途表一并清理：被清掉的在途 promise
 *   完成后不回填缓存（调用方仍拿到本次结果，缓存态以清理动作为准）。
 * - 注入边界（D6 先例）：user 只送 JSON.stringify 的标题/分类/作者三字段
 *   摘要，不送原文 HTML；回复纯文本，不用 jsonMode。
 * - 模式（R12）：默认**直出**——请求附 thinking:{type:'disabled'}、预算 200、
 *   失败自动重试一次（推理型模型的思考 token 与正文共用产出预算，思考吃光
 *   预算返回空串是 R11 事故的主因）；generate({useThinking:true}) 走旧思考
 *   语义（预算 2000、单发不重试），由配置 ai.commentary.useThinking 决定。
 * - 后处理：trim → 去首尾配对引号（模型爱加引号）→ 超 80 字符截断（代理对
 *   安全，F2）→ 空串归 null。
 *
 * 零 electron 依赖；provider 由外部注入（单测全 mock）。
 */
import type { Topic } from '../../shared/types'
import type { AiProvider } from './provider'

/** 锐评请求超时：慢供应商（推理型模型常规延迟 15s+，实测评估批 15s 也成片超时）
 * 下 8s 预算全灭（0/83），对齐日报的 30s 档取 25s；锐评在推送前生成，此值即
 * 慢供应商下单条命中的额外推送延迟上限（直出模式重试一次时上限 ×2） */
export const COMMENTARY_TIMEOUT_MS = 25000
/** 思考模式 max_tokens（R12 前的旧语义，用户显式开启思考时沿用）：推理型模型
 * 的思考 token 与正文**共用产出预算**，预算不足时思考吃光、content 返回空串
 * （实测 512 下 64 次 content="" 仅 14/146 挤出正文；评估批同模型 2000 稳定
 * 有正文）——对齐评估批预算取 2000；可见正文仍由 COMMENTARY_MAX_CHARS 截到 80 */
export const COMMENTARY_MAX_TOKENS = 2000
/** 直出模式 max_tokens（R12 默认）：请求附 thinking:{type:'disabled'}，产出全部
 * 是正文——提示词要求 60 字，200 留足余量；可见正文仍由 COMMENTARY_MAX_CHARS 截到 80 */
export const COMMENTARY_MAX_TOKENS_DIRECT = 200
/** 直出模式失败重试次数：快路径单次成本秒级，失败（网络/超时/空响应）自动补
 * 一发再降级 null；思考模式不重试（单次已 25s 级，重试会把推送延迟上限翻倍） */
export const COMMENTARY_DIRECT_RETRIES = 1
/** 失败负缓存 TTL：窗口内同 key 重试直接 null 不打 LLM（防推送重试风暴），
 * 过期后放行重试——供应商恢复后能自愈（旧语义：失败永续缓存到 prune/重启） */
export const COMMENTARY_NEG_CACHE_TTL_MS = 10 * 60 * 1000
/** 后处理长度上限（字符口径）：prompt 要求 60 字，留 1/3 余量到 80 截断 */
export const COMMENTARY_MAX_CHARS = 80
/** 去引号轮数上限：正常最多两层包裹（“"..."”），3 轮防病态输入 */
const MAX_QUOTE_STRIP_ROUNDS = 3

/** 配对引号（ASCII + 中文全角），stripEnclosingQuotes 用 */
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』']
]

/** system 提示词：一句话钉死语气/长度/输出契约 */
const SYSTEM_PROMPT =
  '对论坛帖子标题写一句中文锐评：犀利、机智、有观点，可以调侃但不辱骂、' +
  '不攻击具体人，60 字以内，只输出评论文本本身，不要引号、不要任何前后缀。'

export interface CommentGeneratorDeps {
  provider: Pick<AiProvider, 'chat'>
  /** 失败/空响应的可观测钩子（生产接 logger.warn；缺省静默——旧测试不注入即旧行为）。
   * 旧版失败完全无声，慢供应商下锐评全灭而无任何日志可查，故补此口。 */
  logWarn?: (message: string) => void
  /** 测试注入假时钟；默认 Date.now（负缓存 TTL 判定用，对齐 bark/ntfy 的注入风格） */
  now?: () => number
}

/** generate 的模式选项（R12）：useThinking 缺省/false = 直出模式（默认，
 * 附 thinking 禁用参数、预算 200、失败重试一次）；true = 思考模式（旧语义） */
export interface GenerateOptions {
  useThinking?: boolean
}

export class CommentGenerator {
  private readonly provider: Pick<AiProvider, 'chat'>
  private readonly logWarn: (message: string) => void
  private readonly now: () => number
  /** 已落定的结果缓存：成功 = 评论文本，失败 = null（负缓存，TTL 见 negExpiresAt） */
  private readonly cache = new Map<string, string | null>()
  /** 负缓存到期表：key → 失败结果作废时刻（now() 口径）；成功缓存无到期 */
  private readonly negExpiresAt = new Map<string, number>()
  /** 在途去重：同 key 并发 generate 复用同一个 Promise */
  private readonly inflight = new Map<string, Promise<string | null>>()

  constructor(deps: CommentGeneratorDeps) {
    this.provider = deps.provider
    this.logWarn = deps.logWarn ?? (() => undefined)
    this.now = deps.now ?? (() => Date.now())
  }

  /**
   * 生成一句锐评。**绝不抛**——一切异常内部消化返回 null。
   * 命中缓存（含失败负缓存）直接返回，不再调 chat。
   *
   * 模式（R12）：opts.useThinking === true 走思考模式（慢、预算 2000、失败
   * 不重试——旧语义）；否则（缺省）直出模式——请求附 thinking 禁用参数、
   * 预算 200、失败自动重试 COMMENTARY_DIRECT_RETRIES 次。缓存键不含模式，
   * 思考/直出结果互通（锐评文本即锐评文本）。
   */
  async generate(topic: Topic, opts: GenerateOptions = {}): Promise<string | null> {
    const useThinking = opts.useThinking === true
    const key = commentaryKey(topic)
    const settled = this.cache.get(key)
    if (settled !== undefined) {
      if (settled !== null) return settled
      // 失败负缓存：TTL 内直接 null 不打 LLM；过期视为未缓存，放行重试自愈。
      // 无到期记录（防御：非本类写入的 null）按旧语义永久缓存。
      const expiresAt = this.negExpiresAt.get(key)
      if (expiresAt === undefined || this.now() < expiresAt) return null
      this.cache.delete(key)
      this.negExpiresAt.delete(key)
    }
    const existing = this.inflight.get(key)
    if (existing !== undefined) return existing

    const p = this.requestCommentary(topic, useThinking).then((text) => {
      // 在途期间被 prune/clear（或被新 Promise 顶替）→ 不回填缓存：
      // 调用方仍拿到本次结果，但缓存态以清理动作为准
      if (this.inflight.get(key) === p) {
        this.cache.set(key, text)
        if (text === null) this.negExpiresAt.set(key, this.now() + COMMENTARY_NEG_CACHE_TTL_MS)
        else this.negExpiresAt.delete(key)
        this.inflight.delete(key)
      }
      return text
    })
    this.inflight.set(key, p)
    return p
  }

  /**
   * 轮末清理：只保留 keepKeys 中的键（与 engine 的 pruneRetryMaps 同语义）。
   * observedSources（可选）：本轮实际观测过的 source id 集——传入时额外保留
   * 「键的 sourceId（首个 `:` 前缀）不在观测集」的键（冷却跳过/抓取失败的
   * source 本轮没有观测，其键保留到下一轮，防冷却窗口内误删）；不传时行为
   * 同旧版（keepKeys 外全删）。
   */
  prune(keepKeys: ReadonlySet<string>, observedSources?: ReadonlySet<string>): void {
    for (const key of [...this.cache.keys()]) {
      if (!keepKeys.has(key) && this.shouldPrune(key, observedSources)) {
        this.cache.delete(key)
      }
    }
    for (const key of [...this.negExpiresAt.keys()]) {
      if (!keepKeys.has(key) && this.shouldPrune(key, observedSources)) {
        this.negExpiresAt.delete(key)
      }
    }
    for (const key of [...this.inflight.keys()]) {
      if (!keepKeys.has(key) && this.shouldPrune(key, observedSources)) {
        this.inflight.delete(key)
      }
    }
  }

  /** prune 的单键判据：observedSources 未给出时恒删；给出时只删其观测过的 source 的键 */
  private shouldPrune(key: string, observedSources: ReadonlySet<string> | undefined): boolean {
    return observedSources === undefined || observedSources.has(sourceIdOfKey(key))
  }

  /** 测试/重置用：清空结果缓存与在途表（在途调用仍会完成但不回填缓存） */
  clear(): void {
    this.cache.clear()
    this.negExpiresAt.clear()
    this.inflight.clear()
  }

  /** 单次 LLM 调用 + 后处理；一切异常消化为 null（generate 的绝不抛契约）。
   * 失败与空响应经 logWarn 钩子留痕（缺省静默）——降级本身不变，但不再无声。
   *
   * 直出模式（R12 默认）失败自动重试 COMMENTARY_DIRECT_RETRIES 次（每次各留
   * 一条 warn，attempt 编号可辨）；思考模式单发（旧语义，重试会把 25s 级延迟
   * 上限翻倍）。 */
  private async requestCommentary(topic: Topic, useThinking: boolean): Promise<string | null> {
    const attempts = useThinking ? 1 : 1 + COMMENTARY_DIRECT_RETRIES
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const content = await this.provider.chat({
          system: SYSTEM_PROMPT,
          user: JSON.stringify({
            title: topic.title,
            category: topic.category,
            author: topic.author
          }),
          timeoutMs: COMMENTARY_TIMEOUT_MS,
          maxTokens: useThinking ? COMMENTARY_MAX_TOKENS : COMMENTARY_MAX_TOKENS_DIRECT,
          disableThinking: !useThinking
        })
        const normalized = normalizeComment(content)
        if (normalized !== null) return normalized
        this.logWarn(
          `commentary empty after normalize (attempt ${attempt}/${attempts}` +
            `, mode=${useThinking ? 'thinking' : 'direct'}` +
            `, content=${JSON.stringify((content ?? '').slice(0, 40))}` +
            `, possibly reasoning consumed max_tokens): "${topic.title}"`
        )
      } catch (err) {
        // 网络/超时/未配置/HTTP/bad-json：锐评非关键路径，降级为无锐评（留一条 warn）
        this.logWarn(
          `commentary failed (attempt ${attempt}/${attempts}` +
            `, mode=${useThinking ? 'thinking' : 'direct'}): ` +
            `${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}` +
            ` (topic: "${topic.title}")`
        )
      }
    }
    return null
  }
}

/** 缓存键：与 engine 全局去重键 / evaluator verdict 键同口径（D2/D3） */
function commentaryKey(t: Topic): string {
  return `${t.sourceId}:${t.id}`
}

/** 键 → sourceId 部分（首个冒号前；与 engine 的 sourceIdOfKey 同款提取，prune 守卫用） */
const sourceIdOfKey = (key: string): string => key.slice(0, key.indexOf(':'))

/** 后处理：trim → 去首尾配对引号 → 超 80 字符截断（代理对安全）→ 空串归 null */
function normalizeComment(raw: string): string | null {
  let text = stripEnclosingQuotes(raw.trim())
  if (text.length > COMMENTARY_MAX_CHARS) text = truncateUtf16Safe(text, COMMENTARY_MAX_CHARS)
  return text === '' ? null : text
}

/**
 * UTF-16 截断（代理对安全，F2）：slice 后末字符若是高代理（0xD800–0xDBFF，
 * emoji/增补平面字符被切半的后半未跟着到达），退一位丢弃孤立高代理——
 * 孤立代理会让下游（TG 消息编码 / JSON.stringify 转义）产生乱码。
 */
function truncateUtf16Safe(text: string, maxChars: number): string {
  const sliced = text.slice(0, maxChars)
  const last = sliced.charCodeAt(sliced.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced
}

/** 循环剥掉首尾成对的引号（含引号内侧空白再 trim）；只剥配对，不动内部引号 */
function stripEnclosingQuotes(text: string): string {
  let out = text
  for (let round = 0; round < MAX_QUOTE_STRIP_ROUNDS; round++) {
    let stripped = false
    for (const [open, close] of QUOTE_PAIRS) {
      if (out.length >= 2 && out.startsWith(open) && out.endsWith(close)) {
        out = out.slice(1, -1).trim()
        stripped = true
        break
      }
    }
    if (!stripped) break
  }
  return out
}
