/**
 * 凭据字段加密内核（R9-W2 / DEC-10，坑10 顺序纪律）。
 *
 * - **内存中永远是明文**：消费方（AiProvider 的 apiKey / 各 Notifier 的
 *   botToken·deviceKey·secret）零改动；加密只发生在 store.save 序列化前的
 *   最后一刻，解密只发生在 store.readFromDisk 迁移之后、sanitize 之前。
 * - **坑10 顺序**：读 = migrate → **decrypt** → sanitize；写 = sanitize →
 *   **encrypt** → serialize。两个方向上 sanitize 看到的都只能是明文——
 *   密文（base64 含空格等任意字符）绝不能被 sanitize 的 trim 破坏。
 * - **盘上格式**：敏感字段值带 `enc:v1:` 前缀 + base64 密文；不带 marker 的
 *   值按明文兼容读（旧配置文件 / headless 写的明文盘直接可用）。信封**不写**
 *   `secretsEncrypted` 标志——"字段是否加密"是每个值自带 marker 的派生态，
 *   落盘成独立标志会出现第二事实源（标志说加密了而字段是明文 / 反之）。
 * - **headless 互操作（坑10）**：PlainSecretBox 对密文 decrypt 返回 null →
 *   字段按"未配置"处理（''），由调用方打一条 error——headless 读到桌面写
 *   的加密盘时凭据干净地失效，而不是把 base64 当 token 发出去。
 * - 零 electron 依赖（safeStorage 适配在 desktop/safe-storage-box.ts，
 *   本模块可在 node 下单测与 headless 直跑，ADR 2）。
 */
import type { AppConfig, ChannelConfig } from '../../shared/types'

/** 盘上密文值的前缀（v1 = safeStorage.encryptString 的 base64） */
export const SECRET_MARKER = 'enc:v1:'

/**
 * 凭据加解密容器（内核接口；desktop 侧实现见 safe-storage-box.ts）。
 * 实现方契约：encrypt/decrypt 绝不抛（失败返回 null，由调用方降级）。
 */
export interface SecretBox {
  /** 加密可用性；false 时调用方按明文存储（PlainSecretBox / safeStorage 不可用降级） */
  isAvailable(): boolean
  /** 明文 → 'enc:v1:<base64>'；不可用返回 null（调用方存明文） */
  encrypt(plain: string): string | null
  /**
   * 输入带 marker → 解密（失败 null = 调用方按未配置处理）；
   * 不带 marker → 原样返回（明文兼容）。
   */
  decrypt(stored: string): string | null
}

/**
 * 恒等实现（headless / safeStorage 不可用降级 / 测试缺省）：
 * isAvailable()=false、encrypt→null（存明文）；decrypt 对带 marker 的值返回
 * null——读到密文 = 字段未配置（坑10 互操作），明文原样透传。
 */
export class PlainSecretBox implements SecretBox {
  isAvailable(): boolean {
    return false
  }

  encrypt(_plain: string): string | null {
    return null
  }

  decrypt(stored: string): string | null {
    return stored.startsWith(SECRET_MARKER) ? null : stored
  }
}

/**
 * channels 侧敏感字段的单一事实源（判别联合按 type 收窄后才有对应键）：
 * telegram.botToken / bark.deviceKey / webhook.secret；ntfy 无敏感字段。
 * **新增通道类型的敏感字段必须同 commit 补这里**（对齐 sanitizeConfig 的
 * 坑4 白名单纪律），否则该字段以明文落盘。
 */
const CHANNEL_SECRET_FIELDS: ReadonlyArray<{ type: ChannelConfig['type']; field: string }> = [
  { type: 'telegram', field: 'botToken' },
  { type: 'bark', field: 'deviceKey' },
  { type: 'webhook', field: 'secret' }
]

/**
 * 敏感字段路径表（单一事实源，R9-W2）：ai.provider.apiKey + 上表派生的
 * channels[].{botToken,deviceKey,secret}。只做文档/测试面（代码遍历走上表 +
 * apiKey 一处，不反射本表）——测试据此断言字段覆盖完整。
 */
export const SECRET_FIELD_PATHS: readonly string[] = [
  'ai.provider.apiKey',
  ...CHANNEL_SECRET_FIELDS.map((e) => `channels[].${e.field}`)
]

/** decryptSecretFields 的失败汇报（整次 load 只置一次 true → 调用方只报一条 error） */
export interface SecretDecryptReport {
  /** 是否存在"带 marker 但解密失败"的字段（置 '' = 按未配置处理） */
  anyFailed: boolean
}

/**
 * 读路径解密（在 migrate 之后、sanitize 之前调用，坑10）：
 * 遍历 SECRET_FIELD_PATHS 覆盖的字段——带 marker 的值走 box.decrypt，
 * 失败（null）置 ''（= 未配置；webhook 的空 secret 随后会被 sanitize 剔键），
 * 不带 marker 的值 box.decrypt 原样透传（明文兼容）。
 *
 * 永远返回新对象（不改入参，对齐 sanitizeConfig 风格）；未变化的子对象
 * 原引用复用（浅拷贝开销最小化）。任何字段解密失败时 report.anyFailed=true，
 * **错误日志由调用方打**且整次 load 只打一条（去重语义见 report 注释）。
 */
export function decryptSecretFields(
  config: AppConfig,
  box: SecretBox,
  report?: SecretDecryptReport
): AppConfig {
  let anyFailed = false
  const decryptValue = (stored: string): string => {
    const plain = box.decrypt(stored)
    if (plain === null) {
      anyFailed = true
      return '' // 解密失败 → 按未配置处理（含 PlainSecretBox 读到密文的坑10 语义）
    }
    return plain
  }

  const next: AppConfig = { ...config }

  // ai.provider.apiKey（'' 无需过 box：不可能带 marker，且语义就是未配置）
  const apiKey = next.ai?.provider?.apiKey
  if (typeof apiKey === 'string' && apiKey !== '') {
    const plain = decryptValue(apiKey)
    if (plain !== apiKey) {
      next.ai = { ...next.ai, provider: { ...next.ai.provider, apiKey: plain } }
    }
  }

  // channels[]（按类型分派；ntfy 等无敏感字段的通道原样透传）
  if (Array.isArray(next.channels)) {
    let changed = false
    const channels = next.channels.map((ch): ChannelConfig => {
      const spec = CHANNEL_SECRET_FIELDS.find((e) => e.type === ch.type)
      if (spec === undefined) return ch
      // webhook.secret 可选：缺键 / 非字符串（盘上垃圾由 sanitize 兜底）不动
      const raw = (ch as unknown as Record<string, unknown>)[spec.field]
      if (typeof raw !== 'string' || raw === '') return ch
      const plain = decryptValue(raw)
      if (plain === raw) return ch
      changed = true
      return { ...ch, [spec.field]: plain } as ChannelConfig
    })
    if (changed) next.channels = channels
  }

  if (report !== undefined && anyFailed) report.anyFailed = true
  return next
}

/**
 * 写路径加密（在 sanitize 之后、序列化之前调用，坑10）：
 * box 可用且字段非空 → encrypt；已带 marker 的值跳过（**防双加密**——
 * 调用方意外把盘上密文喂回来时原样保留）；box 不可用（含 encrypt 返回
 * null 的失败兜底）→ 明文落盘（降级语义，可用性检查由 isAvailable 单点表达）。
 *
 * 永远返回新对象（不改入参）；box 不可用时直接原样返回入参。
 */
export function encryptSecretFields(config: AppConfig, box: SecretBox): AppConfig {
  if (!box.isAvailable()) return config
  const encryptValue = (plain: string): string => {
    if (plain === '' || plain.startsWith(SECRET_MARKER)) return plain
    const enc = box.encrypt(plain)
    return enc === null ? plain : enc
  }

  const next: AppConfig = { ...config }

  const apiKey = next.ai?.provider?.apiKey
  if (typeof apiKey === 'string' && apiKey !== '') {
    const enc = encryptValue(apiKey)
    if (enc !== apiKey) {
      next.ai = { ...next.ai, provider: { ...next.ai.provider, apiKey: enc } }
    }
  }

  if (Array.isArray(next.channels)) {
    let changed = false
    const channels = next.channels.map((ch): ChannelConfig => {
      const spec = CHANNEL_SECRET_FIELDS.find((e) => e.type === ch.type)
      if (spec === undefined) return ch
      const raw = (ch as unknown as Record<string, unknown>)[spec.field]
      if (typeof raw !== 'string' || raw === '') return ch
      const enc = encryptValue(raw)
      if (enc === raw) return ch
      changed = true
      return { ...ch, [spec.field]: enc } as ChannelConfig
    })
    if (changed) next.channels = channels
  }

  return next
}
