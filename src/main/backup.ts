/**
 * 配置备份导出/导入的纯函数内核（R8-B / E4）。
 *
 * - 装配分工：本文件只做 pack（打包）/ unpack（验包）/ restorePlan（落盘方案），
 *   **零 electron、零 fs**——文件读写、dialog、原子写都在 desktop/ipc.ts 的
 *   handler 里（desktop 层允许 electron import；对齐 ADR 2 内核纯函数风格）。
 * - 备份件形状（JSON，单文件）：
 *   `{ kind:'forumwatch-backup', schemaVersion:1, appVersion, createdAt(ISO),
 *      config, seen, state, feedback? }`
 *   四段都是**已解析的 JSON 值**（装配方读 userData 下同名文件 parse 后传入）：
 *   - config：config.json 的完整信封 `{schemaVersion:3, config:AppConfig}`——
 *     原样搬运而非裸 AppConfig，导入端可复用 ConfigStore 的迁移/清洗读路径；
 *   - seen：seen.json 信封 `{schemaVersion:2, seen:SeenEntry[]}`；
 *   - state：state.json 信封 `{schemaVersion:2, sources:{...}}`；
 *   - feedback：feedback.json 信封 `{schemaVersion:1, entries:[...]}`，
 *     **可选段**（导出时文件缺失则不落键，导入时缺键不动现有 feedback.json）。
 * - restorePlan 的 ADR 8.9 不变式：seen 段无效（缺失/形状不对）→ 恢复方案里
 *   seen 置 null（装配层删除现有 seen.json，引擎下次启动空集重建）且 state 里
 *   **所有** sources 的 baselineDone 强制重置 false（空 seen × baselineDone=true
 *   会把来源首页整页当新帖推送——单页 mini 风暴）。seen 有效则两段原样透传。
 */
export const BACKUP_KIND = 'forumwatch-backup'
/** 备份件 schema 版本（备份格式自身演进时 +1，unpack 拒收不认识的主版本） */
export const BACKUP_SCHEMA_VERSION = 1

/** 解包成功的载荷：四段（feedback 可选） */
export interface BackupData {
  /** config.json 的完整信封（未验证内容，由 ConfigStore 读路径负责） */
  config: unknown
  /** seen.json 的完整信封 */
  seen: unknown
  /** state.json 的完整信封 */
  state: unknown
  /** feedback.json 的完整信封；缺段不落键 */
  feedback?: unknown
}

/** packBackup 入参：BackupData + 导出方应用版本 */
export interface PackBackupInput extends BackupData {
  appVersion: string
}

/**
 * 打包为备份件文本（JSON.stringify 默认无缩进——备份件给机器读，紧凑些）。
 * feedback === undefined 时**不落键**；createdAt 取当前时刻（pack 非确定性来源
 * 仅此一处，测试只断言可解析为近期 ISO，不断言精确值）。
 */
export function packBackup(input: PackBackupInput): string {
  const payload: Record<string, unknown> = {
    kind: BACKUP_KIND,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    appVersion: input.appVersion,
    createdAt: new Date().toISOString(),
    config: input.config,
    seen: input.seen,
    state: input.state
  }
  if (input.feedback !== undefined) payload['feedback'] = input.feedback
  return JSON.stringify(payload)
}

export type UnpackBackupResult =
  | { ok: true; data: BackupData }
  | { ok: false; error: string }

/**
 * 验包 + 拆包：JSON 合法性 → 根对象 → kind / schemaVersion / appVersion →
 * config / seen / state 三段存在性与对象形状（feedback 可选，给了须对象）。
 * 任何一步不过 → {ok:false, error}（人读中文，UI 原样展示），绝不抛。
 *
 * 注意段内**不深度校验**：config 的迁移/清洗交给 ConfigStore 读路径，seen/state
 * 的逐字段宽容收编交给各自的 load——这里只保证「是 ForumWatch 备份件、四段
 * 结构在」，防止把任意 JSON 当备份导进去；深校验留给真正消费数据的内核。
 */
export function unpackBackup(text: string): UnpackBackupResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: '不是合法的 JSON 文件' }
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: '备份文件形状不对：根不是 JSON 对象' }
  }
  const o = parsed as Record<string, unknown>
  if (o['kind'] !== BACKUP_KIND) {
    return { ok: false, error: '不是 ForumWatch 备份文件（kind 不符）' }
  }
  if (o['schemaVersion'] !== BACKUP_SCHEMA_VERSION) {
    return { ok: false, error: `不支持的备份格式版本：${String(o['schemaVersion'])}` }
  }
  if (typeof o['appVersion'] !== 'string' || o['appVersion'] === '') {
    return { ok: false, error: '备份缺少有效的 appVersion' }
  }
  for (const seg of ['config', 'seen', 'state'] as const) {
    if (!(seg in o)) return { ok: false, error: `备份缺少 ${seg} 段` }
  }
  if (!isPlainObject(o['config'])) {
    return { ok: false, error: 'config 段形状不对：须为对象（config.json 信封）' }
  }
  // seen.json 实际盘上形状是信封对象 {schemaVersion, seen:[...]}（非裸数组）
  if (!isPlainObject(o['seen'])) {
    return { ok: false, error: 'seen 段形状不对：须为对象（seen.json 信封）' }
  }
  if (!isPlainObject(o['state'])) {
    return { ok: false, error: 'state 段形状不对：须为对象（state.json 信封）' }
  }
  if ('feedback' in o && o['feedback'] !== undefined && !isPlainObject(o['feedback'])) {
    return { ok: false, error: 'feedback 段形状不对：须为对象（feedback.json 信封）' }
  }
  const data: BackupData = { config: o['config'], seen: o['seen'], state: o['state'] }
  if (o['feedback'] !== undefined) data.feedback = o['feedback']
  return { ok: true, data }
}

export interface RestorePlanOptions {
  /**
   * 恢复方当前应用版本。v1 备份无需按版本迁移，当前仅作日志/审计挂点；
   * 未来备份格式升级（schemaVersion 2+）时在这里分派迁移。
   */
  appVersion?: string
}

/** 落盘方案：seen=null 表示「删除现有 seen.json，引擎下次启动空集重建 + 补基线」 */
export interface RestorePlan {
  config: unknown
  /** null = 恢复时删除 seen.json（见 restorePlan；非 null = 原样写回） */
  seen: unknown | null
  state: unknown
}

/**
 * 制定落盘方案（纯函数，不碰盘）：
 * - seen 段**有效**（= dedup.ts 盘上可加载形状：`{schemaVersion:1|2, seen:数组}`，
 *   与 FileSeenStore 的 v1/v2 双版本兼容口径一致）→ seen/state 原样透传；
 * - seen 段无效（unpack 已保证非空对象，但仍可能 schemaVersion 不认识 / seen
 *   非数组）→ seen 置 null，且 state.sources 里所有条目的 baselineDone 强制
 *   false（ADR 8.9：配空 seen 重建基线，防止首页整页重推）。其余字段
 *   （totalHits / maxSeenTopicId）不动——它们与 seen 无耦合。
 */
export function restorePlan(data: BackupData, _opts: RestorePlanOptions = {}): RestorePlan {
  if (isValidSeen(data.seen)) {
    return { config: data.config, seen: data.seen, state: data.state }
  }
  return { config: data.config, seen: null, state: resetAllBaselines(data.state) }
}

/** seen 段有效性：与 dedup.ts looksCorrupt 的接受面一致（v1|v2 信封 + seen 数组） */
function isValidSeen(v: unknown): boolean {
  if (!isPlainObject(v)) return false
  const sv = (v as { schemaVersion?: unknown })['schemaVersion']
  if (sv !== 1 && sv !== 2) return false
  return Array.isArray((v as { seen?: unknown })['seen'])
}

/**
 * state.sources 全员 baselineDone → false。只改 true→false 的条目并重建外层
 * 对象（入参不突变）；条目缺 baselineDone / 非对象 / 已是 false 的原样保留——
 * 深度形状由 FileEngineState 读路径宽容收编，这里不越权重构。
 */
function resetAllBaselines(state: unknown): unknown {
  if (!isPlainObject(state)) return state // unpack 已拦；防御（永远不该走到）
  const sources = (state as { sources?: unknown })['sources']
  if (!isPlainObject(sources)) return state
  const next: Record<string, unknown> = {}
  let changed = false
  for (const [id, entry] of Object.entries(sources)) {
    if (isPlainObject(entry) && (entry as { baselineDone?: unknown })['baselineDone'] === true) {
      next[id] = { ...entry, baselineDone: false }
      changed = true
    } else {
      next[id] = entry
    }
  }
  return changed ? { ...state, sources: next } : state
}

/** 普通对象判定（非 null / 非数组；备份段的形状下限） */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
