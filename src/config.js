'use strict';
/**
 * 配置加载：config.json（可选） + 环境变量 + 命令行参数，优先级从低到高。
 * 首次启动若无密码，进入一次性电视配对流程；配对成功后才保存长期密码哈希。
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
  passwordHash: null,     // 首次配对/修改密码后使用 scrypt 哈希持久化
  sessionTtlHours: 720,   // 会话有效期，默认 30 天
  ytdlpPath: null,        // yt-dlp 可执行文件路径（默认自动查找 PATH / bin/）
  cookiesFromBrowser: null, // 网页片源下载时借用哪个浏览器的登录态，如 "chrome"、"edge"
  cacheMaxGB: 20,         // 网页片源缓存上限（GB），超出后按最久未用淘汰
  compatibilityCacheMaxGB: 10 // 本地不兼容媒体转换缓存上限（GB）
};

function defaultAssetVaultDir(rootDir, env) {
  // 固定放在安装目录之外：即使误删/替换程序目录，频道与合集仍有独立镜像。
  if (env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, 'Showrunner', 'assets');
  if (env.XDG_DATA_HOME) return path.join(env.XDG_DATA_HOME, 'showrunner', 'assets');
  return path.join(rootDir, 'data', 'asset-backups');
}

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

  // 首次启动：只生成本进程有效的配对码，不预先写入一个用户看不到的永久密码。
  // 旧版本自动生成的哈希没有 passwordSetupVersion，无法判断用户是否见过密码；升级后重新配对一次。
  const passwordHashReady = !!cfg.passwordHash && Number(fileCfg.passwordSetupVersion || 0) >= 1;
  if (!cfg.password && !passwordHashReady) {
    cfg.setupRequired = true;
    cfg.setupCode = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    cfg.legacyPasswordNeedsPairing = !!cfg.passwordHash;
    cfg.passwordHash = null;
  } else {
    cfg.setupRequired = false;
  }

  if (!cfg.dataFile) cfg.dataFile = path.join(rootDir, 'data', 'showrunner.json');
  cfg.assetVaultDir = defaultAssetVaultDir(rootDir, env);
  cfg.rootDir = rootDir;
  cfg.configFile = cfgFile;
  return cfg;
}

/** 原子保存密码哈希，同时移除旧版明文密码。 */
function savePasswordHash(cfgFile, passwordHash) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^﻿/, '')); } catch {}
  data.passwordHash = passwordHash;
  data.passwordSetupVersion = 1;
  delete data.password;
  const tmp = cfgFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, cfgFile);
}

module.exports = { loadConfig, parseArgs, DEFAULTS, savePasswordHash, defaultAssetVaultDir };
