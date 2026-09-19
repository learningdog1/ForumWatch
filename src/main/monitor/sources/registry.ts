/**
 * 来源注册表（纯数据 + 纯函数，零 electron / 零 fs，D3）。
 *
 * v3 职责：来源类型 → 允许打开的外链域映射（ipc.ts 的 openExternal 白名单由此
 * 派生——只放行**已配置且 enabled** 的来源对应的域）。固定类型（nodeseek/v2ex）
 * 按类型查 SOURCE_DOMAINS 表；rss 没有固定域，**白名单从 source.url 的 host 派生**
 * （ultrabrain 坑3：白名单对新源类型失效——只扩 SOURCE_DOMAINS 不够，rss 必须
 * 走 url 派生）。未来新增固定域来源类型时在 SOURCE_DOMAINS 登记；adapter 工厂
 * 在装配方登记。
 */
import type { AppConfig, SourceType } from '../../../shared/types'

/** 有固定外链域的来源类型（rss 无固定域：白名单从其 url host 派生） */
export type FixedDomainSourceType = Exclude<SourceType, 'rss'>

/**
 * 各固定域来源类型的可打开外链域（裸域；子域由 isHostAllowed 的匹配规则覆盖）。
 * nodeseek → nodeseek.com 及其子域；v2ex → v2ex.com 及其子域。
 */
export const SOURCE_DOMAINS: Record<FixedDomainSourceType, string[]> = {
  nodeseek: ['nodeseek.com'],
  v2ex: ['v2ex.com']
}

/**
 * 从配置派生允许的外链域列表：只取 `sources` 中 enabled 项对应的域，去重
 * （同域多 source 只贡献一份）。未启用（或未配置）的类型不放行。
 * - nodeseek / v2ex：按类型查 SOURCE_DOMAINS；
 * - rss：解析 `source.url` 取 host 加入白名单（new URL 解析；失败则跳过该项——
 *   防御性，sanitize 本应已拦非法 url）。
 */
export function allowedExternalDomains(cfg: Pick<AppConfig, 'sources'>): string[] {
  const domains = new Set<string>()
  for (const s of cfg.sources) {
    if (!s.enabled) continue
    if (s.type === 'rss') {
      try {
        const host = new URL(s.url).hostname // URL 规范化小写
        if (host !== '') domains.add(host)
      } catch {
        // 防御：sanitize 本应已拦非法 url，此处解析失败直接跳过该项
      }
      continue
    }
    for (const d of SOURCE_DOMAINS[s.type] ?? []) domains.add(d)
  }
  return [...domains]
}

/**
 * host 是否命中允许域：裸域相等或任意子域（`x.domain` / `x.y.domain`）。
 * 大小写不敏感（URL hostname 规范化为小写，这里防御性再降一次）。
 * 后缀伪造（`notnodeseek.com` / `nodeseek.com.evil.io`）不命中。
 */
export function isHostAllowed(host: string, allowedDomains: string[]): boolean {
  const h = host.toLowerCase()
  return allowedDomains.some((d) => {
    const dom = d.toLowerCase()
    return h === dom || h.endsWith('.' + dom)
  })
}
