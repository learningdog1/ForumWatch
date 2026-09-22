/**
 * 演示话题数据构造脚本（R17 样例周报用，tsx 直跑，零 Electron）：
 *
 *   npm run sample:demo-data [-- --seed 17]
 *
 * 在系统临时目录（os.tmpdir() mkdtemp，绝不碰用户数据目录）构造**一周**演示
 * 话题存档 + 一份带 categoryReport 配置的 config.json，stdout 打印目录路径，
 * 供 sample-report.ts --config 消费（同一脚本同一代码路径生成周报样例）。
 *
 * 数据形状 = TopicRecord JSONL（topics-store 落盘同款，键 `${sourceId}:${topicId}`）：
 * - 期间：锚定今天（缺省 2026-09-21 周一）的上一完整周 周一~周日 7 个日桶；
 * - 三分类齐全（情报/交易/测评，nodeseek 来源，~190 帖 >60 触发 LLM 分段
 *   map-reduce 路径）；
 * - 交易标题带结构化价格（「年付 99 元 500G 流量」「$9.9/月 1TB」「20刀 年付」
 *   「USD 25 yearly」——extractDeal 五形态 + 周期 + 流量全口径覆盖）；
 * - 混入分类外（日常）与来源外（linux-do）记录演示过滤、置顶记录演示排除；
 * - 少量同标题多发（不同 topicId）演示「同帖多发」趋势段。
 *
 * config.json：categoryReport 显式开启三档 + appendix；ai.provider 写入本机
 * 代理地址与占位 key（明文无 enc marker，PlainSecretBox 原样透传 → provider
 * 三项齐备 → service 会真实尝试 LLM；占位 key 401 时走「AI 不可用整体降级」
 * 路径并如实记录——这正是要演示的韧性之一）。
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { periodFor } from '../src/main/ai/category-report'

/** 可复现伪随机（mulberry32）：同 seed 同数据，样例可重建 */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const AUTHORS = [
  '捡垃圾的老王', '机房蹲守员', '薅羊毛专业户', '杜甫门下走狗', '线路强迫症',
  '夜半装机人', '流量管家', '小鸡饲养员', '年付钉子户', '测速狂魔',
  '白嫖失败者', '回血小能手'
]

/** 交易类标题模板（{p} 价格 {t} 流量 {v} 变体词——覆盖 extractDeal 全形态） */
const DEAL_TEMPLATES = [
  '年付 {p2} 元 {t}G 流量 小机器返场补货',
  '[{v}] $ {p1}/月 {t2}TB 大流量 VPS 可惜是动态 IP',
  '{p1}刀 年付 CMI 优化线路 手慢无',
  'USD {p2} yearly 无限流量 但超速就限 5Mbps',
  '月付 {p2} 元 {t}G 流量的小鸡，跑路前最后一波',
  '¥ {p1}/年 {t2}TB 抗投诉主机 暂时只有卢村',
  '{p2} 元包年 {t}G 流量 + 独立 IPv4，评论区蹲实测',
  '[$ {p1}/mo] {t}G 流量 KVM 小盘鸡，月付可随时跑',
  '{v} 家年付 {p2} 元返场：{t}G 流量比上次多 100G',
  '3 年付 {p3} 元 {t2}TB 流量 一次买断防涨价'
]

/** 情报类标题模板（部分带价格/额度信息，部分纯快讯） */
const INFO_TEMPLATES = [
  '{v} 家黑五预热：新注册送 $ {p1} 额度，老用户眼红',
  '快讯：{v} 日本软银机房今晚割接，{t}G 流量套餐自动补偿 10%',
  '白嫖快讯：{v} 学生认证送 {p3} 元券，可叠加年付',
  '情报：{v} 家 {t2}TB 流量套餐悄悄涨价 {p2} 元 → {p3} 元',
  '活动：注册就送 {p2} 元余额的小厂，跑路风险自负',
  '{v} 家周年庆：续费一律 7 折，年付 {p2} 元档位最划算',
  '内部消息：{v} 下月上线 {t}G 流量 ¥ {p1}/月 的新套餐',
  '预警：{v} 家钱包维护 48h，趁早充值年付'
]

/** 测评类标题模板 */
const REVIEW_TEMPLATES = [
  '实测 {v} 家 {t}G 流量年付机：晚高峰 YouTube 4K 稳不稳',
  '[测评] $ {p1}/月 的 {v} 小鸡用了 30 天，说点真话',
  '{v} 家 {p2} 元年付机跑分：UnixBench 只有 {p3} 分，图个啥',
  '横评：三家 {t}G 流量年付 {p2} 元档，晚高峰丢包率对比',
  '翻车实测：{v} 家 {t2}TB 大流量月付机，高峰限速到 {p3}KB'
]

/** 同帖多发（固定标题 ×多天不同 topicId——演示「同帖多发」趋势段） */
const REPEATED_TITLES = [
  '年付 99 元 500G 流量 的小鸡又双叒补货了', // ×3（含中文数字混合价格形态）
  '杜甫 2C2G 年付 88 元 无限流量何时回归', // ×2
  '月付 9.9 元 200G 流量 学生机长期车' // ×2
]

const VARIANT_WORDS = ['甲壳虫', '蓝速', '橙云', '企鹅家', '星尘', '海雾', '石墨', '紫晶', '雷鸟', '雪松', '赤狐', '青藤']

/** 分类 → (category, categorySlug) */
const CATS: Record<string, { category: string; categorySlug: string }> = {
  info: { category: '情报', categorySlug: 'info' },
  trade: { category: '交易', categorySlug: 'trade' },
  review: { category: '测评', categorySlug: 'review' },
  daily: { category: '日常', categorySlug: 'daily' } // 分类外：被 categories 过滤
}

function pick<T>(arr: T[], rand: () => number): T {
  return arr[Math.floor(rand() * arr.length)]!
}

/** 用 Date 本地构造保证「文件名日 == firstSeenAt 本地日」（D5 坑④同款纪律） */
function isoAt(day: string, hh: number, mm: number, rand: () => number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return new Date(y, m - 1, d, hh, mm, Math.floor(rand() * 60)).toISOString()
}

function main(): void {
  const seedIdx = process.argv.indexOf('--seed')
  const seed = seedIdx !== -1 ? Number(process.argv[seedIdx + 1] ?? 17) : 17
  void build(seed).then(
    (dir) => {
      console.log(dir) // stdout 只有目录路径，便于 shell 捕获
      process.exit(0)
    },
    (err) => {
      console.error('fatal:', err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  )
}

async function build(seed: number): Promise<string> {
  const rand = rng(Number.isFinite(seed) ? seed : 17)
  const period = periodFor('weekly', new Date())
  const days: string[] = []
  for (let d = new Date(`${period.from}T00:00:00`); d <= new Date(`${period.to}T00:00:00`); d.setDate(d.getDate() + 1)) {
    days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
  }

  const root = await mkdtemp(join(tmpdir(), 'forumwatch-demo-'))
  const topicsDir = join(root, 'topics')
  await mkdir(topicsDir, { recursive: true })

  let topicSeq = 910000
  const counts = { info: 0, trade: 0, review: 0, daily: 0, otherSource: 0, pinned: 0, repeated: 0 }
  const repeatedPlan = new Map<number, string[]>() // dayIndex → titles due

  // 预排同帖多发计划：REPEATED_TITLES[i] 出现在 i+2 个不同日
  REPEATED_TITLES.forEach((title, i) => {
    const times = i === 0 ? 3 : 2
    const startDay = i
    for (let k = 0; k < times && startDay + k < days.length; k++) {
      const di = startDay + k
      repeatedPlan.set(di, [...(repeatedPlan.get(di) ?? []), title])
    }
  })

  for (let di = 0; di < days.length; di++) {
    const day = days[di]!
    const lines: string[] = []

    const emit = (
      catKey: keyof typeof CATS,
      title: string,
      opts: { pinned?: boolean; sourceId?: string } = {}
    ): void => {
      const cat = CATS[catKey]!
      const sourceId = opts.sourceId ?? 'nodeseek'
      const topicId = String(topicSeq++)
      lines.push(
        JSON.stringify({
          key: `${sourceId}:${topicId}`,
          sourceId,
          topicId,
          title,
          url:
            sourceId === 'nodeseek'
              ? `https://www.nodeseek.com/post-${topicId}-1`
              : `https://linux.do/t/topic/${topicId}`,
          author: pick(AUTHORS, rand),
          category: cat.category,
          categorySlug: cat.categorySlug,
          pinned: opts.pinned === true,
          lastActiveAt: isoAt(day, 20, 30, rand),
          excerpt: `${title} —— 演示摘要：该帖为 sample-demo-data 生成的演示数据。`,
          firstSeenAt: isoAt(day, 8 + Math.floor(rand() * 15), Math.floor(rand() * 60), rand)
        })
      )
    }

    // 同帖多发（按预排计划）
    for (const title of repeatedPlan.get(di) ?? []) {
      emit('trade', title)
      counts.repeated++
    }
    // 情报 10 + 交易 12 + 测评 5（三分类，量 >60 触发分段）
    for (let i = 0; i < 10; i++) {
      emit('info', fill(pick(INFO_TEMPLATES, rand), rand))
      counts.info++
    }
    for (let i = 0; i < 12; i++) {
      emit('trade', fill(pick(DEAL_TEMPLATES, rand), rand))
      counts.trade++
    }
    for (let i = 0; i < 5; i++) {
      emit('review', fill(pick(REVIEW_TEMPLATES, rand), rand))
      counts.review++
    }
    // 分类外（日常 ×3）与来源外（linux-do ×2）：演示 service 侧过滤
    for (let i = 0; i < 3; i++) {
      emit('daily', fill(pick(INFO_TEMPLATES, rand), rand))
      counts.daily++
    }
    for (let i = 0; i < 2; i++) {
      emit('info', fill(pick(INFO_TEMPLATES, rand), rand), { sourceId: 'linux-do' })
      counts.otherSource++
    }
    // 置顶 ×1：演示 pinnedExcluded 排除
    emit('trade', '【置顶】长期更新：本月各家年付价格一览表', { pinned: true })
    counts.pinned++

    await writeFile(join(topicsDir, `${day}.jsonl`), lines.map((l) => `${l}\n`).join(''), 'utf-8')
  }

  // config.json：categoryReport 显式开启；provider 写真实本机代理 + 占位 key
  // （明文无 marker → PlainSecretBox 透传 → providerConfigured=true → 真实尝试
  // LLM；401 即整体降级模板并在 stdout 记录原因——韧性演示点）
  const config = {
    schemaVersion: 4,
    config: {
      includeKeywords: ['演示'],
      pollIntervalSec: 60,
      channels: [{ id: 'telegram', type: 'telegram', enabled: true, botToken: '', chatId: '' }],
      notifyEnabled: false,
      sources: [{ id: 'nodeseek', type: 'nodeseek', enabled: true }],
      ai: {
        provider: {
          baseUrl: 'http://127.0.0.1:3051/v1',
          apiKey: 'demo-placeholder-key-not-valid',
          model: 'Qwen/Qwen3.8-Flash'
        },
        categoryReport: {
          enabled: true,
          sourceIds: ['nodeseek'],
          categories: ['情报', '交易', '测评'],
          appendix: true,
          daily: { enabled: true, timeHHMM: '22:30' },
          weekly: { enabled: true, timeHHMM: '08:00' },
          monthly: { enabled: true, timeHHMM: '08:30' }
        }
      }
    }
  }
  await writeFile(join(root, 'config.json'), JSON.stringify(config, null, 2), 'utf-8')

  console.error(
    `[demo-data] period ${period.from}..${period.to} (${days.length} days) → ${root}\n` +
      `[demo-data] in-category: 情报×${counts.info} 交易×${counts.trade} 测评×${counts.review}` +
      ` (另含同帖多发×${counts.repeated} 计入交易) = ${counts.info + counts.trade + counts.review + counts.repeated} 帖\n` +
      `[demo-data] filtered-out 预期: 分类外(日常)×${counts.daily} 来源外(linux-do)×${counts.otherSource} 置顶×${counts.pinned}`
  )
  return root
}

/** 模板填充：{p1} 9.9 / {p2} 99 / {p3} 1580 / {t} 500 / {t2} 2 / {v} 厂商名 */
function fill(tpl: string, rand: () => number): string {
  return tpl
    .replace(/\{p1\}/g, () => pick(['9.9', '12.5', '4.99', '19.9', '6.8'], rand))
    .replace(/\{p2\}/g, () => pick(['99', '88', '128', '156', '199', '79'], rand))
    .replace(/\{p3\}/g, () => pick(['1580', '999', '2999', '520', '888'], rand))
    .replace(/\{t2\}/g, () => pick(['1', '2', '4', '0.5'], rand))
    .replace(/\{t\}/g, () => pick(['500', '800', '1000', '300', '2000'], rand))
    .replace(/\{v\}/g, () => pick(VARIANT_WORDS, rand))
}

main()
