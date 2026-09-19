/**
 * 「路由规则」卡片（R6-W4）：routing 段的 UI——按条件把命中分流到指定通道。
 *
 * - 规则列表：when 摘要（来源 / 命中方式 / 价格规则）→ 目标通道摘要 + 删除；
 * - 添加表单：来源下拉（「任意」= 不限 + 各已配置来源）、命中方式多选
 *   （字面 / 语义 / 规则）、价格规则下拉（「任意」；选中即自动勾选「规则」
 *   方式——ruleId 条件只对规则命中生效）、目标通道多选；
 * - 校验（对齐主进程 sanitizeRouting）：至少声明一个条件 + 至少一个目标通道，
 *   否则「添加」禁用并给原因；id 由 rule-N 派生去重；上限 20 条（sanitize 截断）。
 *
 * 语义说明（DEC-7）：路由按列表顺序**首条命中**生效；无任何规则命中（或未配置
 * 规则）→ 走默认 = 全部就绪通道。测试消息与日报不走路由（恒广播全部通道）。
 */
import { useState } from 'react'
import type {
  ChannelConfig,
  PriceRuleConfig,
  RoutingRule,
  RoutingWhen,
  SourceConfig
} from '@shared/types'
import { Field } from './Field'
import { IconX } from './icons'
import { isChannelReadyUi } from './ChannelsCard'

type MatchedBy = NonNullable<RoutingWhen['matchedBy']>[number]

const MATCHED_BY_LABEL: Record<MatchedBy, string> = {
  literal: '字面',
  semantic: '语义',
  rule: '规则'
}

/** when 摘要（规则列表行展示；sanitize 保证至少一个条件） */
function whenSummary(rule: RoutingRule, sources: SourceConfig[], priceRules: PriceRuleConfig[]): string {
  const parts: string[] = []
  if (rule.when.sourceId !== undefined) {
    const s = sources.find((x) => x.id === rule.when.sourceId)
    parts.push(`来源 ${s?.id ?? rule.when.sourceId}`)
  }
  if (rule.when.matchedBy !== undefined) {
    parts.push(`方式 ${rule.when.matchedBy.map((m) => MATCHED_BY_LABEL[m]).join('/')}`)
  }
  if (rule.when.ruleId !== undefined) {
    const r = priceRules.find((x) => x.id === rule.when.ruleId)
    parts.push(`规则 ${r?.label ?? r?.id ?? rule.when.ruleId}`)
  }
  return parts.length > 0 ? parts.join(' · ') : '（无条件——保存时会被丢弃）'
}

/** 新规则 id：rule-N 派生，冲突递增 */
function uniqueRuleId(rules: RoutingRule[]): string {
  let n = rules.length + 1
  while (rules.some((r) => r.id === `rule-${n}`)) n++
  return `rule-${n}`
}

export function RoutingCard(props: {
  routing: RoutingRule[]
  onChange: (routing: RoutingRule[]) => void
  sources: SourceConfig[]
  priceRules: PriceRuleConfig[]
  channels: ChannelConfig[]
}) {
  const { routing, onChange, sources, priceRules, channels } = props
  const [sourceId, setSourceId] = useState('')
  const [matchedBy, setMatchedBy] = useState<MatchedBy[]>([])
  const [ruleId, setRuleId] = useState('')
  const [targets, setTargets] = useState<string[]>([])

  const hasCondition = sourceId !== '' || matchedBy.length > 0 || ruleId !== ''
  const canAdd = hasCondition && targets.length > 0

  function toggleMatchedBy(m: MatchedBy): void {
    setMatchedBy((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]))
  }

  function toggleTarget(id: string): void {
    setTargets((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
  }

  function addRule(): void {
    if (!canAdd) return
    const when: RoutingWhen = {}
    if (sourceId !== '') when.sourceId = sourceId
    // 选了具体规则即自动限定命中方式为「规则」（ruleId 只对规则命中生效）
    const by: MatchedBy[] =
      ruleId !== '' && !matchedBy.includes('rule') ? [...matchedBy, 'rule'] : matchedBy
    if (by.length > 0) when.matchedBy = by
    if (ruleId !== '') when.ruleId = ruleId
    onChange([...routing, { id: uniqueRuleId(routing), when, channelIds: [...targets] }])
    setSourceId('')
    setMatchedBy([])
    setRuleId('')
    setTargets([])
  }

  return (
    <section className="card">
      <div className="card-head">
        <span className="card-title">路由规则</span>
        <span className="card-title-aux">{routing.length} 条</span>
      </div>
      <Field
        label="已配置规则"
        hint={
          <span>
            按列表顺序<strong>首条命中</strong>生效（声明条件之间 AND）；无规则命中走
            <strong>全部就绪通道</strong>。测试消息与每日日报不受路由影响（恒广播全部通道）。
            顺序 = 优先级，需要调整优先级时删除重加。
          </span>
        }
      >
        <div className="card-scroll">
          {routing.length === 0 ? (
            <div className="src-empty">暂无规则（全部命中走全部就绪通道）</div>
          ) : (
            routing.map((rule) => (
              <div key={rule.id} className="hit">
                <span className="ai-reason" title={rule.id}>
                  {whenSummary(rule, sources, priceRules)}
                </span>
                <span className="src-name">→ {rule.channelIds.join(', ')}</span>
                <span className="src-last">
                  <button
                    type="button"
                    className="btn btn-danger"
                    aria-label={`删除规则 ${rule.id}`}
                    title={`删除规则「${whenSummary(rule, sources, priceRules)}」（保存后生效）`}
                    onClick={() => onChange(routing.filter((r) => r.id !== rule.id))}
                  >
                    <IconX size={14} />
                    删除
                  </button>
                </span>
              </div>
            ))
          )}
        </div>
      </Field>
      <Field label="来源" hint="限定命中的帖子来源；「任意」= 不限来源。">
        <div className="input-row">
          <select
            className="input"
            style={{ width: 'auto' }}
            value={sourceId}
            aria-label="规则来源"
            onChange={(e) => setSourceId(e.target.value)}
          >
            <option value="">任意来源</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
              </option>
            ))}
          </select>
        </div>
      </Field>
      <Field label="命中方式" hint="多选；一个都不勾 = 不限方式。">
        <div className="input-row">
          {(['literal', 'semantic', 'rule'] as MatchedBy[]).map((m) => (
            <label key={m} className="radio" style={{ gap: 4 }}>
              <input
                type="checkbox"
                checked={matchedBy.includes(m)}
                onChange={() => toggleMatchedBy(m)}
              />
              {MATCHED_BY_LABEL[m]}
            </label>
          ))}
        </div>
      </Field>
      <Field
        label="价格规则"
        hint="限定命中的具体价格规则（来自「价格规则」卡）；选中即自动按「规则」方式生效。"
      >
        <div className="input-row">
          <select
            className="input"
            style={{ width: 'auto' }}
            value={ruleId}
            aria-label="价格规则"
            disabled={priceRules.length === 0}
            onChange={(e) => setRuleId(e.target.value)}
          >
            <option value="">任意规则</option>
            {priceRules.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label ?? r.id}
              </option>
            ))}
          </select>
          {priceRules.length === 0 && <span className="feedback muted">尚未配置价格规则</span>}
        </div>
      </Field>
      <Field label="目标通道" hint="该规则命中时推送到的通道（可多选；引用的通道被删后保存时规则会被清掉）。">
        <div className="input-row" style={{ flexWrap: 'wrap' }}>
          {channels.map((ch) => (
            <label key={ch.id} className="radio" style={{ gap: 4 }} title={isChannelReadyUi(ch) ? undefined : '该通道当前未就绪（路由命中也不会发送）'}>
              <input
                type="checkbox"
                checked={targets.includes(ch.id)}
                onChange={() => toggleTarget(ch.id)}
              />
              {ch.id}
            </label>
          ))}
        </div>
      </Field>
      <Field label="添加" hint={canAdd ? undefined : '需至少一个条件（来源 / 方式 / 规则）且至少勾选一个目标通道。'}>
        <div className="input-row">
          <button
            type="button"
            className="btn"
            disabled={!canAdd}
            title={canAdd ? '加入规则列表（仍需保存才生效）' : '条件不完整'}
            onClick={addRule}
          >
            添加规则
          </button>
          {!hasCondition && <span className="feedback muted">未声明任何条件</span>}
          {hasCondition && targets.length === 0 && <span className="feedback muted">未选择目标通道</span>}
        </div>
      </Field>
    </section>
  )
}
