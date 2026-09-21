/**
 * 统计面板（R7-W3）：历史命中的**纯读聚合**。
 *
 * `computeStats(hits, cfg)` 不做任何 IO——"近 N 天"的取数窗口由调用方负责
 * （桌面侧装配：getStats IPC 读 `hitsStore.readRecent(days)` 后调本函数，
 * cfg.includeKeywords 取当前生效配置）。零 electron 依赖，可在 node 下单测。
 *
 * 口径说明：
 * - byDay 的日期从记录自身派生：`notifiedAt`（推送时间）优先，静音/失败命中
 *   回退 `topic.lastActiveAt`（与 UI 时间列同款回退序）；两者都缺失或无效
 *   ISO → 该条计入 total / byMatchedBy / bySource / keywordHits / 失败率，
 *   但不进 byDay（没有可靠日期可归）。日期格式化走 formatLocalDate
 *   （本地时区单一口径，禁 toISOString().slice(0,10)）。
 * - pushFailRate = notifyError 非空（非 null 且非 ''）的占比；total=0 时为 0。
 *   静音（notifyError=null）不是失败。
 * - keywordHits：遍历 matchedKeywords 计数（大小写不敏感归并，展示用首见
 *   原形），count 降序（并列保持首见序）；cfg.includeKeywords 中从未命中的
 *   词以 count=0 + zeroHit=true **附尾**（保持配置序）——"考虑移除或改写"
 *   提示的数据依据。
 * - bySource 按 count 降序，并列按 sourceId 字典序（结果确定）。
 */
import { formatLocalDate } from './hits-store'
import type { HitRecord } from '../../shared/types'
import type { StatsResult } from '../../shared/ipc'

export type { StatsResult }

/** computeStats 的配置入参 */
export interface ComputeStatsConfig {
  /**
   * 当前配置的包含词列表（零命中关键词的检出基准）。与历史记录的
   * matchedKeywords 做大小写不敏感比对（关键词中途改大小写不会误报零命中）。
   */
  includeKeywords: string[]
}

/** 关键词计数的内部形状：key 用小写归并，form 保留首见原形用于展示 */
interface KeywordCount {
  form: string
  count: number
}

/** 记录 → 本地日期（byDay 归属）；无可靠日期 → null（见文件头注释） */
function dayOf(hit: HitRecord): string | null {
  const iso = hit.notifiedAt ?? hit.topic.lastActiveAt
  if (iso == null || iso === '') return null
  const ts = new Date(iso).getTime()
  if (Number.isNaN(ts)) return null
  return formatLocalDate(new Date(ts))
}

/**
 * 聚合一批命中记录为 StatsResult。纯函数：同输入同输出，不碰文件与时钟。
 */
export function computeStats(hits: HitRecord[], cfg: ComputeStatsConfig): StatsResult {
  const byMatchedBy = { literal: 0, semantic: 0, rule: 0, matchall: 0 }
  const dayCounts = new Map<string, number>()
  const sourceCounts = new Map<string, number>()
  const keywordCounts = new Map<string, KeywordCount>() // key = 小写
  let failCount = 0

  for (const hit of hits) {
    if (hit.matchedBy === 'literal') byMatchedBy.literal += 1
    else if (hit.matchedBy === 'semantic') byMatchedBy.semantic += 1
    else if (hit.matchedBy === 'matchall') byMatchedBy.matchall += 1
    else byMatchedBy.rule += 1
    const day = dayOf(hit)
    if (day !== null) dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1)
    const sourceId = hit.topic.sourceId
    sourceCounts.set(sourceId, (sourceCounts.get(sourceId) ?? 0) + 1)
    for (const kw of hit.matchedKeywords) {
      const key = kw.toLowerCase()
      const cur = keywordCounts.get(key)
      if (cur !== undefined) cur.count += 1
      else keywordCounts.set(key, { form: kw, count: 1 })
    }
    if (hit.notifyError != null && hit.notifyError !== '') failCount += 1
  }

  // 关键词榜：有命中的 count 降序（Map 保持首见插入序，sort 稳定 → 并列首见序）
  const hitKeywords = [...keywordCounts.values()]
    .sort((a, b) => b.count - a.count)
    .map((k) => ({ keyword: k.form, count: k.count }))

  // 零命中关键词：当前配置包含词中从未出现的（大小写不敏感比对），附尾保持配置序
  const zeroHitKeywords: { keyword: string; count: 0; zeroHit: true }[] = []
  for (const raw of cfg.includeKeywords) {
    const kw = raw.trim()
    if (kw === '') continue
    if (keywordCounts.has(kw.toLowerCase())) continue
    keywordCounts.set(kw.toLowerCase(), { form: kw, count: 0 }) // 同形重复配置词只列一次
    zeroHitKeywords.push({ keyword: kw, count: 0, zeroHit: true })
  }

  return {
    total: hits.length,
    // 'YYYY-MM-DD' 字典序 = 时间序，倒排 → 新→旧
    byDay: [...dayCounts.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    byMatchedBy,
    bySource: [...sourceCounts.entries()]
      .map(([sourceId, count]) => ({ sourceId, count }))
      .sort((a, b) => b.count - a.count || (a.sourceId < b.sourceId ? -1 : 1)),
    keywordHits: [...hitKeywords, ...zeroHitKeywords],
    pushFailRate: hits.length === 0 ? 0 : failCount / hits.length
  }
}
