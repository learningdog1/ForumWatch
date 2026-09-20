/**
 * 「网络（代理）」卡（阶段 5a 自 Settings.tsx inline 段拆出，settings.md §7）：
 * 代理地址 + 作用域 2 个 Field 原样独立成卡（语义独立于运行节奏：网络层，
 * 大陆用户高频配置，§9）。前缀合法性的 sanitize 前端提示（schemeBad prop）
 * 由 Settings.tsx 下发（save 的同一判定，单源）。
 */
import { Field } from './Field'
import type { ProxyScope } from '@shared/types'

export function ProxyCard(props: {
  proxyUrl: string
  proxyScope: ProxyScope
  /** 代理地址前缀非法（保存时会被清空）——提示态由外层判定 */
  schemeBad: boolean
  onUrlChange: (v: string) => void
  onScopeChange: (v: ProxyScope) => void
}) {
  return (
    <section className="card snot">
      <div className="card-head">
        <span className="card-title">网络（代理）</span>
      </div>
      <Field
        label="代理地址"
        htmlFor="proxy-url"
        hint={
          props.schemeBad ? (
            <span className="err">
              需以 http://、https://、socks5:// 或 socks5h:// 开头；当前值保存时会被清空，请修正
            </span>
          ) : (
            <span>留空表示直连。AI 请求在「全部走代理」时走代理，否则直连。</span>
          )
        }
      >
        <input
          id="proxy-url"
          className={`input mono${props.schemeBad ? ' invalid' : ''}`}
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder="socks5://user:pass@host:1080 或 http://host:port"
          value={props.proxyUrl}
          onChange={(e) => props.onUrlChange(e.target.value)}
        />
      </Field>
      <Field
        label="作用域"
        htmlFor="proxy-scope-telegram-only"
        hint="NodeSeek 通常可直连，Telegram 在大陆需要代理。"
      >
        <div className="radios radios-card">
          <label className="radio">
            <input
              id="proxy-scope-telegram-only"
              type="radio"
              name="proxy-scope"
              checked={props.proxyScope === 'telegram-only'}
              onChange={() => props.onScopeChange('telegram-only')}
            />
            <span className="radio-text">
              <span className="radio-title">仅 Telegram 走代理（默认）</span>
            </span>
          </label>
          <label className="radio">
            <input
              id="proxy-scope-all"
              type="radio"
              name="proxy-scope"
              checked={props.proxyScope === 'all'}
              onChange={() => props.onScopeChange('all')}
            />
            <span className="radio-text">
              <span className="radio-title">全部请求走代理（含 NodeSeek 抓取与 AI 请求）</span>
            </span>
          </label>
        </div>
      </Field>
    </section>
  )
}
