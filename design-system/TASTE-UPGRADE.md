# TASTE-UPGRADE · 品味精进设计稿(R10 之上)

> 依据:三路审计 32 项发现 + `design-system/forumwatch/MASTER.md` + theme.css / global.css 现状通读。
> 范围:仅渲染层表现(`src/renderer/src` 下 CSS/TSX);零外部资源;沿用 CSS 变量令牌体系与文件末尾旧名别名层。
> 关于 MASTER.md 的裁决:该档为机器生成的通用板,其中 Orbitron / JetBrains Mono Google Fonts 与 cyberpunk mood 建议与本项目「Electron 零外联」硬约束冲突,**不采纳**;采纳其色板角色(运营绿 #16A34A 主色系)与 Design Dials(Variance 3 / Motion 2 / Density 8)口径。字体沿用系统中文栈 + `ui-monospace`。

---

## 一、设计定调(一句话)

**为长时间挂在桌面角落、每天瞥几十次的个人论坛监控工具,做一次「瑞士风紧凑看板」的纪律收口:在 R10 运营绿品牌与既有令牌体系内,靠 tone 四档、字重四档、行高三档和全应用唯一的导航 / 页头 / 三态语言,把 32 处审计不一致收拢成一个自洽、双模式对比度达标、状态与错误一眼可辨的桌面工具——气质是"精密仪表"而不是"装饰界面"。**

三个不变:品牌绿只属于「语义与导航」不变;密度 8 的紧凑节奏不变;Motion 2 的克制(无无限循环动效)不变。
一个主张:这次升级不新增任何视觉语汇,只把已有的对的做法推广到漏网处——体系已经有 80 分的骨架,要做的是消灭最后 20 处"两个系统缝在一起"的缝。

---

## 二、分项改造指引

### A. 排版与色彩(基础层)

**1. tone 族从三档补齐为四档。** `tone-*` 类目前只下发 `--tone` / `--tone-bg`,导致 state-pill 把点色档当文字用(实测 2.81–4.12:1)。每个 `tone-*` 类补第四个变量 `--tone-text`(取对应 `*-text` 档),`.state-pill` 文字色改走 `var(--tone-text, var(--text-2))`,`.dot` 与描边继续用 `--tone`。这与 `.outcome` / `.livebadge` / `.how-badge` 的既有正确范式对齐,零结构改动。

**2. 灰族统一绿相(仅浅色模式)。** 现状是蓝相 slate(text-2 #475569、text-3 #64748B、muted #E8F0F1、line #D9D9DF)嵌在绿白品牌底上。做法:等明度换相,全部灰相 hue 固定到绿相(≈150–155°),写进 theme.css 注释作为约束("同一项目只用一族灰")。定档值:

| 令牌 | 现值(蓝相) | 新值(绿相) | 校验 |
|---|---|---|---|
| `--color-muted-foreground`(即 `--text-2` 的引用源,theme.css:26/33;**改基础面值,勿把 `--text-2` 引用改字面量**,否则令牌分层写断) | #475569 | **#43564B** | 白底 ≈7.9:1 |
| `--text-3` | #64748B | **#566B5F** | card-alt 上 ≈4.9:1(顺带修复日志时间戳底子) |
| `--color-muted` / `--card-alt` / `--mute-chip` | #E8F0F1 | **#EAF1EC** | 卡内嵌区,绿相 |
| `--line` | #D9D9DF | **#D8E0DA** | 功能分隔线 |
| `--input-border` | #64748B | **#566B5F** | 与 text-3 同值(维持现状口径) |
| `--scroll-thumb` | #C6CFD6 | **#C8D2CC** | 滚动条 |

深色侧整体是自洽的深蓝灰,**不动**;唯一例外是 `--ok` 在暗色补一档提亮 `#16A34A → #22C55E`,使四族"暗底提亮"策略对齐(暗色 state-pill 绿字从贴线 4.68 变为从容达标)。

**3. 禁止用透明度压语义文字。** 全量清点 global.css 共 12 处 `opacity: 0.7x/0.8x`,按性质三分:

- **语义文字层级弱化,共 5 处,全删**:`.log-line .t` 的 0.75(1473 行;时间戳是排障时间线,12px mono 小字必须实色,text-3 新值在 card-alt 上 ≈4.9:1)、`.log-chip.on .num` 的 0.75(1536 行;选中 chip 深底上的计数文字,删 opacity 后保持 `color: var(--bg)` 即高对比)、`.esc-hint` 的 0.8(2103 行)、`.sb-confirm .sb-esc` 的 0.8(2410 行;与 esc-hint 同性质的 Esc 提示)、`.errorbar-detail` 的 0.85(2534 行)。
- **hover 变淡,4 处,归第④项随增强式 hover 一并消灭**:`.pending-toggle:hover`(979)、`.feedback-retry:hover`(1165)、`.disp-link:hover`(2834)、`.stat-detail-toggle:hover`(2895)。
- **豁免(非文字层级)**:`.spark-bar`(2948/2952)与 `.rk-bar`(3045)是数据柱条的不透明度,属图形表达;`.empty-illus`(0.6)是空态插画图形,同理;`.btn:disabled` / `.ent-main.is-off` / `.entity-row.del` / `.input-disabled` / `.list-dim` 是禁用与待删除的**状态压暗**,是语义本身而非层级弱化——均不动。

原则写入 theme.css 注释:**色阶可控、透明度不可控**(仅限语义文字的层级表达)。

**4. 字重收敛为四档。** 400 正文 / 500 次强调(按钮、命中标题)/ 600 标题族(卡题、组头、导航选中、指标数值)/ 700 页题(唯一)。现状十处 650 一律归 600(PingFang SC 最高 600、雅黑只有 400/700,650 是跨平台漂移源)。`.page-title` 保持 700;`.report-title` 在降为卡头标题后(见 B-2)用 600。

**5. 行高建三档令牌 + 一个徽标专用像素档。**

- `--lh-tight: 1.3` —— 标题、数字、pill、徽标;
- `--lh-base: 1.5` —— 界面正文、表单、列表行、提示条;
- `--lh-read: 1.7` —— 阅读区(日报正文、日志行、详情段);
- `--lh-chip: 17px` —— 徽标行像素行高,**与 fs-12 绑定**(改字号须同步),注释写明。

11 种散值归位映射:1.25 / 1.3 / 1.35 → tight;1.4 / 1.45 / 1.5 / 1.6 → base;1.7 / 1.75 → read;17px → chip。**裸值 `1` 全文件仅命中 `.tag .x`(1820 行,标签删除 × 的行高)——第①项保留不动**(此时 × 还是文本字符,改 1.3 会微撑高标签),随第③项换 `IconX` 时一并删除该声明( flex 对齐的 SVG 不再依赖它);此跨项依赖在两项任务中均注明。选档规则一句话:**标题与数字紧、界面文字中、成段阅读松**。

**6. 中文一律零字距。** 八处 `letter-spacing: 0.01–0.02em` 全部删除(12–20px 中文场景下 0.1–0.4px 肉眼无感,是"装了 tracking 的样子")。拉丁小标签如未来需要 tracking,须 0.06em 以上 + uppercase 才许用——本轮没有此类场景,整列删除。

**7. 卡题全局提档,撤范围覆盖。** 全局 `.card-title` 从 12px/650/text-2 提为 **fs-14 / 600 / var(--fg)**(设置页已验证的节奏),删除 `.page-settings .card-title` 范围覆盖(同块内 `.field-label`、`.input` 覆盖保留)。`card-title-aux` 同步定为 fs-12 / 400 / text-3。五页卡题同档,"卡题 > 行内容 > 元信息"恢复单向递减。

**8. 弱底统一一个 wash 令牌。** 新增 `--primary-wash: color-mix(in srgb, var(--color-primary) 10%, transparent)`,`.chip`(命中词,底从 14% 降档,ok-text 上实测 ≥4.5:1)、`.live-pill:hover`(14%→wash)、`.quick .btn.active`(10%→wash)、导航选中态(见 B-1)共用。"10% 弱底"成为全应用唯一的品牌绿透明底档。

**9. 消灭纯黑纯白硬编码。** `--color-on-primary: #000000 → #052E16`(深绿黑,绿底上 ≈4.5:1,与品牌同相);`.switch::after` 圆点 `#ffffff → #F7FAF8` 且**删除纯黑投影**(暗底上本就不可见,轨道边界已提供边缘);`.btn-danger-solid` 文字 `#ffffff → var(--on-danger)`(#FEF7F7,红底上 ≈4.6:1)。

**10. 点色档禁作小字(err 侧补漏)。** `.ent-btn.danger:hover` 与 `.tag .x:hover` 的文字色 `var(--err) → var(--err-text)`,与 `--ok` 侧已全局遵守的口径对称。

**11. 仪表盘单一最响层。** 页题 fs-20/700 是全页唯一 20px 档;四格指标数值 fs-20 → **fs-15/600**(密度 8 看板口径,数字响度由 tnum + 字重 + 四格留白承载)。层级变为:页题 20 > 状态 pill 15(chip 实底)> 指标数值 15(素底)> 卡题 14——信息优先级(状态>指标>题注)与视觉响度对齐。风险缓释:若实施后首屏锚点偏弱,优先调 `.metric` 的内距与四格留白,**不回调字号**(字号五档不增)。

### B. 布局与分区(外壳层)

**1. 全应用唯一「导航选中态」语言。** 选中 = **`--primary-wash` 底 + 文字 `var(--color-foreground)` + 600 字重 + 图标 `--ok-text`**。

> 字色取值说明(对比度实测):若文字也用 `--ok-text`,在主侧栏底上仅 4.09:1(bg-sidebar ≈#E3F8EA 叠 10% wash 后 ≈#CFF0DA,#15803D 于其上),违反本稿「双模式 ≥4.5:1」的纲。改用 `var(--color-foreground)`(#14532D,同为品牌绿最深档):主侧栏最严底上 **6.41:1**,白卡底(子导航/日期栏)更高,深色模式自动取近白 #F8FAFC 同样从容;品牌绿的表达交给 wash 底与图标色——图标属图形,按 3:1 非文本口径(主侧栏 4.09、暗色 7.03,均达标)。

- 主侧栏 `nav-btn.active`:撤白卡底与阴影,改用上述语言——一级导航终于带品牌绿,层级不再倒挂;
- 设置子导航 `snav-item.active`:同语言,**保留 3px 主色竖条**(次级密列,竖条助扫视);
- 日报日期栏 `report-date.active`:同语言(12% tint → wash),无竖条;
- `.log-chip.on` 深底反转**保留**,定位为"筛选控件"语言,与导航族显式区隔并写注释。

**2. 页头契约:五页一个范式。** PageHeader 是唯一页级页头(题 fs-20/700 + 副题 + 更新于;**页题 = 侧栏 label 同名**)。

- 日报页补页头:题「日报」、副题说明本页价值、updatedAt = **本会话内首次成功读取 / 重新生成该日报的时刻**(组件 state 自记,切日期即重置;`DailyReportInfo` 只有 `date + markdown`,无生成时刻字段,渲染层拿不到历史日的生成时间——会话内无记录时传 `null`,PageHeader 对 null 本就不渲染更新行)。**严禁为此改动 `src/shared` / `src/main` 取数**;卡片头日期降为卡头标题级 **fs-15/600**(它是"这张卡的标题",不是页面身份);
- 设置页补 `sr-only` 的 h1「设置」——视觉上无页题是**决策**(Zone A 子导航已承载分区身份),注释写明"是决策而非缺失";
- 页头动作区对齐:`.pagehead` 从 `flex-end` 改 `flex-start`,`.pagehead-actions` 加约 4px 顶部光学补偿,按钮与副题行齐平,右上角不再悬挂。

**3. 导航行高统一 44px。** `nav-btn` 加 `min-height: var(--hit)`(padding 调至 `8px var(--space-2)`,184px 侧栏足够);`report-date` 加 `min-height: var(--hit)`(padding `8px var(--space-md)`)。三套导航行高收敛为一套,主侧栏不再是自己验收红线(≥44px)的唯一违例。

**4. 切页左缘恒定。** `.page-settings` 左内距 12px → `var(--space-2xl)`(24px),`.settings-scroll` 左内距归 0(右内距保留让位滚动条)。所有页面首个视觉元素左缘落在同一条 24px 竖线上,消除切页 8px 跳动。

**5. 设置页组头拆两级。** 组头一行三种信息同权重 → 拆为:第一行组名 fs-15/600(**带圈序号 ①–⑥ 只保留在子导航**,组头去编号);第二行释义新增 `.group-sub`(fs-12 / text-3 / lh-base)。「组头 15 > 卡题 14 > 标签 13 > hint 12」四级节奏真正落在四个视觉档位上。

**6. 列表页解剖统一(历史页为模板)。** 两页同构为:**卡头(题 + 计数/窗口 aux + 查询指示)→ 卡内筛选条 → 滚动列表 → 分段加载条**。去向页工具条卡并入列表卡、列表卡补卡头「判定记录」+ 计数;筛选两行结构、搜索框与重置位置与历史页逐一对齐。页题「处置去向」→「去向」(导航 label = 页题,写为规范)。

### C. 组件与状态(组件层)

**1. 表单校验态必须有视觉。** global.css 补两条内联语义规则:`.field-hint .err { color: var(--err-text) }`、`.field-hint .warn { color: var(--warn-text) }`——6 处已写 `className="err"/"warn"` 的 hint 立即生效,填错轮询间隔 / 代理地址时不再是"错误与说明文字同色"。规范:**错误/警示只许落在有定义的语义载体上(.field-hint 内联语义 / .feedback.err/.warn),禁止无定义裸类**。

**2. 图标语言唯一:内联 SVG。** Unicode 符号(✓ ✗ ▾ × – ·)全部换成既有 `IconCheck / IconX / IconChevronDown / IconMinus / IconDot`(stroke 1.5 / currentColor 不变):测试台阶段结论、数据卡 / 关于卡成功反馈、挂起行展开、标签删除。挂起行展开补 `aria-expanded` 旋转过渡,与历史页 stat-detail-toggle 同款。文案串里的 ✓/✗ 前缀改为"图标 + 文案"。

**3. 图标尺寸档定死(按实测用例,非虚构)。** 全量清点 size 用例:12×14、13×4、14×35、15×2、16×2、20×1、44×1、8×2。定档:

| 档 | 用途 |
|---|---|
| **8** | `IconDot` 状态点(纯 fill 小圆点)——**体系外件**,不属线形图标档 |
| **12** | 行内文本前缀与反馈符号 |
| **14** | 独立按钮与块图标(主力档) |
| **16** | 侧栏导航图标 |
| **20** | 品牌标(IconRadar) |
| **44** | 空态插画(`IllustrationRadar`)——**体系外件**,插画不属图标档 |

归位三处散值:Reports.tsx:467/473/502/503 的 `IconCheck/IconX` 13 → **12**(行内反馈符号,归第②项);Dispositions.tsx:710 与 History.tsx:879 的 `IconSearch` 15 → **12**(搜索框前置属行内前缀,归第④项);StatusCard.tsx:131 挂起行 `IconClock` 16 → **14**(块图标,归第④项)。同簇同档:ErrorBar 的 X 与重试统一 12。icons.tsx 头注释按上表改写(现注释宣称 16/20 两档,与 12/14 主力脱节——修订后必须与真实档位一致,不再虚构 64 档)。

**4. 进行中语言唯一:`.btn.busy`。** spinner + 文字不变 + disabled(global.css:1075 已内置),AboutCard「检查中…」、AiModelCard「测试中…」、ChannelsCard「发送中…」、DataCard「导出中…/导入中…」、MatchTestCard「评估中…」、SettingsSavebar「保存中…」全部改为 busy 类,删文字替换三元。文案状态描述交给旁侧 feedback 区。按钮宽度稳定、活动感保留。

**5. 行内确认范式统一。** 最重的不可逆操作(导入备份)反而视觉最弱(裸 .notice)→ DataCard 导入确认条改用新通用类 `.inline-confirm`(warn-chip 底 + warn-text + fade-in 入场,与 `.sb-confirm` / `.report-confirm` 同范式);按钮层级保持「确认导入 danger-solid + 取消次级 + Esc 提示」。

**6. hover 一律增强式。** 深链 hover 禁止 `opacity` 变淡(浅色下"回应指针"变"褪色")。四处(`.pending-toggle` / `.feedback-retry` / `.disp-link` / `.stat-detail-toggle`)统一为:**下划线转实线 + 颜色加深一档**(绿色深链加深档用 `var(--color-foreground)`——同为品牌绿相;语境继承色的加深档用 `var(--fg)`),与 `.hit-title` 方向一致。

**7. 筛选 chips 状态闭环。** `.log-chip` 补 `:hover:not(.on)` 中间态:边框加深一档(`var(--input-border)`)+ 底色 `var(--card-alt)`,不与选中深底混淆;transition 不再是死代码。

**8. 错误是一等公民(投票不例外)。** HitRow 投票失败从"静默回滚 + console.warn"改为行内短暂 err 反馈:投票组旁 12px `err-text` 文案(如「反馈提交失败,已还原」)约 1.5s 复原;成功路径不动。

**9. 复制反馈保按钮结构。** 成功反馈 = 图标原位 `IconCopy → IconCheck`(尺寸不变)+ 文字不变 + `.ok` 色档,1.5s 复原;LogView 与 DispositionRow 两处统一同一模式(数量信息瞬时放 `title`)。不再"图标消失 + 文字替换"造成宽度跳动——与"刷新类按钮保文字换图标"的既有纪律互为镜像。

**10. 三态谱系定版。** **结构空 = EmptyState 插画卡;筛选空 = `.empty` 弱灰字;首载 = `.empty.disp-loading`(旋转 IconRefresh + 文案)。** 历史 / 日报页首载从纯灰字改为 disp-loading 范式(**日报页首载随 Reports.tsx 文件归属在第②项执行,任务已列入第②项清单,勿漏**);骨架块(`.set-skel`)保留给设置页整页表单(结构已知的大面积占位),规则写注释:本地 IPC 毫秒级返回的列表页不做骨架,避免闪跳;`.set-skel` 规则并列挂 `.skel` 选择器供后续复用。

**11. 假按钮删除。** RoutingCard 行内编辑脚部的「保存」与「收起」执行完全相同的动作——删「保存」只留「收起」,与其余三类实体卡对齐(编辑模型是"改动直写 draft、Zone C 统一保存");无效原因已有 title,可再上一行常显 field-hint 弱提示。

---

## 三、逐项实施清单(串行 4 项)

> 执行顺序固定:① 基础层 → ② 外壳层 → ③ 设置页 → ④ 查看页。global.css 区段归属见各项;theme.css 仅属第①项。

### 第①项 基础层:令牌与排版纪律收口(kind: foundation)

**负责文件:** `src/renderer/src/theme.css`(整文件、独占)、`src/renderer/src/global.css`(基础层区段:body 排版基线、tone-* 与 .state-pill/.dot、.log-line .t、.esc-hint/.errorbar-detail、.chip/.live-pill:hover/.quick .btn.active、十处 font-weight:650、八处 letter-spacing、line-height 全量归位、.metric .v、.card-title 与 .page-settings .card-title 覆盖、.switch::after、.btn-danger-solid、.ent-btn.danger:hover 与 .tag .x:hover、.src-badge/.cat/.how-badge 的 17px)。

**要做什么:**
1. theme.css:新增 `--lh-tight/--lh-base/--lh-read/--lh-chip` 与 `--primary-wash`、`--on-danger`;浅色灰族六值换绿相(§A-2 表);`--color-on-primary → #052E16`;暗色块仅 `--ok → #22C55E`;注释补三条纪律(灰相 hue 固定 / 透明度禁压语义文字 / 字重四档)。
2. global.css:tone-* 补 `--tone-text`(tone-paused 用 text-2),`.state-pill` 文字走 `--tone-text`;删**五处**语义文字 opacity 弱化(`.log-line .t` / `.log-chip.on .num`(删后保持 `color: var(--bg)`) / `.esc-hint` / `.sb-confirm .sb-esc` / `.errorbar-detail`,见 §A-3);`.chip` 底与 `.live-pill:hover`、`.quick .btn.active` 统一 `--primary-wash`;650→600 十处;删 letter-spacing 八处;line-height 按映射表归位(17px→`var(--lh-chip)`;**`.tag .x` 的 line-height:1 保留不动,依赖注记见 §A-5,随第③项换 IconX 一并删除**);`.metric .v` fs-20→fs-15;`.card-title` 全局提为 fs-14/600/fg 并删 `.page-settings .card-title` 覆盖;switch 圆点 #F7FAF8 + 删投影;`.btn-danger-solid` 文字走 `--on-danger`;两处 danger hover 文字改 `--err-text`。灰族换相在 theme.css 基础面值上改(`--color-muted-foreground` 等),不动 `--text-2` 的引用结构。
3. 全程不动:间距阶、圆角、阴影、动效时长、别名层、深色蓝灰基调;spark-bar / rk-bar 图形条与 disabled / is-off / del / list-dim 状态压暗的 opacity 豁免。

**验收要点:** 浅 / 深两模式下:state-pill 三 tone 文字 ≥4.5:1;日志时间戳在 card-alt 上 ≥4.5:1;命中词 chip ≥4.5:1;全文件 grep 无 `font-weight: 650`、无 `letter-spacing: 0.0[12]em`;grep `opacity: 0.7`/`0.8` 仅余三类——豁免清单(图形条与状态压暗)、第④项待改的 4 处 hover(`.pending-toggle/.feedback-retry/.disp-link/.stat-detail-toggle`)、`.tag .x` 无关(line-height 非 opacity);`.page-settings .card-title` 覆盖已删而设置页卡题观感不变;五页卡题同档;监控台只剩页题一个 20px 档。

### 第②项 外壳层:导航语言与页头契约

**负责文件:** `src/renderer/src/App.tsx`、`src/renderer/src/components/PageHeader.tsx`、`src/renderer/src/pages/Reports.tsx`、`src/renderer/src/global.css`(区段:.nav/.nav-btn、.snav-item、.report-rail/.report-date、.pagehead/.page-title/.pagehead-actions、.page-settings 与 .settings-scroll 的 padding 声明、.report-head/.report-title-row/.report-title)。

**要做什么:**
1. 主侧栏 / 子导航 / 日报日期栏选中态统一为 wash 底 + **文字 `var(--color-foreground)`** + 600 + 图标 `--ok-text`(§B-1,字色取值与实测对比度见该节说明);`nav-btn`、`report-date` 补 `min-height: var(--hit)`;log-chip.on 注释写明属筛选语言。
2. Reports 页顶补 PageHeader(题「日报」/ 副题 / **updatedAt = 本会话内首次成功读取或重新生成该日报的时刻,组件 state 自记、切日期重置;无会话记录传 null(不渲染更新行);严禁为此改 `src/shared` / `src/main`**,§B-2),卡头日期降为 fs-15/600 的卡头标题;Report-title 字重落 600。
3. `.pagehead` 对齐改 flex-start + 动作区光学补偿(§B-2)。
4. `.page-settings` 左内距 24px、`.settings-scroll` 左内距 0(§B-4);核对 savebar 负边距随左 padding 归零同步调整。
5. **Reports 首载改造(本项文件,勿漏)**:Reports.tsx:559 的 `<div className="empty">正在加载日报…</div>` 改为 `.empty.disp-loading` + `IconRefresh size={12}`(旋转复用 btn-spin)同款范式;顺手把 Reports.tsx:467/473/502/503 的 `IconCheck/IconX` size 13 → 12(行内反馈符号档,§C-3)。

**验收要点:** 主侧栏 active 带品牌绿且为唯一一级导航语言,选中文字对比度 ≥4.5:1(主侧栏最严底实测 6.41:1);Cmd+1..5 连续切换时五页内容左缘同线(24px);日报页有页级页头、h1 是「日报」而非日期,首载呈「旋转图标 + 文案」而非纯灰字;三套导航行高均 ≥44px;页头右上动作不再悬挂于时间戳行之下;Reports 反馈图标均为 12。

### 第③项 设置页:组头 / 校验态 / 进行中与确认语言

**负责文件:** `src/renderer/src/pages/Settings.tsx`、`src/renderer/src/components/GroupHeader.tsx`、`components/` 下 `NotifyCard.tsx`、`ProxyCard.tsx`、`RunPaceCard.tsx`、`MatchModeCard.tsx`、`DataCard.tsx`、`AboutCard.tsx`、`AiModelCard.tsx`、`ChannelsCard.tsx`、`MatchTestCard.tsx`、`SettingsSavebar.tsx`、`RoutingCard.tsx`、`KeywordTagInput.tsx`、`src/renderer/src/global.css`(区段:.group-head 与新增 .group-sub、.field-hint 内联语义子规则、新增 .inline-confirm、.hit-mark)。

**要做什么:**
1. GROUPS 拆 title 为组名 + 释义;GroupHeader 渲染两级(§B-5);组头去 ①–⑥ 编号(子导航保留)。
2. global.css 补 `.field-hint .err/.warn` 语义色(§C-1),六个既有 span 立即生效。
3. 六个组件的进行中按钮改 `.btn.busy`(§C-4),删「…中…」文字替换;SettingsSavebar 主 CTA 同样适用。
4. DataCard 导入确认条 `.notice` → `.inline-confirm`(§C-5);导出 / 导入反馈串去 ✓/✗ 字符,渲染处按 kind 前置 IconCheck/IconX(size 12)。
5. MatchTestCard 阶段行与结果行的 ✓✗–· 换 SVG(§C-2);KeywordTagInput 删除 × 换 IconX(size 12,内边微调),**同时删除 global.css 中 `.tag .x` 的 `line-height: 1` 声明**(第①项保留的跨项依赖,SVG flex 对齐不再依赖它,见 §A-5)。
6. RoutingCard 删「保存」假按钮,只留「收起」(§C-11)。
7. Settings.tsx 顶部补 `<h1 className="sr-only">设置</h1>`(§B-2)。

**验收要点:** 轮询间隔填 12 时 hint 变红(六处全验);任一异步按钮进行中转圈且文字 / 宽度不变;导入确认条呈琥珀警示底;组头是"组名 + 下一行释义"两行;grep 设置页组件无 mark 表字符(✓ ✗ –)与独立的 × 残留——**「·」是中文间隔号属合法文案(如 AboutCard 的时间分隔),不机检、人工判读**;`.tag .x` 的 line-height:1 已随 IconX 删除;路由行脚部单按钮。

### 第④项 查看页:列表解剖 / 图标语言 / 三态闭环

**负责文件:** `src/renderer/src/pages/Dispositions.tsx`、`src/renderer/src/pages/History.tsx`、`components/` 下 `StatusCard.tsx`、`HitRow.tsx`、`LogView.tsx`、`DispositionRow.tsx`、`ErrorBar.tsx`、`icons.tsx`、`src/renderer/src/global.css`(区段:.disp-toolbar/.tb-row 与去向列表卡结构、.log-chip hover、hover 方向四选择器 .pending-toggle/.feedback-retry/.disp-link/.stat-detail-toggle、.empty/.disp-loading/.set-skel 加载谱系)。

**要做什么:**
1. 去向页按历史页模板重组:工具条并入列表卡、补卡头「判定记录」+ 计数 + 查询指示,筛选两行 / 搜索 / 重置对齐(§B-6);页题「处置去向」→「去向」。
2. 四处 opacity hover 改增强式(§C-6);`.log-chip` 补 hover 中间态(§C-7)。
3. HitRow 投票失败行内 err 反馈 1.5s 复原(§C-8);两处复制反馈改图标互换模式(§C-9)。
4. StatusCard 挂起行 ▾ → IconChevronDown(size 12)+ aria-expanded 旋转;IconClock 16→14(§C-2/3);Dispositions.tsx:710 与 History.tsx:879 的 IconSearch 15→12(行内前缀档);ErrorBar 的 X 统一 12;icons.tsx 头注释按 §C-3 真实档位表改写(8 状态点与 44 插画注明体系外,**不虚构 64 档**)。
5. History 首载(History.tsx:918)从纯灰字改为 `.empty.disp-loading` + IconRefresh size 12(§C-10;Reports 首载已随文件归属在第②项完成,本项不复改);`.set-skel` 规则并列挂 `.skel`。

**验收要点:** 两列表页肌肉记忆一致(卡头有题、筛选在卡内、搜索重置同位);同屏所有深链 hover 变深不变淡;日志 chips 悬停有反馈;投票失败有可见文案;复制时按钮宽度零跳动;挂起行展开与统计折叠的箭头行为同款;grep `opacity: 0.75` 于 hover 选择器为零。

---

## 四、不做清单(明确不碰)

1. **不引入任何外部资源**:网络字体(含 MASTER.md 建议的 Orbitron / JetBrains Mono)、图标库、npm 依赖、图片;系统字体栈与内联 SVG 不变。
2. **不改业务与交互**:不动 `src/main`、IPC、类型定义、 hooks 逻辑与数据流;功能与交互行为(按钮作用、快捷键、筛选语义)零变化。
3. **不动令牌骨架**:间距阶(xs..3xl)、圆角两档、阴影四档、动效时长、字号五档(12/13/14/15/20)不增不删;theme.css 末尾旧名别名层原样保留。
4. **不大规模改类名、不整文件重写**:新增仅限 `--tone-text`、`--lh-*`、`--primary-wash`、`--on-danger` 四个令牌与 `.group-sub`、`.inline-confirm`、`.skel` 三个类;`.set-skel/.disp-loading` 等历史前缀类名本轮不更名。
5. **不动深色模式基调**:深蓝灰体系保持(仅 `--ok` 提亮一档);不重做品牌色、不加渐变 / 发光 / 新装饰。
6. **不动既有正确范式**:`.log-chip.on` 深底反转(筛选语言)、`.outcome/.livebadge` tone 用法、`reduced-motion` 全局兜底、无限循环动效禁令、"错误是一等公民"的 ErrorBar 体系——只推广,不重造。
7. **不扩范围**:信息架构重组、新页面、文案重写(除被点名的「处置去向→去向」与去 ✓/✗ 字符)、`--space-5`/`--fs-28` 历史清理,均不在本轮。
