# Showrunner 自更新器（由服务端派生，或经 update.bat 手动触发）
# 流程：等旧进程退出 → 解压新包 → 只覆盖安装目录 → 重启
# 注意：本脚本总是从「数据目录里的副本」执行，因此可以安全覆盖安装目录中的自己。
param(
    [int]$WaitPid = 0,          # 服务端派生时传入：等这个 PID 退出
    [string]$InstallDir,        # 安装根目录
    [string]$DataDir,           # 同级用户数据目录
    [string]$PackageZip,        # 已下载的 zip；不给则按 -Repo 自行下载
    [string]$Repo,              # GitHub "owner/repo"（手动模式下载用）
    [int]$Port = 7100           # 手动模式：按端口找到并停止正在运行的服务端
)
$ErrorActionPreference = 'Stop'
if (-not $DataDir) {
    $parent = Split-Path -Parent $InstallDir
    $leaf = Split-Path -Leaf $InstallDir
    $DataDir = Join-Path $parent "$leaf-data"
}
$logFile = Join-Path $DataDir 'logs\update.log'
function Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Add-Content -Path $logFile -Value $line -Encoding UTF8
}

try {
    New-Item -ItemType Directory -Force -Path (Split-Path $logFile) | Out-Null
    Log "==== 开始更新（安装目录 $InstallDir） ===="

    # ---------- 1. 停止旧实例 ----------
    if ($WaitPid -gt 0) {
        Log "等待服务端进程 $WaitPid 退出…"
        for ($i = 0; $i -lt 60; $i++) {
            if (-not (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue)) { break }
            Start-Sleep -Milliseconds 500
        }
    } else {
        # 手动模式：按端口找进程并停止（含其拉起的 kiosk 浏览器，由独立 user-data-dir 识别）
        $conn = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($conn) {
            Log "停止占用端口 $Port 的进程 $($conn.OwningProcess)"
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
            Start-Sleep 2
        }
    }
    # 受控浏览器不一定随服务端退出；只按 Showrunner 专用 profile 标记清理。
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and $_.CommandLine -match 'showrunner-(kiosk|maintenance)-profile' } |
        ForEach-Object { Log "关闭受控浏览器 $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

    # 更新前再留一份不可变快照。正常运行还会维护可移植资产历史，这里保护整个实时状态。
    $stateFile = Join-Path $DataDir 'data\showrunner.json'
    if (Test-Path -LiteralPath $stateFile) {
        $preUpdateDir = Join-Path $DataDir 'backups\pre-update'
        New-Item -ItemType Directory -Force -Path $preUpdateDir | Out-Null
        $preUpdateFile = Join-Path $preUpdateDir ("showrunner-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
        Copy-Item -LiteralPath $stateFile -Destination $preUpdateFile
        Log "更新前状态已备份：$preUpdateFile"
    }

    # ---------- 2. 获取新包 ----------
    if (-not $PackageZip) {
        if (-not $Repo) { throw '未提供 -PackageZip 且未提供 -Repo，无法取得更新包' }
        Log "查询 $Repo 最新 Release…"
        $release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'showrunner-updater' }
        $asset = $release.assets | Where-Object { $_.name -match '^showrunner-portable-.*\.zip$' } | Select-Object -First 1
        if (-not $asset) { $asset = $release.assets | Where-Object { $_.name -like '*.zip' } | Select-Object -First 1 }
        if (-not $asset) { throw '最新 Release 里没有 zip 分发包' }
        $PackageZip = Join-Path $DataDir $asset.name
        Log "下载 $($asset.name)（$([math]::Round($asset.size/1MB,1)) MB）…"
        Invoke-WebRequest $asset.browser_download_url -OutFile $PackageZip
    }
    Log "使用更新包：$PackageZip"

    # ---------- 3. 解压并覆盖（保留数据） ----------
    $stage = Join-Path $env:TEMP "showrunner-update-$PID"
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive $PackageZip -DestinationPath $stage
    Log '解压完成，开始覆盖文件…'

    # 包内根即文件本体；排除数据/缓存/配置/日志/待更新包
    $xd = @('data', 'cache', '.git', 'dist', '.smoke-tmp')
    $xf = @('config.json', '*.log', 'update-pending.zip')
    $rc = robocopy $stage $InstallDir /E /NFL /NDL /NJH /NP /XD $xd /XF $xf
    if ($LASTEXITCODE -ge 8) { throw "robocopy 失败（退出码 $LASTEXITCODE）" }
    Log "文件覆盖完成（robocopy 退出码 $LASTEXITCODE）"
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $PackageZip -Force -ErrorAction SilentlyContinue

    # ---------- 4. 重启 ----------
    $node = Join-Path $InstallDir 'runtime\node\node.exe'
    Log "后台静默重启 $node（不依赖 VBS/WScript）…"
    Start-Process $node -ArgumentList 'src\server.js' -WorkingDirectory $InstallDir -WindowStyle Hidden
    Log '==== 更新完成 ===='
} catch {
    Log "！！更新失败：$_"
    # 失败也要把旧实例拉回来，电视不能黑着
    $node = Join-Path $InstallDir 'runtime\node\node.exe'
    if (Test-Path $node) { Start-Process $node -ArgumentList 'src\server.js' -WorkingDirectory $InstallDir -WindowStyle Hidden }
    exit 1
}
