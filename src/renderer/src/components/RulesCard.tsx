/**
 * 「价格规则」卡片（R5-P2c）：结构化价格规则的增删改与启停。
 *
 * - 规则语义（空态与 hint 一句话讲清）：从帖子标题提取周期 / 价格 / 流量
 *   （如「年付 ¥99」「500G 流量」），一条规则声明的条件之间 AND，全部满足即
 *   命中——独立于关键词与 AI 的第三种命中方式（matchedBy='规则'）。
 * - 编辑模型：表单完全受控于 props（draft 的一段），每次改动即回写 draft，
 *   与本页其余卡片一致走「保存设置」链路；数值输入留空 = 不限（字段不落键，
 *   对齐主进程 sanitize）。
 * - id 由前端生成（rule / rule-2 / …，全列表去重），sanitize 会再 slug 化兜底。
 */
import { useState } from 'react'
import type { PriceCurrency, PriceCycle, PriceRuleConfig } from '@shared/types'
import { Field } from './Field'
import { KeywordTagInput } from './KeywordTagInput'
import { IconX } from './icons'

const CYCLE_OPTIONS: { value: PriceCycle; label: string }[] = [
  { value: 'any', label: '不限周期' },
  { value: 'yearly', label: '年付' },
  { value: 'monthly', label: '月付' }
]

const CURRENCY_OPTIONS: { value: PriceCurrency; label: string }[] = [
  { value: 'any', label: '不限币种' },
  { value: 'CNY', label: '人民币 ¥' },
  { value: 'USD', label: '美元 $' }
]

const CURRENCY_SYMBOL: Record<Exclude<PriceCurrency, 'any'>, string> = { CNY: '¥', USD: '$' }

function cycleText(cycle: PriceCycle): string {
  return CYCLE_OPTIONS.find((o) => o.value === cycle)?.label ?? '不限周期'
}

/** 列表行的条件摘要：`年付 · ≤ ¥100 · ≥ 500G · 关键词×2` */
function ruleSummary(r: PriceRuleConfig): string {
  const parts: string[] = [cycleText(r.cycle)]
  if (r.maxPrice !== undefined) {
    const sym = r.currency !== undefined && r.currency !== 'any' ? CURRENCY_SYMBOL[r.currency] : ''
    parts.push(`≤ ${sym}${r.maxPrice}`)
  }
  if (r.minTrafficGB !== undefined) parts.push(`≥ ${r.minTrafficGB}G`)
  if (r.keywords !== undefined && r.keywords.length > 0) {
    parts.push(`关键词×${r.keywords.length}`)
  }
  return parts.join(' · ')
}

/** 新规则 id：rule / rule-2 / rule-3…（全列表去重；sanitize 侧会再 slug 化） */
function uniqueRuleId(rules: PriceRuleConfig[]): string {
  let n = 1
  while (rules.some((r) => r.id === (n === 1 ? 'rule' : `rule-${n}`))) n++
  return n === 1 ? 'rule' : `rule-${n}`
}

/**
 * 数值输入的受控桥：文本 <-> number|undefined。
 * 留空（或非法数字）= 不限（字段置 undefined，不落配置键——与 sanitize 口径一致）。
 */
function numberBridge(value: number | undefined): string {
  return value === undefined ? '' : String(value)
}
function parseNumber(text: string): number | undefined {
  const t = text.trim()
  if (t === '') return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

export function RulesCard(props: {
  rules: PriceRuleConfig[]
  onChange: (rules: PriceRuleConfig[]) => void
}) {
  const { rules, onChange } = props
  const [expandedId, setExpandedId] = useState<string | null>(null)

  function updateRule(id: string, patch: Partial<PriceRuleConfig>): void {
    onChange(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  function addRule(): void {
    const id = uniqueRuleId(rules)
    onChange([...rules, { id, enabled: true, cycle: 'any', currency: 'any' }])
    setExpandedId(id)
  }

  function removeRule(id: string): void {
    onChange(rules.filter((r) => r.id !== id))
    if (expandedId === id) setExpandedId(null)
  }

  return (
    <section className="card">
      <div className="card-head">
        <span className="card-title">价格规则</span>
        <span className="card-title-aux">确定性命中 · 优先于关键词</span>
      </div>
      <Field
        label="规则列表"
        hint={
          <span>
            规则从帖子标题提取周期 / 价格 / 流量做确定性条件，一条规则内的条件 AND 组合、
            全部满足即命中（命中方式记为「规则」，不再走关键词与 AI）。识别不了的写法
            （裸数字价格、双月付/季付等）不会命中——宁缺勿错。最多 20 条。
          </span>
        }
      >
        <div className="card-scroll">
          {rules.length === 0 ? (
            <div className="src-empty">
              暂无价格规则。例如：周期=年付 + 价格上限 ¥100 + 流量下限 500G——
              标题里同时提到「年付」「¥99」「500G」的帖子即命中。
            </div>
          ) : (
            rules.map((r) => {
              const summary = ruleSummary(r)
              const expanded = expandedId === r.id
              return (
                <div key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <div className="hit" style={{ opacity: r.enabled ? undefined : 0.55 }}>
                    <span className="src-name" title={r.label ?? r.id}>
                      {r.label ?? r.id}
                    </span>
                    <span className="ai-reason" title={summary}>
                      {summary}
                    </span>
                    <span className="src-last switch-row">
                      <button
                        type="button"
                        className={`btn${expanded ? ' active' : ''}`}
                        title={expanded ? '收起编辑表单' : '展开编辑表单'}
                        aria-expanded={expanded}
                        onClick={() => setExpandedId(expanded ? null : r.id)}
                      >
                        {expanded ? '收起' : '编辑'}
                      </button>
                      <button
                        type="button"
                        role="switch"
                        className="switch"
                        aria-checked={r.enabled}
                        aria-label={`${r.enabled ? '停用' : '启用'}规则 ${r.label ?? r.id}`}
                        title={r.enabled ? '点击停用该规则' : '点击启用该规则'}
                        onClick={() => updateRule(r.id, { enabled: !r.enabled })}
                      />
                      <button
                        type="button"
                        className="btn btn-danger"
                        title={`删除规则「${r.label ?? r.id}」（保存后生效）`}
                        aria-label={`删除规则 ${r.label ?? r.id}`}
                        onClick={() => removeRule(r.id)}
                      >
                        <IconX size={14} />
                        删除
                      </button>
                    </span>
                  </div>
                  {expanded && (
                    <div style={{ padding: 'var(--space-2) var(--space-3) var(--space-3)' }}>
                      <Field
                        label="规则名称"
                        hint="展示用（命中记录与推送里显示）；留空时用规则 id。"
                      >
                        <input
                          className="input"
                          type="text"
                          spellCheck={false}
                          autoComplete="off"
                          placeholder="如：百元内年付"
                          value={r.label ?? ''}
                          onChange={(e) => updateRule(r.id, { label: e.target.value })}
                        />
                      </Field>
                      <Field label="周期" hint="标题须提到对应周期（年付/月付等写法）；不限则只看其余条件。">
                        <div className="input-row">
                          <select
                            className="input"
                            value={r.cycle}
                            onChange={(e) =>
                              updateRule(r.id, { cycle: e.target.value as PriceCycle })
                            }
                            aria-label="周期"
                          >
                            {CYCLE_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </Field>
                      <Field
                        label="价格上限"
                        hint="标题提取出的价格须 ≤ 此值；留空 = 不限。识别 ¥/$/元/刀 等写法；裸数字（如「年付88」的 88）提取不到。"
                      >
                        <div className="input-row">
                          <input
                            className="input num"
                            type="number"
                            min={0}
                            placeholder="不限"
                            value={numberBridge(r.maxPrice)}
                            onChange={(e) => updateRule(r.id, { maxPrice: parseNumber(e.target.value) })}
                            aria-label="价格上限"
                          />
                          <select
                            className="input"
                            value={r.currency ?? 'any'}
                            onChange={(e) =>
                              updateRule(r.id, { currency: e.target.value as PriceCurrency })
                            }
                            aria-label="币种"
                          >
                            {CURRENCY_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </Field>
                      <Field
                        label="流量下限（GB）"
                        hint="标题提取出的流量（T / M 自动换算 GB）须 ≥ 此值；留空 = 不限。「不限流量」视为无约束。"
                      >
                        <div className="input-row">
                          <input
                            className="input num"
                            type="number"
                            min={0}
                            placeholder="不限"
                            value={numberBridge(r.minTrafficGB)}
                            onChange={(e) =>
                              updateRule(r.id, { minTrafficGB: parseNumber(e.target.value) })
                            }
                            aria-label="流量下限 GB"
                          />
                          <span className="feedback muted">GB</span>
                        </div>
                      </Field>
                      <Field
                        label="关键词（前置）"
                        hint="非空时标题须包含任一关键词，规则才参与判定（AND 前置条件）；空 = 不限。用于缩小范围（如多价格对比帖）。"
                      >
                        <KeywordTagInput
                          label="规则关键词"
                          placeholder="如：VPS / 白嫖"
                          value={r.keywords ?? []}
                          onChange={(v) => updateRule(r.id, { keywords: v })}
                        />
                      </Field>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
        <div className="input-row" style={{ marginTop: 'var(--space-2)' }}>
          <button
            type="button"
            className="btn"
            disabled={rules.length >= 20}
            title={rules.length >= 20 ? '已达上限 20 条' : '添加一条价格规则并展开编辑'}
            onClick={addRule}
          >
            添加规则
          </button>
          <span className="feedback muted">{rules.length}/20 条</span>
        </div>
      </Field>
    </section>
  )
}
