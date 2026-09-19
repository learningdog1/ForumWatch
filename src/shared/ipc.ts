/**
 * IPC 契约 —— 主进程（desktop/ipc.ts）、preload、渲染进程共享的单一事实源。
 * 通道名 + 载荷类型 + preload 白名单 API 形状（DesktopApi）全部在此定义；
 * UI 阶段只认这个文件与 ./types.ts。
 *
 * 语义约定（实现与 UI 都必须遵守）：
 * - 事件推送（evStatus / evHit / evLog / evDailyReport）由主进程广播给所有存活窗口；
 *   渲染进程启动时先用 invoke 拉全量（getStatus / getHits / getLogs），
 *   事件只用于增量。
 * - pause 只改 desired 不动 health；pause 后 nextPollAt 保留旧值
 *   （排程器已停但字段不清空）——UI 一律按 desired=paused 派生展示，
 *   此时忽略 nextPollAt，不要拿它判断"是否在轮询"。
 * - 所有 invoke 的失败语义都收敛为返回值里的 {ok:false, error} 或
 *   {ok:false}，handler 侧不向渲染进程抛异常。
 */
import type {
  AppConfig,
  DailyReportInfo,
  EngineStatus,
  HitRecord,
  LogEntry
} from './types'

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
  /** invoke → EngineStatus（实时快照，含 per-source 状态与 AI 运行态） */
  getStatus: 'status:get',
  /** invoke → HitRecord[]（内存环形 200 条，旧→新；历史查 hits/ JSONL） */
  getHits: 'hits:get',
  /** invoke → LogEntry[]（内存环形 500 条，旧→新） */
  getLogs: 'logs:get',
  /** invoke(EngineControlCommand) → EngineControlResult */
  engineControl: 'engine:control',
  /**
   * invoke(url) → {ok:boolean}；仅允许 https 且 host 为已配置来源的域
   * （v2：nodeseek.com 及其子域；由主进程按 sources 派生白名单）。
   */
  openExternal: 'external:open',
  /** invoke() → AiTestResult；AI Provider 连通性测试（发一条最小对话） */
  testAiProvider: 'ai:test',
  /** invoke(dateLocal?: string) → DailyReportInfo；缺省取今天（本地时区） */
  getDailyReport: 'report:get',
  /** invoke() → EngineControlResult；手动生成本日日报（生成 + 推送） */
  generateDailyReport: 'report:generate',
  /** invoke() → { dates: string[] }；已有日报的日期列表（本地时区，新→旧） */
  listDailyReports: 'report:list',
  /**
   * invoke(MatchTestRequest) → MatchTestResult（R5-P2c 匹配测试台）：按**已保存**
   * 配置对新标题跑一遍判定管线，返回逐阶段 trace 与 wouldPush。只读诊断——
   * 不写 seen、不产生 HitRecord、不推送。useAi=true 时真调一次语义评估
   * （单帖一批，消耗一次 LLM 调用；失败不炸，语义阶段按 skip 展示错误原因）。
   */
  matchTest: 'match:test',
  /** 主进程 push EngineStatus */
  evStatus: 'event:status',
  /** 主进程 push HitRecord */
  evHit: 'event:hit',
  /** 主进程 push LogEntry */
  evLog: 'event:log',
  /** 主进程 push DailyReportInfo（日报生成完成时） */
  evDailyReport: 'event:report'
} as const

/** 引擎控制命令：pause/resume 改 desired；runNow 补一轮（paused 时 no-op）；sendTest 发测试消息 */
export type EngineControlCommand = 'pause' | 'resume' | 'runNow' | 'sendTest'

/** saveConfig 返回：成功带 sanitize 后的生效配置；失败带错误消息（如磁盘写失败） */
export type SaveConfigResult = { ok: true; config: AppConfig } | { ok: false; error: string }

/** engineControl / generateDailyReport 返回：失败原因在此回传 */
export type EngineControlResult = { ok: true } | { ok: false; error: string }

/** openExternal 返回：url 被拒绝（非 https / 非来源域）或打开失败为 {ok:false} */
export type OpenExternalResult = { ok: boolean }

/** testAiProvider 返回：失败带分类错误（脱敏后，不含 apiKey 明文） */
export type AiTestResult = { ok: true } | { ok: false; error: string }

/** listDailyReports 返回 */
export type DailyReportListResult = { dates: string[] }

/**
 * 匹配测试台（R5-P2c）的结果契约。类型定义在契约层是因为 tsconfig.web 的
 * composite 边界不允许 shared 反向 type-import src/main；内核实现
 * （src/main/monitor/testbench.ts）从这里导入并再导出，语义注释在那边。
 */
export interface MatchStageResult {
  /** 阶段标识（source-filters / exclude / rules / literal / similarity / semantic） */
  stage: string
  /** 阶段展示名（中文） */
  label: string
  /**
   * pass=评估且放行/命中；block=评估且一票否决（或语义未命中）；
   * skip=未评估（管线已死 / 规则短路 / 语义未提供）；info=评估但无命中也无否决。
   */
  outcome: 'pass' | 'block' | 'skip' | 'info'
  /** 人读细节（命中词 / 提取结果 / 阈值比较等） */
  detail: string
}

/** 匹配测试台总结果：wouldPush + 按引擎管线顺序的阶段明细 */
export interface MatchTestResult {
  /** 按当前配置，这个标题若为新帖是否会推送 */
  wouldPush: boolean
  stages: MatchStageResult[]
}

/**
 * match:test 请求：title 必填（非空，主进程侧 trim 校验）；
 * sourceId 给则带上该来源的 per-source 过滤参与判定；
 * useAi=true 且 AI 已配置时真调一次语义评估（消耗一次 LLM 调用）；
 * category / author 为可选的帖子元数据（per-source 过滤判定输入，缺省按空处理）。
 */
export interface MatchTestRequest {
  title: string
  sourceId?: string
  useAi?: boolean
  /** 帖子分类（显示名或 slug 均可；同一值同时按两种口径参与匹配） */
  category?: string
  /** 帖子作者 */
  author?: string
}

/**
 * preload（contextIsolation）暴露给渲染进程的白名单 API。
 * onStatus / onHit / onLog / onDailyReport 返回取消订阅函数（组件卸载时调用）。
 */
export interface DesktopApi {
  getConfig(): Promise<AppConfig>
  saveConfig(config: AppConfig): Promise<SaveConfigResult>
  getStatus(): Promise<EngineStatus>
  getHits(): Promise<HitRecord[]>
  getLogs(): Promise<LogEntry[]>
  engineControl(command: EngineControlCommand): Promise<EngineControlResult>
  openExternal(url: string): Promise<OpenExternalResult>
  testAiProvider(): Promise<AiTestResult>
  getDailyReport(dateLocal?: string): Promise<DailyReportInfo>
  generateDailyReport(): Promise<EngineControlResult>
  listDailyReports(): Promise<DailyReportListResult>
  /** 匹配测试台（R5-P2c）：只读诊断，永不 reject（参数非法也返回 block 结果） */
  matchTest(req: MatchTestRequest): Promise<MatchTestResult>
  onStatus(callback: (s: EngineStatus) => void): () => void
  onHit(callback: (h: HitRecord) => void): () => void
  onLog(callback: (e: LogEntry) => void): () => void
  onDailyReport(callback: (r: DailyReportInfo) => void): () => void
}

/**
 * 托盘 tooltip（纯函数，托盘与 UI 可复用同一派生口径）：
 * desired 优先（用户意图覆盖观测），其次 challenged → backoff → 运行中。
 */
export function deriveTrayLabel(status: EngineStatus): string {
  if (status.desired === 'paused') return 'ForumWatch · 已暂停'
  if (status.health === 'challenged') return 'ForumWatch · Cloudflare 拦截中'
  if (status.health === 'backoff') return 'ForumWatch · 轮询异常重试中'
  return 'ForumWatch · 运行中'
}
