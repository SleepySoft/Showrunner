# Showrunner 打包脚本：生成「复制即用」的用户分发包
# 产物：dist\showrunner-portable-<版本>.zip —— 含便携 Node + npm 依赖 + yt-dlp + ffmpeg，
#       解压后双击 start.bat 即可运行，目标机器不需要安装任何东西。
# 用法：powershell -File scripts\package.ps1 [-SkipVerify]
param([switch]$SkipVerify)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($n, $msg) { Write-Host ""; Write-Host "[$n] $msg" -ForegroundColor Cyan }

$pkg = Get-Content package.json -Raw | ConvertFrom-Json
$version = $pkg.version

# ---------- 1. 前置检查：缺什么补什么 ----------
Step 1 '检查打包原料'

$nodeModules = Test-Path 'node_modules\express'
if (-not $nodeModules) {
    Write-Host '    安装生产依赖…'
    $npm = if (Get-Command npm -ErrorAction SilentlyContinue) { 'npm' } else { Join-Path $root 'runtime\node\npm.cmd' }
    & $npm install --omit=dev --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { throw 'npm install 失败' }
} else { Write-Host '    node_modules 就绪' }

if (-not (Test-Path 'bin\yt-dlp.exe') -or -not (Test-Path 'bin\ffmpeg.exe')) {
    throw 'bin\ 缺少 yt-dlp.exe 或 ffmpeg.exe，请先运行 scripts\install.bat 补齐'
}
Write-Host '    bin 工具就绪'

# 打包必须含便携 Node——目标机器未必装过
if (-not (Test-Path 'runtime\node\node.exe')) {
    Write-Host '    下载便携版 Node.js（约 30MB）…'
    $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
    $lts = $index | Where-Object { $_.lts } | Select-Object -First 1
    $ver = $lts.version
    $zip = Join-Path $env:TEMP "node-$ver-win-x64.zip"
    Invoke-WebRequest "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip" -OutFile $zip
    $stage = Join-Path $env:TEMP "node-$ver-extract"
    Expand-Archive $zip -DestinationPath $stage -Force
    New-Item -ItemType Directory -Force -Path 'runtime' | Out-Null
    Move-Item (Join-Path $stage "node-$ver-win-x64") 'runtime\node' -Force
    Remove-Item $zip, $stage -Recurse -Force -ErrorAction SilentlyContinue
}
$nodeVer = & '.\runtime\node\node.exe' --version
Write-Host "    便携 Node.js 就绪: $nodeVer"

# ---------- 2. 组装 ----------
Step 2 '组装分发包（排除数据/缓存/配置/测试）'
$dist = Join-Path $root 'dist'
$stageDir = Join-Path $dist 'showrunner-portable'
Remove-Item $stageDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stageDir | Out-Null

$include = @('src', 'public', 'scripts', 'bin', 'node_modules', 'runtime',
             'package.json', 'start.bat', 'README.md', 'docs')
foreach ($p in $include) {
    Copy-Item $p -Destination $stageDir -Recurse -Force
}
# 包内绝不含私有数据：长期密码由用户在首启电视配对流程中设置
foreach ($junk in @('data', 'cache', 'config.json', '.smoke-tmp')) {
    Remove-Item (Join-Path $stageDir $junk) -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------- 3. 压缩 ----------
Step 3 '压缩'
$zipName = "showrunner-portable-$version.zip"
$zipPath = Join-Path $dist $zipName
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
Compress-Archive -Path "$stageDir\*" -DestinationPath $zipPath -CompressionLevel Optimal
$sizeMB = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
Write-Host "    产物: dist\$zipName ($sizeMB MB)"

# ---------- 4. 验证：解压 → 用包内便携 Node 启动 → 检查页面 ----------
if (-not $SkipVerify) {
    Step 4 '验证：模拟全新机器（解压到临时目录，只用包内文件启动）'
    $verifyDir = Join-Path $env:TEMP "showrunner-verify-$PID"
    Remove-Item $verifyDir -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive $zipPath -DestinationPath $verifyDir
    # 禁 kiosk 托管，避免验证时弹浏览器（无 BOM 写入，防止 JSON 解析兼容问题）
    [System.IO.File]::WriteAllText((Join-Path $verifyDir 'config.json'),
        '{"manageBrowser": false, "port": 7197, "host": "127.0.0.1"}')

    $vnode = Join-Path $verifyDir 'runtime\node\node.exe'
    $proc = Start-Process $vnode -ArgumentList 'src\server.js' -WorkingDirectory $verifyDir -PassThru -WindowStyle Hidden
    try {
        $ok = $false
        for ($i = 0; $i -lt 30 -and -not $ok; $i++) {
            Start-Sleep 1
            try {
                $r = Invoke-WebRequest 'http://127.0.0.1:7197/tv/' -UseBasicParsing -TimeoutSec 2
                $ok = ($r.StatusCode -eq 200)
            } catch { }
        }
        if (-not $ok) { throw '验证包启动失败或 /tv/ 不可访问' }
        $remote = Invoke-WebRequest 'http://127.0.0.1:7197/remote/' -UseBasicParsing -TimeoutSec 5
        if ($remote.StatusCode -ne 200) { throw '/remote/ 不可访问' }
        Write-Host '    验证通过：包内便携 Node 启动成功，/tv/ 与 /remote/ 均可访问'
    } finally {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep 1
        Remove-Item $verifyDir -Recurse -Force -ErrorAction SilentlyContinue
    }
} else {
    Step 4 '（按参数跳过验证）'
}

Write-Host ""
Write-Host "[√] 打包完成: dist\$zipName" -ForegroundColor Green
Write-Host '    发给用户 → 解压 → 双击 start.bat。首次启动按电视画面配对并设置密码。'
