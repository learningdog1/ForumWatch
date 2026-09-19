/**
 * 来源注册表（纯数据 + 纯函数，零 electron / 零 fs，D3）。
 *
 * v2 职责：来源类型 → 允许打开的外链域映射（ipc.ts 的 openExternal 白名单由此
 * 派生——只放行**已配置且 enabled** 的来源类型对应的域）。未来新增来源类型
 * （RSS/API 备选实现）时在此登记类型→域与 adapter 工厂。
 */
import type { AppConfig, SourceType } from '../../../shared/types'

/**
 * 各来源类型的可打开外链域（裸域；子域由 isHostAllowed 的匹配规则覆盖）。
 * v2 仅 nodeseek → nodeseek.com 及其子域。
 */
export const SOURCE_DOMAINS: Record<SourceType, string[]> = {
  nodeseek: ['nodeseek.com']
}

/**
 * 从配置派生允许的外链域列表：只取 `sources` 中 enabled 项的类型对应域，
 * 去重（同类型多 source 只贡献一份）。未启用（或未配置）的类型不放行。
 */
export function allowedExternalDomains(cfg: Pick<AppConfig, 'sources'>): string[] {
  const domains = new Set<string>()
  for (const s of cfg.sources) {
    if (!s.enabled) continue
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
