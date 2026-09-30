/**
 * 命中行（R10 阶段 1，dashboard.md §3.3 / REDESIGN §6.7）：全应用唯一的命中行
 * 渲染源——监控台与历史命中共用（根治两页复刻行渲染导致的文案漂移，audit #12）。
 *
 * - 结构（list 变体，现状）：时间 · 来源徽标 · 分类 pill · 标题（fs-14 正文级、
 *   点状下划线表可点，hover 实线；点击走主进程白名单受控跳转）· 命中方式徽标+
 *   依据 · 锐评 · 推送状态三态 · 反馈投票。
 * - 推送三态：✓ 已推送 / ✗ 推送失败（可点击——onPushErrorClick 由去向页接线，
 *   阶段 2 前调用方不传则 ✗ 仅 hover 见原因）/ − 静音（title 为全应用定稿
 *   文案「推送总开关关闭，或无就绪通道」，不再随通道实现漂移）。
 * - 投票（R7-W4 三态语义原样迁移）：SVG 图标 + aria-label，样式走样式表。
 * - 可选字段缺失当正常态（pc §6.5：matchedRule/commentary 旧数据缺失等价"无"）。
 *
 * Watchtower 步骤 I 变体（variant prop；缺省 'list' = 现状零变化）：
 * - 'feed'：概念稿 .feed-row 形制（监控台实时命中流）——左列 src mono 标签 +
 *   规则 badge + 规则名/命中词 + NEW 徽标（fresh 由父级控制）+ 两行截断标题 +
 *   推送状态小字（✗ 推送失败深链按钮可达）；右列价格 mono + 时间。行主体
 *   点击 / Enter / Space → openDrawer(hit)；投票移入抽屉，行内不重复放。
 * - 'table'：概念稿历史表行——标题（单行省略）/来源/规则 badge/价格/时间/
 *   状态点。行点击 / Enter / Space → openDrawer(hit)；roving 契约字段
 *   （data-hit-index / selected / onRowPointerDown）沿用。
 */
import { useEffect, useRef, useState } from 'react'
import type { HitRecord } from '@shared/types'
import { extractDeal } from '@shared/deal'
import { openDrawer } from '../lib/hit-drawer'
import { openExternalWithTitleHint } from '../lib/open-external'
import { formatClock, localDate } from '../lib/time'
import { sourceLabel } from '../lib/status'
import {
  IconBubble,
  IconCheck,
  IconMinus,
  IconThumbDown,
  IconThumbUp,
  IconX
} from './icons'

/** 投票失败行内反馈的复原延时（与复制反馈同档，TASTE-UPGRADE §C-8） */
const VOTE_ERR_MS = 1500

/** 行唯一键（与引擎去重键同构） */
export function hitRowKey(hit: HitRecord): string {
  return `${hit.topic.sourceId}:${hit.topic.id}`
}

/**
 * 命中方式 → 概念稿徽标三档（primitives.css .badge b-kw/b-price/b-ai）。
 * matchAll 无概念对应档：走关键词中性档（b-kw），文案「全匹配」，title 说明
 * 语义——不新造色（步骤 G 裁决的映射纪律）。供 feed/table 变体与命中详情
 * 抽屉共用，防两处口径漂移。
 */
export function matchedByBadge(hit: HitRecord): { label: string; cls: string; title: string } {
  switch (hit.matchedBy) {
    case 'rule':
      return { label: '价格', cls: 'b-price', title: '命中方式：价格规则' }
    case 'semantic':
      return { label: 'AI 语义', cls: 'b-ai', title: '命中方式：AI 语义' }
    case 'matchall':
      return { label: '全匹配', cls: 'b-kw', title: '命中方式：来源级全匹配（该来源开启全匹配，新帖直接命中）' }
    default:
      return { label: '关键词', cls: 'b-kw', title: '命中方式：关键词（字面）' }
  }
}

/**
 * 徽标旁的归因短句（feed 变体 .rname / 抽屉 d-meta 槽位）：规则命中给规则名、
 * 字面命中给命中词列表；语义/全匹配的归因在命中原因区，这里不给。缺失如实
 * 返回 null（不伪造）。
 */
export function matchAttribution(hit: HitRecord): { text: string; title: string } | null {
  if (hit.matchedBy === 'rule') {
    const rule = hit.matchedRule ?? null
    if (rule != null && rule !== '') return { text: rule, title: `命中规则：${rule}` }
    return null
  }
  if (hit.matchedBy === 'literal' && hit.matchedKeywords.length > 0) {
    return {
      text: hit.matchedKeywords.join(' · '),
      title: `命中词：${hit.matchedKeywords.join('、')}`
    }
  }
  return null
}

/**
 * 标题价格短文案（feed 右列 / 历史表价格列 / 抽屉 d-price）：按 extractDeal
 * 现算（与引擎判定同源提取器，渲染端直接复用）。无价格给 '—'；外币（USD）
 * 不折算、如实显示原币种；周期有值时作后缀（/年 · /月）。
 */
export function dealPriceText(title: string): string {
  const deal = extractDeal(title)
  const price = deal?.price
  if (price == null) return '—'
  const sym = price.currency === 'CNY' ? '¥' : '$'
  const cycle = deal?.cycle === 'yearly' ? '/年' : deal?.cycle === 'monthly' ? '/月' : ''
  return `${sym}${price.amount}${cycle}`
}

/**
 * 标题提取全量摘要（hover title / 抽屉「价格提取」事实行）：
 * 「周期=年付 · 价格=¥28.9 · 流量=300G」形态，仅含有值字段；
 * 一个字段都提取不到 → null（调用方按缺省省略，不渲染空行）。
 */
export function dealSummaryText(title: string): string | null {
  const deal = extractDeal(title)
  if (deal == null) return null
  const parts: string[] = []
  if (deal.cycle === 'yearly') parts.push('周期=年付')
  else if (deal.cycle === 'monthly') parts.push('周期=月付')
  if (deal.price != null) {
    const sym = deal.price.currency === 'CNY' ? '¥' : '$'
    parts.push(`价格=${sym}${deal.price.amount}${deal.price.currency === 'USD' ? '（美元，未折算）' : ''}`)
  }
  if (deal.trafficGB != null) parts.push(`流量=${deal.trafficGB}G`)
  return parts.length > 0 ? parts.join(' · ') : null
}

/** ISO → 本地全时戳「YYYY-MM-DD HH:mm:ss」（推送时间等的完整口径）；无效原样返回 */
export function formatHitTimestamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${localDate(d)} ${formatClock(iso)}`
}

/** 推送状态三态：✓/✗/− 全 SVG；✗ 在有深链回调时可点击（跳去向页排障） */
function PushState(props: { hit: HitRecord; onPushErrorClick?: (hit: HitRecord) => void }) {
  const { hit, onPushErrorClick } = props
  if (hit.notifiedAt !== null) {
    return (
      <span className="push ok" title={`已推送于 ${hit.notifiedAt}`}>
        <IconCheck size={12} />
        已推送
      </span>
    )
  }
  if (hit.notifyError !== null) {
    if (onPushErrorClick != null) {
      return (
        <button
          type="button"
          className="push err push-fail"
          title={hit.notifyError}
          onClick={(e) => {
            // feed 变体行主体点击是开抽屉：深链按钮须截停，跳去向页排障
            e.stopPropagation()
            onPushErrorClick(hit)
          }}
        >
          <IconX size={12} />
          推送失败
        </button>
      )
    }
    return (
      <span className="push err" title={hit.notifyError}>
        <IconX size={12} />
        推送失败
      </span>
    )
  }
  return (
    <span className="push muted" title="命中已记录但未推送：推送总开关关闭，或无就绪通道">
      <IconMinus size={12} />
      静音
    </span>
  )
}

/** 锐评行：SVG 气泡 + 斜体小字；空/缺失时整行省略 */
function CommentaryLine(props: { commentary: string | null }) {
  const { commentary } = props
  if (commentary === null || commentary === '') return null
  return (
    <span className="commentary" title={commentary}>
      <IconBubble size={12} />
      {commentary}
    </span>
  )
}

/**
 * 命中方式区：字面 → 命中词 chips；语义 → AI 理由（斜体小字）；规则 →
 * 规则徽标（.how-badge.rule 类，色值走 token——原内联样式收敛）+ 命中规则名；
 * 全匹配（R13-2）→ 琥珀徽标（该来源 matchAll 覆盖的直接命中，无命中词/理由）。
 */
function MatchInfo(props: { hit: HitRecord }) {
  const { hit } = props
  const commentary = hit.commentary ?? null
  if (hit.matchedBy === 'semantic') {
    return (
      <span className="hit-how semantic">
        <span className="how-badge">语义</span>
        {hit.semanticReason != null && (
          <span className="ai-reason" title={hit.semanticReason}>
            AI: {hit.semanticReason}
          </span>
        )}
        <CommentaryLine commentary={commentary} />
      </span>
    )
  }
  if (hit.matchedBy === 'rule') {
    // 旧 hits/*.jsonl 行无 matchedRule 字段（可选），缺失等价"非规则命中时的空"
    const matchedRule = hit.matchedRule ?? null
    return (
      <span className="hit-how rule">
        <span className="how-badge">规则</span>
        {matchedRule != null && matchedRule !== '' && (
          <span className="ai-reason" title={`命中规则：${matchedRule}`}>
            {matchedRule}
          </span>
        )}
        <CommentaryLine commentary={commentary} />
      </span>
    )
  }
  if (hit.matchedBy === 'matchall') {
    return (
      <span className="hit-how matchall" title="该来源开启了全匹配：新帖直接命中">
        <span className="how-badge">全匹配</span>
        <CommentaryLine commentary={commentary} />
      </span>
    )
  }
  return (
    <span className="hit-how">
      <span className="how-badge">字面</span>
      <span className="chips">
        {hit.matchedKeywords.map((kw) => (
          <span className="chip" key={kw} title={`命中词：${kw}`}>
            {kw}
          </span>
        ))}
      </span>
      <CommentaryLine commentary={commentary} />
    </span>
  )
}

/**
 * 命中行反馈按钮（R7-W4，DEC-5）：👍/👎 三态——未投=记票；已投当前方向再点
 * 同方向=undo 撤销；已投另一方向=改票。三态语义写在 title/aria-label 里。
 * 投票即发即忘：乐观更新本地高亮，失败回滚 + 行内短暂 err 反馈（「反馈提交
 * 失败，已还原」1.5s 复原，TASTE-UPGRADE §C-8——错误是一等公民，不再只进
 * console）；本地高亮是会话级的（与最近命中列表的内存口径一致，重启清空）。
 */
function VoteButtons(props: { hit: HitRecord }) {
  const { hit } = props
  const [voted, setVoted] = useState<'positive' | 'negative' | null>(null)
  /** 提交失败的行内反馈（乐观高亮已回滚，失败必须可见） */
  const [voteErr, setVoteErr] = useState(false)
  const errTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (errTimerRef.current != null) window.clearTimeout(errTimerRef.current)
    }
  }, [])

  /** 亮出失败文案 1.5s 后复原；连续失败重置计时 */
  function flashVoteErr(): void {
    if (errTimerRef.current != null) window.clearTimeout(errTimerRef.current)
    setVoteErr(true)
    errTimerRef.current = window.setTimeout(() => {
      errTimerRef.current = null
      setVoteErr(false)
    }, VOTE_ERR_MS)
  }

  const vote = (direction: 'positive' | 'negative'): void => {
    const action = voted === direction ? 'undo' : direction
    const prev = voted
    setVoted(action === 'undo' ? null : direction)
    void window.api
      .hitFeedback({
        sourceId: hit.topic.sourceId,
        topicId: hit.topic.id,
        title: hit.topic.title,
        direction: action
      })
      .then((r) => {
        if (!r.ok) {
          setVoted(prev)
          flashVoteErr()
          console.warn('[HitRow] 反馈提交失败：', r.error)
        }
      })
      .catch((err: unknown) => {
        setVoted(prev)
        flashVoteErr()
        console.warn('[HitRow] 反馈请求异常：', err)
      })
  }

  const thumbTitle =
    voted === 'positive'
      ? '已标记为想要：再点一次撤销反馈'
      : voted === 'negative'
        ? '改为想要（撤销"不想要"标记）'
        : '标记为想要：同类新帖更可能被判相关（AI 反馈）'
  const downTitle =
    voted === 'negative'
      ? '已标记为不想要：再点一次撤销反馈'
      : voted === 'positive'
        ? '改为不想要（撤销"想要"标记）'
        : '标记为不想要：同类新帖更可能被判不相关（AI 反馈）'

  return (
    <span className="vote-group">
      <button
        type="button"
        className={`vote-btn up${voted === 'positive' ? ' on' : ''}`}
        title={thumbTitle}
        aria-label={thumbTitle}
        data-vote="positive"
        onClick={() => vote('positive')}
      >
        <IconThumbUp size={14} />
      </button>
      <button
        type="button"
        className={`vote-btn down${voted === 'negative' ? ' on' : ''}`}
        title={downTitle}
        aria-label={downTitle}
        data-vote="negative"
        onClick={() => vote('negative')}
      >
        <IconThumbDown size={14} />
      </button>
      {voteErr && <span className="feedback err">反馈提交失败，已还原</span>}
    </span>
  )
}

export interface HitRowProps {
  hit: HitRecord
  /**
   * 行形制（Watchtower 步骤 I）：'list'（缺省，现状零变化）/ 'feed'（监控台
   * 实时命中流，概念 .feed-row）/ 'table'（历史命中表行，概念 .tbl 行）。
   * feed/table 行主体点击 → openDrawer(hit)。
   */
  variant?: 'list' | 'feed' | 'table'
  /** feed 变体 NEW 徽标（父级控制「新到达」；list/table 不消费） */
  fresh?: boolean
  /** 时间列文案（监控台 HH:mm:ss；历史页跨日视图给 'MM-DD HH:mm' 宽列） */
  time: string
  /** 宽时间列（历史页跨日视图） */
  timeWide?: boolean
  /** 时间列 title（绝对时间戳等；缺省不带） */
  timeTitle?: string
  /** 是否渲染投票按钮（监控台有；历史页阶段 3 决定）。feed 变体投票移入抽屉，行内不渲染 */
  showVotes?: boolean
  /** 推送失败 ✗ → 去向页搜索深链（阶段 2 接线；缺省 ✗ 不可点只 hover 原因） */
  onPushErrorClick?: (hit: HitRecord) => void
  /** 行索引（监控台键盘 roving 用；渲染为 data-hit-index） */
  index?: number
  /** 键盘选中态（焦点行高亮 + 内侧焦点环） */
  selected?: boolean
  /** 指针选中同步（监控台点击行时同步 roving 选中位） */
  onRowPointerDown?: () => void
}

/** 行主体激活（点击 / Enter / Space）统一开口：feed/table 变体共用 */
function activateRow(hit: HitRecord): void {
  openDrawer(hit)
}

/**
 * feed 变体（概念 .feed-row）：左列 meta（src mono + 规则 badge + 归因 + NEW）
 * + 两行截断标题（.feed-row h4 由样式层收编 line-clamp）+ 推送状态小字（✗
 * 推送失败深链按钮在位）；右列价格 mono + 时间。行主体点击 / Enter / Space →
 * openDrawer；投票按钮移入抽屉（showVotes 不消费）。
 */
function HitRowFeed(props: HitRowProps) {
  const { hit } = props
  const badge = matchedByBadge(hit)
  const attribution = matchAttribution(hit)
  return (
    <article
      className={`feed-row${props.selected === true ? ' selected row-selected' : ''}`}
      data-hit-index={props.index}
      tabIndex={0}
      aria-label={`查看命中详情：${hit.topic.title}（Enter 打开）`}
      onPointerDown={props.onRowPointerDown}
      onClick={() => activateRow(hit)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          activateRow(hit)
        }
      }}
    >
      <div className="f-main">
        <div className="f-meta">
          <span className="src num" title={`来源：${sourceLabel(hit.topic.sourceId)}`}>
            {sourceLabel(hit.topic.sourceId)}
          </span>
          <span className={`badge ${badge.cls}`} title={badge.title}>
            {badge.label}
          </span>
          {attribution != null && (
            <span className="rname" title={attribution.title}>
              {attribution.text}
            </span>
          )}
          {props.fresh === true && <span className="new-tag">NEW</span>}
        </div>
        <h4>{hit.topic.title}</h4>
        <div className="f-sub">
          <PushState hit={hit} onPushErrorClick={props.onPushErrorClick} />
        </div>
      </div>
      <div className="f-side">
        <span
          className="price num"
          title={dealSummaryText(hit.topic.title) ?? '标题未提取出价格'}
        >
          {dealPriceText(hit.topic.title)}
        </span>
        <time className="tm num" title={props.timeTitle}>
          {props.time}
        </time>
      </div>
    </article>
  )
}

/**
 * table 变体（概念历史表行）：标题（.hit-t 单行省略）/ 来源 / 规则 badge /
 * 价格 / 时间 / 状态点。行点击 / Enter / Space → openDrawer；tabIndex +
 * data-hit-index + selected / onRowPointerDown 沿用 list 的 roving 契约字段。
 */
function HitRowTable(props: HitRowProps) {
  const { hit } = props
  const badge = matchedByBadge(hit)
  const status = pushStatusView(hit)
  return (
    <tr
      className={props.selected === true ? 'selected row-selected' : undefined}
      data-hit-index={props.index}
      tabIndex={0}
      aria-label={`查看命中详情：${hit.topic.title}（Enter 打开）`}
      onPointerDown={props.onRowPointerDown}
      onClick={() => activateRow(hit)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          activateRow(hit)
        }
      }}
    >
      <td>
        <div className="hit-t" title={hit.topic.title}>
          {hit.topic.title}
        </div>
      </td>
      <td>
        <span className="src num" title={`来源：${sourceLabel(hit.topic.sourceId)}`}>
          {sourceLabel(hit.topic.sourceId)}
        </span>
      </td>
      <td>
        <span className={`badge ${badge.cls}`} title={badge.title}>
          {badge.label}
        </span>
      </td>
      <td className="num" title={dealSummaryText(hit.topic.title) ?? '标题未提取出价格'}>
        {dealPriceText(hit.topic.title)}
      </td>
      <td className="num" title={props.timeTitle}>
        {props.time}
      </td>
      <td>
        <span className="st" title={status.title}>
          <span className={`dot ${status.tone}`} aria-hidden="true" />
          {status.label}
        </span>
      </td>
    </tr>
  )
}

/** 推送三态 → 状态点色调（dashboard.css tone-* 族）与文案；title 带完整口径 */
function pushStatusView(hit: HitRecord): { tone: string; label: string; title: string } {
  if (hit.notifiedAt !== null) {
    return { tone: 'tone-ok', label: '已推送', title: `已推送于 ${formatHitTimestamp(hit.notifiedAt)}` }
  }
  if (hit.notifyError !== null) {
    return { tone: 'tone-challenged', label: '推送失败', title: hit.notifyError }
  }
  return {
    tone: 'tone-paused',
    label: '静音',
    title: '命中已记录但未推送：推送总开关关闭，或无就绪通道'
  }
}

export function HitRow(props: HitRowProps) {
  const { hit } = props
  const variant = props.variant ?? 'list'
  if (variant === 'feed') return <HitRowFeed {...props} />
  if (variant === 'table') return <HitRowTable {...props} />
  const votes = props.showVotes !== false
  return (
    <div
      className={`hit${props.selected === true ? ' selected row-selected' : ''}`}
      data-hit-index={props.index}
      onPointerDown={props.onRowPointerDown}
    >
      <time className={`num${props.timeWide === true ? ' wide' : ''}`} title={props.timeTitle}>
        {props.time}
      </time>
      <span className="src-badge" title={`来源：${sourceLabel(hit.topic.sourceId)}`}>
        {sourceLabel(hit.topic.sourceId)}
      </span>
      <span className="cat" title={`分类：${hit.topic.category}`}>
        {hit.topic.category}
      </span>
      <button
        type="button"
        className="hit-title"
        title={`打开：${hit.topic.title}`}
        onClick={(e) => {
          void openExternalWithTitleHint(e.currentTarget, hit.topic.url)
        }}
      >
        {hit.topic.title}
      </button>
      <MatchInfo hit={hit} />
      <PushState hit={hit} onPushErrorClick={props.onPushErrorClick} />
      {votes && <VoteButtons hit={hit} />}
    </div>
  )
}
