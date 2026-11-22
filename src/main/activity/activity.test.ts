import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_CONFIG, type Topic } from '../../shared/types'
import { AiProviderError } from '../ai/provider'
import { createLogger } from '../logger'
import { ChallengeError } from '../monitor/types'
import { ActivityAiExtractor } from './ai-extractor'
import { ActivityCollector } from './collector'
import { TopicDetailFetcher, parseTopicDetailHtml } from './detail-fetcher'
import {
  extractDeterministicActivitySignals,
  hasEndedTitleMarker,
  prescreenActivityTopic
} from './prescreen'
import {
  ACTIVITIES_FILE_NAME,
  ActivityStore,
  ReplicaActivityView,
  resolveActivityStatus
} from './store'

function makeTopic(overrides: Partial<Topic> = {}): Topic {
  return {
    id: '936634',
    sourceId: 'nodeseek',
    title: '【抽奖】周末送一台 DMIT HK Pro 年付小鸡',
    url: 'https://www.nodeseek.com/post-936634-1',
    author: 'vps_lover',
    authorUrl: 'https://www.nodeseek.com/space/1024',
    category: '日常',
    categorySlug: 'daily',
    pinned: false,
    lastActiveAt: '2026-11-22T10:00:00.000Z',
    ...overrides
  }
}

describe('prescreenActivityTopic & hasEndedTitleMarker', () => {
  it('准确放行抽奖、盖楼、福利派送、节日活动与限时闪购', () => {
    expect(prescreenActivityTopic(makeTopic({ title: '【抽奖】送 3 台香港小鸡' }))).toMatchObject({
      matched: true,
      kindHint: 'lottery'
    })
    expect(prescreenActivityTopic(makeTopic({ title: '周五盖楼送 100 个鸡腿，满 200 楼开' }))).toMatchObject({
      matched: true,
      kindHint: 'floor'
    })
    expect(prescreenActivityTopic(makeTopic({ title: '免费送 5 个邀请码给坛友' }))).toMatchObject({
      matched: true,
      kindHint: 'giveaway'
    })
    expect(prescreenActivityTopic(makeTopic({ title: 'NodeSeek 黑五 Black Friday 社区专题活动汇总' }))).toMatchObject({
      matched: true,
      kindHint: 'event'
    })
    expect(
      prescreenActivityTopic(
        makeTopic({ title: '某商家东京 BGP 首发限时闪购 5 折', categorySlug: 'promotion', category: '推广' })
      )
    ).toMatchObject({
      matched: true,
      kindHint: 'promo'
    })
  })

  it('拦截二手单机买卖、曝光沙盒分类与纯求助提问贴', () => {
    expect(
      prescreenActivityTopic(
        makeTopic({ title: '剩余价值出一台黑五活动机 120 元', categorySlug: 'trade', category: '交易' })
      ).matched
    ).toBe(false)

    expect(
      prescreenActivityTopic(makeTopic({ title: '请问昨天那个抽奖活动有人收到机器吗？' })).matched
    ).toBe(false)

    expect(
      prescreenActivityTopic(
        makeTopic({ title: '【曝光】某商家虚假抽奖活动跑路', categorySlug: 'expose', category: '曝光' })
      ).matched
    ).toBe(false)

    expect(
      prescreenActivityTopic(makeTopic({ title: '【抽奖】送小鸡' }), {
        excludeKeywords: ['送小鸡']
      }).matched
    ).toBe(false)
  })

  it('检测已开奖 / 已结束标题标记', () => {
    expect(hasEndedTitleMarker('【已开奖】周末送一台 DMIT 小鸡')).toBe(true)
    expect(hasEndedTitleMarker('[已结束] 周年庆盖楼送福利')).toBe(true)
    expect(hasEndedTitleMarker('【抽奖中】今晚 22:00 开奖')).toBe(false)
  })
})

describe('extractDeterministicActivitySignals', () => {
  const baseMs = new Date(2026, 10, 22, 12, 0, 0, 0).getTime()

  it('解析 nodeseek.com/lucky 开奖链接与内嵌时间戳、目标楼层、奖品和规则', () => {
    const targetEnd = baseMs + 6 * 3_600_000
    const sig = extractDeterministicActivitySignals({
      title: '【抽奖】送一台美西 CN2 GIA 年付小鸡',
      markdown: [
        '奖品：美西 CN2 GIA 年付 VPS 1 台',
        '参与方式：评论任意祝福语即可参与，每人限回复一次',
        `开奖链接：[点击查看开奖](https://www.nodeseek.com/lucky?post=936634&time=${targetEnd}&floor=188)`
      ].join('\n'),
      sourceUrl: 'https://www.nodeseek.com/post-936634-1',
      baseTimeMs: baseMs
    })

    expect(sig.kind).toBe('lottery')
    expect(sig.luckyUrl).toBe(
      `https://www.nodeseek.com/lucky?post=936634&time=${targetEnd}&floor=188`
    )
    expect(sig.endsAtEpochMillis).toBe(targetEnd)
    expect(sig.drawFloor).toBe(188)
    expect(sig.prize).toContain('CN2 GIA')
    expect(sig.participation).toContain('每人限回复一次')
    expect(sig.tags).toContain('抽奖')
    expect(sig.tags).toContain('官方开奖')
    expect(sig.tags).toContain('VPS')
  })

  it('支持相对时长（24小时后开奖）与完整日期时间提取', () => {
    const rel = extractDeterministicActivitySignals({
      title: '【福利】免费送鸡腿，24小时后开奖',
      markdown: '随便回复即可参与！',
      sourceUrl: 'https://www.nodeseek.com/post-100-1',
      baseTimeMs: baseMs
    })
    expect(rel.endsAtEpochMillis).toBe(baseMs + 24 * 3_600_000)

    const abs = extractDeterministicActivitySignals({
      title: '【活动】社区跨年福利',
      markdown: '截止时间：2026-11-25 20:30\n欢迎大家参与',
      sourceUrl: 'https://www.nodeseek.com/post-101-1',
      baseTimeMs: baseMs
    })
    expect(abs.endsAtEpochMillis).toBe(new Date(2026, 10, 25, 20, 30, 0, 0).getTime())
  })
})

describe('parseTopicDetailHtml & TopicDetailFetcher', () => {
  it('优先解码 NodeSeek <script id="temp-script"> Base64 JSON 获取 1 楼原始 Markdown', () => {
    const payload = {
      postData: {
        postId: 936634,
        title: '【抽奖】周末送鸡',
        category: 'daily',
        categoryWord: '日常',
        locked: 0,
        op: { uid: 1024, name: 'alice' },
        comments: [
          {
            floorIndex: 0,
            markdown: '奖品：HK 小鸡一台\n[开奖链接](/lucky?post=936634&floor=88)',
            time: { createdDate: '2026-11-22T08:30:00.000Z' },
            poster: { uid: 1024, name: 'alice' }
          }
        ]
      }
    }
    const b64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64')
    const html = `<!doctype html><html><body><div id="nsk-body"><script id="temp-script" type="application/json">${b64}</script></div></body></html>`

    const parsed = parseTopicDetailHtml(html, 'https://www.nodeseek.com/post-936634-1')
    expect(parsed.title).toBe('【抽奖】周末送鸡')
    expect(parsed.author).toBe('alice')
    expect(parsed.authorUrl).toBe('https://www.nodeseek.com/space/1024')
    expect(parsed.createdAtEpochMillis).toBe(Date.parse('2026-11-22T08:30:00.000Z'))
    expect(parsed.markdown).toContain('/lucky?post=936634&floor=88')
    expect(parsed.locked).toBe(false)
    expect(parsed.accessRestriction).toBeNull()
  })

  it('识别私有帖/等级受限帖并优雅返回 accessRestriction；遇 CF 403 立即进入熔断冷却', async () => {
    const privateHtml = `<html><body><div id="nsk-body-left">查看本帖需要 Lv 2。</div></body></html>`
    const restricted = parseTopicDetailHtml(privateHtml)
    expect(restricted.accessRestriction).toContain('Lv2')

    let nowMs = 1_000_000
    const fetchMock = vi.fn(async () => ({
      status: 403,
      headers: { 'cf-mitigated': 'challenge' },
      body: 'challenge'
    }))
    const fetcher = new TopicDetailFetcher({
      fetchHtml: fetchMock,
      now: () => nowMs,
      sleep: async () => undefined,
      minIntervalMs: 100,
      jitterMs: 0,
      challengeCooldownMs: 60_000
    })

    const first = await fetcher.fetchDetail('https://www.nodeseek.com/post-1-1')
    expect(first.ok).toBe(false)
    if (!first.ok) expect(first.challenged).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // 冷却期内二次调用零网络请求直接短路
    nowMs += 10_000
    const second = await fetcher.fetchDetail('https://www.nodeseek.com/post-2-1')
    expect(second.ok).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('ActivityStore & ActivityCollector', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'fw-activity-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('持久化往返、动态时间状态翻转（effectiveRevision 自增）、人工编辑保护与墓碑防复活', async () => {
    let clock = 1_700_000_000_000
    const store = new ActivityStore({ dataDir: tmpDir, now: () => clock })

    store.upsertAuto({
      id: 'nodeseek:500',
      sourceId: 'nodeseek',
      topicId: '500',
      title: '【抽奖】即将开始并定时结束',
      summary: '测试时间窗口流转',
      sourceUrl: 'https://www.nodeseek.com/post-500-1',
      organizer: 'bob',
      startsAtEpochMillis: clock + 5_000,
      endsAtEpochMillis: clock + 10_000,
      kind: 'lottery'
    })
    await store.flush()

    const revUpcoming = store.getEffectiveRevision(clock)
    expect(store.queryPublic({}, clock).items[0]?.status).toBe('upcoming')

    clock += 6_000
    const revOngoing = store.getEffectiveRevision(clock)
    expect(revOngoing).not.toBe(revUpcoming)
    expect(store.queryPublic({}, clock).items[0]?.status).toBe('ongoing')

    clock += 6_000
    const revEnded = store.getEffectiveRevision(clock)
    expect(revEnded).not.toBe(revOngoing)
    expect(store.queryPublic({}, clock).items[0]?.status).toBe('ended')

    // 裸 topicId 也能查到详情
    expect(store.getPublicDetail('500', clock)?.id).toBe('nodeseek:500')

    // 管理员人工修改后置 manualOverride，自动更新不再覆盖
    store.updateAdmin('nodeseek:500', { title: '管理员精选标题', pinned: true })
    store.upsertAuto({
      id: 'nodeseek:500',
      sourceId: 'nodeseek',
      topicId: '500',
      title: '爬虫旧标题',
      summary: '旧摘要',
      sourceUrl: 'https://www.nodeseek.com/post-500-1',
      organizer: 'bob'
    })
    expect(store.getRecord('nodeseek:500')?.title).toBe('管理员精选标题')

    // ReplicaActivityView 同步后拥有一致查询结果
    const replica = new ReplicaActivityView(() => clock)
    replica.applySnapshot(store.exportSnapshot())
    expect(replica.queryPublic({}, clock).items[0]?.title).toBe('管理员精选标题')

    // 删除后进墓碑，自动采集不再复活
    expect(store.deleteAdmin('nodeseek:500')).toBe(true)
    expect(
      store.upsertAuto({
        id: 'nodeseek:500',
        sourceId: 'nodeseek',
        topicId: '500',
        title: '试图复活',
        summary: '',
        sourceUrl: 'https://www.nodeseek.com/post-500-1',
        organizer: 'bob'
      })
    ).toBeNull()

    await store.flush()
    const reloaded = new ActivityStore({ dataDir: tmpDir, now: () => clock })
    expect(reloaded.isTombstoned('nodeseek:500')).toBe(true)
  })

  it('损坏文件容错：备份 .corrupt-* 并以空库恢复不抛错', async () => {
    await writeFile(join(tmpDir, ACTIVITIES_FILE_NAME), '{not-valid-json', 'utf-8')
    const store = new ActivityStore({ dataDir: tmpDir, now: () => 12345 })
    expect(store.size()).toBe(0)
    const files = await readdir(tmpDir)
    expect(files.some((f) => f.startsWith(`${ACTIVITIES_FILE_NAME}.corrupt-`))).toBe(true)
  })

  it('ActivityCollector：首启冷启动种子入库 + AI 过滤非活动贴 + 首页标题已开奖自动结单', async () => {
    const nowMs = Date.parse('2026-11-22T12:00:00.000Z')
    const store = new ActivityStore({ now: () => nowMs })
    const logger = createLogger()

    const detailFetcher = new TopicDetailFetcher({
      fetchHtml: async (url) => {
        if (url.includes('post-1001')) {
          return {
            status: 200,
            headers: {},
            body: `<article class="post-content"><p>奖品：香港 CMI 年付小鸡</p><a href="/lucky?post=1001&time=${nowMs + 3600_000}">开奖链接</a></article>`
          }
        }
        return {
          status: 200,
          headers: {},
          body: `<article class="post-content"><p>大家觉得这个抽奖怎么样</p></article>`
        }
      },
      now: () => nowMs,
      sleep: async () => undefined,
      minIntervalMs: 0,
      jitterMs: 0
    })

    const aiExtractor = new ActivityAiExtractor({
      provider: {
        chat: async ({ user }) => {
          if (user.includes('1001') || user.includes('CMI')) {
            return JSON.stringify({
              isActivity: true,
              kind: 'lottery',
              summary: '回复本帖抽香港 CMI 年付 VPS 一台',
              organizer: 'host_official',
              prize: '香港 CMI 年付 VPS',
              participation: '评论即可参与',
              startsAtIso: null,
              endsAtIso: null,
              drawFloor: null,
              tags: ['抽奖', 'CMI']
            })
          }
          if (user.includes('未配测试')) {
            throw new AiProviderError('unconfigured', 'unconfigured')
          }
          return JSON.stringify({
            isActivity: false,
            kind: 'other',
            summary: '',
            organizer: 'someone',
            prize: null,
            participation: null,
            startsAtIso: null,
            endsAtIso: null,
            drawFloor: null,
            tags: []
          })
        }
      },
      now: () => nowMs
    })

    const collector = new ActivityCollector({
      store,
      detailFetcher,
      aiExtractor,
      getConfig: () => structuredClone(DEFAULT_APP_CONFIG),
      logger,
      now: () => nowMs
    })

    // 1. 首启基线轮冷启动种子
    collector.observeRound(
      'nodeseek',
      [
        makeTopic({ id: '1001', title: '【抽奖】送一台香港 CMI 年付小鸡', url: 'https://www.nodeseek.com/post-1001-1' }),
        makeTopic({ id: '1002', title: '【抽奖】伪装成抽奖的讨论贴', url: 'https://www.nodeseek.com/post-1002-1' })
      ],
      {
        isBaseline: true,
        idFilter: true,
        oldThreshold: null,
        prevUnseenKeys: new Set()
      }
    )
    await collector.drain()

    expect(store.size()).toBe(1)
    const item = store.getRecord('nodeseek:1001')!
    expect(item.organizer).toBe('host_official')
    expect(item.luckyUrl).toBe(`https://www.nodeseek.com/lucky?post=1001&time=${nowMs + 3600_000}`)
    expect(resolveActivityStatus(item, nowMs)).toBe('ongoing')
    // 被 AI 拒掉的 1002 已入 evaluatedKeys，不会重复抓取
    expect(store.hasEvaluated('nodeseek:1002')).toBe(true)

    // 2. 下一轮首页标题变为「【已开奖】...」，零请求自动同步为 ended
    collector.observeRound(
      'nodeseek',
      [makeTopic({ id: '1001', title: '【已开奖】送一台香港 CMI 年付小鸡' })],
      {
        isBaseline: false,
        idFilter: true,
        oldThreshold: 1002,
        prevUnseenKeys: new Set(),
        unseenTopics: []
      }
    )
    expect(store.queryPublic({}, nowMs).items[0]?.status).toBe('ended')
  })
})

describe('ChallengeError type import sanity', () => {
  it('ChallengeError 可正常实例化', () => {
    expect(new ChallengeError('cf').name).toBe('ChallengeError')
  })
})
