/**
 * 配置迁移（D2：纯函数，零 electron / 零 fs / 零日志）。
 *
 * - `migrateConfigEnvelope`：把盘上信封（`{schemaVersion, config}`）沿迁移链
 *   （v1 → v2 → v3 → v4）迁到当前形状。
 *   - v1 → v2 保留全部 v1 字段，补 `sources`（默认单项 nodeseek）与 `ai`
 *     （DEFAULT_APP_CONFIG.ai 深拷贝）；
 *   - v2 → v3 只动 `sources`：v2 盘上形状是 `{id, type:'nodeseek', enabled}`
 *     （type 恒 nodeseek），逐项映射为 NodeseekSourceConfig；其余段原样保留。
 *   - v3 → v4 只动 `sources` 里 rss 来源的 url：LowEndTalk 预设错误地址
 *     `https://lowendtalk.com/feed`（恒 404）重写为
 *     `https://lowendtalk.com/discussions/feed.rss`（见 v3ToV4）。
 *   - v4 原样透传（幂等；后续 sanitize 由 ConfigStore 做）。
 *   - 链尾统一过 `normalizeLegacyChannels`（R6-W1 读兼容，见该函数注释）。
 * - **迁移只做纯函数变换，不做校验**：残缺 sources（非数组 / 空数组 / 缺 type /
 *   非对象项）原样透传，合法性由 store 的 merge DEFAULT + sanitize 兜底。
 * - 形状不对（非对象 / 缺 config / 未知 schemaVersion）**抛 Error**——由 ConfigStore
 *   的 corrupt 备份路径接管（备份 + 回默认，行为与 v1 时代一致）。
 * - 返回值与入参不共享任何引用（深拷贝），调用方可安全 mutate。
 */
import {
  DEFAULT_APP_CONFIG,
  type AppConfig,
  type ChannelConfig,
  type TelegramConfig
} from '../../shared/types'

/** 盘上 config.json 的外层信封形状 */
export interface ConfigEnvelope {
  schemaVersion: number
  config: unknown
}

/** 当前契约版本（与 store.ts 的 CONFIG_SCHEMA_VERSION 对齐，写盘用那边的常量） */
export const MIGRATOR_TARGET_VERSION = 4

/** v1 信封里合法的 config 是「不含 sources/ai 的 AppConfig 子集」，按 Partial 读取 */
type V1Config = Partial<Omit<AppConfig, 'sources' | 'ai'>>

/**
 * R6-W1 前的盘上 config 形状：telegram 段仍在（旧顶层键），channels/notify/
 * routing 可能缺失（迁移链中段的合法形态；出链前由 normalizeLegacyChannels
 * 补齐 channels）。telegram 键在出 migrateConfigEnvelope 后仍可残留——剔除
 * 发生在 store 的 sanitize（写路径只写新形状）。
 */
type PreR6Config = Omit<AppConfig, 'channels' | 'notify' | 'routing'> &
  Partial<Pick<AppConfig, 'channels' | 'notify' | 'routing'>> & {
    telegram?: TelegramConfig
  }

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
    env.schemaVersion !== 3 &&
    env.schemaVersion !== MIGRATOR_TARGET_VERSION
  ) {
    throw new Error(`unknown config schemaVersion: ${String(env.schemaVersion)}`)
  }
  if (typeof env.config !== 'object' || env.config === null) {
    throw new Error('config envelope missing config object')
  }

  // v4 → 原样透传（幂等；含缺字段的残缺 config：后续 merge DEFAULT + sanitize 兜底）
  if (env.schemaVersion === MIGRATOR_TARGET_VERSION) {
    return normalizeLegacyChannels(structuredClone(env.config) as PreR6Config)
  }

  // v3 → 只做 v3→v4（不能再过 v2ToV3：那会把 v3 盘上的 rss/v2ex 来源强改为 nodeseek）
  if (env.schemaVersion === 3) {
    return normalizeLegacyChannels(v3ToV4(structuredClone(env.config) as PreR6Config))
  }

  // v1/v2 迁移链：v1 先升 v2，再统一走 v2 → v3 → v4；链尾统一做 R6-W1 旧 telegram 读兼容
  const v2 = env.schemaVersion === 1 ? v1ToV2(env.config) : (structuredClone(env.config) as PreR6Config)
  return normalizeLegacyChannels(v3ToV4(v2ToV3(v2)))
}

/**
 * v1 → v2：保留全部 v1 字段（缺的 v1 字段用默认值兜底）+ sources/ai 强制走
 * 默认值（v1 没有多来源与 AI 概念，盘上即使残留同名垃圾字段也不采信）。
 * channels **不**从默认值注入：v1 的 telegram 凭据走链尾 normalizeLegacyChannels
 * 映射进 channels，若这里先垫上默认 channels 会把它挡掉（"已有 channels 忽略
 * telegram"）。notify / routing v1 同样没有概念，注入默认值无害（无旧键冲突）。
 */
function v1ToV2(config: unknown): PreR6Config {
  const v1 = structuredClone(config) as V1Config
  const base = structuredClone(DEFAULT_APP_CONFIG)
  return {
    ...base,
    ...v1,
    sources: base.sources,
    ai: base.ai,
    // channels 不从默认值垫底：v1 的 telegram 凭据由链尾 normalizeLegacyChannels
    // 映射进 channels；先垫默认 channels 会把它挡掉（"已有 channels 忽略 telegram"）。
    // v1 盘上没有 channels 概念，这里运行时恒为 undefined。
    channels: v1.channels
  }
}

/**
 * v2 → v3：只动 `sources`，其余段原样保留（浅拷贝 + sources 重映射）。
 * v2 时代 type 恒为 'nodeseek'（当时 SourceConfig 只有这一个取值），因此无论
 * 盘上 type 是什么（含缺失/垃圾值——旧版 sanitize 本就强制写 'nodeseek'），
 * 逐项映射为 NodeseekSourceConfig 形状；项上多余/残缺字段不校验不裁剪，
 * 交给后续 sanitize。非数组 sources 整体透传（残缺输入，sanitize 兜底）。
 */
function v2ToV3(config: PreR6Config): PreR6Config {
  const next = structuredClone(config) as PreR6Config & { sources: unknown }
  if (!Array.isArray(next.sources)) return next
  next.sources = next.sources.map((item) =>
    typeof item === 'object' && item !== null ? { ...item, type: 'nodeseek' } : item
  )
  return next
}

/**
 * v3 → v4：只动 `sources` 里 rss 来源的 `url`——LowEndTalk 预设曾携带错误地址
 * `https://lowendtalk.com/feed`（Vanilla 站点该路径不存在，恒 404），修正为全站
 * feed `https://lowendtalk.com/discussions/feed.rss`。按 url 精确匹配重写（不限
 * id：预设 id 'lowendtalk' 与自定义 slug 化 id 两种添加路径都会命中；用户手输
 * 同一错误地址同样受益——它本来就是 404）。其余来源/字段一律不动；非数组
 * sources 整体透传（sanitize 兜底）。幂等：已是新地址的盘再跑一遍无变化。
 */
const LOWENDTALK_BAD_FEED_URL = 'https://lowendtalk.com/feed'
const LOWENDTALK_FEED_URL = 'https://lowendtalk.com/discussions/feed.rss'

function v3ToV4(config: PreR6Config): PreR6Config {
  const next = structuredClone(config) as PreR6Config & { sources: unknown }
  if (!Array.isArray(next.sources)) return next
  next.sources = next.sources.map((item) =>
    typeof item === 'object' &&
    item !== null &&
    (item as { type?: unknown }).type === 'rss' &&
    (item as { url?: unknown }).url === LOWENDTALK_BAD_FEED_URL
      ? { ...item, url: LOWENDTALK_FEED_URL }
      : item
  )
  return next
}

/**
 * R6-W1 盘上读兼容（DEC-9：读时兼容映射，写时只写新形状）：
 * 旧顶层 `telegram.botToken/chatId` → `channels[0]` 的 telegram 通道。
 * - `channels` 缺失/为空 **且** 旧 telegram 任一凭据非空 → 合成
 *   `{id:'telegram', type:'telegram', enabled:true, botToken, chatId}`；
 * - 两者都没有（全新安装 / 旧盘但从未配 telegram）→ 默认空凭据 telegram 通道
 *   （对齐 DEFAULT_APP_CONFIG.channels）；
 * - 已有 channels（新代码写入）→ 原样保留，**忽略**残留的旧 telegram 键
 *   （双轨=永久漂移债，ultrabrain 已否决；旧键的剔除由 sanitize 完成）。
 * 纯函数：入参不 mutate，channels 项一律新建（不与入参共享引用）。
 * 残缺 channels 项（非对象/未知 type）不在此校验——normalize 只负责"有没有"，
 * 合法性由 store 的 sanitize 兜底（ sanitize 全弃时回默认 telegram 项）。
 */
export function normalizeLegacyChannels(cfg: PreR6Config): AppConfig {
  const channels = Array.isArray(cfg.channels) ? cfg.channels : []
  let resolved: ChannelConfig[]
  if (channels.length > 0) {
    resolved = channels.map((ch) => ({ ...ch }))
  } else {
    const legacy: Partial<TelegramConfig> =
      typeof cfg.telegram === 'object' && cfg.telegram !== null ? cfg.telegram : {}
    const botToken = typeof legacy.botToken === 'string' ? legacy.botToken.trim() : ''
    const chatId = typeof legacy.chatId === 'string' ? legacy.chatId.trim() : ''
    resolved =
      botToken !== '' || chatId !== ''
        ? [{ id: 'telegram', type: 'telegram', enabled: true, botToken, chatId }]
        : structuredClone(DEFAULT_APP_CONFIG.channels)
  }
  return { ...cfg, channels: resolved } as AppConfig
}
