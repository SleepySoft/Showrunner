bin/ 目录占位说明
=================

本目录的可执行文件不进入 Git 仓库（体积大、更新频繁）：

- yt-dlp.exe  —— 网页片源下载（~23MB）
- ffmpeg.exe  —— 音视频合并（~105MB）
- mpv.exe     —— 可选本地播放前端（~121MB；缺少时仍可使用默认 Chrome 前端）

yt-dlp / ffmpeg 获取方式（二选一）：
- 开发者：运行 scripts\install.bat，脚本自动下载最新版
- 用户：直接使用打包版（dist\showrunner-portable-*.zip），已内置

mpv 当前需单独安装：使用 mpv 官方安装页推荐的 Windows 构建，将 mpv.exe
放在本目录、加入 PATH，或在 config.json 配置 mpvPath。2026-11-02 本机安装的是
shinchiro x86_64 构建 v0.41.0-1386-g2137d21b2；下载归档 SHA-256：
80ddf0f7fcee5a3ace454967eae22a63b06a5d02e304b5cdb0c1f87e47d90490
