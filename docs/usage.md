# 深度使用文档

README 是快速上手；本文是每一项行为的具体语义：界面元素、状态模型、配置项全集、本地数据文件、轮询/退避/推送细节、AI 语义监控与日报、headless 模式与排查矩阵。内容与代码实现一一对应（截至 2026-09，版本 0.2.0）。

## 目录

- [界面导览](#界面导览)
- [状态模型](#状态模型)
- [配置项参考](#配置项参考)
- [本地数据文件](#本地数据文件)
- [轮询、退避与防休眠](#轮询退避与防休眠)
- [推送细节](#推送细节)
- [AI 语义监控与每日总结](#ai-语义监控与每日总结)
- [headless 模式](#headless-模式)
- [故障排查矩阵](#故障排查矩阵)

## 界面导览

应用为左右双栏结构：

- **左侧栏**：品牌、三个页签（📊 监控台 / 📅 今日回顾 / ⚙️ 设置）、底部迷你运行状态（与托盘 tooltip 同口径）。设置页有未保存修改时，页签上会出现未保存圆点；此时切走页签会先弹提示条（放弃修改并切换 / 留在设置）。
- **监控台**（Dashboard）：
  - **状态卡**：运行状态徽标（运行中 / 已暂停 / Cloudflare 拦截 / 退避重试中）+ 四格指标（上次轮询、下次轮询、连续失败、累计命中）+ 最近错误。已暂停时"下次轮询"显示 `—`（不再排程）。
  - **来源状态块**：每个已启用来源一行——健康点、来源名、健康文案（退避中显示 mm:ss 倒计时）、最近成功时间。v0.2 仅 NodeSeek 一行。
  - **AI 状态块**：生效模式徽标（字面 / 语义 / 字面+语义）、今日调用 `N/300`、降级提示（AI 未配置 / 今日配额用尽）、最近 AI 错误（评估成功后自动清空）。
  - **操作行**：⏸ 暂停监控 / ▶ 恢复监控（同一按钮随状态切换）、🔄 立即轮询（暂停状态下禁用）、✈ 发送测试通知。
  - **最近命中**：最近 200 条命中记录（进程内存环形，重启后清空；`totalHits` 计数才跨重启累计，全天命中另落盘 `hits/`）。每条带来源徽标与命中方式徽标（**字面** / **语义**），语义命中会显示 AI 的一句话判定理由。
  - **运行日志**：最近 500 条日志（info/warn/error 三级，同样为内存环形）。
- **今日回顾**（Reports）：AI 日报页。左侧日期栏列出有日报的日期（新→旧，取最近 14 个），点击切换查看；顶部显示当天命中数摘要。今天还没有日报时空态提供「立即生成」按钮（详见[下文](#ai-语义监控与每日总结)）。
- **设置**（Settings）分八个卡片：关键词、Telegram 推送、AI 模型、监控模式、每日总结、轮询、网络（代理）、行为。底部「保存设置」。要点：
  - 关键词与兴趣描述均为标签输入：输入后回车添加，点 × 删除。
  - **AI 模型**卡：Base URL / API Key / 模型名三项 + DeepSeek / Kimi / GLM 三个一键预设 + 「测试连接」（按**已保存**配置发一条最小对话，表单 dirty 时会提示先保存再测试）。
  - **监控模式**卡：字面匹配 / 语义匹配 / 字面 + 语义三选一（单选卡片），下接兴趣描述输入（建议上限 20 条，超了橙字提示不硬拦）。
  - **每日总结**卡：开关 + 时刻（默认 22:00，本地时区）。
  - 轮询间隔有 30/60/120 秒快捷按钮；低于 15 秒会红字提示，保存时钳到 15。
  - 代理地址非法（不以 `http://` `https://` `socks5://` 开头）会红字提示，保存时清空。
  - 「发送测试消息」同样用的是已保存的配置。
  - 推送总开关（临时静音：仍记录命中但不推送）、开机自启。

**托盘**：关闭窗口 = 隐藏窗口，监控继续。托盘菜单：显示主窗口 / 暂停监控（或恢复监控，随状态）/ 立即轮询 / 发送测试通知 / 在 Finder 中打开配置目录 / 退出。macOS 上点击托盘图标切换主窗口显隐；应用不出现在程序坞与 Cmd+Tab（dock 已隐藏，预期行为）。

## 状态模型

### 运行状态（desired × health）

状态由两个正交维度派生：

- **desired**（用户意图，唯一可写）：`running` / `paused`。暂停只停排程，不清任何观测值。
- **health**（内核观测，自动流转）：`ok` / `backoff`（抓取失败退避中）/ `challenged`（被 Cloudflare 挑战）。**聚合 health 取各来源最差**（challenged > backoff > ok）。

UI 与托盘按 desired 优先的顺序展示为四种状态：

| 展示状态 | 含义 | 恢复方式 |
| --- | --- | --- |
| 运行中 | 正常轮询 | — |
| 已暂停 | 用户主动暂停 | 点「恢复监控」 |
| Cloudflare 拦截 | 抓取被 CF 挑战（HTTP 403 或 `cf-mitigated: challenge`），自动退避重试 | 通常自动恢复 |
| 退避重试中 | 网络失败等普通错误，连续失败计数 > 0 | 成功一轮后自动复位 |

注意：系统事件（休眠唤醒、解锁屏幕）触发的补轮询尊重 desired——你暂停了监控，它不会被系统事件偷偷唤醒。

### 来源状态（per-source）

`EngineStatus.sources` 里每个来源独立维护 `health / lastSuccessAt / lastError / consecutiveFailures / cooldownUntil`，各自走同一条退避曲线。聚合字段是全局汇总，监控台的**来源状态块**展示每来源明细（退避中显示剩余倒计时）。调度器下一轮时刻 = max(配置间隔, 最差来源剩余退避)——v0.2 单来源等价旧行为，多来源后一个来源长时间退避会拉长全局轮询周期。

### AI 运行态（AiRuntimeStatus）

语义监控的观测面，展示在监控台 AI 状态块：

| 字段 | 含义 |
| --- | --- |
| `configured` | Provider 三项（baseUrl/apiKey/model）是否齐备 |
| `effectiveMode` | **实际生效**的模式（UI 看这个，不看配置的 matchMode） |
| `degraded` | 降级三态：`none`（正常）/ `unconfigured`（AI 未配置）/ `quota-exhausted`（今日 300 次配额耗尽） |
| `callsToday` / `dailyLimit` | 今日语义评估调用数 / 上限（300，本地自然日滚动） |
| `lastAiError` | 最近一次 AI 错误（脱敏；评估成功后自动清空） |

降级语义：配置了语义/叠加模式但 `degraded ≠ none` 时，`effectiveMode` 自动回 `literal`，行为与字面档完全一致；AI 评估失败**不计入轮询的 consecutiveFailures**（不影响 health），只记 `lastAiError`。

## 配置项参考

设置全集即 `AppConfig`（`src/shared/types.ts`）。保存时统一过清洗（sanitize），下表列出默认值与清洗规则：

| 字段 | 默认 | 说明 / 清洗规则 |
| --- | --- | --- |
| `includeKeywords` | `[]` | 包含词。trim、去空、去重（不区分大小写，保留首次写法）。**为空 = 字面档不推送任何帖子** |
| `excludeKeywords` | `[]` | 排除词，一票否决。清洗规则同上。**语义模式下仍先于 AI 生效** |
| `pollIntervalSec` | `60` | 轮询间隔（秒）。非法值回退 60；小于 15 钳到 15 |
| `proxyUrl` | `''` | 代理地址。必须以 `http://` `https://` `socks5://` 开头（忽略大小写），否则置空（直连） |
| `proxyScope` | `'telegram-only'` | 代理作用域：`telegram-only`（仅 Telegram；**AI 请求直连**）/ `all`（含 NodeSeek 抓取与 AI 请求）。非法值回退 `telegram-only` |
| `telegram.botToken` | `''` | @BotFather 发放，trim |
| `telegram.chatId` | `''` | 个人或群组 id，trim |
| `notifyEnabled` | `true` | 推送总开关。关闭后命中仍会记录到「最近命中」与 `hits/`，但不推送 |
| `launchAtLogin` | `false` | 开机自启。mac 上未签名应用可能被系统拒绝 |
| `sources` | `[{id:'nodeseek', type:'nodeseek', enabled:true}]` | 论坛来源列表（v2 仅 nodeseek；关键词全局共享，per-source 覆盖留给未来版本）。非数组/空回默认单项；id 规范成 slug、type 恒 `nodeseek`、enabled 布尔化、按 id 去重 |
| `ai.provider.baseUrl` | `''` | OpenAI 兼容服务地址，如 `https://api.deepseek.com/v1`。trim、去尾斜杠、必须 `http(s)://` 开头否则置空；请求时拼 `/chat/completions` |
| `ai.provider.apiKey` | `''` | 服务商 API Key，trim。仅存本机 `config.json`（600 权限） |
| `ai.provider.model` | `''` | 模型名（如 `deepseek-chat`），trim |
| `ai.matchMode` | `'literal'` | 监控模式：`literal`（字面）/ `semantic`（语义）/ `both`（字面+语义，任一命中）。枚举非法回 `literal`。Provider 未配置或配额耗尽时实际生效回 `literal` |
| `ai.interests` | `[]` | 兴趣描述（语义监控用）。每条 trim、去空、单条超 500 字符截断、**最多保留 20 条**。为空时语义档永不命中 |
| `ai.dailyReport.enabled` | `false` | 每日总结开关，强制布尔 |
| `ai.dailyReport.timeHHMM` | `'22:00'` | 日报时刻（`HH:MM`，本地时区）。格式非法（时 0-23 / 分 0-59 之外）回 `'22:00'` |

匹配语义（只匹配标题；AI 语义评估看标题与分类）：

1. 排除词任一命中 → 直接否决（优先级最高，**先于 AI**）。
2. 字面档：包含列表为空 → 永不匹配；包含词任一命中 → 推送，命中的词（去重、原始写法）记入 `matchedKeywords` 并出现在推送消息里。
3. 语义档（`semantic` / `both` 生效时）：字面未命中的新帖送 AI 批量评估（每轮最多 12 帖一次请求）；判定相关 → 推送并附 AI 理由（`semanticReason`）；不相关 → 记为已见不再重评；**评估未决（超时/响应异常）不记已见**，下轮自然重评，滚出首页即止。

保存即生效：引擎每轮轮询前重读配置，Telegram 发送前重读凭据，代理客户端随配置变更销毁重建。无需重启应用。

## 本地数据文件

桌面版所有数据在 Electron userData 目录下（托盘菜单「在 Finder 中打开配置目录」直达）：

- macOS 默认：`~/Library/Application Support/ForumWatch/`
- Windows 默认：`%APPDATA%\ForumWatch\`

| 文件 | 作用 | 说明 |
| --- | --- | --- |
| `config.json` | 配置 | 权限 600（含 bot token 与 AI apiKey，勿外传）。盘上形状为 `{"schemaVersion":2,"config":{...}}`，字段在 `config` 对象内；旧版 v1 信封由加载时迁移函数升到 v2。损坏时自动备份为 `config.json.corrupt-<时间戳>` 并回退默认配置，应用不崩溃 |
| `seen.json` | 已见帖子 ID 集 | 去重键 = `${来源id}:${帖子id}`（旧版裸 id 启动时自动加 `nodeseek:` 前缀）；容量 1000 条环形淘汰，且超过 7 天未遇到的 ID 会被清理 |
| `state.json` | 引擎状态 | v2 形状 `{schemaVersion:2, sources:{"nodeseek":{baselineDone,totalHits}}}`——基线与累计命中**按来源拆分**（防风暴语义）。旧版 v1 加载时自动迁移 |
| `hits/YYYY-MM-DD.jsonl` | 当日命中 | 每条命中追加一行 JSON（按**本地时区**日期分桶）。AI 每日总结的数据源；「今日回顾」与内存「最近命中」互不影响 |
| `reports/YYYY-MM-DD.md` | AI 日报 | 每日总结生成的 markdown（同样本地日期命名）。手动「立即生成」会覆盖当天文件 |
| `logs/log-YYYY-MM-DD.txt` | 日志文件 | 按天滚动，保留 7 天，到期自动清理；日志中的凭据一律脱敏 |

从旧版 NodeSeek Monitor 升级：新版首启自动把旧 userData 的 `config.json` / `seen.json` / `state.json` 拷贝过来（字节级、原子落位、幂等），旧目录保留不删、可随时回退；`logs/` 不拷。

headless 模式使用独立数据目录（见下文），与桌面版互不共享。

## 轮询、退避与防休眠

- 每轮间隔 = 配置值 × (1 ± 20% 随机抖动)，下限 15 秒。抖动是为了避免固定频率被识别为机器行为。
- 连续失败时按 `间隔 × 2^n` 指数退避（n = 连续失败次数），封顶 30 分钟；任一轮成功即复位为配置间隔。
- 挑战（challenged）与普通失败走同一退避曲线，只是状态展示不同。
- 不用 `setInterval`：每轮完成后按 `当前时刻 + 间隔` 重排，休眠/壁钟漂移不积累误差；系统唤醒/解锁屏幕时立即补一轮。
- macOS 上监控运行期间阻止 App Nap（`prevent-app-suspension`），暂停/退出时解除。

## 推送细节

- 消息格式（HTML parse_mode，用户内容全部转义）：

  ```
  🔔 <标题加粗>
  📁 分类 · 👤 作者
  🎯 命中: 关键词1, 关键词2
  🔗 打开帖子（链接）
  ```

  语义命中的推送同样走这个模板，但「🎯 命中」后为空（`matchedKeywords` 恒空数组）——**AI 判定理由只显示在应用内「最近命中」列表**，不进 Telegram 消息。
- 限流：串行队列，两次实际发送间隔 ≥ 1050ms（官方限制约 1 条/秒，留余量）。一轮命中多条时按旧→新顺序排队推送。
- 429：读取响应里的 `parameters.retry_after`，等待该时长（+0.5s 余量，封顶 60s）后重试。
- 其他失败（网络异常 / 非 2xx）：最多 3 次尝试（间隔 1s / 2s），仍失败记入该条命中的 `notifyError` 并在日志写明原因，不影响本轮其他帖子。
- 置顶帖跳过推送（旧帖，只入去重集）。
- 首启基线：首次抓到的整页帖子全部只入去重集、不推送（防通知风暴），日志可见 `baseline captured (N topics)`。
- 每条命中同时落盘 `hits/<本地日期>.jsonl`（见[本地数据文件](#本地数据文件)），是每日总结的数据源。

## AI 语义监控与每日总结

配置入口与写法示例见 README 的「AI 功能」「每日总结」两节；本节补齐行为语义。

### 语义评估管线（每轮轮询内）

1. 排除词检查（先于一切，一票否决）。
2. 字面匹配；`both` 模式下字面命中即推送、**不再送 AI**。
3. 剩余新帖按每批 ≤12 条切片送 AI 批量评估（一次 chat 请求，30s 超时，内联等待）。
4. 判定 `hit` → 推送（`matchedBy='semantic'`，带 AI 理由）；判定不相关 → 记为已见；**未决**（超时/响应异常/缺 id）→ 不记已见，下轮重评，滚出首页即止。
5. 每日调用上限 300（本地自然日滚动，失败调用也计数）：耗尽后本轮剩余批次放弃、整体降级 `literal`，次日自动恢复。

### 降级与失败语义

- Provider 三项未填齐 → `degraded='unconfigured'`，语义/叠加模式实际按字面跑。
- 当日 300 次耗尽 → `degraded='quota-exhausted'`，同上。
- AI 单次评估失败 → 记 `lastAiError`（脱敏），**不计入轮询失败**（health 不受影响）；帖子按"未决"处理下轮重评。
- 兴趣描述为空 → 语义档永不命中（镜像字面档"关键词为空不推送"的防风暴规则）。

### 每日总结行为

- 触发：到设定时刻（本地时区）且当天 `reports/<今天>.md` 不存在且 desired==='running'。应用启动/唤醒时补检查，**只补当天、不回溯历史**；当天自动生成失败最多重试 3 次（防死循环）。
- 内容：读当天 `hits/<今天>.jsonl` → LLM 总结成中文 markdown → 写 `reports/<今天>.md` → 推 Telegram。
- 零命中：固定文案"今日无命中"，不调 LLM，照常推送（心跳）。
- 推送：走 `sendRaw` 纯文本通道，复用串行队列与限流；超过约 3500 字符按行分段（尾缀"（续 N）"）；推送失败只记日志，日报文件不受影响。
- 手动生成：「今日回顾」页「立即生成」随时可出当天日报，**覆盖**已有当天文件（重新生成语义）。
- LLM 失败：自动降级为机械拼接模板（标题列表式），日报不断档。

## headless 模式

不经 Electron、在 node 下直跑监控内核（`scripts/headless.ts`），适合服务器部署、冒烟验证与调试：

```bash
npm run engine:headless -- --once                          # 单轮冒烟，默认目录 ./data/headless
npm run engine:headless -- --config /tmp/nsm-smoke --once  # 指定数据目录
npm run engine:headless -- --config ./data/headless        # 常驻直到 Ctrl-C
npm run engine:headless -- --duration 600 --interval 30    # 跑 10 分钟，30 秒一轮
```

参数：

| 参数 | 说明 |
| --- | --- |
| `--config <dir>` | 数据目录（内含 `config.json` / `seen.json` / `state.json` / `hits/` / `reports/` / `logs/`），默认 `./data/headless`。首次运行生成默认配置（chmod 600）并提示填写 |
| `--once` | 跑一轮后退出，打印 `fetched / fresh / hits / notified / failed / muted-or-unconfigured` 统计。**退出码：仅抓取失败（退避/挑战）为 1**；Telegram 未配置或推送失败均为 0 |
| `--duration <sec>` | 运行指定秒数后优雅退出（默认直到 Ctrl-C / SIGTERM） |
| `--interval <sec>` | 临时覆盖轮询间隔（钳到 ≥15s），**不写回配置** |

环境变量：`NSM_BOT_TOKEN` / `NSM_CHAT_ID` 注入 Telegram 凭据——只进内存、不落盘，优先级高于 config.json。

AI 能力（语义监控、每日总结）在 headless 下与桌面版同款接线，读同一份 `config.json` 的 `ai` 段——在 headless 数据目录手工编辑配置即可启用（注意改配置需重启进程）。

限制：headless 的配置是**启动时快照**，不做热更新（桌面版经 IPC 热更新）；改配置文件后需重启进程。手动编辑 `config.json` 时注意字段在外层 `config` 对象内（见上文盘上形状）。

## 故障排查矩阵

| 症状 | 先看什么 | 常见原因与处理 |
| --- | --- | --- |
| 收不到任何通知 | 设置 → 发送测试消息 | 测试失败：代理不通 / token 无效 / chatId 错 / 没给 bot 发过消息 |
| 测试消息能收、但没推送 | 监控台状态 + 最近命中 | 关键词为空或没命中；被 Cloudflare 拦截（等自动恢复）；推送总开关被静音；置顶帖 |
| 状态"Cloudflare 拦截" | 监控台 | 自动退避重试会自愈；频繁出现调大间隔，或代理作用域切 `all` 换出口 |
| 状态"退避重试中" | 状态卡"最近错误" | 网络故障居多；恢复后自动复位 |
| 日志有 `notify failed` | `logs/log-YYYY-MM-DD.txt` | Telegram 侧错误详情（429 / 网络错误），失败消息不重发，等下一个命中帖 |
| 语义模式不命中 | 监控台 AI 状态块 | ①兴趣描述为空（语义档永不命中）；②`degraded='unconfigured'`——Provider 没配齐，实际在跑字面；③`quota-exhausted`——今日 300 次用完已降级；④AI 报错看 `lastAiError`；⑤帖子字面被排除词否决（语义也救不回） |
| 日报没生成 | 「今日回顾」页 + 设置 | ①开关没开 / 时刻没到；②生成时刻应用没在运行（**不回溯**，错过当天不补历史）；③当时监控处于暂停（desired!=='running' 不生成）；④当天自动尝试已失败 3 次。以上均可在「今日回顾」点「立即生成」手动出当天日报（覆盖重生成） |
| AI 状态块有报错 / 测试连接失败 | `lastAiError` + 设置 → 测试连接 | Base URL / API Key / 模型名有误（注意 Key 是**已保存**配置）；服务商限流或余额不足；`proxyScope='telegram-only'` 时 AI 走直连，直连不通的环境把作用域切 `all`。AI 报错不影响字面监控与轮询 |
| 想重新做首启基线 | 退出应用 → 删除 `seen.json` 与 `state.json` → 启动 | 下次启动整页只记不推。⚠️ 只删 `seen.json` 不删 `state.json` 的话，`baselineDone` 仍为真，整页会被当成"新帖"处理，可能推送一批旧帖 |
| mac 上托盘图标消失 | — | 系统唤醒后的已知 Electron 问题，本应用在唤醒事件里会自动重设图标；仍异常可退出重开 |
| mac 开机不自启 | 系统设置 → 登录项 | 未签名应用被系统拒绝；当前版本请手动启动 |

更架构层面的取舍（为什么不签名、为什么解析 HTML 而非 API、数据源风险）见 [decisions.md](decisions.md)。
