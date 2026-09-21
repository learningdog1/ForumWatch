/**
 * 主进程侧 IPC（契约见 src/shared/ipc.ts）：
 * - createBroadcaster：主→渲染事件推送（evStatus / evHit / evLog / evDailyReport），
 *   面向所有存活 webContents 广播，destroyed 的窗口跳过；日志逐条推（内核日志低频，
 *   每轮轮询 1-2 条，无需批量节流），历史用 logs:get 拉全量。
 * - registerIpcHandlers：invoke handler 注册（getConfig / saveConfig / getStatus /
 *   getHits / getLogs / engineControl / openExternal / testAiProvider /
 *   getDailyReport / generateDailyReport / listDailyReports / dispositionsRecent /
 *   dispositionsDay / queryHits / getStats / hitFeedback / checkUpdate /
 *   getUpdateStatus / exportBackup / importBackup），失败一律收敛为返回值，
 *   绝不向渲染进程抛异常。
 * - AI / 日报通道（W2-c 接入）：testAiProvider 走 provider.testConnection（错误
 *   消息已脱敏，无 apiKey 明文）；getDailyReport/loadReport/list 走
 *   DailyReportService 的文件查询；generateDailyReport 是**手动生成**——跳过
 *   desired 与 attempts 检查、直接覆盖重生成（推送条件在 generate 内部）。
 * - 更新检查（R8-B/E1）：UpdateChecker（desktop/update-check.ts，零 electron）
 *   在这里构造并 start（15s 延迟 + 24h 轮询；runtime.ts 不掺和——它不在本包的
 *   改动面）。checkUpdate / getUpdateStatus 只读 checker 的 outcome 缓存。
 * - 备份导出/导入（R8-B/E4）：dialog 在本层弹；打包/验包/落盘方案走
 *   src/main/backup.ts 纯函数内核；段写回用同目录 tmp+rename 原子写
 *   （ConfigStore.writeAtomically 同款模式，config 段 0o600 对齐其凭据口径）。
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomInt } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  IPC,
  type AiTestResult,
  type BackupExportResult,
  type BackupImportResult,
  type DailyReportListResult,
  type EngineControlResult,
  type HitFeedbackResult,
  type HitQueryOptions,
  type HitQueryResult,
  type MatchTestRequest,
  type MatchTestResult,
  type OpenExternalResult,
  type SaveConfigResult,
  type StatsResult,
  type UpdateCheckStatus
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
import { resolveSourceMatching } from '../monitor/matching'
import { computeStats } from '../monitor/stats'
import { normalizeTitle } from '../monitor/similarity'
import { runMatchTest, type SemanticTestInput } from '../monitor/testbench'
import { UpdateChecker, UPDATE_REPO } from './update-check'
import { packBackup, restorePlan, unpackBackup } from '../backup'
import type { FetchLike } from '../net/http-types'

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

  /**
   * 'YYYY-MM-DD' 形状（锚定；日期入参共用校验）：getDailyReport /
   * dispositionsDay / queryHits 三处共用。日期会拼进读文件路径（reports/
   * pipeline/<date>.jsonl），不锚定形状即放行路径穿越串——非法形状按缺省处理。
   */
  const DATE_SHAPE_RE = /^\d{4}-\d{2}-\d{2}$/

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
  // config.sources 派生（v2：nodeseek → nodeseek.com；见 monitor/sources/registry）。
  // R8-B/E1 起合并静态域 github.com（更新检查的「打开下载页」指向 GitHub
  // Releases 发布页——它不来自任何来源配置，不能走派生路径；最小扩展为
  // ipc 层的合并列表，registry 的派生逻辑不动）。
  const STATIC_EXTERNAL_DOMAINS = ['github.com'] as const

  ipcMain.handle(IPC.openExternal, async (_event, url: unknown): Promise<OpenExternalResult> => {
    if (typeof url !== 'string') return { ok: false }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { ok: false }
    }
    if (parsed.protocol !== 'https:') return { ok: false }
    const allowed = [...allowedExternalDomains(rt.store.get()), ...STATIC_EXTERNAL_DOMAINS]
    if (!isHostAllowed(parsed.hostname, allowed)) {
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

  /**
   * invoke(dateLocal?) → DailyReportInfo：缺省/非法形状（非 'YYYY-MM-DD' 锚定，
   * 日期会拼进 reports 读路径）取今天（本地时区），无日报则 markdown:null
   */
  ipcMain.handle(
    IPC.getDailyReport,
    async (_event, dateLocal?: unknown): Promise<DailyReportInfo> => {
      const date =
        typeof dateLocal === 'string' && DATE_SHAPE_RE.test(dateLocal)
          ? dateLocal
          : formatLocalDate()
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
   * 参数缺省/非字符串/形状非法（非锚定 'YYYY-MM-DD'——date 会拼进 pipeline/
   * <date>.jsonl 读路径，不锚定即放行路径穿越）按今天处理；文件缺失/坏行由
   * store 按空/跳过收口。
   */
  ipcMain.handle(IPC.dispositionsDay, (_event, dateLocal: unknown) => {
    const date =
      typeof dateLocal === 'string' && DATE_SHAPE_RE.test(dateLocal)
        ? dateLocal
        : formatLocalDate()
    return rt.dispositions.readDay(date)
  })

  // ---- 历史命中浏览器 + 统计面板（R7-W2 / W3） -----------------------------

  /** getStats 的 days 钳位：缺省 14（UI 统计区固定口径），下限 1，上限 90 */
  const STATS_DAYS_DEFAULT = 14
  const STATS_DAYS_MAX = 90

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
   * R13：基准 = 全局包含词 ∪ 各来源的覆盖包含词（去重交给 computeStats——
   * 它对 cfg.includeKeywords 已按小写归并去重，并集传入不会重复列出），
   * 让 per-source 关键词也进零命中检出。
   */
  ipcMain.handle(IPC.getStats, async (_event, days: unknown): Promise<StatsResult> => {
    const n =
      typeof days === 'number' && Number.isFinite(days)
        ? Math.min(Math.max(Math.floor(days), 1), STATS_DAYS_MAX)
        : STATS_DAYS_DEFAULT
    const hits = await rt.hitsStore.readRecent(n)
    const cfg = rt.store.get()
    const includeKeywords = [
      ...cfg.includeKeywords,
      ...cfg.sources.flatMap((s) => s.matching?.includeKeywords ?? [])
    ]
    return computeStats(hits, { includeKeywords })
  })

  // ---- 命中反馈（R7-W4 AI 反馈闭环，DEC-5） ---------------------------------

  /**
   * invoke(HitFeedbackRequest) → HitFeedbackResult：命中行 👍/👎 落
   * rt.feedbackStore（正/负例各环形 100，同键再投=改票），SemanticEvaluator 的
   * system prompt 尾部注入最近各 ≤8 条（下一次语义评估生效）。undo 幂等
   * （键不存在也 ok）。载荷不信任 renderer 内存：逐字段判型，非法 → {ok:false}。
   */
  ipcMain.handle(IPC.hitFeedback, (_event, raw: unknown): HitFeedbackResult => {
    // 备份导入后的待重启窗口：feedback.json 已被导入件覆盖，此处写入会用旧内存
    // 环冲掉它——拒绝（重启后投票面恢复）
    if (rt.isPendingRestart) {
      return { ok: false, error: '备份已导入待重启：反馈投票暂不可用，请重启应用' }
    }
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

  /** matchTest 的 title 长度上限（字符；超长在输入阶段 block，不进判定管线） */
  const MATCH_TEST_TITLE_MAX_CHARS = 500

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
    // 长度上限：真实帖子标题远短于此；超长输入（误贴整篇文章等）直接在输入阶段
    // 拦下，不进管线（匹配/相似度/语义调用都不该为无意义载荷买单）
    if (title.length > MATCH_TEST_TITLE_MAX_CHARS) {
      return {
        wouldPush: false,
        stages: [
          {
            stage: 'input',
            label: '输入',
            outcome: 'block',
            detail: `标题超长（>${MATCH_TEST_TITLE_MAX_CHARS} 字符）`
          }
        ]
      }
    }
    const sourceId =
      typeof raw.sourceId === 'string' && raw.sourceId !== '' ? raw.sourceId : undefined
    const useAi = raw.useAi === true
    const category = typeof raw.category === 'string' ? raw.category.trim() : ''
    const author = typeof raw.author === 'string' ? raw.author.trim() : ''

    const cfg: AppConfig = rt.store.get()
    // R13 诊断面 parity：per-source 匹配覆盖用与引擎同一解析器（matching.ts 的
    // resolveSourceMatching）——两处各自解析会漂移，测试台将给出与引擎相反的
    // 结论。sourceId 未指定时整体回退全局（未知 id 同样回退）。
    const m = resolveSourceMatching(cfg, sourceId ?? '')
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
      } else if (m.interests.length === 0) {
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
          const verdicts = await rt.semanticEvaluator.evaluate([topic], m.interests)
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
      // R13：exclude / literal / threshold 三个消费点用 per-source 生效值——直接
      // 把 cfg 覆盖成"该来源视角"的配置（浅拷贝组装，不动 store 内存；testbench
      // 的「字面/语义档不受 matchMode 门控」既有意差保留，诊断工具语义不变）。
      // R13-2：matchAll 走独立入参（cfg 无对应全局字段，只有来源级覆盖）。
      cfg: {
        ...cfg,
        includeKeywords: m.includeKeywords,
        excludeKeywords: m.excludeKeywords,
        ai: { ...cfg.ai, semanticThreshold: m.semanticThreshold }
      },
      recentPushedTitles,
      semantic,
      topic: { category, categorySlug: category, author },
      matchAll: m.matchAll
    })
  })

  // ---- 更新检查（R8-B/E1） --------------------------------------------------

  /**
   * 全局 fetch → FetchLike 适配（UpdateChecker 的注入面）。Electron 主进程
   * （Node ≥18）自带 fetch；更新检查走直连——不掺 proxy 的 site/ai client
   * （那些归 runtime 管，且 GitHub API 通常无需代理即可达；真不可达也只是
   * 静默失败，下次轮询再试）。
   * timeoutMs → AbortSignal.timeout（runtime.ts createBrowserStackFetch 同款，
   * 老运行时缺 AbortSignal.any 时以 timeout 为准）；外部 signal 经
   * AbortSignal.any 合并。不给超时的全局 fetch 会挂到 TCP 超时为止（分钟级），
   * 手动「检查更新」期间 UI 会一直等。
   */
  const directFetch: FetchLike = async (url, init) => {
    let signal = init?.signal
    if (init?.timeoutMs !== undefined) {
      const timeoutSignal = AbortSignal.timeout(init.timeoutMs)
      if (signal !== undefined && typeof AbortSignal.any === 'function') {
        signal = AbortSignal.any([signal, timeoutSignal])
      } else {
        signal = timeoutSignal
      }
    }
    const res = await fetch(url, {
      headers: init?.headers,
      ...(signal !== undefined ? { signal } : {})
    })
    const headers: Record<string, string> = {}
    res.headers.forEach((value, key) => {
      headers[key] = value
    })
    return { status: res.status, headers, body: await res.text() }
  }

  /** 单实例：registerIpcHandlers 每进程只调一次（index.ts 装配序） */
  const updateChecker = new UpdateChecker({
    currentVersion: app.getVersion(),
    repo: UPDATE_REPO,
    fetchFn: directFetch,
    log: { warn: (msg) => rt.logger.warn(msg) }
  })
  // 启动延迟 15s + 每 24h 轮询（app 退出进程随之消亡，无需显式 stop）
  updateChecker.start()

  /** checker 的 outcome → IPC 契约形状（checkedAt 转 ISO；idle 也带 current） */
  const updateStatus = (): UpdateCheckStatus => {
    const last = updateChecker.lastOutcome()
    if (last === null) {
      return { state: 'idle', current: app.getVersion(), checkedAt: null }
    }
    const checkedAt = new Date(last.checkedAt).toISOString()
    switch (last.kind) {
      case 'available':
        return {
          state: 'available',
          current: last.current,
          checkedAt,
          latest: last.latest,
          downloadUrl: last.downloadUrl
        }
      case 'up-to-date':
        return { state: 'up-to-date', current: last.current, checkedAt, latest: last.latest }
      case 'error':
        return { state: 'error', current: last.current, checkedAt, error: last.error }
    }
  }

  /**
   * invoke() → UpdateCheckStatus：手动 force check（真发一次请求，成功失败都
   * 刷新缓存）。check 内部一切失败已静默收敛，这里不会再抛。
   */
  ipcMain.handle(IPC.checkUpdate, async (): Promise<UpdateCheckStatus> => {
    await updateChecker.check()
    return updateStatus()
  })

  /** invoke() → UpdateCheckStatus：最近一次结果的缓存（不发包） */
  ipcMain.handle(IPC.getUpdateStatus, (): UpdateCheckStatus => updateStatus())

  // ---- 备份导出/导入（R8-B/E4） ---------------------------------------------

  /** userData 下的四个数据文件名（与 runtime.ts 装配路径一致） */
  const CONFIG_FILE = 'config.json'
  const SEEN_FILE = 'seen.json'
  const STATE_FILE = 'state.json'
  const FEEDBACK_FILE = 'feedback.json'

  /**
   * 同目录 tmp + rename 原子写（ConfigStore.writeAtomically 同款；备份导入
   * 的段写回用）。mode 给了则先收紧 tmp 权限再 rename（config 段含明文凭据，
   * 与 config.json 的 0o600 口径一致）。失败清 tmp 后向上抛（handler 收口）。
   */
  const writeAtomically = (filePath: string, payload: string, mode?: 0o600): void => {
    const tmpPath = `${filePath}.tmp-${process.pid}-${randomInt(0, 0xffffff).toString(36)}`
    mkdirSync(dirname(filePath), { recursive: true })
    try {
      writeFileSync(tmpPath, payload, mode !== undefined ? { encoding: 'utf-8', mode } : 'utf-8')
      if (mode !== undefined) {
        try {
          chmodSync(tmpPath, mode)
        } catch {
          /* 权限收紧失败不阻断（rename 后内容仍在用户指定目录）；Windows 无 POSIX 位 */
        }
      }
      renameSync(tmpPath, filePath)
    } catch (err) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // tmp 清理失败可忽略（残留无害，下次写会用新 tmp）
      }
      throw err
    }
  }

  /**
   * 读 userData 下的 JSON 文件并 parse；文件缺失 / 读失败 / JSON 坏 → fallback
   * （坏文件记 warn：导出的是「应用实际会加载到的内容」——config 损坏时
   * ConfigStore 会回默认，导出侧同样给默认信封，而不是让整个导出炸掉）。
   */
  const readSegment = (fileName: string, fallback: unknown): unknown => {
    const filePath = join(rt.userDataDir, fileName)
    try {
      if (!existsSync(filePath)) return fallback
      return JSON.parse(readFileSync(filePath, 'utf-8'))
    } catch (err) {
      rt.logger.warn(
        `[backup] read ${fileName} failed, exporting fallback: ${err instanceof Error ? err.message : String(err)}`
      )
      return fallback
    }
  }

  ipcMain.handle(IPC.exportBackup, async (event): Promise<BackupExportResult> => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const opts = {
        defaultPath: `forumwatch-backup-${formatLocalDate().replaceAll('-', '')}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }]
      }
      const picked = win !== undefined ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (picked.canceled || picked.filePath === undefined || picked.filePath === '') {
        return { ok: false, error: '已取消导出' }
      }
      // 四段各取已解析的 JSON 值；缺失/坏文件回退到与内核读路径同口径的默认信封。
      // config 段**不走盘上 parse**（R9-W2/DEC-10）：盘上敏感字段是 enc:v1: 密文
      // （OS 密钥库绑定本机，导出密文毫无用处），改从 rt.store.get() 取**内存明文**
      // ——单一事实源（应用实际会加载到的内容），导出件仍是明文凭据 + UI 警告
      // （DEC-10：导出明文并警告，见备份文案），导入端读回明文、下次 save 自动再加密。
      const config = { schemaVersion: 3, config: rt.store.get() }
      const seen = readSegment(SEEN_FILE, { schemaVersion: 2, seen: [] })
      const state = readSegment(STATE_FILE, { schemaVersion: 2, sources: {} })
      const feedback = readSegment(FEEDBACK_FILE, undefined) // 缺文件 → undefined → 不落键
      const text = packBackup({
        appVersion: app.getVersion(),
        config,
        seen,
        state,
        ...(feedback !== undefined ? { feedback } : {})
      })
      // 用户所选路径直接写（非原子：目标是用户目录而非 userData，中途断电
      // 最坏残留半份文件，重导即可）；内容含明文凭据 → 新建即 0o600
      writeFileSync(picked.filePath, text, { encoding: 'utf-8', mode: 0o600 })
      rt.logger.info(`backup exported to ${picked.filePath}`)
      return { ok: true, path: picked.filePath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.importBackup, async (event): Promise<BackupImportResult> => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const picked =
        win !== undefined
          ? await dialog.showOpenDialog(win, {
              properties: ['openFile'],
              filters: [{ name: 'JSON', extensions: ['json'] }]
            })
          : await dialog.showOpenDialog({
              properties: ['openFile'],
              filters: [{ name: 'JSON', extensions: ['json'] }]
            })
      const filePath = picked.filePaths[0]
      if (picked.canceled || filePath === undefined) {
        return { ok: false, error: '已取消导入' }
      }
      // 验包（kind/版本/段形状；错误消息人读中文，UI 原样展示）
      const unpacked = unpackBackup(readFileSync(filePath, 'utf-8'))
      if (!unpacked.ok) return { ok: false, error: unpacked.error }
      const plan = restorePlan(unpacked.data, { appVersion: app.getVersion() })
      // 按段写回（各自原子；不做 .bak 备份——覆盖风险由 UI 导入前的确认文案承担）
      writeAtomically(join(rt.userDataDir, CONFIG_FILE), JSON.stringify(plan.config, null, 2), 0o600)
      if (plan.seen === null) {
        // seen 段无效：删除现有 seen.json，引擎下次启动空集重建 + 补基线
        // （state 的 baselineDone 已由 restorePlan 强制重置，ADR 8.9）
        rmSync(join(rt.userDataDir, SEEN_FILE), { force: true })
      } else {
        writeAtomically(join(rt.userDataDir, SEEN_FILE), JSON.stringify(plan.seen))
      }
      writeAtomically(join(rt.userDataDir, STATE_FILE), JSON.stringify(plan.state, null, 2))
      // feedback 与 seen 有效性无耦合：备份里给了才写；缺键不动现有 feedback.json
      if (unpacked.data.feedback !== undefined) {
        writeAtomically(
          join(rt.userDataDir, FEEDBACK_FILE),
          JSON.stringify(unpacked.data.feedback, null, 2)
        )
      }
      // 四段已落盘 → "待重启禁写"：暂停引擎（停轮询/停定时，此后 runtime 不再
      // 产生 seen/state 落盘），shutdown 也不会再用旧内存集 flush 覆盖导入的
      // seen.json。UI 提示"监控已暂停，请尽快重启"。
      rt.beginPendingRestart('backup-imported')
      // config 段内存重读（防"导入后继续在设置页保存"把旧内存配置写回盘上）：
      // 导入的 config.json 是明文凭据信封，load 读路径原样透传（不带 enc:v1:
      // marker 的值不进解密）。seen/state/engine 内存不热换——重启生效，
      // needsRestart 语义不变。
      rt.store.load()
      rt.logger.info(
        `backup imported from ${basename(filePath)}; monitoring paused, restart required`
      )
      return { ok: true, needsRestart: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
