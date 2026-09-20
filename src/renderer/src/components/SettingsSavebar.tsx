/**
 * 设置页 Zone C 吸底保存栏（settings.md §3.1/§5.1）：全页唯一保存出口 +
 * 放弃修改 + 全局修改摘要 + 保存反馈三态互斥。
 *
 * 状态区优先级（audit #7 的反向约束）：保存中 > 保存失败（err，需可读可重试）
 * > dirty（`有 N 处未保存修改 · 含 M 项待删除`，N = 12 段中与已保存值不一致的
 * 段数）> 已保存·时刻（ok，dirty 一旦为真即被清除，两者绝不并存）> 干净态。
 *
 * 放弃修改走行内确认（L2 立即不可逆）：首击后保存栏原地变形为确认条
 * （丢弃 N 处 draft 的 danger 确认，非弹窗），确认后由 Settings 恢复 saved 快照。
 */
export interface SavebarMsg {
  kind: 'ok' | 'err' | 'warn' | 'pending' | 'muted'
  text: string
}

export function SettingsSavebar(props: {
  dirtyCount: number
  deleteCount: number
  saving: boolean
  /** 最近一次保存反馈（成功 ok / 失败 err）；dirty 时 ok 态不显示（audit #7） */
  msg: SavebarMsg | null
  confirming: boolean
  onSave: () => void
  onDiscardStart: () => void
  onDiscardCancel: () => void
  onDiscardConfirm: () => void
}) {
  const n = props.dirtyCount
  const m = props.deleteCount

  if (props.confirming) {
    return (
      <div className="savebar" role="alert">
        <div className="sb-confirm">
          <span>
            将丢弃 {n} 处未保存修改{m > 0 ? `（含 ${m} 项待删除）` : ''}
            ，恢复到上次保存的配置。
          </span>
          <button
            type="button"
            className="btn btn-lg btn-danger-solid"
            onClick={props.onDiscardConfirm}
          >
            确认放弃（{n} 处）
          </button>
          <button type="button" className="btn btn-lg" onClick={props.onDiscardCancel}>
            保留修改
          </button>
          <span className="sb-esc">Esc 取消</span>
        </div>
      </div>
    )
  }

  // 三态互斥的状态区（互斥规则见文件头注释）
  let cls = 'sb-status'
  let text: string
  if (props.saving) {
    cls += ' pending'
    text = '正在保存…'
  } else if (props.msg != null && props.msg.kind === 'err') {
    cls += ' err'
    text = props.msg.text
  } else if (n > 0) {
    cls += ' dirty'
    text = `有 ${n} 处未保存修改${m > 0 ? ` · 含 ${m} 项待删除` : ''}`
  } else if (props.msg != null) {
    cls += props.msg.kind === 'ok' ? ' ok' : ` ${props.msg.kind}`
    text = props.msg.text
  } else {
    text = '没有未保存的修改'
  }

  return (
    <div className="savebar">
      <button
        type="button"
        className="btn btn-lg btn-danger"
        disabled={n === 0 || props.saving}
        onClick={props.onDiscardStart}
      >
        放弃修改
      </button>
      <button
        type="button"
        className={`btn btn-lg btn-primary${props.saving ? ' busy' : ''}`}
        disabled={n === 0 || props.saving}
        title="保存设置（⌘S / Ctrl+S）"
        onClick={props.onSave}
      >
        保存设置
      </button>
      <span className={cls} aria-live="polite">
        {text}
      </span>
    </div>
  )
}
