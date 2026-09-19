import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'

// 临时最小入口：桌面集成阶段（S10/S11）会被替换为完整的
// 托盘 + 生命周期 + IPC 装配。当前只保证工程能起来。

function createWindow(): void {
  const win = new BrowserWindow({
    width: 980,
    height: 700,
    title: 'NodeSeek Monitor',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
