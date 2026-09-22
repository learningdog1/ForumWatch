/**
 * 全量话题存档（R17 分类阶段报告的数据底座）。
 *
 * 与 hits-store（仅命中）/ dispositions（处置观测、7 天）互补：这里存的是引擎
 * 观察到的**每一个新帖**——不论命中/未中/被滤/置顶/被排除，也不论报告开关开没开
 * （无条件写：今天积累、将来开启月报也有历史）。**被 id 阈值吞并的回复顶起旧帖
 * 除外**（unseen ≠ 新发帖：engine 在落档前按 W3 判定剔除，否则会按 firstSeenAt
 * 计入当日、系统性抬高报告帖量）。分类日/周/月报（ai/category-report.ts）
 * 从这里读数；周月两档需要 31 天历史，故保留 35 天（TOPIC_ARCHIVE_RETENTION_DAYS
 * ≥ 月报 31 天 + 跨窗补做缓冲）。
 *
 * 存储：`<userData>/topics/YYYY-MM-DD.jsonl` 追加写，一行一个 TopicRecord 的
 * JSON + `\n`（hits-store 同款 appendFile + formatLocalDate 本地时区日分桶；
 * 日志型追加不做 tmp+rename 原子换文件，单行损坏面只有最后一行，readDay 跳坏行）。
 *
 * 去重（关键语义）：键 `${sourceId}:${topicId}`（engine seenKeyFor 同口径）。
 * - 写侧：内存 Set，构造时从**现有日桶文件**重建（首见即入集）——进程内同键
 *   只落一行；重启后 Set 从盘恢复，同键不再落。语义未决重评轮、推送失败重试轮
 *   的重入由该 Set 挡住（这些轮次不走 engine 的 deferred-skip 分支，不能靠
 *   engine 防重）。
 * - 读侧：readRange 再按 key 去重、首见优先（旧→新遍历取首个）——seen 环形
 *   淘汰（容量 1000+500n）后旧帖重进 unseen 被重复落档时，报告读数仍无重复
 *   （文件多几行无害；去重集只在构造时重建一次，长进程内被 seen 淘汰的键重进
 *   unseen 时写侧可能再落一行，读侧兜底）。
 *
 * 写入经串行队列（dispositions 的 writeTail 模式）：行序与产生序一致；
 * record() 同步签名（热循环内无 await，不拖慢轮询）、失败只 console.error 不抛
 * ——**写失败时把该键从去重集回滚移除**，下轮观察可重录（否则该帖永久丢失：
 * 键已挡住后续重录）。保留清理除启动时跑一次外，写入路径检测本地日翻转时顺带
 * 再跑（常驻进程不重启时旧文件也会被清）。flush() 供测试与退出路径。
 *
 * readonly 模式（样例脚本用）：跳过 mkdir/cleanup、record 短路——绝不写用户
 * 数据目录，读 API 照常。零 electron 依赖。
 */
import { appendFile, readFile } from 'node:fs/promises'
import { mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { formatLocalDate } from './hits-store'
import type { Topic, TopicRecord } from '../../shared/types'

/** userData 下的存档目录名；装配方 `join(userData, TOPICS_DIR_NAME)` 后传入 */
export const TOPICS_DIR_NAME = 'topics'

/**
 * 存档保留天数（R17）：35 ≥ 月报 31 天 + 跨窗补做缓冲（2 日后补做上月月报时，
 * 保留窗已滚掉月初几天 → coveredDays 如实呈现 D<31 天，报告头标注「存档不足」，
 * 绝不静默截断冒充全量）。
 */
export const TOPIC_ARCHIVE_RETENTION_DAYS = 35

/** 日桶文件名形状（清理与 listDays 只认这个形状） */
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

const RETENTION_MS = TOPIC_ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000

/** 全局去重键（engine seenKeyFor 同口径 `${sourceId}:${topicId}`） */
const archiveKeyFor = (sourceId: string, topicId: string): string => `${sourceId}:${topicId}`

/** 宽松形状校验：是对象且必填字符串字段齐备即认（excerpt 可选、pinned 容忍缺失=非置顶） */
function isTopicRecordLike(raw: unknown): raw is TopicRecord {
  if (typeof raw !== 'object' || raw === null) return false
  const r = raw as Record<string, unknown>
  return (
    typeof r['key'] === 'string' &&
    typeof r['sourceId'] === 'string' &&
    typeof r['topicId'] === 'string' &&
    typeof r['title'] === 'string' &&
    typeof r['url'] === 'string' &&
    typeof r['author'] === 'string' &&
    typeof r['category'] === 'string' &&
    typeof r['categorySlug'] === 'string' &&
    typeof r['firstSeenAt'] === 'string'
  )
}

/** 解析一个日桶文本为合法记录数组（readDay 与构造期重建共用；坏行跳过） */
function parseDayText(raw: string): TopicRecord[] {
  const out: TopicRecord[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue // 末尾空行/偶然空行
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue // 坏行：跳过，不炸整个文件
    }
    if (isTopicRecordLike(parsed)) out.push(parsed)
  }
  return out
}

export interface TopicArchiveStoreOptions {
  /** topics 目录（即 `<userData>/topics` 本身）；缺省 = 纯内存（不落盘，测试用） */
  dataDir?: string
  /**
   * 只读模式（样例脚本用）：跳过 mkdir/cleanup、record 短路——绝不写用户数据
   * 目录；readDay/listDays/readRange/coveredDays 照常。
   */
  readonly?: boolean
  /** 测试注入假时钟（epoch ms）；默认 Date.now */
  now?: () => number
}

export class TopicArchiveStore {
  private readonly dataDir: string | undefined
  private readonly readonlyMode: boolean
  private readonly now: () => number
  /**
   * 已落档键集（写侧去重）：构造时从现有日桶文件重建（首见即入集，坏行跳过）。
   * readonly 模式不重建（没有写路径需要防重，也少读一遍盘）。
   */
  private readonly archivedKeys = new Set<string>()
  /** 串行写队列尾（dispositions writeTail 模式）：文件行序与产生序一致 */
  private writeTail: Promise<void> = Promise.resolve()
  /** 上次保留清理的本地日（写入路径跨日翻转检测用；构造期清理后初始化） */
  private lastCleanupDay: string | null = null

  constructor(opts: TopicArchiveStoreOptions = {}) {
    this.readonlyMode = opts.readonly === true
    this.now = opts.now ?? (() => Date.now())
    this.dataDir = opts.dataDir
    if (this.dataDir !== undefined && !this.readonlyMode) {
      try {
        mkdirSync(this.dataDir, { recursive: true })
        this.rebuildKeySet()
        this.cleanupOldFiles()
        this.lastCleanupDay = formatLocalDate(new Date(this.now()))
      } catch (err) {
        console.error(
          `[topics] cannot initialize dir ${this.dataDir}, file persistence disabled:`,
          err
        )
        this.dataDir = undefined
      }
    }
  }

  /**
   * 落档一个观察到的新帖（engine unseen 循环在 W3 旧帖判定之后调用；命中/未中/
   * 被滤/置顶/被排除全部经此——被 id 阈值吞并的回复顶起旧帖在调用前已被剔除，
   * 不受报告开关控制）。同键进程内只落一行（Set 去重）；readonly 模式
   * 短路。同步签名：文件追加经内部串行队列，失败只 console.error 不抛。
   * @param topic 引擎已盖 sourceId 的帖子
   * @param now 决定日桶与 firstSeenAt 的时刻，默认当前时间
   */
  record(topic: Topic, now: Date = new Date(this.now())): void {
    if (this.readonlyMode) return
    const key = archiveKeyFor(topic.sourceId, topic.id)
    if (this.archivedKeys.has(key)) return
    this.archivedKeys.add(key)
    if (this.dataDir === undefined) return
    const rec: TopicRecord = {
      key,
      sourceId: topic.sourceId,
      topicId: topic.id,
      title: topic.title,
      url: topic.url,
      author: topic.author,
      category: topic.category,
      categorySlug: topic.categorySlug,
      pinned: topic.pinned === true,
      lastActiveAt: topic.lastActiveAt,
      ...(topic.excerpt !== undefined && topic.excerpt !== '' ? { excerpt: topic.excerpt } : {}),
      firstSeenAt: now.toISOString(),
      // 归属日随写入固化（读取侧优先用它，改时区不漂移；见 TopicRecord.day 注释）
      day: formatLocalDate(now)
    }
    this.appendToFile(rec, now)
  }

  /**
   * 读某个本地日的全部存档（顺序旧→新 = 写入序，**不做读侧去重**——跨日跨行
   * 去重是 readRange 的职责，单日原样给便于排查）。
   * 文件不存在 → []；非 ENOENT 读失败按空处理（查询面不抛）；坏行跳过。
   */
  async readDay(dateLocal: string): Promise<TopicRecord[]> {
    if (this.dataDir === undefined) return []
    let raw: string
    try {
      raw = await readFile(join(this.dataDir, `${dateLocal}.jsonl`), 'utf-8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        console.error(`[topics] cannot read ${dateLocal}.jsonl, treating as empty:`, err)
      }
      return []
    }
    return parseDayText(raw)
  }

  /** 已有数据的天列表，新→旧（'YYYY-MM-DD' 字典序 = 时间序）；目录不存在 → [] */
  listDays(): string[] {
    if (this.dataDir === undefined) return []
    let entries: string[]
    try {
      entries = readdirSync(this.dataDir)
    } catch {
      return []
    }
    return entries
      .filter((name) => DAY_FILE_RE.test(name))
      .map((name) => name.slice(0, -'.jsonl'.length))
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  }

  /**
   * 读 fromDate..toDate（**含两端**，本地日期字符串）的存档，跨日合并（旧→新）
   * 并按 key 去重、**首见优先**（旧→新遍历取首个）——seen 环淘汰后旧帖被重复
   * 落档时报告读数仍无重复。fromDate > toDate = 空区间。查询面不抛。
   */
  async readRange(fromDate: string, toDate: string): Promise<TopicRecord[]> {
    const days = this.listDays().filter((d) => d >= fromDate && d <= toDate)
    const out: TopicRecord[] = []
    const seenKeys = new Set<string>()
    // listDays 新→旧，反转成旧→新：首见优先 = 时间上更早的那行
    for (const day of days.reverse()) {
      for (const rec of await this.readDay(day)) {
        if (seenKeys.has(rec.key)) continue
        seenKeys.add(rec.key)
        out.push(rec)
      }
    }
    return out
  }

  /**
   * fromDate..toDate（含两端）中**有数据**的天列表，旧→新（覆盖率统计用：
   * 「期间 T 天中 D 天有数据」的 D）。目录里存在文件但全为坏行 = 无数据，
   * 不计入（coveredDays 只数有合法记录行的天）。
   *
   * sourceIds（可选）：把 D 的口径对齐到配置来源——只数「该来源集内有记录」
   * 的天（与 category-report 的帖子过滤同口径，防止只配 nodeseek 时被其他
   * 来源的存档撑高覆盖率）。空数组/缺省 = 不过滤（现状口径）。读侧性能：
   * 逐行扫描、命中即停，不为覆盖率统计物化整日记录数组。
   */
  async coveredDays(
    fromDate: string,
    toDate: string,
    sourceIds?: string[]
  ): Promise<string[]> {
    const sourceSet =
      sourceIds !== undefined && sourceIds.length > 0 ? new Set(sourceIds) : undefined
    const days = this.listDays().filter((d) => d >= fromDate && d <= toDate)
    const out: string[] = []
    for (const day of days.reverse()) {
      if (await this.dayHasRecords(day, sourceSet)) out.push(day)
    }
    return out
  }

  /**
   * 等待串行写队列排空（测试与退出路径用；无文件模式恒立即返回）。
   * 队列内的 append 失败已被消化（console.error + 去重键回滚），本方法永不 reject。
   */
  async flush(): Promise<void> {
    await this.writeTail
  }

  // ---- 内部实现 ----------------------------------------------------------

  /**
   * 日桶是否含（可选限定来源集内的）合法记录行——coveredDays 专用：逐行解析、
   * 命中即停（早退，不为覆盖率统计解析整日全部行）。读失败按无数据处理
   * （查询面不抛，ENOENT 静默）。
   */
  private async dayHasRecords(
    dateLocal: string,
    sourceSet: ReadonlySet<string> | undefined
  ): Promise<boolean> {
    if (this.dataDir === undefined) return false
    let raw: string
    try {
      raw = await readFile(join(this.dataDir, `${dateLocal}.jsonl`), 'utf-8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        console.error(`[topics] cannot read ${dateLocal}.jsonl for coverage:`, err)
      }
      return false
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        continue // 坏行跳过
      }
      if (!isTopicRecordLike(parsed)) continue
      if (sourceSet !== undefined && !sourceSet.has(parsed.sourceId)) continue
      return true // 命中即停
    }
    return false
  }

  /** 构造期去重集重建：读全部日桶（≤35 个），首见即入集（与读侧首见优先一致） */
  private rebuildKeySet(): void {
    const dir = this.dataDir as string
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return // 目录刚建/不可读：空集开始（写侧防线退化为进程内去重）
    }
    for (const name of names) {
      if (!DAY_FILE_RE.test(name)) continue
      try {
        for (const rec of parseDayText(readFileSync(join(dir, name), 'utf-8'))) {
          this.archivedKeys.add(rec.key)
        }
      } catch (err) {
        console.error(`[topics] cannot read ${name} during key rebuild:`, err)
      }
    }
  }

  /**
   * jsonl 追加（串行队列；本地时区日分桶）。写入路径顺带做两件事：
   * - 本地日翻转检测（lastCleanupDay）：常驻进程不重启时，跨天首次写入顺带跑
   *   一次保留清理（失败只 log，不影响写入——cleanupOldFiles 自身逐文件吞错）。
   * - append 失败回滚去重键：把该记录的键从 archivedKeys 移除，下轮观察同一帖
   *   会重新 record（否则键已入集挡住重录，该帖**永久丢失**）。
   */
  private appendToFile(rec: TopicRecord, now: Date): void {
    const dir = this.dataDir as string
    const day = formatLocalDate(now)
    const file = join(dir, `${day}.jsonl`)
    if (day !== this.lastCleanupDay) {
      // 先记后跑：清理失败也不在同一天反复重试（失败只 log）
      this.lastCleanupDay = day
      this.cleanupOldFiles()
    }
    const line = `${JSON.stringify(rec)}\n`
    this.writeTail = this.writeTail
      .then(() => appendFile(file, line, 'utf-8'))
      .catch((err: unknown) => {
        console.error(`[topics] append to ${file} failed:`, err)
        this.archivedKeys.delete(rec.key)
      })
  }

  /** 保留清理（dispositions cleanupOldFiles 同款）：文件名日期早于 cutoff 那天的删除。启动时与写入路径跨日翻转时各跑一次 */
  private cleanupOldFiles(): void {
    const dir = this.dataDir as string
    const cutoff = formatLocalDate(new Date(this.now() - RETENTION_MS))
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch (err) {
      console.error(`[topics] cannot list dir ${dir} for cleanup:`, err)
      return
    }
    for (const name of names) {
      const match = DAY_FILE_RE.exec(name)
      if (!match || match[1] >= cutoff) continue
      try {
        unlinkSync(join(dir, name))
      } catch (err) {
        console.error(`[topics] cannot remove old file ${name}:`, err)
      }
    }
  }
}
