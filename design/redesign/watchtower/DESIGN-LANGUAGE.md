# 瞭望塔设计语言解析（Watchtower Design Language）

> 本文档是 `design/redesign/watchtower/concept.html`（917 行单文件概念稿）的**设计侧唯一迁移依据**，写给实施者当手册。
> 所有行号指 concept.html；hex 近似与对比度比值均为本 session python 按 OKLab→sRGB 与 WCAG 公式实算（脚本临时文件，未入库）。
> 上游事实：项目 Electron `^44.4.3`（package.json）= Chromium 126+，`oklch()` / `color-mix()` 可直接用——theme.css:80 已有 `color-mix` 先例。**实施一律写 oklch 原值**；hex 列仅供调试与不支持 oklch 的场合对照。

概念稿结构：主样式块 concept.html:7-259（`:root` 深色令牌 + 组件规则，含少量深色硬编码字面量）；主题层块 concept.html:834-917（`<style id="fw-theme-style">`：浅色覆盖 + 把主块硬编码色收编为令牌 + 历史面板微调 + 拖拽把手）。**两块合并后的最终生效值才是设计意图**——只抄第一块会得到未主题化的旧值（见 §1.4 对照表）。

---

## 0. 设计基调

- **深色「瞭望塔」为默认主题**：炭蓝底（hue 258-260 的低彩度阶梯）+ 琥珀信号色（hue 70），衬线页题 × 系统 sans 正文 × 等宽数字（头注释 concept.html:8-9）。
- **浅色「晨报」**：同一套变量名、全部换值（concept.html:842-875），暖白冷调（hue 255）纸面感。
- 层次靠**表面阶梯逐档提亮**（深色）/逐档压暗（浅色）+ 1px 低透明度边框，不靠重阴影；浮层（抽屉/toast/主按钮）才用大扩散阴影。
- 密度紧凑：正文 14px/1.6，表格行 padding 11px 14px，面板头 14px 16px 10px。

---

## 1. 令牌总表

### 1.1 深色「瞭望塔」（默认，`:root`，concept.html:10-36 + 主题层补 836-841）

`color-scheme: dark`（concept.html:11）。

**背景/表面阶梯**（自外向内逐档提亮）：

| 变量 | oklch 原值 | sRGB 近似 | 用途 |
|---|---|---|---|
| `--stage` | `oklch(0.105 0.013 260)` | `#020407` | 概念稿「桌面舞台」底（假窗口之外），body 背景（:39）。**演示件**，应用内无对应物 |
| `--bg` | `oklch(0.155 0.015 260)` | `#090C13` | 应用窗口底 / 主内容区底（`.window` :46、`.screen` 无自有底色即坐它） |
| `--surface` | `oklch(0.195 0.016 258)` | `#10151C` | 一级表面：标题栏、侧栏、面板、stat 卡、表格 sticky 表头、输入框底、抽屉体 |
| `--surface-2` | `oklch(0.23 0.017 258)` | `#181D25` | 二级表面：chip-mono/pill 底、b-ai 徽标底、d-price/quote 底、k 普通档底、savebar 混底基准、d-close:hover |
| `--surface-3` | `oklch(0.268 0.018 258)` | `#21262F` | 三级表面：默认按钮底、toast 底、开关轨道底、chip.on 底、k 关键词条底、kw 进度槽底、滚动条 thumb |
| `--surface-hi` | `oklch(0.295 0.019 258)` | `#272D36` | **悬停底专用**：nav-item:hover、表格行 hover、feed-row:hover、锚点 hover |

**文字色阶**：

| 变量 | oklch | hex 近似 | 用途 | 对比度实算 |
|---|---|---|---|---|
| `--fg` | `oklch(0.95 0.004 90)` | `#EFEEEB` | 主文字（微暖白） | on surface 15.79 / on bg 16.86 |
| `--muted` | `oklch(0.7 0.012 258)` | `#9A9FA6` | 次要文字（正文级说明、面板副语） | on surface 6.88 |
| `--faint` | `oklch(0.55 0.012 258)` | `#6D7279` | 弱化元信息（时间/来源/表头/eyebrow） | on surface **3.78 ⚠️**，见 §1.5 |

**琥珀 accent**：

| 变量 | oklch | hex 近似 | 用途 | 对比度 |
|---|---|---|---|---|
| `--accent` | `oklch(0.79 0.135 70)` | `#F1AA4F` | 主按钮底、品牌 logo、NEW 标、bars7 今日柱、grip 拖拽高亮 | on surface 9.25 |
| `--accent-ink` | `oklch(0.2 0.05 70)` | `#241100` † | 主按钮文字（深琥珀墨） | on accent 9.18 |

**语义色**（success/danger/warn/info + 两个文字专用档 + 三个分段条灰）：

| 变量 | oklch | hex 近似 | 用途 | 对比度（on surface） |
|---|---|---|---|---|
| `--success` | `oklch(0.74 0.14 152)` | `#5DC47E` | 状态点 ok、spark 走势线、开关选中边、抽屉对勾 | 8.43（UI≥3 ✓） |
| `--danger` | `oklch(0.66 0.19 27)` | `#F0574E` | 状态点 err、delta.bad、c7 分段 | 5.39 ✓ |
| `--warn` | `oklch(0.83 0.15 98)` | `#E1C841` | 状态点 warn、mini-tag 文字、c3 分段 | 10.94 ✓ |
| `--info` | `oklch(0.72 0.115 240)` | `#5AAEE5` | kw 进度条填充、bars7 柱、热力格基色、range accent-color | 7.52 ✓ |
| `--info-soft` | `oklch(0.79 0.08 240)` | `#8BC2E9` | b-kw 徽标文字、c4 分段 | 9.59 ✓ |
| `--success-text` | `oklch(0.8 0.11 155)` | `#81D39F` | b-price 徽标文字（主题层 :837 定义） | 10.25 |
| `--danger-text` | `oklch(0.75 0.1 25)` | `#E7958E` | 排除词条 k.x 文字（主题层 :837） | on surface-3 6.57 |
| `--seg-gray` | `oklch(0.44 0.01 255)` | `#4F5358` | 去向分段条 c1（未命中） | 图形，无需 4.5 |
| `--seg-dark` | `oklch(0.33 0.01 255)` | `#32363B` | 去向分段条 c5（重复·限频） | 同上 |
| `--seg-mid` | `oklch(0.38 0.01 255)` | `#3F4348` | 去向分段条 c6（暂停中）（主题层 :837） | 同上 |

**边框与焦点**：

| 变量 | 值 | 用途 |
|---|---|---|
| `--border` | `rgba(255,255,255,0.08)` | 常规分隔：面板缘、表行、侧栏右缘、feed 行、savebar 顶线、默认徽标边 |
| `--border-strong` | `rgba(255,255,255,0.16)` | 功能边界：输入框、默认按钮、抽屉左缘、toast 外缘、d-close 边、表格表头底线 |
| `--border-hover` | `rgba(255,255,255,0.28)` | hover 边框（主题层 :838，替换主块 :90 的 `.26` 字面量） |
| `--border-active` | `rgba(255,255,255,0.32)` | 输入聚焦边框（主题层 :838） |
| `--focus-ring` | `rgba(255,255,255,0.35)` | `:focus-visible` 外框（2px / offset 2px，:43 + :877） |

**阴影与遮罩**（主题层 :839-840）：

| 变量 | 值 | 用途 |
|---|---|---|
| `--shadow-win` | `0 40px 120px oklch(0 0 0/0.55)` | 假窗口投影。**演示件**（应用内无悬浮窗口层） |
| `--shadow-cta` | `inset 0 1px 0 rgba(255,255,255,.3), 0 6px 18px color-mix(in srgb,var(--accent) 20%,transparent)` | 主按钮（顶缘内高光 + accent 光晕） |
| `--shadow-drawer` | `-30px 0 60px oklch(0 0 0/0.35)` | 抽屉（向左投影） |
| `--shadow-toast` | `0 14px 38px oklch(0 0 0/0.5)` | toast |
| `--bk` | `oklch(0.1 0.01 255/0.55)` | 抽屉遮罩底色 |

**macOS 红绿灯**（演示件，勿迁移）：`--tl-r:#ff5f57; --tl-y:#febc2e; --tl-g:#28c840`（:32）。

**字体**（详见 §2）：`--font-display` / `--font-body` / `--font-mono`（:33-35）。

### 1.2 浅色「晨报」（`:root[data-theme="light"]`，concept.html:842-875）

`color-scheme: light`（:843）。变量名与深色一一对应（同名覆盖 + 浅色独有文字档），**未列出的沿用深色值**（实际只有字体三栈与 `--tl-*` 不覆盖）。

| 变量 | oklch | hex 近似 | 备注 |
|---|---|---|---|
| `--stage` | `oklch(0.9 0.008 255)` | `#DADEE3` | 演示件 |
| `--bg` | `oklch(0.965 0.005 255)` | `#F1F4F7` | 窗口底（冷雾白，比现 app 的 #F6F8FC 略冷） |
| `--surface` | `oklch(0.995 0.003 255)` | `#FCFEFF` † | 近白卡面 |
| `--surface-2` | `oklch(0.955 0.006 255)` | `#EDF0F4` | 嵌井/次级底 |
| `--surface-3` | `oklch(0.915 0.008 255)` | `#DFE3E8` | 按钮底/开关轨/chip.on |
| `--surface-hi` | `oklch(0.89 0.01 255)` | `#D6DBE1` | 悬停底 |
| `--fg` | `oklch(0.25 0.02 260)` | `#1C222B` | on surface 15.81 |
| `--muted` | `oklch(0.46 0.02 260)` | `#525864` | on surface 7.06 |
| `--faint` | `oklch(0.52 0.02 262)` | `#636975` | on surface 5.45 / on bg 5.00 ✓ |
| `--border` | `rgba(20,30,50,0.10)` | — | |
| `--border-strong` | `rgba(20,30,50,0.18)` | — | |
| `--accent` | `oklch(0.54 0.125 70)` | `#9C5F00` † | 焦糖琥珀，on surface 5.13 |
| `--accent-ink` | `oklch(0.99 0.005 90)` | `#FDFCF8` | on accent 5.05 |
| `--success` | `oklch(0.52 0.13 155)` | `#007E46` † | 5.10 |
| `--danger` | `oklch(0.52 0.19 25)` | `#BE222A` | 6.01 |
| `--warn` | `oklch(0.58 0.13 95)` | `#937800` † | 4.21——作状态点 ≥3 ✓；**作 mini-tag 文字 <4.5 ⚠️**（§1.5） |
| `--info` | `oklch(0.48 0.12 235)` | `#006697` † | 6.20 |
| `--info-soft` | `oklch(0.44 0.1 235)` | `#005A81` † | 7.47 |
| `--success-text` | `oklch(0.42 0.12 155)` | `#005F2E` † | 7.76 |
| `--danger-text` | `oklch(0.5 0.18 25)` | `#B32228` | 6.54 |
| `--seg-gray` | `oklch(0.74 0.012 260)` | `#A6ABB3` | |
| `--seg-dark` | `oklch(0.62 0.015 260)` | `#81868F` | |
| `--seg-mid` | `oklch(0.68 0.012 260)` | `#9499A0` | |
| `--focus-ring` | `rgba(20,30,50,0.45)` | — | |
| `--border-hover` | `rgba(20,30,50,0.30)` | — | |
| `--border-active` | `rgba(20,30,50,0.40)` | — | |
| `--shadow-win` | `0 30px 90px rgba(20,30,50,0.20)` | — | 演示件 |
| `--shadow-cta` | `inset 0 1px 0 rgba(255,255,255,.35), 0 6px 18px color-mix(in srgb,var(--accent) 30%,transparent)` | — | 光晕浓度深色 20% → 浅色 30% |
| `--shadow-drawer` | `-30px 0 60px rgba(20,30,50,0.18)` | — | |
| `--shadow-toast` | `0 14px 38px rgba(20,30,50,0.20)` | — | |
| `--bk` | `rgba(15,23,42,0.32)` | — | 遮罩比深色淡 |

† = 原 oklch 在 sRGB 色域外，hex 为逐通道裁切近似；浏览器实际按 CSS Color 4 做降 chroma 色域映射，与逐通道裁切可能有 1-2 个 8bit 色阶差异。**实施写 oklch 原值即所见即所得，hex 只作对照。**

### 1.3 概念稿未设令牌、散落在组件规则里的数值（迁移时应收编为令牌）

概念稿没有圆角/间距/动效令牌变量，以下为逐条提取的**全部**实际值：

**圆角阶梯**（12 档实际在用）：

| 值 | 使用处 |
|---|---|
| `2px` | 去向分段条单段、grip 竖线/横把 |
| `3px` | 热力格、kw 进度条及槽 |
| `4px 4px 2px 2px` | bars7 柱（上圆下锐）；`4px` 另用于 mini-tag、NEW 标、soon |
| `5px` | tag-proto（演示）、k 关键词条、去向分段条整体 |
| `6px` | chip-mono、cmd、badge 默认、滚动条 thumb |
| `7px` | d-close、锚点链接、历史表内 badge（:901） |
| `8px` | 按钮、输入框/下拉/文本域、nav-item |
| `10px` | rule 规则卡、d-price、quote、toast |
| `12px` | panel、stat 卡 |
| `14px` | 假窗口（演示件） |
| `99px`（胶囊） | chip、pill、lg 图例、开关轨道 |

**字号阶梯**（px，实出现值）：
`9.5`（NEW）· `10`（ph-tag/mini-tag/soon/lbls/axis/anchor 编号）· `10.5`（ngl/eyebrow/表头 th/src/tag-proto/mono-cmd）· `11`（t-sub/f-sub/tm/delta/k/.kw .n/badge/fh 档）· `11.5`（side-foot/why/cmd/lg）· `12`（lbl/fl/fh/st/rb/12px 档）· `12.5`（panel-h h3/scr-sub/toast/d-sec li）· `13`（body 基准/按钮/表格/src-name/nav-item 13.5 例外）· `13.5`（nav-item/feed h4/price/hit-t/rule .rt>b）· `14`（**body 全局基准 14px/1.6**，:39）· `17`（设置小节题）· `19`（抽屉标题）· `27`（页题）· `30`（KPI 数字）。

**动效数值**（概念稿无 `--t-*` 变量，全部硬编码；⚠ = 建议迁移时收编为 `--t-fast/--t-base/--t-glide` 三档，对齐项目 theme.css:175-179 既有体系）：

| 数值 | 归属 |
|---|---|
| `.1s` transform | 按钮按压 `translateY(1px)`（:89） |
| `.12s` background | 表格行 / feed 行 hover（:119,:132） |
| `.15s` | 按钮底色/边框（:89）、chip 全属性（:156）、锚点全属性（:196）、grip 高亮（:910,:913） |
| `.2s` | 开关轨道与滑块（:216-217） |
| `.25s` opacity | 遮罩 bk（:230） |
| `.3s` `cubic-bezier(.2,.8,.2,1)` | 抽屉滑入（:232）——**唯一自定义缓动** |
| `.3s` ease | toast 入场 tIn（:257） |
| `.35s` opacity | toast 退场（:256） |
| `.45s` ease | feed 新行 slideIn（:136） |
| `.7s` ease | 刷新图标 spin 一圈（:98） |
| `2.2s` infinite | 状态点 / pill-dot pulse 呼吸（:59） |
| `900ms` | KPI countUp（JS :638，`1-(1-p)³` 缓出） |
| `2600ms`/`380ms` | toast 停留 / 退场后移除（JS :624） |
| `7s` | 概念稿假命中流插入间隔（JS :655，演示件） |
| `@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}` | 全局动效开关（:258）——**必迁移** |

**组件局部自定义属性**（非设计令牌，交互状态载体）：`--v`（热力格强度 0-1，:179）、`--w`（去向分段条段宽权重，:184）、`--rail-w`（历史右栏宽度，默认 292px，:903）。

### 1.4 主块硬编码色 → 主题层令牌对照（迁移必看）

主块（:7-259）写于主题化之前，留有一批深色字面量；主题层（:876-895）逐个改为令牌引用。**同选择器后者覆盖前者，迁移时只抄右侧**：

| 主块字面量 | 主题层最终值 | 位置 |
|---|---|---|
| `:focus-visible` `rgba(255,255,255,.35)` | `var(--focus-ring)` | :43 → :877 |
| `.window` `0 40px 120px oklch(0 0 0/.55)` | `var(--shadow-win)` | :46 → :878 |
| `.btn:hover` `rgba(255,255,255,.26)` | `var(--border-hover)` | :90 → :879 |
| `.btn.primary` 阴影 | `var(--shadow-cta)` | :92 → :880 |
| `.btn.primary:hover` `oklch(0.83 0.14 80)`（`#F7BC50`） | `color-mix(in oklab,var(--accent) 86%,white)` | :93 → :881 |
| `.chip.on` `rgba(255,255,255,.3)` | `var(--border-hover)` | :158 → :882 |
| `.ipt:focus` 等 `rgba(255,255,255,.32)` | `var(--border-active)` | :152 → :883 |
| `.b-price` `oklch(0.8 0.11 155)` | `var(--success-text)` | :129 → :884 |
| `.k.x` `oklch(0.75 0.1 25)` | `var(--danger-text)` | :213 → :885 |
| `.c6` `oklch(0.38 0.01 255)` | `var(--seg-mid)` | :185 → :886 |
| `.bk` `oklch(0.1 0.01 255/0.55)` | `var(--bk)` | :230 → :887 |
| `.drawer` / `.toast` 阴影 | `var(--shadow-drawer)` / `var(--shadow-toast)` | :232,:255 → :888-889 |

spark 迷你走势图配色也在主题层定稿（:891-895）：填充 = `color-mix(in srgb, 语义色 14-16%, transparent)`，描边 = 语义色本体、`stroke-width:1.6`——accent（今日命中）/ success（已推送）/ info（AI 无关）/ danger（轮询错误）四系。

### 1.5 对比度核查（按项目纪律：正文 ≥4.5:1、图形/UI ≥3:1）

实算通过项（抽样）：两主题 fg/muted/accent/accent-ink/success-text/danger-text/info-soft 全部 ≥4.5；语义点与描边在 surface 上全部 ≥3（最浅为浅色 warn 4.21，作图形 ✓）；徽标文字对各自 color-mix 底 6.07-8.38。

**两处不达标，迁移时必须修**（概念原样 vs 项目纪律冲突点，已在本文档裁决为「以纪律为准」）：

1. **深色 `--faint` 承载文字全面 <4.5**：on surface 3.78（`.tm`/`.src`/`.delta`/`.f-sub`/`.axis`/`.lbls`/表头 `th`/`.fl small`/`.fh`/`.why`，9.5-11.5px 小字）、on surface-2 3.49、on bg 4.04（eyebrow）。它们是正文性质的元信息，不是图形。
   → 建议加深为 `oklch(0.62 0.012 258)` `#82868E`（实算 surface 5.02 / surface-2 4.63 / bg 5.36）；想留余量取 `oklch(0.64 0.012 258)`（5.43/5.02/5.80）。浅色 faint 已达标不动。
2. **浅色 `--warn` 作 mini-tag 文字 4.21 <4.5**（深色 warn 10.94 无碍）。
   → 仿概念稿已有的 `success-text`/`danger-text` 分档思路，浅色拆 `--warn-text: oklch(0.46 0.13 95)` `#6F5500`（实算 on surface 6.98 / surface-2 6.17）只供文字用；点/描边继续用 `--warn`。

---

## 2. 字体系统

### 2.1 三栈确切取值（concept.html:33-35）

```css
--font-display: "Noto Serif SC","Songti SC","STSong","Source Han Serif SC","SimSun",serif;
--font-body:    -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;
--font-mono:    "SF Mono",ui-monospace,"JetBrains Mono","Cascadia Code",Menlo,Consolas,monospace;
```

零网络字体红线（theme.css:6 先例：不引字体、不引图标）：三栈全部系统字体，**不得打包/引入任何字体文件**。

### 2.2 授权位置（哪一栈允许出现在哪）

**display 衬线栈——只授权 4 处**，全部是「阅读题」位，禁止扩散到界面控件：

| 位置 | 规格 | 行号 |
|---|---|---|
| 屏页题 `h1`（监控台/历史命中/去向/设置） | `600 27px/1.1`，`letter-spacing -0.015em` | :83 |
| 设置小节题 `h3` | `600 17px/1.2`，`ls -.01em` | :201 |
| 抽屉命中标题 `.d-title` | `600 19px/1.5`，`ls -.01em` | :240 |
| AI 锐评引文 `.quote` | `400 13.5px/1.9`（唯一衬线正文位，行高放松供成段阅读） | :250 |

**等宽栈——只授权「数字与机器符号」**，且一律配 `font-variant-numeric: tabular-nums`（`.mono` 工具类 :77 已内建）：

| 位置 | 规格 | 行号 |
|---|---|---|
| KPI 大数字 `.stat .num` | `600 30px/1`，`ls -0.02em` + tnum | :103 |
| 价格 `.price`（feed 行 / 抽屉） | `600 13.5px/1`（抽屉 16px）+ tnum | :143,:242 |
| 表内时间/延迟/计数 `td.mono`、delta `▲ +12` | `400/500 11-13px` + tnum | :104,:143-144 |
| 来源标记 `.src`（NODESEE 式大写） | `500 10.5px/1`，`ls .05em` | :138 |
| NEW 标、`.tm` 时间戳、`.chip-mono`、`.cmd` 远程命令、`.k` 关键词条、`.kw .n` 计数、`.axis` 时刻轴、锚点/小节编号 `b/.n`、`.conf b` 置信度、`.mono-cmd` | 9.5-11.5px | :144-145,:56,:226,:212,:177,:180,:197,:202,:244,:75 |

**正文栈——其余一切**：全局基准 `400 14px/1.6`（:39）、按钮 500 13px、表格 13px、feed 标题 600 13.5px/1.45、nav-item 500 13.5px。

### 2.3 跨平台降级预期（零网络字体红线的代价，如实写明）

**display 衬线栈**：
- **macOS**：`Noto Serif SC` 系统不预装 → 实际命中 `Songti SC`（宋体-简，预装），观感即概念稿本身。
- **Windows**：前四个全不预装 → 落到 **`SimSun`（中易宋体）**。预期：27px 页题可接受但笔画偏瘦、无 ClearType 平滑的点位在部分字号发虚；17-19px 小节题观感明显降级。这是红线下的既定代价——**不打包字体、不引入网络字体**，接受降级，不做补救。
- **Linux**：`Noto Serif SC`/`Source Han Serif SC` 仅当用户装了 serif 版 CJK 包（如 `fonts-noto-cjk-extra`；注意 `fonts-noto-cjk` 基础包只有 Sans）才命中；否则落 generic `serif` → fontconfig 逐字替换，通常替换到 Noto Sans CJK——**页题可能变成黑体**。预期「衬线不保证」，可接受。

**正文栈**：macOS → SF Pro + PingFang SC（命中 `-apple-system`/`PingFang SC`）；Windows → **Microsoft YaHei 微软雅黑**（预装，命中）；Linux → 命名全落空 → `system-ui` → 发行版 UI 字体 + fontconfig 的 CJK 兜底（常见 Noto Sans CJK）。正文栈三平台均有体面兜底，无风险。

**等宽栈**：
- macOS：`"SF Mono"` 对 Web 不可见（Apple 自家 app 专用）→ 实际命中 `ui-monospace`（Chromium 在 macOS 解析为系统等宽）。注意概念稿把具体名放在 `ui-monospace` **前**，与项目现 theme.css:121-123（`ui-monospace` 打头、含 `Cascadia Mono` 而非 `Cascadia Code`）顺序不同——实际解析结果 macOS 上等价，**迁移时建议沿用项目现有排序**（`ui-monospace` 打头是更稳的写法）。
- Windows：`JetBrains Mono`/`Cascadia Code` 均需用户自装（Cascadia 随 Windows Terminal 分发但不系统级注册）→ 实际命中 **Consolas**（预装）。
- Linux：装了 JetBrains Mono 则命中，否则 generic `monospace` → 常见 DejaVu Sans Mono。tnm 数字列宽在 Consolas/DejaVu 下均稳定（都支持 tnum）。

---

## 3. 组件形制速查

以下「底/边/角/密/悬/动」六要素全部给到数值；未写过渡的即无过渡（如 nav-item hover 是瞬时切换，概念稿如此）。

### 3.1 侧栏导航（:62-76）

- 宽 `218px` 固定，底 `--surface`，右边框 `1px --border`，内边距 `12px 12px 14px`，纵向 flex。
- brand：30×30 内联 SVG logo（`stroke:currentColor` 即 accent、`stroke-width:1.6`），名 14px + 副名 11px faint。
- 分组标签 `.ngl`：10.5px/600/`ls .1em`/faint，padding `10px 10px 6px`（「监控」「系统」两组）。
- **nav-item**：高 `40px`、圆角 `8px`、padding `0 11px`、图标文字 gap `10px`；文字 `500 13.5px/1` `--muted`；图标 16px `stroke-width 1.7` `opacity .75`。
  - hover：文字 `--fg` + 底 `--surface-hi`（无 transition）。
  - 选中 `.on`：文字 `--fg` + 底 `--surface-3` + 边框 `1px --border`。
- side-foot：`margin-top:auto` 顶线 `1px --border`，11.5px `--muted` 行高 2；命令行 `.mono-cmd` 10.5px faint。

### 3.2 stat 卡 + 迷你走势图（:100-107 + :891-895）

- 外层：4 列 grid，gap `14px`，行距 `14px`。
- 卡：底 `--surface`、边 `1px --border`、圆角 `12px`、padding `15px 17px 11px`。
- `.lbl` 12px/500/muted/`ls .02em`；`.num` `600 30px/1 mono` `ls -0.02em` tnum，margin `9px 0 3px`；`.delta` 11px mono faint（`.up`→success、`.bad`→danger）。
- spark：SVG `viewBox 0 0 120 30` + `preserveAspectRatio="none"`，高 `28px`、`margin-top 9px`、宽 100%。双层：面积填充 = 语义色 `color-mix 14-16%` 透明、折线 = 语义色实色 `stroke-width 1.6`。四系配色：今日命中=accent、已推送=success、AI 无关=info、轮询错误=danger。
- 数字滚动 countUp：900ms，`1-(1-p)³` 缓出（JS :638-641）。

### 3.3 面板 panel（:109-114）

- 底 `--surface`、边 `1px --border`、圆角 `12px`、`overflow:hidden`。
- `.pad` 变体内边距 `16px 18px`（纯图表面板用）；默认无 padding（表格面板靠表自家 padding）。
- 面板头 `.panel-h`：padding `14px 16px 10px`，两端对齐；h3 `12.5px/600/ls .05em`；右侧 `.ph-tag` `10px/600/ls .12em` 大写 faint（「Sources」「Live Feed」式英文小签）。

### 3.4 表格 tbl（:115-125 + :896-908）

- `border-collapse:collapse`，字号 13px。
- th：`10.5px/600/ls .08em` faint 左对齐，padding `8px 14px`，底线 `1px --border-strong`，`white-space:nowrap`。
- td：padding `11px 14px`，底线 `1px --border`，`vertical-align:middle`；末行无线。
- 行 hover：底 `--surface-hi`，`transition background .12s`，`cursor:pointer`。
- sticky 表头（历史面板）：`thead th{position:sticky;top:0;background:var(--surface);z-index:2}`（:908）。
- 历史面板专属（:898-907）：第三列（规则徽标）定宽 `104px` nowrap、td 左右 padding `22px/18px`；表 `min-width:780px`；外层 `.tbl-scroll` `flex:1;overflow:auto`；行内徽标放大为 `24px 高/11.5px/圆角 7px`。
- `.hit-t` 标题单元格：600 13px，`max-width:480px` 单行省略。`.src-name`：13px/600 + `small` 11px/400/faint（第二行元信息）。

### 3.5 实时命中流行（:131-145 + JS :643-658）

- 容器 `.feed`：`max-height:404px` 独立滚动。
- 行 `.feed-row`：flex 两端，padding `12px 16px`，行间线 `1px --border`（末行无），hover `--surface-hi` `.12s`，`cursor:pointer`，`tabIndex=0`。
- 新行动画 `.enter`：`slideIn .45s ease`（`opacity 0→1` + `translateY(-8px→0)`）。
- 左区元信息行 `.f-meta`：gap `9px` wrap——`.src`（mono 10.5px/500/ls .05em/faint）+ 规则徽标 + `.rname`（11px muted）+ 可选 NEW 标。
- 标题 `h4`：`600 13.5px/1.45`，`-webkit-line-clamp:2` 两行截断。`.f-sub` 11px faint（「已推送 Telegram」）。
- 右区 `.f-side`：右对齐纵列——`.price` mono 600 13.5px tnum、`.tm` mono 11px faint。
- NEW 标：mono `700 9.5px` `ls .12em` accent 文字 + accent 40% 边框，圆角 `4px`，padding `2px 5px`；同一时刻只保留一个（新行插入前移除旧 NEW）；列表最多保留 14 行。

### 3.6 chip / badge / 状态点

| 件 | 形制 | 状态 |
|---|---|---|
| `.badge` 规则徽标 | 高 `21px` 圆角 `6px` padding `0 8px` 11px/500，三色：`b-kw` = info-soft 文字 on `color-mix(info 14%,transparent)` + info 30% 边；`b-price` = success-text on success 12% + success 28% 边；`b-ai` = muted on `--surface-2` + `--border-strong` **虚线边** | nowrap（:897） |
| `.chip` 筛选片 | 高 `30px` 圆角 `99px` padding `0 13px` 边 `--border-strong` 底 `--surface` 字 muted 12px/500，`transition .15s` | hover 字变 fg；`.on` 底 `--surface-3` 字 fg 边 `--border-hover`（:156-158） |
| `.chip-mono` 等宽小片 | mono 11px/500 底 `--surface-2` 边 `--border` 圆角 `6px` padding `5px 8px` `ls .02em` | 无态（:56） |
| `.dot` 状态点 | `8px` 圆（`.st` 行内缩 `7px`）；默认 faint、`.ok` success、`.warn` warn、`.err` danger | `.live` 加 pulse（:59-61） |
| pulse 呼吸 | `2.2s infinite`：`box-shadow 0 0 0 0 color-mix(success 50%,transparent)` 扩散到 `0 0 0 7px transparent` | 用于运行中来源与 pill 圆点 |
| `.mini-tag` | 10px warn 文字 + warn 35% 边，圆角 `4px` padding `1px 5px` `ls .04em`（「慢」标） | :126 |
| `.k` 关键词条 | mono 11px/500 圆角 `5px` padding `5px 8px`，普通 = fg on `--surface-3`；排除词 `.x` = danger-text on `color-mix(danger 10%,transparent)` | :212-213 |
| `.lg` 去向图例片 | 高 `28px` 圆角 `99px` 边 `--border` 底 `--surface-2` 字 muted 11.5px/500 + 7px 色点 + mono 600 11px 数字 | hover 字 fg 边 `--border-strong`；点击即筛选（:187-189） |
| `.pill`（标题栏，演示件形制可参考） | 圆角 99 底 `--surface-2` 边 `--border` 12px muted + 7px 呼吸点 | :57-60 |

### 3.7 按钮（:89-98）

- 默认 `.btn`：高 `36px`（`.sm` `30px`）圆角 `8px` padding `0 15px`（sm `0 11px`）；字 `500 13px/1`（sm 12px）`ls .02em`；边 `1px --border-strong` 底 `--surface-2`；`transition background .15s, border-color .15s, transform .1s`；图标 gap `8px`。
- hover：底 `--surface-3` 边 `--border-hover`；active：`translateY(1px)`；disabled：`opacity .55`。
- `.primary`：底 `--accent`、边透明、字 `--accent-ink` 600、阴影 `--shadow-cta`（顶缘 1px 白 30% 内高光 + accent 20% 光晕）；hover `color-mix(in oklab, accent 86%, white)`（浅色下自动变亮、深色下也提亮）。
- `.ghost`：底透明（设置页「新建规则」「恢复默认」用）。
- 刷新图标旋转：`.spin` `.7s ease` 一圈，重触发前 `void offsetWidth` 重置（JS :668）。

### 3.8 开关（:214-219）

- 尺寸 `38×21px` 圆角 99；`<input>` 透明覆盖全域点击。
- 轨道：底 `--surface-3` 边 `1px --border-strong`；滑块 `14px` 圆，`top 2.5px`，`left 3px → 19px`，色 `--muted → --fg`；全部 `transition .2s`。
- 选中：轨道底 `color-mix(in srgb, success 26%, var(--surface-2))` + 边 `--success`（绿=运行语义）。
- 原生 radio/checkbox `accent-color: var(--fg)`；range `accent-color: var(--info)` 宽 220px（:220-221）。

### 3.9 锚点导航（设置页，:194-199 + JS :746-758）

- 容器 `position:sticky; top:-26px`（吃掉 screen 顶 padding，滚动时钉在内容区顶）。
- 链接：padding `8px 11px` 圆角 `7px` 字 13px muted 边透明 `transition .15s`；编号 `b` = mono 600 10px faint `ls .05em`（01-05）。
- hover：fg + `--surface-hi`；`.on`：fg + `--surface-2` + 边 `--border`。
- 滚动定位：区块顶距容器顶 `≤70px` 即点亮当前锚（scroll 监听 passive）；点击平滑滚动到 `区块顶-16px`。

### 3.10 抽屉 + 遮罩（:229-253 + JS :723-744）

- 抽屉：右侧全高 `width 462px`（`max-width:88%`），底 `--surface` 左边框 `1px --border-strong` 阴影 `--shadow-drawer`，`z-index:40`（遮罩 39、toast 60、sticky 表头 2、grip 6）。
- 出入：`transform translateX(103%) ↔ none`，`.3s cubic-bezier(.2,.8,.2,1)`；遮罩 `opacity 0↔1` `.25s` + `pointer-events` 切换。
- 头 `.d-head`：padding `16px 18px 10px` 底线 `--border`，左 ph-tag 右关闭钮（28×28 圆角 7 边 `--border-strong`，hover 底 `--surface-2` 字 fg）。
- 体 `.d-body`：padding `18px 20px 26px` 独立滚动。
- 内件：`.d-title` 衬线 19px/1.5；`.d-price` = 底 `--surface-2` 边 `--border` 圆角 `10px` padding `11px 14px` 的价格+置信度条（价格 mono 16px，置信度 `b` 用 mono）；`.d-sec h5` 11px/600/`ls .1em` faint；命中原因列表 li 12.5px muted/1.65 + success 对勾 13px；`.quote` AI 锐评 = 衬线 13.5px/1.9 底 `--surface-2` 圆角 `10px` padding `14px 16px`；反馈钮 ghost sm，点击后 `.voted` = success 边+字。
- 关闭路径：关闭钮 / 遮罩点击 / `Escape`（三条都要，JS :740-742）。

### 3.11 Toast（:254-257 + JS :623-624）

- 容器：绝对定位 `bottom:22px` 水平居中，纵列 gap `8px`，`z-index:60`，`pointer-events:none`。
- 单条：底 `--surface-3` 边 `--border-strong` 圆角 `10px` padding `10px 18px` 12.5px/500，阴影 `--shadow-toast`；入场 `tIn .3s ease`（`translateY 10px→0`）。
- 生命周期：2600ms 后加 `.out`（`opacity .35s` 渐隐）→ 380ms 后移除 DOM。

### 3.12 去向分布分段条（:181-192 + JS :690-721）

- 条 `.dist`：高 `10px` 圆角 `5px`，段间 `gap 2px`，槽底 `--surface-2`；单段 `flex-grow: var(--w)` 圆角 `2px`。
- 七段固定色序：c1 未命中=`--seg-gray`、c2 排除词否决=`--info`、c3 价格不符=`--warn`、c4 评分不足=`--info-soft`、c5 重复·限频=`--seg-dark`、c6 暂停中=`--seg-mid`、c7 抓取失败=`--danger`。
- 图例 `.lg`（形制见 §3.6）与分段条**双向联动**：点图例 = 设筛选 + 平滑滚回顶部。
- 行内原因标记 `.rb`：7px 圆点（`.rdot` 同段色）+ 12px muted 文字；解释语 `.why` 11.5px faint/1.5 `max-width 560px`。

### 3.13 其余杂项形制

- 工具条 `.bar`：flex wrap gap `10px`，距下方 `14px`；搜索框图标绝对定位 `left 11px` 14px、输入 `padding-left 32px` 宽 `280px`。
- 输入件 `.ipt/.sel`：高 `34px` 圆角 `8px` 底 `--surface` 边 `--border-strong`，聚焦边 `--border-active`（`outline:none`）；`.ta` 最小高 `64px`；日期输入宽 `128px`。
- 规则卡 `.rule`：底 `--surface` 边 `--border` 圆角 `10px` padding `14px 16px`，内嵌 `.kws` 关键词条 wrap gap `6px`。
- 设置行 `.frow`：flex gap `16px` padding `13px 0` 虚线底线（`dashed --border`，末行无）；标签列 `150px`。
- 保存栏 `.savebar`：`sticky bottom:0`，负 margin `6px -30px -44px` 吃掉 screen 的 padding 再补 `14px 30px`；底 `color-mix(in srgb, var(--bg) 82%, transparent)` + `backdrop-filter:blur(10px)`，顶线 `--border`，按钮右对齐 gap `12px`。
- 滚动条：宽 `10px`，thumb 底 `--surface-3` 圆角 `6px`，`border 2px transparent` + `background-clip:content-box`（形成细条观感），轨道透明（:40-42）。
- 历史面板拖拽把手（:909-915 + JS :797-830）：竖把在面板左外 `-15px` 宽 `16px` col-resize，hover/拖拽中显示 2px accent 竖线（`.15s`）；横把贴底 `height 10px` row-resize，把手 thumb `36×3px` faint，面板 hover 时 `opacity .45`、拖拽中 `1` + accent。右栏宽限 `232-460px` 默认 `292px`，面板高下限 `220px`；`pointer capture` 拖拽、双击复位、localStorage 记忆。

---

## 4. 主题切换机制（concept.html:776-795）

概念稿实现要点，机制整体可迁移：

1. **单一真源**：`document.documentElement.setAttribute("data-theme", t)`，t 只有 `"dark" | "light"` 两值。深色是 `:root` 基线，浅色是 `:root[data-theme="light"]` 覆盖块；`color-scheme` 属性随主题声明（dark :11 / light :843），原生控件（表单、滚动条）自动跟随。
2. **三态存储**：localStorage 键 `"fw-theme"` 存用户意图 `"dark"（默认）| "light" | "system"`，与实际生效值分离。
3. **system 解析**：`window.matchMedia("(prefers-color-scheme: light)")`，`.matches ? "light" : "dark"`（:777-779）。
4. **URL 覆盖**：`?theme=light|dark|system` 优先于 localStorage（:785-786）——预览/走查用，应用迁移可不带。
5. **UI 同步**：三个 radio `input[name=theme]`，初始化时 `checked` 对齐存储值，`change` 即时应用 + toast 反馈（:787-791）。
6. **系统变化监听**：mq `change` 时**仅当存储值为 `system`** 才重新应用（:793-795）；`addEventListener`/`addListener` 双写兼容旧 API（Electron 44 只需前者）。
7. **防御**：所有 localStorage 读写包 `try/catch`（隐私模式/存储禁用时静默回退默认深色）。
8. 迁移注意：概念稿**深色为基线**、浅色为属性选择器覆盖。若应用侧想让「浅色为无属性默认」（贴近现 theme.css 的浅色基线结构），需把选择器方向反过来（浅色进 `:root`、深色进 `:root[data-theme="dark"]`）并同步翻转 `color-scheme`——两种方向等价，任选其一后全项目统一。另：同屏还需要「记住停留屏」的同类模式（`fw-screen`，:628-635），机制同款。

---

## 5. 概念演示件 vs 可迁移资产

### 5.1 演示件（**不迁移**，见到即弃）

| 演示件 | 位置 | 弃置理由 |
|---|---|---|
| 假 macOS 窗口：`.stage`/`.window` 外框、红绿灯 `--tl-r/y/g`、窗口圆角 14px、`--shadow-win`、`meta viewport width=1360` | :32,:45-46,:265、JS 无 | 应用是 Electron 原生标题栏窗口（src/main/desktop/window.ts:30-44 无 `frame:false`），无自绘标题栏 |
| 标题栏整条：`.titlebar`/`.t-lights`/`.t-name`/`.t-sub`/`.tag-proto`「概念原型 · 示例数据」 | :47-55,:265-274 | 同上；若迁移后需要页内状态 pill，`.pill` 形制可参考但位置另定 |
| 全部示例数据：`HITS` 8 条、`FEED` 追加 3 条、`DISPO` 10 条、`RULE/ST/CATC` 映射、`AIM` 模型预设表、bars7 高度、heat `--v`、kw 宽度与计数、dist `--w` 与图例计数、side-foot 文案、日期 2026-09-23~30、`7230981:FW-bot-token-sample` 假 token | :582-721 | 全是编造数据，接真实状态源 |
| 假交互：7s 定时插假命中流（JS :655）、countUp 固定目标 47/23/11/2（:641）、「测试连接」800ms 假延迟（:768-769）、保存/恢复默认只 toast「未真正写入」（:773-774） | JS | 换真实 API/事件 |
| localStorage 键 `fw-screen` / `fw-theme` / `fw-rail-w` / `fw-hist-h` | :632,:781,:808,:818 | **模式可借鉴、键名与归属按应用现有持久化方案重定**（主题键应进应用设置而非裸 localStorage，以现有 config 体系为准） |
| `data-od-id` 属性（app-window/titlebar/dashboard…） | 全文散布 | 设计走查标注，无样式作用 |
| `<style id="fw-theme-style">` 的「分块」这个形式本身 | :834 | 只是概念稿的增量修订手法；迁移时全部规则合并进正式样式文件 |

### 5.2 可迁移资产（**本次迁移的设计侧全部内容**）

1. 两套主题令牌全表（§1.1/§1.2，含 §1.5 两处对比度修正后的值）。
2. 字体三栈与四个衬线授权位（§2）。
3. 全部组件形制（§3.1-§3.13）：侧栏、stat 卡+spark、面板、表格（含 sticky 表头/列宽徽标档）、命中流、chip/badge/点/NEW/mini-tag、按钮三型、开关、锚点导航、抽屉、toast、去向分段条、迷你图表族（bars7/kw 条/heat 热力）、savebar、滚动条、拖拽把手。
4. 主题切换机制（§4）。
5. 动效清单与 `prefers-reduced-motion` 全局关停（§1.3）；`:focus-visible` 焦点环常显纪律。
6. 拖拽调宽/调高的 pointer 交互逻辑（pointer capture + 双击复位 + 记忆，JS :798-830）。
7. 图例↔筛选双向联动、锚点滚动定位逻辑（scroll-spy 70px 阈值）。

### 5.3 迁移落差备忘（概念稿与仓库现实的已知冲突，实施前必读）

- **宽度体系**：概念稿按 `min-width:1150px` 的 1480px 桌面画（:46，viewport 1360），dash 主区 `5fr/7fr` 双栏、侧栏 218px；应用窗口默认 980×700、minWidth 960（window.ts:31-34）。**不能照搬栅格**——双栏、stat 四列、抽屉 462px 都要按 960px 重排验证，本手册给的是形制与令牌，不是布局锁定值。
- **字号体系**：概念稿 14 档散值（9.5-30px）vs 现 theme.css 的 `--fs-*` 10 档（12-32px，theme.css:126-135）。迁移应收编进现有 `--fs-*` 阶（如 27→`--fs-26`、30→`--fs-32`、13.5→`--fs-13`），不要新增一档一个值。
- **动效**：概念稿无 `--t-*` 变量而项目有（theme.css:175-179）；迁移时 `.12s/.15s→--t-fast`、`.2s-.3s→--t-base/--t-glide` 对号入座，勿再散写。
- **等宽栈顺序**：见 §2.3——建议沿用项目现栈（`ui-monospace` 打头）。
- **对比度**：§1.5 两处必改（深色 faint 加深、浅色拆 warn-text），其余实算通过。
- **圆角**：概念稿 12 档 vs 项目三档（`--r-card 16/--r-ctl 12/--r-pill 999`，theme.css:160-162）。概念稿整体更收（面板 12/控件 8）；迁移时要么按概念稿扩档、要么映射到现有档，二选一后在 theme.css 头注释里记一笔——不要两套并存。
