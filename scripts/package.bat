@echo off
chcp 65001 >nul
rem 打出「复制即用」的用户分发包（dist\showrunner-portable-*.zip）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0package.ps1"
pause
