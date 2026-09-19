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
- 翻页 `?sort=createTime&page-2` 可用（每页 49 条）；MVP 只监控第 1 页。**（此记录已过时：2026-09-19 第五轮复测推翻——query 形态页码被服务端忽略、路径形态 403，当前对 NodeSeek 实际无效，见第五轮 D14。）**

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

---

# 第四轮决策（2026-09-19，数据源大扩容，ultrabrain 裁定）

**D12 配置 v3（判别联合）**：`SourceType` 扩为 `'nodeseek' | 'rss' | 'v2ex'`；`SourceConfig` 改为**按 type 判别的联合**——rss 额外必带 `url`（合法 http(s)，sanitize 非法则整项丢弃）、可选 `label`；三种来源都可带可选 `filters: {includeCategories?, excludeCategories?, blockedAuthors?}`（per-source 过滤**本轮只立契约与清洗，引擎消费在下一轮**。语义已钉死：include 非空 = 分类白名单（匹配显示名或 slug，大小写不敏感）、exclude = 分类黑名单（与 include 同时给出时 exclude 优先）、blockedAuthors = 作者黑名单；均为字面匹配非正则）。默认 sources 不变（仍只 nodeseek 一项）。

- **迁移**：v1/v2 盘上配置加载时沿链式迁移升 v3（v2→v3 只动 sources：v2 时代 type 恒 'nodeseek'，逐项重映射为 NodeseekSourceConfig 形状，其余段原样保留；v3 原样透传幂等）。迁移只做纯函数变换不做校验，合法性由 merge DEFAULT + sanitize 兜底；形状不对（非对象/缺 config/未知版本）抛错走损坏备份路径。**旧版二进制读 v3 文件会命中"未知 schemaVersion"→ 备份 + 回默认**——升级是单向的（见已知限制）。
- **bump 边界（一次 bump，此后加法不 bump）**：schemaVersion 只在"旧版本读新文件会坏"时才 bump。v3 起信封原样透传 + 默认值合并 + sanitize 兜底，此后**加法变更（新增 source type、filters 新字段等）不再 bump 版本**——旧代码读到的只是 sanitize 会忽略/丢弃的未知项；只有破坏性改义/删字段才需要 v4。
- **sanitize 分派（坑1）**：sources 按 type 分派重建，**未知 type 整项丢弃**（不猜测洗成 nodeseek）；rss 的 **url 非法（非字符串/非 http(s)/`new URL` 解析失败/无 host）整项丢弃**（不瞎补默认地址）；label trim 后为空视为无（不落键）；缺 id（或 slug 化后为空）时从 url host 派生建议 id（`example.com` → `example-com`），**id 以用户给的为准**；id 规范 slug、全列表去重保留首个、被丢弃项不占 id；全部项非法回默认单项，**绝不落空列表**。filters 三列表各自 trim、去空、大小写不敏感去重（保留首现写法，对齐 includeKeywords 清洗风格）、每列表上限 100 条截断；清洗后三列表全空返回 undefined（等价"无过滤"，不落空对象）。
- **坑4（隐式 schema 白名单）**：`sanitizeConfig` 逐字段显式重建对象，没有列进重建的字段**保存即丢**——types.ts 契约新增字段必须在同一 commit 补 sanitize 分支与 store.test.ts 往返用例（filters / label / url 即本轮 v3 补的三个）。
- **seen 容量公式（坑12）**：`1000 + 500 × max(0, 来源数 − 1)`——全局 1000 的环形淘汰在多源下会被**容量淘汰先于时间淘汰**（7 天保留期）击穿 → 重复推送；每源 500 条富余。容量在 FileSeenStore 构造期定死，增删来源**下次重启生效**（不为它重构 engine deps；期间偏小容量只是环形淘汰更早，无正确性问题）。单源（含垃圾输入）恒 1000，与 v2 行为完全一致。
- **外链白名单 rss host 派生（坑3）**：openExternal 白名单按 config.sources 派生（只取 **enabled** 项），固定类型查 `SOURCE_DOMAINS` 表（本轮 v2ex 进表：nodeseek.com / v2ex.com 及其子域）；rss 没有固定域，**从 source.url 的 host 派生**（`new URL` 解析，失败跳过——防御性，sanitize 本应已拦）。只扩 SOURCE_DOMAINS 不够：rss 必须走 url 派生，否则白名单对新源失效。

**D13 数据源适配器与装配**：

- **通用 RSS/Atom 适配器**（ADR 5 预留的 RSS 备选路径兑现）：RSS 2.0 + Atom 双格式；命名空间前缀（`dc:creator`、`atom:entry`…）按**本地名**兼容匹配（XML 前缀不保证固定）。**id 提取优先级**：guid 尾部数字（Discourse `tag:linux.do,2005:Topic/12345` 与 URL 型 guid 同样命中 `/\/(\d+)\/?$/`）→ Discourse 主题链接 `/t/{slug}/{id}`（可带楼层尾段，id 恒取主题段）→ Vanilla `/discussion/{id}` → 通用数字路径段 → guid/link 原文兜底；**guid 与 link 都解析出数字且不一致时以 guid 为准**（guid 是论坛侧规范 id，link 可能被 feed 生成器重写或截短）；guid 与 link 全缺的条目没有稳定身份，直接跳过。**不声明 creationOrderedIds**：通用 RSS 的 topic id（guid/link 提取）不保证是数值、更不保证随创建单调（feed 常按最近活跃排序、guid 形态千差万别），声明 true 会误启 maxSeenTopicId 阈值过滤（D9）——保守走不过滤路径。相对链接按 feed 地址补全绝对。防护条款对齐 ADR 5：**0 条视为抓取异常**（feed 改版或被拦的首表现象，走普通失败退避，宁严勿松）；CF 403 / `cf-mitigated: challenge` → ChallengeError → challenged 态退避。
- **V2EX 适配器**：官方 API `/api/topics/latest.json`（无需认证，恒约 40 帖/次）；topic id 随创建单调递增（实测当页 newest 1243180 > oldest 1243131）→ **声明 `creationOrderedIds: true`**（D9 旧帖阈值过滤对 V2EX 生效）。未认证限速约 120 次/小时；默认 60s 轮询 = 60/h 在限内。429 走普通失败退避（不进 challenged 态），错误消息带可读限速提示（建议调大轮询间隔）。
- **共享挑战检测**：`sources/challenge.ts` 从 html adapter 抽出（`assertNotChallenged`：HTTP 403 或 `cf-mitigated` 头含 `challenge`，双信号取一即抛 ChallengeError；header 读取兼容 `Record` 与标准 `Headers`、键名大小写不敏感），html / rss / v2ex 三适配器共用，保持单一检测口径。
- **装配工厂（坑2）**：desktop `runtime.ts` 与 headless `scripts/headless.ts` **同款按 type 工厂**——getSources 访问器内按当前 config.sources 逐项构造（v3 判别联合下静态 id→adapter 注册表不成立：rss 的 url/label 是配置数据，必须按项建实例）。nodeseek / v2ex 按 id 惰性单例；rss 按 id 缓存 `{url, label, adapter}`，**url/label 变更时重建 adapter**（它们是构造参数，变更后旧实例语义过期），seen 键前缀 `${id}:` 不变——改地址不换键空间。headless `--once` 统计改**全来源聚合**（fetched/fresh 求和；包装层透传 creationOrderedIds，R4 起泛化到全部 adapter 类型）。
- **来源管理 UI**：设置页新增「来源」卡片（置顶）：来源列表（类型徽标 NodeSeek/V2EX/RSS + 启停开关 + 删除；默认 nodeseek 不可删、不可删到 0——列表删空 sanitize 会回默认，UI 侧直接禁删更清晰）+ 三个预设一键添加（V2EX / Linux.do=`https://linux.do/latest.rss` / LowEndTalk=`https://lowendtalk.com/feed`，已添加的按 id 置灰）+ 自定义 RSS（url 前端校验 http(s)、可选 label、id 从 host slug 化生成、冲突加 `-2/-3` 后缀）。预设文案**如实标注网络风险**（见下）。修改走既有「保存设置」链路回写 draft.sources，无新 IPC；filters（分类/作者过滤）UI 本轮不做（R5），卡片尾部留提示行。
- **实测事实（2026-09-19）**：三源 curl——NodeSeek SSR HTML 裸客户端 200（ADR 5 既有）；linux.do `/latest.rss` 与 LowEndTalk `/feed` 在**部分网络被 Cloudflare 拦截**（403 / cf-mitigated），预设文案如实标注"届时显示 Cloudflare 拦截并自动退避，建议配合代理"；V2EX API 200、JSON 数组 40 帖。headless 双源（rss + v2ex）实跑冒烟通过，v2ex 实抓 38 帖。
- **坑（手工改配置须为 3）**：headless 数据目录（或任何手工编辑 config.json 的场景）里信封的 `schemaVersion` 必须是 **3**——迁移链只认 1/2/3，写成其他值会走损坏备份路径回默认配置。

**新增坑清单（编号沿用 ultrabrain 原表，与代码注释一致）**：① sanitize 按 type 分派的丢弃纪律（未知 type / 非法 url 整项丢，不猜测修复）；② 静态 id→adapter 注册表在判别联合下不成立（rss 按项建实例、url 变更重建）；③ 外链白名单对新源类型失效（rss 走 url host 派生）；④ sanitize 隐式 schema 白名单（契约加字段必须同 commit 补 sanitize）；⑫ seen 全局 1000 在多源下被容量淘汰先于时间淘汰击穿（1000 + 500×(n−1) 扩容）。

---

# 第五轮决策（2026-09-19，匹配与降噪，ultrabrain 裁定）

**D14 匹配与降噪包（DEC-2 / DEC-4 / DEC-8 裁定结论与修正口径 + 解析兼容经验 + page-2 现实复测修正）**：

- **价格规则 = 第三种命中通道（DEC-2，裁定修正口径：独立于 matchMode）**：`matchedBy='rule'`。规则 `{label?, cycle(yearly/monthly/any), maxPrice?, currency(CNY/USD/any), minTrafficGB?, keywords?[]}` 条件 AND、逐条评估**首条命中即返回**；管线位置**先于字面**（第 6 步）——命中即得、短路 literal 与语义批，同一帖只记一种命中方式（规则优先）；**不受 matchMode 门控**：matchMode 只分派字面关键词 vs AI 语义，规则是零成本结构化匹配，semantic-only 下同样生效（引擎测试锁定该语义）。标题提取（extractDeal）总原则「宁缺勿错」——识别不了的形态不产出字段、让规则不命中，而不是猜近似值喂给比较：
  - 周期：认 `年付/每年/包年/一年/N年（数字或中文数字，≤3 位）/X/年/annual/per year/yr/yearly` 与 `月付（含 N月付）/每月/X/月/monthly/per month/独立词 mo`；**半年付/季付/双月付不识别**（闸门：`年付/月付` 前是 半/季/双 挡掉、`annual` 前是字母或连字符挡掉 semi-annual、裸「一月」不算月付）；年付与月付信号同现取 yearly（固定优先级，行为可预测）。
  - 价格：认 `¥99/￥99/99元/99 块`（CNY）与 `$9.9/9.9刀/USD 20`（USD），千分位（`1,299`）优先匹配；**裸数字（「年付88」的 88）无币种标记不算价格**；多价格标题取首个（简单可预测，多价对比帖建议用规则 keywords 缩小范围而不是让提取器猜「最便宜」）；`99元素` 由负向断言挡掉。
  - 流量：认 `500G/GB、0.5T/TB、1024M/MB`（统一换算 GB，M 级保留一位小数）；数字前是字母（`2C2G` 的 2G 是内存）、单位后是 ASCII 字母或「内」（`500Mbps` 带宽、`2G内存`）不算；`2GB RAM` 带空格仍是已知残余误读，靠规则 keywords 兜底；`不限流量/unlimited` 不设 trafficGB（无约束，不返回 Infinity）。
  - **「无条件规则 = 全匹配」由用户自己负责**：任一条件都不声明的 enabled 规则命中时 deal 为空对象，sanitize 不拦（契约如实写进文档）。
  - 清洗（sanitizePriceRules）：非数组回 `[]`（空列表 = 无规则，合法状态）；整条非对象/无可用 id 丢弃；id slug 化全列表去重；cycle/currency 枚举非法（含缺失）回 `'any'`（落键与缺省语义等价，统一物化）；maxPrice/minTrafficGB 非有限正数丢字段；**keywords 每条规则 ≤20、规则列表 ≤20 条**（超出截断）。
  - 呈现：推送「🎯 命中规则: {label}」（无 label 用 id）；HitRecord.matchedBy 扩三档、新增可选 `matchedRule`（旧 jsonl 行缺字段容忍，等价非规则命中——消费方必须容忍 undefined，对齐 commentary 三态契约先例）。
- **相似降噪 = 纯字面相似度 + 窗口重建 + 短标题守卫（DEC-4 裁定）**：`similarity.enabled` **默认开**（与 `ai.commentary.enabled` 并列的两个「默认开布尔」——旧配置缺失该字段时不能静默关掉降噪，`!== false` 才是关）；threshold 默认 0.72（UI 0.50–0.95 可调；sanitize 非法回 0.72、钳 [0,1] 保留两位小数）。48h 窗口时长是引擎侧常量不进配置。算法链：normalizeTitle（小写 → 全角 ASCII U+FF01–FF5E 线性映射半角 → 非「字母/数字/空格」一律替换成空格——emoji/标点/装饰符**当空格用**保留分词信息 → 空白折叠 trim；幂等）→ 字符 trigram（按码点切，中文/表意文字不劈代理对；空格参与滑窗）→ 集合 Jaccard `≥` 阈值判相似；**归一后 <6 字符的标题双向不参与**（短标题 trigram 误伤率高，`vps` vs `vps2`）。窗口语义：**「近期已推」= 近 48h 成功推送过的标题**（推送失败/静音不入窗——窗口语义是"用户已收到"）；轮末按时间 prune，48h 以**判定时点**为准（长睡眠恢复后窗口里的过期条目放行）；**启动从近 3 天 hits（notifiedAt 非空且仍在 48h 内）重建**（3 天是数据面：48h 跨本地日最多涉 3 个日桶，48h 过滤是窗口不变式；重建 promise 构造期发起、首个推送前 await 就位，失败 = 空窗开始只 log，绝不抛）。被吞帖入 seen 不推送不 emit（log `similar topic swallowed` + 内存计数），作用于**全部命中方式**（规则/字面/语义）push 前、锐评生成之前（吞并的帖子不打 LLM 不耗配额），重试在途的键一并收口。**能力边界（必须如实写、不 oversell）**：字符 trigram 只拦「装饰级」转发变体（加 tag/emoji/全角/大小写）；**换词级改写（`99/年 白嫖`→`99一年 优惠码`）Jaccard ≈0.22、大幅加词 ≈0.67，0.72 阈值下都拦不住**——那类重复是 AI 语义通道（或手动降阈值，代价是误杀正常新帖）的取舍，不是本模块的 bug。
- **page2 自适应 = 有效新帖计数口径（DEC-8 裁定）**：触发条件 = 上一轮**有效新帖数 ≥ 40 且来源 health=ok**。有效新帖 = 过了 id 阈值 + 置顶 + 排除词 + per-source 过滤之后**进入匹配管线**（规则/字面/语义）的帖子数——**不是裸 unseen**（40 ≈ NodeSeek 单页 49 条去掉置顶后的全量新页，即"整页都是新帖"的信号）；health=ok 门槛防 challenged/backoff 恢复后的第一轮补抓（防双倍 CF 暴露）。观测面 `SourceStatus.page2Fetches`（内存累计、重启清零；口径 = 引擎**发起** 2 页请求的次数，第 2 页在 adapter 内失败也计——观测的是引擎侧事实）；第 2 页失败由 adapter 吞并按第 1 页成功收尾（log warn），两页按 topic id 去重保序（第 1 页原序在前）——天然覆盖"服务端忽略页参数返回同页内容"的形态。
- **page-2 现实复测修正（2026-09-19，推翻 ADR 5 旧实测）**：NodeSeek 第 2 页 query 形态（`?sort=createTime&page-2` 与 `?page-2`）**服务端忽略页码返回第 1 页**；路径形态 `/page-2` 裸客户端 403（带全浏览器头也 403）。**当前对 NodeSeek 实际无效**——无害：返回的同页内容被 id 去重 = 无操作；能力保留，等站点放开页参数或换代理出口环境再验证。RSS/V2EX 不实现 pages（收到 opts 忽略，行为不变）。ADR 5 的「翻页可用」记录已就地标注过时。
- **解析兼容经验（D11 同款：score 缺失回退）**：裁决元素可带 `score`（0-1 置信度）。**缺失/非数字回退 1.0**——旧模型行为完全不变（hit 就命中），且与模型真实回的 1.0 不可区分（文档提示用户：调高阈值后若所有语义命中都显示很高置信度且模型不支持 score，阈值实际不起作用；DeepSeek/Kimi/GLM 等支持 JSON 输出的主流模型均回 score）。数值钳 [0,1]；非有限数按"坏值"走回退而非钳位（钳 NaN 产出 NaN，`NaN >= 阈值` 恒 false 会静默吞 hit）。**score 不参与元素合法性判定**（isValidVerdictItem 只看 key/hit，缺 score 的元素仍是合法裁决——D11 的 verdicts→results→兜底扫描兼容链不受影响）。prompt 侧在输出示例里钉死 `"score"` 键（示例是对换键名行为最直接的免疫，W3 同款逻辑）；"仅当明确相关才判 hit=true" 原则不变（score 是补充信号不是放行）。引擎侧消费：hit 且 score ≥ `ai.semanticThreshold`（默认 0 = 不过滤，行为不变）才推送；hit 但 score < 阈值 → **按不相关处理**（入 seen 不再重评、不写语义理由、只 log 一条观测）；已在重试缓存（semanticVerdicts，D4 坑⑥）中的帖子不受热更新阈值影响——缓存的是已过闸 verdict，重试轮直接重推不再过闸。
- **契约兑现与诊断面（执行事实，非裁定）**：D12 立的 `sources[].filters` 契约本轮引擎消费落地（filters.ts 纯函数；管线第 2 步、先于 id 阈值；滤帖入 seen 不推送不评估；`getSourceFilters` 访问器每轮重读，配置热更新）；SourceCard 行内「过滤」展开区（分类白/黑名单 + 作者黑名单；三列表全空不落键，保存往返无假 dirty）。匹配测试台（R5-P2c）：设置页只读诊断卡，按**已保存**配置跑六阶段 trace（来源过滤 → 排除词 → 价格规则 → 字面 → 相似 → 语义）+ wouldPush 结论；不写 seen/hits、不推送、引擎零感知；「调用 AI」真调一次 evaluator——**消耗服务侧额度但不进引擎每日 300 计数器**（engine 的计数器不可从外部改，测试台走独立 IPC handler）；相似阶段用近 2 天已推标题近似真实 48h 窗口（不做时间过滤——2 天读取面本身界定范围，宽一点更有诊断价值）；两处与引擎的有意差异均为诊断服务：字面/语义档不受 matchMode 门控（用户在 semantic-only 下也想看字面档怎么判）、相似闸在"若命中"假设下评估（引擎只在真命中后查）。

---

# 第六轮决策（2026-09-19，推送链路重构，ultrabrain 裁定）

**D15 推送链路重构（DEC-9 通道化 / DEC-11 挂起状态机 / DEC-7 路由 / any-success 聚合 / report→notifyDetail 链路 / 装配）**：

- **DEC-9：telegram 段退役进 channels（读兼容映射、写只写新形状）**：AppConfig **移除顶层 `telegram` 段**，新增 `channels: ChannelConfig[]`（按 type 判别联合：telegram / bark / ntfy / webhook）、`notify: NotifyConfig`（instant/digest + 免打扰）与 `routing: RoutingRule[]`。三者均为**加法字段，schemaVersion 仍 3**（D12 bump 边界先例：旧代码读到的只是 sanitize 会忽略/丢弃的未知项；telegram 段消失不 bump 的前提是读侧兼容兜住旧盘）。
  - **读兼容（`migrations.normalizeLegacyChannels`，迁移链链尾统一调用）**：盘上 `channels` 缺失/为空**且**旧 `telegram.botToken/chatId` 任一非空 → 合成 `channels[0] = {id:'telegram', type:'telegram', enabled:true, botToken, chatId}`；两者都没有（全新安装 / 旧盘从未配 telegram）→ 默认空凭据 telegram 项（对齐 DEFAULT）；已有 channels（新代码写入）→ 原样保留，**忽略**残留的旧 telegram 键。**双轨读写（读时兼容 + 写时保留旧键）被 ultrabrain 否决**——那是永久漂移债；裁定为"读时兼容映射、写时只写新形状"：sanitize 的隐式白名单（第四轮坑4）本就不含旧 `telegram` 键，盘上残留在加载/保存过一次 sanitize 后自然消失。升级用户零动作。
  - **消费方五处改造**（旧 `cfg.telegram` 直读的全部落点）：① engine 的 configured 闸 → `anyChannelReady(cfg.channels)`（isChannelReady = enabled × 已实现类型 × 凭据齐备，notify/types.ts 单一事实源；静音语义 notifyEnabled 不动）；② 桌面 runtime 装配 → `buildNotifiers` 按通道逐个构造发送器（TelegramNotifier 的 getConfig 访问器按 id+type 现读 store）；③ headless 的 env 注入合并 → `NSM_BOT_TOKEN`/`NSM_CHAT_ID` 覆盖**第一个** telegram 通道的凭据（enabled 不动——用户显式关掉的通道不被 env 偷偷唤醒）；④ 渲染端 Settings 的「Telegram 推送」卡退役，换「推送通道 / 推送策略 / 路由规则」三卡；⑤ TelegramConfig 类型降级为仅 migrations 读兼容与凭据访问器复用的形状（`telegramCredentialsOf`），不再是 AppConfig 成员。
  - **通道上限 8、恒至少 1 条**（sanitizeChannels：全弃回默认 telegram 项——空通道列表会让 configured 判定永久悬空）；id slug 化去重、缺 id 按类型派生、冲突加 `-2/-3`；**空凭据 telegram 合法**（= 未配置态，默认配置本身如此）；ntfy 空 topic / webhook 非 http(s) url 整项弃，bark serverUrl / ntfy serverUrl 非 http(s) 弃字段（缺省 = 发送端用官方端点：bark `https://api.day.app`、ntfy `https://ntfy.sh`），webhook secret trim 空不落键。
  - **三新通道发送语义（R6-W2）**：Bark `POST {serverUrl}/push`，**成功口径比 2xx 更严**——Bark 网关 HTTP 200 时业务码也可能非 200（device_key 失效），须响应 JSON `code === 200` 才算成功，否则按失败重试（错误消息带 message 字段）；标题截 60 UTF-16 字符（代理对安全），body = 分类/作者/命中摘要行（`[分类] 作者 · 命中: 词` / `· 命中规则: label` / `· 语义命中: 理由`——bark/ntfy 共用 formatHitSummaryLine）。ntfy `POST {serverUrl}`（根路径 JSON publish，topic 在 body），成功 = HTTP 2xx；429 无结构化 retry_after，统一常规退避。webhook 把命中打包成结构化 JSON POST：载荷 `{type:'hit', topic:{title,url,author,category,categorySlug,sourceId}, matchedBy, matchedKeywords, matchedRule, semanticReason, commentary, ts}`（matchedBy 由输入推导：词→literal、规则→rule、否则 semantic），sendRaw/sendTest 走 `{type:'raw', text, ts}`；secret 非空时附 `X-ForumWatch-Secret` 头；**5s 硬超时**（用户自建消费端慢响应不得拖住推送线程）。四通道统一 3 次重试（1s/2s）、串行队列 + 防抖——**防抖分两档**：telegram 1050ms 硬限速（官方 1 msg/s，含 429 retry_after 尊重），bark/ntfy/webhook 200ms 温和防抖（无单 chat 硬约束；webhook/bark/ntfy 429 与其他失败同走常规退避）。
- **DEC-11：免打扰 + 摘要模式的挂起状态机（deferredHits）**：纯时间逻辑在 notify/queue.ts（区间判定与时刻计算，时钟注入；半开区间 [start,end)：恰在 start 窗内、恰在 end 窗外；`start > end` 跨午夜合法（23:00-08:00）；`start === end` **定死恒不静默**（空区间）——解释成"全天"会变永久静默，让配置错误自然失效）。策略分派（decideNotifyAction）：**digest 模式恒 defer**（摘要本身已是低打扰形态，digest 计时器是唯一释放闸，**quietHours 不与 digest 叠加**）；instant 模式 quietHours.enabled 且窗内 → defer（nextFlushAt=窗尾）。挂起状态机全部在 engine（内存 Map `deferredHits`）：
  - **挂起语义（坑6 三不入）**：挂起帖**不入 seen**（入了会被下轮当旧帖/已处理吞掉）、**不 recordHit**（flush 前不产生 HitRecord，否则 hits 每轮重复追加）、**不入相似降噪窗**（没推过不算"已推"）。payload 自含全量（topic/关键词/规则/语义理由/**已生成的锐评**——flush 不重打 LLM）。
  - **整帖跳过**：unseen 处理链最顶部查挂起集，已在队列的帖整帖跳过（不重新匹配/不重评估/不入 seen），等 flush 收口——否则免打扰结束的那轮会绕过队列直接即时推送，与 flush **双发**。插点先于 per-source 过滤/id 阈值/置顶/排除词，覆盖全部命中方式（literal/rule 命中的挂起帖同样要拦）。
  - **flush 只随轮询 piggyback**（pollOnce 开头检查 due，无独立定时器）：暂停期间无轮询 → 无 flush，恢复后首轮补发。digest 批窗口锚点 `lastDigestFlushAt`（批首条挂起时刻或上次冲刷时刻），due = 锚点 + digestIntervalMin 到点；仅当队列从空开始且上一窗口已到期才重开锚点（连续命中下批窗口不被无限续期，防饿死）。instant 模式的挂起条目在 decideNotifyAction 不再 defer（窗结束/quiet 热更新关掉）时冲刷；已静音（notifyEnabled=false / 无就绪通道）恒 due——静音是终态，挂起条目按静音收口不为永远不会发生的推送空等。**模式热切换不逐条区分挂起原因**：队列在"当前策略放行"或"当前 digest 计时器到点"时整体冲刷。
  - **flush 逐条收口**（**注意是到点逐条发、不是合并成一条消息**）：成功 = seen.add + recordHit(notifiedAt=冲刷时刻) + 相似窗入窗（对齐即时路径成功后的三个动作）；失败 attempts++，未达 3 次留队列下次 flush 重试（失败中间态只 log 不 emit 防刷屏），**达 3 次 → recordHit(notifiedAt=null, notifyError=最后错误) + seen.add（防重新匹配死循环）+ 出队**；冲刷时刻已静音 → 按静音终态出队（两字段均 null，静音不重试）。
  - **24h 超时收口**：挂起超过 DEFERRED_HIT_TIMEOUT_MS 的条目 recordHit(notifyError='deferred timeout') + seen.add + 出队——有界内存保证；**时间维度裁剪，不看 roundTopicKeys**（挂起帖滚出首页不构成放弃它的理由，与重试缓存语义相反）。
  - **重启丢队列是接受的语义**（内存态）：未入 seen 的挂起帖若仍在第 1 页，重启后会被重新匹配（窗内重新入队 / 窗外直接即时推送），**自愈且不双发**（旧进程已死）；滚出第 1 页的挂起帖重启后自然消失（与即时推送失败重试同一有界窗口取舍）。
  - **观测面**：`EngineStatus.pendingNotifyCount`（可选字段，旧快照读者容忍缺失=0；getStatus 恒下发当前队列尺寸），Dashboard 状态卡下「⏳ 挂起待推送 N 条」行（>0 时显示）。
- **DEC-7：路由规则（声明式首条命中 + 悬挂剔除）**：`routing[]` 每条 `{id, when:{sourceId?, matchedBy?, ruleId?}, channelIds}`，when 声明的条件之间 **AND**、逐条**按序评估、首条命中即返回**该规则的 channelIds（数组顺序即优先级，无加权）；无任何规则命中（含空列表）→ 走默认 = **全部就绪通道**（不路由 = R6 之前的全员广播行为）。`when.ruleId` 严格相等天然蕴含"只对 matchedBy='rule' 的命中可匹配"（literal/semantic 命中的 ctx.ruleId 恒 null）；`matchedBy` 是枚举白名单数组非单值。**悬挂引用一律剔除**（sanitizeRouting）：sourceId 不在 sources / ruleId 不在 priceRules → **剔字段而非整条弃**（修正口径：条件可能只是暂时悬挂——删了来源又加回来，剔字段会让规则静默变宽；剔字段后 when 全空才整条弃）；channelIds 只留存在的通道 id，过滤后空 → 整条弃；上限 20 条。**测试消息与日报不走路由**（sendRaw/sendTest 恒广播全部就绪通道——日报/测试语义上属于"全体"，不该被某来源的路由规则劫走）。配置热更新免重启（composite 每次 sendHit 现读 getRouting()）。
- **any-success 聚合（坑9）**：CompositeNotifier 逐通道**串行**扇出（保序；通道自身还有内部队列/限流，串行外层避免多通道并发打爆共享代理）；单通道异常 catch 后继续发其余（一个通道挂不连坐）；**任一成功 → resolve**（engine 记成功、入去重集），**全部失败 → throw 聚合错误** `all channels failed: a: <err>; b: <err>`（每通道错误截 200 字符，对齐 telegram 的脱敏口径；engine 记 notifyError 进既有重试路径）。目标为 0 个通道（规则指向的通道无就绪 notifier / notifiers 为空）→ throw 'no channel available'。**已知取舍（如实写）**：单通道部分失败时其余通道已收到，engine 按失败重试会重复推给已成功的通道——**宁可重复不可漏推**。
- **report 回调 → notifyDetail 链路**：各通道 sendHit 最终结果落定后经 `input.report?.(channelId, ok, error?)` 自报一次（失败回调后照常上抛；回调约定不抛）。composite 原样透传 input 不包装不重复调用——**per-channel 明细与聚合结果同源一次发送，不会两套口径**。engine 侧 NotifyDetailCollector 收集（键=channelId，按上报顺序 = 串行扇出序），成功/失败路径的 HitRecord 据此落 **`notifyDetail`** 键（至少一条记录时才落；静音路径不调 sendHit → 无键）。聚合 notifyError 取首个失败通道的错误（无明细——通道未接 report / 单 notifier mock——回退抛错消息，兼容既有单测）。**旧 hits/*.jsonl 行没有该字段，消费方必须容忍 undefined**（对齐 commentary/matchedRule 的三态契约先例）。挂起 payload 不回写 detail（重试轮各自重新收集，不跨轮残留）。
- **装配（壳 + 签名热重建 + 按通道类型选 client 的代理语义）**：engine / 日报 / ipc 测试消息持有**稳定壳 NotifierShell**（构造期创建永不重建，四方法委托 current；通道集合变化时只 replace 壳内 composite——engine deps 不重建、日报服务不重造）。**重建条件 = 就绪通道集合签名变化**（readyChannelSignature：`type:id` 按序拼接，只看 isChannelReady 通过的通道）——凭据/启停热更新由发送器的 getConfig 每次发送前现读、路由由 composite 的 getRouting 现读，均不需要重建；未就绪通道进出列表不改变扇出集合，不值得为此中断在途发送。**代理作用域按通道类型分派**：telegram 恒走 tgClient（恒代理作用域），bark/ntfy/webhook 走 siteClient——siteClient 的代理随 proxyScope 热更新（'all' 才带代理），telegram-only 时三新通道与站点抓取/AI 同待遇**直连**（大陆用户 bark/ntfy/webhook 自建端点多在本机/内网，直连正确；官方 api.day.app / ntfy.sh 直连可达）。headless 同款装配（配置是启动快照，无需稳定壳，getConfig 直接闭包读 effective）。
- **UI（R6-W4）**：设置页 Telegram 卡退役，换三卡——**「推送通道」**（通道 CRUD + 就绪状态点三色（就绪/停用/凭据缺失）+ 启停开关 + 按类型凭据表单 + 至少保留一条（删空 sanitize 会回默认，UI 直接禁删）+ 测试推送按钮（广播全部就绪通道））、**「推送策略」**（模式单选 / 摘要间隔 1-120 / 免打扰开关+起止时间）、**「路由规则」**（规则列表 + 添加表单：来源下拉/命中方式多选/价格规则下拉（选中即自动勾「规则」方式）/目标通道多选；校验对齐 sanitizeRouting）。就绪判定是 main 侧 isChannelReady 的渲染端复刻（tsconfig.web 的 composite 边界不允许 renderer import src/main，只能复制一份，口径以 main 侧为准）。
- **冒烟实证（2026-09-19）**：本地 webhook server 接收端实跑，多通道扇出下 **26/26 命中全部送达**（含 X-ForumWatch-Secret 鉴权头校验与 HitRecord.notifyDetail 落盘核对）。
