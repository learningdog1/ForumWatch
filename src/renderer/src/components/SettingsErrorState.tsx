/**
 * 设置页整页错误态（settings.md §4.3，修 audit #6：getConfig 失败不再永久
 * loading）。覆盖层 z-index 98——盖 savebar(95)、不盖 leavebar(100)
 * （REDESIGN §1.3 核销值）。文案为定稿原文；重试按钮 danger 描边次级，
 * 不抢 primary。Zone A 由 Settings 在错误态下置灰不可点。
 */
import { IconRefresh } from './icons'

export function SettingsErrorState(props: { reason: string; onRetry: () => void }) {
  return (
    <div className="settings-error" role="alert">
      <section className="card settings-error-card">
        <div className="card-head">
          <span className="card-title">配置读取失败</span>
          <span className="card-title-aux">{props.reason}</span>
        </div>
        <div className="settings-error-body">
          <p>
            无法读取本机配置（{props.reason}）。监控不受影响，仍按已保存的配置运行；
            此页修改在读取成功前不会生效。
          </p>
          <div className="settings-error-actions">
            <button type="button" className="btn btn-danger" onClick={props.onRetry}>
              <IconRefresh size={14} />
              重试
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
