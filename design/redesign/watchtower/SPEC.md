# 瞭望塔换装实施规范（Watchtower SPEC）

> **定位**：本次界面换装的**唯一裁决文档**。实施者（共享层 / 四域 / 机制 / 验收）只认本文件；
> 与 `DESIGN-LANGUAGE.md`（设计侧手册）或 `CURRENT-UI-MAP.md`（代码侧盘点）冲突时，以本文件为准。
>
> **输入**：`design/redesign/watchtower/DESIGN-LANGUAGE.md`（概念稿解析）、
> `design/redesign/watchtower/CURRENT-UI-MAP.md`（仓库现状盘点）、
> `design/redesign/watchtower/concept.html`（917 行概念稿）与 `src/renderer/src/` 源码。
> **证据口径**：两份输入文档的关键行号主张（events.css 行区间、死类、暗色停用点、700 字重分布、
> fs 阶引用计数、旧名引用普查）已在本 session 逐一回读源码复核；全部对比度数字为本 session
> python 实算（OKLab→sRGB Ottosson 矩阵 + WCAG 相对亮度；`color-mix`/rgba 合成按 sRGB gamma
> 空间逐通道混合），脚本为临时文件未入库，口径与 DESIGN-LANGUAGE 头注一致。
> **未运行** typecheck / test / build（工作纪律：验收阶段统一跑）。
>
> **实施一律写 oklch 原值**（Electron ^44 = Chromium 126+，`oklch()`/`color-mix()` 可直接用，
> theme.css:80 已有先例）；hex 列仅供调试对照。标注 † 的 oklch 在 sRGB 色域外，hex 为逐通道
> 裁切近似，与浏览器 CSS Color 4 降 chroma 映射可能有 1-2 个 8bit 色阶差异——**所见即所得以
> oklch 为准**。

---

## §1 总则与范围

### 1.1 设计语言（一句话裁决）

**深色「瞭望塔」为默认主题**：炭蓝表面阶梯（hue 258-260）+ 琥珀信号色 accent（hue 70）+
衬线页题 × 系统 sans 正文 × 等宽数字。**浅色「晨报」**：同一套变量名全部换值（hue 255 暖白冷调）。
**跟随系统**为第三态。层次靠**表面逐档提亮（深）/逐档压暗（浅）+ 1px 低透明度边框**，不靠重阴影；
浮层（保存栏 / 主按钮 / 报表浮条）才用扩散阴影。这套语言落到**全部五页**：监控台 / 去向 /
历史命中 / 日报 / 设置（侧栏五 tab 结构不变，`App.tsx:44-50`）。

### 1.2 明确不做（负面清单，验收对照）

| # | 不做 | 理由 / 依据 |
|---|---|---|
| 1 | **自定义标题栏**（假窗口、红绿灯、`.stage/.window/.titlebar`、`--tl-*`、`--shadow-win` 演示件） | 应用是 Electron 原生窗口框（`src/main/desktop/window.ts` 无 `frame:false`，见 DESIGN-LANGUAGE §5.1） |
| 2 | **信息架构 / 导航变更** | 侧栏五分区、设置六组、keep-alive page-host 结构、锚点深链体系全部保留（CURRENT-UI-MAP §6.3：合并导航属产品决策，超出本次） |
| 3 | **新增数据功能** | 不加任何新 IPC / 新数据面 / 新筛选聚合。概念稿的 7 段去向分布条（.dist/.lg 双向联动）、stat 卡 sparkline 走势图、countUp 数字滚动、7s 假命中流、抽屉、toast、面包屑式 NEW 标流——**全部不迁移**（前两者需要新数据面，其余为演示件或与现有反馈机制重复） |
| 4 | **零网络字体 / 零图标库** | 红线不变（CSP `default-src 'self'` 兜底，index.html:8-9）；衬线标题只用系统字体栈（§2.7） |
| 5 | **无限循环装饰动画**（概念 2.2s pulse 呼吸） | 项目纪律「无无限循环装饰动画」（CURRENT-UI-MAP §3）；现行 `.follow-dot` 无动画即先例 |
| 6 | 布局栅格照搬概念稿 | 概念按 1480px/min-1150 画；应用窗口默认 980×700、minWidth 960（DESIGN-LANGUAGE §5.3）。本规范给形制与令牌，**不给布局锁定值**；所有栅格按 960px 宽重排验证 |
| 7 | git commit / push；改动 out/ dist/ | 工作纪律 |

### 1.3 阶段纪律（对全部实施者生效）

1. **先机械后换装**：`styles/reports.css` 的拆出（§4）是零改写的逐字搬移，独立成一次提交；
   值调整 / 重命名 / 换装全部放后续提交，便于 diff 审阅（仓库先例：fade-in 迁 base.css「内容逐字
   未动」，base.css:89-92）。
2. **类名是行为契约**：改名前必过 §7.3 的运行时 querySelector 清单（无 DOM 测试兜底，改名只炸
   运行时）。本次换装**原则上零类名变更**（死类清理除外，见 §5）。
3. **不动业务逻辑与数据流**：各域 tsx 的 props / hooks / IPC 消费 / 键盘 roving / 深链全部原样；
   tsx 侧预期改动仅限 className 拼接与注释。
4. 对比度纪律沿用：**正文文字 ≥4.5:1，图形/UI ≥3:1**（theme.css 头注先例）；分隔线属装饰档豁免
   （现行 `--line #E3E9F1` on card ≈1.2 的既有实践）。

---

## §2 令牌终表

### 2.1 theme.css 目标结构

```
:root                        ← 深色「瞭望塔」基线（新原语令牌 + 尺度令牌 + color-scheme: dark）
:root[data-theme="light"]    ← 浅色「晨报」覆盖（同名换值 + color-scheme: light）
:root（第二块）              ← R12 名衍生层（--card/--text-2/--ok… 全部 var() 指向新原语）
:root（第三块，现行 259-287）← 遗留别名层，原样保留（删 3 行，见 §2.6）
```

方向裁决：**深色为 `:root` 基线、浅色为属性选择器覆盖**（与概念稿同向，DESIGN-LANGUAGE §4-8
两方向等价、任选其一后全项目统一——本规范选深色基线，因默认主题即深色，无属性时即正确）。
现 `theme.css:190-256` 的「恒假媒体查询停用暗色块」**整体删除**（被新基线取代）；`theme.css:50`
的 `:root{color-scheme:light}` 移入两个主题块各自声明。衍生层只写 `var()` 引用，浅色块覆盖
原语后衍生名自动跟随（现行 `--bg: var(--color-background)` 同机制）。

### 2.2 深色「瞭望塔」终表（`:root` 基线）

**表面阶梯**（自外向内逐档提亮）：

| 变量 | oklch 终值 | hex 近似 | 用途 |
|---|---|---|---|
| `--bg` | `oklch(0.155 0.015 260)` | `#090C13` | 窗口底 / 主内容区底（body、.page） |
| `--surface` | `oklch(0.195 0.016 258)` | `#10151C` | 一级表面：卡、侧栏、面板、输入框底、报表浮条、保存栏 |
| `--surface-2` | `oklch(0.23 0.017 258)` | `#181D25` | 二级表面：嵌井（card-alt）、chip-mono/中性 chip 底、展开行底、日志井 |
| `--surface-3` | `oklch(0.268 0.018 258)` | `#21262F` | 三级表面：默认按钮底、开关轨道、选中 chip/选中行底、滚动条 thumb |
| `--surface-hi` | `oklch(0.295 0.019 258)` | `#272D36` | **悬停底专用**：行 hover、nav hover、feed 行 hover |

**文字色阶**（对比度：on bg / surface / surface-2 / surface-3）：

| 变量 | oklch 终值 | hex 近似 | bg | surface | s2 | s3 | 结论 |
|---|---|---|---|---|---|---|---|
| `--fg` | `oklch(0.95 0.004 90)` | `#EFEEEB` | 16.86 | 15.79 | 14.58 | 13.09 | ✓ 全过 |
| `--muted` | `oklch(0.7 0.012 258)` | `#9A9FA6` | 7.34 | 6.88 | 6.35 | 5.70 | ✓ 全过 |
| `--faint` | `oklch(0.62 0.012 258)` **（修正①）** | `#82868E` | 5.36 | 5.02 | 4.63 | **4.16 ✗** | ✓ 限 surface/s2/bg；**禁落 surface-3 / surface-hi（3.80 ✗）**，落法见 §3.4 |

**琥珀 accent**：

| 变量 | oklch 终值 | hex 近似 | 对比度 | 结论 |
|---|---|---|---|---|
| `--accent` | `oklch(0.79 0.135 70)` | `#F1AA4F` | on surface 9.25 / s2 8.54 / s3 7.67 | ✓ 图形与文字双过 |
| `--accent-ink` | `oklch(0.2 0.05 70)` † | `#241100` | on accent 9.18；on hover #F3B668 10.13 | ✓ |
| `--accent-text` | `= var(--accent)`（深色不分档） | — | 同 accent | ✓ |

**语义色**（点/描边档 on surface / surface-2 / 自家 12% wash）：

| 变量 | oklch 终值 | hex 近似 | surface | s2 | wash | 结论 |
|---|---|---|---|---|---|---|
| `--ok`（success） | `oklch(0.74 0.14 152)` | `#5DC47E` | 8.43 | 7.78 | 6.89 | ✓ |
| `--err`（danger） | `oklch(0.66 0.19 27)` | `#F0574E` | 5.39 | 4.98 | 4.75 | ✓ |
| `--warn` | `oklch(0.83 0.15 98)` | `#E1C841` | 10.94 | 10.10 | 8.67 | ✓ |
| `--info` | `oklch(0.72 0.115 240)` | `#5AAEE5` | 7.52 | 6.94 | 6.24 | ✓ |
| `--info-soft` | `oklch(0.79 0.08 240)` | `#8BC2E9` | 9.59 | 8.85 | — | ✓ |

**语义文字档**（on surface / surface-2 / surface-3 / 自家 12% wash over surface）：

| 变量 | oklch 终值 | hex 近似 | surface | s2 | s3 | wash | 结论 |
|---|---|---|---|---|---|---|---|
| `--ok-text`（success-text） | `oklch(0.8 0.11 155)` | `#81D39F` | 10.25 | 9.47 | 8.50 | 8.38 | ✓ |
| `--err-text`（danger-text） | `oklch(0.75 0.1 25)` | `#E7958E` | 7.93 | 7.32 | 6.57 | 6.98 | ✓ |
| `--warn-text` | `= var(--warn)`（深色不分档） | — | 10.94 | 10.10 | 9.07 | 8.67 | ✓ |
| `--ai-text` | `= var(--info-soft)` | — | 9.59 | 8.85 | 7.95 | 7.96 | ✓ |

**弱底 chip**：`--ok-chip / --err-chip / --warn-chip / --ai-chip` 一律
`color-mix(in srgb, <对应点档> 12%, transparent)`（概念 b-kw 14% / b-price 12% / k.x 10% 的收口值，
实算见上表 wash 列）。`--mute-chip: var(--surface-2)`。`--ai: var(--info)`。

**边框与焦点**：

| 变量 | 终值 | 用途 / 结论 |
|---|---|---|
| `--border` | `rgba(255,255,255,0.08)` | 常规分隔（面板缘、行线、侧栏右缘）。装饰档豁免 ≥3（先例：现行 `--line`） |
| `--border-strong` | `rgba(255,255,255,0.16)` | **仅装饰性描边**（默认按钮外缘、badge 边、虚线井边）。作输入边界不达标（≈1.35），见修正③ |
| `--border-hover` | `rgba(255,255,255,0.28)` | hover 边框（装饰档） |
| `--border-active` | `= var(--focus-ring)` **（修正⑤）** | 输入聚焦边框 |
| `--input-border` | `oklch(0.55 0.012 258)` = `#6D7279` **（修正③）** | 输入框功能边界：on surface **3.78** / s2 3.49，UI≥3 ✓ |
| `--focus-ring` | `= var(--accent)` **（修正④）** | `:focus-visible` 环与输入聚焦：9.25+，UI≥3 ✓ |

**实底色块文字**（沿用「实底文字只走 ink 档」纪律）：

| 变量 | 终值 | 对比度 |
|---|---|---|
| `--on-danger` | `oklch(0.2 0.05 25)` † = `#290B0A` **（修正⑧）** | on `--err` 5.39 ✓ |
| `--hover-danger-bg` | `color-mix(in srgb, var(--err) 86%, white)` = `#F26F67` | 深墨字 6.32 ✓ |

**阴影**（§2.8 详表）。`--scroll-thumb: var(--surface-3)`（概念滚动条 thumb 档；**装饰档豁免**
——实算深 1.21-1.29 / 浅 1.17-1.27、hover 档 1.38，与现行 `--scroll-thumb #C9D4E2` ≈1.15 同档，
非回归且系概念原样；滚动条不属「识别 UI 所必需的图形信息」，豁免口径同 §1.3-4 分隔线先例）。
兼容层：`--primary-wash: color-mix(in srgb, var(--fg) 8%, transparent)`（合成 ≈ `#22262D`，
近似 surface-hi 的中性 hover 底）；`--primary-text: var(--accent-text)`。
sparkbar 柱：`color-mix(in srgb, var(--info) 55%, transparent)` = `#39698B`，vs surface **3.11** ≥3 ✓。

### 2.3 浅色「晨报」终表（`:root[data-theme="light"]`）

**表面阶梯**：

| 变量 | oklch 终值 | hex 近似 |
|---|---|---|
| `--bg` | `oklch(0.965 0.005 255)` | `#F1F4F7` |
| `--surface` | `oklch(0.995 0.003 255)` † | `#FCFEFF` |
| `--surface-2` | `oklch(0.955 0.006 255)` | `#EDF0F4` |
| `--surface-3` | `oklch(0.915 0.008 255)` | `#DFE3E8` |
| `--surface-hi` | `oklch(0.89 0.01 255)` | `#D6DBE1` |

**文字色阶**（bg / surface / s2 / s3）：

| 变量 | oklch 终值 | hex 近似 | bg | surface | s2 | s3 | 结论 |
|---|---|---|---|---|---|---|---|
| `--fg` | `oklch(0.25 0.02 260)` | `#1C222B` | 14.49 | 15.81 | 13.99 | 12.41 | ✓ |
| `--muted` | `oklch(0.46 0.02 260)` | `#525864` | 6.47 | 7.06 | 6.25 | 5.54 | ✓ |
| `--faint` | `oklch(0.52 0.02 262)` | `#636975` | 5.00 | 5.45 | 4.82 | **4.28 ✗** | ✓ 限 surface/s2/bg；禁落 s3（4.28）/ surface-hi（3.96） |

**accent**：

| 变量 | oklch 终值 | hex 近似 | 对比度 | 结论 |
|---|---|---|---|---|
| `--accent` | `oklch(0.54 0.125 70)` | `#9C5F00` | surface 5.13 / s2 4.54 / s3 **4.02 ✗(文字)** | 图形 ✓；**文字限 surface/s2** |
| `--accent-ink` | `oklch(0.99 0.005 90)` | `#FDFCF8` | on accent 5.05；on hover #865200 6.35 | ✓ |
| `--accent-text` | `oklch(0.48 0.13 70)` **（修正⑦）** | `#8A4C00` | surface 6.67 / s2 5.90 / 中性 wash 5.28 | ✓ |
| `--hover-primary-bg` | `color-mix(in oklab, var(--accent) 86%, black)` = `#865200` **（修正⑥）** | — | accent-ink 6.35 | ✓ |

**语义点/描边档**（surface / s2 / 自家 12% wash）：

| 变量 | oklch 终值 | hex 近似 | surface | s2 | wash | 结论 |
|---|---|---|---|---|---|---|
| `--ok` | `oklch(0.52 0.13 155)` † | `#007E46` | 5.10 | 4.51 | 4.33 | ✓ |
| `--err` | `oklch(0.52 0.19 25)` | `#BE222A` | 6.01 | 5.32 | 4.96 | ✓ |
| `--warn` | `oklch(0.58 0.13 95)` | `#937800` | 4.21 | 3.73 | 3.65 | **点/描边 ✓（≥3）；禁作文字** |
| `--info` | `oklch(0.48 0.12 235)` † | `#006697` | 6.20 | 5.49 | 5.20 | ✓ |
| `--info-soft` | `oklch(0.44 0.1 235)` † | `#005A81` | 7.47 | 6.61 | 6.26 | ✓ |

**语义文字档**：

| 变量 | oklch 终值 | hex 近似 | surface | s2 | wash | 结论 |
|---|---|---|---|---|---|---|
| `--ok-text` | `oklch(0.42 0.12 155)` † | `#005F2E` | 7.76 | 6.86 | 6.59 | ✓ |
| `--err-text` | `oklch(0.5 0.18 25)` | `#B32228` | 6.54 | 5.78 | 5.39 | ✓ |
| `--warn-text` | `oklch(0.46 0.13 95)` **（修正②）** | `#6F5500` | 6.98 | 6.17 | 6.04 | ✓ |
| `--ai-text` | `= var(--info-soft)` | — | 7.47 | 6.61 | 6.26 | ✓ |

**边框/焦点/杂项**：`--border: rgba(20,30,50,0.10)`；`--border-strong: rgba(20,30,50,0.18)`；
`--border-hover: rgba(20,30,50,0.30)`；`--border-active: var(--focus-ring)`；
`--input-border: oklch(0.6 0.015 258)` = `#7B8189`（surface **3.89** / s2 3.44 / s3 3.05 ✓）；
`--focus-ring: var(--accent)`（5.13 ✓）；`--mute-chip / --scroll-thumb: var(--surface-2) / var(--surface-3)`
（thumb 装饰档豁免同深色，§2.2 注）；
`--on-danger: #FFFFFF`（on err 6.08 ✓）；`--hover-danger-bg: oklch(0.46 0.19 25)` = `#A90017`（白字 7.78 ✓）；
`--primary-wash: color-mix(in srgb, var(--fg) 12%, transparent)`（合成 ≈ `#E1E4E6`，近似 surface-hi）。
chip 族同深色口径（12% wash）。

### 2.4 概念稿色值不达标微调清单（8 条，实施必读）

本 session 按 WCAG 公式对概念稿全表复算，以下 8 处与项目纪律冲突，**以纪律为准**微调：

| # | 概念原值 | 问题（实算） | 终值（已入 §2.2/2.3 表） |
|---|---|---|---|
| ① | 深色 `--faint oklch(0.55 0.012 258)` | 承载文字 on surface **3.78** / s2 3.49 / bg 4.04，全部 <4.5（`.tm/.src/.delta/.why/表头` 等 9.5-11.5px 元信息是正文性质） | `oklch(0.62 0.012 258)`：surface 5.02 / s2 4.63 / bg 5.36 全过。**仍禁落 surface-3（4.16）与 surface-hi（3.80）**——升档规则见 §3.4 |
| ② | 浅色 `--warn oklch(0.58 0.13 95)` 兼作 mini-tag 文字 | 4.21 <4.5 | 新拆 `--warn-text: oklch(0.46 0.13 95)` #6F5500（6.98/6.17）；点/描边继续 `--warn`。深色 warn 10.94 不分档 |
| ③ | `--border-strong`（白 16% / 墨 18%）兼作输入边界 | 深色 ≈1.6 / 浅色 ≈1.5，UI≥3 不达 | 输入边界独立 `--input-border`（深 #6D7279 =3.78 / 浅 #7B8189 =3.89）；`--border-strong` 降级为纯装饰描边。分隔线弱值保留（装饰豁免，同现行 `--line` 纪律） |
| ④ | `--focus-ring`（深白 35% / 浅墨 45%） | 深 3.22 临界、浅 **2.83 <3** | `var(--accent)`：深 9.25 / 浅 5.13 |
| ⑤ | `--border-active`（深白 32%） | 2.89 <3 | `var(--focus-ring)`（输入聚焦另有 accent 外环，复合可辨） |
| ⑥ | 主按钮 hover `color-mix(accent 86%, white)` 两主题同向 | 浅色 hover 底 #AA7524 上 accent-ink 仅 **3.87 <4.5** | 深色保持加白（10.13 ✓）；浅色反向加黑 `color-mix(in oklab, var(--accent) 86%, black)` #865200（6.35 ✓） |
| ⑦ | （概念缺失）琥珀小字档 | 浅色 accent #9C5F00 在中性 wash（#E1E4E6）上 4.06 <4.5；兼容层 `--primary-text`（wash 底强调文字，20 处在引）需要深一档 | 新增 `--accent-text`：深 = accent 直用；浅 `oklch(0.48 0.13 70)` #8A4C00（wash 5.28 ✓） |
| ⑧ | （概念缺失）实底 danger 文字 | 概念无实底 danger；项目 `.btn-danger-solid` 需要 | 深色 `--on-danger: oklch(0.2 0.05 25)` #290B0A（5.39）；浅色白（6.08）。hover 档见 §2.2/2.3 |

其余实算通过项（抽样备查）：两主题 fg/muted/accent/accent-ink/ok-text/err-text/info-soft 全 ≥4.5
（浅色 accent 文字限 surface/s2）；语义点与描边在 surface 上全 ≥3（最浅为浅色 warn 4.21 作图形 ✓）；
chip 文字对自家 12% wash 全 ≥5.2；muted on surface-hi 5.20/5.13 ✓。

### 2.5 R12 名衍生层（新旧 token 对照；~1300 处既有引用靠它继续工作）

本 session 引用普查（`grep -ro "var(--名)"` styles+components+pages）：--text-3 ×87、--text-2 ×50、
--fg ×28、--line ×28、--card-alt ×25、--warn-text ×23、--font-mono ×23、--primary-wash ×20、
--mute-chip ×19、--err-text ×21、--ok/--ok-text/--warn/--err ×13-19、--color-primary ×18……
全部按下表衍生，**域文件在换装阶段前零改动也不破**：

| R12 名（旧） | 衍生为（新） | | R12 名（旧） | 衍生为（新） |
|---|---|---|---|---|
| `--color-primary` | `var(--accent)` | | `--rail-bg` | `var(--surface)` |
| `--color-on-primary` | `var(--accent-ink)` | | `--rail-fg` | `var(--fg)` |
| `--color-foreground` | `var(--fg)` | | `--rail-fg-2` | `var(--muted)` |
| `--color-background` | `var(--bg)` | | `--rail-bar` | `var(--accent)` |
| `--color-muted` | `var(--surface-2)`（R12 语义即嵌井） | | `--rail-active-bg` | `var(--surface-3)` |
| `--color-border` | `var(--border)` | | `--rail-hover` | `var(--surface-hi)` |
| `--card` | `var(--surface)` | | `--rail-press` | `color-mix(in srgb, var(--fg) 12%, transparent)` |
| `--card-alt` | `var(--surface-2)` | | `--rail-line` | `var(--border)` |
| `--raised` | `var(--surface)` | | `--rail-tone-ok/err/warn` | `var(--ok)/var(--err)/var(--warn)` |
| `--text-2` | `var(--muted)` | | `--rail-tone-ai` | `var(--info)` |
| `--text-3` | `var(--faint)` | | `--primary-text` | `var(--accent-text)` |
| `--line` | `var(--border)` | | `--primary-wash` | §2.2/2.3 中性 fg wash |
| `--input-border` | §2.2/2.3 独立值 | | `--btn-primary-bg` | `var(--accent)` |
| `--ring` | `var(--focus-ring)` | | `--hover-primary-bg/-fg` | §2.2/2.3 / `var(--accent-ink)` |
| `--scroll-thumb` | `var(--surface-3)` | | `--hover-danger-bg` | §2.2/2.3 |
| `--mute-chip` | `var(--surface-2)` | | `--danger-solid-bg` | `var(--err)` |
| `--ai / --ai-text / --ai-chip` | `var(--info) / var(--info-soft) / mix(info 12%)` | | `--on-danger` | §2.2/2.3 |
| `--ok/--err/--warn` + `-text/-chip` | §2.2/2.3 直取（同名换值） | | `--bg-sidebar` | `var(--rail-bg)`（原定义在 R12 直值块 theme.css:185，随块删除——收进衍生层续命；全库引用实测 0，纯兜底） |

### 2.6 遗留别名层处置（现行 theme.css:259-287）

**原样保留，删 3 行**：`--accent: var(--color-primary)`、`--border: var(--line)`、
`--border-strong: var(--input-border)`。原因：这三个名字在新体系里升为**原语令牌**（直接持值），
而衍生层又把 `--color-primary: var(--accent)`、`--line: var(--border)` 指回来——三条别名不删会形成
**var() 循环引用，令牌双双失效**（CSS custom property cycle → guaranteed-invalid）。实测引用为 0
（`var(--border)` / `var(--border-strong)` 于 styles+tsx 零命中，唯一 `var(--accent)` 在
icons.tsx:119，改由新原语直接供值——琥珀信号点，正是设计意图，**该行不动**）。其余别名
（`--text/--on-accent/--chip-bg/--shadow/--space-1..6/--radius-*` 等）无循环，继续兜底。
注意：`--bg-sidebar` 不在本层——其唯一定义在 R12 直值块（theme.css:185，随 §3.1 整体删除），
已在 §2.5 衍生层补一行续命。

### 2.7 字体三栈与衬线授权位

```css
--font-display: "Noto Serif SC","Songti SC","STSong","Source Han Serif SC","SimSun",serif; /* 新增 */
--font-ui:      -apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Noto Sans SC',sans-serif; /* 现值保留 */
--font-mono:    ui-monospace,'SF Mono','JetBrains Mono','Cascadia Mono',Consolas,monospace; /* 现值保留（ui-monospace 打头，DESIGN-LANGUAGE §2.3 裁决） */
```

零网络字体红线（theme.css:6 先例）：三栈全部系统字体，**不打包、不引入任何字体文件**；
跨平台降级预期（Windows 落 SimSun、Linux 可能落黑体）是既定代价，不做补救
（DESIGN-LANGUAGE §2.3 已如实写明，迁移时照抄进 theme.css 头注）。

**衬线 `--font-display` 只授权 3 处**（对齐概念稿四个衬线位中在应用内有对应物的三个；
应用无抽屉，`.d-title` 无落点）：

| # | 位置 | 规格 | 样式落点 |
|---|---|---|---|
| 1 | 页题 `.page-title`（五页 PageHeader） | `600 var(--fs-26)/var(--lh-display)` + `var(--ls-display)` | primitives.css:921-929 |
| 2 | 日报日题 `.report-title` | `600 var(--fs-22)/var(--lh-display)` + `var(--ls-display)` | events.css:223-230 → 拆分后 reports.css |
| 3 | 设置组头 `.group-head` | `600 var(--fs-16)/var(--lh-base)`（概念设置小节题 17px 衬线的对位） | primitives.css:12-18 |

**700 字重纪律同步修订**：衬线 display 位随概念稿转 **600**（serif 视觉重量足够）；**700 只授权
KPI 大数字 `.metric .v`**（dashboard.css:146-159 + 历史页上下文复写 events.css:1089-1094，共 2 处，
均 mono 栈）。theme.css 头注的「三处 700」表述改为「两个文字 display 位 = 衬线 600；KPI display 位 =
mono 700」。衬线**禁止**扩散到按钮/输入/chip/badge/nav/表格（违例即验收不通过）。

**字阶收敛**：删除零引用档 `--fs-20/--fs-24/--fs-28`（本 session grep 实测 0 引用；保留档
12/13/14/16/22/26/32）。概念稿 14 档散值收编映射：9.5/10/10.5/11/11.5→`--fs-12`；12.5/13.5→`--fs-13`；
14→`--fs-14`；17→`--fs-16`；27→`--fs-26`；30→`--fs-32`；19（抽屉题）无对应物不迁移。行高/字距/
间距令牌全部沿用现值。

### 2.8 圆角、阴影、动效终值

**圆角**（概念 12 档 → 项目三档制，按概念稿整体收一档；在 theme.css 头注记一笔，勿两套并存——
DESIGN-LANGUAGE §5.3 要求）：`--r-card: 12px`（16→12，卡/浮层/面板）；`--r-ctl: 8px`（12→8，
按钮/输入/nav pill/实体行）；`--r-pill: 999px` 不变。概念 2-7px 小件（热力格/分段条/mini-tag/badge）
一律取 `4px` 字面值或并入 `--r-ctl`，不设新档。

**阴影**（层次让位边框，浮层才用阴影）：

| 令牌 | 深 | 浅 | 消费 |
|---|---|---|---|
| `--shadow-sm` | `0 0 0 0 transparent` | 同 | **no-op**：卡片平面化（border 分层）。不得写 `none`——`.card` 的 `box-shadow: var(--shadow-sm), var(--edge-top)` 是列表语法 |
| `--shadow-md` | `0 6px 18px oklch(0 0 0/0.35)` | `0 6px 18px rgba(20,30,50,0.18)` | 小浮条（report-tabs/report-rail）、漂浮横幅 |
| `--shadow-lg` | `0 14px 38px oklch(0 0 0/0.5)` | `0 14px 38px rgba(20,30,50,0.20)` | 浮层兜底（现零引用，保留档） |
| `--shadow-xl` | `0 40px 120px oklch(0 0 0/0.55)` | `0 30px 90px rgba(20,30,50,0.20)` | 窗口级浮层（概念 --shadow-win 值；savebar 换装后不再需要，见 §5 设置域） |
| `--shadow-cta` | `inset 0 1px 0 rgba(255,255,255,.3), 0 6px 18px color-mix(in srgb,var(--accent) 20%,transparent)` | `inset 0 1px 0 rgba(255,255,255,.35), … 30%…` | 主按钮/实底角标（概念 §1.1） |
| `--edge-top` | `inset 0 1px 0 rgba(255,255,255,0.05)` | `inset 0 1px 0 rgba(255,255,255,0.6)` | 顶缘发丝光 |
| `--inset-field` | `inset 0 1px 2px rgba(0,0,0,0.3)` | 现值保留 | 输入内凹 |

**动效**：令牌沿用（`--t-fast 120ms / --t-base 200ms / --t-glide 280ms` + 双缓动）。概念散值对号
入座：`.12s/.15s→--t-fast`、`.2s→--t-base`、`.25s/.3s→--t-glide`；概念唯一自定义缓动
`cubic-bezier(.2,.8,.2,1)` 属抽屉，**不迁移**。`prefers-reduced-motion` 全局熔断已存在
（base.css:79-87，0.01ms 技术），保留现状即合规。

---

## §3 共享层改造指令

### 3.1 theme.css（令牌唯一来源）

按 §2.1 结构重写：新 `:root` 深色基线（§2.2 全表 + 尺度令牌沿用 + `color-scheme: dark`）→
`:root[data-theme="light"]` 浅色块（§2.3 + `color-scheme: light`）→ R12 衍生层（§2.5）→ 遗留别名层
（§2.6，删 3 行）。删除现行 188-257 恒假媒体查询暗色块与 48-187 的 R12 直值块
（`#2563EB/#1D4ED8/#F6F8FC/#1E252F/#262E3A…` 随之清零）。头注重写：对比度纪律与实算摘要、
圆角收档记录（§2.8）、衬线授权位与 700 修订（§2.7）、字体降级预期（§2.7）、oklch 实施纪律。
theme.css 保持零组件规则（`color-scheme` 声明是唯一例外，先例 theme.css:50）。

### 3.2 base.css

- body：`background: var(--bg)` / `color: var(--fg)` / `--font-ui` 不变（token 自动换相）。
- 滚动条改概念配方（concept.html:40-42）：宽高 `10px`；thumb `background: var(--surface-3)`
  + `border-radius: 6px` + `border: 2px solid transparent` + `background-clip: content-box`
  （细条观感）；thumb:hover → `var(--surface-hi)`（替换现行 `--text-3 65%` 混色）；轨道透明。
- `:focus-visible` 保持 `var(--ring)`（衍生为 accent，§2.2 修正④）。
- `user-select` 白名单、`.sr-only`、`fade-in`、`.num`、reduced-motion 熔断：**零改动**。

### 3.3 primitives.css / shell.css / global.css

**primitives.css**（共享件层；按件给终态，未列件 = token 衍生自动换装、零改动）：

| 件 | 改造指令 |
|---|---|
| `.card` | `border: 1px solid var(--border)`；`box-shadow: var(--shadow-sm), var(--edge-top)` 保留（sm 已 no-op）；圆角随 `--r-card`(12) 自动 |
| `.card-head` | 头带底 `color-mix(in srgb, var(--card-alt) 60%, transparent)` → **`transparent`**（概念 panel-h 无头带，层次交给底线）；`border-bottom: 1px solid var(--border)` 自动 |
| `.page-title` | 衬线授权位 1：`font-family: var(--font-display); font-weight: 600`（fs-26/lh-display/ls-display 现值保留） |
| `.group-head` | 衬线授权位 3：`font-family: var(--font-display)`（16/600 现值保留） |
| `.btn` | 底 `var(--surface-2)`、边 `var(--border-strong)`、hover 底 `var(--surface-3)` + 边 `var(--border-hover)`、active `translateY(1px)`（概念 §3.7）；尺寸档（32/28/40）与 gap 不动 |
| `.btn-primary` | 底 `var(--accent)`、字 `var(--accent-ink)`、`box-shadow: var(--shadow-cta)`；hover 走 `--hover-primary-bg/-fg`（§2 修正⑥已按主题定向） |
| `.btn-danger` | 边 `color-mix(in srgb, var(--err) 55%, transparent)`、字 `var(--err-text)`、hover 底 `var(--err-chip)`（值自动换 wash） |
| `.input` 族 | 底 `var(--surface)`（= card 衍生）、边 `var(--input-border)`；`:focus` 边 `var(--focus-ring)` + 外环 accent 45%（现行 ring 公式自动）；禁用态结构不动 |
| `.chip`（命中词） | 中性化：`background: var(--surface-3); color: var(--fg)`（概念 `.k` 普通档）；r-pill 保留 |
| `.src-badge` | `background: transparent; border: 1px solid var(--border); color: var(--muted)` |
| `.quick .btn.active / .input-row .btn.active` | 选中档改 `background: var(--surface-3); color: var(--fg); border-color: var(--border-hover)`（概念 chip.on；替 wash+primary-text） |
| `.row-selected` | `background: var(--surface-3); box-shadow: inset 0 0 0 1px var(--border-strong)`（替 wash+左 3px 条+ring；概念选中 = 色阶提升 + 描边）。**保留** `--text-3: var(--text-2)` 就地 remap——新理由：faint on surface-3 4.16 <4.5（§2 修正①），选中行内的元信息文字需要升档 |
| `.switch` | 轨道 off = `var(--surface-2)` + `var(--border-strong)`；滑块 `background: var(--muted)`（**必须改**——现值 `var(--card)` 衍生为 surface，暗色下与 surface-2 轨道不可辨）+ 现行内描边保留；on 轨 `color-mix(in srgb, var(--ok) 26%, var(--surface-2))` + 边 `var(--ok)`，滑块 on = `var(--fg)`（概念 §3.8） |
| `.tag`（关键词条） | 底 `var(--surface-3)`、字 `var(--fg)`（同 `.chip` 语言）；`.tag .x:hover` err 档自动 |
| `.errorbar` | 结构不动：`--err-chip`(12% wash) + `--err-text` + err 45% 描边全部 token 自动换装 |
| `.empty-illus` | `color: var(--muted); background: var(--surface-2)`（圆盘语言保留；信号点 accent 由 icons.tsx:119 自动） |
| `.radios-card` | 选中态 token 自动（wash→中性 wash、左条→accent）；`--text-3: var(--text-2)` remap 保留（理由同 row-selected） |

**shell.css**：侧栏宽 `216px → 218px`（概念 §3.1）；其余全部 token 自动
（`--rail-*` 衍生：surface 底 / muted 字 / surface-hi hover / surface-3 选中 / accent 选中图标）。
`.brand-icon`：`background: transparent; box-shadow: none; color: var(--rail-bar)`（概念裸
accent logo；磁贴结构保留）。`.nav-btn` 高度 `--hit`(44) 红线与 pill 圆角不动；字重/字号不动。
`.dirty-dot` = `var(--warn)` 自动。

**global.css**：`@import './styles/reports.css';` 插在 `events.css` 之后、`settings-monitor.css`
之前（§4 保序约束），并在 import 列表注释里写明「reports.css 必须位于 primitives.css 之后」。

### 3.4 共享纪律（全域生效的两条新规则）

1. **hover 升档**：凡 hover 底用 `var(--surface-hi)` 的行/条容器，同选择器内加
   `--text-3: var(--text-2)`（faint on surface-hi 3.80/3.96 <4.5，§2 修正①）。先例：
   settings-monitor.css:154 `.mt-stage:hover::before`、primitives `.row-selected` 同款 idiom。
2. **faint 的落面禁区**：`--faint`（=衍生 `--text-3`）文字只落 `--bg/--surface/--surface-2`；
   落 `--surface-3/--surface-hi` 的容器必须携 §3.3 `.row-selected` 同款 remap
   （`--text-3: var(--text-2)`，即规则 1 的手法）。浅色 accent 同理禁作 s3 上文字。

### 3.5 跨页共用组件对齐口径（tsx 侧）

| 组件 | 口径 |
|---|---|
| `PageHeader.tsx` | **零 tsx 改动**。页题衬线由 `.page-title` 落地；副题/更新行/stale 琥珀逻辑全保留 |
| `EmptyState.tsx` | **零 tsx 改动**。`.empty-illus` 换装见 §3.3 |
| `ErrorBar.tsx` | **零 tsx 改动**。token 自动换装 |
| `icons.tsx` | **零改动**（含 icons.tsx:119 `var(--accent)`——新原语直接供琥珀值，即概念「信号点 = accent」意图；**不要**按旧盘点建议改指 `--color-primary`，两者现同源）。stroke/尺寸档体系不变 |

---

## §4 events.css 机械拆分（styles/reports.css）

### 4.1 判定标准（按优先级，以 grep 使用点为准）

1. 选择器全部使用点都在 `pages/Reports.tsx` / `components/ReportDoc.tsx` → **随迁** reports.css。
2. 使用点跨页 → **留** events.css（或已在本表注明的例外）。
3. 复合选择器逐条判：`.doc-trunc .disp-link` 整条随迁（`.disp-link` 本体留）；`.zero-row .disp-link` 留。
4. 反例警戒：`.card-grow > .errorbar`（events.css:1307-1310）在历史段但**作用于日报卡**
   （Reports.tsx:503 `card card-grow report-card`）——留 events 继续服务两页，**严禁当历史专属删改**。
5. 媒体查询块拆选择器不拆块语义（720px 块三条归属，各自成块）。
6. keyframes 跨文件合法，reports.css 头注释列明依赖。
7. **只搬不改写**：逐字搬移，唯一允许的新增内容是文件头注释；值调整全部属于 §5 日报域换装阶段。

### 4.2 逐条清单（行号 = 现行 events.css，本 session 已复核）

**A. 随迁段（L18-561 日报页段，除注明外全部随迁）**：
`.page-reports`(20-31)、`.page-reports .pagehead`(35-38)、`.report-tabs`(41-50)、
`.report-tabs .btn`(51-55，**依赖 reports.css 在 primitives.css 之后引入**)、`.report-rail-empty`(57-61)、
`.report-rail`(65-75)、`.report-rail-title`(76-81)、`.report-rail > .errorbar`(83-85)、
`.report-rail-list`(87-94)、`.report-date` 全族(96-159，含 `.label/.sub/:hover/:active/.active×3/.noreport`
——类名是 Reports.tsx:289/363 roving 焦点契约)、`.report-rail-sep`(160-166)、`.report-rail-more`(167-170)、
`.report-rail-jump` 含 svg/.input(171-187)、`.report-card`(191-195)、`.report-head/.report-head-main`
(196-215)、`.report-title-row`(216-221)、`.report-title`(223-230，**22/700 display 位**)、
`.report-busy`+svg(231-238，引 primitives `btn-spin`)、`.report-summary`+`.muted`(239-251)、
`.report-meta`+button+hover(252-273)、`.report-actions`(274-280)、`.report-confirm`+`.esc-hint`(283-298)、
`.report-newver`+hover/active(302-329)、`.report-feedback`+svg+`.btn`(332-346)、
`.report-body`+`> .empty`(350-359)、`.doc`(363-369)、`.doc-h2/.doc-h3`(371-387)、
`.doc-p/.doc-list`(+li/::marker)(389-412)、`.doc strong`(413-416)、`.doc-code`(418-425)、
`.doc-link-wrap/.doc-link(+hover)/.doc-link-hint`(428-450)、`.doc-note`+::before(452-462)、
`.tpl-row/.tpl-time/.tpl-cat/.tpl-title/.tpl-how/.tpl-remark`(464-496)、
`.doc-chips/.doc-chip`(+hover/+active)(498-535)、`.doc-trunc`+`.doc-trunc .disp-link`(537-552，复合
选择器整体随迁)、`.cv-block/.cv-block-list`(554-561)。

**B. 720px 断点块（L564-603）拆三条**：
`.substatus`(565-567) → **迁回 dashboard.css**（dashboard 域类，物理错位，dashboard.css:167-168
注释自认；并入其既有 720px 块或紧随其后）；`.chart-row,.rank-cols`(568-571) → 留 events；
`.page-reports/.report-tabs/.report-rail/.report-rail-title/.report-rail-sep/.report-rail-list/
.report-rail-jump/.report-date`(572-602) → 随迁 reports.css，保留为一个独立
`@media (max-width:720px)` 块。

**C. LiveBadge（L605-647）**：`.livebadge` 全族**留 events.css**（唯一使用点是去向页，
Dispositions.tsx:650 实测）。

**D. 去向页段（L649-1033）全部留 events.css**：
`.page-dispositions`(654-660)、`.card-disp-list`(661-666)、`.disp-scroll`(668-672)、
`.tb-row`(676-681)、`.tb-count`(682-687)、`.search-box` 含 svg/.input(689-706)、`.disp-source`(708-711)、
`.disp-date`(712-717)、`.disp-loading` 含 svg(720-728，**同时被 Reports.tsx:668/1040 消费——留守，
两文件同时在载即继续生效**)、`.disp-strip`(732-738)、`.notebar` 含 .btn(741-756)、`.day-sep`(760-770)、
`.disp-row` 全族(775-821：`.disp-row`/`:last-child`/`.disp-row-main`/`:hover`/`:active`/
`.disp-row-main.row-selected` 级联重述——**引 dashboard.css:403-412 的 `hit-in` keyframes，跨文件
依赖已存在**)、`.d-time`(814-822)、`.d-title`(823-830)、`.d-detail`(831-839)、`.outcome` 全族
(842-874：本体/.ok/.err/.warn/.muted)、展开区 `.disp-expand`/`.ex-row`/`.ex-k`/`.ex-v`/`.ex-detail`/
`.ex-why`/`.ex-track`/`.track-item` 含 ::before 与四 tone/:hover/:active/`.track-sep`/`.track-note`/
`.ex-actions`(878-980)、深链 `.disp-link` 全族(983-1006：本体/:hover/:active——**三页共用：
DispositionRow/History/ReportDoc**，本体必须留守)、`@keyframes disp-flash`(1008-1015) 与
`.disp-row.flash`(1016-1018)、`.load-more-bar` 含 .btn(1021-1033)。

**E. 历史命中页段（L1035-1380）全部留 events.css**：
`.page-history`(1040-1046)、`.stat-detail-toggle` 含 svg/[aria-expanded](1050-1077)、
`.page-history .metrics/.metric/.metric .v`(1083-1094，32/700 复写)、`.chart-row`(1097-1102)、
`.chart-block/.cb-title`(1103-1111)、sparkbar 全族(1118-1166：`.sparkbar/.spark-col/.spark-bar`/
hover+focus/`.zero`/`.spark-labels`)、`.stackbar`(1169-1176)、`.stack-seg` 与四 tone 复合选择器
(1177-1198)、`.legend/.lg-dot`(1199-1212)、`.stats-detail`(1216-1222)、`.rank-cols/.rank-list/
.rank-item/.rk-name/.rk-bar/.rk-val/.rank-more`(1223-1266)、`.zero-row/.zero-chip/
.zero-row .disp-link`(1269-1293)、`.filter-bar`(1297-1305)、`.card-grow > .errorbar`(1307-1310，
**也作用于日报卡**，见判定 4)、`.busy-ind`(1314-1325) 与 `.list-dim`(1326-1329，
**list-dim 同时被 Reports.tsx:627/1008 消费——留守**)、分页 `.pager` 全族(1332-1373：本体/.btn/
`.pager-jump`/`.page-input`/`.pager-size`/`.pager-select`/`.pager-total`)、`.empty-state-actions`
(1376-1380，仅 History.tsx:623 用)。

**F. 暗域护栏块（L1382-1398）**：三条选择器 `.tpl-cat/.doc-chip:hover/.report-newver:hover` 全为
日报域 → **连同 1382-1391 算式注释整体随迁 reports.css**（换装阶段的处置见 §5 日报域第 9 条）。

### 4.3 登记与依赖

- `global.css` import 顺序：`theme → base → primitives → shell → settings-core → dashboard →
  events → reports → settings-monitor → settings-notify`（reports 在 primitives 之后即满足
  `.report-tabs .btn` 盖 `.quick .btn` 的顺序约束，CURRENT-UI-MAP §0）。
- reports.css 头注释必须记录：① 本文件由 events.css 机械拆出（拆分提交零改写）；② keyframes
  依赖 `btn-spin`(primitives)/`fade-in`(base)，本文件无自有 keyframes；③ 留守依赖
  `.card-grow > .errorbar`/`.list-dim`/`.disp-loading` 在 events.css；④ `.disp-link` 本体在 events.css。

---

## §5 四域改造简报

> 每域通用禁区（不再逐域重复）：不动业务逻辑与数据流（props/hooks/IPC/SSE/键盘 roving/深链/
> dirty 机制）；不动其他域文件；类名尽量保留（运行时契约见 §7.3）；tsx 改动以 className 与注释
> 为限；不引第三方资源；间距/字号/圆角/动效一律走令牌。

### 5.1 监控台域

**文件**：`styles/dashboard.css`、`pages/Dashboard.tsx`、`components/StatusCard.tsx`、
`components/HitList.tsx`、`components/LogView.tsx`。

**跨域协作点（先读）**：dashboard.css 是「域 + 共享面」双角色（头注自认）——`.metrics/.metric`、
`.hit/.hit-title/.hit-how/.how-badge`、`.log-chip(s)`、`.live-pill/.live-dot`、`.src-empty/.src-dot`、
`.tone-*` 族被 History/Dispositions/设置卡借用（CURRENT-UI-MAP §1.3）。改这些类**只换值不改名不改
语义**；HitRow.tsx（事件域）消费 `.hit` 族，两域协调以本规范为准。

**目标视觉要点**：
1. `.metrics` 四格井：井底 `--card-alt`（→surface-2）、缝 `--line`（→border）自动；`.metric .v`
   保持 32/700 mono + fg；`.metric.live`（下次轮询格，StatusCard.tsx:266 产出）底
   `var(--primary-wash)` → **`var(--surface-3)`**（提亮一档即「下一秒」，替品牌 wash）；
   **同选择器加 `--text-3: var(--text-2)`**——`.metric .k` 标签是 `var(--text-3)`
   （dashboard.css:141-145），faint on surface-3 = 4.16/4.28 <4.5，落面禁区由 §3.4 规则 2
   强制升档（同 `.row-selected` 手法）。
2. `.dot` 状态点：**去掉 box-shadow 柔光环**，纯色点（概念点无环）；尺寸保持 10px / `.live` 12px
   （现行值，可辨性优先）；色由 `--tone-*`（ok/err/warn）自动。
3. `.state-pill`：16/600 + tone 三档结构不动，chip 底随 `--tone-bg`（→12% wash）自动换装。
4. `.hit` 行：hover `var(--primary-wash)` → **`var(--surface-hi)`** + 同选择器加
   `--text-3: var(--text-2)`（§3.4 规则 1）；`.hit-title` 常显 fg、下划线点色 `var(--faint)`、
   hover/focus → `var(--fg)` + 实下划线（增强式统一，替品牌文字档）；stagger 入场动画保留。
5. `.how-badge` 四档：字面 = 中性（mute-chip→surface-2 + text-2→muted 自动）；**语义 AI =
   b-ai 语言**：`background: var(--surface-2); color: var(--muted);
   border: 1px dashed var(--border-strong)`（概念 §3.6，虚线 = 机器判断）；规则 = ok 档、全匹配 =
   warn 档（wash 自动，浅色 warn-text 新档自动生效）。
6. `.logview` 井：card-alt→surface-2 自动；行色档（info/warn/err）自动。
7. `.log-chip`：默认 surface 底 + `var(--border)` + muted 字（自动）；`:hover:not(.on)` →
   `var(--surface-hi)`；`.on` 选中 → **`background: var(--surface-3); border-color: var(--border-hover);
   color: var(--fg)`**（替现行 fg 深底反转）；`.log-chip.on .num` 同步 `var(--fg)`；
   **删除 dashboard.css:852-859 暗色 lvl-dot 补偿块，并同步重写 840-845 的旧反转语言注释**
   （含 #17222E/#E9EEF5/#1E252F 旧档算式，随反转语言一并作废；不重写则 §7.5 grep 门失败）。
8. `.live-pill`：底 `--btn-primary-bg`（→accent）、字 `--color-on-primary`（→accent-ink）自动；
   `box-shadow` → `var(--shadow-cta)`；`.live-dot` = accent-ink 点自动。
9. `.vote-btn` hover → `var(--surface-hi)`（替 wash）；`.on` 档 ok/err wash 自动。
10. 死类清理：删除 `.hit-mark`（dashboard.css:460-465，tsx 零使用实测）。
11. Dashboard.tsx / StatusCard / HitList / LogView：预期**零 tsx 改动**（键盘 P/R/T/L、反馈三态、
    aria 结构全部保留）；确需挂新类先回本规范比对禁区。

### 5.2 事件域

**文件**：`styles/events.css`（拆分后剩余）、`pages/History.tsx`、`pages/Dispositions.tsx`、
`components/HitRow.tsx`、`components/DispositionRow.tsx`、`components/Pager.tsx`、
`components/StatSparkbar.tsx`、`components/LiveBadge.tsx`。

**目标视觉要点**：
1. `.filter-bar` 头带 `color-mix(card-alt 55%)` → **`transparent`** + `border-bottom`（概念工具条
   无底带）；`.tb-row` 结构不动；`.search-box` 图标色 text-3→faint 自动。
2. 筛选件统一概念 chip 语言：默认 = `var(--border-strong)` 边 + transparent/surface 底 + muted 字 +
   `--t-fast` 过渡；hover 字 fg；选中 = `var(--surface-3)` + fg + `var(--border-hover)` 边。
3. `.disp-row-main`：hover wash → `var(--surface-hi)`；**events.css:807-809 的
   `.disp-row-main.row-selected` 背景重述同步改为 `var(--surface-3)`**（否则拆分后残留的
   `background: transparent`/wash 重述会吞掉共享层新选中底——级联修复注释一并更新）。
4. `.outcome` 徽标 / `.livebadge`：tone 三档（点档 12% wash + 文字档 + 40% 描边）token 全自动，
   结构与类名不动。
5. `.disp-expand` 井 / `.track-item`：card-alt→surface-2 自动；track-item hover wash →
   `var(--surface-hi)`。
6. 历史页 Z1：`.page-history .metric .v` 32/700 复写保持（对共享面漂移免疫，两处同步纪律不变）。
7. `.spark-bar`：底色 `var(--color-primary)` → **`color-mix(in srgb, var(--info) 55%, transparent)`**
   （#39698B vs surface 3.11 ≥3 实算，深色档）；**浅色定向覆写** `:root[data-theme='light']
   .spark-bar` → **72% 混合**（实算 ≈3.4 ≥3；55% 浅色 on surface 仅 2.50 <3，§7.2 复测纪律所
   要求，§2.4-⑥「按主题定向」手法同源——终审回填备案，events.css 块内注释即算式出处）；
   **同时删除现行 `opacity: 0.8`**（保留则实算 2.64 <3），
   hover/focus 柱 → `var(--info)` 实色（现行 opacity:1 档）；**末柱（今天）→ `var(--accent)`**
   （概念 bars7 `.b.acc` 对位，CSS `:last-child` 即可，无需 tsx 改动）；`.zero` 槽 0.25 豁免先例保留。
8. `.stackbar` 四段与 `.lg-dot`（复合选择器成对改）：literal → `var(--faint)`（图形用 5.02 ≥3）、
   semantic → `var(--info)`、rule → `var(--accent)`、matchall → `var(--warn)`；槽底 mute-chip→surface-2
   自动。概念 `--seg-*` 三档**不设**（7 段去向分布条本次不做，§1.2-3）。
9. `.rk-bar` → `var(--accent)`，**同时删除现行 `opacity: 0.7`**（events.css:1252，同第 7 条
   spark-bar 的处置）：实际落面是 `.stats-detail` 井（card-alt→surface-2，History 展开区），浅色
   accent@0.7 on surface-2 实算 **2.75** / on 卡面 2.92，均 <3（深色 4.84-5.07 勉强过）；删
   opacity 后浅色 on surface-2 = 4.54 ✓ / 深色 8.54 ✓。`.rank-*` 结构不动。
10. `.disp-link / .stat-detail-toggle / .zero-row .disp-link` 品牌链接：色 `var(--accent-text)`、
    hover `var(--fg)` + 实下划线（增强式统一）。
11. `.pager` / `.page-input`：token 自动（`.pager .btn` sm 档不动）。
12. 死类清理：删除 `Dispositions.tsx:672` 与 `History.tsx:675` 的 ` refreshing` 条件类拼接
    （busy 已由 `.busy` 呈现，css 零定义实测）。
13. HitRow.tsx（Dashboard + History 两页共用）：roving 契约（`data-hit-index`/`data-vote`/
    `.hit-title`）零改动；如需类名组合调整，仅限追加纯样式类。

### 5.3 日报域

**文件**：`styles/reports.css`（§4 拆分产物）、`pages/Reports.tsx`、`components/ReportDoc.tsx`、
`components/ReportDoc.test.ts`。

**目标视觉要点**：
1. `.report-title`：衬线授权位 2——`font-family: var(--font-display); font-weight: 600`（fs-22/
   lh-display/ls-display 保留，700→600 随衬线）。
2. `.report-rail` / `.report-tabs` 浮条：raised→surface、`--color-border`→border、`--r-card`→12、
   阴影 `var(--shadow-md)`（替 shadow-sm/edge-top 组合）。
3. `.report-tabs .btn.active`：日报域加一条 `.report-tabs .btn.active` 覆写（与共享层
   `.quick .btn.active` 同特指度 (0,3,0)，靠 reports.css 在 primitives.css 之后引入的顺序胜出，
   同 `.report-tabs .btn` 的既有手法）→ `background: var(--surface-3); color: var(--fg)`
   （概念 chip.on，替共享层 wash 选中）。
4. `.report-date`：hover wash → `var(--surface-hi)` + fg；`.active` 行底 wash → `var(--surface-3)`；
   `.active .label` 实底圆片保留（btn-primary-bg→accent、on-primary→accent-ink 自动，9.18/5.05 ✓）。
   **类名零改动**（`button.report-date`/`.report-date.active`/`.doc-trunc` 是 Reports.tsx:289/309/363
   的焦点与滚动契约）。
5. `.doc`：640px 阅读列 / lh-read / fs-14 全保留；`.doc-h2/.doc-h3` 保持 **sans** 600（衬线只授权
   三处，§2.7）；`.doc-list li::marker` → `var(--accent)`（品牌图形档自动）。
6. `.tpl-cat` → 中性：`background: var(--surface-2); color: var(--fg)`（替品牌 wash；分类是内容
   不是品牌信号）；`.tpl-time/.tpl-how/.tpl-remark` faint 自动。
7. `.doc-chip`：surface-2 + muted 自动；`:hover` wash → `var(--surface-hi)` + `var(--fg)`。
8. `.doc-link` → `var(--accent-text)`（浅色 wash 场景 5.28 ✓），hover `var(--fg)` + 实下划线。
9. 迁入的暗域护栏块（原 events.css:1382-1398，含算式注释）：**整体删除**——三条规则的目标态
   （`.tpl-cat` 中性、`.doc-chip:hover` surface-hi+fg、`.report-newver:hover` 见下）在新 token 体系下
   天然达标；删除动作记入 reports.css 头注释（旧算式按 R12 wash 实算、已失效的结论一并留档）。
10. `.report-newver`：常态 ok 档（ok-chip wash + ok-text + ok 35% 边）自动；`:hover` →
    `background: var(--surface-hi); color: var(--fg)`（替品牌 wash hover）；`.report-confirm`/
    `.report-feedback` 三态 token 自动。
11. Reports.tsx / ReportDoc.tsx：预期零 tsx 改动；**`parseInline`/`parseReport` 契约与
    ReportDoc.test.ts 断言面零改动**（测试只测纯函数、不断言类名——CURRENT-UI-MAP §5.1；改解析
    行为即红测试）。

### 5.4 设置域

**文件**：`styles/settings-core.css`、`styles/settings-monitor.css`、`styles/settings-notify.css`、
`pages/Settings.tsx`、`components/` 下设置专属卡（SourceCard/RulesCard/KeywordsCard/MatchModeCard/
MatchTestCard/SimilarityCard/RunPaceCard/CategoryReportCard + ChannelsCard/NotifyCard/RoutingCard/
ProxyCard/AiModelCard/RemoteControlCard/DataCard/AboutCard）与骨架件（SettingsNav/SettingsSavebar/
SettingsErrorState/GroupHeader/Field/EntityList/KeywordTagInput）。

**目标视觉要点**：
1. `.snav-item`：hover card-alt → `var(--surface-hi)`；`.active` wash → **`var(--surface-3)` + fg**
   （与侧栏 nav 选中同语言，概念 anchor `.on`）；scrollspy 契约（`.settings-group` querySelector，
   Settings.tsx:674 实测）不动。
2. `.savebar`：概念 savebar 语言——`background: color-mix(in srgb, var(--bg) 82%, transparent)` +
   `backdrop-filter: blur(10px)` + `border-top: 1px solid var(--border)`；**去圆角**（贴底全宽，
   删 `border-radius` 与 `border`，保留顶线）与 `--shadow-xl`；负 margin 撑满机制与 z-index 95 保留。
3. `.switch`：随 §3.3 共享层换装（滑块 muted→fg 必改）；`.smon .switch[aria-checked] ~ .feedback`
   ok-text 自动。
4. `.field`/`.entity-list`/`.ent-*`：line→border、card-alt→surface-2 全自动；`.entity-row.del` 的
   err-chip wash + 删除线自动；`.ent-expand` 井 + `.smon` 锚定 wash → 中性 wash 自动。
5. 琥珀左条语言族（`.warn-strip/.leavebar/.inline-confirm` + events 的 `.notebar`）：warn-chip→
   12% wash、warn-text（浅色新档）自动；左 3px `var(--warn)` 自动。
6. `.mt-verdict` 漂浮横幅：`--shadow-md + --edge-top` 值随 §2.8 自动；tone wash 自动；`.mt-stage`
   hover wash → `var(--surface-hi)`（升档注释同步更新）。
7. `.btn-danger-solid`：实底 danger 换装——深色 `--err`(#F0574E) + `--on-danger`(#290B0A，5.39)、
   浅色 #BE222A + 白（6.08）、hover 档自动（§2.2/2.3）。
8. 骨架 `.skel/.mt-skel`：card-alt 底 + text-3 12% shimmer 自动。
9. **「外观」行（本次唯一获准的 UI 增量，§6 主题切换的可达性出口）**：RunPaceCard（「运行与通用」
   组）尾部新增一个 `.field` 行：label「外观」+ `.radios` 三项（深色 · 瞭望塔 / 浅色 · 晨报 /
   跟随系统），调 `lib/theme.ts` **即时生效**、localStorage 持久化，**不进 draft/dirty/savebar
   机制**（保存栏对它无效即正确行为）；复用现有 `.field/.radios/.radio` 类，零新 CSS（至多一条
   布局规则）；`role="radiogroup"` + 受控 checked。
10. 其余卡（Channels/Routing/AiModel/Proxy/Remote/Data/About）：token 衍生自动换装为主；
    `.about-logo` wash 底→中性 wash + accent 图标自动；`.cmd/.ch-state/.rule-idx` 结构不动。
11. Settings.tsx / 各卡 tsx：draft/saved、SEGMENTS 13 段 dirty 比较、保存载荷、锚点深链、⌘S、
    L1/L2/L3 确认语言**全部零改动**；`snot/smon` 域根类保留。

---

## §6 主题切换机制（src/renderer/src/lib/theme.ts，新建）

**模块契约**：

```ts
export type ThemeMode = 'dark' | 'light' | 'system'
export type ResolvedTheme = 'dark' | 'light'
export function initTheme(): void            // main.tsx 首帧前调用一次
export function getThemeMode(): ThemeMode    // 存储意图（'dark' | 'light' | 'system'）
export function getResolvedTheme(): ResolvedTheme
export function setThemeMode(mode: ThemeMode): void  // 应用 + 持久化 + 通知订阅者
export function onThemeChange(cb: (mode: ThemeMode, resolved: ResolvedTheme) => void): () => void
```

**行为细则**（概念稿 §4 机制整体迁移，逐条裁决）：
1. **单一真源**：`document.documentElement.setAttribute('data-theme', resolved)`；resolved 只有
   `'dark' | 'light'` 两值。深色是 `:root` 基线，浅色是 `:root[data-theme="light"]` 覆盖（§2.1）。
2. **color-scheme 双保险**：theme.ts 写 `document.documentElement.style.colorScheme = resolved`；
   theme.css 两个主题块也各自声明（web 模式 JS 未跑时首帧也正确）。原生控件（单选/滚动条/日期/
   select）自动跟随。
3. **存储**：localStorage 键 **`'fw-theme'`**（沿用概念稿键名；renderer 私有 UI 偏好，**不进
   AppConfig/dirty 体系**——CURRENT-UI-MAP §4-7 的产品决策点在此裁决为 localStorage 方案）。
   默认 `'dark'`。所有读写包 try/catch（隐私模式/存储禁用静默回退默认深色）。
4. **system 解析**：`window.matchMedia('(prefers-color-scheme: light)')`，`.matches ? 'light' :
   'dark'`；mq `change` 监听**仅当存储值为 `'system'`** 才重新应用；用 `addEventListener`
   （Electron 44 / 现代 Chromium 足够，不需要 `addListener` 旧 API 双写）。
5. **URL 覆盖**：`?theme=dark|light|system` 一次性优先于 localStorage（预览/验收走查用；非法值
   忽略）。**不持久化** URL 来源（刷新后回到存储值）。
6. **initTheme() 时机**：`main.tsx` 在 `installWebApiIfAbsent()` 之后、`createRoot().render()` 之前
   调用（main.tsx:9-11 现有顺序中插入；避免首帧闪错主题）。initTheme 不回写 localStorage。
7. **双环境约束**：只用 `localStorage` / `matchMedia` / `document` 标准Web API，**禁 import
   Electron/Node 模块**（web 无头模式直跑同一产物，CURRENT-UI-MAP §5.3）；模块顶层无副作用，
   全部动作在函数内。
8. **UI 同步**：设置域「外观」行（§5.4-9）经 `getThemeMode/onThemeChange` 受控；system 态下系统
   切换时 radio 保持「跟随系统」选中、页面实时换装。
9. **web-shim 相容**：无 preload 的浏览器形态下行为完全一致（认证 401 的 `window.prompt`、备份
   导入导出等路径与主题无交集，不需要处理）。

---

## §7 验收清单

### 7.1 双主题全页走查（手动）

- [ ] 深色默认：全新启动（无 localStorage）首帧即深色，五页（监控台/去向/历史命中/日报/设置）
      逐页走查无浅色残块、无不可辨文字。
- [ ] 浅色「晨报」：设置 → 外观 → 浅色，即时生效；同上五页走查。
- [ ] 跟随系统：切 system 后改 OS 外观，应用实时翻转；重启应用记忆三态各自正确。
- [ ] keep-alive 切页（Cmd/Ctrl+1..5）后主题不闪不变；设置页 dirty 拦截（leavebar）行为不变。
- [ ] web 无头模式（Docker/Web 部署形态）重复上述三项；`?theme=light` 直达可用。
- [ ] 原生控件跟随：单选/复选/日期输入/select/滚动条在两主题下方向正确（color-scheme）。

### 7.2 对比度（按 §2 口径复算）

- [ ] §2.4 八条修正后的终值逐一复核（正文 ≥4.5 / 图形·UI ≥3）；新增 `color-mix` 派生色对
      （chip wash、hover 底、选中底）在**实际落面**上复测——凡新组合必复测（现行 events.css
      护栏块所引「color-mix 派生色对落地必复测」纪律的先例）。
- [ ] 抽查必过对：两主题 fg/muted/faint(落面合法)/accent-text/语义文字档 on 实际底 ≥4.5；
      语义点与描边、focus-ring、input-border ≥3。
- [ ] faint 未落 surface-3/surface-hi（§3.4 禁区）；hover/选中行容器 remap 在位。

### 7.3 类名兼容与测试

- [ ] 运行时 querySelector 契约逐条仍解析（改名前必查表，CURRENT-UI-MAP §5.2，本 session 复核）：
      `button.report-date`/`.report-date.active`/`.doc-trunc`（Reports）；`[data-group]`（ReportDoc）；
      `[data-hit-index]`/`data-vote`/`.hit-title`（HitList/History/HitRow）；
      `[data-disp-index]`/`.disp-row-main`（Dispositions/DispositionRow）；`.log-chip`（LogView）；
      `.savebar .sb-confirm`/`.page-settings`（DataCard/EntityList）；`.settings-group`（Settings）。
- [ ] `npm run typecheck` / `npm run test` / `npm run build` 由验收阶段统一跑（工作纪律）；
      ReportDoc.test.ts 与 presets.test.ts 零改动通过（解析契约未动即应绿）。

### 7.4 零网络字体与资源

- [ ] `grep -rn "@font-face\|fonts.googleapis\|fonts.gstatic\|url(" src/renderer/src --include="*.css"`
      → 零命中；CSP（index.html:8-9）未改动。
- [ ] 衬线只走 `--font-display` 系统栈；`grep -rn "font-family: var(--font-display)"` →
      **恰好 3 处**（.page-title/.report-title/.group-head）。

### 7.5 旧体系残留清零

- [ ] `grep -rn -i "#2563EB\|#1D4ED8\|#1E40AF\|#6BA8F5\|#8FBEF9\|#F6F8FC\|#17222E\|#262E3A\|#2F3947\|#303A49\|#EEF2F8\|#4A5A6E\|#E9EEF5\|#1E252F" src/renderer`
      → 零命中（含注释——base.css:37、primitives.css:393、events.css:1383、
      dashboard.css:840-845 四处旧注一并更新，见 §5.1-7）。
- [ ] `grep -rn "max-width: 0px" src/renderer` → 零命中（三处恒假停用块全部消亡）。
- [ ] 循环防护：theme.css 遗留别名层**不再定义** `--accent/--border/--border-strong`（§2.6 删 3 行
      落实；漏删即 var() 循环、令牌失效）；`icons.tsx:119` 的 `var(--accent)` 正常解析为琥珀。
- [ ] `font-weight: 700` 全库恰 2 处（dashboard `.metric .v` + events 历史复写）；
      `--fs-20/24/28` 删除且零引用；`grep -rn "fs-15"` → 零。
- [ ] `global.css` import 顺序含 `reports.css` 且位于 `primitives.css` 之后（§4.3）。
- [ ] reduced-motion 熔断仍在（base.css 未经删改）。

### 7.6 机制

- [ ] `lib/theme.ts` 存在且仅用标准 Web API；`main.tsx` 在 render 前调用 `initTheme()`。
- [ ] 断网/清存储/隐私模式（localStorage 抛异常）下默认深色、无崩溃。
- [ ] 设置「外观」行即时生效、重启记忆、不触发 dirty/savebar。

---

## 附：本 session 自查记录（SPEC 撰写时已核）

- 两份输入文档的行号主张抽核无误：events.css 全文通读（区间/选择器与 CURRENT-UI-MAP §1.2 一致）、
  theme.css/global.css/base.css/shell.css/primitives.css/dashboard.css/settings-*.css 全文通读、
  concept.html 917 行全文通读（两块样式合并后的生效值与 DESIGN-LANGUAGE §1.4 对照表一致）。
- grep 实测（结论已写入正文）：旧 azure hex 仅存 theme.css 定义与三处注释；`var(--accent)` 唯一
  存活引用 icons.tsx:119；`var(--border)/var(--border-strong)/var(--surface*)/var(--muted)/var(--faint)/
  var(--info)` 等新名零碰撞；`font-weight: 700` 恰 4 处；fs 阶引用计数与盘点一致（fs-20/24/28 为 0）；
  恒假媒体查询恰 3 处；`refreshing` 死类两处；`.hit-mark` 死 CSS 一处；querySelector 契约 16 处复核。
- 对比度全部数字为本 session python 实算（OKLab→sRGB + WCAG；sRGB gamma 空间混合），与
  DESIGN-LANGUAGE 附表抽样一致，新增了该文档未覆盖的 8 项边界对（focus-ring、border-active、
  hover 方向、accent-text、on-danger、sparkbar 柱、faint×surface-hi、chip wash 全矩阵）。
- 未做：未运行 typecheck/test/build（工作纪律）；未改任何代码——本文件是本次任务唯一产出。
- 修订记录（评审轮，6 条全部采纳、零驳回；每条均经源码行号与本 session 实算复核）：
  ① §5.2-9 `.rk-bar` 补删 `opacity: 0.7`（浅色 @0.7 on surface-2 实算 2.75 <3，events.css:1252）；
  ② §5.1-1 `.metric.live` 补 `--text-3: var(--text-2)` remap（`.metric .k` 走 text-3，
  dashboard.css:141-145 / StatusCard.tsx:266）；③ §5.1-7 与 §7.5 补 dashboard.css:840-845
  旧注重写（#17222E/#E9EEF5/#1E252F 残留）；④ §2.5/§2.6 `--bg-sidebar` 移入衍生层
  （原定义 theme.css:185 随 R12 块删除，引用实测 0）；⑤ §3.4-2 悬空引用改指 §3.3 同款 remap；
  ⑥ §2.2/§2.3 `--scroll-thumb` 补装饰档豁免注（实算 1.17-1.38，与现行 ≈1.15 同档非回归）。
