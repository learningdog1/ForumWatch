/**
 * 「监控模式」卡（阶段 5a 自 Settings.tsx inline 段拆出，settings.md §7）：
 * 匹配模式单选 / 兴趣描述标签 / 语义置信度阈值，内容与 hint 照搬
 * （§3.6 保留清单）。拆出时仅改卡头 aux：当前模式名（§2）。
 * 降级提示（语义档 + AI 未配置）依赖的 aiConfigured 由 Settings.tsx 下发
 * （测试连接的同一判定）。
 */
import { Field } from './Field'
import { KeywordTagInput } from './KeywordTagInput'
import type { MatchMode } from '@shared/types'

const MATCH_MODES: { value: MatchMode; title: string; desc: string }[] = [
  { value: 'literal', title: '字面匹配', desc: '按关键词包含判断；快、零成本、表达精确' },
  { value: 'semantic', title: '语义匹配', desc: 'AI 按兴趣描述判断相关性；能捕捉同义表达，需要配置 AI 模型' },
  { value: 'both', title: '字面 + 语义（任一命中）', desc: '两档叠加，先字面后 AI，任一命中即推送' }
]

const MODE_AUX: Record<MatchMode, string> = {
  literal: '字面匹配',
  semantic: '语义匹配',
  both: '字面 + 语义'
}

const INTERESTS_MAX = 20

export function MatchModeCard(props: {
  matchMode: MatchMode
  interests: string[]
  semanticThreshold: number
  /** AI 三项（Base URL / Key / 模型名）是否齐备——降级提示与 aux 的依据 */
  aiConfigured: boolean
  onModeChange: (v: MatchMode) => void
  onInterestsChange: (v: string[]) => void
  onThresholdChange: (v: number) => void
}) {
  const interestsOver = props.interests.length > INTERESTS_MAX
  const semanticMode = props.matchMode !== 'literal'

  return (
    <section className="card smon">
      <div className="card-head">
        <span className="card-title">监控模式</span>
        <span className="card-title-aux">{MODE_AUX[props.matchMode]}</span>
      </div>
      <Field
        label="匹配模式"
        htmlFor="match-mode-literal"
        hint="语义匹配与叠加模式需要先配置 AI 模型；未配置时自动降级为字面匹配。"
      >
        <div className="radios radios-card">
          {MATCH_MODES.map((m) => (
            <label className="radio" key={m.value}>
              <input
                id={`match-mode-${m.value}`}
                type="radio"
                name="match-mode"
                checked={props.matchMode === m.value}
                onChange={() => props.onModeChange(m.value)}
              />
              <span className="radio-text">
                <span className="radio-title">{m.title}</span>
                <span className="radio-desc">{m.desc}</span>
              </span>
            </label>
          ))}
        </div>
      </Field>
      <Field
        label="兴趣描述"
        hint={
          interestsOver ? (
            <span className="warn">
              已 {props.interests.length} 条，超过建议上限 {INTERESTS_MAX} 条——兴趣越多，AI 判定越容易发散
            </span>
          ) : (
            <span>
              语义匹配的兴趣清单，每条一句自然语言（如「Oracle 免费 ARM 的羊毛」）。输入后回车添加。
              {props.interests.length > 0 && ` 当前 ${props.interests.length}/${INTERESTS_MAX} 条。`}
            </span>
          )
        }
      >
        {semanticMode && !props.aiConfigured && (
          <div className="notice muted-notice">
            尚未配置 AI 模型：语义匹配将自动降级为字面匹配，直到补齐并保存 AI 配置。
          </div>
        )}
        <KeywordTagInput
          label="兴趣描述"
          placeholder="如：Oracle 免费 ARM 的羊毛"
          longText
          value={props.interests}
          onChange={props.onInterestsChange}
        />
      </Field>
      <Field
        label="语义置信度阈值"
        htmlFor="semantic-threshold"
        hint={
          <span>
            AI 判定相关（hit）后还需置信度 score ≥ 此值才推送。默认 0 = 不过滤；
            调高可减少误报，但可能漏报（低置信的真命中会被拦下）。仅影响语义/
            叠加模式的 AI 档，字面与价格规则命中不受影响。
          </span>
        }
      >
        <div className="input-row">
          <input
            id="semantic-threshold"
            className="input-range"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={props.semanticThreshold}
            onChange={(e) => props.onThresholdChange(Number(e.target.value))}
            aria-label="语义置信度阈值"
          />
          <span className="feedback muted num">
            {props.semanticThreshold.toFixed(2)}
            {props.semanticThreshold === 0 ? '（不过滤）' : ''}
          </span>
        </div>
      </Field>
    </section>
  )
}
