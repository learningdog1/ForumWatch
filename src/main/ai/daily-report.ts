/**
 * AI 每日总结（D5）：读当天命中 JSONL → LLM 生成中文 markdown 日报 →
 * 写 `reports/<本地日期>.md` → 按配置用 TelegramNotifier.sendRaw 推送 →
 * onGenerated 广播。
 *
 * - 零命中 → 固定文案"今日无命中"，**不调 LLM**（心跳推送仍有）。
 * - LLM 失败 → **降级固定模板**（按命中列表机械拼接）并 log warn——
 *   日报不许因 LLM 挂掉而失败；文件写失败才向上抛。
 * - 日期口径一律本地时区（formatLocalDate，D5 坑清单④：ISO slice 是 UTC）。
 * - 文件名 `YYYY-MM-DD.md`，直接 writeFile 覆盖（日报允许手动重新生成覆盖）。
 * - 推送条件：cfg.ai.dailyReport.enabled 且 telegram 配置完整且 notifyEnabled；
 *   推送失败只 log error 不影响返回值。分段：>3500（UTF-16 口径 text.length）
 *   按行边界聚合切分，续段尾缀"（续 N）"。
 * - tick（定时检查）：cfg.ai.dailyReport.enabled（功能总开关，关闭时到点不
 *   生成——不调 LLM、不写文件、不消耗 attempts；手动 generate 不受影响）且
 *   now >= 今天 timeHHMM 且 reports/<today>.md 不存在且 desired==='running'
 *   （入参）且当日自动尝试 < 3 次 → generate。attempts 计数
 *   在内存，本地自然日翻转清零（formatLocalDate 判日）。
 * - nextCheckAt：下一次应检查的时刻（今天 timeHHMM 已过 → 明天同一时刻），
 *   装配方用它排 setTimeout（实际 sleep 由装配方 clamp，本模块不管节流）。
 *
 * 零 electron 依赖；provider/hits/notifier 全部注入，单测全 mock。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { formatLocalDate } from '../monitor/hits-store'
import type {
  AppConfig,
  DailyReportInfo,
  HitRecord
} from '../../shared/types'
import type { Logger } from '../logger'
import type { AiProvider } from './provider'

/** 日报 LLM 请求超时（D5） */
const REPORT_TIMEOUT_MS = 30000
/** 日报 LLM max_tokens */
const REPORT_MAX_TOKENS = 1500
/** Telegram 单段长度上限（UTF-16 口径，TG 上限 4096，取 3500 留余量，D5） */
export const TELEGRAM_CHUNK_MAX = 3500
/** 续段尾缀预留长度（"（续 N）"） */
const CHUNK_SUFFIX_RESERVE = 12
/** 当日自动生成尝试上限（D5：防 generate 持续失败死循环） */
export const MAX_AUTO_ATTEMPTS_PER_DAY = 3
/** timeHHMM 解析失败回退（ConfigStore sanitize 已保证形状，防御性回退） */
const FALLBACK_TIME_HHMM = '22:00'

const REPORT_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/

export interface DailyReportDeps {
  provider: Pick<AiProvider, 'chat'>
  hits: { readDay(dateLocal: string): Promise<HitRecord[]> }
  notifier: { sendRaw(text: string): Promise<void> }
  getConfig: () => AppConfig
  logger: Pick<Logger, 'info' | 'warn' | 'error'>
  /** <userData>/reports（构造方 join 好） */
  reportsDir: string
  now?: () => number
  /** 生成成功后的广播回调（桌面：broadcaster.report；可选） */
  onGenerated?: (info: DailyReportInfo) => void
}

export class DailyReportService {
  private readonly deps: DailyReportDeps
  private readonly now: () => number
  /** 当日自动尝试计数（内存；formatLocalDate 判日翻转清零） */
  private attemptsDay = ''
  private attempts = 0

  constructor(deps: DailyReportDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
  }

  /**
   * 生成今天日报：读 hits/<today>.jsonl → LLM 总结（零命中走固定文案不调
   * LLM）→ 写 reports/<today>.md → 按 cfg 推送 → 广播回调。返回 markdown。
   * 文件写失败向上抛（LLM/推送失败都被内部消化）。
   */
  async generate(nowArg?: Date): Promise<string> {
    const now = nowArg ?? new Date(this.now())
    const today = formatLocalDate(now)
    const hits = await this.deps.hits.readDay(today)

    let markdown: string
    if (hits.length === 0) {
      markdown = noHitReport(today)
    } else {
      try {
        markdown = await this.summarize(today, hits)
        // provider 契约：content 空串是"合法"响应——但空日报没有任何信息量，
        // 与 LLM 失败同等处理（降级模板），也避免向 TG 发空消息被 400 拒
        if (markdown.trim() === '') throw new Error('LLM returned empty content')
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        this.deps.logger.warn(`daily report LLM failed, using fallback template: ${detail}`)
        markdown = fallbackReport(today, hits)
      }
    }

    await mkdir(this.deps.reportsDir, { recursive: true })
    await writeFile(this.reportPath(today), markdown, 'utf-8')
    this.deps.logger.info(`daily report written: ${this.reportPath(today)} (${hits.length} hits)`)

    await this.pushIfEnabled(markdown)

    this.deps.onGenerated?.({ date: today, markdown })
    return markdown
  }

  /** 读某天日报；不存在（或读失败）返回 null，查询面不抛。日期形状不合法（含路径穿越片段）同样 null */
  async loadReport(dateLocal: string): Promise<string | null> {
    if (!REPORT_FILE_RE.test(`${dateLocal}.md`)) return null
    try {
      return await readFile(this.reportPath(dateLocal), 'utf-8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        this.deps.logger.warn(`cannot read report ${dateLocal}: ${describe(err)}`)
      }
      return null
    }
  }

  /** 已有日报的日期列表，新→旧；目录不存在 → [] */
  listReportDays(): string[] {
    let names: string[]
    try {
      names = readdirSync(this.deps.reportsDir)
    } catch {
      return []
    }
    return names
      .filter((name) => REPORT_FILE_RE.test(name))
      .map((name) => name.slice(0, -'.md'.length))
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  }

  /**
   * 定时检查（D5 触发条件，审查后五联）：cfg.ai.dailyReport.enabled（总开关）
   * 且 now >= 今天 timeHHMM 且 reports/<today>.md 不存在且 desiredRunning 且
   * 当日自动尝试 < 3 → generate。开关关闭在最前——不生成、不调 LLM、不写
   * 文件、不消耗 attempts；手动 generate（「今日回顾 → 立即生成」）不受影响。
   * @returns 是否执行了生成
   */
  async tick(desiredRunning: boolean, nowArg?: Date): Promise<boolean> {
    // 功能总开关（F1）：关闭时到点也绝不自动生成（attempts 不动，重新开启后
    // 当天仍可正常触发）
    if (!this.deps.getConfig().ai.dailyReport.enabled) return false
    const now = nowArg ?? new Date(this.now())
    const today = formatLocalDate(now)
    this.rollAttemptsDay(today)
    if (!desiredRunning) return false
    if (now.getTime() < this.todayTargetMs(now)) return false
    if (this.attempts >= MAX_AUTO_ATTEMPTS_PER_DAY) return false
    if ((await this.loadReport(today)) !== null) return false
    this.attempts++
    this.deps.logger.info(`daily report tick fired for ${today} (attempt ${this.attempts})`)
    await this.generate(now)
    return true
  }

  /**
   * 下一次应检查时刻（epoch ms）：今天 timeHHMM 未到 → 今天；已到/已过 →
   * 明天同一时刻（跨天自动滚动）。装配方按它排 setTimeout。
   */
  nextCheckAt(nowArg?: Date): number {
    const now = nowArg ?? new Date(this.now())
    const todayTarget = this.todayTargetMs(now)
    if (now.getTime() < todayTarget) return todayTarget
    const tomorrow = new Date(now)
    tomorrow.setDate(tomorrow.getDate() + 1)
    return this.todayTargetMs(tomorrow)
  }

  // ---- 内部实现 ----------------------------------------------------------

  private reportPath(dateLocal: string): string {
    return join(this.deps.reportsDir, `${dateLocal}.md`)
  }

  /** LLM 总结：命中摘要 JSON → 中文 markdown（失败向上抛，由 generate 降级） */
  private async summarize(date: string, hits: HitRecord[]): Promise<string> {
    const payload = {
      date,
      total: hits.length,
      hits: hits.map((h) => ({
        time: h.notifiedAt,
        title: h.topic.title,
        category: h.topic.category,
        sourceId: h.topic.sourceId,
        matchedBy: h.matchedBy,
        // 第五轮：规则命中的 label（旧 hits/*.jsonl 行没有该字段，?? null 归一）
        matchedRule: h.matchedRule ?? null,
        // 第三轮锐评：旧 hits/*.jsonl 行没有该字段，?? null 归一（LLM 按需引用）
        commentary: h.commentary ?? null,
        pushed: h.notifiedAt !== null
      }))
    }
    const system =
      '根据命中记录生成中文监控日报，markdown 格式，结构：一段总述（几条命中、' +
      '主要话题）+ 分来源/分类的要点列表（标题、时间、命中方式），结尾一句数据说明' +
      '（AI 生成）。命中如带锐评（commentary 字段），在要点中用一句话引用它。' +
      '只输出 markdown。'
    return this.deps.provider.chat({
      system,
      user: JSON.stringify(payload),
      timeoutMs: REPORT_TIMEOUT_MS,
      maxTokens: REPORT_MAX_TOKENS
    })
  }

  /** 按配置推送：分段送 notifier.sendRaw；失败只 log error，不影响 generate 返回 */
  private async pushIfEnabled(markdown: string): Promise<void> {
    const cfg = this.deps.getConfig()
    const configured = cfg.telegram.botToken !== '' && cfg.telegram.chatId !== ''
    if (!cfg.ai.dailyReport.enabled || !cfg.notifyEnabled || !configured) return
    const chunks = splitForTelegram(markdown)
    try {
      for (const chunk of chunks) await this.deps.notifier.sendRaw(chunk)
      this.deps.logger.info(`daily report pushed (${chunks.length} message(s))`)
    } catch (err) {
      this.deps.logger.error(`daily report push failed: ${describe(err)}`)
    }
  }

  /** 今天 timeHHMM 对应的 epoch ms（timeHHMM 非法回退 22:00） */
  private todayTargetMs(now: Date): number {
    const [hh, mm] = parseHHMM(this.deps.getConfig().ai.dailyReport.timeHHMM)
    const target = new Date(now)
    target.setHours(hh, mm, 0, 0)
    return target.getTime()
  }

  /** attempts 计数的本地自然日翻转（formatLocalDate 判日，D5 坑清单④） */
  private rollAttemptsDay(today: string): void {
    if (this.attemptsDay !== today) {
      this.attemptsDay = today
      this.attempts = 0
    }
  }
}

/** 'HH:MM' → [时, 分]；非法形状回退 [22, 0] */
function parseHHMM(value: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (m === null) return [22, 0]
  const hh = Number(m[1])
  const mm = Number(m[2])
  if (!Number.isInteger(hh) || hh > 23 || !Number.isInteger(mm) || mm > 59) {
    return parseHHMM(FALLBACK_TIME_HHMM)
  }
  return [hh, mm]
}

/** 零命中固定文案（不调 LLM；心跳推送仍有） */
function noHitReport(date: string): string {
  return [
    `# ForumWatch 监控日报 · ${date}`,
    '',
    '今日无命中。',
    '',
    '—— 数据说明：本日报由 ForumWatch 自动生成。'
  ].join('\n')
}

/** 降级固定模板：按命中列表机械拼接的 markdown（LLM 失败时兜底） */
function fallbackReport(date: string, hits: HitRecord[]): string {
  const lines: string[] = [
    `# ForumWatch 监控日报 · ${date}`,
    '',
    `共 ${hits.length} 条命中。`,
    ''
  ]
  let lastSource: string | null = null
  for (const h of hits) {
    if (h.topic.sourceId !== lastSource) {
      lastSource = h.topic.sourceId
      lines.push(`## ${lastSource}`, '')
    }
    const time = h.notifiedAt !== null ? hhmmLocal(h.notifiedAt) : '--:--'
    // 命中方式三档（第五轮）：语义 / 价格规则（带 label）/ 字面
    const ruleLabel = h.matchedRule ?? ''
    const how =
      h.matchedBy === 'semantic'
        ? '语义命中'
        : h.matchedBy === 'rule'
          ? ruleLabel !== ''
            ? `规则命中：${ruleLabel}`
            : '规则命中'
          : '字面命中'
    // 第三轮锐评：非空时以「」附在命中行尾；无（含旧记录缺字段 → null）不加
    const commentary = h.commentary ?? null
    const remark = commentary !== null && commentary !== '' ? `「${commentary}」` : ''
    lines.push(`- ${time} [${h.topic.category}] ${h.topic.title}（${how}）${remark}`)
  }
  lines.push('', '—— 数据说明：本日报由 ForumWatch 按命中记录自动生成（模板模式）。')
  return lines.join('\n')
}

/** ISO 时间 → 本地 HH:MM（日报条目展示用；解析失败原样截断） */
function hhmmLocal(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(11, 16)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * Telegram 分段：>3500（UTF-16 口径 text.length）按**行边界**聚合切分，
 * 第 N 段（N>1）尾缀"（续 N）"。单行超上限时对该行硬切（不能丢内容）。
 */
export function splitForTelegram(text: string, maxLen = TELEGRAM_CHUNK_MAX): string[] {
  if (text.length <= maxLen) return [text]
  const parts: string[] = []
  let current = ''
  for (const line of text.split('\n')) {
    // 单行自身超上限：先把 current 收掉，再对该行硬切
    if (line.length > maxLen - CHUNK_SUFFIX_RESERVE) {
      if (current !== '') {
        parts.push(current)
        current = ''
      }
      for (let i = 0; i < line.length; i += maxLen - CHUNK_SUFFIX_RESERVE) {
        parts.push(line.slice(i, i + maxLen - CHUNK_SUFFIX_RESERVE))
      }
      continue
    }
    const candidate = current === '' ? line : `${current}\n${line}`
    if (candidate.length > maxLen - CHUNK_SUFFIX_RESERVE) {
      parts.push(current)
      current = line
    } else {
      current = candidate
    }
  }
  if (current !== '') parts.push(current)
  // 第 2 段起加尾缀（预留长度已在聚合时扣掉，总长仍 ≤ maxLen）
  return parts.map((p, i) => (i === 0 ? p : `${p}（续 ${i + 1}）`))
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
