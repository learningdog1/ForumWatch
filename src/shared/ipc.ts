/**
 * IPC 契约 —— 主进程（desktop/ipc.ts）、preload、渲染进程共享的单一事实源。
 * 通道名 + 载荷类型 + preload 白名单 API 形状（DesktopApi）全部在此定义；
 * UI 阶段只认这个文件与 ./types.ts。
 *
 * 语义约定（实现与 UI 都必须遵守）：
 * - 事件推送（evStatus / evHit / evLog）由主进程广播给所有存活窗口；
 *   渲染进程启动时先用 invoke 拉全量（getStatus / getHits / getLogs），
 *   事件只用于增量。
 * - pause 只改 desired 不动 health；pause 后 nextPollAt 保留旧值
 *   （排程器已停但字段不清空）——UI 一律按 desired=paused 派生展示，
 *   此时忽略 nextPollAt，不要拿它判断"是否在轮询"。
 * - 所有 invoke 的失败语义都收敛为返回值里的 {ok:false, error} 或
 *   {ok:false}，handler 侧不向渲染进程抛异常。
 */
import type { AppConfig, EngineStatus, HitRecord, LogEntry } from './types'

/** IPC 通道名（主进程 handler 注册与 preload invoke/send 共用） */
export const IPC = {
  /** invoke → AppConfig（当前生效配置的深拷贝） */
  getConfig: 'config:get',
  /**
   * invoke(AppConfig) → SaveConfigResult。
   * 成功返回 sanitize 后的生效配置（ConfigStore.save 会清洗：关键词去重、
   * pollIntervalSec 钳到 >=15、proxyUrl 非法置空等）；写盘失败返回 {ok:false}。
   */
  saveConfig: 'config:save',
  /** invoke → EngineStatus（实时快照） */
  getStatus: 'status:get',
  /** invoke → HitRecord[]（内存环形 200 条，旧→新） */
  getHits: 'hits:get',
  /** invoke → LogEntry[]（内存环形 500 条，旧→新） */
  getLogs: 'logs:get',
  /** invoke(EngineControlCommand) → EngineControlResult */
  engineControl: 'engine:control',
  /** invoke(url) → {ok:boolean}；仅允许 https 且 host 为 nodeseek.com 或其子域 */
  openExternal: 'external:open',
  /** 主进程 push EngineStatus */
  evStatus: 'event:status',
  /** 主进程 push HitRecord */
  evHit: 'event:hit',
  /** 主进程 push LogEntry */
  evLog: 'event:log'
} as const

/** 引擎控制命令：pause/resume 改 desired；runNow 补一轮（paused 时 no-op）；sendTest 发测试消息 */
export type EngineControlCommand = 'pause' | 'resume' | 'runNow' | 'sendTest'

/** saveConfig 返回：成功带 sanitize 后的生效配置；失败带错误消息（如磁盘写失败） */
export type SaveConfigResult = { ok: true; config: AppConfig } | { ok: false; error: string }

/** engineControl 返回：sendTest 失败（TelegramError 等）在此回传 error */
export type EngineControlResult = { ok: true } | { ok: false; error: string }

/** openExternal 返回：url 被拒绝（非 https / 非 nodeseek 域）或打开失败为 {ok:false} */
export type OpenExternalResult = { ok: boolean }

/**
 * preload（contextIsolation）暴露给渲染进程的白名单 API。
 * onStatus / onHit / onLog 返回取消订阅函数（组件卸载时调用）。
 */
export interface DesktopApi {
  getConfig(): Promise<AppConfig>
  saveConfig(config: AppConfig): Promise<SaveConfigResult>
  getStatus(): Promise<EngineStatus>
  getHits(): Promise<HitRecord[]>
  getLogs(): Promise<LogEntry[]>
  engineControl(command: EngineControlCommand): Promise<EngineControlResult>
  openExternal(url: string): Promise<OpenExternalResult>
  onStatus(callback: (s: EngineStatus) => void): () => void
  onHit(callback: (h: HitRecord) => void): () => void
  onLog(callback: (e: LogEntry) => void): () => void
}

/**
 * 托盘 tooltip（纯函数，托盘与 UI 可复用同一派生口径）：
 * desired 优先（用户意图覆盖观测），其次 challenged → backoff → 运行中。
 */
export function deriveTrayLabel(status: EngineStatus): string {
  if (status.desired === 'paused') return 'NodeSeek Monitor · 已暂停'
  if (status.health === 'challenged') return 'NodeSeek Monitor · Cloudflare 拦截中'
  if (status.health === 'backoff') return 'NodeSeek Monitor · 轮询异常重试中'
  return 'NodeSeek Monitor · 运行中'
}
