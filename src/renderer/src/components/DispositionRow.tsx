/**
 * 判定行（Watchtower 步骤 L，concept.html dispositions 屏 .tbl 表行形制）：
 * 去向页唯一消费者。
 *
 * - 收起态（<tr class="disp-row">）：时间（mono）· 来源（mono 小字）· 帖子 · 解释
 *   （.hit-t 标题行 + .why 解释小字——detail 优先，缺失时用该 outcome 的语义
 *   描述兜底，不编造解释）· 原因（.rb = 组色点 + 7 组组名）· › 展开指示。
 *   行点击 / Enter / Space 展开（roving 契约 data-disp-index / tabIndex /
 *   .row-selected 原样，HitRow table 变体同款）。
 * - 展开态（<tr class="disp-row-x"> 跨列行）三块全保留：完整原因（detail +
 *   按 outcome 的解释话术，先结论后机制后动作）· 同帖处置轨迹（正序，点击跳
 *   对应行）· 按 outcome 的「去调整」设置锚点出口 + 复制标题（反馈 = 图标
 *   原位互换 + 文字恒「复制标题」+ ok/err 色档，1.5s 复原）。
 * - 7 组分组（DISPOSITION_GROUPS + dispositionGroupOf）在本文件定义并导出：
 *   14 类真实 outcome（DISPOSITION_OUTCOMES 全集，Record 全键保证编译期
 *   完整性）按语义归并；去向页分布条 / legend / 筛选 chips / 原因列同源
 *   消费——同一映射，防两处口径漂移。
 * - 不提供「打开原帖」：Disposition 结构无 url 字段，不臆造拼接规则
 *   （dispositions.md §2.3 明确拒绝）。
 * - 明确不并入 HitList：去向行（outcome/轨迹/跳转）与命中行（matchedBy/投票/
 *   推送态）结构不同，独立成组件杜绝第二份拷贝（§5）。
 */
import { Fragment, useEffect, useRef, useState } from 'react'
import type { Disposition, DispositionOutcome } from '@shared/ipc'
import { sourceLabel } from '../lib/status'
import { formatClock } from '../lib/time'
import { IconCheck, IconCopy, IconX } from './icons'

/**
 * 「去调整」深链的设置锚点（阶段 2 只切到设置页；锚点定位在设置页阶段接入，
 * 取值与设置六组分组对齐：① 监控内容 · ② 智能匹配 · ③ 推送通知）。
 */
export type DispositionSettingsAnchor =
  | 'keywords' // ① 关键词（包含词/排除词）
  | 'sources' // ① 来源过滤
  | 'match-mode' // ② 监控模式（兴趣描述/置信度阈值）
  | 'similarity' // ② 相似降噪
  | 'push-channels' // ③ 推送通道
  | 'push-policy' // ③ 推送策略

/** outcome → 徽标文案（R7-W1 资产，原样迁移；全覆盖 14 类） */
export const OUTCOME_LABELS: Record<DispositionOutcome, string> = {
  pushed: '已推送',
  'push-failed': '推送失败',
  muted: '静音',
  deferred: '已挂起',
  'deferred-skip': '挂起中',
  'semantic-pending': '语义待判',
  filtered: '来源过滤',
  'old-below-threshold': '旧帖',
  pinned: '置顶',
  excluded: '排除词',
  'similar-swallowed': '相似去重',
  miss: '未命中',
  'semantic-miss': '语义未中',
  'semantic-below-threshold': '置信度低'
}

/* ── 7 组去向分组（步骤 L：概念稿 7 段堆叠分布条 / legend / 筛选 chips）────
   14 类真实 outcome（shared/ipc DISPOSITION_OUTCOMES）按语义归并成 7 组；
   组 id 即分布条段 / legend dot / 筛选 chip / 表原因列的 tone 类名后缀
   （events.css .g-<id> 组色，令牌派生）。旧 5 分组（all/push/blocked/miss/
   hold）的「已拦截」大杂烩拆开：排除词（一票否决）/ 来源过滤（进链路前）/
   重复·限频（降噪）语义不同，分开才能回答「为什么没推送」。 */
export type DispositionGroupId = 'miss' | 'excluded' | 'filtered' | 'score' | 'dup' | 'hold' | 'push'

export interface DispositionGroup {
  id: DispositionGroupId
  /** 组名（legend / chip / 原因列文案） */
  label: string
  /** 组内 outcome 全集（只作展示/统计；判定走下方 Record 全键映射） */
  outcomes: readonly DispositionOutcome[]
}

export const DISPOSITION_GROUPS: readonly DispositionGroup[] = [
  { id: 'miss', label: '未命中', outcomes: ['miss', 'semantic-miss'] },
  { id: 'excluded', label: '排除词否决', outcomes: ['excluded'] },
  { id: 'filtered', label: '来源过滤', outcomes: ['filtered', 'old-below-threshold', 'pinned'] },
  { id: 'score', label: '评分不足', outcomes: ['semantic-below-threshold'] },
  { id: 'dup', label: '重复·限频', outcomes: ['similar-swallowed'] },
  { id: 'hold', label: '挂起中', outcomes: ['deferred', 'deferred-skip', 'semantic-pending'] },
  { id: 'push', label: '推送结果', outcomes: ['pushed', 'push-failed', 'muted'] }
]

/** outcome → 组 id（Record 全键：DISPOSITION_OUTCOMES 扩枚举时编译期即报缺） */
const OUTCOME_GROUP: Record<DispositionOutcome, DispositionGroupId> = {
  miss: 'miss',
  'semantic-miss': 'miss',
  excluded: 'excluded',
  filtered: 'filtered',
  'old-below-threshold': 'filtered',
  pinned: 'filtered',
  'semantic-below-threshold': 'score',
  'similar-swallowed': 'dup',
  deferred: 'hold',
  'deferred-skip': 'hold',
  'semantic-pending': 'hold',
  pushed: 'push',
  'push-failed': 'push',
  muted: 'push'
}

/** outcome → 所属组对象（分布条 / legend / 原因列共用；Record 全键保证命中） */
export function dispositionGroupOf(outcome: DispositionOutcome): DispositionGroup {
  const id = OUTCOME_GROUP[outcome]
  return DISPOSITION_GROUPS.find((g) => g.id === id) ?? DISPOSITION_GROUPS[0]
}

/**
 * outcome → 徽标配色档（R7-W1 资产原样迁移：成功绿 / 失败红 / 挂起琥珀 / 其余灰；
 * 展开态轨迹 chip 与 .outcome 徽标色档对应——表行原因列的组色走组 tone 类）。
 */
export function badgeTone(outcome: DispositionOutcome): 'ok' | 'err' | 'warn' | 'muted' {
  if (outcome === 'pushed') return 'ok'
  if (outcome === 'push-failed') return 'err'
  if (
    outcome === 'deferred' ||
    outcome === 'deferred-skip' ||
    outcome === 'semantic-pending' ||
    outcome === 'semantic-below-threshold'
  ) {
    return 'warn'
  }
  return 'muted'
}

/**
 * 展开态话术（dispositions.md §2.3 定稿文案）：why 为补充解释（detail 有值时
 * 显示在其下，为空时兜底）；act 为可选的「去调整」出口（label + 设置锚点）。
 * 写作准则：先给结论、再给机制、最后给动作或「无需动作」的安慰。
 */
const OUTCOME_HELP: Record<DispositionOutcome, { why: string; act?: { label: string; anchor: DispositionSettingsAnchor } }> = {
  pushed: { why: '推送成功。同帖不会再重复记录此去向。' },
  'push-failed': {
    why: '推送尝试失败，重试在途；连续 3 次失败或挂起超 24 小时则终止。',
    act: { label: '去检查推送通道', anchor: 'push-channels' }
  },
  muted: {
    why: '记录了命中但没有推送：推送总开关关闭，或没有就绪通道。',
    act: { label: '去查看推送设置', anchor: 'push-policy' }
  },
  miss: {
    why: '标题不含任何包含词，也没触发价格规则与语义判定。包含词为空时字面档本来就不推送。',
    act: { label: '去调整关键词', anchor: 'keywords' }
  },
  'semantic-miss': {
    why: '语义判定为不相关。',
    act: { label: '去调整兴趣描述', anchor: 'match-mode' }
  },
  'semantic-below-threshold': {
    why: '语义判为相关但置信度未过阈值，按未命中处理。',
    act: { label: '去调整置信度阈值', anchor: 'match-mode' }
  },
  filtered: {
    why: '被该来源的分类白/黑名单或作者黑名单滤掉，未进入匹配。',
    act: { label: '去调整来源过滤', anchor: 'sources' }
  },
  excluded: {
    why: '标题命中全局排除词，一票否决，先于一切命中方式。',
    act: { label: '去调整排除词', anchor: 'keywords' }
  },
  pinned: { why: '置顶帖只记入已读、绝不推送——这是设计行为，不是故障。' },
  'old-below-threshold': {
    why: '被回复顶起的旧帖（编号低于已见阈值），判定为旧帖不再推送。'
  },
  'similar-swallowed': {
    why: '与 48 小时内已推送的帖子过于相似，被降噪吞并。',
    act: { label: '去调整相似降噪', anchor: 'similarity' }
  },
  deferred: {
    why: '免打扰或摘要攒批期间挂起，到点自动补发；补发成功后此帖会追加一条「已推送」。重启会清空挂起队列，仍在首页的帖子会重新处理。'
  },
  'deferred-skip': {
    why: '挂起队列成员：本轮跳过重新匹配，等待免打扰或摘要到点后随队列一并补发。'
  },
  'semantic-pending': {
    why: '已进入语义评估队列，下一轮轮询出结果；评估失败时也会停留在此状态。'
  }
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 轨迹时间戳：'MM-DD HH:mm:ss'（同帖轨迹跨小时/跨日，带日期） */
function formatTrackStamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${formatClock(iso)}`
}

/** 行唯一键（状态迁移记录：ts + 帖 + outcome 唯一） */
export function dispositionKey(d: Disposition): string {
  return `${d.ts}|${d.sourceId}|${d.topicId}|${d.outcome}`
}

/** 复制成功反馈的复原延时（ia §5.4 行内三态） */
const COPY_FEEDBACK_MS = 1500

export interface DispositionRowProps {
  record: Disposition
  /** 展开态（多行可同时展开：展开是只读行为，无互斥） */
  expanded: boolean
  /** 键盘选中态（roving tabindex：仅选中行在 Tab 序中） */
  selected: boolean
  /** 行索引（渲染为 data-disp-index，页面 roving 查询用） */
  index: number
  /** 同帖全部去向（正序、含自身；长度 >1 时展示轨迹行） */
  track: Disposition[]
  /** 轨迹跳转落点高亮（一次性动画由 .flash 承载） */
  flash?: boolean
  onToggle: () => void
  /** 点击轨迹中某条 → 滚动 + 高亮对应行（因果链反向可追） */
  onTrackJump: (target: Disposition) => void
  /** 「去调整」出口（设置锚点深链；设置页 dirty 由全局 leavebar 拦截） */
  onGoAnchor?: (anchor: DispositionSettingsAnchor) => void
}

export function DispositionRow(props: DispositionRowProps) {
  const { record } = props
  /** null=空闲（复制图标），true=已复制 ✓，false=复制失败 ✗——三元态修自旧版
      useState(false)：布尔初值使空闲分支不可达，空闲态误渲染失败图标 */
  const [copied, setCopied] = useState<boolean | null>(null)
  const copyTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current)
    }
  }, [])

  async function copyTitle(): Promise<void> {
    let ok = false
    try {
      await navigator.clipboard.writeText(record.title)
      ok = true
    } catch {
      ok = false
    }
    if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current)
    setCopied(ok)
    copyTimerRef.current = window.setTimeout(() => setCopied(null), COPY_FEEDBACK_MS)
  }

  const help = OUTCOME_HELP[record.outcome]
  const act = help.act ?? null
  const detail = record.detail != null && record.detail !== '' ? record.detail : null
  /** 收起态解释小字（.why）：detail（reason/why 等价字段）优先，缺失时用该
      outcome 的语义描述兜底——只写既有字段与定稿话术，不编造解释 */
  const whyLine = detail ?? help.why
  const group = dispositionGroupOf(record.outcome)
  const groupOutcomesText = group.outcomes.map((o) => OUTCOME_LABELS[o]).join('、')

  return (
    <Fragment>
      <tr
        className={`disp-row${props.selected ? ' row-selected' : ''}${props.flash === true ? ' flash' : ''}`}
        tabIndex={props.selected ? 0 : -1}
        data-disp-index={props.index}
        aria-expanded={props.expanded}
        aria-label={`展开原因与同帖轨迹：${record.title}`}
        onClick={props.onToggle}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          // 焦点在行上时 Enter/Space = 展开（页面级 Enter 代点会按 closest 跳过，
          // 不双触发——HitRow table 变体同款契约）
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            props.onToggle()
          }
        }}
      >
        <td className="d-time num" title={record.ts}>
          {formatClock(record.ts)}
        </td>
        <td>
          <span className="src num" title={`来源：${sourceLabel(record.sourceId)}`}>
            {sourceLabel(record.sourceId)}
          </span>
        </td>
        <td className="d-post">
          <div className="hit-t" title={record.title}>
            {record.title}
          </div>
          <div className="why" title={whyLine}>
            {whyLine}
          </div>
        </td>
        <td>
          <span
            className="rb"
            title={`去向组：${group.label}（${groupOutcomesText}）· 本条：${OUTCOME_LABELS[record.outcome]}`}
          >
            <i className={`rdot g-${group.id}`} aria-hidden="true" />
            {group.label}
          </span>
        </td>
        <td className="d-caret num" aria-hidden="true">
          ›
        </td>
      </tr>
      {props.expanded && (
        <tr className="disp-row-x">
          <td colSpan={5}>
            <div className="disp-expand">
              <div className="ex-row">
                <span className="ex-k">原因</span>
                <span className="ex-v">
                  {detail != null && <span className="ex-detail">{detail}</span>}
                  <span className="ex-why">{help.why}</span>
                </span>
              </div>
              {props.track.length > 1 && (
                <div className="ex-row">
                  <span className="ex-k">轨迹</span>
                  <span className="ex-v ex-track">
                    {props.track.map((t, i) => (
                      <Fragment key={dispositionKey(t)}>
                        {i > 0 && (
                          <span className="track-sep" aria-hidden>
                            →
                          </span>
                        )}
                        <button
                          type="button"
                          className={`track-item ${badgeTone(t.outcome)}`}
                          title={`${t.title} · ${OUTCOME_LABELS[t.outcome]}`}
                          onClick={() => props.onTrackJump(t)}
                        >
                          <span className="num">{formatTrackStamp(t.ts)}</span>
                          {OUTCOME_LABELS[t.outcome]}
                        </button>
                      </Fragment>
                    ))}
                    <span className="track-note">（本页已加载记录中该帖的全部去向）</span>
                  </span>
                </div>
              )}
              <div className="ex-actions">
                {act != null && props.onGoAnchor != null && (
                  <button
                    type="button"
                    className="disp-link"
                    title="跳转到设置页对应分组（有未保存修改时会先询问）"
                    onClick={() => props.onGoAnchor?.(act.anchor)}
                  >
                    {act.label}
                  </button>
                )}
                <button
                  type="button"
                  className={`btn btn-sm${copied === false ? ' err' : copied ? ' ok' : ''}`}
                  title={copied === false ? '复制失败' : copied ? '已复制标题' : undefined}
                  onClick={() => void copyTitle()}
                >
                  {/* 图标原位互换（复制→成功✓/失败✗）+ 文字恒「复制标题」——宽度零跳动（§C-9） */}
                  {copied === false ? (
                    <IconX size={12} />
                  ) : copied ? (
                    <IconCheck size={12} />
                  ) : (
                    <IconCopy size={12} />
                  )}
                  复制标题
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  )
}
