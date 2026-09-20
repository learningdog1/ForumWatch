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

/**
 * 处置流水 outcome 全集（R7-W1："为什么没推送"观测面）。
 * 类型与运行时清单共用这一处（const 数组推导联合，防两处漂移）；内核
 * src/main/monitor/dispositions.ts 从这里导入并再导出（MatchStageResult 先例：
 * tsconfig.web 的 composite 边界不允许 shared 反向 type-import src/main）。
 * 每个值对应引擎 unseen 处理链的一个真实分支出口，语义见 dispositions.ts。
 */
export const DISPOSITION_OUTCOMES = [
  /** 挂起队列成员被 unseen 链整帖跳过（等 flush 收口，不重新匹配） */
  'deferred-skip',
  /** per-source 过滤（分类白/黑名单、作者黑名单）滤掉 */
  'filtered',
  /** W3 旧帖过滤：数值 id ≤ 阈值（回复顶起的旧帖） */
  'old-below-threshold',
  /** 置顶帖：只入去重集绝不推送 */
  'pinned',
  /** 全局排除词一票否决 */
  'excluded',
  /** 字面/规则全未命中且未进语义批（终态：入 seen） */
  'miss',
  /** 语义批判否（终态：入 seen） */
  'semantic-miss',
  /** 语义判 hit 但置信度 < ai.semanticThreshold（终态：入 seen） */
  'semantic-below-threshold',
  /** 语义未决（不入 seen，下轮重评；评估失败时滞留在此状态） */
  'semantic-pending',
  /** 相似降噪：与 48h 已推窗口相似被吞（终态：入 seen） */
  'similar-swallowed',
  /** 免打扰/digest 挂起（入内存队列，等 flush） */
  'deferred',
  /** 即时推送成功 / 挂起帖 flush 成功（终态） */
  'pushed',
  /** 推送失败（重试在途）/ flush 3 次失败终态 / 挂起 24h 超时终态 */
  'push-failed',
  /** 静音（notifyEnabled=false 或无就绪通道；含挂起期间热更新为静音的 flush 收口） */
  'muted'
] as const

/** 处置流水 outcome（DISPOSITION_OUTCOMES 推导，见上） */
export type DispositionOutcome = (typeof DISPOSITION_OUTCOMES)[number]

/**
 * 一条处置记录：引擎 unseen 链某分支出口对一条帖子的处置结果。
 * 同一帖子（seenKey）只在 outcome 变化（状态迁移）时追加新记录——重试/重评
 * 轮每轮重入不刷屏（dispositions.ts 的去重语义）。
 */
export interface Disposition {
  /** ISO 时间戳（记录产生时刻） */
  ts: string
  sourceId: string
  topicId: string
  title: string
  outcome: DispositionOutcome
  /** 人读细节（命中词 / 分类与作者 / score 与阈值 / 失败原因等） */
  detail?: string
}

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
   * invoke(url) → {ok:boolean}；仅允许 https 且 host 在主进程的白名单内
   * （= 按已配置 enabled 来源派生的域及其子域 ∪ 静态 github.com——R8-B/E1
   * 起合并：更新检查的「打开下载页」指向 GitHub Releases，不来自任何来源
   * 配置）。拒绝或打开失败均 {ok:false}。
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
  /**
   * invoke() → Disposition[]（内存环形取最近 200 条，旧→新；渲染层自行倒序）。
   * R7-W1 处置流水："为什么没推送"的观测面。
   */
  dispositionsRecent: 'dispositions:recent',
  /** invoke(dateLocal: string) → Disposition[]（该日 pipeline JSONL，旧→新；坏行跳过） */
  dispositionsDay: 'dispositions:day',
  /**
   * invoke(HitQueryOptions) → HitQueryResult（R7-W2 历史命中浏览器）：跨日
   * hits JSONL 合并查询（日期含两端），内存过滤（来源/命中方式/文本）+ 分页，
   * items 恒新→旧。查询面不抛；limit 钳位上限 200。
   */
  queryHits: 'hits:query',
  /**
   * invoke(days?) → StatsResult（R7-W3 统计面板）：近 N 天（缺省 14，钳 [1,90]）
   * 命中的纯读聚合（readRecent → computeStats，includeKeywords 取当前配置）。
   */
  getStats: 'stats:get',
  /**
   * invoke(HitFeedbackRequest) → HitFeedbackResult（R7-W4 AI 反馈闭环，DEC-5）：
   * 命中行 👍/👎 落 FileFeedbackStore（正/负例各环形 100，同键再投=改票），
   * SemanticEvaluator 的 system prompt 尾部注入最近各 ≤8 条（下一次评估生效）。
   * direction='undo' 幂等撤销（键不存在也 ok）。
   */
  hitFeedback: 'hit:feedback',
  /**
   * invoke() → UpdateCheckStatus（R8-B/E1）：手动 force check——真发一次
   * GitHub Releases latest 请求并返回**本次**结果（有新版/已最新/失败三态
   * 如实回传；网络/解析失败不抛，收敛为 state:'error'）。
   */
  checkUpdate: 'update:check',
  /** invoke() → UpdateCheckStatus：最近一次检查的缓存（手动或定时；从未检查 = state:'idle'） */
  getUpdateStatus: 'update:status',
  /**
   * invoke() → BackupExportResult（R8-B/E4）：showSaveDialog（默认名
   * forumwatch-backup-YYYYMMDD.json）→ 读 userData 四文件 parse → packBackup
   * → 写所选路径（0o600：**含明文凭据**）。用户取消 → {ok:false, error:'已取消导出'}。
   */
  exportBackup: 'backup:export',
  /**
   * invoke() → BackupImportResult（R8-B/E4）：showOpenDialog → unpackBackup 验包
   * → restorePlan（seen 无效则删 seen.json + state 全员 baselineDone 重置，ADR 8.9）
   * → config/seen/state/feedback 按段原子写回 userData。成功恒
   * {ok:true, needsRestart:true}——seen/引擎状态内存不热换，重启生效；导入成功
   * 后主进程即暂停监控并进入"待重启禁写"（shutdown 不再 flush 覆盖导入文件），
   * config 段内存重读（防导入后在设置页保存把旧配置写回）。
   */
  importBackup: 'backup:import',
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
 * 历史命中查询（R7-W2）的请求载荷。类型定义在契约层——tsconfig.web 的
 * composite 边界不允许 shared 反向 type-import src/main，内核 hits-store.ts
 * 从这里导入并再导出（Disposition 先例）。日期为本地时区 'YYYY-MM-DD'
 * **含两端**；排序恒为新→旧（跨日按日期倒序，同日内按记录序倒序）。
 */
export interface HitQueryOptions {
  /** 起始本地日期（含） */
  fromDate: string
  /** 截止本地日期（含）；fromDate > toDate = 空区间 */
  toDate: string
  /** 来源精确匹配；undefined / 空串 = 不过滤 */
  sourceId?: string
  /** 命中方式过滤（包含语义：给数组则命中方式须在其内）；undefined / 空数组 = 不过滤 */
  matchedBy?: ('literal' | 'semantic' | 'rule')[]
  /** 对 title + matchedKeywords + matchedRule 的大小写不敏感子串；undefined / 空白 = 不过滤 */
  text?: string
  /** 页大小；上限 200（超出钳位），<=0 / 非法 = 0（total 仍准确） */
  limit: number
  /** 页偏移（0 起）；负数按 0 */
  offset: number
}

/** queryHits 返回：total = 过滤后总数（与分页无关），items = 分页切片（新→旧） */
export interface HitQueryResult {
  total: number
  items: HitRecord[]
}

/** 统计面板（R7-W3）· 按日计数（只含有命中的日期） */
export interface StatsDayCount {
  /** 本地时区 'YYYY-MM-DD' */
  date: string
  count: number
}

/** 统计面板 · 来源计数（降序） */
export interface StatsSourceCount {
  sourceId: string
  count: number
}

/**
 * 统计面板 · 关键词命中计数。零命中关键词（当前配置 includeKeywords 中从未
 * 命中的）以 count=0 + zeroHit=true 附在榜尾——"考虑移除或改写"提示的依据。
 */
export interface StatsKeywordCount {
  keyword: string
  count: number
  zeroHit?: true
}

/**
 * 统计面板（R7-W3）聚合结果：近 N 天（窗口由调用方取数，本形状只是聚合产物）
 * 的命中画像。纯读聚合 src/main/monitor/stats.ts 的 computeStats 产出；
 * pushFailRate ∈ [0,1]（notifyError 非空的占比，total=0 时为 0）。
 */
export interface StatsResult {
  total: number
  /** 有命中的日期，新→旧 */
  byDay: StatsDayCount[]
  /** 三档命中方式计数 */
  byMatchedBy: { literal: number; semantic: number; rule: number }
  /** 来源分布，count 降序 */
  bySource: StatsSourceCount[]
  /** 关键词命中榜：count 降序，零命中关键词附尾（zeroHit: true） */
  keywordHits: StatsKeywordCount[]
  /** 推送失败率（notifyError 非空占比；0 = 无失败或无命中） */
  pushFailRate: number
}

/**
 * hitFeedback（R7-W4）的投票动作：positive/negative 记票（同键再投 = 改票，
 * store 侧覆盖方向并刷新 ts）；undo 撤销该键的票（幂等）。
 */
export type HitFeedbackDirection = 'positive' | 'negative' | 'undo'

/** hitFeedback 请求：反馈键 = `${sourceId}:${topicId}`（与 engine 去重键同口径）；title 为投票时的标题快照 */
export interface HitFeedbackRequest {
  sourceId: string
  topicId: string
  title: string
  direction: HitFeedbackDirection
}

/** hitFeedback 返回：失败（载荷非法 / 写盘失败）带错误消息 */
export type HitFeedbackResult = { ok: true } | { ok: false; error: string }

/**
 * 更新检查状态（R8-B/E1；checkUpdate 返回本次结果 / getUpdateStatus 返回缓存）。
 * state 语义：
 * - 'idle'：从未检查过（应用刚启动、15s 定时首轮未到且未手动查）；
 * - 'available'：有新版（latest > current，downloadUrl 为发布页）；
 * - 'up-to-date'：已最新（latest ≤ current）；
 * - 'error'：上次检查失败（网络 / 非 2xx / 载荷解析；error 人读）。
 * current 在任何 state 都带（idle 也带——「关于」卡的版本号展示不依赖检查）。
 */
export interface UpdateCheckStatus {
  state: 'idle' | 'available' | 'up-to-date' | 'error'
  /** 当前应用版本（app.getVersion()） */
  current: string
  /** 本次/上次检查时刻（ISO）；idle 为 null */
  checkedAt: string | null
  /** 最新 release 的 tag（available / up-to-date 带回） */
  latest?: string
  /** 发布页地址（仅 available；openExternal 白名单已合并 github.com） */
  downloadUrl?: string
  /** 失败原因（仅 error；人读，可直显） */
  error?: string
}

/** exportBackup 返回：成功带导出路径；取消/读写失败带错误消息 */
export type BackupExportResult = { ok: true; path: string } | { ok: false; error: string }

/**
 * importBackup 返回：成功恒带 needsRestart（四段已原子写回 userData，但内存里
 * 的配置 / seen / 引擎状态仍是旧值——不热换，重启后生效）；验包不过 / 写盘
 * 失败带错误消息。
 */
export type BackupImportResult =
  | { ok: true; needsRestart: true }
  | { ok: false; error: string }

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
  /** 处置流水（R7-W1）：内存环形最近 200 条（旧→新）；不抛，失败返回 [] */
  dispositionsRecent(): Promise<Disposition[]>
  /** 处置流水（R7-W1）：某本地日的持久化记录（旧→新）；文件缺失/坏行按空跳过 */
  dispositionsDay(dateLocal: string): Promise<Disposition[]>
  /** 历史命中查询（R7-W2）：跨日合并 + 过滤 + 分页（新→旧）；不抛，失败返回空结果 */
  queryHits(opts: HitQueryOptions): Promise<HitQueryResult>
  /** 统计面板（R7-W3）：近 N 天（缺省 14）命中聚合；不抛，失败返回零值 */
  getStats(days?: number): Promise<StatsResult>
  /**
   * 命中反馈（R7-W4，DEC-5）：👍/👎 记票（同键再投=改票）或 undo 撤销（幂等）；
   * 失败返回 {ok:false}（写盘失败等），永不 reject。
   */
  hitFeedback(req: HitFeedbackRequest): Promise<HitFeedbackResult>
  /**
   * 更新检查（R8-B/E1）：手动 force check（真发一次请求），返回本次三态结果；
   * 失败收敛为 state:'error'，永不 reject。
   */
  checkUpdate(): Promise<UpdateCheckStatus>
  /** 更新检查（R8-B/E1）：最近一次结果缓存；从未检查返回 state:'idle' */
  getUpdateStatus(): Promise<UpdateCheckStatus>
  /**
   * 备份导出（R8-B/E4）：弹保存对话框 → 打包 config/seen/state/feedback 四段写
   * 所选路径（文件含明文凭据）。取消返回 {ok:false}；永不 reject。
   */
  exportBackup(): Promise<BackupExportResult>
  /**
   * 备份导入（R8-B/E4）：弹打开对话框 → 验包 → 按方案写回 userData 四段；
   * 成功恒 needsRestart:true（重启生效）。取消/验包失败返回 {ok:false}；永不 reject。
   */
  importBackup(): Promise<BackupImportResult>
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
