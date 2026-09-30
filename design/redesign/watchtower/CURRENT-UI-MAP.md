# ForumWatch 渲染层现状盘点与迁移地图（CURRENT-UI-MAP）

> 定位：本次「watchtower」迁移的**代码侧唯一依据**。只描述仓库现状（2026-09-30，main @ 069a64c 工作区），不改代码、不改规范。
> 证据口径：全部结论来自本 session 对 `src/renderer/src/` 全量文件（css/ts/tsx）与 `design/redesign/` 上一轮材料的**通读与 grep 实测**，引用一律带 `path:line`；grep 结果注明命令意图。未运行 typecheck/test/build（工作纪律：验收阶段统一跑）。
> 输入材料：`design/redesign/REDESIGN.md`（R10 总稿，绿牌时代）与 `design/redesign/screens/{dashboard,dispositions,history,reports,settings}.md`（五屏详稿，同代）。**注意：REDESIGN §3 的绿色 token 总表已被代码里的 R12「霁蓝平台」azure 体系整体取代**（`src/renderer/src/theme.css:1-40` 头注释是现行裁决链的末端）；本轮迁移以 theme.css 现值为准，REDESIGN/screens 只作历史语义参考（zone 划分、交互契约、文案仍然有效）。
> 同目录 `concept.html` 为本轮新方向概念稿（深色瞭望塔控制台、衬线标题走系统字体栈），不在本盘点范围内，仅作对照。

---

## 0. 渲染层总览

技术形态：Electron + React + 手写 CSS，零框架、零图标库、零网络字体。样式经 `src/renderer/src/global.css` 顺序 `@import`（`global.css:6-14`）：

```
theme.css → styles/base.css → styles/primitives.css → styles/shell.css
→ styles/settings-core.css → styles/dashboard.css → styles/events.css
→ styles/settings-monitor.css → styles/settings-notify.css
```

**引入顺序是语义的一部分**（同特指度时后者胜）：
- `events.css` 在 `dashboard.css` 之后 → `.page-history .metric .v` 才能盖过共享面 32 档复写（`events.css:1079-1094`）；`.disp-row-main.row-selected` 的背景重述同理（`events.css:803-809`）。
- `settings-notify.css` 最后引入，其头注释明示「同名规则以本文件为准」（`settings-notify.css:6`）。
- `.report-tabs .btn`（2 类特指度）盖过 `.quick .btn`（同为 2 类）靠的就是 events 在 primitives 之后（`events.css:51-55` vs `primitives.css:635-640`）。**拆出 styles/reports.css 时必须保持「在 primitives.css 之后」**。

文件体量（`wc -l` 实测）：

| 文件 | 行数 | 角色 |
|---|---|---|
| `theme.css` | 286 | 令牌唯一来源（含停用的暗色块与旧名别名层） |
| `styles/base.css` | 106 | reset / 全局焦点环 / 滚动条 / fade-in / `.num` |
| `styles/primitives.css` | 985 | 共享组件层 |
| `styles/shell.css` | 193 | 应用外壳（侧栏/内容列/.page） |
| `styles/settings-core.css` | 306 | 设置页骨架 + 吸底保存栏 |
| `styles/dashboard.css` | 897 | 监控台域 + 多页共享面 |
| `styles/events.css` | 1398 | **去向 + 历史命中 + 日报三页混载**（本次拆分对象） |
| `styles/settings-monitor.css` | 229 | 设置·监控/匹配域卡 |
| `styles/settings-notify.css` | 209 | 设置·通知/网络/数据域卡 |

页面：`pages/Dashboard.tsx`(183) / `Dispositions.tsx`(842) / `History.tsx`(972) / `Reports.tsx`(1053) / `Settings.tsx`(956)；外壳 `App.tsx`(228)；入口 `main.tsx`（web-shim 首帧前安装，`main.tsx:8-10`）。

---

## 1. 样式所有权地图

### 1.1 各 css 文件 → 页面/组件归属总表

| css 文件 | 管什么 | 使用点（grep 实测） |
|---|---|---|
| `theme.css` | 纯令牌，无组件规则（唯一例外 `:root{color-scheme:light}`，`theme.css:50`） | 全部文件经 `var(--*)` 引用（计数：dashboard 254 处、events 404、primitives 268、shell 48、settings-core 81、settings-monitor 57、settings-notify 56、base 10） |
| `base.css` | `*{box-sizing}`、body 排版（`fs-13`/`tnum`/`user-select:none`）、`:focus-visible` 全局环（`base.css:40-47`）、滚动条三态（`:49-62`）、`.sr-only`、`prefers-reduced-motion` 全局熔断（`:79-87`）、`@keyframes fade-in` 共享唯一定义（`:93-100`）、`.num` mono hook（`:104-106`） | 全部页面 |
| `shell.css` | `.app/.sidebar/.brand/.nav/.nav-btn/.nav-sep/.dirty-dot/.sidebar-foot`（含轨内 tone 覆盖 `.sidebar .tone-*`，`:151-163`）、`.content/.page-host/[hidden]/.page`（内容限宽 `--content-max` 算式，`:187-193`） | 仅 `App.tsx` |
| `primitives.css` | 组头（`.group-head/.group-sub`）、L2 实体行族（`.entity-list/.entity-row/.ent-*`）、选中行规范类 `.row-selected`（`:142-148`）、待删除 `.entity-row.del/.badge-del`、卡族（`.card/.card-head/.card-title/.card-grow/.empty`）、空态（`.empty-state*`）、按钮族（`.btn/.btn-primary/.btn-danger/.busy`）、`.actions/.feedback/.feedback-retry`、chip 族（`.chips/.chip/.src-badge`）、表单（`.field/.field-label/.field-hint/.input/.input-row/.quick/.radios/.radio`）、单选卡组 `.radios-card`（跨域唯一定义，`:686-732`）、`.notice`、开关 `.switch`、标签输入 `.tags/.tag`、页头（`.pagehead/.page-title 26/700/.page-subtitle/.page-updated`）、错误条 `.errorbar/.errorbar-detail` | 所有页面与设置卡 |
| `settings-core.css` | 设置页三区骨架（`.page-settings/.settings-nav/.snav-*/.settings-scroll/.settings-col/.settings-group/.set-slot/.set-flash`）、`.page-settings .field-label/.input` 字段档、`.warn-strip`、骨架 `.settings-loading/.set-skel/.skel`、整页错误 `.settings-error*`、`.leavebar`、吸底保存栏 `.savebar/.sb-status/.sb-confirm`、实底 danger `.btn-danger-solid` | 仅 `pages/Settings.tsx` + 设置卡 |
| `dashboard.css` | 监控台域（`.page-dashboard/.statuscard-head/.state-pill/.dot/.metrics/.metric/.substatus/.subblock*/.src-row/.src-*/.ai-*/.pending-*/.subactions/.lasterr/.hit 全族/.hit-title/.hit-how/.how-badge/.ai-reason/.commentary/.push/button.push-fail/.vote-*/.live-pill/.live-dot/.logview/.log-line/.log-toolbar/.log-chips/.log-chip/.lvl-dot/.log-follow/.follow-dot/.log-copy`）——**同时含跨页共享面**，见 1.3 | Dashboard 页 + History/Dispositions/设置卡借用 |
| `events.css` | 三页混载：日报（待拆）+ 去向 + 历史，详见 1.2 | Reports / ReportDoc / Dispositions / DispositionRow / History / Pager / StatSparkbar / LiveBadge |
| `settings-monitor.css` | `.smon` 域根下的实体行锚定、`.smon-empty`、滑杆 `.input-range`、`.stack-y`、匹配测试台 `.mt-verdict/.mt-stage/.mt-mark/.mt-stage-label/.mt-detail/.mt-running/.mt-skel` | SourceCard/RulesCard/KeywordsCard/MatchModeCard/MatchTestCard/SimilarityCard/RunPaceCard/CategoryReportCard（均挂 `card smon`） |
| `settings-notify.css` | `.aux-dot`、密码显隐 `.pw-wrap/.pw-toggle`、`.radio-tight`、通道行 `.ch-list/.ch-state`、路由序号 `.rule-idx`、操作反馈位 `.op-feedback`、行内确认 `.inline-confirm*`、遥控指令 `.cmd-list/.cmd`、关于卡 `.about-logo` | NotifyCard/ChannelsCard/RoutingCard/ProxyCard/AiModelCard/RemoteControlCard/DataCard/AboutCard（均挂 `card snot`） |

### 1.2 events.css 逐段归属（机械拆分 `styles/reports.css` 的逐条清单）

events.css 头注释自述「去向 / 历史命中 / 日报三页」（`events.css:1`）。按行区间与选择器逐条判定（「随迁」= 移入 reports.css；「留」= 留在 events.css；「升共享」建议但非本次必做）：

**A. 日报页段（L18–561）——除注明外全部随迁：**

| 行区间 | 选择器 | 判定 |
|---|---|---|
| 20–31 | `.page-reports`（两列 grid + 三行轨） | 随迁 |
| 35–38 | `.page-reports .pagehead`（grid 锚定） | 随迁 |
| 41–50 | `.report-tabs`（档位 tab 浮条，R17） | 随迁 |
| 51–55 | `.report-tabs .btn`（回 md 档，**依赖在 primitives 之后引入**） | 随迁（保持 import 顺序约束） |
| 57–61 | `.report-rail-empty` | 随迁 |
| 65–75 | `.report-rail`（raised 浮条） | 随迁 |
| 76–81 | `.report-rail-title` | 随迁 |
| 83–85 | `.report-rail > .errorbar`（日期栏错误条边距） | 随迁 |
| 87–94 | `.report-rail-list` | 随迁 |
| 96–159 | `.report-date` 全族（含 `.label/.sub/:hover/:active/.active×3/.noreport`） | 随迁（类名是键盘 roving 的行为契约，见 §4.2） |
| 160–166 | `.report-rail-sep` | 随迁 |
| 167–170 | `.report-rail-more` | 随迁 |
| 171–187 | `.report-rail-jump`（含 svg / .input） | 随迁 |
| 191–195 | `.report-card` | 随迁 |
| 196–215 | `.report-head/.report-head-main` | 随迁 |
| 216–221 | `.report-title-row` | 随迁 |
| 223–230 | `.report-title`（**22/700 display 位**） | 随迁 |
| 231–238 | `.report-busy` + svg（引 `btn-spin` keyframes，定义在 primitives.css:376-380） | 随迁（keyframes 跨文件可用，记依赖） |
| 239–251 | `.report-summary` + `.muted` | 随迁 |
| 252–273 | `.report-meta` + `button.report-meta` + hover | 随迁 |
| 274–280 | `.report-actions` | 随迁 |
| 283–298 | `.report-confirm` + `.esc-hint` | 随迁 |
| 302–329 | `.report-newver` + hover/active | 随迁 |
| 332–346 | `.report-feedback` + svg + `.btn` | 随迁 |
| 350–359 | `.report-body` + `.report-body > .empty` | 随迁 |
| 363–369 | `.doc`（正文列 640px / lh-read） | 随迁（仅 ReportDoc 用） |
| 371–387 | `.doc-h2`（+first-of-type）/ `.doc-h3` | 随迁 |
| 389–412 | `.doc-p` / `.doc-list`（+li/+::marker） | 随迁 |
| 413–416 | `.doc strong` | 随迁 |
| 418–425 | `.doc-code` | 随迁 |
| 428–450 | `.doc-link-wrap/.doc-link(+hover)/.doc-link-hint` | 随迁 |
| 452–462 | `.doc-note` + ::before | 随迁 |
| 464–496 | `.tpl-row/.tpl-time/.tpl-cat/.tpl-title/.tpl-how/.tpl-remark` | 随迁（仅 ReportDoc 用） |
| 498–535 | `.doc-chips/.doc-chip(+hover/+active)` | 随迁 |
| 537–552 | `.doc-trunc` + `.doc-trunc .disp-link` | 随迁（**复合选择器整体随迁**：`.disp-link` 本体留 events，此规则以 `.doc-trunc` 为上下文，随迁后语义不变） |
| 554–561 | `.cv-block/.cv-block-list` | 随迁（仅 ReportDoc 用） |

**B. 窄窗断点块（L564–603）——三域混装，须拆三条：**

| 行 | 选择器 | 判定 |
|---|---|---|
| 565–567 | `.substatus` 单列折行 | **dashboard 域类**（dashboard.css:169 定义），规则物理上落在 events.css——拆分时迁回 dashboard.css 或独立共享断点段（dashboard.css:167-168 注释已承认此错位：「720px 档见 events.css 对 .substatus 的既有媒体查询」） |
| 568–571 | `.chart-row,.rank-cols` 单列 | 留 events（历史页） |
| 572–602 | `.page-reports/.report-tabs/.report-rail/.report-rail-title/.report-rail-sep/.report-rail-list/.report-rail-jump/.report-date` | 随迁 reports.css（保留为一个独立 `@media (max-width:720px)` 块） |

**C. LiveBadge（L605–647）**：`.livebadge` 全族（live/paused/disk/asof）。组件 `components/LiveBadge.tsx`，**当前唯一使用点是去向页**（`pages/Dispositions.tsx:650`，grep 实测）。判定：**留 events.css**（或升共享层），不进 reports.css。

**D. 去向页段（L649–1033）——全部留 events.css：**
`.page-dispositions`(654)、`.card-disp-list`(661)、`.disp-scroll`(668)、工具条 `.tb-row`(676)/`.tb-count`(682)/`.search-box`(689–706)/`.disp-source`(708)/`.disp-date`(712)/`.disp-loading`(720)、`.disp-strip`(732)、`.notebar`(741)、`.day-sep`(760)、判定行 `.disp-row` 全族(775–821，含 `hit-in` keyframes 依赖——定义在 dashboard.css:403-412)、`.d-time/.d-title/.d-detail`(814–839)、`.outcome` 全族(842–874)、展开 `.disp-expand/.ex-*/.ex-track/.track-*/.ex-actions`(878–980)、深链 `.disp-link` 全族(983–1006，**三页共用：DispositionRow/History/ReportDoc**，grep 实测)、`disp-flash`(1008–1018)、`.load-more-bar`(1021–1033)。

**E. 历史命中页段（L1035–1380）——全部留 events.css：**
`.page-history`(1040)、`.stat-detail-toggle`(1050–1077)、`.page-history .metrics/.metric/.metric .v`(1083–1094，32/700 复写)、`.chart-row/.chart-block/.cb-title`(1097–1111)、sparkbar 全族(1118–1166)、`.stackbar/.stack-seg/.legend/.lg-dot`(1169–1212)、`.stats-detail`(1216)、`.rank-cols/.rank-list/.rank-item/.rk-*/.rank-more`(1223–1266)、`.zero-row/.zero-chip/.zero-row .disp-link`(1269–1293)、`.filter-bar`(1297)、`.card-grow > .errorbar`(1307，**注意也作用于日报卡**，见 F)、`.busy-ind/.list-dim`(1314–1329，**list-dim 同时被 Reports.tsx:627/1008 使用**)、分页 `.pager` 全族(1332–1373)、`.empty-state-actions`(1376–1380，仅 History.tsx:623 用)。

**F. 日报页在 events.css 之外还消费的规则（拆分时的隐藏耦合，必须处理）：**

| 规则 | 位置 | 为什么作用于日报页 |
|---|---|---|
| `.card-grow > .errorbar` 边距 | `events.css:1307-1310` | 日报卡挂 `card card-grow report-card`（`Reports.tsx:503`），错误条是其直接子级（`Reports.tsx:595-601`）——历史段规则实际服务两页。拆分时留 events 即可（reports.css 与 events.css 同时在载），但**不得误删** |
| `.list-dim`（旧数据压暗） | `events.css:1326-1329` | `Reports.tsx:627/1008` 给 `.report-body` 挂 `list-dim`。留 events（或升共享） |
| `.disp-loading`（首载文字型加载） | `events.css:720-728` | `Reports.tsx:668/1040` 使用。留 events（或升共享） |
| `.quick`（tab 行外壳） | `primitives.css:632-647` | `Reports.tsx:114` 挂 `quick report-tabs`。本就在共享层，无需动 |
| `.feedback` 三态色 | `primitives.css:436-464` | `Reports.tsx:573-583/606` 挂 `report-feedback feedback …`。共享层，无需动 |
| `@keyframes hit-in` / `btn-spin` / `fade-in` | dashboard.css:403 / primitives.css:376 / base.css:93 | events 域 `.disp-row` 引 `hit-in`（跨域依赖已存在）；reports 段引 `btn-spin`（`.report-busy svg`）与 `fade-in`（`.report-confirm/.report-newver`）。keyframes 全局可见，拆分无阻断，但 reports.css 头注释应记录依赖 |
| 暗域护栏块 | `events.css:1392-1398` | 三条选择器 `.tpl-cat/.doc-chip:hover/.report-newver:hover` **全为日报域**——随迁 reports.css（连同 1382–1391 的算式注释一起搬，恢复双主题时要用） |

### 1.3 跨文件共享/借用类清单（所有权≠使用权的错位点）

- **dashboard.css 是「监控台域 + 共享面」双角色**（头注释 `dashboard.css:5-9` 自认）：`.metrics/.metric`（History Z1 复用）、`.hit/.hit time/.hit-title/.hit-how/.how-badge`（HitRow，被 Dashboard 与 History 两页用）、`.log-chips/.log-chip`（LogView + History/Dispositions 筛选 chips）、`.live-pill/.live-dot`（HitList + Dispositions 并入角标 `Dispositions.tsx:558-573`）、`.ex-actions .btn.ok/.err` 复制反馈（`dashboard.css:888-897`，服务 DispositionRow）、`.src-empty`（StatusCard + History + **RoutingCard 设置卡**）、`.src-dot`（StatusCard + **ChannelsCard 设置卡**）、`.tone-*` 自定义属性族（StatusCard + ChannelsCard + App 侧栏底经 shell 覆盖）。
- events.css 内的跨页共享：`.disp-link`（去向定义，三页用）、`.tb-row/.search-box/.filter-bar/.busy-ind/.list-dim/.disp-loading`（去向+历史±日报）、`.log-chip`（与 dashboard 共享）、`.livebadge`（组件级，仅去向用）。
- primitives.css 里的设置专属件：`.entity-*` 实体行族、`.tags/.tag`、`.field` 族、`.radios-card`——定义在共享层但使用点全在设置卡（EntityList/KeywordTagInput/Field 均设置域组件，grep 实测 import 图见 §2）。

---

## 2. 组件归属（对齐四域：监控台 / 事件=历史+去向 / 日报 / 设置）

### 2.1 跨页共用（迁移时动一处影响多页）

| 组件 | 使用点（grep import 实测） | 样式位置 |
|---|---|---|
| `PageHeader.tsx` | 全部五页 | primitives.css `.pagehead*`（页题 26/700 display 位 `primitives.css:921-929`） |
| `EmptyState.tsx` | HitList / LogView / History / Dispositions / Reports | primitives.css `.empty-state*`；插画 `IllustrationRadar`（icons） |
| `ErrorBar.tsx` | HitList / LogView / StatusCard / History / Dispositions / Reports | primitives.css `.errorbar/.errorbar-detail` + 卡内边距规则（primitives.css:267-270、events.css:83/1307） |
| `icons.tsx` | 全部（30 个导出：Icon*×29 + IllustrationRadar） | 无独立 css；`currentColor`；尺寸档 12/14/16/20/44/8（`icons.tsx:5-13`）；**唯一旧名引用点 `var(--accent)`**（`icons.tsx:119`，IconRadar 信号点） |
| `HitRow.tsx` | HitList（监控台）+ History（事件） | dashboard.css `.hit*` 族 + primitives `.chip/.src-badge/.row-selected` |
| `hooks/useApi.ts` | App（唯一数据源，向下传 Dashboard） | — |
| `hooks/useNow.ts` | PageHeader + Dashboard | — |
| `lib/status.ts / time.ts / presets.ts / open-external.ts` | 各页 | — |

### 2.2 各域专属

**监控台**：`StatusCard.tsx`（317 行；state-pill/四格/子块/挂起行/最近错误）、`HitList.tsx`（246）、`LogView.tsx`（189）——样式全在 dashboard.css。键盘 roving 依赖 `[data-hit-index]`（HitRow.tsx:267）与 `data-vote`（:221/:231）。

**事件 = 去向 + 历史**：
- 去向：`DispositionRow.tsx`（286；`.disp-row/.outcome/.ex-*/.track-*`，roving 依赖 `[data-disp-index]` `DispositionRow.tsx:197`）、`LiveBadge.tsx`（30，当前仅去向用）。
- 历史：`Pager.tsx`（118）、`StatSparkbar.tsx`（63）。
- 两页同构的列表语言（`.tb-row/.filter-bar/.busy-ind` 等）在 events.css 共享（§1.2 D/E）。

**日报**：`ReportDoc.tsx`（373；`parseInline/parseReport` 纯函数 + 渲染器，`.doc-*/.tpl-*`）。`Reports.tsx` 内含 HitsReportPane 与 CategoryReportPane（R17 分类档）两个 pane，共用 `.report-*` 全套。

**设置**：骨架件 `SettingsNav.tsx / SettingsSavebar.tsx / SettingsErrorState.tsx / GroupHeader.tsx / Field.tsx / EntityList.tsx / KeywordTagInput.tsx`；域卡（`card smon`）：`SourceCard`(602)/`RulesCard`(316)/`KeywordsCard`(62)/`MatchModeCard`(130)/`MatchTestCard`(229)/`SimilarityCard`(68)/`RunPaceCard`(112)/`CategoryReportCard`(195)；域卡（`card snot`）：`ChannelsCard`(524)/`NotifyCard`(172)/`RoutingCard`(493)/`AiModelCard`(191)/`ProxyCard`(81)/`RemoteControlCard`(91)/`DataCard`(203)/`AboutCard`(134)。

### 2.3 死类 / 无样式标记类盘点（grep 实测，css 全库无定义）

| 类名 | 使用点 | 判定 |
|---|---|---|
| `refreshing` | `History.tsx:675`、`Dispositions.tsx:672`（刷新按钮条件类） | **死类**：无任何 CSS 规则（grep `\.refreshing` 于 styles/*.css 零命中），挂了不生效 |
| `.hit-mark` | `dashboard.css:460-465` 定义 | **死 CSS**：tsx 零使用（注释称属匹配测试台，MatchTestCard 现用 `.mt-mark`） |
| `snot` | 8 张通知域卡根（如 `NotifyCard.tsx:34`） | 无样式标记类（对照 `.smon` 有 3 条规则，settings-monitor.css:30-35/59）——迁移时可作域作用域钩子保留或统一命名 |
| `statuscard` | `StatusCard.tsx` 根（`card statuscard`） | 无样式标记类（仅 `.statuscard-head` 有规则，dashboard.css:43） |
| `field-control` | `Field.tsx:12` | 无样式标记类（.field 的 grid 第二列，无需规则） |

---

## 3. 令牌与排版纪律摘要（现行有效版）

全部定义在 `theme.css:48-187`（浅色）+ 停用暗色块（190-256）+ 别名层（259-287）。

- **字阶**（10 档，`--fs-12..32`）：12（辅助元信息，禁正文）/13（次级正文·按钮）/14（正文）/16（组头·state-pill）/20/22（日报日题）/24/26（页题）/28/32（KPI）。**实测引用数：fs-12×97、fs-13×24、fs-14×14、fs-16×5、fs-22×1、fs-26×1、fs-32×2；fs-20/fs-24/fs-28 为零引用保留档**（theme.css:128-135 注释口径一致）。零裸 px 字号（grep `font-size: [0-9]` 于 styles/ 零命中）。
- **三个 display 位**（700 字重仅授权处，grep `font-weight: 700` 恰 4 处 = 3 位 + 1 复写）：
  1. 页题 26/700——`.page-title`（primitives.css:921-929）
  2. 日报日题 22/700——`.report-title`（events.css:223-230）
  3. KPI 32/700 mono——`.metric .v`（dashboard.css:146-159）+ 历史页上下文复写 `.page-history .metric .v`（events.css:1089-1094，对共享面漂移免疫）
- **字重纪律**：只用 400/500/600/700（实测分布：400×4、500×13、600×24、700×4；无 650 等杂档）。
- **行高选档**：`--lh-display 1.2`（22/26/32）/`--lh-tight 1.3`/`--lh-base 1.5`/`--lh-read 1.7`（成段阅读，日报 `.doc` 专属场景 events.css:361-369）/`--lh-chip 18px`（绑 fs-12 徽标）。字距：`--ls-display -0.015em` 仅 ≥20px 标题与数字；`--ls-label 0.05em` 仅拉丁/数字 12px micro-label（中文正文禁加）。
- **间距阶**：`--space-xs 2 / sm 4 / md 8 / lg 12 / xl 16 / 2xl 24 / 3xl 32 / 4xl 48`。
- **圆角三档**：`--r-card 16`（卡/浮层）、`--r-ctl 12`（按钮/输入/实体行/nav pill）、`--r-pill 999`。
- **阴影四档 + 特殊**：`--shadow-sm/md/lg/xl`（低透明度大扩散双层）、`--edge-top`（顶缘发丝光，events.css:74 仍在引）、`--inset-field`（输入内凹）。
- **动效**：`--t-fast 120 / --t-base 200 / --t-glide 280` + `--ease-out / --ease-std`；全局 `prefers-reduced-motion` 熔断（base.css:79-87）；无无限循环装饰动画（busy 转圈属进度指示豁免，primitives.css:375-391）。
- **排版红线**：全局 `tnum`（base.css:24）+ `.num` mono hook（base.css:104）；数字/时间戳 mono（约 38 处组件在引）；`user-select:none` 全局、输入/日志/命中标题放开（base.css:26-35）。
- **对比度纪律**（theme.css 头注释，10-12 行）：文字 ≥4.5:1、图形/UI ≥3:1，全部色对注释内附实算值；wash 底文字收口规则（R12.6）：品牌 wash 上最低 `--text-2`，禁 `--text-3`（primitives.css:136-141 就地 remap 实现之一）。
- **内容限宽与命中区**：`--content-max 1200px`（shell `.page` 算式引用）；`--hit 44px` 可点目标红线（nav/日期行/投票钮/track-item 等在引）。
- **数据变量（非 token，tsx→css 契约）**：`--h`（sparkbar 柱高，StatSparkbar）、`--w`（stack-seg/rk-bar 宽，History.tsx `BarVars`）、`--tone/--tone-bg/--tone-text`（tone 族下发，dashboard.css:58-78）、`--track-tone`（track-item）。

### 3.1 旧名别名层现状（theme.css:259-287）

别名层仍定义 22 个旧名（`--text/--accent/--on-accent/--border/--chip-bg/--shadow/--space-1..6/--radius-s/m/l/--bg-sidebar` 等）。**grep 实测：全部 CSS 文件对旧名的引用为零**（逐一 `var(--旧名)` 精确匹配，含 `--accent-hover/--border/--shadow` 边界名）；**唯一存活引用是 `var(--accent)`，在 `icons.tsx:119`（IconRadar 信号点 fill）**。`--fs-15` 已删且无悬空引用（theme.css:31）。→ 迁移时把 icons.tsx 这一处改指 `--color-primary` 后，别名层整体可删。

---

## 4. 主题机制现状（R12.7 固定浅色）

**现状**：应用恒浅色交付。三处暗色块被「恒假媒体查询」停用——`@media (prefers-color-scheme: dark) and (max-width: 0px)`（无窗口宽度可为 0，永不匹配）：

1. `theme.css:190-256`：暗档 token 全量（表面/轨/tone/阴影终值**全部保留**，头注释明示「勿删」，`theme.css:188-189`）
2. `dashboard.css:852-859`：`.log-chip.on` 选中深底反转上的 lvl-dot 压暗补偿
3. `events.css:1392-1398`：wash 底强调文字提亮护栏（`.tpl-cat/.doc-chip:hover/.report-newver:hover`）

配合 `:root { color-scheme: light }`（`theme.css:50`）钉死原生控件方向。

**恢复「双主题 + 跟随系统」需要动的点**（theme.css:3-5 头注释给出的官方清单 + 本 session 核实的连带项）：

| # | 动作 | 位置 |
|---|---|---|
| 1 | 三处 `and (max-width: 0px)` 删除，恢复纯 `@media (prefers-color-scheme: dark)` | theme.css:190 / dashboard.css:852 / events.css:1392（拆分后随迁 reports.css） |
| 2 | `:root` 的 `color-scheme: light` 改为随主题（两块各声明 `light`/`dark`，或 `light dark`）——**原生控件（单选/滚动条/日期输入/select）自动跟随** | theme.css:48-50 |
| 3 | 原生控件显式品牌档复核：`.radio input`/`.input-range` 的 `accent-color: var(--color-primary)`（primitives.css:663 / settings-monitor.css:71）——暗档 `--color-primary #6BA8F5` 已有值，无需改但需目检 |
| 4 | 焦点环：全局 `:focus-visible` 走 `var(--ring)`（base.css:40-47），暗档 `#7FB2F8` 已备（theme.css:204）——机制无需改，验收时目检 |
| 5 | 滚动条：`--scroll-thumb` 暗档 `#3A465A` 已备（theme.css:205；base.css:49-62 使用）——无需改 |
| 6 | **复测两处停用前的陈旧算式**：events.css:1382-1390 护栏注释的对比度是按旧 14% 暗 wash 与旧 `--primary-text #6BA8F5` 实算的；R12.6 已把暗 wash 收到 12%、primary-text 提到 `#8FBEF9`（theme.css:224-228）——恢复暗色时该护栏块的三条规则是否仍必要/数值是否仍准，需重算，不能照抄注释 |
| 7 | 若 watchtower 方向要**手动切换**（concept.html 是 `color-scheme:dark` 深色优先）：媒体查询方案只支持「跟随系统」；手动切换需改类/属性开关（如 `:root[data-theme]`）并让 `color-scheme` 随之翻转 + 持久化偏好（localStorage 或配置）——这是产品决策点，不是纯代码动作 |

---

## 5. 测试与约束红线

### 5.1 测试现状（vitest，`environment: 'node'`，`vitest.config.ts`）

渲染层仅两个测试文件：
- `components/ReportDoc.test.ts`（209 行）：**只测纯函数** `parseInline`/`parseReport` 的 token/块树形状（「宽松解析永不吞内容」红线在函数层断言，文件头注释明示「渲染层无 DOM 测试环境」）。**它不断言 DOM 结构或类名**——类名/结构改动不会碰红它；但 `parseReport` 的产物形状（`promotedTitle/blocks/groups/mode/hitCount/hitsSummary/truncated`）被 Reports.tsx 卡头消费（`Reports.tsx:184-187/404-422`），改解析契约会连带页面。
- `lib/presets.test.ts`：来源预设形状，与 UI 无关。

**grep `className` 于全部 `*.test.ts`：零命中。无 e2e；`tests/` 目录在 vitest include 里但不存在。** 结论：DOM/类名的真正红线不在测试，而在下面 5.2 的运行时选择器。

### 5.2 类名是行为契约：运行时 querySelector 清单（改名前必查）

| 选择器 | 位置 | 用途 |
|---|---|---|
| `button.report-date` / `.report-date.active` | `Reports.tsx:363` / `:289` | 日期栏 roving 焦点移动 / 确认条关闭后焦点归还 |
| `.doc-trunc` | `Reports.tsx:309` | 「可能不完整」→ 滚到截断提示行 |
| `[data-group="N"]` | `ReportDoc.tsx:338` | 分组 chip 平滑定位 |
| `[data-hit-index]` / `data-vote` / `.hit-title` | `HitList.tsx:108/116/135/138`、`History.tsx:524/532/547`、`HitRow.tsx:221/231/267` | 命中列表 roving / Enter 代点 |
| `[data-disp-index]` / `.disp-row-main` | `Dispositions.tsx:424/442/504`、`DispositionRow.tsx:197` | 判定列表 roving / 展开去重 |
| `.log-chip` | `LogView.tsx:88` | L 键聚焦日志筛选 chips 的 DOM 序 |
| `.savebar .sb-confirm` / `.page-settings` | `DataCard.tsx:42-43`、`EntityList.tsx:75-76` | 行内确认互斥（同屏只开一个） |
| `.settings-group` | `Settings.tsx:702` | scrollspy 组识别 |

### 5.3 web 无头模式（lib/web-shim.ts）对 renderer 的约束

- **同一构建产物双环境直跑**：浏览器无 preload 时 `main.tsx` 首帧前安装 HTTP+SSE 版 `window.api`（`web-shim.ts:287-297`）。→ **渲染层只能依赖 `window.api`（DesktopApi 形状）与标准 Web API**，禁 import Electron/Node 模块；新样式必须兼容纯 Chromium（`color-mix()`、`:has()` 已在用，Electron 与浏览器均可，但别引入 Electron-only 特性）。
- 事件面走单条 EventSource（断线自重连）；「永不 reject」通道在 web 侧有 fallback 兜底（`web-shim.ts:169-181`）——**UI 不得假设 invoke 一定 reject 或一定 resolve**，错误条/空态语义两环境一致。
- 认证 401 会触发 `window.prompt`（`web-shim.ts:64`）；令牌存 localStorage。备份导出走 Blob 下载、导入走隐藏 file input——**不要给这些路径换成 Electron 专属交互**。
- `navigator.clipboard`（Reports 复制全文，`Reports.tsx:346`）在非安全上下文可能不可用——已有 catch 降级为「复制失败」反馈，勿移除。
- CSP（`index.html:8-11`）：`default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:`——**零网络字体/图标红线有 CSP 兜底**；watchtower 的衬线标题只能用系统字体栈（concept.html 的 `"Noto Serif SC","Songti SC","STSong","Source Han Serif SC","SimSun",serif` 即先例，需新增 `--font-display` 类令牌承载）。
- `useNow` 的挂机降负依赖 `document.hidden`（useNow.ts:17-24）——keep-alive 页级隐藏由 `active` prop 传入，迁移时保持该协议（App.tsx:185-224 五个 page-host 的 hidden 切换）。

---

## 6. 风险清单与建议

### 6.1 events.css 拆分的边界判定标准（本次迁移的核心机械规则）

按优先级依次判，全部以 **grep 使用点**为准（本 session 已跑，结论在 §1.2）：

1. **选择器所有使用点都在 `pages/Reports.tsx` 或 `components/ReportDoc.tsx`** → 随迁 reports.css（`report-*` 前缀全族、`doc-*`、`tpl-*`、`cv-block*` 均满足）。
2. **使用点跨页** → 留 events（或升共享层）：`.disp-link/.list-dim/.disp-loading/.busy-ind/.tb-row/.search-box/.filter-bar/.log-chip(s)`。
3. **复合选择器逐条判，不按前缀一刀切**：`.doc-trunc .disp-link` 整条随迁（上下文选择器，`.disp-link` 本体留）；`.zero-row .disp-link` 留。
4. **不以选择器名判终局的反例**：`.card-grow > .errorbar`（events.css:1307）在历史段但作用于日报卡（§1.2 F）——**凡「作用于报表页的规则」清单必须含这条**，拆分后留在 events.css 继续服务两页即可，严禁当成「历史专属」删改。
5. **媒体查询块拆选择器不拆块语义**：720px 块三条归属（§1.2 B），各自成块。
6. **暗域护栏块**（events.css:1392-1398）三条全为日报 → 随迁，连同算式注释。
7. **keyframes 依赖记账**：reports.css 引 `btn-spin`（primitives）/`fade-in`（base）/自身无 keyframes；events 留守部分继续引 `hit-in`（dashboard）。跨文件 keyframes 合法，但 reports.css 头注释应列明。
8. **import 位置**：reports.css 必须在 primitives.css 之后（`.report-tabs .btn` 覆盖 `.quick .btn` 靠顺序，§0）；建议插在 events.css 之后、settings-monitor 之前，或末端——只需保序约束写入 global.css 注释。
9. **机械拆分纪律**：第一阶段逐字搬移不改值（沿用仓库先例：fade-in 迁 base.css 时「内容逐字未动」，base.css:89-92）；值调整/重命名放后续独立提交，便于 diff 审阅。

### 6.2 其余风险

| # | 风险 | 证据 | 建议 |
|---|---|---|---|
| 1 | **死类 `refreshing`**：两页刷新按钮条件挂类，无任何样式 | History.tsx:675、Dispositions.tsx:672；grep css 零命中 | 迁移时删类或补规则（二选一，别留悬空） |
| 2 | **死 CSS `.hit-mark`** | dashboard.css:460-465；tsx 零使用 | 删 |
| 3 | **别名层仅剩 `--accent` 一处引用** | icons.tsx:119 | 改指 `--color-primary` 后整层可删（theme.css:259-287） |
| 4 | **暗色恢复的陈旧算式**：events 护栏按 14% wash 旧值实算，R12.6 已改 12% + 提亮 primary-text | events.css:1382-1390 vs theme.css:224-228 | 恢复双主题前用 WCAG 公式重算该块（§4 第 6 条） |
| 5 | **`.substatus` 断点物理错位**：dashboard 类的 720px 规则住在 events.css | events.css:565-567；dashboard.css:167-168 注释自认 | 拆分时顺手迁回 dashboard.css |
| 6 | **类名即行为契约**：无 DOM 测试兜底，改名只炸运行时 | §5.2 清单 | 重命名/重构类前过一遍该表；可把该表维护进本文件随迁 |
| 7 | **三 display 位的 700 复写耦合**：历史页 32/700 是对 dashboard 共享面的「漂移免疫」复写 | events.css:1089-1094 | watchtower 若调 KPI 档，两处同步或收敛为单源 |
| 8 | **dashboard.css 双角色**（域 + 共享面）被 History/Dispositions/设置卡借用了 8 组类 | §1.3 | 若做域文件重排，先把这些类升 primitives/共享层再动 dashboard.css，避免三页连锁回归 |
| 9 | **fs-20/24/28 零引用保留档** | §3 实测 | 新字阶设计时明确去留，避免「定义了没人用」继续膨胀 |
| 10 | **web 双环境回归面**：改交互必须同时过浏览器形态（Docker/Web 部署） | web-shim.ts / main.tsx:8-10 | 涉及 clipboard/prompt/下载导入的改动在 web 模式手测 |
| 11 | **`user-select:none` 全局**：正文类区域靠白名单放开（input/textarea/.logview/.hit-title） | base.css:26-35 | watchtower 若引入可选中正文（如日报全文复制），记得扩白名单 |

### 6.3 与上一轮材料的衔接提示

- REDESIGN.md §3 的**绿色 token 表已作废**（代码为 azure R12）；其 §6 交互规范（错误≠空、活列表、加载三态、键盘表、dirty 守卫）与 §8 验收清单仍在被代码注释大量引用（「§6.3」「§5.1」「ia §…」遍布各文件头注释），迁移时这些编号指 REDESIGN/ia/screens 体系，不是本文件编号。
- screens/ 五份是各页 zone 结构的原始出处（Z0/Z1/Z2…、Zone A-E 命名沿用至今，如 `Reports.tsx` 头注释）；四域划分（监控台 / 事件=历史+去向 / 日报 / 设置）与侧栏五 tab 的关系：侧栏仍五项（去向与历史命中是两个 tab，同属「事件」域），迁移若合并导航属产品决策，超出本盘点。

---

## 附：本 session 实测命令记录（结论可复现）

- 文件清单与行数：`find src/renderer -type f`、`wc -l`（§0 表）
- 旧名别名引用：对 `--text/--accent/--accent-hover/--on-accent/--btn-primary-hover/--border/--border-strong/--input-bg/--chip-bg/--*-bg/--shadow/--space-1..6/--radius-s|m|l/--bg-sidebar/--fs-15` 逐一 `grep -rn "var(--名)"` → 仅 `--accent`（icons.tsx:119）存活
- 字重分布：`grep -rn "font-weight:" … | sort | uniq -c` → 400×4 / 500×13 / 600×24 / 700×4
- 字阶引用计数：对 `--fs-*` 逐一 grep 计数（§3）
- 类名→使用点：对 events.css 全部类名 `grep -rl` 于 pages/components（§1.2/§1.3）
- 死类：`grep -rn "\.refreshing|\.statuscard {|\.field-control|hit-mark"` 于 css/tsx
- 暗色停用点：`grep -rn "max-width: 0px|prefers-color-scheme"` → 三处（theme/events/dashboard）
- 组件 import 图：对每个组件 `grep -rln "from '…/components/X'"`（§2）
- 测试断言面：`grep -rn "className" src tests --include="*.test.*"` → 零命中；`cat vitest.config.ts`
