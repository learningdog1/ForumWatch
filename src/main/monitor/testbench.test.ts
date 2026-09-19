/**
 * runMatchTest 单测（R5-P2c 匹配测试台内核）。
 * 覆盖：阶段顺序与各阶段 trace 文案、wouldPush 矩阵（规则/字面/语义 × 相似/排除/
 * 来源过滤）、semantic skip（未提供 / {skipped}）、filters block、规则短路、
 * 提取摘要、短标题守卫、阈值边界。
 */
import { describe, expect, it } from 'vitest'
import type { AppConfig, PriceRuleConfig, SourceFilters } from '../../shared/types'
import { DEFAULT_APP_CONFIG } from '../../shared/types'
import {
  runMatchTest,
  STAGE_EXCLUDE,
  STAGE_FILTERS,
  STAGE_LITERAL,
  STAGE_RULES,
  STAGE_SEMANTIC,
  STAGE_SIMILARITY,
  type MatchTestInput
} from './testbench'

function cfg(overrides: Partial<AppConfig> = {}): MatchTestInput['cfg'] {
  return { ...DEFAULT_APP_CONFIG, ...overrides }
}

function rule(overrides: Partial<PriceRuleConfig> = {}): PriceRuleConfig {
  return { id: 'r1', enabled: true, cycle: 'any', ...overrides }
}

function input(overrides: Partial<MatchTestInput> = {}): MatchTestInput {
  return { title: '测试标题', cfg: cfg(), recentPushedTitles: [], ...overrides }
}

/** 取指定阶段的单条结果 */
function stageOf(result: ReturnType<typeof runMatchTest>, stage: string) {
  const s = result.stages.find((x) => x.stage === stage)
  expect(s, `stage ${stage} should exist`).toBeDefined()
  return s!
}

describe('runMatchTest：阶段顺序与默认形态', () => {
  it('六阶段按引擎管线顺序输出；全空配置下 wouldPush=false', () => {
    const r = runMatchTest(input({ title: '随便一个标题' }))
    expect(r.stages.map((s) => s.stage)).toEqual([
      STAGE_FILTERS,
      STAGE_EXCLUDE,
      STAGE_RULES,
      STAGE_LITERAL,
      STAGE_SIMILARITY,
      STAGE_SEMANTIC
    ])
    expect(r.wouldPush).toBe(false)
    expect(stageOf(r, STAGE_FILTERS).outcome).toBe('skip')
    expect(stageOf(r, STAGE_EXCLUDE).outcome).toBe('pass')
    expect(stageOf(r, STAGE_RULES).outcome).toBe('info')
    expect(stageOf(r, STAGE_LITERAL).outcome).toBe('info')
    expect(stageOf(r, STAGE_SIMILARITY).outcome).toBe('pass')
    expect(stageOf(r, STAGE_SEMANTIC).outcome).toBe('skip')
  })

  it('无包含关键词时字面档说明防风暴语义', () => {
    const r = runMatchTest(input({ cfg: cfg() }))
    expect(stageOf(r, STAGE_LITERAL).detail).toContain('未配置包含关键词')
  })

  it('相似降噪关闭时该阶段 skip', () => {
    const r = runMatchTest(
      input({ cfg: cfg({ similarity: { enabled: false, threshold: 0.72 } }) })
    )
    expect(stageOf(r, STAGE_SIMILARITY).outcome).toBe('skip')
    expect(stageOf(r, STAGE_SIMILARITY).detail).toContain('已关闭')
  })
})

describe('runMatchTest：字面与排除词', () => {
  it('命中包含词 → literal pass、wouldPush=true，detail 列出命中词', () => {
    const r = runMatchTest(
      input({
        title: '白嫖一个 VPS 的小技巧',
        cfg: cfg({ includeKeywords: ['vps', '白嫖', 'nginx'] })
      })
    )
    const s = stageOf(r, STAGE_LITERAL)
    expect(s.outcome).toBe('pass')
    expect(s.detail).toContain('白嫖')
    expect(s.detail).toContain('vps') // matchTopic 保留配置词的原始写法
    expect(r.wouldPush).toBe(true)
  })

  it('排除词 block → wouldPush=false，后续阶段全部 skip', () => {
    const r = runMatchTest(
      input({
        title: '福利 VPS 送钱',
        cfg: cfg({ includeKeywords: ['vps'], excludeKeywords: ['福利', '广告'] })
      })
    )
    const s = stageOf(r, STAGE_EXCLUDE)
    expect(s.outcome).toBe('block')
    expect(s.detail).toContain('福利')
    expect(r.wouldPush).toBe(false)
    for (const st of [STAGE_RULES, STAGE_LITERAL, STAGE_SIMILARITY, STAGE_SEMANTIC]) {
      expect(stageOf(r, st).outcome).toBe('skip')
    }
  })
})

describe('runMatchTest：价格规则', () => {
  const rules: PriceRuleConfig[] = [
    rule({ id: 'cheap-yearly', label: '百元内年付', cycle: 'yearly', maxPrice: 100, currency: 'CNY' })
  ]

  it('命中规则 → rules pass（含规则名与提取摘要），literal/semantic 短路 skip，wouldPush=true', () => {
    const r = runMatchTest(
      input({
        title: '年付 ¥99 的机器，500G 流量',
        cfg: cfg({ priceRules: rules, includeKeywords: ['vps'] })
      })
    )
    const s = stageOf(r, STAGE_RULES)
    expect(s.outcome).toBe('pass')
    expect(s.detail).toContain('百元内年付')
    expect(s.detail).toContain('年付')
    expect(s.detail).toContain('¥99')
    expect(s.detail).toContain('流量 500G')
    expect(stageOf(r, STAGE_LITERAL).outcome).toBe('skip')
    expect(stageOf(r, STAGE_LITERAL).detail).toContain('价格规则已命中')
    expect(stageOf(r, STAGE_SEMANTIC).outcome).toBe('skip')
    expect(r.wouldPush).toBe(true)
  })

  it('提取不到价格（声明了上限）→ 规则不命中，info 带提取摘要', () => {
    const r = runMatchTest(
      input({ title: '聊聊主机选型', cfg: cfg({ priceRules: rules }) })
    )
    const s = stageOf(r, STAGE_RULES)
    expect(s.outcome).toBe('info')
    expect(s.detail).toContain('未命中价格规则')
    expect(s.detail).toContain('无可提取交易信息')
    expect(r.wouldPush).toBe(false)
  })

  it('价格超上限 → 不命中，detail 展示实际提取价格', () => {
    const r = runMatchTest(
      input({ title: '年付 ¥299 元的机器', cfg: cfg({ priceRules: rules }) })
    )
    const s = stageOf(r, STAGE_RULES)
    expect(s.outcome).toBe('info')
    expect(s.detail).toContain('¥299')
    expect(r.wouldPush).toBe(false)
  })

  it('未配置规则 → info 提示未配置（仍展示提取信息）', () => {
    const r = runMatchTest(input({ title: '月付 $9.9', cfg: cfg() }))
    const s = stageOf(r, STAGE_RULES)
    expect(s.outcome).toBe('info')
    expect(s.detail).toContain('未配置价格规则')
    expect(s.detail).toContain('月付')
    expect(s.detail).toContain('$9.9')
  })

  it('disabled 规则不参与（evaluateRules 同款语义）', () => {
    const r = runMatchTest(
      input({
        title: '年付 ¥99',
        cfg: cfg({ priceRules: [rule({ enabled: false })] })
      })
    )
    expect(stageOf(r, STAGE_RULES).outcome).toBe('info')
    expect(r.wouldPush).toBe(false)
  })
})

describe('runMatchTest：相似降噪', () => {
  const base = cfg({ includeKeywords: ['vps'] })
  const recent = ['便宜 vps 年付 99 元的活动帖子'] // 已归一化形态

  it('与近期已推相似 → similarity block，即使字面命中 wouldPush=false', () => {
    const r = runMatchTest(
      input({
        title: '【转发】便宜 VPS 年付 99 元的活动帖子！',
        cfg: base,
        recentPushedTitles: recent
      })
    )
    const s = stageOf(r, STAGE_SIMILARITY)
    expect(s.outcome).toBe('block')
    expect(s.detail).toContain('与近期已推标题相似')
    expect(stageOf(r, STAGE_LITERAL).outcome).toBe('pass')
    expect(r.wouldPush).toBe(false)
  })

  it('不相似 → pass；短标题守卫（归一后 <6 字符）恒不判相似', () => {
    const r1 = runMatchTest(
      input({ title: '聊聊完全不同的 vps 话题', cfg: base, recentPushedTitles: recent })
    )
    expect(stageOf(r1, STAGE_SIMILARITY).outcome).toBe('pass')
    expect(r1.wouldPush).toBe(true)

    const r2 = runMatchTest(
      input({ title: 'vps', cfg: base, recentPushedTitles: ['vps'] })
    )
    expect(stageOf(r2, STAGE_SIMILARITY).outcome).toBe('pass')
    expect(r2.wouldPush).toBe(true)
  })

  it('规则命中 + 相似拦截 → wouldPush=false（相似作用于全部命中方式）', () => {
    const similarToRuleTitle = normalize('年付 ¥99 的机器，500G 流量')
    const r = runMatchTest(
      input({
        title: '【分享】年付 ¥99 的机器，500G 流量',
        cfg: cfg({
          priceRules: [rule({ cycle: 'yearly', maxPrice: 100, currency: 'CNY' })]
        }),
        recentPushedTitles: [similarToRuleTitle]
      })
    )
    expect(stageOf(r, STAGE_RULES).outcome).toBe('pass')
    expect(stageOf(r, STAGE_SIMILARITY).outcome).toBe('block')
    expect(r.wouldPush).toBe(false)
  })
})

describe('runMatchTest：语义档', () => {
  const base = cfg({ ai: { ...DEFAULT_APP_CONFIG.ai, semanticThreshold: 0.5 } })

  it('hit 且过闸 → pass、wouldPush=true（字面未命中亦可）', () => {
    const r = runMatchTest(
      input({
        title: '想搭个自托管服务',
        cfg: base,
        semantic: { hit: true, score: 0.93, reason: '与自建主机相关' }
      })
    )
    const s = stageOf(r, STAGE_SEMANTIC)
    expect(s.outcome).toBe('pass')
    expect(s.detail).toContain('0.93')
    expect(s.detail).toContain('0.5')
    expect(s.detail).toContain('与自建主机相关')
    expect(stageOf(r, STAGE_LITERAL).outcome).toBe('info')
    expect(r.wouldPush).toBe(true)
  })

  it('hit 未过闸 → block（detail 含 score 与阈值），wouldPush=false', () => {
    const r = runMatchTest(
      input({
        cfg: base,
        semantic: { hit: true, score: 0.3, reason: '可能相关' }
      })
    )
    const s = stageOf(r, STAGE_SEMANTIC)
    expect(s.outcome).toBe('block')
    expect(s.detail).toContain('0.3')
    expect(s.detail).toContain('0.5')
    expect(r.wouldPush).toBe(false)
  })

  it('hit=false → block（detail 含 reason）', () => {
    const r = runMatchTest(
      input({
        cfg: base,
        semantic: { hit: false, score: 0.1, reason: '与兴趣无关' }
      })
    )
    const s = stageOf(r, STAGE_SEMANTIC)
    expect(s.outcome).toBe('block')
    expect(s.detail).toContain('与兴趣无关')
    expect(r.wouldPush).toBe(false)
  })

  it('semantic 未提供 → skip', () => {
    const r = runMatchTest(input({ cfg: base }))
    expect(stageOf(r, STAGE_SEMANTIC).outcome).toBe('skip')
    expect(r.wouldPush).toBe(false)
  })

  it('semantic={skipped}（AI 未配置/失败/未决）→ skip 且 detail 注明原因', () => {
    const r = runMatchTest(
      input({ cfg: base, semantic: { skipped: 'AI 评估失败：timeout' } })
    )
    const s = stageOf(r, STAGE_SEMANTIC)
    expect(s.outcome).toBe('skip')
    expect(s.detail).toContain('timeout')
    expect(r.wouldPush).toBe(false)
  })

  it('阈值 0（默认）时任何 score 都过闸（>= 边界，与引擎同款）', () => {
    const r = runMatchTest(
      input({
        cfg: cfg(),
        semantic: { hit: true, score: 0, reason: null }
      })
    )
    expect(stageOf(r, STAGE_SEMANTIC).outcome).toBe('pass')
    expect(r.wouldPush).toBe(true)
  })

  it('score 恰等于阈值 → 过闸（>= 而非 >）', () => {
    const r = runMatchTest(
      input({
        cfg: base,
        semantic: { hit: true, score: 0.5, reason: null }
      })
    )
    expect(stageOf(r, STAGE_SEMANTIC).outcome).toBe('pass')
  })
})

describe('runMatchTest：per-source 过滤', () => {
  const filters: SourceFilters = { includeCategories: ['trade', '交易'] }

  it('分类白名单命中（提供分类）→ pass', () => {
    const r = runMatchTest(
      input({
        title: 'vps 交易帖测试',
        cfg: cfg({ includeKeywords: ['vps'] }),
        filters,
        topic: { category: '交易', categorySlug: '' }
      })
    )
    expect(stageOf(r, STAGE_FILTERS).outcome).toBe('pass')
    expect(r.wouldPush).toBe(true)
  })

  it('未提供分类且来源有白名单 → block（按无分类处理，与引擎对无分类帖子行为一致）', () => {
    const r = runMatchTest(
      input({ cfg: cfg({ includeKeywords: ['vps'] }), filters })
    )
    const s = stageOf(r, STAGE_FILTERS)
    expect(s.outcome).toBe('block')
    expect(s.detail).toContain('不在白名单')
    expect(r.wouldPush).toBe(false)
    // 后续阶段全部 skip（引擎：滤帖入 seen 不评估）
    for (const st of [STAGE_EXCLUDE, STAGE_RULES, STAGE_LITERAL, STAGE_SIMILARITY, STAGE_SEMANTIC]) {
      expect(stageOf(r, st).outcome).toBe('skip')
    }
  })

  it('作者黑名单命中 → block', () => {
    const r = runMatchTest(
      input({
        cfg: cfg({ includeKeywords: ['vps'] }),
        filters: { blockedAuthors: ['alice'] },
        topic: { author: 'Alice' }
      })
    )
    const s = stageOf(r, STAGE_FILTERS)
    expect(s.outcome).toBe('block')
    expect(s.detail).toContain('Alice')
    expect(r.wouldPush).toBe(false)
  })

  it('filters=undefined → 阶段 skip，不影响判定', () => {
    const r = runMatchTest(
      input({ cfg: cfg({ includeKeywords: ['vps'] }), title: 'vps 优惠' })
    )
    expect(stageOf(r, STAGE_FILTERS).outcome).toBe('skip')
    expect(r.wouldPush).toBe(true)
  })
})

/** 与 similarity.normalizeTitle 同口径的测试辅助（避免从被测模块间接断言实现） */
function normalize(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
}
