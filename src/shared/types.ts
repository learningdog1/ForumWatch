/**
 * 全局数据契约 —— 主进程、渲染进程、headless 脚本共用。
 * 改这个文件必须同步核对所有消费方（engine / desktop / renderer / scripts）。
 */

/** 一条 NodeSeek 帖子（从首页帖子列表解析出的字段） */
export interface Topic {
  /** NodeSeek 帖子 id，如 "936634"（来自 /post-{id}-{seq} 链接） */
  id: string
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

/** 命中记录：一个新帖命中关键词并（尝试）推送 */
export interface HitRecord {
  topic: Topic
  /** 命中的包含词（触发推送的那些） */
  matchedKeywords: string[]
  /** 推送时间 ISO；推送失败时为 null */
  notifiedAt: string | null
  /** 推送失败原因（notifiedAt 为 null 时给出） */
  notifyError: string | null
}

/** 代理作用域：仅 Telegram 走代理，还是所有请求都走代理 */
export type ProxyScope = 'all' | 'telegram-only'

export interface TelegramConfig {
  botToken: string
  chatId: string
}

export interface AppConfig {
  /** 包含词：任一命中即为候选（不区分大小写） */
  includeKeywords: string[]
  /** 排除词：任一命中则否决（不区分大小写） */
  excludeKeywords: string[]
  /** 轮询间隔秒数，下限 15 */
  pollIntervalSec: number
  /** 代理 URL：'' 表示直连；支持 http:// https:// socks5:// */
  proxyUrl: string
  proxyScope: ProxyScope
  telegram: TelegramConfig
  /** 推送总开关（临时静音用） */
  notifyEnabled: boolean
  /** 开机自启（Electron app.setLoginItemSettings） */
  launchAtLogin: boolean
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  includeKeywords: [],
  excludeKeywords: [],
  pollIntervalSec: 60,
  proxyUrl: '',
  proxyScope: 'telegram-only',
  telegram: { botToken: '', chatId: '' },
  notifyEnabled: true,
  launchAtLogin: false
}

/** 用户意图（唯一可写维度）：运行中 / 暂停 */
export type DesiredState = 'running' | 'paused'
/** 内核健康（自动流转）：正常 / 失败退避中 / 被 Cloudflare 挑战 */
export type HealthState = 'ok' | 'backoff' | 'challenged'

export interface EngineStatus {
  desired: DesiredState
  health: HealthState
  lastPollAt: string | null
  lastSuccessAt: string | null
  nextPollAt: string | null
  consecutiveFailures: number
  lastError: string | null
  totalHits: number
}

export const INITIAL_ENGINE_STATUS: EngineStatus = {
  desired: 'running',
  health: 'ok',
  lastPollAt: null,
  lastSuccessAt: null,
  nextPollAt: null,
  consecutiveFailures: 0,
  lastError: null,
  totalHits: 0
}

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  ts: string // ISO
  level: LogLevel
  msg: string
}
