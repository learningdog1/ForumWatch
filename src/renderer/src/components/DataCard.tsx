/**
 * 「数据」卡片（R8-B/E4）：备份导出/导入。
 *
 * - 导出：主进程弹保存对话框，打包 config / seen / state / feedback 四段写到
 *   所选路径。**备份文件含明文凭据**（bot token / API key）——hint 里明说，
 *   导出成功后也再提醒一次妥善保管。
 * - 导入：先弹打开对话框选文件，选完出**确认弹层**（覆盖语义 + 重启生效），
 *   确认后主进程验包 → 按段原子写回。成功后主进程即暂停监控并进入"待重启
 *   禁写"（退出不再覆盖导入文件），提示"已导入，请尽快重启（监控已暂停）"。
 * - 两路的取消（对话框按了取消）按 muted 提示处理，不算错误。
 */
import { useState } from 'react'
import { Field } from './Field'

type Msg = { kind: 'ok' | 'err' | 'warn' | 'pending' | 'muted'; text: string }

export function DataCard() {
  const [exporting, setExporting] = useState(false)
  const [exportMsg, setExportMsg] = useState<Msg | null>(null)
  /** 导入的两步确认：null = 未开始；true = 文件已选、待用户确认覆盖 */
  const [pendingImport, setPendingImport] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState<Msg | null>(null)

  async function doExport(): Promise<void> {
    setExporting(true)
    setExportMsg({ kind: 'pending', text: '正在打包导出…' })
    try {
      const r = await window.api.exportBackup()
      setExportMsg(
        r.ok
          ? { kind: 'ok', text: `✓ 已导出到 ${r.path}（含明文凭据，请妥善保管）` }
          : { kind: 'muted', text: r.error }
      )
    } catch {
      setExportMsg({ kind: 'err', text: '导出失败：通道异常' })
    } finally {
      setExporting(false)
    }
  }

  async function doImport(): Promise<void> {
    setImporting(true)
    setImportMsg({ kind: 'pending', text: '正在导入…' })
    try {
      const r = await window.api.importBackup()
      if (r.ok) {
        setPendingImport(false)
        // 导入成功即暂停监控（主进程侧），退出时不再写 seen/state——文案与
        // 主进程行为对齐：提示"已暂停"，催促尽快重启而不是慢慢等下一轮
        setImportMsg({
          kind: 'ok',
          text: '✓ 已导入，请尽快重启应用生效（监控已暂停）'
        })
      } else {
        setImportMsg({ kind: 'muted', text: r.error })
      }
    } catch {
      setImportMsg({ kind: 'err', text: '导入失败：通道异常' })
    } finally {
      setImporting(false)
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <span className="card-title">数据</span>
        <span className="card-title-aux">备份与恢复</span>
      </div>
      <Field
        label="导出备份"
        hint={
          <span className="warn">
            导出文件包含完整配置与已读记录，其中含**明文凭据**（bot token / API
            key 等）——请妥善保管，不要分享给他人或上传到公开位置。
          </span>
        }
      >
        <div className="input-row">
          <button type="button" className="btn" disabled={exporting} onClick={() => void doExport()}>
            {exporting ? '导出中…' : '导出备份'}
          </button>
          {exportMsg !== null && <span className={`feedback ${exportMsg.kind}`}>{exportMsg.text}</span>}
        </div>
      </Field>
      <Field
        label="导入备份"
        hint="选择之前导出的备份文件（forumwatch-backup-*.json），恢复其中的配置、已读记录与运行状态。"
      >
        {pendingImport ? (
          <div className="notice">
            <div>
              确认后将选择备份文件，其内容会**覆盖**当前全部配置与已读记录（含推送
              通道凭据、关键词、AI 配置、来源列表与去重状态）；导入后需**重启应用**
              生效。此操作不可撤销。
            </div>
            <div className="input-row" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="btn btn-danger"
                disabled={importing}
                onClick={() => void doImport()}
              >
                {importing ? '导入中…' : '确认导入'}
              </button>
              <button
                type="button"
                className="btn"
                disabled={importing}
                onClick={() => {
                  setPendingImport(false)
                  setImportMsg(null)
                }}
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <div className="input-row">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setImportMsg(null)
                setPendingImport(true)
              }}
            >
              导入备份
            </button>
            {importMsg !== null && (
              <span className={`feedback ${importMsg.kind}`}>{importMsg.text}</span>
            )}
          </div>
        )}
      </Field>
    </section>
  )
}
