@echo off
rem 更新 yt-dlp 到最新版（网站改版导致下载失败时先跑这个）
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile '%~dp0..\bin\yt-dlp.exe'"
echo.
"%~dp0..\bin\yt-dlp.exe" --version
echo yt-dlp 已更新。ffmpeg 不需要频繁更新；如需更新请重新运行 install.bat（删掉 bin\ffmpeg.exe 后）。
pause
