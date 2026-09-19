/**
 * 配置迁移（D2：纯函数，零 electron / 零 fs / 零日志）。
 *
 * - `migrateConfigEnvelope`：把盘上信封（`{schemaVersion, config}`）沿迁移链
 *   （v1 → v2 → v3）迁到当前形状。
 *   - v1 → v2 保留全部 v1 字段，补 `sources`（默认单项 nodeseek）与 `ai`
 *     （DEFAULT_APP_CONFIG.ai 深拷贝）；
 *   - v2 → v3 只动 `sources`：v2 盘上形状是 `{id, type:'nodeseek', enabled}`
 *     （type 恒 nodeseek），逐项映射为 NodeseekSourceConfig；其余段原样保留。
 *   - v3 原样透传（幂等；后续 sanitize 由 ConfigStore 做）。
 * - **迁移只做纯函数变换，不做校验**：残缺 sources（非数组 / 空数组 / 缺 type /
 *   非对象项）原样透传，合法性由 store 的 merge DEFAULT + sanitize 兜底。
 * - 形状不对（非对象 / 缺 config / 未知 schemaVersion）**抛 Error**——由 ConfigStore
 *   的 corrupt 备份路径接管（备份 + 回默认，行为与 v1 时代一致）。
 * - 返回值与入参不共享任何引用（深拷贝），调用方可安全 mutate。
 */
import { DEFAULT_APP_CONFIG, type AppConfig } from '../../shared/types'

/** 盘上 config.json 的外层信封形状 */
export interface ConfigEnvelope {
  schemaVersion: number
  config: unknown
}

/** 当前契约版本（与 store.ts 的 CONFIG_SCHEMA_VERSION 对齐，写盘用那边的常量） */
export const MIGRATOR_TARGET_VERSION = 3

/** v1 信封里合法的 config 是「不含 sources/ai 的 AppConfig 子集」，按 Partial 读取 */
type V1Config = Partial<Omit<AppConfig, 'sources' | 'ai'>>

/**
 * 未知信封 → v3 AppConfig。形状非法时抛 Error（不返回默认值：损坏与否由
 * store 的备份路径决定，迁移函数只负责「能迁的迁，不能迁的报错」）。
 */
export function migrateConfigEnvelope(raw: unknown): AppConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('config envelope is not an object')
  }
  const env = raw as Partial<ConfigEnvelope>
  if (
    env.schemaVersion !== 1 &&
    env.schemaVersion !== 2 &&
    env.schemaVersion !== MIGRATOR_TARGET_VERSION
  ) {
    throw new Error(`unknown config schemaVersion: ${String(env.schemaVersion)}`)
  }
  if (typeof env.config !== 'object' || env.config === null) {
    throw new Error('config envelope missing config object')
  }

  // v3 → 原样透传（幂等；含缺字段的残缺 config：后续 merge DEFAULT + sanitize 兜底）
  if (env.schemaVersion === MIGRATOR_TARGET_VERSION) {
    return structuredClone(env.config) as AppConfig
  }

  // 迁移链：v1 先升 v2，再统一走 v2 → v3
  const v2 = env.schemaVersion === 1 ? v1ToV2(env.config) : (structuredClone(env.config) as AppConfig)
  return v2ToV3(v2)
}

/**
 * v1 → v2：保留全部 v1 字段（缺的 v1 字段用默认值兜底）+ sources/ai 强制走
 * 默认值（v1 没有多来源与 AI 概念，盘上即使残留同名垃圾字段也不采信）。
 */
function v1ToV2(config: unknown): AppConfig {
  const v1 = structuredClone(config) as V1Config
  const base = structuredClone(DEFAULT_APP_CONFIG)
  return {
    ...base,
    ...v1,
    sources: base.sources,
    ai: base.ai
  }
}

/**
 * v2 → v3：只动 `sources`，其余段原样保留（浅拷贝 + sources 重映射）。
 * v2 时代 type 恒为 'nodeseek'（当时 SourceConfig 只有这一个取值），因此无论
 * 盘上 type 是什么（含缺失/垃圾值——旧版 sanitize 本就强制写 'nodeseek'），
 * 逐项映射为 NodeseekSourceConfig 形状；项上多余/残缺字段不校验不裁剪，
 * 交给后续 sanitize。非数组 sources 整体透传（残缺输入，sanitize 兜底）。
 */
function v2ToV3(config: AppConfig): AppConfig {
  const next = structuredClone(config) as AppConfig & { sources: unknown }
  if (!Array.isArray(next.sources)) return next
  next.sources = next.sources.map((item) =>
    typeof item === 'object' && item !== null ? { ...item, type: 'nodeseek' } : item
  )
  return next
}
