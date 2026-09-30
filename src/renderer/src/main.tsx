import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installWebApiIfAbsent } from './lib/web-shim'
import { initTheme } from './lib/theme'
import './global.css'

// 浏览器部署(Docker/Web):无 preload 时安装 HTTP+SSE 版 window.api;
// Electron 里 preload 已装好,此调用 no-op。必须在首帧前执行。
installWebApiIfAbsent()

// 主题首帧定档（Watchtower SPEC §6-6）：在 render 之前写 data-theme，
// 避免首帧闪错主题（深色基线之外的主题）。不回写 localStorage。
initTheme()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
