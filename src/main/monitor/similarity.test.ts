import { describe, expect, it } from 'vitest'
import { SHORT_TITLE_GUARD, findSimilarTo, isSimilarToAny, jaccard, normalizeTitle, trigrams } from './similarity'

/**
 * 黄金样本全部来自实现的真实行为（写测试前先跑通实现再固化预期），
 * 覆盖规格要求的四类归一化：全角半角 / emoji / 符号 / 空白。
 */
describe('normalizeTitle', () => {
  it('全角字母数字转半角并转小写；全角空格 U+3000 折叠为空格', () => {
    expect(normalizeTitle('ＶＰＳ　９９')).toBe('vps 99')
  })

  it('emoji 剔除（词中与词尾都变成词边界）', () => {
    expect(normalizeTitle('🔥年付VPS 9.9刀🔥')).toBe('年付vps 9 9刀')
  })

  it('装饰符剔除：中日韩标点【】（）、ASCII 括号、星号一律变空格', () => {
    expect(normalizeTitle('【白嫖】[分享]（限时）*免费*')).toBe('白嫖 分享 限时 免费')
  })

  it('连续空白折叠为单空格并 trim（混用半角/制表/换行）', () => {
    expect(normalizeTitle('  多个   空格\t制表\n换行  ')).toBe('多个 空格 制表 换行')
  })

  it('黄金样本：【白嫖】ＶＰＳ　¥９９/年 → 白嫖 vps 99 年（¥ / 剔除、９９→99）', () => {
    expect(normalizeTitle('【白嫖】ＶＰＳ　¥９９/年')).toBe('白嫖 vps 99 年')
  })

  it('纯符号/emoji 标题归一为空串', () => {
    expect(normalizeTitle('🎉!!【】')).toBe('')
    expect(normalizeTitle('')).toBe('')
  })

  it('大小写统一转小写；中文原样保留', () => {
    expect(normalizeTitle('Cheap VPS Big SALE')).toBe('cheap vps big sale')
    expect(normalizeTitle('二手 路由器')).toBe('二手 路由器')
  })

  it('幂等：normalizeTitle(normalizeTitle(x)) === normalizeTitle(x)', () => {
    for (const raw of [
      '【白嫖】ＶＰＳ　¥９９/年',
      '🔥年付VPS 9.9刀🔥',
      '  多个   空格\t制表\n换行  ',
      '🎉!!【】'
    ]) {
      const once = normalizeTitle(raw)
      expect(normalizeTitle(once)).toBe(once)
    }
  })
})

describe('trigrams', () => {
  it('英文按字符切 3-gram 滑窗', () => {
    expect(trigrams('abcd')).toEqual(new Set(['abc', 'bcd']))
  })

  it('中文按码点切滑窗，不被代理对劈开', () => {
    expect(trigrams('云服务器')).toEqual(new Set(['云服务', '服务器']))
  })

  it('空格也是字符，参与滑窗（保留词边界信息）', () => {
    expect(trigrams('ab cd')).toEqual(new Set(['ab ', 'b c', ' cd']))
  })

  it('超短串：长度 <3 返回自身单项集合；恰为 3 走正常滑窗', () => {
    expect(trigrams('ab')).toEqual(new Set(['ab']))
    expect(trigrams('')).toEqual(new Set(['']))
    expect(trigrams('abc')).toEqual(new Set(['abc']))
  })
})

describe('jaccard', () => {
  it('全等集合 → 1', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(1)
  })

  it('无交集 → 0', () => {
    expect(jaccard(new Set(['abc', 'bcd']), new Set(['cde', 'def']))).toBe(0)
  })

  it('部分重叠算精确比值：|A∩B|/|A∪B|', () => {
    // 交集 {bcd,cde}=2，并集 {abc,bcd,cde,def}=4 → 0.5
    expect(jaccard(new Set(['abc', 'bcd', 'cde']), new Set(['bcd', 'cde', 'def']))).toBe(0.5)
  })

  it('空集约定：双空集 → 1（全等的空）；一空一非空 → 0', () => {
    expect(jaccard(new Set(), new Set())).toBe(1)
    expect(jaccard(new Set(['abc']), new Set())).toBe(0)
  })
})

describe('isSimilarToAny', () => {
  /** 用归一化 + trigram + jaccard 算出原始标题对的精确得分（用于固化文档化数值） */
  function pairScore(a: string, b: string): number {
    return jaccard(trigrams(normalizeTitle(a)), trigrams(normalizeTitle(b)))
  }

  it('变体1｜前缀 tag 增减：[分享] 甲骨文云… vs 无 tag（J=0.8125）', () => {
    const recent = normalizeTitle('甲骨文云 4核24G 永久免费')
    expect(pairScore('[分享] 甲骨文云 4核24G 永久免费', '甲骨文云 4核24G 永久免费')).toBeCloseTo(0.8125, 10)
    expect(isSimilarToAny('[分享] 甲骨文云 4核24G 永久免费', [recent], 0.72)).toBe(true)
  })

  it('变体2｜大小写 + 标点 + 尾部 emoji：完全同活动（J=1）', () => {
    const recent = normalizeTitle('搬瓦工 cn2 gia 限量8折 末班车')
    expect(pairScore('搬瓦工 CN2 GIA 限量8折!末班车🚗', '搬瓦工 cn2 gia 限量8折 末班车')).toBe(1)
    expect(isSimilarToAny('搬瓦工 CN2 GIA 限量8折!末班车🚗', [recent], 0.72)).toBe(true)
  })

  it('变体3｜全角/货币符/斜杠装饰：黄金样本对（J=1）', () => {
    const recent = normalizeTitle('白嫖 vps 99 年')
    expect(pairScore('【白嫖】ＶＰＳ　¥９９/年', '白嫖 vps 99 年')).toBe(1)
    expect(isSimilarToAny('【白嫖】ＶＰＳ　¥９９/年', [recent], 0.72)).toBe(true)
  })

  it('变体4｜英文品牌大小写 + 前缀 tag（J=13/15≈0.833）', () => {
    const recent = normalizeTitle('NodeSeek 积分兑换礼品指南')
    expect(pairScore('[转发] NodeSeek 积分兑换礼品指南', 'NodeSeek 积分兑换礼品指南')).toBeCloseTo(15 / 18, 10)
    expect(isSimilarToAny('[转发] NodeSeek 积分兑换礼品指南', [recent], 0.72)).toBe(true)
  })

  it('变体5｜前后缀装饰齐上，贴着阈值上沿（J=13/18≈0.7222 ≥ 0.72）', () => {
    const recent = normalizeTitle('甲骨文云 4核24G 永久免费')
    expect(pairScore('[出] 甲骨文云 4核24G 永久免费 自用', '甲骨文云 4核24G 永久免费')).toBeCloseTo(13 / 18, 10)
    expect(isSimilarToAny('[出] 甲骨文云 4核24G 永久免费 自用', [recent], 0.72)).toBe(true)
  })

  it('无关标题（跨语系/跨主题）不命中；混合窗口扫到任一命中即 true', () => {
    const recents = [
      normalizeTitle('二手路由器 闲置出'),
      normalizeTitle('求推荐 机械键盘 87配列')
    ]
    expect(isSimilarToAny('Cheap VPS Big Sale', recents, 0.72)).toBe(false)
    // 窗口里夹一个命中项（变体1 的对子）→ true
    expect(
      isSimilarToAny('[分享] 甲骨文云 4核24G 永久免费', [...recents, normalizeTitle('甲骨文云 4核24G 永久免费')], 0.72)
    ).toBe(true)
  })

  it('换词级转发不命中：规格示例对 [分享]xx云 99/年 白嫖 vs xx云 99一年 优惠码（J=2/9≈0.222）', () => {
    const recent = normalizeTitle('xx云 99一年 优惠码')
    expect(pairScore('[分享]xx云 99/年 白嫖', 'xx云 99一年 优惠码')).toBeCloseTo(4 / 18, 10)
    expect(isSimilarToAny('[分享]xx云 99/年 白嫖', [recent], 0.72)).toBe(false)
  })

  it('同活动但改写幅度大（加前缀 tag + 加词）不命中：J=2/3≈0.667', () => {
    const recent = normalizeTitle('[福利]华为云 88一年 新用户专享')
    expect(pairScore('华为云 88一年 新用户', '[福利]华为云 88一年 新用户专享')).toBeCloseTo(2 / 3, 10)
    expect(isSimilarToAny('华为云 88一年 新用户', [recent], 0.72)).toBe(false)
  })

  it('短标题守卫｜title 方向：归一后 <6 恒 false（即使与窗口完全同串）', () => {
    // "vps2" 归一后长度 4 < SHORT_TITLE_GUARD，与窗口里同串也不判相似
    expect(SHORT_TITLE_GUARD).toBe(6)
    expect(isSimilarToAny('vps2', [normalizeTitle('vps2')], 0.72)).toBe(false)
    expect(isSimilarToAny('vps', [normalizeTitle('vps 9.9')], 0.9)).toBe(false)
  })

  it('短标题守卫｜recent 方向：窗口里 <6 的条目跳过，长条目仍可命中', () => {
    const title = '【白嫖】ＶＰＳ　¥９９/年'
    // 只有短条目 → false
    expect(isSimilarToAny(title, [normalizeTitle('vps2'), normalizeTitle('99')], 0.72)).toBe(false)
    // 夹着长条目（变体3 对子）→ true
    expect(
      isSimilarToAny(title, [normalizeTitle('vps2'), normalizeTitle('白嫖 vps 99 年')], 0.72)
    ).toBe(true)
  })

  it('阈值边界｜J=12/17≈0.7059：阈值 0.70 命中、0.72 不命中', () => {
    const recent = normalizeTitle('腾讯云 38/月 新用户首年')
    const newTitle = '[福利] 腾讯云 38/月 新用户首年冲了'
    expect(pairScore(newTitle, '腾讯云 38/月 新用户首年')).toBeCloseTo(12 / 17, 10)
    expect(isSimilarToAny(newTitle, [recent], 0.7)).toBe(true)
    expect(isSimilarToAny(newTitle, [recent], 0.72)).toBe(false)
  })

  it('比较为 >=（等于阈值算相似）：J=1 时阈值取 1 也命中', () => {
    expect(isSimilarToAny('same title here', [normalizeTitle('same title here')], 1)).toBe(true)
  })

  it('空 recentTitles → 恒 false', () => {
    expect(isSimilarToAny('随便一个长标题', [], 0.72)).toBe(false)
    expect(isSimilarToAny('随便一个长标题', [], 0)).toBe(false)
  })
})

describe('findSimilarTo（带明细版）', () => {
  it('返回首个命中条目的标题与相似度', () => {
    // 与既有 isSimilarToAny 用例同款相似对（装饰符归一后高重叠）
    const m = findSimilarTo(
      '【转发】便宜 VPS 年付 99 元的活动帖子！',
      [normalizeTitle('无关标题很长的一行字'), normalizeTitle('便宜 vps 年付 99 元的活动帖子')],
      0.72
    )
    expect(m).not.toBeNull()
    expect(m!.title).toBe(normalizeTitle('便宜 vps 年付 99 元的活动帖子'))
    expect(m!.score).toBeGreaterThan(0.72)
    expect(m!.score).toBeLessThanOrEqual(1)
  })

  it('完全相同标题 → score 恰为 1', () => {
    const m = findSimilarTo('same title here', [normalizeTitle('same title here')], 0.72)
    expect(m).toMatchObject({ score: 1 })
  })

  it('遍历序 = 入参序：前条略低于阈、后条更高时返回后条', () => {
    const title = '[福利] 腾讯云 38/月 新用户首年冲了'
    const weak = normalizeTitle('腾讯云 38/月 新用户首年') // J≈0.706 < 0.72
    const strong = normalizeTitle(title) // J=1
    const m = findSimilarTo(title, [weak, strong], 0.72)
    expect(m!.title).toBe(strong)
  })

  it('不相似 / 空窗口 / 短标题守卫 → null（与 isSimilarToAny 布尔投影一致）', () => {
    expect(findSimilarTo('聊聊完全不同的 vps 话题', [normalizeTitle('便宜 vps 年付 99 元的活动帖子')], 0.72)).toBeNull()
    expect(findSimilarTo('随便一个长标题', [], 0.72)).toBeNull()
    expect(findSimilarTo('vps2', [normalizeTitle('vps2')], 0.72)).toBeNull()
    // 布尔投影对齐
    for (const [t, recents, th] of [
      ['same title here', [normalizeTitle('same title here')], 0.72],
      ['聊聊完全不同的 vps 话题', [normalizeTitle('便宜 vps 年付 99 元的活动帖子')], 0.72]
    ] as const) {
      expect(isSimilarToAny(t, [...recents], th)).toBe(findSimilarTo(t, [...recents], th) !== null)
    }
  })
})
