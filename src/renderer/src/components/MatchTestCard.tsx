/**
 * 「匹配测试台」卡片（R5-P2c）：粘贴一条帖子标题，按**已保存**配置跑一遍
 * 完整判定管线（来源过滤 → 排除词 → 价格规则 → 字面 → 相似降噪 → 语义），
 * 查看会不会推送、卡在哪一步。
 *
 * - 走 match:test IPC（主进程 testbench.runMatchTest）；只读诊断——不写去重集、
 *   不推送、不产生命中记录。
 * - 表单 dirty 时先提示保存（与「发送测试消息 / 测试连接」同款约定：测试用的
 *   都是已保存配置）。
 * - 「调用 AI」开启时真调一次语义评估，消耗一次 LLM 调用（不占用监控引擎的
 *   每日 300 计数器，但服务侧额度照扣）；失败在语义阶段按跳过展示原因。
 */
import { useState, type ReactNode } from 'react'
import type { MatchTestResult } from '@shared/ipc'
import type { SourceConfig } from '@shared/types'
import { Field } from './Field'
import { IconBolt, IconCheck, IconDot, IconMinus, IconX } from './icons'

type Msg = { kind: 'ok' | 'err' | 'warn' | 'pending' | 'muted'; text: string }

/** 阶段结论 → 行首符号（内联 SVG，§C-2 图标语言唯一）与本域阶段行色档
 *  （.mt-mark 的 ok/err/muted；图例文案见「结果」Field 的 hint） */
const OUTCOME_VIEW: Record<
  MatchTestResult['stages'][number]['outcome'],
  { mark: ReactNode; cls: string }
> = {
  pass: { mark: <IconCheck size={12} />, cls: 'ok' },
  block: { mark: <IconX size={12} />, cls: 'err' },
  skip: { mark: <IconMinus size={12} />, cls: 'muted' },
  info: { mark: <IconDot size={12} />, cls: 'muted' }
}

function sourceOptionLabel(s: SourceConfig): string {
  if (s.type === 'nodeseek') return `NodeSeek（${s.id}）`
  if (s.type === 'v2ex') return `V2EX（${s.id}）`
  return s.label ?? s.url
}

export function MatchTestCard(props: { sources: SourceConfig[]; dirty: boolean }) {
  const { sources, dirty } = props
  const [title, setTitle] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [category, setCategory] = useState('')
  const [author, setAuthor] = useState('')
  const [useAi, setUseAi] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<MatchTestResult | null>(null)
  const [msg, setMsg] = useState<Msg | null>(null)

  async function run(): Promise<void> {
    const t = title.trim()
    if (t === '') {
      setMsg({ kind: 'err', text: '请先输入要测试的帖子标题' })
      return
    }
    if (dirty) {
      setMsg({
        kind: 'warn',
        text: '设置有未保存的改动：测试使用的是已保存的配置，请先保存再测试。'
      })
      return
    }
    setRunning(true)
    setMsg({ kind: 'pending', text: '正在评估…' })
    try {
      const r = await window.api.matchTest({
        title: t,
        ...(sourceId !== '' ? { sourceId } : {}),
        useAi,
        ...(category.trim() !== '' ? { category: category.trim() } : {}),
        ...(author.trim() !== '' ? { author: author.trim() } : {})
      })
      setResult(r)
      setMsg(null)
    } catch {
      // handler 收敛过失败语义，这里只是防御（IPC 层异常）
      setMsg({ kind: 'err', text: '测试失败：与主进程通信异常，请重试' })
    } finally {
      setRunning(false)
    }
  }

  return (
    <section className="card smon">
      <div className="card-head">
        <span className="card-title">匹配测试台</span>
        <span className="card-title-aux">只读诊断</span>
      </div>
      <Field
        label="帖子标题"
        htmlFor="match-test-title"
        hint="粘贴一条真实帖子标题，按已保存的配置逐阶段跑判定管线，看它会命中在哪一步、被什么拦下。"
      >
        <input
          id="match-test-title"
          className="input mono"
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder="如：年付 ¥99 的 VPS，500G 流量"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <Field
        label="来源（可选）"
        htmlFor="match-test-source"
        hint="选择来源后，该来源的分类 / 作者过滤参与判定；不选则跳过来源过滤阶段。"
      >
        <div className="input-row">
          <select
            id="match-test-source"
            className="input input-auto-min"
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            aria-label="测试来源"
          >
            <option value="">不指定来源</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {sourceOptionLabel(s)}
              </option>
            ))}
          </select>
        </div>
      </Field>
      <Field
        label="分类 / 作者（可选）"
        htmlFor="match-test-category"
        hint="帖子元数据，供来源过滤判定：分类匹配显示名或 slug（不区分大小写），作者黑名单一票否决。留空按无分类处理——来源配了分类白名单时会显示被滤掉。"
      >
        <div className="input-row">
          <input
            id="match-test-category"
            className="input"
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder="分类，如 交易 / trade"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            aria-label="帖子分类"
          />
          <input
            id="match-test-author"
            className="input"
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder="作者"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            aria-label="帖子作者"
          />
        </div>
      </Field>
      <Field
        label="调用 AI"
        hint="开启后真调一次语义评估（消耗一次 LLM 调用；需 AI 已配置且兴趣描述非空，否则语义阶段按跳过展示原因）。"
      >
        <div className="switch-row">
          <button
            type="button"
            role="switch"
            className="switch"
            aria-checked={useAi}
            aria-label="调用 AI 语义评估"
            onClick={() => setUseAi((v) => !v)}
          />
          <span className="feedback muted">{useAi ? '开启（调用 AI）' : '关闭'}</span>
        </div>
      </Field>
      <Field label="运行" hint="不写去重集、不推送、不产生命中记录，可反复测试。">
        <div className="input-row">
          <button
            type="button"
            className={`btn${running ? ' busy' : ''}`}
            disabled={running}
            onClick={() => void run()}
            title="按已保存配置跑一遍判定管线"
          >
            {running ? null : <IconBolt size={14} />}
            运行测试
          </button>
          {msg != null && <span className={`feedback ${msg.kind}`}>{msg.text}</span>}
          {msg == null && result == null && (
            <span className="feedback muted">尚未运行。粘贴一条真实帖子标题，按已保存配置跑一遍判定管线。</span>
          )}
        </div>
      </Field>
      {running && result == null && (
        <div className="field">
          <span className="field-label">结果</span>
          <div className="mt-running" aria-hidden="true">
            <div className="mt-skel" />
            <div className="mt-skel" />
            <div className="mt-skel" />
          </div>
        </div>
      )}
      {result != null && (
        <Field label="结果" hint="行首符号图例：通过 = 放行/命中；否决 = 一票否决；未评估 = 短路或未提供；无命中 = 评估但无命中。">
          <div className="stack-y">
            <div className={`mt-verdict ${result.wouldPush ? 'ok' : 'err'}`}>
              {result.wouldPush ? <IconCheck size={14} /> : <IconX size={14} />}
              <span>
                {result.wouldPush ? '会推送（若为新帖且推送开关开启）' : '不会推送'}
              </span>
            </div>
            <div className="entity-list">
              {result.stages.map((s) => {
                const view = OUTCOME_VIEW[s.outcome]
                return (
                  <div className="mt-stage" key={s.stage}>
                    <span className={`mt-mark ${view.cls}`} title={s.outcome}>
                      {view.mark}
                    </span>
                    <span className="mt-stage-label">{s.label}</span>
                    <span className="mt-detail">{s.detail}</span>
                  </div>
                )
              })}
            </div>
          </div>
        </Field>
      )}
    </section>
  )
}
