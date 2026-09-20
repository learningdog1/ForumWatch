import { describe, expect, it } from 'vitest'
import { parseInline, parseReport } from './ReportDoc'

/**
 * ReportDoc 渲染器的解析器单测（R10 阶段 4 门禁项）。
 * 仓库 vitest 为 node 环境（无 DOM），故测可独立导入的纯函数——渲染层只是
 * 这些 token/块的直接映射，核心红线「宽松解析永不吞内容」在函数层断言。
 */

/** 全部 token 的可见文本拼接（link 取锚文本；语法符不计） */
function visibleText(tokens: ReturnType<typeof parseInline>): string {
  return tokens.map((t) => t.text).join('')
}

describe('parseInline · 行内四语法', () => {
  it('粗体 **text** → strong，前后原文保留', () => {
    expect(parseInline('前缀 **加粗** 后缀')).toEqual([
      { kind: 'text', text: '前缀 ' },
      { kind: 'strong', text: '加粗' },
      { kind: 'text', text: ' 后缀' }
    ])
  })

  it('行内代码 `text` → code', () => {
    expect(parseInline('用 `npm test` 跑测试')).toEqual([
      { kind: 'text', text: '用 ' },
      { kind: 'code', text: 'npm test' },
      { kind: 'text', text: ' 跑测试' }
    ])
  })

  it('链接 [文字](https://…) → link（锚文本 + 完整 url）', () => {
    expect(parseInline('见 [帖子](https://www.nodeseek.com/post/1) 详情')).toEqual([
      { kind: 'text', text: '见 ' },
      { kind: 'link', text: '帖子', url: 'https://www.nodeseek.com/post/1' },
      { kind: 'text', text: ' 详情' }
    ])
  })

  it('斜体 *text* → em（首尾贴非空白）', () => {
    expect(parseInline('这是 *重点* 吗')).toEqual([
      { kind: 'text', text: '这是 ' },
      { kind: 'em', text: '重点' },
      { kind: 'text', text: ' 吗' }
    ])
  })

  it('一段内多语法混合，各归各位', () => {
    expect(parseInline('**粗** + `码` + [链](https://a.b/c)')).toEqual([
      { kind: 'strong', text: '粗' },
      { kind: 'text', text: ' + ' },
      { kind: 'code', text: '码' },
      { kind: 'text', text: ' + ' },
      { kind: 'link', text: '链', url: 'https://a.b/c' }
    ])
  })
})

describe('parseInline · 宽松解析永不吞内容', () => {
  const UNRECOGNIZED = [
    '**未闭合的粗体', // 单侧 **
    '`未闭合的代码', // 单个反引号
    '[缺右括号](https://a.b/c', // 括号不完整 → 原样
    '[非 http](ftp://a.b/c)', // 非 http/https 协议 → 原样（不渲染为链接）
    '| 表头 | 表头 |', // GFM 表格管道符 → 原样
    '~~删除线~~', // 未支持语法 → 原样
    '一个 * 星号', // 单个 * → 原样
    '2 * 3 * 4 = 24', // 两侧贴空白不成斜体（CommonMark 侧翼规则口径）
    '普通中文一行，什么语法都没有'
  ]
  it.each(UNRECOGNIZED)('未识别语法原文渲染：%s', (line) => {
    expect(parseInline(line)).toEqual([{ kind: 'text', text: line }])
  })

  it('任意输入的可见文本不丢失（语法符之外逐字保留）', () => {
    const samples = [
      '**加粗** 与 `代码` 与 [链接](https://a.b/c) 混排',
      '残缺 **加粗 与 [链接](https://a.b 与 ` 代码',
      '**a*b** 与 *c*'
    ]
    for (const s of samples) {
      const tokens = parseInline(s)
      // 去掉四语法的定界符后，其余字符必须逐字保留
      const stripped = s
        .replace(/`([^`\n]+)`/g, '$1')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(\S(?:[^*\n]*\S)?)\*/g, '$1')
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
      expect(visibleText(tokens)).toBe(stripped)
    }
  })
})

describe('parseReport · 块级与元信息', () => {
  const AI_MD = [
    '# ForumWatch 监控日报 · 2026-09-20',
    '',
    '今日共 12 条命中，**羊毛**类为主。',
    '',
    '## nodeseek',
    '',
    '- 09:12 [羊毛快讯] 送 100 元券，[原帖](https://www.nodeseek.com/post/1)（语义命中）',
    '- 10:00 [闲聊] 自由格式的一行，不是模板行',
    '',
    '—— 数据说明：本日报由 AI 生成。'
  ].join('\n')

  it('首个含「监控日报」的 h1 上提去重，不进正文块', () => {
    const r = parseReport(AI_MD)
    expect(r.promotedTitle).toBe('ForumWatch 监控日报 · 2026-09-20')
    const texts = r.blocks.map((b) => ('text' in b ? b.text : ''))
    expect(texts).not.toContain('ForumWatch 监控日报 · 2026-09-20')
  })

  it('不含「监控日报」的首 h1 照常渲染（LLM 自拟标题不丢）', () => {
    const r = parseReport('# 自拟标题\n\n正文')
    expect(r.promotedTitle).toBeNull()
    expect(r.blocks[0]).toEqual({ type: 'h2', text: '自拟标题', group: 0 })
  })

  it('模板行结构化：时间/分类/标题/方式；不匹配的行回退普通列表项', () => {
    const r = parseReport(AI_MD)
    const list = r.blocks.find((b) => b.type === 'list')
    expect(list).toBeDefined()
    if (list?.type !== 'list') return
    expect(list.items).toHaveLength(2)
    expect(list.items[0]).toEqual({
      kind: 'tpl',
      time: '09:12',
      category: '羊毛快讯',
      title: '送 100 元券，[原帖](https://www.nodeseek.com/post/1)',
      how: '语义命中',
      remark: null
    })
    // 不匹配模板模式（结尾无「（命中方式）」）：整行原文保留，仅剥掉列表符
    expect(list.items[1]).toEqual({
      kind: 'plain',
      text: '10:00 [闲聊] 自由格式的一行，不是模板行'
    })
  })

  it('元信息：命中数 / 生成模式 / 尾注与截断', () => {
    const r = parseReport(AI_MD)
    expect(r.hitCount).toBe(12)
    expect(r.hitsSummary).toBe('共 12 条命中')
    expect(r.mode).toBe('ai')
    expect(r.truncated).toBe(false)
    expect(r.groups).toEqual(['nodeseek'])
    expect(r.blocks.at(-1)).toEqual({ type: 'note', text: '数据说明：本日报由 AI 生成。' })
  })

  it('降级模板（主进程 fallbackReport 固定格式）：mode=template，锐评尾入 remark', () => {
    const md = [
      '# ForumWatch 监控日报 · 2026-09-19',
      '',
      '共 2 条命中。',
      '',
      '## nodeseek',
      '',
      '- 08:30 [福利] 标题一（字面命中）',
      '- 09:11 [羊毛] 标题二（规则命中：低于 9.9 元）「这条值得冲」',
      '',
      '—— 数据说明：本日报由 ForumWatch 按命中记录自动生成（模板模式）。'
    ].join('\n')
    const r = parseReport(md)
    expect(r.mode).toBe('template')
    expect(r.hitCount).toBe(2)
    expect(r.truncated).toBe(false)
    const items = r.blocks.find((b) => b.type === 'list')?.items ?? []
    expect(items[1]).toEqual({
      kind: 'tpl',
      time: '09:11',
      category: '羊毛',
      title: '标题二',
      how: '规则命中：低于 9.9 元',
      remark: '这条值得冲'
    })
  })

  it('零命中日报（noHitReport 固定文案）：hitCount=0、今日无命中、非模板不截断', () => {
    const r = parseReport(
      [
        '# ForumWatch 监控日报 · 2026-09-18',
        '',
        '今日无命中。',
        '',
        '—— 数据说明：本日报由 ForumWatch 自动生成。'
      ].join('\n')
    )
    expect(r.hitCount).toBe(0)
    expect(r.hitsSummary).toBe('今日无命中')
    expect(r.mode).toBe('ai')
    expect(r.truncated).toBe(false)
  })

  it('截断检测：非模板且结尾没有「—— 数据说明」尾注 → truncated（LLM 被 max_tokens 截断）', () => {
    const r = parseReport('# ForumWatch 监控日报 · 2026-09-20\n\n今日共 50 条命中，摘要如下，然后戛然而止')
    expect(r.mode).toBeNull()
    expect(r.truncated).toBe(true)
  })

  it('纯空 / 不可识别内容：不上提、不误报截断', () => {
    const r = parseReport('')
    expect(r.promotedTitle).toBeNull()
    expect(r.blocks).toEqual([])
    expect(r.truncated).toBe(false)
  })
})
