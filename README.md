# Showrunner 放映员

> 手机编排节目单，电视只负责播——把"放什么看什么"的电视台体验带回家。

## 这是什么

Showrunner 是一个家庭点播系统，核心设计是**服务器权威队列**：

- **手机（家长）**：唯一的编排入口。浏览电脑里的媒体库、添加/排序/删除节目、控制播放。
- **电视（孩子）**：一台"哑终端"。全屏播放，没有片单、没有推荐、不响应任何键鼠操作，播完自动下一部，全部播完进入待机画面。

电视端没有任何可选择的东西，因此不存在"防破解"问题——就像小时候的电视机，放什么，看什么。

## 快速开始

### 环境要求

- Node.js ≥ 18（开发于 Node 24）
- 一台接着电视的电脑（Windows / macOS / Linux 均可）

### 安装与启动

```bash
npm install
npm start
```

> **两种分发方式**：开发者 `git clone`（纯代码，无二进制）→ `scripts\install.bat` 自动补齐环境；用户直接用打包好的 `showrunner-portable-*.zip`（含便携 Node + 全部工具），解压双击 `start.bat` 即用。打新包：`scripts\package.bat`（含自启动验证）。详见 [docs/DEPLOY.md](docs/DEPLOY.md)。

首次启动会自动生成遥控器密码并写入 `config.json`，同时打印在控制台：

```
  Showrunner 放映员已启动
  电视播放端:  http://localhost:7100/tv/
  手机遥控器:  http://本机IP:7100/remote/
  首次运行，已生成遥控器密码: xxxxxxxx  （已写入 config.json）
```

### 配置媒体库

不需要改任何配置文件——全部在遥控器网页上完成：

1. 手机打开遥控器 → 「片库」页 → 「＋ 添加目录」
2. 在弹出的目录浏览器里逐层进入影片所在文件夹，点「选择此目录」
3. 片库立即列出该目录（含子目录）里的全部影片

目录会持久化保存，重启不丢；随时可移除（不删磁盘文件）。也可以用 `config.json` 的 `mediaDirs` 或 `--media` 参数预置目录，两者会合并。

### 添加网页片源

节目单编辑里点「＋ 添加节目」→「贴链接」，粘贴 B 站 / 优酷 / YouTube 链接——服务端自动抓标题入列，并**在后台用 yt-dlp 提前下载到本地缓存**（`cache/<站点>/<标题>-<内容ID>.mp4`）。轮到播放时电视直接播缓存文件：零广告、零卡顿、零网页逻辑。遥控器上每个网页条目都有缓存徽标（⏳ 缓存中 xx% / ✅ 已缓存 / ⚠️ 失败可重试）；播出队列变化时会自动预取当前 + 后续 2 个网页条目。

缓存相关配置（`config.json`）：

| 键 | 说明 |
|---|---|
| `ytdlpPath` | yt-dlp 路径（默认自动查找 PATH，内置 `bin/yt-dlp.exe` 兜底） |
| `cookiesFromBrowser` | 下载需要登录的站点时借用浏览器登录态，如 `"chrome"`、`"edge"` |
| `cacheMaxGB` | 缓存容量上限（默认 20 GB），超出后自动淘汰最久未播的 |

未安装 yt-dlp 时网页条目会在电视端提示"缓存失败"并自动跳过，不影响本地片播放。项目已内置 ffmpeg：B 站等音视频分离的站点会自动合并成完整 mp4（没有 ffmpeg 时自动退回单文件格式，此类站点会失败）。

### 日常使用

1. **电视端**：无需手动操作——服务端启动后自动拉起 kiosk Chrome（全屏锁定，输出到电视），崩溃或被关闭会自动重拉。
2. **手机端**：手机与电脑同一局域网，浏览器打开 `http://电脑IP:7100/remote/`，输入密码。建议"添加到主屏幕"，体验等同 App。
3. **节目单**：「节目单」页 →「＋」新建节目单（如"周末纪录片之夜"）→「＋ 添加节目」贴链接或从片库挑选、排序 → 点「播出」让它成为当前节目单。节目单可建多个、随时复用切换。
4. 播出中的节目单里，每个条目旁的 ▶ 可以直接点播跳转；当前正在播的条目有"播放中"标记。

### 维护模式

需要临时操作电视那台电脑时（装软件、扫码续期、调系统设置），在遥控器「正在播放」页点「进入维护模式」：

- kiosk 锁定画面被关闭，系统默认浏览器打开一个普通窗口
- **约 10 分钟无操作自动回锁**，kiosk 重新拉起；也可随时点「立即回锁」
- kiosk 使用独立浏览器配置，杀掉它不会误伤你自己开着的 Chrome/Edge 窗口

相关配置（`config.json`）：`"manageBrowser": false` 关闭浏览器托管；`"chromePath": "..."` 指定浏览器路径。

~~电视端全屏 kiosk 手动启动~~（已由服务端自动托管，见上文"维护模式"）。

## 命令行参数

`npm start -- --port 8080 --host 0.0.0.0 --media D:\影片 --password xxx`

| 参数 | 说明 |
|---|---|
| `--port` / `--host` | 监听地址（默认 7100 / 0.0.0.0） |
| `--media <dir>` | 追加一个媒体目录（可多次） |
| `--data <file>` | 数据文件位置 |
| `--password` | 遥控器密码（也可用环境变量 `SHOWRUNNER_PASSWORD`） |

优先级：命令行 > 环境变量 > config.json > 默认值。

## 公网访问（可选）

你有公网 IP + DDNS 时，用 Caddy 反向代理即可让手机在外编排：

```caddyfile
tv.example.com {
    reverse_proxy 127.0.0.1:7100
}
```

**安全红线**：公网只暴露 `/remote` 和 `/api`（有密码鉴权）；`/tv`、`/media`、`/cache` 仅限局域网。用 Caddy 可按路径限制：

```caddyfile
tv.example.com {
    @blocked path /tv/* /media/* /cache/*
    respond @blocked 403
    reverse_proxy 127.0.0.1:7100
}
```

## 项目结构

```
showrunner/
├── src/
│   ├── server.js      # 入口：装配 + 启动
│   ├── config.js      # 配置加载（文件/环境变量/命令行）
│   ├── queue.js       # 队列状态机 —— 播出行为的唯一权威
│   ├── playlists.js   # 节目单管理（多单/复用/择一播出）
│   ├── library.js     # 媒体库扫描，稳定 ID
│   ├── browse.js      # 文件系统浏览（网页选目录）
│   ├── webtitle.js    # 网页片源标题解析（剥 SEO 后缀）
│   ├── ytdlp.js       # yt-dlp 封装：查信息 / 下载 / 进度解析
│   ├── cache.js       # 网页片源缓存：规范命名 / 索引 / LRU / 预取
│   ├── store.js       # JSON 原子持久化
│   ├── auth.js        # 密码登录 / 会话
│   ├── ws.js          # WebSocket：状态推送 + 电视上报
│   └── routes/
│       ├── api.js     # 遥控器 REST API
│       └── media.js   # 视频流（Range）：本地媒体 + 网页缓存
├── public/
│   ├── remote/        # 手机遥控器（PWA 友好的移动页）
│   └── tv/            # 电视播放端（只读、锁输入）
├── bin/
│   ├── yt-dlp.exe     # 内置 yt-dlp（网页片源下载，不入库，install 自动下载）
│   └── ffmpeg.exe     # 内置 ffmpeg（音视频合并，不入库，install 自动下载）
├── scripts/           # 部署脚本：install / package / autostart / update-tools
├── test/              # 100+ 个测试：单元 + 端到端
└── docs/              # 架构 / API / 测试 / 部署文档
```

## 路线图

- [x] P0 本地媒体：队列 + 流式 + 遥控 + 电视端
- [x] P1 网页片源：yt-dlp 预下载缓存（B 站、YouTube 等），电视端播缓存文件
- [ ] P2 kiosk Chrome 兜底引擎 + 页面净化注入（优酷等 DRM 站点）
- [ ] P3 频道模式（时刻表播出）、每日时长上限、观看时段限制、登录态维护（扫码续期）

详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
