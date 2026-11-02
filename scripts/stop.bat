@echo off
chcp 65001 >nul
rem Showrunner 停止整个服务（Node 服务 + 受管的 mpv/Chrome 前端）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
if errorlevel 1 pause
