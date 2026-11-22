/**
 * 活动 AI 精筛与结构化提取器（零 Electron，复用 AiProvider）。
 *
 * 作用：
 * 1. 二次精筛：区分「真正的活动/抽奖/福利/限时促销」与「讨论某活动、求助、晒中奖、吐槽」；
 * 2. 结构化抽取：从标题 + 1 楼正文中提炼移动端卡片可直接展示的 `summary`、主办方 `organizer`、
 *    奖品 `prize`、参与方式 `participation`、起止时间（ISO → epoch ms）与目标楼层；
 * 3. 故障自愈与无感降级：未配 AI / 上游超时 / JSON 格式异常 / 冷却期内一律返回 `null`
 *    （绝不向调用方抛错），由 `ActivityCollector` 无缝回退到确定性提取结果。
 */
import type { ActivityKind } from '../../shared/types'
import { AiProviderError, type AiProvider } from '../ai/provider'

const EXTRACT_TIMEOUT_MS = 20_000
const EXTRACT_MAX_TOKENS = 700
const BODY_PROMPT_MAX_CHARS = 2_800
const BACKOFF_BASE_MS = 30_000
const BACKOFF_CAP_MS = 10 * 60_000

const VALID_KINDS = new Set<ActivityKind>([
  'lottery',
  'giveaway',
  'promo',
  'event',
  'floor',
  'other'
])

const SYSTEM_PROMPT =
  '你是社区活动与福利聚合助手。根据给定的论坛帖子标题、作者、分类、发帖参考时间与一楼正文，判断这是否是一个真实的【正在或即将进行的社区活动/抽奖/盖楼/免费派送/节日专题/限时促销】。' +
  '如果是纯晒奖贴、求助提问、二手单机转让、吐槽曝光或无关水贴，请将 isActivity 设为 false。' +
  '只输出合法 JSON 对象，不要 markdown 代码围栏或额外解释。JSON 字段契约：' +
  '{"isActivity":true或false,' +
  '"kind":"lottery|giveaway|promo|event|floor|other",' +
  '"summary":"50~120字精炼摘要（说明奖品/福利与参与规则）",' +
  '"organizer":"主办方或发帖人名称",' +
  '"prize":"奖品或优惠内容简述，无则null",' +
  '"participation":"参与方式简述，无则null",' +
  '"startsAtIso":"带时区的ISO8601开始时间，未知则null",' +
  '"endsAtIso":"带时区的ISO8601截止/开奖时间，按楼层开奖或未知则null",' +
  '"drawFloor":整数开奖楼层或null,' +
  '"tags":["最多4个简短中文标签"]}'

export interface AiExtractInput {
  title: string
  author: string
  category: string
  markdown: string
  referenceTimeMs: number
}

export interface AiActivityVerdict {
  isActivity: boolean
  kind: ActivityKind
  summary: string
  organizer: string
  prize: string | null
  participation: string | null
  startsAtEpochMillis: number | null
  endsAtEpochMillis: number | null
  drawFloor: number | null
  tags: string[]
}

export interface ActivityAiExtractorDeps {
  provider: Pick<AiProvider, 'chat'>
  now?: () => number
  logWarn?: (msg: string) => void
}

export class ActivityAiExtractor {
  private readonly provider: Pick<AiProvider, 'chat'>
  private readonly now: () => number
  private readonly logWarn?: (msg: string) => void
  private consecutiveFailures = 0
  private cooldownUntilMs = 0

  constructor(deps: ActivityAiExtractorDeps) {
    this.provider = deps.provider
    this.now = deps.now ?? (() => Date.now())
    this.logWarn = deps.logWarn
  }

  async extract(input: AiExtractInput): Promise<AiActivityVerdict | null> {
    if (this.now() < this.cooldownUntilMs) {
      return null
    }

    const refIso = formatLocalIsoWithOffset(new Date(input.referenceTimeMs))
    const userPayload = JSON.stringify({
      title: input.title,
      author: input.author,
      category: input.category,
      publishedAt: refIso,
      bodyExcerpt: input.markdown.slice(0, BODY_PROMPT_MAX_CHARS)
    })

    try {
      const raw = await this.provider.chat({
        system: SYSTEM_PROMPT,
        user: userPayload,
        jsonMode: true,
        disableThinking: true,
        timeoutMs: EXTRACT_TIMEOUT_MS,
        maxTokens: EXTRACT_MAX_TOKENS
      })
      const parsed = parseVerdictJson(raw, input.author)
      if (parsed === null) {
        this.noteFailure('AI activity extractor returned invalid JSON')
        return null
      }
      this.consecutiveFailures = 0
      this.cooldownUntilMs = 0
      return parsed
    } catch (err) {
      if (err instanceof AiProviderError && err.kind === 'unconfigured') {
        return null
      }
      const retrySec = err instanceof AiProviderError ? err.retryAfterSec : undefined
      this.noteFailure(
        `AI activity extraction failed: ${err instanceof Error ? err.message : String(err)}`,
        retrySec
      )
      return null
    }
  }

  private noteFailure(msg: string, retryAfterSec?: number): void {
    this.consecutiveFailures++
    const expMs = Math.min(
      BACKOFF_CAP_MS,
      BACKOFF_BASE_MS * Math.pow(2, Math.min(this.consecutiveFailures - 1, 6))
    )
    const upstreamMs =
      retryAfterSec !== undefined && Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? retryAfterSec * 1000
        : 0
    this.cooldownUntilMs = this.now() + Math.max(expMs, upstreamMs)
    this.logWarn?.(msg)
  }
}

function parseVerdictJson(raw: string, fallbackOrganizer: string): AiActivityVerdict | null {
  const jsonText = extractFirstJsonObject(raw)
  if (jsonText === null) return null
  let obj: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(jsonText)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    obj = parsed as Record<string, unknown>
  } catch {
    return null
  }

  if (typeof obj['isActivity'] !== 'boolean') return null
  const isActivity = obj['isActivity']
  const rawKind = typeof obj['kind'] === 'string' ? (obj['kind'].trim().toLowerCase() as ActivityKind) : 'other'
  const kind: ActivityKind = VALID_KINDS.has(rawKind) ? rawKind : 'other'

  const summary = typeof obj['summary'] === 'string' ? obj['summary'].replace(/\s+/g, ' ').trim().slice(0, 240) : ''
  const organizer =
    typeof obj['organizer'] === 'string' && obj['organizer'].trim() !== ''
      ? obj['organizer'].trim().slice(0, 80)
      : fallbackOrganizer.trim()

  const prize =
    typeof obj['prize'] === 'string' && obj['prize'].trim() !== ''
      ? obj['prize'].trim().slice(0, 120)
      : null
  const participation =
    typeof obj['participation'] === 'string' && obj['participation'].trim() !== ''
      ? obj['participation'].trim().slice(0, 140)
      : null

  const startsAtEpochMillis = parseOptionalIsoMs(obj['startsAtIso'])
  const endsAtEpochMillis = parseOptionalIsoMs(obj['endsAtIso'])

  const rawFloor = obj['drawFloor']
  const drawFloor =
    typeof rawFloor === 'number' && Number.isInteger(rawFloor) && rawFloor >= 2 && rawFloor <= 500_000
      ? rawFloor
      : null

  const tags = Array.isArray(obj['tags'])
    ? obj['tags']
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim().slice(0, 20))
        .filter((t) => t.length > 0)
        .slice(0, 5)
    : []

  return {
    isActivity,
    kind,
    summary,
    organizer,
    prize,
    participation,
    startsAtEpochMillis,
    endsAtEpochMillis,
    drawFloor,
    tags
  }
}

function parseOptionalIsoMs(val: unknown): number | null {
  if (typeof val !== 'string' || val.trim() === '') return null
  const ms = Date.parse(val.trim())
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

function extractFirstJsonObject(text: string): string | null {
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

function formatLocalIsoWithOffset(date: Date): string {
  const pad = (n: number): string => String(Math.abs(Math.trunc(n))).padStart(2, '0')
  const offsetMin = -date.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const hh = pad(Math.floor(Math.abs(offsetMin) / 60))
  const mm = pad(Math.abs(offsetMin) % 60)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${hh}:${mm}`
  )
}
