/**
 * 来源注册表纯函数单测（D3 + v3）：openExternal 白名单派生（固定域查表 +
 * rss url host 派生）+ host 匹配规则。
 */
import { describe, expect, it } from 'vitest'
import { allowedExternalDomains, isHostAllowed, SOURCE_DOMAINS } from './registry'
import { DEFAULT_APP_CONFIG, type SourceConfig } from '../../../shared/types'

function sources(...list: SourceConfig[]): { sources: SourceConfig[] } {
  return { sources: list }
}

describe('SOURCE_DOMAINS', () => {
  it('每个固定域来源类型都有非空域列表（rss 无固定域，不在此表）', () => {
    expect(SOURCE_DOMAINS.nodeseek).toEqual(['nodeseek.com'])
    expect(SOURCE_DOMAINS.v2ex).toEqual(['v2ex.com'])
  })
})

describe('allowedExternalDomains（按配置派生）', () => {
  it('默认配置（nodeseek enabled）→ nodeseek.com', () => {
    expect(allowedExternalDomains(DEFAULT_APP_CONFIG)).toEqual(['nodeseek.com'])
  })

  it('来源 disabled → 该类型域不放行（空列表）', () => {
    const cfg = sources({ id: 'nodeseek', type: 'nodeseek', enabled: false })
    expect(allowedExternalDomains(cfg)).toEqual([])
  })

  it('同类型多个 source：只取 enabled 的，域去重', () => {
    const cfg = sources(
      { id: 'nodeseek', type: 'nodeseek', enabled: true },
      { id: 'nodeseek-mirror', type: 'nodeseek', enabled: true },
      { id: 'nodeseek-off', type: 'nodeseek', enabled: false }
    )
    expect(allowedExternalDomains(cfg)).toEqual(['nodeseek.com'])
  })

  it('v2ex：enabled → v2ex.com', () => {
    const cfg = sources(
      { id: 'nodeseek', type: 'nodeseek', enabled: true },
      { id: 'v2ex', type: 'v2ex', enabled: true }
    )
    expect(allowedExternalDomains(cfg).sort()).toEqual(['nodeseek.com', 'v2ex.com'])
  })

  it('rss：白名单从 source.url 的 host 派生（子域 host 也按裸域入表）', () => {
    const cfg = sources(
      { id: 'hn', type: 'rss', enabled: true, url: 'https://hnrss.org/frontpage' },
      { id: 'blog', type: 'rss', enabled: true, url: 'http://blog.example.com/feed.xml' }
    )
    const allowed = allowedExternalDomains(cfg)
    expect(allowed).toContain('hnrss.org')
    expect(allowed).toContain('blog.example.com') // 子域 host 原样入表（isHostAllowed 做裸域/子域匹配）
    expect(allowed).toHaveLength(2)
  })

  it('rss 与固定域类型混合：查表 + url 派生合并去重', () => {
    const cfg = sources(
      { id: 'nodeseek', type: 'nodeseek', enabled: true },
      { id: 'v2ex', type: 'v2ex', enabled: true },
      { id: 'ns-feed', type: 'rss', enabled: true, url: 'https://nodeseek.com/rss' } // 与查表域重复
    )
    expect(allowedExternalDomains(cfg).sort()).toEqual(['nodeseek.com', 'v2ex.com'])
  })

  it('rss url 非法（sanitize 本应已拦）：解析失败跳过该项，不影响其他来源', () => {
    const cfg = sources(
      { id: 'bad', type: 'rss', enabled: true, url: 'not a url' },
      { id: 'v2ex', type: 'v2ex', enabled: true }
    )
    expect(allowedExternalDomains(cfg)).toEqual(['v2ex.com'])
  })

  it('enabled=false 的 rss 不进白名单', () => {
    const cfg = sources({ id: 'hn', type: 'rss', enabled: false, url: 'https://hnrss.org/frontpage' })
    expect(allowedExternalDomains(cfg)).toEqual([])
  })

  it('rss host 大小写规范化：URL 解析降为小写入表', () => {
    const cfg = sources({ id: 'hn', type: 'rss', enabled: true, url: 'https://HnRSS.ORG/frontpage' })
    expect(allowedExternalDomains(cfg)).toEqual(['hnrss.org'])
  })
})

describe('isHostAllowed（裸域或子域）', () => {
  const allowed = ['nodeseek.com']

  it('裸域与任意深度子域命中（大小写不敏感）', () => {
    expect(isHostAllowed('nodeseek.com', allowed)).toBe(true)
    expect(isHostAllowed('www.nodeseek.com', allowed)).toBe(true)
    expect(isHostAllowed('a.b.nodeseek.com', allowed)).toBe(true)
    expect(isHostAllowed('WWW.NodeSeek.COM', allowed)).toBe(true)
  })

  it('后缀伪造与无关域不命中', () => {
    expect(isHostAllowed('notnodeseek.com', allowed)).toBe(false)
    expect(isHostAllowed('nodeseek.com.evil.io', allowed)).toBe(false)
    expect(isHostAllowed('nodeseek.community', allowed)).toBe(false)
    expect(isHostAllowed('example.com', allowed)).toBe(false)
  })

  it('空允许列表恒拒绝', () => {
    expect(isHostAllowed('nodeseek.com', [])).toBe(false)
  })

  it('v2ex 后缀伪造不命中（notv2ex.com / v2ex.com.evil.io）', () => {
    const v2exAllowed = ['v2ex.com']
    expect(isHostAllowed('v2ex.com', v2exAllowed)).toBe(true)
    expect(isHostAllowed('www.v2ex.com', v2exAllowed)).toBe(true)
    expect(isHostAllowed('notv2ex.com', v2exAllowed)).toBe(false)
    expect(isHostAllowed('v2ex.com.evil.io', v2exAllowed)).toBe(false)
    expect(isHostAllowed('v2ex.company', v2exAllowed)).toBe(false)
  })
})
