/**
 * 应用外壳（Watchtower 步骤 H 应用外壳重构，REDESIGN §4/§5.1 + 概念稿 titlebar/
 * sidebar 段）：Titlebar（46px，darwin 红绿灯留位）在上，sidebar+content 行结构
 * 包进 .shell 行容器；ToastHost 与 HitDetailDrawer（overlays.css 定层）挂渲染树末尾。
 * - 侧栏分组定稿（概念 .ngl 分组标签）：监控组 = 监控台 → 历史命中 → 去向 → 日报
 *   （附件顺序在前、日报追加组尾），系统组 = 设置（组前保留唯一 nav-sep 分隔线）；
 *   Cmd/Ctrl+1..5 按数组序寻址（useEffect 数字键逻辑零改动，顺序随数组自动更新）；
 *   active tab 补 aria-current（修审计 #10）。
 * - keep-alive：查看页常驻挂载、hidden 切换（筛选/滚动状态保持）；
 *   去向页自阶段 2 起并入，经 active prop 感知可见性（隐藏时停自刷）。
 * - 状态数据只在壳层 useApi 一次，向下传给监控台（避免双份订阅/双份全量拉取）。
 * - 设置页 dirty 通过 onDirtyChange 上报；dirty 时切走 tab 不直接切换，
 *   而是给行内提示条（放弃修改并切换 / 留在设置）——不做路由拦截。
 * - 跨页深链 → 设置锚点（goSettings，阶段 5a 接通）：去向 outcome 出口 /
 *   监控台空态 / 历史零命中词，均带锚点定位 + 800ms 高亮。
 * - 侧栏 footer 多行：运行状态行（deriveRunState / deriveTrayLabel，与托盘
 *     tooltip 同口径）+ 推送通道就绪行（挂载时一次性 getConfig，isChannelReadyUi
 *     = enabled × 凭据齐备，与设置页同判定——配置面就绪而非连接探测，不显示假
 *     「已连接」）+ 遥控命令行（bot-commands.ts 实际支持集）+ 版本行
 *     （getUpdateStatus().current，AboutCard 同源 IPC）。
 */
import { Fragment, useCallback, useEffect, useState } from 'react'
import { deriveTrayLabel } from '@shared/ipc'
import type { ChannelType } from '@shared/types'
import { isChannelReadyUi } from './components/ChannelsCard'
import { HitDetailDrawer } from './components/HitDetailDrawer'
import {
  IconHistory,
  IconPulse,
  IconRadar,
  IconReport,
  IconSearch,
  IconSliders
} from './components/icons'
import { Titlebar } from './components/Titlebar'
import { ToastHost } from './components/ToastHost'
import { useApi } from './hooks/useApi'
import { deriveRunState } from './lib/status'
import { getResolvedTheme, onThemeChange } from './lib/theme'
import type { ResolvedTheme } from './lib/theme'
import { Dashboard } from './pages/Dashboard'
import { Dispositions } from './pages/Dispositions'
import type { DispositionsDeepLink } from './pages/Dispositions'
import { History } from './pages/History'
import { Reports } from './pages/Reports'
import { Settings } from './pages/Settings'
import type { SettingsAnchor, SettingsAnchorLink } from './pages/Settings'

type Tab = 'dashboard' | 'dispositions' | 'history' | 'reports' | 'settings'

/** 侧栏分组（步骤 H，概念 .ngl）：monitor=监控组，system=系统组（前置分隔线） */
type NavGroup = 'monitor' | 'system'

/** 分组标签文案（概念稿 sidebar :282/:286：「监控」/「系统」） */
const NAV_GROUP_LABELS: Record<NavGroup, string> = {
  monitor: '监控',
  system: '系统'
}

/** 分区定稿（步骤 H）：数组序即 Cmd/Ctrl+1..5 寻址序（数字键 effect 按
    TABS[i] 取项，零改动随序自动更新） */
const TABS: ReadonlyArray<{
  key: Tab
  label: string
  icon: typeof IconPulse
  group: NavGroup
}> = [
  { key: 'dashboard', label: '监控台', icon: IconPulse, group: 'monitor' },
  { key: 'history', label: '历史命中', icon: IconHistory, group: 'monitor' },
  { key: 'dispositions', label: '去向', icon: IconSearch, group: 'monitor' },
  { key: 'reports', label: '日报', icon: IconReport, group: 'monitor' },
  { key: 'settings', label: '设置', icon: IconSliders, group: 'system' }
]

/** 推送通道类型 → footer 就绪行文案（任务口径：无 telegram 时按类型显示） */
const CHANNEL_TYPE_LABELS: Record<ChannelType, string> = {
  telegram: 'Telegram Bot',
  bark: 'Bark',
  ntfy: 'ntfy',
  webhook: 'Webhook'
}

/** 生效主题 → 界面名（footer 版本行：深色=瞭望塔 / 浅色=晨报；system 态按实际生效档取） */
const UI_NAME_BY_THEME: Record<ResolvedTheme, string> = {
  dark: '瞭望塔',
  light: '晨报'
}

/** footer 推送通道行：ready=false 统一 faint 态（未配置 / 未知） */
interface PushChannelLine {
  text: string
  ready: boolean
}

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
  /** footer 推送通道就绪行（挂载时一次性取数；null=未回，行不渲染） */
  const [pushLine, setPushLine] = useState<PushChannelLine | null>(null)
  /** footer 版本行的当前应用版本（getUpdateStatus().current；null=未回显 '…'） */
  const [version, setVersion] = useState<string | null>(null)
  /** footer 版本行的界面名（跟随生效主题：深色=瞭望塔 / 浅色=晨报） */
  const [uiName, setUiName] = useState(() => UI_NAME_BY_THEME[getResolvedTheme()])
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

  // footer 推送通道就绪行：挂载时一次性 getConfig（无订阅面，cancelled 防卸载后
  // setState）。就绪判定复用 ChannelsCard 的 isChannelReadyUi（main 侧
  // isChannelReady 的渲染端复刻：enabled × 凭据齐备）——配置面就绪≠已连接，
  // 无连接探测 IPC，不显示假的「已连接」
  useEffect(() => {
    let cancelled = false
    void window.api
      .getConfig()
      .then((cfg) => {
        if (cancelled) return
        const ready = cfg.channels.filter(isChannelReadyUi)
        const telegram = ready.find((c) => c.type === 'telegram')
        if (telegram !== undefined) {
          setPushLine({ text: 'Telegram Bot 已就绪', ready: true })
        } else if (ready.length > 0) {
          setPushLine({ text: `${CHANNEL_TYPE_LABELS[ready[0].type]} 已就绪`, ready: true })
        } else {
          setPushLine({ text: '推送通道未配置', ready: false })
        }
      })
      .catch(() => {
        // 取数失败（web-shim 网络层异常等）：如实标「未知」，不冒充未配置
        if (!cancelled) setPushLine({ text: '推送通道状态未知', ready: false })
      })
    return () => {
      cancelled = true
    }
  }, [])

  // footer 版本行：AboutCard 同源 IPC（getUpdateStatus 永不 reject，catch 纯防御）
  useEffect(() => {
    let cancelled = false
    void window.api
      .getUpdateStatus()
      .then((s) => {
        if (!cancelled) setVersion(s.current)
      })
      .catch(() => {
        /* 保持 '…' 占位，不另设错误态 */
      })
    return () => {
      cancelled = true
    }
  }, [])

  // footer 版本行界面名：订阅主题变化（onThemeChange 给 (mode, resolved)；system 态
  // 随系统翻转时也通知，resolved 即实际生效档——名字随生效档、不随存储意图）
  useEffect(() => onThemeChange((_mode, resolved) => setUiName(UI_NAME_BY_THEME[resolved])), [])

  return (
    <div className="app">
      <Titlebar status={status} />
      <div className="shell">
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
            {TABS.map((t, i) => {
              const groupStart = i === 0 || TABS[i - 1].group !== t.group
              return (
                <Fragment key={t.key}>
                  {/* 查看区 / 设置区的唯一分隔线：保留在系统组前 */}
                  {groupStart && t.group === 'system' && <div className="nav-sep" role="separator" />}
                  {groupStart && (
                    <div className="nav-group-label" aria-hidden="true">
                      {NAV_GROUP_LABELS[t.group]}
                    </div>
                  )}
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
              )
            })}
          </nav>
          <div className="sidebar-foot">
            {/* ① 运行状态行（与托盘 tooltip 同口径；tone-* 点色见 shell.css） */}
            <div className={`sidebar-foot-run tone-${runState.key}`} title={deriveTrayLabel(status)}>
              <span className="dot" />
              <span className="sidebar-foot-label">{runState.label}</span>
            </div>
            {/* ② 推送通道就绪行（配置面就绪，未回数前不渲染该行） */}
            {pushLine !== null && (
              <div
                className={`sidebar-foot-ch${pushLine.ready ? ' tone-ok' : ''}`}
                title="就绪 = 已启用且凭据齐备（与设置页「通知推送」同判定）；无就绪通道不推送"
              >
                <span className="dot" />
                <span className="sidebar-foot-label">{pushLine.text}</span>
              </div>
            )}
            {/* ③ 遥控命令行（bot-commands.ts 实际支持集；/help 亦有，见远程控制卡） */}
            <div
              className="sidebar-foot-cmds cmds"
              title="Telegram Bot 远程遥控指令（发 /help 可见全部）"
            >
              <span className="cmd">/status</span>
              <span className="cmd">/pause</span>
              <span className="cmd">/resume</span>
              <span className="cmd">/poll</span>
            </div>
            {/* ④ 版本行（AboutCard 同源）+ 界面名（随生效主题） */}
            <div className="sidebar-foot-version">
              <span className="num">v{version ?? '…'}</span> · 界面 · {uiName}
            </div>
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
      {/* 全局浮层宿主（overlays.css 定层：drawer 40 / toast 60；fixed 定位，
          挂载点不影响布局） */}
      <ToastHost />
      <HitDetailDrawer />
    </div>
  )
}
