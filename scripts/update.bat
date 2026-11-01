@echo off
chcp 65001 >nul
rem 手动升级入口：服务器没运行也能用（保留数据/缓存/配置，升级后自动重启）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1"
pause
