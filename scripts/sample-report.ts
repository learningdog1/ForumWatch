/**
 * 分类阶段报告样例脚本（R17，tsx 直跑，零 Electron）：
 *
 *   npm run sample:report -- --config <dir> --kind daily|weekly|monthly \
 *     [--date YYYY-MM-DD] [--out <dir>] [--out-file <path>] [--no-ai]
 *
 * 从既有用户数据目录**只读**生成一份分类报告样例（不落用户目录、绝不推送）：
 * - ConfigStore.load() 只读不 save（headless.ts 同款 PlainSecretBox）；
 * - TopicArchiveStore readonly 模式（跳过 mkdir/cleanup、record 短路）；
 * - **混合口径降级**：topics/ 全量话题存档刚上线、旧数据目录可能还没有——
 *   topics/ 不存在或期间无日桶时，回退用 hits/*.jsonl（命中监控面，只含命中
 *   帖但字段同构）**在内存里派生** TopicRecord 喂同一 service 代码路径，输出
 *   文件头注明「hits 派生混合口径」。两者都没有 → 零帖报告（如实呈现）；
 * - AiProvider 复用真实装配（provider 未配置 → service 自动降级模板）；
 *   --no-ai 注入恒抛 provider 强制走降级路径（模板模式验证）；
 * - **绝不推送**：CategoryReportDeps.shouldPush 注入 () => false，且不构造
 *   任何 notifier/engine/scheduler——notifier 槽位放一个"被调即抛"的哨兵，
 *   推送路径若被意外触发会立刻在 stdout 爆出（防回归的运行时护栏）。
 *
 * --date 锚定"今天"（缺省系统当前日期）→ periodFor(kind, new Date(date+'T12:00:00'))
 * （取正午避开 DST 边界）。输出写 <out>/sample-<kind>-<periodKey>.md（--out 缺省
 * ./out/sample-reports/，与构建产物 out/ 目录互不干扰——该目录已是既有忽略物）；
 * --out-file 覆盖输出文件名（相对 cwd；两份样例报告要固定文件名时用）。
 * stdout 打印输出路径、period 区间、数据口径、覆盖率行与是否降级。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ConfigStore } from '../src/main/config/store'
import { PlainSecretBox } from '../src/main/config/secrets'
import { HttpClient } from '../src/main/net/http'
import { AiProvider } from '../src/main/ai/provider'
import { CategoryReportService, periodFor, type CategoryReportKind } from '../src/main/ai/category-report'
import { TopicArchiveStore } from '../src/main/monitor/topics-store'
import type { TopicRecord } from '../src/shared/types'

const USAGE = `usage: npm run sample:report -- --config <dir> --kind daily|weekly|monthly [--date YYYY-MM-DD] [--out <dir>] [--out-file <path>] [--no-ai]
  --config <dir>   用户数据目录（须已有 topics/ 存档或 hits/ 命中数据，必填）
  --kind           报告档位：daily | weekly | monthly，必填
  --date YYYY-MM-DD 锚定日（缺省今天）；weekly/monthly 取该日所属的上一完整周期
  --out <dir>      输出目录（缺省 ./out/sample-reports/）
  --out-file <path> 输出文件路径（相对 cwd；缺省 <out>/sample-<kind>-<periodKey>.md）
  --no-ai          注入恒抛 provider，强制模板降级路径（不调 LLM）`

interface CliArgs {
  configDir: string | null
  kind: CategoryReportKind | null
  date: string | null
  outDir: string
  outFile: string | null
  noAi: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { configDir: null, kind: null, date: null, outDir: './out/sample-reports', outFile: null, noAi: false }
  const needValue = (flag: string, i: number): string => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) {
      console.error(`missing value for ${flag}\n${USAGE}`)
      process.exit(2)
    }
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--config') args.configDir = needValue(a, i++)
    else if (a === '--kind') {
      const k = needValue(a, i++)
      if (k !== 'daily' && k !== 'weekly' && k !== 'monthly') {
        console.error(`invalid --kind: ${k} (daily|weekly|monthly)\n${USAGE}`)
        process.exit(2)
      }
      args.kind = k
    } else if (a === '--date') args.date = needValue(a, i++)
    else if (a === '--out') args.outDir = needValue(a, i++)
    else if (a === '--out-file') args.outFile = needValue(a, i++)
    else if (a === '--no-ai') args.noAi = true
    else {
      console.error(`unknown argument: ${a}\n${USAGE}`)
      process.exit(2)
    }
  }
  if (args.configDir === null || args.kind === null) {
    console.error(`--config and --kind are required\n${USAGE}`)
    process.exit(2)
  }
  if (args.date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    console.error(`invalid --date: ${args.date} (YYYY-MM-DD)\n${USAGE}`)
    process.exit(2)
  }
  return args
}

/** hits/ 日桶文件名形状（与 topics 存档同款） */
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

/** 列目录中落在 [from,to]（含）内的日桶（'YYYY-MM-DD'，旧→新）；目录不存在 → [] */
function dayFilesInRange(dir: string, from: string, to: string): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .map((n) => DAY_FILE_RE.exec(n)?.[1])
    .filter((d): d is string => d !== undefined && d >= from && d <= to)
    .sort()
}

/**
 * **混合口径**存档适配器（CategoryReportDeps.archive 形状）：topics/ 全量存档
 * 不存在或期间无数据时，从 hits/*.jsonl（命中监控面，只含命中帖，但 topic 载荷
 * 字段与 Topic 同构）**只读**派生 TopicRecord。firstSeenAt 取 notifiedAt（命中
 * 落档时刻；无则回退 topic.lastActiveAt），key 与 topics-store 同口径
 * `${sourceId}:${topicId}` 去重首见优先。零写入——构造与读取都不碰用户目录。
 */
class HitsDerivedArchive {
  private readonly cache = new Map<string, TopicRecord[]>()

  constructor(private readonly hitsDir: string) {}

  private async readDay(day: string): Promise<TopicRecord[]> {
    const hit = this.cache.get(day)
    if (hit !== undefined) return hit
    let raw: string
    try {
      raw = await readFile(join(this.hitsDir, `${day}.jsonl`), 'utf-8')
    } catch {
      this.cache.set(day, [])
      return []
    }
    const out: TopicRecord[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        continue // 坏行跳过（topics-store parseDayText 同款）
      }
      const t = (parsed as { topic?: unknown }).topic
      if (typeof t !== 'object' || t === null) continue
      const r = t as Record<string, unknown>
      if (
        typeof r['id'] !== 'string' ||
        typeof r['sourceId'] !== 'string' ||
        typeof r['title'] !== 'string' ||
        typeof r['url'] !== 'string'
      ) {
        continue
      }
      const firstSeenAt =
        typeof (parsed as { notifiedAt?: unknown }).notifiedAt === 'string'
          ? ((parsed as { notifiedAt: string }).notifiedAt)
          : typeof r['lastActiveAt'] === 'string'
            ? (r['lastActiveAt'] as string)
            : `${day}T12:00:00.000Z`
      out.push({
        key: `${r['sourceId'] as string}:${r['id'] as string}`,
        sourceId: r['sourceId'] as string,
        topicId: r['id'] as string,
        title: r['title'] as string,
        url: r['url'] as string,
        author: typeof r['author'] === 'string' ? (r['author'] as string) : '',
        category: typeof r['category'] === 'string' ? (r['category'] as string) : '',
        categorySlug: typeof r['categorySlug'] === 'string' ? (r['categorySlug'] as string) : '',
        pinned: r['pinned'] === true,
        lastActiveAt: typeof r['lastActiveAt'] === 'string' ? (r['lastActiveAt'] as string) : null,
        ...(typeof r['excerpt'] === 'string' && r['excerpt'] !== ''
          ? { excerpt: r['excerpt'] as string }
          : {}),
        firstSeenAt
      })
    }
    this.cache.set(day, out)
    return out
  }

  async readRange(fromDate: string, toDate: string): Promise<TopicRecord[]> {
    const out: TopicRecord[] = []
    const seen = new Set<string>()
    for (const day of dayFilesInRange(this.hitsDir, fromDate, toDate)) {
      for (const rec of await this.readDay(day)) {
        if (seen.has(rec.key)) continue // 首见优先（旧→新遍历）
        seen.add(rec.key)
        out.push(rec)
      }
    }
    return out
  }

  async coveredDays(fromDate: string, toDate: string): Promise<string[]> {
    const out: string[] = []
    for (const day of dayFilesInRange(this.hitsDir, fromDate, toDate)) {
      if ((await this.readDay(day)).length > 0) out.push(day)
    }
    return out
  }
}

/** 混合口径注记（插在报告标题行后）：样例脚本注记，非 service 输出 */
const HYBRID_CALIBER_NOTE =
  '> 📌 数据口径（样例脚本注记）：全量话题存档（topics/）本期无数据——报告由命中监控面' +
  '（hits/*.jsonl，只含命中帖）派生生成，非全量话题口径；分类内帖子数与附录均以命中面为准。'

/** 在 markdown 首行（H1 标题）之后插入一段注记；无换行（异常防御）则前置于开头 */
function insertAfterTitle(markdown: string, note: string): string {
  const nl = markdown.indexOf('\n')
  if (nl === -1) return `${note}\n\n${markdown}`
  return `${markdown.slice(0, nl)}\n\n${note}${markdown.slice(nl)}`
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  // parseArgs 已对缺失必填项 process.exit(2)；这里再守一次让 TS 收窄非空
  if (args.configDir === null || args.kind === null) process.exit(2)
  const { configDir, kind, date, noAi } = args
  const dir = resolve(configDir)
  const topicsDir = join(dir, 'topics')
  const hitsDir = join(dir, 'hits')

  // 配置只读：load 不 save（PlainSecretBox——headless 同款，桌面密文盘的凭据
  // 按"未配置"处理，报告自动降级模板，正合样例脚本语义）
  const store = new ConfigStore(join(dir, 'config.json'), { secretBox: new PlainSecretBox() })
  const cfg = store.load()

  // 锚定日（缺省今天）→ 正午时刻（避开 DST 边界）→ 该档的上一完整周期
  const anchor = date !== null ? `${date}T12:00:00` : undefined
  const now = anchor !== undefined ? new Date(anchor) : new Date()
  const period = periodFor(kind, now)

  // 数据口径选择：topics 存档优先；期间无日桶 → hits 派生混合口径；再无 →
  // topics readonly 空存档（零帖报告，如实呈现）——三者都零写入用户目录。
  const topicsDays = existsSync(topicsDir) ? dayFilesInRange(topicsDir, period.from, period.to) : []
  const hitsDays = dayFilesInRange(hitsDir, period.from, period.to)
  let dataMode: 'topics' | 'hybrid' | 'empty'
  let archive: { readRange(f: string, t: string): Promise<TopicRecord[]>; coveredDays(f: string, t: string): Promise<string[]> }
  if (topicsDays.length > 0) {
    dataMode = 'topics'
    // 存档只读：readonly 模式不建目录、不清理、record 短路
    archive = new TopicArchiveStore({ dataDir: topicsDir, readonly: true })
  } else if (hitsDays.length > 0) {
    dataMode = 'hybrid'
    archive = new HitsDerivedArchive(hitsDir)
    console.warn(
      `[warn] topics archive has no data for ${period.from}..${period.to}; ` +
        `falling back to hits-derived hybrid caliber (${hitsDir}, 命中面≠全量话题面)`
    )
  } else {
    dataMode = 'empty'
    archive = new TopicArchiveStore({ dataDir: topicsDir, readonly: true })
    console.warn(
      `[warn] neither topics/ nor hits/ has data for ${period.from}..${period.to}; ` +
        `generating an honest zero-record report`
    )
  }

  // provider：--no-ai 恒抛（逼降级路径）；缺省复用真实 AiProvider
  // （provider 未配置时 service 自行降级，同样零网络调用）
  const provider =
    noAi === true
      ? {
          chat: () =>
            Promise.reject(new Error('sample mode: --no-ai provider is disabled by design'))
        }
      : new AiProvider({
          post: (url, init) => new HttpClient({}).post(url, init),
          getConfig: () => cfg.ai.provider
        })

  const outDir = resolve(args.outDir)
  const svc = new CategoryReportService({
    provider,
    archive,
    // 哨兵 notifier：shouldPush=false 下永不被调；被调即抛（运行时护栏）
    notifier: {
      sendRaw: () => Promise.reject(new Error('sample-report must never push'))
    },
    getConfig: () => cfg,
    logger: {
      info: (msg) => console.log(`[info] ${msg}`),
      warn: (msg) => console.warn(`[warn] ${msg}`),
      error: (msg) => console.error(`[error] ${msg}`)
    },
    // service 的落文件点也指向**样例输出目录**（service-output/ 子目录），
    // 绝不写用户数据目录的 reports/
    reportsDir: join(outDir, 'service-output'),
    shouldPush: () => false
  })

  console.log(`generating ${kind} report for period ${period.label} (${period.from} .. ${period.to})`)
  const markdown = await svc.generate(kind, now)

  // 混合口径时在标题行后注明数据来源口径（样例脚本注记，正文其余部分与
  // service 输出逐字节一致）；--out-file 支持固定输出文件名（两份样例交付用）
  const finalMarkdown =
    dataMode === 'hybrid' ? insertAfterTitle(markdown, HYBRID_CALIBER_NOTE) : markdown
  const sampleFile =
    args.outFile !== null
      ? resolve(args.outFile)
      : join(outDir, `sample-${kind}-${period.periodKey}.md`)
  await mkdir(dirname(sampleFile), { recursive: true })
  await writeFile(sampleFile, finalMarkdown, 'utf-8')

  // 摘要行：覆盖率 + 是否降级（从确定性生成的 markdown 里提取，脚本零额外接口）
  const coverage = /- 存档 (\d+)\/(\d+) 天有数据/.exec(finalMarkdown)?.[0] ?? 'coverage line missing'
  const degraded = finalMarkdown.includes('模板模式（AI 不可用）')
  const noTopics = finalMarkdown.includes('AI 总结：未调用')
  const archiveShort = finalMarkdown.includes('存档不足')
  const appendixRows = (finalMarkdown.match(/^- \d{2}:\d{2} \[/gm) ?? []).length
  console.log(`output: ${sampleFile}`)
  console.log(`period: ${period.from} .. ${period.to} (${period.label})`)
  console.log(
    `data: ${dataMode === 'topics' ? 'topics archive (全量话题面)' : dataMode === 'hybrid' ? 'hybrid (hits 派生——命中面，非全量)' : 'empty (无存档数据)'}`
  )
  console.log(`coverage: ${coverage}${archiveShort ? ' [存档不足]' : ''}`)
  console.log(`appendix rows: ${appendixRows}`)
  console.log(
    `mode: ${noTopics ? 'no topics (LLM not called)' : degraded ? 'template (AI unavailable / --no-ai)' : 'ai summary'}`
  )
  console.log(`push: disabled (sample script never pushes)`)
  return 0
}

void main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('fatal:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
)
