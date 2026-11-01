@echo off
chcp 65001 >nul
rem Showrunner 手动启动（有控制台窗口，方便查看日志和启动错误）
cd /d "%~dp0"
if exist "runtime\node\node.exe" (
  "runtime\node\node.exe" src\server.js
) else (
  node src\server.js
)
pause
