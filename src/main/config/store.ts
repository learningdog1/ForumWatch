/**
 * 配置存储（ADR 3 / ADR 8.7）。
 *
 * - `config.json` 含 bot token 等敏感信息：**绝不入 git**，文件权限 `0o600`
 *   （在 tmp 上先 chmod 再 rename，文件从不存在的那一刻起就是 600）。
 * - 纯 JSON + `schemaVersion`，原子写（同目录 tmp + `renameSync`）。
 * - 损坏容错：读不出 / 非法 JSON / schema 不认识 → 备份成 `{file}.corrupt-{ts}`
 *   后返回默认配置的深拷贝，绝不抛（ADR 3）。
 * - 盘上格式：`{ "schemaVersion": 1, "config": AppConfig }`（缩进 2 空格）。
 *
 * 零 electron 依赖，可在 node 下单测与 headless 直跑（ADR 2）。
 */
import { randomInt } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_APP_CONFIG, type AppConfig, type ProxyScope } from '../../shared/types'

/** 轮询间隔下限（秒），低于此值按服务器友好频率钳制 */
export const MIN_POLL_INTERVAL_SEC = 15
/** pollIntervalSec 非法（非数字 / NaN / Infinity）时的回退值 */
export const FALLBACK_POLL_INTERVAL_SEC = 60

const CONFIG_SCHEMA_VERSION = 1
const PROXY_URL_PREFIXES = ['http://', 'https://', 'socks5://'] as const
const PROXY_SCOPES: readonly ProxyScope[] = ['all', 'telegram-only']

/** 盘上 JSON 的外层形状 */
interface ConfigFileEnvelope {
  schemaVersion: number
  config: Partial<AppConfig>
}

/**
 * 清洗用户/盘上来的配置：永远返回全新对象（不改入参），且字段类型一定合法。
 * - 关键词数组：trim、去空、去重（不区分大小写，保留首次出现的写法）。
 * - `pollIntervalSec`：非数字/NaN/Infinity → 60；否则钳到 ≥15。
 * - `proxyUrl`：trim；非空时必须以 `http://` `https://` `socks5://` 开头（忽略大小写），否则置 ''。
 * - `proxyScope`：只认 'all' | 'telegram-only'，非法回退 'telegram-only'。
 * - `telegram.botToken` / `telegram.chatId`：trim。
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
    launchAtLogin: src.launchAtLogin === true
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
   * - 损坏（读失败 / 非法 JSON / 外层形状或 schemaVersion 不对）→
   *   备份 `{file}.corrupt-{ts}` + 默认配置深拷贝，不抛；
   * - 合法 → 合并到默认值上再 sanitize（盘上缺字段也能得到完整合法的配置）。
   */
  load(): AppConfig {
    this.config = this.readFromDisk()
    return structuredClone(this.config)
  }

  /** 取当前配置；未 load 过则先 load。返回深拷贝，调用方改动不会污染内部状态。 */
  get(): AppConfig {
    return this.config ?? this.load()
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
   * 浅合并更新：顶层字段直接覆盖；`telegram` 是嵌套对象，传入即**整体替换**
   * （想只改 token 就得把 chatId 一起带上）。合并后过 sanitize 再落盘。
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
    if (!isConfigEnvelope(parsed)) return this.backupCorruptAndDefault(raw)

    const loaded = (parsed as ConfigFileEnvelope).config
    const defaults = structuredClone(DEFAULT_APP_CONFIG)
    return sanitizeConfig({
      ...defaults,
      ...loaded,
      telegram: { ...defaults.telegram, ...(loaded.telegram ?? {}) }
    })
  }

  private backupCorruptAndDefault(content: string): AppConfig {
    const backupPath = `${this.filePath}.corrupt-${Date.now()}`
    try {
      writeFileSync(backupPath, content, 'utf-8')
      console.error(`[config] config file corrupt, backed up to ${backupPath}; using defaults`)
    } catch (err) {
      console.error(`[config] config file corrupt and backup to ${backupPath} failed:`, err)
    }
    return structuredClone(DEFAULT_APP_CONFIG)
  }
}

/** 外层形状校验：`{schemaVersion:1, config:object}` 之外的都按损坏处理 */
function isConfigEnvelope(raw: unknown): raw is ConfigFileEnvelope {
  if (typeof raw !== 'object' || raw === null) return false
  const env = raw as Partial<ConfigFileEnvelope>
  return env.schemaVersion === CONFIG_SCHEMA_VERSION && typeof env.config === 'object' && env.config !== null
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
