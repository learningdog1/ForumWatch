/**
 * 「数据」卡片（R8-B/E4）：备份导出/导入。
 *
 * - 导出：主进程弹保存对话框，打包 config / seen / state / feedback 四段写到
 *   所选路径。**备份文件含明文凭据**（bot token / API key）——hint 里明说，
 *   导出成功后也再提醒一次妥善保管（L3 破坏性导出的双重警告，settings.md §3.5）。
 * - 导入：先出**确认条**（覆盖语义 + 重启生效），确认后主进程弹打开对话框选
 *   文件并验包 → 按段原子写回。设计稿的「先选文件 → 包摘要 → 确认」顺序反转
 *   需主进程两步 IPC（P2 未就绪），本阶段按降级路径保持现状单步顺序，不谎报
 *   包摘要。成功后主进程即暂停监控并进入"待重启禁写"（退出不再覆盖导入文件），
 *   提示"已导入，请尽快重启（监控已暂停）"。
 * - **失败与取消分级**（audit #14，§4.3）：失败 = err 色带原因（导入附「当前
 *   配置未改动」）；用户取消 = 中性 muted「已取消导出 / 已取消导入」，不混同
 *   为失败。主进程 P2 项（返回值带 cancelled 标志）落地前，取消按返回 error
 *   的既定文案识别（desktop/ipc.ts 两个 dialog canceled 分支的固定字符串）。
 * - Esc 关闭导入确认条（settings.md §5.4 Esc 链末级；保存栏确认条优先）。
 */
import { useEffect, useState } from 'react'
import { Field } from './Field'
import { IconCheck, IconDot } from './icons'

type Msg = { kind: 'ok' | 'err' | 'warn' | 'pending' | 'muted'; text: string }

/** 主进程取消路径的返回文案（desktop/ipc.ts dialog canceled 分支的固定值） */
const EXPORT_CANCELLED = '已取消导出'
const IMPORT_CANCELLED = '已取消导入'

export function DataCard() {
  const [exporting, setExporting] = useState(false)
  const [exportMsg, setExportMsg] = useState<Msg | null>(null)
  /** 导入的确认条：false = 未开始；true = 待用户确认覆盖（确认后才选文件执行） */
  const [pendingImport, setPendingImport] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState<Msg | null>(null)

  // Esc 关闭导入确认条（保存栏行内确认开着时让位——就近优先；设置页 keep-alive
  // 隐藏态不响应，Esc 属于当前可见页面）
  useEffect(() => {
    if (!pendingImport) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.isComposing) return
      if (document.querySelector('.savebar .sb-confirm') != null) return
      const page = document.querySelector('.page-settings')
      if (page != null && page.closest('[hidden]') != null) return
      setPendingImport(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pendingImport])

  async function doExport(): Promise<void> {
    setExporting(true)
    setExportMsg({ kind: 'pending', text: '正在打包导出…' })
    try {
      const r = await window.api.exportBackup()
      if (r.ok) {
        setExportMsg({ kind: 'ok', text: `已导出到 ${r.path}（含明文凭据，请妥善保管）` })
      } else if (r.error === EXPORT_CANCELLED) {
        setExportMsg({ kind: 'muted', text: '已取消导出' })
      } else {
        setExportMsg({ kind: 'err', text: `导出失败：${r.error}` })
      }
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
          text: '已导入，请尽快重启应用生效（监控已暂停）'
        })
      } else if (r.error === IMPORT_CANCELLED) {
        setImportMsg({ kind: 'muted', text: '已取消导入' })
      } else {
        setImportMsg({ kind: 'err', text: `导入失败：${r.error}（当前配置未改动）` })
      }
    } catch {
      setImportMsg({ kind: 'err', text: '导入失败：通道异常' })
    } finally {
      setImporting(false)
    }
  }

  return (
    <section className="card snot">
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
          <button
            type="button"
            className={`btn${exporting ? ' busy' : ''}`}
            disabled={exporting}
            onClick={() => void doExport()}
          >
            导出备份
          </button>
        </div>
        {/* 操作反馈位常驻（.op-feedback）：导出路径/失败原因常为长文本，
            落独立行且高度预留，出现与消失都不推动字段行布局 */}
        <div className="op-feedback">
          {exportMsg !== null && (
            <span className={`feedback ${exportMsg.kind}`}>
              {exportMsg.kind === 'ok' && <IconCheck size={12} />}
              {exportMsg.text}
            </span>
          )}
        </div>
      </Field>
      <Field
        label="导入备份"
        hint="选择之前导出的备份文件（forumwatch-backup-*.json），恢复其中的配置、已读记录与运行状态。"
      >
        {pendingImport ? (
          <div className="inline-confirm" role="alert">
            <span className="inline-confirm-icon">
              <IconDot size={10} />
            </span>
            <div className="inline-confirm-body">
              导入将覆盖当前全部配置与已读记录（含通道凭据、关键词、AI 配置、来源与
              去重状态），此操作不可撤销；导入后需重启应用生效。
            </div>
            <div className="input-row inline-confirm-actions">
              <button
                type="button"
                className={`btn btn-danger-solid${importing ? ' busy' : ''}`}
                disabled={importing}
                onClick={() => void doImport()}
              >
                确认导入
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
              <span className="feedback muted">Esc 取消</span>
            </div>
            <div className="op-feedback">
              {importMsg !== null && (
                <span className={`feedback ${importMsg.kind}`}>
                  {importMsg.kind === 'ok' && <IconCheck size={12} />}
                  {importMsg.text}
                </span>
              )}
            </div>
          </div>
        ) : (
          <>
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
            </div>
            {/* 反馈位常驻：失败（err+原因）与取消（muted）分级展示于此 */}
            <div className="op-feedback">
              {importMsg !== null && (
                <span className={`feedback ${importMsg.kind}`}>
                  {importMsg.kind === 'ok' && <IconCheck size={12} />}
                  {importMsg.text}
                </span>
              )}
            </div>
          </>
        )}
      </Field>
    </section>
  )
}
