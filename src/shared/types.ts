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
 * - AiConfig 增加 commentary（锐评开关，**默认开**——sanitize 侧唯一默认开的布尔）。
 * - HitRecord 增加可选 commentary：旧 hits/*.jsonl 行没有此字段，类型必须容忍缺失；
 *   新写入的记录一律给 string|null（生成失败/未启用时为 null），不再留 undefined。
 */

/** 论坛来源类型（v2 仅 nodeseek，联合类型留给未来论坛） */
export type SourceType = 'nodeseek'

/** 一个已配置的论坛来源 */
export interface SourceConfig {
  /** 稳定 slug；v2 恒为 'nodeseek'，与去重键前缀、状态键一致 */
  id: string
  type: SourceType
  enabled: boolean
}

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
  /** AI 每日总结 */
  dailyReport: {
    enabled: boolean
    /** 'HH:MM' 本地时区 */
    timeHHMM: string
  }
  /**
   * AI 锐评（第三轮）：命中帖推送前让 LLM 附一句点评。
   * 配置里恒存在（默认/ sanitize 保证）；enabled 是全配置**唯一默认开**的布尔
   * （见 store.ts sanitizeAi 的书写约定），UI 侧直接读 cfg.ai.commentary.enabled。
   */
  commentary: {
    enabled: boolean
  }
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

/** 命中记录：一个新帖命中（字面或语义）并（尝试）推送 */
export interface HitRecord {
  topic: Topic
  /** 字面命中的包含词；matchedBy='semantic' 时为空数组 */
  matchedKeywords: string[]
  /** 命中方式 */
  matchedBy: 'literal' | 'semantic'
  /** AI 的一句话判定理由（matchedBy='semantic' 时给出，可能为 null） */
  semanticReason: string | null
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
}

/** 代理作用域：仅 Telegram 走代理，还是所有请求都走代理（AI 请求在 'all' 时走代理、'telegram-only' 时直连） */
export type ProxyScope = 'all' | 'telegram-only'

export interface TelegramConfig {
  botToken: string
  chatId: string
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
  telegram: TelegramConfig
  /** 推送总开关（临时静音用） */
  notifyEnabled: boolean
  /** 开机自启（Electron app.setLoginItemSettings） */
  launchAtLogin: boolean
  /** 论坛来源列表（v2 仅 nodeseek 一项；关键词 v2 全局共享，per-source 覆盖留给 v3） */
  sources: SourceConfig[]
  /** AI 能力配置（Provider 未配置时语义档自动降级为字面档） */
  ai: AiConfig
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  includeKeywords: [],
  excludeKeywords: [],
  pollIntervalSec: 60,
  proxyUrl: '',
  proxyScope: 'telegram-only',
  telegram: { botToken: '', chatId: '' },
  notifyEnabled: true,
  launchAtLogin: false,
  sources: [{ id: 'nodeseek', type: 'nodeseek', enabled: true }],
  ai: {
    provider: { baseUrl: '', apiKey: '', model: '' },
    matchMode: 'literal',
    interests: [],
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
