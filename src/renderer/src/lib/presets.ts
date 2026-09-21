/**
 * 来源预设常量表（R4-W4「来源」卡片用）。
 *
 * 预设只描述「一键添加什么」：config 项（判别联合的合法成员）+ 展示文案。
 * 如实标注网络风险——linux.do / LowEndTalk 的 RSS 在部分网络会被 Cloudflare
 * 拦截，届时来源状态显示「Cloudflare 拦截」并自动指数退避，建议配合代理。
 * 是否已添加的判定按 id 匹配（见 presetAdded）；重复添加由 SourceCard 置灰拦下，
 * 主进程 sanitize 的 id 去重是最后防线。
 */
import type { SourceConfig } from '@shared/types'

export interface SourcePreset {
  /** 预设按钮文案 */
  name: string
  /** 一句话说明（含网络风险），随按钮 title / 描述区展示 */
  desc: string
  /** 点击添加时追加进 config.sources 的项（enabled: true） */
  config: SourceConfig
}

export const SOURCE_PRESETS: SourcePreset[] = [
  {
    name: 'V2EX',
    desc: '官方 API（/api/topics/latest.json，无需地址）；未认证限速约 120 次/小时，默认 60s 轮询在限内。',
    config: { id: 'v2ex', type: 'v2ex', enabled: true }
  },
  {
    name: 'Linux.do',
    desc: 'Discourse 最新主题 RSS。部分网络会被 Cloudflare 拦截：届时来源状态显示「Cloudflare 拦截」并自动退避，建议配合代理使用。',
    config: {
      id: 'linux-do',
      type: 'rss',
      url: 'https://linux.do/latest.rss',
      label: 'Linux.do',
      enabled: true
    }
  },
  {
    name: 'LowEndTalk',
    desc: 'Vanilla Forums 全站 RSS。部分网络会被 Cloudflare 拦截：届时来源状态显示「Cloudflare 拦截」并自动退避，建议配合代理使用。',
    config: {
      id: 'lowendtalk',
      type: 'rss',
      url: 'https://lowendtalk.com/discussions/feed.rss',
      label: 'LowEndTalk',
      enabled: true
    }
  },
  {
    // R13：offers 推送预设——用全站 feed（实测稳定 200，单条 feed 已覆盖多个
    // 优惠类分类；/categories/offers 端点的 Cloudflare 策略时变）+ 分类白名单，
    // 零 adapter 改动（rss.ts 已把 RSS <category> 填进 topic.category/
    // categorySlug，filters.ts 按显示名/slug 双口径匹配）。白名单保存后可在
    // 「来源 → 过滤」面板自行调整。与「LowEndTalk」全站预设按 id 区分
    // （presetAdded 不互斥）：两者同时启用时同一帖可能各推一次——去重键是
    // per-source 的，跨源双推靠默认相似降噪（0.72/48h 标题级）兜底吞重，
    // 建议二选一或停用其一。
    name: 'LowEndTalk Offers',
    desc:
      '全站 RSS + 分类白名单（Offers / Shared Hosting Offers / Giveaways & Freebies，保存后可在「过滤」面板调整），只推优惠帖。' +
      '与全站「LowEndTalk」来源同时启用时同帖可能各推一次（靠相似降噪吞重），建议二选一。' +
      '部分网络会被 Cloudflare 拦截，建议配合代理使用。',
    config: {
      id: 'lowendtalk-offers',
      type: 'rss',
      url: 'https://lowendtalk.com/discussions/feed.rss',
      label: 'LowEndTalk Offers',
      enabled: true,
      filters: {
        includeCategories: ['Offers', 'Shared Hosting Offers', 'Giveaways & Freebies']
      }
    }
  }
]

/**
 * 预设是否已被添加（按 id 匹配当前 sources 列表；enabled=false 也算已添加——
 * 禁用 ≠ 删除，预设按钮同样置灰）。
 */
export function presetAdded(preset: SourcePreset, sources: SourceConfig[]): boolean {
  return sources.some((s) => s.id === preset.config.id)
}

/**
 * url → 合法 host；非法（非 http(s) / 解析失败 / 无 host）返回 null。
 * 与主进程 sanitize 的 httpUrlHost 同判定口径（前端预检，红字提示不拦保存链路）。
 */
export function httpUrlHost(url: string): string | null {
  try {
    const parsed = new URL(url.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.hostname !== '' ? parsed.hostname : null
  } catch {
    return null
  }
}

/**
 * host → 来源 id slug（'lowendtalk.com' → 'lowendtalk-com'）。
 * 与主进程 slugifySourceId 同口径：非法字符替换 '-'。host 由 URL 解析而来，
 * 实际只含 [a-z0-9.-]，替换规则只为对齐主进程、不承担清洗职责。
 */
export function slugFromHost(host: string): string {
  return host.trim().replace(/[^A-Za-z0-9_-]+/g, '-')
}

/**
 * 从 host slug 生成不与现有来源冲突的 id：冲突时加 -2/-3/… 后缀。
 * 与主进程 sanitize 的「id 全列表去重（保留首个）」配合：前端先避开，
 * 后端兜底丢弃后者。
 */
export function uniqueSourceId(base: string, existing: SourceConfig[]): string {
  const taken = new Set(existing.map((s) => s.id))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}
