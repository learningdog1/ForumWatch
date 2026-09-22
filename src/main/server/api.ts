/**
 * Web 服务器的 invoke 处理器表（Docker 部署，ADR 2 无头内核风格）。
 *
 * 处理器逻辑与桌面版 src/main/desktop/ipc.ts 的 ipcMain.handle 同源同口径
 * （校验、归一化、失败收敛全部对齐——两处漂移就是 UI 行为漂移）；差异仅三处：
 * - openExternal：服务器无法开系统浏览器——只做与桌面完全一致的白名单校验
 *   （https + 来源域∪github.com），通过返回 {ok:true}，由网页 shim 自行
 *   window.open；校验在服务端做的意义是保持"放行哪些域"的单一事实源。
 * - exportBackup / importBackup 不在本表：走专用 HTTP 路由（web.ts）——
 *   网页端是文件下载/上传，没有系统对话框。
 * - 更新检查：复用零 electron 的 UpdateChecker（desktop/update-check.ts），
 *   current 版本取 package.json；Docker 部署升级走换镜像，GitHub Releases
 *   检查结果仅作版本信息展示。
 *
 * 上下文（WebApiContext）由 headless 装配（scripts/headless.ts）提供——对象
 * 集合与桌面 DesktopRuntime 一致（store/engine/aiProvider/reportService/...）。
 * saveConfig 的副作用不走本模块：headless 的 watchConfigDir 会因 store.update
 * 的原子写盘触发 diff → rebuildDerived（约 500ms 去抖后），语义与桌面
 * applyConfigSideEffects 等价（异步一拍）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '../../shared/ipc'
import type { AppConfig, DailyReportInfo, EngineStatus, HitRecord, LogEntry, Topic } from '../../shared/types'
import type { Logger } from '../logger'
import type { ConfigStore } from '../config/store'
import type { MonitorEngine } from '../monitor/engine'
import type { AiProvider } from '../ai/provider'
import type { SemanticEvaluator } from '../ai/evaluator'
import type { DailyReportService } from '../ai/daily-report'
import type { CategoryReportService } from '../ai/category-report'
import { periodFor } from '../ai/category-report'
import type { FileFeedbackStore } from '../ai/feedback'
import type { HitsStore } from '../monitor/hits-store'
import type { DispositionStore } from '../monitor/dispositions'
import type { EngineControlResult, SaveConfigResult, OpenExternalResult, AiTestResult, DailyReportListResult, HitQueryOptions, HitQueryResult, MatchTestRequest, MatchTestResult, StatsResult, HitFeedbackResult, UpdateCheckStatus, CategoryReportInfo, CategoryReportKind, CategoryReportListResult, CategoryReportGenerateResult } from '../../shared/ipc'
import { allowedExternalDomains, isHostAllowed } from '../monitor/sources/registry'
import { formatLocalDate } from '../monitor/hits-store'
import { resolveSourceMatching } from '../monitor/matching'
import { computeStats } from '../monitor/stats'
import { normalizeTitle } from '../monitor/similarity'
import { runMatchTest, type SemanticTestInput } from '../monitor/testbench'
import { UpdateChecker, UPDATE_REPO } from '../desktop/update-check'
import type { FetchLike } from '../net/http-types'
import pkg from '../../../package.json'

/** 无头装配提供的上下文（对象集合 = DesktopRuntime 的公开面，headless.ts 组装） */
export interface WebApiContext {
  dataDir: string
  logger: Logger
  store: ConfigStore
  engine: MonitorEngine
  aiProvider: AiProvider
  semanticEvaluator: SemanticEvaluator
  reportService: DailyReportService
  /** 分类阶段报告（R17）：三档查询/手动生成（与桌面 rt.categoryReportService 同源） */
  categoryReportService: CategoryReportService
  hitsStore: HitsStore
  dispositions: DispositionStore
  feedbackStore: FileFeedbackStore
  /** 备份导入后的待重启窗口：与桌面 isPendingRestart 同语义（headless 恒 false） */
  isPendingRestart(): boolean
}

/** 单个 invoke 处理器：args 为渲染层调用参数数组（无参通道为 []） */
export type InvokeHandler = (args: unknown[]) => Promise<unknown> | unknown

/** 'YYYY-MM-DD' 形状锚定（与桌面 ipc.ts 同款；日期会拼进文件读路径，防穿越） */
const DATE_SHAPE_RE = /^\d{4}-\d{2}-\d{2}$/

/** monthly 期键形状（与桌面 ipc.ts 同款；category-report:get 的期键校验） */
const MONTH_SHAPE_RE = /^\d{4}-\d{2}$/

/** 分类报告 kind 白名单（与桌面 ipc.ts 同款；渲染层传 unknown） */
const isCategoryKind = (v: unknown): v is CategoryReportKind =>
  v === 'daily' || v === 'weekly' || v === 'monthly'

/** openExternal 的静态白名单（更新检查下载页；与桌面 ipc.ts 同款合并口径） */
const STATIC_EXTERNAL_DOMAINS = ['github.com'] as const

/** matchTest 的 title 长度上限（与桌面同款） */
const MATCH_TEST_TITLE_MAX_CHARS = 500

/**
 * 全局 fetch → FetchLike 适配（与桌面 ipc.ts 的 directFetch 同款：超时转
 * AbortSignal.timeout，外部 signal 经 AbortSignal.any 合并）。
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

/**
 * 组装 invoke 处理器表（通道名 → 处理器）。与桌面 registerIpcHandlers 的
 * handler 一一对应；导出 Map 供 web.ts 的 POST /api/invoke 查表分发。
 */
export function createInvokeHandlers(ctx: WebApiContext): Map<string, InvokeHandler> {
  // 更新检查单实例（与桌面同款 15s 延迟 + 24h 轮询；进程退出随之消亡）
  const updateChecker = new UpdateChecker({
    currentVersion: pkg.version,
    repo: UPDATE_REPO,
    fetchFn: directFetch,
    log: { warn: (msg) => ctx.logger.warn(msg) }
  })
  updateChecker.start()

  /** checker outcome → IPC 契约形状（与桌面 updateStatus 同款） */
  const updateStatus = (): UpdateCheckStatus => {
    const last = updateChecker.lastOutcome()
    if (last === null) return { state: 'idle', current: pkg.version, checkedAt: null }
    const checkedAt = new Date(last.checkedAt).toISOString()
    switch (last.kind) {
      case 'available':
        return { state: 'available', current: last.current, checkedAt, latest: last.latest, downloadUrl: last.downloadUrl }
      case 'up-to-date':
        return { state: 'up-to-date', current: last.current, checkedAt, latest: last.latest }
      case 'error':
        return { state: 'error', current: last.current, checkedAt, error: last.error }
    }
  }

  /** 渲染层 unknown 载荷 → HitQueryOptions（与桌面 normalizeHitQuery 同款） */
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

  const handlers = new Map<string, InvokeHandler>([
    [IPC.getConfig, () => ctx.store.get()],

    [
      IPC.saveConfig,
      (args): SaveConfigResult => {
        try {
          const effective = ctx.store.update(args[0] as Partial<AppConfig>)
          // 副作用由 headless 的 watchConfigDir 热重载承接（见文件头注释）
          return { ok: true, config: effective }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
    ],

    [IPC.getStatus, (): EngineStatus => ctx.engine.getStatus()],
    [IPC.getHits, (): HitRecord[] => ctx.engine.getRecentHits()],
    [IPC.getLogs, (): LogEntry[] => ctx.logger.getRecent()],

    [
      IPC.engineControl,
      async (args): Promise<EngineControlResult> => {
        const cmd = args[0]
        if (cmd !== 'pause' && cmd !== 'resume' && cmd !== 'runNow' && cmd !== 'sendTest') {
          return { ok: false, error: `unknown command: ${String(cmd)}` }
        }
        try {
          switch (cmd) {
            case 'pause':
              ctx.engine.pause()
              break
            case 'resume':
              ctx.engine.resume()
              break
            case 'runNow':
              ctx.engine.runNow()
              break
            case 'sendTest':
              await ctx.engine.sendTestNotification()
              break
          }
          return { ok: true }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
    ],

    [
      IPC.openExternal,
      (args): OpenExternalResult => {
        const url = args[0]
        if (typeof url !== 'string') return { ok: false }
        let parsed: URL
        try {
          parsed = new URL(url)
        } catch {
          return { ok: false }
        }
        if (parsed.protocol !== 'https:') return { ok: false }
        const allowed = [...allowedExternalDomains(ctx.store.get()), ...STATIC_EXTERNAL_DOMAINS]
        if (!isHostAllowed(parsed.hostname, allowed)) return { ok: false }
        // 校验通过：网页端由 shim 自行 window.open（服务器无系统浏览器）
        return { ok: true }
      }
    ],

    [
      IPC.testAiProvider,
      async (): Promise<AiTestResult> => {
        try {
          await ctx.aiProvider.testConnection()
          return { ok: true }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
    ],

    [
      IPC.getDailyReport,
      async (args): Promise<DailyReportInfo> => {
        const raw = args[0]
        const date =
          typeof raw === 'string' && DATE_SHAPE_RE.test(raw) ? raw : formatLocalDate()
        return { date, markdown: await ctx.reportService.loadReport(date) }
      }
    ],

    [
      IPC.generateDailyReport,
      async (): Promise<EngineControlResult> => {
        try {
          await ctx.reportService.generate()
          return { ok: true }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
    ],

    [IPC.listDailyReports, (): DailyReportListResult => ({ dates: ctx.reportService.listReportDays() })],

    // ---- 分类阶段报告（R17，与桌面 ipc.ts 同口径） ---------------------------

    [
      IPC.getCategoryReport,
      async (args): Promise<CategoryReportInfo> => {
        const kind = isCategoryKind(args[0]) ? args[0] : 'daily'
        const shape = kind === 'monthly' ? MONTH_SHAPE_RE : DATE_SHAPE_RE
        const raw = args[1]
        const explicit = typeof raw === 'string' && shape.test(raw) ? raw : undefined
        const periods = ctx.categoryReportService.listPeriods(kind)
        const periodKey = explicit ?? periods[0] ?? periodFor(kind).periodKey
        return {
          kind,
          periodKey,
          markdown: await ctx.categoryReportService.loadReport(kind, periodKey)
        }
      }
    ],

    [
      IPC.generateCategoryReport,
      async (args): Promise<CategoryReportGenerateResult> => {
        const kind = args[0]
        if (!isCategoryKind(kind)) {
          return { ok: false, error: `unknown report kind: ${String(kind)}` }
        }
        // 期键在调用 generate 之前算好：生成耗时跨本地午夜时返回值不漂移
        // （与桌面 ipc.ts 同源同口径；与 SSE 广播的期键一致）
        const periodKey = periodFor(kind).periodKey
        try {
          const markdown = await ctx.categoryReportService.generate(kind)
          return { ok: true, periodKey, markdown }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
    ],

    [
      IPC.listCategoryReports,
      (args): CategoryReportListResult => ({
        periods: ctx.categoryReportService.listPeriods(isCategoryKind(args[0]) ? args[0] : 'daily')
      })
    ],

    [IPC.dispositionsRecent, () => ctx.dispositions.recent(200)],

    [
      IPC.dispositionsDay,
      (args) => {
        const raw = args[0]
        const date =
          typeof raw === 'string' && DATE_SHAPE_RE.test(raw) ? raw : formatLocalDate()
        return ctx.dispositions.readDay(date)
      }
    ],

    [
      IPC.queryHits,
      (args): Promise<HitQueryResult> => ctx.hitsStore.query(normalizeHitQuery(args[0]))
    ],

    [
      IPC.getStats,
      async (args): Promise<StatsResult> => {
        const days = args[0]
        const n =
          typeof days === 'number' && Number.isFinite(days)
            ? Math.min(Math.max(Math.floor(days), 1), 90)
            : 14
        const hits = await ctx.hitsStore.readRecent(n)
        const cfg = ctx.store.get()
        const includeKeywords = [
          ...cfg.includeKeywords,
          ...cfg.sources.flatMap((s) => s.matching?.includeKeywords ?? [])
        ]
        return computeStats(hits, { includeKeywords })
      }
    ],

    [
      IPC.hitFeedback,
      (args): HitFeedbackResult => {
        if (ctx.isPendingRestart()) {
          return { ok: false, error: '备份已导入待重启：反馈投票暂不可用，请重启容器' }
        }
        const o = (typeof args[0] === 'object' && args[0] !== null ? args[0] : {}) as Record<string, unknown>
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
            ctx.feedbackStore.undo(`${sourceId}:${topicId}`)
          } else {
            ctx.feedbackStore.vote(`${sourceId}:${topicId}`, title, direction)
          }
          return { ok: true }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
    ],

    // 匹配测试台（与桌面 matchTest handler 同款；语义阶段真调一次 evaluator）
    [
      IPC.matchTest,
      async (args): Promise<MatchTestResult> => {
        const raw = (typeof args[0] === 'object' && args[0] !== null ? args[0] : {}) as Partial<MatchTestRequest>
        const title = typeof raw.title === 'string' ? raw.title.trim() : ''
        if (title === '') {
          return {
            wouldPush: false,
            stages: [
              { stage: 'input', label: '输入', outcome: 'block', detail: '参数无效：需要非空 title' }
            ]
          }
        }
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

        const cfg: AppConfig = ctx.store.get()
        const m = resolveSourceMatching(cfg, sourceId ?? '')
        const filters = sourceId !== undefined
          ? cfg.sources.find((s) => s.id === sourceId)?.filters
          : undefined

        let recentPushedTitles: string[] = []
        try {
          const recent = await ctx.hitsStore.readRecent(2)
          recentPushedTitles = recent
            .filter((h) => h.notifiedAt !== null && h.notifiedAt !== '')
            .map((h) => normalizeTitle(h.topic.title))
            .filter((t) => t !== '')
        } catch {
          recentPushedTitles = []
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
            semantic = { skipped: '兴趣描述为空：语义档永不命中（未调 AI）' }
          } else {
            const topic: Topic = {
              id: 'testbench',
              sourceId: sourceId ?? 'testbench',
              title,
              url: '',
              author,
              category,
              categorySlug: category,
              pinned: false,
              lastActiveAt: null
            }
            try {
              const verdicts = await ctx.semanticEvaluator.evaluate([topic], m.interests)
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
      }
    ],

    [
      IPC.checkUpdate,
      async (): Promise<UpdateCheckStatus> => {
        await updateChecker.check()
        return updateStatus()
      }
    ],

    [IPC.getUpdateStatus, (): UpdateCheckStatus => updateStatus()]
  ])

  return handlers
}

// ---- 备份导出/导入的内核段（web.ts 的 HTTP 路由消费） ------------------------

/** userData 等价物 = headless 的数据目录；四文件名与桌面装配路径一致 */
const CONFIG_FILE = 'config.json'
const SEEN_FILE = 'seen.json'
const STATE_FILE = 'state.json'
const FEEDBACK_FILE = 'feedback.json'

export interface BackupSegments {
  config: unknown
  seen: unknown
  state: unknown
  feedback: unknown
}

/**
 * 组装备份导出的四段载荷（与桌面 exportBackup 同款：config 段走 store 内存
 * 明文——单一事实源；其余段按文件读、缺失/坏文件回默认信封）。返回 null =
 * 组装失败（handler 收口为 {ok:false}）。
 */
export function collectBackupSegments(ctx: WebApiContext): BackupSegments {
  const readSegment = (fileName: string, fallback: unknown): unknown => {
    const filePath = join(ctx.dataDir, fileName)
    try {
      if (!existsSync(filePath)) return fallback
      return JSON.parse(readFileSync(filePath, 'utf-8'))
    } catch (err) {
      ctx.logger.warn(
        `[backup] read ${fileName} failed, exporting fallback: ${err instanceof Error ? err.message : String(err)}`
      )
      return fallback
    }
  }
  return {
    config: { schemaVersion: 3, config: ctx.store.get() },
    seen: readSegment(SEEN_FILE, { schemaVersion: 2, seen: [] }),
    state: readSegment(STATE_FILE, { schemaVersion: 2, sources: {} }),
    feedback: readSegment(FEEDBACK_FILE, undefined)
  }
}

export { CONFIG_FILE, SEEN_FILE, STATE_FILE, FEEDBACK_FILE, STATIC_EXTERNAL_DOMAINS }
