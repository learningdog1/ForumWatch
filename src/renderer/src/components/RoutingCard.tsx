/**
 * 「路由规则」卡片（R6-W4；阶段 5b 改造最大，settings.md §5.3）：
 * routing 段的 UI——按条件把命中分流到指定通道。
 *
 * - 规则列表（EntityList 外壳，L2 实体行）：
 *   - **上移 / 下移**：顺序 = 优先级的直接操作化（首条命中生效），替代现状
 *     「删除重加」workaround（audit #8）；首/末条对应方向禁用；
 *   - **行内编辑**：「编辑」展开复用添加表单的四组字段（来源 / 命中方式 /
 *     价格规则 / 目标通道），改动直写 draft——与价格规则/来源/通道三种列表的
 *     编辑模式对齐（改目标通道不必整条重建）；一次只展开一行；
 *   - L1 删除不弹确认（§3.5）：已保存过的行转「待删除」态（删除线 + 琥珀徽标 +
 *     撤销删除）；未保存过的新行直接从 draft 移除。
 * - 添加表单：来源下拉（「任意」= 不限 + 各已配置来源，显示名走 sourceLabel）、
 *   命中方式多选（字面 / 语义 / 规则）、价格规则下拉（「任意」；选中即自动勾选
 *   「规则」方式——ruleId 条件只对规则命中生效）、目标通道多选；
 * - 校验（对齐主进程 sanitizeRouting）：至少声明一个条件 + 至少一个目标通道，
 *   否则「添加」禁用并给原因；id 由 rule-N 派生去重；上限 20 条（sanitize 截断）。
 *   行内编辑脚部不再有「保存」假按钮（§C-11：与「收起」执行同一动作——改动
 *   直写草稿、页底统一保存，与其余三类实体卡的单「收起」对齐）。
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
import { EntityList, useEscCollapse, type PendingDeleteSlot } from './EntityList'
import { Field } from './Field'
import { IconArrowDown, IconArrowUp, IconX } from './icons'
import { isChannelReadyUi } from './ChannelsCard'
import { sourceLabel } from '../lib/status'
import { httpUrlHost } from '../lib/presets'

type MatchedBy = NonNullable<RoutingWhen['matchedBy']>[number]

const MATCHED_BY_LABEL: Record<MatchedBy, string> = {
  literal: '字面',
  semantic: '语义',
  rule: '规则'
}

/**
 * 来源选项文案：sourceLabel 单源显示名优先（NodeSeek 而非 nodeseek，ia §3
 * 跨页一致项）；自建 RSS 无内置映射时用 label / 域名。
 */
function sourceOptionText(s: SourceConfig): string {
  const mapped = sourceLabel(s.id)
  if (mapped !== s.id) return mapped
  if (s.type === 'rss') return s.label ?? (httpUrlHost(s.url) ?? s.id)
  return s.id
}

/** when 摘要（规则列表行展示；sanitize 保证至少一个条件） */
function whenSummary(rule: RoutingRule, sources: SourceConfig[], priceRules: PriceRuleConfig[]): string {
  const parts: string[] = []
  if (rule.when.sourceId !== undefined) {
    const s = sources.find((x) => x.id === rule.when.sourceId)
    parts.push(`来源 ${s !== undefined ? sourceOptionText(s) : rule.when.sourceId}`)
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

export function RoutingCard(
  props: {
    routing: RoutingRule[]
    onChange: (routing: RoutingRule[]) => void
    sources: SourceConfig[]
    priceRules: PriceRuleConfig[]
    channels: ChannelConfig[]
  } & PendingDeleteSlot
) {
  const { routing, onChange, sources, priceRules, channels, pendingDelete, onMarkDelete, onUndoDelete } = props
  const [sourceId, setSourceId] = useState('')
  const [matchedBy, setMatchedBy] = useState<MatchedBy[]>([])
  const [ruleId, setRuleId] = useState('')
  const [targets, setTargets] = useState<string[]>([])
  /** 当前展开行内编辑的规则 id（一次一行） */
  const [expandedId, setExpandedId] = useState<string | null>(null)
  useEscCollapse(expandedId != null, () => setExpandedId(null))

  const hasCondition = sourceId !== '' || matchedBy.length > 0 || ruleId !== ''
  const canAdd = hasCondition && targets.length > 0
  /** 目标通道多选的 Field htmlFor 锚（指向首个复选框；空列表时不指） */
  const firstChannel = channels.length > 0 ? channels[0] : null

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

  /** 上移 / 下移：顺序即优先级（列表顺序 = 命中顺序，audit #8） */
  function moveRule(index: number, dir: -1 | 1): void {
    const to = index + dir
    if (to < 0 || to >= routing.length) return
    const next = [...routing]
    const [row] = next.splice(index, 1)
    next.splice(to, 0, row)
    onChange(next)
  }

  /** 行内编辑：改动直写 draft（与价格规则/来源/通道的编辑模式对齐） */
  function updateRule(id: string, fn: (r: RoutingRule) => RoutingRule): void {
    onChange(routing.map((r) => (r.id === id ? fn(r) : r)))
  }

  function setRuleSource(id: string, v: string): void {
    updateRule(id, (r) => {
      const when: RoutingWhen = { ...r.when }
      if (v === '') delete when.sourceId
      else when.sourceId = v
      return { ...r, when }
    })
  }

  function toggleRuleMatchedBy(id: string, m: MatchedBy): void {
    updateRule(id, (r) => {
      const cur = r.when.matchedBy ?? []
      const next = cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]
      const when: RoutingWhen = { ...r.when }
      if (next.length === 0) delete when.matchedBy
      else when.matchedBy = next
      return { ...r, when }
    })
  }

  function setRulePriceRule(id: string, v: string): void {
    updateRule(id, (r) => {
      const when: RoutingWhen = { ...r.when }
      if (v === '') {
        delete when.ruleId
      } else {
        when.ruleId = v
        // 选中具体规则即自动限定命中方式为「规则」（与添加表单同款联动）
        if (when.matchedBy === undefined) when.matchedBy = ['rule']
        else if (!when.matchedBy.includes('rule')) when.matchedBy = [...when.matchedBy, 'rule']
      }
      return { ...r, when }
    })
  }

  function toggleRuleTarget(id: string, channelId: string): void {
    updateRule(id, (r) => ({
      ...r,
      channelIds: r.channelIds.includes(channelId)
        ? r.channelIds.filter((x) => x !== channelId)
        : [...r.channelIds, channelId]
    }))
  }

  return (
    <section className="card snot">
      <div className="card-head">
        <span className="card-title">路由规则</span>
        <span className="card-title-aux num">{routing.filter((r) => !pendingDelete.has(r.id)).length}/20 条 · 顺序即优先级</span>
      </div>
      <Field
        label="已配置规则"
        hint={
          <span>
            按列表顺序<strong>首条命中</strong>生效（条件之间 AND）；无规则命中走
            <strong>全部就绪通道</strong>。测试消息与日报不受路由影响。
          </span>
        }
      >
        {routing.length === 0 ? (
          <div className="src-empty">暂无规则——所有命中推送到全部就绪通道。</div>
        ) : (
          <EntityList
            items={routing}
            rowKey={(r) => r.id}
            rowClass={(r) => (pendingDelete.has(r.id) ? ' del' : '')}
            render={(rule, i) => {
              const del = pendingDelete.has(rule.id)
              const open = expandedId === rule.id && !del
              const whenText = whenSummary(rule, sources, priceRules)
              const targetsText = rule.channelIds.join(', ')
              return (
                <>
                  <div className="ent-main">
                    <span className="rule-idx" title={`优先级 ${i + 1}（列表顺序即命中顺序）`}>
                      {i + 1}
                    </span>
                    <span className="ent-name" title={`${whenText} → ${targetsText}`}>
                      {whenText}
                    </span>
                    <span className="ent-sum" title={targetsText}>
                      → {targetsText}
                    </span>
                    {del && <span className="badge-del">待删除</span>}
                    <span className="ent-ops">
                      {!del ? (
                        <>
                          <button
                            type="button"
                            className="ent-btn"
                            aria-label="上移"
                            title="上移（调整优先级——列表顺序即命中顺序）"
                            disabled={i === 0}
                            onClick={() => moveRule(i, -1)}
                          >
                            <IconArrowUp size={14} />
                          </button>
                          <button
                            type="button"
                            className="ent-btn"
                            aria-label="下移"
                            title="下移（调整优先级——列表顺序即命中顺序）"
                            disabled={i === routing.length - 1}
                            onClick={() => moveRule(i, 1)}
                          >
                            <IconArrowDown size={14} />
                          </button>
                          <button
                            type="button"
                            className={`ent-btn${open ? ' active' : ''}`}
                            aria-expanded={open}
                            title={open ? '收起编辑表单' : '展开编辑表单'}
                            onClick={() => setExpandedId(open ? null : rule.id)}
                          >
                            {open ? '收起' : '编辑'}
                          </button>
                          <button
                            type="button"
                            className="ent-btn danger"
                            aria-label={`删除规则 ${rule.id}`}
                            title={`标记删除「${whenText}」（保存后生效；放弃修改可还原）`}
                            onClick={() => onMarkDelete(rule.id)}
                          >
                            <IconX size={14} />
                            删除
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="ent-btn"
                          title={`撤销删除「${whenText}」`}
                          onClick={() => onUndoDelete(rule.id)}
                        >
                          撤销删除
                        </button>
                      )}
                    </span>
                  </div>
                  {open && (
                    <div className="ent-expand">
                      <Field
                        label="来源"
                        htmlFor={`rule-${rule.id}-source`}
                        hint="限定命中的帖子来源；「任意」= 不限来源。"
                      >
                        <div className="input-row">
                          <select
                            id={`rule-${rule.id}-source`}
                            className="input input-auto"
                            value={rule.when.sourceId ?? ''}
                            aria-label="规则来源"
                            onChange={(e) => setRuleSource(rule.id, e.target.value)}
                          >
                            <option value="">任意来源</option>
                            {sources.map((s) => (
                              <option key={s.id} value={s.id}>
                                {sourceOptionText(s)}
                              </option>
                            ))}
                          </select>
                        </div>
                      </Field>
                      <Field
                        label="命中方式"
                        htmlFor={`rule-${rule.id}-matched-literal`}
                        hint="多选；一个都不勾 = 不限方式。"
                      >
                        <div className="input-row">
                          {(['literal', 'semantic', 'rule'] as MatchedBy[]).map((m) => (
                            <label key={m} className="radio radio-tight">
                              <input
                                id={`rule-${rule.id}-matched-${m}`}
                                type="checkbox"
                                checked={rule.when.matchedBy?.includes(m) ?? false}
                                onChange={() => toggleRuleMatchedBy(rule.id, m)}
                              />
                              {MATCHED_BY_LABEL[m]}
                            </label>
                          ))}
                        </div>
                      </Field>
                      <Field
                        label="价格规则"
                        htmlFor={`rule-${rule.id}-price`}
                        hint="限定命中的具体价格规则（来自「价格规则」卡）；选中即自动按「规则」方式生效。"
                      >
                        <div className="input-row">
                          <select
                            id={`rule-${rule.id}-price`}
                            className="input input-auto"
                            value={rule.when.ruleId ?? ''}
                            aria-label="价格规则"
                            disabled={priceRules.length === 0}
                            onChange={(e) => setRulePriceRule(rule.id, e.target.value)}
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
                      <Field
                        label="目标通道"
                        htmlFor={firstChannel !== null ? `rule-${rule.id}-target-${firstChannel.id}` : undefined}
                        hint="该规则命中时推送到的通道（可多选；引用的通道被删后保存时规则会被清掉）。"
                      >
                        <div className="input-row">
                          {channels.map((ch) => (
                            <label
                              key={ch.id}
                              className="radio radio-tight"
                              title={isChannelReadyUi(ch) ? undefined : '该通道当前未就绪（路由命中也不会发送）'}
                            >
                              <input
                                id={`rule-${rule.id}-target-${ch.id}`}
                                type="checkbox"
                                checked={rule.channelIds.includes(ch.id)}
                                onChange={() => toggleRuleTarget(rule.id, ch.id)}
                              />
                              {ch.id}
                            </label>
                          ))}
                        </div>
                      </Field>
                      <div className="ent-expand-foot">
                        <button
                          type="button"
                          className="btn"
                          title="改动已写入草稿，收起编辑（仍需页底「保存设置」落盘）"
                          onClick={() => setExpandedId(null)}
                        >
                          收起
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )
            }}
          />
        )}
      </Field>
      <Field
        label="来源"
        htmlFor="rule-new-source"
        hint="限定命中的帖子来源；「任意」= 不限来源。"
      >
        <div className="input-row">
          <select
            id="rule-new-source"
            className="input input-auto"
            value={sourceId}
            aria-label="规则来源"
            onChange={(e) => setSourceId(e.target.value)}
          >
            <option value="">任意来源</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {sourceOptionText(s)}
              </option>
            ))}
          </select>
        </div>
      </Field>
      <Field label="命中方式" htmlFor="rule-new-matched-literal" hint="多选；一个都不勾 = 不限方式。">
        <div className="input-row">
          {(['literal', 'semantic', 'rule'] as MatchedBy[]).map((m) => (
            <label key={m} className="radio radio-tight">
              <input
                id={`rule-new-matched-${m}`}
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
        htmlFor="rule-new-price"
        hint="限定命中的具体价格规则（来自「价格规则」卡）；选中即自动按「规则」方式生效。"
      >
        <div className="input-row">
          <select
            id="rule-new-price"
            className="input input-auto"
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
      <Field
        label="目标通道"
        htmlFor={firstChannel !== null ? `rule-new-target-${firstChannel.id}` : undefined}
        hint="该规则命中时推送到的通道（可多选；引用的通道被删后保存时规则会被清掉）。"
      >
        <div className="input-row">
          {channels.map((ch) => (
            <label
              key={ch.id}
              className="radio radio-tight"
              title={isChannelReadyUi(ch) ? undefined : '该通道当前未就绪（路由命中也不会发送）'}
            >
              <input
                id={`rule-new-target-${ch.id}`}
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
