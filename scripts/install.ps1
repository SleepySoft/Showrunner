# Showrunner 全新 Windows 11 一键部署
# 用法：右键 install.bat「以管理员身份运行」或普通双击均可（全程不需要管理员权限，
#       只有最后写防火墙放行规则时需要，失败会提示手动操作）。
# 参数：-SkipFirewall 跳过防火墙规则（测试用）
param([switch]$SkipFirewall)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($n, $msg) { Write-Host ""; Write-Host "[$n] $msg" -ForegroundColor Cyan }

# ---------- 1. Node.js 运行时 ----------
Step 1 '检查 Node.js 运行时'
$nodeExe = $null
$portableNode = Join-Path $root 'runtime\node\node.exe'

if (Get-Command node -ErrorAction SilentlyContinue) {
    $nodeExe = 'node'
    Write-Host "    系统已安装 Node.js: $((& node --version))"
} elseif (Test-Path $portableNode) {
    $nodeExe = $portableNode
    Write-Host "    使用便携版 Node.js: $((& $nodeExe --version))"
} else {
    Write-Host '    未检测到 Node.js，下载便携版（约 30MB，免安装免管理员）…'
    # 从官方 dist 索引取最新 LTS
    $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
    $lts = $index | Where-Object { $_.lts } | Select-Object -First 1
    $ver = $lts.version
    Write-Host "    选定 LTS 版本: $ver"
    $zip = Join-Path $env:TEMP "node-$ver-win-x64.zip"
    Invoke-WebRequest "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip" -OutFile $zip
    $stage = Join-Path $env:TEMP "node-$ver-extract"
    Expand-Archive $zip -DestinationPath $stage -Force
    New-Item -ItemType Directory -Force -Path (Join-Path $root 'runtime') | Out-Null
    Move-Item (Join-Path $stage "node-$ver-win-x64") (Join-Path $root 'runtime\node') -Force
    Remove-Item $zip, $stage -Recurse -Force -ErrorAction SilentlyContinue
    $nodeExe = $portableNode
    Write-Host "    便携版已就位: $((& $nodeExe --version))"
}
$npmCmd = if ($nodeExe -eq 'node') { 'npm' } else { Join-Path $root 'runtime\node\npm.cmd' }

# ---------- 2. npm 依赖 ----------
Step 2 '安装 npm 依赖（express + ws，约 10MB）'
& $npmCmd install --omit=dev --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { throw 'npm install 失败' }

# ---------- 3. yt-dlp / ffmpeg ----------
Step 3 '检查 yt-dlp 与 ffmpeg（网页片源下载引擎）'
$ytdlp = Join-Path $root 'bin\yt-dlp.exe'
$ffmpeg = Join-Path $root 'bin\ffmpeg.exe'

if (-not (Test-Path $ytdlp)) {
    Write-Host '    下载 yt-dlp…'
    New-Item -ItemType Directory -Force -Path (Join-Path $root 'bin') | Out-Null
    Invoke-WebRequest 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile $ytdlp
}
Write-Host "    yt-dlp: $((& $ytdlp --version))"

if (-not (Test-Path $ffmpeg)) {
    Write-Host '    下载 ffmpeg 静态构建（约 110MB，只需一次）…'
    $fz = Join-Path $env:TEMP 'ffmpeg-release.zip'
    Invoke-WebRequest 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile $fz
    $fstage = Join-Path $env:TEMP 'ffmpeg-extract'
    Expand-Archive $fz -DestinationPath $fstage -Force
    $found = Get-ChildItem $fstage -Recurse -Filter ffmpeg.exe | Select-Object -First 1
    Copy-Item $found.FullName $ffmpeg
    Remove-Item $fz, $fstage -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "    ffmpeg: $((& $ffmpeg -version | Select-Object -First 1))"

# ---------- 4. 首次配置 ----------
Step 4 '初始化配置'
$dataDir = Join-Path $root 'data'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
# 密码由电视端首次配对设置，这里只确保数据目录存在
Write-Host '    data\ 目录就绪（首次启动时在电视画面完成密码配对）'

# ---------- 5. 防火墙放行（可选，需管理员）----------
Step 5 '防火墙放行局域网访问（TCP 7100）'
if ($SkipFirewall) {
    Write-Host '    （按参数跳过）'
} else {
    $existing = netsh advfirewall firewall show rule name='Showrunner' 2>$null
    if ($LASTEXITCODE -eq 0 -and "$existing" -match 'Showrunner') {
        Write-Host '    规则已存在，跳过'
    } else {
        netsh advfirewall firewall add rule name='Showrunner' dir=in action=allow protocol=TCP localport=7100 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host '    已放行 TCP 7100（手机同局域网可访问遥控器）'
        } else {
            Write-Host '    [!] 写入防火墙规则需要管理员权限。请右键 install.bat「以管理员身份运行」一次，' -ForegroundColor Yellow
            Write-Host '        或手动：控制面板 → Windows Defender 防火墙 → 高级设置 → 入站规则 → 新建规则 → 端口 TCP 7100' -ForegroundColor Yellow
        }
    }
}

# ---------- 完成 ----------
Step '√' '部署完成'
Write-Host @"

  启动方式：
    手动启动   双击 start.bat
    开机自启   双击 scripts\autostart-on.bat（注册后登录即自动后台运行）
    取消自启   双击 scripts\autostart-off.bat

  首次启动后：
    电视端    http://localhost:7100/tv/   （服务端会自动拉起 kiosk 全屏）
    遥控器    http://本机IP:7100/remote/  （首次运行按电视画面提示设置密码）

  工具更新：yt-dlp 官网更新频繁，网站改版导致下载失败时运行 scripts\update-tools.bat
"@ -ForegroundColor Green
