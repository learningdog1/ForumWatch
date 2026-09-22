/**
 * invoke 处理器表（src/main/server/api.ts）分类阶段报告三通道的处理器测试
 * （R17 Stage B 接入面；桌面 desktop/ipc.ts 的同款逻辑经两处「同源同口径」
 * 约定对齐——这里测的是处理器协议：kind 白名单 / 期键形状与缺省解析 /
 * 生成结果映射，内核 CategoryReportService 本体在 ai/category-report.test.ts）。
 *
 * 零 electron；createInvokeHandlers 会构造 UpdateChecker 并 start（15s 真实
 * setTimeout，避免测试进程残留计时器/发包）——套件全程 vi.useFakeTimers，
 * 计时器永不推进即永不触发。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInvokeHandlers, type WebApiContext } from './api'
import { createLogger } from '../logger'
import type { CategoryReportService } from '../ai/category-report'
import type { InvokeHandler } from './api'
import { IPC, type CategoryReportGenerateResult, type CategoryReportInfo, type CategoryReportListResult } from '../../shared/ipc'

// 不给 fileDir → 只写内存环，不落盘，测试零副作用
const logger = createLogger()

/** 分类报告服务桩：处理器只碰 listPeriods/loadReport/generate 三个面 */
interface ServiceStub {
  listPeriods: ReturnType<typeof vi.fn>
  loadReport: ReturnType<typeof vi.fn>
  generate: ReturnType<typeof vi.fn>
}

function makeStub(overrides?: Partial<ServiceStub>): ServiceStub {
  return {
    listPeriods: overrides?.listPeriods ?? vi.fn(() => [] as string[]),
    loadReport: overrides?.loadReport ?? vi.fn(async () => null as string | null),
    generate: overrides?.generate ?? vi.fn(async () => '# report')
  }
}

/** 组装处理器表（ctx 只填分类报告服务与 logger——被测通道不碰其余字段） */
function makeHandlers(stub: ServiceStub): Map<string, InvokeHandler> {
  const ctx = {
    dataDir: '/nonexistent',
    logger,
    categoryReportService: stub as unknown as CategoryReportService
  } as unknown as WebApiContext
  return createInvokeHandlers(ctx)
}

const expectInfo = async (
  handlers: Map<string, InvokeHandler>,
  args: unknown[]
): Promise<CategoryReportInfo> =>
  (await handlers.get(IPC.getCategoryReport)!(args)) as CategoryReportInfo

const expectList = async (
  handlers: Map<string, InvokeHandler>,
  args: unknown[]
): Promise<CategoryReportListResult> =>
  (await handlers.get(IPC.listCategoryReports)!(args)) as CategoryReportListResult

const expectGenerate = async (
  handlers: Map<string, InvokeHandler>,
  args: unknown[]
): Promise<CategoryReportGenerateResult> =>
  (await handlers.get(IPC.generateCategoryReport)!(args)) as CategoryReportGenerateResult

beforeAll(() => {
  vi.useFakeTimers()
})

describe('invoke 处理器 · 分类阶段报告（R17）', () => {
  beforeEach(() => {
    vi.clearAllTimers()
  })

  it('category-report:get：显式合法期键 → 回显期键 + 该期全文', async () => {
    const stub = makeStub({
      listPeriods: vi.fn(() => ['2026-09-13', '2026-09-06']),
      loadReport: vi.fn(async () => '# 分类总结报告·09-07 ~ 09-13')
    })
    const h = makeHandlers(stub)
    const r = await expectInfo(h, ['weekly', '2026-09-06'])
    expect(r).toEqual({
      kind: 'weekly',
      periodKey: '2026-09-06',
      markdown: '# 分类总结报告·09-07 ~ 09-13'
    })
    expect(stub.loadReport).toHaveBeenCalledWith('weekly', '2026-09-06')
    // 显式期键不依赖列表（listPeriods 只为缺省解析服务，不影响回显）
    expect(stub.listPeriods).toHaveBeenCalledTimes(1)
  })

  it('category-report:get：期键缺省 → 该档最新一期（listPeriods[0]）', async () => {
    const stub = makeStub({
      listPeriods: vi.fn(() => ['2026-09-20', '2026-09-13']),
      loadReport: vi.fn(async () => '# 最新一期')
    })
    const h = makeHandlers(stub)
    const r = await expectInfo(h, ['daily'])
    expect(r.periodKey).toBe('2026-09-20')
    expect(r.markdown).toBe('# 最新一期')
  })

  it('category-report:get：一期都没有 → periodKey=当前期形状、markdown=null', async () => {
    const stub = makeStub({ listPeriods: vi.fn(() => []), loadReport: vi.fn(async () => null) })
    const h = makeHandlers(stub)
    const monthly = await expectInfo(h, ['monthly'])
    expect(monthly.periodKey).toMatch(/^\d{4}-\d{2}$/)
    expect(monthly.markdown).toBeNull()
    const daily = await expectInfo(h, ['daily'])
    expect(daily.periodKey).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(daily.markdown).toBeNull()
  })

  it('category-report:get：期键形状按档锚定，路径穿越串按缺省处理且绝不进读路径', async () => {
    const stub = makeStub({
      listPeriods: vi.fn((kind: string) => (kind === 'monthly' ? ['2026-08'] : ['2026-09-13'])),
      loadReport: vi.fn(async () => null)
    })
    const h = makeHandlers(stub)
    // daily/weekly 只认 'YYYY-MM-DD'：路径串形状非法 → 回退该档最新一期
    const traversal = await expectInfo(h, ['daily', '../../etc/passwd'])
    expect(traversal.periodKey).toBe('2026-09-13')
    // monthly 只认 'YYYY-MM'：给日键 = 非法 → 回退月档最新一期（与传入串不同名，断言无歧义）
    const wrongShape = await expectInfo(h, ['monthly', '2026-09-13'])
    expect(wrongShape.periodKey).toBe('2026-08')
    expect(stub.loadReport).toHaveBeenLastCalledWith('monthly', '2026-08')
    // 全部 loadReport 调用的期键都不含路径片段
    for (const call of stub.loadReport.mock.calls) {
      expect(String(call[1])).toMatch(/^\d{4}-\d{2}(-\d{2})?$/)
    }
  })

  it('category-report:get：kind 非法按 daily 处理（查询面不抛）', async () => {
    const stub = makeStub({
      listPeriods: vi.fn(() => ['2026-09-13']),
      loadReport: vi.fn(async () => null)
    })
    const h = makeHandlers(stub)
    const r = await expectInfo(h, ['yearly' /* 非法 */, undefined, '多余参数被忽略'])
    expect(r.kind).toBe('daily')
  })

  it('category-report:generate：成功带 periodFor 当前期的期键形状与全文', async () => {
    const stub = makeStub({ generate: vi.fn(async () => '# 生成的报告') })
    const h = makeHandlers(stub)
    const r = await expectGenerate(h, ['weekly'])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.periodKey).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(r.markdown).toBe('# 生成的报告')
    }
    expect(stub.generate).toHaveBeenCalledWith('weekly')
  })

  it('category-report:generate：期键在调用 generate 之前算好——生成跨本地午夜不漂到次日', async () => {
    // 23:59:59.900 发起；generate 执行期间（读存档/调 LLM）翻到次日 00:00:30
    vi.setSystemTime(new Date(2026, 8, 18, 23, 59, 59, 900))
    const stub = makeStub({
      generate: vi.fn(async () => {
        vi.setSystemTime(new Date(2026, 8, 19, 0, 0, 30, 0))
        return '# 跨午夜生成的报告'
      })
    })
    const h = makeHandlers(stub)
    const r = await expectGenerate(h, ['daily'])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.periodKey).toBe('2026-09-18') // 发起时的期，不是生成完成时刻的期
      expect(r.markdown).toBe('# 跨午夜生成的报告')
    }
    // 同理 monthly：月末深夜发起（期=2026-08）、次月 1 日完成（期会翻到 2026-09）
    // → 返回发起时的 2026-08
    vi.setSystemTime(new Date(2026, 8, 30, 23, 59, 59, 900))
    const stubM = makeStub({
      generate: vi.fn(async () => {
        vi.setSystemTime(new Date(2026, 9, 1, 0, 0, 10, 0))
        return '# 月末跨午夜'
      })
    })
    const rM = await expectGenerate(makeHandlers(stubM), ['monthly'])
    expect(rM.ok).toBe(true)
    if (rM.ok) expect(rM.periodKey).toBe('2026-08')
    vi.setSystemTime(new Date()) // 还原系统时间，不污染后续用例
  })

  it('category-report:generate：失败收敛 ok:false；kind 非法不触发生成', async () => {
    const stub = makeStub({
      generate: vi.fn(async () => {
        throw new Error('reports dir not writable')
      })
    })
    const h = makeHandlers(stub)
    const r = await expectGenerate(h, ['daily'])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('not writable')

    const bad = await expectGenerate(h, ['sometimes'])
    expect(bad.ok).toBe(false)
    expect(stub.generate).toHaveBeenCalledTimes(1) // 只被 daily 那次调用
  })

  it('category-report:list：返回该档期键列表；kind 非法按 daily', async () => {
    const stub = makeStub({
      listPeriods: vi.fn((kind: string) => (kind === 'monthly' ? ['2026-08', '2026-07'] : ['2026-09-13']))
    })
    const h = makeHandlers(stub)
    const monthly = await expectList(h, ['monthly'])
    expect(monthly.periods).toEqual(['2026-08', '2026-07'])
    const bad = await expectList(h, [undefined])
    expect(bad.periods).toEqual(['2026-09-13'])
    expect(stub.listPeriods).toHaveBeenLastCalledWith('daily')
  })
})
