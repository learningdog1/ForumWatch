/**
 * 「来源」卡片（R4-W4，从 Settings 拆出的新卡片）：
 * - 来源列表：类型徽标（NodeSeek/V2EX/RSS）+ 名称（rss 显示 label 或 host）+
 *   url + 启停开关 + 删除按钮。默认 nodeseek 来源不可删除（至少保留一个来源，
 *   列表删空 sanitize 会回默认——UI 侧直接禁删更清晰）。
 * - 添加：三个预设（V2EX / Linux.do / LowEndTalk，见 lib/presets.ts；已添加的
 *   按 id 匹配置灰）+ 自定义 RSS（url 前端校验 http(s) 红字反馈；id 从 host
 *   slug 化生成、冲突加 -2/-3 后缀）。
 * - 状态收在组件内；修改经 onChange 回写 Settings 的 draft config sources 字段，
 *   走既有「保存设置」链路（无新 IPC）。
 * - filters（分类/作者过滤）UI 本轮不做（R5），只留结构预留（尾部提示行）。
 *
 * 判别联合读取收窄：type === 'rss' 才访问 url / label（@shared/types v3）。
 */
import { useState } from 'react'
import type { RssSourceConfig, SourceConfig } from '@shared/types'
import { Field } from './Field'
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

export function SourceCard(props: {
  sources: SourceConfig[]
  onChange: (sources: SourceConfig[]) => void
}) {
  const { sources, onChange } = props
  // 自定义 RSS 表单状态收在组件内：只有点「添加来源」成功才落进 sources（draft）
  const [customUrl, setCustomUrl] = useState('')
  const [customLabel, setCustomLabel] = useState('')
  const [addError, setAddError] = useState<string | null>(null)

  const urlTrim = customUrl.trim()
  const urlBad = urlTrim !== '' && httpUrlHost(urlTrim) === null

  function toggle(id: string): void {
    onChange(sources.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)))
  }

  /** 默认 nodeseek 来源不可删；其余至少保留一个来源（删空 sanitize 会回默认） */
  function canRemove(s: SourceConfig): boolean {
    if (s.type === 'nodeseek' && s.id === 'nodeseek') return false
    return sources.length > 1
  }

  function removeTitle(s: SourceConfig): string {
    return canRemove(s)
      ? `删除来源「${displayName(s) ?? typeBadge(s)}」（保存后生效）`
      : '至少保留一个来源：列表删空会被重置回默认'
  }

  function remove(id: string): void {
    onChange(sources.filter((s) => s.id !== id))
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
    <section className="card">
      <div className="card-head">
        <span className="card-title">来源</span>
        <span className="card-title-aux">多论坛监控</span>
      </div>
      <Field
        label="已配置来源"
        hint={
          <span>
            启停即时进入 draft、点「保存设置」生效；停用的来源不抓取也不进外链白名单。
            至少保留一个来源。
          </span>
        }
      >
        <div className="card-scroll">
          {sources.length === 0 ? (
            <div className="src-empty">暂无来源（保存时会被重置回默认 NodeSeek）</div>
          ) : (
            sources.map((s) => {
              const name = displayName(s)
              const url = displayUrl(s)
              return (
                <div className="hit" key={s.id}>
                  <span className="src-badge" title={`类型：${typeBadge(s)}`}>
                    {typeBadge(s)}
                  </span>
                  {name !== null && <span className="src-name">{name}</span>}
                  <span className="ai-reason" title={url}>
                    {url}
                  </span>
                  <span className="src-last switch-row">
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
                      className="btn btn-danger"
                      disabled={!canRemove(s)}
                      title={removeTitle(s)}
                      aria-label={`删除来源 ${name ?? typeBadge(s)}`}
                      onClick={() => remove(s.id)}
                    >
                      <IconX size={14} />
                      删除
                    </button>
                  </span>
                </div>
              )
            })
          )}
        </div>
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
          className={`input mono${urlBad ? ' invalid' : ''}`}
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
      <Field label="显示名（可选）" hint="列表里展示的名字；留空时用地址的域名。">
        <input
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
      {/* 结构预留：per-source filters（分类/作者过滤）UI 属 R5，本轮不渲染控件 */}
      <div className="notice muted-notice">按来源的分类 / 作者过滤将在后续版本开放。</div>
    </section>
  )
}
