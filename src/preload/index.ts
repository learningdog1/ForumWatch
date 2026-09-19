/**
 * preload（contextIsolation 开启）：只经 contextBridge 暴露白名单 API。
 * 形状单一事实源是 src/shared/ipc.ts 的 DesktopApi；通道名/载荷类型全走 IPC 常量。
 * 事件订阅（onStatus/onHit/onLog/onDailyReport）返回取消订阅函数，渲染进程卸载
 * 组件时调用。
 */
import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type DesktopApi, type MatchTestRequest } from '../shared/ipc'
import type { DailyReportInfo, EngineStatus, HitRecord, LogEntry } from '../shared/types'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T): void => {
    callback(payload)
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: DesktopApi = {
  getConfig: () => ipcRenderer.invoke(IPC.getConfig),
  saveConfig: (config) => ipcRenderer.invoke(IPC.saveConfig, config),
  getStatus: () => ipcRenderer.invoke(IPC.getStatus),
  getHits: () => ipcRenderer.invoke(IPC.getHits),
  getLogs: () => ipcRenderer.invoke(IPC.getLogs),
  engineControl: (command) => ipcRenderer.invoke(IPC.engineControl, command),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  // AI / 日报（主进程 W2-c 已接入：Provider 连通性测试 + 日报生成/查询）
  testAiProvider: () => ipcRenderer.invoke(IPC.testAiProvider),
  getDailyReport: (dateLocal) => ipcRenderer.invoke(IPC.getDailyReport, dateLocal),
  generateDailyReport: () => ipcRenderer.invoke(IPC.generateDailyReport),
  listDailyReports: () => ipcRenderer.invoke(IPC.listDailyReports),
  // 匹配测试台（R5-P2c）：主进程按已保存配置跑判定管线，返回逐阶段 trace
  matchTest: (req: MatchTestRequest) => ipcRenderer.invoke(IPC.matchTest, req),
  onStatus: (callback) => subscribe<EngineStatus>(IPC.evStatus, callback),
  onHit: (callback) => subscribe<HitRecord>(IPC.evHit, callback),
  onLog: (callback) => subscribe<LogEntry>(IPC.evLog, callback),
  onDailyReport: (callback) => subscribe<DailyReportInfo>(IPC.evDailyReport, callback)
}

contextBridge.exposeInMainWorld('api', api)
