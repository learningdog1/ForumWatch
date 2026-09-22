/**
 * 「分类总结报告」卡（R17，设置页 ② 智能匹配组）：按分类（默认情报/交易/测评）
 * 对**全量话题存档**做日/周/月三档 AI 总结的配置面。
 *
 * - 总开关（enabled，默认关）+ 统计来源多选（sourceIds）+ 分类 chips（categories，
 *   复用 KeywordTagInput）+ 三档独立开关与时刻（daily/weekly/monthly，形态仿
 *   RunPaceCard「生成与推送」行的 switch + time input）+ 附录开关（appendix）。
 * - 值域清洗全部交给主进程 sanitize（store.ts sanitizeCategoryReport）——空分类/
 *   非法时刻在保存后自动回默认并回填（Settings 的「部分值已按规则修正」
 *   提示语义）；悬挂来源被剔除、清空来源保持空（= 不过滤，统计全部来源，
 *   不回默认）；卡内只做轻提示（如分类上限 10），不做前端硬拦。
 * - 生成时机说明：周报固定周一生成上一完整周、月报固定 1 日生成上一自然月，
 *   不设 weekday 配置（契约见 types.ts CategoryReportConfig）。
 * - 与「运行节奏」卡的每日总结（ai.dailyReport）相互独立：数据底座（topics/
 *   存档 vs hits/ 命中）、开关、文件全部分开。
 */
import type { CategoryReportConfig, SourceConfig } from '@shared/types'
import type { CategoryReportKind } from '@shared/ipc'
import { Field } from './Field'
import { KeywordTagInput } from './KeywordTagInput'
import { sourceLabel } from '../lib/status'
import { httpUrlHost } from '../lib/presets'

/** 分类上限（与主进程 sanitizeCategoryReport 的 CATEGORY_REPORT_MAX_CATEGORIES 对齐） */
const MAX_CATEGORIES = 10

/** 三档的表单元数据：开关 aria 名 + 时刻 input id + 生成时机说明 */
const KIND_FIELDS: ReadonlyArray<{
  kind: CategoryReportKind
  label: string
  timeId: string
  hint: string
}> = [
  {
    kind: 'daily',
    label: '每日',
    timeId: 'category-report-daily-time',
    hint: '当天到点总结当天（数据面 topics/ 全量存档，与上方「每日总结」的命中日报独立）'
  },
  {
    kind: 'weekly',
    label: '每周一',
    timeId: 'category-report-weekly-time',
    hint: '周一到点总结刚结束的完整一周（周一~周日）；错过当周内会补做'
  },
  {
    kind: 'monthly',
    label: '每月 1 日',
    timeId: 'category-report-monthly-time',
    hint: '每月 1 日到点总结上一自然月；存档保留 35 天，跨保留窗补做时报告会如实标注存档不足'
  }
]

/** 来源选项文案（RoutingCard sourceOptionText 同款：内置映射优先，RSS 用 label/域名） */
function sourceOptionText(s: SourceConfig): string {
  const mapped = sourceLabel(s.id)
  if (mapped !== s.id) return mapped
  if (s.type === 'rss') return s.label ?? (httpUrlHost(s.url) ?? s.id)
  return s.id
}

export function CategoryReportCard(props: {
  cr: CategoryReportConfig
  /** 全部已配置来源（多选项数据面；待删除行由外层 effDraft 剔除） */
  sources: SourceConfig[]
  onChange: (next: CategoryReportConfig) => void
}) {
  const cr = props.cr

  /** 就地改一档的 enabled/timeHHMM（浅替换该档对象，不动其余字段） */
  function patchKind(kind: CategoryReportKind, section: { enabled: boolean; timeHHMM: string }): void {
    props.onChange({ ...cr, [kind]: section })
  }

  /** 来源多选翻选：勾选加入、取消移除（清空 = 不过滤来源，全部来源参与统计） */
  function toggleSource(id: string): void {
    const next = cr.sourceIds.includes(id)
      ? cr.sourceIds.filter((x) => x !== id)
      : [...cr.sourceIds, id]
    props.onChange({ ...cr, sourceIds: next })
  }

  const categoriesFull = cr.categories.length >= MAX_CATEGORIES

  return (
    <section className="card smon">
      <div className="card-head">
        <span className="card-title">分类总结报告</span>
      </div>
      <Field
        label="功能开关"
        hint="按「分类 · 来源」对全量话题存档（topics/，命中与否都入档）做阶段性 AI 总结；AI 不可用时自动降级为统计模板。开启后到点自动生成并按推送配置发送正文（附录只在报告文件里）。与「运行节奏」里的每日命中总结相互独立。"
      >
        <div className="switch-row">
          <button
            type="button"
            role="switch"
            aria-checked={cr.enabled}
            className="switch"
            aria-label="分类总结报告"
            onClick={() => props.onChange({ ...cr, enabled: !cr.enabled })}
          />
          <span className="feedback muted">{cr.enabled ? '开启' : '关闭'}</span>
        </div>
      </Field>
      <Field
        label="统计来源"
        hint="勾选参与统计的论坛来源（报告只统计这些来源的帖子）。一个都不勾 = 不过滤来源（统计全部来源的帖子）。"
      >
        <div className="input-row">
          {props.sources.map((s) => (
            <label key={s.id} className="radio radio-tight">
              <input
                type="checkbox"
                checked={cr.sourceIds.includes(s.id)}
                onChange={() => toggleSource(s.id)}
              />
              {sourceOptionText(s)}
            </label>
          ))}
        </div>
      </Field>
      <Field
        label="统计分类"
        hint={
          categoriesFull ? (
            <span className="err">
              已达上限 {MAX_CATEGORIES} 个（保存时超出部分会被截断）；匹配帖子分类的显示名或 slug，不区分大小写。
            </span>
          ) : (
            <span>
              回车添加分类（匹配显示名或 slug，不区分大小写）；清空时保存会回默认
              情报 / 交易 / 测评。
            </span>
          )
        }
      >
        <KeywordTagInput
          value={cr.categories}
          onChange={(categories) => props.onChange({ ...cr, categories })}
          placeholder="如：情报"
          label="统计分类"
        />
      </Field>
      {KIND_FIELDS.map((f) => {
        const section = cr[f.kind]
        return (
          <Field
            key={f.kind}
            label={`生成·${f.label}`}
            htmlFor={f.timeId}
            hint={f.hint}
          >
            <div className="switch-row">
              <button
                type="button"
                role="switch"
                aria-checked={section.enabled}
                className="switch"
                aria-label={`${f.label}分类报告`}
                onClick={() => patchKind(f.kind, { ...section, enabled: !section.enabled })}
              />
              <input
                id={f.timeId}
                className={`input input-time num${section.enabled ? '' : ' input-disabled'}`}
                type="time"
                value={section.timeHHMM}
                disabled={!section.enabled}
                onChange={(e) => patchKind(f.kind, { ...section, timeHHMM: e.target.value })}
                aria-label={`${f.label}生成时间`}
              />
              <span className="feedback muted">{section.enabled ? '开启' : '关闭'}</span>
            </div>
          </Field>
        )
      })}
      <Field
        label="报告附录"
        hint="报告文件是否附「附录·全量帖子清单」（每帖一行，可核对防漏）。推送消息恒不带附录，防月报刷屏。"
      >
        <div className="switch-row">
          <button
            type="button"
            role="switch"
            aria-checked={cr.appendix}
            className="switch"
            aria-label="报告附录"
            onClick={() => props.onChange({ ...cr, appendix: !cr.appendix })}
          />
          <span className="feedback muted">{cr.appendix ? '附全量清单' : '不附清单'}</span>
        </div>
      </Field>
    </section>
  )
}
