/**
 * 配置存储（ADR 3 / ADR 8.7 / D2；R9-W2 凭据加密落盘 DEC-10）。
 *
 * - `config.json` 含 bot token / apiKey 等敏感信息：**绝不入 git**，文件权限 `0o600`
 *   （在 tmp 上先 chmod 再 rename，文件从不存在的那一刻起就是 600）。
 * - 凭据加密落盘（R9-W2 / DEC-10，坑10 顺序纪律）：敏感字段（ai.provider.apiKey /
 *   channels 的 botToken·deviceKey·secret，见 secrets.ts SECRET_FIELD_PATHS）经注入的
 *   SecretBox 以 `enc:v1:` 密文落盘；**内存中永远是明文**（消费方零改动）。
 *   读 = migrate → **decrypt** → sanitize；写 = sanitize → **encrypt** → serialize
 *   ——两个方向上 sanitize 看到的都只能是明文，密文不会被 trim 破坏。信封不写
 *   `secretsEncrypted` 标志（字段值自带 marker，派生态不落盘成第二事实源）。
 *   构造不注入 secretBox 时缺省 PlainSecretBox（明文读写，既有测试/headless 语义）。
 * - 纯 JSON + `schemaVersion`，原子写（同目录 tmp + `renameSync`）。
 * - 损坏容错：读不出 / 非法 JSON / 迁移函数拒认 → 备份成 `{file}.corrupt-{ts}`
 *   后返回默认配置的深拷贝，绝不抛（ADR 3）。
 * - 盘上格式：`{ "schemaVersion": 4, "config": AppConfig }`（缩进 2 空格）。
 *   load 路径：JSON.parse → `migrateConfigEnvelope`（v1/v2 → v3 链式，见
 *   migrations.ts）→ 合并 DEFAULT → decryptSecretFields → sanitize。
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
  type ChannelConfig,
  type MatchMode,
  type NodeseekSourceConfig,
  type NotifyConfig,
  type PriceCurrency,
  type PriceCycle,
  type PriceRuleConfig,
  type ProxyScope,
  type RssSourceConfig,
  type RoutingRule,
  type RoutingWhen,
  type SourceConfig,
  type SourceFilters,
  type V2exSourceConfig
} from '../../shared/types'
import { migrateConfigEnvelope } from './migrations'
import {
  decryptSecretFields,
  encryptSecretFields,
  PlainSecretBox,
  type SecretBox
} from './secrets'

/** 轮询间隔下限（秒），低于此值按服务器友好频率钳制 */
export const MIN_POLL_INTERVAL_SEC = 15
/** pollIntervalSec 非法（非数字 / NaN / Infinity）时的回退值 */
export const FALLBACK_POLL_INTERVAL_SEC = 60

const CONFIG_SCHEMA_VERSION = 4
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
/** sources / priceRules 的 id 只允许 slug 字符（与去重键前缀、状态键一致），其余替换为 '-' */
const SOURCE_ID_ILLEGAL_RE = /[^\w-]/g
/** per-source filters 每个列表的条数上限（超出截断，对齐 includeKeywords 清洗风格） */
const SOURCE_FILTERS_MAX_ITEMS = 100
/** 价格规则条数上限（第五轮；超出截断） */
const PRICE_RULES_MAX_ITEMS = 20
/** 单条价格规则 keywords 的条数上限（超出截断） */
const PRICE_RULE_KEYWORDS_MAX_ITEMS = 20
/** 推送通道条数上限（第六轮 R6-W1；超出截断） */
const CHANNELS_MAX_ITEMS = 8
/** 路由规则条数上限（第六轮 R6-W1；超出截断） */
const ROUTING_RULES_MAX_ITEMS = 20
/** digest 间隔非法（非数字 / NaN / Infinity）时的回退值（分钟） */
const DEFAULT_DIGEST_INTERVAL_MIN = 15
/** Telegram 遥控允许 Chat ID 清单上限（R9-W1；超出截断） */
const REMOTE_CONTROL_MAX_CHAT_IDS = 10
/** 免打扰时段缺省回退（第六轮；与 DEFAULT_APP_CONFIG.notify.quietHours 对齐） */
const DEFAULT_QUIET_START_HHMM = '23:00'
const DEFAULT_QUIET_END_HHMM = '08:00'
const PRICE_CYCLES: readonly PriceCycle[] = ['yearly', 'monthly', 'any']
const PRICE_CURRENCIES: readonly PriceCurrency[] = ['CNY', 'USD', 'any']
const NOTIFY_MODES: readonly NotifyConfig['mode'][] = ['instant', 'digest']
/** routing.when.matchedBy 的合法枚举（与 HitRecord.matchedBy 同口径） */
const MATCHED_BY_VALUES = ['literal', 'semantic', 'rule'] as const
/** similarity.threshold 非法（非数字 / NaN / Infinity）时的回退值 */
const DEFAULT_SIMILARITY_THRESHOLD = 0.72

/**
 * 清洗用户/盘上来的配置：永远返回全新对象（不改入参），且字段类型一定合法。
 *
 * **隐式 schema 白名单（ultrabrain 坑4）**：本函数逐字段显式重建对象，没有列进
 * 重建的字段保存即丢——**types.ts 的契约新增字段时，必须在同一
 * commit 里补上这里的 sanitize 分支**（v3 的 filters / label / url、第五轮的
 * priceRules / similarity / ai.semanticThreshold 都是这么补的），
 * 并同步补 store.test.ts 的往返用例。
 *
 * - 关键词数组：trim、去空、去重（不区分大小写，保留首次出现的写法）。
 * - `pollIntervalSec`：非数字/NaN/Infinity → 60；否则钳到 ≥15。
 * - `proxyUrl`：trim；非空时必须以 `http://` `https://` `socks5://` `socks5h://` 开头（忽略大小写），否则置 ''。
 * - `proxyScope`：只认 'all' | 'telegram-only'，非法回退 'telegram-only'。
 * - `channels`（第六轮 R6-W1，见 sanitizeChannels）：非数组 → 默认单项 telegram；
 *   逐项按 type 分派重建（telegram: token/chatId trim，空凭据合法=未配置态；
 *   bark: deviceKey trim、serverUrl 非 http(s) 弃字段；ntfy: topic trim 且非空
 *   否则整项弃、serverUrl 同 bark；webhook: url 必须合法 http(s) URL 否则整项弃、
 *   secret trim 空不落键）；enabled 布尔化；id slug 化去重（缺 id 按类型派生，
 *   重复加 -2）；未知 type / 非对象整项弃；**列表恒至少保留一项**（全弃回默认
 *   telegram 项）；上限 8 条。旧顶层 `telegram` 键**不在白名单**——写路径只写
 *   新形状（读侧兼容由 migrations.normalizeLegacyChannels 负责）。
 * - `notify`（第六轮，见 sanitizeNotify）：mode 只认 'instant'|'digest' 非法回
 *   'instant'；digestIntervalMin 非法回 15、钳 [1,120]；quietHours.enabled 布尔化、
 *   startHHMM/endHHMM 格式非法分别回 '23:00'/'08:00'（复用 timeHHMM 校验口径）；
 *   remoteControl（R9-W1）enabled 布尔化（默认关）、allowedChatIds trim/去空/
 *   精确去重/上限 10。
 * - `routing`（第六轮，见 sanitizeRouting）：非数组 → []（空=不路由，合法状态）；
 *   上限 20 条；when.sourceId 悬挂（不在 sources）剔字段、matchedBy 枚举过滤
 *   （清洗后空不落键）、ruleId 悬挂（不在 priceRules）剔字段；when 清洗后全空
 *   → 整条弃；channelIds 只留存在的通道 id（过滤后空 → 整条弃）；id slug 化去重。
 * - `sources`（v3 判别联合，见 sanitizeSources）：非数组/空 → 默认单项 nodeseek；
 *   nodeseek/v2ex 项 id 规范 slug（非法字符替换 '-'，空则丢弃）、enabled 布尔化、
 *   filters 走 sanitizeFilters；rss 项同上且 **url 必须是合法 http(s) URL（能
 *   new URL 且有 host），否则整项丢弃**，label trim 后为空视为无，缺 id 时可从
 *   url host 派生建议 id（id 以用户给的为准）；未知 type 整项丢弃；按 id 全列表
 *   去重（保留首个）。
 * - `priceRules`（第五轮，见 sanitizePriceRules）：非数组 → []（空列表 = 无规则，
 *   合法状态）；整条非对象/无可用 id 丢弃；id slug 化去重、enabled 布尔化、
 *   cycle/currency 枚举非法（含缺失）回 'any'、label trim 空则不落键、
 *   maxPrice/minTrafficGB 非有限正数丢字段、keywords trim/去空/大小写不敏感
 *   去重/上限 20（清洗后空不落键）；列表上限 20 条。
 * - `similarity`（第五轮，见 sanitizeSimilarity）：enabled **默认开**（`!== false`，
 *   与 commentary.enabled 并列的两个默认开布尔）；threshold 非法回 0.72、钳到
 *   [0,1] 保留两位小数。
 * - `ai.provider.baseUrl`：trim、去尾斜杠、必须 `http(s)://` 开头否则 ''；
 *   `apiKey` / `model` trim；`matchMode` 枚举非法回 'literal'；`interests` 每条 trim
 *   去空、单条 ≤500 字符截断、最多 20 条；`semanticThreshold` 非法回 0（默认 =
 *   行为不变）、钳到 [0,1]；`dailyReport.timeHHMM` 必须 HH:MM（时 0-23
 *   分 0-59）否则回 '22:00'，`enabled` 强制布尔；`commentary.enabled` 缺失/非法 →
 *   true（**默认开的布尔**之一，方向与其余布尔相反，见 sanitizeAi）。
 */
export function sanitizeConfig(cfg: AppConfig): AppConfig {
  const src = (typeof cfg === 'object' && cfg !== null ? cfg : {}) as Partial<AppConfig>
  const sources = sanitizeSources(src.sources)
  const priceRules = sanitizePriceRules(src.priceRules)
  const channels = sanitizeChannels(src.channels)
  return {
    includeKeywords: sanitizeKeywordList(src.includeKeywords),
    excludeKeywords: sanitizeKeywordList(src.excludeKeywords),
    pollIntervalSec: sanitizePollIntervalSec(src.pollIntervalSec),
    proxyUrl: sanitizeProxyUrl(src.proxyUrl),
    proxyScope: sanitizeProxyScope(src.proxyScope),
    channels,
    notify: sanitizeNotify(src.notify),
    routing: sanitizeRouting(src.routing, channels, sources, priceRules),
    notifyEnabled: src.notifyEnabled === true,
    launchAtLogin: src.launchAtLogin === true,
    sources,
    priceRules,
    similarity: sanitizeSimilarity(src.similarity),
    ai: sanitizeAi(src.ai)
  }
}

export class ConfigStore {
  private readonly filePath: string
  private readonly secretBox: SecretBox
  private config: AppConfig | null = null

  /**
   * @param opts.secretBox 凭据加密容器（R9-W2/DEC-10）：缺省 PlainSecretBox
   *   （明文读写——既有测试与 headless 语义零变化）；desktop 装配传
   *   createSafeStorageBox()（safe-storage-box.ts，主进程 ready 后构造）。
   */
  constructor(filePath: string, opts: { secretBox?: SecretBox } = {}) {
    this.filePath = filePath
    this.secretBox = opts.secretBox ?? new PlainSecretBox()
  }

  /**
   * 从磁盘加载。
   * - 文件缺失 → 默认配置深拷贝；
   * - 损坏（读失败 / 非法 JSON / 信封形状或版本被迁移函数拒认）→
   *   备份 `{file}.corrupt-{ts}` + 默认配置深拷贝，不抛；
   * - 合法（v1/v2 先沿迁移链升到 v3）→ 合并默认 → **解密**（坑10：先解密后
   *   sanitize）→ sanitize（盘上缺字段也能得到完整合法的配置）。内存中得到
   *   的永远是明文；带 marker 但解密失败的字段置 ''（未配置）并报一条 error。
   */
  load(): AppConfig {
    this.config = this.readFromDisk()
    return structuredClone(this.config)
  }

  /** 取当前配置（内存明文）；未 load 过则先 load。返回深拷贝，调用方改动不会污染内部状态。 */
  get(): AppConfig {
    return structuredClone(this.config ?? this.load())
  }

  /**
   * 清洗后原子写盘（tmp + rename，chmod 0o600），并更新内存值。
   * 坑10 写序：sanitize（明文上）→ encryptSecretFields → 序列化——盘上敏感
   * 字段是 `enc:v1:` 密文，信封不写加密标志；**内存值存 sanitize 后的明文**
   * （this.config = clean，不是加密副本）。与 FileSeenStore.flush 不同：配置
   * 写失败**向上抛**（用户刚改的设置落不了盘不该被吞掉，由调用方决定如何提示）。
   */
  save(cfg: AppConfig): void {
    const clean = sanitizeConfig(cfg)
    const onDisk = encryptSecretFields(clean, this.secretBox)
    const payload = JSON.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, config: onDisk }, null, 2)
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
   * 浅合并更新：顶层字段直接覆盖；`channels` / `sources` / `ai` 等嵌套对象与
   * 数组传入即**整体替换**（想只改 telegram token 就得把整份 channels 带上）。
   * 合并后过 sanitize 再落盘（盘上残留的旧顶层 `telegram` 键在 sanitize 重建时
   * 被剔除——写路径只写新形状）。
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
    // v1/v2/v3 信封在这里沿迁移链升到 v3（链尾含 R6-W1 的旧 telegram → channels
    // 读兼容映射）；形状不对（非对象/缺 config/未知版本）抛错 → 按损坏处理
    let migrated: AppConfig
    try {
      migrated = migrateConfigEnvelope(parsed)
    } catch {
      return this.backupCorruptAndDefault(raw)
    }

    const defaults = structuredClone(DEFAULT_APP_CONFIG)
    // migrated.channels 由迁移链保证非空；notify/routing 缺失（旧盘）由 defaults
    // 兜底。盘上残留的旧顶层 telegram 键（迁移链读兼容的输入侧）在 sanitize
    // 重建对象时自然消失——写路径只写新形状（DEC-9）。
    const merged = { ...defaults, ...migrated }
    // 坑10 读序：**先解密后 sanitize**——盘上 enc:v1: 密文在这里还原成明文，
    // sanitize 的 trim 等清洗只接触明文；解密失败的字段置 ''（未配置）且整次
    // load 只报一条 error（PlainSecretBox 读到密文同样走到这里 = headless 坑10
    // 互操作语义）。不带 marker 的明文值原样透传（旧盘兼容）。
    const report: { anyFailed: boolean } = { anyFailed: false }
    const decrypted = decryptSecretFields(merged, this.secretBox, report)
    if (report.anyFailed) {
      console.error('[config] 加密凭据解密失败，按未配置处理')
    }
    return sanitizeConfig(decrypted)
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

/** 字符串字段清洗：非字符串（含 unknown 盘上垃圾）→ ''，否则 trim */
function sanitizeToken(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** sanitize 视角下的原始 sources 项（未知数据，逐字段判型后再组装） */
type RawSourceItem = {
  id?: unknown
  type?: unknown
  enabled?: unknown
  url?: unknown
  label?: unknown
  filters?: unknown
}

/**
 * v3 判别联合清洗：按 type 分派重建（**每个字段都必须在重建对象里**，漏了就是
 * 保存即丢——ultrabrain 坑4；新增字段必须同 commit 补 sanitize）。
 *
 * - 'nodeseek' / 'v2ex'：id 规范 slug（复用既有逻辑）、enabled 布尔化、filters
 *   走 sanitizeFilters；缺 id / slug 后为空 → 丢弃。
 * - 'rss'：同上，且 **url 必须是合法 http(s) URL（能 new URL 且有 host），否则
 *   整项丢弃**；label trim、空则视为无（不落键）；缺 id（或 slug 后为空）时从
 *   url host 派生建议 id（'example.com' → 'example-com'）——**id 以用户给的为准**。
 * - 未知 type：整项丢弃（不洗成 nodeseek，v3 起类型白名单交给本函数）。
 * - id 全列表去重（保留首个；被丢弃的项不占 id）。
 */
function sanitizeSources(list: SourceConfig[] | undefined): SourceConfig[] {
  if (!Array.isArray(list) || list.length === 0) {
    return structuredClone(DEFAULT_APP_CONFIG.sources)
  }
  const out: SourceConfig[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const raw = item as RawSourceItem
    const enabled = raw.enabled === true

    if (raw.type === 'rss') {
      // url 先行：非法（非字符串/非 http(s)/解析失败/无 host）→ 整项丢弃
      const url = typeof raw.url === 'string' ? raw.url.trim() : ''
      const host = httpUrlHost(url)
      if (host === null) continue
      const given = typeof raw.id === 'string' ? slugifySourceId(raw.id) : ''
      const id = given !== '' ? given : slugifySourceId(host) // 缺 id：从 url host 派生建议 id
      if (id === '' || seen.has(id)) continue
      seen.add(id)
      const clean: RssSourceConfig = { id, type: 'rss', enabled, url }
      const label = typeof raw.label === 'string' ? raw.label.trim() : ''
      if (label !== '') clean.label = label
      const filters = sanitizeFilters(raw.filters)
      if (filters !== undefined) clean.filters = filters
      out.push(clean)
      continue
    }

    if (raw.type === 'nodeseek' || raw.type === 'v2ex') {
      if (typeof raw.id !== 'string') continue
      const id = slugifySourceId(raw.id)
      if (id === '' || seen.has(id)) continue
      seen.add(id)
      const clean: NodeseekSourceConfig | V2exSourceConfig = { id, type: raw.type, enabled }
      const filters = sanitizeFilters(raw.filters)
      if (filters !== undefined) clean.filters = filters
      out.push(clean)
      continue
    }

    // 未知 type：整项丢弃
  }
  // 全部项非法（或去重后为空）→ 回默认单项，绝不落空列表（空列表 = 无来源可监控）
  return out.length > 0 ? out : structuredClone(DEFAULT_APP_CONFIG.sources)
}

/** id 规范：trim + 非法字符替换 '-'（slug 化后为空串表示"没给出可用 id"） */
function slugifySourceId(rawId: string): string {
  return rawId.trim().replace(SOURCE_ID_ILLEGAL_RE, '-')
}

/**
 * url 是否为合法 http(s) URL：能 `new URL` 且协议 http/https 且有 host。
 * 合法返回 hostname（URL 规范化小写），非法返回 null（调用方丢弃该项）。
 */
function httpUrlHost(url: string): string | null {
  if (url.length === 0) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (parsed.host === '') return null
    return parsed.hostname
  } catch {
    return null
  }
}

/**
 * 可选 http(s) URL 字段清洗（第六轮：bark/ntfy 的 serverUrl）：非字符串/非 http(s)
 * /解析失败 → undefined（**弃字段**，不弃项——调用方以 undefined = 用服务端默认）；
 * 合法返回 trim 后的串。
 */
function sanitizeHttpUrlField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const url = value.trim()
  return httpUrlHost(url) !== null ? url : undefined
}

/**
 * per-source filters 清洗（v3 契约，引擎消费在下一轮）：
 * 三个列表各自 trim、去空、去重（大小写不敏感、保留首次写法，对齐
 * includeKeywords 清洗风格）、每列表上限 100 条（超出截断）。
 * 非对象输入 / 清洗后三列表全空 → 返回 undefined（等价"无过滤"，不落空对象）。
 */
function sanitizeFilters(raw: unknown): SourceFilters | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const f = raw as { includeCategories?: unknown; excludeCategories?: unknown; blockedAuthors?: unknown }
  const includeCategories = sanitizeFilterList(f.includeCategories)
  const excludeCategories = sanitizeFilterList(f.excludeCategories)
  const blockedAuthors = sanitizeFilterList(f.blockedAuthors)
  if (
    includeCategories.length === 0 &&
    excludeCategories.length === 0 &&
    blockedAuthors.length === 0
  ) {
    return undefined
  }
  const clean: SourceFilters = {}
  if (includeCategories.length > 0) clean.includeCategories = includeCategories
  if (excludeCategories.length > 0) clean.excludeCategories = excludeCategories
  if (blockedAuthors.length > 0) clean.blockedAuthors = blockedAuthors
  return clean
}

/**
 * filter 列表清洗：trim、去空、大小写不敏感去重（保留首现写法）、截断到上限
 * （默认 filters 的 100 条；priceRules.keywords 复用本函数，上限 20）。
 */
function sanitizeFilterList(list: unknown, maxItems: number = SOURCE_FILTERS_MAX_ITEMS): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (typeof item !== 'string') continue
    const s = item.trim()
    if (s.length === 0) continue
    const key = s.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
    if (out.length >= maxItems) break
  }
  return out
}

/** sanitize 视角下的原始 priceRules 项（未知数据，逐字段判型后再组装） */
type RawPriceRuleItem = {
  id?: unknown
  label?: unknown
  enabled?: unknown
  cycle?: unknown
  currency?: unknown
  maxPrice?: unknown
  minTrafficGB?: unknown
  keywords?: unknown
}

/**
 * 结构化价格规则清洗（第五轮契约，引擎消费在 R5 后续包）：
 * - 非数组 → []（默认值；与 sources 不同，空列表是合法状态 = 无规则，不回默认）。
 * - 整条非对象 / id 非字符串 / id slug 化后为空 → 整条丢弃；slug 后按 id 去重
 *   （保留首个；被丢弃的项不占 id，对齐 sanitizeSources）。
 * - enabled 布尔化（`=== true`，缺省 false）；cycle / currency 枚举非法（含缺失）
 *   回 'any'——'any' 即"不过滤"，落键与缺省语义等价，统一物化。
 * - label trim、空则不落键。
 * - maxPrice / minTrafficGB 非有限正数（0 / 负数 / NaN / Infinity / 非数字）→
 *   丢弃该字段（键不落）。
 * - keywords trim、去空、大小写不敏感去重（保留首现写法）、上限 20；清洗后空
 *   数组不落键（等价"不限关键词"）。
 * - 列表上限 20 条（超出截断，按清洗后顺序）。
 */
function sanitizePriceRules(list: PriceRuleConfig[] | undefined): PriceRuleConfig[] {
  if (!Array.isArray(list)) return []
  const out: PriceRuleConfig[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (out.length >= PRICE_RULES_MAX_ITEMS) break
    if (typeof item !== 'object' || item === null) continue
    const raw = item as RawPriceRuleItem
    if (typeof raw.id !== 'string') continue
    const id = slugifySourceId(raw.id)
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const clean: PriceRuleConfig = {
      id,
      enabled: raw.enabled === true,
      cycle: PRICE_CYCLES.includes(raw.cycle as PriceCycle) ? (raw.cycle as PriceCycle) : 'any',
      currency: PRICE_CURRENCIES.includes(raw.currency as PriceCurrency)
        ? (raw.currency as PriceCurrency)
        : 'any'
    }
    const label = typeof raw.label === 'string' ? raw.label.trim() : ''
    if (label !== '') clean.label = label
    if (isPositiveFiniteNumber(raw.maxPrice)) clean.maxPrice = raw.maxPrice
    if (isPositiveFiniteNumber(raw.minTrafficGB)) clean.minTrafficGB = raw.minTrafficGB
    const keywords = sanitizeFilterList(raw.keywords, PRICE_RULE_KEYWORDS_MAX_ITEMS)
    if (keywords.length > 0) clean.keywords = keywords
    out.push(clean)
  }
  return out
}

/** sanitize 视角下的原始 channels 项（未知数据，逐字段判型后再组装） */
type RawChannelItem = {
  id?: unknown
  type?: unknown
  enabled?: unknown
  botToken?: unknown
  chatId?: unknown
  deviceKey?: unknown
  serverUrl?: unknown
  topic?: unknown
  url?: unknown
  secret?: unknown
}

/**
 * 推送通道列表清洗（第六轮 R6-W1 契约，见 types.ts ChannelConfig）：
 * - 非数组 → 默认单项 telegram（DEFAULT.channels）。
 * - 逐项按 type 分派重建（**每个字段都必须在重建对象里**，坑4 同款）：
 *   - telegram：botToken/chatId trim；**空凭据合法**（= 未配置态，默认配置本身
 *     就是空凭据 telegram 项，不能弃）；
 *   - bark：deviceKey trim（空=未配置态，保留）；serverUrl 非 http(s) **弃字段**
 *     （缺省 = W2 发送端用官方 https://api.day.app）；
 *   - ntfy：topic trim 且**非空**（空 topic 整项弃——没有可推送的目的地）；
 *     serverUrl 同 bark（缺省 = W2 用 https://ntfy.sh）；
 *   - webhook：url 必须是合法 http(s) URL（能 new URL 且有 host），否则**整项弃**；
 *     secret trim、空不落键。
 * - enabled 布尔化（`=== true`）；未知 type / 非对象整项弃。
 * - id：slug 化（复用 SOURCE_ID_ILLEGAL_RE 口径），空则按类型派生默认 id
 *   （telegram/bark/ntfy/webhook），仍冲突则追加 `-2`/`-3`…；被弃项不占 id。
 * - **列表恒至少保留一项**：全部项被弃 → 回默认 telegram 项（与 sanitizeSources
 *   "绝不落空列表"同一精神——空通道列表会让 configured 判定永久悬空）。
 * - 上限 8 条（超出截断，按清洗后顺序）。
 */
function sanitizeChannels(list: ChannelConfig[] | undefined): ChannelConfig[] {
  if (!Array.isArray(list)) return structuredClone(DEFAULT_APP_CONFIG.channels)
  const out: ChannelConfig[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (out.length >= CHANNELS_MAX_ITEMS) break
    if (typeof item !== 'object' || item === null) continue
    const raw = item as RawChannelItem
    const enabled = raw.enabled === true

    let clean: ChannelConfig
    if (raw.type === 'telegram') {
      clean = {
        id: '',
        type: 'telegram',
        enabled,
        botToken: sanitizeToken(raw.botToken),
        chatId: sanitizeToken(raw.chatId)
      }
    } else if (raw.type === 'bark') {
      clean = { id: '', type: 'bark', enabled, deviceKey: sanitizeToken(raw.deviceKey) }
      const serverUrl = sanitizeHttpUrlField(raw.serverUrl)
      if (serverUrl !== undefined) clean.serverUrl = serverUrl
    } else if (raw.type === 'ntfy') {
      const topic = sanitizeToken(raw.topic)
      if (topic === '') continue // trim+非空：无可推送目的地，整项弃
      clean = { id: '', type: 'ntfy', enabled, topic }
      const serverUrl = sanitizeHttpUrlField(raw.serverUrl)
      if (serverUrl !== undefined) clean.serverUrl = serverUrl
    } else if (raw.type === 'webhook') {
      const url = typeof raw.url === 'string' ? raw.url.trim() : ''
      if (httpUrlHost(url) === null) continue // 整项弃
      clean = { id: '', type: 'webhook', enabled, url }
      const secret = sanitizeToken(raw.secret)
      if (secret !== '') clean.secret = secret
    } else {
      continue // 未知 type：整项弃
    }

    // id：slug 化，空则按类型派生；冲突追加 -2/-3…（对齐全列表去重语义）
    const base = typeof raw.id === 'string' && slugifySourceId(raw.id) !== ''
      ? slugifySourceId(raw.id)
      : raw.type
    let id = base
    let suffix = 2
    while (seen.has(id)) {
      id = `${base}-${suffix}`
      suffix++
    }
    seen.add(id)
    clean.id = id
    out.push(clean)
  }
  return out.length > 0 ? out : structuredClone(DEFAULT_APP_CONFIG.channels)
}

/**
 * 推送策略清洗（第六轮契约；digest/免打扰由 W1-queue 消费，当前仅落契约；
 * R9-W1 增 remoteControl）：
 * mode 枚举非法回 'instant'；digestIntervalMin 非法回 15、钳到 [1,120]；
 * quietHours.enabled 布尔化，startHHMM/endHHMM 格式非法（复用 timeHHMM 口径）
 * 分别回 '23:00' / '08:00'；remoteControl.enabled 布尔化（`=== true`，默认关），
 * allowedChatIds 每条 trim、去空、**精确去重**（chat id 是数字串，负数群 id 合法，
 * 不做大小写折叠）、上限 10 条（超出截断）。
 */
function sanitizeNotify(notify: AppConfig['notify'] | undefined): AppConfig['notify'] {
  const raw =
    typeof notify === 'object' && notify !== null
      ? (notify as {
          mode?: unknown
          digestIntervalMin?: unknown
          quietHours?: { enabled?: unknown; startHHMM?: unknown; endHHMM?: unknown }
          remoteControl?: { enabled?: unknown; allowedChatIds?: unknown }
        })
      : {}
  const qh =
    typeof raw.quietHours === 'object' && raw.quietHours !== null ? raw.quietHours : {}
  const rc =
    typeof raw.remoteControl === 'object' && raw.remoteControl !== null
      ? raw.remoteControl
      : {}
  return {
    mode: NOTIFY_MODES.includes(raw.mode as NotifyConfig['mode'])
      ? (raw.mode as NotifyConfig['mode'])
      : 'instant',
    digestIntervalMin: sanitizeDigestIntervalMin(raw.digestIntervalMin),
    quietHours: {
      enabled: qh.enabled === true,
      startHHMM: sanitizeTimeHHMM(qh.startHHMM as string | undefined, DEFAULT_QUIET_START_HHMM),
      endHHMM: sanitizeTimeHHMM(qh.endHHMM as string | undefined, DEFAULT_QUIET_END_HHMM)
    },
    remoteControl: {
      enabled: rc.enabled === true,
      allowedChatIds: sanitizeChatIdList(rc.allowedChatIds)
    }
  }
}

/**
 * Telegram 遥控允许 Chat ID 清单（R9-W1）：trim、去空、精确去重（保留首现写法；
 * 不做大小写折叠——chat id 本就是数字串，主 chatId 的隐含允许在 controller 侧
 * 现读凭据时合并）、上限 10 条。
 */
function sanitizeChatIdList(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const s = item.trim()
    if (s.length === 0 || out.includes(s)) continue
    out.push(s)
    if (out.length >= REMOTE_CONTROL_MAX_CHAT_IDS) break
  }
  return out
}

/** digest 间隔清洗：非法（非数字 / NaN / Infinity）回 15，否则钳到 [1,120] 分钟 */
function sanitizeDigestIntervalMin(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_DIGEST_INTERVAL_MIN
  return Math.min(120, Math.max(1, value))
}

/** sanitize 视角下的原始 routing 项（未知数据，逐字段判型后再组装） */
type RawRoutingItem = {
  id?: unknown
  when?: unknown
  channelIds?: unknown
}

/**
 * 路由规则清洗（第六轮契约，W3 router 消费；DEC-7：悬挂引用一律剔除）：
 * - 非数组 → []（空 = 不路由，合法状态，不回默认）。
 * - 整条非对象 / id 非字符串 / id slug 化后为空 → 整条丢弃；slug 后按 id 去重。
 * - `when` 逐字段清洗（DEC-7 修正：**剔除悬挂的条件字段**而非整条弃）：
 *   sourceId 不在 sources → 剔字段；matchedBy 枚举过滤（清洗后空数组不落键）；
 *   ruleId 不在 priceRules → 剔字段。when 清洗后**全空** → 整条弃（没有条件
 *   的路由无法判定，语义悬空）。
 * - channelIds 只保留存在于 channels 的 id（顺序保留、去重）；过滤后空 → 整条弃。
 * - 列表上限 20 条（超出截断）。
 */
function sanitizeRouting(
  list: RoutingRule[] | undefined,
  channels: ChannelConfig[],
  sources: SourceConfig[],
  priceRules: PriceRuleConfig[]
): RoutingRule[] {
  if (!Array.isArray(list)) return []
  const channelIds = new Set(channels.map((c) => c.id))
  const sourceIds = new Set(sources.map((s) => s.id))
  const ruleIds = new Set(priceRules.map((r) => r.id))
  const out: RoutingRule[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (out.length >= ROUTING_RULES_MAX_ITEMS) break
    if (typeof item !== 'object' || item === null) continue
    const raw = item as RawRoutingItem
    if (typeof raw.id !== 'string') continue
    const id = slugifySourceId(raw.id)
    if (id === '' || seen.has(id)) continue
    seen.add(id)

    const w =
      typeof raw.when === 'object' && raw.when !== null
        ? (raw.when as { sourceId?: unknown; matchedBy?: unknown; ruleId?: unknown })
        : {}
    const when: RoutingWhen = {}
    if (typeof w.sourceId === 'string' && sourceIds.has(w.sourceId)) when.sourceId = w.sourceId
    const matchedBy = Array.isArray(w.matchedBy)
      ? w.matchedBy.filter((m): m is (typeof MATCHED_BY_VALUES)[number] =>
          MATCHED_BY_VALUES.includes(m as (typeof MATCHED_BY_VALUES)[number])
        )
      : []
    if (matchedBy.length > 0) when.matchedBy = matchedBy
    if (typeof w.ruleId === 'string' && ruleIds.has(w.ruleId)) when.ruleId = w.ruleId
    if (when.sourceId === undefined && when.matchedBy === undefined && when.ruleId === undefined) {
      continue // when 全空：无法判定的路由，整条弃
    }

    const targets: string[] = []
    if (Array.isArray(raw.channelIds)) {
      for (const cid of raw.channelIds) {
        if (typeof cid === 'string' && channelIds.has(cid) && !targets.includes(cid)) {
          targets.push(cid)
        }
      }
    }
    if (targets.length === 0) continue // 目标全悬挂：整条弃

    out.push({ id, when, channelIds: targets })
  }
  return out
}

/** 相似帖降噪清洗（第五轮）：enabled **默认开**（`!== false`，与 ai.commentary.enabled
 * 同方向——旧配置缺失该字段时不能静默关掉降噪）；threshold 非法回 0.72，否则钳到
 * [0,1] 并保留两位小数。 */
function sanitizeSimilarity(similarity: AppConfig['similarity'] | undefined): AppConfig['similarity'] {
  const raw =
    typeof similarity === 'object' && similarity !== null
      ? (similarity as { enabled?: unknown; threshold?: unknown })
      : {}
  return {
    enabled: raw.enabled !== false,
    threshold: clamp01(raw.threshold, DEFAULT_SIMILARITY_THRESHOLD, true)
  }
}

/** 有限正数判定（maxPrice / minTrafficGB 清洗用：0 / 负数 / NaN / Infinity 均否） */
function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * 0-1 阈值清洗：非法（非数字 / NaN / Infinity）回 fallback，否则钳到 [0,1]；
 * round2 = true 时保留两位小数（similarity.threshold 的口径；ai.semanticThreshold
 * 不取整，按第五轮规格区分）。
 */
function clamp01(value: unknown, fallback: number, round2 = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const clamped = Math.min(1, Math.max(0, value))
  return round2 ? Math.round(clamped * 100) / 100 : clamped
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
    // 语义置信度阈值（第五轮）：默认 0 = 行为不变（不过滤）；非法回 0、钳到 [0,1]
    semanticThreshold: clamp01(ai?.semanticThreshold, 0),
    dailyReport: {
      enabled: ai?.dailyReport?.enabled === true,
      timeHHMM: sanitizeTimeHHMM(ai?.dailyReport?.timeHHMM)
    },
    // AI 锐评开关——**默认开的布尔**（与 similarity.enabled 并列，本文件仅此两个）：
    // 必须写 `!== false`（缺失/非法 → true），与本文件其余布尔（dailyReport.enabled /
    // notifyEnabled / launchAtLogin / sources[].enabled / priceRules[].enabled 均为
    // `=== true`，缺省 false）方向相反。
    // 原因：锐评是第三轮新增字段，全体旧配置文件（v1 迁移件与早期 v2）都没有它，
    // 若"风格统一"改成 `=== true`，会把所有老用户的锐评静默关掉。改向前先想清楚。
    // （similarity.enabled 第五轮加入同一方向：旧配置缺失时同样不能静默关掉降噪。）
    commentary: {
      enabled: ai?.commentary?.enabled !== false,
      // 锐评思考开关（R12）：**默认关**（`=== true`，缺省 false——方向与
      // enabled 相反但同属"新增字段的旧配置缺失取新默认值"约定：直出模式是
      // 新默认行为，老用户静默迁移到更快更稳的路径；显式 true 保留思考语义）
      useThinking: ai?.commentary?.useThinking === true
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

/**
 * 'HH:MM' 清洗：两位时(0-23):两位分(0-59)，非法（含缺失/非字符串）回 fallback。
 * 第六轮起带 fallback 参数：ai.dailyReport.timeHHMM 用 '22:00'（既有口径），
 * notify.quietHours 用 '23:00'/'08:00'（第六轮默认）。
 */
function sanitizeTimeHHMM(value: string | undefined, fallback = DEFAULT_REPORT_TIME_HHMM): string {
  if (typeof value !== 'string' || !TIME_HHMM_RE.test(value)) return fallback
  const hh = Number(value.slice(0, 2))
  const mm = Number(value.slice(3, 5))
  if (!Number.isInteger(hh) || hh > 23 || !Number.isInteger(mm) || mm > 59) {
    return fallback
  }
  return value
}
