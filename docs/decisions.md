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

---

# 第二轮决策（2026-09-19，多论坛化 + AI 能力，ultrabrain 裁定）

**D1 命名与迁移**：产品名 **ForumWatch**（productName 只用 ASCII；中文副标题放 UI："ForumWatch · 论坛监控"）；appId `com.colmidad.forumwatch`。userData 迁移选首启一次性拷贝（旧目录 `appData/NodeSeek Monitor` → 新目录，拷 config/seen/state，逐文件 tmp+rename；**不变式：seen 拷贝失败必须重置 baselineDone**——rebuiltFromCorrupt 覆盖不了"没拷过来"；绝不删旧目录；新 config.json 存在即"已迁移"标记）。Windows 改 appId 后新旧双装可同时运行=双推送，发布说明置顶"先退旧再装新"。mac 登录项由 applyConfigSideEffects 的差异比对自动重注册。

**D2 配置 v2**：关键词 v2 全局共享（per-source 覆盖留给 v3 加法迁移）；**baselineDone/totalHits 按 source 拆分**（防风暴语义，不是过度设计）。形状见 `src/shared/types.ts`（sources: SourceConfig[] / ai: AiConfig）。迁移函数放 `src/main/config/migrations.ts` 纯函数（零 electron，ConfigStore envelope 解析后调用）；seen.json v1 裸 id → `nodeseek:{id}` 前缀（视为成功加载，不置 rebuiltFromCorrupt）；state.json v2 = `{schemaVersion:2, sources:Record<id,{baselineDone,totalHits}>}`。

**D3 多来源引擎**：单 MonitorEngine 内循环多 source。`EngineDeps.getSources: () => SourceAdapter[]` 访问器（**不是构造期数组**，否则热更新断裂）；adapter 加 `readonly id`。每 source 独立 try/catch、独立失败计数走同一退避曲线（记 cooldownUntil）。EngineStatus 聚合字段保留 + 新增 `sources: SourceStatus[]`；聚合 health 取最差。seen 键 engine 组装 `${sourceId}:${topic.id}`；Topic.sourceId 由 engine 盖章。已知限制：全局 scheduler 间隔 = max(配置间隔, 最差 source 剩余退避)，v2 单 source 等价现状。

**D4 语义评估**：批式单请求（每轮一次，cap 12 帖）+ pollOnce 内联 await（30s 超时）+ **评估失败不计入 consecutiveFailures**（记 lastAiError）+ **未决不入 seen**（下轮重评，滚出首页即止，对齐 8.10）+ 排除词永远先于 AI 一票否决。管线：排除词 → literal（'both' 命中即推不走 AI）→ 剩余 unseen 进 AI（'semantic'/'both'）。协议：OpenAI 兼容 chat/completions，temperature 0，response_format json_object（失败兜底取响应中首个 {} 块）；system"仅当明确相关才判 hit，宁可漏报不要误报"；响应缺 id 视为未决。语义档 interests 为空 = 永不命中；Provider 未配置 → 整体降级 literal（ai-unconfigured 标志）。每日调用上限 **300**（常量，本地自然日滚动），耗尽降级 literal-only。verdict 仅内存 Map（缓存"已判 hit 推送重试中"的帖子，重启重评一次成本可忽略）。

**D5 日报**：独立 setTimeout 重排定时器 + 启动/resume 时检查 + **仅当天补做不回溯**；触发条件 `now >= 今日 timeHHMM（本地时区）` 且 `reports/<today>.md` 不存在且 desired==='running'；文件不存在即重试触发器 + 内存 attempts≤3 防死循环。当天命中落 `hits/YYYY-MM-DD.jsonl`（追加，本地日期分桶），日报存 `reports/YYYY-MM-DD.md`。零命中也生成"今日无命中"并推送（心跳）。TG 用 `sendRaw`（复用串行队列/限流），HTML parse_mode，3500 字符分段（UTF-16 口径，按行聚合切点），尾缀"（续 N）"。

**D6 AI 网络与安全**：第三个 aiClient（独立实例，defaultTimeoutMs 30s）；复用二元 proxyScope：'all' → AI 走代理，'telegram-only' → AI 直连（DeepSeek/GLM 大陆直连可用）。`redactSecret(s)`：≤8 字符全 `***`，否则前3+`***`+后2；Authorization 头绝不进日志；AI 抛错消息一律脱敏；apiKey 与 botToken 同待遇（config.json 600 权限，getConfig 返回全量）。baseUrl sanitize 去尾斜杠，请求拼 `/chat/completions`。

**D7 图标管线（ADR 3 豁免）**："豁免：devDependencies 允许原生二进制（现例 sharp，仅 scripts/gen-icons.ts 图标栅格化，PNG 产物提交入库、CI 不执行该脚本）。原约束收窄为：package.json 的 dependencies 禁原生模块，应用产物不含任何原生二进制。"尺寸：resources/icon.svg（512 viewBox 唯一事实源）→ icon.png 512；托盘 mac `trayTemplate.png`/`@2x`（纯黑+alpha，命名大小写敏感）+ win 彩色 `tray.png`/`@2x`。SVG 约束（librsvg）：纯 path + 至多一个 linearGradient，不用 filter/mask/style/text，fill-rule evenodd；mac 全出血留 20% 安全区，win 留 10% 透明边。

**D8 UI 路线**：保留零框架手写 CSS + 令牌升级（不引入 tailwind/radix）。五个方向按性价比：① emoji 全换内联 SVG sprite（stroke 1.5px、currentColor、16/20 两档，品牌标复用 app 图标单体路径）；② 排版纪律（tnum 等宽数字、12/13/15/20/28 字号阶、4px 栅格、标题字距）；③ 材质层次（双层阴影、圆角 6/10/14 阶、侧栏带 accent 色相、dark 拉开明度差）；④ 微交互（120-180ms transition、focus-visible ring、新命中行入场动画）；⑤ 空态插画 + 引导文案。布局骨架不动。

**新增坑清单**：① getSources 必须是访问器；② 新旧双装=双推送（发布说明置顶）；③ 迁移 seen 拷贝失败 → 强制重置 baselineDone；④ hits/reports 日分桶与 timeHHMM 判断必须本地时区（ISO slice(0,10) 是错的）；⑤ headless.ts 必须同步接线 AI 能力（或显式 no-op）；⑥ 'both' 模式 AI 判 hit 但推送失败的帖子不入 seen 下轮重评——verdict Map 为这个角落存在；⑦ TG 4096 是 UTF-16 单位数，分段切点按行聚合；⑧ sharp 平台二进制只进 lockfile 不进产物，无需 .npmrc。
