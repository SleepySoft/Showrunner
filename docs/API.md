# API 参考

Base URL：`http://<电脑IP>:7100`

除 `POST /api/login` 外，所有 `/api/*` 需要会话（Cookie `sr_session`，登录时下发）。
`/tv`、`/media`、`/cache` 面向局域网播放端，不鉴权——**公网部署必须屏蔽这三个前缀**。

## 鉴权

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
    "upcoming": [{ "qid": "...", "title": "..." }]   // 最多 3 部
  },
  "queue": [{ "qid": "...", "type": "local|web", "title": "...", "addedAt": 0 }],
  "playlists": [{ "id": "...", "name": "...", "count": 3, "active": true }],
  "activeId": "...",
  "cache": [{ "key": "...", "url": "...", "title": "...", "status": "ready", "progress": 100, "bytes": 0 }]
}
```

注意：`state`（电视端可见）与 `queue` / `playlists`（仅遥控器可见）是两个信任级别。`queue` 即播出中节目单的条目。

## 节目单

节目单可创建多个、单独编辑、随时复用；点「播出」的节目单成为直播队列。**播出中节目单的 items 与直播队列是同一份数据**——编辑它即实时作用于播出。

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

设为当前播出：队列装入该节目单条目，回到第一部待机（不自动开播）。

### `GET /api/playlists/:id`

```json
{ "playlist": { "id": "...", "name": "...", "active": false, "items": [...] } }
```

### `POST /api/playlists/:id/items`

```json
// 本地媒体 { "mediaId": "..." } 或 { "mediaIds": [...] }
// 网页片源 { "url": "https://..." }
// 201 { "added": [...] }
```

播出中节目单的添加会实时推送到电视端。

### `DELETE /api/playlists/:id/items/:qid` · `POST /api/playlists/:id/items/move`

```json
// move 请求 { "qid": "...", "toIndex": 2 }
```

## 片库与目录

### `GET /api/library` / `GET /api/library?rescan=1`

```json
{
  "items": [{ "id": "...", "title": "...", "relPath": "...", "ext": ".mp4", "size": 123456 }],
  "mediaDirs": ["D:\\影片"]
}
```

`rescan=1` 重新扫描磁盘。条目按路径本地化排序，不暴露绝对路径。

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
{ "mode": "normal", "manageBrowser": true, "kioskRunning": true, "maintenanceUntil": null, "browserFound": true }
```

### `POST /api/mode`

```json
// 请求 { "mode": "maintenance" }   // 或 "normal"
```

- `maintenance`：杀掉 kiosk 锁定画面，系统默认浏览器开一次普通窗口；`maintenanceUntil` 到期（默认 10 分钟）自动回到 `normal` 并重拉 kiosk。
- 非法 mode 返回 400。`manageBrowser: false` 时模式仍记录但不操作浏览器进程。
- 模式变更通过 WebSocket 推送 `{ "type": "mode", "data": { /* 同 GET /api/mode */ } }`。

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

## WebSocket

### `GET /ws?role=tv|remote[&token=...]`

- `role=remote`：需要 `token`（登录响应中的 token），无 token 以 `4401` 关闭。
- `role=tv`：局域网播放端，无需 token。

**服务端 → 客户端**

```json
{ "type": "state", "data": { /* 同 GET /api/state 的 state */ } }
```

连接建立即推送一次；此后任何状态变更实时推送。`position` 心跳**不**触发广播（防风暴）。

**电视端 → 服务端**（仅 `role=tv` 被采信，遥控器发送会被忽略）

```json
{ "type": "ended" }                                  // 播完 → 服务端自动连播
{ "type": "position", "position": 12.5, "duration": 5400 }   // 每 5 秒心跳
```
