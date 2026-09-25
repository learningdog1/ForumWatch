/**
 * CategoryReportService 单测（R17）：周期纯函数 periodFor（周中/周末/月初/月末/
 * 年末，本地时区口径含凌晨跨界）、生成（零帖不调 LLM / ≤60 单次 / >60 map-reduce /
 * 任一失败整体降级模板 / 附录行数==帖子数 / 置顶排除 / 分类双口径）、推送与开关
 * （shouldPush 默认四联矩阵 / 载荷不含附录 / 长文分段 / 注入 false 绝不推）、
 * tick 调度（到点/未到点/文件存在/attempts 耗尽/desiredRunning/总开关不耗 attempts/
 * 周三补做/月报跨保留窗/nextCheckAt/期键翻转清零/**单档失败不中断后续档**）、
 * 并发护栏（同档复用进行中 Promise、不同档互不阻塞）、体量上限（超 MAX_MAP_CHUNKS
 * 不调 LLM 直接降级、头注与覆盖率注明体量）、来源过滤（sourceIds 空 = 不过滤全部
 * 来源；coveredDays 按配置来源传参）、loadReport/listPeriods。
 *
 * 全 mock：provider/archive/notifier 注入，假时钟经 now 参传入，临时目录落文件。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  CategoryReportService,
  MAX_AUTO_ATTEMPTS_PER_PERIOD,
  MAX_MAP_CHUNKS,
  chunkByTokenBudget,
  estimateTokens,
  periodFor,
  REPORT_INPUT_TOKEN_BUDGET,
  type CategoryReportDeps,
  type CategoryReportKind
} from './category-report'
import { splitForTelegram } from './daily-report'
import { REPORT_CHUNK_MAX, HTML_SAFE_MAX } from '../notify/markdown-report'
import { DEFAULT_APP_CONFIG, type AppConfig, type TopicRecord } from '../../shared/types'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rss-monitor-catreport-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

// ---- fixtures ---------------------------------------------------------------

function makeConfig(overrides: {
  ai?: Partial<AppConfig['ai']>
  categoryReport?: Partial<AppConfig['ai']['categoryReport']>
  notifyEnabled?: boolean
  channels?: AppConfig['channels']
} = {}): AppConfig {
  return {
    ...structuredClone(DEFAULT_APP_CONFIG),
    channels: [{ id: 'telegram', type: 'telegram', enabled: true, botToken: 'T', chatId: 'C' }],
    notifyEnabled: true,
    ...(overrides.notifyEnabled !== undefined ? { notifyEnabled: overrides.notifyEnabled } : {}),
    ...(overrides.channels !== undefined ? { channels: overrides.channels } : {}),
    ai: {
      ...structuredClone(DEFAULT_APP_CONFIG.ai),
      provider: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk', model: 'm' },
      ...structuredClone(overrides.ai ?? {}),
      categoryReport: {
        ...structuredClone(DEFAULT_APP_CONFIG.ai.categoryReport),
        enabled: true,
        daily: { enabled: true, timeHHMM: '22:30' },
        weekly: { enabled: true, timeHHMM: '08:00' },
        monthly: { enabled: true, timeHHMM: '08:30' },
        ...structuredClone(overrides.categoryReport ?? {})
      }
    }
  }
}

/** 只开某一档（tick 单档测试用：其余档关闭，防别档到点污染断言） */
function onlyKind(kind: CategoryReportKind): AppConfig['ai']['categoryReport'] {
  return {
    ...structuredClone(DEFAULT_APP_CONFIG.ai.categoryReport),
    enabled: true,
    daily: { enabled: kind === 'daily', timeHHMM: '22:30' },
    weekly: { enabled: kind === 'weekly', timeHHMM: '08:00' },
    monthly: { enabled: kind === 'monthly', timeHHMM: '08:30' }
  }
}

function rec(id: string, overrides: Partial<TopicRecord> = {}): TopicRecord {
  return {
    key: `nodeseek:${id}`,
    sourceId: 'nodeseek',
    topicId: id,
    title: `title-${id}`,
    url: `https://example.com/post-${id}-1`,
    author: 'alice',
    category: '交易',
    categorySlug: 'trade',
    pinned: false,
    lastActiveAt: null,
    firstSeenAt: '2026-09-18T10:00:00',
    ...overrides
  }
}

/**
 * 大标题记录：单帖载荷估算 ~45k token（150k ASCII × 0.3），两帖 + 段开销即超
 * 90k 预算 → 各自成段（token 预算分段测试的「大载荷」制造器）。
 */
const BIG_TITLE = 'x'.repeat(150_000)
function bigRec(id: string): TopicRecord {
  return rec(id, { title: BIG_TITLE })
}

describe('token 预算分段（R19b 纯函数）', () => {
  it('estimateTokens：CJK ×1.2 + 其余 ×0.3，向上取整', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('aaaa')).toBe(2) // 4 × 0.3 = 1.2 → 2
    expect(estimateTokens('中文字')).toBe(4) // 3 × 1.2 = 3.6 → 4
    expect(estimateTokens('中文a')).toBe(3) // 2×1.2 + 1×0.3 = 2.7 → 3
  })

  it('chunkByTokenBudget：预算内单段；超预算贪心切（顺序保持）；空数组 → []', () => {
    expect(chunkByTokenBudget([])).toEqual([])
    // 100 小帖 ~3k token：单段（旧逻辑按 60 帖固定切两段）
    const small = Array.from({ length: 100 }, (_, i) => rec(String(i)))
    expect(chunkByTokenBudget(small)).toHaveLength(1)
    // 两大帖各 ~45k：两帖 + 8k 开销 = 98k > 90k → 两段
    const chunks = chunkByTokenBudget([bigRec('a'), bigRec('b')])
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toHaveLength(1)
    // 贪心：大帖 a + 小帖（~30 token）同段装得下 → [2, 1]
    const mixed = chunkByTokenBudget([bigRec('a'), rec('1'), bigRec('b')])
    expect(mixed.map((c) => c.length)).toEqual([2, 1])
  })
})

interface TestHarness {
  svc: CategoryReportService
  chat: Mock
  readRange: Mock
  coveredDays: Mock
  sendRaw: Mock
  onGenerated: Mock
  cfgRef: { current: AppConfig }
}

function build(opts: { records?: TopicRecord[]; covered?: string[]; cfg?: AppConfig; shouldPush?: () => boolean } = {}): TestHarness {
  const chat = vi.fn(async () => 'AI 总结内容')
  const readRange = vi.fn(async () => opts.records ?? [])
  const coveredDays = vi.fn(async () => opts.covered ?? [])
  const sendRaw = vi.fn(async (_text: string) => {})
  const onGenerated = vi.fn()
  const cfgRef = { current: opts.cfg ?? makeConfig() }
  const deps: CategoryReportDeps = {
    provider: { chat },
    archive: { readRange, coveredDays },
    notifier: { sendRaw },
    getConfig: () => cfgRef.current,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    reportsDir: join(dir, 'reports', 'category'),
    onGenerated,
    ...(opts.shouldPush !== undefined ? { shouldPush: opts.shouldPush } : {})
  }
  return { svc: new CategoryReportService(deps), chat, readRange, coveredDays, sendRaw, onGenerated, cfgRef }
}

/** 附录条目行（`- HH:MM [分类] 标题（作者） url`）计数 */
function appendixLineCount(markdown: string): number {
  return markdown.split('\n').filter((l) => /^- \d{2}:\d{2} \[/.test(l)).length
}

// ---- 周期纯函数 periodFor ----------------------------------------------------

describe('periodFor（本地时区 Date 算术，无 ISO slice）', () => {
  it('daily：今天（本地日凌晨 0:30 也不漂到前一天）', () => {
    // 东八区下 ISO slice 在 00:30 会给出前一天——本地构造 + formatLocalDate 不会
    const now = new Date(2026, 8, 18, 0, 30, 0, 0)
    expect(periodFor('daily', now)).toEqual({
      kind: 'daily',
      periodKey: '2026-09-18',
      from: '2026-09-18',
      to: '2026-09-18',
      label: '2026-09-18'
    })
  })

  it('weekly：周中（周三）指向刚结束的完整周（周一~周日，key=周日）', () => {
    // 2026-09-16 是周三；刚结束的周 = 09-07(一) ~ 09-13(日)
    const now = new Date(2026, 8, 16, 12, 0, 0, 0)
    const p = periodFor('weekly', now)
    expect(p.periodKey).toBe('2026-09-13')
    expect(p.from).toBe('2026-09-07')
    expect(p.to).toBe('2026-09-13')
    expect(p.label).toBe('09-07 ~ 09-13')
  })

  it('weekly：周日 23:59 归属再上一周（本周未结束）；周一 0:30 翻转到刚结束的那周', () => {
    // 2026-09-20 是周日：本周（09-14~09-20）尚未结束 → 期 = 09-07~09-13
    const sunday = periodFor('weekly', new Date(2026, 8, 20, 23, 59, 0, 0))
    expect(sunday.periodKey).toBe('2026-09-13')
    // 2026-09-21 是周一 00:30：期翻转为 09-14~09-20
    const monday = periodFor('weekly', new Date(2026, 8, 21, 0, 30, 0, 0))
    expect(monday.periodKey).toBe('2026-09-20')
    expect(monday.from).toBe('2026-09-14')
    expect(monday.label).toBe('09-14 ~ 09-20')
  })

  it('monthly：月中指上一自然月（含 31 天月与 28 天月）；月末日期正确', () => {
    // 2026-09-21 → 2026-08（31 天）
    const p = periodFor('monthly', new Date(2026, 8, 21, 9, 0, 0, 0))
    expect(p).toEqual({
      kind: 'monthly',
      periodKey: '2026-08',
      from: '2026-08-01',
      to: '2026-08-31',
      label: '2026-08'
    })
    // 2026-03-15 → 2026-02（28 天，2026 非闰年）
    const feb = periodFor('monthly', new Date(2026, 2, 15, 9, 0, 0, 0))
    expect(feb.from).toBe('2026-02-01')
    expect(feb.to).toBe('2026-02-28')
  })

  it('monthly：月末（31 日深夜）与月初（1 日 0:30）都指上一月；年末 12→1 回绕', () => {
    // 月末深夜不漂移
    const monthEnd = periodFor('monthly', new Date(2026, 8, 30, 23, 30, 0, 0))
    expect(monthEnd.periodKey).toBe('2026-08')
    // 年末回绕：2026-01-01 → 2025-12
    const newYear = periodFor('monthly', new Date(2026, 0, 1, 0, 30, 0, 0))
    expect(newYear.periodKey).toBe('2025-12')
    expect(newYear.from).toBe('2025-12-01')
    expect(newYear.to).toBe('2025-12-31')
  })

  it('monthly：闰年 2 月（2024-03 → 02-29）', () => {
    const p = periodFor('monthly', new Date(2024, 2, 10, 9, 0, 0, 0))
    expect(p.to).toBe('2024-02-29')
  })
})

// ---- 生成 -------------------------------------------------------------------

describe('生成（LLM 分档与降级）', () => {
  it('零帖：不调 LLM，固定文案报告，文件照写、推送照走', async () => {
    const h = build({ records: [], covered: ['2026-09-18'] })
    const md = await h.svc.generate('daily', new Date(2026, 8, 18, 23, 0, 0, 0))
    expect(h.chat).not.toHaveBeenCalled()
    expect(md).toContain('# 📰 分类行情报告 · 2026-09-18')
    expect(md).toContain('本期分类内无帖子')
    expect(md).toContain('AI 总结：未调用（本期无帖子）')
    expect(md).not.toContain('## 附录·全量帖子清单')
    expect((await readFile(join(dir, 'reports', 'category', 'daily-2026-09-18.md'), 'utf-8'))).toBe(md)
    expect(h.sendRaw).toHaveBeenCalled() // 默认四联全开 → 心跳推送
    expect(h.onGenerated).toHaveBeenCalledWith({
      kind: 'daily',
      periodKey: '2026-09-18',
      markdown: md
    })
  })

  it('小体量（token 预算内）：单次 LLM 直出；载荷带元数据（title/category/author/deal）与 url/摘要', async () => {
    const records = [
      rec('1', { title: '年付 ¥99 512M VPS' }),
      rec('2', { title: '机器测评', category: '测评', categorySlug: 'review', excerpt: 'x'.repeat(160) })
    ]
    const h = build({ records, covered: ['2026-09-18'] })
    const md = await h.svc.generate('daily', new Date(2026, 8, 18, 23, 0, 0, 0))
    expect(h.chat).toHaveBeenCalledTimes(1)
    // R19：直出模式（disableThinking——思考型模型思考吃光 max_tokens 致空串，
    // 曾是「报告没带 AI 总结」静默降级的根因）
    expect(h.chat.mock.calls[0]![0].disableThinking).toBe(true)
    expect(h.chat.mock.calls[0]![0].maxTokens).toBe(4000)
    // prompt 为五段简报结构（emoji 小节标题）
    expect(h.chat.mock.calls[0]![0].system).toContain('## 🧠 总评')
    expect(h.chat.mock.calls[0]![0].system).toContain('## 💰 行情解读')
    expect(h.chat.mock.calls[0]![0].system).toContain('## 🔮 展望')
    const payload = JSON.parse(h.chat.mock.calls[0]![0].user as string)
    expect(payload.total).toBe(2)
    expect(payload.topics[0]).toMatchObject({ title: '年付 ¥99 512M VPS', category: '交易' })
    expect(payload.topics[0].deal).toEqual({ cycle: 'yearly', price: { amount: 99, currency: 'CNY' }, trafficGB: 0.5 })
    // R19：载荷带确定性统计（行情解读的数据依据）
    expect(payload.stats.categoryTotals).toEqual([{ category: '交易', count: 1 }, { category: '测评', count: 1 }])
    expect(payload.stats.dealGroups[0]).toMatchObject({ group: 'yearly×CNY', samples: 1, median: 99 })
    // R19b：载荷带 url（热点可附真实链接）与摘要（超 120 字截断）
    expect(payload.topics[0].url).toBe('https://example.com/post-1-1')
    expect(payload.topics[1].excerpt).toBe('x'.repeat(119) + '…')
    expect(md).toContain('AI 总结内容')
    expect(md).not.toContain('模板模式')
    // 附录行数 == 过滤后帖子数（防漏断言）
    expect(appendixLineCount(md)).toBe(2)
  })

  it('超 token 预算：贪心切段逐段 map + reduce（两大帖 → 2 段小结 + 1 汇总）；超时随载荷放大', async () => {
    const records = [bigRec('a'), bigRec('b')]
    const h = build({ records, covered: ['2026-09-18'] })
    const md = await h.svc.generate('daily', new Date(2026, 8, 18, 23, 0, 0, 0))
    expect(h.chat).toHaveBeenCalledTimes(3)
    // 前两次 = 段小结（各 1 帖），第三次 = reduce（segments 数组）
    const first = JSON.parse(h.chat.mock.calls[0]![0].user as string)
    const second = JSON.parse(h.chat.mock.calls[1]![0].user as string)
    const reduce = JSON.parse(h.chat.mock.calls[2]![0].user as string)
    expect(first.total).toBe(1)
    expect(second.total).toBe(1)
    expect(reduce.segments).toHaveLength(2)
    // 段载荷不变量：每段估算 ≤ 预算（单帖自身超预算的段除外——此处两段都是单帖大载荷）
    expect(estimateTokens(h.chat.mock.calls[0]![0].user as string)).toBeLessThanOrEqual(
      REPORT_INPUT_TOKEN_BUDGET
    )
    // 动态超时：~45k token 载荷 → 60s 底数 + ~45s，落在 (60s, 180s]
    const timeout = h.chat.mock.calls[0]![0].timeoutMs as number
    expect(timeout).toBeGreaterThan(60_000)
    expect(timeout).toBeLessThanOrEqual(180_000)
    expect(md).toContain('AI 总结内容')
    expect(appendixLineCount(md)).toBe(2)
    expect(md).toContain(`分段 ${3} 段全部成功`)
  })

  it('预算内大体量单次直出：100 小帖一次调用（不再按 60 帖固定切段）', async () => {
    const records = Array.from({ length: 100 }, (_, i) =>
      rec(String(i), { firstSeenAt: `2026-09-18T${String(8 + (i % 12)).padStart(2, '0')}:30:00` })
    )
    const h = build({ records, covered: ['2026-09-18'] })
    const md = await h.svc.generate('daily', new Date(2026, 8, 18, 23, 0, 0, 0))
    expect(h.chat).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(h.chat.mock.calls[0]![0].user as string)
    expect(payload.total).toBe(100)
    expect(md).toContain('AI 总结内容')
    expect(appendixLineCount(md)).toBe(100)
  })

  it('任一 map 段失败 → 整体降级模板（统计表 + 全量附录 + 头注），绝不拼半成品', async () => {
    const records = [bigRec('a'), bigRec('b'), bigRec('c')] // 3 段，第 2 段失败
    let call = 0
    const chat = vi.fn(async () => {
      call++
      if (call === 2) throw new Error('segment 2 down') // 第二段小结失败
      return `段小结 ${call}`
    })
    const h = build({ records, covered: ['2026-09-18'] })
    h.chat.mockImplementation(chat)
    const md = await h.svc.generate('daily', new Date(2026, 8, 18, 23, 0, 0, 0))
    expect(md).toContain('模板模式（AI 不可用）')
    expect(md).not.toContain('段小结') // 半成品不出现
    expect(md).toContain('## 📊 帖量分布')
    expect(md).toContain('## 附录·全量帖子清单')
    expect(appendixLineCount(md)).toBe(3)
    expect(md).toContain('AI 不可用·模板模式')
  })

  it('reduce 失败 → 同降级；段小结返回空串 → 同降级', async () => {
    const records = [bigRec('a'), bigRec('b')] // 2 段：第 1、2 次段小结，第 3 次 reduce
    // reduce（第 3 次调用）失败
    const h1 = build({ records, covered: ['2026-09-18'] })
    let c1 = 0
    h1.chat.mockImplementation(async () => {
      c1++
      return c1 === 3 ? Promise.reject(new Error('reduce down')) : `s${c1}`
    })
    const md1 = await h1.svc.generate('daily', new Date(2026, 8, 18, 23, 0, 0, 0))
    expect(md1).toContain('模板模式（AI 不可用）')
    // 段小结空串
    const h2 = build({ records, covered: ['2026-09-18'] })
    let c2 = 0
    h2.chat.mockImplementation(async () => {
      c2++
      return c2 === 1 ? '' : 'ok'
    })
    const md2 = await h2.svc.generate('daily', new Date(2026, 8, 18, 23, 0, 0, 0))
    expect(md2).toContain('模板模式（AI 不可用）')
  })

  it('单次直出空串 → 降级；LLM 抛错 → 降级', async () => {
    const h1 = build({ records: [rec('1')], covered: ['2026-09-18'] })
    h1.chat.mockResolvedValue('')
    const md1 = await h1.svc.generate('daily', new Date(2026, 8, 18, 23, 0, 0, 0))
    expect(md1).toContain('模板模式（AI 不可用）')
    const h2 = build({ records: [rec('1')], covered: ['2026-09-18'] })
    h2.chat.mockRejectedValue(new Error('provider boom'))
    const md2 = await h2.svc.generate('daily', new Date(2026, 8, 18, 23, 0, 0, 0))
    expect(md2).toContain('模板模式（AI 不可用）')
  })

  it('provider 三项不齐（未配置）→ 同降级，零 LLM 调用', async () => {
    const h = build({
      records: [rec('1')],
      covered: ['2026-09-18'],
      cfg: makeConfig({ ai: { provider: { baseUrl: '', apiKey: '', model: '' } } })
    })
    const md = await h.svc.generate('daily', new Date(2026, 8, 18, 23, 0, 0, 0))
    expect(h.chat).not.toHaveBeenCalled()
    expect(md).toContain('模板模式（AI 不可用）')
  })

  it('置顶帖被排除并在覆盖率注明；分类匹配 display 名与 slug 双口径', async () => {
    const records = [
      rec('1', { category: '交易', categorySlug: 'trade' }),
      rec('2', { category: '', categorySlug: 'deal' }), // slug 命中（display 名空）
      rec('3', { category: '闲聊', categorySlug: 'chat' }), // 分类不匹配 → 排除
      rec('4', { pinned: true }), // 置顶 → 排除并注明
      rec('5', { sourceId: 'v2ex' }) // 来源不在 sourceIds → 排除
    ]
    const h = build({
      records,
      covered: ['2026-09-18'],
      cfg: makeConfig({ categoryReport: { categories: ['交易', 'deal'] } })
    })
    const md = await h.svc.generate('daily', new Date(2026, 8, 18, 23, 0, 0, 0))
    expect(appendixLineCount(md)).toBe(2) // rec1 + rec2
    expect(md).toContain('置顶帖 1 条已排除')
    expect(md).toContain('分类内帖子 2 条已全部列入附录')
  })

  it('appendix=false：文件无附录、覆盖率注明附录已关闭；推送载荷同样无附录', async () => {
    const h = build({
      records: [rec('1')],
      covered: ['2026-09-18'],
      cfg: makeConfig({ categoryReport: { appendix: false } })
    })
    const md = await h.svc.generate('daily', new Date(2026, 8, 18, 23, 0, 0, 0))
    expect(md).not.toContain('## 附录·全量帖子清单')
    expect(md).toContain('附录已关闭')
    expect(h.sendRaw).toHaveBeenCalledTimes(1)
    // 推送载荷无附录正文（覆盖率行的「附录已关闭」说明保留是预期行为）
    const pushed = String(h.sendRaw.mock.calls[0]![0])
    expect(pushed).not.toContain('## 附录·全量帖子清单')
    expect(pushed).toContain('附录已关闭')
  })

  it('覆盖率：D/T 天如实呈现；D<T 头注「存档不足」；D=T 无头注', async () => {
    const short = build({ records: [rec('1')], covered: ['2026-09-02', '2026-09-05'] })
    const now = new Date(2026, 8, 21, 9, 0, 0, 0) // monthly → 2026-08（31 天）
    const mdShort = await short.svc.generate('monthly', now)
    expect(mdShort).toContain('存档 2/31 天有数据')
    expect(mdShort).toContain('存档不足')
    expect(mdShort).toContain('# 📰 分类行情报告 · 2026-08')

    const full = build({ records: [rec('1')], covered: allDays('2026-08-01', '2026-08-31') })
    const mdFull = await full.svc.generate('monthly', now)
    expect(mdFull).toContain('存档 31/31 天有数据')
    expect(mdFull).not.toContain('存档不足')
  })

  it('行情零样本：如实写「未解析出结构化价格」；有样本时按分组出分位表', async () => {
    const none = build({ records: [rec('1', { title: '纯讨论' })], covered: ['2026-09-18'] })
    const mdNone = await none.svc.generate('daily', new Date(2026, 8, 18, 23, 0, 0, 0))
    expect(mdNone).toContain('本期未解析出结构化价格')
    const some = build({
      records: [rec('1', { title: '年付 ¥100' }), rec('2', { title: '年付 ¥300' })],
      covered: ['2026-09-18']
    })
    const mdSome = await some.svc.generate('daily', new Date(2026, 8, 18, 23, 0, 0, 0))
    expect(mdSome).toContain('yearly×CNY')
    // 样本 [100,300]：P25=150（线性插值）/ 中位 200 / P75=250
    expect(mdSome).toContain('| 2 | 100 | 150 | 200 | 250 | 300 |')
  })

  it(`体量上限：预算分段 > ${MAX_MAP_CHUNKS} 段不调 provider、直接降级确定性报告并注明体量`, async () => {
    // 每帖 ~45k token → 各自成段；31 帖 = 31 段 > 上限 30
    const records = Array.from({ length: MAX_MAP_CHUNKS + 1 }, (_, i) => bigRec(String(i)))
    const h = build({ records, covered: ['2026-09-18'] })
    const md = await h.svc.generate('daily', new Date(2026, 8, 18, 23, 0, 0, 0))
    expect(h.chat).not.toHaveBeenCalled() // 体量降级不碰 LLM
    expect(md).toContain('模板模式（体量过大）')
    expect(md).toContain(`分类内帖子 ${records.length} 条超出 AI 总结分段上限`)
    expect(md).toContain('因体量超出分段上限·模板模式')
    expect(md).not.toContain('AI 不可用·模板模式') // 与 provider 不可用的降级文案区分
    expect(md).toContain('## 附录·全量帖子清单')
    expect(appendixLineCount(md)).toBe(records.length) // 全量附录防漏：报告仍完整生成
  })

  it(`体量上限边界：恰 ${MAX_MAP_CHUNKS} 段仍走 map-reduce（不降级）`, async () => {
    const records = Array.from({ length: MAX_MAP_CHUNKS }, (_, i) => bigRec(String(i)))
    const h = build({ records, covered: ['2026-09-18'] })
    const md = await h.svc.generate('daily', new Date(2026, 8, 18, 23, 0, 0, 0))
    expect(h.chat).toHaveBeenCalledTimes(MAX_MAP_CHUNKS + 1) // 30 段小结 + 1 reduce
    expect(md).not.toContain('模板模式')
    expect(md).toContain(`分段 ${MAX_MAP_CHUNKS + 1} 段全部成功`)
  })

  it('sourceIds 空 = 不按来源过滤（全部来源；sanitize 不再回退 nodeseek 的查询侧对齐）', async () => {
    const records = [
      rec('1', { sourceId: 'v2ex', key: 'v2ex:1' }),
      rec('2', { sourceId: 'my-rss', key: 'my-rss:2' }),
      rec('3') // nodeseek
    ]
    const h = build({
      records,
      covered: ['2026-09-18'],
      cfg: makeConfig({ categoryReport: { sourceIds: [] } })
    })
    const md = await h.svc.generate('daily', new Date(2026, 8, 18, 23, 0, 0, 0))
    expect(appendixLineCount(md)).toBe(3) // 全部来源的帖都在（不再被悬挂的 nodeseek 滤成 0）
    expect(md).toContain('分类内帖子 3 条')
    // 覆盖率查询同口径：空 = 不过滤（传空数组，store 侧按全部来源计）
    expect(h.coveredDays).toHaveBeenCalledWith('2026-09-18', '2026-09-18', [])
  })

  it('coveredDays 按配置来源传参（覆盖率 D 的口径与帖子过滤对齐）', async () => {
    const h = build({ records: [rec('1')], covered: ['2026-09-18'] })
    await h.svc.generate('daily', new Date(2026, 8, 18, 23, 0, 0, 0))
    expect(h.coveredDays).toHaveBeenCalledWith('2026-09-18', '2026-09-18', ['nodeseek'])
  })

  it('记录带 day 字段时附录/载荷的归属日优先用它（写入时本地日，改时区不漂移）', async () => {
    // firstSeenAt 是 UTC 时刻：本地时区（东八区）重算会落到 09-19，day 字段固化为 09-18
    const h = build({
      records: [rec('1', { firstSeenAt: '2026-09-18T20:00:00.000Z', day: '2026-09-18' })],
      covered: ['2026-09-18']
    })
    const md = await h.svc.generate('daily', new Date(2026, 8, 18, 23, 0, 0, 0))
    expect(md).toContain('### 2026-09-18')
    const payload = JSON.parse(h.chat.mock.calls[0]![0].user as string)
    expect(payload.topics[0].date).toBe('2026-09-18')
  })
})

// ---- 并发护栏 -----------------------------------------------------------------

describe('并发护栏（同档互斥复用进行中 Promise；不同档互不阻塞）', () => {
  it('同档并发两次 generate：复用同一进行中 Promise——底层只生成一次（LLM/文件/推送各一次），双方拿同一结果', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = build({ records: [rec('1')], covered: ['2026-09-18'] })
    h.chat.mockImplementation(async () => {
      await gate // 挂住唯一一次生成，制造并发窗口
      return 'AI 总结内容'
    })
    const now = new Date(2026, 8, 18, 23, 0, 0, 0)
    const p1 = h.svc.generate('daily', now)
    const p2 = h.svc.generate('daily', now) // 手动「立即生成」与定时 tick 撞同档
    release()
    const [md1, md2] = await Promise.all([p1, p2])
    expect(md1).toBe(md2)
    expect(h.chat).toHaveBeenCalledTimes(1)
    expect(h.onGenerated).toHaveBeenCalledTimes(1)
    expect(h.sendRaw).toHaveBeenCalledTimes(1)
    expect((await readFile(join(dir, 'reports', 'category', 'daily-2026-09-18.md'), 'utf-8'))).toBe(md1)
    // settle 后互斥出队：再调重新起一次完整生成（手动覆盖重生成语义不变）
    await h.svc.generate('daily', now)
    expect(h.chat).toHaveBeenCalledTimes(2)
  })

  it('不同档互不阻塞：daily 的存档读挂起时 weekly 照常完成', async () => {
    let releaseDaily!: () => void
    const dailyGate = new Promise<void>((resolve) => {
      releaseDaily = resolve
    })
    const chat = vi.fn(async () => 'AI 总结内容')
    const readRange = vi.fn(async (from: string, to: string) => {
      if (from === to) await dailyGate // daily 的区间（当天）挂起
      return [rec('1')]
    })
    const cfgRef = { current: makeConfig() }
    const svc = new CategoryReportService({
      provider: { chat },
      archive: { readRange, coveredDays: vi.fn(async () => ['2026-09-18']) },
      notifier: { sendRaw: vi.fn(async () => {}) },
      getConfig: () => cfgRef.current,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      reportsDir: join(dir, 'reports', 'category')
    })
    const now = new Date(2026, 8, 18, 23, 0, 0, 0)
    const pDaily = svc.generate('daily', now)
    const mdWeekly = await svc.generate('weekly', now) // 不等 daily
    expect(mdWeekly).toContain('# 📰 分类行情报告 · 09-07 ~ 09-13')
    releaseDaily()
    await expect(pDaily).resolves.toContain('# 📰 分类行情报告 · 2026-09-18')
  })
})

// ---- 推送与开关 --------------------------------------------------------------

describe('推送与开关', () => {
  it('shouldPush 默认按配置四联：enabled × 档位 × notifyEnabled × anyChannelReady', async () => {
    const now = new Date(2026, 8, 18, 23, 0, 0, 0)
    const cases: Array<{ name: string; cfg: AppConfig; pushed: boolean }> = [
      { name: '全开', cfg: makeConfig(), pushed: true },
      {
        name: '总开关关',
        cfg: makeConfig({ categoryReport: { enabled: false } }),
        pushed: false
      },
      {
        name: '档位关',
        cfg: makeConfig({ categoryReport: { daily: { enabled: false, timeHHMM: '22:30' } } }),
        pushed: false
      },
      { name: 'notifyEnabled 关', cfg: makeConfig({ notifyEnabled: false }), pushed: false },
      {
        name: '无就绪通道',
        cfg: makeConfig({ channels: [{ id: 'telegram', type: 'telegram', enabled: true, botToken: '', chatId: '' }] }),
        pushed: false
      }
    ]
    for (const c of cases) {
      const h = build({ records: [rec('1')], covered: ['2026-09-18'], cfg: c.cfg })
      h.sendRaw.mockClear()
      await h.svc.generate('daily', now)
      expect(h.sendRaw.mock.calls.length > 0, c.name).toBe(c.pushed)
    }
  })

  it('推送载荷不含附录（正文=总述~覆盖率）；长正文分段且每段双形态（R19 纯文本 + HTML opts）', async () => {
    const chat = vi.fn(async () => '## 🧠 总评\nAI 总结内容\n' + '很长的总结段落。'.repeat(600)) // >3000 字
    const h = build({ records: Array.from({ length: 100 }, (_, i) => rec(String(i))), covered: ['2026-09-18'] })
    h.chat.mockImplementation(chat)
    await h.svc.generate('daily', new Date(2026, 8, 18, 23, 0, 0, 0))
    // 100 帖预算内单次直出；LLM 返回超长文本 → 正文多段推送
    expect(h.sendRaw.mock.calls.length).toBeGreaterThan(1)
    h.sendRaw.mock.calls.forEach((call, i) => {
      const text = String(call[0])
      expect(text).not.toContain('附录·全量帖子清单')
      // 纯文本段已剥 markdown 记号（## 标题不再裸奔）
      expect(text).not.toContain('## 🧠')
      // opts.html：Telegram HTML 渲染（标题加粗），且不超 Telegram 4096 上限
      const html = (call[1] as { html?: string }).html
      expect(typeof html).toBe('string')
      expect(html!.length).toBeGreaterThan(0)
      expect(html!.length).toBeLessThanOrEqual(HTML_SAFE_MAX)
      if (i === 0) {
        expect(text).toContain('🧠 总评')
        expect(html).toContain('<b>🧠 总评</b>')
      }
    })
    const body = h.sendRaw.mock.calls.map((c) => String(c[0])).join('\n')
    expect(body).toContain('AI 总结内容')
    expect(splitForTelegram(body, REPORT_CHUNK_MAX).length).toBeGreaterThanOrEqual(1)
  })

  it('推送失败只 log error 不影响生成（文件照写、返回值正常）', async () => {
    const h = build({ records: [rec('1')], covered: ['2026-09-18'] })
    h.sendRaw.mockRejectedValue(new Error('tg down'))
    const md = await h.svc.generate('daily', new Date(2026, 8, 18, 23, 0, 0, 0))
    expect(md).toContain('# 📰 分类行情报告 · 2026-09-18')
    expect(await h.svc.loadReport('daily', '2026-09-18')).toBe(md)
  })

  it('shouldPush 注入 () => false：配置全开也绝不调 notifier（样例脚本安全性锚点）', async () => {
    const h = build({
      records: [rec('1')],
      covered: ['2026-09-18'],
      cfg: makeConfig(), // 全开
      shouldPush: () => false
    })
    await h.svc.generate('daily', new Date(2026, 8, 18, 23, 0, 0, 0))
    expect(h.sendRaw).not.toHaveBeenCalled()
    expect(h.chat).toHaveBeenCalled() // 生成本身不受影响
  })
})

// ---- tick 调度 ---------------------------------------------------------------

describe('tick 调度', () => {
  it('daily：到点触发生成；未到点不触发；文件已存在不重复生成', async () => {
    const h = build({
      records: [rec('1')],
      covered: ['2026-09-18'],
      cfg: makeConfig({ categoryReport: onlyKind('daily') })
    })
    // 22:29 未到点（timeHHMM '22:30'）
    expect(await h.svc.tick(true, new Date(2026, 8, 18, 22, 29, 0, 0))).toBe(false)
    expect(h.chat).not.toHaveBeenCalled()
    // 22:30 到点
    expect(await h.svc.tick(true, new Date(2026, 8, 18, 22, 30, 0, 0))).toBe(true)
    expect(h.chat).toHaveBeenCalledTimes(1)
    // 文件已存在 → 不再生成
    expect(await h.svc.tick(true, new Date(2026, 8, 18, 23, 0, 0, 0))).toBe(false)
    expect(h.chat).toHaveBeenCalledTimes(1)
  })

  it('desiredRunning=false：到点也不生成、不消耗 attempts（补跑时仍可生成）', async () => {
    const h = build({
      records: [rec('1')],
      covered: ['2026-09-18'],
      cfg: makeConfig({ categoryReport: onlyKind('daily') })
    })
    expect(await h.svc.tick(false, new Date(2026, 8, 18, 23, 0, 0, 0))).toBe(false)
    expect(h.chat).not.toHaveBeenCalled()
    expect(await h.svc.tick(true, new Date(2026, 8, 18, 23, 30, 0, 0))).toBe(true)
  })

  it('总开关关闭：到点不生成且不消耗 attempts（连打 5 次后开闸仍可生成）', async () => {
    const onlyDaily = onlyKind('daily')
    const h = build({
      records: [rec('1')],
      covered: ['2026-09-18'],
      cfg: makeConfig({ categoryReport: { ...onlyDaily, enabled: false } })
    })
    for (let i = 0; i < 5; i++) {
      expect(await h.svc.tick(true, new Date(2026, 8, 18, 23, 0, 0, 0))).toBe(false)
    }
    expect(h.chat).not.toHaveBeenCalled()
    h.cfgRef.current = makeConfig({ categoryReport: onlyDaily }) // 开闸
    expect(await h.svc.tick(true, new Date(2026, 8, 18, 23, 30, 0, 0))).toBe(true)
  })

  it('attempts 3 次耗尽后放弃；期键翻转（次日）清零重新可生成；generate 失败由 tick 消化不上抛', async () => {
    // 让 generate 必败：reportsDir 指向一个「文件之下」的非法路径（mkdir ENOTDIR）
    const blocker = join(dir, 'blocker')
    await writeFile(blocker, 'x', 'utf-8')
    const chat = vi.fn(async () => 'AI 总结')
    const readRange = vi.fn(async () => [rec('1')])
    const coveredDays = vi.fn(async () => ['2026-09-18'])
    const sendRaw = vi.fn(async () => {})
    const logError = vi.fn()
    const cfgRef = { current: makeConfig() }
    const svc = new CategoryReportService({
      provider: { chat },
      archive: { readRange, coveredDays },
      notifier: { sendRaw },
      getConfig: () => cfgRef.current,
      logger: { info: vi.fn(), warn: vi.fn(), error: logError },
      reportsDir: join(blocker, 'category')
    })
    // 只开 daily 档：失败聚焦单档 attempts（别档到点会在 daily 失败后被继续尝试）
    cfgRef.current = makeConfig({ categoryReport: onlyKind('daily') })
    // 三次失败：generate 的文件写失败被 tick 消化（log error、ran=false、attempts 已计数）
    for (let i = 0; i < MAX_AUTO_ATTEMPTS_PER_PERIOD; i++) {
      await expect(svc.tick(true, new Date(2026, 8, 18, 23, 0, 0, 0))).resolves.toBe(false)
    }
    expect(chat).toHaveBeenCalledTimes(MAX_AUTO_ATTEMPTS_PER_PERIOD)
    expect(logError).toHaveBeenCalledTimes(MAX_AUTO_ATTEMPTS_PER_PERIOD) // 失败仍占额度且留痕
    // 第 4 次（同期）：attempts 耗尽 → 不再尝试（不调 LLM、不再 log error）
    await expect(svc.tick(true, new Date(2026, 8, 18, 23, 30, 0, 0))).resolves.toBe(false)
    expect(chat).toHaveBeenCalledTimes(MAX_AUTO_ATTEMPTS_PER_PERIOD)
    // 次日（期键翻转）：attempts 清零 → 再次尝试（chat 第 4 次被调；目录仍非法故仍失败）
    await expect(svc.tick(true, new Date(2026, 8, 19, 23, 0, 0, 0))).resolves.toBe(false)
    expect(chat).toHaveBeenCalledTimes(MAX_AUTO_ATTEMPTS_PER_PERIOD + 1)
  })

  it('单档失败不中断后续档：daily 的存档读炸后，同一 tick 里 weekly 照常生成', async () => {
    const chat = vi.fn(async () => 'AI 总结内容')
    // readRange：daily 的区间（from === to = 当天）炸；weekly 的跨周区间正常
    const readRange = vi.fn(async (from: string, to: string) => {
      if (from === to) throw new Error('archive read failed')
      return [rec('w1', { firstSeenAt: '2026-09-16T10:00:00' })]
    })
    const coveredDays = vi.fn(async () => ['2026-09-16'])
    const logError = vi.fn()
    const cfgRef = {
      current: makeConfig({
        categoryReport: {
          ...onlyKind('weekly'),
          daily: { enabled: true, timeHHMM: '22:30' }
        }
      })
    }
    const svc = new CategoryReportService({
      provider: { chat },
      archive: { readRange, coveredDays },
      notifier: { sendRaw: vi.fn(async () => {}) },
      getConfig: () => cfgRef.current,
      logger: { info: vi.fn(), warn: vi.fn(), error: logError },
      reportsDir: join(dir, 'reports', 'category')
    })
    // 周一 23:00：daily（22:30）与 weekly（周一 08:00）都已过点；monthly 关
    const ran = await svc.tick(true, new Date(2026, 8, 21, 23, 0, 0, 0))
    expect(ran).toBe(true) // weekly 成功 → tick 返回 true
    expect(logError).toHaveBeenCalledTimes(1) // daily 失败被 log error、未中断循环
    expect(String(logError.mock.calls[0]![0])).toContain('daily')
    expect(await svc.loadReport('weekly', '2026-09-20')).not.toBeNull() // weekly 照常落盘
    expect(await svc.loadReport('daily', '2026-09-21')).toBeNull()
    expect(chat).toHaveBeenCalledTimes(1) // 只有 weekly 调了 LLM
  })

  it('weekly：周一 timeHHMM 前不触发、后触发生成上一完整周；周三文件缺失仍补做', async () => {
    const h = build({
      records: [rec('1', { firstSeenAt: '2026-09-16T10:00:00' })],
      covered: ['2026-09-14', '2026-09-16'],
      cfg: makeConfig({ categoryReport: onlyKind('weekly') })
    })
    // 2026-09-21 周一 07:00（timeHHMM 08:00 前）→ 未到
    expect(await h.svc.tick(true, new Date(2026, 8, 21, 7, 0, 0, 0))).toBe(false)
    expect(h.chat).not.toHaveBeenCalled()
    // 周一 08:30 → 生成 09-14~09-20（期键=周日 09-20）
    expect(await h.svc.tick(true, new Date(2026, 8, 21, 8, 30, 0, 0))).toBe(true)
    expect(await h.svc.loadReport('weekly', '2026-09-20')).not.toBeNull()
    // 周三 10:00：文件已存在 → 不重复；删掉文件 → 补做
    expect(await h.svc.tick(true, new Date(2026, 8, 23, 10, 0, 0, 0))).toBe(false)
    const { unlink } = await import('node:fs/promises')
    await unlink(join(dir, 'reports', 'category', 'weekly-2026-09-20.md'))
    expect(await h.svc.tick(true, new Date(2026, 8, 23, 10, 0, 0, 0))).toBe(true)
  })

  it('monthly：1 日到点生成上月；月中文件缺失补做', async () => {
    const h = build({
      records: [rec('1', { firstSeenAt: '2026-09-05T10:00:00' })],
      covered: ['2026-09-05'],
      cfg: makeConfig({ categoryReport: onlyKind('monthly') })
    })
    // 2026-10-01 08:00 前（timeHHMM 08:30）→ 未到
    expect(await h.svc.tick(true, new Date(2026, 9, 1, 8, 0, 0, 0))).toBe(false)
    // 09:00 → 生成 2026-09 月报
    expect(await h.svc.tick(true, new Date(2026, 9, 1, 9, 0, 0, 0))).toBe(true)
    expect(await h.svc.loadReport('monthly', '2026-09')).not.toBeNull()
    // 月中（10-15）：文件已存在 → 否；删除 → 补做
    expect(await h.svc.tick(true, new Date(2026, 9, 15, 9, 0, 0, 0))).toBe(false)
    const { unlink } = await import('node:fs/promises')
    await unlink(join(dir, 'reports', 'category', 'monthly-2026-09.md'))
    expect(await h.svc.tick(true, new Date(2026, 9, 15, 9, 0, 0, 0))).toBe(true)
  })

  it('档位开关独立：daily 关、weekly 开 → 只有 weekly 生成', async () => {
    const h = build({
      records: [rec('1')],
      covered: allDays('2026-09-14', '2026-09-21'),
      cfg: makeConfig({
        categoryReport: {
          ...onlyKind('weekly'),
          daily: { enabled: false, timeHHMM: '22:30' }
        }
      })
    })
    // 周一 08:30：daily 已过点但关着；weekly 到点
    expect(await h.svc.tick(true, new Date(2026, 8, 21, 8, 30, 0, 0))).toBe(true)
    expect(await h.svc.loadReport('weekly', '2026-09-20')).not.toBeNull()
    expect(await h.svc.loadReport('daily', '2026-09-21')).toBeNull()
  })

  it('nextCheckAt：三档最小值；本期已过 → 下一期；全关 → Infinity', async () => {
    // 三档全开：daily 22:30 / weekly 周一 08:00 / monthly 1 日 08:30
    const h = build({})
    const now = new Date(2026, 8, 21, 7, 0, 0, 0) // 周一 07:00
    // daily 目标今天 22:30（未到）；weekly 目标今天 08:00（未到）；monthly 目标 09-01 08:30（已过→10-01 08:30）
    expect(h.svc.nextCheckAt(now)).toBe(new Date(2026, 8, 21, 8, 0, 0, 0).getTime())
    const later = new Date(2026, 8, 21, 9, 0, 0, 0) // 周一 09:00：weekly 已过 → 下周一
    expect(h.svc.nextCheckAt(later)).toBe(new Date(2026, 8, 21, 22, 30, 0, 0).getTime()) // daily 今天 22:30 最小
    const eod = new Date(2026, 8, 21, 23, 0, 0, 0) // 周一 23:00：daily 也过 → 明天 22:30
    expect(h.svc.nextCheckAt(eod)).toBe(new Date(2026, 8, 22, 22, 30, 0, 0).getTime())
    // 全关 → Infinity
    const off = build({ cfg: makeConfig({ categoryReport: { enabled: false } }) })
    expect(off.svc.nextCheckAt(now)).toBe(Infinity)
    // 总开关开但三档全关 → Infinity
    const allKindsOff = build({
      cfg: makeConfig({
        categoryReport: {
          daily: { enabled: false, timeHHMM: '22:30' },
          weekly: { enabled: false, timeHHMM: '08:00' },
          monthly: { enabled: false, timeHHMM: '08:30' }
        }
      })
    })
    expect(allKindsOff.svc.nextCheckAt(now)).toBe(Infinity)
  })
})

// ---- loadReport / listPeriods ------------------------------------------------

describe('loadReport / listPeriods', () => {
  it('loadReport 期键形状按档校验（防路径穿越）；不存在 → null', async () => {
    const h = build({})
    expect(await h.svc.loadReport('daily', '../../etc/passwd')).toBeNull()
    expect(await h.svc.loadReport('daily', '2026-9-18')).toBeNull() // 非两位
    expect(await h.svc.loadReport('monthly', '2026-09-18')).toBeNull() // 月报不认日期键
    expect(await h.svc.loadReport('weekly', '2026-09-18')).toBeNull() // 不存在
    await h.svc.generate('daily', new Date(2026, 8, 18, 23, 0, 0, 0))
    expect(await h.svc.loadReport('daily', '2026-09-18')).not.toBeNull()
  })

  it('listPeriods 按档过滤、新→旧', async () => {
    const h = build({ records: [], covered: [] })
    await h.svc.generate('daily', new Date(2026, 8, 17, 23, 0, 0, 0))
    await h.svc.generate('daily', new Date(2026, 8, 18, 23, 0, 0, 0))
    await h.svc.generate('weekly', new Date(2026, 8, 21, 9, 0, 0, 0))
    await h.svc.generate('monthly', new Date(2026, 8, 21, 9, 0, 0, 0))
    expect(h.svc.listPeriods('daily')).toEqual(['2026-09-18', '2026-09-17'])
    expect(h.svc.listPeriods('weekly')).toEqual(['2026-09-20'])
    expect(h.svc.listPeriods('monthly')).toEqual(['2026-08'])
    // 垃圾文件不影响（readdirSync 非递归、按前缀+形状过滤）
    await writeFile(join(dir, 'reports', 'category', 'junk.md'), 'x', 'utf-8')
    await writeFile(join(dir, 'reports', 'category', 'daily-not-a-date.md'), 'x', 'utf-8')
    expect(h.svc.listPeriods('daily')).toEqual(['2026-09-18', '2026-09-17'])
  })
})

/** from..to（含两端）的全部日期串 */
function allDays(from: string, to: string): string[] {
  const out: string[] = []
  const d = new Date(`${from}T00:00:00`)
  const end = new Date(`${to}T00:00:00`)
  while (d.getTime() <= end.getTime()) {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    out.push(`${y}-${m}-${day}`)
    d.setDate(d.getDate() + 1)
  }
  return out
}
