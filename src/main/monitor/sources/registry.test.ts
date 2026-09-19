/**
 * 来源注册表纯函数单测（D3）：openExternal 白名单派生 + host 匹配规则。
 */
import { describe, expect, it } from 'vitest'
import { allowedExternalDomains, isHostAllowed, SOURCE_DOMAINS } from './registry'
import { DEFAULT_APP_CONFIG, type SourceConfig } from '../../../shared/types'

function sources(...list: SourceConfig[]): { sources: SourceConfig[] } {
  return { sources: list }
}

describe('SOURCE_DOMAINS', () => {
  it('v2 每个来源类型都有非空域列表', () => {
    expect(SOURCE_DOMAINS.nodeseek).toEqual(['nodeseek.com'])
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
})
