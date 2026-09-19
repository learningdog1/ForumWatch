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

---

## 第二轮执行纪要（2026-09-19）

- **D1–D3 已落地，无偏差**：更名与首启迁移（字节级拷贝 config/seen/state、logs/ 不拷、旧目录保留、seen 拷失败强制重置 baselineDone、新 config.json 即迁移标记）；配置 v2 + seen/state 迁移函数；多来源引擎（getSources 访问器、per-source 独立退避与状态、聚合 health 取最差、全局间隔 = max(配置间隔, 最差剩余退避)）。
- **D4 已落地，无偏差**：批式单请求（cap 12）+ pollOnce 内联 await、评估失败不进 consecutiveFailures、未决不入 seen、排除词先于 AI、300/日限额（常量）、未配置/耗尽降级字面、verdict 仅内存 Map。
- **D5 已落地，一处执行期细化**：「今日回顾 → 立即生成」对当天已有日报为**覆盖重生成**（裁定只约束了自动触发的"不存在才生成"，手动路径补齐为覆盖语义，writeFile 直接覆写）。3500 字符 UTF-16 按行分段、零命中心跳、attempts≤3、仅当天补做均照裁定。
- **D6 已落地，无偏差**：第三 aiClient（30s 超时）、proxyScope 复用（telegram-only 时 AI 直连）、redactSecrets 全链路脱敏、baseUrl 去尾斜杠拼 /chat/completions。
- **D7 已落地，一处执行期细化**：**16px 图标去青点**（looker 复核返修：青点折算 16px 后距环内缘不足 0.2px，抗锯齿后与环顶描边熔成糊团——16 档与 Template 对齐只留"环 + 针"，青点保留在 32 档）。npm run icons（sharp devDep）+ design/ SVG 源入库照裁定。
- **D8 已落地**：三 tab（监控台/今日回顾/设置）、设置八卡片（关键词/Telegram/AI 模型/监控模式/每日总结/轮询/网络/行为）、命中列表来源徽标 + 字面/语义命中方式徽标 + 语义理由、AI 状态块看 effectiveMode 与 degraded 三态。
- **坑清单 ①–⑧ 全部兑现**：含 ⑤ headless.ts 同款接线 AI 能力（aiClient/evaluator/hitsStore/DailyReportService）。
- **审查后细化（第二轮代码审查）**：日报开关 `ai.dailyReport.enabled` 定为**功能总开关**——关闭时定时 tick 到点不生成（不调 LLM、不写文件、不消耗 attempts；「今日回顾 → 立即生成」的手动 generate 不受影响）。verdict 内存 Map 已按坑⑥补实现（语义命中×推送失败 → 缓存 reason，下轮绕过 AI 批直接按已判 hit 重试，成功/静音清除；轮末对滚出首页的键统一清理，与 pendingNotifyErrors 两套机制不串）。迁移拷贝顺序定为 **seen → state → config**（config.json 存在即「已迁移」标记，标记最后落位，防 kill 窗口内 seen/state 永久不补拷）。空 interests 时引擎侧直接跳过 AI 批（不计数）；手动 resume（IPC/托盘）desired 翻转后补跑一次日报 tick。

---

# 第三轮决策（2026-09-19，旧帖过滤 + AI 锐评，ultrabrain 裁定）

**D9 旧帖过滤 = id 阈值窗口（否决 sort 参数）**：问题——NodeSeek 首页按**最后回复时间**排序，旧帖被回复顶回首页后对 seen 集是"新帖"，会被评估/推送（同一公告反复打扰）。首选方案 `?sort=createTime` 实测**被服务端忽略**：带与不带参数背靠背抓取对比，返回 id 序列逐位一致（同为回复序）——排序参数是摆设，此路不通。改为 engine 侧阈值窗口：

- **能力声明 `SourceAdapter.creationOrderedIds?: true`**：adapter 声明"本来源帖子 id 随创建单调递增"（NodeSeek 满足）；未声明/非 true 的来源整段过滤零行为变化（未来非数字 id 来源自然旁路——非数字 id 既不进阈值计算也不被过滤）。
- **per-source 阈值 `maxSeenTopicId`** 存 `state.json` 的 sources 条目里；**schemaVersion 不变（仍 2）**——字段宽容收编：旧 v2 文件缺该字段读作 null（合法），单条目值非法只把该条目该字段归 null，不判整文件损坏（阈值丢了可重建，不值得核弹 state）。
- **过滤语义**：unseen 且数值 id ≤ 阈值的帖子视为"被回复顶起的旧帖"，入 seen 不推送不评估（先于置顶/排除词分支）；轮末阈值推进 `max(旧阈值, pageMax)`，**只升不降**（pageMax 低于旧阈值 = 高 id 帖滚出首页，正常现象不回撤；下降时另发 warn 日志作单调性异常观测）。
- **ultrabrain 修正（豁免集 `prevUnseenKeys`）**：上一轮就在 unseen 处理流里的帖子（推送失败重试中 / 语义未决重评中——它们不入 seen）必须豁免过滤——轮末阈值会追上它们的 id，不豁免会被阈值永久吞掉重试机会。实现：轮末把"本轮 unseen 键集"整集替换为下一轮的豁免集（生命周期对齐 pruneRetryMaps，滚出首页自然消失）。
- **存量升级静默初始化轮**：baselineDone=true 但阈值缺失（旧版升级用户首跑），本轮整页 unseen 全部入 seen、写阈值、不推送不评估、正常收尾（不算失败）；否则升级后第一轮会把满页旧帖当新帖推送——正是本特性要修的 bug 的存量版。pageMax 为 null（整页无合法数值 id，对 NodeSeek 属异常形态）时不初始化，落回正常管线（阈值仍 null = 不过滤）。
- **首启基线同轮初始化阈值**：基线轮末把整页 max id 与 baselineDone 同 patch 原子写入；seen 损坏补基线（rebuiltFromCorrupt）时**阈值不重置**——阈值独立于 seen 存储，历史高点保留（取 max(旧阈值, pageMax)，防当前页拉低）。
- **已知接受**：id 乱序（同轮内低 id 新帖出现在高 id 之后）会被误当旧帖吞掉——偶发漏报换误报归零，接受；换来的是"回复顶起旧帖重复推送"的确定性 bug 被消灭。
- **连带修复**：headless `--once` 模式的 adapter 包装层漏传 `creationOrderedIds` 能力标志——engine 看不到声明，`--once` 下旧帖过滤整段失效；包装层已补透传。

**D10 AI 锐评**：命中帖推送前让 LLM 对帖子标题写一句中文锐评（≤60 字，犀利机智不辱骂），附在 TG 消息里。**五道闸**全过才真调 LLM，否则 commentary=null 且零成本：① 装配方注入了 commentaryGenerator（旧装配/测试不注入 = 行为与升级前完全一致）；② `cfg.ai.commentary.enabled === true`（配置恒存在恒布尔，**默认开**——sanitize 侧唯一默认开的布尔）；③ provider 三项齐备；④ 总配额 callsToday < 300（与语义评估共用桶）；⑤ 子限额 commentaryToday < 100（超出**静默降级**为无锐评推送、不 log、无 degraded 态——100 子限额保证语义评估在总桶至少剩 200，无需调序）。**计数语义（如实写进文档）**：真调用即双计数（callsToday++ 且 commentaryToday++），**成败皆计数**；CommentGenerator 成败皆缓存（成功缓存文本、失败缓存 null 负缓存）+ 在途 Promise 去重——推送失败重试轮 generate 被再次调用并**再次计数**，但内部缓存保证不再打 LLM（重试不重打 LLM 但重复计数，这是接受的口径）。prune 与 engine 的 pruneRetryMaps 同点轮末清理（只保留本轮仍在页面上的键）。**HitRecord.commentary 三态契约**：`undefined`（旧 hits/*.jsonl 行，消费方必须容忍，等价无锐评）/ `null`（新记录：未启用/未配置/超限/生成失败）/ `string`（成功）。**呈现**：TG 消息「🎯 命中」行之后插 `💬 锐评: {text}`（转义，空/null 整行省略）；日报把命中携带的 commentary 用一句话引用进要点；监控台 AI 状态块并列展示 `锐评 N/100`。装配：runtime.ts 与 headless.ts 均以同一 AiProvider 实例构造 CommentGenerator 注入 engine（与 evaluator 同款注入风格）；生成器**绝不抛**（一切异常内部消化为 null——锐评绝不拖垮推送主链路），user 只送标题/分类/作者三字段 JSON，8s 超时、max_tokens 120、纯文本回复不用 jsonMode。**审查后细化（第三轮代码审查）**：prune 与 retryMaps 同款 observedSources 守卫（冷却/抓取失败轮未观测 → 该 source 的缓存键保留到下一次成功观测）；commentaryLimit 随状态下发（AiRuntimeStatus 可选字段，渲染层不硬编码 100）。

**D11 evaluator 解析兼容（verdicts → results → 兜底扫描）**：线上实测有模型无视提示词用 `{"results":[...]}` 回包，旧代码只认 `verdicts` 键 → bad-json → 整批未决每轮重评（烧配额 + 刷错误日志）。修复：裁决数组按兼容顺序定位——显式键 `verdicts` → 显式键 `results` → **兜底扫描**（顶层所有数组值里第一个含合法 `{key, hit}` 元素的数组）；任何候选必须至少含 1 个合法元素才算命中（防"解析成功但零裁决"的静默未决）。都定位不到才抛 bad-json，**错误消息带实际顶层键名**（便于排查模型又换了什么键名）。prompt 侧同步收紧：给出精确输出示例并**钉死键名 `verdicts`**（示例是对换键名行为最直接的免疫）。
