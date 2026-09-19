/**
 * 「推送策略」卡片（R6-W4）：notify 段的 UI——
 * - mode 单选：instant 命中即推 / digest 摘要攒批；
 * - digestIntervalMin 数字输入（sanitize 钳 [1,120]，前端只提示不拦截）；
 * - 免打扰：开关 + start/end（HH:MM 时间输入，跨午夜合法——23:00-08:00 表示
 *   当日 23 点到次日 8 点；同值视为空区间不静默）。
 * 挂起语义说明（DEC-11）：免打扰窗内与摘要模式的命中会挂起（不入已读、不计
 * 命中），窗尾 / 到点合并推送；挂起队列是内存态，重启丢弃——仍在首页的帖子
 * 会被重新处理（窗内重新入队 / 窗外直接推），不会丢也不会双发。
 */
import type { NotifyConfig } from '@shared/types'
import { Field } from './Field'

const NOTIFY_MODES: { value: NotifyConfig['mode']; title: string; desc: string }[] = [
  { value: 'instant', title: '实时推送', desc: '命中即推（免打扰窗内除外）' },
  { value: 'digest', title: '摘要攒批', desc: '命中先挂起，到间隔后按批合并推送' }
]

export function NotifyCard(props: {
  notify: NotifyConfig
  onChange: (notify: NotifyConfig) => void
}) {
  const { notify, onChange } = props

  const intervalNum = Number(String(notify.digestIntervalMin))
  const intervalBad = !Number.isFinite(intervalNum) || intervalNum < 1 || intervalNum > 120

  return (
    <section className="card">
      <div className="card-head">
        <span className="card-title">推送策略</span>
        <span className="card-title-aux">{notify.mode === 'digest' ? `摘要 · ${notify.digestIntervalMin} 分钟` : '实时'}</span>
      </div>
      <Field
        label="推送模式"
        hint={
          <span>
            摘要模式下命中不即时推送：先进挂起队列，到达间隔后按插入序合并冲刷
            （每条仍独立成消息，锐评在命中时已生成、冲刷不重打 AI）。
          </span>
        }
      >
        <div className="radios radios-card">
          {NOTIFY_MODES.map((m) => (
            <label className="radio" key={m.value}>
              <input
                type="radio"
                name="notify-mode"
                checked={notify.mode === m.value}
                onChange={() => onChange({ ...notify, mode: m.value })}
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
        label="摘要间隔"
        hint={
          intervalBad ? (
            <span className="err">需为 1-120 的分钟数（保存时会被钳制）</span>
          ) : (
            <span>摘要模式的攒批窗口（分钟）；从本批第一条挂起起算，保存时钳到 [1,120]。</span>
          )
        }
      >
        <div className="input-row">
          <input
            className={`input num${intervalBad ? ' invalid' : ''}`}
            type="number"
            min={1}
            max={120}
            step={1}
            value={notify.digestIntervalMin}
            disabled={notify.mode !== 'digest'}
            aria-label="摘要间隔（分钟）"
            onChange={(e) => onChange({ ...notify, digestIntervalMin: Number(e.target.value) })}
          />
          <span className="feedback muted">分钟</span>
        </div>
      </Field>
      <Field
        label="免打扰时段"
        hint={
          <span>
            窗内命中的推送挂起到窗尾合并发送（只作用于实时模式——摘要模式本身已是
            低打扰形态）。支持<strong>跨午夜</strong>：如 23:00 → 08:00 表示当晚 23 点到
            次日 8 点；起止相同视为未配置。
          </span>
        }
      >
        <div className="switch-row">
          <button
            type="button"
            role="switch"
            className="switch"
            aria-checked={notify.quietHours.enabled}
            aria-label="免打扰时段"
            onClick={() =>
              onChange({
                ...notify,
                quietHours: { ...notify.quietHours, enabled: !notify.quietHours.enabled }
              })
            }
          />
          <input
            className={`input input-time num${notify.quietHours.enabled ? '' : ' input-disabled'}`}
            type="time"
            value={notify.quietHours.startHHMM}
            disabled={!notify.quietHours.enabled}
            aria-label="免打扰开始时刻"
            onChange={(e) =>
              onChange({ ...notify, quietHours: { ...notify.quietHours, startHHMM: e.target.value } })
            }
          />
          <span className="feedback muted">至</span>
          <input
            className={`input input-time num${notify.quietHours.enabled ? '' : ' input-disabled'}`}
            type="time"
            value={notify.quietHours.endHHMM}
            disabled={!notify.quietHours.enabled}
            aria-label="免打扰结束时刻"
            onChange={(e) =>
              onChange({ ...notify, quietHours: { ...notify.quietHours, endHHMM: e.target.value } })
            }
          />
          <span className="feedback muted">{notify.quietHours.enabled ? '开启' : '关闭'}</span>
        </div>
      </Field>
      <Field label="挂起与重启" hint="监控台的「挂起待推送」行实时显示队列条数。">
        <div className="notice muted-notice">
          免打扰窗内与摘要模式的命中会挂起（不入已读、暂不计数），窗尾 / 到点合并推送；
          挂起队列保存在内存里，重启会丢弃——仍在首页的帖子重启后会被重新处理
          （窗内重新入队、窗外直接推送），不丢推也不双发。
        </div>
      </Field>
    </section>
  )
}
