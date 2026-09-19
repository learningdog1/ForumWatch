/**
 * 随包资源路径解析。
 *
 * 项目根 `resources/` 目录在打包时由 electron-builder 作为 extraResources 带上
 * （落在 `process.resourcesPath/resources/` 下，目录结构原样保留）；
 * dev 下 app.getAppPath() = 项目根，直接从源码位置读。
 */
import { app } from 'electron'
import { join } from 'node:path'

/**
 * 解析资源绝对路径。
 * @param rel 相对 `resources/` 目录的路径，如 `icons/tray.png`
 */
export function resolveResource(rel: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'resources', rel)
    : join(app.getAppPath(), 'resources', rel)
}
