# 架构决策记录（ADR）

日期：2026-09-19。来源：planner 分步计划 + ultrabrain 攻坚咨询裁定（五项推荐全部成立）。

## 1. 框架：Electron 44（否决 Tauri 2 / Wails）

- 开发机为 macOS arm64，仅有 Node 22 + npm，无 Rust/Go 工具链。
- Tauri 2 官方不支持 mac→win 交叉编译，Windows 包必须走 CI；Wails 需要安装 Go。
- Electron 是唯一"本机现有工具链即可开发 + 交叉打包"的选项。体积（~100MB）与内存对常驻托盘工具可接受。
- 实测版本：electron 44.4.3（内置 Node 24.21 / Chromium 152）、electron-vite 5.0.0、electron-builder 26.15.3。
- 脚手架用 electron-vite（**不要**用 npm 的 `create-electron` 包——2018 年占位死包）。

## 2. 监控内核：Electron 主进程，且为零 Electron 依赖的纯 TS 模块

- 关窗进托盘后渲染进程可能不存在，内核必须在主进程。
- 结构约束：engine（定时/抓取/过滤/推送/状态）写成**零 electron import** 的纯 TS，主进程只做装配（生命周期、托盘、IPC）。内核可在 node 下单测与 headless 直跑，未来可搬 CLI/服务端。
- 托盘与 UI 不各自维护状态，只订阅 engine 事件；主进程是唯一事实源。

## 3. 持久化：纯 JSON 文件（否决 SQLite / 原生模块）

- 数据量（配置 + 去重 ID 集合，KB 级）用不上数据库。
- 原生模块（better-sqlite3 等）需按 Electron ABI 重编，且 mac→win 交叉编译要拖工具链，会废掉"本地交叉打包"这条腿。**全项目禁用原生依赖。**
- 落地：`userData/state.json` + `config.json`；tmp 文件 + `fs.rename` 原子写；写入去抖；带 `schemaVersion`；损坏时备份重建不崩溃。

## 4. 产物：双轨（本地交叉 + GitHub Actions）

- mac 本地 `electron-builder --win nsis`：electron-builder 26 打常规 NSIS **不需要 wine**；避开 MSI/WiX 目标和自定义 NSIS 脚本（仍需 wine）。
- 代码签名留空：Windows 会有 SmartScreen 提示，个人使用可接受；mac 未公证走"右键-打开"。若未来要签：jsign / Azure Trusted Signing / 仅在 GH Actions windows runner 上签。
- CI：tag 触发，mac runner 出 dmg、windows runner 出 nsis，发 Release；CI 跑单测门禁。
- MVP 不做自动更新（mac 上 electron-updater 基本要求签名+公证）。

## 5. 数据源：NodeSeek SSR HTML 为主路径

实测（2026-09-19）：

- `GET https://www.nodeseek.com/?sort=createTime` —— 裸 HTTP 客户端 + 普通 Mozilla UA 返回 200（~90KB），`ul.post-list > li.post-list-item` 含帖子 ID（`/post-{id}-1` 链接）/标题/作者/分类/浏览评论数/最后回复时间/置顶标记。按创建时间排序。
- `/rss`、`/api/topics` 等 —— 403 且 `cf-mitigated: challenge`（Cloudflare 主动挑战），纯后端客户端不可用。
- 翻页 `?sort=createTime&page-2` 可用（每页 49 条）；MVP 只监控第 1 页。

防护条款（写进 adapter）：

- **0 条 ≠ 无新帖**：解析出 0 个 `post-list-item` 必须视为 degraded/challenged 告警（NodeSeek 是 Nuxt SSR，改版或被 CF 拦的首表现象就是 0 条）。
- **挑战检测双信号**：HTTP 403 或 `cf-mitigated: challenge` 响应头，取其一即抛 `ChallengeError`。
- 轮询：默认 60s、下限 15s、±20% 抖动、连续失败指数退避（2x，封顶 30 分钟）、成功复位；`ChallengeError` 进 challenged 状态。
- `SourceAdapter` 接口保留 RSS/API + cookie 备选实现的位置；若 undici TLS 指纹被 CF 拉黑，B 计划是 Electron `net.fetch`（Chromium 网络栈，代价是 engine 绑死 Electron，仅作降级路径）。

## 6. HTTP 客户端：单一 undici 封装 + per-target 代理作用域

- 统一用 **npm 安装的 undici 8 的 `fetch`**（不用 Node 全局 fetch——全局是内置 undici 6，跨版本塞 dispatcher 有兼容风险）。
- 代理：`http(s)://` → undici `ProxyAgent`；`socks5://` → `fetch-socks` 的 `SocksDispatcher`；配置变更时销毁重建 dispatcher。
- **代理作用域** `proxy.scope: 'all' | 'telegram-only'`：大陆常见场景是 NodeSeek 直连可达、仅 api.telegram.org 需走代理。实现为 direct + proxied 两个 client 实例按目标路由。
- 超时用 `AbortSignal.timeout()`。页面抓取与 Telegram 发送共用此封装。否决 axios/got（引入第二套 HTTP 栈，需求只有 GET 页面 + POST sendMessage）。

## 7. 状态模型：desired × health 正交两维（否决 5 状态平铺）

- `desired: 'running' | 'paused'`（用户意图，唯一可写）
- `health: 'ok' | 'backoff' | 'challenged'`（内核观测，自动流转）
- `stopped` 是进程生命周期，不是 engine 状态。UI/托盘展示状态由二元组派生。

## 8. 已知坑与对策（实现阶段必须遵守）

1. **休眠/壁钟漂移**：不用裸 `setInterval`；每次执行后按 `Date.now()+interval` 重排 `setTimeout`；监听 `powerMonitor` 的 resume/unlock-screen 立即补一轮。
2. **macOS App Nap**：监控运行期间 `powerSaveBlocker.start('prevent-app-suspension')`，暂停/退出时 stop。
3. **mac 托盘**：图标 16×16（`@2x` 32）；Template 命名才跟随深浅色（我们用彩色图标，接受不跟随）；托盘图标在唤醒/显示器变更后可能消失——resume 事件里重设 `tray.setImage` 兜底；`app.dock.hide()`（不进 Cmd+Tab 是预期）。
4. **关窗语义**：`close` 事件 `preventDefault()` + hide（除非 before-quit）；mac 处理 `activate` 重开；`requestSingleInstanceLock()` 防多开。
5. **首次运行基线**：首启抓到的整页帖子只入去重集不推送（防通知风暴）；去重键 = 帖子 ID；去重集上限环形淘汰（1000 条）。
6. **Telegram**：HTML parse_mode 记得转义；429 读 `retry_after` 尊重之；每 chat 限 1 msg/s、20 msg/min。
7. **凭据**：config.json 含 bot token——文件权限 600、绝不入 git、README 提示。
8. **Node 版本**：系统 node 22 只跑工具链；Electron 44 自带 Node 24。无原生模块则无 ABI 问题，不要试图对齐版本。
9. **seen 损坏重建补基线**：seen.json 损坏备份重建后（FileSeenStore.rebuiltFromCorrupt），若 baselineDone 已置位则强制重置补做基线——否则空去重集 × baselineDone=true 会把整页当新帖推送（单页 mini 通知风暴）。
10. **推送失败重试语义**：推送真实失败（notifier 抛错）不入去重集，下轮自然重试（帖子滚出首页第 1 页即止，天然有界）；同 id 同失败态只 emit/log 一次防刷屏，成功或转静音后 emit 最终态并入集。静音（notifyEnabled=false / telegram 未配置）是用户主动行为，不重试。

## 事实来源

electron-builder Windows 文档（macOS 交叉构建）、electron-builder#4853（jsign）、Electron releases.json（44.4.3=Node 24.21.0）、npm registry 实测版本、NodeSeek 首页/RSS 实测（curl，2026-09-19）。
