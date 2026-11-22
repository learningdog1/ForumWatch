# ForumWatch 活动聚合 API 与高并发部署指南（对接 Anode / `nodeseek`）

本文档说明如何将 ForumWatch 部署在公网服务器上提供高并发「社区活动 / 抽奖 / 节日专题」API，并无缝对接客户端项目（`/Volumes/2T/Applications/Data/code/orca/nodeseek`，即 `learningdog1/Anode` 中的 `ActivityRepository`）。

---

## 1. 架构与高并发设计

为什么 ForumWatch 可以在保证论坛零封号风险的同时扛住高并发客户端流量？

1. **单实例采集引擎 + 多核只读 API 进程池（`node:cluster`）读写物理分离**：
   - **Primary 主进程**：唯一运行 `MonitorEngine`、Telegram 推送与 `ActivityCollector`（初筛 → 2.5s+ 串行限速抓取 1 楼详情 → AI 结构化精筛 → 异步去抖原子写盘），绝不出现多实例重复爬 NodeSeek 触发 Cloudflare 403 或重复发 Telegram 推送的问题。
   - **N 个只读 API Worker（`FW_API_WORKERS=auto`）**：在独立端口（如 `8788`）共享监听，仅持有主进程通过 IPC 实时同步的纯内存 `ReplicaActivityView`，物理剥离后台管理面（`/api/invoke` 与 `/api/v1/admin/*` 在公开端口恒不可达）。
2. **零磁盘 I/O + 预序列化 `Buffer` + 预压缩 `Gzip` + 零陈旧 `ETag`**：
   - 所有客户端读取 100% 走内存索引 + LRU 预序列化缓存，单核即可承载万级 QPS；
   - `effectiveRevision` 将数据变更版本与活动 `startsAtEpochMillis` / `endsAtEpochMillis` 时间边界做二分融合：活动到点开奖/截止的那一毫秒起 `ETag` 自动更新，无需后台轮询改状态；客户端带 `If-None-Match` 命中 `304 Not Modified` 时响应体为 0 字节。
   - 列表页每轮抓取顺带检查首页标题，楼主将标题改为 `【已开奖】` / `[已结束]` 时**零额外 HTTP 请求**自动将活动同步为 `ended`。

---

## 2. 服务器部署（Docker Compose + Nginx 反代）

### 2.1 一键启动（源码构建运行）

```bash
git clone https://github.com/learningdog1/ForumWatch.git
cd ForumWatch
docker compose up -d --build
```

关键环境变量说明（见 `docker-compose.yml`）：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TZ` | `UTC`（建议设 `Asia/Shanghai`） | 决定帖子相对时间（如「今晚 22:00 开奖」）的解析时区 |
| `FW_WEB_PORT` / `FW_WEB_HOST` | `8787` / `0.0.0.0` | 管理后台与管理 API 监听端口 |
| `FW_WEB_TOKEN` | 空 | **管理端令牌**（保护网页后台、`/api/invoke` 与 `/api/v1/admin/activities*`） |
| `FW_API_PORT` / `FW_API_HOST` | 未设 / `0.0.0.0` | 物理隔离的**公开只读活动 API 端口**（推荐设 `8788` 对外暴露） |
| `FW_API_WORKERS` | `1` | 公开端口只读 Worker 进程数，设为 `auto` 自动按服务器 CPU 核数横向扩展 |
| `FW_ACTIVITY_SECRET` | 空 | 客户端鉴权密钥。留空=公开免鉴权；非空=默认支持 `Bearer <secret>` 或 `OverseasApiCrypto` 同款 `HMAC-SHA256` 签名 |
| `FW_ACTIVITY_ENCRYPT` | `false` | 设为 `true`（需同时设 `FW_ACTIVITY_SECRET`）时强制要求 `HMAC-SHA256` 签名并以 `AES-256-GCM` 加密信封返回 |
| `FW_API_RATE_LIMIT_RPM` | `240` | 单客户端 IP 每分钟令牌桶限流阈值（设为 `0` 关闭内置限流） |
| `FW_TRUST_PROXY` | `false` | 前置 Nginx / Cloudflare 时设为 `true`，按 `CF-Connecting-IP` / `X-Real-IP` / `X-Forwarded-For` 识别真实 IP |

### 2.2 推荐 Nginx 反向代理配置（抗瞬时十万级并发）

若使用公开免鉴权或反代层微缓存，在 Nginx 中代理 `127.0.0.1:8788` 并开启 keepalive 连接池：

```nginx
proxy_cache_path /var/cache/nginx/fw_activity levels=1:2 keys_zone=fw_act_cache:16m max_size=256m inactive=10m use_temp_path=off;

upstream forumwatch_activity_api {
    server 127.0.0.1:8788;
    keepalive 64;
}

server {
    listen 443 ssl http2;
    server_name activity-api.example.com;

    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://forumwatch_activity_api;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # 公开明文模式下可进一步开启 3s 微缓存 + 后台并发回源合并锁，彻底挡住洪峰：
        proxy_cache fw_act_cache;
        proxy_cache_lock on;
        proxy_cache_use_stale updating error timeout http_500 http_502 http_503 http_504;
    }
}
```

---

## 3. HTTP 接口契约

### 3.1 健康探活

- **`GET /healthz`**（或 `GET /api/v1/health`，免鉴权）
- 响应 `200 OK`：
  ```json
  { "ok": true, "status": "ok", "version": "0.11.0", "activities": 18, "uptimeSec": 3600 }
  ```

### 3.2 活动列表查询（客户端主接口）

- **`GET /api/v1/activities`**
- 查询参数：
  - `page`：页码（从 `1` 起，默认 `1`）
  - `page_size`（兼容 `pageSize`）：每页条数（`1..100`，默认 `20`）
  - `status`：`all`（默认）| `active`（= `ongoing` + `upcoming`）| `ongoing` | `upcoming` | `ended`
  - `kind`：可选过滤，`lottery` | `giveaway` | `promo` | `event` | `floor` | `other`（支持逗号分隔多值，如 `lottery,floor`）
  - `source_id`（兼容 `sourceId`）：可选来源过滤（如 `nodeseek`）
  - `q`：可选搜索词（匹配标题、摘要、主办方、奖品、标签）
  - `updated_after`（兼容 `updatedAfter`）：可选增量同步毫秒时间戳
- 条件缓存头：支持请求头 `If-None-Match: <ETag>` 或 `If-Modified-Since`，未变更返回 `304 Not Modified`。
- 响应 `200 OK`（明文模式；若开启 `FW_ACTIVITY_ENCRYPT=true`，外层包裹 `{ "v": 1, "alg": "AES-256-GCM", "iv": "...", "data": "..." }`）：
  ```json
  {
    "ok": true,
    "updatedAtEpochMillis": 1795347000000,
    "serverTimeEpochMillis": 1795347005123,
    "page": 1,
    "pageSize": 20,
    "page_size": 20,
    "total": 12,
    "hasMore": false,
    "has_more": false,
    "counts": {
      "all": 12,
      "ongoing": 8,
      "upcoming": 1,
      "ended": 3
    },
    "items": [
      {
        "id": "nodeseek:936634",
        "title": "【抽奖】周末送一台 DMIT HK Pro 年付小鸡",
        "summary": "奖品：DMIT HK Pro 年付 VPS × 1 · 规则：评论即可参与，每人限一次",
        "sourceUrl": "https://www.nodeseek.com/post-936634-1",
        "organizer": "vps_lover",
        "organizerUrl": "https://www.nodeseek.com/space/1024",
        "startsAtEpochMillis": 1795310000000,
        "endsAtEpochMillis": 1795395200000,
        "status": "ongoing",
        "kind": "lottery",
        "pinned": false,
        "sourceId": "nodeseek",
        "topicId": "936634",
        "category": "日常",
        "categorySlug": "daily",
        "luckyUrl": "https://www.nodeseek.com/lucky?post=936634&time=1795395200000",
        "drawFloor": null,
        "prize": "DMIT HK Pro 年付 VPS × 1",
        "participation": "评论即可参与，每人限一次",
        "tags": ["抽奖", "官方开奖", "VPS"],
        "createdAtEpochMillis": 1795310005000,
        "updatedAtEpochMillis": 1795310005000
      }
    ]
  }
  ```

### 3.3 单条活动详情

- **`GET /api/v1/activities/:id`**
  - `:id` 支持 URL 编码后的完整 ID（如 `nodeseek%3A936634`）或直接传 NodeSeek 裸帖子号（如 `936634`）。
- 响应 `200 OK`：在列表项全部字段基础上额外返回清洗后的 1 楼 `bodyMarkdown` 与 `externalLinks: [{ "text": "...", "url": "..." }]`。

### 3.4 管理端人工干预接口（仅挂载在管理端口 `:8787`，需携带 `Authorization: Bearer <FW_WEB_TOKEN>`）

```bash
# 1. 输入任意 NodeSeek 帖子链接一键抓取解析入库：
curl -X POST http://127.0.0.1:8787/api/v1/admin/activities/ingest \
  -H "Authorization: Bearer $FW_WEB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.nodeseek.com/post-936634-1","force":true}'

# 2. 手动发布专题活动并置顶：
curl -X POST http://127.0.0.1:8787/api/v1/admin/activities \
  -H "Authorization: Bearer $FW_WEB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "NodeSeek 黑五促销与抽奖汇总专题",
    "summary": "汇总全站黑五商家闪购与官方盖楼抽奖",
    "sourceUrl": "https://www.nodeseek.com/post-930000-1",
    "organizer": "NodeSeek 社区",
    "kind": "event",
    "pinned": true
  }'

# 3. 置顶 / 修改截止时间 / 手动结单 / 下线隐藏（设置后自动置 manualOverride=true，不会被爬虫覆盖）：
curl -X PATCH http://127.0.0.1:8787/api/v1/admin/activities/nodeseek%3A936634 \
  -H "Authorization: Bearer $FW_WEB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"pinned":true,"forceEnded":false}'

# 4. 删除活动并记入墓碑（后续轮询不会重新入库）：
curl -X DELETE http://127.0.0.1:8787/api/v1/admin/activities/nodeseek%3A936634 \
  -H "Authorization: Bearer $FW_WEB_TOKEN"
```

---

## 4. 客户端 `/Volumes/2T/Applications/Data/code/orca/nodeseek` 对接代码参考

`items[]` 的核心字段已与 `com.nodeseek.app.domain.activity.ForumWatchActivityItem` **逐字段精确对齐**：
- `id: String`
- `title: String`
- `summary: String`
- `sourceUrl: String`
- `organizer: String`
- `startsAtEpochMillis: Long?`
- `endsAtEpochMillis: Long?`

同时返回了 `topicId`（当 `sourceId == "nodeseek"` 且 `topicId != null` 时，客户端可直接原生路由到 `TopicDetailScreen(topicId.toLong())`，无需跳外部浏览器）、`status`（`ongoing` / `upcoming` / `ended`）、`kind`、`luckyUrl`、`prize`、`participation` 与 `tags`。

在 `orca/nodeseek` 中实现 `ActivityRepository` 并接入 `DefaultAppContainer.kt` 的参考骨架：

```kotlin
package com.nodeseek.app.data.activity

import com.nodeseek.app.data.overseas.OverseasApiCrypto
import com.nodeseek.app.domain.activity.ActivityFeedSnapshot
import com.nodeseek.app.domain.activity.ActivityRepository
import com.nodeseek.app.domain.activity.ForumWatchActivityItem
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException

@Serializable
private data class ActivityItemDto(
    val id: String,
    val title: String,
    val summary: String = "",
    val sourceUrl: String = "",
    val organizer: String = "",
    val startsAtEpochMillis: Long? = null,
    val endsAtEpochMillis: Long? = null,
    val status: String = "ongoing",
    val kind: String = "other",
    val pinned: Boolean = false,
    val sourceId: String = "",
    val topicId: String? = null,
    val luckyUrl: String? = null,
    val prize: String? = null,
    val participation: String? = null,
    val tags: List<String> = emptyList(),
)

@Serializable
private data class ActivityFeedResponseDto(
    val ok: Boolean = true,
    val updatedAtEpochMillis: Long = 0L,
    val items: List<ActivityItemDto> = emptyList(),
)

@Serializable
private data class CachedActivityEnvelope(
    val etag: String? = null,
    val updatedAtEpochMillis: Long = 0L,
    val items: List<ActivityItemDto> = emptyList(),
)

class ForumWatchActivityRepository(
    private val baseUrlProvider: () -> String,
    /** 可选：留空走公开明文；填入与服务端 FW_ACTIVITY_SECRET 相同的密钥则自动走 HMAC 签名（支持加密信封） */
    private val sharedSecretProvider: () -> ByteArray? = { null },
    private val encryptedEnvelope: Boolean = false,
    private val cacheFile: File? = null,
    private val httpClient: OkHttpClient = OkHttpClient(),
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : ActivityRepository {

    private val json = Json { ignoreUnknownKeys = true }
    private val _snapshot = MutableStateFlow(ActivityFeedSnapshot())
    override val snapshot: StateFlow<ActivityFeedSnapshot> = _snapshot.asStateFlow()

    @Volatile
    private var lastEtag: String? = null

    override suspend fun loadCachedActivities(): ActivityFeedSnapshot = withContext(ioDispatcher) {
        val file = cacheFile ?: return@withContext _snapshot.value
        if (!file.exists()) return@withContext _snapshot.value
        runCatching {
            val cached = json.decodeFromString<CachedActivityEnvelope>(file.readText())
            lastEtag = cached.etag
            val snap = cached.toDomainSnapshot()
            _snapshot.value = snap
            snap
        }.getOrDefault(_snapshot.value)
    }

    override suspend fun refreshActivities(force: Boolean): Result<ActivityFeedSnapshot> =
        withContext(ioDispatcher) {
            runCatching {
                val url = baseUrlProvider().trim().trimEnd('/').toHttpUrl().newBuilder()
                    .addPathSegments("api/v1/activities")
                    .addQueryParameter("page", "1")
                    .addQueryParameter("page_size", "50")
                    .build()

                val reqBuilder = Request.Builder()
                    .url(url)
                    .get()
                    .header("Accept", "application/json")

                if (!force && !lastEtag.isNullOrBlank()) {
                    reqBuilder.header("If-None-Match", lastEtag!!)
                }

                val secret = sharedSecretProvider()?.takeIf { it.isNotEmpty() }
                val aesKey = if (secret != null && encryptedEnvelope) {
                    OverseasApiCrypto.deriveAesKey(secret)
                } else {
                    null
                }
                if (secret != null) {
                    val hmacKey = OverseasApiCrypto.deriveHmacKey(secret)
                    val pathWithQuery = url.encodedPath + (url.encodedQuery?.let { "?$it" }.orEmpty())
                    val tsSec = (System.currentTimeMillis() / 1000L).toString()
                    val nonce = OverseasApiCrypto.generateNonce()
                    val sig = OverseasApiCrypto.signRequest(hmacKey, "GET", pathWithQuery, tsSec, nonce)
                    reqBuilder.header("X-Timestamp", tsSec)
                        .header("X-Nonce", nonce)
                        .header("X-Signature", sig)
                    if (encryptedEnvelope) {
                        reqBuilder.header("X-Response-Enc", "aes-256-gcm")
                    }
                }

                httpClient.newCall(reqBuilder.build()).execute().use { res ->
                    if (res.code == 304) {
                        return@runCatching _snapshot.value
                    }
                    if (!res.isSuccessful) {
                        throw IOException("ForumWatch API HTTP ${res.code}")
                    }
                    val rawBody = res.body?.string().orEmpty()
                    val plainJson = if (aesKey != null || res.header("X-Content-Encrypted") == "AES-256-GCM") {
                        val key = aesKey ?: OverseasApiCrypto.deriveAesKey(checkNotNull(secret))
                        OverseasApiCrypto.decryptEnvelope(key, rawBody)
                    } else {
                        rawBody
                    }
                    val dto = json.decodeFromString<ActivityFeedResponseDto>(plainJson)
                    val etag = res.header("ETag")
                    lastEtag = etag
                    val envelope = CachedActivityEnvelope(
                        etag = etag,
                        updatedAtEpochMillis = dto.updatedAtEpochMillis,
                        items = dto.items,
                    )
                    cacheFile?.runCatching {
                        parentFile?.mkdirs()
                        writeText(json.encodeToString(CachedActivityEnvelope.serializer(), envelope))
                    }
                    val snap = envelope.toDomainSnapshot()
                    _snapshot.value = snap
                    snap
                }
            }
        }

    private fun CachedActivityEnvelope.toDomainSnapshot(): ActivityFeedSnapshot =
        ActivityFeedSnapshot(
            updatedAtEpochMillis = updatedAtEpochMillis,
            activities = items.map { dto ->
                ForumWatchActivityItem(
                    id = dto.id,
                    title = dto.title,
                    summary = dto.summary,
                    sourceUrl = dto.sourceUrl,
                    organizer = dto.organizer,
                    startsAtEpochMillis = dto.startsAtEpochMillis,
                    endsAtEpochMillis = dto.endsAtEpochMillis,
                )
            },
        )
}
```
