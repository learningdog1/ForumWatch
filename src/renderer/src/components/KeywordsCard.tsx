/**
 * 「关键词」卡（阶段 5a 自 Settings.tsx inline 段拆出，settings.md §7）：
 * 包含/排除两组标签输入（KeywordTagInput 的 IME 资产保留）。
 * 拆出时新增：包含词为空的常显警示条（§3.4 零配置语义——「空了会怎样」与
 * 「空列表」分开讲，warn 色只在列表为空时出现）。
 * 机制（draft 字段 + patch 回调）由 Settings.tsx 下发，逻辑与原 inline 段一致。
 */
import { Field } from './Field'
import { KeywordTagInput } from './KeywordTagInput'

export function KeywordsCard(props: {
  includeKeywords: string[]
  excludeKeywords: string[]
  onIncludeChange: (v: string[]) => void
  onExcludeChange: (v: string[]) => void
}) {
  const includeEmpty = props.includeKeywords.length === 0
  return (
    <section className="card smon">
      <div className="card-head">
        <span className="card-title">关键词</span>
      </div>
      {includeEmpty && (
        <div className="warn-strip">
          包含词为空：字面档不会推送任何帖子（这是防通知风暴的默认设计）。添加关键词，或到「智能匹配」启用语义
          / 价格规则。
        </div>
      )}
      <Field
        label="包含关键词"
        hint={<span>任一命中即推送；为空则不推送。输入后回车添加，点标签上的 × 删除。</span>}
      >
        <KeywordTagInput
          label="包含关键词"
          placeholder="如：VPS / 白嫖 / nginx"
          value={props.includeKeywords}
          onChange={props.onIncludeChange}
        />
      </Field>
      <Field label="排除关键词" hint="任一命中则不推送（优先于包含词，也优先于 AI 判定）。">
        <KeywordTagInput
          label="排除关键词"
          placeholder="如：福利 / 广告"
          value={props.excludeKeywords}
          onChange={props.onExcludeChange}
        />
      </Field>
    </section>
  )
}
