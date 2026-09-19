/**
 * DailyReportService 单测：provider.chat / hits.readDay / notifier.sendRaw /
 * getConfig 全 mock，reportsDir 走真实 tmpdir。
 * 覆盖：零命中固定文案（不调 LLM）/ 有命中 LLM 素材形状（含第三轮锐评
 * commentary 有/无两态）/ LLM 失败降级模板（锐评「」附行尾）/
 * 推送条件 / 分段 / tick 条件矩阵 / attempts 上限与跨日清零 / nextCheckAt /
 * listReportDays / loadReport。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_CONFIG, type AppConfig, type HitRecord, type Topic } from '../../shared/types'
import { formatLocalDate } from '../monitor/hits-store'
import {
  DailyReportService,
  splitForTelegram,
  TELEGRAM_CHUNK_MAX
} from './daily-report'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forumwatch-report-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

function makeTopic(id: string, title: string): Topic {
  return {
    id,
    sourceId: 'nodeseek',
    title,
    url: `https://www.nodeseek.com/post-${id}-1`,
    author: 'someone',
    category: '交易',
    categorySlug: 'trade',
    pinned: false,
    lastActiveAt: null
  }
}

function makeHit(id: string, title: string, matchedBy: 'literal' | 'semantic' = 'literal'): HitRecord {
  return {
    topic: makeTopic(id, title),
    matchedKeywords: matchedBy === 'literal' ? ['羊毛'] : [],
    matchedBy,
    semanticReason: matchedBy === 'semantic' ? '与兴趣相关' : null,
    notifiedAt: '2026-09-19T10:00:01+08:00',
    notifyError: null
  }
}

interface Harness {
  svc: DailyReportService
  chat: ReturnType<typeof vi.fn>
  readDay: ReturnType<typeof vi.fn>
  sendRaw: ReturnType<typeof vi.fn>
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }
  cfg: AppConfig
  onGenerated: ReturnType<typeof vi.fn>
}

function makeHarness(
  opts: {
    hitsForDay?: HitRecord[]
    chatReply?: (callIndex: number) => string | Error
    cfg?: Partial<AppConfig>
    reportsDir?: string
  } = {}
): Harness {
  const cfg: AppConfig = {
    ...structuredClone(DEFAULT_APP_CONFIG),
    telegram: { botToken: 'T', chatId: 'C' },
    notifyEnabled: true,
    ai: {
      ...structuredClone(DEFAULT_APP_CONFIG.ai),
      dailyReport: { enabled: true, timeHHMM: '22:00' }
    },
    ...opts.cfg
  }
  const chat = vi.fn(() => {
    const idx = chat.mock.calls.length - 1
    const reply = opts.chatReply ?? (() => '# AI 日报\n\n总述内容。')
    const r = reply(idx)
    return typeof r === 'string' ? Promise.resolve(r) : Promise.reject(r)
  })
  const readDay = vi.fn(async (_date: string) => opts.hitsForDay ?? [])
  const sendRaw = vi.fn(async () => {})
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const onGenerated = vi.fn()
  const svc = new DailyReportService({
    provider: { chat },
    hits: { readDay },
    notifier: { sendRaw },
    getConfig: () => cfg,
    logger,
    reportsDir: opts.reportsDir ?? join(dir, 'reports'),
    onGenerated
  })
  return { svc, chat, readDay, sendRaw, logger, cfg, onGenerated }
}

/** 本地时区的指定时刻（测试不依赖机器时区） */
function at(h: number, m: number, day = 19, month = 8): Date {
  return new Date(2026, month, day, h, m)
}

describe('generate', () => {
  it('零命中：固定文案、不调 LLM、写文件、推送一次、onGenerated 广播', async () => {
    const h = makeHarness()
    const md = await h.svc.generate(at(22, 30))

    expect(h.chat).not.toHaveBeenCalled()
    expect(md).toContain('今日无命中')
    expect(md).toContain('2026-09-19')
    await expect(h.svc.loadReport('2026-09-19')).resolves.toBe(md)
    expect(h.sendRaw).toHaveBeenCalledTimes(1)
    expect(h.sendRaw.mock.calls[0]![0]).toBe(md)
    expect(h.onGenerated).toHaveBeenCalledWith({ date: '2026-09-19', markdown: md })
  })

  it('有命中：LLM 被调，user JSON 含命中摘要（time/title/category/sourceId/matchedBy/commentary/pushed），markdown 落盘', async () => {
    const hits = [
      makeHit('1', '羊毛 A'),
      makeHit('2', '语义 B', 'semantic'),
      { ...makeHit('3', '推送失败 C'), notifiedAt: null, notifyError: 'telegram down' },
      { ...makeHit('4', '带锐评 D', 'semantic'), commentary: '这价格怕不是钓鱼' },
      { ...makeHit('5', '空锐评 E'), commentary: null }
    ]
    const h = makeHarness({ hitsForDay: hits })
    const md = await h.svc.generate(at(22, 30))

    expect(h.chat).toHaveBeenCalledTimes(1)
    const req = h.chat.mock.calls[0]![0] as { system: string; user: string; timeoutMs?: number; maxTokens?: number }
    expect(req.system).toContain('中文监控日报')
    // 第三轮：system prompt 提示 LLM 在要点中引用锐评
    expect(req.system).toContain('命中如带锐评（commentary 字段），在要点中用一句话引用它')
    expect(req.timeoutMs).toBe(30000)
    expect(req.maxTokens).toBe(1500)
    const payload = JSON.parse(req.user) as {
      date: string
      total: number
      hits: Array<{ title: string; category: string; sourceId: string; matchedBy: string; commentary: string | null; pushed: boolean }>
    }
    expect(payload.date).toBe('2026-09-19')
    expect(payload.total).toBe(5)
    expect(payload.hits).toHaveLength(5)
    expect(payload.hits[0]).toMatchObject({ title: '羊毛 A', category: '交易', sourceId: 'nodeseek', matchedBy: 'literal', pushed: true })
    expect(payload.hits[1]).toMatchObject({ matchedBy: 'semantic' })
    expect(payload.hits[2]).toMatchObject({ pushed: false })
    // 第三轮锐评两态：有 → 原文；无（旧 jsonl 行缺字段 / 显式 null）→ 归一 null
    expect(payload.hits[0]).toMatchObject({ commentary: null })
    expect(payload.hits[3]).toMatchObject({ commentary: '这价格怕不是钓鱼' })
    expect(payload.hits[4]).toMatchObject({ commentary: null })
    expect(md).toBe('# AI 日报\n\n总述内容。')
    await expect(h.svc.loadReport('2026-09-19')).resolves.toBe(md)
  })

  it('规则命中行（R5-P2a）：LLM 素材带 matchedRule（?? null 归一）；降级模板显示「规则命中：label」', async () => {
    const ruleHit: HitRecord = {
      topic: makeTopic('3', '9.9元/月 小鸡'),
      matchedKeywords: [],
      matchedBy: 'rule',
      semanticReason: null,
      matchedRule: '白菜月付',
      notifiedAt: '2026-09-19T10:00:01+08:00',
      notifyError: null
    }
    // 旧 jsonl 行形态：无 matchedRule 字段（消费方须容忍缺失）
    const stripMatchedRule = (h: HitRecord): HitRecord => {
      const copy = { ...h }
      delete (copy as Partial<HitRecord>).matchedRule
      return copy
    }
    const literalHit: HitRecord = { ...makeHit('2', '羊毛 B'), matchedRule: null }

    // a) LLM 路径：payload.matchedRule 三态归一（label / 缺字段→null / 显式 null）
    const h1 = makeHarness({ hitsForDay: [ruleHit, stripMatchedRule(makeHit('1', '羊毛 A')), literalHit] })
    await h1.svc.generate(at(22, 30))
    const req = h1.chat.mock.calls[0]![0] as { system: string; user: string }
    const payload = JSON.parse(req.user) as {
      hits: Array<{ matchedBy: string; matchedRule: string | null }>
    }
    expect(payload.hits[0]).toMatchObject({ matchedBy: 'rule', matchedRule: '白菜月付' })
    expect(payload.hits[1]).toMatchObject({ matchedBy: 'literal', matchedRule: null })
    expect(payload.hits[2]).toMatchObject({ matchedBy: 'literal', matchedRule: null })

    // b) 降级模板：规则命中带 label；matchedBy='rule' 但缺 matchedRule 的旧记录兜底「规则命中」；literal 不变
    const noLabelRule = stripMatchedRule({ ...ruleHit, topic: makeTopic('5', '3元/月 小鸡') })
    const h2 = makeHarness({
      hitsForDay: [ruleHit, noLabelRule, literalHit],
      chatReply: () => new Error('AI down')
    })
    const md = await h2.svc.generate(at(22, 30))
    expect(md).toMatch(/9\.9元\/月 小鸡（规则命中：白菜月付）$/m)
    expect(md).toMatch(/3元\/月 小鸡（规则命中）$/m)
    expect(md).toMatch(/羊毛 B（字面命中）$/m)
  })

  it('LLM 抛错：降级固定模板仍成功落盘，log warn，推送照发（锐评「」附行尾，无锐评不加）', async () => {
    const h = makeHarness({
      hitsForDay: [
        makeHit('1', '羊毛 A'),
        { ...makeHit('2', '语义 B', 'semantic'), commentary: '这价格怕不是钓鱼' }
      ],
      chatReply: () => new Error('AI provider network error')
    })
    const md = await h.svc.generate(at(22, 30))

    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('daily report LLM failed'))
    expect(md).toContain('共 2 条命中')
    expect(md).toContain('羊毛 A')
    expect(md).toContain('语义 B')
    expect(md).toContain('语义命中')
    // 第三轮锐评：有 → 「原文」附在命中行尾；无 → 命中行到（命中方式）即止
    expect(md).toMatch(/语义 B（语义命中）「这价格怕不是钓鱼」$/m)
    expect(md).toMatch(/羊毛 A（字面命中）$/m)
    expect(md).toContain('模板模式')
    await expect(h.svc.loadReport('2026-09-19')).resolves.toBe(md)
    expect(h.sendRaw).toHaveBeenCalledTimes(1)
  })

  it('LLM 返回空串（provider 契约合法）：同样降级固定模板，不落空文件', async () => {
    const h = makeHarness({
      hitsForDay: [makeHit('1', '羊毛 A')],
      chatReply: () => '   '
    })
    const md = await h.svc.generate(at(22, 30))
    expect(md).toContain('共 1 条命中')
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('daily report LLM failed'))
    await expect(h.svc.loadReport('2026-09-19')).resolves.toBe(md)
  })

  it('推送条件：dailyReport.enabled=false / notifyEnabled=false / telegram 未配置 → 不调 sendRaw', async () => {
    for (const patch of [
      { ai: { ...DEFAULT_APP_CONFIG.ai, dailyReport: { enabled: false, timeHHMM: '22:00' } } },
      { notifyEnabled: false },
      { telegram: { botToken: '', chatId: '' } }
    ]) {
      const h = makeHarness({ cfg: patch })
      await h.svc.generate(at(22, 30))
      expect(h.sendRaw).not.toHaveBeenCalled()
    }
  })

  it('推送失败：log error 但 generate 正常返回且文件已写', async () => {
    const h = makeHarness()
    h.sendRaw.mockRejectedValue(new Error('telegram send failed'))
    const md = await h.svc.generate(at(22, 30))
    expect(md).toContain('今日无命中')
    expect(h.logger.error).toHaveBeenCalledWith(expect.stringContaining('daily report push failed'))
    await expect(h.svc.loadReport('2026-09-19')).resolves.toBe(md)
  })

  it('超长 markdown：分段推送，每段 ≤3500 且行边界切分，第 2 段起尾缀（续 N）', async () => {
    // 50 行 × ~100 字符 = ~5000 字符 → 至少 2 段
    const longMd = Array.from({ length: 50 }, (_, i) => `${String(i).padStart(2, '0')} ${'x'.repeat(98)}`).join('\n')
    const h = makeHarness({ hitsForDay: [makeHit('1', '羊毛 A')], chatReply: () => longMd })
    await h.svc.generate(at(22, 30))

    expect(h.sendRaw.mock.calls.length).toBeGreaterThanOrEqual(2)
    for (const [text] of h.sendRaw.mock.calls as Array<[string]>) {
      expect(text.length).toBeLessThanOrEqual(TELEGRAM_CHUNK_MAX)
    }
    const first = h.sendRaw.mock.calls[0]![0] as string
    expect(first.endsWith('（续 1）')).toBe(false)
    expect((h.sendRaw.mock.calls[1]![0] as string).endsWith('（续 2）')).toBe(true)
    // 行边界切分：首段以整行结束（不以行中间字符截断）
    expect(first.endsWith('x')).toBe(true)
    // 内容无丢失（去掉尾缀后按行拼回 = 原文）
    const reassembled = (h.sendRaw.mock.calls as Array<[string]>)
      .map(([t]) => t.replace(/（续 \d+）$/, ''))
      .join('\n')
    expect(reassembled).toBe(longMd)
  })
})

describe('splitForTelegram（纯函数）', () => {
  it('短文本单段原样返回', () => {
    expect(splitForTelegram('abc\ndef')).toEqual(['abc\ndef'])
  })

  it('恰好等于上限：单段', () => {
    const text = 'a'.repeat(TELEGRAM_CHUNK_MAX)
    expect(splitForTelegram(text)).toEqual([text])
  })

  it('单行超上限：对该行硬切，不丢内容', () => {
    const text = 'y'.repeat(TELEGRAM_CHUNK_MAX + 100)
    const parts = splitForTelegram(text)
    expect(parts.length).toBe(2)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(TELEGRAM_CHUNK_MAX)
    expect(parts.map((p) => p.replace(/（续 \d+）$/, '')).join('')).toBe(text)
  })
})

describe('tick（定时触发条件矩阵）', () => {
  it('未到 timeHHMM：不跑', async () => {
    const h = makeHarness()
    await expect(h.svc.tick(true, at(21, 59))).resolves.toBe(false)
    expect(h.chat).not.toHaveBeenCalled()
    expect(h.sendRaw).not.toHaveBeenCalled()
    await expect(h.svc.loadReport('2026-09-19')).resolves.toBeNull()
  })

  it('到时且无文件：跑（生成 + 推送），返回 true', async () => {
    const h = makeHarness()
    await expect(h.svc.tick(true, at(22, 0))).resolves.toBe(true)
    await expect(h.svc.loadReport('2026-09-19')).resolves.toContain('今日无命中')
    expect(h.sendRaw).toHaveBeenCalledTimes(1)
  })

  it('已有文件：不跑（幂等，手动/自动生成过都不重复）', async () => {
    const h = makeHarness()
    await h.svc.generate(at(22, 0))
    await expect(h.svc.tick(true, at(22, 30))).resolves.toBe(false)
    expect(h.sendRaw).toHaveBeenCalledTimes(1) // 只有 generate 那次
  })

  it('paused（desiredRunning=false）：不跑且不消耗 attempts', async () => {
    const h = makeHarness()
    await expect(h.svc.tick(false, at(22, 30))).resolves.toBe(false)
    // 之后恢复运行仍能正常生成
    await expect(h.svc.tick(true, at(22, 30))).resolves.toBe(true)
  })

  it('generate 持续失败：当日 attempts 上限 3 次，之后不再尝试；跨日清零', async () => {
    // blocker 文件挡住 reports 目录路径 → mkdir/writeFile 失败 → generate 抛
    await writeFile(join(dir, 'blocker'), 'x', 'utf-8')
    const h = makeHarness({ reportsDir: join(dir, 'blocker', 'reports') })
    for (let i = 0; i < 3; i++) {
      await expect(h.svc.tick(true, at(22, 0))).rejects.toThrow()
    }
    // 第 4 次：attempts 已到 3 → 直接 false，不再尝试
    await expect(h.svc.tick(true, at(23, 0))).resolves.toBe(false)
    // 跨日（本地自然日翻转）：attempts 清零，重新开始尝试
    await expect(h.svc.tick(true, at(22, 0, 20))).rejects.toThrow()
  })

  it('dailyReport.enabled=false（功能总开关）：到点不生成、不调 LLM、不写文件、不计 attempts', async () => {
    // 有命中：若 tick 走到 generate 必然会调 LLM——用它证伪「偷偷生成」
    const h = makeHarness({
      hitsForDay: [makeHit('1', '羊毛 A')],
      cfg: { ai: { ...DEFAULT_APP_CONFIG.ai, dailyReport: { enabled: false, timeHHMM: '22:00' } } }
    })
    await expect(h.svc.tick(true, at(22, 30))).resolves.toBe(false)
    expect(h.chat).not.toHaveBeenCalled()
    expect(h.sendRaw).not.toHaveBeenCalled()
    await expect(h.svc.loadReport('2026-09-19')).resolves.toBeNull()

    // 手动 generate 不受总开关影响（「今日回顾 → 立即生成」仍可用；开关只拦
    // 自动触发与推送）——照常写文件、照常调 LLM
    const md = await h.svc.generate(at(22, 30))
    expect(h.chat).toHaveBeenCalledTimes(1)
    expect(md).toBe('# AI 日报\n\n总述内容。')
    await expect(h.svc.loadReport('2026-09-19')).resolves.toBe(md)
    expect(h.sendRaw).not.toHaveBeenCalled() // 推送仍被开关拦住
  })

  it('开关关闭期间不消耗 attempts：重新开启后当天到点仍正常生成（enabled=true 行为不变）', async () => {
    const h = makeHarness({
      hitsForDay: [makeHit('1', '羊毛 A')],
      cfg: { ai: { ...DEFAULT_APP_CONFIG.ai, dailyReport: { enabled: false, timeHHMM: '22:00' } } }
    })
    await expect(h.svc.tick(true, at(22, 0))).resolves.toBe(false)
    await expect(h.svc.tick(true, at(22, 30))).resolves.toBe(false)

    h.cfg.ai.dailyReport.enabled = true // 热更新语义：getConfig 每次实时读
    await expect(h.svc.tick(true, at(23, 0))).resolves.toBe(true)
    expect(h.chat).toHaveBeenCalledTimes(1)
    expect(h.sendRaw).toHaveBeenCalledTimes(1)
  })

  it('timeHHMM 已过的当天时刻也触发（补做今天，不回溯昨天）', async () => {
    const h = makeHarness()
    // 生成时刻属于今天 23:59，命中桶 key 也是今天
    await expect(h.svc.tick(true, at(23, 59))).resolves.toBe(true)
    expect(h.readDay).toHaveBeenCalledWith('2026-09-19')
    expect(formatLocalDate(at(23, 59))).toBe('2026-09-19')
  })
})

describe('nextCheckAt', () => {
  it('今天 timeHHMM 未到 → 今天该时刻', () => {
    const h = makeHarness() // timeHHMM 22:00
    expect(h.svc.nextCheckAt(at(10, 0))).toBe(at(22, 0).getTime())
  })

  it('今天 timeHHMM 已到/已过 → 明天同一时刻（跨天滚动）', () => {
    const h = makeHarness()
    expect(h.svc.nextCheckAt(at(22, 0))).toBe(new Date(2026, 8, 20, 22, 0).getTime())
    expect(h.svc.nextCheckAt(at(23, 30))).toBe(new Date(2026, 8, 20, 22, 0).getTime())
  })

  it('跨月边界滚动（9/30 → 10/1）', () => {
    const h = makeHarness()
    expect(h.svc.nextCheckAt(at(10, 0, 30))).toBe(new Date(2026, 8, 30, 22, 0).getTime())
    expect(h.svc.nextCheckAt(at(23, 30, 30))).toBe(new Date(2026, 9, 1, 22, 0).getTime())
  })
})

describe('loadReport / listReportDays', () => {
  it('无文件 → null；目录不存在 → 空列表', async () => {
    const h = makeHarness()
    await expect(h.svc.loadReport('2026-09-19')).resolves.toBeNull()
    expect(h.svc.listReportDays()).toEqual([])
  })

  it('日期形状不合法（含路径穿越片段）→ loadReport 直接 null，不触碰文件系统', async () => {
    const h = makeHarness()
    await expect(h.svc.loadReport('../../config')).resolves.toBeNull()
    await expect(h.svc.loadReport('')).resolves.toBeNull()
    await expect(h.svc.loadReport('2026-9-19')).resolves.toBeNull()
  })

  it('多天生成后：列表新→旧，正文可读回', async () => {
    const h = makeHarness()
    await h.svc.generate(at(22, 0, 18))
    await h.svc.generate(at(22, 0, 19))
    expect(h.svc.listReportDays()).toEqual(['2026-09-19', '2026-09-18'])
    const md = await h.svc.loadReport('2026-09-18')
    expect(md).toContain('2026-09-18')
  })

  it('重新生成覆盖旧文件（手动重生成语义）', async () => {
    const h = makeHarness({ hitsForDay: [makeHit('1', '羊毛 A')], chatReply: () => '第一版' })
    await h.svc.generate(at(22, 0))
    h.chat.mockImplementation(async () => '第二版')
    await h.svc.generate(at(22, 30))
    await expect(h.svc.loadReport('2026-09-19')).resolves.toBe('第二版')
  })
})
