/**
 * Electron safeStorage → SecretBox 适配（R9-W2 / DEC-10）。
 *
 * **desktop 层唯一的 electron import 点**：内核（config/secrets.ts / store.ts）
 * 只见 SecretBox 接口，零 electron 依赖（ADR 2）。
 *
 * 时机（无需二段初始化）：safeStorage 的密钥库（macOS Keychain / Win DPAPI /
 * Linux kwallet）在主进程 app ready 之后才可用；本模块唯一的调用点是
 * DesktopRuntime 构造函数（runtime.ts）——它由 index.ts 在 `app.whenReady()`
 * 之后经 initRuntime 创建，所以 createSafeStorageBox() 被调时 safeStorage
 * 必然已可用，无需懒初始化 / init() 二段式（最小方案）。若未来出现 ready
 * 之前的构造点：safeStorage 在 Linux 上会误报不可用（降级明文 + warn），
 * 届时再补二段初始化。
 *
 * 降级与失败语义：
 * - isEncryptionAvailable()=false（Linux 无密钥库 / BasicText 模式等）→
 *   返回 PlainSecretBox（凭据明文落盘，config.json 仍 0o600）+ **一条** warn
 *   （createSafeStorageBox 每进程只调一次，warn 天然只打一条）。
 * - encrypt 单次失败（Keychain 被锁等）→ null（该字段明文落盘）；进程内只
 *   打一条 error（flag 去重——失败原因持续存在时不逐字段刷屏）。
 * - decrypt 失败（密钥轮换后旧密文解不开 / 密文损坏）→ 静默 null（该字段按
 *   未配置处理）——**汇总日志是调用方的职责**：store.readFromDisk 对整次
 *   load 只报一条"加密凭据解密失败"（去重口径见 secrets.ts）。
 */
import { safeStorage } from 'electron'
import { PlainSecretBox, SECRET_MARKER, type SecretBox } from '../config/secrets'

/** 日志出口（runtime 传它的 Logger；缺省 console——对齐 index.ts 的 pre-logger 风格） */
export interface SafeStorageLog {
  warn(msg: string): void
  error(msg: string): void
}

export function createSafeStorageBox(log: SafeStorageLog = console): SecretBox {
  let available = false
  try {
    available = safeStorage.isEncryptionAvailable()
  } catch (err) {
    log.warn(
      `[secrets] safeStorage.isEncryptionAvailable() threw, storing credentials in plain text: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return new PlainSecretBox()
  }
  if (!available) {
    log.warn('[secrets] OS keyring unavailable (safeStorage), credentials will be stored as plain text')
    return new PlainSecretBox()
  }

  let encryptFailureLogged = false
  return {
    isAvailable: () => true,
    encrypt: (plain: string): string | null => {
      try {
        // Buffer → base64：盘上形状 enc:v1:<base64>（marker 由内核侧统一约定）
        return SECRET_MARKER + safeStorage.encryptString(plain).toString('base64')
      } catch (err) {
        if (!encryptFailureLogged) {
          encryptFailureLogged = true
          log.error(
            `[secrets] encryptString failed, affected fields stored in plain text: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        }
        return null
      }
    },
    decrypt: (stored: string): string | null => {
      // 不带 marker 的值原样透传（明文兼容）——与 SecretBox 接口契约一致
      if (!stored.startsWith(SECRET_MARKER)) return stored
      try {
        return safeStorage.decryptString(Buffer.from(stored.slice(SECRET_MARKER.length), 'base64'))
      } catch {
        // 密钥轮换 / 密文损坏 → null：字段按未配置处理，由 store 汇总报错
        return null
      }
    }
  }
}
