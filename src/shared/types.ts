/**
 * 全局数据契约（v2）—— 主进程、渲染进程、headless 脚本共用。
 * 改这个文件必须同步核对所有消费方（engine / desktop / renderer / scripts）。
 *
 * v2 变更（2026-09-19，多论坛化 + AI 能力）：
 * - AppConfig 增加 sources（论坛来源列表，v2 仅 nodeseek）与 ai 段（LLM Provider/语义监控/日报）。
 * - Topic/来源解耦：Topic.sourceId 标记来源；去重键由 engine 组装为 `${sourceId}:${topic.id}`。
 * - EngineStatus 增加 per-source 状态与 AI 运行态。
 * - HitRecord 增加 matchedBy（literal/semantic）与 AI 判定理由。
 *
 * 第三轮变更（2026-09-19，AI 锐评）：
 * - AiConfig 增加 commentary（锐评开关，**默认开**——当时是唯一默认开的布尔；
 *   第五轮 similarity.enabled 加入后，默认开布尔共两个，见 AppConfig.similarity）。
 * - HitRecord 增加可选 commentary：旧 hits/*.jsonl 行没有此字段，类型必须容忍缺失；
 *   新写入的记录一律给 string|null（生成失败/未启用时为 null），不再留 undefined。
 *
 * v3 变更（2026-09-19，多论坛化第二轮：config 契约）：
 * - SourceType 从单一 'nodeseek' 扩为 'nodeseek' | 'rss' | 'v2ex'。
 * - SourceConfig 改为按 type 判别的联合：rss 额外必带 url（合法 http(s)）、
 *   可选 label；三种来源都可带可选 filters（per-source 过滤契约，本轮只定义
 *   契约与 sanitize，引擎消费在下一轮）。
 * - DEFAULT_APP_CONFIG.sources 不变（仍只有 nodeseek 一项，不带 filters）。
 *
 * 第五轮变更（2026-09-19，R5：价格规则 + 相似帖降噪 + 语义置信度）：
 * - 全部为**加法字段**，不 bump schemaVersion（commentary.enabled 先例）。
 * - AppConfig 增加 priceRules（PriceRuleConfig[]，默认 []；规则命中即第三种命中
 *   方式 matchedBy='rule'）与 similarity（相似帖降噪，**默认开**，阈值 0.72；
 *   48h 对比窗口是引擎侧常量，不进配置）。
 * - ai 增加 semanticThreshold（默认 0 = 行为不变；0-1 置信度阈值）。
 * - HitRecord.matchedBy 扩为 literal|semantic|rule；新增可选 matchedRule
 *   （旧 hits/*.jsonl 行容忍缺失，对齐 commentary 的三态注释风格）。
 * - SourceStatus 增加可选 page2Fetches（DEC-8 第 2 页补抓观测面，旧快照缺失=0）。
 *
 * 第六轮变更（2026-09-19，R6-W1：推送通道化契约改造，DEC-9）：
 * - AppConfig **移除 telegram 段**，新增 channels（ChannelConfig[] 判别联合：
 *   telegram/bark/ntfy/webhook；本轮只有 telegram 有发送实现，bark/ntfy/webhook
 *   是 W2 的契约占位）、notify（instant/digest 模式 + 免打扰时段；W1-queue 消费）
 *   与 routing（RoutingRule[]；W3 消费）。三者均为**加法字段**，schemaVersion 仍 3
 *   ——盘上兼容由 migrations.normalizeLegacyChannels 读侧映射（旧 telegram 凭据
 *   → channels[0]），写路径只写新形状（sanitize 重建时旧 telegram 键自然消失）。
 * - TelegramConfig 类型保留导出：仅 migrations/notify 读兼容与凭据访问器复用。
 * - HitRecord 增加可选 notifyDetail（per-channel 推送明细，键=channelId；W3
 *   router 落盘，本轮 engine 单 notifier 仍写 notifiedAt/notifyError 聚合口径）。
 *
 * R8-A 变更（2026-09-19，E2 引擎看门狗 + E3 Cloudflare B 计划）：
 * - EngineStatus 增加可选 watchdog（runtime 层附加的看门狗观测面，engine 不写；
 *   INITIAL 补默认 { lastTriggeredAt: null, count: 0 }，旧快照读者容忍缺失）。
 * - （E3 的能力声明在 src/main/monitor/types.ts 的 SourceAdapter 上，不在此文件。）
 *
 * R9-W1 变更（2026-09-19，DEC-6 Telegram bot 双向遥控）：
 * - NotifyConfig 增加 remoteControl（enabled + allowedChatIds，默认关/空列表）：
 *   加法字段，不 bump schemaVersion；sanitize 见 store.ts sanitizeNotify。
 */

/** 论坛来源类型（v3 起：nodeseek SSR / 通用 RSS / V2EX） */
export type SourceType = 'nodeseek' | 'rss' | 'v2ex'

/**
 * per-source 过滤契约（v3 定义，引擎消费在下一轮）。
 *
 * 语义：
 * - `includeCategories` 非空 = 分类白名单：帖子的分类**显示名或 slug** 命中任一
 *   才算候选（大小写不敏感）；为空/缺失 = 不限分类。
 * - `excludeCategories` = 分类黑名单：命中任一直接否决（与 include 同时给出时
 *   exclude 优先，对齐全局 excludeKeywords 的一票否决风格）。
 * - `blockedAuthors` = 作者黑名单：作者名命中任一（大小写不敏感）一票否决。
 * - 所有匹配值为字面字符串（非正则/通配）。
 */
export interface SourceFilters {
  /** 分类白名单（空 = 不限）；匹配分类显示名或 slug，大小写不敏感 */
  includeCategories?: string[]
  /** 分类黑名单；命中任一否决 */
  excludeCategories?: string[]
  /** 作者黑名单；命中任一一票否决 */
  blockedAuthors?: string[]
}

/** NodeSeek 来源（SSR HTML 抓取，现有主路径） */
export interface NodeseekSourceConfig {
  /** 稳定 slug；与去重键前缀、状态键一致 */
  id: string
  type: 'nodeseek'
  enabled: boolean
  /** per-source 过滤（可选，见 SourceFilters 语义） */
  filters?: SourceFilters
}

/** V2EX 来源 */
export interface V2exSourceConfig {
  /** 稳定 slug；与去重键前缀、状态键一致 */
  id: string
  type: 'v2ex'
  enabled: boolean
  /** per-source 过滤（可选，见 SourceFilters 语义） */
  filters?: SourceFilters
}

/** 通用 RSS 来源 */
export interface RssSourceConfig {
  /** 稳定 slug；与去重键前缀、状态键一致。sanitize 保证合法 http(s) URL 且有 host */
  id: string
  type: 'rss'
  enabled: boolean
  /** RSS feed 地址（合法 http(s) URL，sanitize 非法则整项丢弃） */
  url: string
  /** 展示名（可选；sanitize trim、空则视为无） */
  label?: string
  /** per-source 过滤（可选，见 SourceFilters 语义） */
  filters?: SourceFilters
}

/** 一个已配置的论坛来源（判别联合：按 type 分派，rss 额外带 url） */
export type SourceConfig = NodeseekSourceConfig | V2exSourceConfig | RssSourceConfig

/** OpenAI 兼容 LLM Provider 配置（DeepSeek / Kimi / GLM / OpenAI 等通用） */
export interface AiProviderConfig {
  /** 如 https://api.deepseek.com/v1（sanitize 会去尾斜杠；请求时拼 /chat/completions） */
  baseUrl: string
  apiKey: string
  model: string
}

/** 匹配模式：仅字面 / 仅语义 / 两者叠加（literal OR semantic） */
export type MatchMode = 'literal' | 'semantic' | 'both'

export interface AiConfig {
  provider: AiProviderConfig
  matchMode: MatchMode
  /** 自然语言兴趣描述（语义监控用；为空时语义档永不命中——镜像字面档防风暴规则） */
  interests: string[]
  /**
   * 语义命中置信度阈值（第五轮）：AI 评估给出的置信度低于此值不判命中。
   * 默认 0 = 行为不变（不过滤）；取值 [0,1]，sanitize 非法回 0、越界钳制。
   */
  semanticThreshold: number
  /** AI 每日总结 */
  dailyReport: {
    enabled: boolean
    /** 'HH:MM' 本地时区 */
    timeHHMM: string
  }
  /**
   * AI 锐评（第三轮）：命中帖推送前让 LLM 附一句点评。
   * 配置里恒存在（默认/ sanitize 保证）；enabled 是**默认开的布尔**之一
   * （另一个是 similarity.enabled，见 store.ts sanitizeAi / sanitizeSimilarity
   * 的书写约定），UI 侧直接读 cfg.ai.commentary.enabled。
   */
  commentary: {
    enabled: boolean
  }
}

/** 价格周期 */
export type PriceCycle = 'yearly' | 'monthly' | 'any'
/** 币种（'any' 不过滤币种） */
export type PriceCurrency = 'CNY' | 'USD' | 'any'
/**
 * 一条结构化价格规则（第五轮契约，引擎消费在 R5 后续包）：
 * 条件之间 AND；命中即作为第三种命中方式（matchedBy='rule'）。
 */
export interface PriceRuleConfig {
  /** 规则 id（slug 化、全列表去重，见 store.ts sanitizePriceRules） */
  id: string
  /** 展示名（可选；sanitize trim、空则不落键） */
  label?: string
  enabled: boolean
  cycle: PriceCycle
  /** 标题提取出的价格上限（数值；与币种配合） */
  maxPrice?: number
  currency?: PriceCurrency
  /** 标题提取出的流量下限（GB） */
  minTrafficGB?: number
  /** 标题需包含任一关键词（空=不限）——AND 前置条件 */
  keywords?: string[]
}

/** 一条论坛帖子（从来源帖子列表解析出的字段） */
export interface Topic {
  /** 帖子 id（如 NodeSeek 的 "936634"）；全局唯一键 = `${sourceId}:${id}` */
  id: string
  /** 来源 id，由 engine 在处理时盖上（adapter 不感知） */
  sourceId: string
  title: string
  /** 绝对链接，如 https://www.nodeseek.com/post-936634-1 */
  url: string
  author: string
  /** 分类显示名，如 "交易" */
  category: string
  /** 分类 slug，如 "trade" */
  categorySlug: string
  /** 是否置顶（置顶帖是旧帖，监控默认跳过） */
  pinned: boolean
  /** 最近活跃时间（ISO 字符串，来自 <time datetime>，是最后回复时间而非发帖时间） */
  lastActiveAt: string | null
}

/** 命中记录：一个新帖命中（字面、语义或价格规则）并（尝试）推送 */
export interface HitRecord {
  topic: Topic
  /** 字面命中的包含词；matchedBy='semantic' 时为空数组 */
  matchedKeywords: string[]
  /** 命中方式（第五轮起三档：字面 / 语义 / 价格规则） */
  matchedBy: 'literal' | 'semantic' | 'rule'
  /** AI 的一句话判定理由（matchedBy='semantic' 时给出，可能为 null） */
  semanticReason: string | null
  /**
   * 命中的价格规则 id/label（matchedBy='rule' 时给出）。**可选**：旧 hits/*.jsonl
   * 行没有此字段，消费方必须容忍 undefined（等价"非规则命中"）；新写入的记录一律给
   * string|null——非规则命中时为 null，规则命中时为规则的 id（无 label）或 label。
   */
  matchedRule?: string | null
  /**
   * AI 锐评正文（第三轮）。**可选**：旧 hits/*.jsonl 行没有此字段，消费方必须容忍
   * undefined（等价于"无锐评"）；新写入的记录一律给 string|null——生成失败/未启用/
   * Provider 未配置时为 null，成功时为锐评文本。
   */
  commentary?: string | null
  /** 推送时间 ISO；推送失败时为 null */
  notifiedAt: string | null
  /** 推送失败原因（notifiedAt 为 null 时给出；静音时为 null） */
  notifyError: string | null
  /**
   * per-channel 推送明细（第六轮 R6-W1 契约，W3 router 落盘）：键 = channelId，
   * 值 = 该通道的推送结果。**可选**：旧 hits/*.jsonl 行没有此字段，消费方必须容忍
   * undefined（等价"无明细"）；单 notifier 时代聚合口径仍是上方 notifiedAt /
   * notifyError 两字段，本字段在 W3 多通道并发推送后由 router 写入。
   */
  notifyDetail?: Record<string, { ok: boolean; error?: string }>
}

/** 代理作用域：仅 Telegram 走代理，还是所有请求都走代理（AI 请求在 'all' 时走代理、'telegram-only' 时直连） */
export type ProxyScope = 'all' | 'telegram-only'

/**
 * 旧版 telegram 凭据形状（R6-W1 前的 AppConfig.telegram）。
 * **不再出现在 AppConfig 上**：仅为 migrations 的读兼容映射与 TelegramNotifier
 * 的凭据访问器保留此形状（notify/telegram.ts 的 getConfig 返回值）。
 */
export interface TelegramConfig {
  botToken: string
  chatId: string
}

/** 推送通道类型（R6-W1：telegram 有实现；bark/ntfy/webhook 为 W2 契约占位） */
export type ChannelType = 'telegram' | 'bark' | 'ntfy' | 'webhook'

/** Telegram Bot 推送通道 */
export interface TelegramChannelConfig {
  /** 通道 id（slug 化、全列表去重；notifyDetail 明细键） */
  id: string
  type: 'telegram'
  enabled: boolean
  botToken: string
  chatId: string
}

/** Bark 推送通道（iOS） */
export interface BarkChannelConfig {
  id: string
  type: 'bark'
  enabled: boolean
  /** 自建服务器 base，默认官方 https://api.day.app（缺省=官方，由 W2 发送端兜底） */
  serverUrl?: string
  deviceKey: string
}

/** ntfy 推送通道 */
export interface NtfyChannelConfig {
  id: string
  type: 'ntfy'
  enabled: boolean
  /** 默认 https://ntfy.sh（缺省=官方，由 W2 发送端兜底） */
  serverUrl?: string
  topic: string
}

/** Webhook 推送通道 */
export interface WebhookChannelConfig {
  id: string
  type: 'webhook'
  enabled: boolean
  url: string
  /** 随请求发送的自定义鉴权头值（头名固定 X-ForumWatch-Secret） */
  secret?: string
}

/** 一个已配置的推送通道（判别联合：按 type 分派） */
export type ChannelConfig =
  | TelegramChannelConfig
  | BarkChannelConfig
  | NtfyChannelConfig
  | WebhookChannelConfig

/** 推送节流模式（R6-W1 契约；digest 由 W1-queue 消费，当前仅 instant 生效） */
export interface NotifyConfig {
  /** 'instant' 命中即推（现行行为）；'digest' 聚合摘要推 */
  mode: 'instant' | 'digest'
  /** digest 聚合间隔（分钟）；sanitize 钳 [1,120]，默认 15 */
  digestIntervalMin: number
  /** 免打扰时段（本地时区，跨午夜合法；W1-queue 消费，当前仅契约） */
  quietHours: {
    enabled: boolean
    /** 'HH:MM' 起点 */
    startHHMM: string
    /** 'HH:MM' 终点 */
    endHHMM: string
  }
  /**
   * Telegram 遥控（R9-W1，DEC-6）：经 bot 的 getUpdates 长轮询接收指令
   * （/status /pause /resume /poll /help），实现双向遥控。默认关闭。
   * 就绪条件 = enabled 且存在就绪 telegram 通道（凭据齐备）；允许清单外的会话
   * 一律静默忽略（硬闸，不回复）；主 Chat ID（第一个就绪 telegram 通道的 chatId）
   * 隐含允许。注意：启用后本应用独占该 bot 的 getUpdates——其他工具轮询同一
   * bot 会互相 409（坑8）。
   */
  remoteControl: {
    enabled: boolean
    /** 允许发指令的额外 Chat ID（字符串原样，可含负数群 id；主 chatId 隐含在内） */
    allowedChatIds: string[]
  }
}

/** 路由规则的匹配条件（W3 router 消费；全部字段可选，空 when 的规则由 sanitize 整条弃） */
export interface RoutingWhen {
  /** 限定来源（须存在于 sources，悬挂由 sanitize 剔除字段） */
  sourceId?: string
  /** 限定命中方式（枚举过滤，空数组不落键） */
  matchedBy?: ('literal' | 'semantic' | 'rule')[]
  /** 限定价格规则（须存在于 priceRules，悬挂由 sanitize 剔除字段） */
  ruleId?: string
}

/** 一条路由规则：when 命中的帖推给 channelIds 列出的通道（W3 router 消费） */
export interface RoutingRule {
  id: string
  when: RoutingWhen
  /** 目标通道 id 列表（须存在于 channels；过滤后空则整条弃） */
  channelIds: string[]
}

export interface AppConfig {
  /** 包含词：任一命中即为候选（不区分大小写，只匹配标题） */
  includeKeywords: string[]
  /** 排除词：任一命中则否决（不区分大小写；语义模式下仍先于 AI 一票否决） */
  excludeKeywords: string[]
  /** 轮询间隔秒数，下限 15 */
  pollIntervalSec: number
  /** 代理 URL：'' 表示直连；支持 http:// https:// socks5:// socks5h:// */
  proxyUrl: string
  proxyScope: ProxyScope
  /**
   * 推送通道列表（第六轮 R6-W1，DEC-9；取代旧 telegram 段）。判别联合按 type
   * 分派，sanitize 保证非空（全弃时回默认 telegram 项）、id slug 化去重、上限 8。
   * 默认单项：id='telegram' 的空凭据 telegram 通道（= 未配置态，与旧默认等价）。
   * 本轮只有 telegram 有发送实现；bark/ntfy/webhook 是 W2 的契约占位。
   */
  channels: ChannelConfig[]
  /**
   * 推送策略（第六轮契约：digest 模式 + 免打扰由 W1-queue 消费；当前引擎恒走
   * instant 直推，该段仅落契约与 sanitize）。默认 instant / 15min / 免打扰关。
   */
  notify: NotifyConfig
  /**
   * 路由规则（第六轮契约，W3 router 消费）：when 命中的帖推给 channelIds。
   * 默认 [] = 不路由（全部命中走默认通道组）；sanitize 剔除悬挂引用。
   */
  routing: RoutingRule[]
  /** 推送总开关（临时静音用） */
  notifyEnabled: boolean
  /** 开机自启（Electron app.setLoginItemSettings） */
  launchAtLogin: boolean
  /**
   * 论坛来源列表（v3 判别联合，默认仍只有 nodeseek 一项；关键词仍全局共享，
   * per-source 覆盖= filters 于 v3 引入契约，引擎消费在下一轮）
   */
  sources: SourceConfig[]
  /**
   * 结构化价格规则（第五轮，见 PriceRuleConfig）：标题提取的价格/流量条件全部
   * 满足即命中，作为第三种命中方式（matchedBy='rule'）。默认 [] = 无规则；
   * 引擎消费在 R5 后续包，本轮只定契约与 sanitize。
   */
  priceRules: PriceRuleConfig[]
  /**
   * 相似帖降噪（第五轮）：命中推送前与近窗内已推送帖比对标题相似度，视为相似
   * 则不再推（降重复推送噪音）。**默认开**（与 ai.commentary.enabled 并列的两个
   * 默认开布尔之一）；48h 对比窗口是引擎侧常量（不进配置）。threshold ∈ [0,1]，
   * sanitize 非法回 0.72、钳到 [0,1] 保留两位小数。
   */
  similarity: {
    enabled: boolean
    threshold: number
  }
  /** AI 能力配置（Provider 未配置时语义档自动降级为字面档） */
  ai: AiConfig
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  includeKeywords: [],
  excludeKeywords: [],
  pollIntervalSec: 60,
  proxyUrl: '',
  proxyScope: 'telegram-only',
  channels: [{ id: 'telegram', type: 'telegram', enabled: true, botToken: '', chatId: '' }],
  notify: {
    mode: 'instant',
    digestIntervalMin: 15,
    quietHours: { enabled: false, startHHMM: '23:00', endHHMM: '08:00' },
    // R9-W1：Telegram 遥控默认关闭（允许清单为空 = 仅主 Chat ID 可发指令）
    remoteControl: { enabled: false, allowedChatIds: [] }
  },
  routing: [],
  notifyEnabled: true,
  launchAtLogin: false,
  sources: [{ id: 'nodeseek', type: 'nodeseek', enabled: true }],
  priceRules: [],
  similarity: { enabled: true, threshold: 0.72 },
  ai: {
    provider: { baseUrl: '', apiKey: '', model: '' },
    matchMode: 'literal',
    interests: [],
    semanticThreshold: 0,
    dailyReport: { enabled: false, timeHHMM: '22:00' },
    commentary: { enabled: true }
  }
}

/** 用户意图（唯一可写维度）：运行中 / 暂停 */
export type DesiredState = 'running' | 'paused'
/** 内核健康（自动流转）：正常 / 失败退避中 / 被 Cloudflare 挑战 */
export type HealthState = 'ok' | 'backoff' | 'challenged'

/** 单个来源的运行状态（engine 内循环多 source，各自独立计数与退避） */
export interface SourceStatus {
  sourceId: string
  health: HealthState
  lastSuccessAt: string | null
  lastError: string | null
  consecutiveFailures: number
  /** 退避截止时刻 ISO；null 表示无退避 */
  cooldownUntil: string | null
  /**
   * 第 2 页补抓累计次数（第五轮，DEC-8 观测面：首页 0 新帖时补抓下一页的执行
   * 面数）。**可选**：旧状态快照没有此字段，消费方容忍缺失（等价 0）。
   */
  page2Fetches?: number
}

/** AI 运行态（语义评估管线的观测面） */
export interface AiRuntimeStatus {
  /** Provider 三项（baseUrl/apiKey/model）是否齐备 */
  configured: boolean
  /** 生效模式：Provider 未配置或当日配额耗尽时降级为 'literal' */
  effectiveMode: MatchMode
  degraded: 'none' | 'unconfigured' | 'quota-exhausted'
  /** 今日语义评估调用次数（本地自然日滚动） */
  callsToday: number
  /**
   * 每日锐评调用数，上限 100（第三轮）。**可选**：渲染层后续消费，旧消费者
   * （状态快照的既有读者）不破——缺字段等价于 0。与 callsToday 共用同一本地
   * 自然日滚动与同一总桶（dailyLimit 300）：锐评每次调用同时计入两者。
   */
  commentaryToday?: number
  /**
   * 每日锐评调用上限（当前 100，常量不进配置；F4 单一事实源）。**可选**：由
   * engine 的 deriveAiStatus 随状态下发，渲染层读它而非硬编码；缺字段时消费方
   * 回退默认 100（旧状态快照读者不破）。
   */
  commentaryLimit?: number
  /** 每日调用上限（常量 300，v2 不进配置） */
  dailyLimit: number
  lastAiError: string | null
}

export interface EngineStatus {
  desired: DesiredState
  /** 聚合健康 = 各来源最差（challenged > backoff > ok） */
  health: HealthState
  lastPollAt: string | null
  lastSuccessAt: string | null
  nextPollAt: string | null
  consecutiveFailures: number
  lastError: string | null
  totalHits: number
  /** per-source 状态（v2 仅 'nodeseek' 一项） */
  sources: SourceStatus[]
  ai: AiRuntimeStatus
  /**
   * 挂起待推送条数（第六轮 R6-W4）：免打扰窗内 / digest 模式挂起队列
   * （engine.deferredHits）的当前尺寸。**可选**：旧状态快照没有此字段，消费方
   * 容忍缺失（等价 0）；engine 的 getStatus 每次快照恒下发当前值。
   */
  pendingNotifyCount?: number
  /**
   * 引擎看门狗观测面（R8-A 任务一，E2）：desktop 装配方持有的 EngineWatchdog
   * 状态，随状态广播时**在 runtime 层附加**（快照对象上挂字段再发，见
   * runtime.emitStatus）——engine 自身不写它（status 是 engine 的事实源，
   * watchdog 是 runtime 侧旁路观测）。**可选**：旧状态快照与 headless 装配没有
   * 此字段，消费方容忍缺失（等价「无看门狗」）；lastTriggeredAt=null 且 count=0
   * = 看门狗在位但从未触发。
   */
  watchdog?: { lastTriggeredAt: string | null; count: number }
}

export const INITIAL_ENGINE_STATUS: EngineStatus = {
  desired: 'running',
  health: 'ok',
  lastPollAt: null,
  lastSuccessAt: null,
  nextPollAt: null,
  consecutiveFailures: 0,
  lastError: null,
  totalHits: 0,
  sources: [],
  pendingNotifyCount: 0,
  // R8-A：看门狗默认态（engine 快照里的占位值；广播路径由 runtime 附加实时值覆盖）
  watchdog: { lastTriggeredAt: null, count: 0 },
  ai: {
    configured: false,
    effectiveMode: 'literal',
    degraded: 'unconfigured',
    callsToday: 0,
    dailyLimit: 300,
    lastAiError: null
  }
}

/** 一份已生成的日报（UI 与 IPC 共用形状） */
export interface DailyReportInfo {
  /** 本地时区 'YYYY-MM-DD' */
  date: string
  /** 日报 markdown 正文；请求的日期没有日报时为 null */
  markdown: string | null
}

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  ts: string // ISO
  level: LogLevel
  msg: string
}
