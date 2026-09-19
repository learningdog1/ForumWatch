/**
 * BotCommandController 单测（R9-W1）：post/now/sleep 全部注入 mock，零网络、
 * 零真实等待。循环终止由测试 harness 控制——getUpdates handler 在约定调用
 * 次数后把 enabled 翻 false，循环在下一轮检查点自动退出（生产语义同一分支），
 * 测试 await waitStopped() 收口。
 */

import { describe, expect, it } from 'vitest'
import type { HttpRequestInit, HttpResponse, FetchLike } from '../net/http-types'
import { INITIAL_ENGINE_STATUS, type EngineStatus } from '@shared/types'
import {
  BotCommandController,
  formatStatusReply,
  parseCommandName,
  type BotCommandControllerDeps
} from './bot-commands'

const BOT_TOKEN = '123456:AA-token'
const MAIN_CHAT = 100200

/** 单条 message 更新的 getUpdates 成功响应 */
function updatesBody(updates: Array<{ id: number; chatId: number; text?: string }>): string {
  return JSON.stringify({
    ok: true,
    result: updates.map((u) => ({
      update_id: u.id,
      ...(u.text === undefined
        ? {}
        : { message: { chat: { id: u.chatId }, text: u.text } })
    }))
  })
}

const EMPTY_UPDATES = updatesBody([])

function statusOf(patch: Partial<EngineStatus> = {}): EngineStatus {
  return structuredClone({ ...INITIAL_ENGINE_STATUS, ...patch })
}

interface Harness {
  controller: BotCommandController
  /** 每次 post 的入参 */
  calls: Array<{ url: string; init?: HttpRequestInit }>
  /** sendMessage 回复（chatId + text） */
  replies: Array<{ chatId: string; text: string }>
  logs: Array<{ level: 'info' | 'warn' | 'error'; msg: string }>
  /** 每次 sleep 的毫秒数（假时钟同时推进） */
  sleeps: number[]
  pauseCount: () => number
  resumeCount: () => number
  runNowCount: () => number
  setStatus: (s: EngineStatus) => void
  getStatusValue: () => EngineStatus
  setEnabled: (enabled: boolean) => void
  setAllowedChatIds: (ids: string[]) => void
  setCredentials: (c: { botToken: string; chatId: string } | null) => void
  /**
   * 设定 getUpdates 响应队列（用尽后回落空批 200）。项可以是：
   * - string（200 响应体）/ HttpResponse（构造 409、500 等非 2xx）
   * - 函数（惰性求值，可夹带翻配置等副作用），返回上述两者之一
   */
  queueUpdates: (items: Array<string | HttpResponse | (() => string | HttpResponse)>) => void
  /** 第 n 次 getUpdates（1 起）返回后把 enabled 翻 false，驱动循环退出 */
  stopAfterGetUpdates: (n: number) => void
  getUpdatesCallCount: () => number
}

function makeHarness(opts: { allowedChatIds?: string[]; credentialsNull?: boolean } = {}): Harness {
  const calls: Array<{ url: string; init?: HttpRequestInit }> = []
  const replies: Array<{ chatId: string; text: string }> = []
  const logs: Array<{ level: 'info' | 'warn' | 'error'; msg: string }> = []
  const sleeps: number[] = []
  let clock = 0
  let pauseCount = 0
  let resumeCount = 0
  let runNowCount = 0
  let status = statusOf()
  let enabled = true
  let allowedChatIds = opts.allowedChatIds ?? []
  let credentials: { botToken: string; chatId: string } | null = opts.credentialsNull
    ? null
    : { botToken: BOT_TOKEN, chatId: String(MAIN_CHAT) }
  let queue: Array<string | HttpResponse | (() => string | HttpResponse)> = []
  let getUpdatesCalls = 0
  let stopAfter = Number.POSITIVE_INFINITY

  const post: FetchLike = (url, init) => {
    calls.push({ url, init })
    if (url.includes('/deleteWebhook')) {
      return Promise.resolve({ status: 200, headers: {}, body: '{"ok":true,"result":true}' })
    }
    if (url.includes('/getUpdates')) {
      getUpdatesCalls++
      const item = queue.length > 0 ? queue.shift() : undefined
      const resolved =
        typeof item === 'function' ? item() : (item ?? EMPTY_UPDATES)
      const res =
        typeof resolved === 'string' ? { status: 200, headers: {}, body: resolved } : resolved
      if (getUpdatesCalls >= stopAfter) enabled = false
      return Promise.resolve(res)
    }
    if (url.includes('/sendMessage')) {
      const body = JSON.parse(init?.body ?? '{}') as { chat_id?: unknown; text?: unknown }
      replies.push({ chatId: String(body.chat_id), text: String(body.text) })
      return Promise.resolve({ status: 200, headers: {}, body: '{"ok":true,"result":{"message_id":1}}' })
    }
    return Promise.resolve({ status: 404, headers: {}, body: '' })
  }

  const deps: BotCommandControllerDeps = {
    getEnabled: () => ({ enabled, allowedChatIds: [...allowedChatIds] }),
    getCredentials: () => (credentials === null ? null : { ...credentials }),
    post,
    getStatus: () => status,
    pause: () => {
      pauseCount++
    },
    resume: () => {
      resumeCount++
    },
    runNow: () => {
      runNowCount++
    },
    log: {
      info: (msg) => logs.push({ level: 'info', msg }),
      warn: (msg) => logs.push({ level: 'warn', msg }),
      error: (msg) => logs.push({ level: 'error', msg })
    },
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    }
  }

  return {
    controller: new BotCommandController(deps),
    calls,
    replies,
    logs,
    sleeps,
    pauseCount: () => pauseCount,
    resumeCount: () => resumeCount,
    runNowCount: () => runNowCount,
    setStatus: (s) => (status = s),
    getStatusValue: () => status,
    setEnabled: (v) => (enabled = v),
    setAllowedChatIds: (ids) => (allowedChatIds = ids),
    setCredentials: (c) => (credentials = c),
    queueUpdates: (items) => (queue = [...items]),
    stopAfterGetUpdates: (n) => (stopAfter = n),
    getUpdatesCallCount: () => getUpdatesCalls
  }
}

describe('parseCommandName', () => {
  it('解析矩阵：裸指令 / @botname 后缀 / 大小写 / 带参数；非指令与空指令为 null', () => {
    expect(parseCommandName('/status')).toBe('status')
    expect(parseCommandName('/status@fw_bot')).toBe('status')
    expect(parseCommandName('/PAUSE')).toBe('pause')
    expect(parseCommandName('/poll  立刻')).toBe('poll')
    expect(parseCommandName('hello')).toBeNull()
    expect(parseCommandName('status')).toBeNull()
    expect(parseCommandName('/')).toBeNull()
    expect(parseCommandName('/@bot')).toBeNull()
    expect(parseCommandName('  /status')).toBeNull() // 前导空格不是指令（TG 客户端不会产生）
  })
})

describe('formatStatusReply', () => {
  it('运行态：含引擎/健康/下次轮询/命中/挂起/AI 模式关键字段', () => {
    const text = formatStatusReply(
      statusOf({
        health: 'backoff',
        nextPollAt: '2026-09-19T12:34:56.000Z',
        totalHits: 42,
        pendingNotifyCount: 3,
        ai: {
          configured: true,
          effectiveMode: 'both',
          degraded: 'none',
          callsToday: 5,
          dailyLimit: 300,
          lastAiError: null
        }
      })
    )
    expect(text).toContain('运行中')
    expect(text).toContain('失败退避中')
    expect(text).toContain('下次轮询')
    expect(text).toContain('累计命中: 42')
    expect(text).toContain('挂起待推: 3 条')
    expect(text).toContain('AI 模式: 字面+语义')
  })

  it('暂停态：下次轮询显示已暂停占位；AI 降级附原因', () => {
    const text = formatStatusReply(
      statusOf({
        desired: 'paused',
        ai: {
          configured: false,
          effectiveMode: 'literal',
          degraded: 'unconfigured',
          callsToday: 0,
          dailyLimit: 300,
          lastAiError: null
        }
      })
    )
    expect(text).toContain('已暂停')
    expect(text).toContain('下次轮询: —（已暂停）')
    expect(text).toContain('AI 模式: 字面（Provider 未配置，已降级字面）')
  })
})

describe('BotCommandController 启动与装配纪律（坑8）', () => {
  it('enabled=false → start 是 noop：零 post 调用、不进入运行态', () => {
    const h = makeHarness()
    h.setEnabled(false)
    h.controller.start()
    expect(h.calls).toHaveLength(0)
    expect(h.controller.isRunning).toBe(false)
  })

  it('凭据缺失（getCredentials → null）→ start 是 noop', () => {
    const h = makeHarness({ credentialsNull: true })
    h.controller.start()
    expect(h.calls).toHaveLength(0)
    expect(h.controller.isRunning).toBe(false)
  })

  it('start 先 deleteWebhook（drop_pending_updates=false），getUpdates 带 timeout=25（坑8 第三条前半）', async () => {
    const h = makeHarness()
    h.stopAfterGetUpdates(1)
    h.controller.start()
    await h.controller.waitStopped()
    expect(h.calls[0]!.url).toContain(`/bot${BOT_TOKEN}/deleteWebhook`)
    expect(h.calls[0]!.url).toContain('drop_pending_updates=false')
    expect(h.calls[1]!.url).toContain('/getUpdates')
    expect(h.calls[1]!.url).toContain('timeout=25')
  })

  it('回复走自己的 sendMessage 直调（不进推送队列——URL 带 sendMessage 且成功即收）', async () => {
    const h = makeHarness()
    h.queueUpdates([updatesBody([{ id: 1, chatId: MAIN_CHAT, text: '/help' }])])
    h.stopAfterGetUpdates(2)
    h.controller.start()
    await h.controller.waitStopped()
    const send = h.calls.find((c) => c.url.includes('/sendMessage'))
    expect(send).toBeDefined()
    expect(send!.url).toContain(`/bot${BOT_TOKEN}/sendMessage`)
    expect(h.replies).toHaveLength(1)
  })
})

describe('指令分派', () => {
  it('/status：回复状态摘要（含全部关键字段）', async () => {
    const h = makeHarness()
    h.setStatus(statusOf({ totalHits: 7, pendingNotifyCount: 1 }))
    h.queueUpdates([updatesBody([{ id: 1, chatId: MAIN_CHAT, text: '/status' }])])
    h.stopAfterGetUpdates(2)
    h.controller.start()
    await h.controller.waitStopped()
    expect(h.replies).toHaveLength(1)
    expect(h.replies[0]!.chatId).toBe(String(MAIN_CHAT))
    const text = h.replies[0]!.text
    expect(text).toContain('运行中')
    expect(text).toContain('下次轮询')
    expect(text).toContain('累计命中: 7')
    expect(text).toContain('挂起待推: 1 条')
    expect(text).toContain('AI 模式')
  })

  it('/pause：调 engine.pause 一次并回复（controller 自身不退出——坑8 第二条）', async () => {
    const h = makeHarness()
    h.queueUpdates([updatesBody([{ id: 1, chatId: MAIN_CHAT, text: '/pause' }])])
    h.stopAfterGetUpdates(2)
    h.controller.start()
    await h.controller.waitStopped()
    expect(h.pauseCount()).toBe(1)
    expect(h.resumeCount()).toBe(0)
    expect(h.replies[0]!.text).toContain('已暂停')
    // 循环退出是因为测试翻掉 enabled（stopAfterGetUpdates），不是 /pause 停的：
    // 日志里 listener 退出原因是 disabled，且没有 stop() 的 "remote control stopped"
    expect(h.logs.some((l) => l.msg.includes('disabled or credentials missing'))).toBe(true)
    expect(h.logs.some((l) => l.msg.includes('remote control stopped'))).toBe(false)
  })

  it('/resume：调 engine.resume 一次并回复', async () => {
    const h = makeHarness()
    h.queueUpdates([updatesBody([{ id: 1, chatId: MAIN_CHAT, text: '/resume' }])])
    h.stopAfterGetUpdates(2)
    h.controller.start()
    await h.controller.waitStopped()
    expect(h.resumeCount()).toBe(1)
    expect(h.replies[0]!.text).toContain('已恢复')
  })

  it('/poll：调 engine.runNow 一次，回复"已触发"', async () => {
    const h = makeHarness()
    h.queueUpdates([updatesBody([{ id: 1, chatId: MAIN_CHAT, text: '/poll' }])])
    h.stopAfterGetUpdates(2)
    h.controller.start()
    await h.controller.waitStopped()
    expect(h.runNowCount()).toBe(1)
    expect(h.replies[0]!.text).toContain('已触发')
  })

  it('/help：列出全部 5 条指令', async () => {
    const h = makeHarness()
    h.queueUpdates([updatesBody([{ id: 1, chatId: MAIN_CHAT, text: '/help' }])])
    h.stopAfterGetUpdates(2)
    h.controller.start()
    await h.controller.waitStopped()
    const text = h.replies[0]!.text
    for (const cmd of ['/status', '/pause', '/resume', '/poll', '/help']) {
      expect(text).toContain(cmd)
    }
  })

  it('非指令文本：忽略（不回复、不碰引擎）', async () => {
    const h = makeHarness()
    h.queueUpdates([updatesBody([{ id: 1, chatId: MAIN_CHAT, text: '今天天气不错' }])])
    h.stopAfterGetUpdates(2)
    h.controller.start()
    await h.controller.waitStopped()
    expect(h.replies).toHaveLength(0)
    expect(h.pauseCount() + h.resumeCount() + h.runNowCount()).toBe(0)
  })

  it('未知指令：回复提示（区别于非指令的静默忽略）', async () => {
    const h = makeHarness()
    h.queueUpdates([updatesBody([{ id: 1, chatId: MAIN_CHAT, text: '/reboot' }])])
    h.stopAfterGetUpdates(2)
    h.controller.start()
    await h.controller.waitStopped()
    expect(h.replies).toHaveLength(1)
    expect(h.replies[0]!.text).toContain('未知指令')
    expect(h.replies[0]!.text).toContain('/help')
  })

  it('带 @botname 后缀与参数的指令照常分派（/status@fw_bot）', async () => {
    const h = makeHarness()
    h.queueUpdates([updatesBody([{ id: 1, chatId: MAIN_CHAT, text: '/status@fw_bot' }])])
    h.stopAfterGetUpdates(2)
    h.controller.start()
    await h.controller.waitStopped()
    expect(h.replies).toHaveLength(1)
    expect(h.replies[0]!.text).toContain('ForumWatch 状态')
  })

  it('无 message.text 的更新（如 edited_message）忽略', async () => {
    const h = makeHarness()
    h.queueUpdates([updatesBody([{ id: 1, chatId: MAIN_CHAT }])])
    h.stopAfterGetUpdates(2)
    h.controller.start()
    await h.controller.waitStopped()
    expect(h.replies).toHaveLength(0)
  })
})

describe('allowlist 硬闸', () => {
  it('陌生 chat id：完全忽略（不回复）+ warn 一次', async () => {
    const h = makeHarness()
    h.queueUpdates([updatesBody([{ id: 1, chatId: 999, text: '/status' }])])
    h.stopAfterGetUpdates(2)
    h.controller.start()
    await h.controller.waitStopped()
    expect(h.replies).toHaveLength(0)
    const warns = h.logs.filter((l) => l.level === 'warn' && l.msg.includes('not in allowlist'))
    expect(warns).toHaveLength(1)
    expect(warns[0]!.msg).toContain('999')
  })

  it('同一陌生 chat 反复发指令：warn 一分钟去重（假时钟不推进 → 只一条）', async () => {
    const h = makeHarness()
    h.queueUpdates([
      updatesBody([{ id: 1, chatId: 999, text: '/status' }]),
      updatesBody([{ id: 2, chatId: 999, text: '/pause' }]),
      updatesBody([{ id: 3, chatId: 999, text: '/resume' }])
    ])
    h.stopAfterGetUpdates(4)
    h.controller.start()
    await h.controller.waitStopped()
    expect(h.replies).toHaveLength(0)
    const warns = h.logs.filter((l) => l.msg.includes('not in allowlist'))
    expect(warns).toHaveLength(1)
  })

  it('配置清单内的额外 chat id（含负数群 id）可发指令并收到回复', async () => {
    const h = makeHarness({ allowedChatIds: ['-100999'] })
    h.queueUpdates([updatesBody([{ id: 1, chatId: -100999, text: '/status' }])])
    h.stopAfterGetUpdates(2)
    h.controller.start()
    await h.controller.waitStopped()
    expect(h.replies).toHaveLength(1)
    expect(h.replies[0]!.chatId).toBe('-100999')
  })

  it('主 Chat ID 隐含允许（allowedChatIds 为空也能用）', async () => {
    const h = makeHarness({ allowedChatIds: [] })
    h.queueUpdates([updatesBody([{ id: 1, chatId: MAIN_CHAT, text: '/pause' }])])
    h.stopAfterGetUpdates(2)
    h.controller.start()
    await h.controller.waitStopped()
    expect(h.replies).toHaveLength(1)
    expect(h.pauseCount()).toBe(1)
  })
})

describe('409 与错误退避（坑8 第三条）', () => {
  const conflictRes = (): HttpResponse => ({
    status: 409,
    headers: {},
    body: '{"ok":false,"error_code":409,"description":"Conflict"}'
  })

  it('409：log error（文案说明被其他消费者占用）+ sleep 60s 退避 + 5 分钟内同错误去重', async () => {
    const h = makeHarness()
    h.queueUpdates([conflictRes, conflictRes, conflictRes]) // 3 轮 409（假时钟各推进 60s，均 < 5min）
    h.stopAfterGetUpdates(3)
    h.controller.start()
    await h.controller.waitStopped()
    const errors = h.logs.filter((l) => l.level === 'error' && l.msg.includes('409'))
    expect(errors).toHaveLength(1)
    expect(errors[0]!.msg).toContain('其他 getUpdates 消费者占用')
    expect(errors[0]!.msg).toContain('另一个实例')
    // 每轮 409 后都退避 60s（不崩不退出，期间继续轮询；第 3 轮退避后才见翻配置退出）
    expect(h.sleeps).toEqual([60_000, 60_000, 60_000])
    expect(h.getUpdatesCallCount()).toBe(3)
  })

  it('409 去重 5 分钟后过期：第 6 轮（假时钟累计 300s）重新 log 一次', async () => {
    const h = makeHarness()
    h.queueUpdates([conflictRes, conflictRes, conflictRes, conflictRes, conflictRes, conflictRes])
    h.stopAfterGetUpdates(6)
    h.controller.start()
    await h.controller.waitStopped()
    const errors = h.logs.filter((l) => l.level === 'error' && l.msg.includes('409'))
    // t=0 首条；t=60/120/180/240 抑制；t=300 时距首条 ≥5min → 第二条
    expect(errors).toHaveLength(2)
  })

  it('409 后恢复：退避一轮后正常拉取并处理指令（循环未崩）', async () => {
    const h = makeHarness()
    h.queueUpdates([
      conflictRes,
      updatesBody([{ id: 5, chatId: MAIN_CHAT, text: '/poll' }])
    ])
    h.stopAfterGetUpdates(3)
    h.controller.start()
    await h.controller.waitStopped()
    expect(h.sleeps).toEqual([60_000])
    expect(h.runNowCount()).toBe(1)
    expect(h.replies[0]!.text).toContain('已触发')
  })

  it('getUpdates 非 2xx（500）：warn + 退避 60s 重试，不退出', async () => {
    const h = makeHarness()
    h.queueUpdates([
      { status: 500, headers: {}, body: 'server boom' },
      updatesBody([{ id: 1, chatId: MAIN_CHAT, text: '/help' }])
    ])
    h.stopAfterGetUpdates(3)
    h.controller.start()
    await h.controller.waitStopped()
    expect(h.sleeps).toEqual([60_000])
    expect(h.logs.some((l) => l.level === 'warn' && l.msg.includes('HTTP 500'))).toBe(true)
    expect(h.replies[0]!.text).toContain('/status')
  })

  it('getUpdates 2xx 但载荷非法：warn + 退避重试，不退出', async () => {
    const h = makeHarness()
    h.queueUpdates([
      'not-json',
      updatesBody([{ id: 1, chatId: MAIN_CHAT, text: '/help' }])
    ])
    h.stopAfterGetUpdates(3)
    h.controller.start()
    await h.controller.waitStopped()
    expect(h.sleeps).toEqual([60_000])
    expect(h.logs.some((l) => l.level === 'warn' && l.msg.includes('parse failed'))).toBe(true)
    expect(h.replies[0]!.text).toContain('/status')
  })
})

describe('offset 与生命周期', () => {
  it('offset 内存推进：首批 update_id=100，下一次 getUpdates 带 offset=101', async () => {
    const h = makeHarness()
    h.queueUpdates([
      updatesBody([{ id: 100, chatId: MAIN_CHAT, text: '普通文本' }]),
      EMPTY_UPDATES
    ])
    h.stopAfterGetUpdates(2)
    h.controller.start()
    await h.controller.waitStopped()
    const first = h.calls.find((c) => c.url.includes('/getUpdates'))!
    const second = h.calls.filter((c) => c.url.includes('/getUpdates'))[1]!
    expect(first.url).not.toContain('offset=')
    expect(second.url).toContain('offset=101')
  })

  it('运行中 enabled 翻 false：循环自动退出（info log + isRunning false）', async () => {
    const h = makeHarness()
    h.queueUpdates([
      updatesBody([{ id: 1, chatId: MAIN_CHAT, text: '/status' }]),
      EMPTY_UPDATES
    ])
    h.stopAfterGetUpdates(2)
    h.controller.start()
    await h.controller.waitStopped()
    expect(h.controller.isRunning).toBe(false)
    expect(h.logs.some((l) => l.level === 'info' && l.msg.includes('disabled or credentials missing'))).toBe(
      true
    )
  })

  it('运行中凭据失效（getCredentials → null）：循环自动退出', async () => {
    const h = makeHarness()
    h.queueUpdates([
      EMPTY_UPDATES,
      () => {
        h.setCredentials(null)
        return EMPTY_UPDATES
      }
    ])
    h.controller.start()
    await h.controller.waitStopped()
    expect(h.controller.isRunning).toBe(false)
    expect(h.logs.some((l) => l.msg.includes('disabled or credentials missing'))).toBe(true)
  })

  it('stop()：立即停止（isRunning false）且幂等；循环随后退出不再发请求', async () => {
    const h = makeHarness()
    h.controller.start()
    expect(h.controller.isRunning).toBe(true)
    h.controller.stop()
    h.controller.stop() // 幂等：不抛
    expect(h.controller.isRunning).toBe(false)
    await h.controller.waitStopped()
    const callsAfterStop = h.calls.length
    await new Promise((r) => setTimeout(r, 5)) // 给微任务一拍，确认无新请求
    expect(h.calls.length).toBe(callsAfterStop)
  })

  it('stop → start 可重新启动（新循环正常工作）', async () => {
    const h = makeHarness()
    h.controller.start()
    h.controller.stop()
    await h.controller.waitStopped()
    h.setEnabled(true)
    h.queueUpdates([updatesBody([{ id: 1, chatId: MAIN_CHAT, text: '/poll' }])])
    h.stopAfterGetUpdates(2)
    h.controller.start()
    expect(h.controller.isRunning).toBe(true)
    await h.controller.waitStopped()
    expect(h.runNowCount()).toBe(1)
  })
})
