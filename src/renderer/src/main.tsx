import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installWebApiIfAbsent } from './lib/web-shim'
import './global.css'

// 浏览器部署(Docker/Web):无 preload 时安装 HTTP+SSE 版 window.api;
// Electron 里 preload 已装好,此调用 no-op。必须在首帧前执行。
installWebApiIfAbsent()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
