'use strict';
/**
 * 隔离开发入口：默认不读写正式 data/config/资产保险库，不操作 Windows 开机启动。
 * 绝不用 kiosk 全屏：Chrome 前端按需窗口化托管，mpv 前端同样窗口化；看门狗默认
 * 关闭（不自动拉起），在遥控器「播放前端」里手动打开/关闭，或开启「自动拉起」。
 * 默认关闭真实媒体缓存，适合普通 Chrome + DevTools。
 *
 * 例外：.dev/config.json 里设 "useProductionData": true 后，直接读写与正式入口
 * 相同的同级 showrunner-data（频道/设置/资产保险库）。这是显式选择，调试改动会
 * 写入正式数据，且不要与正式实例同时运行。
 */
const fs = require('fs');
const path = require('path');
const { start } = require('../src/server');
const { defaultDataDir } = require('../src/storage-layout');

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

  // 显式开关：用正式数据目录（与正式入口 defaultDataDir 相同的解析规则与目录布局）
  const useProductionData = saved.useProductionData === true;
  const productionDir = defaultDataDir(rootDir);
  if (useProductionData && !fs.existsSync(productionDir)) {
    throw new Error(`useProductionData 已开启，但找不到正式数据目录：${productionDir}`);
  }

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
    dataFile: useProductionData ? path.join(productionDir, 'data', 'showrunner.json') : path.join(devDir, 'showrunner.json'),
    assetVaultDir: useProductionData ? path.join(productionDir, 'asset-vault') : path.join(devDir, 'assets'),
    cacheDir: useProductionData ? path.join(productionDir, 'cache') : path.join(devDir, 'cache'),
    playbackIssueLog: useProductionData ? path.join(productionDir, 'logs', 'playback-events.log') : path.join(devDir, 'playback-events.log'),
    useProductionData,
    disableCache: !enabled(env.SHOWRUNNER_DEV_CACHE),
    manageBrowser: true,      // 允许按需托管浏览器进程（手动打开 chrome 前端时）
    kioskBrowser: false,      // 开发模式绝不用 kiosk 全屏，一律窗口化
    frontendWatchdog: false,  // 不自动拉起前端；在遥控器里手动打开/关闭或开启自动拉起
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
  console.log('  Showrunner 开发模式（不启动 kiosk）');
  console.log(`  遥控器: http://127.0.0.1:${instance.port}/remote/`);
  console.log(`  电视端: http://127.0.0.1:${instance.port}/tv/`);
  console.log(`  ${passwordHint}`);
  if (cfg.useProductionData) {
    console.log('  ⚠ 正在直接读写正式数据目录（.dev/config.json 的 useProductionData=true）');
    console.log('    调试改动会写入正式频道/设置；不要同时运行正式实例');
  } else {
    console.log(`  数据目录: ${path.dirname(cfg.dataFile)}`);
  }
  console.log(`  真实网页缓存: ${cfg.disableCache ? '关闭（SHOWRUNNER_DEV_CACHE=1 可开启）' : '开启'}`);
  console.log('  播放前端: 不自动拉起（遥控器「播放前端」里打开/关闭；一律窗口化，无 kiosk）');
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
