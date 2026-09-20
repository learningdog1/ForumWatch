/**
 * 命中行（R10 阶段 1，dashboard.md §3.3 / REDESIGN §6.7）：全应用唯一的命中行
 * 渲染源——监控台与历史命中共用（根治两页复刻行渲染导致的文案漂移，audit #12）。
 *
 * - 结构：时间 · 来源徽标 · 分类 pill · 标题（fs-14 正文级、点状下划线表可点，
 *   hover 实线；点击走主进程白名单受控跳转）· 命中方式徽标+依据 · 锐评 ·
 *   推送状态三态 · 反馈投票。
 * - 推送三态：✓ 已推送 / ✗ 推送失败（可点击——onPushErrorClick 由去向页接线，
 *   阶段 2 前调用方不传则 ✗ 仅 hover 见原因）/ − 静音（title 为全应用定稿
 *   文案「推送总开关关闭，或无就绪通道」，不再随通道实现漂移）。
 * - 投票（R7-W4 三态语义原样迁移）：SVG 图标 + aria-label，样式走样式表。
 * - 可选字段缺失当正常态（pc §6.5：matchedRule/commentary 旧数据缺失等价"无"）。
 */
import { useEffect, useRef, useState } from 'react'
import type { HitRecord } from '@shared/types'
import { openExternalWithTitleHint } from '../lib/open-external'
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
          onClick={() => onPushErrorClick(hit)}
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
 * 规则徽标（.how-badge.rule 类，色值走 token——原内联样式收敛）+ 命中规则名。
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
  /** 时间列文案（监控台 HH:mm:ss；历史页跨日视图给 'MM-DD HH:mm' 宽列） */
  time: string
  /** 宽时间列（历史页跨日视图） */
  timeWide?: boolean
  /** 时间列 title（绝对时间戳等；缺省不带） */
  timeTitle?: string
  /** 是否渲染投票按钮（监控台有；历史页阶段 3 决定） */
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

export function HitRow(props: HitRowProps) {
  const { hit } = props
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
