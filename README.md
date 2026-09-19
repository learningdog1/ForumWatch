# NodeSeek Monitor

常驻系统托盘的 [NodeSeek](https://www.nodeseek.com) 论坛监控工具：按设定间隔轮询 NodeSeek 首页新帖，标题命中关键词时立即推送到 Telegram。macOS / Windows 双平台。

<!-- TODO: screenshot -->

## 功能特性

- **关键词监控**：包含词任一命中即推送，排除词一票否决，大小写不敏感。
- **Telegram 推送**：消息含标题、分类、作者、命中的关键词与原帖链接（HTML 格式）。
- **常驻托盘**：关闭窗口即最小化到系统托盘继续监控，退出请走托盘菜单。
- **稳健轮询**：默认 60 秒一轮（最低 15 秒，带 ±20% 随机抖动防反爬）；连续失败自动指数退避，封顶 30 分钟，恢复成功后自动复位。
- **Cloudflare 感知**：被 Cloudflare 挑战拦截时状态栏显示"Cloudflare 拦截"并自动退避重试，不误报数据。
- **代理支持**：`http(s)://` 与 `socks5://`，作用域可选"仅 Telegram 走代理"或"全部请求走代理"。
- **首启防打扰**：首次启动只把当前帖子记为已读、不推送，避免安装瞬间收到一大堆历史通知。
- **推送限流**：遵守 Telegram 官方限速（约 1 条/秒），遇 429 自动等待服务端指示的时间后重试；发送失败自动重试 3 次。
- **数据全部本地**：配置、已读记录、日志存在本机 userData 目录，不上传任何数据。

## 下载安装

到本项目仓库的 **Releases** 页面下载对应平台的安装包：

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| macOS | `.dmg` | 未签名、未公证 |
| Windows | `.exe`（NSIS 安装包） | 未签名 |

### macOS：应用"已损坏，无法打开"或"无法验证开发者"怎么办

应用没有做代码签名和公证，首次打开会被 Gatekeeper 拦截，这是预期现象：

1. 下载 `.dmg`，把 **NodeSeek Monitor** 拖入「应用程序」文件夹。
2. 在「应用程序」里找到它，**右键点击 → 打开 → 再点"打开"**（不要直接双击）。
   只需要做一次，之后可正常双击打开。
3. 如果仍提示"已损坏"，可在「终端」执行（把路径换成实际安装位置）后，再右键打开：

   ```bash
   xattr -cr /Applications/NodeSeek\ Monitor.app
   ```

### Windows：SmartScreen 提示"已保护你的电脑"怎么办

安装包未签名，运行时 SmartScreen 会弹蓝色警告，这是预期现象：

1. 双击安装包，出现 SmartScreen 提示时点 **"更多信息"**。
2. 再点 **"仍要运行"**，按提示完成安装。

## 快速上手

5 步跑起来：

1. **安装并启动**应用（见上一节）。首次启动会把首页现有帖子记为已读，不会推送。
2. **填写关键词**：左侧栏进入「设置 → 关键词」，在"包含关键词"里加入你关心的词（如 `VPS`、`白嫖`），回车确认；可选填"排除关键词"。填完点「保存设置」。
3. **创建 Telegram Bot**：
   1. 在 Telegram 里找 [@BotFather](https://t.me/BotFather)，发送 `/newbot`，按提示起名，得到 **Bot Token**（形如 `123456789:ABCdefGHI...`）。
   2. **给你刚创建的 bot 发一条消息**（任意内容，比如 `hi`）。不先发消息，bot 无法主动给你推送。
   3. 获取 **Chat ID**，两种方法任选：
      - 方法一：给 [@userinfobot](https://t.me/userinfobot) 发任意消息，它回复里的 `Id` 就是你的 Chat ID。个人聊天是正数；群组是负数（通常是 `-100` 开头），需先把 bot 拉进群并在群里发条消息。
      - 方法二：浏览器打开 `https://api.telegram.org/bot<你的Token>/getUpdates`（把 `<你的Token>` 换成第 1 步的 token），返回 JSON 里 `message.chat.id` 字段就是 Chat ID。
4. **填写 Telegram 配置**：「设置 → Telegram 推送」里填入 Bot Token 与 Chat ID，点「保存设置」。
5. **点「✈ 发送测试消息」**：Telegram 里收到 `✅ NodeSeek Monitor 测试消息` 即配置成功。之后保持应用运行（窗口可以关，托盘常驻），新帖命中关键词就会推送。

> 大陆用户请先阅读下面的「网络与代理」一节，api.telegram.org 通常需要代理才能访问。

## 关键词语义

关键词决定"哪些帖子值得推送"，规则如下（只匹配**标题**，不匹配正文）：

- **包含关键词**：多个词之间是"或"的关系——标题命中任意一个即触发推送。
- **排除关键词**：一票否决——标题命中任意一个排除词，即使同时命中包含词也不推送。
- **大小写不敏感**：`VPS` 与 `vps` 等价（对中文无影响）。
- **匹配方式是子串**：关键词 `nginx` 能命中标题 `宝塔nginx反代教程`，也会命中 `tengine-nginx对比`。
- **⚠️ 包含关键词为空 = 不推送任何帖子**。这是故意的防误设计：没配关键词时不推送，避免全量帖子刷屏。刚装好收不到通知，先检查这里。

示例：

| 包含词 | 排除词 | 标题 | 结果 |
| --- | --- | --- | --- |
| `VPS, 白嫖` | `广告` | `免费白嫖一年的 VPS` | 推送（命中"白嫖""VPS"） |
| `VPS, 白嫖` | `广告` | `VPS 广告位招商` | 不推送（命中排除词"广告"） |
| `VPS, 白嫖` | | `服务器流量计费讨论` | 不推送（未命中包含词） |
| （空） | | 任何标题 | 不推送 |

## 网络与代理（大陆用户必读）

应用有两类外网请求：抓取 NodeSeek（`www.nodeseek.com`，大陆一般可直连）与调用 Telegram API（`api.telegram.org`，大陆通常需要代理）。

在「设置 → 网络（代理）」配置：

- **代理地址**：支持 `http://`、`https://`、`socks5://` 三种前缀，如 `socks5://127.0.0.1:1080` 或 `http://127.0.0.1:7890`。留空表示直连。地址必须以这三个前缀之一开头，否则保存时会被清空。
- **作用域**（二选一）：
  - **仅 Telegram 走代理（默认）**：NodeSeek 直连，Telegram 走代理。大陆用户的推荐配置。
  - **全部请求走代理**：NodeSeek 抓取也走代理。适合 NodeSeek 也需要代理访问的网络环境。

配置修改后保存即生效，无需重启。

## 常见问题

### 没收到通知，怎么排查？

按顺序检查：

1. **测试消息能收到吗**：监控台或设置页点「发送测试通知」。
   - 测试消息都收不到 → 是 Telegram 配置/网络问题，继续第 2、3 步。
   - 测试消息能收到 → 是关键词/帖子问题，继续第 4、5 步。
2. **代理设置对不对**：大陆访问 api.telegram.org 必须配代理。确认代理地址正确且代理进程在运行；如果代理挂了，换成可用节点再点测试。
3. **Chat ID 对不对**：确认拿到的是你自己的 Chat ID，且你已经给 bot 发过至少一条消息（bot 无法主动发起会话）。
4. **关键词配了吗**：包含关键词为空 = 不推送（见上一节）。确认关键词拼写、以及帖子标题确实包含它。
5. **被 Cloudflare 拦截了吗**：状态卡显示"Cloudflare 拦截"时抓取暂停，恢复前不会有新命中，见下一问。
6. **看日志**：监控台「运行日志」或配置目录 `logs/log-YYYY-MM-DD.txt`，推送失败会写明原因（网络错误、429、token 无效等）。

### 状态显示"Cloudflare 拦截"怎么办？

NodeSeek 部分接口在 Cloudflare 后面，偶尔会对本应用发起人机验证挑战。此时：

- **通常什么都不用做**：应用会自动退避重试（间隔逐步放大到最长 30 分钟），一般会自行恢复。
- **想快点恢复**：点「立即轮询」主动补一轮；若立刻再次被拦，说明风控仍在，建议把轮询间隔调大（如 120 秒以上）。
- **频繁被拦**：多为轮询过快所致，请调大间隔；也可以在「设置 → 网络」把作用域切为"全部请求走代理"换一个出口 IP 试试。

### 为什么刚安装/刚启动时没有推送？

首次启动（以及 seen 记录被清空后的启动）会做一次**基线**：把首页当前所有帖子标记为已见、不推送，防止安装瞬间被几十条历史帖刷屏。从基线之后新出现的帖子才参与关键词匹配和推送。每次重启应用不会有这个问题——已读记录持久化在本地。

### 置顶帖为什么收不到推送？

首页置顶帖是运营固定在那里的旧帖，应用会跳过置顶帖的推送（只记为已见），避免同一条公告反复推送。

### 关掉窗口后应用还在运行吗？

在。关窗是最小化到系统托盘，监控继续。托盘图标菜单提供：显示主窗口 / 暂停或恢复监控 / 立即轮询 / 发送测试通知 / 打开配置目录 / 退出。**真正退出请走托盘菜单的「退出」。**

macOS 上应用不出现在程序坞和 Cmd+Tab 切换器里（dock 已隐藏，托盘应用的预期行为），通过菜单栏右侧的托盘图标交互。

### 开机自启开了没生效？

macOS 上未签名应用可能被系统拒绝登录自启（可在 系统设置 → 登录项 中检查）。Windows 打包签名后此问题自然消失，当前版本如遇拒绝请手动启动。

## 隐私说明

- 所有配置（关键词、代理、Telegram 凭据）、已读记录与日志**只存储在本机** userData 目录下的 `config.json` / `seen.json` / `state.json` / `logs/`。
- 应用没有任何统计、埋点或云端服务，**不上传任何数据**。
- 网络请求只发往两个目标：`www.nodeseek.com`（抓取首页）与 `api.telegram.org`（推送消息）。
- `config.json` 含 Bot Token，文件权限为 600；请勿把该文件分享给他人，Token 泄露请到 @BotFather 用 `/revoke` 重置。

## 开发指南

### 命令

```bash
npm install        # 安装依赖（无原生模块，无需任何编译工具链）
npm run dev        # 开发模式（electron-vite）
npm test           # 单元测试（vitest）
npm run typecheck  # TS 类型检查（node + web 两套 tsconfig）
npm run build      # 构建（out/）
npm run dist:mac   # 打 mac 安装包（dmg）
npm run dist:win   # 在 macOS 上交叉打 Windows NSIS 包
```

### 目录结构

```
src/
  main/       主进程。其中监控内核（monitor/ notify/ net/ config/ logger/）
              是零 electron 依赖的纯 TS 模块，可在 node 下单测与 headless 直跑；
              desktop/ 负责装配（托盘、窗口、IPC、电源钩子）
  preload/    contextBridge 白名单 API
  renderer/   React UI（监控台 + 设置双栏）
  shared/     主/渲染/headless 共享的数据契约（types.ts / ipc.ts）
scripts/      headless.ts 内核直跑入口
docs/         decisions.md 架构决策记录、usage.md 深度使用文档
```

### headless 模式（不经 Electron 直跑内核）

```bash
# 单轮冒烟：抓一轮即退出，打印统计（抓取失败时退出码 1）
npm run engine:headless -- --once

# 指定数据目录（首次运行会生成默认 config.json，chmod 600）
npm run engine:headless -- --config /tmp/nsm-smoke --once

# 常驻运行直到 Ctrl-C
npm run engine:headless -- --config ./data/headless

# 跑 10 分钟、30 秒一轮
npm run engine:headless -- --duration 600 --interval 30

# 用环境变量注入 Telegram 凭据（只进内存，不落盘）
NSM_BOT_TOKEN=xxx NSM_CHAT_ID=yyy npm run engine:headless -- --once
```

参数：`--config <dir>` 数据目录（默认 `./data/headless`，内含 `config.json` / `seen.json` / `state.json` / `logs/`）；`--once` 跑一轮退出；`--duration <sec>` 运行指定秒数后优雅退出；`--interval <sec>` 临时覆盖轮询间隔（最低 15 秒，不写回配置）。

注意：headless 的配置是启动时快照，改配置文件需重启进程（桌面版无此限制，改配置即时生效）。

### 测试

```bash
npm test
```

内核（matcher、engine、poller、dedup、state、html 解析、http、telegram、logger、config store）均为纯模块单测，不依赖 Electron。

### 打包

- mac：`npm run dist:mac` 本地出 dmg。
- win：`npm run dist:win` 在 macOS 上交叉打 NSIS 包（electron-builder 26 打常规 NSIS 目标不需要 wine）。
- 代码签名留空（见已知限制）。

### CI

CI/发布已配置：push/PR 跑 typecheck+单测+构建门禁（`.github/workflows/ci.yml`）；推送 `v*` tag 自动在 GitHub Actions 双平台构建并发布 Release——mac runner 出 dmg（arm64+x64）、windows runner 出 nsis x64（`.github/workflows/release.yml`）。本地打包命令见上方。

## 已知限制

- **应用未签名未公证**：macOS 首次打开需右键 → 打开；Windows 会遇 SmartScreen"仍要运行"；mac 上登录自启可能被系统拒绝。
- **NodeSeek 非官方接口**：数据来自 NodeSeek 首页的 SSR HTML，不是官方 API。站点改版或风控策略变化（如 Cloudflare 挑战常态化）可能导致监控失效，需要发版适配；这是长期存在的风险。
- **只监控首页第 1 页**：每轮约 49 条最新帖，不翻页。极高峰时段两轮间隔内的帖子可能被顶出第 1 页而漏掉。
- **关键词只匹配标题**，不匹配正文、作者、分类。
- **无自动更新**：升级请手动下载新版安装包覆盖安装。

## License

[MIT](LICENSE) © colmidad
