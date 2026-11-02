'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Auth } = require('../src/auth');
const { buildDevConfig } = require('../scripts/dev');

test('开发配置隔离正式数据、浏览器、缓存和系统开机启动', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-dev-config-'));
  try {
    const base = buildDevConfig(root, {});
    assert.equal(base.host, '127.0.0.1');
    assert.equal(base.port, 7101);
    assert.equal(base.password, 'showrunner-dev');
    assert.equal(base.manageBrowser, true);      // 允许按需托管浏览器进程
    assert.equal(base.kioskBrowser, false);      // 但绝不用 kiosk 全屏
    assert.equal(base.frontendWatchdog, false);  // 不自动拉起前端，遥控器里手动打开/关闭
    assert.equal(base.useProductionData, false); // 默认隔离 .dev/，不碰正式数据
    assert.equal(base.disableCache, true);
    assert.ok(base.dataFile.startsWith(path.join(root, '.dev')));
    assert.ok(base.assetVaultDir.startsWith(path.join(root, '.dev')));
    assert.equal((await base.autostartManager.status()).supported, false);

    const configured = buildDevConfig(root, {
      SHOWRUNNER_DEV_PORT: '7201', SHOWRUNNER_DEV_PASSWORD: 'custom-dev-password',
      SHOWRUNNER_DEV_CACHE: '1', SHOWRUNNER_DEV_MEDIA: [path.join(root, 'media-a'), path.join(root, 'media-b')].join(path.delimiter)
    });
    assert.equal(configured.port, 7201);
    assert.equal(configured.password, 'custom-dev-password');
    assert.equal(configured.disableCache, false);
    assert.equal(configured.mediaDirs.length, 2);

    // 与正式模式一致：看门狗默认跟随托管配置开启（开发配置显式关闭）
    assert.equal(buildDevConfig(root, {}).frontendWatchdog, false);

    // useProductionData=true：直接读写与正式入口相同的同级 <root>-data（正式目录布局）；
    // 正式数据目录不存在时必须显式报错，而不是悄悄自建一份
    const prodDir = path.join(path.dirname(root), path.basename(root) + '-data');
    fs.mkdirSync(path.join(root, '.dev'), { recursive: true });
    fs.writeFileSync(path.join(root, '.dev', 'config.json'), JSON.stringify({ useProductionData: true }));
    assert.throws(() => buildDevConfig(root, {}), /找不到正式数据目录/);
    fs.mkdirSync(path.join(prodDir, 'data'), { recursive: true });
    const prod = buildDevConfig(root, {});
    assert.equal(prod.useProductionData, true);
    assert.equal(prod.dataFile, path.join(prodDir, 'data', 'showrunner.json'));
    assert.equal(prod.assetVaultDir, path.join(prodDir, 'asset-vault'));
    assert.equal(prod.cacheDir, path.join(prodDir, 'cache'));
    assert.equal(prod.playbackIssueLog, path.join(prodDir, 'logs', 'playback-events.log'));

    fs.mkdirSync(path.join(root, '.dev'), { recursive: true });
    const hash = Auth.hashPassword('changed-dev-password');
    fs.writeFileSync(path.join(root, '.dev', 'config.json'), JSON.stringify({ passwordHash: hash, passwordSetupVersion: 1 }));
    const restarted = buildDevConfig(root, {});
    assert.equal(restarted.password, null);
    assert.equal(restarted.passwordHash, hash);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
