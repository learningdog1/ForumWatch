/**
 * 来源预设常量表单测（R13 新增 LowEndTalk Offers 后锁定形状）：
 * vitest 为 node 环境（无 DOM，仓库先例见 ReportDoc.test.ts），这里测可独立
 * 导入的纯模块——预设项形状（分类白名单的三个优惠分类）、id 与全站预设互不
 * 冲突（presetAdded 两预设不互斥）、白名单值已是 trim 后的唯一形（sanitize 的
 * filter 列表清洗只做 trim/去空/去重——值本身满足则保存往返不改写；工程边界
 * 不允许 renderer 导入 main 的 sanitizeConfig，故以形状不变式锁定等价面）。
 */
import { describe, expect, it } from 'vitest'
import { presetAdded, SOURCE_PRESETS } from './presets'

describe('SOURCE_PRESETS（R13：LowEndTalk Offers 预设）', () => {
  it('LowEndTalk Offers：全站 feed + 三个优惠分类白名单，id 与全站预设不同', () => {
    const offers = SOURCE_PRESETS.find((p) => p.config.id === 'lowendtalk-offers')
    expect(offers).toBeDefined()
    expect(offers!.config.type).toBe('rss')
    expect(offers!.config).toMatchObject({
      url: 'https://lowendtalk.com/discussions/feed.rss',
      label: 'LowEndTalk Offers',
      enabled: true,
      filters: {
        includeCategories: ['Offers', 'Shared Hosting Offers', 'Giveaways & Freebies']
      }
    })
    // 与全站预设 id 不同（两者可并存；双推兜底见 engine.test 的双源同题用例）
    const full = SOURCE_PRESETS.find((p) => p.config.id === 'lowendtalk')
    expect(full).toBeDefined()
    expect(full!.config.id).not.toBe(offers!.config.id)
  })

  it('presetAdded 按 id 匹配：添加 Offers 不置灰全站预设（有意行为，二选一由用户决定）', () => {
    const offers = SOURCE_PRESETS.find((p) => p.config.id === 'lowendtalk-offers')!
    const full = SOURCE_PRESETS.find((p) => p.config.id === 'lowendtalk')!
    const sources = [{ ...offers.config }]
    expect(presetAdded(offers, sources)).toBe(true)
    expect(presetAdded(full, sources)).toBe(false)
  })

  it('Offers 白名单值已是 trim 后唯一形（sanitize 往返不改写的前提）', () => {
    const offers = SOURCE_PRESETS.find((p) => p.config.id === 'lowendtalk-offers')!
    if (offers.config.type !== 'rss') throw new Error('unreachable')
    const cats = offers.config.filters?.includeCategories ?? []
    expect(cats.length).toBeGreaterThan(0)
    for (const c of cats) {
      expect(c.trim()).toBe(c) // 无前后空白：sanitize trim 后不变
      expect(c.length).toBeGreaterThan(0) // 非空：不会被清洗丢弃
    }
    expect(new Set(cats.map((c) => c.toLowerCase())).size).toBe(cats.length) // 大小写不敏感唯一
  })
})
