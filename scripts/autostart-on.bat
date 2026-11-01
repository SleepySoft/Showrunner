@echo off
chcp 65001 >nul
rem 注册开机自启：任务计划程序直接运行便携 Node，不依赖 VBS/WScript
set "ROOT=%~dp0.."
set "NODE=%ROOT%\runtime\node\node.exe"
if not exist "%NODE%" (
  echo 未找到便携 Node：%NODE%
  echo 请重新解压完整便携包，或从遥控器设置页启用开机启动。
  pause
  exit /b 1
)
schtasks /Create /TN "Showrunner" /SC ONLOGON /RL LIMITED /F /TR "\"%NODE%\" \"%ROOT%\src\server.js\""
if %ERRORLEVEL%==0 (
  echo.
  echo 已注册开机自启任务「Showrunner」，下次登录 Windows 时自动后台运行。
  echo 现在试跑请双击项目根目录的 start.bat。
  echo 取消方法：运行 autostart-off.bat
) else (
  echo.
  echo 注册失败，错误码 %ERRORLEVEL%
)
pause
