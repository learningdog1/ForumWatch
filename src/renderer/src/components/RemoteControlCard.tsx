/**
 * 「Telegram 遥控」卡片（R9-W1，DEC-6）：notify.remoteControl 段的 UI——
 * - 开关：启用后本应用经 bot 的 getUpdates 长轮询接收指令（双向遥控）；
 * - 允许的 Chat ID 标签输入：仅这些会话可发指令（硬闸——清单外一律静默忽略，
 *   不回复）；全部 Telegram 通道里配置的 Chat ID 均隐含允许，无需重复填
 *   （settings.md §3.6 授权口径：多通道下「主 Chat ID」未定义，按详稿声明）。
 * - 指令：/status（状态摘要）/ /pause（暂停）/ /resume（恢复）/ /poll（立即
 *   轮询一轮）/ /help（帮助）。
 * 冲突提示（坑8）：启用后该 bot 的 getUpdates 被本应用独占——若你同时用其他
 * 工具轮询同一个 bot（或给 bot 设过 webhook），会互相 409。
 * 就绪条件：开关开启且存在就绪的 telegram 通道（凭据齐备且启用）；未就绪时
 * 开关可打开但监听不启动（装配方按就绪签名对齐）。
 */
import type { NotifyConfig } from '@shared/types'
import { Field } from './Field'
import { KeywordTagInput } from './KeywordTagInput'

const REMOTE_COMMANDS = ['/status', '/pause', '/resume', '/poll', '/help']

export function RemoteControlCard(props: {
  rc: NotifyConfig['remoteControl']
  onChange: (rc: NotifyConfig['remoteControl']) => void
}) {
  const { rc, onChange } = props

  return (
    <section className="card snot">
      <div className="card-head">
        <span className="card-title">Telegram 遥控</span>
        <span className="card-title-aux">
          <span className={`aux-dot${rc.enabled ? ' ok' : ''}`} />
          {rc.enabled ? '已启用' : '关闭'}
        </span>
      </div>
      <Field
        label="开关"
        hint={
          <span>
            启用后可在 Telegram 里向 bot 发指令远程控制监控（需已配置就绪的
            Telegram 推送通道）。可用指令：
            {/* 同一份指令清单改为等宽 chip 组呈现（文案内容不变，只换排版） */}
            <span className="cmd-list">
              {REMOTE_COMMANDS.map((c) => (
                <span className="cmd" key={c}>
                  {c}
                </span>
              ))}
            </span>
            ——/status 查看状态、/pause 暂停、/resume 恢复、/poll 立即轮询一轮、
            /help 帮助。
          </span>
        }
      >
        <div className="switch-row">
          <button
            type="button"
            role="switch"
            className="switch"
            aria-checked={rc.enabled}
            aria-label="Telegram 遥控"
            onClick={() => onChange({ ...rc, enabled: !rc.enabled })}
          />
          <span className="feedback muted">{rc.enabled ? '开启' : '关闭'}</span>
        </div>
      </Field>
      <Field
        label="允许的 Chat ID"
        hint={
          <span>
            仅这些会话可发指令（清单外一律<strong>静默忽略</strong>，不回复）；
            全部 Telegram 通道里配置的 <strong>Chat ID 均隐含允许</strong>，无需重复填。
            群聊 id 是负数（如 -1001234567890）。输入后回车添加，最多 10 个。
          </span>
        }
      >
        <KeywordTagInput
          label="允许的 Chat ID"
          placeholder="如 -1001234567890"
          value={rc.allowedChatIds}
          onChange={(v) => onChange({ ...rc, allowedChatIds: v })}
        />
      </Field>
      <Field label="独占提示" hint="启用后该 bot 的 getUpdates 长轮询被本应用占用。">
        <div className="notice muted-notice">
          若你同时用其他工具轮询同一个 bot（或给 bot 设置过 webhook），双方会互相
          冲突（Telegram 返回 409）——请停掉一边。应用启动时会自动清掉历史 webhook。
        </div>
      </Field>
    </section>
  )
}
