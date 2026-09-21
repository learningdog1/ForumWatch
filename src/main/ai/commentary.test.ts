/**
 * CommentGenerator 单测：provider.chat 全 mock，零网络。
 * 覆盖：成功返回与请求形状（默认直出模式 200 tokens + disableThinking；
 * 思考模式 2000 tokens 不带思考禁用参数；25s 超时 / 无 jsonMode / system 契约 /
 * user 三字段 JSON）/ 直出失败自动重试一次（首发败重试成、空响应重试、思考
 * 模式不重试）/ 后处理（trim、去配对引号、80 字截断（含代理对安全，F2）、
 * 空串归 null）/ chat 抛错 → null 且不抛 / 成功缓存与失败负缓存（TTL 内二次
 * 调用不打 LLM、TTL 过期放行重试自愈）/ logWarn 可观测钩子（失败与空响应各
 * 留痕；缺省注入静默）/ 同 key 并发去重（一次 chat）/ prune 保留集语义（成功
 * 缓存与负缓存都吃 prune；observedSources 守卫：未观测 source 的键保留，F1）/
 * clear（含在途回填打断）。
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
  it('成功（默认直出模式，R12）：返回后处理后的评论文本；请求形状 = 25s 超时 / 200 tokens（正文预算）/ 附 disableThinking / 无 jsonMode / system 锐评契约 / user 三字段 JSON', async () => {
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
      disableThinking?: boolean
    }
    expect(req.timeoutMs).toBe(25000)
    expect(req.maxTokens).toBe(200) // 直出模式：产出全是正文，不需要思考预算
    expect(req.disableThinking).toBe(true) // 附 thinking:{type:'disabled'}（provider 侧映射）
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

  it('思考模式（useThinking:true）：maxTokens 2000（思考与正文共用预算）/ 不带 disableThinking（旧行为）', async () => {
    const h = makeHarness(() => '思考锐评')
    const out = await h.generator.generate(topic('1'), { useThinking: true })
    expect(out).toBe('思考锐评')
    expect(h.chat).toHaveBeenCalledTimes(1)
    const req = h.chat.mock.calls[0]![0] as { maxTokens?: number; disableThinking?: boolean }
    expect(req.maxTokens).toBe(2000)
    expect(req.disableThinking).toBe(false) // provider 只在 === true 时下发，false 不进请求体（旧行为）
  })

  it('思考模式失败：单发不重试（重试会把 25s 级推送延迟上限翻倍）', async () => {
    const h = makeHarness(() => {
      throw new AiProviderError('AI provider request timed out after 25000ms', 'timeout')
    })
    await expect(h.generator.generate(topic('1'), { useThinking: true })).resolves.toBeNull()
    expect(h.chat).toHaveBeenCalledTimes(1)
  })

  it('直出模式失败自动重试一次（R12）：首发失败、重试成功 → 返回文本且成功缓存', async () => {
    const h = makeHarness((i) => {
      if (i === 0) throw new TypeError('fetch failed')
      return '重试成功锐评'
    })
    await expect(h.generator.generate(topic('1'))).resolves.toBe('重试成功锐评')
    expect(h.chat).toHaveBeenCalledTimes(2)
    await expect(h.generator.generate(topic('1'))).resolves.toBe('重试成功锐评') // 缓存命中不重打
    expect(h.chat).toHaveBeenCalledTimes(2)
  })

  it('直出模式空响应也重试：首发空串、重试有正文 → 返回文本', async () => {
    const h = makeHarness((i) => (i === 0 ? '' : '空后重试锐评'))
    await expect(h.generator.generate(topic('1'))).resolves.toBe('空后重试锐评')
    expect(h.chat).toHaveBeenCalledTimes(2)
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
      Promise.reject(new AiProviderError('AI provider request timed out after 25000ms', 'timeout'))
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

  it('失败负缓存：失败（直出重试一次后仍败）后同 topic 二次调用不调 chat（返回 null）', async () => {
    const h = makeHarness(() => {
      throw new AiProviderError('AI provider network error', 'network')
    })
    expect(await h.generator.generate(topic('1'))).toBeNull()
    expect(await h.generator.generate(topic('1'))).toBeNull()
    expect(h.chat).toHaveBeenCalledTimes(2) // 首发 + 直出重试各一次，负缓存命中后零调用
  })

  it('失败负缓存 TTL（10 分钟）：窗口内不打 LLM，到点放行重试——供应商恢复后自愈', async () => {
    let t = 1_000_000
    let fail = true
    const chat = vi.fn(() =>
      fail ? Promise.reject(new Error('network down')) : Promise.resolve('复活锐评')
    )
    const generator = new CommentGenerator({ provider: { chat }, now: () => t })
    expect(await generator.generate(topic('1'))).toBeNull() // 失败（2 次尝试）→ 负缓存落位
    expect(await generator.generate(topic('1'))).toBeNull() // TTL 内：不打 LLM
    expect(chat).toHaveBeenCalledTimes(2)
    t += 10 * 60 * 1000 // TTL 到点（含）
    fail = false
    await expect(generator.generate(topic('1'))).resolves.toBe('复活锐评') // 放行重打
    expect(chat).toHaveBeenCalledTimes(3)
    // 成功落位后：负缓存语义不再参与，同 key 命中成功缓存
    await expect(generator.generate(topic('1'))).resolves.toBe('复活锐评')
    expect(chat).toHaveBeenCalledTimes(3)
  })

  it('失败负缓存 TTL 差一秒未到：仍命中负缓存不打 LLM', async () => {
    let t = 1_000_000
    const chat = vi.fn(() => Promise.reject(new Error('network down')))
    const generator = new CommentGenerator({ provider: { chat }, now: () => t })
    expect(await generator.generate(topic('1'))).toBeNull()
    t += 10 * 60 * 1000 - 1
    expect(await generator.generate(topic('1'))).toBeNull()
    expect(chat).toHaveBeenCalledTimes(2)
  })

  it('logWarn 钩子：失败留痕（含异常消息与帖标题）；缺省注入时静默不炸', async () => {
    const warns: string[] = []
    const chat = vi.fn(() =>
      Promise.reject(new AiProviderError('AI provider request timed out after 25000ms', 'timeout'))
    )
    const generator = new CommentGenerator({ provider: { chat }, logWarn: (m) => warns.push(m) })
    await expect(generator.generate(topic('1'))).resolves.toBeNull()
    expect(warns).toHaveLength(2) // 首发 + 直出重试各留一条（attempt 编号可辨）
    expect(warns[0]).toContain('commentary failed')
    expect(warns[0]).toContain('attempt 1/2')
    expect(warns[1]).toContain('attempt 2/2')
    expect(warns[0]).toContain('timed out after 25000ms')
    expect(warns[0]).toContain('title-1')
    // 旧装配不注入 logWarn：静默降级，不抛
    const silent = new CommentGenerator({ provider: { chat } })
    await expect(silent.generate(topic('1'))).resolves.toBeNull()
  })

  it('logWarn 钩子：空响应归 null 时留痕（两次尝试各一条，可观测口）', async () => {
    const warns: string[] = []
    const generator = new CommentGenerator({
      provider: { chat: () => Promise.resolve('   ') },
      logWarn: (m) => warns.push(m)
    })
    await expect(generator.generate(topic('1'))).resolves.toBeNull()
    expect(warns).toHaveLength(2)
    expect(warns[0]).toContain('commentary empty after normalize')
    expect(warns[0]).toContain('mode=direct')
    expect(warns[0]).toContain('max_tokens')
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
    expect(chat).toHaveBeenCalledTimes(3) // 首发 + 直出重试（2 次）+ 清缓存后重打（1 次）
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
    await expect(generator.generate(topic('1'))).resolves.toBeNull() // 负缓存落位（2 次尝试）
    // 失败轮（nodeseek 未观测）：keepKeys 为空也不清负缓存
    generator.prune(new Set(), new Set(['other']))
    fail = false
    await expect(generator.generate(topic('1'))).resolves.toBeNull() // 负缓存仍命中：不打 LLM
    expect(chat).toHaveBeenCalledTimes(2)
    // 该 source 恢复观测后的轮末才清负缓存
    generator.prune(new Set(), new Set(['nodeseek']))
    await expect(generator.generate(topic('1'))).resolves.toBe('复活锐评')
    expect(chat).toHaveBeenCalledTimes(3)
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
