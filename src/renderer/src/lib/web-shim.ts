/**
 * 浏览器环境下的 window.api 桥(Docker / Web 部署)。
 *
 * 桌面版:preload(contextBridge)在渲染进程启动前装好 window.api。
 * 浏览器:本模块在 main.tsx 顶部 import,检测 window.api 未定义(无 preload)
 * 时安装同形状的 Web 实现——UI 代码零改动,同一构建产物双环境直跑。
 *
 * 实现映射(对端 = src/main/server/web.ts):
 * - invoke 系方法 → fetch POST /api/invoke {channel, args} → {ok, result};
 * - onStatus/onHit/onLog/onDailyReport → 单条共享 EventSource('/api/events'),
 *   按 message 里的 channel 分发给订阅者(EventSource 自带断线重连);
 * - openExternal → 服务端白名单校验通过后 window.open(桌面是 shell.openExternal);
 * - exportBackup → GET /api/backup/export 走 Blob 下载;importBackup → 隐藏
 *   file input 选包上传 POST(桌面是系统对话框)。
 *
 * 认证:服务端配了 token 时,401 会触发一次 prompt 输入并存 localStorage
 * ('fw.webToken'),此后请求带 Bearer 头、SSE 带 ?token= 查询参数。
 */
import type {
  DesktopApi,
  Disposition,
  HitFeedbackRequest,
  HitFeedbackResult,
  HitQueryOptions,
  HitQueryResult,
  MatchTestRequest,
  MatchTestResult,
  StatsResult,
  UpdateCheckStatus
} from '@shared/ipc'
import type { DailyReportInfo, EngineStatus, HitRecord, LogEntry } from '@shared/types'
import { IPC } from '@shared/ipc'

const TOKEN_STORAGE_KEY = 'fw.webToken'

function storedToken(): string {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function saveToken(token: string): void {
  try {
    if (token === '') localStorage.removeItem(TOKEN_STORAGE_KEY)
    else localStorage.setItem(TOKEN_STORAGE_KEY, token)
  } catch {
    /* 隐私模式等存储不可用:每次 401 都会再问一次,可接受 */
  }
}

/** 带认证的 fetch:401 且尚未问过本轮时 prompt 一次令牌再重试 */
async function authFetch(input: string, init?: RequestInit): Promise<Response> {
  const token = storedToken()
  const withAuth = (i?: RequestInit): RequestInit => ({
    ...i,
    headers: { ...(i?.headers as Record<string, string> | undefined), ...(token !== '' ? { authorization: `Bearer ${token}` } : {}) }
  })
  let res = await fetch(input, withAuth(init))
  if (res.status === 401) {
    const asked = window.prompt('此管理界面需要访问令牌,请输入:') ?? ''
    if (asked === '') return res
    saveToken(asked.trim())
    res = await fetch(input, withAuth(init))
  }
  return res
}

/** 单次 invoke:POST /api/invoke;网络层失败也按 {ok:false} 收敛(UI 契约:不 reject) */
async function invokeRaw(channel: string, args: unknown[]): Promise<unknown> {
  let res: Response
  try {
    res = await authFetch('/api/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel, args })
    })
  } catch (err) {
    throw new Error(`网络请求失败(服务不可达?): ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!res.ok) {
    throw new Error(`服务响应 ${res.status}`)
  }
  const envelope = (await res.json()) as { ok: boolean; result?: unknown; error?: string }
  if (!envelope.ok) throw new Error(envelope.error ?? 'invoke failed')
  return envelope.result
}

type Listener<T> = (payload: T) => void

/** 共享 EventSource:首个订阅时创建;channel → 订阅者集合 */
const subscribers = new Map<string, Set<(payload: unknown) => void>>()
let source: EventSource | null = null

function ensureEventSource(): void {
  if (source !== null) return
  const token = storedToken()
  const qs = token !== '' ? `?token=${encodeURIComponent(token)}` : ''
  source = new EventSource(`/api/events${qs}`)
  source.onmessage = (ev: MessageEvent<string>) => {
    try {
      const { channel, payload } = JSON.parse(ev.data) as { channel: string; payload: unknown }
      const set = subscribers.get(channel)
      if (set !== undefined) for (const fn of set) fn(payload)
    } catch {
      /* 坏帧丢弃 */
    }
  }
}

function subscribe<T>(channel: string, callback: Listener<T>): () => void {
  let set = subscribers.get(channel)
  if (set === undefined) {
    set = new Set()
    subscribers.set(channel, set)
  }
  const fn = callback as (payload: unknown) => void
  set.add(fn)
  ensureEventSource()
  return () => {
    set?.delete(fn)
  }
}

/** 触发浏览器下载一个 Blob(authFetch 拿响应后转存) */
function downloadBlob(res: Response, filename: string): void {
  void res.blob().then((blob) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  })
}

/** 隐藏 file input 选一个 JSON 文件并读文本(导入备份用) */
function pickJsonFile(): Promise<string | null> {
  return new Promise((resolvePick) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.onchange = () => {
      const file = input.files?.[0]
      if (file === undefined) {
        resolvePick(null)
        return
      }
      void file.text().then(resolvePick, () => resolvePick(null))
    }
    // 取消选择不触发 change;input 失焦兜底(用户点掉对话框)
    input.oncancel = () => resolvePick(null)
    document.body.appendChild(input)
    input.click()
    input.remove()
  })
}

/** 组装 Web 版 DesktopApi(形状与 preload 完全一致) */
export function createWebApi(): DesktopApi {
  const call = <T>(channel: string, ...args: unknown[]): Promise<T> =>
    invokeRaw(channel, args) as Promise<T>

  /**
   * 契约「永不 reject」的通道的兜底(IPC 注释逐条列明:matchTest/queryHits/
   * getStats/hitFeedback/checkUpdate/getUpdateStatus/dispositions*)——网络瞬断
   * (容器重启/发版)时按各自的空值形状返回,不让异常打进 UI 的 effect 链。
   * 其余通道保持 reject(用户动作驱动,UI 有错误展示路径)。
   */
  const safe = <T>(channel: string, fallback: () => T, ...args: unknown[]): Promise<T> =>
    invokeRaw(channel, args)
      .then((r) => r as T)
      .catch((err: unknown) => {
        console.warn(`[web-shim] ${channel} failed, using fallback:`, err)
        return fallback()
      })

  const zeroStats = () => ({
    total: 0,
    byDay: [],
    byMatchedBy: { literal: 0, semantic: 0, rule: 0, matchall: 0 },
    bySource: [],
    keywordHits: [],
    pushFailRate: 0
  })

  return {
    getConfig: () => call('config:get'),
    saveConfig: (config) => call('config:save', config),
    getStatus: () => call('status:get'),
    getHits: () => call('hits:get'),
    getLogs: () => call('logs:get'),
    engineControl: (command) => call('engine:control', command),
    // 服务端做了与桌面一致的白名单校验;通过后浏览器自己开新页
    openExternal: async (url) => {
      const r = await call<{ ok: boolean }>('external:open', url)
      if (r.ok) window.open(url, '_blank', 'noopener,noreferrer')
      return r
    },
    testAiProvider: () => call('ai:test'),
    getDailyReport: (dateLocal) => call('report:get', dateLocal),
    generateDailyReport: () => call('report:generate'),
    listDailyReports: () => call('report:list'),
    matchTest: (req: MatchTestRequest) =>
      safe('match:test', () => ({
        wouldPush: false,
        stages: [
          {
            stage: 'error',
            label: '网络',
            outcome: 'skip',
            detail: '请求失败:管理服务不可达,请稍后重试'
          }
        ]
      }) satisfies MatchTestResult, req),
    dispositionsRecent: () => safe('dispositions:recent', () => [] as Disposition[]),
    dispositionsDay: (dateLocal) => safe('dispositions:day', () => [] as Disposition[], dateLocal),
    queryHits: (opts: HitQueryOptions) =>
      safe('hits:query', () => ({ total: 0, items: [] }) satisfies HitQueryResult, opts),
    getStats: (days) => safe('stats:get', zeroStats satisfies () => StatsResult, days),
    hitFeedback: (req: HitFeedbackRequest) =>
      safe('hit:feedback', () => ({ ok: false, error: '网络请求失败' }) satisfies HitFeedbackResult, req),
    checkUpdate: () =>
      safe(
        'update:check',
        () =>
          ({
            state: 'error',
            current: '',
            checkedAt: new Date().toISOString(),
            error: '网络请求失败'
          }) satisfies UpdateCheckStatus
      ),
    getUpdateStatus: () =>
      safe(
        'update:status',
        () =>
          ({
            state: 'idle',
            current: '',
            checkedAt: null
          }) satisfies UpdateCheckStatus
      ),
    // 网页端备份:下载/上传(桌面版是系统对话框)
    exportBackup: async () => {
      const res = await authFetch('/api/backup/export')
      if (!res.ok) return { ok: false, error: `导出失败(HTTP ${res.status})` }
      const today = new Date().toISOString().slice(0, 10).replaceAll('-', '')
      downloadBlob(res, `forumwatch-backup-${today}.json`)
      return { ok: true, path: `forumwatch-backup-${today}.json(已下载)` }
    },
    importBackup: async () => {
      const text = await pickJsonFile()
      if (text === null) return { ok: false, error: '已取消导入' }
      let res: Response
      try {
        res = await authFetch('/api/backup/import', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: text
        })
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      if (!res.ok) return { ok: false, error: `导入失败(HTTP ${res.status})` }
      return (await res.json()) as { ok: true; needsRestart: true } | { ok: false; error: string }
    },
    onStatus: (callback: Listener<EngineStatus>) => subscribe(IPC.evStatus, callback),
    onHit: (callback: Listener<HitRecord>) => subscribe(IPC.evHit, callback),
    onLog: (callback: Listener<LogEntry>) => subscribe(IPC.evLog, callback),
    onDailyReport: (callback: Listener<DailyReportInfo>) => subscribe(IPC.evDailyReport, callback)
  }
}

/**
 * 入口副作用(main.tsx 顶部 import):浏览器环境(无 preload)安装 Web 版 api。
 * Electron 里 preload 先行装好 window.api → 本函数 no-op。
 */
export function installWebApiIfAbsent(): void {
  if (typeof window === 'undefined') return
  const w = window as { api?: DesktopApi }
  if (w.api === undefined) {
    w.api = createWebApi()
  }
}
