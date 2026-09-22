/**
 * 全局数据契约（v2）—— 主进程、渲染进程、headless 脚本共用。
 * 改这个文件必须同步核对所有消费方（engine / desktop / renderer / scripts）。
 *
 * v2 变更（2026-09-19，多论坛化 + AI 能力）：
 * - AppConfig 增加 sources（论坛来源列表，v2 仅 nodeseek）与 ai 段（LLM Provider/语义监控/日报）。
 * - Topic/来源解耦：Topic.sourceId 标记来源；去重键由 engine 组装为 `${sourceId}:${topic.id}`。
 * - EngineStatus 增加 per-source 状态与 AI 运行态。
 * - HitRecord 增加 matchedBy（literal/semantic）与 AI 判定理由。
 *
 * 第三轮变更（2026-09-19，AI 锐评）：
 * - AiConfig 增加 commentary（锐评开关，**默认开**——当时是唯一默认开的布尔；
 *   第五轮 similarity.enabled 加入后，默认开布尔共两个，见 AppConfig.similarity）。
 * - HitRecord 增加可选 commentary：旧 hits/*.jsonl 行没有此字段，类型必须容忍缺失；
 *   新写入的记录一律给 string|null（生成失败/未启用时为 null），不再留 undefined。
 *
 * v3 变更（2026-09-19，多论坛化第二轮：config 契约）：
 * - SourceType 从单一 'nodeseek' 扩为 'nodeseek' | 'rss' | 'v2ex'。
 * - SourceConfig 改为按 type 判别的联合：rss 额外必带 url（合法 http(s)）、
 *   可选 label；三种来源都可带可选 filters（per-source 过滤契约，本轮只定义
 *   契约与 sanitize，引擎消费在下一轮）。
 * - DEFAULT_APP_CONFIG.sources 不变（仍只有 nodeseek 一项，不带 filters）。
 *
 * 第五轮变更（2026-09-19，R5：价格规则 + 相似帖降噪 + 语义置信度）：
 * - 全部为**加法字段**，不 bump schemaVersion（commentary.enabled 先例）。
 * - AppConfig 增加 priceRules（PriceRuleConfig[]，默认 []；规则命中即第三种命中
 *   方式 matchedBy='rule'）与 similarity（相似帖降噪，**默认开**，阈值 0.72；
 *   48h 对比窗口是引擎侧常量，不进配置）。
 * - ai 增加 semanticThreshold（默认 0 = 行为不变；0-1 置信度阈值）。
 * - HitRecord.matchedBy 扩为 literal|semantic|rule；新增可选 matchedRule
 *   （旧 hits/*.jsonl 行容忍缺失，对齐 commentary 的三态注释风格）。
 * - SourceStatus 增加可选 page2Fetches（DEC-8 第 2 页补抓观测面，旧快照缺失=0）。
 *
 * 第六轮变更（2026-09-19，R6-W1：推送通道化契约改造，DEC-9）：
 * - AppConfig **移除 telegram 段**，新增 channels（ChannelConfig[] 判别联合：
 *   telegram/bark/ntfy/webhook；本轮只有 telegram 有发送实现，bark/ntfy/webhook
 *   是 W2 的契约占位）、notify（instant/digest 模式 + 免打扰时段；W1-queue 消费）
 *   与 routing（RoutingRule[]；W3 消费）。三者均为**加法字段**，schemaVersion 仍 3
 *   ——盘上兼容由 migrations.normalizeLegacyChannels 读侧映射（旧 telegram 凭据
 *   → channels[0]），写路径只写新形状（sanitize 重建时旧 telegram 键自然消失）。
 * - TelegramConfig 类型保留导出：仅 migrations/notify 读兼容与凭据访问器复用。
 * - HitRecord 增加可选 notifyDetail（per-channel 推送明细，键=channelId；W3
 *   router 落盘，本轮 engine 单 notifier 仍写 notifiedAt/notifyError 聚合口径）。
 *
 * R8-A 变更（2026-09-19，E2 引擎看门狗 + E3 Cloudflare B 计划）：
 * - EngineStatus 增加可选 watchdog（runtime 层附加的看门狗观测面，engine 不写；
 *   INITIAL 补默认 { lastTriggeredAt: null, count: 0 }，旧快照读者容忍缺失）。
 * - （E3 的能力声明在 src/main/monitor/types.ts 的 SourceAdapter 上，不在此文件。）
 *
 * R9-W1 变更（2026-09-19，DEC-6 Telegram bot 双向遥控）：
 * - NotifyConfig 增加 remoteControl（enabled + allowedChatIds，默认关/空列表）：
 *   加法字段，不 bump schemaVersion；sanitize 见 store.ts sanitizeNotify。
 *
 * R13 变更（2026-09-21，per-source 匹配覆盖 + LowEndTalk Offers 预设）：
 * - 三种 SourceConfig 各加可选 `matching?: SourceMatchingConfig`（与 filters?
 *   并列；五个**全可选**字段，字段级回退全局——未设置/清洗后空数组不落键 =
 *   未覆盖 = 跟随全局同名配置）。**加法字段，不 bump schemaVersion**（R5 先例），
 *   盘上兼容由 load 的 merge DEFAULT + sanitize 兜底。
 * - 生效配置统一走 src/main/monitor/matching.ts 的 resolveSourceMatching 纯函数
 *   （引擎 pollSource 与 ipc 诊断面共用，防两处口径分叉）。
 * - 「显式清空包含词仍开字面档」**不可表达**——该意图用 matchMode:'semantic'
 *   表达（literalActive=false，字面档整体跳过）；排除词同理无法表达「该来源
 *   不排除」。契约细节见 SourceMatchingConfig 注释与 docs/usage.md。
 *
 * R13-2 变更（2026-09-21，来源级全匹配）：
 * - SourceMatchingConfig 增加可选 `matchAll?: boolean`（未设置 = 不全匹配）：
 *   开启后该来源过闸新帖**直接命中**（matchedBy='matchall'），字面/语义档整体
 *   跳过；价格规则仍先评估（命中记 'rule'，保留规则归因与路由能力）。四道闸
 *   （来源过滤/旧帖阈值/置顶/排除词）与相似降噪**照常生效**——全匹配 ≠ 全推送。
 * - HitRecord.matchedBy 扩为四档（+ 'matchall'）：旧 hits/*.jsonl 行不可能有
 *   该值，消费方枚举分支缺省即可；RoutingWhen.matchedBy / queryHits 过滤同步扩。
 *   加法字段，不 bump schemaVersion（R13 先例）。
 *
 * R13-3 变更（2026-09-21，语义评估节流与降级）：
 * - AiRuntimeStatus.degraded 扩 'backoff'（语义评估连续失败 → 指数退避冷却，
 *   冷却期零调用防重试风暴）+ 可选 semanticCooldownUntil（ISO 截止时刻）。
 * - 未决帖轮次上限（引擎常量 5 轮）：超限按「降级字面判定」收口（镜像
 *   Provider 未配置的整体降级语义）——命中即推、未中入 seen，防未决帖
 *   无限重评与滚出首页静默丢失。
 *
 * R17 变更（2026-09-21，分类阶段报告 Stage A）：
 * - 新增 TopicRecord（全量话题存档行，<userData>/topics/YYYY-MM-DD.jsonl）：
 *   engine 在 unseen 循环顶部把每个观察到的新帖（不论命中/被滤/置顶/被排除）
 *   落档一次——分类报告的数据底座，与 HitRecord（仅命中）/disposition（仅 7 天
 *   观测）互补。**加法类型，不改既有形状**。
 * - AiConfig 增加 categoryReport: CategoryReportConfig（分类日/周/月报开关，
 *   **enabled 一律默认 false**——对齐 dailyReport 先例，老用户升级不突增推送；
 *   周报固定周一生成上一完整周、月报固定 1 日生成上一自然月，不设 weekday
 *   配置）。**加法字段，不 bump schemaVersion**（R13 先例）：盘上兼容由
 *   load 的 merge DEFAULT + sanitize 兜底，migrations.ts 零改动。
 */

/** 论坛来源类型（v3 起：nodeseek SSR / 通用 RSS / V2EX） */
export type SourceType = 'nodeseek' | 'rss' | 'v2ex'

/**
 * per-source 过滤契约（v3 定义，引擎消费在下一轮）。
 *
 * 语义：
 * - `includeCategories` 非空 = 分类白名单：帖子的分类**显示名或 slug** 命中任一
 *   才算候选（大小写不敏感）；为空/缺失 = 不限分类。
 * - `excludeCategories` = 分类黑名单：命中任一直接否决（与 include 同时给出时
 *   exclude 优先，对齐全局 excludeKeywords 的一票否决风格）。
 * - `blockedAuthors` = 作者黑名单：作者名命中任一（大小写不敏感）一票否决。
 * - 所有匹配值为字面字符串（非正则/通配）。
 */
export interface SourceFilters {
  /** 分类白名单（空 = 不限）；匹配分类显示名或 slug，大小写不敏感 */
  includeCategories?: string[]
  /** 分类黑名单；命中任一否决 */
  excludeCategories?: string[]
  /** 作者黑名单；命中任一一票否决 */
  blockedAuthors?: string[]
}

/**
 * per-source 匹配覆盖契约（R13，字段级回退全局）。
 *
 * 语义：五个字段**全可选**——未设置（或 sanitize 清洗后空数组不落键）= 未覆盖
 * = 跟随全局同名配置（AppConfig.includeKeywords / ai.matchMode 等）。
 * 引擎消费经 matching.ts 的 resolveSourceMatching 解析为生效值（与 ipc 诊断面
 * 共用同一实现）。
 *
 * **不可表达的意图（务必读）**：
 * - 「显式清空包含词（该来源字面档永不命中）」无法用 includeKeywords: []
 *   表达——sanitize 空数组不落键 = 回退全局。该意图用 matchMode:'semantic'
 *   表达（此时字面档整体跳过，见 engine 的 literalActive 派生）。
 * - 排除词同理无法表达「该来源不排除」——只能靠全局列表里不放该词。
 *
 * 覆盖是**替换**不是合并：includeKeywords/excludeKeywords/interests 设置后
 * 完全替换全局同名列表。价格规则与 AI 锐评**不参与**覆盖（恒用全局配置）。
 *
 * R13-2：`matchAll: true` = 来源级全匹配——该来源过闸新帖直接命中
 * （matchedBy='matchall'），字面/语义档与其余覆盖字段全部跳过（UI 侧开启时
 * 置灰其余覆盖项）；价格规则仍先评估（命中记 'rule'）；排除词/来源过滤/
 * 旧帖/置顶/相似降噪照常否决。典型用法：LowEndTalk Offers 来源开全匹配，
 * 所有 offers 新帖全推（对齐参考项目的"全部推送"行为）。
 */
export interface SourceMatchingConfig {
  /** 包含词覆盖（空 = 未覆盖，跟随全局；设置后**替换**全局列表） */
  includeKeywords?: string[]
  /** 排除词覆盖（空 = 未覆盖，跟随全局；设置后**替换**全局列表，一票否决） */
  excludeKeywords?: string[]
  /** 匹配模式覆盖（未设置 = 跟随全局 ai.matchMode；Provider 未配置时仍整体降级字面） */
  matchMode?: MatchMode
  /** 兴趣描述覆盖（空 = 未覆盖，跟随全局；sanitize 同全局口径 20 条 / 500 字） */
  interests?: string[]
  /** 语义置信度阈值覆盖（未设置 = 跟随全局 ai.semanticThreshold；范围 [0,1]） */
  semanticThreshold?: number
  /**
   * 来源级全匹配（R13-2）：true = 该来源过闸新帖直接命中（matchedBy='matchall'），
   * 字面/语义档与 matchMode/includeKeywords/interests/semanticThreshold 覆盖全部
   * 跳过；价格规则先评估（命中记 'rule'）。sanitize 仅 true 落键（false/非法 = 不落键）。
   */
  matchAll?: boolean
}

/** NodeSeek 来源（SSR HTML 抓取，现有主路径） */
export interface NodeseekSourceConfig {
  /** 稳定 slug；与去重键前缀、状态键一致 */
  id: string
  type: 'nodeseek'
  enabled: boolean
  /** per-source 过滤（可选，见 SourceFilters 语义） */
  filters?: SourceFilters
  /** per-source 匹配覆盖（可选，见 SourceMatchingConfig 语义；R13） */
  matching?: SourceMatchingConfig
}

/** V2EX 来源 */
export interface V2exSourceConfig {
  /** 稳定 slug；与去重键前缀、状态键一致 */
  id: string
  type: 'v2ex'
  enabled: boolean
  /** per-source 过滤（可选，见 SourceFilters 语义） */
  filters?: SourceFilters
  /** per-source 匹配覆盖（可选，见 SourceMatchingConfig 语义；R13） */
  matching?: SourceMatchingConfig
}

/** 通用 RSS 来源 */
export interface RssSourceConfig {
  /** 稳定 slug；与去重键前缀、状态键一致。sanitize 保证合法 http(s) URL 且有 host */
  id: string
  type: 'rss'
  enabled: boolean
  /** RSS feed 地址（合法 http(s) URL，sanitize 非法则整项丢弃） */
  url: string
  /** 展示名（可选；sanitize trim、空则视为无） */
  label?: string
  /** per-source 过滤（可选，见 SourceFilters 语义） */
  filters?: SourceFilters
  /** per-source 匹配覆盖（可选，见 SourceMatchingConfig 语义；R13） */
  matching?: SourceMatchingConfig
}

/** 一个已配置的论坛来源（判别联合：按 type 分派，rss 额外带 url） */
export type SourceConfig = NodeseekSourceConfig | V2exSourceConfig | RssSourceConfig

/** OpenAI 兼容 LLM Provider 配置（DeepSeek / Kimi / GLM / OpenAI 等通用） */
export interface AiProviderConfig {
  /** 如 https://api.deepseek.com/v1（sanitize 会去尾斜杠；请求时拼 /chat/completions） */
  baseUrl: string
  apiKey: string
  model: string
}

/** 匹配模式：仅字面 / 仅语义 / 两者叠加（literal OR semantic） */
export type MatchMode = 'literal' | 'semantic' | 'both'

/**
 * 分类阶段报告配置（R17）：按分类（默认情报/交易/测评）对**全量话题存档**
 * （topics/*.jsonl，见 TopicRecord）做日/周/月三档 AI 总结。
 *
 * - 与 ai.dailyReport **并存不替代**：日报=命中监控报告（数据面 hits/，监控
 *   视角）；本报告=分类行情报告（数据面 topics/ 存档，行情视角）。开关、
 *   文件、数据底座全部独立。
 * - enabled 一律 `=== true` 才开（默认全关）——对齐 dailyReport 先例，老用户
 *   升级不突增推送；timeHHMM 默认错峰（22:30 / 08:00 / 08:30）避免与现有
 *   日报 22:00 同刻争 LLM。
 * - 周报固定**周一**生成上一完整周（周一~周日）；月报固定**每月 1 日**生成
 *   上一自然月——生成期恒为"刚结束的那个完整周期"，不设 weekday 配置
 *   （无语义增益只增边界）。
 * - 目标时刻过后的当期内补做语义：文件缺失且 attempts 未耗尽仍触发（睡过头
 *   的机器次日凌晨仍补做上月月报），见 category-report.ts 的 tick。
 */
export interface CategoryReportConfig {
  /** 功能总开关（三档总闸；false 时到点不生成不消耗 attempts） */
  enabled: boolean
  /**
   * 参与统计的来源 id（须存在于 sources，悬挂由 sanitize 剔除）。
   * **空 = 不按来源过滤（全部来源）**——sanitize 不回退 nodeseek（对只配
   * RSS/V2EX 的用户，回退是悬挂 id，报告恒零帖）；查询侧同样把空当不过滤。
   */
  sourceIds: string[]
  /** 参与统计的分类（匹配显示名或 slug，大小写不敏感；上限 10） */
  categories: string[]
  /** 报告文件是否附「附录·全量帖子清单」（推送恒不带附录，防月报刷屏） */
  appendix: boolean
  daily: {
    enabled: boolean
    /** 'HH:MM' 本地时区（生成当天报告的目标时刻） */
    timeHHMM: string
  }
  weekly: {
    enabled: boolean
    /** 'HH:MM' 本地时区（周一生成上一完整周的目标时刻） */
    timeHHMM: string
  }
  monthly: {
    enabled: boolean
    /** 'HH:MM' 本地时区（每月 1 日生成上一自然月的目标时刻） */
    timeHHMM: string
  }
}

export interface AiConfig {
  provider: AiProviderConfig
  matchMode: MatchMode
  /** 自然语言兴趣描述（语义监控用；为空时语义档永不命中——镜像字面档防风暴规则） */
  interests: string[]
  /**
   * 语义命中置信度阈值（第五轮）：AI 评估给出的置信度低于此值不判命中。
   * 默认 0 = 行为不变（不过滤）；取值 [0,1]，sanitize 非法回 0、越界钳制。
   */
  semanticThreshold: number
  /**
   * 语义未决时间窗（分钟，R15）：评估失败/未决的帖子在该窗口内持续重评；
   * 超窗仍无裁决 → 降级字面判定收口（防无限重评，也防"轮数上限在快轮询下
   * 过激"——30s 轮询 × 5 轮 = 2.5 分钟就把语义候选静默丢弃的旧事故）。
   * 加法字段不 bump schemaVersion（commentary.enabled 先例），旧配置缺失 → 30，
   * sanitize 钳到 [1,1440]。
   */
  semanticUndecidedTimeoutMin: number
  /** AI 每日总结 */
  dailyReport: {
    enabled: boolean
    /** 'HH:MM' 本地时区 */
    timeHHMM: string
  }
  /**
   * AI 锐评（第三轮）：命中帖推送前让 LLM 附一句点评。
   * 配置里恒存在（默认/ sanitize 保证）；enabled 是**默认开的布尔**之一
   * （另一个是 similarity.enabled，见 store.ts sanitizeAi / sanitizeSimilarity
   * 的书写约定），UI 侧直接读 cfg.ai.commentary.enabled。
   */
  commentary: {
    enabled: boolean
    /**
     * 锐评是否允许模型思考（R12）：推理型模型（如智谱 GLM）的思考 token 与
     * 正文共用 max_tokens 产出预算——开启更慢，且思考吃光预算时正文为空
     * （R11 事故主因）。**默认 false = 直出模式**：请求附 thinking 禁用参数、
     * 预算降 200、失败自动重试一次。加法字段不 bump schemaVersion
     * （commentary.enabled 先例），旧配置缺失 → false（新默认行为）。
     * 仅对支持思考参数的服务（智谱 GLM 系）生效，其余供应商该参数不下发。
     */
    useThinking: boolean
  }
  /**
   * 语义评估调用选项（R15，对齐 commentary 的形态）：useThinking **默认 false
   * = 直出模式**——评估是短 JSON 判定任务，请求附 thinking 禁用参数（推理型
   * 模型的思考 token 与正文共用产出预算且显著拉长延迟，是批量评估超时的
   * 主因之一）。仅对支持思考参数的服务生效，其余供应商该参数不下发/忽略。
   * 加法字段不 bump schemaVersion，旧配置缺失 → false（新默认行为）。
   */
  evaluation: {
    useThinking: boolean
  }
  /**
   * 分类阶段报告（R17）：见 CategoryReportConfig。加法字段不 bump
   * schemaVersion（R13 先例）；旧配置缺失 → sanitize 补全默认段（全关）。
   */
  categoryReport: CategoryReportConfig
}

/** 价格周期 */
export type PriceCycle = 'yearly' | 'monthly' | 'any'
/** 币种（'any' 不过滤币种） */
export type PriceCurrency = 'CNY' | 'USD' | 'any'
/**
 * 一条结构化价格规则（第五轮契约，引擎消费在 R5 后续包）：
 * 条件之间 AND；命中即作为第三种命中方式（matchedBy='rule'）。
 */
export interface PriceRuleConfig {
  /** 规则 id（slug 化、全列表去重，见 store.ts sanitizePriceRules） */
  id: string
  /** 展示名（可选；sanitize trim、空则不落键） */
  label?: string
  enabled: boolean
  cycle: PriceCycle
  /** 标题提取出的价格上限（数值；与币种配合） */
  maxPrice?: number
  currency?: PriceCurrency
  /** 标题提取出的流量下限（GB） */
  minTrafficGB?: number
  /** 标题需包含任一关键词（空=不限）——AND 前置条件 */
  keywords?: string[]
}

/** 一条论坛帖子（从来源帖子列表解析出的字段） */
export interface Topic {
  /** 帖子 id（如 NodeSeek 的 "936634"）；全局唯一键 = `${sourceId}:${id}` */
  id: string
  /** 来源 id，由 engine 在处理时盖上（adapter 不感知） */
  sourceId: string
  title: string
  /** 绝对链接，如 https://www.nodeseek.com/post-936634-1 */
  url: string
  author: string
  /** 分类显示名，如 "交易" */
  category: string
  /** 分类 slug，如 "trade" */
  categorySlug: string
  /** 是否置顶（置顶帖是旧帖，监控默认跳过） */
  pinned: boolean
  /** 最近活跃时间（ISO 字符串，来自 <time datetime>，是最后回复时间而非发帖时间） */
  lastActiveAt: string | null
  /**
   * 帖子摘要（纯文本：已剥 HTML 标签、压缩空白、截断）。**可选**：RSS
   * description / V2EX content 能提供，nodeseek 列表页没有——无摘要的来源不写
   * 该键。随 Topic 进 HitRecord/hits jsonl 落盘：**旧记录没有此字段，消费方必须
   * 容忍 undefined**（等价"无摘要"，与 matchedRule 可选字段同款约定）；推送文案
   * （telegram 的 📄 摘要行）按缺省省略。
   */
  excerpt?: string
  /**
   * 发帖人个人主页链接（issue #2 建议一）。**可选**：nodeseek 列表页作者锚点
   * （/space/{id}）与 V2EX member（/member/{username}）能提供，RSS 一般没有——
   * 无链接的来源/旧记录不写该键，**消费方必须容忍 undefined**（与 excerpt 同款
   * 约定）；推送文案（telegram 的 👤 作者行）按缺省退化为纯文本作者名。
   */
  authorUrl?: string
}

/**
 * 全量话题存档行（R17 分类报告的数据底座）：engine 在 unseen 处理链（W3 旧帖
 * 判定之后）把每个观察到的新帖（命中/未中/被滤/置顶/被排除**全部**；被 id 阈值
 * 吞并的回复顶起旧帖除外——unseen ≠ 新发帖）落档一次，存
 * `<userData>/topics/YYYY-MM-DD.jsonl`（本地时区日分桶，35 天保留）。
 *
 * 与 Topic 的关系：Topic 是**单轮页面快照**（每轮重复出现），TopicRecord 是
 * **首次观察的存档事实**（键 `${sourceId}:${topicId}` 进程内/跨重启只落一行，
 * 读侧再按 key 去重首见优先兜底 seen 环淘汰后的重档）。lastActiveAt/excerpt
 * 等 Topic 可选/可空字段在此保持同款形态；firstSeenAt 是存档时刻（ISO），
 * 报告附录的 HH:MM 展示以它为准（lastActiveAt 是最后回复时间，非观察时刻）。
 */
export interface TopicRecord {
  /** 全局去重键 `${sourceId}:${topicId}`（engine seenKeyFor 同口径） */
  key: string
  sourceId: string
  topicId: string
  title: string
  url: string
  author: string
  /** 分类显示名（如 "交易"）；来源解析失败时可能为空串 */
  category: string
  /** 分类 slug（如 "trade"） */
  categorySlug: string
  /** 置顶标记（置顶=旧帖，随档落存；报告侧默认排除并注明） */
  pinned: boolean
  /** 最近活跃时间（ISO，来自页面；可能为 null——沿用 Topic 的可空语义） */
  lastActiveAt: string | null
  /** 摘要（可选：RSS/V2EX 来源有，nodeseek 列表页没有；与 Topic.excerpt 同款约定） */
  excerpt?: string
  /** 首次被引擎观察到的时刻（ISO，存档写入时刻） */
  firstSeenAt: string
  /**
   * 归属本地日 'YYYY-MM-DD'（R17 评审修复：**写入时刻已固化的本地时区日**，
   * formatLocalDate 口径）。**可选**：早期行没有此字段，消费方必须容忍缺失
   * （等价"按 firstSeenAt 重算"，与 matchedRule 等可选字段同款约定）；新写入
   * 的记录一律给值。读取/统计侧优先用本字段（dayOfRecord）——写入后系统改
   * 时区时，历史记录不会按新时区重算进别的日桶（日桶文件名按写入时 TZ 定，
   * 统计若按读取时 TZ 重算会与之漂移）。
   */
  day?: string
}

/** 命中记录：一个新帖命中（字面、语义、价格规则或来源级全匹配）并（尝试）推送 */
export interface HitRecord {
  topic: Topic
  /** 字面命中的包含词；matchedBy 非 'literal' 时为空数组 */
  matchedKeywords: string[]
  /**
   * 命中方式（R13-2 起四档：字面 / 语义 / 价格规则 / 来源级全匹配）。
   * 'matchall' 仅来自 SourceMatchingConfig.matchAll（旧 hits/*.jsonl 行不可能
   * 有该值，消费方枚举分支缺省容错）。
   */
  matchedBy: 'literal' | 'semantic' | 'rule' | 'matchall'
  /** AI 的一句话判定理由（matchedBy='semantic' 时给出，可能为 null） */
  semanticReason: string | null
  /**
   * 命中的价格规则 id/label（matchedBy='rule' 时给出）。**可选**：旧 hits/*.jsonl
   * 行没有此字段，消费方必须容忍 undefined（等价"非规则命中"）；新写入的记录一律给
   * string|null——非规则命中时为 null，规则命中时为规则的 id（无 label）或 label。
   * 展示语义字段：**路由不读它**（router 的 when.ruleId 按规则 id 匹配，推送链路
   * 的规则 id 在 HitMessageInput.matchedRuleId，不进 HitRecord）。
   */
  matchedRule?: string | null
  /**
   * AI 锐评正文（第三轮）。**可选**：旧 hits/*.jsonl 行没有此字段，消费方必须容忍
   * undefined（等价于"无锐评"）；新写入的记录一律给 string|null——生成失败/未启用/
   * Provider 未配置时为 null，成功时为锐评文本。
   */
  commentary?: string | null
  /** 推送时间 ISO；推送失败时为 null */
  notifiedAt: string | null
  /** 推送失败原因（notifiedAt 为 null 时给出；静音时为 null） */
  notifyError: string | null
  /**
   * per-channel 推送明细（第六轮 R6-W1 契约，W3 router 落盘）：键 = channelId，
   * 值 = 该通道的推送结果。**可选**：旧 hits/*.jsonl 行没有此字段，消费方必须容忍
   * undefined（等价"无明细"）；单 notifier 时代聚合口径仍是上方 notifiedAt /
   * notifyError 两字段，本字段在 W3 多通道并发推送后由 router 写入。
   */
  notifyDetail?: Record<string, { ok: boolean; error?: string }>
}

/** 代理作用域：仅 Telegram 走代理，还是所有请求都走代理（AI 请求在 'all' 时走代理、'telegram-only' 时直连） */
export type ProxyScope = 'all' | 'telegram-only'

/**
 * 旧版 telegram 凭据形状（R6-W1 前的 AppConfig.telegram）。
 * **不再出现在 AppConfig 上**：仅为 migrations 的读兼容映射与 TelegramNotifier
 * 的凭据访问器保留此形状（notify/telegram.ts 的 getConfig 返回值）。
 */
export interface TelegramConfig {
  botToken: string
  chatId: string
}

/** 推送通道类型（R6-W1：telegram 有实现；bark/ntfy/webhook 为 W2 契约占位） */
export type ChannelType = 'telegram' | 'bark' | 'ntfy' | 'webhook'

/** Telegram Bot 推送通道 */
export interface TelegramChannelConfig {
  /** 通道 id（slug 化、全列表去重；notifyDetail 明细键） */
  id: string
  type: 'telegram'
  enabled: boolean
  botToken: string
  chatId: string
}

/** Bark 推送通道（iOS） */
export interface BarkChannelConfig {
  id: string
  type: 'bark'
  enabled: boolean
  /** 自建服务器 base，默认官方 https://api.day.app（缺省=官方，由 W2 发送端兜底） */
  serverUrl?: string
  deviceKey: string
}

/** ntfy 推送通道 */
export interface NtfyChannelConfig {
  id: string
  type: 'ntfy'
  enabled: boolean
  /** 默认 https://ntfy.sh（缺省=官方，由 W2 发送端兜底） */
  serverUrl?: string
  topic: string
}

/** Webhook 推送通道 */
export interface WebhookChannelConfig {
  id: string
  type: 'webhook'
  enabled: boolean
  url: string
  /** 随请求发送的自定义鉴权头值（头名固定 X-ForumWatch-Secret） */
  secret?: string
}

/** 一个已配置的推送通道（判别联合：按 type 分派） */
export type ChannelConfig =
  | TelegramChannelConfig
  | BarkChannelConfig
  | NtfyChannelConfig
  | WebhookChannelConfig

/** 推送节流模式（R6-W1 契约；digest 由 W1-queue 消费，当前仅 instant 生效） */
export interface NotifyConfig {
  /** 'instant' 命中即推（现行行为）；'digest' 聚合摘要推 */
  mode: 'instant' | 'digest'
  /** digest 聚合间隔（分钟）；sanitize 钳 [1,120]，默认 15 */
  digestIntervalMin: number
  /** 免打扰时段（本地时区，跨午夜合法；W1-queue 消费，当前仅契约） */
  quietHours: {
    enabled: boolean
    /** 'HH:MM' 起点 */
    startHHMM: string
    /** 'HH:MM' 终点 */
    endHHMM: string
  }
  /**
   * Telegram 遥控（R9-W1，DEC-6）：经 bot 的 getUpdates 长轮询接收指令
   * （/status /pause /resume /poll /help），实现双向遥控。默认关闭。
   * 就绪条件 = enabled 且存在就绪 telegram 通道（凭据齐备）；允许清单外的会话
   * 一律静默忽略（硬闸，不回复）；主 Chat ID（第一个就绪 telegram 通道的 chatId）
   * 隐含允许。注意：启用后本应用独占该 bot 的 getUpdates——其他工具轮询同一
   * bot 会互相 409（坑8）。
   */
  remoteControl: {
    enabled: boolean
    /** 允许发指令的额外 Chat ID（字符串原样，可含负数群 id；主 chatId 隐含在内） */
    allowedChatIds: string[]
  }
}

/** 路由规则的匹配条件（W3 router 消费；全部字段可选，空 when 的规则由 sanitize 整条弃） */
export interface RoutingWhen {
  /** 限定来源（须存在于 sources，悬挂由 sanitize 剔除字段） */
  sourceId?: string
  /** 限定命中方式（枚举过滤，空数组不落键；R13-2 起 + 'matchall'） */
  matchedBy?: ('literal' | 'semantic' | 'rule' | 'matchall')[]
  /** 限定价格规则（须存在于 priceRules，悬挂由 sanitize 剔除字段） */
  ruleId?: string
}

/** 一条路由规则：when 命中的帖推给 channelIds 列出的通道（W3 router 消费） */
export interface RoutingRule {
  id: string
  when: RoutingWhen
  /** 目标通道 id 列表（须存在于 channels；过滤后空则整条弃） */
  channelIds: string[]
}

export interface AppConfig {
  /** 包含词：任一命中即为候选（不区分大小写，只匹配标题） */
  includeKeywords: string[]
  /** 排除词：任一命中则否决（不区分大小写；语义模式下仍先于 AI 一票否决） */
  excludeKeywords: string[]
  /** 轮询间隔秒数，下限 15 */
  pollIntervalSec: number
  /** 代理 URL：'' 表示直连；支持 http:// https:// socks5:// socks5h:// */
  proxyUrl: string
  proxyScope: ProxyScope
  /**
   * 推送通道列表（第六轮 R6-W1，DEC-9；取代旧 telegram 段）。判别联合按 type
   * 分派，sanitize 保证非空（全弃时回默认 telegram 项）、id slug 化去重、上限 8。
   * 默认单项：id='telegram' 的空凭据 telegram 通道（= 未配置态，与旧默认等价）。
   * 本轮只有 telegram 有发送实现；bark/ntfy/webhook 是 W2 的契约占位。
   */
  channels: ChannelConfig[]
  /**
   * 推送策略（第六轮契约：digest 模式 + 免打扰由 W1-queue 消费；当前引擎恒走
   * instant 直推，该段仅落契约与 sanitize）。默认 instant / 15min / 免打扰关。
   */
  notify: NotifyConfig
  /**
   * 路由规则（第六轮契约，W3 router 消费）：when 命中的帖推给 channelIds。
   * 默认 [] = 不路由（全部命中走默认通道组）；sanitize 剔除悬挂引用。
   */
  routing: RoutingRule[]
  /** 推送总开关（临时静音用） */
  notifyEnabled: boolean
  /** 开机自启（Electron app.setLoginItemSettings） */
  launchAtLogin: boolean
  /**
   * 论坛来源列表（v3 判别联合，默认仍只有 nodeseek 一项；关键词仍全局共享，
   * per-source 覆盖= filters 于 v3 引入契约，引擎消费在下一轮）
   */
  sources: SourceConfig[]
  /**
   * 结构化价格规则（第五轮，见 PriceRuleConfig）：标题提取的价格/流量条件全部
   * 满足即命中，作为第三种命中方式（matchedBy='rule'）。默认 [] = 无规则；
   * 引擎消费在 R5 后续包，本轮只定契约与 sanitize。
   */
  priceRules: PriceRuleConfig[]
  /**
   * 相似帖降噪（第五轮）：命中推送前与近窗内已推送帖比对标题相似度，视为相似
   * 则不再推（降重复推送噪音）。**默认开**（与 ai.commentary.enabled 并列的两个
   * 默认开布尔之一）；48h 对比窗口是引擎侧常量（不进配置）。threshold ∈ [0,1]，
   * sanitize 非法回 0.72、钳到 [0,1] 保留两位小数。
   */
  similarity: {
    enabled: boolean
    threshold: number
  }
  /** AI 能力配置（Provider 未配置时语义档自动降级为字面档） */
  ai: AiConfig
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  includeKeywords: [],
  excludeKeywords: [],
  pollIntervalSec: 60,
  proxyUrl: '',
  proxyScope: 'telegram-only',
  channels: [{ id: 'telegram', type: 'telegram', enabled: true, botToken: '', chatId: '' }],
  notify: {
    mode: 'instant',
    digestIntervalMin: 15,
    quietHours: { enabled: false, startHHMM: '23:00', endHHMM: '08:00' },
    // R9-W1：Telegram 遥控默认关闭（允许清单为空 = 仅主 Chat ID 可发指令）
    remoteControl: { enabled: false, allowedChatIds: [] }
  },
  routing: [],
  notifyEnabled: true,
  launchAtLogin: false,
  sources: [{ id: 'nodeseek', type: 'nodeseek', enabled: true }],
  priceRules: [],
  similarity: { enabled: true, threshold: 0.72 },
  ai: {
    provider: { baseUrl: '', apiKey: '', model: '' },
    matchMode: 'literal',
    interests: [],
    semanticThreshold: 0,
    semanticUndecidedTimeoutMin: 30,
    dailyReport: { enabled: false, timeHHMM: '22:00' },
    commentary: { enabled: true, useThinking: false },
    evaluation: { useThinking: false },
    // R17 分类阶段报告：全关（老用户升级不突增推送），时刻错峰避让日报 22:00
    categoryReport: {
      enabled: false,
      sourceIds: ['nodeseek'],
      categories: ['情报', '交易', '测评'],
      appendix: true,
      daily: { enabled: false, timeHHMM: '22:30' },
      weekly: { enabled: false, timeHHMM: '08:00' },
      monthly: { enabled: false, timeHHMM: '08:30' }
    }
  }
}

/** 用户意图（唯一可写维度）：运行中 / 暂停 */
export type DesiredState = 'running' | 'paused'
/** 内核健康（自动流转）：正常 / 失败退避中 / 被 Cloudflare 挑战 */
export type HealthState = 'ok' | 'backoff' | 'challenged'

/** 单个来源的运行状态（engine 内循环多 source，各自独立计数与退避） */
export interface SourceStatus {
  sourceId: string
  health: HealthState
  lastSuccessAt: string | null
  lastError: string | null
  consecutiveFailures: number
  /** 退避截止时刻 ISO；null 表示无退避 */
  cooldownUntil: string | null
  /**
   * 第 2 页补抓累计次数（第五轮，DEC-8 观测面：首页 0 新帖时补抓下一页的执行
   * 面数）。**可选**：旧状态快照没有此字段，消费方容忍缺失（等价 0）。
   */
  page2Fetches?: number
}

/** AI 运行态（语义评估管线的观测面） */
export interface AiRuntimeStatus {
  /** Provider 三项（baseUrl/apiKey/model）是否齐备 */
  configured: boolean
  /** 生效模式：Provider 未配置时降级为 'literal' */
  effectiveMode: MatchMode
  /**
   * 降级态：'unconfigured' = Provider 未配置（语义档整体降级字面）；
   * 'backoff'（R13-3）= 语义评估连续失败进入指数退避冷却——冷却期内不调
   * 上游（防重试风暴），新帖累积为未决待重评。无配额降级（不设每日上限）。
   */
  degraded: 'none' | 'unconfigured' | 'backoff'
  /**
   * 语义评估退避冷却截止时刻 ISO（R13-3）。**可选**：旧状态快照没有此字段，
   * 消费方容忍缺失（等价 null = 无冷却）；仅 degraded='backoff' 时非 null。
   */
  semanticCooldownUntil?: string | null
  /** 今日 AI 调用次数（语义评估 + 锐评合计；本地自然日滚动，纯观测计数，无上限） */
  callsToday: number
  /**
   * 今日锐评调用数（第三轮）。**可选**：渲染层消费，旧消费者（状态快照的既有
   * 读者）不破——缺字段等价于 0。与 callsToday 共用同一本地自然日滚动；已计入
   * callsToday（锐评一次调用两计数各 +1），无独立子限额。
   */
  commentaryToday?: number
  lastAiError: string | null
}

export interface EngineStatus {
  desired: DesiredState
  /** 聚合健康 = 各来源最差（challenged > backoff > ok） */
  health: HealthState
  lastPollAt: string | null
  lastSuccessAt: string | null
  nextPollAt: string | null
  consecutiveFailures: number
  lastError: string | null
  totalHits: number
  /** per-source 状态（v2 仅 'nodeseek' 一项） */
  sources: SourceStatus[]
  ai: AiRuntimeStatus
  /**
   * 挂起待推送条数（第六轮 R6-W4）：免打扰窗内 / digest 模式挂起队列
   * （engine.deferredHits）的当前尺寸。**可选**：旧状态快照没有此字段，消费方
   * 容忍缺失（等价 0）；engine 的 getStatus 每次快照恒下发当前值。
   */
  pendingNotifyCount?: number
  /**
   * 引擎看门狗观测面（R8-A 任务一，E2）：desktop 装配方持有的 EngineWatchdog
   * 状态，随状态广播时**在 runtime 层附加**（快照对象上挂字段再发，见
   * runtime.emitStatus）——engine 自身不写它（status 是 engine 的事实源，
   * watchdog 是 runtime 侧旁路观测）。**可选**：旧状态快照与 headless 装配没有
   * 此字段，消费方容忍缺失（等价「无看门狗」）；lastTriggeredAt=null 且 count=0
   * = 看门狗在位但从未触发。
   */
  watchdog?: { lastTriggeredAt: string | null; count: number }
}

export const INITIAL_ENGINE_STATUS: EngineStatus = {
  desired: 'running',
  health: 'ok',
  lastPollAt: null,
  lastSuccessAt: null,
  nextPollAt: null,
  consecutiveFailures: 0,
  lastError: null,
  totalHits: 0,
  sources: [],
  pendingNotifyCount: 0,
  // R8-A：看门狗默认态（engine 快照里的占位值；广播路径由 runtime 附加实时值覆盖）
  watchdog: { lastTriggeredAt: null, count: 0 },
  ai: {
    configured: false,
    effectiveMode: 'literal',
    degraded: 'unconfigured',
    callsToday: 0,
    lastAiError: null
  }
}

/** 一份已生成的日报（UI 与 IPC 共用形状） */
export interface DailyReportInfo {
  /** 本地时区 'YYYY-MM-DD' */
  date: string
  /** 日报 markdown 正文；请求的日期没有日报时为 null */
  markdown: string | null
}

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  ts: string // ISO
  level: LogLevel
  msg: string
}
