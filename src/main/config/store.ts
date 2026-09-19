/**
 * 配置存储（ADR 3 / ADR 8.7 / D2）。
 *
 * - `config.json` 含 bot token / apiKey 等敏感信息：**绝不入 git**，文件权限 `0o600`
 *   （在 tmp 上先 chmod 再 rename，文件从不存在的那一刻起就是 600）。
 * - 纯 JSON + `schemaVersion`，原子写（同目录 tmp + `renameSync`）。
 * - 损坏容错：读不出 / 非法 JSON / 迁移函数拒认 → 备份成 `{file}.corrupt-{ts}`
 *   后返回默认配置的深拷贝，绝不抛（ADR 3）。
 * - 盘上格式：`{ "schemaVersion": 2, "config": AppConfig }`（缩进 2 空格）。
 *   load 路径：JSON.parse → `migrateConfigEnvelope`（v1→v2，见 migrations.ts）→
 *   合并 DEFAULT → sanitize。
 *
 * 零 electron 依赖，可在 node 下单测与 headless 直跑（ADR 2）。
 */
import { randomInt } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  DEFAULT_APP_CONFIG,
  type AppConfig,
  type AiConfig,
  type MatchMode,
  type ProxyScope,
  type SourceConfig
} from '../../shared/types'
import { migrateConfigEnvelope } from './migrations'

/** 轮询间隔下限（秒），低于此值按服务器友好频率钳制 */
export const MIN_POLL_INTERVAL_SEC = 15
/** pollIntervalSec 非法（非数字 / NaN / Infinity）时的回退值 */
export const FALLBACK_POLL_INTERVAL_SEC = 60

const CONFIG_SCHEMA_VERSION = 2
// 与 http.ts 的 resolveDispatcherSpec 支持面保持一致（socks5h = 远端 DNS 解析）
const PROXY_URL_PREFIXES = ['http://', 'https://', 'socks5://', 'socks5h://'] as const
const PROXY_SCOPES: readonly ProxyScope[] = ['all', 'telegram-only']
const AI_MATCH_MODES: readonly MatchMode[] = ['literal', 'semantic', 'both']
/** AI baseUrl 只认 http(s)（D6：请求时拼 /chat/completions） */
const AI_BASE_URL_PREFIXES = ['http://', 'https://'] as const
/** 兴趣描述条数上限（D4：批式评估的输入规模控制） */
const AI_INTERESTS_MAX_ITEMS = 20
/** 单条兴趣描述长度上限（字符） */
const AI_INTERESTS_MAX_CHARS = 500
/** timeHHMM 非法时的回退值 */
const DEFAULT_REPORT_TIME_HHMM = '22:00'
const TIME_HHMM_RE = /^\d{2}:\d{2}$/
/** sources 的 id 只允许 slug 字符（与去重键前缀、状态键一致），其余替换为 '-' */
const SOURCE_ID_ILLEGAL_RE = /[^\w-]/g

/**
 * 清洗用户/盘上来的配置：永远返回全新对象（不改入参），且字段类型一定合法。
 * - 关键词数组：trim、去空、去重（不区分大小写，保留首次出现的写法）。
 * - `pollIntervalSec`：非数字/NaN/Infinity → 60；否则钳到 ≥15。
 * - `proxyUrl`：trim；非空时必须以 `http://` `https://` `socks5://` `socks5h://` 开头（忽略大小写），否则置 ''。
 * - `proxyScope`：只认 'all' | 'telegram-only'，非法回退 'telegram-only'。
 * - `telegram.botToken` / `telegram.chatId`：trim。
 * - `sources`：非数组/空 → 默认单项 nodeseek；每项 id 规范成 slug（非法字符替换 '-'，
 *   空则丢弃该项）、type 恒 'nodeseek'、enabled 布尔化；按 id 去重（保留首个）。
 * - `ai.provider.baseUrl`：trim、去尾斜杠、必须 `http(s)://` 开头否则 ''；
 *   `apiKey` / `model` trim；`matchMode` 枚举非法回 'literal'；`interests` 每条 trim
 *   去空、单条 ≤500 字符截断、最多 20 条；`dailyReport.timeHHMM` 必须 HH:MM（时 0-23
 *   分 0-59）否则回 '22:00'，`enabled` 强制布尔；`commentary.enabled` 缺失/非法 →
 *   true（**唯一默认开的布尔**，方向与其余布尔相反，见 sanitizeAi）。
 */
export function sanitizeConfig(cfg: AppConfig): AppConfig {
  const src = (typeof cfg === 'object' && cfg !== null ? cfg : {}) as Partial<AppConfig>
  return {
    includeKeywords: sanitizeKeywordList(src.includeKeywords),
    excludeKeywords: sanitizeKeywordList(src.excludeKeywords),
    pollIntervalSec: sanitizePollIntervalSec(src.pollIntervalSec),
    proxyUrl: sanitizeProxyUrl(src.proxyUrl),
    proxyScope: sanitizeProxyScope(src.proxyScope),
    telegram: {
      botToken: sanitizeToken(src.telegram?.botToken),
      chatId: sanitizeToken(src.telegram?.chatId)
    },
    notifyEnabled: src.notifyEnabled === true,
    launchAtLogin: src.launchAtLogin === true,
    sources: sanitizeSources(src.sources),
    ai: sanitizeAi(src.ai)
  }
}

export class ConfigStore {
  private readonly filePath: string
  private config: AppConfig | null = null

  constructor(filePath: string) {
    this.filePath = filePath
  }

  /**
   * 从磁盘加载。
   * - 文件缺失 → 默认配置深拷贝；
   * - 损坏（读失败 / 非法 JSON / 信封形状或版本被迁移函数拒认）→
   *   备份 `{file}.corrupt-{ts}` + 默认配置深拷贝，不抛；
   * - 合法（v1 先迁移到 v2）→ 合并到默认值上再 sanitize（盘上缺字段也能得到
   *   完整合法的配置）。
   */
  load(): AppConfig {
    this.config = this.readFromDisk()
    return structuredClone(this.config)
  }

  /** 取当前配置；未 load 过则先 load。返回深拷贝，调用方改动不会污染内部状态。 */
  get(): AppConfig {
    return structuredClone(this.config ?? this.load())
  }

  /**
   * 清洗后原子写盘（tmp + rename，chmod 0o600），并更新内存值。
   * 与 FileSeenStore.flush 不同：配置写失败**向上抛**（用户刚改的设置落不了盘
   * 不该被吞掉，由调用方决定如何提示）。
   */
  save(cfg: AppConfig): void {
    const clean = sanitizeConfig(cfg)
    const payload = JSON.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, config: clean }, null, 2)
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${randomInt(0, 0xffffff).toString(36)}`
    mkdirSync(dirname(this.filePath), { recursive: true })
    try {
      writeFileSync(tmpPath, payload, 'utf-8')
      chmodSync(tmpPath, 0o600) // rename 前收紧权限：文件从未以宽松权限存在过
      renameSync(tmpPath, this.filePath)
    } catch (err) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // tmp 清理失败可忽略（残留无敏感内容之外的危害，内容本身也是 600）
      }
      throw err
    }
    this.config = clean
  }

  /**
   * 浅合并更新：顶层字段直接覆盖；`telegram` / `sources` / `ai` 是嵌套对象与数组，
   * 传入即**整体替换**（想只改 token 就得把 chatId 一起带上）。合并后过 sanitize
   * 再落盘。
   * @returns 落盘后的新配置（sanitize 之后的生效值）
   */
  update(patch: Partial<AppConfig>): AppConfig {
    const current = this.get()
    const merged: AppConfig = { ...current, ...patch }
    this.save(merged)
    return this.get()
  }

  // ---- 内部实现 ----------------------------------------------------------

  private readFromDisk(): AppConfig {
    if (!existsSync(this.filePath)) return structuredClone(DEFAULT_APP_CONFIG)

    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf-8')
    } catch (err) {
      console.error(`[config] cannot read ${this.filePath}, using defaults:`, err)
      return structuredClone(DEFAULT_APP_CONFIG)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return this.backupCorruptAndDefault(raw)
    }
    // v1 信封在这里迁移到 v2；形状不对（非对象/缺 config/未知版本）抛错 → 按损坏处理
    let migrated: AppConfig
    try {
      migrated = migrateConfigEnvelope(parsed)
    } catch {
      return this.backupCorruptAndDefault(raw)
    }

    const defaults = structuredClone(DEFAULT_APP_CONFIG)
    return sanitizeConfig({
      ...defaults,
      ...migrated,
      telegram: { ...defaults.telegram, ...(migrated.telegram ?? {}) }
    })
  }

  private backupCorruptAndDefault(content: string): AppConfig {
    const backupPath = `${this.filePath}.corrupt-${Date.now()}`
    try {
      writeFileSync(backupPath, content, 'utf-8')
      // 备份内容含 bot token 等敏感信息：权限与主文件一致收紧到 600
      chmodSync(backupPath, 0o600)
      console.error(`[config] config file corrupt, backed up to ${backupPath}; using defaults`)
    } catch (err) {
      console.error(`[config] config file corrupt and backup to ${backupPath} failed:`, err)
    }
    return structuredClone(DEFAULT_APP_CONFIG)
  }
}

function sanitizeKeywordList(list: string[] | undefined): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (typeof item !== 'string') continue
    const kw = item.trim()
    if (kw.length === 0) continue
    const key = kw.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(kw)
  }
  return out
}

function sanitizePollIntervalSec(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return FALLBACK_POLL_INTERVAL_SEC
  return Math.max(MIN_POLL_INTERVAL_SEC, value)
}

function sanitizeProxyUrl(value: string | undefined): string {
  if (typeof value !== 'string') return ''
  const url = value.trim()
  if (url.length === 0) return ''
  const lower = url.toLowerCase()
  return PROXY_URL_PREFIXES.some((prefix) => lower.startsWith(prefix)) ? url : ''
}

function sanitizeProxyScope(value: ProxyScope | undefined): ProxyScope {
  return PROXY_SCOPES.includes(value as ProxyScope) ? (value as ProxyScope) : 'telegram-only'
}

function sanitizeToken(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

function sanitizeSources(list: SourceConfig[] | undefined): SourceConfig[] {
  if (!Array.isArray(list) || list.length === 0) {
    return structuredClone(DEFAULT_APP_CONFIG.sources)
  }
  const out: SourceConfig[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const rawId = (item as Partial<SourceConfig>).id
    if (typeof rawId !== 'string') continue
    const id = rawId.trim().replace(SOURCE_ID_ILLEGAL_RE, '-')
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    out.push({ id, type: 'nodeseek', enabled: item.enabled === true })
  }
  // 全部项非法（或去重后为空）→ 回默认单项，绝不落空列表（空列表 = 无来源可监控）
  return out.length > 0 ? out : structuredClone(DEFAULT_APP_CONFIG.sources)
}

function sanitizeAi(ai: AiConfig | undefined): AiConfig {
  return {
    provider: {
      baseUrl: sanitizeAiBaseUrl(ai?.provider?.baseUrl),
      apiKey: sanitizeToken(ai?.provider?.apiKey),
      model: sanitizeToken(ai?.provider?.model)
    },
    matchMode: AI_MATCH_MODES.includes(ai?.matchMode as MatchMode)
      ? (ai?.matchMode as MatchMode)
      : 'literal',
    interests: sanitizeInterests(ai?.interests),
    dailyReport: {
      enabled: ai?.dailyReport?.enabled === true,
      timeHHMM: sanitizeTimeHHMM(ai?.dailyReport?.timeHHMM)
    },
    // AI 锐评开关——全文件**唯一默认开的布尔**：必须写 `!== false`（缺失/非法 → true），
    // 与本文件其余布尔（dailyReport.enabled / notifyEnabled / launchAtLogin /
    // sources[].enabled 均为 `=== true`，缺省 false）方向相反。
    // 原因：锐评是第三轮新增字段，全体旧配置文件（v1 迁移件与早期 v2）都没有它，
    // 若"风格统一"改成 `=== true`，会把所有老用户的锐评静默关掉。改向前先想清楚。
    commentary: {
      enabled: ai?.commentary?.enabled !== false
    }
  }
}

function sanitizeAiBaseUrl(value: string | undefined): string {
  if (typeof value !== 'string') return ''
  // 先去尾斜杠再验前缀：退化输入 'http://' 去尾后是 'http:'，不该被保留
  const url = value.trim().replace(/\/+$/, '')
  if (url.length === 0) return ''
  const lower = url.toLowerCase()
  return AI_BASE_URL_PREFIXES.some((prefix) => lower.startsWith(prefix)) ? url : ''
}

function sanitizeInterests(list: string[] | undefined): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const s = item.trim().slice(0, AI_INTERESTS_MAX_CHARS)
    if (s.length === 0) continue
    out.push(s)
    if (out.length >= AI_INTERESTS_MAX_ITEMS) break
  }
  return out
}

function sanitizeTimeHHMM(value: string | undefined): string {
  if (typeof value !== 'string' || !TIME_HHMM_RE.test(value)) return DEFAULT_REPORT_TIME_HHMM
  const hh = Number(value.slice(0, 2))
  const mm = Number(value.slice(3, 5))
  if (!Number.isInteger(hh) || hh > 23 || !Number.isInteger(mm) || mm > 59) {
    return DEFAULT_REPORT_TIME_HHMM
  }
  return value
}
