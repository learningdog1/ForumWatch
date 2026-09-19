/**
 * 配置迁移（D2：纯函数，零 electron / 零 fs / 零日志）。
 *
 * - `migrateConfigEnvelope`：把盘上信封（`{schemaVersion, config}`）迁移到 v2 形状。
 *   v1 → v2 保留全部 v1 字段，补 `sources`（默认单项 nodeseek）与 `ai`
 *   （DEFAULT_APP_CONFIG.ai 深拷贝）；v2 原样透传（后续 sanitize 由 ConfigStore 做）。
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
export const MIGRATOR_TARGET_VERSION = 2

/** v1 信封里合法的 config 是「不含 sources/ai 的 AppConfig 子集」，按 Partial 读取 */
type V1Config = Partial<Omit<AppConfig, 'sources' | 'ai'>>

/**
 * 未知信封 → v2 AppConfig。形状非法时抛 Error（不返回默认值：损坏与否由
 * store 的备份路径决定，迁移函数只负责「能迁的迁，不能迁的报错」）。
 */
export function migrateConfigEnvelope(raw: unknown): AppConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('config envelope is not an object')
  }
  const env = raw as Partial<ConfigEnvelope>
  if (env.schemaVersion !== 1 && env.schemaVersion !== MIGRATOR_TARGET_VERSION) {
    throw new Error(`unknown config schemaVersion: ${String(env.schemaVersion)}`)
  }
  if (typeof env.config !== 'object' || env.config === null) {
    throw new Error('config envelope missing config object')
  }

  // v2 → 原样透传（含缺字段的残缺 config：后续 merge DEFAULT + sanitize 兜底）
  if (env.schemaVersion === MIGRATOR_TARGET_VERSION) {
    return structuredClone(env.config) as AppConfig
  }

  // v1 → v2：保留全部 v1 字段（缺的 v1 字段用默认值兜底）+ sources/ai 强制走
  // 默认值（v1 没有多来源与 AI 概念，盘上即使残留同名垃圾字段也不采信）
  const v1 = structuredClone(env.config) as V1Config
  const base = structuredClone(DEFAULT_APP_CONFIG)
  return {
    ...base,
    ...v1,
    sources: base.sources,
    ai: base.ai
  }
}
