/**
 * 最近命中列表：时间 · 来源徽标 · 分类徽标 · 标题（openExternal，仅已配置
 * 来源的域会被主进程放行）· 命中方式徽标（字面/语义）· 命中词 chips 或
 * AI 判定理由（语义命中时 matchedKeywords 恒为空，改展示 semanticReason 斜体
 * 小字）· 锐评行（commentary 非空时，💬 前缀 + ai-reason 同款斜体小字；旧
 * hits/*.jsonl 行无该字段，?? null 归一后不展示）· 推送状态（✓已推送 / ✗推送失败[hover 见原因] / −静音[hover 见说明]）。
 * 时间取 notifiedAt（推送时间）；静音/失败命中没有推送时间，退而取帖子 lastActiveAt。
 */
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

/** 命中方式区：字面 → 命中词 chips；语义 → AI 理由（斜体小字）；锐评（有则附同区域） */
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
            </div>
          ))
        )}
      </div>
    </section>
  )
}
