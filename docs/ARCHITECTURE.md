# 架构设计：WHY / WHAT / HOW

> 文档导航：[WHY / WHAT / HOW / ADR](README.md) · 决策记录：[ADR 索引](adr/README.md)

## WHY：为什么这样设计

整个系统只有一条铁律：**电视端没有内容列表**。

传统思路是"做一个播放器，然后限制它的操作"——这条路永远在和小孩（和网页自身的推荐逻辑）斗智。Showrunner 反过来：电视端是一个哑终端，它只知道问服务器"现在放什么"，然后照做。选择权在结构上就不存在，而不是被禁用。

```
┌─────────────┐   REST + WS（编排、控制）   ┌──────────────────┐
│  手机遥控器  │ ────────────────────────▶ │                  │
│ （唯一有选择权）│ ◀──────────────────────── │    PC 服务端      │
└─────────────┘        WS 状态推送          │  ┌────────────┐  │
                                            │  │QueueManager│  │ ← 唯一权威
┌─────────────┐        WS「现在放什么」      │  │ （状态机）  │  │
│  电视播放端  │ ◀──────────────────────── │  └────────────┘  │
│  （哑终端）   │ ────────────────────────▶ │  Library / Store │
└─────────────┘   ended/position 上报       └──────────────────┘
                                                       │ Range 流
                                            视频数据 ──┘
```

对应决策：[ADR-0001：服务器权威播出状态](adr/0001-server-authoritative-playback.md)。

## WHAT：系统由什么组成

| 组件 | 负责 | 不负责 |
|---|---|---|
| `QueueManager` | 当前节目、播放状态、推进和待机 | 网站解析、磁盘扫描 |
| `PlaylistManager` | 频道及频道节目、启用和点播权限 | 实际播放进度 |
| `CollectionManager` | 合集内容、顺序/随机游标 | 决定何时播出 |
| `Scheduler` | 周期时段与频道跃迁 | 频道内单项播放细节 |
| `Library` / `CacheManager` | 本地媒体索引、网页媒体缓存与流 | 编排规则 |
| `SourceRegistry` | 网站识别、标题、合集及元数据兼容 | 下载进程和播放 |
| 遥控器 / 电视页 | 人机交互与媒体播放 | 保存权威业务状态 |

服务端把这些组件装配为 REST 控制平面、WebSocket 状态通道和 Range 媒体流。数据模型与接口分别见下文及 [API 参考](API.md)。

## HOW：系统如何工作

### 1. 状态机与频道

`QueueManager`（`src/queue.js`）持有全部播出状态；`PlaylistManager`（`src/playlists.js`）管理可复用的节目单。关键设计：**播出中节目单的 items 数组与 QueueManager.queue 是同一引用**——遥控器编辑播出中的节目单就是在编辑直播队列，电视端通过广播实时收到；编辑其他节目单则完全不影响播出。切换「播出」只是让队列装入另一个节目单的数组。

```js
// PlaylistManager
{ playlists: [{ id, name, items: [{ qid, type: 'local'|'web', mediaId|url, title, relPath, addedAt }] }],
  activeId }

// QueueManager（queue === 播出中节目单的 items，同一引用）
{ queue, currentIndex: -1 | 0..n-1,   // -1 = 待机（播完或未开始）
  playback: { status: 'idle'|'playing'|'paused', position, duration, volume, updatedAt } }
```

关键行为：

| 事件 | 行为 |
|---|---|
| 首部入列 | currentIndex 定位到 0，但**不自动开播**（等家长按 ▶） |
| 电视上报 `ended` | 自动 `next()`；到队尾则进入待机（currentIndex = -1），电视显示待机画面 |
| 删除正在播的条目 | 原位接下一部，进度归零 |
| 排序 move | 当前片跟随移动，播放不受影响 |
| `standby` 动作 | 停播但保留队列，回到第一部开头 |

所有变更发出 `change` 事件 → 服务端持久化（JSON 原子写）+ WebSocket 广播。

电视端只拿到 `getPublicState()`：当前片 + 状态 + 最多 3 部"即将播出"——**永远拿不到队列全文**。

### 2. 信任边界

| 端 | 能做什么 | 依据 |
|---|---|---|
| 遥控器 | 队列增删排序、播放控制 | 密码 → `HttpOnly` 会话 Cookie；`/ws-remote` 校验同一会话 |
| 电视端 | 收状态，上报进度/结束，并请求切台或点播 | `/ws-tv` 仅限可信局域网；请求仍由服务端按频道权限校验 |
| 遥控器伪造电视上报 | 无效 | 服务端按 WebSocket 端点区分角色（有测试覆盖） |

#### 首次配对

没有长期密码时，服务端不接受空密码登录，也不生成一个只能从控制台看到的永久密码。电视 kiosk 通过仅限 loopback 的 `/tv/setup-info` 显示一次性 6 位码和局域网地址；手机以配对码调用 `/api/setup` 并选择长期密码。成功后仅持久化 scrypt 哈希，码立即销毁。局域网设备只能查询“是否需要配对”，不能读取配对码；失败尝试有来源限速。见 [ADR-0010](adr/0010-first-run-tv-pairing.md)。

#### 频道、切换与受控点播

原「节目单」在产品界面中升级为「频道」，底层继续使用 `playlists` 字段兼容旧数据和旧 API。一个频道包含三个正交开关：

- `enabled`：是否出现在电视端；可同时启用多个。鼠标右键打开/关闭频道菜单，方向键选择，鼠标左键或 Enter 确认。
- `allowOnDemand`：是否向电视端披露该频道的节目标题并允许点播；关闭时仍只下发当前节目。
- `autoPlay`：关闭后是纯点播频道，进入频道先显示空闲画面，点播结束后回到空闲画面。

每个频道节目还可带两个互不冲突的时间字段：

- `maxPlaySeconds`：内容播放上限，用于裁掉片尾垫料；视频未结束也会到时强切。
- `startTime`（`HH:MM`）：每日指定开播点。节目提前结束时显示频道待机画面和下一档倒计时；下一开播点到达时强制切换，即使上一节目尚未结束。

电视的频道切换和点播指令仍经 WebSocket 交给服务器校验：只能切换 `enabled` 频道，只能点播当前频道且必须开启 `allowOnDemand`。电视不会获得未启用频道或禁止点播频道的完整目录。

电视端的能力被刻意收窄：它只能上报播放事实，以及请求服务器允许的频道切换或点播；它不能修改频道、权限、时刻表和完整片库。

#### 最小遥控器输入

电脑遥控器按鼠标左右键加键盘方向键处理：右键打开/返回/关闭菜单，四个方向键移动，左键点击或 `Enter/OK` 确认；`Escape/ContextMenu/BrowserBack` 是右键的兼容别名。频道菜单只列出启用频道；点播菜单只在当前频道允许点播时出现，选择仍交给服务器校验。鼠标移动不会自动打开菜单，系统音量键不受影响，电源键也不绑定应用行为。设计理由见 [ADR-0009](adr/0009-minimal-tv-remote-input.md)。

### 3. 媒体安全

- 影片 ID = `sha1(相对路径)` 前 16 位。文件不移动，ID 不变，重启后队列引用依然有效。
- `/media/:id/stream` 只接受**已登记**的 ID，路径不来自请求参数，杜绝目录穿越（有测试）。
- 对外 API 不暴露绝对路径。

### 4. 网页片源引擎

四级片源策略，按可控性从高到低自动降级：

1. **本地文件** —— 完全可控（已实现）
2. **预下载缓存** —— 编排后服务端用 yt-dlp 提前下载成本地文件，播放体验等同第 1 级：零广告、零卡顿、零网页逻辑（已实现，见下）
3. **实时流** —— yt-dlp 解析流地址交 mpv 播放，无网页但受网络影响（未做，预下载已覆盖大多数场景）
4. **kiosk Chrome 兜底** —— 仅 DRM 站点（优酷部分会员内容）。三重约束：
   - 导航看门狗：CDP 监听 URL，被推荐劫持立即拉回
   - 净化注入：隐藏推荐/评论/弹幕，锁死页面交互，监听 ended
   - 播放状态机：30 秒无心跳视为异常，自动跳下一部并通知手机

#### 缓存引擎实现（`src/ytdlp.js` + `src/cache.js`）

- **命名规范**：`cache/<站点>/<标题>-<内容ID>.<扩展名>`（如 `cache/bilibili/宇宙奇观：第一集-BV1xx411c7mD.mp4`），Windows 非法字符净化、限长 60；站点来自 yt-dlp 的 extractor，内容 ID 来自视频 ID。人打开目录就能看懂，不随意起名。
- **预取窗口**：播出队列每次变化时，自动缓存「当前 + 后续 2 个」网页条目（`prefetchQueue`）；`ensure()` 幂等，同一 URL 永不下两遍。
- **状态机**：`pending → downloading → ready / failed`。failed 可重试；进程重启时中断的下载降级为 failed。索引 `cache/index.json` 原子写。
- **装饰器模式**：`queue.decorator = item => cache.decorate(item)`——`getPublicState().current` 对网页条目附加 `cacheStatus / progress / stream / cacheError`，队列本身不感知缓存，职责分离。
- **播放**：ready 后电视端把 `stream`（`/cache/:key/stream`，同样支持 Range）当普通视频播；未就绪时黑屏显示"正在缓存 xx%"等待（进度实时推送），失败显示 6 秒后自动跳过。
- **LRU 淘汰**：缓存超过 `cacheMaxGB`（默认 20 GB）时淘汰最久未播的 ready 条目。
- **无 ffmpeg 兜底**：有 ffmpeg 用 `bv*+ba/b` 合并高画质；没有自动退回 `best[ext=mp4]/best` 单文件格式，保证一定能播。
- **登录态**：`cookiesFromBrowser` 让 yt-dlp 借用本机浏览器已登录的 Cookie 下载会员/登录内容；凭证只存在于服务端。过期时手机遥控器上该条目显示 ⚠️ 失败，可一键重试。扫码续期的完整闭环（电视投二维码）属 P3。
- **网站源适配层**：`src/sources/` 通过统一注册表分派标题、合集分析和 yt-dlp 元数据修补。站点专用代码独立成文件，失败返回 `null` 即落到公共 HTML/yt-dlp 兜底；新增源无需改业务路由、缓存或播放层，接口约定见 `docs/SOURCES.md`。

### 5. 电视台式编排：合集、循环与时刻表

#### 合集（`src/collections.js`）

合集是「连续剧式内容包」：自己维护一个**集数游标**（cursor），节目单里放一个 `type: 'collection'` 的「抽一集」条目，每次轮到它成为当前片时经 `queue.resolver` 调 `takeNext()` 取下一集——像电视台每天播一集连续剧。

- **顺序模式**：按合集内顺序播，播完自动从头再来；**随机模式**：随机抽且一轮内不重复（`randomPool` 抽完重置）。
- **解析结果记录在队列条目上**（`item.resolved`）：同一 qid 停留不重复抽；换节目单 / 循环回卷时 force 重抽；重启续播保持原集不串集（有测试）。
- **对外伪装**：`getPublicState()` 把已解析的合集条目伪装成普通条目（local/web），标题为 `《合集名》第N集 标题`——电视端完全无感；未解析（空合集）时给出 `cacheError`，电视端提示后跳过。
- 游标随数据文件持久化；删除游标前的条目时游标同步前移，不串集。

#### 循环播放

`queue.loop = true` 时队尾 `next()` 回卷到第一部并继续播（合集条目抽新集）；否则进入待机。循环标志存在节目单上（`playlists.setLoop`），时刻表规则也可单独带 loop；activate 时装入队列生效。

#### 播出时刻表（`src/scheduler.js`）

规则：`{ playlistId, days: [0-6], start: 'HH:MM', end, loop }`，每 15 秒 tick 一次。核心语义是 **transition-only**：

| 情况 | 动作 |
|---|---|
| 进入窗口（上次无命中或命中别的规则） | 切到该节目单并开播 |
| 同一条规则仍在生效 | **不动**——窗口内家长手动切台不被抢回 |
| 离开窗口（之前有命中） | 停播待机、回到第一部开头 |
| 规则指向已删除的节目单 | 切换失败、不记录，下轮再试，不崩溃 |

`decide(rules, now, last)` 是纯函数，测试注入时钟；服务端每 15 秒 tick + 启动即对齐 + 规则增删后立即对齐。规则存在数据文件 `settings.schedules`。

#### 节目表导出

`GET /api/export`（JSON）/ `GET /api/export.md`（Markdown 下载）：时刻表（时段/星期/循环）+ 各节目单全文（合集条目标注"下次播第 N 集"）+ 各合集内容与进度（标注 ← 下一集）。导出是纯读操作，可打印贴在电视旁。

#### 频道与合集资产

频道、合集、节目时间和时刻表另有带版本的 `.showrunner.json` 无损格式。`AssetVault` 只在这些内容的指纹变化时写入同级数据目录中的 `data/asset-backups/` 与 `asset-vault/`，并保留 30 份历史；播放进度不会制造历史噪声。实时状态损坏时 `Store` 从 `.bak` 恢复并隔离坏文件，不能恢复则停止启动，绝不以空频道覆盖原文件。完整边界见 [ADR-0008](adr/0008-channel-collection-assets.md)。

### 6. 浏览器托管（普通 / 维护 / 下线模式）

`BrowserController`（`src/browserctl.js`）把"kiosk 的开与关"变成服务端自己管理的进程：

- **普通模式**：看门狗每 5 秒检查 kiosk Chrome 是否存活，退出即重拉（10 秒冷却防拉起风暴）。kiosk 使用独立 `user-data-dir`，与用户日常浏览器是完全隔离的进程树——`taskkill /T` 只杀受控实例，不会误伤用户自己开着的窗口。
- **维护模式**：遥控器一键切换 → 等待 kiosk 进程树退出，再启动一个受控的非 kiosk 普通窗口（家长可以扫码续期或检查播放环境）；默认 10 分钟无操作自动回锁，也可随时手动回锁。
- **下线模式**：杀 kiosk 且停用看门狗重拉，释放电脑供其他用途；下线状态持久化，明确“重新上线”后才恢复。
- 模式变更经 WebSocket 实时推送到所有遥控器；维护状态不持久化，下线状态持久化。
- **单实例不变量**：模式切换串行执行并先关后开，`kiosk` 与 `maintenanceBrowser` 不得同时存在；启动时按专用 profile 标记清理上次异常退出的遗留实例，详见 [ADR-0007](adr/0007-single-managed-browser-instance.md)。

### 7. 持久化与恢复

- 程序目录与用户数据目录并列；`showrunner/` 默认使用 `showrunner-data/`。配置、状态、资产、日志和缓存都在后者中。
- 队列或节目单的每次变更即写 `<data-dir>/data/showrunner.json`（临时文件 + rename 原子替换，防断电损坏）。
- 数据文件同时保存 `settings.mediaDirs`（网页端增删的媒体目录）与 `settings.schedules`（时刻表规则）、`collections`（合集全文与集数游标）——重启不丢，与 `config.json` 预置目录合并去重。
- 发现程序目录内的旧版数据时，先进入只提供确认页的迁移门禁；未输入电视确认码前不加载业务、不写盘、不播放。见 [ADR-0012](adr/0012-confirmed-sibling-data-layout.md)。
- 旧版单队列的数据结构在人工确认文件位置迁移之后，再自动升级为「默认频道」。
- 重启后节目单、播出位置、播放进度原样恢复。
- 损坏的状态文件先尝试 `.bak` 与资产保险库；无法恢复时拒绝以空数据启动，避免覆盖现场。

### 8. 播放异常侦测

电视端在实际媒体播放路径上监听媒体错误和 `play()` 拒绝，并用 5 秒位置心跳判断冻结：服务端要求播放、存在当前媒体且连续 20 秒无进度，才报告 `playbackIssue`。缓存尚未完成、频道待机、用户暂停以及电视断线不会触发该判断。

服务端验证异常报告的 `qid` 必须等于当前节目，先向 `<data-dir>/logs/playback-events.log` 写入 JSONL，再调用与正常播完相同的频道推进逻辑。当前阶段不做刷新、重启或重复下载，边界与后续方向见 [ADR-0006](adr/0006-skip-and-log-playback-issues.md)。

本地媒体若明确报格式不支持或解码失败，不立即套用跳过策略：电视端改发 `compatibilityRequest`，服务端按需用 FFmpeg 生成 H.264/AAC MP4 到 `cache/compatible/`，完成后自动重播当前节目。原文件不变，转换结果按源文件签名复用并受独立容量上限约束。遥控器“日志”页通过鉴权 API 查看最近结构化播放事件与转换状态；不暴露绝对媒体路径。见 [ADR-0011](adr/0011-local-media-compatibility-fallback.md)。

### 9. 可选播放前端（已接受，待实现）

播出核心将与电视画面实现解耦：旧部署默认继续使用 Chrome kiosk，可选 mpv 直接播放本地/NAS 原文件和 yt-dlp 已就绪缓存。频道、合集、调度、异常策略与遥控器仍只有一份服务器权威状态；播放前端只执行命令和回报客观事件。`playerFrontend` 与可执行文件路径属于本机配置，不进入频道/合集资产。详细契约、源解析、单实例托管、维护模式、OSD/遥控器和实施顺序见 [ADR-0014](adr/0014-selectable-playback-frontends.md)。

## ADR：关键取舍

| 决策 | 主要理由 |
|---|---|
| [服务器权威播出状态](adr/0001-server-authoritative-playback.md) | 从结构上收回电视端选择权，并保持单一状态源 |
| [网页片源优先预下载](adr/0002-prefetch-web-sources.md) | 消除网页交互和播出时网络抖动 |
| [网站源适配器注册表](adr/0003-source-adapter-registry.md) | 隔离站点差异，保持 yt-dlp 与业务层稳定 |
| [原子 JSON 持久化](adr/0004-atomic-json-storage.md) | 符合家庭单机、小数据量和便携部署约束 |
| [频道与合集独立资产](adr/0008-channel-collection-assets.md) | 防止更新、误删和损坏导致编排资产不可恢复 |
| [最小共同遥控器按键](adr/0009-minimal-tv-remote-input.md) | 用四个方向键覆盖频道查看、切换和受控点播 |
| [电视首次配对](adr/0010-first-run-tv-pairing.md) | 让 Windows 静默启动也能安全设置用户自选密码 |
| [公网仅开放遥控平面](adr/0005-public-control-plane-only.md) | 不把未鉴权的电视与媒体平面暴露到互联网 |
| [播放异常先记录并跳过](adr/0006-skip-and-log-playback-issues.md) | 在完整恢复体系落地前避免节目无限卡住 |
| [本地媒体兼容转换](adr/0011-local-media-compatibility-fallback.md) | 在不改原文件的前提下支持浏览器不能直接解码的存量格式 |
| [同级双目录与确认式迁移](adr/0012-confirmed-sibling-data-layout.md) | 更新可替换程序而不碰数据，同时禁止静默搬动用户资产 |
| [本机电视确认的密码恢复](adr/0013-tv-confirmed-password-recovery.md) | 在无控制台的 kiosk 场景恢复控制权，同时阻止公网重置 |
| [可选 Chrome 与 mpv 播放前端](adr/0014-selectable-playback-frontends.md) | 保留现有 Web 电视端，同时让存量片库可用原生播放器直接解码 |
| [托管浏览器保持单实例](adr/0007-single-managed-browser-instance.md) | 避免维护窗口与 kiosk 并存造成双播 |

Node.js + Express + ws 继续作为单进程运行时；测试使用 Node 内置 `node:test`。若这些约束发生变化，应新增 ADR，而不是只修改本页结论。
