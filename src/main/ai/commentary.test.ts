/**
 * CommentGenerator 单测：provider.chat 全 mock，零网络。
 * 覆盖：成功返回与请求形状（8s 超时 / 120 tokens / 无 jsonMode / system 契约 /
 * user 三字段 JSON）/ 后处理（trim、去配对引号、80 字截断（含代理对安全，F2）、
 * 空串归 null）/ chat 抛错 → null 且不抛 / 成功缓存与失败负缓存（二次调用不打
 * LLM）/ 同 key 并发去重（一次 chat）/ prune 保留集语义（成功缓存与负缓存都吃
 * prune；observedSources 守卫：未观测 source 的键保留，F1）/ clear（含在途
 * 回填打断）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Topic } from '../../shared/types'
import { AiProviderError } from './provider'
import { CommentGenerator } from './commentary'

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
  generator: CommentGenerator
  chat: ReturnType<typeof vi.fn>
}

/** reply(callIndex) 返回 assistant 文本或抛错（抛错转为 rejected promise） */
function makeHarness(reply: (callIndex: number) => string): Harness {
  const chat = vi.fn(() => {
    const idx = chat.mock.calls.length - 1
    try {
      return Promise.resolve(reply(idx))
    } catch (e) {
      return Promise.reject(e)
    }
  })
  const generator = new CommentGenerator({ provider: { chat } })
  return { generator, chat }
}

describe('CommentGenerator.generate', () => {
  it('成功：返回后处理后的评论文本；请求形状 = 8s 超时 / 120 tokens / 无 jsonMode / system 锐评契约 / user 三字段 JSON', async () => {
    const h = makeHarness(() => '  一句锐评  ')
    const out = await h.generator.generate(topic('1'))
    expect(out).toBe('一句锐评')

    expect(h.chat).toHaveBeenCalledTimes(1)
    const req = h.chat.mock.calls[0]![0] as {
      system: string
      user: string
      jsonMode?: boolean
      timeoutMs?: number
      maxTokens?: number
    }
    expect(req.timeoutMs).toBe(8000)
    expect(req.maxTokens).toBe(120)
    expect(req.jsonMode).toBeUndefined() // 纯文本回复，不带 response_format
    expect(req.system).toContain('中文锐评')
    expect(req.system).toContain('60 字以内')
    expect(req.system).toContain('不辱骂')
    expect(req.system).toContain('只输出评论文本本身')
    expect(JSON.parse(req.user)).toEqual({
      title: 'title-1',
      category: '交易',
      author: 'alice'
    })
  })

  it('后处理去引号：ASCII/全角/单引号配对包裹都被剥掉，双层包裹与引号内空白也处理', async () => {
    const cases: Array<[string, string]> = [
      ['"双引号锐评"', '双引号锐评'],
      ['“全角双引号”', '全角双引号'],
      ["'单引号'", '单引号'],
      ['“"双层包裹"”', '双层包裹'],
      ['  “  引号内有空白  ”  ', '引号内有空白']
    ]
    for (const [reply, expected] of cases) {
      const h = makeHarness(() => reply)
      expect(await h.generator.generate(topic('1'))).toBe(expected)
    }
  })

  it('后处理截断：超 80 字符在字符边界 slice(0,80)', async () => {
    const h = makeHarness(() => '锐'.repeat(100))
    const out = await h.generator.generate(topic('1'))
    expect(out).toBe('锐'.repeat(80))
  })

  it('后处理截断代理对安全（F2）：79 普通字符 + emoji 切半 → 退一位丢孤立高代理', async () => {
    // 😀 = U+1F600（高代理 + 低代理两个 UTF-16 单元）；'锐'.repeat(79) + 😀 = 81
    // 单元，第 80 单元恰是高代理——旧 slice(0,80) 会产出孤立高代理
    const raw = '锐'.repeat(79) + '\u{1F600}'
    expect(raw.length).toBe(81)
    const h = makeHarness(() => raw)
    const out = await h.generator.generate(topic('1'))
    expect(out).not.toBeNull()
    expect(Array.from(out as string).length).toBeLessThanOrEqual(80) // 码点口径不超限
    const lastCp = (out as string).codePointAt((out as string).length - 1)!
    expect(lastCp < 0xd800 || lastCp > 0xdfff).toBe(true) // 末字符不是孤立代理
    expect(out).toBe('锐'.repeat(79)) // 被切半的 emoji 整个丢弃
  })

  it('后处理截断代理对安全：边界内完整的 emoji 不受影响', async () => {
    // 78 普通字符 + 代理对 = 恰 80 单位：不触发截断，emoji 完整保留
    const raw = '锐'.repeat(78) + '\u{1F600}'
    expect(raw.length).toBe(80)
    const h = makeHarness(() => raw)
    await expect(h.generator.generate(topic('1'))).resolves.toBe(raw)
  })

  it('后处理空串：纯空白 / 只剩引号对 → null', async () => {
    const h1 = makeHarness(() => '   ')
    expect(await h1.generator.generate(topic('1'))).toBeNull()
    const h2 = makeHarness(() => '“”')
    expect(await h2.generator.generate(topic('1'))).toBeNull()
  })

  it('chat 抛 AiProviderError（timeout）→ 返回 null，不向上抛', async () => {
    const chat = vi.fn(() =>
      Promise.reject(new AiProviderError('AI provider request timed out after 8000ms', 'timeout'))
    )
    const generator = new CommentGenerator({ provider: { chat } })
    await expect(generator.generate(topic('1'))).resolves.toBeNull()
  })

  it('chat 抛普通 Error（网络）→ 返回 null，不向上抛', async () => {
    const chat = vi.fn(() => Promise.reject(new TypeError('fetch failed')))
    const generator = new CommentGenerator({ provider: { chat } })
    await expect(generator.generate(topic('1'))).resolves.toBeNull()
  })

  it('chat 同步抛非 Error 值 → 返回 null，不向上抛', async () => {
    const chat = vi.fn(() => {
      throw 'boom'
    })
    const generator = new CommentGenerator({ provider: { chat } })
    await expect(generator.generate(topic('1'))).resolves.toBeNull()
  })

  it('成功缓存：同 topic 二次调用不调 chat，返回同一句', async () => {
    const h = makeHarness(() => '缓存锐评')
    expect(await h.generator.generate(topic('1'))).toBe('缓存锐评')
    expect(await h.generator.generate(topic('1'))).toBe('缓存锐评')
    expect(h.chat).toHaveBeenCalledTimes(1)
  })

  it('失败负缓存：失败后同 topic 二次调用不调 chat（返回 null），别的 topic 不受影响', async () => {
    const h = makeHarness(() => {
      throw new AiProviderError('AI provider network error', 'network')
    })
    expect(await h.generator.generate(topic('1'))).toBeNull()
    expect(await h.generator.generate(topic('1'))).toBeNull()
    expect(h.chat).toHaveBeenCalledTimes(1)
  })

  it('并发去重：同 key 两个并发 generate 只触发一次 chat，两者拿到同一结果；落定后缓存生效', async () => {
    let resolveChat: (s: string) => void = () => {}
    const chat = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveChat = resolve
        })
    )
    const generator = new CommentGenerator({ provider: { chat } })
    const p1 = generator.generate(topic('1'))
    const p2 = generator.generate(topic('1'))
    resolveChat('并发结果')
    const [r1, r2] = await Promise.all([p1, p2])
    expect(chat).toHaveBeenCalledTimes(1)
    expect(r1).toBe('并发结果')
    expect(r2).toBe('并发结果')
    // 去重完成后缓存落位：再来一次仍不打 LLM
    await expect(generator.generate(topic('1'))).resolves.toBe('并发结果')
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('并发不同 key 不去重：各打各的 chat', async () => {
    const h = makeHarness((i) => `锐评${i}`)
    const [a, b] = await Promise.all([
      h.generator.generate(topic('1')),
      h.generator.generate(topic('2'))
    ])
    expect(h.chat).toHaveBeenCalledTimes(2)
    expect(a).toBe('锐评0')
    expect(b).toBe('锐评1')
  })

  it('prune：保留集外的键被清除（再调用重新打 chat），保留集内的键缓存仍命中', async () => {
    const replies = ['第一句', '第二句', '第三句']
    const h = makeHarness((i) => replies[i]!)
    await h.generator.generate(topic('1')) // → 第一句
    await h.generator.generate(topic('2')) // → 第二句
    expect(h.chat).toHaveBeenCalledTimes(2)

    h.generator.prune(new Set(['nodeseek:2']))
    // 保留集外：缓存被清，重新打 chat
    await expect(h.generator.generate(topic('1'))).resolves.toBe('第三句')
    expect(h.chat).toHaveBeenCalledTimes(3)
    // 保留集内：缓存命中
    await expect(h.generator.generate(topic('2'))).resolves.toBe('第二句')
    expect(h.chat).toHaveBeenCalledTimes(3)
  })

  it('prune 也清失败负缓存：清掉后再调用重新打 chat', async () => {
    let fail = true
    const chat = vi.fn(() =>
      fail ? Promise.reject(new Error('network down')) : Promise.resolve('复活锐评')
    )
    const generator = new CommentGenerator({ provider: { chat } })
    await expect(generator.generate(topic('1'))).resolves.toBeNull()
    generator.prune(new Set()) // 全清
    fail = false
    await expect(generator.generate(topic('1'))).resolves.toBe('复活锐评')
    expect(chat).toHaveBeenCalledTimes(2)
  })

  it('prune 带 observedSources（F1）：未观测 source 的键保留，已观测 source 滚出首页的键照删', async () => {
    const h = makeHarness((i) => `锐评${i}`)
    await h.generator.generate(topic('1')) // → 锐评0（nodeseek:1）
    await h.generator.generate(topic('2', 'other')) // → 锐评1（other:2）
    expect(h.chat).toHaveBeenCalledTimes(2)

    // 本轮页面只剩 other:3；nodeseek 未观测（冷却/失败轮）→ nodeseek:1 不在
    // keepKeys 但其 source 未观测 → 保留；other 已观测 → other:2 滚出首页被删
    h.generator.prune(new Set(['other:3']), new Set(['other']))
    await expect(h.generator.generate(topic('1'))).resolves.toBe('锐评0') // 缓存命中
    expect(h.chat).toHaveBeenCalledTimes(2)
    await expect(h.generator.generate(topic('2', 'other'))).resolves.toBe('锐评2') // 被清 → 重打
    expect(h.chat).toHaveBeenCalledTimes(3)
  })

  it('prune 带 observedSources：失败负缓存同样受守卫（未观测 source 的负缓存保留）', async () => {
    let fail = true
    const chat = vi.fn(() =>
      fail ? Promise.reject(new Error('network down')) : Promise.resolve('复活锐评')
    )
    const generator = new CommentGenerator({ provider: { chat } })
    await expect(generator.generate(topic('1'))).resolves.toBeNull() // 负缓存落位
    // 失败轮（nodeseek 未观测）：keepKeys 为空也不清负缓存
    generator.prune(new Set(), new Set(['other']))
    fail = false
    await expect(generator.generate(topic('1'))).resolves.toBeNull() // 负缓存仍命中：不打 LLM
    expect(chat).toHaveBeenCalledTimes(1)
    // 该 source 恢复观测后的轮末才清负缓存
    generator.prune(new Set(), new Set(['nodeseek']))
    await expect(generator.generate(topic('1'))).resolves.toBe('复活锐评')
    expect(chat).toHaveBeenCalledTimes(2)
  })

  it('prune 不带 observedSources：行为同旧版（keepKeys 外全删，兼容旧调用方）', async () => {
    const h = makeHarness((i) => `锐评${i}`)
    await h.generator.generate(topic('1'))
    h.generator.prune(new Set())
    await expect(h.generator.generate(topic('1'))).resolves.toBe('锐评1') // 被清 → 重打
    expect(h.chat).toHaveBeenCalledTimes(2)
  })

  it('clear：清空成功缓存，同 topic 再调用重新打 chat', async () => {
    const h = makeHarness((i) => (i === 0 ? '旧锐评' : '新锐评'))
    await expect(h.generator.generate(topic('1'))).resolves.toBe('旧锐评')
    h.generator.clear()
    await expect(h.generator.generate(topic('1'))).resolves.toBe('新锐评')
    expect(h.chat).toHaveBeenCalledTimes(2)
  })

  it('clear 打断在途回填：在途 promise 完成后调用方拿到结果但不写缓存，下次调用重打 chat', async () => {
    let resolveChat: ((s: string) => void) | undefined
    const chat = vi.fn(() => {
      if (chat.mock.calls.length === 1) {
        return new Promise<string>((resolve) => {
          resolveChat = resolve
        })
      }
      return Promise.resolve('重打结果')
    })
    const generator = new CommentGenerator({ provider: { chat } })
    const p = generator.generate(topic('1'))
    generator.clear()
    resolveChat!('迟到结果')
    await expect(p).resolves.toBe('迟到结果') // 调用方仍拿到本次结果
    await expect(generator.generate(topic('1'))).resolves.toBe('重打结果') // 但缓存未回填 → 重打
    expect(chat).toHaveBeenCalledTimes(2)
  })
})
