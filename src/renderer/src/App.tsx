/**
 * 应用外壳（R10 重设计，REDESIGN §4/§5.1）：
 * - 侧栏五分区定稿命名与顺序（监控台 → 去向 → 历史命中 → 日报 ┃ 设置）：
 *   顺序 = 数据新鲜度谱系（事件驱动 → 10s 轮询 → 手动 → 每日快照），
 *   查看区/设置区以唯一一条分隔线切割；Cmd/Ctrl+1..5 快速切换；
 *   active tab 补 aria-current（修审计 #10）。
 * - keep-alive：查看页常驻挂载、hidden 切换（筛选/滚动状态保持）；
 *   去向页自阶段 2 起并入，经 active prop 感知可见性（隐藏时停自刷）。
 * - 状态数据只在壳层 useApi 一次，向下传给监控台（避免双份订阅/双份全量拉取）。
 * - 设置页 dirty 通过 onDirtyChange 上报；dirty 时切走 tab 不直接切换，
 *   而是给行内提示条（放弃修改并切换 / 留在设置）——不做路由拦截。
 * - 跨页深链 → 设置锚点（goSettings，阶段 5a 接通）：去向 outcome 出口 /
 *   监控台空态 / 历史零命中词，均带锚点定位 + 800ms 高亮。
 * - 侧栏底部迷你状态与托盘 tooltip 同口径（deriveTrayLabel / deriveRunState）。
 */
import { Fragment, useCallback, useEffect, useState } from 'react'
import { deriveTrayLabel } from '@shared/ipc'
import {
  IconHistory,
  IconPulse,
  IconRadar,
  IconReport,
  IconSearch,
  IconSliders
} from './components/icons'
import { useApi } from './hooks/useApi'
import { deriveRunState } from './lib/status'
import { Dashboard } from './pages/Dashboard'
import { Dispositions } from './pages/Dispositions'
import type { DispositionsDeepLink } from './pages/Dispositions'
import { History } from './pages/History'
import { Reports } from './pages/Reports'
import { Settings } from './pages/Settings'
import type { SettingsAnchor, SettingsAnchorLink } from './pages/Settings'

type Tab = 'dashboard' | 'dispositions' | 'history' | 'reports' | 'settings'

/** 分区定稿（REDESIGN §4.1）：view=true 属查看区，false 属设置区（前置分隔线） */
const TABS: ReadonlyArray<{
  key: Tab
  label: string
  icon: typeof IconPulse
  view: boolean
}> = [
  { key: 'dashboard', label: '监控台', icon: IconPulse, view: true },
  { key: 'dispositions', label: '去向', icon: IconSearch, view: true },
  { key: 'history', label: '历史命中', icon: IconHistory, view: true },
  { key: 'reports', label: '日报', icon: IconReport, view: true },
  { key: 'settings', label: '设置', icon: IconSliders, view: false }
]

export default function App() {
  const [tab, setTab] = useState<Tab>('dashboard')
  const [settingsDirty, setSettingsDirty] = useState(false)
  const [pendingTab, setPendingTab] = useState<Tab | null>(null)
  /** 去向页搜索深链（监控台「✗ 推送失败」一跳排障，dispositions.md §4.1）：
      seq 递增保证同值深链可重复触发 */
  const [dispDeepLink, setDispDeepLink] = useState<DispositionsDeepLink | null>(null)
  /** 历史命中页日期深链（日报「命中明细 →」，reports.md §7-5）：预填该日窗口；
      seq 递增保证同一天可重复触发（用户改过筛选后再点同日也生效） */
  const [histDate, setHistDate] = useState<{ date: string; seq: number } | null>(null)
  /**
   * 设置页锚点深链（阶段 5a 接通，settings.md §5.2）：seq 递增保证同值深链可
   * 重复触发（与 dispDeepLink 同模式）。出口映射：去向「去调整」锚点与
   * DispositionSettingsAnchor 对齐；监控台空态缺省落组①；历史零命中词落关键词卡
   */
  const [settingsAnchor, setSettingsAnchor] = useState<SettingsAnchorLink | null>(null)
  const api = useApi()
  const { status } = api

  const handleDirtyChange = useCallback((dirty: boolean) => {
    setSettingsDirty(dirty)
  }, [])

  /** 切设置页并定位到锚点（进入后滚到目标卡 + 800ms 高亮） */
  function goSettings(anchor: SettingsAnchor): void {
    setSettingsAnchor((prev) => ({ id: anchor, seq: (prev?.seq ?? 0) + 1 }))
    switchTab('settings')
  }

  /** 命中行「✗ 推送失败」→ 去向页预填该帖标题搜索（每渲染新建，switchTab 读最新
      tab/dirty 态；与 onGoSettings 同模式，不做 useCallback 捕获旧闭包） */
  function handlePushErrorClick(title: string): void {
    setDispDeepLink((prev) => ({ text: title, seq: (prev?.seq ?? 0) + 1 }))
    switchTab('dispositions')
  }

  /** 日报「命中明细 →」：切历史命中页并预填该日日期筛选（jumpToHistory 深链） */
  function handleJumpToHistory(date: string): void {
    setHistDate((prev) => ({ date, seq: (prev?.seq ?? 0) + 1 }))
    switchTab('history')
  }

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

  // Cmd/Ctrl+1..5 切分区（IME 组合期不触发；Alt 组合留给系统）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.isComposing || e.altKey || !(e.metaKey || e.ctrlKey)) return
      const item = TABS[Number(e.key) - 1]
      if (item == null) return
      e.preventDefault()
      switchTab(item.key)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          {/* R12 品牌图标砖：IconRadar 20px 单色（currentColor 由 .brand-icon 给 --rail-bar，
              砖底 = rail wash 档） */}
          <span className="brand-icon">
            <IconRadar size={20} />
          </span>
          <span className="brand-text">
            <span className="brand-name">ForumWatch</span>
            <span className="brand-sub">论坛监控</span>
          </span>
        </div>
        <nav className="nav" aria-label="主分区">
          {TABS.map((t) => (
            <Fragment key={t.key}>
              {!t.view && <div className="nav-sep" role="separator" />}
              <button
                type="button"
                className={`nav-btn${tab === t.key ? ' active' : ''}`}
                aria-current={tab === t.key ? 'page' : undefined}
                onClick={() => switchTab(t.key)}
              >
                <t.icon size={16} />
                {t.label}
                {t.key === 'settings' && settingsDirty && tab !== 'settings' && (
                  <span className="dirty-dot" title="有未保存的修改" />
                )}
              </button>
            </Fragment>
          ))}
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

        {/* keep-alive：hidden 切换保持各页筛选/滚动/表单状态（REDESIGN §5.1）。
            onGoSettings：监控台「还没有命中」空态的「去设置监控内容」出口
            （缺省映射：落组①「监控内容」锚点） */}
        <section className="page-host" hidden={tab !== 'dashboard'}>
          <Dashboard
            {...api}
            active={tab === 'dashboard'}
            onGoSettings={() => goSettings('grp-monitor')}
            onPushErrorClick={handlePushErrorClick}
          />
        </section>
        {/* 去向页（阶段 2 并入 keep-alive）：active 下发可见性——隐藏时停自刷/动画，
            恢复活跃立即刷一次；deepLink 为监控台「✗ 推送失败」的搜索深链；
            onGoAnchor 的锚点值与 DispositionSettingsAnchor 对齐，直达对应卡 */}
        <section className="page-host" hidden={tab !== 'dispositions'}>
          <Dispositions
            active={tab === 'dispositions'}
            deepLink={dispDeepLink}
            running={status.desired === 'running'}
            onGoDashboard={() => switchTab('dashboard')}
            onGoAnchor={(anchor) => goSettings(anchor)}
          />
        </section>
        {/* 历史命中（阶段 3 三区骨架）：onGoSettings 为零命中关键词深链
            （流 4：落「监控内容 → 关键词」卡锚点 + 800ms 高亮）；
            initialDate 为日报「命中明细 →」的单日窗口预填深链 */}
        <section className="page-host" hidden={tab !== 'history'}>
          <History
            active={tab === 'history'}
            onGoSettings={() => goSettings('keywords')}
            initialDate={histDate}
          />
        </section>
        <section className="page-host" hidden={tab !== 'reports'}>
          <Reports onGoHistory={handleJumpToHistory} />
        </section>
        <section className="page-host" hidden={tab !== 'settings'}>
          <Settings
            onDirtyChange={handleDirtyChange}
            active={tab === 'settings'}
            initialAnchor={settingsAnchor}
          />
        </section>
      </main>
    </div>
  )
}
