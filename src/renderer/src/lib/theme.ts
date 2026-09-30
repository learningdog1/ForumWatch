/**
 * 主题切换机制（Watchtower SPEC §6；概念稿 §4 整体迁移）。
 *
 * 模块契约：
 * - initTheme()          main.tsx 首帧前调用一次（installWebApiIfAbsent 之后、
 *                        createRoot().render 之前）；不回写 localStorage。
 * - getThemeMode()       存储意图（'dark' | 'light' | 'system'）。
 * - getResolvedTheme()   实际生效档（'dark' | 'light' 两值）。
 * - setThemeMode(mode)   应用 + localStorage 持久化 + 通知订阅者。
 * - onThemeChange(cb)    订阅（mode, resolved）；返回退订函数。
 *
 * 行为细则：
 * 1. 单一真源：document.documentElement 的 data-theme 属性，值只有 dark/light。
 *    深色是 theme.css :root 基线（无属性即正确），浅色是
 *    :root[data-theme="light"] 覆盖——属性仍显式写 'dark'，保持真源可读。
 * 2. color-scheme 双保险：JS 写 documentElement.style.colorScheme；theme.css
 *    两主题块也各自声明（web 模式 JS 未跑时首帧也正确）。原生控件（单选/
 *    滚动条/日期/select）自动跟随。
 * 3. 存储：localStorage 键 'fw-theme'（renderer 私有 UI 偏好，不进 AppConfig/
 *    dirty 体系），默认 'dark'。所有读写包 try/catch——隐私模式/存储禁用
 *    静默回退默认深色，不崩溃。
 * 4. system 解析：window.matchMedia('(prefers-color-scheme: light)')
 *    .matches ? 'light' : 'dark'；mq change 监听仅在当前生效意图为 'system'
 *    时挂载（dark/light 态不随系统摆动）。用 addEventListener（Electron 44 /
 *    现代 Chromium 足够，不双写旧 API）。
 * 5. URL 覆盖：?theme=dark|light|system 一次性优先于 localStorage（预览/验收
 *    走查用）；非法值忽略；不持久化（刷新后回到存储值）。
 * 6. 双环境约束：只用 localStorage/matchMedia/document 标准Web API，禁 import
 *    Electron/Node 模块（web 无头模式直跑同一产物）；模块顶层无副作用。
 */
export type ThemeMode = 'dark' | 'light' | 'system'
export type ResolvedTheme = 'dark' | 'light'

export type ThemeChangeListener = (mode: ThemeMode, resolved: ResolvedTheme) => void

const STORAGE_KEY = 'fw-theme'

const listeners = new Set<ThemeChangeListener>()

/** 当前生效意图（initTheme 前为默认深色——此时 DOM 也尚未渲染） */
let currentMode: ThemeMode = 'dark'
/** system mq 监听是否在挂载中（只在 system 态挂） */
let mqAttached = false

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'dark' || value === 'light' || value === 'system'
}

/** 读存储意图；异常/非法值回退默认深色 */
function readStoredMode(): ThemeMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return isThemeMode(value) ? value : 'dark'
  } catch {
    return 'dark'
  }
}

/** 读 ?theme= 一次性覆盖；非法/缺失返回 null（不持久化） */
function readUrlOverride(): ThemeMode | null {
  try {
    const value = new URLSearchParams(window.location.search).get('theme')
    return isThemeMode(value) ? value : null
  } catch {
    return null
  }
}

/** 系统偏好 → 实际档；matchMedia 不可用时按深色 */
function resolveSystemTheme(): ResolvedTheme {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

function resolveTheme(mode: ThemeMode): ResolvedTheme {
  return mode === 'system' ? resolveSystemTheme() : mode
}

function onSystemChange(): void {
  // 仅 system 态响应（监听器本身也只在 system 态挂载，双保险）
  if (currentMode === 'system') applyTheme('system')
}

/** system mq 监听随意图挂/摘：dark/light 态不随系统摆动 */
function syncSystemListener(mode: ThemeMode): void {
  const want = mode === 'system'
  if (want === mqAttached) return
  try {
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    if (want) {
      mq.addEventListener('change', onSystemChange)
    } else {
      mq.removeEventListener('change', onSystemChange)
    }
    mqAttached = want
  } catch {
    // matchMedia 不可用：system 态退化为解析时点值，不随系统实时翻转
  }
}

/** 应用意图到 DOM（单一真源 + colorScheme 双保险）并通知订阅者；不碰存储 */
function applyTheme(mode: ThemeMode): void {
  currentMode = mode
  const resolved = resolveTheme(mode)
  const root = document.documentElement
  root.setAttribute('data-theme', resolved)
  root.style.colorScheme = resolved
  syncSystemListener(mode)
  for (const notify of listeners) notify(mode, resolved)
}

/**
 * 首帧初始化：URL 覆盖一次性优先于 localStorage；不回写 localStorage
 * （?theme= 来源刷新即失效）。main.tsx 在 render 之前调用一次。
 */
export function initTheme(): void {
  applyTheme(readUrlOverride() ?? readStoredMode())
}

/** 存储意图（'dark' | 'light' | 'system'）；initTheme 前为默认 'dark' */
export function getThemeMode(): ThemeMode {
  return currentMode
}

/** 实际生效档（'dark' | 'light'） */
export function getResolvedTheme(): ResolvedTheme {
  return resolveTheme(currentMode)
}

/** 应用 + 持久化 + 通知订阅者；写存储失败（隐私模式）时本会话仍生效 */
export function setThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    // 存储禁用：静默降级为会话内生效
  }
  applyTheme(mode)
}

/** 订阅主题变化；返回退订函数（设置页「外观」行受控用） */
export function onThemeChange(cb: ThemeChangeListener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
