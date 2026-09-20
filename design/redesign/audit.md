# ForumWatch 现有界面 UX 审计

> 审计方式：纯代码还原（未运行应用——本次为设计交付，约束禁止 `npm run dev`）。逐行阅读了 `src/renderer/src/` 下全部 5 个页面、16 个组件、`theme.css` / `global.css` 全量，以及支撑层 `lib/status.ts` / `lib/time.ts` / `lib/presets.ts`（经检索确认引用关系）、`hooks/useApi.ts`、`hooks/useNow.ts`（经 useApi 引用确认）、`src/main/desktop/window.ts`（窗口尺寸）。所有结论附 `path:line` 证据；凡属推断而非代码可见事实的，行文明确标注。字号 token 使用情况经 `grep -rn "fs-28\|fs-20"` 验证。
>
> 产品语境参见同目录 `product-context.md`：单机中文技术用户、VPS/羊毛论坛监控、常驻托盘、本地数据、可解释性是差异化卖点。

---

## 1. 总体评价

这是一个**成熟度相当高**的自建界面：零框架零组件库（global.css:2-4），却有一套执行纪律严格的 token 体系（theme.css:5-10：字号 5 档 / 间距 4px 栅格 / 圆角 3 档 / 双层阴影）、统一空态组件（EmptyState.tsx:8-17）、统一图标系统（icons.tsx:20-35，16×16 栅格 / stroke 1.5 / currentColor / aria-hidden）、暗色模式整组覆盖（theme.css:83-120）、以及多处超出一般水准的细节处理（日志跟随暂停、IME 组合键处理、请求序号守卫、dirty 守卫）。注释里可见多轮迭代（D8 / R4-R9 工作包），核心交互链路（配置→保存→测试→监控→查看）是闭环的。

主要问题集中在四个层面：

1. **错误态系统性缺失**——除两处外，全部数据面加载失败被静默吞掉，与空态不可区分（§5.2，最高优先级）。
2. **命名与 IA**——「流水」「今日回顾」两个 tab 名没有传达页面价值；设置页 17 张卡单列长滚无导航（§4.5、§5.1）。
3. **口径一致性**——统计面板与列表两套口径、来源显示名三页两种、同一状态文案两处漂移（§4.3、§5.5）。
4. **数据密集场景打磨不足**——列表整屏闪 loading、分页只有前后翻、路由规则无排序、自动刷新无暂停（§5.6）。

---

## 2. 现有信息架构

```
侧栏（184px，App.tsx:100-159）
├─ 品牌 ForumWatch / 论坛监控
├─ 监控台    Dashboard  状态卡 + 挂起行 + 最近命中 + 运行日志（Dashboard.tsx:51-83）
├─ 今日回顾  Reports    左日期栏 + AI 日报正文（Reports.tsx:153-213）
├─ 历史命中  History    统计面板(14天) + 筛选列表(分页)（History.tsx:445-636）
├─ 流水      Dispositions  处置流水：outcome 分组 + 来源/日期筛选（Dispositions.tsx:133-229）
├─ 设置      Settings   17 张卡片单列 + 底部保存栏（Settings.tsx:342-806）
└─ 底部迷你运行状态（App.tsx:155-158，与托盘 tooltip 同口径）
```

- 五 tab 职责切分基本成立：**看现在**（监控台）/ **看总结**（今日回顾）/ **查原始记录**（历史命中）/ **查为什么**（流水）/ **改配置**（设置）。
- 设置 dirty 守卫：dirty 时切走 tab 弹行内 leavebar「放弃修改并切换 / 留在设置」（App.tsx:88-96, 162-179），侧栏「设置」项给 dirty-dot（App.tsx:150-153）。不做路由拦截的取舍在注释里写明（App.tsx:6-7）——这是正确的桌面应用做法。
- 状态数据只在壳层 useApi 一份，向下传给监控台（App.tsx:76, 180-181），避免双份订阅（App.tsx:5 注释）——架构干净。

**IA 层面的问题**：

- 「流水」是会计隐喻，tab 名（App.tsx:141）不传达页面价值。页内卡叫「处置流水」（Dispositions.tsx:139），空态文案才说出价值——「"为什么没推送"在这里查」（Dispositions.tsx:199）。而 product-context.md:§3 明确「可解释性是本产品的差异化卖点」，恰恰是这条差异化能力的入口名字最难懂。
- 「今日回顾」名不符实：页面实际支持浏览任意历史日期的日报（Reports.tsx:2-3「当天（或历史某天）」；日期栏 History.tsx 侧 Reports.tsx:165-175「更早」分组）。同时 tab 叫「今日回顾」、页内栏目标题叫「日报」（Reports.tsx:156），两套名字指同一物。
- 设置页内 17 张卡的顺序（Settings.tsx:344-788）：来源→关键词→推送通道→推送策略→Telegram 遥控→路由规则→价格规则→**匹配测试台**→AI 模型→监控模式→相似降噪→每日总结→轮询→网络（代理）→行为→数据→关于。「匹配测试台」是诊断工具而非配置项，插在「价格规则」与「AI 模型」之间打断配置流（Settings.tsx:396-398）；「轮询」「网络」「行为」三张各只有 1-2 个控件的小卡散在尾部，与「每日总结」这类大卡颗粒度不齐。
- 五个 tab 中三个查看页（监控台/历史命中/流水）复用 `page-dashboard` 类名（History.tsx:446、Dispositions.tsx:134），纯维护性问题（用户不可见），但说明后加页面是在"借用"监控台布局而非建立自己的页面骨架。

---

## 3. 视觉语言与 token 体系

**体系本身（好评）**：

- 双主题完整：浅色 `:root` + `prefers-color-scheme: dark` 整组覆盖（theme.css:12-120），配合 `color-scheme: light dark` 让原生控件跟随（theme.css:2）。
- 语义色齐备：`--ok/--warn/--err/--ai` 各带 `-bg` 弱底（theme.css:70-77）；tone 体系通过自定义属性 `--tone/--tone-bg` 下发（global.css:330-347），状态徽标/健康点/侧栏底共用一套。
- 排版纪律：全局 `tnum` 等宽数字（global.css:28），时间戳/计数/倒计时对齐；mono 字体用于日志/输入回显（global.css:807, 884）。
- 交互反馈：所有交互件 120-180ms 过渡（theme.css:41-42；global.css:134-137, 575-582）；`:focus-visible` accent ring（global.css:42-45）；`.btn:active` 微下沉（global.css:590-592）。
- 组件风格统一：卡片（radius-m + border + 双层阴影，global.css:230-236）、按钮三档（普通/primary/danger，global.css:560-618）、徽标两族（描边幽灵 `.src-badge` vs 实底 `.cat`/`.chip`，global.css:681-708 有注释说明区分意图）、开关（global.css:1000-1032）。

**执行层的侵蚀**：

- **字号阶定义 5 档实际只用 3.5 档**：`--fs-28` 全项目零使用、`--fs-20` 仅日报 `doc-h1` 一处（grep 验证，global.css:1244 唯一命中）。页面级标题层级缺失——卡片标题是 12px 灰字（global.css:246-252），全界面最大的常态文字是状态徽标 15px（global.css:349-360）。结果是设置页 17 张卡视觉节奏全平，没有分组、没有大小对比，只能靠滚动扫描。
- **内联样式绕开 token**：History 页全页内联（History.tsx:176, 216-224, 267-284, 300, 319, 326-329——文件头注释 History.tsx:17-18 自己承认）；「规则」命中徽标的绿色配色在 HitList.tsx:83-90 与 History.tsx:140-146 **重复内联两份**；RulesCard/SourceCard/ChannelsCard 的展开区 padding/背景内联（RulesCard.tsx:160、SourceCard.tsx:208-212、ChannelsCard.tsx:396-400）。改一处色值要动两处文件。
- **`.card-scroll` max-height: 280px**（global.css:266-269）：设置页的来源列表、通道列表、规则列表都套这个类（SourceCard.tsx:151、ChannelsCard.tsx:340、RulesCard.tsx:109），条目多时在整页滚动里再嵌一层 280px 滚动——滚动套滚动是桌面表单的经典痛点。
- 空态两套体系并存：卡片式 EmptyState（插画+标题+提示+动作，EmptyState.tsx:8-17）与灰字 `.empty` / `.src-empty`（global.css:283-288, 473-476）混用（如 History.tsx:482「正在加载统计…」用 `.empty`，History.tsx:599 空态用 EmptyState）。
- 窗口 980×700 默认、无 minWidth（window.ts:30-32），可缩到极窄；响应式断点只有 720px 一档（global.css:1284-1306），只覆盖 `.substatus` 与 `.page-reports`，History/Dispositions 的筛选行在窄窗仅靠 flex-wrap 兜底。

---

## 4. 各页审计

### 4.1 监控台（Dashboard.tsx + StatusCard + HitList + LogView）

**层级**：状态徽标 → 4 格指标（上次/下次轮询、连续失败、累计命中，StatusCard.tsx:151-164）→ 来源/AI 双列子块 + 操作条（StatusCard.tsx:165-179）→ 挂起待推送行 → 最近命中 → 运行日志。优先级排序正确：状态先于数据、数据先于日志。

**好的细节**：

- 暂停时「下次轮询」显示 "—" 并 title 解释「已暂停，不排程」（StatusCard.tsx:153-157）——避免了显示过期时间的误导。
- 「立即轮询」在暂停时 disabled 且 title 给出解法「已暂停：先恢复监控」（StatusCard.tsx:122-131；HitList 空态同款 HitList.tsx:228-231）。
- AI 块按 effectiveMode（实际生效）而非配置展示，降级三态各有文案（StatusCard.tsx:8-9, 89-94）；配额/锐评子限额两行计数带 title 口径说明（StatusCard.tsx:77-87）。
- LogView 自动跟随 + 上滚暂停 + 贴底恢复 + 卡头行内提示（LogView.tsx:20-45, 41-45）——日志刷屏场景的标准解法，做对了。
- HitList 空态区分「从未命中」与「启动后还没有新命中（累计 N 条）」两态并联动「立即轮询」（HitList.tsx:219-242）。
- 命中行三档命中方式徽标色彩区分（字面中性/语义 AI 紫/规则绿，HitList.tsx:64-113）+ 推送状态三态（✓/✗/−）hover 给原因（HitList.tsx:18-39）。

**问题**：

1. **挂起待推送的关键语义全藏在 hover title**（Dashboard.tsx:66-73）：行内只有「⏳ 挂起待推送: N 条」，而「不入已读、暂不计数、**重启丢弃**」这些直接影响用户数据预期的语义只在 title 里。桌面端 hover 发现性低，用户不知道挂起条目有丢失风险（虽有兜底：仍在首页的帖子会重新处理，Dashboard.tsx:69 title 原文）。
2. HitList 新命中从顶部插入（useApi.ts:58-60 前插），**没有"暂停跟随"机制**——用户正在阅读列表中部时新命中到达会把内容推下去（LogView 有该机制，HitList 没有）。监控高频命中时阅读会被反复打断。
3. 日志区**无级别筛选、无复制按钮**：200 条环（useApi.ts:18）里找一条 error 只能肉眼扫（LogView.tsx:37-59）。文本可选中（global.css:33-39 已放开 user-select）算是兜底。
4. VoteButtons 用 emoji 👍/👎 作按钮内容（HitList.tsx:184-199），title 写了三态语义但没有 aria-label；且**只在监控台有、历史命中页没有**——两页行结构不一致，用户在历史页无法补投反馈（History.tsx:171-199 无投票区，属本地复刻时省略）。

### 4.2 今日回顾（Reports.tsx）

**结构**：左 148px 日期栏（今天恒置顶 + 更早 14 个，Reports.tsx:155-176）+ 右日报卡。空态三态区分（加载中/今天未生成可手造/该日无日报，Reports.tsx:184-209）清晰，「立即生成」带 loading 与结果反馈（Reports.tsx:193-205）。订阅主进程生成完成事件自动刷新（Reports.tsx:123-130）。这部分是扎实的。

**问题**：

1. **更早的日报不可达**：`dates.filter(...).slice(0, 14)`（Reports.tsx:149）——第 15 天以前已生成的日报没有任何入口（listDailyReports 明明返回了全部日期，被前端截断）。对一个"补看历史"的页面（设置页 hint 原话，Settings.tsx:654「已生成的日报在『今日回顾』页随时可查」），这是可达性缺陷。
2. **markdown 纯文本行渲染的可见瑕疵**：只解析标题/列表/空行（Reports.tsx:29-88），LLM 输出的 `**加粗**`、`[链接](url)`、表格等会**原样显示星号和方括号**。注释表明是有意取舍（Reports.tsx:5-6「不引 markdown 库」），但日报是该页的绝对主体内容，语法残留直接损伤阅读体验。
3. 命中数摘要是正则尽力解析（Reports.tsx:21-27），LLM 不按格式输出就不显示——可接受的降级，但头部信息（生成时间）同样依赖头部解析，失败时卡片头只有日期（Reports.tsx:179-182）。

### 4.3 历史命中（History.tsx）

**结构**：统计卡（4 指标 + 命中方式占比条 + 来源 Top + 关键词榜，固定近 14 天）+ 列表卡（日期范围/来源/命中方式多选/文本搜索 + 50/页分页）。工程细节到位：请求序号守卫防慢响应覆盖（History.tsx:363-365, 376, 389）、搜索 300ms 防抖（History.tsx:77-84）、筛选变化自动回第一页（History.tsx:401-403）、页码越界收口（History.tsx:406-409）、**统计面板有完整错误态**（错误文案 + 重试按钮 + 旧数据保留，History.tsx:411-426, 463-480）——这是全应用唯一做对错误态的数据面。

**问题**：

1. **统计与列表口径解耦但 UI 无解释**：统计固定 14 天（History.tsx:31-32），列表默认近 7 天且随筛选变（History.tsx:343-350）。设计意图写在注释里（History.tsx:6-7「列表是查询视图，统计是画像」），但 UI 上唯一的线索是卡片标题「统计面板 · 近 14 天」（History.tsx:450）。用户把列表筛到近 3 天显示 5 条，抬头看统计「总命中 200」，两个数字的矛盾没有任何行内解释——会认为筛选没生效。这是该页最高频的困惑点。
2. **列表查询整屏闪 loading**：每次筛选/翻页/防抖触发，`setLoading(true)` 后整个列表区替换为「正在加载历史命中…」（History.tsx:377, 596-597），旧结果不保留。搜索框输入时每 300ms 闪一次。统计面板自己都做了「旧数据保留」（History.tsx:412-414 注释），列表却没做，两处标准不一致。
3. **分页只有上一页/下一页**（History.tsx:613-633）：无页码跳转、无每页条数选择。命中攒到几千条（60+ 页）时逐页翻不可用。
4. **列表查询失败与空态混淆**：`.catch(() => setResult({ total: 0, items: [] }))`（History.tsx:393-397）后显示「该条件下没有历史命中」（History.tsx:599-605）——IPC 坏了会被解读为"没数据"，排障方向被误导。
5. 关键词命中榜 20 条折叠后**无展开入口**（History.tsx:36 KEYWORD_RANK_LIMIT、History.tsx:303-305「另有 N 个未展示」只报数不给开关）；`byDay`（命中日分布）有数据但只显示天数（History.tsx:496-499），日趋势白白浪费。
6. 复刻 HitList 行渲染（History.tsx:86-199，文件头注释 History.tsx:10-12 解释了原因：HitList props 面向监控台不适配分页）——复刻过程中**文案已漂移**：静音状态 title，HitList 版「推送总开关关闭，或 Telegram 未配置」（HitList.tsx:35），History 版「推送总开关关闭，或无就绪通道」（History.tsx:105）。通道化改造（R6）后 HitList 版文案已过时，同一状态两种解释。

### 4.4 流水（Dispositions.tsx）

**结构**：outcome 五分组 chips（全部/推送结果/已拦截/未命中/挂起中，Dispositions.tsx:21-31）+ 来源下拉 + 日期（空=实时环 200 条 10s 自刷 / 有值=当日持久化文件）+ 行（时间/来源/标题/detail/14 类 outcome 徽标，Dispositions.tsx:36-66）。outcome 中文标签全覆盖且配色分级合理（成功绿/失败红/挂起琥珀/其余灰，Dispositions.tsx:54-66）。「该页回答为什么没推送」的产品价值在空态 hint 里讲清楚了（Dispositions.tsx:196-202）。

**问题**：

1. **加载失败静默置空**（Dispositions.tsx:89-92 catch 后 setItems([])），显示「还没有处置记录」空态（Dispositions.tsx:194-202）——同 History 问题 4，错误态与空态混淆。
2. **来源显示原始 id**：来源下拉与行内徽标直接用 `d.sourceId`（Dispositions.tsx:164-168, 207-209），显示「nodeseek」；而历史命中页同一字段经 `sourceLabel()` 显示「NodeSeek」（History.tsx:179-181, 554）。**同一个来源在两个查看页两种名字**。RoutingCard 的来源下拉同样用 raw id（RoutingCard.tsx:151-155）。
3. **实时视图 10s 自动刷新无暂停**（Dispositions.tsx:101-108）：只有切到历史日期才停。用户正在阅读或要点某行时列表整体重排（每次 load 全量替换 + reverse，Dispositions.tsx:87-88），行会移位。至少应在筛选激活或悬停时暂停，或给手动刷新优先。
4. 日期选择器从空 → 某日是单向跳转，「回实时」按钮只在选了日期后出现（Dispositions.tsx:180-184）——可接受，但「今天」选历史日时 card-count 显示「今天 · 历史文件」（Dispositions.tsx:139）措辞略拧巴（今天的数据在实时环里更全，文件是持久化侧）。

### 4.5 设置（Settings.tsx + 9 张功能卡）

**结构**：17 张卡单列（660px 窄栏，global.css:199-206），统一「卡头 + Field 行（148px 标签列 + 控件列 + hint 行）」网格（global.css:841-863），底部保存栏。**表单机制本身是对的**：draft/saved 双态、保存用 sanitize 回填、往返修正提示「已保存（部分值已按规则修正，如最低 15 秒）」（Settings.tsx:252-262）、测试三兄弟（测试消息/测试连接/匹配测试）统一「dirty 时先提示保存」约定（Settings.tsx:275-303, 305-330; MatchTestCard.tsx:52-58）、前端校验只提示不拦截且与主进程 sanitize 对齐（Settings.tsx:5-8）、卡内列表（来源/通道/规则）走 draft 即「保存后生效」并有 title 说明。

**问题**：

1. **17 张卡无页内导航，保存栏不吸底**：保存按钮在整个页面最底部（Settings.tsx:790-804；`.savebar` 无 sticky/固定，global.css:1310-1320）。在第一张「来源」卡改一个词，要滚过 16 张卡才能按保存。最高频任务（改关键词→保存）路径过长，且滚动过程中保存栏不可见、修改了什么没有全局摘要。
2. **无主动放弃修改入口、无 Cmd+S**：dirty 后想撤销全部改动，只能逐项改回；App.tsx 的 leavebar「放弃修改并切换」只在切 tab 时被动出现（App.tsx:162-178），且选了它就离开了设置页。保存栏里「保存设置」旁没有「放弃修改」按钮（Settings.tsx:790-804）。快捷键零绑定（无 Cmd+S、无 tab 切换）。
3. **保存后再修改，反馈文案矛盾**：saveMsg 显示「已保存 · 12:00:00」后，`patch()` 不清除它（Settings.tsx:189-191, 253-262）——用户改了一个关键词，按钮变回可点的「保存设置」，但旁边的文案仍说「已保存」。saveMsg 优先于 dirty 提示展示（Settings.tsx:799-803），用户以为改动已保存而离开，修改丢失（虽有 leavebar 二次拦截兜底，App.tsx:90-92）。
4. **路由规则顺序=优先级，却无排序控件**：hint 原话「顺序 = 优先级，需要调整优先级时删除重加」（RoutingCard.tsx:108-110）。20 条上限的路由规则重排成本是 O(n) 次删除+重加；且规则不可编辑（只有删除，RoutingCard.tsx:118-137），改一个目标通道也要删了重建。价格规则卡有「编辑」展开（RulesCard.tsx:129-137），路由卡没有——同页两种列表编辑模式不一致。
5. **嵌套滚动**：来源/通道/规则列表都套 `.card-scroll`（max-height 280px，global.css:266-269；SourceCard.tsx:151、ChannelsCard.tsx:340、RulesCard.tsx:109）——设置页本身是长滚动页，列表条目一多（20 条规则、10+ 来源）就形成滚动套滚动。
6. **getConfig 失败=永久 loading**：`.catch(() => {})`（Settings.tsx:176）后 draft 恒为 null，页面永远显示「正在加载配置…」（Settings.tsx:332-340），无重试。设置页是应用的控制中枢，这是最不该静默的地方。
7. DataCard 把**失败与取消同样弱化**：导出/导入 `r.ok === false` 时显示为 muted 灰字（DataCard.tsx:33, 56，注释说取消按 muted 处理，但真实错误也走同一路径），错误被弱化到与"你按了取消"同级。导入确认层的顺序也反常：先出确认文案再弹文件选择器（DataCard.tsx:91-119 → doImport 内才触发对话框，DataCard.tsx:42-46），「确认后将选择备份文件」（DataCard.tsx:94）用户需要二次理解。
8. KeywordTagInput **重复词静默忽略**（KeywordTagInput.tsx:29-35：exists 即 return，输入框照常清空）——用户输入已存在的词按回车，框空了、列表没变化、无任何提示，会误以为添加成功。IME 组合处理本身是亮点（KeywordTagInput.tsx:41-49）。
9. 「行为」卡名过于宽泛：里面是「推送总开关」+「开机自启」两个互不相关的开关（Settings.tsx:751-784）；「每日总结」的「补看历史」Field 是一句静态文案而非控件（Settings.tsx:654-656）——把说明伪装成了表单行。
10. RemoteControlCard 说「推送通道里配置的主 Chat ID 隐含允许」（RemoteControlCard.tsx:59-60），但通道化后可配**多个** telegram 通道（ChannelsCard 支持添加多条 telegram，ChannelsCard.tsx:125-130），"主"是哪条未定义——多通道用户的授权边界不可推断。

---

## 5. 横向主题

### 5.1 命名与导航

| 界面元素 | 名字 | 问题 |
|---|---|---|
| tab「流水」（App.tsx:141） | 页内叫「处置流水」（Dispositions.tsx:139） | 会计隐喻；价值（"为什么没推送"）只写在空态 hint（Dispositions.tsx:199） |
| tab「今日回顾」（App.tsx:123） | 页内叫「日报」（Reports.tsx:156） | 两套名字；且页面可看历史日期，名不符实（Reports.tsx:2-3） |
| 卡「行为」（Settings.tsx:753） | 推送总开关+开机自启 | 名字不指向内容 |
| 卡「相似降噪」（Settings.tsx:576） | 标题相似去重 | 音频隐喻，目标用户（VPS 圈）大概率可懂，但 aux「48 小时窗口」（Settings.tsx:577）未解释与轮询/免打扰等时间参数的关系 |
| 「匹配测试台」（Settings.tsx:397） | 只读诊断工具 | 命名 OK，但位置在配置流中间（§2） |

导航无键盘支持：tab 切换无快捷键（App.tsx 无 keydown 处理），列表无 PageUp/Down，全局无 Cmd+F/Cmd+K 类入口。侧栏 nav 有 `<nav>` landmark（App.tsx:110）但 active tab 无 `aria-current`（App.tsx:111-153 仅 class 区分）。

### 5.2 空 / 加载 / 错误状态

空态：统一 EmptyState 组件 + 三态区分做得好的场景（HitList.tsx:219-242、Reports.tsx:184-209、Dispositions.tsx:194-202 区分「无记录」vs「筛选后为空」、History.tsx:598-606 区分「无结果」vs「本页为空」）。

错误态：**系统性缺失**。全应用 8 个数据面里只有 2 个有错误态：

| 数据面 | 失败行为 | 证据 |
|---|---|---|
| History 统计 getStats | ✅ 错误文案+重试+旧数据保留 | History.tsx:411-426, 463-480 |
| AboutCard 更新检查 | ✅ error 态红字 | AboutCard.tsx:60-61 |
| Settings getConfig | ❌ 永久「正在加载配置…」 | Settings.tsx:176, 332-340 |
| Reports getDailyReport | ❌ 显示「该日没有日报」 | Reports.tsx:105-106, 207-209 |
| History queryHits | ❌ 显示「该条件下没有历史命中」 | History.tsx:393-397, 599-605 |
| Dispositions 两个数据面 | ❌ 显示「还没有处置记录」 | Dispositions.tsx:89-92, 196-202 |
| Reports listDailyReports | ❌ 静默，日期栏为空 | Reports.tsx:116 `.catch(() => {})` |
| History getConfig（来源下拉备料） | ❌ 静默，下拉只剩统计来源 | History.tsx:430-434 |

模式是统一的 `catch → 置空/静默`。对单机本地数据这多数时候无伤（文件就在本机），但一旦发生（磁盘/权限/升级残留），用户看到的是"没有数据"而非"读取失败"，排障方向被误导——且与本产品"可解释性"的定位直接相悖。

加载态：文字型（「正在加载…」）无骨架无进度，本地 IPC 快速返回时无伤；但 History 列表的整屏 loading 替换（§4.3 问题 2）在防抖场景反复触发。

### 5.3 表单与反馈

- 校验模式统一（前端提示不拦截 + 保存时 sanitize 修正 + 回填提示），轮询间隔/代理地址/摘要间隔三处同构（Settings.tsx:193-199, 663-698; NotifyCard.tsx:25-26, 60-84）——一致性好。
- 测试操作与 dirty 闸的约定统一且 hint 讲明原因（「测试消息使用的是已保存的配置」，Settings.tsx:279-282; MatchTestCard.tsx:53-57; ChannelsCard.tsx:441-444）。
- 反馈都是行内 `.feedback` 文字（无 toast 系统），成功带 ✓、失败带原因——对桌面工具是克制且合适的选择。
- 但反馈的生命周期管理有漏洞：saveMsg 不随后续修改清除（§4.5 问题 3）；Dashboard 的 feedback 只在 sendTest 设置，pause/resume/runNow 失败时**无任何反馈**（Dashboard.tsx:26-34：control() 无 catch 无结果反馈，engineControl reject 时 unhandled rejection，按钮转一圈 busy 就结束了）。
- 删除操作（规则/来源/通道/路由）均无确认（RulesCard.tsx:88-91、SourceCard.tsx:79-82、ChannelsCard.tsx:117-120、RoutingCard.tsx:130），靠「保存后才生效」的 draft 语义兜底 + title 说明。draft 语义成立时这是可接受的轻量化，但 UI 没有任何地方主动告诉用户「不保存即可丢弃删除」——撤销路径不可发现（见 §5.4）。

### 5.4 键盘与可达性

做得对：`:focus-visible` ring（global.css:42-45）；switch 用 `role="switch"` + `aria-checked`（Settings.tsx:484-489 等全部开关）；图标全 aria-hidden 由文本标签兜底（icons.tsx:33）；输入控件绝大多数有 aria-label（History.tsx:532-577、ChannelsCard.tsx:186 等）；KeywordTagInput 有 `role="group"` + aria-label（KeywordTagInput.tsx:52-56）；leavebar 有 `role="alert"`（App.tsx:163）。

缺口：

- **Field 的 label 与控件零关联**：Field 组件支持 `htmlFor`（Field.tsx:6）但全项目没有任何调用传入（grep 确认）——所有独立 input 的 label 点击不聚焦、屏幕阅读器不朗读关联。
- 筛选 chips / 分组按钮无 `aria-pressed`（Dispositions.tsx:145-155、History.tsx:559-569、RoutingCard.tsx:161-170 命中方式 checkbox 用了原生 checkbox 无碍）。
- 侧栏 active tab 无 `aria-current`（App.tsx:111-153）。
- 投票按钮无 aria-label，仅 emoji + title（HitList.tsx:184-199）。
- 无任何快捷键（保存/切页/搜索/刷新全部只靠鼠标）。

### 5.5 口径一致性

- 来源名两种（NodeSeek vs nodeseek，§4.4 问题 2）。
- 静音 title 文案两版（§4.3 问题 6）。
- 统计 14 天 vs 列表筛选（§4.3 问题 1）。
- 监控台命中行有投票、历史命中行没有（§4.1 问题 4）。
- 列表编辑模式两种：价格规则/来源/通道有「编辑」展开，路由规则只有删除（§4.5 问题 4）。
- HitList 的 PushState title 提到「Telegram 未配置」（HitList.tsx:35），但通道化后推送有四类通道——文案停留在单通道时代（History.tsx:105 的新表述「或无就绪通道」才是对的）。

### 5.6 数据密集场景

- **200 条无虚拟化**：HitList/Dispositions/LogView 各 200 条上限（useApi.ts:17-18、Dispositions.tsx:139）直接 map 渲染（HitList.tsx:244-267、Dispositions.tsx:204-225），每条 hit 插入触发全列表重渲染。React 19 下 200 行可接受，但配合 `hit-in` 200ms 入场动画（global.css:649-668）与无暂停跟随，高频命中时段的视觉噪音会叠加。
- History 服务端分页 50/页是正确选择，但翻页交互原始（§4.3 问题 3）。
- 关键词榜/日志/日报三个"长内容"场景各缺一手：榜无展开（§4.3 问题 5）、日志无筛选（§4.1 问题 3）、日报无历史入口（§4.2 问题 1）。
- 设置页三个内嵌列表的嵌套滚动（§4.5 问题 5）。
- 统计面板常驻列表上方占高（History.tsx:447-514 在列表卡之前）——翻页浏览时统计一直占首屏高度，两个 card-grow 争高度（History 页两个卡都是普通 card，列表 card-grow 依赖 flex 剩余空间，History.tsx:517；实际布局为统计卡自然高度 + 列表卡吃剩余，首屏可能整个被统计占满）。

### 5.7 值得保留的设计资产（重设计时应继承）

1. token 体系与双主题（theme.css 整体）。
2. LogView 跟随暂停（LogView.tsx:20-45）——可直接推广到 HitList。
3. EmptyState 三态模式（「从未」vs「本会话无」vs「筛选后无」的区分意识）。
4. dirty 守卫 + leavebar 的非路由拦截模式（App.tsx:84-96, 162-179）。
5. 测试操作统一走已保存配置 + dirty 闸的约定（Settings.tsx:275-330）。
6. 请求序号守卫（History.tsx:363-365 等）。
7. tone 体系用 CSS 自定义属性下发（global.css:330-347）。
8. IME 组合键处理（KeywordTagInput.tsx:41-49）。
9. 卡头 aux 徽标模式（card-title-aux，如「3/4 就绪」「确定性命中 · 优先于关键词」，ChannelsCard.tsx:327、RulesCard.tsx:97）——一眼摘要做在标题右侧，信息密度得当。
10. 状态优先级派生统一（desired > challenged > backoff > running，lib/status.ts:15-20 与托盘同口径）。

---

## 6. 问题清单（按 severity 排序）

severity 定义：high = 阻碍核心任务或造成误解；medium = 明显影响效率或理解；low = 打磨项。

| # | severity | 归属 | 问题 | 证据 |
|---|---|---|---|---|
| 1 | high | 全局 | 错误态系统性缺失：6/8 数据面失败被静默吞掉与空态混淆；设置页 getConfig 失败=永久 loading | §5.2 表格 |
| 2 | high | 设置 | 17 卡长表单无页内导航、保存栏不吸底、无放弃修改/快捷键 | Settings.tsx:342-806, 790-804; global.css:1310 |
| 3 | high | 全局 | 「流水」「今日回顾」tab 名不传达页面价值，与页内名不一致 | App.tsx:123, 141; Dispositions.tsx:139, 199; Reports.tsx:156 |
| 4 | high | 历史命中 | 统计(14天)与列表(默认7天)口径解耦无 UI 解释，数字互相矛盾 | History.tsx:31-32, 343, 450 |
| 5 | medium | 历史命中 | 列表查询整屏闪 loading、旧结果不保留；分页仅前后翻 | History.tsx:377, 596-597, 613-633 |
| 6 | medium | 监控台 | 挂起语义（不入已读/重启丢弃）藏在 hover title | Dashboard.tsx:66-73 |
| 7 | medium | 设置 | 保存后再修改，savebar 仍显示「已保存」 | Settings.tsx:253-262, 790-804 |
| 8 | medium | 设置 | 路由规则顺序=优先级却无排序/编辑，"删除重加" | RoutingCard.tsx:108-110, 118-137 |
| 9 | medium | 全局 | 来源显示名不一致（NodeSeek vs nodeseek），三处口径 | Dispositions.tsx:164-168, 207-209; History.tsx:554; RoutingCard.tsx:151-155 |
| 10 | medium | 全局 | Field label 无 htmlFor 关联；chips 无 aria-pressed；无任何快捷键 | Field.tsx:6; Dispositions.tsx:145-155; App.tsx（全文无 keydown） |
| 11 | medium | 流水 | 实时视图 10s 自动刷新无暂停，阅读时列表重排 | Dispositions.tsx:101-108, 87-88 |
| 12 | low | 全局 | HitList/History 复刻行渲染致文案漂移（静音 title 两版） | HitList.tsx:35 vs History.tsx:105 |
| 13 | low | 今日回顾 | 第 15 天前的日报无入口；markdown 行内语法原文显示 | Reports.tsx:149; Reports.tsx:29-88 |
| 14 | low | 设置 | DataCard 失败与取消同为 muted 灰字；标签输入重复词静默忽略 | DataCard.tsx:33, 56; KeywordTagInput.tsx:29-35 |
| 15 | low | 全局 | fs-28/20 阶未用，页面标题层级缺失、17 卡节奏全平；内联样式侵蚀 token | §3；grep 验证 |

---

## 7. 对重设计的输入建议（一句话版）

1. 错误态作为一等公民：所有数据面统一「失败 ≠ 空」的展示与重试模式（History 统计面板 History.tsx:463-480 已有现成范本）。
2. 设置页拆分或加锚点导航 + 吸底保存栏 + 「放弃修改」+ Cmd+S。
3. tab 改名：「流水」→ 突出"为什么没推送"的语义（如「去向/处置」），「今日回顾」→「日报」对齐页内名。
4. 统计面板与列表要么同口径联动、要么在两处都标注窗口差异。
5. 保留 §5.7 列出的全部资产。
