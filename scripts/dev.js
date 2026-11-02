'use strict';
/**
 * 隔离开发入口：不读写正式 data/config/资产保险库，不启动或回收任何浏览器，
 * 也不操作 Windows 开机启动。默认关闭真实媒体缓存，适合普通 Chrome + DevTools。
 */
const fs = require('fs');
const path = require('path');
const { start } = require('../src/server');

const enabled = value => /^(1|true|yes)$/i.test(String(value || ''));

function buildDevConfig(rootDir, env = process.env) {
  const devDir = path.join(rootDir, '.dev');
  const configFile = path.join(devDir, 'config.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch {}

  const explicitPassword = env.SHOWRUNNER_DEV_PASSWORD || null;
  const savedHash = Number(saved.passwordSetupVersion || 0) >= 1 ? saved.passwordHash || null : null;
  const port = Number(env.SHOWRUNNER_DEV_PORT || 7101);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SHOWRUNNER_DEV_PORT 必须是 1-65535 的端口');
  // 显式开启后才在开发模式拉起 mpv 前端；窗口化（最大化普通窗口，非全屏）保证可自由操作
  const mpvDev = enabled(env.SHOWRUNNER_DEV_MPV);

  return {
    rootDir,
    configFile,
    host: '127.0.0.1',
    port,
    password: explicitPassword || (savedHash ? null : 'showrunner-dev'),
    passwordHash: explicitPassword ? null : savedHash,
    setupRequired: false,
    sessionTtlHours: 24,
    mediaDirs: String(env.SHOWRUNNER_DEV_MEDIA || '').split(path.delimiter).filter(Boolean),
    dataFile: path.join(devDir, 'showrunner.json'),
    assetVaultDir: path.join(devDir, 'assets'),
    cacheDir: path.join(devDir, 'cache'),
    playbackIssueLog: path.join(devDir, 'playback-events.log'),
    disableCache: !enabled(env.SHOWRUNNER_DEV_CACHE),
    manageBrowser: false,
    manageFrontend: mpvDev,
    playerFrontend: mpvDev ? 'mpv' : 'chrome',
    mpvWindowed: mpvDev,
    updateRepo: '',
    autostartManager: {
      status: async () => ({ supported: false, enabled: false, debug: true }),
      setEnabled: async () => ({ supported: false, enabled: false, error: '开发模式不操作系统开机启动' })
    }
  };
}

async function main() {
  const rootDir = path.join(__dirname, '..');
  const cfg = buildDevConfig(rootDir);
  fs.mkdirSync(path.dirname(cfg.dataFile), { recursive: true });
  const instance = await start(cfg);
  const passwordHint = cfg.password ? `调试密码: ${cfg.password}` : '调试密码: 使用 .dev/config.json 中已设置的密码';
  console.log('');
  console.log('  Showrunner 开发模式（不启动 kiosk，不碰正式数据）');
  console.log(`  遥控器: http://127.0.0.1:${instance.port}/remote/`);
  console.log(`  电视端: http://127.0.0.1:${instance.port}/tv/`);
  console.log(`  ${passwordHint}`);
  console.log(`  数据目录: ${path.dirname(cfg.dataFile)}`);
  console.log(`  真实网页缓存: ${cfg.disableCache ? '关闭（SHOWRUNNER_DEV_CACHE=1 可开启）' : '开启'}`);
  console.log(cfg.manageFrontend
    ? '  mpv 前端: 窗口化调试模式（SHOWRUNNER_DEV_MPV=1，最大化窗口非全屏；不拉起 Chrome）'
    : '  mpv 前端: 不拉起（SHOWRUNNER_DEV_MPV=1 可窗口化调试，非全屏）');
  console.log('');

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await instance.close();
  };
  process.once('SIGINT', () => close().finally(() => process.exit(0)));
  process.once('SIGTERM', () => close().finally(() => process.exit(0)));
}

if (require.main === module) {
  main().catch(error => { console.error('开发服务启动失败:', error); process.exit(1); });
}

module.exports = { buildDevConfig };
