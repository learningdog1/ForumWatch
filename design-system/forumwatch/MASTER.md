# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** ForumWatch
**Generated:** 2026-09-20 16:25:18（--design-system --variance 6 --motion 4 --density 8）
**Revised:** 2026-09-20 R11 人工裁决（本文件在生成物之上落定终值；与 `design/r11/DESIGN-BRIEF.md` 同源，冲突以本文件为准）
**Category:** Status Page / Incident Management（桌面监控台，非营销落地页）
**Design Dials:** Variance 6/10 (Balanced / Modern) | Motion 4/10 (Standard) | Density 8/10 (Dense / Dashboard)

---

## R11 改动理由（vs R10 旧版 MASTER / theme.css）

用户裁决：「这个软件设计的太难看了……大刀阔斧优化」——R10（运营绿 #16A34A、Variance 3、扁平）虽体系严谨，但「绿相染满一切」（薄荷底 #F0FDF4 + 绿装饰边 + 绿相灰 + 单一 12-20 字阶 + 无深度）导致整体发闷发灰、缺乏结构与质感。R11 保持「高密度桌面监控工具」定位不变，做六个可肉眼辨识的拉差：

1. **表面去染色**：浅色底从薄荷绿 `#F0FDF4` 改为冷纸灰白 `#EEF1F5`，灰族从「绿相 150–155°」改为**蓝相 slate**（与暗色版既有 slate 族 #94A3B8 统一语言）。旧 TASTE-UPGRADE §A-2「禁蓝相灰」**废止**——它本就与暗色版自相矛盾。品牌绿降格为「信号色」：只出现在状态点/强调/选择条，不再染表面。
2. **双表面体系（Ink Rail）**：侧栏两模式恒为深墨轨 `#131A2A`/`#0B1220`（Linear/Raycast 系开发者工具语言），与内容区形成最强结构对比。这是与 R10 肉眼差距最大的一处。
3. **三级表面 + 真阴影**：bg → card → raised 三档表面 + 双层 key+ambient 阴影 + 暗色顶部发丝高光（`--edge-top`），替换 R10 的「白卡浮在绿底」单一层次。
4. **字阶对比拉满**：5 档（12/13/14/15/20）扩为 7 档 **12/13/14/16/20/24/28**——页题回 24px/700，KPI 数字回到 28px/700 mono（R10 删除的 fs-28 复活并落到实处），配 display 负字距；15 并入 16（别名层过渡，见 Typography）。700 档全应用只授权三处 display 位：页题 24 / 日报日题 20 / KPI 28。
5. **品牌绿换相位**：黄相 green `#16A34A` → 蓝相 emerald（图形 `#059669` / 文字 `#047857` / 暗色 `#34D399`）。语义约定「绿=运行、红=事件、琥珀=中间态、紫=AI」继承不变（不触文案）；主按钮文字改按模式走 `--color-on-primary`（浅=深翠底白字 5.48:1、暗=翡翠底深墨字 7.71:1；旧「绿底黑字」废除。**禁硬编码 white**——纯白 on 暗档 `#34D399` 仅 1.92:1）。
6. **Motion 2 → 4**：新增 `--t-glide 280ms` 面板/展开档与行入场 240ms 上移淡入（一次性、无回弹）；120/180ms 微过渡与「无无限循环」红线继承。

**检索依据**（ui-ux-pro-max，本 session 实跑）：`--design-system`（6/4/8）返回 Style=Dark Mode (OLED)、Pattern=Real-Time/Operations Landing、配色仍锚 Status Page 绿；`--domain style "dark dashboard depth elevation layered"` 返回 **dimensional-layering**（4 级 elevation + 分层深度，本文件阴影/表面体系的直接依据）与 data-dense-dashboard；`--domain typography "…monospace data technical"` 返回 "Modern Dark Cinema (Inter System)" 的**层级手法**（display 负字距 + micro-label 加字距 + mono-for-data）——字体一律不采用（零网络字体红线，Inter/Fira/Orbitron 均弃，沿用系统栈）。

**继承不动的旧裁决**（不属本次「改方向」范围）：侧栏 184px、设置六组+锚点+吸底保存栏 IA、五页命名与快捷键、keep-alive、活列表/错误≠空/双窗口口径、tone 三档族结构与 `--tone/--tone-bg` 下发范式、`--hit: 44px`、tnum 全局、字重 400/500/600/700 唯一四档。

---

## Global Rules

### Color Palette（R11 终值 · 浅为基、暗整组覆盖）

**浅色（`:root`）**

| Role | Hex | CSS Variable |
|------|-----|--------------|
| Primary（图形：点/描边/选择条/图标强调） | `#059669` | `--color-primary` |
| On Primary | `#FFFFFF` | `--color-on-primary` |
| 主按钮底 | `#047857` | `--btn-primary-bg` |
| 主按钮 hover 底 | `#065F46` | `--hover-primary-bg`（fg 恒 `#FFFFFF`） |
| Background | `#EEF1F5` | `--color-background` / `--bg` |
| Foreground | `#16202E` | `--color-foreground` / `--fg` |
| Card | `#FFFFFF` | `--color-card` / `--card` |
| Card-alt（卡内嵌井/日志底/展开行底） | `#F2F5F8` | `--card-alt` |
| Raised（浮层/弹层/吸底栏面） | `#FFFFFF` | `--raised`（配 `--shadow-lg`） |
| Muted Foreground（次要文字） | `#455567` | `--text-2` |
| 辅助元信息 | `#5B6B80` | `--text-3` |
| Border（装饰描边，禁承载分隔/输入语义） | `#CBD5E1` | `--color-border` |
| Line（功能分隔线） | `#D3DBE4` | `--line` |
| Input border | `#64748B` | `--input-border` |
| Ring | `#047857` | `--ring` |
| Rail（侧栏，两模式恒深） | `#131A2A` | `--rail-bg` |
| Rail 文字 / 次要 | `#E8EEF7` / `#93A3BC` | `--rail-fg` / `--rail-fg-2` |
| Rail 选中竖条 | `#34D399` | `--rail-bar` |

**暗色（`@media (prefers-color-scheme: dark)`）**

| Role | Hex | CSS Variable |
|------|-----|--------------|
| Primary | `#34D399` | `--color-primary` |
| 主按钮底 / 字 | `#34D399` / `#052E1F` | `--btn-primary-bg` / `--color-on-primary` |
| 主按钮 hover 底 | `#6EE7B7`（fg 不变） | `--hover-primary-bg` |
| Background | `#070B14` | `--color-background` |
| Card | `#0D1422` | `--color-card` |
| Card-alt | `#151E30` | `--card-alt` |
| Raised | `#16203A` | `--raised` |
| Foreground | `#E8EEF7` | `--color-foreground` |
| Muted Foreground / text-3 | `#A6B4C8` / `#8294AD` | `--text-2` / `--text-3` |
| Border（装饰） | `#324261` | `--color-border` |
| Line（功能） | `#26324A` | `--line` |
| Input border | `#6B7A94` | `--input-border` |
| Ring | `#34D399` | `--ring` |
| Rail | `#0B1220`（muted `#93A3BC` 7.32:1 实测） | `--rail-bg` |

**语义 tone 族（每族三档：点/描边 · 文字 · 弱底；浅色 / 暗色）**

| tone | 点 | 文字 | 弱底 |
|------|-----|------|------|
| ok（=品牌绿） | `#059669` / `#34D399` | `#047857` / `#34D399` | `#DCF5EA` / `#0E2A22` |
| err | `#DC2626` / `#F87171` | `#B42318` / `#F87171` | `#FDE7E5` / `#3A161B` |
| warn | `#B45309` / `#FBBF24` | `#92400E` / `#FBBF24` | `#FBEBD2` / `#33270F` |
| ai | `#7C3AED` / `#A78BFA` | `#6D28D9` / `#A78BFA` | `#EDE9FE` / `#241B3F` |
| mute | — | `#455567` / `#A6B4C8` | `#E7ECF2` / `#1A2334` |

**对比度实测（WCAG 相对亮度公式，本 session python 实算；文字≥4.5:1、图形/UI≥3:1）**：白字 on `#047857` 5.48 / on `#065F46` 7.68；`#022C22` on `#059669` 4.02（故浅底按钮弃「绿底深字」改白字深底）；`#059669` on 白 3.77 / on bg 3.33（点/描边达标）；`#047857` on 白 5.48 / on bg 4.84 / on ok-chip 4.78；fg on 白 16.40 on bg 14.48、text-2 7.64、text-3 `#5B6B80` on 白 5.44 on card-alt 4.97 on bg 4.80；ring on bg 4.84；rail-fg 14.89、rail-fg-2 6.79、rail-bar 9.04；暗：fg on bg 16.87、text-2 8.76、text-3 5.95、ok-text on card 9.58 on chip 7.96、on-primary 7.71、err 6.66/5.79、warn 11.03/8.75、ai 6.77/5.92、ring on card 9.58、input-border on card 4.24；err/warn/ai 浅文字档 6.57/7.09/7.10、点档 4.83/5.02/5.70；**danger 实底**：两模式底收敛 `#DC2626`（`--danger-solid-bg` 新 token——`.btn-danger-solid` 现状用 `var(--err)` 作底，而暗 `--err` 点档 `#F87171` 上纯白实测仅 2.77:1，故实底不得再吃 `--err`），hover `#B91C1C`（白字 6.47:1）；`--on-danger` 现值 `#FEF7F7` 实测 4.57:1 达标（R10「≈4.6:1」不虚，此前引 `#FEF2F2/4.41` 系简报誊写错值，已更正），R11 统一为 `#FFFFFF`（4.83:1），token 保留不可丢（settings-core.css:279/285 在用）。红线：任何新色对接入前按此公式复测，不得沿用本表数字豁免；`color-mix` 派生档（wash/hover 混色）落地时逐一复测。

**Color Notes:** Emerald signal green on ink/slate surfaces；incident red + maintenance amber + AI violet 语义继承 R10。

### Typography（零网络字体裁决）

- **界面字体**：`--font-ui: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', sans-serif`
- **数据字体**：`--font-mono: ui-monospace, 'SF Mono', 'JetBrains Mono', 'Cascadia Mono', Consolas, monospace`——时间戳/计数/KPI/日志/URL/ID 一律 mono + 全局 `font-feature-settings:'tnum' 1`。
- 检索命中的 Fira Code/Fira Sans/Inter **不采用**（@import 网络字体违反零外部资源红线；且无中文字形）；采用的只是其**手法**：display 负字距（`--ls-display: -0.015em`，仅 ≥20px 档）、micro-label 正字距（`--ls-label: 0.05em`，仅拉丁/数字 12px 档，中文正文不加）。
- **字阶 7 档**：12（辅助元信息，禁正文）/ 13（次级正文·按钮）/ 14（正文级）/ 16（组头·state-pill·强调）/ 20（分区小节题·日报卡头）/ 24（页题）/ 28（KPI 大数字）。旧 `--fs-15` 并入 16，**别名层保留 `--fs-15: var(--fs-16)` 过渡**（现状引用 5 处，目标值逐处定、禁机械套 16：primitives.css:6 `.group-head`→16、dashboard.css:71 `.state-pill`→16、dashboard.css:110 `.metric .v`→28/700（KPI）、events.css:162 `.report-title`→20/700（日题）、events.css:281 `.doc-h2`→16；清零后删别名）。
- **字重只用 400/500/600/700**（继承）；700 只授权三处 display 位：页题 24 / 日报卡头日题 20 / KPI 28；brand-name 现值 700（shell.css:40）降 600，其余一律 ≤600。
- **行高**：display 1.15（24/28 档）/ tight 1.3 / base 1.5 / read 1.7（成段中文）；chip 像素档 `--lh-chip: 18px`。

### Spacing Variables

*Density: 8/10 — Dense / Dashboard*

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | `2px` / `0.125rem` | Tight gaps |
| `--space-sm` | `4px` / `0.25rem` | Icon gaps, inline spacing |
| `--space-md` | `8px` / `0.5rem` | Standard padding |
| `--space-lg` | `12px` / `0.75rem` | Section padding |
| `--space-xl` | `16px` / `1rem` | Large gaps |
| `--space-2xl` | `24px` / `1.5rem` | Section margins |
| `--space-3xl` | `32px` / `2rem` | Group gaps |

### Shadow Depths（双层 key+ambient；dimensional-layering 4 级）

| Level | 浅色 | 暗色 | Usage |
|-------|------|------|-------|
| `--shadow-sm` | `0 1px 2px rgba(15,23,42,.06), 0 2px 4px rgba(15,23,42,.05)` | `0 1px 2px rgba(0,0,0,.5)` | 静态卡 |
| `--shadow-md` | `0 4px 10px rgba(15,23,42,.08), 0 2px 4px rgba(15,23,42,.05)` | `0 4px 12px rgba(0,0,0,.55)` | hover 卡/下拉 |
| `--shadow-lg` | `0 14px 32px rgba(15,23,42,.14), 0 4px 10px rgba(15,23,42,.07)` | `0 16px 40px rgba(0,0,0,.6)` | 浮层/设置子导航 |
| `--shadow-xl` | `0 28px 56px rgba(15,23,42,.20), 0 8px 18px rgba(15,23,42,.10)` | `0 28px 64px rgba(0,0,0,.65)` | 吸底保存栏/确认层 |
| `--edge-top` | `inset 0 1px 0 rgba(255,255,255,.7)`（raised 面近无） | `inset 0 1px 0 rgba(255,255,255,.06)` | 暗色顶缘发丝高光 |

暗色层次以「表面提亮一档 + 发丝高光 + 边框」表达，阴影只作浮层兜底（继承 R10 裁决）。

---

## Component Specs

```css
/* 主按钮（全视图至多一个实底主按钮，继承 R10 纪律） */
.btn-primary {
  background: var(--btn-primary-bg);   /* 浅 #047857 / 暗 #34D399 */
  color: var(--color-on-primary);      /* 浅 #FFFFFF / 暗 #052E1F */
  padding: 6px 14px; min-height: 32px; /* 命中区以 --hit 44 等效补偿 */
  border-radius: var(--r-ctl);         /* 10px */
  font-weight: 500; box-shadow: var(--shadow-sm);
  transition: background-color var(--t-fast) var(--ease-std),
              box-shadow var(--t-fast) var(--ease-std),
              transform var(--t-fast) var(--ease-std);
}
.btn-primary:hover:not(:disabled) { background: var(--hover-primary-bg); box-shadow: var(--shadow-md); }
.btn-primary:active:not(:disabled) { transform: translateY(0.5px); box-shadow: none; }
/* 次级 = card 底 + input-border 描边；danger 描边 = err 55% 混、文字 --err-text，
   实底 danger 底 #DC2626 字 #FFFFFF；hover 一律加深/加阴影，禁 opacity 变淡、禁位移布局 */

.card {
  background: var(--card);
  border: 1px solid var(--color-border);      /* 装饰档 */
  border-radius: var(--r-card);               /* 14px */
  box-shadow: var(--shadow-sm), var(--edge-top);
}
/* 列表行 hover：background: var(--primary-wash)（浅 emerald 10% / 暗 14%，落地复测）；
   选中行：3px 左竖条 var(--color-primary) + wash 底（与 rail/snav 同语言） */

.input {
  padding: 6px 10px; border: 1px solid var(--input-border);
  border-radius: var(--r-ctl); background: var(--card); font-size: var(--fs-14);
}
.input:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; border-color: var(--ring); }
/* KPI 数字：font: 700 var(--fs-28)/1.15 var(--font-mono); letter-spacing:-0.015em; tnum */
/* 页题：font: 700 var(--fs-24)/1.2 var(--font-ui); letter-spacing:-0.015em */
```

### Modal / 确认层

遮罩 `rgba(2,6,17,.62)`（暗）/ `rgba(22,32,46,.45)`（浅，落地复测），面板 `--raised` 底 + `--r-card` + `--shadow-xl` + `--edge-top`；禁用 backdrop-filter 大面模糊（Electron 桌面性能与可读性）。

---

## Style Guidelines

**Style:** Dark Mode (OLED) × Dimensional Layering（检索双命中合成）——高对比文字、emerald 信号色、三级表面 + 4 级 elevation、墨轨结构栏。

**Pattern Name:** Real-Time / Operations Landing → **桌面化转用**（继承 REDESIGN §3.1）：营销 CTA/Section Order 不采用；保留其 telemetry 面板规范——标「实时」必有数据截至与 stale 态、轮询可暂停、隐藏到托盘停 UI 动画与刷新、键盘全程可达、reduced-motion 渲染静态终态。

**Key Effects:** hover 阴影升一档（非位移布局）、行入场一次性上移淡入、焦点环 2px 常显、暗色发丝高光。

---

## Motion

**Tier: Standard (4/10)** —— 无 GSAP 依赖（红线），以下参数用 CSS transition/animation 实现：

- 微过渡：`--t-fast: 120ms`（颜色/描边）；`--t-base: 180ms`（背景/小位移）；`--t-glide: 280ms`（展开/折叠/页面级，新增）。
- 缓动：`--ease-out: cubic-bezier(.22,1,.36,1)`（入场/展开）；`--ease-std: cubic-bezier(.4,0,.2,1)`（属性过渡）。
- 列表行入场：`opacity 0→1 + translateY(6px)→0`，240ms `ease-out`，批量上限 8 行、stagger 40ms；**禁 back.out 回弹**（检索明示：dense 数据表上回弹显得毛糙）。
- 一次性动画 ≤400ms；**无限循环为 0**（busy 转圈豁免注记保留）；`prefers-reduced-motion` 直接终态；窗口隐藏全部停止。

---

## Anti-Patterns (Do NOT Use)

- ❌ Slow dashboards / decorative charts / hidden error states
- ❌ Emojis as icons — 一律内联 SVG（现状 icons.tsx：16×16 / stroke 1.5 / currentColor / aria-hidden）
- ❌ Missing cursor:pointer / Layout-shifting hovers（含 translateY 卡片浮起）/ Instant state changes / Invisible focus states
- ❌ **R10 教训新增**：表面染品牌色（绿底/绿相灰）、「唯一小字阶」压平层次、全扁平无 elevation、单一强调档（无 display 字阶）
- ❌ 网络字体/@import/CDN 资源、backdrop-filter 大面积毛玻璃、文字用透明度分级

---

## Pre-Delivery Checklist（桌面化，REDESIGN §8 的 R11 版）

- [ ] 无 emoji 图标；图标同一 SVG 体系
- [ ] 全部可点元素 cursor:pointer；过渡 120–300ms；hover 不移位
- [ ] 浅/暗两模式正文 ≥4.5:1、图形/UI ≥3:1（新色对按公式复测，color-mix 派生档逐一实测）
- [ ] `:focus-visible` 2px 环两模式常显；rail 上的焦点环用 `--rail-bar` 档
- [ ] `prefers-reduced-motion` 终态渲染；无无限循环动画；隐藏即停
- [ ] 最小窗口 960px；无意外横向滚动；吸底/锚点让位（88px、scroll-margin-top）
- [ ] 错误态可见可重试、旧数据保留；空态三态；加载局部化不闪屏
- [ ] 字重仅 400/500/600/700；KPI/时间戳 mono + tnum；页题全应用唯一 24/700
- [ ] 双模式全走 CSS 变量；组件零硬编码 hex
