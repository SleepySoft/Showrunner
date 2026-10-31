@echo off
chcp 65001 >nul
rem Showrunner 一键部署入口（双击即可，无需管理员）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
pause
