/**
 * 匹配测试台内核（R5-P2c）：把引擎对新帖的**判定管线**复刻成一条只读 trace，
 * 逐阶段给出 pass / block / skip / info 与 detail，并回答"这个标题会不会推送"。
 *
 * 定位与边界（务必读）：
 * - 纯函数、零 IO、零 electron 依赖（对齐 matcher.ts / rules.ts / filters.ts，ADR 2）。
 *   AI 档**不在此处调用**——调用方先调 evaluator 再把裁决（或不可评估原因）传入
 *   （semantic 入参），本模块只做判定与展示。
 * - 阶段顺序对齐 engine.pollSource 的真实管线（详见 engine.ts 的管线注释）：
 *   per-source 过滤（2）→ 排除词否决（5）→ 价格规则（6，命中即得、短路后续命中
 *   档）→ 字面（7）→ 相似降噪闸（8，作用于"若命中"的推送前检查）→ 语义（9）。
 *   与引擎的两处**有意**差异，均为"测试台是诊断工具"服务：
 *   1. 字面/语义档不受 matchMode 门控（cfg Pick 里也没有 matchMode）——用户在
 *      semantic-only 模式下也想看到字面档会怎么判；wouldPush 的语义不受影响
 *      （命中类通道任一 pass 即视为命中）。
 *   2. 相似闸在"若命中"假设下评估：即使当前没有任何命中通道 pass，也展示相似
 *      与否（引擎只在真命中后查相似）。
 * - wouldPush = 命中类阶段（价格规则 / 字面 / 语义过闸）任一 pass，且未被
 *   来源过滤、排除词、相似降噪任一 block。
 * - 不写 seen、不产生 HitRecord、不推送——engine 侧零感知，本模块只读。
 */
import { applySourceFilters } from './filters'
import { matchTopic } from './matcher'
import { evaluateRules, extractDeal } from './rules'
import { findSimilarTo, type SimilarityMatch } from './similarity'
import type { AppConfig, SourceFilters, Topic } from '../../shared/types'
import type { MatchStageResult, MatchTestResult } from '../../shared/ipc'

/**
 * 结果契约类型再导出（定义在 shared/ipc.ts 契约层——tsconfig.web 的 composite
 * 边界不允许 shared 反向 type-import 本文件；消费方从任一处导入都是同一类型）。
 */
export type { MatchStageResult, MatchTestResult }

/**
 * AI 档输入（调用方先调 evaluator 再传入）：
 * - 判决形态 {hit, score, reason}（SemanticVerdict 的结构子集）；
 * - 不可评估形态 {skipped: 原因}——AI 未配置 / 兴趣为空 / 调用失败 / 未决等，
 *   语义阶段按 skip 展示并把原因写进 detail（对任务规格 {hit,score,reason}
 *   形状的超集：调用方传判决形态时行为与规格完全一致）。
 */
export type SemanticTestInput =
  | { hit: boolean; score: number; reason: string | null }
  | { skipped: string }

/** runMatchTest 入参（cfg 为 Pick：测试台只消费这五段配置） */
export interface MatchTestInput {
  /** 待测标题（原文；相似检查内部自行归一化） */
  title: string
  /** 选中来源的 filters（无 = undefined：来源过滤阶段 skip） */
  filters?: SourceFilters
  cfg: Pick<AppConfig, 'excludeKeywords' | 'includeKeywords' | 'priceRules' | 'similarity' | 'ai'>
  /** 已归一化的近期已推标题（调用方从 hitsStore.readRecent 准备，契约同 findSimilarTo） */
  recentPushedTitles: string[]
  /** 可选：AI 档结果（见 SemanticTestInput） */
  semantic?: SemanticTestInput
  /**
   * 帖子分类/作者（per-source 过滤的判定输入）。测试台只有标题，无帖子元数据：
   * 调用方可选传入；缺省按"无分类、无作者"评估——来源配了分类白名单时会 block
   *（真实帖子无分类时的引擎行为一致），detail 会说明原因。
   */
  topic?: { category?: string; categorySlug?: string; author?: string }
  /**
   * 来源级全匹配（R13-2）：ipc 调用方传 resolveSourceMatching 的生效值。
   * true = 过闸标题直接命中（matchedBy='matchall'），字面/语义档按引擎同款
   * 短路展示为 skip。
   */
  matchAll?: boolean
}

/** 阶段标识常量（测试与消费方共用，防字符串漂移） */
export const STAGE_FILTERS = 'source-filters'
export const STAGE_EXCLUDE = 'exclude'
export const STAGE_RULES = 'rules'
export const STAGE_MATCHALL = 'matchall'
export const STAGE_LITERAL = 'literal'
export const STAGE_SIMILARITY = 'similarity'
export const STAGE_SEMANTIC = 'semantic'

/** 周期展示名（与 RulesCard 下拉同词表） */
const CYCLE_LABEL: Record<'yearly' | 'monthly', string> = { yearly: '年付', monthly: '月付' }

/** 合成最小 Topic（matchTopic / applySourceFilters 只读 title 与 category、author） */
function synthTopic(input: MatchTestInput): Topic {
  return {
    id: 'testbench',
    sourceId: 'testbench',
    title: input.title,
    url: '',
    author: input.topic?.author ?? '',
    category: input.topic?.category ?? '',
    categorySlug: input.topic?.categorySlug ?? '',
    pinned: false,
    lastActiveAt: null
  }
}

/** 排除词扫描（判定口径与 matcher.isExcluded 逐字相同；顺带收集命中词做 detail） */
function matchedExcludeWords(title: string, words: string[]): string[] {
  const lower = title.toLowerCase()
  const out: string[] = []
  for (const raw of words) {
    const kw = raw.trim().toLowerCase()
    if (kw.length === 0) continue
    if (lower.includes(kw)) out.push(raw.trim())
  }
  return out
}

/** 提取结果的可读摘要：`年付 · ¥99 · 流量 500G`；什么都提不到 → `无可提取交易信息` */
function describeDeal(title: string): string {
  const deal = extractDeal(title)
  if (deal === null) return '无可提取交易信息'
  const parts: string[] = []
  if (deal.cycle !== undefined) parts.push(CYCLE_LABEL[deal.cycle])
  if (deal.price !== undefined) {
    const symbol = deal.price.currency === 'CNY' ? '¥' : '$'
    parts.push(`${symbol}${deal.price.amount}`)
  }
  if (deal.trafficGB !== undefined) parts.push(`流量 ${deal.trafficGB}G`)
  return `提取: ${parts.join(' · ')}`
}

/** trim + 小写相等（filters.ts 的 norm 同口径，仅用于 block 原因的展示文案） */
/** 相似拦截明细里已推标题的展示截断（字符）：长标题截尾省略号，detail 保持可读 */
const SIMILAR_DETAIL_TITLE_MAX = 40

function clipTitle(s: string): string {
  return s.length <= SIMILAR_DETAIL_TITLE_MAX ? s : `${s.slice(0, SIMILAR_DETAIL_TITLE_MAX - 1)}…`
}

function eqIgnoreCase(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** 分类（显示名或 slug）是否命中列表（categoryMatches 同口径，展示用） */
function categoryInList(category: string, categorySlug: string, list: string[]): boolean {
  const hit = (v: string): boolean => v.trim() !== '' && list.some((item) => eqIgnoreCase(item, v))
  return hit(category) || hit(categorySlug)
}

/** 来源过滤 block 的具体原因（决策本身由 applySourceFilters 做出，这里只写文案） */
function filterBlockReason(topic: Topic, filters: SourceFilters): string {
  if (filters.includeCategories !== undefined && filters.includeCategories.length > 0) {
    const included = categoryInList(topic.category, topic.categorySlug, filters.includeCategories)
    if (!included) {
      const shown = topic.category !== '' ? topic.category : (topic.categorySlug !== '' ? topic.categorySlug : '无分类')
      return `分类「${shown}」不在白名单（测试台未提供帖子分类时按无分类处理）`
    }
  }
  if (categoryInList(topic.category, topic.categorySlug, filters.excludeCategories ?? [])) {
    return '分类命中黑名单'
  }
  const author = topic.author.trim()
  if (author !== '' && (filters.blockedAuthors ?? []).some((a) => eqIgnoreCase(a, author))) {
    return `作者「${topic.author}」命中黑名单`
  }
  return '命中过滤条件'
}

/**
 * 跑一次匹配测试。永不抛、不做 IO；对任意输入返回完整 stages（含防御路径：
 * 空标题按"字面/规则/语义都不可能命中"走常规评估——引擎里空标题同样只是
 * 不命中，没有特殊分支）。
 */
export function runMatchTest(input: MatchTestInput): MatchTestResult {
  const { title, cfg } = input
  const topic = synthTopic(input)
  const stages: MatchStageResult[] = []
  /** 管线已被一票否决（来源过滤/排除词）后的统一 skip 文案 */
  let dead: string | null = null
  /** 价格规则命中：短路后续命中类阶段（literal / semantic），相似闸照常评估 */
  let ruleHit = false
  /** 来源级全匹配命中（R13-2）：短路字面/语义档（价格规则优先保留归因） */
  let matchAllHit = false
  /** 命中类通道（规则/字面/语义过闸）是否任一 pass */
  let hitAny = false
  /** 相似降噪是否拦截 */
  let similarBlocked = false
  /** 相似命中的窗口条目明细（拦截时向用户展示"和哪条相似"） */
  let similarMatch: SimilarityMatch | null

  const push = (
    stage: string,
    label: string,
    outcome: MatchStageResult['outcome'],
    detail: string
  ): void => {
    stages.push({ stage, label, outcome, detail })
  }
  const pushSkip = (stage: string, label: string, reason: string): void => {
    push(stage, label, 'skip', `${reason}，本阶段不评估`)
  }

  // ---- 1. per-source 过滤（引擎管线第 2 步） -------------------------------
  if (input.filters === undefined) {
    push(STAGE_FILTERS, '来源过滤', 'skip', '未指定来源，或该来源未配置过滤')
  } else if (applySourceFilters(topic, input.filters)) {
    push(STAGE_FILTERS, '来源过滤', 'pass', '未命中来源过滤条件，放行')
  } else {
    dead = '已被来源过滤滤掉'
    push(STAGE_FILTERS, '来源过滤', 'block', `被来源过滤滤掉：${filterBlockReason(topic, input.filters)}（引擎不推送不评估）`)
  }

  // ---- 2. 排除词一票否决（第 5 步） ----------------------------------------
  if (dead !== null) {
    pushSkip(STAGE_EXCLUDE, '排除词', dead)
  } else {
    const words = matchedExcludeWords(title, cfg.excludeKeywords)
    if (words.length > 0) {
      dead = '被排除词否决'
      push(STAGE_EXCLUDE, '排除词', 'block', `命中排除词：${words.join('、')}（优先级最高，不推送）`)
    } else {
      push(
        STAGE_EXCLUDE,
        '排除词',
        'pass',
        cfg.excludeKeywords.length === 0 ? '未配置排除词' : `未命中排除词（共 ${cfg.excludeKeywords.length} 个）`
      )
    }
  }

  // ---- 3. 价格规则（第 6 步；命中即得，短路后续命中档） ----------------------
  if (dead !== null) {
    pushSkip(STAGE_RULES, '价格规则', dead)
  } else {
    // 引擎同款短路：无规则时跳过逐标题的正则提取
    const ruleMatch = cfg.priceRules.length > 0 ? evaluateRules(title, cfg.priceRules) : null
    if (ruleMatch !== null) {
      ruleHit = true
      hitAny = true
      push(STAGE_RULES, '价格规则', 'pass', `命中规则「${ruleMatch.label}」· ${describeDeal(title)}`)
    } else {
      push(
        STAGE_RULES,
        '价格规则',
        'info',
        `${cfg.priceRules.length === 0 ? '未配置价格规则' : '未命中价格规则'} · ${describeDeal(title)}`
      )
    }
  }

  // ---- 3.5 来源级全匹配（R13-2 第 6.5 步，价格规则之后） --------------------
  if (dead !== null) {
    pushSkip(STAGE_MATCHALL, '全匹配', dead)
  } else if (ruleHit) {
    pushSkip(STAGE_MATCHALL, '全匹配', '价格规则已命中（引擎同款短路，保留规则归因）')
  } else if (input.matchAll === true) {
    matchAllHit = true
    hitAny = true
    push(STAGE_MATCHALL, '全匹配', 'pass', '该来源已开启全匹配：过闸新帖直接命中（字面/语义档跳过；排除词与来源过滤仍否决）')
  } else {
    push(STAGE_MATCHALL, '全匹配', 'info', '未开启（该来源未设置全匹配覆盖）')
  }

  // ---- 4. 字面匹配（第 7 步） ----------------------------------------------
  if (dead !== null) {
    pushSkip(STAGE_LITERAL, '字面匹配', dead)
  } else if (ruleHit) {
    pushSkip(STAGE_LITERAL, '字面匹配', '价格规则已命中（引擎同款短路，只记一种命中方式）')
  } else if (matchAllHit) {
    pushSkip(STAGE_LITERAL, '字面匹配', '全匹配已命中（引擎同款短路，字面档跳过）')
  } else {
    const { matched, matchedKeywords } = matchTopic(topic, cfg.includeKeywords, cfg.excludeKeywords)
    if (matched) {
      hitAny = true
      push(STAGE_LITERAL, '字面匹配', 'pass', `命中包含词：${matchedKeywords.join('、')}`)
    } else {
      push(
        STAGE_LITERAL,
        '字面匹配',
        'info',
        cfg.includeKeywords.length === 0
          ? '未配置包含关键词（字面档永不命中——防通知风暴）'
          : `未命中包含关键词（共 ${cfg.includeKeywords.length} 个）`
      )
    }
  }

  // ---- 5. 相似降噪闸（第 8 步；作用于"若命中"，对全部命中方式生效） -----------
  if (dead !== null) {
    pushSkip(STAGE_SIMILARITY, '相似降噪', dead)
  } else if (!cfg.similarity.enabled) {
    push(STAGE_SIMILARITY, '相似降噪', 'skip', '相似降噪已关闭')
  } else if (
    (similarMatch = findSimilarTo(title, input.recentPushedTitles, cfg.similarity.threshold)) !==
    null
  ) {
    similarBlocked = true
    push(
      STAGE_SIMILARITY,
      '相似降噪',
      'block',
      `与近期已推标题相似（相似度 ${similarMatch.score.toFixed(2)} ≥ 阈值 ${cfg.similarity.threshold}）：` +
        `「${clipTitle(similarMatch.title)}」——即使命中也不推送（48h 已推窗口的防重复语义；` +
        `测试台在推送之后回测同帖会与它自己相似，属正常）`
    )
  } else {
    push(
      STAGE_SIMILARITY,
      '相似降噪',
      'pass',
      input.recentPushedTitles.length === 0
        ? '近期已推窗口为空，不会因相似被抑制'
        : `与近期 ${input.recentPushedTitles.length} 条已推标题不相似（阈值 ${cfg.similarity.threshold}）`
    )
  }

  // ---- 6. 语义评估（第 9 步；置信度过闸 = R5-P2b） ---------------------------
  if (dead !== null) {
    pushSkip(STAGE_SEMANTIC, '语义评估', dead)
  } else if (ruleHit) {
    pushSkip(STAGE_SEMANTIC, '语义评估', '价格规则已命中（引擎同款短路，不进 AI 批）')
  } else if (matchAllHit) {
    pushSkip(STAGE_SEMANTIC, '语义评估', '全匹配已命中（引擎同款短路，不进 AI 批）')
  } else if (input.semantic === undefined) {
    push(STAGE_SEMANTIC, '语义评估', 'skip', '未调用 AI 评估（未勾选或调用前置条件不满足）')
  } else if ('skipped' in input.semantic) {
    push(STAGE_SEMANTIC, '语义评估', 'skip', `AI 评估不可用：${input.semantic.skipped}`)
  } else {
    const verdict = input.semantic
    const threshold = cfg.ai.semanticThreshold
    if (verdict.hit && verdict.score >= threshold) {
      hitAny = true
      push(
        STAGE_SEMANTIC,
        '语义评估',
        'pass',
        `AI 判定相关：score ${verdict.score} ≥ 阈值 ${threshold}` +
          (verdict.reason != null ? ` · ${verdict.reason}` : '')
      )
    } else if (verdict.hit) {
      push(
        STAGE_SEMANTIC,
        '语义评估',
        'block',
        `AI 判定相关但置信度不足：score ${verdict.score} < 阈值 ${threshold}（不推送）`
      )
    } else {
      push(
        STAGE_SEMANTIC,
        '语义评估',
        'block',
        `AI 判定不相关${verdict.reason != null ? `：${verdict.reason}` : ''}`
      )
    }
  }

  return { wouldPush: hitAny && !similarBlocked && dead === null, stages }
}
