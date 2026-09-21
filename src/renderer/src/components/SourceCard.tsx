/**
 * 「来源」卡片（R4-W4，从 Settings 拆出；阶段 5b 改为 L2 实体行模式）：
 * - 来源列表（EntityList 外壳）：类型徽标（NodeSeek/V2EX/RSS）+ 名称（rss
 *   显示 label 或 host）+ url 摘要 + 「过滤」展开（R5-P2c：分类白/黑名单 +
 *   作者黑名单，写回该 source 的 filters 字段）+ 「匹配」展开（R13：该来源的
 *   关键词/匹配模式/兴趣/语义阈值覆盖，写回 matching 字段）+ 启停开关 + 删除。
 *   默认 nodeseek 来源不可删除（至少保留一个来源，列表删空 sanitize 会回默认
 *   ——UI 侧直接禁删更清晰；下限按剔除待删除行后的生效列表算）。过滤/匹配
 *   两个面板互斥单开（expanded = {id, kind}，防列表过长）。
 * - L1 删除不弹确认（settings.md §3.5）：已保存过的行转「待删除」态
 *   （删除线 + 琥珀徽标 + 撤销删除），保存栏汇总「含 M 项待删除」；
 *   未保存过的新行直接从 draft 移除（尚无「保存后删除」语义）。
 * - 添加：预设（V2EX / Linux.do / LowEndTalk / LowEndTalk Offers，见
 *   lib/presets.ts；已添加的按 id 匹配置灰——含待删除行，id 仍被占用）+
 *   自定义 RSS（url 前端校验 http(s) 红字反馈；id 从 host slug 化生成、
 *   冲突加 -2/-3 后缀）。
 * - 状态收在组件内；修改经 onChange 回写 Settings 的 draft config sources 字段，
 *   走既有「保存设置」链路（无新 IPC）。filters 三列表全空时不落键（undefined，
 *   对齐主进程 sanitize 的落键规则，避免保存后出现假 dirty）；matching 同理
 *   ——五字段全空不落键（patchMatching）。
 *
 * 判别联合读取收窄：type === 'rss' 才访问 url / label（@shared/types v3）。
 */
import { useState } from 'react'
import type {
  MatchMode,
  RssSourceConfig,
  SourceConfig,
  SourceFilters,
  SourceMatchingConfig
} from '@shared/types'
import { EntityList, useEscCollapse, type PendingDeleteSlot } from './EntityList'
import { Field } from './Field'
import { KeywordTagInput } from './KeywordTagInput'
import { IconBroadcast, IconX } from './icons'
import { SOURCE_PRESETS, httpUrlHost, presetAdded, slugFromHost, uniqueSourceId } from '../lib/presets'
import type { SourcePreset } from '../lib/presets'

/** 类型 → 徽标文案（判别联合的 type 判别值，收窄入口） */
function typeBadge(s: SourceConfig): string {
  if (s.type === 'nodeseek') return 'NodeSeek'
  if (s.type === 'v2ex') return 'V2EX'
  return 'RSS'
}

/** 固定类型的默认站点（展示用；adapter 内有同款常量，UI 侧只读展示） */
const FIXED_TYPE_URL: Record<'nodeseek' | 'v2ex', string> = {
  nodeseek: 'https://www.nodeseek.com',
  v2ex: 'https://www.v2ex.com/api/topics/latest.json'
}

/** rss → label 或 host；固定类型无独立名称（徽标即名称） */
function displayName(s: SourceConfig): string | null {
  if (s.type !== 'rss') return null
  return s.label ?? (httpUrlHost(s.url) ?? s.url)
}

/** rss → feed 地址；固定类型 → 默认站点/端点 */
function displayUrl(s: SourceConfig): string {
  return s.type === 'rss' ? s.url : FIXED_TYPE_URL[s.type]
}

/** 匹配模式覆盖的可选档位（「跟随全局」单独一档，见匹配面板；文案对齐 MatchModeCard） */
const MATCH_OVERRIDE_MODES: { value: MatchMode; title: string; desc: string }[] = [
  { value: 'literal', title: '字面匹配', desc: '只按该来源的包含词判断；快、零成本、表达精确' },
  { value: 'semantic', title: '语义匹配', desc: 'AI 按该来源的兴趣描述判断；字面档整体跳过' },
  { value: 'both', title: '字面 + 语义（任一命中）', desc: '两档叠加，先字面后 AI，任一命中即推送' }
]

export function SourceCard(
  props: {
    sources: SourceConfig[]
    onChange: (sources: SourceConfig[]) => void
    /**
     * 全局语义置信度阈值（R13-2 评审修复）：阈值覆盖勾选的初值与未覆盖态的
     * 读数回退用它——勾选不动滑杆不再把该来源的闸静默清零为 0。
     */
    globalSemanticThreshold: number
  } & PendingDeleteSlot
) {
  const {
    sources,
    onChange,
    pendingDelete,
    onMarkDelete,
    onUndoDelete,
    globalSemanticThreshold
  } = props
  // 自定义 RSS 表单状态收在组件内：只有点「添加来源」成功才落进 sources（draft）
  const [customUrl, setCustomUrl] = useState('')
  const [customLabel, setCustomLabel] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  // 当前展开的行内面板（一次只展开一个，收拢列表高度）：过滤 / 匹配互斥单开
  const [expanded, setExpanded] = useState<{ id: string; kind: 'filters' | 'matching' } | null>(null)
  useEscCollapse(expanded != null, () => setExpanded(null))

  const urlTrim = customUrl.trim()
  const urlBad = urlTrim !== '' && httpUrlHost(urlTrim) === null

  /** 生效列表（剔除待删除行）：删空下限与 aux 计数都按保存后的口径算 */
  const liveSources = sources.filter((s) => !pendingDelete.has(s.id))

  function toggle(id: string): void {
    onChange(sources.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)))
  }

  /** 默认 nodeseek 来源不可删；其余至少保留一个来源（删空 sanitize 会回默认） */
  function canRemove(s: SourceConfig): boolean {
    if (s.type === 'nodeseek' && s.id === 'nodeseek') return false
    return liveSources.length > 1
  }

  function removeTitle(s: SourceConfig): string {
    return canRemove(s)
      ? `标记删除「${displayName(s) ?? typeBadge(s)}」（保存后生效；放弃修改可还原）`
      : '至少保留一个来源：列表删空会被重置回默认'
  }

  /** 过滤条目计数（按钮角标用） */
  function filterCount(s: SourceConfig): number {
    const f = s.filters
    if (f === undefined) return 0
    return (f.includeCategories?.length ?? 0) + (f.excludeCategories?.length ?? 0) + (f.blockedAuthors?.length ?? 0)
  }

  /** 匹配覆盖已设置的字段数（按钮角标用：六字段里已覆盖几个，含 R13-2 全匹配） */
  function matchCount(s: SourceConfig): number {
    const m = s.matching
    if (m === undefined) return 0
    let n = 0
    if ((m.includeKeywords?.length ?? 0) > 0) n++
    if ((m.excludeKeywords?.length ?? 0) > 0) n++
    if (m.matchMode !== undefined) n++
    if ((m.interests?.length ?? 0) > 0) n++
    if (m.semanticThreshold !== undefined) n++
    if (m.matchAll === true) n++
    return n
  }

  /**
   * 写回某来源的 filters 字段：三列表全空时不落键（undefined）——对齐主进程
   * sanitize 的落键规则（清洗后全空 → 无 filters 对象），保存往返不产生假 dirty。
   */
  function patchFilters(id: string, patch: Partial<SourceFilters>): void {
    onChange(
      sources.map((s) => {
        if (s.id !== id) return s
        const merged: SourceFilters = { ...(s.filters ?? {}), ...patch }
        const empty =
          (merged.includeCategories ?? []).length === 0 &&
          (merged.excludeCategories ?? []).length === 0 &&
          (merged.blockedAuthors ?? []).length === 0
        const copy = { ...s }
        if (empty) delete copy.filters
        else copy.filters = merged
        return copy
      })
    )
  }

  /**
   * 写回某来源的 matching 字段（R13，对齐 patchFilters 的落键规则）：
   * - patch 值为 undefined 的键 = 清除该覆盖（radio 回「跟随全局」/阈值取消勾选/
   *   全匹配开关关）；布尔 false 同 undefined 处理（sanitize 也仅 true 落键）。
   * - 六字段全空（列表空 / matchMode·threshold 未设 / matchAll 非 true）→
   *   delete copy.matching 不落键——对齐主进程 sanitizeSourceMatching
   *   「全空不落键」，保存往返不产生假 dirty。整项替换不就地改嵌套
   *   （浅拷贝安全，见 Settings.tsx toDraft）。
   */
  function patchMatching(id: string, patch: Partial<SourceMatchingConfig>): void {
    onChange(
      sources.map((s) => {
        if (s.id !== id) return s
        const merged: Record<string, unknown> = { ...(s.matching ?? {}) }
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined || v === false || (Array.isArray(v) && v.length === 0)) delete merged[k]
          else merged[k] = v
        }
        const empty =
          ((merged['includeKeywords'] as string[] | undefined) ?? []).length === 0 &&
          ((merged['excludeKeywords'] as string[] | undefined) ?? []).length === 0 &&
          merged['matchMode'] === undefined &&
          ((merged['interests'] as string[] | undefined) ?? []).length === 0 &&
          merged['semanticThreshold'] === undefined &&
          merged['matchAll'] !== true
        const copy = { ...s }
        if (empty) delete copy.matching
        else copy.matching = merged as SourceMatchingConfig
        return copy
      })
    )
  }

  function addPreset(preset: SourcePreset): void {
    if (presetAdded(preset, sources)) return
    // 预设 config 是模块级常量：浅拷贝再入 draft，避免调用方原地改动污染预设
    onChange([...sources, { ...preset.config }])
  }

  function addCustom(): void {
    const url = urlTrim
    const host = httpUrlHost(url)
    if (host === null) {
      setAddError('地址需为合法 http(s) URL，如 https://example.com/feed')
      return
    }
    const label = customLabel.trim()
    // id 从 host slug 化（与主进程 sanitize 同口径），冲突加 -2/-3 后缀
    const id = uniqueSourceId(slugFromHost(host), sources)
    const item: RssSourceConfig = { id, type: 'rss', enabled: true, url }
    if (label !== '') item.label = label
    onChange([...sources, item])
    setCustomUrl('')
    setCustomLabel('')
    setAddError(null)
  }

  return (
    <section className="card smon">
      <div className="card-head">
        <span className="card-title">来源</span>
        <span className="card-title-aux">
          {liveSources.length} 个 · {liveSources.filter((s) => s.enabled).length} 启用
        </span>
      </div>
      <Field
        label="已配置来源"
        hint={
          <span>
            启停即时进入 draft、点「保存设置」生效；停用的来源不抓取也不进外链白名单。
            至少保留一个来源。每行「过滤」配置该来源的分类 / 作者过滤（被滤帖不推送不评估）；
            「匹配」单独覆盖该来源的关键词 / 匹配模式 / 兴趣 / 语义阈值（留空 = 跟随全局）。
          </span>
        }
      >
        {sources.length === 0 ? (
          <div className="smon-empty">
            暂无来源。保存时会重置回默认 NodeSeek——可从下方预设一键添加。
          </div>
        ) : (
          <EntityList
            items={sources}
            rowKey={(s) => s.id}
            rowClass={(s) => (pendingDelete.has(s.id) ? ' del' : '')}
            render={(s) => {
              const name = displayName(s)
              const url = displayUrl(s)
              const del = pendingDelete.has(s.id)
              const filters = s.filters
              const filtersOpen = expanded?.id === s.id && expanded.kind === 'filters' && !del
              const matchingOpen = expanded?.id === s.id && expanded.kind === 'matching' && !del
              const fCount = filterCount(s)
              const mCount = matchCount(s)
              const thresholdOverridden = s.matching?.semanticThreshold !== undefined
              const matchAllOn = s.matching?.matchAll === true
              return (
                <>
                  <div className="ent-main">
                    <span className="src-badge" title={`类型：${typeBadge(s)}`}>
                      {typeBadge(s)}
                    </span>
                    {name !== null && (
                      <span className="ent-name" title={name}>
                        {name}
                      </span>
                    )}
                    <span className="ent-sum" title={url}>
                      {url}
                    </span>
                    {del && <span className="badge-del">待删除</span>}
                    <span className="ent-ops">
                      {!del ? (
                        <>
                          <button
                            type="button"
                            className={`ent-btn${filtersOpen ? ' active' : ''}`}
                            title={
                              fCount > 0
                                ? `分类 / 作者过滤（已配 ${fCount} 条）——点击${filtersOpen ? '收起' : '编辑'}`
                                : `配置该来源的分类 / 作者过滤（当前未配置）`
                            }
                            aria-expanded={filtersOpen}
                            onClick={() => setExpanded(filtersOpen ? null : { id: s.id, kind: 'filters' })}
                          >
                            过滤{fCount > 0 ? ` ${fCount}` : ''}
                          </button>
                          <button
                            type="button"
                            className={`ent-btn${matchingOpen ? ' active' : ''}`}
                            title={
                              mCount > 0
                                ? `关键词 / 匹配模式 / 兴趣 / 语义阈值 / 全匹配覆盖（已覆盖 ${mCount} 项）——点击${matchingOpen ? '收起' : '编辑'}`
                                : `单独覆盖该来源的关键词 / 匹配模式 / 兴趣描述 / 语义置信度阈值，或开启全匹配（当前全部跟随全局）`
                            }
                            aria-expanded={matchingOpen}
                            onClick={() => setExpanded(matchingOpen ? null : { id: s.id, kind: 'matching' })}
                          >
                            匹配{mCount > 0 ? ` ${mCount}` : ''}
                          </button>
                          <button
                            type="button"
                            role="switch"
                            className="switch"
                            aria-checked={s.enabled}
                            aria-label={`${s.enabled ? '停用' : '启用'}来源 ${name ?? typeBadge(s)}`}
                            title={s.enabled ? '点击停用该来源' : '点击启用该来源'}
                            onClick={() => toggle(s.id)}
                          />
                          <button
                            type="button"
                            className="ent-btn danger"
                            disabled={!canRemove(s)}
                            title={removeTitle(s)}
                            aria-label={`删除来源 ${name ?? typeBadge(s)}`}
                            onClick={() => onMarkDelete(s.id)}
                          >
                            <IconX size={14} />
                            删除
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="ent-btn"
                          title={`撤销删除「${name ?? typeBadge(s)}」`}
                          onClick={() => onUndoDelete(s.id)}
                        >
                          撤销删除
                        </button>
                      )}
                    </span>
                  </div>
                  {filtersOpen && (
                    <div className="ent-expand">
                      <Field
                        label="分类白名单"
                        hint="非空时只放行命中分类的帖子：匹配分类显示名或 slug（如 交易 / trade），不区分大小写。"
                      >
                        <KeywordTagInput
                          label="分类白名单"
                          placeholder="如：交易 / trade"
                          value={filters?.includeCategories ?? []}
                          onChange={(v) => patchFilters(s.id, { includeCategories: v })}
                        />
                      </Field>
                      <Field
                        label="分类黑名单"
                        hint="分类命中任一条直接滤掉（与白名单并存时黑名单优先）。"
                      >
                        <KeywordTagInput
                          label="分类黑名单"
                          placeholder="如：闲聊 / chat"
                          value={filters?.excludeCategories ?? []}
                          onChange={(v) => patchFilters(s.id, { excludeCategories: v })}
                        />
                      </Field>
                      <Field
                        label="作者黑名单"
                        hint="作者命中任一一票否决（不区分大小写）；被滤掉的帖子入去重集、不推送不评估。"
                      >
                        <KeywordTagInput
                          label="作者黑名单"
                          placeholder="如：某营销号"
                          value={filters?.blockedAuthors ?? []}
                          onChange={(v) => patchFilters(s.id, { blockedAuthors: v })}
                        />
                      </Field>
                      <div className="ent-expand-foot">
                        <button type="button" className="btn" onClick={() => setExpanded(null)}>
                          收起
                        </button>
                      </div>
                    </div>
                  )}
                  {matchingOpen && (
                    <div className="ent-expand">
                      <Field
                        label="全匹配（来源级）"
                        hint="开启后该来源所有过闸新帖直接命中推送（命中方式记「全匹配」），关键词 / 匹配模式 / 兴趣 / 阈值全部跳过；排除词、分类/作者过滤与相似降噪仍会否决。适合「这个版块的帖子我全要」。"
                      >
                        <label className="radio radio-tight">
                          <input
                            type="checkbox"
                            checked={matchAllOn}
                            onChange={(e) =>
                              patchMatching(s.id, { matchAll: e.target.checked ? true : undefined })
                            }
                          />
                          开启全匹配（推送该来源全部新帖）
                        </label>
                      </Field>
                      {/* R13-2：全匹配开启时五个匹配覆盖全部不参与判定——fieldset 置灰
                          禁用（原生语义，覆盖 input/range/checkbox），收起按钮留在
                          fieldset 外保持可点。 */}
                      <fieldset className="ent-match-fields" disabled={matchAllOn}>
                        <Field
                          label="包含关键词（覆盖）"
                          hint="留空 = 跟随全局；设置后**替换**（不是合并）全局包含词——该来源的字面档只按这里的词命中（词条间任一命中，词条内 && 须全部命中）。想整体关掉字面档请用下方「语义匹配」。"
                        >
                          <KeywordTagInput
                            label={`包含关键词覆盖 ${s.id}`}
                            placeholder="如：VPS / 独服 / dedicated"
                            value={s.matching?.includeKeywords ?? []}
                            onChange={(v) => patchMatching(s.id, { includeKeywords: v })}
                          />
                        </Field>
                        <Field
                          label="排除关键词（覆盖）"
                          hint="留空 = 跟随全局；设置后替换全局排除词（任一命中一票否决，先于字面与 AI 判定，全匹配下同样否决）。"
                        >
                          <KeywordTagInput
                            label={`排除关键词覆盖 ${s.id}`}
                            placeholder="如：抽奖 / giveaway"
                            value={s.matching?.excludeKeywords ?? []}
                            onChange={(v) => patchMatching(s.id, { excludeKeywords: v })}
                          />
                        </Field>
                        <Field
                          label="匹配模式（覆盖）"
                          hint="跟随全局时用「智能匹配 → 监控模式」的设置。注意：清空包含词 = 回退全局而非字面档永不命中——想让该来源只走 AI 判定，选「语义匹配」（字面档整体跳过）。"
                        >
                          <div className="radios radios-card">
                            <label className="radio">
                              <input
                                type="radio"
                                name={`match-override-${s.id}`}
                                checked={s.matching?.matchMode === undefined}
                                onChange={() => patchMatching(s.id, { matchMode: undefined })}
                              />
                              <span className="radio-text">
                                <span className="radio-title">跟随全局</span>
                                <span className="radio-desc">用「监控模式」卡的当前设置</span>
                              </span>
                            </label>
                            {MATCH_OVERRIDE_MODES.map((mo) => (
                              <label className="radio" key={mo.value}>
                                <input
                                  type="radio"
                                  name={`match-override-${s.id}`}
                                  checked={s.matching?.matchMode === mo.value}
                                  onChange={() => patchMatching(s.id, { matchMode: mo.value })}
                                />
                                <span className="radio-text">
                                  <span className="radio-title">{mo.title}</span>
                                  <span className="radio-desc">{mo.desc}</span>
                                </span>
                              </label>
                            ))}
                          </div>
                        </Field>
                        <Field
                          label="兴趣描述（覆盖）"
                          hint="留空 = 跟随全局；设置后替换全局兴趣清单（该来源语义档的判定输入）。"
                        >
                          <KeywordTagInput
                            label={`兴趣描述覆盖 ${s.id}`}
                            placeholder="如：便宜大碗的 VPS / 独服 deals"
                            longText
                            value={s.matching?.interests ?? []}
                            onChange={(v) => patchMatching(s.id, { interests: v })}
                          />
                        </Field>
                        <Field
                          label="语义置信度阈值（覆盖）"
                          hint="勾选后替换全局阈值（仅影响该来源的 AI 档）；未勾选 = 跟随全局。勾选初值取当前全局值，不动滑杆保存不会改变生效阈值。"
                        >
                          <div className="input-row">
                            <label className="radio radio-tight">
                              <input
                                type="checkbox"
                                checked={thresholdOverridden}
                                onChange={(e) =>
                                  patchMatching(s.id, {
                                    semanticThreshold: e.target.checked
                                      ? (s.matching?.semanticThreshold ?? globalSemanticThreshold)
                                      : undefined
                                  })
                                }
                              />
                              覆盖全局阈值
                            </label>
                            <input
                              className="input-range"
                              type="range"
                              min={0}
                              max={1}
                              step={0.05}
                              value={s.matching?.semanticThreshold ?? globalSemanticThreshold}
                              disabled={!thresholdOverridden}
                              onChange={(e) =>
                                patchMatching(s.id, { semanticThreshold: Number(e.target.value) })
                              }
                              aria-label={`语义置信度阈值覆盖 ${s.id}`}
                            />
                            <span className="feedback muted num">
                              {(s.matching?.semanticThreshold ?? globalSemanticThreshold).toFixed(2)}
                              {!thresholdOverridden
                                ? '（未覆盖，跟随全局）'
                                : (s.matching?.semanticThreshold ?? globalSemanticThreshold) === 0
                                  ? '（不过滤）'
                                  : ''}
                            </span>
                          </div>
                        </Field>
                      </fieldset>
                      <div className="ent-expand-foot">
                        <button type="button" className="btn" onClick={() => setExpanded(null)}>
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
      <Field label="预设来源" hint="点击一键添加（仍需保存才生效）；已添加的置灰。">
        <div className="input-row">
          {SOURCE_PRESETS.map((p) => {
            const added = presetAdded(p, sources)
            return (
              <button
                type="button"
                key={p.config.id}
                className="btn"
                disabled={added}
                title={added ? `${p.name}：已添加` : p.desc}
                onClick={() => addPreset(p)}
              >
                <IconBroadcast size={14} />
                {p.name}
                {added ? '（已添加）' : ''}
              </button>
            )
          })}
        </div>
        <div className="notice muted-notice">
          Linux.do / LowEndTalk 的 RSS 在部分网络会被 Cloudflare
          拦截：届时来源状态显示「Cloudflare 拦截」并自动退避，建议配合代理； V2EX
          走官方 API，未认证限速约 120 次/小时（默认 60s 轮询在限内）。
        </div>
      </Field>
      <Field
        label="RSS 地址"
        htmlFor="src-url"
        hint={
          urlBad ? (
            <span className="feedback err">
              地址需以 http:// 或 https:// 开头且域名合法（如 https://example.com/feed）
            </span>
          ) : (
            <span>任何 RSS 2.0 / Atom feed；支持 Discourse（/latest.rss）等论坛的全文 feed。</span>
          )
        }
      >
        <input
          id="src-url"
          className={`input mono${urlBad ? ' invalid' : ''}`}
          aria-invalid={urlBad}
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder="https://example.com/feed"
          value={customUrl}
          onChange={(e) => {
            setCustomUrl(e.target.value)
            setAddError(null)
          }}
        />
      </Field>
      <Field label="显示名（可选）" htmlFor="src-label" hint="列表里展示的名字；留空时用地址的域名。">
        <input
          id="src-label"
          className="input"
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder="如：Example 论坛"
          value={customLabel}
          onChange={(e) => setCustomLabel(e.target.value)}
        />
      </Field>
      <Field label="添加" hint="来源 id 由域名自动生成（如 lowendtalk-com）；重复添加同一域名会加后缀区分。">
        <div className="input-row">
          <button
            type="button"
            className="btn"
            disabled={urlTrim === ''}
            title={urlTrim === '' ? '先填写 RSS 地址' : '添加该自定义 RSS 来源'}
            onClick={addCustom}
          >
            <IconBroadcast size={14} />
            添加来源
          </button>
          {addError !== null && <span className="feedback err">{addError}</span>}
        </div>
      </Field>
    </section>
  )
}
