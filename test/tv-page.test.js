'use strict';
/**
 * 电视页环境标记：非托管（manageBrowser=false，开发/调试默认）模式下，服务端给
 * /tv 页面注入 __SHOWRUNNER_UNMANAGED__ 标记，页面据此解除 kiosk 专属锁定交互
 * （隐藏光标、禁右键/双击）。托管模式不得注入该标记。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { start } = require('../src/server');

async function boot(overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-tvpage-'));
  const srv = await start({
    rootDir: path.join(__dirname, '..'),
    host: '127.0.0.1',
    port: 0,
    password: 'test-pwd',
    dataFile: path.join(tmp, 'data.json'),
    cacheDir: path.join(tmp, 'cache'),
    disableCache: true,
    manageBrowser: false,
    ...overrides
  });
  return { srv, tmp, base: `http://127.0.0.1:${srv.port}` };
}

// 托管模式不能真的让 BrowserController 管理浏览器，换成无副作用的假 supervisor
function managedSupervisor() {
  const emitter = new EventEmitter();
  return {
    on: emitter.on.bind(emitter),
    start: async () => ({}),
    stop: async () => {},
    sync: async () => {},
    status: () => ({ frontend: 'chrome' }),
    mode: 'normal'
  };
}

test('非托管（开发）模式：/tv 各路径都注入解除锁定的环境标记', async () => {
  const { srv, tmp, base } = await boot();
  try {
    for (const p of ['/tv', '/tv/', '/tv/index.html']) {
      const res = await fetch(base + p);
      assert.equal(res.status, 200, p);
      const html = await res.text();
      assert.ok(html.includes('window.__SHOWRUNNER_UNMANAGED__=true'), p);
      assert.ok(html.includes('id="devBadge"'), p);
    }
  } finally {
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('托管模式：/tv 页面不注入标记，保持原生 kiosk 行为', async () => {
  const { srv, tmp, base } = await boot({ manageBrowser: true, frontendSupervisor: managedSupervisor() });
  try {
    const res = await fetch(base + '/tv/');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(!html.includes('__SHOWRUNNER_UNMANAGED__=true'));
  } finally {
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
