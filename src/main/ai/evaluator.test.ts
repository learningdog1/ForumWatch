/**
 * SemanticEvaluator 单测：provider.chat 全 mock，零网络。
 * 覆盖：成功裁决映射 / 部分缺 key 跳过 / hit:false 也在 Map / 空 interests
 * 不调 chat 全 false / 空 topics 不调 / >12 抛 / 垃圾 JSON 抛 bad-json /
 * 平衡块提取（前后包垃圾文本）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Topic } from '../../shared/types'
import { AiProviderError } from './provider'
import { MAX_SEMANTIC_BATCH, SemanticEvaluator } from './evaluator'

function topic(id: string, sourceId = 'nodeseek'): Topic {
  return {
    id,
    sourceId,
    title: `title-${id}`,
    url: `https://www.nodeseek.com/post-${id}-1`,
    author: 'alice',
    category: '交易',
    categorySlug: 'trade',
    pinned: false,
    lastActiveAt: null
  }
}

interface Harness {
  evaluator: SemanticEvaluator
  chat: ReturnType<typeof vi.fn>
}

/** chatReply(callIndex) 返回 assistant 文本或抛错 */
function makeHarness(reply: (callIndex: number) => string): Harness {
  const chat = vi.fn(() => {
    const idx = chat.mock.calls.length - 1
    try {
      return Promise.resolve(reply(idx))
    } catch (e) {
      return Promise.reject(e)
    }
  })
  const evaluator = new SemanticEvaluator({ provider: { chat } })
  return { evaluator, chat }
}

describe('SemanticEvaluator.evaluate', () => {
  it('成功裁决映射：key 为 `${sourceId}:${id}`，hit/reason 原样透传；请求体形状符合协议', async () => {
    const h = makeHarness(
      () =>
        '{"verdicts":[{"key":"nodeseek:1","hit":true,"reason":"与自建主机相关"},' +
        '{"key":"nodeseek:2","hit":false,"reason":"无关"}]}'
    )
    const topics = [topic('1'), topic('2')]
    const out = await h.evaluator.evaluate(topics, ['自建主机', 'NAS'])

    expect(out.size).toBe(2)
    expect(out.get('nodeseek:1')).toEqual({ hit: true, reason: '与自建主机相关' })
    expect(out.get('nodeseek:2')).toEqual({ hit: false, reason: null })

    // 请求形状：system 提示词 + user JSON（interests + topics 摘要），jsonMode/超时/上限
    expect(h.chat).toHaveBeenCalledTimes(1)
    const req = h.chat.mock.calls[0]![0] as {
      system: string
      user: string
      jsonMode?: boolean
      timeoutMs?: number
      maxTokens?: number
    }
    expect(req.system).toContain('论坛帖子筛选器')
    expect(req.system).toContain('宁可漏报不要误报')
    expect(req.jsonMode).toBe(true)
    expect(req.timeoutMs).toBe(15000)
    expect(req.maxTokens).toBe(2000)
    expect(JSON.parse(req.user)).toEqual({
      interests: ['自建主机', 'NAS'],
      topics: [
        { key: 'nodeseek:1', title: 'title-1', category: '交易' },
        { key: 'nodeseek:2', title: 'title-2', category: '交易' }
      ]
    })
  })

  it('verdict 项缺 key 或 hit 非布尔 → 跳过该项（视为未决），其余照常', async () => {
    const h = makeHarness(
      () =>
        '{"verdicts":[' +
        '{"key":"nodeseek:1","hit":true,"reason":"r1"},' +
        '{"hit":true,"reason":"no key"},' +
        '{"key":"nodeseek:3","hit":"yes","reason":"hit 非布尔"},' +
        '{"key":"nodeseek:4","hit":false}' +
        ']}'
    )
    const out = await h.evaluator.evaluate([topic('1'), topic('3'), topic('4')], ['x'])
    expect(out.has('nodeseek:1')).toBe(true)
    expect(out.has('nodeseek:3')).toBe(false) // hit 非布尔：跳过
    expect(out.has('nodeseek:4')).toBe(true)
    expect(out.get('nodeseek:4')).toEqual({ hit: false, reason: null })
  })

  it('hit:false 也在 Map 里（已裁决不命中，调用方据此入 seen）', async () => {
    const h = makeHarness(() => '{"verdicts":[{"key":"nodeseek:9","hit":false}]}')
    const out = await h.evaluator.evaluate([topic('9')], ['x'])
    expect(out.get('nodeseek:9')).toEqual({ hit: false, reason: null })
  })

  it('空 interests：不调 chat，返回全量 Map（全部 hit:false）', async () => {
    const h = makeHarness(() => '{"verdicts":[]}')
    const out = await h.evaluator.evaluate([topic('1'), topic('2')], [])
    expect(h.chat).not.toHaveBeenCalled()
    expect(out.size).toBe(2)
    for (const v of out.values()) expect(v).toEqual({ hit: false, reason: null })
  })

  it('空 topics：不调 chat，返回空 Map', async () => {
    const h = makeHarness(() => '{"verdicts":[]}')
    const out = await h.evaluator.evaluate([], ['兴趣'])
    expect(h.chat).not.toHaveBeenCalled()
    expect(out.size).toBe(0)
  })

  it(`> ${MAX_SEMANTIC_BATCH} 条：抛 Error（调用方负责切片的防御性断言），不调 chat`, async () => {
    const h = makeHarness(() => '{"verdicts":[]}')
    const topics = Array.from({ length: MAX_SEMANTIC_BATCH + 1 }, (_, i) => topic(String(i)))
    await expect(h.evaluator.evaluate(topics, ['x'])).rejects.toThrow(
      /semantic batch too large/
    )
    expect(h.chat).not.toHaveBeenCalled()
  })

  it('垃圾 JSON（无任何平衡对象）→ 抛 AiProviderError bad-json', async () => {
    const h = makeHarness(() => '抱歉，我无法处理这个请求。')
    const p = h.evaluator.evaluate([topic('1')], ['x'])
    let caught: unknown
    await p.catch((e: unknown) => {
      caught = e
    })
    expect(caught).toBeInstanceOf(AiProviderError)
    expect((caught as AiProviderError).kind).toBe('bad-json')
  })

  it('顶层缺 verdicts 数组 → 抛 bad-json', async () => {
    const h = makeHarness(() => '{"results":[]}')
    await expect(h.evaluator.evaluate([topic('1')], ['x'])).rejects.toMatchObject({
      name: 'AiProviderError',
      kind: 'bad-json'
    })
  })

  it('平衡块提取：有效 JSON 前后包垃圾文本（含代码围栏）仍能解析', async () => {
    const payload =
      '{"verdicts":[{"key":"nodeseek:1","hit":true,"reason":"标题含 {花括号} 与转义引号 \\" 也按字符串处理"}]}'
    const h = makeHarness(() => `好的，以下是筛选结果：\n\`\`\`json\n${payload}\n\`\`\`\n希望有帮助！`)
    const out = await h.evaluator.evaluate([topic('1')], ['x'])
    expect(out.get('nodeseek:1')).toEqual({
      hit: true,
      reason: '标题含 {花括号} 与转义引号 " 也按字符串处理'
    })
  })

  it('截断的 JSON（花括号不闭合）→ 抛 bad-json', async () => {
    const h = makeHarness(() => '前置说明 {"verdicts":[{"key":"nodeseek:1","hit":tru')
    await expect(h.evaluator.evaluate([topic('1')], ['x'])).rejects.toMatchObject({
      kind: 'bad-json'
    })
  })

  it('provider.chat 抛 AiProviderError → 原样向上抛（该批全部未决由调用方处理）', async () => {
    const chat = vi.fn(() =>
      Promise.reject(new AiProviderError('AI provider request timed out after 15000ms', 'timeout'))
    )
    const evaluator = new SemanticEvaluator({ provider: { chat } })
    await expect(evaluator.evaluate([topic('1')], ['x'])).rejects.toMatchObject({
      kind: 'timeout'
    })
  })

  it('多 source 键不串：key 前缀按 topic.sourceId 组装', async () => {
    const h = makeHarness(
      () => '{"verdicts":[{"key":"aa:1","hit":true,"reason":"r"},{"key":"bb:1","hit":false}]}'
    )
    const out = await h.evaluator.evaluate([topic('1', 'aa'), topic('1', 'bb')], ['x'])
    expect(out.get('aa:1')).toEqual({ hit: true, reason: 'r' })
    expect(out.get('bb:1')).toEqual({ hit: false, reason: null })
  })
})
