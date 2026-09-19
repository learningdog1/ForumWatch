/**
 * AI 锐评生成器（第三轮）：命中帖推送前让 LLM 对帖子标题写一句中文锐评，
 * 结果写进 HitRecord.commentary（string | null）。
 *
 * - **绝不抛**：网络/超时/未配置/HTTP/bad-json/空响应等一切异常在内部消化为
 *   null——锐评是锦上添花，绝不允许拖垮命中推送主链路（对齐 D5 日报"不许因
 *   LLM 挂掉而失败"的降级哲学，但更彻底：连降级文案都没有，直接无锐评）。
 * - 结果缓存（仅内存 Map，对齐 D4 verdict 的语义）：成功缓存评论文本、**失败
 *   也缓存 null（负缓存）**——同 key 再调用不再打 LLM，防 engine 推送重试
 *   路径反复烧配额；重启后重生成一次的成本可忽略。
 * - 并发去重：同 key 在途 Promise 复用，防重试路径并发双打。
 * - prune/clear：与 engine 的 pruneRetryMaps 同语义——轮末只保留本轮仍出现
 *   在页面上的帖子的键（`${sourceId}:${id}`，与 seen 键同构）；滚出首页后
 *   缓存已无意义，删掉防 Map 常驻。传入 observedSources 时与 pruneRetryMaps
 *   同款守卫：本轮未观测（冷却跳过/抓取失败）的 source 的键一律保留，避免
 *   冷却窗口内误删仍在首页的帖子的缓存。在途表一并清理：被清掉的在途 promise
 *   完成后不回填缓存（调用方仍拿到本次结果，缓存态以清理动作为准）。
 * - 注入边界（D6 先例）：user 只送 JSON.stringify 的标题/分类/作者三字段
 *   摘要，不送原文 HTML；回复纯文本，不用 jsonMode。
 * - 后处理：trim → 去首尾配对引号（模型爱加引号）→ 超 80 字符截断（代理对
 *   安全，F2）→ 空串归 null。
 *
 * 零 electron 依赖；provider 由外部注入（单测全 mock）。
 */
import type { Topic } from '../../shared/types'
import type { AiProvider } from './provider'

/** 锐评请求超时：非关键路径，远小于评估批的 15s / 日报的 30s */
export const COMMENTARY_TIMEOUT_MS = 8000
/** 锐评请求 max_tokens：60 字中文锐评的规模余量 */
export const COMMENTARY_MAX_TOKENS = 120
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
}

export class CommentGenerator {
  private readonly provider: Pick<AiProvider, 'chat'>
  /** 已落定的结果缓存：成功 = 评论文本，失败 = null（负缓存） */
  private readonly cache = new Map<string, string | null>()
  /** 在途去重：同 key 并发 generate 复用同一个 Promise */
  private readonly inflight = new Map<string, Promise<string | null>>()

  constructor(deps: CommentGeneratorDeps) {
    this.provider = deps.provider
  }

  /**
   * 生成一句锐评。**绝不抛**——一切异常内部消化返回 null。
   * 命中缓存（含失败负缓存）直接返回，不再调 chat。
   */
  async generate(topic: Topic): Promise<string | null> {
    const key = commentaryKey(topic)
    const settled = this.cache.get(key)
    if (settled !== undefined) return settled
    const existing = this.inflight.get(key)
    if (existing !== undefined) return existing

    const p = this.requestCommentary(topic).then((text) => {
      // 在途期间被 prune/clear（或被新 Promise 顶替）→ 不回填缓存：
      // 调用方仍拿到本次结果，但缓存态以清理动作为准
      if (this.inflight.get(key) === p) {
        this.cache.set(key, text)
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
    this.inflight.clear()
  }

  /** 单次 LLM 调用 + 后处理；一切异常消化为 null（generate 的绝不抛契约） */
  private async requestCommentary(topic: Topic): Promise<string | null> {
    try {
      const content = await this.provider.chat({
        system: SYSTEM_PROMPT,
        user: JSON.stringify({
          title: topic.title,
          category: topic.category,
          author: topic.author
        }),
        timeoutMs: COMMENTARY_TIMEOUT_MS,
        maxTokens: COMMENTARY_MAX_TOKENS
      })
      return normalizeComment(content)
    } catch {
      // 网络/超时/未配置/HTTP/bad-json：锐评非关键路径，静默降级为无锐评
      return null
    }
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
