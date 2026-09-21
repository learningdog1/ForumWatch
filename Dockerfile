# syntax=docker/dockerfile:1
#
# ForumWatch Docker 镜像 —— 无头内核 + 同一套 Web 管理界面。
#
# 构建(多阶段):
#   1. build:npm ci → 渲染层 vite 构建(out/renderer)→ esbuild 打包
#      scripts/headless.ts 为单文件 server.js(packages=external:cheerio/
#      undici/fetch-socks 由运行阶段的 node_modules 提供,与 electron-vite
#      externalizeDepsPlugin 同款思路);
#   2. runtime:node:22-alpine + 生产依赖 + server.js + web 静态产物。
#
# 运行:docker run -d -p 8787:8787 -v fw-data:/data \
#   -e TZ=Asia/Shanghai -e FW_WEB_TOKEN=换个强口令 cashewchickengazgazgood/forumwatch
# 数据全部落 /data(config/seen/state/hits/logs/...),升级换镜像不丢数据。
# 管理界面:http://<host>:8787(与桌面版同一套 UI;公网部署务必设 FW_WEB_TOKEN)。

# ---- 构建阶段 -----------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# 依赖层(锁文件先行,利用层缓存)
COPY package.json package-lock.json ./
RUN npm ci

# 源码与构建
COPY tsconfig*.json electron.vite.config.ts vitest.config.ts ./
COPY src ./src
COPY scripts ./scripts
# 渲染层产物:桌面版同一构建(vite 产物浏览器可直跑,web-shim 已在入口接线)
RUN npm run build
# 无头服务器单文件打包(CJS;相对源码与 package.json 内联,外部依赖留 node_modules)
RUN npx esbuild scripts/headless.ts --bundle --platform=node --target=node22 \
    --format=cjs --packages=external --outfile=dist/server.js \
    --log-level=warning

# ---- 运行阶段 -----------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# 仅生产依赖(cheerio/undici/fetch-socks,全纯 JS 无原生模块)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 服务器单文件 + Web 静态产物
COPY --from=build /app/dist/server.js ./server.js
COPY --from=build /app/out/renderer ./web

# 数据卷(配置/去重集/命中/日志全在此;升级换镜像不丢)
VOLUME /data
ENV FW_WEB_ROOT=/app/web
# 端口可用 FW_WEB_PORT 覆盖(容器内监听端口,映射时保持一致)
EXPOSE 8787

# 健康检查:API 可达即健康(引擎轮询状态在 UI 里看,不作为容器存活条件)
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${FW_WEB_PORT:-8787}/api/health" >/dev/null || exit 1

CMD ["sh", "-c", "exec node server.js --config /data --web ${FW_WEB_PORT:-8787}"]
