import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HitRecord, Topic } from '../../shared/types'
import {
  formatLocalDate,
  HitsStore,
  HITS_DIR_NAME,
  HITS_QUERY_LIMIT_MAX,
  type HitQueryOptions
} from './hits-store'

let dir: string // 模拟 <userData>/hits（构造函数收 hits 目录本身）
let store: HitsStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forumwatch-hits-'))
  store = new HitsStore(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function makeTopic(id: string): Topic {
  return {
    id,
    sourceId: 'nodeseek',
    title: `title-${id}`,
    url: `https://www.nodeseek.com/post-${id}-1`,
    author: 'someone',
    category: '交易',
    categorySlug: 'trade',
    pinned: false,
    lastActiveAt: '2026-09-19T10:00:00+08:00'
  }
}

function makeHit(id: string, matchedBy: 'literal' | 'semantic' = 'literal'): HitRecord {
  return {
    topic: makeTopic(id),
    matchedKeywords: matchedBy === 'literal' ? ['vps'] : [],
    matchedBy,
    semanticReason: matchedBy === 'semantic' ? '与兴趣描述中的自建主机话题相关' : null,
    notifiedAt: '2026-09-19T10:00:01+08:00',
    notifyError: null
  }
}

describe('formatLocalDate（本地时区口径）', () => {
  it('月/日补零', () => {
    expect(formatLocalDate(new Date(2026, 0, 5, 3, 7))).toBe('2026-01-05')
    expect(formatLocalDate(new Date(2026, 10, 20))).toBe('2026-11-20')
  })

  it('23:59 边界仍属当天', () => {
    expect(formatLocalDate(new Date(2026, 8, 19, 23, 59))).toBe('2026-09-19')
  })

  it('本地 00:30 不漂移到 UTC 日期（误用 toISOString().slice 会差一天）', () => {
    // 本地构造 2026-09-19 00:30：东八区机器上 UTC 是 2026-09-18 16:30，
    // toISOString().slice(0,10) 会得到 '2026-09-18'（错误口径）。
    const d = new Date(2026, 8, 19, 0, 30)
    expect(formatLocalDate(d)).toBe('2026-09-19')
    // 无论测试机处于哪个时区：只要 UTC 日期与本地日期不同，结果必须取本地那份
    const utcDate = d.toISOString().slice(0, 10)
    if (utcDate !== '2026-09-19') {
      expect(formatLocalDate(d)).not.toBe(utcDate)
    }
  })

  it('默认参数返回今天（与显式 new Date() 一致）', () => {
    expect(formatLocalDate()).toBe(formatLocalDate(new Date()))
  })
})

describe('HitsStore', () => {
  it('目录名常量', () => {
    expect(HITS_DIR_NAME).toBe('hits')
  })

  it('append→readDay 往返：多条、顺序保持（旧→新）、v2 字段原样', async () => {
    const now = new Date(2026, 8, 19, 12, 0)
    const a = makeHit('1', 'literal')
    const b = makeHit('2', 'semantic')
    const c = makeHit('3', 'literal')
    await store.append(a, now)
    await store.append(b, now)
    await store.append(c, now)

    const hits = await store.readDay('2026-09-19')
    expect(hits.map((h) => h.topic.id)).toEqual(['1', '2', '3'])
    expect(hits[0]).toEqual(a)
    expect(hits[1].matchedBy).toBe('semantic')
    expect(hits[1].matchedKeywords).toEqual([])
    expect(hits[1].semanticReason).toBe('与兴趣描述中的自建主机话题相关')
    expect(hits[2].topic.sourceId).toBe('nodeseek')

    // 文件形态：一行一个 JSON + 换行，ISO 时间戳原样字符串
    const raw = await readFile(join(dir, '2026-09-19.jsonl'), 'utf-8')
    const lines = raw.split('\n')
    expect(lines).toHaveLength(4) // 3 行内容 + 末尾空串（尾随 \n）
    expect(JSON.parse(lines[0])).toEqual(a)
    expect(raw.endsWith('\n')).toBe(true)
  })

  it('跨天分桶：不同 now 落到不同文件', async () => {
    await store.append(makeHit('1'), new Date(2026, 8, 18, 23, 59))
    await store.append(makeHit('2'), new Date(2026, 8, 19, 0, 1))
    await store.append(makeHit('3'), new Date(2026, 8, 19, 8, 0))

    expect((await store.readDay('2026-09-18')).map((h) => h.topic.id)).toEqual(['1'])
    expect((await store.readDay('2026-09-19')).map((h) => h.topic.id)).toEqual(['2', '3'])

    const files = (await readdir(dir)).sort()
    expect(files).toEqual(['2026-09-18.jsonl', '2026-09-19.jsonl'])
  })

  it('readDay：文件不存在 → []', async () => {
    expect(await store.readDay('2030-01-01')).toEqual([])
  })

  it('readRecent（R5-P2a 窗口重建数据源）：近 N 个本地自然日合并、整体旧→新、含跨日桶', async () => {
    // 三天数据：17 日两条、18 日一条、19 日（今天口径由注入 now 决定）两条；16 日有一条（窗口外）
    await store.append(makeHit('a1'), new Date(2026, 8, 16, 12, 0))
    await store.append(makeHit('b1'), new Date(2026, 8, 17, 12, 0))
    await store.append(makeHit('b2'), new Date(2026, 8, 17, 13, 0))
    await store.append(makeHit('c1'), new Date(2026, 8, 18, 23, 59))
    await store.append(makeHit('d1'), new Date(2026, 8, 19, 0, 1))
    await store.append(makeHit('d2'), new Date(2026, 8, 19, 8, 0))

    // now = 2026-09-19 09:00：近 3 天 = 19/18/17（16 日在窗口外）
    const hits = await store.readRecent(3, new Date(2026, 8, 19, 9, 0))
    expect(hits.map((h) => h.topic.id)).toEqual(['b1', 'b2', 'c1', 'd1', 'd2']) // 旧→新
    // days=1 只读今天；days 覆盖更早的窗口时把 16 日也带上
    expect((await store.readRecent(1, new Date(2026, 8, 19, 9, 0))).map((h) => h.topic.id)).toEqual(['d1', 'd2'])
    expect((await store.readRecent(4, new Date(2026, 8, 19, 9, 0))).map((h) => h.topic.id)).toEqual([
      'a1', 'b1', 'b2', 'c1', 'd1', 'd2'
    ])
  })

  it('readRecent：days<=0 / 非整数 → []；某日文件不存在按空处理', async () => {
    expect(await store.readRecent(0)).toEqual([])
    expect(await store.readRecent(-3)).toEqual([])
    expect(await store.readRecent(1.5)).toEqual([])
    // 空目录（无任何命中）：读 3 天也安全
    expect(await store.readRecent(3, new Date(2026, 8, 19, 9, 0))).toEqual([])
  })

  it('坏行容错：中间行是垃圾 / 形状不对的行都被跳过，其余照常返回', async () => {
    const good1 = makeHit('1')
    const good2 = makeHit('2')
    // 手工拼一个文件：好行 / 垃圾（非法 JSON）/ 合法 JSON 但不是 HitRecord / 好行（无尾随换行）
    const raw =
      `${JSON.stringify(good1)}\n` +
      `{"broken": 这不是JSON\n` +
      `{"foo": "bar"}\n` +
      `{"topic": {"id": 123}}\n` +
      JSON.stringify(good2)
    await writeFile(join(dir, '2026-09-19.jsonl'), raw, 'utf-8')

    const hits = await store.readDay('2026-09-19')
    expect(hits).toEqual([good1, good2])
  })

  it('listDays：新→旧排序，无关文件名被忽略', async () => {
    await store.append(makeHit('1'), new Date(2026, 8, 18))
    await store.append(makeHit('2'), new Date(2026, 8, 1))
    await store.append(makeHit('3'), new Date(2026, 8, 19))
    // 无关文件：不同扩展名 / 日期不补零 / 多余后缀 / 普通文本
    await writeFile(join(dir, '2026-09-19.md'), '', 'utf-8')
    await writeFile(join(dir, '2026-9-9.jsonl'), '', 'utf-8')
    await writeFile(join(dir, '2026-09-19.jsonl.bak'), '', 'utf-8')
    await writeFile(join(dir, 'notes.txt'), '', 'utf-8')

    expect(store.listDays()).toEqual(['2026-09-19', '2026-09-18', '2026-09-01'])
  })

  it('listDays：目录不存在 → []', () => {
    expect(new HitsStore(join(dir, 'not-exist')).listDays()).toEqual([])
  })
})

// ---- query（R7-W2 历史命中浏览器数据面） ------------------------------------

/** query 测试构造器：makeHit 的可覆盖版（来源/标题/关键词/规则/推送态） */
interface QueryHitSpec {
  id: string
  sourceId?: string
  title?: string
  matchedBy?: 'literal' | 'semantic' | 'rule'
  keywords?: string[]
  matchedRule?: string | null
  notifiedAt?: string | null
  notifyError?: string | null
}

function buildHit(spec: QueryHitSpec): HitRecord {
  const matchedBy = spec.matchedBy ?? 'literal'
  const topic: Topic = {
    ...makeTopic(spec.id),
    sourceId: spec.sourceId ?? 'nodeseek',
    title: spec.title ?? `title-${spec.id}`
  }
  return {
    topic,
    matchedKeywords: spec.keywords ?? (matchedBy === 'literal' ? ['vps'] : []),
    matchedBy,
    semanticReason: matchedBy === 'semantic' ? '与兴趣描述相关' : null,
    ...(spec.matchedRule !== undefined ? { matchedRule: spec.matchedRule } : {}),
    notifiedAt: spec.notifiedAt ?? '2026-09-19T10:00:01+08:00',
    notifyError: spec.notifyError ?? null
  }
}

/** query 的缺省入参（区间/limit 覆盖见各用例） */
function baseQuery(over: Partial<HitQueryOptions> = {}): HitQueryOptions {
  return { fromDate: '2026-09-16', toDate: '2026-09-19', limit: 100, offset: 0, ...over }
}

/** 四天种子：16 日 1 条 / 17 日 2 条 / 18 日 1 条 / 19 日 2 条 */
async function seedSpan(): Promise<void> {
  await store.append(buildHit({ id: 'a1' }), new Date(2026, 8, 16, 12, 0))
  await store.append(buildHit({ id: 'b1' }), new Date(2026, 8, 17, 12, 0))
  await store.append(buildHit({ id: 'b2' }), new Date(2026, 8, 17, 13, 0))
  await store.append(buildHit({ id: 'c1' }), new Date(2026, 8, 18, 12, 0))
  await store.append(buildHit({ id: 'd1' }), new Date(2026, 8, 19, 12, 0))
  await store.append(buildHit({ id: 'd2' }), new Date(2026, 8, 19, 13, 0))
}

describe('HitsStore.query（R7-W2 历史命中查询）', () => {
  it('跨日合并读（fromDate..toDate 含两端）+ 新→旧排序（跨日日期倒序、同日记录序倒序）', async () => {
    await seedSpan()
    const r = await store.query(baseQuery({ fromDate: '2026-09-17', toDate: '2026-09-19' }))
    expect(r.total).toBe(5) // 16 日的 a1 在区间外
    expect(r.items.map((h) => h.topic.id)).toEqual(['d2', 'd1', 'c1', 'b2', 'b1'])
  })

  it('fromDate == toDate 单日：区间即一天，同日内新→旧', async () => {
    await seedSpan()
    const r = await store.query(baseQuery({ fromDate: '2026-09-16', toDate: '2026-09-16' }))
    expect(r.total).toBe(1)
    expect(r.items.map((h) => h.topic.id)).toEqual(['a1'])
    const r19 = await store.query(baseQuery({ fromDate: '2026-09-19', toDate: '2026-09-19' }))
    expect(r19.items.map((h) => h.topic.id)).toEqual(['d2', 'd1'])
  })

  it('sourceId 精确过滤；空串 = 不过滤', async () => {
    await store.append(buildHit({ id: 'n1', sourceId: 'nodeseek' }), new Date(2026, 8, 19, 10, 0))
    await store.append(buildHit({ id: 'r1', sourceId: 'rss-a' }), new Date(2026, 8, 19, 11, 0))
    await store.append(buildHit({ id: 'r2', sourceId: 'rss-a' }), new Date(2026, 8, 19, 12, 0))

    const rss = await store.query(baseQuery({ sourceId: 'rss-a' }))
    expect(rss.total).toBe(2)
    expect(rss.items.map((h) => h.topic.id)).toEqual(['r2', 'r1'])
    // 精确匹配：'rss' 不命中 'rss-a'
    expect((await store.query(baseQuery({ sourceId: 'rss' }))).total).toBe(0)
    // 空串 = 不过滤（与 undefined 同义）
    expect((await store.query(baseQuery({ sourceId: '' }))).total).toBe(3)
  })

  it('matchedBy 包含过滤：单选 / 多选 / 空数组与 undefined = 不过滤', async () => {
    await store.append(buildHit({ id: 'l1', matchedBy: 'literal' }), new Date(2026, 8, 19, 10, 0))
    await store.append(buildHit({ id: 's1', matchedBy: 'semantic' }), new Date(2026, 8, 19, 11, 0))
    await store.append(buildHit({ id: 'g1', matchedBy: 'rule', matchedRule: '低价VPS' }), new Date(2026, 8, 19, 12, 0))

    expect((await store.query(baseQuery({ matchedBy: ['rule'] }))).items.map((h) => h.topic.id)).toEqual(['g1'])
    expect(
      (await store.query(baseQuery({ matchedBy: ['literal', 'semantic'] }))).items.map((h) => h.topic.id)
    ).toEqual(['s1', 'l1'])
    expect((await store.query(baseQuery({ matchedBy: [] }))).total).toBe(3)
    expect((await store.query(baseQuery({}))).total).toBe(3)
  })

  it('text 对 title 大小写不敏感子串', async () => {
    await store.append(buildHit({ id: 'e1', title: 'Cheap VPS Hosting' }), new Date(2026, 8, 19, 10, 0))
    await store.append(buildHit({ id: 'e2', title: 'nodeseek 年付优惠' }), new Date(2026, 8, 19, 11, 0))
    await store.append(buildHit({ id: 'e3', title: '无关标题' }), new Date(2026, 8, 19, 12, 0))

    expect((await store.query(baseQuery({ text: 'cheap vps' }))).items.map((h) => h.topic.id)).toEqual(['e1'])
    expect((await store.query(baseQuery({ text: 'NODESEEK' }))).items.map((h) => h.topic.id)).toEqual(['e2'])
    expect((await store.query(baseQuery({ text: '优惠' }))).items.map((h) => h.topic.id)).toEqual(['e2'])
  })

  it('text 也匹配 matchedKeywords 与 matchedRule（旧记录无 matchedRule 按无）', async () => {
    await store.append(
      buildHit({ id: 'k1', title: '无关标题', keywords: ['香港VPS'] }),
      new Date(2026, 8, 19, 10, 0)
    )
    await store.append(
      buildHit({ id: 'k2', matchedBy: 'rule', matchedRule: '低价VPS', title: '另一个标题' }),
      new Date(2026, 8, 19, 11, 0)
    )
    // 旧记录形状：不携带 matchedRule 键（buildHit 未给 spec.matchedRule 时本就不落键）
    const legacy = buildHit({ id: 'k3', title: 'legacy 行' })
    await store.append(legacy, new Date(2026, 8, 19, 12, 0))
    expect('matchedRule' in legacy).toBe(false)

    expect((await store.query(baseQuery({ text: '香港' }))).items.map((h) => h.topic.id)).toEqual(['k1'])
    expect((await store.query(baseQuery({ text: '低价vps' }))).items.map((h) => h.topic.id)).toEqual(['k2'])
    // 全部记录都不含的词
    expect((await store.query(baseQuery({ text: '不存在词' }))).total).toBe(0)
  })

  it('text 纯空白 = 不过滤（trim 后为空）', async () => {
    await seedSpan()
    expect((await store.query(baseQuery({ text: '   ' }))).total).toBe(6)
    expect((await store.query(baseQuery({ text: undefined }))).total).toBe(6)
  })

  it('分页：offset/limit 切片 + total 恒为过滤后总数', async () => {
    await seedSpan() // 6 条，新→旧：d2 d1 c1 b2 b1 a1
    const p1 = await store.query(baseQuery({ limit: 3, offset: 0 }))
    expect(p1.total).toBe(6)
    expect(p1.items.map((h) => h.topic.id)).toEqual(['d2', 'd1', 'c1'])
    const p2 = await store.query(baseQuery({ limit: 3, offset: 3 }))
    expect(p2.total).toBe(6)
    expect(p2.items.map((h) => h.topic.id)).toEqual(['b2', 'b1', 'a1'])
    const p3 = await store.query(baseQuery({ limit: 3, offset: 6 }))
    expect(p3.items).toEqual([])
    // 尾页不满页
    const tail = await store.query(baseQuery({ limit: 4, offset: 4 }))
    expect(tail.items.map((h) => h.topic.id)).toEqual(['b1', 'a1'])
  })

  it('limit 钳位上限 200（HITS_QUERY_LIMIT_MAX）：请求 1000 也只回 200 条，total 准确', async () => {
    expect(HITS_QUERY_LIMIT_MAX).toBe(200)
    const now = new Date(2026, 8, 19, 12, 0)
    for (let i = 0; i < 205; i++) {
      await store.append(buildHit({ id: `h${i}` }), now)
    }
    const r = await store.query(baseQuery({ limit: 1000 }))
    expect(r.total).toBe(205)
    expect(r.items).toHaveLength(200)
    // 恰好等于上限不截
    const exact = await store.query(baseQuery({ limit: 200 }))
    expect(exact.items).toHaveLength(200)
  })

  it('limit/offset 边界：负 offset 按 0、limit<=0 → items 空、非整数 floor', async () => {
    await seedSpan()
    const negOffset = await store.query(baseQuery({ limit: 2, offset: -5 }))
    expect(negOffset.items.map((h) => h.topic.id)).toEqual(['d2', 'd1'])
    const zeroLimit = await store.query(baseQuery({ limit: 0 }))
    expect(zeroLimit.total).toBe(6)
    expect(zeroLimit.items).toEqual([])
    const nanLimit = await store.query(baseQuery({ limit: Number.NaN }))
    expect(nanLimit.total).toBe(6)
    expect(nanLimit.items).toEqual([])
    const frac = await store.query(baseQuery({ limit: 2.9, offset: 1.7 }))
    expect(frac.items.map((h) => h.topic.id)).toEqual(['d1', 'c1'])
  })

  it('坏行跳过（复用 readDay 语义）：垃圾/形状不对的行不进结果', async () => {
    const good1 = buildHit({ id: 'g1' })
    const good2 = buildHit({ id: 'g2' })
    const raw =
      `${JSON.stringify(good1)}\n` +
      `{"broken": 这不是JSON\n` +
      `{"foo": "bar"}\n` +
      `{"topic": {"id": 123}}\n` +
      JSON.stringify(good2)
    await writeFile(join(dir, '2026-09-19.jsonl'), raw, 'utf-8')

    const r = await store.query(baseQuery())
    expect(r.total).toBe(2)
    expect(r.items.map((h) => h.topic.id)).toEqual(['g2', 'g1']) // 新→旧
  })

  it('空结果面：from > to 空区间 / 无文件的区间 / 目录不存在 → 空', async () => {
    await seedSpan()
    expect(await store.query(baseQuery({ fromDate: '2026-09-19', toDate: '2026-09-16' }))).toEqual({
      total: 0,
      items: []
    })
    expect(await store.query(baseQuery({ fromDate: '2030-01-01', toDate: '2030-01-02' }))).toEqual({
      total: 0,
      items: []
    })
    // 从未命中过的目录（listDays 目录不存在 → []）
    expect(await new HitsStore(join(dir, 'not-exist')).query(baseQuery())).toEqual({
      total: 0,
      items: []
    })
  })
})
