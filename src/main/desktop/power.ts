/**
 * 电源事件钩子（ADR 8.1 / 8.2 / D5）：
 * - powerMonitor resume → rt.onPowerResume()：engine.runNow() 立即补一轮 +
 *   日报 tick 补做（睡眠可能跨过当天 timeHHMM）。两者内部都尊重 desired，
 *   暂停期间是 no-op，不会被系统事件偷偷唤醒。
 * - unlock-screen → engine.runNow()（不触发日报 tick——亮屏不等于睡醒跨点）。
 * - powerSaveBlocker('prevent-app-suspension')：desired=running 时持有，
 *   pause / quit（shutdown 先 engine.pause，同样触发状态事件）时释放，
 *   防 macOS App Nap 挂起定时器。
 * 由 engine onStatus 驱动，全程订阅 runtime 的单一事实源。
 */
import { powerMonitor, powerSaveBlocker } from 'electron'
import type { DesktopRuntime } from './runtime'

export function attachPowerHooks(rt: DesktopRuntime): void {
  powerMonitor.on('resume', () => rt.onPowerResume())
  powerMonitor.on('unlock-screen', () => rt.engine.runNow())

  let blockerId: number | null = null

  rt.onStatus((status) => {
    if (status.desired === 'running') {
      if (blockerId === null || !powerSaveBlocker.isStarted(blockerId)) {
        blockerId = powerSaveBlocker.start('prevent-app-suspension')
        rt.logger.info(`powerSaveBlocker started (id=${blockerId})`)
      }
    } else if (blockerId !== null) {
      if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId)
      blockerId = null
      rt.logger.info('powerSaveBlocker stopped')
    }
  })
}
