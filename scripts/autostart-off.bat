@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0autostart.ps1" -Action Disable
set "SHOWRUNNER_EXIT=%ERRORLEVEL%"
pause
exit /b %SHOWRUNNER_EXIT%
