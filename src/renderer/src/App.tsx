/**
 * 应用外壳：左侧栏（品牌 + 监控台/今日回顾/历史命中/流水/设置 五个 tab + 底部
 * 迷你运行状态）+ 右侧内容区。
 *
 * - 状态数据只在壳层 useApi 一次，向下传给监控台（避免双份订阅/双份全量拉取）。
 * - 设置页 dirty 通过 onDirtyChange 上报；dirty 时切走 tab 不直接切换，
 *   而是给行内提示条（放弃修改并切换 / 留在设置）——不做路由拦截。
 * - 侧栏底部迷你状态与托盘 tooltip 同口径（deriveTrayLabel / deriveRunState）。
 */
import { useCallback, useState } from 'react'
import { deriveTrayLabel } from '@shared/ipc'
import { IconPulse, IconRadar, IconReport, IconSliders } from './components/icons'
import { useApi } from './hooks/useApi'
import { deriveRunState } from './lib/status'
import { Dashboard } from './pages/Dashboard'
import { Dispositions } from './pages/Dispositions'
import { History } from './pages/History'
import { Reports } from './pages/Reports'
import { Settings } from './pages/Settings'

type Tab = 'dashboard' | 'reports' | 'history' | 'dispositions' | 'settings'

/**
 * 流水 tab 的放大镜图标（R7-W1）。components/icons.tsx 不在本工作包允许改动
 * 清单内，故按该文件的同款约定（16×16 栅格 / stroke 1.5 / currentColor /
 * aria-hidden）在本地定义。
 */
function IconSearch(props: { size?: number; className?: string }) {
  const size = props.size ?? 16
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.4 10.4 14 14" />
    </svg>
  )
}

/**
 * 历史命中 tab 的卷轴/时钟图标（R7-W2）。同 IconSearch 的本地定义约定
 * （components/icons.tsx 不在允许改动清单内）。
 */
function IconHistory(props: { size?: number; className?: string }) {
  const size = props.size ?? 16
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3l2 2" />
    </svg>
  )
}

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
          <span className="brand-icon">
            <IconRadar size={20} />
          </span>
          <span className="brand-text">
            <span className="brand-name">ForumWatch</span>
            <span className="brand-sub">论坛监控</span>
          </span>
        </div>
        <nav className="nav">
          <button
            type="button"
            className={`nav-btn${tab === 'dashboard' ? ' active' : ''}`}
            onClick={() => switchTab('dashboard')}
          >
            <IconPulse size={16} />
            监控台
          </button>
          <button
            type="button"
            className={`nav-btn${tab === 'reports' ? ' active' : ''}`}
            onClick={() => switchTab('reports')}
          >
            <IconReport size={16} />
            今日回顾
          </button>
          <button
            type="button"
            className={`nav-btn${tab === 'history' ? ' active' : ''}`}
            onClick={() => switchTab('history')}
          >
            <IconHistory size={16} />
            历史命中
          </button>
          <button
            type="button"
            className={`nav-btn${tab === 'dispositions' ? ' active' : ''}`}
            onClick={() => switchTab('dispositions')}
          >
            <IconSearch size={16} />
            流水
          </button>
          <button
            type="button"
            className={`nav-btn${tab === 'settings' ? ' active' : ''}`}
            onClick={() => switchTab('settings')}
          >
            <IconSliders size={16} />
            设置
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
        ) : tab === 'reports' ? (
          <Reports />
        ) : tab === 'history' ? (
          <History />
        ) : tab === 'dispositions' ? (
          <Dispositions />
        ) : (
          <Settings onDirtyChange={handleDirtyChange} />
        )}
      </main>
    </div>
  )
}
