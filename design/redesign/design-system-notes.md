# ForumWatch 设计系统 · 桌面端执行注意点（design-system-notes）

> 配套文件：`design-system/forumwatch/MASTER.md`（ui-ux-pro-max 检索生成，2026-09-20）。
> 本文档回答两件事：**MASTER.md 里哪些内容不适用于桌面端监控工具**，以及**落地时的桌面/中文/暗色/长时使用修正**。
> 产品画像：Electron 桌面应用，多论坛新帖监控（数据密集、列表为主）、关键词 + AI 语义匹配、Telegram 推送、中文界面、长时间挂机。

---

## 1. 生成方式与拨盘取值（备查）

```bash
python3 ~/.agents/skills/ui-ux-pro-max/scripts/search.py \
  "forum monitoring desktop tool data dense dark" \
  --design-system --persist -p "ForumWatch" --output-dir . \
  --density 8 --variance 3 --motion 2
```

- `--density 8`：数据密集监控列表，得到 2/4/8/12/16/24/32px 紧凑间距表（MASTER.md「Spacing Variables」），适用于帖子列表、侧栏订阅树、统计条。
- `--variance 3`：工具型界面取「居中/极简」，避免 Brutalism/Bento 类高变体布局——监控列表需要可预测的网格，不需要视觉惊喜。
- `--motion 2`：长时间挂机场景，动画只保留 subtle 微交互；且本项目依赖里没有 GSAP（`package.json` 仅 electron/react/undici 等），不为此引入动画库。

产品被归类为 **Status Page / Incident Management**，匹配到的 Style 为 **Minimalism & Swiss Style**（Best For: dashboards / professional tools，Light+Dark 双模式支持）——分类与产品定位核对相符，予以采用。

## 2. MASTER.md 中不适用于桌面端的内容（逐条甄别）

| MASTER.md 条目 | 结论 | 理由与处理 |
|---|---|---|
| Page Pattern「Real-Time / Operations Landing」的 Section Order（Hero > metrics > How it works > CTA）与 CTA Placement | **不采用** | 这是营销落地页的转化结构，桌面工具没有 Hero/CTA 漏斗。 |
| 同上 Pattern 中 Conversion Strategy 的 telemetry 规则 | **采用并升级为面板行为规范** | 与落地页无关、对监控工具反而是核心：① 只有真实数据源支撑才标「实时」，必须带更新时间与过期（stale）状态；② 轮询类 UI 提供暂停/隐藏或刷新频率控制；③ 窗口隐藏/最小化到托盘时停止 UI 层定时刷新与动画（stop offscreen/hidden work）；④ 支持键盘操作；⑤ `prefers-reduced-motion` 下直接渲染静态终态。 |
| Motion「Scroll Reveal（GSAP ScrollTrigger）」 | **不采用实现，保留原则** | 桌面应用不是滚动页面；项目无 GSAP。保留其参数精神：300–400ms、`power1.out` 类缓出、位移 8–16px 读作 fade 而非 slide，应用于列表项进入、面板切换、抽屉展开等微交互。 |
| Pre-Delivery Checklist 的「Responsive: 375px/768px/1024px/1440px」「No horizontal scroll on mobile」 | **改写为桌面断点** | 移动断点不适用。改为：最小可用窗口宽度（建议 ≥ 960px），侧栏可折叠（宽/窄双态），窗口隐藏到托盘时 UI 降频。「内容不横向溢出」的原则保留（列表区禁止意外横向滚动）。 |
| Typography「Orbitron / JetBrains Mono」 | **Orbitron 不采用；mono 保留** | 见第 3 节。 |

反模式区（慢仪表盘、装饰性图表、隐藏错误状态、emoji 图标、不可见焦点、150–300ms 过渡等）**全部保留**，桌面端权重只增不减（桌面用户键盘依赖更高）。

## 3. 字体方案修正（Orbitron 不可用的完整论证）

MASTER.md 给出的 Heading = Orbitron，经核对**不适用**，理由：

1. **无中文字形**：Orbitron 仅覆盖拉丁字符，中文界面下所有中文文本都会 fallback，造成中英混排字重、基线、字宽不一致——对数据密集列表是持续性伤害。
2. **气质冲突**：Orbitron 的 mood 是 cyberpunk/neon/tactical（Best For: gaming/fintech），与 MASTER.md 自己选定的 Minimalism & Swiss（clean、functional、professional tools）直接矛盾。
3. **桌面离线场景**：工具类 Electron 应用不应依赖 Google Fonts 网络加载（首启闪字体/离线不可用），优先系统字体栈。

**替代方案（来自 typography 域补充检索的已验证结果，非杜撰）：**

- **正文/界面字体**：系统中文栈优先 —— `-apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif`（检索命中「Chinese Simplified → Noto Sans SC」：clean / modern / professional / readable，Simplified Chinese support；桌面端用系统字形免网络依赖，Noto Sans SC 作跨平台兜底）。**不引入 Orbitron，不引入网络 @import。**
- **数据等宽字体**：保留检索配对中的 JetBrains Mono（或系统等宽 `SF Mono / Cascadia Mono / Consolas` 兜底），仅用于帖子 ID、URL、时间戳、数字统计、日志——即「Dashboard Data（Mono + Sans）」配对里 "Code for data, Sans for labels" 的分工。

**中文排版参数（MASTER.md 未覆盖、桌面中文界面必须补）：**

- 中文正文行高 **1.6–1.75**（中文字形高、1.5 会挤）；紧凑单行列表项（标题行）行高 1.4 起步。
- 正文字号基准 14–16px；12px 只允许用于时间戳/计数等辅助元信息，禁止正文（对应技能规则 "Text < 12px body" 反模式）。
- 中英混排数字/ID 一律走 mono 栈并 `font-variant-numeric: tabular-nums`，避免列表刷新时数字跳动导致行宽抖动。

## 4. 暗色模式 token 补充（MASTER.md 只落了浅色值）

MASTER.md 色板为浅色底（bg `#F0FDF4`）。产品要求「暗色友好」，Style（Minimalism & Swiss）本身声明 Light/Dark 双支持。暗色 token 采用 color 域补充检索命中的「RPA / Automation Dashboard」暗色板——其语义结构与 MASTER.md 完全同源（running green `#16A34A` + failed red `#DC2626` + queued amber，正对应监控的 正常/错误/维护），可直接作为暗色变体：

| Role | 暗色值 | 备注 |
|---|---|---|
| Background | `#020617` | 近黑深蓝灰，不用纯黑 |
| Foreground | `#F8FAFC` | 柔和白，避免纯白光晕（halation） |
| Card | `#0E1223` | 与 bg 的层次靠底色差 + 边框，不靠重阴影 |
| Card Foreground | `#F8FAFC` | |
| Muted / Muted Fg | `#1A1E2F` / `#94A3B8` | |
| Border | `#334155` | 装饰分隔用；见第 5 节边界警示 |
| Primary / Accent | `#16A34A` / `#22C55E` | `#22C55E` 暗底作文字 8.85:1 |
| Destructive | `#EF4444` | 暗底下比 `#DC2626` 亮一档 |

语义色约定（浅暗两模式一致，来自检索 Color Notes）：**绿 = 运行/正常，红 = 错误/事件，琥珀 = 维护/限流等中间态**；状态表达不得只靠颜色，需同时有图标/文字（技能规则 "Relying on color alone" 反模式）。

## 5. 对比度实测（本次交付实际计算，WCAG 相对亮度公式）

浅色（MASTER.md 原值）：正文 `#14532D`/`#F0FDF4` = **8.70:1** ✓；muted `#475569`/bg = **7.24:1** ✓；on-primary `#000`/`#16A34A` = **6.37:1** ✓；destructive `#DC2626`/card = **4.83:1** ✓。

暗色（第 4 节补充值）：正文 `#F8FAFC`/`#020617` = **19.28:1** ✓；muted `#94A3B8`/card = **7.25:1** ✓；accent `#22C55E`/bg = **8.85:1** ✓；primary `#16A34A`/bg = **6.12:1** ✓；destructive `#EF4444`/bg = **5.36:1** ✓。

**不达标与修正（实测发现，MASTER.md 未提示）：**

- 浅色 `#16A34A` 直接作正文 = **3.15:1**，不足 4.5:1 → 绿色在浅底只用于状态点/边框/大号文本；小字正文一律走 foreground。
- 浅色边框 `#BBF7D0`/bg = **1.16:1** → 只能当卡片底色装饰，**不能当分隔线/输入框边框**；浅色有效边界用 `#64748B`（实测 **4.55:1**）。
- 浅色 focus ring `#16A34A` = **3.15:1** 偏弱 → 建议加深为 `#15803D`（实测 **4.79:1**）。
- 暗色边框 `#334155`/bg = **1.95:1**，更亮的 `#475569` 也仅 **2.66:1** → 暗色静态边框只作装饰；输入框/可交互边界的状态可见性必须依赖 focus ring（`#22C55E`，8.85:1），不能只靠边框。

## 6. 长时间挂机与信息密度注意点

- **挂机降负**：窗口隐藏/托盘时暂停 UI 层轮询刷新与全部动画（引擎层抓取不受影响）；可见时的列表刷新用增量插入，禁止整列表重排（闪烁 + CPU 浪费）。
- **无持续动效**：不做脉冲呼吸灯、跑马灯、无限循环动画（motion 2/10 的本意）；新帖到达提示用一次性 300–400ms 微交互 + 角标计数。
- **实时性标注**：所有「刚刚/N 分钟前」相对时间旁保留绝对时间戳；数据带更新时间，超时显示 stale 态而非假装实时。
- **密度**：沿用 MASTER.md 密集间距表（2/4/8/12/16/24/32px）；列表行内边距 8px 起；侧栏窄态 ≥ 200px。密集不等于拥挤：行间仍需 8px 级呼吸位，中文小字禁止低于 12px。
- **键盘优先**：桌面监控工具用户重键盘——Tab 序合理、焦点环常显（暗浅两模式都要过 3:1）、列表支持 j/k 或上下键移动、常用操作有快捷键。
- **虚拟列表**：帖子量大时内容区用虚拟滚动，保证挂机数日、累积数千条时依旧流畅（对应反模式「Slow dashboards」）。

## 7. 落地红线（从 MASTER.md 反模式区继承 + 本次补充）

- 禁 emoji 作图标，统一 SVG 图标集（Lucide/Heroicons）。
- 禁隐藏错误状态：抓取失败、规则失效、推送失败必须在界面上有可见入口与原因，不允许静默吞掉。
- 禁装饰性图表：统计区只放用户决策需要的数据（命中趋势、来源分布等），不为好看加图表。
- 禁 0ms 状态突变，交互反馈 150–300ms；同时尊重 `prefers-reduced-motion`。
- 两模式正文对比度 ≥ 4.5:1（本次实测值见第 5 节，实现引入新色对时必须重新实测，不得沿用本文数字作为豁免）。

---

*来源声明：MASTER.md 由 ui-ux-pro-max `--design-system` 检索生成并持久化；第 3 节字体替代与第 4 节暗色 token 来自 typography/color 域补充检索命中（非编造）；第 5 节对比度数字为本次交付用 WCAG 公式实测。*
