/**
 * 标题相似度（R5-P1b / ultrabrain DEC-4）——"近期已推"窗口的纯计算部分。
 *
 * 背景：论坛同一活动被反复转发，标题多为**装饰级变体**——大小写、全角/半角、
 * emoji、`[分享]`/`【转发】` 之类前后缀装饰符变了，正文主体一致。推送成功后的
 * 标题进引擎侧维护的 48h"近期已推"窗口；新命中帖推送前查相似——相似则入
 * seen 不推（判定与窗口生命周期都在引擎侧，R5-P2a）。本模块只做纯计算，
 * 零 IO、零 electron 依赖（对齐 matcher.ts，ADR 2）。
 *
 * 算法口径：normalizeTitle 压成规范形 → trigrams 取 3-gram 滑窗集合 →
 * jaccard 求集合相似度 → 与阈值比较。归一化后长度 < SHORT_TITLE_GUARD 的
 * 标题不参与判定（短标题 trigram 误伤率高，如 "vps" vs "vps2"）。
 *
 * 已知边界（给引擎/P2a 的预期管理）：字符 trigram 抓得住装饰级变体；换词级
 * 转发（`99/年 白嫖` → `99一年 优惠码`）Jaccard 只有 ~0.2，0.72 阈值下**不会**
 * 命中——那类重复是 AI 语义通道（或引擎降阈值）的取舍，不是本模块的 bug。
 */
// 目标环境 Node >= 22 / Chromium：正则 Unicode property（\p{L} 等 + u 标志）可用

/**
 * 归一化后短于此长度的标题不参与相似判定。
 * 两个方向都生效：待判标题归一后 < 6 → 恒 false；
 * "近期已推"窗口里归一后 < 6 的条目 → 跳过比较。
 */
export const SHORT_TITLE_GUARD = 6

/**
 * 标题归一化（幂等：normalizeTitle(normalizeTitle(x)) === normalizeTitle(x)）。
 *
 * 步骤：
 * 1. 转小写（对中文无影响，全角字母 toLowerCase 已顺手变小写全角）；
 * 2. 全角 ASCII 变体区 U+FF01–U+FF5E 线性映射 -0xFEE0 → 半角 ASCII
 *    （ＶＰＳ→vps、９９→99；【】等 CJK 标点不在此区，由下一步统一处理）；
 * 3. 非「字母 / 数字 / 空格」一律替换成空格：emoji（\p{Extended_Pictographic}
 *    及其组合序列）、标点、装饰符（[]【】()·*!？?¥/$// 等）、各类 Unicode
 *    空白（U+3000 全角空格、\t、\n）都变成词边界——符号是"当空格用"而非
 *    "当不存在用"，保留分词信息（`99/年` → `99 年`，不是 `99年`）；
 *    \p{L} 已覆盖中日韩文字（Lo）；
 * 4. 连续空白折叠为单空格、trim。
 */
export function normalizeTitle(title: string): string {
  return (
    title
      .toLowerCase()
      // 全角 ASCII → 半角（U+FF01..U+FF5E 与 U+0021..U+007E 一一对应，差 0xFEE0）
      .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/[^\p{L}\p{N} ]/gu, ' ')
      .replace(/ {2,}/g, ' ')
      .trim()
  )
}

/**
 * 3-gram 滑窗集合。按**码点**切字符（`Array.from`），中文/表意文字不被
 * 劈成代理对半截；空格也是字符，参与滑窗（保留词边界信息）。
 * 长度 < 3 的串返回其自身单项集合（空串则返回 `{""}`）。
 */
export function trigrams(s: string): Set<string> {
  const chars = Array.from(s)
  if (chars.length < 3) return new Set([s])
  const grams = new Set<string>()
  for (let i = 0; i + 3 <= chars.length; i++) {
    grams.add(chars[i] + chars[i + 1] + chars[i + 2])
  }
  return grams
}

/**
 * 集合 Jaccard 相似度：|A∩B| / |A∪B|。
 * 两空集（并集为空）约定为 1——"全等的空"；一空一非空为 0。
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let intersection = 0
  for (const gram of a) {
    if (b.has(gram)) intersection++
  }
  return intersection / (a.size + b.size - intersection)
}

/**
 * 判定 title 是否与"近期已推"窗口里的任一标题相似（相似 → 引擎放弃推送、入 seen）。
 *
 * 契约（重要，防双重归一口径漂移）：
 * - `title` 传**原始标题**，函数内部自行 normalizeTitle；
 * - `recentTitles` 必须是调用方**已用 normalizeTitle 归一化过**的标题——引擎在
 *   标题入窗时归一一次，之后每轮直接传窗口内容即可。normalizeTitle 是幂等的，
 *   传了已归一的串再归一次结果不变（只是浪费），但**传未归一的原始串**会按
 *   原样切 trigram，装饰符会拉低相似度，属于契约违例；
 * - `threshold` 由引擎决定（R5 计划默认 0.72），比较为 `>=`（等于阈值算相似），
 *   本模块不校验其取值合理性。
 *
 * 短标题守卫双向生效（见 SHORT_TITLE_GUARD）。窗口为空 → 恒 false。
 */
export function isSimilarToAny(
  title: string,
  recentTitles: string[],
  threshold: number
): boolean {
  const normalized = normalizeTitle(title)
  if (normalized.length < SHORT_TITLE_GUARD) return false
  const target = trigrams(normalized)
  for (const recent of recentTitles) {
    if (recent.length < SHORT_TITLE_GUARD) continue
    if (jaccard(target, trigrams(recent)) >= threshold) return true
  }
  return false
}
