/**
 * 组合通知器（第六轮 R6-W3；DEC-9 坑9：any-success 聚合）。
 *
 * 把"一次命中推给哪些通道"的扇出决策（router.resolveChannelIds）与"逐通道
 * 发送 + 聚合结果"合在一个 Notifier 里——engine 仍只见单个 Notifier，不感知
 * 通道数（W1 契约不变）。
 *
 * - 路由（sendHit）：从 HitMessageInput 推导 RouteContext（matchedKeywords 非空
 *   → literal；matchedRule 非空 → rule；否则 semantic——与 engine.processHit
 *   的三档命中传参约定一致：literal/semantic 命中恒传 matchedRule=null），
 *   resolveChannelIds → null 则目标=全部 notifiers（默认全员广播），非 null
 *   则目标=id 命中的 notifiers（id 不在列表里的忽略）。**每次发送 getRouting()
 *   现读**，配置热更新即时生效。
 * - 发送：逐通道**串行**（保序；通道自身还有内部队列/限流，串行外层避免多通道
 *   并发打爆共享代理）。单通道异常 catch 后继续发其余通道（一个通道挂不连坐）。
 * - per-channel 明细：各通道在 sendHit 内部经 `input.report?.(channelId, ok,
 *   error)` 自报（composite 原样透传 input，不包装不复制、**不重复调用
 *   report**）——per-channel 结果与聚合结果同源一次发送，不会两套口径。
 * - 聚合（DEC-9 坑9）：**任一成功 → resolve**（engine 记成功、入去重集）；
 *   **全部失败 → throw** 聚合错误（engine 记 notifyError、下轮重试——单通道
 *   部分失败时其余通道已收到，重试会重复推给它们，这是 any-success 语义的
 *   已知取舍：宁可重复不可漏推）；目标为 0 个通道（规则把通道清空 / 规则指向
 *   的通道无就绪 notifier——W4 只为就绪通道构造发送器，配置在但未就绪的通道
 *   id 会路由命中却无发送方 / notifiers 本身为空）→ throw 'no channel
 *   available'。
 * - sendRaw / sendTest：**广播全部 notifiers，不走路由**（日报/测试消息语义
 *   上属于"全体"，不该被某来源的路由规则劫走），聚合语义同上。
 * - 聚合错误消息：`all channels failed: a: <err>; b: <err>`，每通道错误取
 *   `err.message`（非 Error 取 String(err)）并截断 200 字符——对齐 telegram.ts
 *   `lastDetail.slice(0, 200)` 的既有脱敏口径（响应体/错误文本不无限进
 *   HitRecord.notifyError 与日志）。
 */

import type { RoutingRule } from '@shared/types'
import type { HitMessageInput, Notifier } from './types'
import { resolveChannelIds, type RouteContext } from './router'

/** 聚合错误里单通道错误明细的截断长度（对齐 telegram.ts 的 200 字符口径） */
const ERROR_DETAIL_MAX_CHARS = 200

export interface CompositeNotifierOptions {
  /** 每次发送现读当前生效的路由规则（配置热更新即时生效） */
  getRouting: () => RoutingRule[]
  /**
   * 时钟注入（测试/装配用）。当前实现的行为与时间无关、不消费它；留在选项
   * 形状里是为与 W1-queue / 后续 digest 装配参数保持稳定契约。
   */
  now?: () => Date
}

/** 一个目标通道的发送结果（聚合决策用；per-channel 明细由通道自报 report） */
interface ChannelOutcome {
  id: string
  ok: boolean
  error?: string
}

export class CompositeNotifier implements Notifier {
  /** 固定 'composite'（仅日志/调试用途标识，不是 ChannelConfig.id） */
  readonly id = 'composite'
  private readonly notifiers: Notifier[]
  private readonly getRouting: () => RoutingRule[]

  constructor(notifiers: Notifier[], opts: CompositeNotifierOptions) {
    // 浅拷贝：装配侧事后增删数组元素不影响已构造 composite 的扇出集合
    this.notifiers = [...notifiers]
    this.getRouting = opts.getRouting
  }

  /**
   * 命中推送：路由 → 逐通道串行发送 → 聚合。input 原样透传给每个目标通道
   * （各通道自行消费 report 回调自报明细，见文件头）。
   */
  async sendHit(input: HitMessageInput): Promise<void> {
    const ids = resolveChannelIds(routeContextOf(input), this.getRouting())
    const targets = ids === null ? this.notifiers : this.notifiers.filter((n) => ids.includes(n.id))
    await this.fanOut(targets, (n) => n.sendHit(input))
  }

  /** 纯文本（日报）：广播全部通道，不走路由 */
  async sendRaw(text: string): Promise<void> {
    await this.fanOut(this.notifiers, (n) => n.sendRaw(text))
  }

  /** 测试消息：广播全部通道，不走路由 */
  async sendTest(): Promise<void> {
    await this.fanOut(this.notifiers, (n) => n.sendTest())
  }

  /**
   * 逐通道串行发送 + 聚合（DEC-9 坑9）：单通道 throw 被 catch、继续其余通道；
   * any-success → 正常返回；全失败 → throw `all channels failed: …`；
   * 目标为空 → throw 'no channel available'。
   */
  private async fanOut(targets: Notifier[], op: (n: Notifier) => Promise<void>): Promise<void> {
    if (targets.length === 0) throw new Error('no channel available')
    const outcomes: ChannelOutcome[] = []
    for (const n of targets) {
      try {
        await op(n) // for..of + await：严格串行保序
        outcomes.push({ id: n.id, ok: true })
      } catch (err) {
        outcomes.push({ id: n.id, ok: false, error: describeError(err) })
      }
    }
    if (outcomes.every((o) => !o.ok)) {
      const detail = outcomes.map((o) => `${o.id}: ${o.error ?? 'unknown error'}`).join('; ')
      throw new Error(`all channels failed: ${detail}`)
    }
  }
}

/**
 * 从 HitMessageInput 推导路由上下文。matchedBy 推导优先级与 engine 的命中
 * 管线互斥性一致：matchedKeywords 非空 → literal；否则 matchedRule 非空 →
 * rule（engine 仅规则命中传非空 matchedRule，且此时 matchedKeywords 恒空，
 * 两条件现实里不并存，这里按 literal 优先防御）；否则 semantic。
 */
function routeContextOf(input: HitMessageInput): RouteContext {
  const isRule = typeof input.matchedRule === 'string' && input.matchedRule.length > 0
  const matchedBy: RouteContext['matchedBy'] =
    input.matchedKeywords.length > 0 ? 'literal' : isRule ? 'rule' : 'semantic'
  return {
    sourceId: input.topic.sourceId,
    matchedBy,
    ruleId: isRule ? (input.matchedRule as string) : null
  }
}

/** 错误脱敏：Error 取 message、其余 String()，空消息兜底，截断 200 字符 */
function describeError(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err)) || 'unknown error'
  return msg.length > ERROR_DETAIL_MAX_CHARS ? msg.slice(0, ERROR_DETAIL_MAX_CHARS) : msg
}
