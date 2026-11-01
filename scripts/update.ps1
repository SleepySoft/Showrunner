# 手动升级（服务器没运行也能用）：从 config.json 读 updateRepo，
# 下载最新分发包并调用 self-update.ps1 完成替换与重启。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = Split-Path -Parent $PSScriptRoot

$cfgPath = Join-Path $root 'config.json'
$repo = $null; $port = 7100
if (Test-Path $cfgPath) {
    $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
    $repo = $cfg.updateRepo
    if ($cfg.port) { $port = [int]$cfg.port }
}
if (-not $repo) {
    Write-Host 'config.json 里没有配置 updateRepo（形如 "用户名/仓库名"），无法检查更新。' -ForegroundColor Red
    exit 1
}
Write-Host "仓库: $repo  端口: $port  安装目录: $root"
& (Join-Path $PSScriptRoot 'self-update.ps1') -InstallDir $root -Repo $repo -Port $port
if ($LASTEXITCODE -ne 0) { Write-Host '升级失败，详见 data\update.log' -ForegroundColor Red; exit 1 }
Write-Host '升级完成，服务已重启。' -ForegroundColor Green
