/**
 * 日报正文渲染器（R10 阶段 4，reports.md §5）：自写最小行内解析器，不引 markdown 库。
 * - 行内四语法（宽松解析，**永不吞内容**——未识别语法原文渲染）：
 *   `**粗体**` → strong、`` `代码` `` → code、`[文字](url)` → 链接（仅 http/https，
 *   括号不完整/其他协议原样）、`*斜体*` → em（首尾贴非空白，`2 * 3 * 4` 不误判）。
 *   全程 React 元素构造，**禁 dangerouslySetInnerHTML**（文本节点自动转义，无 XSS 面）。
 * - 块级：首个非空行是含「监控日报」的 # 标题 → 上提去重（信息由卡头承载，§5.3-1）；
 *   ## / ### 标题、列表、段落、「—— 数据说明」尾注弱化（fs-12 灰 + 上边框）；
 *   不满足上提条件的 h1 照常按 h2 层级渲染（LLM 偶发自拟标题时不丢）。
 * - 模板行结构化（§3.4-4）：`- HH:MM [分类] 标题（命中方式）「锐评」`（daily-report
 *   模板固定格式）拆为 时间 / 分类 chip / 标题 / 方式 / 锐评；不匹配回退普通列表行。
 * - 大数据量（千行模板日报）：块级 content-visibility 分块 + 块数 > 24 时的 ##
 *   分组导航 chips（阅读面不翻页，§3.4）；LLM 模式尾注缺失 → 末尾「可能不完整」
 *   截断提示（自家两套模板必有尾注；LLM 未按 prompt 收尾时允许误报——提示语含「可能」）。
 * - 链接点击走 openExternal：域名白名单由主进程按已配置来源派生裁决（本页不新增
 *   跳转通道），被拒 → 链接正下方行内 fs-12 提示，2.5s 后消失（§2.6-3）。
 *
 * 解析器抽为可独立导入的纯函数（parseInline / parseReport），单测直接测函数——
 * 渲染层无 DOM 测试环境（vitest environment: node），「永不吞内容」靠纯函数断言。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'

/** 链接被白名单拒绝后，行内提示的停留时长（reports.md §2.6-3） */
const LINK_HINT_MS = 2500
/** 块数超过该值才显示分组导航 chips（渐进披露：短文不需要目录，§3.4-2） */
const CHIPS_BLOCK_THRESHOLD = 24

// ---- 行内解析（纯函数） -------------------------------------------------------

/** 行内 token：text=原文渲染；strong/em/code=行内语法；link 仅 http/https */
export type InlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; url: string }

/**
 * 四语法单遍扫描（最早出现优先；同位置按 代码 → 粗体 → 斜体 → 链接 取舍）。
 * 斜体内容首尾须贴非空白字符（CommonMark 侧翼规则的精神：`2 * 3 * 4` 不成斜体）；
 * 链接 url 仅 http/https 且不含空白/半角右括号，其余一切按原文返回 text token。
 */
const INLINE_RE =
  /`([^`\n]+)`|\*\*(.+?)\*\*|\*(\S(?:[^*\n]*\S)?)\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g

/** 行内解析：未识别语法（表格管道符、单个 `*` / 反引号、残缺链接…）原文保留 */
export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = []
  let last = 0
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0
    if (idx > last) tokens.push({ kind: 'text', text: text.slice(last, idx) })
    if (m[1] !== undefined) tokens.push({ kind: 'code', text: m[1] })
    else if (m[2] !== undefined) tokens.push({ kind: 'strong', text: m[2] })
    else if (m[3] !== undefined) tokens.push({ kind: 'em', text: m[3] })
    else tokens.push({ kind: 'link', text: m[4] ?? '', url: m[5] ?? '' })
    last = idx + m[0].length
  }
  if (last < text.length) tokens.push({ kind: 'text', text: text.slice(last) })
  return tokens
}

// ---- 块级解析（纯函数） -------------------------------------------------------

/** 模板行（daily-report.ts fallbackReport 固定格式）：时间 [分类] 标题（方式）「锐评」 */
export interface TplRowItem {
  kind: 'tpl'
  time: string
  category: string
  title: string
  how: string
  remark: string | null
}
export type DocListItem = { kind: 'plain'; text: string } | TplRowItem

export type DocBlock =
  | { type: 'h2'; text: string; group: number }
  | { type: 'h3'; text: string }
  | { type: 'p'; text: string }
  | { type: 'list'; items: DocListItem[] }
  | { type: 'note'; text: string }

/** parseReport 的完整产物：块树 + 卡头元信息（§5.4 尽力解析，解析不到为 null） */
export interface ParsedReport {
  /** 上提去重的首 h1（含「监控日报」才上提；否则 null，该 h1 照常渲染） */
  promotedTitle: string | null
  blocks: DocBlock[]
  /** 全部 ## 标题（分组导航 chips；模板模式即来源分组） */
  groups: string[]
  /** 生成模式：尾注含「模板模式」→ template；存在「数据说明」→ ai；否则 null */
  mode: 'ai' | 'template' | null
  /** 头 10 行的命中数（"共 N 条"）；「今日无命中」= 0；解析不到 null */
  hitCount: number | null
  /** 卡头 aux 胶囊文案（"共 N 条命中" / "今日无命中"） */
  hitsSummary: string | null
  /** 截断检测（§3.4-3，LLM 模式专属）：非模板且无尾注 → 可能被 max_tokens 截断 */
  truncated: boolean
}

/** 模板行匹配：`HH:MM|--:-- [分类] 标题（命中方式）` + 可选「锐评」尾（§3.4-4） */
const TPL_ROW_RE = /^(--:--|\d{2}:\d{2}) \[(.+?)\] (.+)（(.+?)）(?:「(.*)」)?$/

const BULLET_RE = /^\s*[-*]\s+(.*)$/
const HEADING_RE = /^(#{1,3})\s+(.*)$/

/**
 * 日报 markdown → 块树 + 元信息。逐行扫描（标题 / 列表 / 段落 / 尾注），
 * 连续非空文本行合并为一段（沿用旧 renderDoc 行为）；一切未识别形态原样保留。
 */
export function parseReport(md: string): ParsedReport {
  const lines = md.split('\n')
  const blocks: DocBlock[] = []
  const groups: string[] = []
  let promotedTitle: string | null = null
  let seenContent = false
  let para: string[] = []
  let list: DocListItem[] = []

  const flushPara = (): void => {
    if (para.length > 0) {
      blocks.push({ type: 'p', text: para.join(' ') })
      para = []
    }
  }
  const flushList = (): void => {
    if (list.length > 0) {
      blocks.push({ type: 'list', items: list })
      list = []
    }
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (line.trim() === '') {
      flushPara()
      flushList()
      continue
    }
    // 首 h1 上提去重（§5.3-1）：首个非空行是含「监控日报」的 # 标题 → 不进正文
    if (!seenContent) {
      seenContent = true
      const firstH1 = /^#\s+(.*)$/.exec(line)
      if (firstH1 != null && firstH1[1].includes('监控日报')) {
        promotedTitle = firstH1[1].trim()
        continue
      }
    }
    const heading = HEADING_RE.exec(line)
    if (heading != null) {
      flushPara()
      flushList()
      const text = heading[2].trim()
      if (heading[1].length <= 2) {
        // # 与 ## 都落在 h2 层级（doc-h1 的 fs-20 参数已上提卡头，正文不再有 h1）
        groups.push(text)
        blocks.push({ type: 'h2', text, group: groups.length - 1 })
      } else {
        blocks.push({ type: 'h3', text })
      }
      continue
    }
    if (line.startsWith('——')) {
      flushPara()
      flushList()
      blocks.push({ type: 'note', text: line.replace(/^——\s*/, '') })
      continue
    }
    const bullet = BULLET_RE.exec(line)
    if (bullet != null) {
      flushPara()
      const item = bullet[1].trim()
      const tpl = TPL_ROW_RE.exec(item)
      if (tpl != null) {
        list.push({
          kind: 'tpl',
          time: tpl[1],
          category: tpl[2],
          title: tpl[3],
          how: tpl[4],
          remark: tpl[5] ?? null
        })
      } else {
        list.push({ kind: 'plain', text: item })
      }
      continue
    }
    flushList()
    para.push(line.trim())
  }
  flushPara()
  flushList()

  // 元信息（§5.4）：全部尽力解析——LLM 输出不含则不展示，不强求
  const head = lines.slice(0, 10).join('\n')
  const hm = /共\s*(\d+)\s*条/.exec(head)
  const hitCount = hm != null ? Number(hm[1]) : head.includes('今日无命中') ? 0 : null
  const hitsSummary =
    hm != null ? `共 ${hm[1]} 条命中` : hitCount === 0 ? '今日无命中' : null
  const mode: ParsedReport['mode'] = lines.some((l) => l.includes('模板模式'))
    ? 'template'
    : lines.some((l) => l.includes('数据说明'))
      ? 'ai'
      : null
  // 截断检测：自家两套模板（零命中/降级拼接）结尾必有「—— 数据说明」尾注，
  // 尾注缺失且非模板 → 只能是 LLM 输出被 REPORT_MAX_TOKENS 截断（允许误报）
  const hasNote = blocks.some((b) => b.type === 'note')
  const truncated = mode !== 'template' && !hasNote && blocks.length > 0

  return { promotedTitle, blocks, groups, mode, hitCount, hitsSummary, truncated }
}

// ---- 渲染 ---------------------------------------------------------------------

/** 行内 token → React 节点（纯文本直达 React 文本节点，自动转义） */
function renderInline(text: string): ReactNode {
  const tokens = parseInline(text)
  if (tokens.length === 1 && tokens[0].kind === 'text') return tokens[0].text
  return tokens.map((t, i) => {
    switch (t.kind) {
      case 'strong':
        return <strong key={i}>{t.text}</strong>
      case 'em':
        return <em key={i}>{t.text}</em>
      case 'code':
        return (
          <code key={i} className="doc-code">
            {t.text}
          </code>
        )
      case 'link':
        return <DocLink key={i} text={t.text} url={t.url} />
      default:
        return t.text
    }
  })
}

/**
 * 正文链接：渲染层只做协议白名单（http/https，已在 parseInline 保证）；域名
 * 白名单在主进程按已配置来源派生裁决。被拒 → 正下方行内提示，2.5s 后消失。
 */
function DocLink(props: { text: string; url: string }) {
  const [rejected, setRejected] = useState(false)
  const timerRef = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current)
    },
    []
  )
  function open(e: ReactMouseEvent<HTMLAnchorElement>): void {
    e.preventDefault()
    void window.api
      .openExternal(props.url)
      .then((r) => {
        if (r !== undefined && r.ok) return
        setRejected(true)
        if (timerRef.current != null) window.clearTimeout(timerRef.current)
        timerRef.current = window.setTimeout(() => setRejected(false), LINK_HINT_MS)
      })
      .catch(() => {
        /* IPC 契约本不 reject；真异常时静默（不打断阅读） */
      })
  }
  return (
    <span className="doc-link-wrap">
      <a className="doc-link" href={props.url} title={props.url} onClick={open}>
        {props.text}
      </a>
      {rejected && (
        <span className="doc-link-hint" role="status">
          该链接域名不在已配置来源的允许列表内，未打开
        </span>
      )}
    </span>
  )
}

/** 模板行结构化渲染：时间（mono+tnum）+ 分类 chip + 标题 + 方式 + 锐评（§3.4-4） */
function TplRow(props: { item: TplRowItem }) {
  const it = props.item
  return (
    <span className="tpl-row">
      <span className="tpl-time num">{it.time}</span>
      <span className="tpl-cat">{it.category}</span>
      <span className="tpl-title">{renderInline(it.title)}</span>
      <span className="tpl-how">{it.how}</span>
      {it.remark != null && <span className="tpl-remark">「{it.remark}」</span>}
    </span>
  )
}

/** 单个块级容器；屏外块由 .cv-block / .cv-block-list 的 content-visibility 跳过布局 */
function renderBlock(b: DocBlock, key: number): ReactNode {
  switch (b.type) {
    case 'h2':
      return (
        <div key={key} className="doc-h2 cv-block" data-group={b.group}>
          {renderInline(b.text)}
        </div>
      )
    case 'h3':
      return (
        <div key={key} className="doc-h3 cv-block">
          {renderInline(b.text)}
        </div>
      )
    case 'p':
      return (
        <p key={key} className="doc-p cv-block">
          {renderInline(b.text)}
        </p>
      )
    case 'note':
      return (
        <div key={key} className="doc-note cv-block">
          {renderInline(b.text)}
        </div>
      )
    case 'list':
      return (
        <ul key={key} className="doc-list cv-block-list">
          {b.items.map((it, i) => (
            <li key={i}>{it.kind === 'tpl' ? <TplRow item={it} /> : renderInline(it.text)}</li>
          ))}
        </ul>
      )
  }
}

export function ReportDoc(props: { markdown: string; onGoHistory?: () => void }) {
  const parsed = useMemo(() => parseReport(props.markdown), [props.markdown])
  const rootRef = useRef<HTMLDivElement | null>(null)

  /** 点击分组 chip → 平滑定位到对应 ## 块（reduced-motion 直接瞬移，§3.4-2） */
  function scrollToGroup(i: number): void {
    const el = rootRef.current?.querySelector(`[data-group="${i}"]`)
    el?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
      block: 'start'
    })
  }

  const showChips = parsed.blocks.length > CHIPS_BLOCK_THRESHOLD && parsed.groups.length > 0

  return (
    <div className="doc" ref={rootRef}>
      {showChips && (
        <div className="doc-chips" role="group" aria-label="分组导航">
          {parsed.groups.map((g, i) => (
            <button type="button" key={i} className="doc-chip" title={g} onClick={() => scrollToGroup(i)}>
              {g}
            </button>
          ))}
        </div>
      )}
      {parsed.blocks.map((b, i) => renderBlock(b, i))}
      {parsed.truncated && (
        <div className="doc-trunc">
          这篇日报可能不完整（命中较多时 AI 摘要可能被截断）。可重新生成，或
          {props.onGoHistory != null && (
            <button type="button" className="disp-link" onClick={props.onGoHistory}>
              查看该日命中明细 →
            </button>
          )}
        </div>
      )}
    </div>
  )
}
