'use strict';
/** BrowserController 单元测试（注入假 spawn/exec，不启动真实浏览器）+ /api/mode 集成测试。 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BrowserController } = require('../src/browserctl');
const { start } = require('../src/server');

function makeFake() {
  const spawned = [];
  const execed = [];
  const spawnImpl = (cmd, args) => {
    const proc = {
      pid: 4000 + spawned.length,
      cmd, args,
      handlers: {},
      killed: false,
      on(ev, fn) { this.handlers[ev] = fn; },
      kill() { this.killed = true; },
      simulateExit() { if (this.handlers.exit) this.handlers.exit(); }
    };
    spawned.push(proc);
    return proc;
  };
  const execImpl = (cmd, cb) => {
    execed.push(cmd);
    if (cb) process.nextTick(() => cb(null, '', ''));
  };
  return { spawned, execed, spawnImpl, execImpl };
}

const opts = over => ({
  tvUrl: 'http://localhost:7100/tv/',
  chromePath: 'C:\\fake\\chrome.exe',
  manage: true,
  maintenanceMinutes: 10,
  relaunchCooldownMs: 0,
  ...over
});

test('启动即清理遗留受控实例并拉起 kiosk（独立 profile + kiosk 参数）', async () => {
  const f = makeFake();
  const bc = new BrowserController(opts({ spawnImpl: f.spawnImpl, execImpl: f.execImpl }));
  await bc.start(60000);
  assert.ok(f.execed[0].includes('showrunner-maintenance-profile'));
  assert.equal(f.spawned.length, 1);
  assert.ok(f.spawned[0].args.includes('--kiosk'));
  assert.ok(f.spawned[0].args.includes('http://localhost:7100/tv/'));
  assert.ok(f.spawned[0].args.some(a => a.startsWith('--user-data-dir=')));
  assert.equal(bc.status().kioskRunning, true);
  bc.stop();
});

test('kiosk 意外退出后 tick 自动重拉（看门狗）', async () => {
  const f = makeFake();
  const bc = new BrowserController(opts({ spawnImpl: f.spawnImpl, execImpl: f.execImpl }));
  await bc.start(60000);
  f.spawned[0].simulateExit();
  assert.equal(bc.status().kioskRunning, false);
  await bc.tick();
  assert.equal(f.spawned.length, 2);
  bc.stop();
});

test('维护模式：回收 kiosk 后只打开一个受控普通窗口', async () => {
  const f = makeFake();
  const bc = new BrowserController(opts({ spawnImpl: f.spawnImpl, execImpl: f.execImpl }));
  await bc.start(60000);
  const s = await bc.setMode('maintenance');
  assert.equal(s.mode, 'maintenance');
  assert.ok(s.maintenanceUntil > Date.now());
  assert.ok(f.execed.some(c => c.includes('taskkill')));      // kiosk 被杀
  assert.equal(f.spawned.length, 2);                          // kiosk + 受控维护窗口
  assert.equal(f.spawned[1].args.includes('--kiosk'), false);
  assert.ok(f.spawned[1].args.includes('--new-window'));
  assert.equal(bc.status().kioskRunning, false);
  assert.equal(bc.status().maintenanceBrowserRunning, true);
  assert.equal(bc.status().managedBrowserRunning, true);
  bc.stop();
});

test('维护模式超时先关闭普通窗口，再拉起唯一 kiosk', async () => {
  const f = makeFake();
  const bc = new BrowserController(opts({ spawnImpl: f.spawnImpl, execImpl: f.execImpl }));
  await bc.start(60000);
  await bc.setMode('maintenance');
  bc.maintenanceUntil = Date.now() - 1; // 模拟已超时
  await bc.tick();
  assert.equal(bc.status().mode, 'normal');
  assert.equal(f.spawned.length, 3); // 初始 kiosk + 维护窗口 + 新 kiosk
  assert.equal(bc.status().maintenanceBrowserRunning, false);
  assert.equal(bc.status().kioskRunning, true);
  assert.ok(f.execed.some(c => c.includes('/PID 4001'))); // 维护窗口已按进程树回收
  bc.stop();
});

test('手动回锁先关闭维护窗口再拉 kiosk，旧进程迟到退出不影响新实例', async () => {
  const f = makeFake();
  const bc = new BrowserController(opts({ spawnImpl: f.spawnImpl, execImpl: f.execImpl }));
  await bc.start(60000);
  await bc.setMode('maintenance');
  await bc.setMode('normal');
  assert.equal(bc.status().mode, 'normal');
  assert.equal(bc.status().kioskRunning, true);
  assert.equal(bc.status().maintenanceBrowserRunning, false);
  f.spawned[1].simulateExit(); // 被 taskkill 的旧维护进程稍后才发 exit
  assert.equal(bc.status().kioskRunning, true);
  bc.stop();
});

test('下线模式释放所有受控浏览器且不会被看门狗重拉，上线后恢复', async () => {
  const f = makeFake();
  const bc = new BrowserController(opts({ spawnImpl: f.spawnImpl, execImpl: f.execImpl }));
  await bc.start(60000);
  assert.equal((await bc.setMode('offline')).mode, 'offline');
  assert.equal(bc.status().kioskRunning, false);
  await bc.tick();
  assert.equal(f.spawned.length, 1);
  await bc.setMode('normal');
  assert.equal(f.spawned.length, 2);
  bc.stop();
});

test('以持久化下线状态启动时不拉 kiosk', async () => {
  const f = makeFake();
  const bc = new BrowserController(opts({ initialMode: 'offline', spawnImpl: f.spawnImpl, execImpl: f.execImpl }));
  await bc.start(60000);
  assert.equal(f.spawned.length, 0);
  assert.equal(bc.status().mode, 'offline');
  bc.stop();
});

test('非法模式返回 null，同模式幂等', async () => {
  const f = makeFake();
  const bc = new BrowserController(opts({ spawnImpl: f.spawnImpl, execImpl: f.execImpl }));
  await bc.start(60000);
  assert.equal(await bc.setMode('hack'), null);
  assert.equal((await bc.setMode('normal')).mode, 'normal');
  bc.stop();
});

test('manage=false 完全不碰浏览器（含模式切换）', async () => {
  const f = makeFake();
  const bc = new BrowserController(opts({ manage: false, spawnImpl: f.spawnImpl, execImpl: f.execImpl }));
  await bc.start(60000);
  bc.tick();
  await bc.setMode('maintenance'); // 回归：托管关闭时切模式也不许有进程副作用
  await bc.setMode('normal');
  assert.equal(f.spawned.length, 0);
  assert.equal(f.execed.length, 0);
  assert.equal(bc.status().manageBrowser, false);
  bc.stop();
});

// ---------- /api/mode 集成 ----------

let tmp, srv, base, cookie;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-mode-'));
  srv = await start({
    rootDir: path.join(__dirname, '..'),
    host: '127.0.0.1', port: 0,
    password: 'pw', mediaDirs: [],
    dataFile: path.join(tmp, 'data.json'),
    cacheDir: path.join(tmp, 'cache'),
    disableCache: true,
    sessionTtlHours: 1
    // 不传 manageBrowser：测试中浏览器托管关闭
  });
  base = `http://127.0.0.1:${srv.port}`;
  const res = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'pw' })
  });
  cookie = res.headers.get('set-cookie').split(';')[0];
});

after(async () => {
  await srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const authed = (p, opts = {}) => fetch(base + p, {
  ...opts,
  headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie }
});

test('GET /api/mode 返回托管状态', async () => {
  const s = await (await authed('/api/mode')).json();
  assert.equal(s.mode, 'normal');
  assert.equal(s.manageBrowser, false);
});

test('POST /api/mode 切换模式', async () => {
  const s = await (await authed('/api/mode', { method: 'POST', body: JSON.stringify({ mode: 'maintenance' }) })).json();
  assert.equal(s.mode, 'maintenance');
  assert.ok(s.maintenanceUntil > Date.now());
  const s2 = await (await authed('/api/mode', { method: 'POST', body: JSON.stringify({ mode: 'normal' }) })).json();
  assert.equal(s2.mode, 'normal');
  const s3 = await (await authed('/api/mode', { method: 'POST', body: JSON.stringify({ mode: 'offline' }) })).json();
  assert.equal(s3.mode, 'offline');
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'data.json'), 'utf8'));
  assert.equal(saved.settings.offline, true);
  await authed('/api/mode', { method: 'POST', body: JSON.stringify({ mode: 'normal' }) });
});

test('POST /api/mode 非法模式 400 + 未登录 401', async () => {
  assert.equal((await authed('/api/mode', { method: 'POST', body: JSON.stringify({ mode: 'x' }) })).status, 400);
  assert.equal((await fetch(base + '/api/mode')).status, 401);
});

test('播放前端 API 返回状态并拒绝未注册类型', async () => {
  const status = await (await authed('/api/playback/frontend')).json();
  assert.equal(status.frontend, 'chrome');
  assert.ok(status.frontends.chrome);
  assert.ok(status.frontends.mpv);
  assert.equal((await authed('/api/playback/frontend', {
    method: 'PUT', body: JSON.stringify({ type: 'unknown-player' })
  })).status, 400);
  assert.equal((await fetch(base + '/api/playback/frontend')).status, 401);
});
