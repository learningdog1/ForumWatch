/**
 * 最近命中列表：时间 · 分类徽标 · 标题（openExternal，仅 nodeseek 域会被主进程放行）
 * · 命中词 chips · 推送状态（✓已推送 / ✗推送失败[hover 见原因] / −静音[hover 见说明]）。
 * 时间取 notifiedAt（推送时间）；静音/失败命中没有推送时间，退而取帖子 lastActiveAt。
 */
import type { HitRecord } from '@shared/types'
import { formatClock } from '../lib/time'

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

export function HitList(props: { hits: HitRecord[] }) {
  const { hits } = props
  return (
    <section className="card">
      <div className="card-head">
        <span className="card-title">最近命中</span>
        <span className="card-count">{hits.length > 0 ? `${hits.length} 条` : ''}</span>
      </div>
      <div className="card-scroll">
        {hits.length === 0 ? (
          <div className="empty">还没有命中——配置关键词后，论坛新帖命中时会出现在这里</div>
        ) : (
          hits.map((hit) => (
            <div className="hit" key={hit.topic.id}>
              <time>{formatClock(hit.notifiedAt ?? hit.topic.lastActiveAt)}</time>
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
              <span className="chips">
                {hit.matchedKeywords.map((kw) => (
                  <span className="chip" key={kw} title={`命中词：${kw}`}>
                    {kw}
                  </span>
                ))}
              </span>
              <PushState hit={hit} />
            </div>
          ))
        )}
      </div>
    </section>
  )
}
