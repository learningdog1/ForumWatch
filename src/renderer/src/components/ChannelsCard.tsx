/**
 * 「推送通道」卡片（R6-W4，取代旧「Telegram 推送」卡；阶段 5b 改为 L2 实体行）：
 * - 通道列表（EntityList 外壳）：就绪状态点（enabled × 凭据齐备）+ 类型徽标 +
 *   id + 按类型摘要 + 启停开关 + 删除（至少保留一条：列表删空 sanitize 会回
 *   默认 telegram 项，UI 直接禁删；下限按剔除待删除行后的生效列表算）+
 *   「编辑」展开按类型的凭据表单（telegram: botToken/chatId；bark: deviceKey +
 *   可选 serverUrl；ntfy: topic + 可选 serverUrl；webhook: url + 可选 secret）。
 * - L1 删除不弹确认（settings.md §3.5）：已保存过的行转「待删除」态（删除线 +
 *   琥珀徽标 + 撤销删除）；未保存过的新行直接从 draft 移除。
 * - 添加通道：类型下拉 → 按类型渲染对应字段；id 由类型派生、冲突加 -2/-3 后缀
 *   （与主进程 sanitizeChannels 同口径，保存后 id 不会被二次改写）。
 * - 「发送测试消息」按钮宿主在本卡（按钮行为 = 广播全部就绪通道，经
 *   CompositeNotifier.sendTest；状态与 dirty 闸在 Settings 层，经 props 注入）。
 * - 代理说明：telegram 恒走「网络」页配置的代理作用域；bark/ntfy/webhook 在
 *   telegram-only 时与站点抓取/AI 同待遇直连，'all' 时才走代理。
 *
 * 就绪判定（credentialsCompleteUi/isChannelReadyUi）是 main 侧
 * notify/types.ts isChannelReady 的渲染端复刻——tsconfig.web 的 composite 边界
 * 不允许 renderer import src/main，共享判定只能复制一份（口径以 main 侧为准）。
 */
import { useState, type ReactNode } from 'react'
import type { ChannelConfig, ChannelType } from '@shared/types'
import { EntityList, useEscCollapse, type PendingDeleteSlot } from './EntityList'
import { Field } from './Field'
import { IconCheck, IconDot, IconEye, IconEyeOff, IconSend, IconX } from './icons'

/** 类型徽标文案（判别联合的 type 判别值收窄入口） */
function typeBadge(ch: ChannelConfig): string {
  return ch.type === 'telegram' ? 'Telegram' : ch.type === 'bark' ? 'Bark' : ch.type === 'ntfy' ? 'ntfy' : 'Webhook'
}

/** 列表行摘要：按类型给最有辨识度的一眼信息（凭据脱敏——token/key 只露前段） */
function channelSummary(ch: ChannelConfig): string {
  switch (ch.type) {
    case 'telegram':
      return `chat ${ch.chatId.trim() !== '' ? ch.chatId : '—'}`
    case 'bark':
      return ch.deviceKey.trim() !== '' ? `key ${ch.deviceKey.slice(0, 8)}…` : '未配置 deviceKey'
    case 'ntfy':
      return `topic ${ch.topic.trim() !== '' ? ch.topic : '—'}`
    case 'webhook':
      return ch.url.trim() !== '' ? ch.url : '未配置 URL'
  }
}

/** 各类型凭据是否齐备（main 侧 channelCredentialsComplete 的复刻；enabled 不在此判断） */
export function credentialsCompleteUi(ch: ChannelConfig): boolean {
  switch (ch.type) {
    case 'telegram':
      return ch.botToken.trim() !== '' && ch.chatId.trim() !== ''
    case 'bark':
      return ch.deviceKey.trim() !== ''
    case 'ntfy':
      return ch.topic.trim() !== ''
    case 'webhook':
      return ch.url.trim() !== ''
  }
}

/** 通道就绪（main 侧 isChannelReady 的复刻：enabled × 凭据齐备；四类型均已实现发送器） */
export function isChannelReadyUi(ch: ChannelConfig): boolean {
  return ch.enabled && credentialsCompleteUi(ch)
}

/** 新通道 id：类型名起底，冲突加 -2/-3…（与 sanitizeChannels 的派生口径一致） */
function uniqueChannelId(type: ChannelType, channels: ChannelConfig[]): string {
  let id: string = type
  let suffix = 2
  while (channels.some((ch) => ch.id === id)) {
    id = `${type}-${suffix}`
    suffix++
  }
  return id
}

/** 添加表单的字段形状（按类型解释；空串 = 未填） */
interface AddFormState {
  botToken: string
  chatId: string
  deviceKey: string
  topic: string
  url: string
  serverUrl: string
  secret: string
}

const EMPTY_ADD_FORM: AddFormState = {
  botToken: '',
  chatId: '',
  deviceKey: '',
  topic: '',
  url: '',
  serverUrl: '',
  secret: ''
}

/** 测试推送按钮的宿主状态（Settings 持有：dirty 闸与消息反馈都在那一层） */
export interface ChannelTestSlot {
  testing: boolean
  msg: { kind: string; text: string } | null
  onSend: () => void
}

export function ChannelsCard(
  props: {
    channels: ChannelConfig[]
    onChange: (channels: ChannelConfig[]) => void
    test: ChannelTestSlot
  } & PendingDeleteSlot
) {
  const { channels, onChange, test, pendingDelete, onMarkDelete, onUndoDelete } = props
  const [addType, setAddType] = useState<ChannelType>('telegram')
  const [form, setForm] = useState<AddFormState>(EMPTY_ADD_FORM)
  const [addError, setAddError] = useState<string | null>(null)
  /** 当前展开编辑的通道 id（一次一个） */
  const [expandedId, setExpandedId] = useState<string | null>(null)
  useEscCollapse(expandedId != null, () => setExpandedId(null))
  /** Bot Token / Secret 的明文切换（编辑与添加共用） */
  const [showSecret, setShowSecret] = useState(false)

  function patchChannel(id: string, patch: Partial<ChannelConfig>): void {
    onChange(
      channels.map((ch) =>
        ch.id === id ? ({ ...ch, ...patch } as ChannelConfig) : ch
      )
    )
  }

  function toggle(id: string): void {
    const ch = channels.find((c) => c.id === id)
    if (ch === undefined) return
    patchChannel(id, { enabled: !ch.enabled })
  }

  /** 生效列表（剔除待删除行）：至少保留一条的下限与 aux 计数按保存后口径算 */
  const liveChannels = channels.filter((ch) => !pendingDelete.has(ch.id))
  const canRemove = liveChannels.length > 1

  function removeTitle(id: string): string {
    return canRemove
      ? `标记删除「${id}」（保存后生效；放弃修改可还原）`
      : '至少保留一条通道：删空会被重置回默认 Telegram'
  }

  function addChannel(): void {
    const trimmed = (s: string): string => s.trim()
    let item: ChannelConfig | null = null
    if (addType === 'telegram') {
      if (trimmed(form.botToken) === '' || trimmed(form.chatId) === '') {
        setAddError('Telegram 需要 Bot Token 与 Chat ID 两项')
        return
      }
      item = { id: '', type: 'telegram', enabled: true, botToken: trimmed(form.botToken), chatId: trimmed(form.chatId) }
    } else if (addType === 'bark') {
      if (trimmed(form.deviceKey) === '') {
        setAddError('Bark 需要 Device Key（App 内复制）')
        return
      }
      item = { id: '', type: 'bark', enabled: true, deviceKey: trimmed(form.deviceKey) }
      if (trimmed(form.serverUrl) !== '') item.serverUrl = trimmed(form.serverUrl)
    } else if (addType === 'ntfy') {
      if (trimmed(form.topic) === '') {
        setAddError('ntfy 需要订阅的 Topic')
        return
      }
      item = { id: '', type: 'ntfy', enabled: true, topic: trimmed(form.topic) }
      if (trimmed(form.serverUrl) !== '') item.serverUrl = trimmed(form.serverUrl)
    } else {
      if (!/^https?:\/\//i.test(trimmed(form.url))) {
        setAddError('Webhook 需要以 http(s):// 开头的接收地址')
        return
      }
      item = { id: '', type: 'webhook', enabled: true, url: trimmed(form.url) }
      if (trimmed(form.secret) !== '') item.secret = trimmed(form.secret)
    }
    item.id = uniqueChannelId(addType, channels)
    onChange([...channels, item])
    setForm(EMPTY_ADD_FORM)
    setAddError(null)
  }

  /** 按类型渲染一组凭据输入（编辑与添加共用；ch=null 表示添加表单） */
  function renderFields(ch: ChannelConfig | null): ReactNode {
    const type = ch?.type ?? addType
    // 控件 id 前缀（Field htmlFor 关联用）：编辑行走通道 id，添加表单走 add 前缀
    const pid = ch === null ? 'ch-add' : `ch-${ch.id}`
    if (type === 'telegram') {
      const tg = ch?.type === 'telegram' ? ch : null
      const tokenVal = tg ? tg.botToken : form.botToken
      const chatVal = tg ? tg.chatId : form.chatId
      return (
        <>
          <Field label="Bot Token" htmlFor={`${pid}-bot-token`} hint="来自 @BotFather，形如 123456:ABC-DEF...">
            <div className="pw-wrap">
              <input
                id={`${pid}-bot-token`}
                className="input mono"
                type={showSecret ? 'text' : 'password'}
                spellCheck={false}
                autoComplete="off"
                value={tokenVal}
                onChange={(e) =>
                  tg
                    ? patchChannel(tg.id, { botToken: e.target.value } as Partial<ChannelConfig>)
                    : setForm({ ...form, botToken: e.target.value })
                }
              />
              <button
                type="button"
                className="pw-toggle"
                onClick={() => setShowSecret((v) => !v)}
                aria-label={showSecret ? '隐藏 Token' : '显示 Token'}
                title={showSecret ? '隐藏 Token' : '显示 Token'}
              >
                {showSecret ? <IconEyeOff size={14} /> : <IconEye size={14} />}
              </button>
            </div>
          </Field>
          <Field label="Chat ID" htmlFor={`${pid}-chat-id`} hint="个人或群组 id，来自 @userinfobot 或类似机器人。">
            <input
              id={`${pid}-chat-id`}
              className="input mono"
              type="text"
              spellCheck={false}
              autoComplete="off"
              value={chatVal}
              onChange={(e) =>
                tg
                  ? patchChannel(tg.id, { chatId: e.target.value } as Partial<ChannelConfig>)
                  : setForm({ ...form, chatId: e.target.value })
              }
            />
          </Field>
        </>
      )
    }
    if (type === 'bark') {
      const bark = ch?.type === 'bark' ? ch : null
      return (
        <>
          <Field label="Device Key" htmlFor={`${pid}-device-key`} hint="Bark App「首页→复制」里的 key；官方网关或自建服务器均可。">
            <input
              id={`${pid}-device-key`}
              className="input mono"
              type="text"
              spellCheck={false}
              autoComplete="off"
              value={bark ? bark.deviceKey : form.deviceKey}
              onChange={(e) =>
                bark
                  ? patchChannel(bark.id, { deviceKey: e.target.value } as Partial<ChannelConfig>)
                  : setForm({ ...form, deviceKey: e.target.value })
              }
            />
          </Field>
          <Field label="服务器（可选）" htmlFor={`${pid}-server-url`} hint="自建 Bark 服务器地址；留空 = 官方 https://api.day.app。">
            <input
              id={`${pid}-server-url`}
              className="input mono"
              type="text"
              spellCheck={false}
              autoComplete="off"
              placeholder="https://api.day.app"
              value={bark ? (bark.serverUrl ?? '') : form.serverUrl}
              onChange={(e) =>
                bark
                  ? patchChannel(bark.id, { serverUrl: e.target.value } as Partial<ChannelConfig>)
                  : setForm({ ...form, serverUrl: e.target.value })
              }
            />
          </Field>
        </>
      )
    }
    if (type === 'ntfy') {
      const ntfy = ch?.type === 'ntfy' ? ch : null
      return (
        <>
          <Field label="Topic" htmlFor={`${pid}-topic`} hint="ntfy 的订阅主题名（自建服务器上需已创建/可发布）。">
            <input
              id={`${pid}-topic`}
              className="input mono"
              type="text"
              spellCheck={false}
              autoComplete="off"
              value={ntfy ? ntfy.topic : form.topic}
              onChange={(e) =>
                ntfy
                  ? patchChannel(ntfy.id, { topic: e.target.value } as Partial<ChannelConfig>)
                  : setForm({ ...form, topic: e.target.value })
              }
            />
          </Field>
          <Field label="服务器（可选）" htmlFor={`${pid}-server-url`} hint="自建 ntfy 地址；留空 = 官方 https://ntfy.sh。">
            <input
              id={`${pid}-server-url`}
              className="input mono"
              type="text"
              spellCheck={false}
              autoComplete="off"
              placeholder="https://ntfy.sh"
              value={ntfy ? (ntfy.serverUrl ?? '') : form.serverUrl}
              onChange={(e) =>
                ntfy
                  ? patchChannel(ntfy.id, { serverUrl: e.target.value } as Partial<ChannelConfig>)
                  : setForm({ ...form, serverUrl: e.target.value })
              }
            />
          </Field>
        </>
      )
    }
    const hook = ch?.type === 'webhook' ? ch : null
    return (
      <>
        <Field
          label="接收地址"
          htmlFor={`${pid}-url`}
          hint="命中打包成结构化 JSON POST 到该地址（鉴权头 X-ForumWatch-Secret）；供自建自动化/归档消费。"
        >
          <input
            id={`${pid}-url`}
            className="input mono"
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder="https://example.com/hook"
            value={hook ? hook.url : form.url}
            onChange={(e) =>
              hook
                ? patchChannel(hook.id, { url: e.target.value } as Partial<ChannelConfig>)
                : setForm({ ...form, url: e.target.value })
            }
          />
        </Field>
        <Field label="Secret（可选）" htmlFor={`${pid}-secret`} hint="非空时随请求发送 X-ForumWatch-Secret 头供消费端校验。">
          <input
            id={`${pid}-secret`}
            className="input mono"
            type={showSecret ? 'text' : 'password'}
            spellCheck={false}
            autoComplete="off"
            value={hook ? (hook.secret ?? '') : form.secret}
            onChange={(e) =>
              hook
                ? patchChannel(hook.id, { secret: e.target.value } as Partial<ChannelConfig>)
                : setForm({ ...form, secret: e.target.value })
            }
          />
        </Field>
      </>
    )
  }

  const readyCount = liveChannels.filter(isChannelReadyUi).length

  return (
    <section className="card snot">
      <div className="card-head">
        <span className="card-title">推送通道</span>
        <span className="card-title-aux num">{readyCount}/{liveChannels.length} 就绪</span>
      </div>
      {readyCount === 0 && (
        <div className="warn-strip">
          还没有就绪通道：凭据齐备且启用的通道才会推送。展开行内编辑填好凭据。
        </div>
      )}
      <Field
        label="已配置通道"
        hint={
          <span>
            就绪 = 已启用且凭据齐备；只有就绪通道参与推送（路由与测试消息都是）。
            Telegram 恒走「网络」页的代理；Bark / ntfy / Webhook 在「仅 Telegram 走代理」时
            与站点抓取同待遇<strong>直连</strong>，「全部走代理」时才经代理。
            启停与凭据修改保存后即热生效，无需重启。
          </span>
        }
      >
        <div className="ch-list">
        <EntityList
          items={channels}
          rowKey={(ch) => ch.id}
          rowClass={(ch) => (pendingDelete.has(ch.id) ? ' del' : '')}
          render={(ch) => {
            const del = pendingDelete.has(ch.id)
            const ready = isChannelReadyUi(ch)
            const credsOk = credentialsCompleteUi(ch)
            const open = expandedId === ch.id && !del
            // tone-* 复用现有 CSS 语气类（ok / backoff=已停用 / challenged=凭据缺失）
            const dotTone = ready ? 'ok' : credsOk ? 'backoff' : 'challenged'
            const dotTitle = ready
              ? '就绪：已启用且凭据齐备'
              : credsOk
                ? '凭据齐备但已停用（不参与推送）'
                : '凭据未配齐（填好并保存后才参与推送）'
            const summary = channelSummary(ch)
            return (
              <>
                <div className={`ent-main tone-${dotTone}`}>
                  <span className="src-dot" title={dotTitle}>
                    <IconDot size={8} />
                  </span>
                  <span className="src-badge" title={`类型：${typeBadge(ch)}`}>
                    {typeBadge(ch)}
                  </span>
                  <span className="ent-name" title={`通道 id：${ch.id}（命中明细 notifyDetail 的键）`}>
                    {ch.id}
                  </span>
                  <span className="ent-sum" title={summary}>
                    {summary}
                  </span>
                  <span className="ch-state">{ready ? '就绪' : credsOk ? '已停用' : '未配齐'}</span>
                  {del && <span className="badge-del">待删除</span>}
                  <span className="ent-ops">
                    {!del ? (
                      <>
                        <button
                          type="button"
                          className={`ent-btn${open ? ' active' : ''}`}
                          aria-expanded={open}
                          title={open ? '收起凭据编辑' : '展开凭据编辑'}
                          onClick={() => setExpandedId(open ? null : ch.id)}
                        >
                          {open ? '收起' : '编辑'}
                        </button>
                        <button
                          type="button"
                          role="switch"
                          className="switch"
                          aria-checked={ch.enabled}
                          aria-label={`${ch.enabled ? '停用' : '启用'}通道 ${ch.id}`}
                          title={ch.enabled ? '点击停用该通道' : '点击启用该通道'}
                          onClick={() => toggle(ch.id)}
                        />
                        <button
                          type="button"
                          className="ent-btn danger"
                          disabled={!canRemove}
                          title={removeTitle(ch.id)}
                          aria-label={`删除通道 ${ch.id}`}
                          onClick={() => onMarkDelete(ch.id)}
                        >
                          <IconX size={14} />
                          删除
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="ent-btn"
                        title={`撤销删除「${ch.id}」`}
                        onClick={() => onUndoDelete(ch.id)}
                      >
                        撤销删除
                      </button>
                    )}
                  </span>
                </div>
                {open && <div className="ent-expand">{renderFields(ch)}</div>}
              </>
            )
          }}
        />
        </div>
      </Field>
      <Field label="添加通道" htmlFor="ch-add-type" hint="选择类型后填写对应凭据；id 由类型自动生成，保存后生效。">
        <div className="input-row">
          <select
            id="ch-add-type"
            className="input input-auto"
            value={addType}
            aria-label="通道类型"
            onChange={(e) => {
              setAddType(e.target.value as ChannelType)
              setAddError(null)
            }}
          >
            <option value="telegram">Telegram（Bot）</option>
            <option value="bark">Bark（iOS）</option>
            <option value="ntfy">ntfy</option>
            <option value="webhook">Webhook（JSON）</option>
          </select>
        </div>
        <div className="mt-md">{renderFields(null)}</div>
        <div className="input-row mt-md">
          <button
            type="button"
            className="btn"
            onClick={addChannel}
            title="加入通道列表（仍需保存才生效）"
          >
            添加
          </button>
          {addError !== null && <span className="feedback err">{addError}</span>}
        </div>
      </Field>
      <Field
        label="测试推送"
        hint="按已保存的配置向**全部就绪通道**各发一条测试消息（不走路由规则；日报同样广播全部通道）。"
      >
        <div className="input-row">
          <button
            type="button"
            className={`btn${test.testing ? ' busy' : ''}`}
            disabled={test.testing}
            onClick={test.onSend}
          >
            {test.testing ? null : <IconSend size={14} />}
            发送测试消息
          </button>
        </div>
        {/* 反馈位常驻（.op-feedback）：消息出现/消失不推动布局 */}
        <div className="op-feedback">
          {test.msg != null && (
            <span className={`feedback ${test.msg.kind}`}>
              {test.msg.kind === 'ok' && <IconCheck size={12} />}
              {test.msg.text}
            </span>
          )}
        </div>
      </Field>
    </section>
  )
}
