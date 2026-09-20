# ForumWatch R11 视觉重设计简报（设计主导 · 终值裁决）

**方向一句话**：「墨轨控制台（Ink Rail Console）」——冷青纸面 + 两模式恒深墨色侧栏 + emerald 信号绿 + 三级表面/双层阴影深度 + 12↔28 七档字阶对比。高密度桌面监控工具的定位不变，但表面去染色、层次拉起来，与 R10（薄荷绿染面、扁平、五档小字阶）肉眼可辨。

**输入与依据**：
- 现状实读：`src/renderer/src/theme.css`（全文 189 行）、`App.tsx` 全文、`components/StatusCard.tsx`、`HitList.tsx`、`EntityList.tsx`、`Field.tsx`、`RulesCard.tsx`（前 120 行）、`design-system/forumwatch/MASTER.md`（R10 旧版全文）、`design/redesign/REDESIGN.md`（全文 441 行）、`pages/` 五页行数与骨架（Dashboard/History/Reports/Settings/Dispositions）。
- **CSS 文件结构注（评审轮更正）**：设计审计时样式为单文件 `global.css`（3275 行，逐段实读）；此后仓库已将其拆分为 `global.css`（16 行 @import 聚合器，global.css:8-16）+ `styles/*.css` 八个领域文件。本简报 §2.0 的文件归属映射与行号以拆分后现状为准（评审轮 grep 实测），一切「改哪个文件」以 §2.0 为唯一依据。
- ui-ux-pro-max 实跑（本 session，命令原文）：
  - `search.py "monitoring dashboard developer productivity dense data tool" --design-system --variance 6 --motion 4 --density 8` → Pattern=Real-Time/Operations Landing、Style=Dark Mode (OLED)、色板锚 Status Page 绿、typography 命中 Fira 族（不采用，见下）。
  - `--domain style "dark dashboard depth elevation layered"` → **dimensional-layering**（4 级 elevation/backdrop 深度语言，R11 表面与阴影体系的直接依据）、data-dense-dashboard（8–12px padding、行 hover、KPI 卡）、dark-mode-oled。
  - `--domain color "monitoring operations status colors"` → API Developer Portal / Smart Home IoT 等暗板佐证（#0F172A/#1B2336 slate 分层）。
  - `--domain typography "professional dashboard monospace data technical"` → Modern Dark Cinema：display 负字距 + label 正字距 + mono-for-data 手法（字体弃、手法取）。
  - `--persist --force -p ForumWatch --output-dir 项目根` 已执行，`design-system/forumwatch/MASTER.md` 已按上述裁决改写为 R11 终值（含「R11 改动理由 vs R10」一节）。
- 对比度：本 session 用 python 按 WCAG 相对亮度公式实算 50+ 色对（全部 ≥4.5:1 文字 / ≥3:1 图形；结果摘录进 MASTER 与本简报 §1.6）。**未运行**应用、构建、测试（工作流统一执行）。

**档位说明**：variance 6（用户要大刀阔斧但仍属成熟工具：6=Modern 偏 Bold，未到 Brutalism）、motion 4（监控工具禁装饰动效，但展开/入场要成档存在）、density 8（继承 R10 密集档，检索确认间距表不变）。与旧版差异：3/2/8 → 6/4/8。

---

## 0. 功能红线（最高优先级，全阶段生效）

纯视觉重设计：数据流、状态逻辑、IPC、hooks、props 语义、事件处理、校验行为一律不动；**用户可见文案的文字内容不得改写**（排版/标点微调可以）。DOM 结构、className、样式、布局可动。本文所有「版式/组件」条款只描述视觉与结构呈现，不新增行为。

---

## 1. 设计令牌终值表（`theme.css` 直接照此重写）

规则：浅色 `:root` 为基础，`@media (prefers-color-scheme: dark)` **整组覆盖**；组件内零硬编码 hex。变量名尽量沿用 R10 现有名（别名层已在 theme.css 尾部，迁移期可继续使用旧名）。新增 `--raised`/`--rail-*`/`--edge-top`/`--fs-24`/`--fs-28`/`--t-glide`/`--ease-*`/`--ls-*`。`--fs-15` **不直接删**：并入 16 档，但迁移期在 theme.css 尾部别名层新增一行 `--fs-15: var(--fs-16);`（与既有旧名别名同模式）——现状有 5 处 `var(--fs-15)` 引用（清单见 §1.5），无别名又漏改会让整条 font-size 声明失效静默回退继承错字号。各引用处由所属领域工程师替换为 `--fs-16`，五处全部清零后收尾阶段删别名行。

### 1.1 基础面与文字

| 变量 | 浅色 | 暗色 | 用途 |
|---|---|---|---|
| `--color-background` / `--bg` | `#EEF1F5` | `#070B14` | 窗口底（冷纸灰白 / 深空蓝黑） |
| `--color-card` / `--card` | `#FFFFFF` | `#0D1422` | 卡面 |
| `--card-alt` | `#F2F5F8` | `#151E30` | 卡内嵌井（日志底/展开行底/KPI 井） |
| `--raised` | `#FFFFFF` | `#16203A` | 浮层/弹层/吸底栏/设置子导航面（配 lg/xl 阴影） |
| `--color-foreground` / `--fg` / `--text` | `#16202E` | `#E8EEF7` | 主文字（浅 on card 16.40 / on bg 14.48；暗 on bg 16.87:1） |
| `--text-2`（=`--color-muted-foreground`） | `#455567` | `#A6B4C8` | 次要文字（7.64 / 8.76:1） |
| `--text-3` | `#5B6B80` | `#8294AD` | 辅助元信息（5.44:1 白底、4.97:1 card-alt、暗 5.95:1；旧绿相 #566B5F 废止） |
| `--line`（功能分隔线） | `#D3DBE4` | `#26324A` | 行/卡/组分隔 |
| `--color-border`（装饰描边） | `#CBD5E1` | `#324261` | 仅卡外缘装饰；禁承载分隔/输入语义（R10 纪律继承，旧薄荷 `#BBF7D0` 废止） |
| `--input-border` | `#64748B` | `#6B7A94` | 输入框功能边界（4.76 / 4.24:1） |
| `--ring` | `#047857` | `#34D399` | 焦点环（on bg 4.84 / on card 9.58:1） |
| `--scroll-thumb` | `#C4CEDA` | `#26324A` | 滚动条 |

### 1.2 墨轨侧栏（两模式恒深，R11 新增）

| 变量 | 浅色 | 暗色 | 用途 |
|---|---|---|---|
| `--rail-bg`（=`--bg-sidebar`） | `#131A2A` | `#0B1220` | 侧栏底（旧「绿 6% 混色」公式废止） |
| `--rail-fg` | `#E8EEF7` | `#E8EEF7` | 轨内主文字（14.89:1） |
| `--rail-fg-2` | `#93A3BC` | `#93A3BC` | 轨内次要（6.79 / 7.32:1） |
| `--rail-bar` | `#34D399` | `#34D399` | 选中 3px 竖条 / 轨内品牌强调（9.04:1） |
| `--rail-active-bg` | `color-mix(in srgb, #34D399 14%, transparent)` | 同值 | nav 选中底（rail-fg 其上仍 >13:1；落地复测） |
| `--rail-line` | `rgba(255,255,255,.10)` | `rgba(255,255,255,.08)` | 轨内分隔线/brand 底边 |

轨内一切文字用 rail 族色，不得引用 `--fg/--text-2`（它们在浅底定义）。dirty-dot、迷你状态 tone 点在轨内用各 tone 的**暗档**值（`#34D399/#F87171/#FBBF24/#A78BFA`，均已实测 >5:1 on #131A2A 同族深底 ≥7）。

### 1.3 品牌与主按钮（R10「绿底黑字」反转为「按模式取 `--color-on-primary`」）

> **警示（评审轮实测）**：纯白 on 暗档按钮底 `#34D399` 仅 **1.92:1**。一切「实底按钮/圆片/角标」文字只准写 `var(--color-on-primary)`（浅档解析为白 5.48:1，暗档解析为深墨 `#052E1F` 7.71:1），**禁在任何领域文件硬编码 `#FFFFFF`/`white`**。

| 变量 | 浅色 | 暗色 | 实测 |
|---|---|---|---|
| `--color-primary`（图形：点/描边/选择条/图标强调/`accent-color`） | `#059669` | `#34D399` | on 白 3.77、on bg 3.33 / on bg 10.24（UI≥3） |
| `--btn-primary-bg` | `#047857` | `#34D399` | — |
| `--color-on-primary` | `#FFFFFF` | `#052E1F` | 5.48 / 7.71:1 |
| `--hover-primary-bg` | `#065F46` | `#6EE7B7` | 字仍 `--color-on-primary`：浅白字 7.68 / 暗墨字 9.72 |
| `--hover-primary-fg` | `#FFFFFF` | `#052E1F` | — |
| `--hover-danger-bg` | `#B91C1C` | 同值 | danger 描边/浅底 hover 加深档（继承 R10 值） |
| `--danger-solid-bg`（新，实底 danger 专用底） | `#DC2626` | `#DC2626` | **实底 danger 禁再用 `var(--err)` 作底**（settings-core.css:276 `.btn-danger-solid` 现状如此）：暗档 `--err`=`#F87171` 上纯白实测仅 2.77:1。实底底两模式统一 `#DC2626`（白字 4.83）、hover `#B91C1C`（白字 6.47）；`--err` 点档在暗色只服务点/描边/文字/弱底 |
| `--on-danger`（实底 danger 文字，**保留现有变量名**） | `#FFFFFF` | `#FFFFFF` | danger 实底 `#DC2626` 两模式同值，白字 4.83:1（实测）。现值 `#FEF7F7` 实测 4.57:1 达标（R10 注释「≈4.6:1」不虚）——R11 统一为纯白并把两模式 danger 底收敛为同值；theme.css 重写时**此 token 不可丢**（settings-core.css:279/285 `.btn-danger-solid` 在用，丢了声明无效→继承文字色，确认条观感崩坏） |
| `--primary-wash` | `color-mix(in srgb, #059669 10%, transparent)` | `color-mix(in srgb, #34D399 14%, transparent)` | 行 hover/选中/quick-active 共用一档（继承「全应用唯一绿透明底」纪律；混色后文字对须落地复测） |

### 1.4 语义 tone 族（三档结构继承：点 · 文字 · 弱底；语义映射继承：绿=运行、红=事件、琥珀=中间态、紫=AI；色不单用）

| 族 | 点（浅/暗） | 文字（浅/暗） | 弱底（浅/暗） |
|---|---|---|---|
| `--ok` / `-text` / `-chip` | `#059669` / `#34D399` | `#047857` / `#34D399` | `#DCF5EA` / `#0E2A22` |
| `--err` / `-text` / `-chip` | `#DC2626` / `#F87171` | `#B42318` / `#F87171` | `#FDE7E5` / `#3A161B` |
| `--warn` / `-text` / `-chip` | `#B45309` / `#FBBF24` | `#92400E` / `#FBBF24` | `#FBEBD2` / `#33270F` |
| `--ai` / `-text` / `-chip` | `#7C3AED` / `#A78BFA` | `#6D28D9` / `#A78BFA` | `#EDE9FE` / `#241B3F` |
| `--mute-chip` | —（文字用 `--text-2`） | — | `#E7ECF2` / `#1A2334` |

文字档全部实测 ≥4.78:1（对各自 chip）；点档全部 ≥3:1（对 card/card-alt/chip）。**浅底小字禁用点档**（R10 陷阱继承）。下发范式 `--tone/--tone-bg/--tone-text`（tone-* 类）原样保留，仅换色值。

### 1.5 字体 / 字阶 / 行高 / 字距

| 变量 | 值 | 用途 |
|---|---|---|
| `--font-ui` | `-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', sans-serif` | 不动（零网络字体） |
| `--font-mono` | `ui-monospace, 'SF Mono', 'JetBrains Mono', 'Cascadia Mono', Consolas, monospace` | 数据；tnum 全局保留 |
| `--fs-12 / 13 / 14 / 16 / 20 / 24 / 28` | 12/13/14/16/20/24/28px | 辅助元 / 次级正文·按钮 / 正文（命中标题·输入值） / 组头·state-pill / 分区小节题·日报卡头 / **页题** / **KPI 大数字** |
| ~~`--fs-15`~~ | 并入 16；别名层过渡 | 现状 `var(--fs-15)` 引用 5 处，**逐处落定目标值（禁机械套 16）**：styles/primitives.css:6 `.group-head`→**16**（共享层/阶段0）、styles/dashboard.css:71 `.state-pill`→**16**（§2.4 状态 pill 16/600）、styles/dashboard.css:110 `.metric .v`→**28/700 mono（例外：KPI 大数字，按 §3.1，不套 16）**、styles/events.css:162 `.report-title`→**20/700（例外：日报日题，按 §3.2，不套 16）**、styles/events.css:281 `.doc-h2`→**16**。各领域负责人按本列目标值替换，五处全部清零后阶段收尾删别名行 |
| `--lh-display` | 1.15 | 仅 24/28 档 |
| `--lh-tight / base / read` | 1.3 / 1.5 / 1.7 | 继承 R10 选档规则 |
| `--lh-chip` | 18px | 徽标像素行高（绑 fs-12，9→10px 圆点配 18） |
| `--ls-display` | `-0.015em` | 仅 ≥20px 标题与数字 |
| `--ls-label` | `+0.05em` | 仅拉丁/数字 12px micro-label（中文正文禁加） |

字重映射（仅 400/500/600/700）：正文 400；按钮/标签/来源名 500；卡题/组头/state-pill/nav-active/metric-k→ 600；**700 档全应用只授权三处 display 层：页题 24/700、日报卡头日题 20/700、KPI 数字 28/700**（这是 §4.4 验收线，任何第四处 700 均判违规）。

### 1.6 圆角 / 间距 / 阴影 / 动效

| 变量 | 值 | 备注 |
|---|---|---|
| `--r-card` | **14px** | 卡/浮层（旧 12→14，与控件档拉开） |
| `--r-ctl` | **10px** | 按钮/输入/实体行（旧 8→10） |
| `--r-pill` | 999px | chip/pill/badge/live-pill |
| `--space-xs..3xl` | 2/4/8/12/16/24/32px | **整组继承不动**（density 8 检索确认） |
| `--shadow-sm` | 浅 `0 1px 2px rgba(15,23,42,.06), 0 2px 4px rgba(15,23,42,.05)` / 暗 `0 1px 2px rgba(0,0,0,.5)` | 双层 key+ambient |
| `--shadow-md` | 浅 `0 4px 10px rgba(15,23,42,.08), 0 2px 4px rgba(15,23,42,.05)` / 暗 `0 4px 12px rgba(0,0,0,.55)` | hover/下拉 |
| `--shadow-lg` | 浅 `0 14px 32px rgba(15,23,42,.14), 0 4px 10px rgba(15,23,42,.07)` / 暗 `0 16px 40px rgba(0,0,0,.6)` | 浮层 |
| `--shadow-xl` | 浅 `0 28px 56px rgba(15,23,42,.20), 0 8px 18px rgba(15,23,42,.10)` / 暗 `0 28px 64px rgba(0,0,0,.65)` | 吸底保存栏 |
| `--edge-top` | 浅 `inset 0 1px 0 rgba(255,255,255,.7)` / 暗 `inset 0 1px 0 rgba(255,255,255,.06)` | 暗色顶缘发丝光（质感核心，新 token） |
| `--t-fast` | 120ms | 颜色/描边 |
| `--t-base` | 180ms | 背景/小位移 |
| `--t-glide` | **280ms**（新） | 展开/折叠/页面级 |
| `--ease-out` | `cubic-bezier(.22,1,.36,1)` | 入场/展开 |
| `--ease-std` | `cubic-bezier(.4,0,.2,1)` | 属性过渡 |
| `--hit` | 44px | 继承（桌面等效间距口径不变） |

---

## 2. 共享组件规范（改一处 → 五页受益；样式已拆分，改哪个文件以 §2.0 归属映射为唯一依据）

### 2.0 样式文件归属映射（owner 边界，防四个领域工程师重复改/改错文件）

| 文件 | 内容 | Owner（改动责任域） |
|---|---|---|
| `theme.css` | 全部令牌 + 别名层 | **共享层（阶段 0，先行冻结）** |
| `global.css` | 仅 @import 聚合（16 行），**禁写规则** | 无人（不动） |
| `styles/base.css` | body/reset/滚动条/全局排版 | 共享层 |
| `styles/primitives.css` | 卡（`.card-head:181`）、按钮族（`.btn:277` `.btn-primary:335` `.btn-danger:347`）、实体行（`.entity-row:30`）、空态（`.empty:239` `.empty-state:248`）、错误条基础（`.errorbar:774`）、组头（`.group-head:6`）、tone 下发 | 共享层 |
| `styles/shell.css` | 侧栏/品牌（`.brand-name:39`）/nav/rail | 共享层 |
| `styles/settings-core.css` | 设置骨架/snav/骨架屏（`.set-skel,.skel:159-160`）/保存栏 | settings 域 |
| `styles/dashboard.css` | 状态卡（`.state-pill:65` `.metrics:87` `.pending-row:240`）、`.live-pill:590`、日志 | dashboard 域 |
| `styles/events.css` | 去向/历史/日报三页；含 `.errorbar` 上下文覆盖（:39 `.report-rail >`、:1078 `.card-grow >`）与 `.empty` 覆盖（:267） | events 域 |
| `styles/settings-monitor.css` / `settings-notify.css` | 设置子域卡 | settings 对应子域 |

**冲突裁决规则**：①共享色/阴影/圆角/字阶一律只改 `theme.css` + `base/primitives/shell`；领域文件只引用 token、零 hex。②基础组件（errorbar/empty/btn/card）需要改基础观感时**只改 primitives 定义处**——events.css 等文件里的 `.xxx > .errorbar` 是加_scope_ 的上下文覆盖（margin/位置），不得在领域文件重定义同一基础属性；改后上下文覆盖自动继承。③`--fs-15` 别名行（§1）由共享层加、各领域清自己文件。

1. **按钮族**：`.btn`（次级：`--card` 底 + `--input-border` 描边 + 500 字重 + `--r-ctl`，hover `--card-alt` 底 + 描边升 `--text-3` + `--shadow-sm`）；`.btn-primary`（底 `--btn-primary-bg` + 字 `--color-on-primary`——浅=深翠底白字 5.48、暗=翡翠底深墨字 7.71，禁硬编码白；hover 更深/提亮一档 + `--shadow-md`，active `translateY(.5px)`+去阴影——按压反馈走阴影不走路移）；`.btn-danger`（err 55% 描边 + `--err-text`，hover 上 `--err-chip`）；busy 转圈、disabled `opacity:.45` 机制原样保留。尺寸档：sm(28h)/md(32h 默认)/lg(40h，保存栏/确认用)。同一视图至多一个实底主按钮（红线继承）。
2. **输入族**：`.input`/`textarea`/`.tags`：14px 正文、`--r-ctl`、内凹感=1px `--input-border` + `inset 0 1px 2px rgba(15,23,42,.06)`（暗 `inset 0 1px 2px rgba(0,0,0,.4)`）；focus 边框升 `--ring` + 外环 2px（`.input:focus-visible` 现走自有样式的路子不变）；禁用态底色 `--card-alt` + 字 `--text-3`。mono 输入（URL/JSON）保持。滑杆 `accent-color: var(--color-primary)`。
3. **卡片**：`--card` 底 + 装饰 `--color-border` 1px + `--r-card` + `--shadow-sm` + `--edge-top`；卡头（`.card-head`）底边换 `--line` 并加 `--card-alt`/暗 `#111A2B` 的极浅头带（`background: color-mix(in srgb, var(--card-alt) 60%, transparent)`）拉开头/身两级；卡题 14/600、aux 12/`--text-3` 结构不动。`.metrics`/`.substatus` 井格：缝隙 `1px` 背景换 `--line`，井底 `--card-alt`，圆角 `--r-ctl`。
4. **chip / pill / badge**：三型——状态 pill（`--tone-bg` 底 + `--tone-text` 字 + 点 + `--r-pill`，state-pill 用 16/600）、outcome 徽标与来源 badge（`--tone-chip` 底 + `--tone-text` 字 12px + `--lh-chip`）、关键词 chip（`--mute-chip` 底 + `--text-2`；品牌绿 chip 唯一用 `--primary-wash` 档不新增第二档——继承）。描边一律 `color-mix(--tone 40%, transparent)`。全部 nowrap。
5. **导航**：主侧栏=墨轨：rail 族 token；nav-btn 字 `--rail-fg-2` 500、hover `rgba(255,255,255,.06)` 底 + `--rail-fg` 字、active `--rail-active-bg` + `--rail-fg` 字重 **600** + 左 `--rail-bar` 3px 竖条（`::before`，与 snav 同语言）；brand 区放大：IconRadar `--rail-bar` 色 22px + brand-name 15/**600** `--rail-fg`（旧 brand 是 text-2 灰，R11 品牌进轨；现状 shell.css:40 的 700 降 600——700 档只留给 §1.5 三处 display 位）。设置子导航 `.settings-nav`：`--raised` 底 + `--shadow-md`；`.snav-item.active` 保持 wash+竖条语言但字重 600、加 `--r-ctl`。
6. **表格/列表行**（HitRow/EntityRow/DispositionRow/日志行）：行分隔 `--line`；hover `--primary-wash`；选中行左 3px `--color-primary` 竖条 + wash；键盘选中行（`data-hit-index`）焦点态 2px `--ring` inset；「待删除」态=删除线 + `--warn-text` 徽标 + 行底 `--err-chip`（保留 R10 语义）。行内按钮组（ent-btn）尺寸档 sm。时间戳列 mono 12 `--text-3` 右对齐。
7. **空/错误/加载态**：EmptyState 插画色 `--text-3` + 新增外圈 `--card-alt` 圆盘底（给空洞一个「容器感」，纯装饰豁免对比度）；ErrorBar 用 `--err-chip` 底 + `--err-text` + 1px `--err` 45% 描边 + `--r-ctl`；骨架 `.skel` 底 `--card-alt` + shimmer 一次性淡入（不循环）；live-pill 角标 `--btn-primary-bg` 实底 + 字 `--color-on-primary`（旧绿描边浅底版升为实底强提醒，`role=status` 语义不动）。

---

## 3. 逐领域指引

### 3.1 dashboard（监控台：实时状态 + 命中流 + 日志）
- **版式重点**：页头页题 24/700/`--ls-display` + 副题 13/`--text-3` 一行距收紧；状态带是全屏视觉锚：state-pill 升 16/600、四格指标数值 **28/700 mono**（井格底 `--card-alt`），「页题 24 ↔ 元信息 12 ↔ KPI 28」三级响度差 = R11 的核心对比。
- 命中流卡：hit-title 14/500、来源 chip + 时间 mono 12、投票按钮 hover wash；卡 `flex:1.4` 视口高布局不动。日志面 `--card-alt` 井 + mono 12 行、级别 chip 组走 tone 三档。
- 操作条（subactions）与挂起行（pending-row）视觉不动结构、只换档：pending 行弱底 `--warn-chip` + 左 3px `--warn` 条。
- 深度：整页卡 `--shadow-sm`，日志/命中两长卡加 `--edge-top`；stagger 入场 240ms ≤8 行。

### 3.2 events（去向 / 历史命中 / 日报）
- **去向**：筛选 chips 组=「小控件带」语言（`--raised` 底条 + 内嵌 chips）；outcome 徽标三档族严格执行；行展开=内嵌 `--card-alt` 井（缩进 24px、`--r-ctl`），轨迹「已挂起→已推送」用 mono + tone 点。
- **历史命中**：Z1 统计画像=四指标 28/700 + sparkbar 柱 `--color-primary`（hover 柱 `--ok-text`）；口径 aux 徽标 12/`--text-3`；Z2 列表吃高内滚结构不动。
- **日报**：阅读面是唯一「松」区：正文列 560px、14px、`--lh-read 1.7`；卡头两级=日题 20/700 display 距 + 元信息 mono 12；日期栏选中=实底 `--btn-primary-bg` 圆片 + 字 `--color-on-primary`（今日/选中一眼可辨）；markdown 渲染 h1 上提、模板行结构化样式同 wash 语言。

### 3.3 settings-monitor（来源 / 关键词 / 价格规则 / 匹配类卡）
- 实体行摘要 = `entity-row` 语言：启停开关在左、名称 500、摘要 mono 12；**展开编辑区**是 R11 质感位：`--card-alt` 井 + 1px `--color-border` + 内阴影，字段行左标签 13/500 右控件。
- KeywordTagInput chip：`--mute-chip` 底、hover 出现 ✗；重复词抖动样式不动只换色。路由规则序号列 mono 16/600 + `--ls-label`（顺序=优先级的响度提示）。
- 待删除/撤销/折叠「展开全部」三态语言同 §2.6。warn-strip 零配置警示：`--warn-chip` 底 + 左 3px `--warn`。

### 3.4 settings-notify（通知 / 数据 / 运行 / 系统类卡）
- 通道行 tone 点（就绪 ok / 降级 warn / 失败 err）+ 通道名 500 + 状态 mono；测试按钮反馈三色（ok/err/pending）档不变只换值。
- 数据卡：导入/导出确认条=行内 danger 语言（`.btn-danger-solid` 底改 `--danger-solid-bg`（两模式 `#DC2626`，不再吃 `--err`——暗点档上白字仅 2.77:1，§1.3）+ 字 `--on-danger`（`#FFFFFF` 4.83:1），与 primary 绿明确区分，两按钮永不邻位同强）。
- **吸底保存栏**：`--raised` 底 + `--shadow-xl` + `--edge-top`（R11 的「托盘上漂浮的控件条」）；组头 16/600、卡题 14/600、标签 13/500、hint 12/`--text-3` 四级节奏继承。
- 关于卡：版本 mono、logo 走 `--color-primary`。

---

## 4. 不可违反的纪律（验收逐条对）

1. **双模式全走 CSS 变量**，暗色整组覆盖；组件零硬编码 hex；rail 与 tone 暗档只在变量层出现；一切实底色块（primary/danger/live-pill/日期圆片）文字只走 `--color-on-primary`/`--on-danger` 变量，禁写 `white`（暗翡翠底上纯白仅 1.92:1，§1.3 警示）。
2. **对比度**：文字 ≥4.5:1、图形/UI ≥3:1；本表数字为本 session 实算结果，**新色对（含一切 `color-mix` 派生值）接入时按 WCAG 公式复测，不得沿用现成数字豁免**。
3. **`:focus-visible` 2px 环常显**（offset 2px），浅 `#047857`/暗 `#34D399`，墨轨上 `--rail-bar`；输入类自有 focus 样式不叠加。
4. **字重只用 400/500/600/700**；700 只授权三处 display 位——页题 24、日报卡头日题 20、KPI 数字 28（§1.5）；其余一律 ≤600，**brand-name 现值 700（shell.css:40）降 600**；禁 650（PingFang/雅黑漂移源，继承）。
5. **等宽数字**：全局 tnum；时间戳/计数/KPI/日志一律 mono 栈。
6. **零外部资源**：不引字体、不引图标库、不引 CSS 框架（检索建议的 Fira/Inter/Orbitron/Google Fonts @import 一律不采纳，只取手法）。
7. **色不单用**：tone 必须 点+文字（+图标）同现；透明度禁压语义文字（禁用态/待删除态是状态语义本身，豁免继承）。
8. **动效**：过渡 120–300ms 用 §1.6 档；无限循环为 0（busy 转圈豁免）；禁 back.out 回弹；`prefers-reduced-motion` 直渲终态；窗口隐藏停动画与定时刷。
9. **hover 不移位**：反馈走颜色/阴影/内阴影；禁 scale/translate 布局位移与 opacity 变淡式弱化。
10. **结构红线**：§0 全部；另继承 边界两档/输入独立边界/tone 三档族/`--hit 44`/至多一个实底主按钮/错误≠空/活列表阅读优先/keep-alive 与既有 IA（五页命名、设置六组、184px 侧栏宽）。
11. **落地复测清单**（实施阶段必做）：rail-active 混色底上的文字、`--primary-wash` 混色底上的各级文字、浅卡头带混色、danger 实底 hover、`color-scheme` 原生控件（滑杆/单选/滚动条）在深轨旁的观感。

*本简报为设计交付：未运行应用与任何构建/测试命令（工作流统一执行）。*

---

# R12 修订：明亮大气方向（覆盖 R11 冲突条款，本域唯一依据）

**用户裁决输入**：「配色不好看，整体太黑了，我需要大气美观的，软件的排版布局也需要改变」。

**方向一句话**：「霁蓝平台（Clear-Blue Deck）」——雾白纸面 + 纯白大圆角卡 +  azure 蔚蓝品牌 + 柔和大扩散阴影 + 亮色侧栏 pill 导航 + 内容限宽居中；暗色改柔和深灰蓝（非纯黑墨）。R11 的「两模式恒深墨轨」条款（§1.2、§2.5 轨内语言）**整条废除**，其余 R11 纪律（零硬编码色值、tone 三档族、字重四档、对比度线、动效档、hover 不移位）继续有效。

## R12.0 检索依据（ui-ux-pro-max 实跑，本 session）

- `--domain style "premium light saas dashboard spacious elegant"` → **minimalism-and-swiss**（spacious/white space/grid-based，Enterprise dashboards/SaaS 首选；hover 200–250ms）+ **bento-box-grid**（Apple 风：页面底 #F5F5F7、纯白卡、rounded-xl 16–24px、柔和大扩散阴影 `0 4px 6px rgba(0,0,0,.05)`——R12 卡面与页面底语言的直接依据）+ **data-dense-dashboard**（中性浅灰白底、行 hover、KPI 卡——工具密度保留）。
- `--domain style "soft shadow depth elevation light ui"` → **dimensional-layering**：4 级 elevation 全部改为「低透明度 + 大模糊半径」的柔和扩散档。
- `--domain color "light airy professional palette blue"` → **B2B Service 板**（bg #F8FAFC / card #FFF / border #E2E8F0 / muted-fg #475569 / 藏蓝+蓝 CTA）与 **CRM 板**（primary #2563EB、bg #F8FAFC、ring #2563EB）——R12 基础面与品牌相位取蓝（emerald 降格为仅 ok 语义绿，不再作品牌色）。
- `--design-system "desktop monitoring tool light professional spacious data"` → Style=Minimalism & Swiss（spacious/essential）、避免项「Slow dashboards + hidden error states」；字体建议 Inter/Fira 不采纳（零网络字体红线），只取手法。
- `--domain ux "focus appearance" / "color contrast"` → 焦点环 ≥2px 周长对比 ≥3:1；文字 ≥4.5:1——全部色对本节数字为 python WCAG 实算。

## R12.1 令牌终值表（theme.css 已照此重写；组件层零硬编码）

命名全部沿用 R11（含旧名别名层），**新增** `--primary-text`、`--fs-26`、`--fs-32`、`--fs-22`、`--space-4xl`、`--content-max`；**删除** `--fs-15` 别名（现状代码引用已清零，领域文件不得再引，需要落 16 档）。`--rail-*` 名称保留但语义改「亮轨」。

### 基础面与文字

| 变量 | 浅色 | 暗色 | 用途（实算） |
|---|---|---|---|
| `--color-background` / `--bg` | `#F6F8FC`（雾白冷调） | `#1E252F`（深灰蓝） | 窗口底 |
| `--color-card` / `--card` | `#FFFFFF` | `#262E3A` | 卡面 |
| `--card-alt`（=`--color-muted`） | `#EEF2F8` | `#2F3947` | 嵌井/内嵌面 |
| `--raised` | `#FFFFFF` | `#333F50` | 浮层/吸底栏 |
| `--color-foreground` / `--fg` | `#17222E` | `#E9EEF5` | 主文字（浅 16.10 白底 / 暗 11.74 卡底） |
| `--text-2` | `#4A5A6E` | `#A7B4C4` | 次要（7.05 / 6.50） |
| `--text-3` | `#5D6C83` | `#99A8BA` | 辅助元信息（浅 5.33 白底 / 4.75 card-alt；暗 5.65 / 4.82） |
| `--line` | `#E3E9F1` | `#38455A` | 功能分隔线（比 R11 明显转浅：线条让位于留白与阴影） |
| `--color-border` | `#D9E1EC` | `#435168` | 卡外缘装饰描边（纪律不变：不承载分隔/输入语义） |
| `--input-border` | `#7B8CA1` | `#8FA0B5` | 输入边界（3.44 / 5.13，UI≥3） |
| `--ring` | `#1D4ED8` | `#7FB2F8` | 焦点环（6.70 / 6.27） |
| `--scroll-thumb` | `#C9D4E2` | `#3A465A` | 滚动条 |
| `:root { color-scheme: light dark }` | — | — | 原生控件跟随（R12 起写进 theme.css，不再依赖 index.html） |

### 品牌与主按钮（emerald → azure；绿只留 ok 语义）

| 变量 | 浅 | 暗 | 实算 |
|---|---|---|---|
| `--color-primary`（图形档：点/描边/选择条/accent-color/图标强调） | `#2563EB` | `#6BA8F5` | 5.17 白底 / 5.57 卡底（≥3） |
| `--btn-primary-bg` | `#1D4ED8` | `#6BA8F5` | 实底按钮 |
| `--color-on-primary` | `#FFFFFF` | `#0B1B2E` | 6.70 / 7.06——实底文字仍禁硬编码 white |
| `--hover-primary-bg` / `--hover-primary-fg` | `#1E40AF` / `#FFFFFF` | `#8FBEF9` / `#0B1B2E` | 8.72 / 深墨 |
| `--primary-text`（**新**：wash 底上的强调文字/图标） | `#1D4ED8` | `#6BA8F5` | 6.02 on 浅 wash（#EEF3FD） |
| `--primary-wash` | `color-mix(in srgb, #2563EB 8%, transparent)` | `color-mix(in srgb, #6BA8F5 14%, transparent)` | 唯一品牌透明底档：行 hover/选中/quick-active/卡选中共用；fg on 浅 wash 14.47 |
| `--danger-solid-bg` `#DC2626` 两模式 · `--on-danger` `#FFFFFF`（4.83）· `--hover-danger-bg` `#B91C1C` | 同 R11 | — | 不变 |

### 语义 tone 族（三档结构、语义映射不变；品牌绿让位后 ok 仍是「运行/成功」绿）

| 族 | 点（浅/暗） | 文字（浅/暗） | 弱底（浅/暗） |
|---|---|---|---|
| ok | `#16A34A` / `#3ECF8E` | `#15803D` / `#3ECF8E` | `#DCFCE7` / `#0E2A22` |
| err | `#DC2626` / `#F87171` | `#B42318` / `#F87171` | `#FEE4E2` / `#3A161B` |
| warn | `#B45309` / `#FBBF24` | `#92400E` / `#FBBF24` | `#FDECC8` / `#33270F` |
| ai | `#7C3AED` / `#B79CF7` | `#6D28D9` / `#B79CF7` | `#EDE9FE` / `#241B3F` |
| mute-chip | `#E9EEF5` / `#2A3341`（文字 `--text-2`，6.05 / 6.05） | | |

全对 ≥4.5:1 文字（text-on-chip 实测 ok 4.57 / err 5.45 / warn 6.08 / ai 5.98，暗档 5.79–8.75）。

### 亮轨侧栏（替代「墨轨」；名称保留、语义翻亮）

| 变量 | 浅 | 暗 | 用途 |
|---|---|---|---|
| `--rail-bg`（=`--bg-sidebar`） | `#FBFCFE` | `#1A212C` | 侧栏面（浅=亮于窗口底一档的白面；暗=比内容底更深一档的灰蓝，均非纯黑） |
| `--rail-fg` | `#17222E` | `#E9EEF5` | 轨内主文字（15.68 / 14+） |
| `--rail-fg-2` | `#54637A` | `#93A2B6` | 轨内次要（5.94） |
| `--rail-bar` | `#2563EB` | `#6BA8F5` | 品牌强调（图标/选中 icon） |
| `--rail-active-bg` | `color-mix(in srgb, #2563EB 10%, transparent)` | `color-mix(in srgb, #6BA8F5 16%, transparent)` | nav 选中 pill 底 |
| `--rail-hover` / `--rail-press` | `#EDF1F7` / `#E1E8F2` | `rgba(255,255,255,.05)` / `.09` | 轨内按压底 |
| `--rail-line` | `#E7ECF4` | `rgba(255,255,255,.08)` | 轨内分隔线 |
| `--rail-tone-ok/err/warn/ai` | = 当模式 tone 点档（浅即浅档、暗即暗档） | | 轨内状态点（亮轨上绿点用 #16A34A 3.30≥3，不再是暗档） |

### 字阶 / 间距 / 圆角 / 阴影 / 动效（「大气」的数值落点）

| 变量 | 值 | 备注 |
|---|---|---|
| 字阶 | `12 / 13 / 14 / 16 / 20 / 22 / 24 / 26 / 28 / 32`（`--fs-22/26/32` 新增） | 标题从容：页题 **26/700**、日报日题 **22/700**、KPI **32/700 mono**；正文舒适：副题/输入/正文带 14；组头 16/600、卡题 14/600 不变。700 仍只授权页题/日题/KPI 三处 display 位 |
| `--lh-display` | 1.2 | 26/28/32 大标题（1.15→1.2，从容不迫） |
| `--space-4xl` | **48px（新）** | 页头与内容带、组间大距 |
| `--content-max` | **1200px（新）** | 内容限宽：`.page` 用 `padding-inline: max(var(--space-2xl), calc((100% - var(--content-max)) / 2))` 居中，宽窗不吃灰 |
| `--r-card` | **16px**（14→16） | bento 大圆角卡 |
| `--r-ctl` | **12px**（10→12） | 按钮/输入/pill 行 |
| `--shadow-sm` 浅 | `0 1px 2px rgba(22,34,52,.05), 0 1px 3px rgba(22,34,52,.06)` | 卡常态 |
| `--shadow-md` 浅 | `0 2px 6px rgba(22,34,52,.05), 0 8px 24px rgba(22,34,52,.08)` | hover/下拉 |
| `--shadow-lg` 浅 | `0 4px 12px rgba(22,34,52,.06), 0 16px 40px rgba(22,34,52,.12)` | 浮层 |
| `--shadow-xl` 浅 | `0 8px 20px rgba(22,34,52,.08), 0 28px 64px rgba(22,34,52,.16)` | 吸底保存栏（大扩散低透明度=「柔和不发脏」） |
| 暗档阴影 | sm/md/lg/xl 单层 `rgba(6,10,18,.40/.45/.50/.55)`，半径同浅 | 深灰蓝上阴影退居兜底 |
| `--edge-top` | 浅 `inset 0 1px 0 rgba(255,255,255,.85)` / 暗 `rgba(255,255,255,.05)` | 保留 token（events.css 在引），亮面近乎无感即可 |
| `--t-base` | **200ms**（180→200） | Swiss/Minimalism 检索档 200–250ms；`--t-fast 120 / --t-glide 280` 不变 |

## R12.2 壳层与新导航布局规则（shell.css/App.tsx）

1. **亮色侧栏 + pill 导航（布局主改点之一）**：侧栏宽 184→**216px**（留白档），`--rail-*` 亮面 + 右缘 1px `--line`。brand 区改「图标砖」语言：36px 圆角 12 磁贴（底 `--primary-wash`、IconRadar `--color-primary` 20px）+ 品牌名 16/600 `--rail-fg` + 副标 12 `--rail-fg-2`。
2. **nav 选中语言 = pill**：`.nav-btn` 14px/500 `--rail-fg-2`、min-height 44、radius `--r-ctl`；hover `--rail-hover`；active = `--rail-active-bg` + `--rail-fg` 600 + 图标 `--rail-bar`。**导航不再用左 3px 竖条**——竖条语言专属数据行（R12.3 裁决 2），两套语言就此分家，避免「到处都在画左条」。
3. **内容区限宽居中**：`.page` 上下 padding 升档（顶 24、底 40），左右 `max(24px, calc((100% - 1200px)/2))`；窄窗仍保 24px 呼吸。
4. **页头大标题带副题**：`.page-title` 26/700/`--ls-display`；副题升 **14px `--text-2`**（旧 13/text-3——「副题也是内容」）；`--pagehead` 与内容带的间距由页面自身 flex gap 承担（共享层不加 margin，防双距）。
5. **设置页**：Zone A 子导航去卡片化——200px 列、透明面、条目 pill 与主 nav 同语言（active wash+fg 600，无竖条）；`.settings-col` 限宽 680→**760px**；组间 32 不变、卡内边距随 primitives 升档；保存栏/离开条圆角随 `--r-card/--r-ctl` 自动放大。
6. 保留结构红线：五页命名与顺序、keep-alive、设置六组、Cmd/Ctrl+1..5、层叠纪律 100/98/95。

## R12.3 三条跨域裁决（简报为准 + 共享层已落地）

1. **`.radios-card` 唯一定义在 `styles/primitives.css`**（嵌井承托 + hover 提亮 + 选中 `--primary-wash` + `--color-primary` 描边与左 3px 条 + 选中题色 `--primary-text` + 焦点环上卡），三卡（MatchModeCard/NotifyCard/ProxyCard）只挂类不再落定义。**各领域应确保自己文件里没有副本**（现状复查：settings-monitor.css 与 settings-notify.css 的旧副本已不在，仅剩指引注释；若你的工作树里又出现同名定义，删除并改回 primitives）。
2. **键盘/鼠标「选中行」统一语言 = `.row-selected`**（primitives.css 新规范类）：`--primary-wash` 底 + 左侧 3px `--color-primary` 条 + 内衬 1px `color-mix(--ring 35%)` ring，全用 box-shadow 实现不改盒模。HitRow 已挂该类（`hit selected row-selected`）；dashboard 的 `.hit.selected` 与 events 的 roving 行请**收敛为给行加 `row-selected` 类**，删除各自 wash+条+ring 的重复定义（上下文专属的非本语言属性可保留在领域文件）。
3. **「有未保存修改」两模式统一琥珀（`--warn` 档），禁红**：侧栏 `.dirty-dot`（改 `--warn`，不再用轨内暗档专属变量）、设置子导航 `.snav-dot`、保存栏 `.sb-status.dirty`（`--warn-text` 600）、`.leavebar`（`--warn-chip` 底 + 左 3px `--warn`）全部落 warn 族；红只留给「事件/失败」。注意区分：**「待删除」行底仍用 `--err-chip`**（那是删除语义不是 dirty 语义），配套「待删除」徽标仍是琥珀。

## R12.4 领域页面版式指引（各域按此调自己的 css/tsx）

- **dashboard**：KPI 数值 `--fs-32/700 mono`（从 28 升档）；state-pill 保 16/600 但字色走 tone 文字档 + `--tone-bg` 底；命中流行距升一档（行 min-height ≥44、行内 gap 走 `--space-md` 以上）；页头副题改 14/text-2 由 PageHeader 自动生效，域内勿再覆盖字号。
- **events（去向/历史/日报）**：历史 Z1 四指标同 32 档；日报日题升 **22/700**（`--fs-22`），阅读列宽 560→**640px** 更从容；展开井 `--card-alt` + `--r-ctl`（自动 12）；roving 选中行接 `.row-selected`。
- **settings-monitor / settings-notify**：`.field` 栅格左列 148→**168px**（共享层已改，勿在域内重复覆盖）；实体行摘要列与操作列间距走 `--space-md`；确认条/警示条全部 tone 化，**dirty 类一律琥珀**；域内如有硬编码 `padding: 8px 12px` 一类旧紧凑档，按「卡内边距升档」调到 16/20。

## R12.5 交接备忘（领域工程师必读）

- 令牌**只换值不换名**，你不需要改名就能吃到新配色；新增可选令牌：`--primary-text`（wash 上强调文字，代替原「wash 上用 ok-text」的写法——**绿让位蓝**，域内凡「品牌透明底上的文字」请改用它）、`--fs-22/26/32`、`--space-4xl`、`--content-max`。
- `--fs-15` 别名已删：代码引用现状为零，若你的 diff 里还有 `var(--fs-15)`，按语义改 16 或对应新档。
- `.radios-card`、`.row-selected`、输入/按钮/卡片/错误条/空态的基础观感都已在 primitives 重做：**删掉域内的同属性覆盖**，只留上下文（margin/宽度）类差异。
- 侧栏/导航已翻亮：域内不得再引用「轨内恒深」假设（该概念不存在了）；`.sidebar` 内 tone 点变量仍走 `--rail-tone-*`（值已改为当模式点档）。
- 悬空自查建议：改完后 grep 自己文件里的 `var(--`，与 theme.css 定义表对一遍；新色对（含一切 `color-mix` 派生）落地前按 WCAG 复测，不得沿用本节数字豁免。

## R12.6 勘误:共享层对比度修复（领域复核 4 项 + 连带 1 项,终值覆盖 R12.1 对应行）

领域工程师复核实算出 4 个令牌/共享层问题,共享层裁决如下（python WCAG 实算;theme.css/primitives.css 已同步落地）:

| # | 令牌 | 旧值→**新值** | 病灶与终算 |
|---|---|---|---|
| 1 | 暗 `--primary-text` | `#6BA8F5` → **`#8FBEF9`** | 旧值在 card-alt 承托的 wash 上 3.75<4.5。新值 wash/card 5.74、wash/alt 4.98、wash/raised 4.90、card 7.10、raised 5.97——全链 ≥4.5。影响 primitives `.chip`/`.ent-btn.active`/`.quick .btn.active`/`.radios-card` 选中题,自动生效 |
| 2 | 暗 `--err-text` | `#F87171`(与点档同值) → **`#FCA5A5`(文字档自点档分离)** | 旧值 card-alt 4.22、raised(旧) 3.86。新值 card 7.21、card-alt 6.16、raised 6.06、err-chip 8.44、wash/card 5.82、wash/alt 5.06。点档 `--err` 保持 `#F87171`(图形 ≥3 域,raised 上 3.86≥3)。中间档 `#FA8585` 被否:在选中行 wash/alt 上 4.0<4.5(「推送失败」红字会落在选中行内) |
| 3 | 暗 `--primary-wash` | 14% → **12%** + **wash 文字收口规则** | 14% 底(card-alt 承托 #37495F)上连 text-2 都只剩 4.37——问题在 wash 太亮而非 text-3 太暗;text-3 在 ≤10% 的任何 wash/alt 上仍 3.96~4.09 救不回。裁决:**规则** =「wash 底最低文字档 `--text-2`,禁 text-3;wash 不叠铺 `--raised` 浮层」。12% 下 text-2/card 5.25、text-2/alt 4.56、fg 8.23~9.48、primary-text 4.98~5.74 全过。共享层已代偿:`.row-selected` 与 `.radios-card` 选中态内部 `--text-3: var(--text-2)` 局部 remap,域文件零改动即达标;各领域自查「wash/hover 底上的 text-3」场景(如 hover 行内 meta)按同规则处理 |
| 4 | 浅 `--ok` 点档(含 `--rail-tone-ok`) | `#16A34A` → **`#128A3E`** | 旧值 card-alt 2.93<3(.src-dot 类)。新值白 4.44、card-alt 3.95、ok-chip 4.04、rail-bg 4.32、wash 3.57~3.99——图形档全 ≥3;与文字档 `--ok-text #15803D` 保持一档差。**不采豁免**:有文字同现只是兜底,点档自己达标更干净 |
| 5 | 暗 `--raised`(连带) | `#333F50` → **`#303A49`** | 修 ①②③ 时自查发现 text-3 在 raised 上 4.40<4.5(`.sb-status.pending` 在用)。提亮 text-3 会挤掉与 text-2 的层级差,裁决 raised 加深一档:text-3 4.74、text-2 5.46、fg 9.86、primary-text 5.97、err-text 6.06 全过;card→raised 提亮 ΔL 0.0146 仍有可感层级(浮层另有 lg/xl 阴影兜底) |

R12.1 表中暗档 `--primary-text`/`--err-text`/`--primary-wash`/`--raised` 与浅档 `--ok`/`--rail-tone-ok` 各行的旧值以本节为准作废。
