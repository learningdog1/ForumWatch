/**
 * 分类阶段报告（R17）：按分类（默认情报/交易/测评）对**全量话题存档**
 * （topics-store）做日/周/月三档 AI 总结。
 *
 * 与 ai.dailyReport **并存不替代**：日报=命中监控报告（数据面 hits/*.jsonl，
 * 监控视角，写 reports/YYYY-MM-DD.md）；本报告=分类行情报告（数据面 topics/
 * 存档，行情视角，写 reports/category/{kind}-<期键>.md）。数据底座、结构、
 * 开关、文件全部独立——现有 listReportDays 的 REPORT_FILE_RE 只认
 * `\d{4}-\d{2}-\d{2}\.md` 且 readdirSync 非递归，子目录名被正则滤掉，互不影响。
 *
 * 报告结构（文件全文）：标题（# 分类总结报告·<label>）→ AI 总述（或模板降级）
 * → 分类热点/趋势（确定性统计）→ 行情（extractDeal 分位表）→ 数据覆盖率
 * （确定性、可验证）→ 附录·全量帖子清单（确定性拼接，每帖一行保证不漏，
 * 附录行数与分类内帖子数严格相等）。
 *
 * LLM map-reduce 防漏（月报可达上千帖）：≤60 帖单次直出；>60 按时间序 60/段
 * 逐段小结（载荷只带 title/category/author/time/extractDeal 结果，不带 url/
 * 正文），全部成功后 reduce 汇总；任一段或 reduce 失败/空串 → **整体降级**为
 * 纯统计+全量清单模板并头注「模板模式（AI 不可用）」，绝不拼半成品；
 * provider 三项不齐同样降级；零帖不调 LLM 直接固定文案。分段数设上限
 * MAX_MAP_CHUNKS：串行 LLM × 每段 60s 超时，几千帖可占用数十分钟——超上限
 * 不走 map-reduce，直接降级确定性模板并在头注注明「体量过大」。
 *
 * 并发护栏：generate 按档位（kind）互斥——手动「立即生成」与定时 tick 撞在
 * 同档时**复用同一个进行中的 Promise**（同结果返回双方），绝不双份 LLM/写文件/
 * 推送；不同档位互不阻塞。tick 内单档 generate 硬失败（文件写失败等）log error
 * 后继续其余档位（attempts 已计数，失败仍占尝试额度）。
 *
 * 来源过滤语义：sourceIds 空 = **不按来源过滤**（全部来源）——sanitize 不回退
 * nodeseek（对只配 RSS/V2EX 的用户回退是悬挂 id，报告恒零帖）；覆盖率
 * coveredDays 同口径传 sourceIds（空 = 不过滤），D/T 的 D 与帖子过滤对齐。
 *
 * 推送：正文（总述~覆盖率）经 splitForTelegram 分段送 notifier.sendRaw，
 * **附录不推送**（月报附录数千行会刷屏，文件里全量）；推送失败只 log error
 * 不影响生成。shouldPush 可注入（样例脚本传 () => false 恒不推）；缺省按配置
 * 四联判定（总开关 × 该档开关 × notifyEnabled × anyChannelReady）。
 *
 * 日期口径：一律本地时区 Date 算术 + formatLocalDate（D5 坑④），绝不用 ISO
 * slice；周界用 setDate 回退（mondayOf）、月界用 new Date(y, m-1, 1) /
 * new Date(y, m, 0)（年末 12→1 由构造器回绕）。
 *
 * 零 electron 依赖；provider/archive/notifier 全部注入，单测全 mock。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { formatLocalDate } from '../monitor/hits-store'
import { buildCategoryStats, dayOfRecord, type CategoryStats } from '../monitor/category-stats'
import { extractDeal } from '../monitor/rules'
import { TOPIC_ARCHIVE_RETENTION_DAYS } from '../monitor/topics-store'
import { splitForTelegram } from './daily-report'
import type { AppConfig, TopicRecord } from '../../shared/types'
import type { Logger } from '../logger'
import { anyChannelReady } from '../notify/types'
import type { AiProvider } from './provider'

/** 报告档位：日 / 周（上一完整周，周一生成）/ 月（上一自然月，1 日生成） */
export type CategoryReportKind = 'daily' | 'weekly' | 'monthly'

/** 全部档位（固定序：tick 遍历与 UI 档位 tab 共用） */
export const CATEGORY_REPORT_KINDS: readonly CategoryReportKind[] = ['daily', 'weekly', 'monthly']

/** LLM 单段帖子数上限（map-reduce 的段大小；≤ 此值单次直出） */
export const CATEGORY_REPORT_CHUNK = 60
/**
 * map-reduce 分段数上限（可调）：串行 LLM、每段 60s 超时——段数无上限时几千帖
 * 可占用数十分钟（30 段 ≈ 1800 帖已是月报极端量）。超出即不走 LLM，直接降级
 * 确定性报告（统计 + 全量附录，头注「体量过大」）。
 */
export const MAX_MAP_CHUNKS = 30
/** LLM 请求超时（对齐 daily-report REPORT_TIMEOUT_MS 形态，量更大放宽） */
const REPORT_TIMEOUT_MS = 60000
/** LLM max_tokens（对齐 daily-report REPORT_MAX_TOKENS 形态，量更大放宽） */
const REPORT_MAX_TOKENS = 2000
/** 单期自动生成尝试上限（防 generate 持续失败死循环，对齐 daily-report 3 次） */
export const MAX_AUTO_ATTEMPTS_PER_PERIOD = 3
/** timeHHMM 解析失败回退（sanitize 已保证形状，防御性回退；按档错峰默认） */
const FALLBACK_TIME_HHMM: Record<CategoryReportKind, string> = {
  daily: '22:30',
  weekly: '08:00',
  monthly: '08:30'
}

/** daily/weekly 期键形状（本地 'YYYY-MM-DD'） */
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/
/** monthly 期键形状（'YYYY-MM'） */
const MONTH_KEY_RE = /^\d{4}-\d{2}$/

/** 一个报告期的确定性描述（periodFor 的返回） */
export interface CategoryReportPeriod {
  kind: CategoryReportKind
  /** 期键：daily/weekly=周日/当天日期 'YYYY-MM-DD'（weekly 取周日），monthly='YYYY-MM' */
  periodKey: string
  /** 期间起日（含，本地 'YYYY-MM-DD'） */
  from: string
  /** 期间止日（含） */
  to: string
  /** 展示标签：daily=日期 / weekly='MM-DD ~ MM-DD' / monthly='YYYY-MM' */
  label: string
}

/** onGenerated 回调载荷（桌面/headless 广播与 IPC 的 Stage B 消费形状） */
export interface CategoryReportGenerated {
  kind: CategoryReportKind
  periodKey: string
  /** 报告全文（含附录） */
  markdown: string
}

export interface CategoryReportDeps {
  provider: Pick<AiProvider, 'chat'>
  /** 全量话题存档（读面子集，测试/mock 只需这两个方法） */
  archive: {
    readRange(fromDate: string, toDate: string): Promise<TopicRecord[]>
    /**
     * 覆盖率口径的有数据天列表；sourceIds（可选，空/缺省 = 不过滤）把 D 的口径
     * 对齐到配置来源——「期间该来源集内任一天有数据」才算 covered。
     */
    coveredDays(fromDate: string, toDate: string, sourceIds?: string[]): Promise<string[]>
  }
  notifier: { sendRaw(text: string): Promise<void> }
  getConfig: () => AppConfig
  logger: Pick<Logger, 'info' | 'warn' | 'error'>
  /**
   * 报告目录（即 `<userData>/reports/category` 本身——与 DailyReportService 的
   * reportsDir 语义不同，装配方 join 好子目录后传入）；文件
   * `{kind}-{periodKey}.md`，writeFile 覆盖（手动重生成覆盖旧一期）。
   */
  reportsDir: string
  now?: () => number
  /** 生成成功后的广播回调（可选；Stage B 接 broadcaster/webBroadcast） */
  onGenerated?: (info: CategoryReportGenerated) => void
  /**
   * 推送判定钩子（样例脚本注入 () => false 恒不推——绝不构造真实推送路径）；
   * 缺省按配置四联判定（enabled × 档位 × notifyEnabled × anyChannelReady）。
   */
  shouldPush?: () => boolean
}

/**
 * 周期纯函数：**生成期恒为"刚结束的那个完整周期"**（与本轮 now 处于周内/月中
 * 的哪个位置无关）——daily=今天；weekly=上一完整周（周一~周日，key=周日日期）；
 * monthly=上一自然月（key='YYYY-MM'）。导出供测试与样例脚本复用。
 */
export function periodFor(
  kind: CategoryReportKind,
  nowArg?: Date
): CategoryReportPeriod {
  const now = nowArg ?? new Date()
  if (kind === 'daily') {
    const key = formatLocalDate(now)
    return { kind, periodKey: key, from: key, to: key, label: key }
  }
  if (kind === 'weekly') {
    // 本周一锚点（getDay 周日=0 → (day+6)%7 是距本周一的天数）；生成期 = 锚点
    // 前 7 天窗口（周一~周日）。周内任意时刻（含周日、周一 0 点后）都指向
    // 刚结束的那周——生成期与"今天"解耦，tick 只按周一目标时刻门控。
    const monday = new Date(now)
    monday.setDate(monday.getDate() - ((now.getDay() + 6) % 7))
    const start = new Date(monday)
    start.setDate(start.getDate() - 7)
    const end = new Date(monday)
    end.setDate(end.getDate() - 1)
    return {
      kind,
      periodKey: formatLocalDate(end),
      from: formatLocalDate(start),
      to: formatLocalDate(end),
      label: `${mmdd(start)} ~ ${mmdd(end)}`
    }
  }
  // monthly：上一自然月。new Date(y, m-1, 1) 在 m=0（一月）时回绕到上年 12 月；
  // new Date(y, m, 0) = 上月最后一天（day 0 = 前一个月的最后一天）。
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const end = new Date(now.getFullYear(), now.getMonth(), 0)
  const key = `${String(start.getFullYear()).padStart(4, '0')}-${String(start.getMonth() + 1).padStart(2, '0')}`
  return { kind, periodKey: key, from: formatLocalDate(start), to: formatLocalDate(end), label: key }
}

/** MM-DD（周报标签用） */
function mmdd(d: Date): string {
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 'HH:MM' → [时, 分]；非法形状回该档默认时刻 */
function parseHHMM(value: string, fallback: [number, number]): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (m === null) return fallback
  const hh = Number(m[1])
  const mm = Number(m[2])
  if (!Number.isInteger(hh) || hh > 23 || !Number.isInteger(mm) || mm > 59) return fallback
  return [hh, mm]
}

function fallbackHHMM(kind: CategoryReportKind): [number, number] {
  const [h, m] = FALLBACK_TIME_HHMM[kind].split(':')
  return [Number(h), Number(m)]
}

/** fromDate..toDate（含两端，本地日期串）的自然日数（逐日推进，DST 安全） */
function countDaysInclusive(from: string, to: string): number {
  const d = new Date(`${from}T00:00:00`)
  const end = new Date(`${to}T00:00:00`)
  let n = 0
  while (d.getTime() <= end.getTime()) {
    n++
    d.setDate(d.getDate() + 1)
  }
  return n
}

/** ISO 时刻 → 本地 HH:MM（附录条目展示用；解析失败 '--:--'） */
function hhmmLocal(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--:--'
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** provider 三项是否齐备（engine aiConfigured 同口径） */
function providerConfigured(cfg: AppConfig): boolean {
  const p = cfg.ai.provider
  return p.baseUrl.trim() !== '' && p.apiKey.trim() !== '' && p.model.trim() !== ''
}

export class CategoryReportService {
  private readonly deps: CategoryReportDeps
  private readonly now: () => number
  /** 各档自动尝试计数（内存；期键变化即清零——rollAttempts 的期键推广） */
  private readonly attempts = new Map<CategoryReportKind, { periodKey: string; count: number }>()
  /**
   * 各档进行中的生成 Promise（并发护栏）：手动「立即生成」与定时 tick 撞在
   * 同档时复用同一个进行中的 Promise（同一结果返回双方），绝不双份 LLM/写
   * 文件/推送；不同档位互不阻塞。settle 即出队（后续调用重新起一次生成）。
   */
  private readonly inFlight = new Map<CategoryReportKind, Promise<string>>()

  constructor(deps: CategoryReportDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
  }

  /**
   * 生成某档当前期的报告（手动「立即生成」同此入口：跳过 desired/attempts，
   * 覆盖重生成）。读存档 → 过滤（来源/分类/置顶）→ 确定性统计 → LLM 总结
   * （零帖不调；失败整体降级模板）→ 写文件 → 按配置推送正文 → onGenerated。
   * 文件写失败向上抛；LLM/推送失败都被内部消化。返回报告全文。
   *
   * 并发护栏：同档位已有进行中的生成时**不重新起生成**，直接复用该 Promise
   * （返回同一结果）；档位之间互不影响。带 nowArg 的调用同样受此约束（复用
   * 中的结果以先起的那次为准——并发场景下两次调用的 nowArg 本就不可兼得）。
   */
  async generate(kind: CategoryReportKind, nowArg?: Date): Promise<string> {
    const running = this.inFlight.get(kind)
    if (running !== undefined) return running
    const p = this.generateInternal(kind, nowArg)
    this.inFlight.set(kind, p)
    try {
      return await p
    } finally {
      // settle 即出队：无论成败，下一次 generate 重新起一次完整生成
      if (this.inFlight.get(kind) === p) this.inFlight.delete(kind)
    }
  }

  private async generateInternal(kind: CategoryReportKind, nowArg?: Date): Promise<string> {
    const now = nowArg ?? new Date(this.now())
    const period = periodFor(kind, now)
    const cfg = this.deps.getConfig()
    const cr = cfg.ai.categoryReport

    const all = await this.deps.archive.readRange(period.from, period.to)
    // 空 sourceIds = 不按来源过滤（全部来源；sanitize 不再回退 nodeseek）
    const sourceSet = new Set(cr.sourceIds)
    const catSet = new Set(cr.categories.map((c) => c.toLowerCase()))
    let pinnedExcluded = 0
    const records: TopicRecord[] = []
    for (const rec of all) {
      if (sourceSet.size > 0 && !sourceSet.has(rec.sourceId)) continue
      // 分类匹配：显示名或 slug 双口径、大小写不敏感（SourceFilters 同款）
      if (!catSet.has(rec.category.toLowerCase()) && !catSet.has(rec.categorySlug.toLowerCase())) {
        continue
      }
      if (rec.pinned) {
        pinnedExcluded++ // 置顶=旧帖，默认排除并在覆盖率段注明
        continue
      }
      records.push(rec)
    }

    // 覆盖率口径对齐配置来源：D = 期间该来源集内有数据的天（sourceIds 空 = 全部来源，现状口径）
    const covered = await this.deps.archive.coveredDays(period.from, period.to, cr.sourceIds)
    const totalDays = countDaysInclusive(period.from, period.to)
    const stats = buildCategoryStats(records)

    // LLM 总结（零帖不调；任一环节失败 → 整体降级，绝不拼半成品）
    const ai = await this.summarize(kind, period, records, cfg)
    const archiveShort = covered.length < totalDays

    const appendix = cr.appendix ? buildAppendix(records) : ''
    const body = [
      `# 分类总结报告·${period.label}`,
      '',
      ...(archiveShort
        ? [
            `> ⚠️ 存档不足：期间 ${covered.length}/${totalDays} 天有存档数据（保留窗口 ${TOPIC_ARCHIVE_RETENTION_DAYS} 天或来源当日缺数据），报告只覆盖已有数据。`,
            ''
          ]
        : []),
      ...(ai.degraded
        ? [
            ai.volumeCapped
              ? `> 模板模式（体量过大）：分类内帖子 ${records.length} 条超出 AI 总结分段上限（${MAX_MAP_CHUNKS} 段 × ${CATEGORY_REPORT_CHUNK} 帖/段），已降级为确定性统计 + 全量清单，无 AI 总结。`
              : '> 模板模式（AI 不可用）：以下为确定性统计 + 全量清单，无 AI 总结。',
            ''
          ]
        : []),
      // 零帖/降级时 markdown 为空串：不落空段（避免连续空行）
      ...(ai.markdown !== '' ? [ai.markdown, ''] : []),
      buildHotspotsSection(stats),
      '',
      buildTrendSection(stats),
      '',
      buildMarketSection(stats),
      '',
      buildCoverageSection({
        coveredDays: covered.length,
        totalDays,
        records: records.length,
        appendixEnabled: cr.appendix,
        pinnedExcluded,
        aiSegments: ai.segments,
        aiDegraded: ai.degraded,
        aiVolumeCapped: ai.volumeCapped,
        zeroRecords: records.length === 0
      })
    ].join('\n')
    const markdown = appendix !== '' ? `${body}\n\n${appendix}` : body

    await mkdir(this.deps.reportsDir, { recursive: true })
    await writeFile(this.reportPath(kind, period.periodKey), markdown, 'utf-8')
    this.deps.logger.info(
      `category report (${kind}) written: ${this.reportPath(kind, period.periodKey)} ` +
        `(${records.length} topics${ai.degraded ? ', template mode' : `, ${ai.segments} LLM call(s)`})`
    )

    await this.pushIfEnabled(kind, body)

    this.deps.onGenerated?.({ kind, periodKey: period.periodKey, markdown })
    return markdown
  }

  /**
   * 读某期报告；不存在（或读失败）返回 null，查询面不抛。期键形状按档校验
   * （daily/weekly 'YYYY-MM-DD'、monthly 'YYYY-MM'）——形状不合法（含路径穿越
   * 片段）同样 null。
   */
  async loadReport(kind: CategoryReportKind, periodKey: string): Promise<string | null> {
    if (!periodKeyShape(kind).test(periodKey)) return null
    try {
      return await readFile(this.reportPath(kind, periodKey), 'utf-8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        this.deps.logger.warn(`cannot read category report ${kind}-${periodKey}: ${describe(err)}`)
      }
      return null
    }
  }

  /** 某档已有报告的期键列表，新→旧；目录不存在 → [] */
  listPeriods(kind: CategoryReportKind): string[] {
    let names: string[]
    try {
      names = readdirSync(this.deps.reportsDir)
    } catch {
      return []
    }
    const prefix = `${kind}-`
    const shape = periodKeyShape(kind)
    return names
      .filter((name) => name.startsWith(prefix) && name.endsWith('.md'))
      .map((name) => name.slice(prefix.length, -'.md'.length))
      .filter((key) => shape.test(key))
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  }

  /**
   * 定时检查（daily-report tick 五联条件的期键推广，对三档各自判定）：
   * cfg.ai.categoryReport.enabled（总开关最先——关闭不生成、不调 LLM、不写
   * 文件、不消耗 attempts）且该档 enabled 且 now >= 本期目标时刻（daily=今天
   * timeHHMM / weekly=本周一 timeHHMM / monthly=本月 1 日 timeHHMM）且该期文件
   * 不存在且 desiredRunning 且本期尝试 < 3 → generate。
   * 补做语义：目标时刻过后当期内（当天/当周/当月）文件缺失仍触发——睡过头的
   * 机器次日凌晨仍补做上月月报；attempts 耗尽即放弃（文件存在性兜底重启语义）。
   * 单档隔离：某档 generate 硬失败（文件写失败等向上抛的错）log error 后继续
   * 同一 tick 里其后的档位（attempts 已先行计数，失败仍占尝试额度）。
   * @returns 是否有档位**成功**生成了报告（失败档不计入——headless 的
   *   「generated by timer tick」日志只该在真生成时出现）
   */
  async tick(desiredRunning: boolean, nowArg?: Date): Promise<boolean> {
    const cfg = this.deps.getConfig()
    if (!cfg.ai.categoryReport.enabled) return false
    const now = nowArg ?? new Date(this.now())
    let ran = false
    for (const kind of CATEGORY_REPORT_KINDS) {
      const section = cfg.ai.categoryReport[kind]
      if (!section.enabled) continue
      const period = periodFor(kind, now)
      this.rollAttempts(kind, period.periodKey)
      if (now.getTime() < this.periodTargetMs(kind, now, section.timeHHMM)) continue
      if (!desiredRunning) continue
      if ((this.attempts.get(kind)?.count ?? 0) >= MAX_AUTO_ATTEMPTS_PER_PERIOD) continue
      if ((await this.loadReport(kind, period.periodKey)) !== null) continue
      const count = (this.attempts.get(kind)?.count ?? 0) + 1
      this.attempts.set(kind, { periodKey: period.periodKey, count })
      this.deps.logger.info(
        `category report (${kind}) tick fired for ${period.periodKey} (attempt ${count})`
      )
      try {
        await this.generate(kind, now)
        ran = true
      } catch (err) {
        // 单档失败不中断后续档：log error 后继续（attempts 已计数，失败仍占额度）
        this.deps.logger.error(
          `category report (${kind}) tick generate failed for ${period.periodKey}: ${describe(err)}`
        )
      }
    }
    return ran
  }

  /**
   * 下一次应检查时刻（epoch ms）：三档（enabled 总开关 + 档位开关均开）的下次
   * 目标时刻最小值；某档本期目标时刻已过 → 取其下一期目标（跨天/周/月滚动）。
   * 全关（含总开关）返回 Infinity。装配方与日报定时器取 min 后 clamp。
   */
  nextCheckAt(nowArg?: Date): number {
    const cfg = this.deps.getConfig()
    if (!cfg.ai.categoryReport.enabled) return Infinity
    const now = nowArg ?? new Date(this.now())
    let min = Infinity
    for (const kind of CATEGORY_REPORT_KINDS) {
      const section = cfg.ai.categoryReport[kind]
      if (!section.enabled) continue
      const target = this.periodTargetMs(kind, now, section.timeHHMM)
      const next = now.getTime() < target ? target : this.nextPeriodTargetMs(kind, now, section.timeHHMM)
      if (next < min) min = next
    }
    return min
  }

  // ---- 内部实现 ----------------------------------------------------------

  private reportPath(kind: CategoryReportKind, periodKey: string): string {
    return join(this.deps.reportsDir, `${kind}-${periodKey}.md`)
  }

  /** 本期目标时刻：daily=今天 / weekly=本周一 / monthly=本月 1 日，各 at timeHHMM */
  private periodTargetMs(kind: CategoryReportKind, now: Date, timeHHMM: string): number {
    const [hh, mm] = parseHHMM(timeHHMM, fallbackHHMM(kind))
    const target = anchorDateOf(kind, now)
    target.setHours(hh, mm, 0, 0)
    return target.getTime()
  }

  /** 下一期目标时刻（本期已过后的滚动：明天 / 下周一 / 下月 1 日） */
  private nextPeriodTargetMs(kind: CategoryReportKind, now: Date, timeHHMM: string): number {
    const [hh, mm] = parseHHMM(timeHHMM, fallbackHHMM(kind))
    const anchor = anchorDateOf(kind, now)
    if (kind === 'daily') anchor.setDate(anchor.getDate() + 1)
    else if (kind === 'weekly') anchor.setDate(anchor.getDate() + 7)
    else anchor.setMonth(anchor.getMonth() + 1)
    anchor.setHours(hh, mm, 0, 0)
    return anchor.getTime()
  }

  /** attempts 计数的期键翻转（期键变化即清零；内存态，重启清零由文件存在性兜底） */
  private rollAttempts(kind: CategoryReportKind, periodKey: string): void {
    const cur = this.attempts.get(kind)
    if (cur === undefined || cur.periodKey !== periodKey) {
      this.attempts.set(kind, { periodKey, count: 0 })
    }
  }

  /**
   * LLM 总结：零帖不调返回空串；provider 未配置 / 帖量超分段上限 / 单发或任一
   * 段/reduce 失败或空串 → { degraded: true, markdown: '', segments: 0 }（整体
   * 降级，绝不拼半成品；volumeCapped 标记体量降级供头注区分文案）。
   * >CHUNK 帖按时间序 60/段 map + reduce，段数以 MAX_MAP_CHUNKS 为上限。
   */
  private async summarize(
    kind: CategoryReportKind,
    period: CategoryReportPeriod,
    records: TopicRecord[],
    cfg: AppConfig
  ): Promise<{ markdown: string; degraded: boolean; segments: number; volumeCapped: boolean }> {
    if (records.length === 0) {
      return { markdown: '本期分类内无帖子。', degraded: false, segments: 0, volumeCapped: false }
    }
    if (!providerConfigured(cfg)) {
      this.deps.logger.warn('category report: AI provider not configured, using template')
      return { markdown: '', degraded: true, segments: 0, volumeCapped: false }
    }
    // 体量上限：串行 LLM × 每段 60s 超时，段数无上限时几千帖可占数十分钟——
    // 超上限不走 map-reduce，直接确定性降级（头注「体量过大」）
    if (Math.ceil(records.length / CATEGORY_REPORT_CHUNK) > MAX_MAP_CHUNKS) {
      this.deps.logger.warn(
        `category report: ${records.length} topics exceed map-reduce cap ` +
          `(${MAX_MAP_CHUNKS} segments x ${CATEGORY_REPORT_CHUNK}), degrading to template`
      )
      return { markdown: '', degraded: true, segments: 0, volumeCapped: true }
    }
    try {
      if (records.length <= CATEGORY_REPORT_CHUNK) {
        const out = await this.chatSummarize(kind, period, records)
        if (out.trim() === '') throw new Error('LLM returned empty content')
        return { markdown: out, degraded: false, segments: 1, volumeCapped: false }
      }
      // map：按时间序（records 已旧→新）60/段逐段小结（段数已被上限拦过）
      const chunks: TopicRecord[][] = []
      for (let i = 0; i < records.length; i += CATEGORY_REPORT_CHUNK) {
        chunks.push(records.slice(i, i + CATEGORY_REPORT_CHUNK))
      }
      const summaries: string[] = []
      for (let i = 0; i < chunks.length; i++) {
        const s = await this.chatChunkSummary(kind, period, i + 1, chunks.length, chunks[i]!)
        if (s.trim() === '') throw new Error(`LLM returned empty content for segment ${i + 1}`)
        summaries.push(s)
      }
      // reduce：全部段成功后汇总（任一段失败已在上方抛出，不会带半成品进来）
      const final = await this.chatReduce(kind, period, summaries)
      if (final.trim() === '') throw new Error('LLM returned empty content for reduce')
      return { markdown: final, degraded: false, segments: chunks.length + 1, volumeCapped: false }
    } catch (err) {
      this.deps.logger.warn(
        `category report LLM failed, using fallback template: ${describe(err)}`
      )
      return { markdown: '', degraded: true, segments: 0, volumeCapped: false }
    }
  }

  /** ≤CHUNK 帖：单次直出完整总结（总述 + 热点 + 趋势三段式） */
  private chatSummarize(
    kind: CategoryReportKind,
    period: CategoryReportPeriod,
    records: TopicRecord[]
  ): Promise<string> {
    const system =
      '根据论坛帖子存档生成中文分类行情总结（markdown）。结构：先一段总述（帖子量、' +
      '主要话题与氛围），再「## 分类热点」按分类归纳讨论热点（引用代表性标题），' +
      '最后「## 趋势」给跨帖信号（重复出现的话题、活跃作者、价格走势）。只输出 markdown。'
    return this.deps.provider.chat({
      system,
      user: JSON.stringify(this.llmPayload(kind, period, records)),
      timeoutMs: REPORT_TIMEOUT_MS,
      maxTokens: REPORT_MAX_TOKENS
    })
  }

  /** >CHUNK 帖的段小结（载荷只带元数据，不带 url/正文） */
  private chatChunkSummary(
    kind: CategoryReportKind,
    period: CategoryReportPeriod,
    segIndex: number,
    segTotal: number,
    records: TopicRecord[]
  ): Promise<string> {
    const system =
      `这是论坛帖子存档分段时间总结的第 ${segIndex}/${segTotal} 段。用中文 markdown ` +
      '小结该段帖子：一段概述（帖子量与话题）+ 要点列表（代表性标题与信号）。只输出 markdown。'
    return this.deps.provider.chat({
      system,
      user: JSON.stringify(this.llmPayload(kind, period, records)),
      timeoutMs: REPORT_TIMEOUT_MS,
      maxTokens: REPORT_MAX_TOKENS
    })
  }

  /** reduce：全部段小结成功后汇总为完整总结 */
  private chatReduce(
    kind: CategoryReportKind,
    period: CategoryReportPeriod,
    summaries: string[]
  ): Promise<string> {
    const system =
      '根据分段时间小结汇总成完整的中文分类行情总结（markdown）。结构：先一段总述' +
      '（帖子量、主要话题与氛围），再「## 分类热点」按分类归纳讨论热点，最后「## 趋势」' +
      '给跨帖信号（重复话题、活跃作者、价格走势）。只输出 markdown，不要提及分段过程。'
    return this.deps.provider.chat({
      system,
      user: JSON.stringify({ period: period.label, kind, segments: summaries }),
      timeoutMs: REPORT_TIMEOUT_MS,
      maxTokens: REPORT_MAX_TOKENS
    })
  }

  /** LLM 载荷：title/category/author/time/extractDeal 结果（不带 url/正文） */
  private llmPayload(
    kind: CategoryReportKind,
    period: CategoryReportPeriod,
    records: TopicRecord[]
  ): Record<string, unknown> {
    return {
      kind,
      period: period.label,
      total: records.length,
      topics: records.map((r) => ({
        time: hhmmLocal(r.firstSeenAt),
        // 归属日优先记录内 day 字段（写入时本地日，防事后改时区归日漂移）
        date: dayOfRecord(r),
        title: r.title,
        category: r.category,
        author: r.author,
        deal: extractDeal(r.title)
      }))
    }
  }

  /** 按配置推送正文（总述~覆盖率，**不含附录**）；分段送 sendRaw；失败只 log error */
  private async pushIfEnabled(kind: CategoryReportKind, body: string): Promise<void> {
    if (!this.shouldPushNow(kind)) return
    const chunks = splitForTelegram(body)
    try {
      for (const chunk of chunks) await this.deps.notifier.sendRaw(chunk)
      this.deps.logger.info(`category report (${kind}) pushed (${chunks.length} message(s))`)
    } catch (err) {
      this.deps.logger.error(`category report (${kind}) push failed: ${describe(err)}`)
    }
  }

  /** 推送判定：shouldPush 注入优先（样例脚本恒 false）；缺省四联（配置 × 档位 × notifyEnabled × 通道就绪） */
  private shouldPushNow(kind: CategoryReportKind): boolean {
    if (this.deps.shouldPush !== undefined) return this.deps.shouldPush()
    const cfg = this.deps.getConfig()
    const cr = cfg.ai.categoryReport
    return cr.enabled && cr[kind].enabled && cfg.notifyEnabled && anyChannelReady(cfg.channels)
  }
}

/** 档位的期键形状（loadReport 防路径穿越 + listPeriods 过滤共用） */
function periodKeyShape(kind: CategoryReportKind): RegExp {
  return kind === 'monthly' ? MONTH_KEY_RE : DATE_KEY_RE
}

/** 档位的目标时刻锚点日：daily=今天 / weekly=本周一 / monthly=本月 1 日（时分清零由调用方 set） */
function anchorDateOf(kind: CategoryReportKind, now: Date): Date {
  const d = new Date(now)
  if (kind === 'daily') return d
  if (kind === 'weekly') {
    d.setDate(d.getDate() - ((now.getDay() + 6) % 7))
    return d
  }
  d.setDate(1)
  return d
}

// ---- 确定性段落渲染（模板模式的降级文案与正常模式的统计段共用同一实现） ----

/** 分类热点：分类计数概览 + 每日分布（分类×日矩阵的确定性渲染） */
function buildHotspotsSection(stats: CategoryStats): string {
  const lines: string[] = ['## 分类热点', '']
  if (stats.total === 0) {
    lines.push('本期无帖子。')
    return lines.join('\n')
  }
  const catTotals = stats.matrix.categories.map((c, i) => ({
    category: c,
    count: stats.matrix.counts.reduce((sum, row) => sum + (row[i] ?? 0), 0)
  }))
  lines.push(
    `共 ${stats.total} 条：` +
      catTotals.map((c) => `${c.category} ×${c.count}`).join('、') +
      '。'
  )
  lines.push('')
  lines.push('| 日期 | ' + stats.matrix.categories.join(' | ') + ' |')
  lines.push('| --- | ' + stats.matrix.categories.map(() => '---').join(' | ') + ' |')
  stats.matrix.days.forEach((day, i) => {
    lines.push(`| ${day} | ` + stats.matrix.counts[i]!.join(' | ') + ' |')
  })
  return lines.join('\n')
}

/** 趋势：同帖多发（normalizeTitle 归并 ≥2 次）+ 作者 Top10 */
function buildTrendSection(stats: CategoryStats): string {
  const lines: string[] = ['## 趋势', '']
  if (stats.repeatedTitles.length > 0) {
    lines.push('同帖多发（标题归一后出现 ≥2 次，热门信号）：')
    for (const t of stats.repeatedTitles) lines.push(`- ×${t.count} ${t.title}`)
  } else {
    lines.push('本期无明显同帖多发。')
  }
  lines.push('')
  if (stats.topAuthors.length > 0) {
    lines.push('活跃作者 Top：')
    lines.push(stats.topAuthors.map((a) => `${a.author}（${a.count}）`).join('、'))
  }
  return lines.join('\n')
}

/** 行情：extractDeal 分位表（cycle×currency）；零样本如实写「未解析出结构化价格」 */
function buildMarketSection(stats: CategoryStats): string {
  const lines: string[] = ['## 行情（结构化价格）', '']
  if (stats.dealGroups.length === 0) {
    lines.push('本期未解析出结构化价格（标题无可识别的周期/币种价格形态）。')
    return lines.join('\n')
  }
  lines.push('| 分组 | 样本 | 最低 | P25 | 中位 | P75 | 最高 | 流量中位(GB) |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const g of stats.dealGroups) {
    lines.push(
      `| ${g.group} | ${g.samples} | ${fmtPrice(g.min)} | ${fmtPrice(g.p25)} | ${fmtPrice(g.median)} | ${fmtPrice(g.p75)} | ${fmtPrice(g.max)} | ${g.trafficMedianGB === null ? '—' : g.trafficMedianGB} |`
    )
  }
  return lines.join('\n')
}

function fmtPrice(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

/** 覆盖率说明（确定性、防漏可验证）：附录行数与 N 严格相等由 buildAppendix 保证 */
function buildCoverageSection(info: {
  coveredDays: number
  totalDays: number
  records: number
  appendixEnabled: boolean
  pinnedExcluded: number
  aiSegments: number
  aiDegraded: boolean
  aiVolumeCapped: boolean
  zeroRecords: boolean
}): string {
  const lines: string[] = ['## 数据覆盖率', '']
  lines.push(`- 存档 ${info.coveredDays}/${info.totalDays} 天有数据（期间各日存档完整性）。`)
  lines.push(
    info.appendixEnabled
      ? `- 分类内帖子 ${info.records} 条已全部列入附录（附录行数与该数严格相等）。`
      : `- 分类内帖子 ${info.records} 条（附录已关闭，未附全量清单）。`
  )
  if (info.pinnedExcluded > 0) {
    lines.push(`- 置顶帖 ${info.pinnedExcluded} 条已排除（置顶=旧帖，非本期新发）。`)
  }
  if (info.zeroRecords) {
    lines.push('- AI 总结：未调用（本期无帖子）。')
  } else if (info.aiDegraded && info.aiVolumeCapped) {
    lines.push('- AI 总结：因体量超出分段上限·模板模式（统计与清单为确定性生成，无信息缺失）。')
  } else if (info.aiDegraded) {
    lines.push('- AI 总结：AI 不可用·模板模式（统计与清单为确定性生成，无信息缺失）。')
  } else {
    lines.push(`- AI 总结覆盖 ${info.records}/${info.records}（分段 ${info.aiSegments} 段全部成功）。`)
  }
  return lines.join('\n')
}

/** 附录·全量帖子清单：按日分组，每帖一行（确定性拼接保证不漏） */
function buildAppendix(records: TopicRecord[]): string {
  if (records.length === 0) return ''
  const byDay = new Map<string, TopicRecord[]>()
  for (const rec of records) {
    // 归属日优先记录内 day 字段（写入时本地日），旧记录回退 firstSeenAt 重算
    const day = dayOfRecord(rec) || '未知日期'
    const list = byDay.get(day)
    if (list === undefined) byDay.set(day, [rec])
    else list.push(rec)
  }
  const lines: string[] = ['## 附录·全量帖子清单', '']
  for (const day of [...byDay.keys()].sort()) {
    lines.push(`### ${day}`, '')
    for (const rec of byDay.get(day)!) {
      const cat = rec.category !== '' ? rec.category : '未分类'
      lines.push(`- ${hhmmLocal(rec.firstSeenAt)} [${cat}] ${rec.title}（${rec.author}） ${rec.url}`)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
