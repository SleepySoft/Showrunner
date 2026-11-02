# 调试指南

## WHY

正式模式会托管唯一 kiosk 浏览器、使用真实频道资产并可能执行下载、调度和开机启动操作。这些行为适合无人值守播放，不适合开发：DevTools 不易打开，一次测试也不应污染正式频道或安装目录外的资产保险库。

因此调试入口必须同时满足：不用 kiosk、普通浏览器可开 DevTools、数据完全隔离、系统操作无副作用、启动命令足够短。

## WHAT

`scripts/dev.js` 提供独立开发配置：

| 项目 | 开发模式 |
|---|---|
| 地址 | 仅 `127.0.0.1:7101` |
| 浏览器托管 | 按需窗口化托管，绝不使用 kiosk 全屏 |
| 电视页交互 | 注入非托管标记：不隐藏光标，不拦截右键/双击，左上角显示 DEV 标识 |
| 播放前端 | 看门狗默认关闭（不自动拉起）；在遥控器「播放前端」里手动打开/关闭，或开「自动拉起」 |
| 数据、配置、缓存、日志 | 全部放在 `.dev/` |
| 资产保险库 | `.dev/assets/`，不接触正式的同级数据目录 |
| 默认密码 | `showrunner-dev` |
| 网页视频下载 | 默认关闭 |
| Windows 开机启动 | 注入无副作用实现，页面中隐藏 |
| 更新源 | 关闭 |

`.dev/` 已加入 Git 忽略。删除它可以重置调试环境，不会影响程序同级正式数据目录中的配置、状态或频道资产。

## HOW

### 1. 日常前后端联调

```powershell
npm run dev
```

该命令使用 Node watch 模式；服务端模块变化后自动重启。静态 HTML 不需要重启，刷新页面即可：

- 遥控器：`http://127.0.0.1:7101/remote/`
- 电视端：`http://127.0.0.1:7101/tv/`
- 默认密码：`showrunner-dev`

建议用两个普通 Chrome 窗口同时打开遥控器和电视端。两边都可按 `F12`：

- Network → Fetch/XHR：检查 REST 请求、状态码和响应。
- Network → WS：分别检查 `/ws-remote` 与 `/ws-tv` 消息。
- Console：查看前端异常、媒体播放拒绝和按键事件。
- Application → Cookies：确认 `sr_session` 是 HttpOnly 会话。

电视端直接按键盘 `↑/↓/←/→` 即可模拟电脑遥控器，不需要进入 kiosk。

开发模式下服务端会给 `/tv` 页面注入 `__SHOWRUNNER_UNMANAGED__` 标记：页面不再隐藏鼠标光标，右键菜单和双击恢复为普通浏览器行为（右键检查、双击全屏都可用），左上角常驻 DEV 标识提示当前是非 kiosk 调试画面。kiosk 模式不会注入该标记，锁定行为不变。

### 2. 服务端断点

```powershell
npm run dev:inspect
```

然后用 VS Code “Attach to Node Process”，或 Chrome 打开 `chrome://inspect` 连接。可在 API 路由、队列推进、合集解析、调度与 WebSocket 消息处理处下断点。

只需要运行一次、不监听代码变化时：

```powershell
npm run dev:once
```

### 3. 调试配置

PowerShell 中可在启动前设置：

```powershell
$env:SHOWRUNNER_DEV_PORT = '7201'
$env:SHOWRUNNER_DEV_PASSWORD = 'my-debug-password'
$env:SHOWRUNNER_DEV_MEDIA = 'D:\影片;E:\动画'
$env:SHOWRUNNER_DEV_CACHE = '1'   # 仅在确实要调试 yt-dlp/缓存时开启
npm run dev
```

调试播放前端（mpv 的 OSD 菜单、IPC 同步，或 Chrome 前端的窗口化效果）时，直接在遥控器「设置 → 播放前端」操作：

- **自动拉起**：看门狗开关。开启后崩溃自动重拉、服务重启自动开播；关闭后前端保持关闭。
- **打开 / 关闭**：手动开关所选前端（一次性）。「关闭」会同时停用自动拉起；开发模式下前端一律窗口化（最大化普通窗口，mpv 无 `--fullscreen`，Chrome 无 kiosk），可自由操作。

所有前端（mpv 进程、Chrome 窗口）都由服务端统一管理，任一时刻要么全关、要么只有一个在跑。开发模式下「维护模式/下线」行隐藏（那是 kiosk 全屏场景的功能）。

调试页内修改密码后，哈希保存在 `.dev/config.json`，下次仍有效。环境变量密码优先，适合临时覆盖。

### 4. 测试定位

```powershell
npm test
npm run test:watch
node --test test/playlists.test.js
node --test --test-name-pattern="首次运行" test/password-api.test.js
```

状态机、持久化、鉴权和 WebSocket 问题优先写或缩小自动测试；浏览器布局、媒体策略和遥控器手感再用普通 Chrome 人工验证。

真实网站下载全链路单独运行：

```powershell
npm run smoke
```

它会访问真实网站并下载媒体，不应混入日常快速调试。

### 5. 正式环境诊断

正式机器只复现正式环境特有问题时，先从手机进入“维护模式”，不要手工再开第二个浏览器：

- 更新日志：`<data-dir>/logs/update.log`
- 播放异常记录：`<data-dir>/logs/playback-events.log`
- 浏览器托管/单实例问题：维护模式中打开任务管理器并检查专用 profile 进程

修复应先在 `.dev/` 和自动测试中验证，再回正式模式验收。

## ADR

开发模式没有改变生产架构：服务端仍是播放权威，电视与遥控器信任边界不变。它只是为这些边界提供无副作用的观察入口。相关决定见 [ADR-0001](adr/0001-server-authoritative-playback.md)、[ADR-0007](adr/0007-single-managed-browser-instance.md) 与 [ADR-0008](adr/0008-channel-collection-assets.md)。
