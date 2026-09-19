/**
 * 主进程侧 IPC（契约见 src/shared/ipc.ts）：
 * - createBroadcaster：主→渲染事件推送（evStatus / evHit / evLog / evDailyReport），
 *   面向所有存活 webContents 广播，destroyed 的窗口跳过；日志逐条推（内核日志低频，
 *   每轮轮询 1-2 条，无需批量节流），历史用 logs:get 拉全量。
 * - registerIpcHandlers：invoke handler 注册（getConfig / saveConfig / getStatus /
 *   getHits / getLogs / engineControl / openExternal / testAiProvider /
 *   getDailyReport / generateDailyReport / listDailyReports / dispositionsRecent /
 *   dispositionsDay / queryHits / getStats / hitFeedback），失败一律收敛为返回值，
 *   绝不向渲染进程抛异常。
 * - AI / 日报通道（W2-c 接入）：testAiProvider 走 provider.testConnection（错误
 *   消息已脱敏，无 apiKey 明文）；getDailyReport/loadReport/list 走
 *   DailyReportService 的文件查询；generateDailyReport 是**手动生成**——跳过
 *   desired 与 attempts 检查、直接覆盖重生成（推送条件在 generate 内部）。
 */
import { BrowserWindow, ipcMain, shell } from 'electron'
import {
  IPC,
  type AiTestResult,
  type DailyReportListResult,
  type EngineControlResult,
  type HitFeedbackResult,
  type HitQueryOptions,
  type HitQueryResult,
  type MatchTestRequest,
  type MatchTestResult,
  type OpenExternalResult,
  type SaveConfigResult,
  type StatsResult
} from '../../shared/ipc'
import type {
  AppConfig,
  DailyReportInfo,
  EngineStatus,
  HitRecord,
  LogEntry,
  Topic
} from '../../shared/types'
import type { DesktopRuntime } from './runtime'
import { allowedExternalDomains, isHostAllowed } from '../monitor/sources/registry'
import { formatLocalDate } from '../monitor/hits-store'
import { computeStats } from '../monitor/stats'
import { normalizeTitle } from '../monitor/similarity'
import { runMatchTest, type SemanticTestInput } from '../monitor/testbench'

/** 主→渲染事件推送接口（runtime 把 engine onStatus/onHit / 日报广播转发给它） */
export interface EventBroadcaster {
  status(s: EngineStatus): void
  hit(h: HitRecord): void
  log(e: LogEntry): void
  /** 日报生成完成时推送（DailyReportInfo） */
  report(r: DailyReportInfo): void
}

export function createBroadcaster(): EventBroadcaster {
  const broadcast = (channel: string, payload: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      // 跳过已销毁/已崩溃的窗口（关窗进托盘后可能销毁重建）；
      // send 也包一层 catch——退出时序里 render frame 先于窗口销毁的极端情况
      // 只丢一次推送，不向上冒泡打断 engine 回调链。
      if (win.isDestroyed()) continue
      const wc = win.webContents
      if (wc.isDestroyed() || wc.isCrashed()) continue
      try {
        wc.send(channel, payload)
      } catch {
        /* render frame disposed：跳过该窗口 */
      }
    }
  }
  return {
    status: (s) => broadcast(IPC.evStatus, s),
    hit: (h) => broadcast(IPC.evHit, h),
    log: (e) => broadcast(IPC.evLog, e),
    report: (r) => broadcast(IPC.evDailyReport, r)
  }
}

/**
 * 注册全部 invoke handler 与日志事件流。在 runtime 初始化之后、窗口创建之前调用。
 */
export function registerIpcHandlers(rt: DesktopRuntime, bc: EventBroadcaster): void {
  // 日志事件流：新条目实时推（渲染进程启动时用 getLogs 拉内存环形的全量）
  rt.logger.onLog((entry) => bc.log(entry))

  ipcMain.handle(IPC.getConfig, () => rt.store.get())

  // store.update（浅合并 + sanitize + 原子落盘）——渲染端漏字段时按合并语义
  // 保留现有值，不会意外清空关键词等未提交字段；写盘失败向上抛 → catch 转 {ok:false}
  ipcMain.handle(IPC.saveConfig, (_event, cfg: unknown): SaveConfigResult => {
    try {
      const effective = rt.store.update(cfg as Partial<AppConfig>)
      rt.applyConfigSideEffects(effective)
      return { ok: true, config: effective }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.getStatus, () => rt.engine.getStatus())
  ipcMain.handle(IPC.getHits, () => rt.engine.getRecentHits())
  ipcMain.handle(IPC.getLogs, () => rt.logger.getRecent())

  /**
   * engine:control —— pause 语义（内核上游约定，UI 必读）：
   * - pause 只改 desired，不动 health；
   * - pause 后 nextPollAt 保留旧值（排程器已停但字段不清空），UI 应按
   *   desired=paused 派生展示（忽略 nextPollAt）；
   * - runNow 在 paused 时是 no-op（内核尊重 desired）；
   * - sendTest 异常（TelegramError）在这里 catch 回传 {ok:false, error}。
   */
  ipcMain.handle(IPC.engineControl, async (_event, cmd: unknown): Promise<EngineControlResult> => {
    if (cmd !== 'pause' && cmd !== 'resume' && cmd !== 'runNow' && cmd !== 'sendTest') {
      return { ok: false, error: `unknown command: ${String(cmd)}` }
    }
    try {
      switch (cmd) {
        case 'pause':
          rt.engine.pause()
          break
        case 'resume':
          rt.engine.resume()
          break
        case 'runNow':
          rt.engine.runNow()
          break
        case 'sendTest':
          await rt.engine.sendTestNotification()
          break
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // 仅放行 https 且 host 为已配置（enabled）来源的域或其子域；白名单按
  // config.sources 派生（v2：nodeseek → nodeseek.com；见 monitor/sources/registry）
  ipcMain.handle(IPC.openExternal, async (_event, url: unknown): Promise<OpenExternalResult> => {
    if (typeof url !== 'string') return { ok: false }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { ok: false }
    }
    if (parsed.protocol !== 'https:') return { ok: false }
    if (!isHostAllowed(parsed.hostname, allowedExternalDomains(rt.store.get()))) {
      return { ok: false }
    }
    try {
      await shell.openExternal(parsed.toString())
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })

  // ---- AI / 日报（W2-c 真实实现） -----------------------------------------

  /** invoke() → AiTestResult：最小对话验证 Provider；错误消息 provider 已脱敏 */
  ipcMain.handle(IPC.testAiProvider, async (): Promise<AiTestResult> => {
    try {
      await rt.aiProvider.testConnection()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /** invoke(dateLocal?) → DailyReportInfo：缺省取今天（本地时区），无日报则 markdown:null */
  ipcMain.handle(
    IPC.getDailyReport,
    async (_event, dateLocal?: unknown): Promise<DailyReportInfo> => {
      const date =
        typeof dateLocal === 'string' && dateLocal !== '' ? dateLocal : formatLocalDate()
      return { date, markdown: await rt.reportService.loadReport(date) }
    }
  )

  /**
   * invoke() → EngineControlResult：手动生成本日日报。跳过 desired 与 attempts
   * 检查、覆盖重生成（generate 直接 writeFile 覆盖）；推送条件同 generate 内部
   * （enabled × telegram 配置 × notifyEnabled）。onGenerated 广播由 reportService
   * 构造时的回调发出（broadcaster.report）。
   */
  ipcMain.handle(IPC.generateDailyReport, async (): Promise<EngineControlResult> => {
    try {
      await rt.reportService.generate()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /** invoke() → { dates: string[] }：已有日报的日期列表（新→旧，读 reports/ 目录） */
  ipcMain.handle(IPC.listDailyReports, (): DailyReportListResult => ({
    dates: rt.reportService.listReportDays()
  }))

  // ---- 处置流水（R7-W1"为什么没推送"观测面） -------------------------------

  /** invoke() → Disposition[]：内存环最近 200 条（旧→新）；查询面不抛 */
  ipcMain.handle(IPC.dispositionsRecent, () => rt.dispositions.recent(200))

  /**
   * invoke(dateLocal) → Disposition[]：某本地日的持久化记录（旧→新）。
   * 参数缺省/非字符串按今天处理；文件缺失/坏行由 store 按空/跳过收口。
   */
  ipcMain.handle(IPC.dispositionsDay, (_event, dateLocal: unknown) => {
    const date =
      typeof dateLocal === 'string' && dateLocal !== '' ? dateLocal : formatLocalDate()
    return rt.dispositions.readDay(date)
  })

  // ---- 历史命中浏览器 + 统计面板（R7-W2 / W3） -----------------------------

  /** getStats 的 days 钳位：缺省 14（UI 统计区固定口径），下限 1，上限 90 */
  const STATS_DAYS_DEFAULT = 14
  const STATS_DAYS_MAX = 90

  /** 'YYYY-MM-DD' 形状（queryHits 的日期入参校验；非法 → 空结果） */
  const DATE_SHAPE_RE = /^\d{4}-\d{2}-\d{2}$/

  /**
   * 渲染进程传来的 unknown 载荷 → HitQueryOptions（不信任 renderer 内存）。
   * 非法日期 → 空区间（toDate 形状不过 → 恒空；fromDate 形状不过 → 保持 toDate
   * 为上界）。字段缺省按"不过滤 / 第一页 / 50 条"处理。
   */
  const normalizeHitQuery = (raw: unknown): HitQueryOptions => {
    const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const fromDate =
      typeof o['fromDate'] === 'string' && DATE_SHAPE_RE.test(o['fromDate']) ? o['fromDate'] : ''
    const toDate =
      typeof o['toDate'] === 'string' && DATE_SHAPE_RE.test(o['toDate']) ? o['toDate'] : ''
    const sourceId = typeof o['sourceId'] === 'string' && o['sourceId'] !== '' ? o['sourceId'] : undefined
    const matchedBy = Array.isArray(o['matchedBy'])
      ? o['matchedBy'].filter(
          (v): v is 'literal' | 'semantic' | 'rule' =>
            v === 'literal' || v === 'semantic' || v === 'rule'
        )
      : undefined
    const text = typeof o['text'] === 'string' && o['text'].trim() !== '' ? o['text'] : undefined
    const limit = typeof o['limit'] === 'number' && Number.isFinite(o['limit']) ? o['limit'] : 50
    const offset = typeof o['offset'] === 'number' && Number.isFinite(o['offset']) ? o['offset'] : 0
    return { fromDate, toDate, sourceId, matchedBy, text, limit, offset }
  }

  /**
   * invoke(HitQueryOptions) → HitQueryResult：hitsStore.query 跨日 JSONL 合并
   * 查询（过滤 + 分页，items 新→旧）。查询面不抛；readDay 单日失败按空处理。
   */
  ipcMain.handle(
    IPC.queryHits,
    (_event, opts: unknown): Promise<HitQueryResult> => rt.hitsStore.query(normalizeHitQuery(opts))
  )

  /**
   * invoke(days?) → StatsResult：近 N 天（缺省 14，钳 [1,90]）命中的纯读聚合。
   * readRecent 以当前时刻起算本地自然日窗口；includeKeywords 取当前生效配置
   * （零命中关键词检出基准）。读取失败按空数据聚合（不抛）。
   */
  ipcMain.handle(IPC.getStats, async (_event, days: unknown): Promise<StatsResult> => {
    const n =
      typeof days === 'number' && Number.isFinite(days)
        ? Math.min(Math.max(Math.floor(days), 1), STATS_DAYS_MAX)
        : STATS_DAYS_DEFAULT
    const hits = await rt.hitsStore.readRecent(n)
    return computeStats(hits, { includeKeywords: rt.store.get().includeKeywords })
  })

  // ---- 命中反馈（R7-W4 AI 反馈闭环，DEC-5） ---------------------------------

  /**
   * invoke(HitFeedbackRequest) → HitFeedbackResult：命中行 👍/👎 落
   * rt.feedbackStore（正/负例各环形 100，同键再投=改票），SemanticEvaluator 的
   * system prompt 尾部注入最近各 ≤8 条（下一次语义评估生效）。undo 幂等
   * （键不存在也 ok）。载荷不信任 renderer 内存：逐字段判型，非法 → {ok:false}。
   */
  ipcMain.handle(IPC.hitFeedback, (_event, raw: unknown): HitFeedbackResult => {
    const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const sourceId = typeof o['sourceId'] === 'string' ? o['sourceId'] : ''
    const topicId = typeof o['topicId'] === 'string' ? o['topicId'] : ''
    const title = typeof o['title'] === 'string' ? o['title'].trim() : ''
    const direction = o['direction']
    if (sourceId === '' || topicId === '' || title === '') {
      return { ok: false, error: 'invalid feedback payload: need non-empty sourceId/topicId/title' }
    }
    if (direction !== 'positive' && direction !== 'negative' && direction !== 'undo') {
      return { ok: false, error: `unknown direction: ${String(direction)}` }
    }
    try {
      if (direction === 'undo') {
        rt.feedbackStore.undo(`${sourceId}:${topicId}`)
      } else {
        rt.feedbackStore.vote(`${sourceId}:${topicId}`, title, direction)
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ---- 匹配测试台（R5-P2c） -----------------------------------------------

  /**
   * invoke(MatchTestRequest) → MatchTestResult：按已保存配置对单个标题跑一遍
   * 判定管线（testbench.runMatchTest 纯函数）。只读诊断：不写 seen / hits、
   * 不推送、不动引擎状态。永不向渲染进程抛异常（参数非法也返回 block 结果）。
   *
   * 数据面：
   * - filters：sourceId 给则取该 source 的 config.filters（无则 undefined）；
   * - recentPushedTitles：hitsStore.readRecent(2) 里 notifiedAt 非空的行，
   *   标题 normalizeTitle 后跳过空串（isSimilarToAny 的契约：窗口须传已归一串；
   *   这里不做 48h 时间过滤——测试台想看"与近期推过的东西"是否相似，宽一点
   *   更有诊断价值，2 天读取面本身已界定范围）；
   * - semantic：useAi=true 且 provider 三项齐备时**真调一次** evaluator（单帖
   *   一批，消耗一次 LLM 调用——注意这不走 engine 的每日 300 计数器，engine.ts
   *   不可改；失败/未决/AI 未配置/兴趣为空都收敛为 {skipped}，语义阶段按 skip
   *   展示原因，绝不炸整次测试。
   */
  ipcMain.handle(IPC.matchTest, async (_event, req: unknown): Promise<MatchTestResult> => {
    const raw = (typeof req === 'object' && req !== null ? req : {}) as Partial<MatchTestRequest>
    const title = typeof raw.title === 'string' ? raw.title.trim() : ''
    if (title === '') {
      return {
        wouldPush: false,
        stages: [
          { stage: 'input', label: '输入', outcome: 'block', detail: '参数无效：需要非空 title' }
        ]
      }
    }
    const sourceId =
      typeof raw.sourceId === 'string' && raw.sourceId !== '' ? raw.sourceId : undefined
    const useAi = raw.useAi === true
    const category = typeof raw.category === 'string' ? raw.category.trim() : ''
    const author = typeof raw.author === 'string' ? raw.author.trim() : ''

    const cfg: AppConfig = rt.store.get()
    const filters = sourceId !== undefined
      ? cfg.sources.find((s) => s.id === sourceId)?.filters
      : undefined

    let recentPushedTitles: string[] = []
    try {
      const recent = await rt.hitsStore.readRecent(2)
      recentPushedTitles = recent
        .filter((h) => h.notifiedAt !== null && h.notifiedAt !== '')
        .map((h) => normalizeTitle(h.topic.title))
        .filter((t) => t !== '')
    } catch {
      recentPushedTitles = [] // 读取失败按空窗处理（测试面不炸）
    }

    let semantic: SemanticTestInput | undefined
    if (!useAi) {
      semantic = undefined
    } else {
      const p = cfg.ai.provider
      const configured =
        p.baseUrl.trim() !== '' && p.apiKey.trim() !== '' && p.model.trim() !== ''
      if (!configured) {
        semantic = { skipped: 'AI 未配置（Base URL / API Key / 模型名不齐）' }
      } else if (cfg.ai.interests.length === 0) {
        // evaluator 对空兴趣会快速全 miss 不调 API；直接说明原因更清楚
        semantic = { skipped: '兴趣描述为空：语义档永不命中（未调 AI）' }
      } else {
        const topic: Topic = {
          id: 'testbench',
          sourceId: sourceId ?? 'testbench',
          title,
          url: '',
          author,
          category,
          // 用户给的分类同时按显示名与 slug 两种口径参与匹配（测试台拿不到真实 slug）
          categorySlug: category,
          pinned: false,
          lastActiveAt: null
        }
        try {
          const verdicts = await rt.semanticEvaluator.evaluate([topic], cfg.ai.interests)
          const verdict = verdicts.get(`${topic.sourceId}:${topic.id}`)
          semantic =
            verdict === undefined
              ? { skipped: 'AI 未给出该帖的裁决（未决）' }
              : { hit: verdict.hit, score: verdict.score, reason: verdict.reason }
        } catch (err) {
          semantic = {
            skipped: `AI 评估失败：${err instanceof Error ? err.message : String(err)}`
          }
        }
      }
    }

    return runMatchTest({
      title,
      filters,
      cfg,
      recentPushedTitles,
      semantic,
      topic: { category, categorySlug: category, author }
    })
  })
}
