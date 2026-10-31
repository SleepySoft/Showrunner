# 全新 Windows 11 部署指南

目标：一台刚装好的 Win11 电脑（接着电视），从零到"开机即用的家庭电视台"。

## 两种分发模式

| | 开发者路线 | 用户路线（复制即用） |
|---|---|---|
| 拿到什么 | GitHub 仓库（纯代码 + 脚本，无二进制） | `showrunner-portable-*.zip`（~100MB，全内置） |
| 操作 | clone → `scripts\install.bat` | 解压 → 双击 `start.bat` |
| 需要联网 | 是（下载 Node/依赖/工具） | 完全离线可用 |
| 需要管理员 | 否（防火墙放行除外） | 否（防火墙放行除外） |

**用户包的内容**：代码 + 生产依赖（node_modules）+ 便携 Node.js（runtime\node）+ yt-dlp/ffmpeg（bin）。不含任何私有数据——密码在首次启动时自动生成。打包含自动验证：解压到临时目录、只用包内文件启动、确认 /tv/ 和 /remote/ 可访问才算成功。

**维护者打新包**：`scripts\package.bat` → 产物在 `dist\`。

## 依赖全景（为什么"庞大"其实可控）

| 组件 | 体积 | 用户包 | 开发者仓库 |
|---|---|---|---|
| 项目本体（代码 + npm 依赖） | ~10 MB | 已内置 | clone + `npm install`（自动） |
| Node.js 运行时 | ~30 MB | 已内置便携版 | 系统已有则用，否则脚本自动下便携版 |
| bin/yt-dlp.exe | 23 MB | 已内置 | 脚本自动下载 |
| bin/ffmpeg.exe | 105 MB | 已内置 | 脚本自动下载 |

不需要 Python、Docker、Visual C++ 运行库（两个 exe 都是静态编译）。

## 路线 A：用户包（推荐，复制即用）

拿到 `showrunner-portable-*.zip` 后：解压到任意位置（如 `D:\showrunner`）→ 双击 `start.bat` → 完成。可选 `scripts\autostart-on.bat` 注册开机自启。全程离线可用、无需管理员、无需安装任何东西。

唯一需要管理员的是防火墙放行（手机访问不了时才需要）：右键 `scripts\install.bat` 以管理员身份运行一次即可，或按脚本提示手动加入站规则。

## 路线 B：开发者（GitHub 仓库）

1. `git clone` 仓库（纯代码 + 脚本；`bin/*.exe`、`runtime/`、`node_modules/` 均不入库）
2. 双击 `scripts\install.bat`，脚本自动完成：
   - 检测 Node.js；没有则从 nodejs.org 下载**便携版**到 `runtime\node\`（免安装、免管理员、不污染系统）
   - `npm install` 安装依赖（express + ws）
   - 下载 `bin\yt-dlp.exe` / `bin\ffmpeg.exe`
   - 尝试放行防火墙 TCP 7100（需管理员；失败会打印手动步骤）
3. 双击 `start.bat` 启动。首次启动打印遥控器密码（也写入 `config.json`）
4. （可选）双击 `scripts\autostart-on.bat` 注册开机自启——登录后无窗口后台运行，日志在 `data\server.log`

## 路线 C：手动逐条（脚本不可用时）

```powershell
# 1. 装 Node.js（三选一）
winget install OpenJS.NodeJS.LTS          # 商店安装（推荐）
# 或去 https://nodejs.org 下载 LTS 安装包
# 或下载 node-vXX-win-x64.zip 解压到项目 runtime\node\

# 2. 装依赖
cd D:\showrunner
npm install --omit=dev

# 3. 启动
node src\server.js
```

yt-dlp / ffmpeg 已在 `bin\` 里；若丢失，重新运行 `install.bat` 会自动补齐。

## 部署后检查清单

- [ ] 电视上显示 kiosk 全屏画面（待机页或播放页）
- [ ] 手机连同一 WiFi，打开 `http://电脑IP:7100/remote/` 能登录
- [ ] 贴一个 B 站链接进节目单，几分钟后条目出现 ✅ 已缓存
- [ ] 重启电脑一次，确认自启生效、队列和缓存原样恢复

## 公网远程编排（可选）

你有公网 IP + DDNS：用 Caddy 反代，只暴露 `/remote` 和 `/api`，屏蔽 `/tv` `/media` `/cache`（示例见 README「公网访问」）。手机在外也能编排节目单、预下载缓存。

## 维护

| 场景 | 操作 |
|---|---|
| 网页片源突然全部下载失败 | 网站改版了，跑 `scripts\update-tools.bat` 升级 yt-dlp |
| 要临时操作这台电脑 | 遥控器 →「进入维护模式」，10 分钟无操作自动回锁 |
| 换电脑迁移 | 整个文件夹拷走即可（`data\` 里有节目单和进度，`cache\` 可不带） |
| 取消自启 | `scripts\autostart-off.bat` |

## 卸载

1. `scripts\autostart-off.bat` 取消自启
2. （可选）`netsh advfirewall firewall delete rule name=Showrunner` 删防火墙规则
3. 删除整个项目文件夹——系统里没有留下任何东西（便携 Node 也在文件夹内）
