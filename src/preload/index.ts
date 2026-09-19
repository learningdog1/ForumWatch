import { contextBridge } from 'electron'

// 占位：S11 IPC 契约冻结后由 desktop 集成替换为白名单 API。

contextBridge.exposeInMainWorld('api', {
  ping: (): string => 'pong'
})
