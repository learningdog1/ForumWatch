/**
 * 备份内核单测（R8-B / E4）：pack/unpack 往返、篡改件拒收矩阵、
 * restorePlan 的 seen 有效性 → baseline 重置矩阵（ADR 8.9）。
 */
import { describe, expect, it } from 'vitest'
import {
  BACKUP_KIND,
  BACKUP_SCHEMA_VERSION,
  packBackup,
  restorePlan,
  unpackBackup
} from './backup'

/** 与盘上一致的真实段落样本（信封原样，不裸拆） */
const CONFIG = { schemaVersion: 3, config: { includeKeywords: ['vps'], pollIntervalSec: 60 } }
const SEEN = {
  schemaVersion: 2,
  seen: [
    { id: 'nodeseek:123', addedAt: 1 },
    { id: 'v2ex:456', addedAt: 2 }
  ]
}
const STATE = {
  schemaVersion: 2,
  sources: {
    nodeseek: { baselineDone: true, totalHits: 7, maxSeenTopicId: 999 },
    v2ex: { baselineDone: true, totalHits: 0, maxSeenTopicId: null },
    rssNew: { baselineDone: false, totalHits: 0, maxSeenTopicId: null }
  }
}
const FEEDBACK = {
  schemaVersion: 1,
  entries: [{ key: 'nodeseek:123', title: '好帖', direction: 'positive', ts: '2026-09-01T00:00:00.000Z' }]
}

describe('packBackup', () => {
  it('形状：kind/schemaVersion/appVersion/createdAt/四段；feedback 缺省不落键', () => {
    const before = Date.now()
    const withFb = JSON.parse(
      packBackup({ appVersion: '0.2.0', config: CONFIG, seen: SEEN, state: STATE, feedback: FEEDBACK })
    ) as Record<string, unknown>
    const withoutFb = JSON.parse(
      packBackup({ appVersion: '0.2.0', config: CONFIG, seen: SEEN, state: STATE })
    ) as Record<string, unknown>

    expect(withFb['kind']).toBe(BACKUP_KIND)
    expect(withFb['schemaVersion']).toBe(BACKUP_SCHEMA_VERSION)
    expect(withFb['appVersion']).toBe('0.2.0')
    // createdAt 是近期 ISO（pack 的唯一非确定来源，只验时间窗）
    const created = Date.parse(String(withFb['createdAt']))
    expect(created).toBeGreaterThanOrEqual(before)
    expect(created).toBeLessThanOrEqual(Date.now() + 1_000)
    expect(withFb['config']).toEqual(CONFIG)
    expect(withFb['seen']).toEqual(SEEN)
    expect(withFb['state']).toEqual(STATE)
    expect(withFb['feedback']).toEqual(FEEDBACK)

    expect('feedback' in withoutFb).toBe(false)
  })

  it('段为已解析的 JSON 值原样透传（不 stringify 不再包信封）', () => {
    const parsed = JSON.parse(
      packBackup({ appVersion: '0.2.0', config: CONFIG, seen: SEEN, state: STATE })
    ) as { config: unknown; seen: unknown; state: unknown }
    expect(parsed.config).toEqual(CONFIG)
    expect(parsed.seen).toEqual(SEEN)
    expect(parsed.state).toEqual(STATE)
  })
})

describe('pack → unpack 往返', () => {
  it('带 feedback：unpack 得到与入参相等的四段', () => {
    const text = packBackup({
      appVersion: '0.2.0',
      config: CONFIG,
      seen: SEEN,
      state: STATE,
      feedback: FEEDBACK
    })
    const r = unpackBackup(text)
    expect(r).toEqual({ ok: true, data: { config: CONFIG, seen: SEEN, state: STATE, feedback: FEEDBACK } })
  })

  it('不带 feedback：data 无 feedback 键', () => {
    const r = unpackBackup(packBackup({ appVersion: '0.2.0', config: CONFIG, seen: SEEN, state: STATE }))
    expect(r.ok).toBe(true)
    if (r.ok) expect('feedback' in r.data).toBe(false)
  })

  it('空 seen / 空 state（fresh install 导出的默认信封）也能往返', () => {
    const r = unpackBackup(
      packBackup({
        appVersion: '0.2.0',
        config: CONFIG,
        seen: { schemaVersion: 2, seen: [] },
        state: { schemaVersion: 2, sources: {} }
      })
    )
    expect(r.ok).toBe(true)
  })
})

describe('unpackBackup 拒收矩阵（篡改件）', () => {
  const base = (): Record<string, unknown> => ({
    kind: BACKUP_KIND,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    appVersion: '0.2.0',
    createdAt: '2026-09-19T00:00:00.000Z',
    config: CONFIG,
    seen: SEEN,
    state: STATE
  })

  it('非 JSON 文本', () => {
    expect(unpackBackup('not json at all')).toMatchObject({ ok: false })
  })

  it('kind 错（别的工具的备份/随手 JSON）', () => {
    const bad = base()
    bad['kind'] = 'something-else'
    expect(unpackBackup(JSON.stringify(bad))).toMatchObject({ ok: false })
  })

  it('schemaVersion 错（未来格式）', () => {
    const bad = base()
    bad['schemaVersion'] = 2
    expect(unpackBackup(JSON.stringify(bad))).toMatchObject({ ok: false })
  })

  it('appVersion 缺失 / 非字符串', () => {
    const noVer = base()
    delete noVer['appVersion']
    expect(unpackBackup(JSON.stringify(noVer))).toMatchObject({ ok: false })
    const badVer = base()
    badVer['appVersion'] = 0.2
    expect(unpackBackup(JSON.stringify(badVer))).toMatchObject({ ok: false })
  })

  it('段缺失：config / seen / state 任一缺失', () => {
    for (const seg of ['config', 'seen', 'state']) {
      const bad = base()
      delete bad[seg]
      const r = unpackBackup(JSON.stringify(bad))
      expect(r).toMatchObject({ ok: false })
      if (!r.ok) expect(r.error).toContain(seg)
    }
  })

  it('段形状不对：config 数组 / seen 数组（盘上是信封对象） / state 字符串 / feedback 数组', () => {
    const c = base()
    c['config'] = [CONFIG]
    expect(unpackBackup(JSON.stringify(c))).toMatchObject({ ok: false })

    const s = base()
    s['seen'] = SEEN.seen // 裸数组：不是 seen.json 的盘上形状
    expect(unpackBackup(JSON.stringify(s))).toMatchObject({ ok: false })

    const st = base()
    st['state'] = 'nope'
    expect(unpackBackup(JSON.stringify(st))).toMatchObject({ ok: false })

    const f = base()
    f['feedback'] = FEEDBACK.entries
    expect(unpackBackup(JSON.stringify(f))).toMatchObject({ ok: false })
  })

  it('根不是对象（数组 / 数字 / JSON null）', () => {
    expect(unpackBackup('[]')).toMatchObject({ ok: false })
    expect(unpackBackup('42')).toMatchObject({ ok: false })
    expect(unpackBackup('null')).toMatchObject({ ok: false })
  })
})

describe('restorePlan（ADR 8.9 不变式）', () => {
  it('seen 有效（v2 信封 + seen 数组）→ seen/state 原样透传', () => {
    const plan = restorePlan({ config: CONFIG, seen: SEEN, state: STATE })
    expect(plan).toEqual({ config: CONFIG, seen: SEEN, state: STATE })
    // baselineDone 保持 true（不无谓重置——补基线会漏一轮推送窗口）
    const sources = (plan.state as typeof STATE).sources
    expect(sources['nodeseek'].baselineDone).toBe(true)
  })

  it('seen 有效（v1 信封，旧备份）→ 同样原样透传', () => {
    const v1 = { schemaVersion: 1, seen: [{ id: '123', addedAt: 1 }] }
    const plan = restorePlan({ config: CONFIG, seen: v1, state: STATE })
    expect(plan.seen).toEqual(v1)
    expect(plan.state).toEqual(STATE)
  })

  it('seen 缺失 → seen=null + 所有 sources 的 baselineDone 强制 false（其余字段不动）', () => {
    const plan = restorePlan({ config: CONFIG, seen: undefined, state: STATE })
    expect(plan.seen).toBeNull()
    const sources = (plan.state as typeof STATE).sources
    expect(sources['nodeseek']).toEqual({ baselineDone: false, totalHits: 7, maxSeenTopicId: 999 })
    expect(sources['v2ex']).toEqual({ baselineDone: false, totalHits: 0, maxSeenTopicId: null })
    // 已是 false 的条目原样（不重建对象也无妨，只看结果）
    expect(sources['rssNew'].baselineDone).toBe(false)
    // config 段不动
    expect(plan.config).toEqual(CONFIG)
  })

  it('seen 形状不对（schemaVersion 不认识 / seen 非数组）→ 同缺失处理', () => {
    for (const bad of [
      { schemaVersion: 3, seen: [] }, // 未来版本
      { schemaVersion: 2, seen: 'oops' }, // 非数组
      { schemaVersion: 2 }, // 无 seen 键
      {} // 空对象
    ]) {
      const plan = restorePlan({ config: CONFIG, seen: bad, state: STATE })
      expect(plan.seen).toBeNull()
      expect((plan.state as typeof STATE).sources['nodeseek'].baselineDone).toBe(false)
    }
  })

  it('state 无 sources / 空对象：重置分支不炸、原样返回', () => {
    const emptyState = { schemaVersion: 2, sources: {} }
    const plan = restorePlan({ config: CONFIG, seen: undefined, state: emptyState })
    expect(plan.seen).toBeNull()
    expect(plan.state).toEqual(emptyState)

    const noSourcesKey = { schemaVersion: 2 }
    expect(restorePlan({ config: CONFIG, seen: [], state: noSourcesKey }).state).toEqual(noSourcesKey)
  })

  it('入参不突变（resetAllBaselines 重建对象而非就地改）', () => {
    const stateSnapshot = JSON.parse(JSON.stringify(STATE)) as typeof STATE
    restorePlan({ config: CONFIG, seen: undefined, state: STATE })
    expect(STATE).toEqual(stateSnapshot)
  })

  it('feedback 段透传（装配层决定写不写 feedback.json）', () => {
    const plan = restorePlan({ config: CONFIG, seen: SEEN, state: STATE, feedback: FEEDBACK })
    expect(plan.seen).toEqual(SEEN) // feedback 与 seen 有效性无耦合
    // plan 形状不含 feedback（写回决定权在装配方经 unpack 的 data）
  })
})
