/**
 * 应用外壳：左侧栏（品牌 + 监控台/设置 两个 tab + 底部迷你运行状态）
 * + 右侧内容区。
 *
 * - 状态数据只在壳层 useApi 一次，向下传给监控台（避免双份订阅/双份全量拉取）。
 * - 设置页 dirty 通过 onDirtyChange 上报；dirty 时切走 tab 不直接切换，
 *   而是给行内提示条（放弃修改并切换 / 留在设置）——不做路由拦截。
 * - 侧栏底部迷你状态与托盘 tooltip 同口径（deriveTrayLabel / deriveRunState）。
 */
import { useCallback, useState } from 'react'
import { deriveTrayLabel } from '@shared/ipc'
import { useApi } from './hooks/useApi'
import { deriveRunState } from './lib/status'
import { Dashboard } from './pages/Dashboard'
import { Settings } from './pages/Settings'

type Tab = 'dashboard' | 'settings'

export default function App() {
  const [tab, setTab] = useState<Tab>('dashboard')
  const [settingsDirty, setSettingsDirty] = useState(false)
  const [pendingTab, setPendingTab] = useState<Tab | null>(null)
  const { status, hits, logs } = useApi()

  const handleDirtyChange = useCallback((dirty: boolean) => {
    setSettingsDirty(dirty)
  }, [])

  const runState = deriveRunState(status)

  function switchTab(next: Tab): void {
    if (next === tab) {
      setPendingTab(null)
      return
    }
    // 设置页有未保存修改：先给行内提示，不直接切走
    if (tab === 'settings' && settingsDirty) {
      setPendingTab(next)
      return
    }
    setTab(next)
    setPendingTab(null)
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-icon">📡</span>
          <span>NodeSeek Monitor</span>
        </div>
        <nav className="nav">
          <button
            type="button"
            className={`nav-btn${tab === 'dashboard' ? ' active' : ''}`}
            onClick={() => switchTab('dashboard')}
          >
            📊 监控台
          </button>
          <button
            type="button"
            className={`nav-btn${tab === 'settings' ? ' active' : ''}`}
            onClick={() => switchTab('settings')}
          >
            ⚙️ 设置
            {settingsDirty && tab !== 'settings' && (
              <span className="dirty-dot" title="有未保存的修改" />
            )}
          </button>
        </nav>
        <div className={`sidebar-foot tone-${runState.key}`} title={deriveTrayLabel(status)}>
          <span className="dot" />
          <span className="sidebar-foot-label">{runState.label}</span>
        </div>
      </aside>

      <main className="content">
        {pendingTab != null && (
          <div className="leavebar" role="alert">
            <span>设置表单有未保存的修改，切换页面后将不会保存。</span>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setTab(pendingTab)
                setPendingTab(null)
              }}
            >
              放弃修改并切换
            </button>
            <button type="button" className="btn" onClick={() => setPendingTab(null)}>
              留在设置
            </button>
          </div>
        )}
        {tab === 'dashboard' ? (
          <Dashboard status={status} hits={hits} logs={logs} />
        ) : (
          <Settings onDirtyChange={handleDirtyChange} />
        )}
      </main>
    </div>
  )
}
