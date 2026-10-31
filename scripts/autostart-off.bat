@echo off
chcp 65001 >nul
rem 取消开机自启（不会停止当前正在运行的实例）
schtasks /Delete /TN "Showrunner" /F
pause
