# Showrunner 停止脚本：退出整个服务——Node 服务进程 + 受管的 mpv/Chrome 前端。
# 定位顺序：PID 文件（服务启动时写入）→ 监听端口 → node 进程树兜底；
# 前端按命令行特征（showrunner-mpv / showrunner-*-profile）兜底清理，
# 不影响用户自己打开的 mpv 或日常 Chrome。
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$root = Split-Path -Parent $PSScriptRoot
# 与 src/storage-layout.js 的 defaultDataDir 同一解析规则
$dataDir = if ($env:SHOWRUNNER_DATA_DIR) { $env:SHOWRUNNER_DATA_DIR } else {
    Join-Path (Split-Path -Parent $root) ((Split-Path -Leaf $root) + '-data')
}

$targets = [ordered]@{}

function Add-Target($id, $why) {
    if (-not $id) { return }
    $key = [string][int]$id
    if ([int]$key -gt 0 -and [int]$key -ne $PID -and -not $targets.Contains($key)) { $targets[$key] = $why }
}

# 1) PID 文件：服务启动时写入 <dataDir>\run\showrunner.pid
$pidFile = Join-Path $dataDir 'run\showrunner.pid'
if (Test-Path $pidFile) {
    $raw = (Get-Content $pidFile -Raw).Trim()
    if ($raw -match '^\d+$') {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId = $raw"
        if ($p -and $p.Name -match '^node' -and $p.CommandLine -match 'server\.js') {
            Add-Target $raw 'PID 文件'
        }
    }
}

# 2) 监听端口：config.json 的 port（缺省 7100；开发实例走 PID 文件即可）
$port = 7100
$cfgPath = Join-Path $dataDir 'config.json'
if (Test-Path $cfgPath) {
    try {
        $configured = (Get-Content $cfgPath -Raw | ConvertFrom-Json).port
        if ($configured -ge 1 -and $configured -le 65535) { $port = $configured }
    } catch {}
}
Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    Add-Target $_.OwningProcess "端口 $port"
}

# 3) 兜底：命令行含本安装目录绝对路径的 node 服务进程。
#    注意不能按 "server.js" 全局匹配——会误杀其他项目乃至本仓库的开发实例；
#    相对路径启动（start.bat / npm run dev）的实例由 PID 文件与端口覆盖。
$rootPattern = '*' + $root + '*'
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine -like $rootPattern
} | ForEach-Object { Add-Target $_.ProcessId '进程树' }

if ($targets.Count -eq 0) {
    Write-Host 'Showrunner 服务未在运行。'
} else {
    foreach ($id in $targets.Keys) {
        & taskkill.exe /PID $id /T /F 2>$null | Out-Null
        Write-Host ("已停止 Showrunner（PID {0}，{1}）" -f $id, $targets[$id])
    }
}

# 4) 受管前端兜底清理（/T 树杀通常已覆盖；漏网的 detached 进程按特征补刀）
$mpvKilled = 0
Get-CimInstance Win32_Process -Filter "Name = 'mpv.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine -like '*showrunner-mpv*'
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $mpvKilled++ }
$chromeKilled = 0
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object {
    $_.CommandLine -and ($_.CommandLine -like '*showrunner-kiosk-profile*' -or $_.CommandLine -like '*showrunner-maintenance-profile*')
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $chromeKilled++ }
if ($mpvKilled -or $chromeKilled) {
    Write-Host ("已清理受管前端：mpv × {0}，Chrome × {1}" -f $mpvKilled, $chromeKilled)
}

# 5) 清掉 PID 文件残留（服务被强杀时文件会留下）
if (Test-Path $pidFile) { Remove-Item $pidFile -Force }
