/**
 * 「AI 模型」卡（阶段 5a 自 Settings.tsx inline 段拆出，settings.md §7）：
 * 预设 / Base URL / API Key（眼睛显隐）/ 模型名 / 测试连接 / 推送锐评，
 * 内容与 hint 照搬（§3.6 保留清单）。拆出时仅改卡头 aux：就绪态
 * （绿点已配置 / 琥珀未配置，§2）。
 * 测试连接走**已保存**配置：testing/msg/onSend 由 Settings.tsx 下发
 * （dirty 闸在外层）；API Key 显隐是纯 UI 态，随本组件内聚。
 */
import { useState } from 'react'
import { Field } from './Field'
import { IconBolt, IconCheck, IconEye, IconEyeOff } from './icons'

/** 常用 AI 预设（点击填充 baseUrl/model，不自动保存、不碰 apiKey） */
const AI_PRESETS: { name: string; baseUrl: string; model: string }[] = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2-0711-preview' },
  { name: 'GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7' }
]

export interface AiModelTestProps {
  testing: boolean
  msg: { kind: 'ok' | 'err' | 'warn' | 'pending' | 'muted'; text: string } | null
  onSend: () => void
}

export function AiModelCard(props: {
  baseUrl: string
  apiKey: string
  model: string
  commentaryEnabled: boolean
  /** 锐评思考开关（R12）：仅 commentaryEnabled 时呈现 */
  commentaryUseThinking: boolean
  onBaseUrlChange: (v: string) => void
  onApiKeyChange: (v: string) => void
  onModelChange: (v: string) => void
  onCommentaryToggle: () => void
  onCommentaryThinkingToggle: () => void
  onPresetPick: (baseUrl: string, model: string) => void
  test: AiModelTestProps
}) {
  const [showApiKey, setShowApiKey] = useState(false)

  // 表单口径的 "AI 已配置"（与主进程 Provider 三项齐备判定一致），驱动卡头 aux
  const aiConfigured =
    props.baseUrl.trim() !== '' && props.apiKey.trim() !== '' && props.model.trim() !== ''

  return (
    <section className="card snot">
      <div className="card-head">
        <span className="card-title">AI 模型</span>
        <span className="card-title-aux">
          {aiConfigured ? (
            <>
              <span className="aux-dot ok" />
              已配置
            </>
          ) : (
            <>
              <span className="aux-dot warn" />
              未配置
            </>
          )}
        </span>
      </div>
      <Field label="常用预设" hint="点击填入对应服务的地址与模型名（不会自动保存，也不改动 API Key）。">
        <div className="input-row">
          {AI_PRESETS.map((p) => (
            <button
              type="button"
              key={p.name}
              className={`btn${props.baseUrl.trim() === p.baseUrl && props.model.trim() === p.model ? ' active' : ''}`}
              title={`${p.baseUrl} · ${p.model}`}
              onClick={() => props.onPresetPick(p.baseUrl, p.model)}
            >
              {p.name}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Base URL" htmlFor="ai-base-url" hint="OpenAI 兼容服务的 API 根地址，请求时自动拼接 /chat/completions。">
        <input
          id="ai-base-url"
          className="input mono"
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder="https://api.deepseek.com/v1"
          value={props.baseUrl}
          onChange={(e) => props.onBaseUrlChange(e.target.value)}
        />
      </Field>
      <Field
        label="API Key"
        htmlFor="ai-api-key"
        hint="仅存本机 config.json（600 权限），请求只发往你填的地址；不会出现在日志里。"
      >
        <div className="pw-wrap">
          <input
            id="ai-api-key"
            className="input mono"
            type={showApiKey ? 'text' : 'password'}
            spellCheck={false}
            autoComplete="off"
            placeholder="sk-..."
            value={props.apiKey}
            onChange={(e) => props.onApiKeyChange(e.target.value)}
          />
          <button
            type="button"
            className="pw-toggle"
            onClick={() => setShowApiKey((v) => !v)}
            aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
            title={showApiKey ? '隐藏 API Key' : '显示 API Key'}
          >
            {showApiKey ? <IconEyeOff size={14} /> : <IconEye size={14} />}
          </button>
        </div>
      </Field>
      <Field label="模型名" htmlFor="ai-model" hint="该服务下可用的模型标识。">
        <input
          id="ai-model"
          className="input mono"
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder="deepseek-chat"
          value={props.model}
          onChange={(e) => props.onModelChange(e.target.value)}
        />
      </Field>
      <Field label="测试连接" hint="按已保存的配置发一条最小对话，验证地址 / Key / 模型可用。">
        <div className="input-row">
          <button
            type="button"
            className={`btn${props.test.testing ? ' busy' : ''}`}
            disabled={props.test.testing}
            onClick={props.test.onSend}
          >
            {props.test.testing ? null : <IconBolt size={14} />}
            测试连接
          </button>
        </div>
        {/* 反馈位常驻（.op-feedback）：结果出现/消失不推动布局 */}
        <div className="op-feedback">
          {props.test.msg != null && (
            <span className={`feedback ${props.test.msg.kind}`}>
              {props.test.msg.kind === 'ok' && <IconCheck size={12} />}
              {props.test.msg.text}
            </span>
          )}
        </div>
      </Field>
      <Field
        label="推送锐评"
        hint="命中推送时让 AI 写一句锐评附在消息里。每次命中额外调用一次 LLM（不设每日次数上限，调用成本由 LLM 服务侧计费约束）；关闭后推送恢复纯净格式。"
      >
        <div className="switch-row">
          <button
            type="button"
            role="switch"
            aria-checked={props.commentaryEnabled}
            className="switch"
            aria-label="推送锐评"
            onClick={props.onCommentaryToggle}
          />
          <span className="feedback muted">{props.commentaryEnabled ? '开启' : '关闭'}</span>
        </div>
      </Field>
      {props.commentaryEnabled && (
        <Field
          label="锐评深度思考"
          hint="关闭（推荐）：AI 直接写一句锐评，速度快、成功率高，失败还会自动重试一次。开启：允许推理型模型（如 GLM）先思考再点评，明显更慢，且可能因思考占满输出预算而挤不出锐评。该开关仅对支持思考参数的服务（如智谱 GLM）生效。"
        >
          <div className="switch-row">
            <button
              type="button"
              role="switch"
              aria-checked={props.commentaryUseThinking}
              className="switch"
              aria-label="锐评深度思考"
              onClick={props.onCommentaryThinkingToggle}
            />
            <span className="feedback muted">
              {props.commentaryUseThinking ? '开启（慢，可能空评）' : '关闭（推荐）'}
            </span>
          </div>
        </Field>
      )}
    </section>
  )
}
