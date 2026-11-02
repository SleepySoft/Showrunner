# API 参考

| 视角 | 本文定位 |
|---|---|
| WHY | 为遥控器、电视端和服务端提供明确的信任边界与稳定契约 |
| WHAT | REST 控制面、两个分离的 WebSocket 端点和局域网媒体流 |
| HOW | 以下按资源列出请求、响应、校验和状态码 |
| ADR | [服务器权威状态](adr/0001-server-authoritative-playback.md) · [公网仅开放遥控平面](adr/0005-public-control-plane-only.md) |

Base URL：`http://<电脑IP>:7100`

除首次配对、密码恢复和 `POST /api/login` 外，所有业务 `/api/*` 需要会话（Cookie `sr_session`，登录、配对或恢复成功时下发）。
`/tv`、`/media`、`/cache`、`/compatible`、`/ws-tv` 和兼容旧版的 `/ws` 面向局域网播放端——**公网部署必须屏蔽**。公网仅白名单开放 `/remote`、`/api`、`/ws-remote`。

## 存储迁移门禁

### `GET /api/storage/status`

正常运行返回 `{ "required": false }`。如果启动时发现程序目录内的旧版数据，服务只运行迁移门禁，该接口返回新旧目录的文件数、字节数和是否冲突；不返回绝对路径或确认码。

### `POST /api/storage/confirm`

仅迁移门禁存在。需提交本机电视画面上的六位确认码：

```json
{ "code": "123456", "action": "migrate" }
```

`action` 可为 `migrate`、`use-target`、`fresh` 或 `postpone`。`fresh` 还必须提交 `confirmFresh: true`。连续五次确认码错误后，当前进程不再接受尝试。门禁期间业务 API 、播放 WebSocket 和媒体流都不会启动。

## 鉴权

### `GET /api/setup/status` / `POST /api/setup`

未设置长期密码时，状态接口返回 `{ "required": true }`。手机提交电视画面上的 6 位一次性码和自选密码：

```json
{ "code": "482731", "newPassword": "至少 8 个字符" }
```

成功响应与登录相同并设置会话 Cookie。配对码错误返回 403，连续失败会返回 429；已经完成配对返回 409。配对码本身只能由本机 loopback 的 `/tv/setup-info` 读取，不通过 `/api/setup/status` 披露。

### 忘记密码恢复

- `GET /api/password/recovery/status`：只返回是否有有效请求和过期时间，不返回确认码。
- `POST /api/password/recovery/request`：请求电视显示十分钟一次性码。
- `POST /api/password/recovery/confirm`：提交 `{ "code": "123456", "newPassword": "..." }`，成功后保存新哈希、撤销所有旧会话并返回新会话。

请求和确认都只接受局域网 IP 直连；存在 `Forwarded` / `X-Forwarded-For` 或 Host 为公网域名时返回 403。确认码只由 loopback `/tv/setup-info` 披露，连续五次错误后锁定十五分钟。

### `POST /api/login`

```json
// 请求
{ "password": "..." }
// 200
{ "ok": true, "token": "<hex>" }   // 同时 Set-Cookie: sr_session=<token>; HttpOnly
// 401
{ "error": "wrong password" }
```

`token` 同时用于 WebSocket 遥控器连接（见下）。

### `POST /api/logout`

使当前会话失效并清除 Cookie。

### `POST /api/password`

```json
{ "currentPassword": "旧密码", "newPassword": "至少 8 个字符的新密码" }
```

成功后密码以 scrypt 哈希写入配置，撤销全部旧会话，并为当前设备签发新会话。

## 状态

### `GET /api/state`

```json
{
  "state": {
    "status": "playing",            // idle | playing | paused
    "position": 123.4,              // 秒（电视端心跳回报的真实进度）
    "duration": 5400,
    "volume": 1,
    "current": { "qid": "...", "mediaId": "...", "title": "...", "relPath": "...", "index": 0 },
    "queueLength": 3,
    "upcoming": [{ "qid": "...", "title": "..." }],  // 最多 3 部
    "waiting": { "reason": "schedule", "nextStartAt": 1793529000000, "nextTitle": "下一档" },
    "channels": [{ "id": "...", "name": "少儿频道", "selected": true, "allowOnDemand": false }],
    "selectedChannelId": "..."
  },
  "queue": [{ "qid": "...", "type": "local|web|collection", "title": "...", "addedAt": 0 }],
  "playlists": [{ "id": "...", "name": "...", "count": 3, "active": true, "loop": false }],
  "activeId": "...",
  "cache": [{ "key": "...", "url": "...", "title": "...", "status": "ready", "progress": 100, "bytes": 0 }],
  "collections": [{ "id": "...", "name": "...", "count": 12, "cursor": 3, "mode": "sequential" }],
  "schedules": [{ "id": "...", "playlistId": "...", "playlistName": "...", "days": [6, 0], "start": "18:00", "end": "20:00", "loop": true }]
}
```

注意：`state`（电视端可见）与 `queue` / `playlists`（仅遥控器可见）是两个信任级别。电视只能看到启用频道；禁止点播的频道不会暴露完整节目目录。

合集条目（`type: "collection"`）成为当前片时，`state.current` 会被伪装成已解析的那一集（local/web 类型），标题形如 `《地球脉动》第3集 深海世界`，并带 `collectionId`；合集为空或已删除时带 `cacheError`。

## 频道（兼容路径 `/api/playlists`）

频道可创建多个并同时启用，`activeId` 表示电视当前选中的频道。为兼容旧客户端，接口和持久化字段仍沿用 `playlists` 名称。

频道摘要新增 `enabled`、`allowOnDemand`、`autoPlay`。电视只会收到启用频道；仅当 `allowOnDemand=true` 时才会收到该频道的节目目录。

### `POST /api/playlists/:id/options`

```json
{ "enabled": true, "allowOnDemand": true, "autoPlay": true }
```

- `enabled`：频道是否出现在电视端。
- `allowOnDemand`：电视端是否可以选择具体节目。
- `autoPlay=false`：纯点播频道，空闲时显示待机/节目选择画面。

### `POST /api/playlists/:id/items/:qid/timing`

```json
{ "startTime": "18:30", "maxPlaySeconds": 1200 }
```

- `startTime`：每日指定开播点；提前结束时待机到下一档，下一档到点强切。留空清除。
- `maxPlaySeconds`：播放上限，到时强切，可用于裁掉片尾垫料。留空清除。

### `GET /api/playlists`

```json
{ "playlists": [{ "id": "...", "name": "...", "count": 3, "active": true }], "activeId": "..." }
```

### `POST /api/playlists`

```json
// 请求 { "name": "周末纪录片之夜" } → 201 { "playlist": {...} }
```

### `POST /api/playlists/:id/rename`

```json
// 请求 { "name": "新名字" } → 200 { "ok": true }
```

### `DELETE /api/playlists/:id`

删除节目单。删除播出中的节目单会清空直播队列并待机。

### `POST /api/playlists/:id/activate`

切换当前频道。普通自动播出频道会立即开始播放，不需要再调用 `control: play`；纯点播频道仍进入点播待机，含指定开播点的频道仍按严格排时规则决定当前节目或待机。

设为当前播出：队列装入该节目单条目，回到第一部待机（不自动开播）。

### `POST /api/playlists/:id/loop`

```json
// 请求 { "loop": true } → 200 { "ok": true, "loop": true }
```

循环开关。播出中的节目单立即作用于直播队列：队尾 `next` 回卷到第一部继续播（合集条目抽新集）。

### `GET /api/playlists/:id`

```json
{ "playlist": { "id": "...", "name": "...", "active": false, "loop": false, "items": [...] } }
```

### `POST /api/playlists/:id/items`

```json
// 本地媒体 { "mediaId": "..." } 或 { "mediaIds": [...] }
// 网页片源 { "url": "https://..." }
// 合集抽一集 { "collectionId": "..." }
// 201 { "added": [...] }
```

播出中节目单的添加会实时推送到电视端。

### `PUT /api/playlists/:id/local-items`

```json
// 请求 { "mediaIds": ["当前确认保留的全部本地媒体 ID", "..."] }
// 200 { "added": [...], "removed": 2, "selected": 12 }
```

确认式更新频道中的本地文件集合。仍被选中的原条目会保留 `qid`、顺序和播放时间配置；取消选择的条目与历史重复项会删除，新选择追加到末尾。网页与合集条目不受影响。所有新 ID 会先验证，任一无效则整体不修改。

### `DELETE /api/playlists/:id/items/:qid` · `POST /api/playlists/:id/items/move`

```json
// move 请求 { "qid": "...", "toIndex": 2 }
```

## 合集

合集是连续剧式内容包：节目单里放「抽一集」条目，轮到它播出时从合集取下一集并推进游标。

### `GET /api/collections`

```json
{ "collections": [{ "id": "...", "name": "地球脉动", "count": 12, "cursor": 3, "mode": "sequential" }] }
```

### `POST /api/collections`

```json
// 请求 { "name": "地球脉动", "mode": "sequential" }   // mode: sequential（顺序）| random（随机不重复）
// 201 { "collection": { "id": "...", "name": "...", "mode": "...", "count": 0, "cursor": 0 } }
```

### `POST /api/collections/import`

从网站播放列表、B 站合集内任意一集、B 站分 P 视频等链接创建合集。B 站视频会自动反查它所属的 UGC 合集，其余网站由 yt-dlp 展开；解析成功后才创建合集。单个视频链接会导入为一集。单次最多导入 500 集。

```json
// 请求；name 可省略，默认使用网站返回的合集标题
{ "url": "https://www.bilibili.com/video/BV.../", "name": "可选名称", "mode": "sequential" }
// 201
{ "collection": { "id": "...", "name": "...", "count": 12, "cursor": 0 }, "imported": 12, "truncated": false }
```

### `GET /api/collections/:id`

返回合集全文（含 items 数组）。不存在返回 404。

### `POST /api/collections/:id/rename` · `/mode` · `/reset`

```json
// rename { "name": "新名字" } / mode { "mode": "random" } / reset 无请求体（游标归零、随机池重置）
```

### `DELETE /api/collections/:id`

删除合集（不影响队列里已解析出的剧集条目）。

### `POST /api/collections/:id/items`

请求体同节目单 items（mediaId / mediaIds / url），**禁止嵌套合集**（collectionId 返回 400）。

### `PUT /api/collections/:id/local-items`

请求与响应同频道的 `local-items` 接口，用确认后的完整 `mediaIds` 集合增减合集中的本地文件；网页条目不受影响，既有条目及其顺序会尽量保留。

### `DELETE /api/collections/:id/items/:qid` · `POST /api/collections/:id/items/move`

删除时若删的是游标之前的集，游标同步前移（不串集）。

## 播出时刻表

规则：「周几 + 时段 → 播哪个节目单」。服务端每 15 秒对齐一次；只在窗口进出瞬间动作（同规则生效期间不抢家长的手动操作）。不跨午夜（end 必须晚于 start）。

### `GET /api/schedules`

```json
{ "rules": [{ "id": "...", "playlistId": "...", "playlistName": "周末纪录片之夜", "days": [6, 0], "start": "18:00", "end": "20:00", "loop": true }] }
```

### `POST /api/schedules`

```json
// 请求 { "playlistId": "...", "days": [6, 0], "start": "18:00", "end": "20:00", "loop": true }
// 201 { "rule": {...} }
// 400 days 非法 / 时段非法；404 节目单不存在
```

创建后立即对齐一次——若此刻正处于窗口内，马上切台开播。

### `DELETE /api/schedules/:id`

删除规则；若删的是生效中的规则，立即停播待机。

## 节目表导出

### `GET /api/export`

JSON 全量导出：时刻表 + 节目单全文 + 合集全文。

### `GET /api/export.md`

Markdown 节目表下载（`Content-Disposition: attachment`）：时刻表表格、各节目单内容（合集条目标注"下次播第 N 集"）、合集进度（标注 ← 下一集）。适合打印贴在电视旁。

## 频道与合集资产

### `GET /api/assets/export`

下载无损的 `showrunner-assets` 文档。格式带 `schemaVersion`，完整保留频道选项、节目时间、合集游标与时刻表；不包含密码、绝对媒体目录、缓存和播放位置。该文件用于恢复、迁移和提交分享，和面向阅读的 `/api/export.md` 不同。

### `POST /api/assets/import`

```json
{ "mode": "merge", "document": { "format": "showrunner-assets", "schemaVersion": 1 } }
```

`merge` 保留当前资产，遇到 ID 冲突时自动重映射频道、合集和时刻表引用；`replace` 完整替换当前频道、合集与时刻表。导入本地媒体时按 `sourceName + relPath` 重新绑定，响应中的 `binding.unresolved` 表示当前片库尚未找到的条目数。请求上限 10 MiB；未知格式、未知 schema 版本、重复 ID 和悬空引用返回 400。

## 片库与目录

### `GET /api/library` / `GET /api/library?rescan=1`

```json
{
  "items": [{ "id": "...", "title": "...", "relPath": "纪录片/第一集.mp4", "sourceId": "...", "sourceName": "影片", "ext": ".mp4", "size": 123456 }],
  "mediaDirs": ["D:\\影片"]
}
```

`rescan=1` 重新扫描磁盘。条目按路径本地化排序，不暴露绝对路径。

`sourceId/sourceName` 标识片库根目录，前端据此构建「根目录 → 子目录 → 文件」树。频道和合集浏览器以现有本地条目作为初始勾选，用户增减选择后通过对应的 `PUT .../local-items` 一次确认；关闭或放弃不会发送更新，重复确认不会产生重复条目。

### `GET /api/dirs` / `POST /api/dirs` / `DELETE /api/dirs`

```json
// POST / DELETE 请求体
{ "path": "D:\\影片" }
// 响应
{ "dirs": ["D:\\影片"] }
```

增删媒体目录（网页端管理，持久化到数据文件 `settings.mediaDirs`，与 `config.json` 的目录合并）。POST 时目录不存在或不是目录返回 400；重复添加自动去重；增删后立即重扫片库。

### `GET /api/browse` / `GET /api/browse?path=<目录>`

```json
// 不带 path：返回根位置（Windows 盘符清单）
{ "path": null, "parent": null, "dirs": [{ "name": "C:\\", "path": "C:\\" }], "videoCount": 0 }
// 带 path
{ "path": "D:\\影片", "parent": "D:\\", "dirs": [{ "name": "纪录片", "path": "D:\\影片\\纪录片" }], "videoCount": 12, "isMediaCandidate": true }
```

供遥控器网页浏览服务器文件系统、挑选媒体目录。目录不存在返回 400。隐藏目录（`.` / `$` 开头）不出现在列表中。盘符清单通过 `fsutil` 枚举（逐个探测会撞上断开的网络映射盘而挂起）。

## 队列（播出中节目单的快捷入口）

### `POST /api/queue`

向**播出中**的节目单末尾追加条目。没有播出中节目单时返回 409。

```json
// 本地媒体（单个或批量）
{ "mediaId": "..." }
{ "mediaIds": ["...", "..."] }
// 网页片源：直接贴地址，服务端自动抓 <title> 并剥掉站点 SEO 后缀
{ "url": "https://www.bilibili.com/video/BVxxxx" }
// 合集抽一集
{ "collectionId": "..." }
// 201
{ "added": [{ "qid": "...", "type": "local|web", ... }] }
// 400 链接非法或非 http/https / 404 媒体不存在
```

网页片源条目不携带 `mediaId`。入列后服务端自动用 yt-dlp 预下载到缓存（见「网页片源缓存」），电视端播缓存文件。标题抓取失败时退化为「主机:端口 + 路径」，入列永远成功。

网页片源条目在 `state.current` 中会附加缓存装饰字段：

```json
{
  "type": "web", "url": "https://...",
  "cacheStatus": "ready",          // none | pending | downloading | ready | failed
  "progress": 100,                 // 0~100
  "stream": "/cache/<key>/stream", // 仅 ready 时存在，电视端直接播它
  "cacheError": "...",             // 仅 failed 时存在
  "cachedTitle": "..."             // yt-dlp 抓到的正式标题
}
```

## 网页片源缓存

缓存文件按 `cache/<站点>/<标题>-<内容ID>.<扩展名>` 规范命名，索引在 `cache/index.json`。队列变化时自动预取「当前 + 后续 2 个」网页条目。

### `GET /api/cache`

```json
{ "items": [{ "key": "...", "url": "...", "title": "...", "status": "ready", "progress": 100, "bytes": 123456 }] }
```

`GET /api/state` 的响应也带同样的 `cache` 数组。

### `POST /api/cache/:key/retry`

重试一个 `failed` 条目。非 failed 返回 409。

### `DELETE /api/cache/:key`

删除缓存条目及其磁盘文件。

### `GET /cache/:key/stream`

缓存产物的流式端点（局域网、不鉴权，同 `/media`）。支持 Range；未 ready 或不存在返回 404。

### `DELETE /api/queue/:qid`

删除条目。删除正在播的条目会原位接下一部、进度归零。不存在返回 404。

### `POST /api/queue/move`

```json
{ "qid": "...", "toIndex": 2 }
```

索引越界自动钳制；当前播放片跟随移动。

### `POST /api/queue/clear`

清空队列并进入待机。

## 维护模式

### `GET /api/mode`

```json
{ "mode": "normal", "manageFrontend": true, "frontend": "mpv", "playerRunning": true, "kioskRunning": false, "player": { "type": "mpv", "available": true, "running": true, "ipcConnected": true, "currentQid": "...", "lastError": null }, "frontends": { "chrome": {}, "mpv": {} } }
```

### `POST /api/mode`

```json
// 请求 { "mode": "maintenance" }   // 或 "normal" / "offline"
```

- `maintenance`：等待当前 Chrome/mpv 播放前端退出，再启动一个受控的非 kiosk 维护窗口；到期或手动回锁时先关闭维护窗口，再恢复所选前端。
- `offline`：停止播放前端且看门狗不再重拉；状态持久化，直到遥控器切回 `normal`。
- 非法 mode 返回 400。`manageBrowser: false` 时模式仍记录但不操作浏览器进程。
- 模式变更通过 WebSocket 推送 `{ "type": "mode", "data": { /* 同 GET /api/mode */ } }`。
- 所有模式切换串行处理；Showrunner 管理的浏览器任意时刻最多一个。服务启动时会清理带专用 profile 标记的遗留实例，不影响用户自己的浏览器。

## 播放前端

- `GET /api/playback/frontend`：返回与 `/api/mode` 相同的前端、可用性、进程和 IPC 状态，不包含绝对媒体路径。
- `PUT /api/playback/frontend`，请求 `{ "type": "chrome" }` 或 `{ "type": "mpv" }`：串行停止旧前端并启动新前端。成功后保存机器级配置；未注册类型返回 400，启动失败返回 409 并恢复旧前端。

## 开机启动

- `GET /api/autostart` → `{ "supported": true, "enabled": false }`
- `POST /api/autostart`，请求 `{ "enabled": true }`：在 Windows 创建或删除固定名称的当前用户登录任务；不执行用户提供的命令或路径。

## 播放控制

### `POST /api/control`

| action | 参数 | 说明 |
|---|---|---|
| `play` | — | 开播/继续；待机中则从当前（或第一部）开始 |
| `pause` | — | 暂停 |
| `next` | — | 下一部；队尾则播完待机 |
| `prev` | — | 上一部 |
| `jump` | `qid` | 跳到队列中任意一部并开播 |
| `seek` | `position`（秒） | 跳转进度 |
| `volume` | `volume`（0~1） | 音量 |
| `standby` | — | 停播待机：保留队列，回到第一部开头 |

```json
// 200
{ "ok": true, "state": { ... } }   // 返回最新公开状态
// 400 unknown action / 409 当前状态不适用
```

## 媒体流

### `GET /media/:id/stream`

- 支持 `Range: bytes=start-end`（拖动进度条必需），正确返回 `206` / `Content-Range` / `416`。
- `id` 必须是媒体库已登记 ID，否则 404——不接受路径参数，无目录穿越风险。

### `GET /compatible/:id/stream`

- 本地媒体的 H.264/AAC MP4 兼容缓存流，同样支持 Range。
- 仅转换完成后存在，否则返回 404；和 `/media` 一样只应在局域网开放。

## WebSocket

### `GET /ws-tv`

电视端局域网连接，无需 token；不得经公网反代开放。

### `GET /ws-remote`

遥控器状态连接，使用登录产生的 `HttpOnly` 会话 Cookie；无效会话以 `4401` 关闭，旧客户端仍可传 `?token=...`。可经严格白名单的 HTTPS/WSS 反代开放。`/ws?role=...` 只为旧客户端兼容，禁止公网开放。

**服务端 → 客户端**

```json
{ "type": "state", "data": { /* 同 GET /api/state 的 state */ } }
```

连接建立即推送一次；此后任何状态变更实时推送。`position` 心跳**不**触发广播（防风暴）。

**电视端 → 服务端**（仅 `/ws-tv` 连接被采信，遥控器发送会被忽略）

```json
{ "type": "ended" }                                  // 播完 → 服务端自动连播
{ "type": "position", "position": 12.5, "duration": 5400 }   // 每 5 秒心跳
{ "type": "playbackIssue", "qid": "...", "kind": "frozen", "detail": "播放位置连续 20 秒未前进", "position": 12.5, "duration": 5400, "readyState": 2, "networkState": 2 }
```

`playbackIssue` 仅在 `qid` 等于当前节目时生效。服务端将事件追加到 `<data-dir>/logs/playback-events.log`，随后按正常播完逻辑跳到下一节目；同一节目 10 秒内重复报告会被忽略。当前类型包括下载/登录等准备失败的 `source_error`，以及 `media_error`、`play_rejected`、`frozen`、`unexpected_pause`、`stalled` 和兼容转换相关事件。

本地媒体出现 `MEDIA_ERR_SRC_NOT_SUPPORTED` 或 `MEDIA_ERR_DECODE` 时，电视端改发：

```json
{ "type": "compatibilityRequest", "qid": "...", "detail": "MEDIA_ERR_SRC_NOT_SUPPORTED" }
```

服务端验证当前节目后启动 FFmpeg 兼容转换，不立即跳台。状态中的当前节目会出现 `compatibilityStatus: pending|transcoding|ready|failed`；就绪时 `stream` 指向 `/compatible/:mediaId/stream`。

### `GET /api/diagnostics/playback?limit=200`

返回最近的结构化播放事件（新到旧）及兼容转换缓存摘要。需要登录，最多返回 500 条，不包含绝对媒体路径和原始服务端日志。
