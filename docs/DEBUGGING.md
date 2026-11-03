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
| 电视页交互 | 注入非托管标记：不隐藏光标，左上角显示 DEV 标识；右键/双击仍被接管（遥控器菜单键等效右键），Shift+右键/双击为浏览器原生行为 |
| 播放前端 | 看门狗默认关闭（不自动拉起）；在遥控器「播放前端」里手动打开/关闭，或开「自动拉起」 |
| 数据、配置、缓存、日志 | 全部放在 `.dev/`；例外见下方「使用正式数据调试」 |
| 资产保险库 | `.dev/assets/`，不接触正式的同级数据目录 |
| 默认密码 | `showrunner-dev` |
| 网页视频下载 | 默认关闭 |
| Windows 开机启动 | 注入无副作用实现，页面中隐藏 |
| 更新源 | 关闭 |

`.dev/` 已加入 Git 忽略。删除它可以重置调试环境，不会影响程序同级正式数据目录中的配置、状态或频道资产。

### 使用正式数据调试

默认开发模式读写的是 `.dev/` 里的隔离数据（基本为空）。若要在开发模式下调试真实频道/合集（例如验证播放前端的实际效果），在 `.dev/config.json` 中加一行显式开关：

```json
{ "useProductionData": true }
```

开启后 dev 直接读写与正式入口相同的同级 `showrunner-data` 目录（`data/showrunner.json`、资产保险库、缓存、日志，布局与正式一致），启动时控制台会给出醒目警告。注意：

- 调试改动（建删频道、改设置、播放进度、看门狗开关等）都会**写入正式数据**；
- 不要与正式实例（`npm start` / 开机启动）同时运行，两个进程写同一份数据文件会互相覆盖；
- 正式数据目录不存在时启动会直接报错，而不会悄悄新建一份。

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

开发模式下服务端会给 `/tv` 页面注入 `__SHOWRUNNER_UNMANAGED__` 标记：页面不再隐藏鼠标光标，左上角常驻 DEV 标识提示当前是非 kiosk 调试画面。kiosk 模式不会注入该标记，锁定行为不变。注意右键/双击仍被页面接管（物理遥控器的菜单键在系统层常被当作鼠标右键，不接管会同时弹出 Chrome 原生菜单）；调试时用 **Shift+右键** 打开浏览器原生菜单、Shift+双击触发全屏。

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

### mpv 无声排查

mpv 前端排查“画面正常但无声”（Chrome 有声、mpv 无声）按顺序查：

1. **mpv 日志**：遥控器「日志」页底部直接显示 mpv 日志尾部（音频初始化失败只写在这里），
   文件在数据目录 `logs/mpv.log`。mpv 以 `--no-config` 启动，用户 profile 里的
   mpv.conf（如 `volume=0`、静音）不会生效；--input-conf 传入的遥控器按键绑定仍然加载。
2. **按应用静音**：Windows 音量合成器会记住 mpv 的静音状态并跨重启保留，mpv 连接 IPC 后
   会主动解除静音；若仍无声，打开音量合成器确认 mpv 列没有被静音/调零。
3. **音频输出未启动**：若文件有音轨但系统音频设备当时不可用（电视未开、设备被独占），
   mpv 会无声地放完整段画面。Showrunner 每 10 秒检查一次（mpv 0.41 的 `ao` 属性
   输出正常也是空数组，必须用 `current-ao` 判断），连续两次确认后记录
   「mpv 音频输出未启动」事件并自动重启一次 mpv 重试音频设备初始化（同一节目只重启一次）。

### 音量均衡（响度归一）

mpv 前端默认开启 EBU R128 响度归一（`--af=loudnorm`），大小声源自动拉到统一响度，
遥控器「播放前端」行的「音量均衡」复选框可开关（仅 mpv 支持，Chrome 前端不生效）。
切换会重启 mpv（播放中断几秒）并持久化到机器级配置 `volumeNormalize`。

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
