/**
 * 「运行节奏」卡（阶段 5a 新增，settings.md §7：现状「轮询」「每日总结」
 * 「行为(自启)」三张 1-2 控件小卡合并为一）：轮询间隔 + 生成与推送 +
 * 开机自启 3 个 Field。原「每日总结」卡的「补看历史」伪控件 Field 删除
 * （§3.6：说明伪装成表单行），其信息并入「生成与推送」hint 末句。
 * sanitize 前端提示（最低 15 秒）经由 intervalValid/intervalTooLow props
 * 由 Settings.tsx 下发（save 的同一判定，单源）。
 *
 * Watchtower 换装新增「外观」行（SPEC §5.4-9，即时生效不进 draft）。
 *
 * 步骤 M（设置重组，概念 general 屏段）并入两行：
 * - 「关窗行为」radios（closeBehavior，步骤 D 主进程已接线）：tray=最小化
 *   到托盘（默认，推荐）/ quit=退出应用。**进 draft/dirty/save 全链路**——
 *   与同卡 pollIntervalText 等字段同一模式（受控 props + 外层 patch）；
 * - 「Web 管理界面」只读状态行：浏览器模式（web-shim 安装标记 isWebMode()，
 *   与 Titlebar 同一判定）显示当前访问地址，桌面模式提示 Docker /
 *   无头部署可用——不做假开关（Web 管理不随桌面配置启停）。
 */
import { useEffect, useState } from 'react'
import type { AppConfig } from '@shared/types'
import { getThemeMode, onThemeChange, setThemeMode, type ThemeMode } from '../lib/theme'
import { isWebMode } from '../lib/web-shim'
import { Field } from './Field'

/** 外观三档（label 与概念稿设置屏「外观」行一致，SPEC §6） */
const APPEARANCE_OPTIONS: ReadonlyArray<{ value: ThemeMode; label: string }> = [
  { value: 'dark', label: '深色 · 瞭望塔' },
  { value: 'light', label: '浅色 · 晨报' },
  { value: 'system', label: '跟随系统' }
]

/** 关窗行为两档（AppConfig.closeBehavior；label 与概念稿「关窗行为」行一致） */
const CLOSE_BEHAVIOR_OPTIONS: ReadonlyArray<{
  value: AppConfig['closeBehavior']
  title: string
  desc?: string
}> = [
  {
    value: 'tray',
    title: '最小化到托盘',
    desc: '推荐 · 关窗不退出，后台继续监控'
  },
  { value: 'quit', title: '退出应用' }
]

/**
 * 浏览器模式下当前访问地址（location.protocol//location.host，如 http://127.0.0.1:8787）。
 * 桌面 vs 浏览器的判定见组件内 isWebMode()：web-shim 安装标记须渲染时惰性求值
 * （安装早于首帧、晚于本模块 import），不能像旧版 UA 法那样模块级缓存。
 */
const WEB_ORIGIN = `${location.protocol}//${location.host}`

/**
 * 「外观」行：受控 checked 由 onThemeChange 订阅驱动（system 态下系统切换时
 * radio 保持「跟随系统」、页面实时换装，§6-8）；radio name 与其它卡的单选组
 * 不冲突。纯 UI 偏好，不触碰 props/draft。
 */
function AppearanceField() {
  const [mode, setMode] = useState<ThemeMode>(() => getThemeMode())
  useEffect(() => onThemeChange((m) => setMode(m)), [])
  return (
    <Field label="外观" hint="选择立即生效并单独记住，不走下方保存栏，也不影响监控与推送配置。">
      <div className="radios radios-row" role="radiogroup" aria-label="外观">
        {APPEARANCE_OPTIONS.map((o) => (
          <label className="radio" key={o.value}>
            <input
              type="radio"
              name="settings-appearance"
              checked={mode === o.value}
              onChange={() => setThemeMode(o.value)}
            />
            <span className="radio-text">
              <span className="radio-title">{o.label}</span>
            </span>
          </label>
        ))}
      </div>
    </Field>
  )
}

export function RunPaceCard(props: {
  pollIntervalText: string
  /** 秒数可解析 / 是否低于 sanitize 下限（15s）——提示态由外层判定 */
  intervalValid: boolean
  intervalTooLow: boolean
  dailyEnabled: boolean
  dailyTime: string
  launchAtLogin: boolean
  /** 关窗行为（步骤 D：'tray' 最小化到托盘（默认）| 'quit' 退出应用） */
  closeBehavior: AppConfig['closeBehavior']
  onIntervalChange: (v: string) => void
  onDailyToggle: () => void
  onDailyTimeChange: (v: string) => void
  onLaunchToggle: () => void
  onCloseBehaviorChange: (v: AppConfig['closeBehavior']) => void
}) {
  // 浏览器模式判定渲染时现读：嵌入式浏览器（宿主 Electron）的 UA 含
  // 'Electron/'，旧 UA 法会误判成桌面；标记法见 lib/web-shim.ts。
  const webMode = isWebMode()

  return (
    <section className="card smon">
      <div className="card-head">
        <span className="card-title">运行节奏</span>
      </div>
      <Field
        label="轮询间隔"
        htmlFor="poll-interval"
        hint={
          !props.intervalValid ? (
            <span className="err">请输入有效的秒数</span>
          ) : props.intervalTooLow ? (
            <span className="err">最低 15 秒，过低易触发反爬（保存时会被钳到 15 秒）</span>
          ) : (
            <span>每轮抓取 NodeSeek 首页的间隔。</span>
          )
        }
      >
        <div className="input-row">
          <input
            id="poll-interval"
            className={`input num${props.intervalValid && !props.intervalTooLow ? '' : ' invalid'}`}
            aria-invalid={!props.intervalValid || props.intervalTooLow}
            type="number"
            min={15}
            step={1}
            value={props.pollIntervalText}
            onChange={(e) => props.onIntervalChange(e.target.value)}
          />
          <span className="feedback muted">秒</span>
          <span className="quick">
            {['30', '60', '120'].map((v) => (
              <button
                type="button"
                key={v}
                className={`btn${props.pollIntervalText === v ? ' active' : ''}`}
                onClick={() => props.onIntervalChange(v)}
              >
                {v}s
              </button>
            ))}
          </span>
        </div>
      </Field>
      <Field
        label="生成与推送"
        htmlFor="daily-time"
        hint="每天此时用 AI 总结当天命中并推送 Telegram；错过的时间点不回溯补做，暂停监控时不生成。已生成的日报在「日报」页随时可查，也可在那页手动生成。"
      >
        <div className="switch-row">
          <button
            type="button"
            role="switch"
            aria-checked={props.dailyEnabled}
            className="switch"
            aria-label="每日总结"
            onClick={props.onDailyToggle}
          />
          <input
            id="daily-time"
            className={`input input-time num${props.dailyEnabled ? '' : ' input-disabled'}`}
            type="time"
            value={props.dailyTime}
            disabled={!props.dailyEnabled}
            onChange={(e) => props.onDailyTimeChange(e.target.value)}
            aria-label="每日总结时间"
          />
          <span className="feedback muted">{props.dailyEnabled ? '开启' : '关闭'}</span>
        </div>
      </Field>
      <Field
        label="开机自启"
        hint="mac 上未签名应用可能被系统拒绝自启（可在 系统设置 → 登录项 中检查）。"
      >
        <div className="switch-row">
          <button
            type="button"
            role="switch"
            aria-checked={props.launchAtLogin}
            className="switch"
            aria-label="开机自启"
            onClick={props.onLaunchToggle}
          />
          <span className="feedback muted">{props.launchAtLogin ? '开启' : '关闭'}</span>
        </div>
      </Field>
      {/* 关窗行为（步骤 M，概念 general 屏段）：受控 radios，draft 全链路同卡其余字段 */}
      <Field label="关窗行为" hint="关闭窗口时的动作，保存后生效。">
        <div className="radios" role="radiogroup" aria-label="关窗行为">
          {CLOSE_BEHAVIOR_OPTIONS.map((o) => (
            <label className="radio" key={o.value}>
              <input
                type="radio"
                name="settings-close-behavior"
                checked={props.closeBehavior === o.value}
                onChange={() => props.onCloseBehaviorChange(o.value)}
              />
              <span className="radio-text">
                <span className="radio-title">{o.title}</span>
                {o.desc != null && <span className="radio-desc">{o.desc}</span>}
              </span>
            </label>
          ))}
        </div>
      </Field>
      {/* Web 管理界面（只读状态行）：浏览器模式显示实际地址，桌面模式提示
          Docker / 无头部署——不做假开关（无随桌面配置启停的语义） */}
      <Field label="Web 管理界面" hint="同一界面的浏览器访问形态，与桌面版功能一致，供 Docker / 无头部署使用；只读状态，无需保存。">
        {webMode ? (
          <span className="web-origin num">{WEB_ORIGIN}</span>
        ) : (
          <span className="feedback muted">Docker / 无头部署可用，桌面模式未启用</span>
        )}
      </Field>
      {/* 外观（Watchtower §5.4-9）：即时生效、独立持久化，不进 dirty/savebar */}
      <AppearanceField />
    </section>
  )
}
