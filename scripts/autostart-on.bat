@echo off
rem 注册开机自启：登录后后台静默运行 Showrunner（无窗口）
set "ROOT=%~dp0.."
schtasks /Create /TN "Showrunner" /SC ONLOGON /RL LIMITED /F /TR "wscript.exe \"%ROOT%scripts\run-hidden.vbs\""
if %ERRORLEVEL%==0 (
  echo.
  echo 已注册开机自启任务「Showrunner」。现在就可以双击 run-hidden.vbs 试跑一次。
  echo 取消方法：运行 autostart-off.bat
) else (
  echo.
  echo 注册失败，错误码 %ERRORLEVEL%
)
pause
