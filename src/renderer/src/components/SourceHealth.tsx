/**
 * 来源健康度表（Watchtower 步骤 J，概念稿 dash-grid 左栏 .tbl）：每个启用来源
 * 一行，数据 join status.sources（运行态）× config.sources（方式标签 / 展示名）×
 * getStats(1).bySource（今日命中）。列：
 * - 状态：健康点（ok=正常 / warn=退避 / err=被拦，与 tone-* 同映射）；title 带
 *   健康文案（退避中含 mm:ss 倒计时）与 lastError——原 StatusCard SourceRow
 *   的信息收编，一项不丢。
 * - 来源：展示名 + 方式 label（网页抓取/API/RSS 2.0）+ 间隔。间隔是全局
 *   pollIntervalSec（引擎无 per-source 间隔，如实同一值展示，不伪造差异）。
 * - 延迟：lastPollDurationMs（仅计抓取本身；成功才写入、失败清 null）格式化
 *   412ms / 2.3s；null 显 '—'（title 说明口径）。>3s 加 .mini-tag「慢」。
 * - 上次轮询：lastSuccessAt 相对时间（title 注明口径 = 上次成功 + 绝对时刻）。
 * - 今日：getStats(1) 落盘口径的当日命中数。
 * 行不可点：无 per-source 详情 IPC，不造假交互（概念行可点是演示行为）。
 */
import type { SourceStatus, SourceType } from '@shared/types'
import { sourceLabel } from '../lib/status'
import { formatCountdown, formatRelative } from '../lib/time'

/** 慢源阈值：单次抓取超过 3s 视为慢（概念稿 LowEndTalk 4.5s 示例对位） */
const SLOW_MS = 3000

/** 来源类型 → 方式 label（概念稿设置页口径） */
export function sourceMethodLabel(type: SourceType): string {
  if (type === 'nodeseek') return '网页抓取'
  if (type === 'v2ex') return 'API'
  return 'RSS 2.0'
}

/** 毫秒 → 概念稿紧凑读法：412ms / 2.3s */
function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** 秒 → 概念稿紧凑读法：30s / 2m */
function formatInterval(sec: number): string {
  return sec < 60 ? `${sec}s` : `${Math.round(sec / 60)}m`
}

/** 健康点 title：健康文案（退避含倒计时）+ 最近错误（原 SourceRow 语义） */
function dotTitle(s: SourceStatus, now: number): string {
  const parts: string[] = []
  if (s.health === 'ok') parts.push('正常')
  else if (s.health === 'backoff') {
    const cooldown =
      s.cooldownUntil != null ? formatCountdown(Date.parse(s.cooldownUntil) - now) : null
    parts.push(cooldown != null ? `退避中 · 距下次重试 ${cooldown}` : '退避重试中')
  } else parts.push('抓取被 Cloudflare 拦截')
  if (s.lastError != null) parts.push(`最近错误：${s.lastError}`)
  parts.push(`连续失败 ${s.consecutiveFailures} 次`)
  return parts.join('\n')
}

export function SourceHealth(props: {
  /** 运行态来源列表（EngineStatus.sources；空 = 无启用来源） */
  sources: SourceStatus[]
  /** sourceId → 方式 label（getConfig().sources 派生；null = 配置未读到） */
  methodById: Record<string, string> | null
  /** sourceId → 配置展示名（getConfig().sources 的 rss label 派生；无 label 回退 sourceLabel） */
  labelById: Record<string, string> | null
  /** 全局轮询间隔秒（AppConfig.pollIntervalSec；null = 配置未读到，行内省略） */
  intervalSec: number | null
  /** sourceId → 今日命中数（getStats(1).bySource 派生；null = 未读到） */
  todayBySource: Record<string, number> | null
  /** 跳动的当前时刻（相对时间/退避倒计时每秒重算） */
  now: number
}) {
  const { sources, now } = props

  return (
    <section className="panel panel-sources">
      <div className="panel-h">
        <h3>来源健康度</h3>
        <span className="ph-tag">Sources</span>
      </div>
      {sources.length === 0 ? (
        <div className="src-empty">暂无启用中的来源 · 去设置添加</div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th scope="col">状态</th>
              <th scope="col">来源</th>
              <th scope="col">延迟</th>
              <th scope="col">上次轮询</th>
              <th scope="col">今日</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => {
              const duration = s.lastPollDurationMs ?? null
              const slow = duration != null && duration > SLOW_MS
              const method = props.methodById?.[s.sourceId]
              const intervalText =
                props.intervalSec != null ? formatInterval(props.intervalSec) : null
              const methodText =
                method != null && intervalText != null
                  ? `${method} · ${intervalText}`
                  : (method ?? intervalText ?? null)
              const today = props.todayBySource?.[s.sourceId]
              return (
                <tr key={s.sourceId}>
                  <td>
                    <span
                      className={`dot tone-${s.health}`}
                      title={dotTitle(s, now)}
                      aria-label={s.health === 'ok' ? '正常' : s.health === 'backoff' ? '退避中' : '被拦截'}
                      role="img"
                    />
                  </td>
                  <td>
                    <div className="src-name">
                      {props.labelById?.[s.sourceId] ?? sourceLabel(s.sourceId)}
                      {methodText != null && (
                        <small
                          title={
                            intervalText != null
                              ? '抓取方式 · 间隔为全局轮询设置（所有来源共用，无独立间隔）'
                              : '抓取方式'
                          }
                        >
                          {methodText}
                        </small>
                      )}
                      {slow && (
                        <span className="mini-tag" title={`最近一次抓取耗时 ${formatDuration(duration as number)}，超过 ${formatDuration(SLOW_MS)}`}>
                          慢
                        </span>
                      )}
                    </div>
                  </td>
                  <td
                    className="num"
                    title={
                      duration != null
                        ? `最近一次抓取耗时（仅计抓取本身；成功轮次写入，失败清空，冷却跳过保留上一值）：${formatDuration(duration)}`
                        : '最近一次轮询未完成或抓取失败（失败轮次无有效耗时）；冷却跳过的轮次保留上一值，重启后为空'
                    }
                  >
                    {duration != null ? formatDuration(duration) : '—'}
                  </td>
                  <td
                    className="num dim"
                    title={
                      s.lastSuccessAt != null
                        ? `口径 = 上次成功抓取：${s.lastSuccessAt}`
                        : '该来源自启动以来尚未成功抓取'
                    }
                  >
                    {s.lastSuccessAt == null ? '尚未成功' : formatRelative(s.lastSuccessAt, now)}
                  </td>
                  <td
                    className="num"
                    title={
                      today != null
                        ? '今日该来源命中数（getStats(1) 落盘口径）'
                        : '今日计数读取中（getStats(1) 落盘口径）'
                    }
                  >
                    {today ?? '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}
