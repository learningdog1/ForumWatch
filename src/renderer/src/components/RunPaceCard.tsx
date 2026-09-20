/**
 * 「运行节奏」卡（阶段 5a 新增，settings.md §7：现状「轮询」「每日总结」
 * 「行为(自启)」三张 1-2 控件小卡合并为一）：轮询间隔 + 生成与推送 +
 * 开机自启 3 个 Field。原「每日总结」卡的「补看历史」伪控件 Field 删除
 * （§3.6：说明伪装成表单行），其信息并入「生成与推送」hint 末句。
 * sanitize 前端提示（最低 15 秒）经由 intervalValid/intervalTooLow props
 * 由 Settings.tsx 下发（save 的同一判定，单源）。
 */
import { Field } from './Field'

export function RunPaceCard(props: {
  pollIntervalText: string
  /** 秒数可解析 / 是否低于 sanitize 下限（15s）——提示态由外层判定 */
  intervalValid: boolean
  intervalTooLow: boolean
  dailyEnabled: boolean
  dailyTime: string
  launchAtLogin: boolean
  onIntervalChange: (v: string) => void
  onDailyToggle: () => void
  onDailyTimeChange: (v: string) => void
  onLaunchToggle: () => void
}) {
  return (
    <section className="card smon">
      <div className="card-head">
        <span className="card-title">运行节奏</span>
      </div>
      <Field
        label="轮询间隔"
        htmlFor="poll-interval"
        hint={
          !props.intervalValid ? (
            <span className="err">请输入有效的秒数</span>
          ) : props.intervalTooLow ? (
            <span className="err">最低 15 秒，过低易触发反爬（保存时会被钳到 15 秒）</span>
          ) : (
            <span>每轮抓取 NodeSeek 首页的间隔。</span>
          )
        }
      >
        <div className="input-row">
          <input
            id="poll-interval"
            className={`input num${props.intervalValid && !props.intervalTooLow ? '' : ' invalid'}`}
            aria-invalid={!props.intervalValid || props.intervalTooLow}
            type="number"
            min={15}
            step={1}
            value={props.pollIntervalText}
            onChange={(e) => props.onIntervalChange(e.target.value)}
          />
          <span className="feedback muted">秒</span>
          <span className="quick">
            {['30', '60', '120'].map((v) => (
              <button
                type="button"
                key={v}
                className={`btn${props.pollIntervalText === v ? ' active' : ''}`}
                onClick={() => props.onIntervalChange(v)}
              >
                {v}s
              </button>
            ))}
          </span>
        </div>
      </Field>
      <Field
        label="生成与推送"
        htmlFor="daily-time"
        hint="每天此时用 AI 总结当天命中并推送 Telegram；错过的时间点不回溯补做，暂停监控时不生成。已生成的日报在「日报」页随时可查，也可在那页手动生成。"
      >
        <div className="switch-row">
          <button
            type="button"
            role="switch"
            aria-checked={props.dailyEnabled}
            className="switch"
            aria-label="每日总结"
            onClick={props.onDailyToggle}
          />
          <input
            id="daily-time"
            className={`input input-time num${props.dailyEnabled ? '' : ' input-disabled'}`}
            type="time"
            value={props.dailyTime}
            disabled={!props.dailyEnabled}
            onChange={(e) => props.onDailyTimeChange(e.target.value)}
            aria-label="每日总结时间"
          />
          <span className="feedback muted">{props.dailyEnabled ? '开启' : '关闭'}</span>
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
            aria-checked={props.launchAtLogin}
            className="switch"
            aria-label="开机自启"
            onClick={props.onLaunchToggle}
          />
          <span className="feedback muted">{props.launchAtLogin ? '开启' : '关闭'}</span>
        </div>
      </Field>
    </section>
  )
}
