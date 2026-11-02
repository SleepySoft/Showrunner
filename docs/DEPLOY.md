# 全新 Windows 11 部署指南

目标：一台刚装好的 Win11 电脑（接着电视），从零到"开机即用的家庭电视台"。

| 视角 | 本文定位 |
|---|---|
| WHY | 让家庭电脑无需数据库和复杂运维即可可靠启动、恢复和迁移 |
| WHAT | 便携用户包、开发者安装、手动安装、公网反代与维护流程 |
| HOW | 根据路线 A/B/C 执行，并用检查清单验收 |
| ADR | [原子 JSON 持久化](adr/0004-atomic-json-storage.md) · [公网仅开放遥控平面](adr/0005-public-control-plane-only.md) |

## 两种分发模式

| | 开发者路线 | 用户路线（复制即用） |
|---|---|---|
| 拿到什么 | GitHub 仓库（纯代码 + 脚本，无二进制） | `showrunner-portable-*.zip`（~100MB，全内置） |
| 操作 | clone → `scripts\install.bat` | 解压 → 双击 `start.bat` |
| 需要联网 | 是（下载 Node/依赖/工具） | 完全离线可用 |
| 需要管理员 | 否（防火墙放行除外） | 否（防火墙放行除外） |

**用户包的内容**：代码 + 生产依赖（node_modules）+ 便携 Node.js（runtime\node）+ yt-dlp/ffmpeg（bin）。不含任何私有数据——长期密码由用户在电视配对流程中设置。打包含自动验证：解压到临时目录、只用包内文件启动、确认 /tv/ 和 /remote/ 可访问才算成功。

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

### 程序与数据目录

`D:\showrunner\` 默认把所有私有数据放到同级 `D:\showrunner-data\`，无需配置。代码目录可整体替换；数据目录保存 `config.json`、`data\`、`cache\`、`logs\` 和 `asset-vault\`。

旧版升级后第一次启动会暂停播放，电视显示六位迁移确认码。手机遥控器可选择“迁移并保留旧数据”、“使用现有同级数据”、“创建全新数据”或“暂不迁移并退出”。未输入正确确认码前不会搬动或写入旧数据；迁移完成后旧目录也不会自动删除。

需自定义时可传 `--data-dir D:\TVData` 或设置 `SHOWRUNNER_DATA_DIR`。

## 路线 B：开发者（GitHub 仓库）

1. `git clone` 仓库（纯代码 + 脚本；`bin/*.exe`、`runtime/`、`node_modules/` 均不入库）
2. 双击 `scripts\install.bat`，脚本自动完成：
   - 检测 Node.js；没有则从 nodejs.org 下载**便携版**到 `runtime\node\`（免安装、免管理员、不污染系统）
   - `npm install` 安装依赖（express + ws）
   - 下载 `bin\yt-dlp.exe` / `bin\ffmpeg.exe`
   - 尝试放行防火墙 TCP 7100（需管理员；失败会打印手动步骤）
3. 双击 `start.bat` 启动。电视会显示一次性配对码和手机地址；用手机打开该地址并设置长期密码（哈希保存在同级 `showrunner-data\config.json`）
4. （可选）双击 `scripts\autostart-on.bat` 注册开机自启——登录后无窗口后台运行
5. （可选）发布包已内置 mpv（`bin\mpv.exe`），开箱即可在“正在播放”页切换前端直放 NAS/MKV/HEVC；如需更换版本，将 `mpv.exe` 放到 `bin\`、加入 PATH，或在同级数据目录 `config.json` 配置 `mpvPath`

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

mpv 当前不由安装脚本下载，以避免未核定的发布源、许可和包体积策略。Chrome 仍是默认前端；用户安装 mpv 后可通过遥控器切换。

## 部署后检查清单

- [ ] 电视上显示 kiosk 全屏画面（待机页或播放页）
- [ ] 手机连同一 WiFi，打开 `http://电脑IP:7100/remote/` 能登录
- [ ] 贴一个 B 站链接进节目单，几分钟后条目出现 ✅ 已缓存
- [ ] 重启电脑一次，确认自启生效、队列和缓存原样恢复

## 公网远程编排（可选）

你有公网 IP + DDNS：路由器只映射 HTTPS 443 到 Caddy，不能直接映射应用的 7100。Caddy 采用白名单，仅放行 `/remote`、`/api`、`/ws-remote`，其余（尤其 `/tv`、`/media`、`/cache`、`/compatible`、`/ws-tv`、`/ws`）一律拒绝。完整配置见 README「公网访问」。

## 维护

| 场景 | 操作 |
|---|---|
| 网页片源突然全部下载失败 | 网站改版了，跑 `scripts\update-tools.bat` 升级 yt-dlp |
| 要临时操作这台电脑 | 遥控器 →「进入维护模式」，10 分钟无操作自动回锁 |
| 要长期释放这台电脑 | 遥控器 →「下线」；使用完再从手机点「重新上线」 |
| 修改密码 / 开关自启 | 遥控器「正在播放」页直接操作；改密会让其他设备重新登录 |
| 忘记密码 | 在家庭局域网中按电视显示的 IP 直接打开登录页 →「忘记密码」→ 输入电视一次性码；公网域名不允许恢复 |
| 换电脑迁移 | 同时拷走 `showrunner\` 和同级 `showrunner-data\`；不需要网页缓存时可不带数据目录中的 `cache\` |
| 取消自启 | `scripts\autostart-off.bat` |
| 停止整个服务 | `scripts\stop.bat`：按 PID 文件/监听端口精确定位本安装的服务进程并结束整棵进程树，同时清理受管的 mpv/Chrome 前端；不影响用户自己打开的浏览器或其他 node 程序 |

## Windows 远程终端

Windows 也可以像 Linux 一样使用 SSH。首次需要通过本机或远程桌面打开“管理员 PowerShell”，按 Microsoft 的 [OpenSSH Server 指南](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse?pivots=windows-11&tabs=powershell)执行：

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic

# 安装通常会自动创建规则；没有时只向本地子网开放 22 端口
if (-not (Get-NetFirewallRule -Name OpenSSH-Server-In-TCP -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name OpenSSH-Server-In-TCP -DisplayName 'OpenSSH Server (sshd)' `
    -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -RemoteAddress LocalSubnet
}
```

另一台机器随后可运行：

```powershell
ssh Windows用户名@电脑IP
```

建议后续配置 SSH 公钥，并在 `%ProgramData%\ssh\sshd_config` 用 `AllowUsers` 限定维护账号。远程桌面适合首次安装和图形问题；SSH 适合更新、看日志、重启服务；SMB 只用于受控文件传输，不应承担进程管理。

## 卸载

卸载或删除程序目录前，先在遥控器“频道”页下载一次“备份资产”。用户数据位于程序同级的 `showrunner-data\`，删除程序目录不会自动删它；但它仍不替代异机备份。

1. `scripts\autostart-off.bat` 取消自启
2. （可选）`netsh advfirewall firewall delete rule name=Showrunner` 删防火墙规则
3. 删除程序文件夹；如需彻底清除用户资产，再单独删除同级 `showrunner-data\`
