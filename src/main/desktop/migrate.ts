/**
 * userData 首启迁移（D1：NodeSeek Monitor → ForumWatch 更名落地）。
 *
 * - 触发条件：旧目录存在 且 新目录 `config.json` 不存在（新 config.json 即
 *   "已迁移"标记——config 只在用户保存设置时才落盘，但迁移自身的拷贝就足以立标记）。
 * - 拷贝 `config.json` / `seen.json` / `state.json`（`logs/` 刻意不拷）：**字节级复制**
 *   （Buffer 读 → 写目标目录 `.tmp-<pid>-<rand>` → chmod 0o600 → rename 原子落位），
 *   不做任何格式转换——v1/v2 的形状迁移由各自的 loader/ConfigStore 负责。
 * - 单文件失败只 warn 并继续（落多少用多少）；**绝不删旧目录**；目标同名文件已
 *   存在时跳过（不覆盖，保证迁移幂等、无数据丢失方向的操作）。
 * - 不变式（防单页推送风暴）：最终 seen.json 不在新目录 而 state.json 在 →
 *   把 state 里所有 baselineDone 语义字段强制置 false 后原子写回。
 *   空去重集 × baselineDone=true 会把整页旧帖当新帖推送；FileSeenStore 的
 *   rebuiltFromCorrupt 只覆盖"文件损坏"，覆盖不了"根本没拷过来"。
 *
 * 零 electron 依赖（目录路径由调用方注入），可在 node 下单测。
 */
import { randomInt } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

/** 参与迁移的文件（logs/ 不拷） */
const MIGRATION_FILES = ['config.json', 'seen.json', 'state.json'] as const

export interface UserDataMigrationInput {
  /** 旧版 userData 目录（appData/NodeSeek Monitor） */
  legacyDir: string
  /** 新版 userData 目录（app.getPath('userData')，已是 ForumWatch） */
  targetDir: string
  /** 日志出口（默认 console.log）；此时 logger 尚未初始化，注入便于单测静音 */
  log?: (message: string) => void
  /** 告警出口（默认 console.warn） */
  warn?: (message: string) => void
}

export interface UserDataMigrationResult {
  /** 是否满足条件执行了迁移流程（false = 无旧目录 / 已迁移） */
  ran: boolean
  /** 本次实际拷贝成功的文件名（按尝试顺序） */
  copied: string[]
  /** 是否触发了不变式修补（state.json 的 baselineDone 被强制重置） */
  baselineReset: boolean
}

/**
 * 执行一次性 userData 迁移。任何一步失败只 warn 并继续，绝不抛出、绝不删旧目录。
 */
export function migrateUserDataFiles(input: UserDataMigrationInput): UserDataMigrationResult {
  const log = input.log ?? ((message: string) => console.log(message))
  const warn = input.warn ?? ((message: string) => console.warn(message))
  const result: UserDataMigrationResult = { ran: false, copied: [], baselineReset: false }

  if (!existsSync(input.legacyDir)) return result
  if (existsSync(join(input.targetDir, 'config.json'))) return result // 已迁移标记（D1）

  result.ran = true
  try {
    mkdirSync(input.targetDir, { recursive: true })
  } catch (err) {
    warn(`[migrate] cannot create target dir ${input.targetDir}: ${describe(err)}`)
    return result
  }

  for (const name of MIGRATION_FILES) {
    const src = join(input.legacyDir, name)
    const dest = join(input.targetDir, name)
    if (!existsSync(src)) continue // 旧目录本来就没有：不拷（可能触发下方不变式）
    if (existsSync(dest)) continue // 目标已有：跳过，不覆盖
    try {
      copyFileAtomically(src, dest)
      result.copied.push(name)
    } catch (err) {
      warn(`[migrate] copy ${name} failed: ${describe(err)}`)
    }
  }

  result.baselineReset = resetBaselineIfSeenMissing(input.targetDir, warn)

  if (result.copied.length > 0) {
    log(
      `[migrate] ForumWatch: migrated ${result.copied.join(', ')} ` +
        `from legacy NodeSeek Monitor data (old directory left untouched)`
    )
  }
  return result
}

/**
 * 宽松解析 state.json 并把能找到的 baselineDone 语义字段全部置 false。
 * - v1 形状：顶层 `baselineDone: boolean`；
 * - v2 形状：`sources` 下的每个 source（Record 值或数组元素）的 `baselineDone`；
 * - 解析失败 / 没有任何 baselineDone 字段 → 返回 null（调用方保持文件原样：
 *   state 加载器对损坏内容会回默认值 baselineDone=false，本身即安全）。
 * 纯函数，不碰文件系统。
 */
export function patchStateForMissingSeen(raw: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  let patched = false

  if (typeof obj['baselineDone'] === 'boolean') {
    obj['baselineDone'] = false
    patched = true
  }

  const sources = obj['sources']
  const sourceList = Array.isArray(sources)
    ? sources
    : typeof sources === 'object' && sources !== null
      ? Object.values(sources)
      : []
  for (const source of sourceList) {
    if (typeof source !== 'object' || source === null) continue
    const s = source as Record<string, unknown>
    if (typeof s['baselineDone'] === 'boolean') {
      s['baselineDone'] = false
      patched = true
    }
  }

  return patched ? JSON.stringify(obj, null, 2) : null
}

// ---- 内部实现 ----------------------------------------------------------

/**
 * 不变式修补：seen.json 不在目标目录 而 state.json 在 → 重置其 baselineDone。
 * @returns 是否实际改写了 state.json
 */
function resetBaselineIfSeenMissing(targetDir: string, warn: (message: string) => void): boolean {
  const statePath = join(targetDir, 'state.json')
  if (existsSync(join(targetDir, 'seen.json')) || !existsSync(statePath)) return false

  let raw: string
  try {
    raw = readFileSync(statePath, 'utf-8')
  } catch (err) {
    warn(`[migrate] cannot read state.json for baseline reset: ${describe(err)}`)
    return false
  }

  const patched = patchStateForMissingSeen(raw)
  if (patched === null) {
    warn('[migrate] state.json has no parsable baselineDone field; leaving as-is ' +
      '(state loader treats unparsable content as baselineDone=false)')
    return false
  }
  try {
    writeAtomically(statePath, patched)
    warn('[migrate] seen.json missing: reset baselineDone=false in state.json to avoid push storm')
    return true
  } catch (err) {
    warn(`[migrate] writing patched state.json failed: ${describe(err)}`)
    return false
  }
}

/** 字节级拷贝：Buffer 读写（不做编码/格式转换）+ 原子落位 */
function copyFileAtomically(src: string, dest: string): void {
  writeAtomically(dest, readFileSync(src))
}

/** tmp + chmod 600 + rename 原子写；失败清理 tmp 后向上抛（模式同 config store） */
function writeAtomically(dest: string, content: string | Buffer): void {
  const tmpPath = `${dest}.tmp-${process.pid}-${randomInt(0, 0xffffff).toString(36)}`
  try {
    writeFileSync(tmpPath, content)
    chmodSync(tmpPath, 0o600)
    renameSync(tmpPath, dest)
  } catch (err) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // tmp 清理失败可忽略
    }
    throw err
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
