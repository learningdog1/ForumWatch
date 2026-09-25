/**
 * 报告 markdown → 推送正文渲染（R19）：日报/分类报告的 markdown 在**推送前**
 * 转成两种形态，一次生成、各通道自取——
 * - Telegram HTML（parse_mode='HTML' 支持的子集：粗体/斜体/行内代码/链接/
 *   blockquote/pre；markdown 的 # 标题、表格、列表在 TG **没有对应语法**，
 *   原样发送就是用户看到的 `#`、`|---|` 裸奔，这是本模块存在的理由）；
 * - 纯文本（bark/ntfy/webhook 与 HTML 超长兜底）：去 markdown 记号，表格
 *   按显示宽度对齐（CJK 双宽）。
 *
 * 只覆盖两个报告服务实际会产出的 markdown 子集（标题/粗体/斜体/行内代码/
 * 链接/无序有序列表/引用块/管道表格/水平线/围栏代码），不做通用 markdown——
 * 未识别的行按普通文本行透传（转义），不丢内容。
 *
 * 渲染是**纯函数**：同一输入恒同一输出（与 category-stats 同款约定），单测
 * 全量覆盖；切分复用 daily-report 的 splitForTelegram（行边界聚合 + 硬切
 * 超长单行），HTML 转换后按 HTML_SAFE_MAX 兜底——超限段退纯文本，绝不因
 * 4096 上限推送失败。
 */

import { escapeHtml } from './telegram'

/** 报告推送段（推送前已切分）的双形态：text=纯文本兜底（所有通道），html='' 表示该段退纯文本 */
export interface ReportPushPair {
  text: string
  html: string
}

/**
 * 推送段的 markdown 长度上限：比 splitForTelegram 默认 3500 更保守——HTML
 * 标签与实体转义会让正文膨胀（每个标题 +7、每个 & +4），3000 + 膨胀仍留在
 * Telegram sendMessage 单条 4096（UTF-16）之内。
 */
export const REPORT_CHUNK_MAX = 3000

/** 转换后 HTML 的安全上限（4096 减去余量）：超过即判该段退纯文本（绝不发送失败） */
export const HTML_SAFE_MAX = 4000

/**
 * 行内记号（一次正则捕获，split 出奇偶下标交替：偶=普通文本、奇=命中记号）：
 * 粗体优先于斜体（否则 ** 会被斜体吃掉一半）；markdown 链接先于裸 URL（`[t](u)`
 * 整体命中，u 不会被裸 URL 规则二次切）；裸 URL 排除空白与常见中英文右标点
 * （。）】」等不作 URL 一部分，行尾中文句号不吞进链接）。
 */
const INLINE_RE =
  /(\*\*[^*\n]+\*\*|\*\S(?:[^*\n]*\S)?\*|`[^`\n]+`|\[[^\]\n]*\]\([^)\n]+\)|https?:\/\/[^\s<>）)】\]。，、；！？：」』"]+)/g

/** 行内记号 → Telegram HTML（普通文本段过 escapeHtml，记号段按类型包裹） */
function inlineHtml(text: string): string {
  return text
    .split(INLINE_RE)
    .map((part, idx) => {
      if (idx % 2 === 0) return escapeHtml(part)
      if (part.startsWith('**')) return `<b>${escapeHtml(part.slice(2, -2))}</b>`
      if (part.startsWith('`')) return `<code>${escapeHtml(part.slice(1, -1))}</code>`
      if (part.startsWith('[')) {
        const m = /^\[([^\]]*)\]\(([^)]+)\)$/.exec(part)
        if (m === null) return escapeHtml(part) // 形状不符（理论不可达）：按普通文本
        return `<a href="${escapeHtml(m[2]!)}">${escapeHtml(m[1]!)}</a>`
      }
      // 裸 URL（HTML 模式显式链接化——正文 URL 在 HTML parse_mode 下的客户端
      // 自动识别不可依赖；纯文本模式由 Telegram 原生识别，无需包裹）
      if (/^https?:\/\//.test(part)) {
        return `<a href="${escapeHtml(part)}">${escapeHtml(part)}</a>`
      }
      return `<i>${escapeHtml(part.slice(1, -1))}</i>`
    })
    .join('')
}

/** 行内记号 → 纯文本（剥粗体、斜体、行内代码包裹；链接取「文字 (url)」保留可跳转性） */
function inlinePlain(text: string): string {
  return text
    .split(INLINE_RE)
    .map((part, idx) => {
      if (idx % 2 === 0) return part
      if (part.startsWith('**')) return part.slice(2, -2)
      if (part.startsWith('`')) return part.slice(1, -1)
      if (part.startsWith('[')) {
        const m = /^\[([^\]]*)\]\(([^)]+)\)$/.exec(part)
        if (m === null) return part
        return m[1] !== '' ? `${m[1]} (${m[2]!})` : m[2]!
      }
      if (/^https?:\/\//.test(part)) return part // 裸 URL 原样（TG 纯文本原生可点）
      return part.slice(1, -1)
    })
    .join('')
}

/** 单个字符的终端显示宽度（CJK/全角/emoji = 2，其余 = 1）——表格对齐用 */
function charWidth(ch: string): number {
  const cp = ch.codePointAt(0)!
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首/标点
    (cp >= 0x3041 && cp <= 0x33ff) || // 假名/注音/兼容
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 基本
    (cp >= 0xa000 && cp <= 0xa4cf) || // 彝文/傣文
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul 音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角形式
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji（报告小节标题大量使用）
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展 B+
  ) {
    return 2
  }
  return 1
}

function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) w += charWidth(ch)
  return w
}

/** 右侧补空格到目标显示宽度（对齐用；已超宽原样返回） */
function padWidth(s: string, w: number): string {
  const cur = displayWidth(s)
  return cur >= w ? s : s + ' '.repeat(w - cur)
}

/** 管道表格行 → 单元格数组（剥首尾边框管道；cells 已 trim） */
function parseTableRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

/** 表格分隔行（`| --- | :---: |`）：所有单元格都是 :---: 形态 */
function isTableSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c))
}

/**
 * 管道表格渲染：剥分隔行、按显示宽度对齐各列、表头下加分隔线——markdown 表格
 * 在 Telegram 没有对应语法，HTML 模式包 `<pre>`（等宽对齐可读），纯文本模式
 * 输出同样的对齐文本。
 */
function renderTable(rawLines: string[], mode: 'html' | 'plain'): string {
  const rows = rawLines
    .map(parseTableRow)
    .filter((cells) => !isTableSeparatorRow(cells))
  if (rows.length === 0) {
    // 防御：解析不出任何数据行（理论不可达，行都以 | 开头）→ 原样透传
    return mode === 'html' ? escapeHtml(rawLines.join('\n')) : rawLines.join('\n')
  }
  const width = Math.max(...rows.map((r) => r.length))
  const colWidths: number[] = []
  for (let c = 0; c < width; c++) {
    colWidths.push(Math.max(...rows.map((r) => displayWidth(r[c] ?? ''))))
  }
  const lines = rows.map((r) =>
    r.map((cell, i) => padWidth(cell, colWidths[i]!)).join(' │ ')
  )
  const total = colWidths.reduce((s, w) => s + w, 0) + ' │ '.length * (width - 1)
  lines.splice(1, 0, '─'.repeat(Math.max(total, 8)))
  const joined = lines.join('\n')
  return mode === 'html' ? `<pre>${escapeHtml(joined)}</pre>` : joined
}

/** 块级渲染主循环：逐行识别围栏/表格/标题/引用/列表/水平线，其余按普通行透传 */
function renderBlocks(md: string, mode: 'html' | 'plain'): string {
  const inline = mode === 'html' ? inlineHtml : inlinePlain
  const lines = md.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    // 围栏代码块：``` 开闭之间的行原样（HTML 模式 <pre> 包裹转义内容）
    if (/^\s*```/.test(line)) {
      const buf: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) {
        buf.push(lines[i]!)
        i++
      }
      i++ // 跳过闭合围栏（或 EOF）
      const joined = buf.join('\n')
      out.push(mode === 'html' ? `<pre>${escapeHtml(joined)}</pre>` : joined)
      continue
    }
    // 管道表格连续段
    if (/^\s*\|/.test(line)) {
      const tbl: string[] = []
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) {
        tbl.push(lines[i]!)
        i++
      }
      out.push(renderTable(tbl, mode))
      continue
    }
    // ATX 标题：# × 1-6（Telegram 无标题语法 → 粗体行；纯文本去 # 前缀）
    const h = /^(#{1,6})\s+(.*\S)\s*$/.exec(line)
    if (h !== null) {
      out.push(mode === 'html' ? `<b>${inline(h[2]!)}</b>` : inlinePlain(h[2]!))
      i++
      continue
    }
    // 水平线（独立成行的 ---/***/___）
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('─'.repeat(16))
      i++
      continue
    }
    // 引用块连续段（> 开头）→ blockquote（纯文本剥 > 前缀）
    if (/^\s*>/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i]!)) {
        buf.push(lines[i]!.replace(/^\s*>\s?/, ''))
        i++
      }
      if (mode === 'html') {
        out.push(`<blockquote>${buf.map((l) => inlineHtml(l)).join('\n')}</blockquote>`)
      } else {
        out.push(buf.map((l) => inlinePlain(l)).join('\n'))
      }
      continue
    }
    // 列表项（- / * / + / 1.）：无序统一 •，有序保留编号；Telegram 无列表语法
    const li = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line)
    if (li !== null) {
      const bullet = /^[-*+]$/.test(li[2]!) ? '•' : `${li[2]!.replace(/[.)]$/, '.')}`
      out.push(`${li[1]!}${bullet} ${inline(li[3]!)}`)
      i++
      continue
    }
    // 普通行（含空行）：转义透传，换行由 Telegram 按字面保留
    out.push(inline(line))
    i++
  }
  return out.join('\n')
}

/** 报告 markdown → Telegram HTML（parse_mode='HTML' 子集；调用方负责长度兜底） */
export function markdownToTelegramHtml(md: string): string {
  return renderBlocks(md, 'html')
}

/** 报告 markdown → 纯文本（bark/ntfy/webhook 用：去记号、表格对齐） */
export function markdownToPlain(md: string): string {
  return renderBlocks(md, 'plain')
}

/**
 * 一个**已切分**的推送段 → 双形态：text 恒为纯文本（所有通道的兜底与
 * bark/ntfy/webhook 的唯一形态）；html 超过 HTML_SAFE_MAX 时置 ''（调用方
 * 对 '' 段退纯文本发送，绝不因 Telegram 4096 上限失败）。
 */
export function reportPushPair(markdownChunk: string): ReportPushPair {
  const html = markdownToTelegramHtml(markdownChunk)
  return { text: markdownToPlain(markdownChunk), html: html.length <= HTML_SAFE_MAX ? html : '' }
}
