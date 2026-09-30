/**
 * 设置页（阶段 5a 骨架重写，settings.md；步骤 M 按 watchtower 概念稿重排七组）：
 * 三区骨架——
 * - Zone A 子导航（SettingsNav，锚点栏：scrollspy 联动 + 组级 dirty 圆点 +
 *   01-07 mono 编号，对齐概念 .anchor `<b>01</b>匹配规则` 形制）；
 * - Zone B 七组内容滚动区（唯一滚动容器：01 匹配规则 02 监控来源 03 AI 语义
 *   04 通知推送 05 通用 06 数据与诊断 07 关于；组头走概念 .sec 编号小节题，
 *   十七张卡按组摆放，卡内部形制不重构——RulesCard 行形制对齐 .rule 卡是
 *   获准例外）；
 * - Zone C 吸底保存栏（SettingsSavebar：保存/放弃修改/状态文案三态互斥，
 *   概念 savebar 右对齐按钮组 + 毛玻璃吸底；保存成功另发 showToast）。
 *
 * 机制层全部保留（现状测试覆盖的重点）：draft/saved 双态、saveConfig 全量透传、
 * sanitize 回填提示（「已保存（部分值已按规则修正…）」）、测试三兄弟 dirty 闸
 * （测试走已保存配置）、删空下限（来源不可删空、通道至少 1 条在 SourceCard /
 * ChannelsCard 内）、onDirtyChange 上报（App 的 leavebar/dirty-dot 依赖）。
 *
 * 本阶段升级项：
 * - dirty 从整份 JSON.stringify 比较改为 **13 段配置分别比较**（§5.1 的 12 段
 *   + R17 分类总结报告独立成段，段表见 SEGMENTS）：段 → 组映射驱动子导航圆
 *   点；段计数 = 「有 N 处未保存修改」的 N；
 * - **L1 待删除态显式数据源**（5b，§3.5/§5.3）：M 项待删除不再由「saved 有而
 *   draft 无」推导，改为显式 pendingDel 标记集——已保存过的行删除转待删除
 *   （不弹确认，保存后生效、放弃修改可还原），未保存过的新行直接移除；
 *   dirty 比较与保存载荷都走「生效 draft」（effDraft = 剔除待删除行），
 *   标记本身即产生 dirty，不会出现「干净态却有待删除行」的自相矛盾；
 * - audit #7：dirty 一旦为真立即清除「已保存·时刻」文案（patch 内清 ok 态）；
 * - audit #6：getConfig 失败 → 整页错误态 + 重试（不再永久 loading）；
 * - ⌘S 保存（IME 组合期不触发）+ 放弃修改（行内确认条，恢复 saved 快照，
 *   含待删除标记一并还原）；
 * - initialAnchor 深链（seq 递增防同值不触发，与去向页 dispDeepLink 同模式）：
 *   进入后滚到目标卡 + 800ms 高亮环；锚点 id 与 DispositionSettingsAnchor 对齐。
 *
 * 保存走 AppConfig v2 全量透传：sources 与 ai 段都由本页表单构建（ai 段来自
 * AiModelCard/MatchModeCard/RunPaceCard，sources 来自「来源」卡）；
 * priceRules / similarity 分别来自「价格规则」「相似降噪」卡；
 * channels / notify / routing 来自「推送通道 / 推送策略 / 路由规则」卡
 * （notify.remoteControl 遥控段由「Telegram 遥控」卡编辑）；
 * 「行为」卡废止——推送总开关并入 NotifyCard 首行，开机自启并入 RunPaceCard
 * （步骤 M 起关窗行为 closeBehavior 也由 RunPaceCard 编辑，随本页保存）。
 * 页尾两张**非表单**卡（不进 draft / dirty）：「数据」备份导出/导入 + 「关于」。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  AppConfig,
  CategoryReportConfig,
  ChannelConfig,
  MatchMode,
  NotifyConfig,
  PriceRuleConfig,
  ProxyScope,
  RoutingRule,
  SourceConfig
} from '@shared/types'
import { AboutCard } from '../components/AboutCard'
import { AiModelCard } from '../components/AiModelCard'
import { CategoryReportCard } from '../components/CategoryReportCard'
import { ChannelsCard } from '../components/ChannelsCard'
import { isChannelReadyUi } from '../components/ChannelsCard'
import { DataCard } from '../components/DataCard'
import { KeywordsCard } from '../components/KeywordsCard'
import { MatchModeCard } from '../components/MatchModeCard'
import { MatchTestCard } from '../components/MatchTestCard'
import { NotifyCard } from '../components/NotifyCard'
import { PageHeader } from '../components/PageHeader'
import { ProxyCard } from '../components/ProxyCard'
import { RemoteControlCard } from '../components/RemoteControlCard'
import { RulesCard } from '../components/RulesCard'
import { RoutingCard } from '../components/RoutingCard'
import { RunPaceCard } from '../components/RunPaceCard'
import { SettingsErrorState } from '../components/SettingsErrorState'
import { SettingsNav } from '../components/SettingsNav'
import { SettingsSavebar } from '../components/SettingsSavebar'
import { SimilarityCard } from '../components/SimilarityCard'
import { SourceCard } from '../components/SourceCard'
import { showToast } from '../lib/toast'
import { formatClock } from '../lib/time'

// ---- 深链锚点（settings.md §5.2；id 与去向页 DispositionSettingsAnchor 对齐）----

/**
 * 设置页锚点全集：七组（grp-*）+ 各卡片。去向页「去调整」出口的六个取值
 * （keywords / sources / match-mode / similarity / push-channels / push-policy）
 * 原样包含在内，可直接下发。
 *
 * 步骤 M（设置重组，概念稿 01-05 屏段 → 七组）：既有值一个未删未改（深链
 * 兼容：去向页六值、监控台 grp-monitor、历史 keywords 全依赖原值），仅
 * **新增** 'grp-sources'（02 监控来源独立成组需要第 7 个组锚点）；grp-* 与
 * 组的对应关系重映射见 GROUPS——grp-monitor=01 匹配规则、grp-sources=02
 * 监控来源、grp-match=03 AI 语义、grp-notify=04 通知推送、grp-run=05 通用、
 * grp-data=06 数据与诊断、grp-about=07 关于。
 */
export type SettingsAnchor =
  | 'grp-monitor'
  | 'grp-sources'
  | 'grp-match'
  | 'grp-notify'
  | 'grp-run'
  | 'grp-data'
  | 'grp-about'
  | 'sources'
  | 'keywords'
  | 'price-rules'
  | 'ai-model'
  | 'match-mode'
  | 'category-report'
  | 'similarity'
  | 'push-channels'
  | 'push-policy'
  | 'routing'
  | 'remote'
  | 'run-pace'
  | 'proxy'
  | 'data'
  | 'match-test'
  | 'about'

/** 跨页深链载荷（App 层构造；seq 递增保证同值深链可重复触发） */
export interface SettingsAnchorLink {
  id: SettingsAnchor
  seq: number
}

/** 锚点 → 卡片/组槽元素的 DOM id（全应用唯一前缀，5b 与验收共用） */
export function settingsAnchorDomId(a: SettingsAnchor): string {
  return `set-${a}`
}

/**
 * 组内卡片锚点槽：id 承载子导航跳转与跨页深链；flashId 命中时挂 .flash
 * （800ms 高亮环，深链落点）。九张现有卡组件根元素不带 id，统一由本槽包覆。
 */
function Slot(props: { anchor: SettingsAnchor; flashId: string | null; children: ReactNode }) {
  const domId = settingsAnchorDomId(props.anchor)
  return (
    <div id={domId} className={`set-slot${props.flashId === domId ? ' flash' : ''}`}>
      {props.children}
    </div>
  )
}

/**
 * 编号组头（步骤 M，概念稿 .sec h3 形制：衬线小节题 + mono 编号 + 底线；
 * desc 为第二行释义）。替代原 GroupHeader（组件本体不动、仅本页换消费方）：
 * 编号是概念 anchor/sec 的对位，属本页重组的一部分。
 */
function SecHeader(props: { num: string; name: string; desc?: string }) {
  return (
    <div>
      <h2 className="sec-head">
        <span className="sec-num">{props.num}</span>
        {props.name}
      </h2>
      {props.desc != null && <p className="sec-sub">{props.desc}</p>}
    </div>
  )
}

// ---- draft 双态（机制层，保留现状） ------------------------------------------

interface Draft {
  includeKeywords: string[]
  excludeKeywords: string[]
  sources: SourceConfig[]
  pollIntervalText: string
  proxyUrl: string
  proxyScope: ProxyScope
  /**
   * 推送通道列表（R6-W1 起数据面在；R6-W4 由「推送通道」卡完整管理增删启停
   * 与四类型凭据编辑）
   */
  channels: ChannelConfig[]
  /**
   * 推送策略（R6-W4「推送策略」卡：instant/digest + 免打扰时段）
   */
  notify: NotifyConfig
  /**
   * 路由规则（R6-W4「路由规则」卡：按条件分流到指定通道）
   */
  routing: RoutingRule[]
  notifyEnabled: boolean
  launchAtLogin: boolean
  /** 关窗行为（步骤 D 起主进程接线；「运行节奏」卡的 radios 编辑） */
  closeBehavior: AppConfig['closeBehavior']
  aiBaseUrl: string
  aiApiKey: string
  aiModel: string
  matchMode: MatchMode
  interests: string[]
  dailyEnabled: boolean
  dailyTime: string
  /**
   * 分类总结报告（R17）：整段持有（ai.categoryReport 的深拷贝），编辑由
   * CategoryReportCard 以新段对象回写；保存全量透传，清洗在主进程 sanitize。
   */
  categoryReport: CategoryReportConfig
  commentaryEnabled: boolean
  /** 锐评思考开关（R12，「AI 模型」卡；仅锐评开启时呈现） */
  commentaryUseThinking: boolean
  /** 价格规则（R5-P2c 起由本页「价格规则」卡管理） */
  priceRules: PriceRuleConfig[]
  /** 相似降噪（「相似降噪」卡） */
  similarityEnabled: boolean
  similarityThreshold: number
  /** 语义置信度阈值（「监控模式」卡滑杆；0 = 不过滤） */
  aiSemanticThreshold: number
}

type Msg = { kind: 'ok' | 'err' | 'warn' | 'pending' | 'muted'; text: string }

const PROXY_SCHEME_RE = /^(https?|socks5h?):\/\//i

function toDraft(c: AppConfig): Draft {
  return {
    includeKeywords: [...c.includeKeywords],
    excludeKeywords: [...c.excludeKeywords],
    // 浅拷贝逐项（编辑只整项替换、不就地改嵌套字段，浅层足够）
    sources: c.sources.map((s) => ({ ...s })),
    pollIntervalText: String(c.pollIntervalSec),
    proxyUrl: c.proxyUrl,
    proxyScope: c.proxyScope,
    channels: c.channels.map((ch) => ({ ...ch })),
    notify: {
      ...c.notify,
      quietHours: { ...c.notify.quietHours },
      // R9-W1：遥控段深拷贝（allowedChatIds 数组独立于 saved）
      remoteControl: {
        ...c.notify.remoteControl,
        allowedChatIds: [...c.notify.remoteControl.allowedChatIds]
      }
    },
    routing: c.routing.map((r) => ({
      ...r,
      when: { ...r.when },
      channelIds: [...r.channelIds]
    })),
    notifyEnabled: c.notifyEnabled,
    launchAtLogin: c.launchAtLogin,
    closeBehavior: c.closeBehavior,
    aiBaseUrl: c.ai.provider.baseUrl,
    aiApiKey: c.ai.provider.apiKey,
    aiModel: c.ai.provider.model,
    matchMode: c.ai.matchMode,
    interests: [...c.ai.interests],
    dailyEnabled: c.ai.dailyReport.enabled,
    dailyTime: c.ai.dailyReport.timeHHMM,
    // R17 分类报告段深拷贝（嵌套 daily/weekly/monthly 与两个字符串数组独立于 saved）
    categoryReport: {
      ...c.ai.categoryReport,
      sourceIds: [...c.ai.categoryReport.sourceIds],
      categories: [...c.ai.categoryReport.categories],
      daily: { ...c.ai.categoryReport.daily },
      weekly: { ...c.ai.categoryReport.weekly },
      monthly: { ...c.ai.categoryReport.monthly }
    },
    commentaryEnabled: c.ai.commentary.enabled,
    commentaryUseThinking: c.ai.commentary.useThinking,
    priceRules: c.priceRules.map((r) => ({ ...r })),
    similarityEnabled: c.similarity.enabled,
    similarityThreshold: c.similarity.threshold,
    aiSemanticThreshold: c.ai.semanticThreshold
  }
}

// ---- 13 段配置（settings.md §5.1 的 12 段 + R17 分类总结报告段）---------------

/** 配置段 key（与保存栏 N、组级圆点、深链组映射一一对应） */
type SegmentKey =
  | 'sources'
  | 'keywords'
  | 'priceRules'
  | 'aiModel'
  | 'matchMode'
  | 'categoryReport'
  | 'similarity'
  | 'channels'
  | 'notifyStrategy'
  | 'routing'
  | 'remote'
  | 'runPace'
  | 'proxy'

/** 七组 key（即 grp-* 锚点值；'grp-sources' 为步骤 M 新增，其余六个原值不动） */
type GroupKey =
  | 'grp-monitor'
  | 'grp-sources'
  | 'grp-match'
  | 'grp-notify'
  | 'grp-run'
  | 'grp-data'
  | 'grp-about'

/**
 * 13 段定义（R17 起 12+1：分类总结报告独立成段）：pick 返回 JSON 可序列化的
 * 段值（draft 与 toDraft(saved) 各取一次比 stringify）。推送策略段特意排除
 * remoteControl（遥控独立成段）。
 *
 * 段 → 组映射（步骤 M 重排，对齐概念稿设置屏 01-05 + 保留的 06/07）：
 * keywords/priceRules → 01 匹配规则；sources → 02 监控来源；aiModel/matchMode/
 * categoryReport/similarity → 03 AI 语义；channels/notifyStrategy/routing/
 * remote → 04 通知推送；runPace（含 closeBehavior）/proxy → 05 通用。
 */
const SEGMENTS: ReadonlyArray<{ key: SegmentKey; group: GroupKey; pick: (d: Draft) => unknown }> = [
  { key: 'keywords', group: 'grp-monitor', pick: (d) => [d.includeKeywords, d.excludeKeywords] },
  { key: 'priceRules', group: 'grp-monitor', pick: (d) => d.priceRules },
  { key: 'sources', group: 'grp-sources', pick: (d) => d.sources },
  { key: 'aiModel', group: 'grp-match', pick: (d) => [d.aiBaseUrl, d.aiApiKey, d.aiModel, d.commentaryEnabled, d.commentaryUseThinking] },
  { key: 'matchMode', group: 'grp-match', pick: (d) => [d.matchMode, d.interests, d.aiSemanticThreshold] },
  { key: 'categoryReport', group: 'grp-match', pick: (d) => d.categoryReport },
  { key: 'similarity', group: 'grp-match', pick: (d) => [d.similarityEnabled, d.similarityThreshold] },
  { key: 'channels', group: 'grp-notify', pick: (d) => d.channels },
  {
    key: 'notifyStrategy',
    group: 'grp-notify',
    pick: (d) => ({
      mode: d.notify.mode,
      digest: d.notify.digestIntervalMin,
      quiet: d.notify.quietHours,
      mute: d.notifyEnabled
    })
  },
  { key: 'routing', group: 'grp-notify', pick: (d) => d.routing },
  { key: 'remote', group: 'grp-notify', pick: (d) => d.notify.remoteControl },
  {
    key: 'runPace',
    group: 'grp-run',
    pick: (d) => [d.pollIntervalText, d.dailyEnabled, d.dailyTime, d.launchAtLogin, d.closeBehavior]
  },
  { key: 'proxy', group: 'grp-run', pick: (d) => [d.proxyUrl, d.proxyScope] }
]

/** 七组摆位（步骤 M，概念稿设置屏分组；06/07 无表单段——非配置卡不进 dirty）。
 *   num = 子导航与组头的 mono 编号（01-07）；name = 组头小节题与子导航 label；
 *   desc = 第二行释义，07「关于」无释义。 */
const GROUPS: ReadonlyArray<{ id: GroupKey; num: string; name: string; desc?: string }> = [
  { id: 'grp-monitor', num: '01', name: '匹配规则', desc: '定义「监控什么、什么算命中」' },
  { id: 'grp-sources', num: '02', name: '监控来源', desc: '抓哪些论坛：启停、分类过滤与单独匹配覆盖' },
  { id: 'grp-match', num: '03', name: 'AI 语义', desc: 'AI 语义判定与降噪参数' },
  { id: 'grp-notify', num: '04', name: '通知推送', desc: '推给谁、何时推、走哪条路' },
  { id: 'grp-run', num: '05', name: '通用', desc: '应用自身的运行节奏与系统行为' },
  { id: 'grp-data', num: '06', name: '数据与诊断', desc: '只读诊断与数据迁移（非配置）' },
  { id: 'grp-about', num: '07', name: '关于' }
]

// ---- L1 待删除态（settings.md §3.5/§5.1，显式数据源） ---------------------------

/** 四类实体列表域（来源 / 通道 / 价格规则 / 路由——都有稳定 id） */
type EntityKind = 'sources' | 'channels' | 'priceRules' | 'routing'

/** 各域已标记「待删除」的实体 id（保存后从配置消失；放弃修改可还原） */
type PendingDeletes = Record<EntityKind, ReadonlySet<string>>

const NO_PENDING: PendingDeletes = {
  sources: new Set(),
  channels: new Set(),
  priceRules: new Set(),
  routing: new Set()
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

// ---- 页面 ---------------------------------------------------------------------

export function Settings(props: {
  onDirtyChange: (dirty: boolean) => void
  /** keep-alive 可见性（隐藏时 ⌘S/Esc 不接管） */
  active?: boolean
  /** 跨页锚点深链（滚到目标卡 + 800ms 高亮环；seq 递增防同值不触发） */
  initialAnchor?: SettingsAnchorLink | null
}) {
  const active = props.active !== false
  const [saved, setSaved] = useState<AppConfig | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  /** L1 待删除标记（显式数据源：保存栏 M 计数 / 保存剔除 / 放弃还原都在本页） */
  const [pendingDel, setPendingDel] = useState<PendingDeletes>(NO_PENDING)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** 首载 >300ms 才显示轻量骨架（§4.2；本地 IPC 常态无感知） */
  const [slowLoad, setSlowLoad] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<Msg | null>(null)
  const [testing, setTesting] = useState(false)
  const [testMsg, setTestMsg] = useState<Msg | null>(null)
  const [aiTesting, setAiTesting] = useState(false)
  const [aiTestMsg, setAiTestMsg] = useState<Msg | null>(null)
  /** scrollspy 激活组（DOM id，如 set-grp-monitor） */
  const [activeGroup, setActiveGroup] = useState<string>(settingsAnchorDomId('grp-monitor'))
  /** 放弃修改的行内确认态（首击后保存栏原地变形） */
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  // onDirtyChange 上报：ref 镜像避免回调身份变化引起重复触发；卸载时归位 false
  const onDirtyRef = useRef(props.onDirtyChange)
  useEffect(() => {
    onDirtyRef.current = props.onDirtyChange
  }, [props.onDirtyChange])
  useEffect(() => () => onDirtyRef.current(false), [])

  // 配置读取：失败进整页错误态（audit #6），重试按钮驱动 reloadTick
  useEffect(() => {
    let cancelled = false
    setLoadError(null)
    setSlowLoad(false)
    const slowTimer = window.setTimeout(() => {
      if (!cancelled) setSlowLoad(true)
    }, 300)
    void window.api
      .getConfig()
      .then((cfg) => {
        if (cancelled) return
        setSaved(cfg)
        setDraft(toDraft(cfg))
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(errText(e))
      })
      .finally(() => {
        window.clearTimeout(slowTimer)
      })
    return () => {
      cancelled = true
      window.clearTimeout(slowTimer)
    }
  }, [reloadTick])

  // ---- 13 段 dirty 计算（§5.1 + R17；替代原整份 JSON.stringify 比较）----

  const savedDraft = useMemo(() => (saved == null ? null : toDraft(saved)), [saved])

  /**
   * 生效 draft：剔除待删除行后的形态——dirty 比较与保存载荷共用（「标记删除」
   * 即产生 dirty，保存后这些行从配置消失；draft 本身保留原行供各卡渲染待删除态）。
   */
  const effDraft = useMemo<Draft | null>(() => {
    if (draft == null) return null
    return {
      ...draft,
      sources: draft.sources.filter((s) => !pendingDel.sources.has(s.id)),
      channels: draft.channels.filter((c) => !pendingDel.channels.has(c.id)),
      priceRules: draft.priceRules.filter((r) => !pendingDel.priceRules.has(r.id)),
      routing: draft.routing.filter((r) => !pendingDel.routing.has(r.id))
    }
  }, [draft, pendingDel])

  const dirtySegments = useMemo<SegmentKey[]>(() => {
    if (effDraft == null || savedDraft == null) return []
    return SEGMENTS.filter(
      (s) => JSON.stringify(s.pick(effDraft)) !== JSON.stringify(s.pick(savedDraft))
    ).map((s) => s.key)
  }, [effDraft, savedDraft])

  const dirtyCount = dirtySegments.length
  const dirty = dirtyCount > 0

  /** M 项待删除 = 全部待删除标记数（每条都对应保存后将消失的已保存实体） */
  const deleteCount =
    pendingDel.sources.size + pendingDel.channels.size + pendingDel.priceRules.size + pendingDel.routing.size

  useEffect(() => {
    onDirtyRef.current(dirty)
  }, [dirty])

  /** audit #7：dirty 一旦为真立即清除「已保存·时刻」文案（err 态保留可重试） */
  function clearOkMsg(): void {
    setSaveMsg((m) => (m != null && m.kind === 'ok' ? null : m))
  }

  function patch(p: Partial<Draft>): void {
    setDraft((d) => (d == null ? d : { ...d, ...p }))
    clearOkMsg()
  }

  /**
   * L1 删除（settings.md §3.5，不弹确认）：已保存过的行转「待删除」标记；
   * 未保存过的新行没有「保存后删除」语义，直接从 draft 移除。删空下限
   * （来源至少 1 个 / 通道至少 1 条）由各卡按生效列表禁用删除按钮保证。
   */
  function markDelete(kind: EntityKind, id: string): void {
    if (draft == null) return
    const inSaved =
      savedDraft != null &&
      (kind === 'sources'
        ? savedDraft.sources
        : kind === 'channels'
          ? savedDraft.channels
          : kind === 'priceRules'
            ? savedDraft.priceRules
            : savedDraft.routing
      ).some((x) => x.id === id)
    if (!inSaved) {
      if (kind === 'sources') patch({ sources: draft.sources.filter((x) => x.id !== id) })
      else if (kind === 'channels') patch({ channels: draft.channels.filter((x) => x.id !== id) })
      else if (kind === 'priceRules') patch({ priceRules: draft.priceRules.filter((x) => x.id !== id) })
      else patch({ routing: draft.routing.filter((x) => x.id !== id) })
      return
    }
    setPendingDel((p) => {
      const next = new Set(p[kind])
      next.add(id)
      return { ...p, [kind]: next }
    })
    clearOkMsg()
  }

  /** 撤销删除：去掉待删除标记（保存前可无限还原） */
  function undoDelete(kind: EntityKind, id: string): void {
    setPendingDel((p) => {
      if (!p[kind].has(id)) return p
      const next = new Set(p[kind])
      next.delete(id)
      return { ...p, [kind]: next }
    })
  }

  const intervalTrim = (draft?.pollIntervalText ?? '').trim()
  const intervalNum = Number(intervalTrim)
  const intervalValid = intervalTrim !== '' && Number.isFinite(intervalNum)
  const intervalTooLow = intervalValid && intervalNum < 15

  const proxyTrim = (draft?.proxyUrl ?? '').trim()
  const proxySchemeBad = proxyTrim !== '' && !PROXY_SCHEME_RE.test(proxyTrim)

  // 表单口径的 "AI 已配置"（与主进程 Provider 三项齐备判定一致）
  const aiConfigured =
    draft != null &&
    draft.aiBaseUrl.trim() !== '' &&
    draft.aiApiKey.trim() !== '' &&
    draft.aiModel.trim() !== ''

  async function save(): Promise<void> {
    if (effDraft == null || saved == null || saving || confirmDiscard) return
    const d = effDraft
    setSaving(true)
    try {
      const cfg: AppConfig = {
        // sources 来自「来源」卡（SourceCard 回写 draft，待删除行已在此剔除）；
        // ai 段由本页 AI 卡构建，其余字段覆盖为本表单管理的值。
        // channels/notify/routing（R6-W4）来自「推送通道 / 推送策略 / 路由规则」
        // 三卡——旧顶层 telegram 键不再发送（写路径只写新形状）
        ...saved,
        includeKeywords: d.includeKeywords,
        excludeKeywords: d.excludeKeywords,
        sources: d.sources,
        pollIntervalSec: intervalValid ? Math.floor(intervalNum) : 15,
        proxyUrl: proxyTrim,
        proxyScope: d.proxyScope,
        channels: d.channels,
        // R6-W4：推送策略与路由规则（「推送策略」「路由规则」卡回写 draft 透传）
        notify: d.notify,
        routing: d.routing,
        notifyEnabled: d.notifyEnabled,
        launchAtLogin: d.launchAtLogin,
        closeBehavior: d.closeBehavior,
        priceRules: d.priceRules,
        similarity: {
          enabled: d.similarityEnabled,
          threshold: d.similarityThreshold
        },
        ai: {
          // 本页未管理的 ai 子字段（R15 的 semanticUndecidedTimeoutMin /
          // evaluation.useThinking 等）保留已保存值——sanitize 会兜底默认，但
          // 显式透传防"保存其它设置把这些值抹回默认"
          ...saved.ai,
          provider: {
            baseUrl: d.aiBaseUrl.trim(),
            apiKey: d.aiApiKey.trim(),
            model: d.aiModel.trim()
          },
          matchMode: d.matchMode,
          interests: d.interests,
          // 语义置信度阈值（第五轮 / R5-P2c：「监控模式」卡的滑杆）
          semanticThreshold: d.aiSemanticThreshold,
          dailyReport: { enabled: d.dailyEnabled, timeHHMM: d.dailyTime },
          // 分类总结报告（R17「分类总结报告」卡整段透传；清洗在主进程 sanitize）
          categoryReport: d.categoryReport,
          // 锐评开关（「AI 模型」卡的「推送锐评」控件）；思考开关同卡（R12）
          commentary: { enabled: d.commentaryEnabled, useThinking: d.commentaryUseThinking }
        }
      }
      const r = await window.api.saveConfig(cfg)
      if (r.ok) {
        setSaved(r.config)
        setDraft(toDraft(r.config))
        // 待删除行已随保存落盘，标记清空（保存后从列表消失）
        setPendingDel(NO_PENDING)
        const adjusted = JSON.stringify(r.config) !== JSON.stringify(cfg)
        const at = formatClock(new Date().toISOString())
        setSaveMsg(
          adjusted
            ? { kind: 'ok', text: `已保存（部分值已按规则修正，如最低 15 秒）· ${at}` }
            : { kind: 'ok', text: `已保存 · ${at}` }
        )
        // 步骤 M：保存成功另发一条全局 toast（概念稿 toast 形制；保存栏状态
        // 文案照旧保留——ok 态随下次 dirty 被清除，toast 是即时回声）
        showToast(adjusted ? '设置已保存（部分值已按规则修正）' : '设置已保存')
      } else {
        setSaveMsg({ kind: 'err', text: `保存失败：${r.error}。改动仍在表单里，可重试保存。` })
      }
    } catch (e) {
      // IPC reject（通道异常）：反馈置 err 态，不留在 pending（与 r.ok=false 同级处理）
      setSaveMsg({ kind: 'err', text: `保存失败：${errText(e)}。改动仍在表单里，可重试保存。` })
    } finally {
      setSaving(false)
    }
  }

  /**
   * 发送测试消息（R6-W4 起广播全部就绪通道，不走路由）：dirty 时先提示保存
   * （主进程用的是已保存配置）；无就绪通道时提示先配置。
   */
  async function sendTest(): Promise<void> {
    if (draft == null) return
    if (dirty) {
      setTestMsg({
        kind: 'warn',
        text: '设置有未保存的改动：测试使用的是已保存的配置，请先保存再测试。'
      })
      return
    }
    if (!draft.channels.some(isChannelReadyUi)) {
      setTestMsg({
        kind: 'err',
        text: '没有就绪通道：请先在「推送通道」配置至少一个凭据齐备且启用的通道并保存。'
      })
      return
    }
    setTesting(true)
    setTestMsg({ kind: 'pending', text: '正在向全部就绪通道发送测试消息…' })
    try {
      const r = await window.api.engineControl('sendTest')
      setTestMsg(
        r.ok
          ? { kind: 'ok', text: '测试消息已发送到全部就绪通道，请分别查收' }
          : { kind: 'err', text: `发送失败：${r.error}` }
      )
    } catch (e) {
      // IPC reject：反馈置 err 态，不留在 pending
      setTestMsg({ kind: 'err', text: `发送失败：${errText(e)}` })
    } finally {
      setTesting(false)
    }
  }

  async function testAi(): Promise<void> {
    if (draft == null) return
    if (dirty) {
      setAiTestMsg({
        kind: 'warn',
        text: '设置有未保存的改动：测试使用的是已保存的配置，请先保存再测试。'
      })
      return
    }
    if (!aiConfigured) {
      setAiTestMsg({ kind: 'err', text: '请先填写并保存 Base URL、API Key 与模型名再测试' })
      return
    }
    setAiTesting(true)
    setAiTestMsg({ kind: 'pending', text: '正在测试连接…' })
    try {
      const r = await window.api.testAiProvider()
      setAiTestMsg(
        r.ok
          ? { kind: 'ok', text: '连接成功，模型可用' }
          : { kind: 'err', text: `连接失败：${r.error}` }
      )
    } catch (e) {
      // IPC reject：反馈置 err 态，不留在 pending
      setAiTestMsg({ kind: 'err', text: `连接失败：${errText(e)}` })
    } finally {
      setAiTesting(false)
    }
  }

  /** 放弃修改：恢复 saved 快照（行内确认条确认后调用；待删除标记一并还原） */
  function discardDraft(): void {
    if (saved == null) return
    setDraft(toDraft(saved))
    setPendingDel(NO_PENDING)
    setSaveMsg(null)
    setConfirmDiscard(false)
  }

  // ⌘S 保存（IME 组合期不触发；页面隐藏不接管）+ Esc 退出放弃确认（就近优先）。
  // 无依赖数组、每渲染重挂（与壳层 ⌘1..5 同模式），读到的恒是最新闭包
  useEffect(() => {
    if (!active) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.isComposing) return
      if (e.key === 'Escape') {
        if (confirmDiscard) setConfirmDiscard(false)
        return
      }
      if (e.altKey || !(e.metaKey || e.ctrlKey)) return
      if (e.key !== 's' && e.key !== 'S') return
      e.preventDefault()
      if (dirty && !saving && draft != null && !confirmDiscard) void save()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  // 确认条只在 dirty 期间存在（draft 恰好回到与 saved 一致时自动退出）
  useEffect(() => {
    if (!dirty) setConfirmDiscard(false)
  }, [dirty])

  // ---- Zone A ⇄ Zone B：scrollspy + 锚点跳转 + 深链高亮 ----

  const scrollRef = useRef<HTMLDivElement | null>(null)
  /** 深链高亮中的槽 DOM id（800ms 后归 null；去向页 flashKey 同机制） */
  const [flashId, setFlashId] = useState<string | null>(null)
  const flashTimerRef = useRef<number | null>(null)
  useEffect(() => () => {
    if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current)
  }, [])

  /** scrollspy：视口内最靠上的组 = 激活项（原型的组顶 + 160px 阈值） */
  function handleScroll(): void {
    const sc = scrollRef.current
    if (sc == null) return
    const scTop = sc.getBoundingClientRect().top
    const threshold = sc.scrollTop + 160
    let cur: string | null = null
    for (const g of Array.from(sc.querySelectorAll<HTMLElement>('.settings-group'))) {
      const top = g.getBoundingClientRect().top - scTop + sc.scrollTop
      if (top <= threshold) cur = g.id
    }
    if (cur != null) setActiveGroup((prev) => (prev === cur ? prev : cur))
  }

  function jumpToGroup(groupId: string): void {
    setActiveGroup(groupId)
    document
      .getElementById(groupId)
      ?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' })
  }

  // 深链：滚到目标卡 + 800ms 高亮环；同步子导航激活到所属组。高亮经 rAF 两拍
  // 置位——同锚点重复触发（seq 变、id 不变）也能移除再加回 class 重启动画
  const ready = draft != null
  useEffect(() => {
    const link = props.initialAnchor
    if (link == null || !ready || !active) return
    const domId = settingsAnchorDomId(link.id)
    const el = document.getElementById(domId)
    if (el == null) return
    el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' })
    setFlashId(null)
    const raf = requestAnimationFrame(() => setFlashId(domId))
    if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current)
    flashTimerRef.current = window.setTimeout(() => setFlashId(null), 820)
    const grp = el.closest('.settings-group')
    if (grp != null) setActiveGroup(grp.id)
    return () => cancelAnimationFrame(raf)
  }, [props.initialAnchor, ready, active])

  const navGroups = GROUPS.map((g) => ({
    id: settingsAnchorDomId(g.id),
    num: g.num,
    label: g.name,
    dirty: dirtySegments.length > 0 && SEGMENTS.some((s) => s.group === g.id && dirtySegments.includes(s.key))
  }))

  // ---- 渲染：整页错误态 / 首载骨架 / 三区骨架 ----

  if (draft == null && loadError != null) {
    return (
      <div className="page page-settings">
        {/* 与 loading 分支同构：Zone A 置灰保骨架（§4.3，SettingsErrorState 头注释
            的约定）；错误卡是覆盖层（.settings-error，z-index 98）盖住内容区 */}
        <SettingsNav groups={navGroups} active={activeGroup} disabled onJump={() => {}} />
        <div className="settings-scroll">
          <div className="settings-col">
            <SettingsErrorState reason={loadError} onRetry={() => setReloadTick((t) => t + 1)} />
          </div>
        </div>
      </div>
    )
  }

  if (draft == null) {
    return (
      <div className="page page-settings">
        <SettingsNav groups={navGroups} active={activeGroup} disabled onJump={() => {}} />
        <div className="settings-scroll">
          <div className="settings-col">
            {slowLoad && (
              <div className="settings-loading" aria-live="polite">
                <span>正在读取本机配置…</span>
                <div className="set-skel" />
                <div className="set-skel" />
                <div className="set-skel" />
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="page page-settings">
      {/* 页头（概念稿 settings 屏：eyebrow + 衬线题 + 副题「把哨兵调成你的样子」）。
          旧决策「视觉上无页题」（TASTE-UPGRADE §B-2）随瞭望塔全量重设计废除——视觉
          比对 05 屏 FAIL 项；h1 由 PageHeader 提供，主分支不再另设 sr-only 题 */}
      <SettingsNav groups={navGroups} active={activeGroup} onJump={jumpToGroup} />

      <div className="settings-scroll" ref={scrollRef} onScroll={handleScroll}>
        <div className="settings-col">
          <PageHeader eyebrow="Settings" title="设置" subtitle="把哨兵调成你的样子" />
          {/* 01 匹配规则（grp-monitor）：关键词 + 价格规则——概念 sec-rules 屏段 */}
          <section className="settings-group" id={settingsAnchorDomId('grp-monitor')}>
            <SecHeader num={GROUPS[0].num} name={GROUPS[0].name} desc={GROUPS[0].desc} />
            <Slot anchor="keywords" flashId={flashId}>
              <KeywordsCard
                includeKeywords={draft.includeKeywords}
                excludeKeywords={draft.excludeKeywords}
                onIncludeChange={(v) => patch({ includeKeywords: v })}
                onExcludeChange={(v) => patch({ excludeKeywords: v })}
              />
            </Slot>
            <Slot anchor="price-rules" flashId={flashId}>
              <RulesCard
                rules={draft.priceRules}
                onChange={(priceRules) => patch({ priceRules })}
                pendingDelete={pendingDel.priceRules}
                onMarkDelete={(id) => markDelete('priceRules', id)}
                onUndoDelete={(id) => undoDelete('priceRules', id)}
              />
            </Slot>
          </section>

          {/* 02 监控来源（grp-sources，步骤 M 新增组锚点） */}
          <section className="settings-group" id={settingsAnchorDomId('grp-sources')}>
            <SecHeader num={GROUPS[1].num} name={GROUPS[1].name} desc={GROUPS[1].desc} />
            <Slot anchor="sources" flashId={flashId}>
              <SourceCard
                sources={draft.sources}
                onChange={(sources) => patch({ sources })}
                pendingDelete={pendingDel.sources}
                onMarkDelete={(id) => markDelete('sources', id)}
                onUndoDelete={(id) => undoDelete('sources', id)}
                globalSemanticThreshold={draft.aiSemanticThreshold}
              />
            </Slot>
          </section>

          {/* 03 AI 语义（grp-match）：AI 模型在前——组序即配置依赖序 */}
          <section className="settings-group" id={settingsAnchorDomId('grp-match')}>
            <SecHeader num={GROUPS[2].num} name={GROUPS[2].name} desc={GROUPS[2].desc} />
            <Slot anchor="ai-model" flashId={flashId}>
              <AiModelCard
                baseUrl={draft.aiBaseUrl}
                apiKey={draft.aiApiKey}
                model={draft.aiModel}
                commentaryEnabled={draft.commentaryEnabled}
                commentaryUseThinking={draft.commentaryUseThinking}
                onBaseUrlChange={(v) => patch({ aiBaseUrl: v })}
                onApiKeyChange={(v) => patch({ aiApiKey: v })}
                onModelChange={(v) => patch({ aiModel: v })}
                onCommentaryToggle={() => patch({ commentaryEnabled: !draft.commentaryEnabled })}
                onCommentaryThinkingToggle={() =>
                  patch({ commentaryUseThinking: !draft.commentaryUseThinking })
                }
                onPresetPick={(baseUrl, model) => patch({ aiBaseUrl: baseUrl, aiModel: model })}
                test={{
                  testing: aiTesting,
                  msg: aiTestMsg == null ? null : { kind: aiTestMsg.kind, text: aiTestMsg.text },
                  onSend: () => void testAi()
                }}
              />
            </Slot>
            <Slot anchor="match-mode" flashId={flashId}>
              <MatchModeCard
                matchMode={draft.matchMode}
                interests={draft.interests}
                semanticThreshold={draft.aiSemanticThreshold}
                aiConfigured={aiConfigured}
                onModeChange={(v) => patch({ matchMode: v })}
                onInterestsChange={(v) => patch({ interests: v })}
                onThresholdChange={(v) => patch({ aiSemanticThreshold: v })}
              />
            </Slot>
            <Slot anchor="similarity" flashId={flashId}>
              <SimilarityCard
                enabled={draft.similarityEnabled}
                threshold={draft.similarityThreshold}
                onToggle={() => patch({ similarityEnabled: !draft.similarityEnabled })}
                onThresholdChange={(v) => patch({ similarityThreshold: v })}
              />
            </Slot>
            <Slot anchor="category-report" flashId={flashId}>
              {/* R17 分类总结报告：来源多选走生效列表（待删除来源不再可选，
                  悬挂引用由保存时 sanitize 清理——RoutingCard 同口径） */}
              <CategoryReportCard
                cr={draft.categoryReport}
                sources={effDraft?.sources ?? draft.sources}
                onChange={(categoryReport) => patch({ categoryReport })}
              />
            </Slot>
          </section>

          {/* 04 通知推送（grp-notify） */}
          <section className="settings-group" id={settingsAnchorDomId('grp-notify')}>
            <SecHeader num={GROUPS[3].num} name={GROUPS[3].name} desc={GROUPS[3].desc} />
            <Slot anchor="push-channels" flashId={flashId}>
              <ChannelsCard
                channels={draft.channels}
                onChange={(channels) => patch({ channels })}
                pendingDelete={pendingDel.channels}
                onMarkDelete={(id) => markDelete('channels', id)}
                onUndoDelete={(id) => undoDelete('channels', id)}
                test={{
                  testing,
                  msg: testMsg == null ? null : { kind: testMsg.kind, text: testMsg.text },
                  onSend: () => void sendTest()
                }}
              />
            </Slot>
            <Slot anchor="push-policy" flashId={flashId}>
              <NotifyCard
                notify={draft.notify}
                onChange={(notify) => patch({ notify })}
                notifyEnabled={draft.notifyEnabled}
                onNotifyEnabledToggle={() => patch({ notifyEnabled: !draft.notifyEnabled })}
              />
            </Slot>
            <Slot anchor="routing" flashId={flashId}>
              <RoutingCard
                routing={draft.routing}
                onChange={(routing) => patch({ routing })}
                /* 下拉数据走生效列表（待删除的来源/规则/通道不再可选；悬挂引用由
                   whenSummary 回退显示原始 id，保存时 sanitize 清理） */
                sources={effDraft?.sources ?? []}
                priceRules={effDraft?.priceRules ?? []}
                channels={effDraft?.channels ?? []}
                pendingDelete={pendingDel.routing}
                onMarkDelete={(id) => markDelete('routing', id)}
                onUndoDelete={(id) => undoDelete('routing', id)}
              />
            </Slot>
            <Slot anchor="remote" flashId={flashId}>
              <RemoteControlCard
                rc={draft.notify.remoteControl}
                onChange={(rc) => patch({ notify: { ...draft.notify, remoteControl: rc } })}
              />
            </Slot>
          </section>

          {/* 05 通用（grp-run）：运行节奏（含关窗行为/外观）+ 代理 */}
          <section className="settings-group" id={settingsAnchorDomId('grp-run')}>
            <SecHeader num={GROUPS[4].num} name={GROUPS[4].name} desc={GROUPS[4].desc} />
            <Slot anchor="run-pace" flashId={flashId}>
              <RunPaceCard
                pollIntervalText={draft.pollIntervalText}
                intervalValid={intervalValid}
                intervalTooLow={intervalTooLow}
                dailyEnabled={draft.dailyEnabled}
                dailyTime={draft.dailyTime}
                launchAtLogin={draft.launchAtLogin}
                closeBehavior={draft.closeBehavior}
                onIntervalChange={(v) => patch({ pollIntervalText: v })}
                onDailyToggle={() => patch({ dailyEnabled: !draft.dailyEnabled })}
                onDailyTimeChange={(v) => patch({ dailyTime: v })}
                onLaunchToggle={() => patch({ launchAtLogin: !draft.launchAtLogin })}
                onCloseBehaviorChange={(v) => patch({ closeBehavior: v })}
              />
            </Slot>
            <Slot anchor="proxy" flashId={flashId}>
              <ProxyCard
                proxyUrl={draft.proxyUrl}
                proxyScope={draft.proxyScope}
                schemeBad={proxySchemeBad}
                onUrlChange={(v) => patch({ proxyUrl: v })}
                onScopeChange={(v) => patch({ proxyScope: v })}
              />
            </Slot>
          </section>

          {/* 06 数据与诊断（grp-data） */}
          <section className="settings-group" id={settingsAnchorDomId('grp-data')}>
            <SecHeader num={GROUPS[5].num} name={GROUPS[5].name} desc={GROUPS[5].desc} />
            <Slot anchor="data" flashId={flashId}>
              <DataCard />
            </Slot>
            <Slot anchor="match-test" flashId={flashId}>
              <MatchTestCard sources={draft.sources} dirty={dirty} />
            </Slot>
          </section>

          {/* 07 关于（grp-about） */}
          <section className="settings-group" id={settingsAnchorDomId('grp-about')}>
            <SecHeader num={GROUPS[6].num} name={GROUPS[6].name} desc={GROUPS[6].desc} />
            <Slot anchor="about" flashId={flashId}>
              <AboutCard />
            </Slot>
          </section>

          {/* Zone C · 吸底保存栏（全页唯一保存出口） */}
          <SettingsSavebar
            dirtyCount={dirtyCount}
            deleteCount={deleteCount}
            saving={saving}
            msg={saveMsg == null ? null : { kind: saveMsg.kind, text: saveMsg.text }}
            confirming={confirmDiscard}
            onSave={() => void save()}
            onDiscardStart={() => setConfirmDiscard(true)}
            onDiscardCancel={() => setConfirmDiscard(false)}
            onDiscardConfirm={discardDraft}
          />
        </div>
      </div>
    </div>
  )
}
