/**
 * 设置页：表单状态从 getConfig 拉取，保存统一走 saveConfig
 * （成功用返回的 sanitize 值回填表单；失败红字展示 error）。
 *
 * 前端校验只提示不拦截（与主进程 sanitize 对齐）：
 * - 轮询间隔 <15 → 红字"最低 15 秒…"（sanitize 会钳到 15）
 * - 代理非 http(s):// 或 socks5(h):// 前缀 → 红字提醒（sanitize 会置空）
 *
 * "发送测试消息"用的是**已保存**配置：表单 dirty 时先提示保存而非直接发送。
 * dirty 状态通过 onDirtyChange 上报给外壳（离开 tab 前的行内提示用）。
 */
import { useEffect, useRef, useState } from 'react'
import type { AppConfig, ProxyScope } from '@shared/types'
import { Field } from '../components/Field'
import { KeywordTagInput } from '../components/KeywordTagInput'
import { formatClock } from '../lib/time'

interface Draft {
  includeKeywords: string[]
  excludeKeywords: string[]
  pollIntervalText: string
  proxyUrl: string
  proxyScope: ProxyScope
  botToken: string
  chatId: string
  notifyEnabled: boolean
  launchAtLogin: boolean
}

type Msg = { kind: 'ok' | 'err' | 'warn' | 'pending' | 'muted'; text: string }

const PROXY_SCHEME_RE = /^(https?|socks5h?):\/\//i

function toDraft(c: AppConfig): Draft {
  return {
    includeKeywords: [...c.includeKeywords],
    excludeKeywords: [...c.excludeKeywords],
    pollIntervalText: String(c.pollIntervalSec),
    proxyUrl: c.proxyUrl,
    proxyScope: c.proxyScope,
    botToken: c.telegram.botToken,
    chatId: c.telegram.chatId,
    notifyEnabled: c.notifyEnabled,
    launchAtLogin: c.launchAtLogin
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

  async function save(): Promise<void> {
    if (draft == null || saved == null) return
    setSaving(true)
    try {
      const cfg: AppConfig = {
        includeKeywords: draft.includeKeywords,
        excludeKeywords: draft.excludeKeywords,
        pollIntervalSec: intervalValid ? Math.floor(intervalNum) : 15,
        proxyUrl: proxyTrim,
        proxyScope: draft.proxyScope,
        telegram: { botToken: draft.botToken.trim(), chatId: draft.chatId.trim() },
        notifyEnabled: draft.notifyEnabled,
        launchAtLogin: draft.launchAtLogin
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
        <Field label="排除关键词" hint="任一命中则不推送（优先于包含词）。">
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
            >
              {showToken ? '隐藏' : '显示'}
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
              {testing ? '发送中…' : '✈ 发送测试消息'}
            </button>
            {testMsg != null && <span className={`feedback ${testMsg.kind}`}>{testMsg.text}</span>}
          </div>
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
              className={`input${intervalValid && !intervalTooLow ? '' : ' invalid'}`}
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
              <span>留空表示直连。</span>
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
              全部请求走代理（含 NodeSeek 抓取）
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
