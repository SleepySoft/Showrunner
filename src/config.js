'use strict';
/**
 * 配置加载：config.json（可选） + 环境变量 + 命令行参数，优先级从低到高。
 * 首次启动若无密码，自动生成随机密码写入 config.json 并打印到控制台。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULTS = {
  host: '0.0.0.0',
  port: 7100,
  mediaDirs: [],          // 本地媒体库目录列表
  dataFile: null,         // 默认 <root>/data/showrunner.json
  password: null,         // 遥控器登录密码
  sessionTtlHours: 720,   // 会话有效期，默认 30 天
  ytdlpPath: null,        // yt-dlp 可执行文件路径（默认自动查找 PATH / bin/）
  cookiesFromBrowser: null, // 网页片源下载时借用哪个浏览器的登录态，如 "chrome"、"edge"
  cacheMaxGB: 20          // 网页片源缓存上限（GB），超出后按最久未用淘汰
};

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--host') args.host = argv[++i];
    else if (a === '--data') args.dataFile = argv[++i];
    else if (a === '--media') (args.mediaDirs = args.mediaDirs || []).push(argv[++i]);
    else if (a === '--password') args.password = argv[++i];
  }
  return args;
}

function loadConfig(rootDir, argv = process.argv, env = process.env) {
  const cfgFile = path.join(rootDir, 'config.json');
  let fileCfg = {};
  if (fs.existsSync(cfgFile)) {
    try {
      // 容忍 UTF-8 BOM（编辑器/PowerShell 写配置常带 BOM）
      const raw = fs.readFileSync(cfgFile, 'utf8').replace(/^﻿/, '');
      fileCfg = JSON.parse(raw);
    }
    catch { /* 配置损坏时忽略，用默认值 */ }
  }

  const cfg = Object.assign({}, DEFAULTS, fileCfg, parseArgs(argv));
  if (env.SHOWRUNNER_PASSWORD) cfg.password = env.SHOWRUNNER_PASSWORD;
  if (env.PORT) cfg.port = Number(env.PORT);

  // 首次启动：生成随机密码并持久化
  if (!cfg.password) {
    cfg.password = crypto.randomBytes(4).toString('hex');
    fileCfg.password = cfg.password;
    try { fs.writeFileSync(cfgFile, JSON.stringify(fileCfg, null, 2)); } catch { /* 只读目录则仅打印 */ }
    cfg.generatedPassword = true;
  }

  if (!cfg.dataFile) cfg.dataFile = path.join(rootDir, 'data', 'showrunner.json');
  cfg.rootDir = rootDir;
  return cfg;
}

module.exports = { loadConfig, parseArgs, DEFAULTS };
