/**
 * markdown-report 单测（R19）：报告 markdown → 推送双形态渲染。
 *
 * 覆盖：标题/粗体/斜体/行内代码/链接/列表/引用块/管道表格/水平线/围栏代码的
 * HTML 与纯文本两种渲染、HTML 转义、CJK 对齐、reportPushPair 的超长兜底。
 * 渲染是纯函数（同一输入恒同一输出），全部断言字面输出。
 */
import { describe, expect, it } from 'vitest'
import {
  HTML_SAFE_MAX,
  markdownToPlain,
  markdownToTelegramHtml,
  reportPushPair
} from './markdown-report'

describe('markdownToTelegramHtml：块级', () => {
  it('ATX 标题 → 粗体行（# 前缀剥除，1-6 级同款）', () => {
    expect(markdownToTelegramHtml('# 日报标题')).toBe('<b>日报标题</b>')
    expect(markdownToTelegramHtml('## 🧠 总评')).toBe('<b>🧠 总评</b>')
    expect(markdownToTelegramHtml('### 三级')).toBe('<b>三级</b>')
  })

  it('无序列表 → • 前缀；有序列表保留编号', () => {
    expect(markdownToTelegramHtml('- 项一\n- 项二')).toBe('• 项一\n• 项二')
    expect(markdownToTelegramHtml('* 星号项')).toBe('• 星号项')
    expect(markdownToTelegramHtml('1. 第一步\n2. 第二步')).toBe('1. 第一步\n2. 第二步')
  })

  it('引用块连续段 → blockquote（多行合并、> 前缀剥除）', () => {
    expect(markdownToTelegramHtml('> ⚠️ 模板模式（AI 不可用）：统计兜底\n> 第二行')).toBe(
      '<blockquote>⚠️ 模板模式（AI 不可用）：统计兜底\n第二行</blockquote>'
    )
  })

  it('水平线（--- / ***）→ 分隔线字符', () => {
    expect(markdownToTelegramHtml('上文\n\n---\n\n下文')).toBe('上文\n\n────────────────\n\n下文')
  })

  it('围栏代码块 → pre（内容转义）', () => {
    expect(markdownToTelegramHtml('```\na < b & c\n```')).toBe('<pre>a &lt; b &amp; c</pre>')
  })

  it('管道表格：剥分隔行、<pre> 包裹、表头下加分隔线、列宽对齐（含 CJK 双宽）', () => {
    const md = ['| 日期 | 交易 |', '| --- | --- |', '| 2026-09-24 | 445 |'].join('\n')
    const html = markdownToTelegramHtml(md)
    expect(html).toContain('<pre>')
    expect(html).toContain('</pre>')
    expect(html).not.toContain('---') // 分隔行被剥
    // 列对齐：col1 宽 = max('日期'=4, '2026-09-24'=10) = 10 → 日期补 6 空格
    expect(html).toContain('日期       │ 交易')
    expect(html).toContain('2026-09-24 │ 445 ')
    // 表头下有整宽分隔线（10 + 3 + 4 = 17 列）
    expect(html).toContain('─'.repeat(17))
  })

  it('空行与普通文本：按行保留（换行不由渲染器增删）', () => {
    expect(markdownToTelegramHtml('第一段\n\n第二段')).toBe('第一段\n\n第二段')
  })
})

describe('markdownToTelegramHtml：行内', () => {
  it('粗体/斜体/行内代码', () => {
    expect(markdownToTelegramHtml('**热点**')).toBe('<b>热点</b>')
    expect(markdownToTelegramHtml('*斜体*')).toBe('<i>斜体</i>')
    expect(markdownToTelegramHtml('`code`')).toBe('<code>code</code>')
    // 粗体优先于斜体：**热点** 不会被斜体规则吃掉一半
    expect(markdownToTelegramHtml('**热点**和*斜体*')).toBe('<b>热点</b>和<i>斜体</i>')
  })

  it('HTML 转义：& < > 在普通文本与记号内容里都转义', () => {
    expect(markdownToTelegramHtml('A & B < C > D')).toBe('A &amp; B &lt; C &gt; D')
    expect(markdownToTelegramHtml('**a&b<c**')).toBe('<b>a&amp;b&lt;c</b>')
  })

  it('markdown 链接 → <a>（href 与文字都转义）；裸 URL 显式链接化（R19b）', () => {
    expect(markdownToTelegramHtml('[帖子](https://a.com/x?y=1&z=2)')).toBe(
      '<a href="https://a.com/x?y=1&amp;z=2">帖子</a>'
    )
    // 裸 URL → <a>（HTML parse_mode 下客户端自动识别不可依赖，显式包裹才稳）
    expect(markdownToTelegramHtml('详见 https://a.com/p/1')).toBe(
      '详见 <a href="https://a.com/p/1">https://a.com/p/1</a>'
    )
    // URL 带查询参数（& 转义）与行尾中文句号（不吞进 URL）
    expect(markdownToTelegramHtml('https://a.com/x?y=1&z=2。完')).toBe(
      '<a href="https://a.com/x?y=1&amp;z=2">https://a.com/x?y=1&amp;z=2</a>。完'
    )
    // markdown 链接优先：[t](u) 整体命中，u 不被裸 URL 规则二次切
    expect(markdownToTelegramHtml('看 [帖子](https://a.com/p/1) 即可')).toBe(
      '看 <a href="https://a.com/p/1">帖子</a> 即可'
    )
  })

  it('行内代码优先保护：`**` 在代码内不再当粗体', () => {
    expect(markdownToTelegramHtml('`**not bold**`')).toBe('<code>**not bold**</code>')
  })
})

describe('markdownToPlain（bark/ntfy/webhook 与 HTML 超长兜底）', () => {
  it('剥标题/粗体/斜体/行内代码记号；链接保留可跳转形态；裸 URL 原样（TG 纯文本原生可点）', () => {
    expect(markdownToPlain('## 🧠 总评\n- **热点**：`低价` 涌现')).toBe(
      '🧠 总评\n• 热点：低价 涌现'
    )
    expect(markdownToPlain('[帖子](https://a.com)')).toBe('帖子 (https://a.com)')
    expect(markdownToPlain('详见 https://a.com/p/1。')).toBe('详见 https://a.com/p/1。')
  })

  it('引用块剥 > 前缀；表格同样对齐（无 pre 包裹）', () => {
    expect(markdownToPlain('> ⚠️ 模板模式')).toBe('⚠️ 模板模式')
    const md = ['| 日期 | 交易 |', '| --- | --- |', '| 2026-09-24 | 445 |'].join('\n')
    const plain = markdownToPlain(md)
    expect(plain).not.toContain('<pre>')
    expect(plain).toContain('2026-09-24 │ 445')
  })
})

describe('reportPushPair（推送段双形态）', () => {
  it('常规件：text=纯文本、html=HTML 渲染', () => {
    const pair = reportPushPair('## 🧠 总评\n本期 679 帖。')
    expect(pair.text).toBe('🧠 总评\n本期 679 帖。')
    expect(pair.html).toBe('<b>🧠 总评</b>\n本期 679 帖。')
  })

  it('HTML 膨胀超 HTML_SAFE_MAX → html 置空退纯文本（绝不发送失败）', () => {
    // 600 行标题：markdown ~1.8k 字符，HTML 每行 +7 标签字符 → ~6k > 上限
    const md = Array.from({ length: 600 }, () => '# a').join('\n')
    const pair = reportPushPair(md)
    expect(markdownToTelegramHtml(md).length).toBeGreaterThan(HTML_SAFE_MAX) // 前置：确实超限
    expect(pair.html).toBe('')
    expect(pair.text).not.toContain('#') // 纯文本兜底也已剥记号
  })
})

describe('端到端：一期报告正文的双形态渲染（R19 结构）', () => {
  const report = [
    '# 📰 分类行情报告 · 2026-09-24',
    '',
    '> ⚠️ 模板模式（AI 不可用）：AI 简报生成失败，本期只有确定性统计 + 全量清单。',
    '',
    '## 📊 帖量分布',
    '',
    '共 679 条：交易 ×445、测评 ×150、情报 ×84。',
    '',
    '| 日期 | 交易 | 测评 | 情报 |',
    '| --- | --- | --- | --- |',
    '| 2026-09-24 | 445 | 150 | 84 |',
    '',
    '## 💸 价格分位',
    '',
    '- **yearly×USD**：中位 30，P25 17.75'
  ].join('\n')

  it('HTML：标题粗体、警告 blockquote、表格 pre 对齐、列表 bullet', () => {
    const html = markdownToTelegramHtml(report)
    expect(html).toContain('<b>📰 分类行情报告 · 2026-09-24</b>')
    expect(html).toContain('<blockquote>⚠️ 模板模式（AI 不可用）：')
    expect(html).toContain('<b>📊 帖量分布</b>')
    expect(html).toContain('<pre>')
    expect(html).toContain('2026-09-24 │ 445 ') // 对齐列
    expect(html).toContain('• <b>yearly×USD</b>：中位 30，P25 17.75')
    expect(html).not.toContain('| --- |') // 表格分隔行不裸奔
    expect(html).not.toContain('## ') // 标记不裸奔
  })

  it('纯文本：无任何 markdown 记号与 HTML 标签', () => {
    const plain = markdownToPlain(report)
    expect(plain).toContain('📰 分类行情报告 · 2026-09-24')
    expect(plain).toContain('2026-09-24 │ 445')
    expect(plain).not.toContain('## ')
    expect(plain).not.toContain('**')
    expect(plain).not.toContain('| --- |')
    expect(plain).not.toContain('<')
  })
})
