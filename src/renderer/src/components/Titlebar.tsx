/**
 * 自绘标题栏（Watchtower 步骤 H；概念稿 titlebar 段 concept.html :47-61 + :265-274）。
 * 主进程窗口已切 darwin `titleBarStyle:'hiddenInset'`（界面重构步骤 D）：红绿灯原生
 * 保留、浮在内容上——本组件只画 46px 宿主条，给红绿灯**留位不画假灯**（按钮由系统
 * 渲染），中部名称/副题，右侧运行状态回执。
 *
 * 环境判定：桌面 vs 浏览器读 web-shim 的安装标记（isWebMode()/webPort()）——
 * 不再看 navigator.userAgent：嵌入式浏览器（宿主是 Electron 应用）的 UA 会继承
 * 宿主的 'Electron/' 令牌，按 UA 判会把浏览器误判成桌面（Web 管理 chip 消失）。
 * 标记在 main.tsx render 前安装，但组件模块的 import 早于安装执行，判定必须
 * 渲染时惰性求值、不能缓存模块级值：
 * - 浏览器模式：无占位 + 渲染「Web 管理 :端口」chip（location.port 实际值；桌面
 *   进程不跑 web server，不显示假 chip）；
 * - darwin 桌面：左端 70px 红绿灯占位——判定保留 UA 法（'Electron/' +
 *   'Macintosh'）且仅非 web 模式下生效（浏览器里 UA 含 Electron 也不画）；
 * - 非 darwin 桌面：无占位，名称直接起头。
 * -webkit-app-region 在浏览器天然无效，安全。
 *
 * 运行状态 pill（.pill/.pill-dot，primitives 附件层）：点档与 lib/status.ts
 * deriveRunState 的 key→色映射对齐（侧栏 footer tone-* 同一口径）——running=ok 脉冲
 * （.live）/ paused=faint 熄灭（.off）/ backoff=warn / challenged=err（后两档点色在
 * shell.css .titlebar 作用域补定义，不动 primitives）。整条 drag，右侧交互件容器
 * no-drag（样式均在 shell.css）。
 */
import { deriveTrayLabel } from '@shared/ipc'
import type { EngineStatus } from '@shared/types'
import { deriveRunState, type RunStateKey } from '../lib/status'
import { isWebMode, webPort } from '../lib/web-shim'

/** runState key → pill 点档（shell.css 侧栏 tone-* 同映射：paused 熄灭 / backoff warn / challenged err） */
const PILL_DOT: Record<RunStateKey, string> = {
  running: 'live',
  paused: 'off',
  backoff: 'warn',
  challenged: 'err'
}

/**
 * pill 文案：running/paused 给带语境短句；challenged/backoff 复用 deriveTrayLabel 的
 * 短语部分（恒 'ForumWatch · xxx' 前缀——pill 紧邻名称，剥前缀不重复）。
 * 来源数 = status.sources.length：engine 装配方按 config.sources[].enabled 过滤后才
 * 注册，快照里的 sources 即**启用中**的来源（engine.ts finishRound 只聚合 activeIds）。
 */
function pillText(status: EngineStatus, key: RunStateKey, sourceCount: number): string {
  if (key === 'running') return `监控中 · ${sourceCount} 个来源`
  if (key === 'paused') return '已暂停 · 轮询已停止'
  return deriveTrayLabel(status).replace('ForumWatch · ', '')
}

export function Titlebar(props: { status: EngineStatus }) {
  const { status } = props
  const runState = deriveRunState(status)
  const trayLabel = deriveTrayLabel(status)
  // 环境判定渲染时现读（标记安装早于首帧但晚于本模块 import，模块级缓存必错）。
  // darwin 红绿灯占位保留 UA 法并叠加 !isWebMode() 守卫：嵌入式浏览器
  // （宿主 Electron，UA 含 'Electron/'）不再误画 70px 占位。
  const webMode = isWebMode()
  const port = webPort()
  const darwinDesktop =
    !webMode && navigator.userAgent.includes('Electron/') && navigator.userAgent.includes('Macintosh')

  return (
    <header className="titlebar">
      {/* darwin 红绿灯占位：原生按钮浮在本条上，只留空间（aria-hidden 纯装饰占位） */}
      {darwinDesktop && <div className="t-lights" aria-hidden="true" />}
      <span className="t-name">ForumWatch</span>
      <span className="t-sub">论坛监控</span>
      <div className="t-right">
        {webMode && (
          <span className="t-web-chip" title="浏览器管理模式（Docker / Web 部署，web-shim）">
            Web 管理{port !== null ? ` :${port}` : ''}
          </span>
        )}
        <span className="pill" title={trayLabel}>
          <i className={`pill-dot ${PILL_DOT[runState.key]}`} />
          <span>{pillText(status, runState.key, status.sources.length)}</span>
        </span>
      </div>
    </header>
  )
}
