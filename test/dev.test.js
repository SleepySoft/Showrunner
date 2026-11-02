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
