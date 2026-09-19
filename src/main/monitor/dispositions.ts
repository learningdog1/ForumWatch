/**
 * 处置流水（R7-W1）："为什么没推送"的观测面内核。
 *
 * 引擎 unseen 处理链的每个分支出口（per-source 过滤 / id 阈值 / 置顶 / 排除词 /
 * 规则与字面未中 / 语义三态 / 相似吞并 / 挂起 / 推送成败 / 静音）都向本 store
 * 上报一条 Disposition。用户问"这条帖子为什么没通知"时按 sourceId:topicId 查
 * 最后一条记录即可回答。
 *
 * 去重语义（DEC-3，关键）：内存 Map<seenKey, lastOutcome>——同一帖子的键首次
 * 出现记录；outcome **相同**不记（推送失败重试轮、语义未决重评轮每轮重入，
 * 不刷屏）；outcome **变化**（状态迁移：miss→无、pending→semantic-miss、
 * deferred→pushed、push-failed→pushed 等）再记一条，形成该帖的处置轨迹。
 *
 * 键清理：帖子入 seen（推送成功/被吞/已判 miss）后不再进 unseen 流，Map 里的
 * 键由引擎轮末统一清——与 pruneRetryMaps 同款生命周期：只清"本轮成功抓取过
 * 页面的 source"里"已滚出首页"的键（observedSources 守卫，R3 审查先例）；
 * 冷却/失败轮的键保留到下次成功观测。挂起中的帖子不入 seen 也不会滚出清理
 * 集（仍在页面上），其键存活到 flush 收口出终态。
 *
 * 存储：
 * - 内存环（容量 500，淘汰最老）：recent(limit) 给 UI（getRecentHits 同款）。
 * - 持久化：`pipeline/YYYY-MM-DD.jsonl`（**本地时区**日分桶，formatLocalDate
 *   单一口径——与 hits-store 同款追加写，不做 tmp+rename 原子换文件：日志型
 *   追加单行损坏面只有最后一行，readDay 跳坏行）。写经串行队列（logger 的
 *   writeTail 模式）保证文件行序与产生序一致；失败只 console.error 不抛。
 * - 保留 7 天：构造时清理 `YYYY-MM-DD.jsonl` 早于（now - 7 天）的文件
 *   （logger 的 cleanupOldFiles 同款：文件名日期字典序比较，删除失败只记日志）。
 *
 * 构造注入（二选一或都缺省）：dataDir（文件持久化）/ append 回调（替代持久化，
 * 测试或替代装配用；给了则不走文件）。都不给 = 内存环 only。零 electron 依赖。
 */
import { appendFile, readFile } from 'node:fs/promises'
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { formatLocalDate } from './hits-store'
import { DISPOSITION_OUTCOMES, type Disposition, type DispositionOutcome } from '../../shared/ipc'

export type { Disposition, DispositionOutcome }
export { DISPOSITION_OUTCOMES }

/** userData 下的流水存储目录名；装配方 `join(userData, PIPELINE_DIR_NAME)` 后传入 */
export const PIPELINE_DIR_NAME = 'pipeline'

/** 内存环形容量（recent 给 UI 的上限；淘汰最老） */
export const DISPOSITION_RING_CAPACITY = 500

/** 流水文件保留天数（对齐 logger 的 LOG_RETENTION_DAYS 模式） */
export const DISPOSITION_RETENTION_DAYS = 7

/** 日桶文件名形状（清理只认这个形状；捕获组 = 文件名日期，与 logger 同款） */
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

const RETENTION_MS = DISPOSITION_RETENTION_DAYS * 24 * 60 * 60 * 1000

/** readDay 的坏行跳过用：outcome 合法值集合 */
const VALID_OUTCOMES: ReadonlySet<string> = new Set<string>(DISPOSITION_OUTCOMES)

function isDispositionLike(raw: unknown): raw is Disposition {
  if (typeof raw !== 'object' || raw === null) return false
  const r = raw as Record<string, unknown>
  return (
    typeof r['ts'] === 'string' &&
    typeof r['sourceId'] === 'string' &&
    typeof r['topicId'] === 'string' &&
    typeof r['title'] === 'string' &&
    typeof r['outcome'] === 'string' &&
    VALID_OUTCOMES.has(r['outcome'])
  )
}

/** 全局去重键（与 engine 的 seenKeyFor 同口径 `${sourceId}:${topicId}`） */
const seenKeyFor = (sourceId: string, topicId: string): string => `${sourceId}:${topicId}`

/** 键 → sourceId 部分（prune 判断键归属用；键必含冒号，取首个冒号前） */
const sourceIdOfKey = (key: string): string => key.slice(0, key.indexOf(':'))

export interface DispositionStoreOptions {
  /** pipeline 目录（即 `<userData>/pipeline` 本身）；给了才写文件 */
  dataDir?: string
  /**
   * 追加回调（与 dataDir 二选一；**给了优先于文件**——测试 / 替代持久化用）。
   * 每条**实际落账**的记录（去重放行后）调用一次；抛错由本 store 消化（console.error）。
   */
  append?: (rec: Disposition) => void
  /** 测试注入假时钟（epoch ms）；默认 Date.now */
  now?: () => number
}

export class DispositionStore {
  private readonly dataDir: string | undefined
  private readonly appendCb: ((rec: Disposition) => void) | undefined
  private readonly now: () => number
  /** 内存环（旧→新） */
  private readonly ring: Disposition[] = []
  /** seenKey → 该键最后记录的 outcome（去重/迁移判定的唯一状态） */
  private readonly lastOutcomes = new Map<string, DispositionOutcome>()
  /** 串行写队列尾（logger writeTail 模式）：保证 jsonl 行序与产生序一致 */
  private writeTail: Promise<void> = Promise.resolve()

  constructor(opts: DispositionStoreOptions = {}) {
    this.appendCb = opts.append
    this.now = opts.now ?? (() => Date.now())
    this.dataDir = this.appendCb !== undefined ? undefined : opts.dataDir
    if (this.dataDir !== undefined) {
      try {
        mkdirSync(this.dataDir, { recursive: true })
        this.cleanupOldFiles()
      } catch (err) {
        console.error(
          `[dispositions] cannot initialize dir ${this.dataDir}, file persistence disabled:`,
          err
        )
        this.dataDir = undefined
      }
    }
  }

  /**
   * 记录一条处置（引擎各分支出口调用；去重见类注释）。
   * 同键同 outcome = 重试/重评轮重入，静默跳过（内存 Map 与 jsonl 都不追加）；
   * outcome 变化 = 状态迁移，追加一条并更新 Map。
   */
  record(
    sourceId: string,
    topicId: string,
    title: string,
    outcome: DispositionOutcome,
    detail?: string
  ): void {
    const key = seenKeyFor(sourceId, topicId)
    if (this.lastOutcomes.get(key) === outcome) return
    this.lastOutcomes.set(key, outcome)
    const rec: Disposition = {
      ts: new Date(this.now()).toISOString(),
      sourceId,
      topicId,
      title,
      outcome,
      ...(detail !== undefined && detail !== '' ? { detail } : {})
    }
    this.ring.push(rec)
    if (this.ring.length > DISPOSITION_RING_CAPACITY) this.ring.shift()
    if (this.appendCb !== undefined) {
      try {
        this.appendCb(rec)
      } catch (err) {
        console.error('[dispositions] append callback threw:', err)
      }
      return
    }
    if (this.dataDir !== undefined) this.appendToFile(rec)
  }

  /** 内存环快照（旧→新，最近 limit 条；返回拷贝） */
  recent(limit = 200): Disposition[] {
    return this.ring.slice(-limit)
  }

  /**
   * 读某个本地日的全部流水（顺序旧→新 = 写入序）。
   * 文件不存在（当日无记录）→ []；非 ENOENT 读失败同样按空处理（查询面不抛）。
   * 单行 JSON.parse 失败或形状不像 Disposition（含 outcome 非法）→ 跳过该行。
   */
  async readDay(dateLocal: string): Promise<Disposition[]> {
    if (this.dataDir === undefined) return []
    let raw: string
    try {
      raw = await readFile(join(this.dataDir, `${dateLocal}.jsonl`), 'utf-8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        console.error(`[dispositions] cannot read ${dateLocal}.jsonl, treating as empty:`, err)
      }
      return []
    }
    const out: Disposition[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue // 末尾空行/偶然空行
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        continue // 坏行：跳过，不炸整个文件
      }
      if (isDispositionLike(parsed)) out.push(parsed)
    }
    return out
  }

  /**
   * 轮末键清理（引擎 pruneRetryMaps 调用点联动）：删掉"本轮成功观测的 source
   * 里已滚出首页"的键——帖子滚出首页后不会再进 unseen 流，其 lastOutcome 不再
   * 变化，留着只会让重启后同 id 新帖的首条处置被误判为重复。冷却/失败轮
   * （source 未观测）的键保留到下次成功观测（observedSources 守卫）。
   */
  prune(keepKeys: Set<string>, observedSources: Set<string>): void {
    if (this.lastOutcomes.size === 0) return
    for (const key of [...this.lastOutcomes.keys()]) {
      if (!keepKeys.has(key) && observedSources.has(sourceIdOfKey(key))) {
        this.lastOutcomes.delete(key)
      }
    }
  }

  /**
   * 等待串行写队列排空（测试与退出路径用；内存环/append 回调模式恒立即返回）。
   * 队列内的 append 失败已被消化（只 console.error），本方法永不 reject。
   */
  async flush(): Promise<void> {
    await this.writeTail
  }

  /** jsonl 追加（串行队列；本地时区日分桶） */
  private appendToFile(rec: Disposition): void {
    const dir = this.dataDir as string
    const file = join(dir, `${formatLocalDate(new Date(this.now()))}.jsonl`)
    const line = `${JSON.stringify(rec)}\n`
    this.writeTail = this.writeTail
      .then(() => appendFile(file, line, 'utf-8'))
      .catch((err: unknown) => {
        console.error(`[dispositions] append to ${file} failed:`, err)
      })
  }

  /** 启动清理（logger cleanupOldFiles 同款）：文件名日期早于（now - 7 天）那天的删除 */
  private cleanupOldFiles(): void {
    const dir = this.dataDir as string
    const cutoff = formatLocalDate(new Date(this.now() - RETENTION_MS))
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch (err) {
      console.error(`[dispositions] cannot list dir ${dir} for cleanup:`, err)
      return
    }
    for (const name of names) {
      const match = DAY_FILE_RE.exec(name)
      if (!match || match[1] >= cutoff) continue
      try {
        unlinkSync(join(dir, name))
      } catch (err) {
        console.error(`[dispositions] cannot remove old file ${name}:`, err)
      }
    }
  }
}

