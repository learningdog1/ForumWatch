/**
 * 最近命中列表：时间 · 来源徽标 · 分类徽标 · 标题（openExternal，仅已配置
 * 来源的域会被主进程放行）· 命中方式徽标（字面/语义/规则）· 命中词 chips、
 * AI 判定理由或命中规则名 · 锐评行（commentary 非空时，💬 前缀 + ai-reason
 * 同款斜体小字；旧 hits/*.jsonl 行无该字段，?? null 归一后不展示）· 推送状态
 * （✓已推送 / ✗推送失败[hover 见原因] / −静音[hover 见说明]）· 反馈按钮
 * （R7-W4：👍/👎 三态，见 VoteButtons）。
 * 时间取 notifiedAt（推送时间）；静音/失败命中没有推送时间，退而取帖子 lastActiveAt。
 */
import { useState, type CSSProperties } from 'react'
import type { HitRecord } from '@shared/types'
import { sourceLabel } from '../lib/status'
import { formatClock } from '../lib/time'
import { EmptyState } from './EmptyState'
import { IconRefresh } from './icons'

function PushState(props: { hit: HitRecord }) {
  const { hit } = props
  if (hit.notifiedAt !== null) {
    return (
      <span className="push ok" title={`已推送于 ${hit.notifiedAt}`}>
        ✓ 已推送
      </span>
    )
  }
  if (hit.notifyError !== null) {
    return (
      <span className="push err" title={hit.notifyError}>
        ✗ 推送失败
      </span>
    )
  }
  return (
    <span className="push muted" title="命中已记录但未推送：推送总开关关闭，或 Telegram 未配置">
      − 静音
    </span>
  )
}

/**
 * 锐评行（第三轮）：commentary 非空时展示，与 AI 理由同款 ai-reason 斜体小字，
 * 💬 前缀区分。旧 hits/*.jsonl 行没有该字段（调用处 ?? null 归一），空/缺失
 * 时整行省略；与语义理由行并存时两行独立展示。
 */
function CommentaryLine(props: { commentary: string | null }) {
  const { commentary } = props
  if (commentary === null || commentary === '') return null
  return (
    <span className="ai-reason" title={commentary}>
      💬 {commentary}
    </span>
  )
}

/**
 * 命中方式区：字面 → 命中词 chips；语义 → AI 理由（斜体小字）；规则（R5-P2c）→
 * 规则徽标 + 命中规则名（对齐 semanticReason 的展示位；matchedRule 为旧记录
 * 可选字段，?? null 归一后空则只显徽标）；锐评（有则附同区域）。
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
        {/* 结构化命中通道：绿色描边与字面（中性）/语义（AI 紫）区分，色值走令牌 */}
        <span
          className="how-badge"
          style={{
            borderColor: 'color-mix(in srgb, var(--ok) 45%, transparent)',
            color: 'var(--ok)'
          }}
        >
          规则
        </span>
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

/** 反馈按钮基础样式（内联：本轮 global.css 不在改动清单，History 内联样式先例） */
const VOTE_BTN_BASE: CSSProperties = {
  flex: 'none',
  border: '1px solid transparent',
  background: 'none',
  padding: '0 5px',
  lineHeight: '17px',
  fontSize: 'var(--fs-12)',
  borderRadius: 'var(--radius-s)',
  cursor: 'pointer',
  opacity: 0.5
}

/**
 * 命中行反馈按钮（R7-W4，DEC-5）：右下角 👍/👎 三态——
 * 未投 = 记票；已投当前方向（高亮）再点同方向 = undo 撤销；已投另一方向 =
 * 改票（store 同键覆盖）。三态语义写在按钮 title 提示里。投票即发即忘：
 * 乐观更新本地高亮，失败回滚 + console.warn（无侵入提示，不打断 UI）。
 * 本地高亮是会话级的——与最近命中列表的内存口径一致（重启清空）；盘上
 * feedback.json 里的票跨会话进 prompt，UI 不回读（无查询 IPC）。
 */
function VoteButtons(props: { hit: HitRecord }) {
  const { hit } = props
  const [voted, setVoted] = useState<'positive' | 'negative' | null>(null)

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
          console.warn('[HitList] 反馈提交失败：', r.error)
        }
      })
      .catch((err: unknown) => {
        setVoted(prev)
        console.warn('[HitList] 反馈请求异常：', err)
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
  const active = (on: boolean, color: string): CSSProperties =>
    on ? { ...VOTE_BTN_BASE, opacity: 1, color, borderColor: `color-mix(in srgb, ${color} 45%, transparent)` } : VOTE_BTN_BASE

  return (
    <span
      className="vote-group"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none' }}
    >
      <button
        type="button"
        title={thumbTitle}
        style={active(voted === 'positive', 'var(--ok)')}
        onClick={() => vote('positive')}
      >
        👍
      </button>
      <button
        type="button"
        title={downTitle}
        style={active(voted === 'negative', 'var(--err)')}
        onClick={() => vote('negative')}
      >
        👎
      </button>
    </span>
  )
}

export function HitList(props: {
  hits: HitRecord[]
  /** 持久累计命中数（EngineStatus.totalHits）：与内存列表口径不同，空态联动展示 */
  totalHits: number
  onRunNow: () => void
  runNowDisabled: boolean
}) {
  const { hits } = props
  return (
    <section className="card">
      <div className="card-head">
        <span className="card-title">最近命中</span>
        <span className="card-count num">{hits.length > 0 ? `${hits.length} 条` : ''}</span>
      </div>
      <div className="card-scroll">
        {hits.length === 0 ? (
          props.totalHits > 0 ? (
            <EmptyState
              title="启动后还没有新命中"
              hint={`累计已命中 ${props.totalHits} 条；命中列表只保留本次运行（重启后清空），历史命中见「今日回顾」日报`}
              action={
                <button
                  type="button"
                  className="btn"
                  disabled={props.runNowDisabled}
                  title={props.runNowDisabled ? '已暂停：先恢复监控' : '忽略等待，立即补一轮轮询'}
                  onClick={props.onRunNow}
                >
                  <IconRefresh size={14} />
                  立即轮询
                </button>
              }
            />
          ) : (
            <EmptyState
              title="还没有命中"
              hint="配置关键词或兴趣描述后，论坛新帖命中时会出现在这里"
            />
          )
        ) : (
          hits.map((hit) => (
            <div className="hit" key={hit.topic.id}>
              <time className="num">{formatClock(hit.notifiedAt ?? hit.topic.lastActiveAt)}</time>
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
                onClick={() => {
                  void window.api.openExternal(hit.topic.url)
                }}
              >
                {hit.topic.title}
              </button>
              <MatchInfo hit={hit} />
              <PushState hit={hit} />
              <VoteButtons hit={hit} />
            </div>
          ))
        )}
      </div>
    </section>
  )
}
