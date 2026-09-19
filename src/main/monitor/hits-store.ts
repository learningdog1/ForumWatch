/**
 * 命中记录持久化（D5：AI 日报与 UI 历史查询的数据底座）。
 *
 * - 存储：追加型 JSONL，按**本地时区**自然日分桶——`<userData>/hits/YYYY-MM-DD.jsonl`，
 *   一行一个 `HitRecord` 的 JSON 对象 + `\n`。本地日期必须用
 *   getFullYear/getMonth/getDate 拼（D5 / 新增坑 ④：`toISOString().slice(0,10)`
 *   是 UTC 日期，东八区 00:00–08:00 会漂到前一天）。
 * - 写入：`mkdir recursive` + `appendFile` 追加。与 dedup/FileSeenStore 的
 *   tmp+rename 原子写**语义不同**：这是日志型追加，不做读改写整文件，
 *   单次 append 的损坏面只有最后一行（readDay 会跳过坏行），无需原子换文件。
 * - 读取：文件不存在 → `[]`；单行 JSON.parse 失败或形状不像 HitRecord → 跳过
 *   该行（坏行不炸整个文件）；返回顺序 = 文件行序 = 写入序（旧→新）。
 * - 清理：旧文件永不清理（D5），磁盘占用 = 每命中一行，量级可忽略。
 *
 * 零 electron 依赖，可在 node 下单测与 headless 直跑（ADR 2）。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { HitRecord } from '../../shared/types'

/** userData 下的命中存储目录名；装配方负责 `join(userData, HITS_DIR_NAME)` 后传入构造函数 */
export const HITS_DIR_NAME = 'hits'

/** 日桶文件名形状：`YYYY-MM-DD.jsonl`（listDays 只认这个形状，其余文件一概忽略） */
const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/

/**
 * 本地时区 'YYYY-MM-DD'。日报定时（D5）与日分桶共用的日期口径，
 * W2 日报模块复用本函数，不要各自再拼一遍。
 * 禁止 `toISOString().slice(0, 10)`——那是 UTC 日期。
 */
export function formatLocalDate(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 命中记录的日分桶 JSONL 存储。
 *
 * 生命周期：进程启动 `new HitsStore(join(userData, 'hits'))` 一个实例长期持有；
 * engine 每命中一次 `await append(hit)`（可注入 now 供测试）；
 * 日报/UI 查询走 `readDay(dateLocal)` / `listDays()`。
 */
export class HitsStore {
  private readonly dir: string

  /**
   * @param dir 命中存储目录（即 `<userData>/hits` 本身，装配方用
   *   `join(userData, HITS_DIR_NAME)` 组出；目录不存在时 append 会创建）
   */
  constructor(dir: string) {
    this.dir = dir
  }

  /** 某个本地日期对应的 JSONL 文件路径 */
  private pathFor(dateLocal: string): string {
    return join(this.dir, `${dateLocal}.jsonl`)
  }

  /**
   * 追加一条命中到 `hits/<本地日期>.jsonl`。
   * HitRecord 原样序列化（ISO 时间戳保持字符串原样），一行一个 JSON + `\n`。
   * @param hit 命中记录
   * @param now 用于决定日桶的时刻，默认当前时间（注入供测试/补写）
   */
  async append(hit: HitRecord, now: Date = new Date()): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const line = `${JSON.stringify(hit)}\n`
    await appendFile(this.pathFor(formatLocalDate(now)), line, 'utf-8')
  }

  /**
   * 读某天全部命中，顺序旧→新（= 写入序）。
   * - 文件不存在（当天无命中）→ `[]`；其他读失败同样返回 `[]`（查询面不抛）。
   * - 单行 JSON.parse 失败或形状不像 HitRecord（宽松校验：`topic.id` 为字符串）
   *   → 跳过该行，坏行不炸整个文件。
   */
  async readDay(dateLocal: string): Promise<HitRecord[]> {
    let raw: string
    try {
      raw = await readFile(this.pathFor(dateLocal), 'utf-8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        // 文件不存在是常态（当天无命中）；其他读失败打日志后按空处理，不炸查询方
        console.error(`[hits] cannot read ${this.pathFor(dateLocal)}, treating as empty:`, err)
      }
      return []
    }
    const hits: HitRecord[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue // 末尾空行/偶然空行
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        continue // 坏行：跳过，不炸整个文件
      }
      if (isHitRecordLike(parsed)) hits.push(parsed)
    }
    return hits
  }

  /**
   * 读最近 N 个本地自然日（today 起向前数，含 today）的全部命中，合并后按
   * 时间顺序旧→新（各日桶内部本就旧→新，跨日按日期升序拼接）。
   * R5-P2a 相似降噪窗口的启动重建数据源：48h 窗口跨本地日最多涉 3 个日桶，
   * 调用方 `readRecent(3)` 即可完整覆盖。
   * 单日读失败按空处理（查询面不抛，与 readDay 同款）；days <= 0 → []。
   * 返回**全部**记录（含推送失败/静音的 notifiedAt=null 行）——是否只要成功
   * 推送由调用方（engine）决定，本方法不做业务过滤。
   */
  async readRecent(days: number, now: Date = new Date()): Promise<HitRecord[]> {
    if (!Number.isInteger(days) || days <= 0) return []
    const out: HitRecord[] = []
    // 从最旧的一天开始拼接（days-1 天前 → 今天），保证整体旧→新
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now)
      d.setDate(d.getDate() - i)
      out.push(...(await this.readDay(formatLocalDate(d))))
    }
    return out
  }

  /**
   * 已有数据的天列表，新→旧（'YYYY-MM-DD' 字典序 = 时间序，倒排即可）。
   * 目录不存在 → `[]`；目录里不匹配 `YYYY-MM-DD.jsonl` 的文件被忽略。
   */
  listDays(): string[] {
    let entries: string[]
    try {
      entries = readdirSync(this.dir)
    } catch {
      return [] // 目录还不存在（从未命中过）
    }
    return entries
      .filter((name) => DAY_FILE_RE.test(name))
      .map((name) => name.slice(0, -'.jsonl'.length))
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  }
}

/** 宽松形状校验：是对象、有 topic、topic.id 是字符串即认（其余字段原样信任） */
function isHitRecordLike(raw: unknown): raw is HitRecord {
  if (typeof raw !== 'object' || raw === null) return false
  const topic = (raw as { topic?: unknown }).topic
  if (typeof topic !== 'object' || topic === null) return false
  return typeof (topic as { id?: unknown }).id === 'string'
}
