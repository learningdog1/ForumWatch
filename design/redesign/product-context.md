# ForumWatch 产品语境（界面重设计输入）

> 依据材料：`README.md`（全文）、`docs/usage.md`（全文，357 行）、`src/shared/types.ts`（543 行）、`src/shared/ipc.ts`（425 行）、`docs/decisions.md` 第七/八/九轮中与界面相关的 ADR（DEC-5 / DEC-12 / E1 / E4 / DEC-6 / DEC-10）。文中引用均为本次实际读取的行号。文档版本口径：v0.5.0（README:3, usage.md:3 与 decisions.md 记载至 R9）。

---

## 1. 产品是什么

**ForumWatch**（前身 NodeSeek Monitor，README:7-9）是一个**常驻系统托盘的论坛监控工具**：按设定间隔轮询多个论坛来源的新帖，标题命中关键词（字面匹配）、符合价格规则（结构化匹配）或符合兴趣描述（AI 语义匹配）时，立即推送到用户配置的通知通道（Telegram / Bark / ntfy / Webhook，多通道并发，支持按来源或命中方式路由分流、摘要攒批与免打扰时段）。还可让 AI 为每条命中附一句锐评、每天定点生成命中日报。macOS / Windows 双平台 Electron 桌面应用（README:3）。

产品演进脉络（决定界面复杂度的来源）：单论坛关键词监控（NodeSeek Monitor）→ 多论坛来源 + AI 语义监控（v0.2）→ 价格规则 + 相似降噪 + 置信度阈值（R5）→ 推送通道化（4 类通道 + 路由 + 摘要/免打扰，R6）→ 透明度包（处置流水 + 历史命中 + 统计 + AI 反馈，R7）→ 运维硬化（看门狗 + 更新检查 + 备份 + headless 热重载，R8）→ Telegram 遥控 + 凭据加密（R9）。

**架构形态**（README:289-299）：Electron 44 三进程——主进程跑监控内核（零 Electron 依赖的纯 TS），preload 白名单桥，renderer 是 React UI（现有五 tab）。数据全部本地（userData 目录下 config.json / seen.json / state.json / hits/ / pipeline/ / reports/ / feedback.json / logs/，README:265），无云端、无埋点。

## 2. 给谁用

从功能与文案推断（README:74-117 快速上手、usage.md 故障排查矩阵的服务对象）：

- **个人技术用户**，活跃于 VPS / 主机交易类论坛（NodeSeek、V2EX、Linux.do、LowEndTalk），想第一时间捕获优惠帖 / 羊毛帖 / 教程帖——"白嫖"、"年付 ¥99"、"Oracle 免费 ARM" 这类兴趣是典型场景（README:172-176）。
- **中文用户为主**：全界面中文；大陆用户访问 Telegram 需代理是产品明确的一等场景（README:95, 205-216 有专门的「网络与代理（大陆用户必读）」）。
- **动手能力强**：会创建 Telegram Bot、可能自建 Bark/ntfy 服务器、消费 Webhook JSON、自选 LLM Provider（DeepSeek/Kimi/GLM 或任意 OpenAI 兼容服务，README:150-160）、会跑 headless 模式。
- 单人单机使用——没有多用户、协作、分享语义；一切配置与数据在本机。

## 3. 核心价值

1. **及时性**：新帖出现（轮询默认 60s + 抖动）→ 命中 → 即时推到手机，多通道并发、任一成功即算送达（README:29, 34；usage.md:203-205）。
2. **三种命中方式互补**：字面关键词（零成本确定）、价格规则（结构化确定、零 AI 成本）、AI 语义（能捕捉"换种说法"的帖子），可叠加使用（README:17-19）。
3. **可解释性**（本产品的差异化卖点）：每条新帖在判定管线每个出口的去向都记在「流水」页，14 类去向覆盖全部出口——"为什么没收到推送"从此有界面答案（README:23；usage.md:34-39）。
4. **越用越准**：命中行 👍/👎 反馈注入后续语义评估提示词，AI 判断贴合用户口味（README:28）。
5. **本地与隐私**：配置、已读、命中、流水、反馈、日志全在本机；不上传任何数据；AI 仅在主动配置后把标题/分类/兴趣描述发往用户自填的服务地址（README:43, 263-269）。

## 4. 关键任务流（从配置监控到收到通知的完整路径）

### 4.1 首次上手（README:74-97「快速上手」七步）

1. 安装启动 → **首启基线**：首页现有帖子全部只记已读、不推送（防通知风暴；usage.md:242）。
2. 「设置 → 关键词」填包含词/排除词（标签输入，回车添加）。
3. （可选）「设置 → 来源」加 V2EX / Linux.do / LowEndTalk 预设或任意 RSS/Atom 地址；每来源可配分类白/黑名单、作者黑名单（per-source 过滤，usage.md:45）。
4. 创建 Telegram Bot → 「设置 → 推送通道」填 Bot Token + Chat ID；或改用 Bark / ntfy / Webhook（各自凭据表单，usage.md:48-49）。
5. （可选）「设置 → AI 模型」配 Provider（预设或手填）→ 测试连接 → 「监控模式」切语义/叠加档、写兴趣描述（usage.md:57-58）。
6. 点「✈ 发送测试消息」——向全部就绪通道广播验证链路（不走路由，usage.md:51）。
7. 保持应用运行（关窗 = 最小化到托盘继续监控）。

### 4.2 日常监控回路（核心运行时任务流）

新帖从抓取到推送经过**九步判定管线**（usage.md:151-163，按序）：

```
挂起队列成员检查 → per-source 过滤 → id 阈值旧帖 → 置顶 → 排除词
→ 价格规则 → 字面匹配 → 相似降噪闸 → 语义批（置信度闸）
→ （任一命中且未被拦）→ 推送策略闸（免打扰/摘要挂起 or 即时推送）
```

- 规则 > 字面 > 语义的优先级：规则命中短路字面与语义；both 档字面命中不再送 AI（省调用）。
- 用户在**监控台**观察这条回路：状态卡（运行四态 + 四格指标 + 挂起行 + 最近错误）、来源状态块（per-source 健康）、AI 状态块（生效模式 + 配额计数 + 降级提示）、最近命中（带命中方式徽标与 👍/👎）、运行日志（usage.md:22-28）。
- 排查"为什么没推送"：**流水页**按标题搜该帖，看它落在 14 类去向中的哪一类（未命中 / 已拦截 / 挂起中 / 推送结果），detail 小字带原因（README:227；usage.md:34-39）。

### 4.3 暂停与远程控制

- 托盘菜单 / 监控台操作行：暂停 / 恢复 / 立即轮询 / 测试通知（usage.md:26, 68）。
- **Telegram 遥控**（可选）：手机上向 bot 发 `/status` `/pause` `/resume` `/poll` `/help`；允许清单外静默忽略；监控暂停期间遥控仍可达（/resume 正是救回手段，README:32；usage.md:53）。

### 4.4 回顾与调优

- 「历史命中」页：日期范围 + 来源 + 命中方式 + 文本搜索查全部落盘命中；顶部统计面板（近 14 天总命中 / 推送失败率 / 命中日 / 来源分布 / 三方式占比 / 关键词命中榜——零命中关键词灰字提示"未命中，考虑移除"）帮用户修剪无效关键词（README:24-25；usage.md:30-33）。
- 「今日回顾」页：翻近 14 天 AI 日报，今天没有可「立即生成」（README:27；usage.md:29）。
- 「设置 → 匹配测试台」：粘贴标题按已保存配置逐阶段跑管线，看会命中在哪一步、被什么拦下（只读诊断，README:22；usage.md:56）。

### 4.5 运维与迁移

- 「设置 → 数据」导出/导入单文件 JSON 备份（含明文凭据警告；导入需重启生效，usage.md:65）。
- 「设置 → 关于」手动检查更新（只检查不自动更新；README:40）。
- 「设置 → 网络（代理）」：地址 + 作用域二选一（仅 Telegram 走代理 / 全部请求走代理），保存即生效（README:36）。
- 旧版 NodeSeek Monitor 升级自动迁移配置/已读/状态（README:11）。

## 5. 界面必须承载的功能与实体

### 5.1 信息架构：五个页签 + 托盘（usage.md:19-40；DEC-12，decisions.md:225 起）

现有 IA 为左右双栏：左侧栏（品牌 + 五页签 + 底部迷你运行状态），主区随页签切换。五页签各有清晰的数据面分工（DEC-12）：

| 页签 | 数据面 | 核心问题 |
| --- | --- | --- |
| 📊 监控台 | 内存环形（最近命中 200 / 日志 500），事件推送驱动 | 现在正在发生什么 |
| 📅 今日回顾 | reports/ 落盘日报（14 天） | 今天命中总结成了什么 |
| 📜 历史命中 | hits/*.jsonl 落盘跨日查询 + 统计 | 历史上落盘了什么 |
| 🔍 流水 | pipeline/*.jsonl（7 天）+ 内存环实时视图 | 没推送的那些去哪了 |
| ⚙️ 设置 | config.json（draft-保存模式） | 一切配置入口 |

**托盘是第二交互面**：关窗 = 隐藏窗口继续监控；托盘菜单六项（显示主窗口 / 暂停或恢复 / 立即轮询 / 发送测试通知 / 打开配置目录 / 退出）；macOS 无 dock 图标、点托盘切换窗口显隐；托盘 tooltip 与左侧栏底部迷你状态同口径（`deriveTrayLabel`，ipc.ts:420-425；usage.md:68）。

### 5.2 监控台的块状结构（usage.md:22-28）

1. **状态卡**：运行状态徽标四态（运行中 / 已暂停 / Cloudflare 拦截 / 退避重试中——由 desired × health 两维派生，usage.md:72-87）+ 四格指标（上次轮询 / 下次轮询 / 连续失败 / 累计命中）+ 最近错误 + 挂起待推送行（`⏳ 挂起待推送 N 条`，仅 N>0 显示）。
2. **来源状态块**：每个已启用来源一行——健康点、来源名、健康文案（退避中 mm:ss 倒计时）、最近成功时间。
3. **AI 状态块**：生效模式徽标（字面 / 语义 / 字面+语义——看 `effectiveMode` 不看配置值）+ 今日调用 `N/300` 与锐评 `N/100` 两行 + 降级提示（AI 未配置 / 今日配额用尽）+ 最近 AI 错误（评估成功自动清空）。
4. **操作行**：⏸ 暂停 / ▶ 恢复（同一按钮随状态切换）、🔄 立即轮询（暂停时禁用）、✈ 发送测试通知（广播全部就绪通道，不走路由）。
5. **最近命中**：每条带来源徽标 + 命中方式徽标（**字面** / **语义** / **规则**）；语义命中显示 AI 一句话判定理由，规则命中显示命中的规则名；行尾 👍/👎 反馈按钮（三态：记票 / 同向撤销 / 反向改票；高亮是会话级，usage.md:270）。
6. **运行日志**：最近 500 条，info/warn/error 三级。

### 5.3 设置页：十七个卡片（顺序即页面顺序，usage.md:40-66）

来源（置顶）、关键词、推送通道、推送策略、Telegram 遥控、路由规则、价格规则、匹配测试台、AI 模型、监控模式、相似降噪、每日总结、轮询、网络（代理）、行为、数据、关于；底部统一「保存设置」。

各卡片要点（界面必须承载的编辑面）：

- **来源**：来源列表（类型徽标 NodeSeek/V2EX/RSS + 名称 + 地址 + 「过滤」展开 + 启停 + 删除；默认 NodeSeek 不可删、列表不可删空）+ 三个预设一键添加（已添加置灰、如实标注 CF 拦截风险）+ 自定义 RSS 表单（地址 + 可选显示名）+ per-source 过滤（分类白/黑名单、作者黑名单三个标签输入，一次只展开一行）。
- **关键词**：包含词 + 排除词两个标签输入；⚠️ 包含词为空 = 字面档不推送任何帖子（防误设计）。
- **推送通道**：通道列表（类型徽标 + 通道 id + **就绪状态点**（绿=就绪 / 黄=齐备但停用 / 红=凭据缺失）+ 启停 + 删除 + 「编辑」展开按类型凭据表单；至少保留一条、上限 8）+ 添加通道（类型下拉 → 分类型表单）+ 测试推送按钮宿主。
- **推送策略**：模式单选（实时 / 摘要攒批）+ 摘要间隔（1-120 分钟）+ 免打扰时段（开关 + 起止时刻，支持跨午夜；起止相等 = 空区间恒不静默）+ 挂起语义提示。
- **Telegram 遥控**：开关（默认关）+ 允许 Chat ID 标签输入（上限 10；主 Chat ID 隐含允许）+ 独占提示（getUpdates 被本应用独占、与其他工具 409 冲突）。
- **路由规则**：规则列表（when 摘要 → 目标通道摘要）+ 添加表单（来源「任意」/ 命中方式多选 / 价格规则下拉（选中自动勾「规则」方式）/ 目标通道多选）；**按列表顺序首条命中生效**；至少一个条件 + 至少一个目标通道；上限 20。
- **价格规则**：规则列表（规则名 / 条件摘要 / 编辑展开行内表单 / 启停 / 删除；上限 20）；表单字段：规则名、周期（不限/年付/月付）、价格上限 + 币种（不限/¥/$）、流量下限（GB）、关键词前置（≤20）。
- **匹配测试台**：标题输入（+ 可选来源/分类/作者/是否调用 AI）→ 逐阶段 trace（六阶段：来源过滤 → 排除词 → 价格规则 → 字面 → 相似 → 语义，每阶段 ✓放行 / ✗拦截 / –跳过 / ·无命中 + 原因）+ wouldPush 结论。
- **AI 模型**：Base URL / API Key / 模型名 + 三预设（DeepSeek/Kimi/GLM，只填地址与模型名，Key 自填）+ 测试连接（按已保存配置）+ 推送锐评开关（默认开）。
- **监控模式**：三选一单选卡片（字面 / 语义 / 字面+语义）+ 兴趣描述标签输入（建议 ≤20 条）+ 语义置信度阈值滑杆（0-1，默认 0）。
- **相似降噪**：开关（默认开）+ 阈值滑杆（0.50-0.95，默认 0.72）。
- **每日总结**：开关 + 时刻（默认 22:00）。
- **轮询**：30/60/120 秒快捷按钮；<15s 红字提示（保存钳到 15）。
- **网络（代理）**：地址（http/https/socks5 前缀校验）+ 作用域单选。
- **行为**：推送总开关（临时静音：仍记录命中但不推送）+ 开机自启。
- **数据**：导出备份（保存对话框，默认名 `forumwatch-backup-YYYYMMDD.json`，**明文凭据双重警告**）+ 导入备份（两步：确认层 → 文件选择 → 验包红字错误 → 需重启生效）。
- **关于**：版本号 + 更新检查三态（有新版附「打开下载页」/ ✓已最新 / 检查失败附原因与时间）。

### 5.4 历史命中页（usage.md:30-33）

- **统计面板**（近 14 天固定窗口，与列表筛选解耦——"列表是查询视图、统计是画像"）：四个指标块（总命中 / 推送失败率 / 命中日 / 来源数）+ 三命中方式占比（堆叠比例条 + 图例）+ 来源分布 Top + 关键词命中榜（零命中词灰字附尾"未命中，考虑移除"）。
- **历史命中列表**：日期范围（默认近 7 天）+ 来源下拉（配置来源 ∪ 历史出现过的来源——已删来源仍有历史数据）+ 命中方式多选 + 文本搜索（标题/命中词/规则名，300ms 防抖）+ 分页（50/页）；结果恒新→旧；标题点击打开原帖；推送状态三态（✓ 已推送 / ✗ 失败 hover 原因 / − 静音）。
- 两个数据面手动刷新（无事件订阅）。

### 5.5 流水页（usage.md:34-39；DISPOSITION_OUTCOMES，ipc.ts:31-60）

- **14 类去向**分四组：推送结果（已推送 / 推送失败 / 静音）、已拦截（来源过滤 / 旧帖 / 置顶 / 排除词 / 相似去重）、未命中（未命中 / 语义未中 / 置信度低）、挂起中（已挂起 / 挂起中 / 语义待判）；每条带 detail 小字（命中词 / AI 理由 / score 与阈值 / 失败原因）。
- **去重语义**：同帖同去向不重复记，去向变化才追加——同帖形成处置轨迹（如 `已挂起 → 已推送`）。
- **双数据面**：日期留空 = 实时视图（内存环最近 200 条，10s 自动刷新）；选日期 = 该日落盘文件（静态）；分组 chips（单选）+ 来源下拉 + 日期选择。

### 5.6 今日回顾页（usage.md:29）

左侧日期栏（有日报的日期，新→旧，最近 14 个）+ 顶部当天命中数摘要 + markdown 日报正文 + 空态「立即生成」按钮。

### 5.7 核心实体模型（types.ts，界面字段的事实源）

| 实体 | 定义处 | 关键字段与展示语义 |
| --- | --- | --- |
| 来源 SourceConfig | types.ts:56-113 | 判别联合 nodeseek/v2ex/rss；id（slug，去重键前缀）、enabled、可选 filters（includeCategories/excludeCategories/blockedAuthors）、rss 带 url + label |
| 帖子 Topic | types.ts:178-195 | id、sourceId、title、url、author、category（显示名）/categorySlug、pinned、lastActiveAt（是最后回复时间非发帖时间） |
| 命中记录 HitRecord | types.ts:198-231 | topic + matchedKeywords + matchedBy（literal/semantic/rule 三档）+ semanticReason（AI 理由）+ matchedRule（规则名，**可选**）+ commentary（锐评，**可选**）+ notifiedAt/notifyError + notifyDetail（per-channel 送达明细，**可选**，键=通道 id） |
| 处置 Disposition | ipc.ts:66-79 | ts、sourceId、topicId、title、outcome（14 枚举）、detail |
| 通道 ChannelConfig | types.ts:247-294 | 判别联合 telegram（botToken/chatId）/bark（deviceKey + serverUrl?）/ntfy（topic + serverUrl?）/webhook（url + secret?）；id、enabled |
| 推送策略 NotifyConfig | types.ts:297-323 | mode（instant/digest）、digestIntervalMin、quietHours{enabled,startHHMM,endHHMM}、remoteControl{enabled,allowedChatIds} |
| 路由规则 RoutingRule | types.ts:326-341 | when{sourceId?, matchedBy?, ruleId?}（全 AND）→ channelIds；首条命中生效 |
| 价格规则 PriceRuleConfig | types.ts:154-175 | id、label?、enabled、cycle（yearly/monthly/any）、maxPrice?、currency?、minTrafficGB?、keywords?（AND 前置） |
| AI 配置 AiConfig | types.ts:116-151 | provider{baseUrl,apiKey,model}、matchMode（literal/semantic/both）、interests（≤20 条）、semanticThreshold、dailyReport{enabled,timeHHMM}、commentary{enabled} |
| 引擎状态 EngineStatus | types.ts:476-504 | desired（running/paused，唯一可写）× health（ok/backoff/challenged，自动流转）、四格指标字段、sources[]（per-source）、ai（AiRuntimeStatus：configured/effectiveMode/degraded/callsToday/commentaryToday?/dailyLimit/lastAiError）、pendingNotifyCount?、watchdog? |
| 反馈 | ipc.ts:314-322 | direction positive/negative/undo；键 = `${sourceId}:${topicId}`；正负例各环形 100 条 |
| 日报 DailyReportInfo | types.ts:530-535 | date（本地 YYYY-MM-DD）+ markdown（null = 无） |
| 统计 StatsResult | ipc.ts:268-308 | total、byDay、byMatchedBy{literal,semantic,rule}、bySource、keywordHits（零命中附 zeroHit:true）、pushFailRate |
| 更新状态 UpdateCheckStatus | ipc.ts:336-348 | state（idle/available/up-to-date/error）、current、latest?、downloadUrl?、error? |

## 6. 影响设计的约束

### 6.1 平台与形态

- **Electron 桌面应用，macOS / Windows 双平台**，未签名未公证（mac 首开需右键打开、Win 遇 SmartScreen——README:344）。设计需兼容两平台控件习惯（如时间选择、文件对话框）。
- **托盘常驻是产品身份**：关窗 ≠ 退出；真正的退出走托盘菜单。界面要不断暗示"窗口关了监控还在"（迷你状态、挂起行、托盘 tooltip 同口径）。macOS 上应用不出现在 Dock 与 Cmd+Tab（usage.md:68）。
- 全中文界面（现有 UI 文案全中文，含 emoji 前缀的页签/按钮惯例：📊 📅 📜 🔍 ⚙️ / ⏸ ▶ 🔄 ✈ ⏳）。

### 6.2 数据新鲜度三档（ipc.ts:6-15 语义约定 + usage.md 各页描述）

1. **事件推送增量**：状态 / 命中 / 日志 / 日报生成由主进程 ev* 广播，渲染端 invoke 拉全量 + 事件追加——监控台是"活"的。
2. **定时轮询**：流水实时视图 10s 自动刷新（无事件通道）。
3. **手动刷新**：历史命中与统计（落盘文件静态，无订阅）。
   重设计需尊重这档差异：不能把历史页做成"看似实时"。

### 6.3 设置页的 draft-保存模式

- 所有配置改动先进 draft，点底部「保存设置」才生效（保存即生效、无需重启——除导入备份，usage.md:165, 65）。
- 未保存修改时：页签出现未保存圆点；切走页签先弹提示条（放弃并切换 / 留下，usage.md:21）。
- 「测试连接」「发送测试消息」「匹配测试台」都用**已保存**配置，表单 dirty 时提示先保存（usage.md:63）——界面上"已保存"与"草稿"两种状态必须始终可区分。

### 6.4 环形缓冲与保留边界（界面数据面的"有限性"要可视或至少不误导）

- 最近命中 200 条（内存，重启清空；`totalHits` 计数才跨重启累计）；日志 500 条（内存）；流水实时 200 条 / 落盘 7 天；hits 落盘永久；日报 14 天；反馈正负各 100 条。
- 历史命中分页 50/页、单次请求上限 200 钳位；统计界面固定 14 天（IPC 支持 1-90 天，留了调整口，usage.md:31）。

### 6.5 可选字段与旧数据兼容

类型契约大量"**可选字段，旧数据缺失容忍**"（matchedRule / commentary / notifyDetail / pendingNotifyCount / watchdog / commentaryToday——types.ts 各字段注释）。重设计的详情展示必须把"字段缺失"当作正常态（等价"无"），而非错误。

### 6.6 状态语义约束（ipc.ts:10-13 + usage.md:72-117）

- 展示状态由 **desired（用户意图）× health（内核观测）** 派生为四态：运行中 / 已暂停 / Cloudflare 拦截 / 退避重试中；desired 优先。
- **已暂停时忽略 nextPollAt**（字段保留旧值但 UI 显示 `—`）——不能拿它判断"是否在轮询"。
- 聚合 health 取各来源最差（challenged > backoff > ok），但单来源被拦不影响其他来源——全局状态与 per-source 状态需同时可见。
- 挂起（免打扰/摘要）不是失败：挂起帖不入已读、不产生命中记录，到点补发——`⏳ 挂起待推送 N 条` 行是关键安慰性信息。
- AI 降级三态（none/unconfigured/quota-exhausted）静默回字面档：**看 effectiveMode 不看配置的 matchMode**；AI 错误不影响监控健康（不进失败计数）。

### 6.7 数量上限与删除下限（sanitize 会强制，界面应前置提示）

通道 ≤8 且至少 1 条；路由规则 ≤20 且至少一条件一目标；价格规则 ≤20、每条 keywords ≤20；遥控 allowlist ≤10；兴趣 ≤20 条（超了橙字提示不硬拦）；per-source 过滤各列表 ≤100；轮询间隔 ≥15s；摘要间隔 1-120 分钟；代理地址前缀非法保存时清空。

### 6.8 安全与凭据呈现

- 四类凭据（AI Key / Telegram Token / Bark DeviceKey / Webhook Secret）落盘加密（`enc:v1:`，README:42）；**日志与错误消息全脱敏**——界面任何错误展示不得破坏该口径。
- 备份导出**含明文凭据**（600 权限）：卡内警告 + 成功提示双重提醒——重设计需保留强警告位。
- 外链打开经主进程白名单（https + 启用来源域 ∪ github.com，ipc.ts:99-106）：界面上的"打开原帖/下载页"都是受控跳转。

### 6.9 就绪（ready）概念

通道"就绪" = enabled 且凭据齐备；只有就绪通道参与扇出；就绪状态点（绿/黄/红）是排查第一入口。无规则命中 / 测试消息 / 日报 → 全部就绪通道广播；路由命中 → 仅目标通道（且不回退广播，usage.md:203-207, 332）。

### 6.10 防风暴与空配置语义（易被误解，界面需主动解释）

- 包含关键词为空 = 字面档**不推送任何帖子**（故意的防误设计，README:107）；兴趣为空 = 语义档永不命中（镜像规则，usage.md:263）。
- 首启基线只记不推；置顶帖跳过；排除词一票否决先于一切命中方式。
- 这些"没收到推送"的高频误解正是流水页存在的理由——重设计应把"解释"能力前置。

### 6.11 其他

- 现有 renderer 为 React（README:294）；重设计不必更换技术栈假设，但本文档只定语境不定实现。
- IPC 失败纪律：所有 invoke 失败收敛为 `{ok:false, error}`，不向渲染进程抛异常（ipc.ts:12-14）——界面的错误展示是"值"而非"异常"。
- 已知限制中影响期望管理的：只监控第 1 页（高峰可能漏帖）、摘要模式是"到点逐条发"非合并成一条、无逐通道单独测试按钮（想单测需临时停用其他通道，README:347, 357-358）。
