/**
 * 推送通道抽象（第六轮 R6-W1 契约改造；R6-W2 扩三通道实现）。
 *
 * - `Notifier`：通道无关的推送接口。engine 只依赖本接口（结构类型），具体通道
 *   （telegram + R6-W2 的 Bark/Ntfy/WebhookNotifier）实现它，W3 的
 *   router/composite 按路由规则把一次命中扇出到多个 Notifier。
 * - `HitMessageInput`：命中推送的通道无关输入，从旧 TelegramNotifier.sendHit 的
 *   四参签名提炼（topic/matchedKeywords/commentary/matchedRule）；semanticReason
 *   供 W2+ 通道文案/结构化字段消费；report 为 R6-W2 新增的 per-channel 结果回调。
 * - 通道就绪判定（isChannelReady / anyChannelReady / telegramCredentialsOf）：
 *   engine 的 configured 判定与桌面/headless 装配方共用的单一事实源——通道
 *   "已配置" = enabled 且类型有发送实现且凭据齐备。R6-W2 起 telegram/bark/ntfy/
 *   webhook 四类型均有发送实现（IMPLEMENTED_CHANNEL_TYPES）；bark/ntfy/webhook
 *   的发送器构造在 W4 装配方落地——本轮判定先行放开是契约内的中间态。
 */

import type { ChannelConfig, ChannelType, TelegramConfig, Topic } from '../../shared/types'

/** 命中推送的通道无关输入（R6-W1 从 TelegramNotifier.sendHit 参数形状提炼） */
export interface HitMessageInput {
  /** 命中帖（title/category/author/url 为文案素材；sourceId 供通道侧溯源） */
  topic: Topic
  /** 字面命中的关键词；semantic/rule 命中时为空数组 */
  matchedKeywords: string[]
  /** AI 锐评（可选）：null/undefined/空串 = 无锐评行 */
  commentary?: string | null
  /** 命中的价格规则 label（可选）：非空 = 规则命中（matchedBy='rule'）。展示用（文案「命中规则」行） */
  matchedRule?: string | null
  /**
   * 命中的价格规则 **id**（可选）：路由用——composite.routeContextOf 取它作
   * ctx.ruleId，与配置 when.ruleId（存规则 id）严格相等比较。matchedRule 是
   * 展示用 label，label ≠ id 的规则按 label 路由永不命中，故路由一律读这里。
   * 与 matchedRule 同源同生（engine 规则命中两字段都带；其他命中方式恒 null）。
   */
  matchedRuleId?: string | null
  /** 语义命中的 AI 判定理由（可选）：webhook 通道随 payload 透传，bark/ntfy 进摘要行 */
  semanticReason?: string | null
  /**
   * per-channel 推送结果回调（R6-W2，可选）：sendHit 的**最终**结果——
   * 成功调 `report(id, true)`；失败（含重试耗尽、凭据未配置）调
   * `report(id, false, error)` 后照常向上抛。engine 侧收集 per-channel 明细
   * （HitRecord.notifyDetail）；通道实现只管调用、不消费返回值，回调自身
   * 约定不抛（抛错会替换/叠加本次 sendHit 的失败语义）。
   * R6-W2 落地 bark/ntfy/webhook 三通道；telegram 的 report 接线由后续包补
   * （telegram.ts 不在 W2 文件清单，现行 sendHit 不读该字段，行为无害）。
   */
  report?: (channelId: string, ok: boolean, error?: string) => void
}

/**
 * sendRaw 的可选富文本（R19 报告推送）：`html` = 同一内容的 Telegram
 * parse_mode='HTML' 渲染（markdown-report 转换）。支持富文本的通道
 * （telegram）非空时用它发送，其余通道/空值一律用 text 纯文本——接口向后
 * 兼容：旧调用（单参）与只实现单参的通道（bark/ntfy/webhook）不受影响。
 */
export interface RawMessageOptions {
  html?: string
}

/**
 * 一个推送通道的发送接口。实现方契约：
 * - `id`：通道 id（与 ChannelConfig.id 一致；W3 起作为 HitRecord.notifyDetail
 *   的 per-channel 明细键）；
 * - `sendHit`：命中推送（各通道自行决定文案格式与转义）；失败抛 Error（message
 *   进 HitRecord.notifyError）；
 * - `sendRaw`：纯文本发送（日报等；不做转义）；R19 起可带 opts.html 富文本，
 *   不支持富文本的通道忽略 opts；
 * - `sendTest`：设置页「发送测试消息」用，固定文案。
 * 内部队列/限流/重试语义由各实现自理（telegram 的 1050ms 串行队列 + 429 退避
 * 是既有资产，W2 新通道按各自 API 限制决定）。
 */
export interface Notifier {
  readonly id: string
  sendHit(input: HitMessageInput): Promise<void>
  sendRaw(text: string, opts?: RawMessageOptions): Promise<void>
  sendTest(): Promise<void>
}

/** 已实现发送器的通道类型（R6-W2 扩 bark/ntfy/webhook；见文件头注释） */
const IMPLEMENTED_CHANNEL_TYPES: readonly ChannelType[] = ['telegram', 'bark', 'ntfy', 'webhook']

/**
 * 通道凭据是否齐备（按 type 分派的"可发送"口径；enabled 不在此判断）：
 * telegram = botToken+chatId 均非空；bark = deviceKey 非空；ntfy = topic 非空；
 * webhook = url 非空。（sanitize 已保证形状，这里防御式 trim 判空。）
 */
export function channelCredentialsComplete(ch: ChannelConfig): boolean {
  switch (ch.type) {
    case 'telegram':
      return ch.botToken.trim() !== '' && ch.chatId.trim() !== ''
    case 'bark':
      return ch.deviceKey.trim() !== ''
    case 'ntfy':
      return ch.topic.trim() !== ''
    case 'webhook':
      return ch.url.trim() !== ''
  }
}

/**
 * 通道是否就绪（engine 的 configured 判定的单一事实源）：
 * enabled 且类型已有发送实现（R6-W2 起 telegram/bark/ntfy/webhook 四类型）且凭据齐备。
 */
export function isChannelReady(ch: ChannelConfig): boolean {
  return (
    ch.enabled &&
    IMPLEMENTED_CHANNEL_TYPES.includes(ch.type) &&
    channelCredentialsComplete(ch)
  )
}

/** 是否存在任一就绪通道（engine configured / 日报推送条件共用） */
export function anyChannelReady(channels: ChannelConfig[]): boolean {
  return channels.some(isChannelReady)
}

/**
 * 第一个就绪 telegram 通道的凭据（桌面/headless 装配方构造 TelegramNotifier 的
 * getConfig 落点）。无就绪 telegram 通道 → 空凭据（TelegramNotifier.deliver 对
 * 空凭据抛 'telegram not configured'；engine 侧 configured 闸正常情况下已拦下，
 * 这里只是兜底）。单 telegram 通道时代（R6-W1）与旧 cfg.telegram 直读等价。
 */
export function telegramCredentialsOf(channels: ChannelConfig[]): TelegramConfig {
  for (const ch of channels) {
    if (ch.type === 'telegram' && isChannelReady(ch)) {
      return { botToken: ch.botToken, chatId: ch.chatId }
    }
  }
  return { botToken: '', chatId: '' }
}
