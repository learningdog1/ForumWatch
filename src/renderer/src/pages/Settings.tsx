/**
 * 设置页：表单状态从 getConfig 拉取，保存统一走 saveConfig
 * （成功用返回的 sanitize 值回填表单；失败红字展示 error）。
 *
 * 前端校验只提示不拦截（与主进程 sanitize 对齐）：
 * - 轮询间隔 <15 → 红字"最低 15 秒…"（sanitize 会钳到 15）
 * - 代理非 http(s):// 或 socks5(h):// 前缀 → 红字提醒（sanitize 会置空）
 * - 兴趣描述超过 20 条 → 橙字提示（不硬拦）
 *
 * 保存走 AppConfig v2 全量透传：sources 与 ai 段都由本页表单构建
 * （ai 段来自 AI 模型/监控模式/每日总结三张卡，sources 来自「来源」卡——
 * SourceCard 组件内管启停/增删/预设，回写 draft.sources）。
 * "发送测试消息 / 测试连接"用的都是**已保存**配置：表单 dirty 时先提示保存
 * 而非直接发送。dirty 状态通过 onDirtyChange 上报给外壳。
 */
import { useEffect, useRef, useState } from 'react'
import type { AppConfig, MatchMode, ProxyScope, SourceConfig } from '@shared/types'
import { Field } from '../components/Field'
import { KeywordTagInput } from '../components/KeywordTagInput'
import { SourceCard } from '../components/SourceCard'
import { IconBolt, IconEye, IconEyeOff, IconSend } from '../components/icons'
import { formatClock } from '../lib/time'

interface Draft {
  includeKeywords: string[]
  excludeKeywords: string[]
  sources: SourceConfig[]
  pollIntervalText: string
  proxyUrl: string
  proxyScope: ProxyScope
  botToken: string
  chatId: string
  notifyEnabled: boolean
  launchAtLogin: boolean
  aiBaseUrl: string
  aiApiKey: string
  aiModel: string
  matchMode: MatchMode
  interests: string[]
  dailyEnabled: boolean
  dailyTime: string
  commentaryEnabled: boolean
}

type Msg = { kind: 'ok' | 'err' | 'warn' | 'pending' | 'muted'; text: string }

const PROXY_SCHEME_RE = /^(https?|socks5h?):\/\//i

/** 常用 AI 预设（点击填充 baseUrl/model，不自动保存、不碰 apiKey） */
const AI_PRESETS: { name: string; baseUrl: string; model: string }[] = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2-0711-preview' },
  { name: 'GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7' }
]

const INTERESTS_MAX = 20

const MATCH_MODES: { value: MatchMode; title: string; desc: string }[] = [
  { value: 'literal', title: '字面匹配', desc: '按关键词包含判断；快、零成本、表达精确' },
  { value: 'semantic', title: '语义匹配', desc: 'AI 按兴趣描述判断相关性；能捕捉同义表达，需要配置 AI 模型' },
  { value: 'both', title: '字面 + 语义（任一命中）', desc: '两档叠加，先字面后 AI，任一命中即推送' }
]

function toDraft(c: AppConfig): Draft {
  return {
    includeKeywords: [...c.includeKeywords],
    excludeKeywords: [...c.excludeKeywords],
    // 浅拷贝逐项（编辑只整项替换、不就地改嵌套字段，浅层足够）
    sources: c.sources.map((s) => ({ ...s })),
    pollIntervalText: String(c.pollIntervalSec),
    proxyUrl: c.proxyUrl,
    proxyScope: c.proxyScope,
    botToken: c.telegram.botToken,
    chatId: c.telegram.chatId,
    notifyEnabled: c.notifyEnabled,
    launchAtLogin: c.launchAtLogin,
    aiBaseUrl: c.ai.provider.baseUrl,
    aiApiKey: c.ai.provider.apiKey,
    aiModel: c.ai.provider.model,
    matchMode: c.ai.matchMode,
    interests: [...c.ai.interests],
    dailyEnabled: c.ai.dailyReport.enabled,
    dailyTime: c.ai.dailyReport.timeHHMM,
    commentaryEnabled: c.ai.commentary.enabled
  }
}

export function Settings(props: { onDirtyChange: (dirty: boolean) => void }) {
  const [saved, setSaved] = useState<AppConfig | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<Msg | null>(null)
  const [testing, setTesting] = useState(false)
  const [testMsg, setTestMsg] = useState<Msg | null>(null)
  const [showToken, setShowToken] = useState(false)
  const [aiTesting, setAiTesting] = useState(false)
  const [aiTestMsg, setAiTestMsg] = useState<Msg | null>(null)
  const [showApiKey, setShowApiKey] = useState(false)

  // onDirtyChange 上报：ref 镜像避免回调身份变化引起重复触发；卸载时归位 false
  const onDirtyRef = useRef(props.onDirtyChange)
  useEffect(() => {
    onDirtyRef.current = props.onDirtyChange
  }, [props.onDirtyChange])
  useEffect(() => () => onDirtyRef.current(false), [])

  useEffect(() => {
    let cancelled = false
    void window.api
      .getConfig()
      .then((cfg) => {
        if (cancelled) return
        setSaved(cfg)
        setDraft(toDraft(cfg))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const dirty =
    draft != null && saved != null && JSON.stringify(draft) !== JSON.stringify(toDraft(saved))

  useEffect(() => {
    onDirtyRef.current(dirty)
  }, [dirty])

  function patch(p: Partial<Draft>): void {
    setDraft((d) => (d == null ? d : { ...d, ...p }))
  }

  const intervalTrim = (draft?.pollIntervalText ?? '').trim()
  const intervalNum = Number(intervalTrim)
  const intervalValid = intervalTrim !== '' && Number.isFinite(intervalNum)
  const intervalTooLow = intervalValid && intervalNum < 15

  const proxyTrim = (draft?.proxyUrl ?? '').trim()
  const proxySchemeBad = proxyTrim !== '' && !PROXY_SCHEME_RE.test(proxyTrim)

  // 表单口径的 "AI 已配置"（与主进程 Provider 三项齐备判定一致）
  const aiConfigured =
    draft != null &&
    draft.aiBaseUrl.trim() !== '' &&
    draft.aiApiKey.trim() !== '' &&
    draft.aiModel.trim() !== ''
  const semanticMode = draft != null && draft.matchMode !== 'literal'
  const interestsOver = draft != null && draft.interests.length > INTERESTS_MAX

  async function save(): Promise<void> {
    if (draft == null || saved == null) return
    setSaving(true)
    try {
      const cfg: AppConfig = {
        // sources 来自「来源」卡（SourceCard 回写 draft）；ai 段由本页三张 AI 卡
        // 构建，其余字段覆盖为本表单管理的值
        ...saved,
        includeKeywords: draft.includeKeywords,
        excludeKeywords: draft.excludeKeywords,
        sources: draft.sources,
        pollIntervalSec: intervalValid ? Math.floor(intervalNum) : 15,
        proxyUrl: proxyTrim,
        proxyScope: draft.proxyScope,
        telegram: { botToken: draft.botToken.trim(), chatId: draft.chatId.trim() },
        notifyEnabled: draft.notifyEnabled,
        launchAtLogin: draft.launchAtLogin,
        ai: {
          provider: {
            baseUrl: draft.aiBaseUrl.trim(),
            apiKey: draft.aiApiKey.trim(),
            model: draft.aiModel.trim()
          },
          matchMode: draft.matchMode,
          interests: draft.interests,
          dailyReport: { enabled: draft.dailyEnabled, timeHHMM: draft.dailyTime },
          // 锐评开关（本页「AI 模型」卡的「推送锐评」控件）
          commentary: { enabled: draft.commentaryEnabled }
        }
      }
      const r = await window.api.saveConfig(cfg)
      if (r.ok) {
        setSaved(r.config)
        setDraft(toDraft(r.config))
        const adjusted = JSON.stringify(r.config) !== JSON.stringify(cfg)
        const at = formatClock(new Date().toISOString())
        setSaveMsg(
          adjusted
            ? { kind: 'ok', text: `已保存（部分值已按规则修正，如最低 15 秒）· ${at}` }
            : { kind: 'ok', text: `已保存 · ${at}` }
        )
      } else {
        setSaveMsg({ kind: 'err', text: `保存失败：${r.error}` })
      }
    } finally {
      setSaving(false)
    }
  }

  async function sendTest(): Promise<void> {
    if (draft == null) return
    if (dirty) {
      setTestMsg({
        kind: 'warn',
        text: '设置有未保存的改动：测试消息使用的是已保存的配置，请先保存再测试'
      })
      return
    }
    if (draft.botToken.trim() === '' || draft.chatId.trim() === '') {
      setTestMsg({ kind: 'err', text: '请先填写 Bot Token 与 Chat ID 再测试' })
      return
    }
    setTesting(true)
    setTestMsg({ kind: 'pending', text: '正在发送测试消息…' })
    try {
      const r = await window.api.engineControl('sendTest')
      setTestMsg(
        r.ok
          ? { kind: 'ok', text: '✓ 测试消息已发送，请在 Telegram 中查收' }
          : { kind: 'err', text: `发送失败：${r.error}` }
      )
    } finally {
      setTesting(false)
    }
  }

  async function testAi(): Promise<void> {
    if (draft == null) return
    if (dirty) {
      setAiTestMsg({
        kind: 'warn',
        text: '设置有未保存的改动：测试连接使用的是已保存的配置，请先保存再测试'
      })
      return
    }
    if (!aiConfigured) {
      setAiTestMsg({ kind: 'err', text: '请先填写并保存 Base URL、API Key 与模型名再测试' })
      return
    }
    setAiTesting(true)
    setAiTestMsg({ kind: 'pending', text: '正在测试连接…' })
    try {
      const r = await window.api.testAiProvider()
      setAiTestMsg(
        r.ok
          ? { kind: 'ok', text: '✓ 连接成功，模型可用' }
          : { kind: 'err', text: `连接失败：${r.error}` }
      )
    } finally {
      setAiTesting(false)
    }
  }

  if (draft == null) {
    return (
      <div className="page page-settings">
        <section className="card">
          <div className="empty">正在加载配置…</div>
        </section>
      </div>
    )
  }

  return (
    <div className="page page-settings">
      <SourceCard sources={draft.sources} onChange={(sources) => patch({ sources })} />

      <section className="card">
        <div className="card-head">
          <span className="card-title">关键词</span>
        </div>
        <Field
          label="包含关键词"
          hint={<span>任一命中即推送；为空则不推送。输入后回车添加，× 删除。</span>}
        >
          <KeywordTagInput
            label="包含关键词"
            placeholder="如：VPS / 白嫖 / nginx"
            value={draft.includeKeywords}
            onChange={(v) => patch({ includeKeywords: v })}
          />
        </Field>
        <Field label="排除关键词" hint="任一命中则不推送（优先于包含词，也优先于 AI 判定）。">
          <KeywordTagInput
            label="排除关键词"
            placeholder="如：福利 / 广告"
            value={draft.excludeKeywords}
            onChange={(v) => patch({ excludeKeywords: v })}
          />
        </Field>
      </section>

      <section className="card">
        <div className="card-head">
          <span className="card-title">Telegram 推送</span>
        </div>
        <Field label="Bot Token" hint="来自 @BotFather，形如 123456:ABC-DEF...">
          <div className="pw-wrap">
            <input
              className="input mono"
              type={showToken ? 'text' : 'password'}
              spellCheck={false}
              autoComplete="off"
              value={draft.botToken}
              onChange={(e) => patch({ botToken: e.target.value })}
            />
            <button
              type="button"
              className="pw-toggle"
              onClick={() => setShowToken((v) => !v)}
              aria-label={showToken ? '隐藏 Token' : '显示 Token'}
              title={showToken ? '隐藏 Token' : '显示 Token'}
            >
              {showToken ? <IconEyeOff size={14} /> : <IconEye size={14} />}
            </button>
          </div>
        </Field>
        <Field label="Chat ID" hint="个人或群组 id，来自 @userinfobot 或类似机器人。">
          <input
            className="input mono"
            type="text"
            spellCheck={false}
            autoComplete="off"
            value={draft.chatId}
            onChange={(e) => patch({ chatId: e.target.value })}
          />
        </Field>
        <Field label="测试推送" hint="按已保存的配置向该 Chat 发送一条测试消息。">
          <div className="input-row">
            <button type="button" className="btn" disabled={testing} onClick={() => void sendTest()}>
              <IconSend size={14} />
              {testing ? '发送中…' : '发送测试消息'}
            </button>
            {testMsg != null && <span className={`feedback ${testMsg.kind}`}>{testMsg.text}</span>}
          </div>
        </Field>
      </section>

      <section className="card">
        <div className="card-head">
          <span className="card-title">AI 模型</span>
          <span className="card-title-aux">OpenAI 兼容接口</span>
        </div>
        <Field label="常用预设" hint="点击填入对应服务的地址与模型名（不会自动保存，也不改动 API Key）。">
          <div className="input-row">
            {AI_PRESETS.map((p) => (
              <button
                type="button"
                key={p.name}
                className={`btn${draft.aiBaseUrl.trim() === p.baseUrl && draft.aiModel.trim() === p.model ? ' active' : ''}`}
                title={`${p.baseUrl} · ${p.model}`}
                onClick={() => patch({ aiBaseUrl: p.baseUrl, aiModel: p.model })}
              >
                {p.name}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Base URL" hint="OpenAI 兼容服务的 API 根地址，请求时自动拼接 /chat/completions。">
          <input
            className="input mono"
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder="https://api.deepseek.com/v1"
            value={draft.aiBaseUrl}
            onChange={(e) => patch({ aiBaseUrl: e.target.value })}
          />
        </Field>
        <Field
          label="API Key"
          hint="仅存本机 config.json（600 权限），请求只发往你填的地址；不会出现在日志里。"
        >
          <div className="pw-wrap">
            <input
              className="input mono"
              type={showApiKey ? 'text' : 'password'}
              spellCheck={false}
              autoComplete="off"
              placeholder="sk-..."
              value={draft.aiApiKey}
              onChange={(e) => patch({ aiApiKey: e.target.value })}
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
        <Field label="模型名" hint="该服务下可用的模型标识。">
          <input
            className="input mono"
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder="deepseek-chat"
            value={draft.aiModel}
            onChange={(e) => patch({ aiModel: e.target.value })}
          />
        </Field>
        <Field label="测试连接" hint="按已保存的配置发一条最小对话，验证地址 / Key / 模型可用。">
          <div className="input-row">
            <button type="button" className="btn" disabled={aiTesting} onClick={() => void testAi()}>
              <IconBolt size={14} />
              {aiTesting ? '测试中…' : '测试连接'}
            </button>
            {aiTestMsg != null && (
              <span className={`feedback ${aiTestMsg.kind}`}>{aiTestMsg.text}</span>
            )}
          </div>
        </Field>
        <Field
          label="推送锐评"
          hint="命中推送时让 AI 写一句锐评附在消息里。每次命中额外调用一次 LLM（每日上限 100 次，与语义评估共享每日 300 次总额度）；关闭后推送恢复纯净格式。"
        >
          <div className="switch-row">
            <button
              type="button"
              role="switch"
              aria-checked={draft.commentaryEnabled}
              className="switch"
              aria-label="推送锐评"
              onClick={() => patch({ commentaryEnabled: !draft.commentaryEnabled })}
            />
            <span className="feedback muted">{draft.commentaryEnabled ? '开启' : '关闭'}</span>
          </div>
        </Field>
      </section>

      <section className="card">
        <div className="card-head">
          <span className="card-title">监控模式</span>
        </div>
        <Field
          label="匹配模式"
          hint="语义匹配与叠加模式需要先配置 AI 模型；未配置或当日配额耗尽时自动降级为字面匹配。"
        >
          <div className="radios radios-card">
            {MATCH_MODES.map((m) => (
              <label className="radio" key={m.value}>
                <input
                  type="radio"
                  name="match-mode"
                  checked={draft.matchMode === m.value}
                  onChange={() => patch({ matchMode: m.value })}
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
              <span className="warn">已 {draft.interests.length} 条，超过建议上限 {INTERESTS_MAX} 条——兴趣越多，AI 判定越容易发散</span>
            ) : (
              <span>
                语义匹配的兴趣清单，每条一句自然语言（如「Oracle 免费 ARM 的羊毛」）。输入后回车添加。
                {draft.interests.length > 0 && ` 当前 ${draft.interests.length}/${INTERESTS_MAX} 条。`}
              </span>
            )
          }
        >
          {semanticMode && !aiConfigured && (
            <div className="notice muted-notice">尚未配置 AI 模型：语义匹配将自动降级为字面匹配，直到补齐并保存 AI 配置。</div>
          )}
          <KeywordTagInput
            label="兴趣描述"
            placeholder="如：Oracle 免费 ARM 的羊毛"
            longText
            value={draft.interests}
            onChange={(v) => patch({ interests: v })}
          />
        </Field>
      </section>

      <section className="card">
        <div className="card-head">
          <span className="card-title">每日总结</span>
        </div>
        <Field
          label="生成与推送"
          hint="每天此时用 AI 总结当天命中并推送 Telegram；错过的时间点不回溯补做，暂停监控时不生成。"
        >
          <div className="switch-row">
            <button
              type="button"
              role="switch"
              aria-checked={draft.dailyEnabled}
              className="switch"
              aria-label="每日总结"
              onClick={() => patch({ dailyEnabled: !draft.dailyEnabled })}
            />
            <input
              className={`input input-time num${draft.dailyEnabled ? '' : ' input-disabled'}`}
              type="time"
              value={draft.dailyTime}
              disabled={!draft.dailyEnabled}
              onChange={(e) => patch({ dailyTime: e.target.value })}
              aria-label="每日总结时间"
            />
            <span className="feedback muted">{draft.dailyEnabled ? '开启' : '关闭'}</span>
          </div>
        </Field>
        <Field label="补看历史" hint="已生成的日报在「今日回顾」页随时可查，也可在那页手动生成本日日报。">
          <span className="feedback muted">今日回顾页支持手动「立即生成」</span>
        </Field>
      </section>

      <section className="card">
        <div className="card-head">
          <span className="card-title">轮询</span>
        </div>
        <Field
          label="轮询间隔"
          hint={
            !intervalValid ? (
              <span className="err">请输入有效的秒数</span>
            ) : intervalTooLow ? (
              <span className="err">最低 15 秒，过低易触发反爬（保存时会被钳到 15 秒）</span>
            ) : (
              <span>每轮抓取 NodeSeek 首页的间隔。</span>
            )
          }
        >
          <div className="input-row">
            <input
              className={`input num${intervalValid && !intervalTooLow ? '' : ' invalid'}`}
              type="number"
              min={15}
              step={1}
              value={draft.pollIntervalText}
              onChange={(e) => patch({ pollIntervalText: e.target.value })}
            />
            <span className="feedback muted">秒</span>
            <span className="quick">
              {['30', '60', '120'].map((v) => (
                <button
                  type="button"
                  key={v}
                  className={`btn${draft.pollIntervalText === v ? ' active' : ''}`}
                  onClick={() => patch({ pollIntervalText: v })}
                >
                  {v}s
                </button>
              ))}
            </span>
          </div>
        </Field>
      </section>

      <section className="card">
        <div className="card-head">
          <span className="card-title">网络（代理）</span>
        </div>
        <Field
          label="代理地址"
          hint={
            proxySchemeBad ? (
              <span className="err">
                需以 http://、https://、socks5:// 或 socks5h:// 开头；当前值保存时会被清空，请修正
              </span>
            ) : (
              <span>留空表示直连。AI 请求在「全部走代理」时走代理，否则直连。</span>
            )
          }
        >
          <input
            className={`input mono${proxySchemeBad ? ' invalid' : ''}`}
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder="socks5://user:pass@host:1080 或 http://host:port"
            value={draft.proxyUrl}
            onChange={(e) => patch({ proxyUrl: e.target.value })}
          />
        </Field>
        <Field label="作用域" hint="NodeSeek 通常可直连，Telegram 在大陆需要代理。">
          <div className="radios">
            <label className="radio">
              <input
                type="radio"
                name="proxy-scope"
                checked={draft.proxyScope === 'telegram-only'}
                onChange={() => patch({ proxyScope: 'telegram-only' })}
              />
              仅 Telegram 走代理（默认）
            </label>
            <label className="radio">
              <input
                type="radio"
                name="proxy-scope"
                checked={draft.proxyScope === 'all'}
                onChange={() => patch({ proxyScope: 'all' })}
              />
              全部请求走代理（含 NodeSeek 抓取与 AI 请求）
            </label>
          </div>
        </Field>
      </section>

      <section className="card">
        <div className="card-head">
          <span className="card-title">行为</span>
        </div>
        <Field label="推送总开关" hint="临时静音：仍记录命中但不推送。">
          <div className="switch-row">
            <button
              type="button"
              role="switch"
              aria-checked={draft.notifyEnabled}
              className="switch"
              aria-label="推送总开关"
              onClick={() => patch({ notifyEnabled: !draft.notifyEnabled })}
            />
            <span className="feedback muted">{draft.notifyEnabled ? '开启' : '已静音'}</span>
          </div>
        </Field>
        <Field
          label="开机自启"
          hint="mac 上未签名应用可能被系统拒绝自启（可在 系统设置 → 登录项 中检查）。"
        >
          <div className="switch-row">
            <button
              type="button"
              role="switch"
              aria-checked={draft.launchAtLogin}
              className="switch"
              aria-label="开机自启"
              onClick={() => patch({ launchAtLogin: !draft.launchAtLogin })}
            />
            <span className="feedback muted">{draft.launchAtLogin ? '开启' : '关闭'}</span>
          </div>
        </Field>
      </section>

      <div className="savebar">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          {saving ? '保存中…' : '保存设置'}
        </button>
        {saveMsg != null ? (
          <span className={`feedback ${saveMsg.kind}`}>{saveMsg.text}</span>
        ) : (
          <span className="feedback muted">{dirty ? '有未保存的修改' : '无未保存的修改'}</span>
        )}
      </div>
    </div>
  )
}
