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
    assert.equal(base.manageBrowser, false);
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

    // 默认不拉起任何播放前端；SHOWRUNNER_DEV_MPV=1 时仅窗口化拉起 mpv（非全屏、不碰 Chrome）
    assert.equal(base.manageFrontend, false);
    assert.equal(base.playerFrontend, 'chrome');
    assert.equal(base.mpvWindowed, false);
    const mpvDev = buildDevConfig(root, { SHOWRUNNER_DEV_MPV: '1' });
    assert.equal(mpvDev.manageFrontend, true);
    assert.equal(mpvDev.playerFrontend, 'mpv');
    assert.equal(mpvDev.mpvWindowed, true);
    assert.equal(mpvDev.manageBrowser, false);

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
