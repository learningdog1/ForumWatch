/**
 * 「关于」卡片（R8-B/E1）：当前版本号 + 更新检查（手动 force check / 最近结果
 * 缓存）+ 有新版时「打开下载页」（openExternal——github.com 已并入主进程
 * openExternal 白名单）。三态如实展示：有新版 / 已最新 / 检查失败。
 *
 * 数据面：挂载拉一次 getUpdateStatus（主进程启动 15s 后还有一轮定时检查会
 * 刷新缓存，但本卡不订阅推送——设置页通常短暂停留，下次进来重新拉即可）。
 */
import { useEffect, useState } from 'react'
import type { UpdateCheckStatus } from '@shared/ipc'
import { Field } from './Field'
import { formatClock } from '../lib/time'

export function AboutCard() {
  const [status, setStatus] = useState<UpdateCheckStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [openErr, setOpenErr] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.api
      .getUpdateStatus()
      .then((s) => {
        if (!cancelled) setStatus(s)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  async function check(): Promise<void> {
    setChecking(true)
    try {
      setStatus(await window.api.checkUpdate())
    } catch {
      /* invoke 层已收敛为 state:'error'；真 reject 只能是通道坏了，忽略 */
    } finally {
      setChecking(false)
    }
  }

  async function openDownload(url: string): Promise<void> {
    setOpenErr(false)
    const r = await window.api.openExternal(url)
    if (!r.ok) setOpenErr(true)
  }

  /** 状态行文案（checking 时按钮自带「检查中…」，这里只描最近结果） */
  const statusText = (): { kind: 'ok' | 'warn' | 'err' | 'muted'; text: string } | null => {
    if (status === null) return null
    const at = status.checkedAt !== null ? ` · ${formatClock(status.checkedAt)}` : ''
    switch (status.state) {
      case 'idle':
        return { kind: 'muted', text: '尚未检查（应用启动 15 秒后自动检查一次）' }
      case 'available':
        return { kind: 'warn', text: `有新版本：v${status.current} → ${status.latest ?? '?'}${at}` }
      case 'up-to-date':
        return { kind: 'ok', text: `✓ 已是最新版本（v${status.latest ?? status.current}）${at}` }
      case 'error':
        return { kind: 'err', text: `检查失败：${status.error ?? '未知错误'}${at}` }
    }
  }

  const st = statusText()

  return (
    <section className="card">
      <div className="card-head">
        <span className="card-title">关于</span>
        <span className="card-title-aux">ForumWatch</span>
      </div>
      <Field
        label="当前版本"
        hint="版本号来自应用包（package.json）；新版本经 GitHub Releases 发布。"
      >
        <span className="feedback muted num">v{status?.current ?? '…'}</span>
      </Field>
      <Field
        label="检查更新"
        hint="应用启动 15 秒后自动检查一次，此后每 24 小时向 GitHub Releases 检查；也可随时手动检查。检查失败不影响监控。"
      >
        <div className="input-row">
          <button type="button" className="btn" disabled={checking} onClick={() => void check()}>
            {checking ? '检查中…' : '检查更新'}
          </button>
          {status?.state === 'available' && status.downloadUrl !== undefined && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void openDownload(status.downloadUrl as string)}
            >
              打开下载页（{status.latest}）
            </button>
          )}
          {st !== null && <span className={`feedback ${st.kind}`}>{st.text}</span>}
        </div>
        {openErr && (
          <div className="notice muted-notice">
            打开下载页失败（浏览器唤起被拒）；可手动访问 GitHub Releases 页面。
          </div>
        )}
      </Field>
      {status?.state === 'available' && (
        <Field label="最新版本" hint="下载页含 macOS（dmg）与 Windows（nsis 安装器）两种安装包。">
          <span className="feedback warn num">
            {status.latest}（当前 v{status.current}）
          </span>
        </Field>
      )}
    </section>
  )
}
