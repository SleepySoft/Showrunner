'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('../src/server');
const { isPrivateAddress } = require('../src/password-recovery');

test('修改为指定密码后撤销旧会话并持久化哈希', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-password-api-'));
  const configFile = path.join(tmp, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ port: 0 }));
  const srv = await start({
    rootDir: path.join(__dirname, '..'), configFile,
    host: '127.0.0.1', port: 0, password: 'old-password',
    mediaDirs: [], dataFile: path.join(tmp, 'data.json'), cacheDir: path.join(tmp, 'cache'),
    disableCache: true, disableScheduler: true, disableChannelTimer: true, sessionTtlHours: 1
  });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const login = await fetch(base + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'old-password' })
    });
    const oldCookie = login.headers.get('set-cookie').split(';')[0];
    const changed = await fetch(base + '/api/password', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: oldCookie },
      body: JSON.stringify({ currentPassword: 'old-password', newPassword: 'chosen-password' })
    });
    assert.equal(changed.status, 200);
    const newCookie = changed.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(base + '/api/state', { headers: { Cookie: oldCookie } })).status, 401);
    assert.equal((await fetch(base + '/api/state', { headers: { Cookie: newCookie } })).status, 200);
    const oldLogin = await fetch(base + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'old-password' })
    });
    assert.equal(oldLogin.status, 401);
    const newLogin = await fetch(base + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'chosen-password' })
    });
    assert.equal(newLogin.status, 200);
    const disk = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.match(disk.passwordHash, /^scrypt\$/);
    assert.equal(disk.password, undefined);
    assert.equal(disk.passwordSetupVersion, 1);
  } finally {
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('首次运行用电视配对码设置长期密码', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-setup-api-'));
  const configFile = path.join(tmp, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ port: 0 }));
  const srv = await start({
    rootDir: path.join(__dirname, '..'), configFile,
    host: '127.0.0.1', port: 0, password: null, passwordHash: null,
    setupRequired: true, setupCode: '482731',
    mediaDirs: [], dataFile: path.join(tmp, 'data.json'), cacheDir: path.join(tmp, 'cache'),
    disableCache: true, disableScheduler: true, disableChannelTimer: true, sessionTtlHours: 1
  });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    assert.deepEqual(await (await fetch(base + '/api/setup/status')).json(), { required: true });
    assert.equal((await fetch(base + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: '' })
    })).status, 409);

    const tvInfo = await (await fetch(base + '/tv/setup-info')).json();
    assert.equal(tvInfo.required, true);
    assert.equal(tvInfo.code, '482731');

    const wrong = await fetch(base + '/api/setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '000000', newPassword: 'chosen-password' })
    });
    assert.equal(wrong.status, 403);

    const paired = await fetch(base + '/api/setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '482731', newPassword: 'chosen-password' })
    });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(base + '/api/state', { headers: { Cookie: cookie } })).status, 200);
    assert.deepEqual(await (await fetch(base + '/api/setup/status')).json(), { required: false });
    assert.equal((await (await fetch(base + '/tv/setup-info')).json()).required, false);
    assert.equal((await fetch(base + '/api/setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '482731', newPassword: 'another-password' })
    })).status, 409);
    const disk = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.match(disk.passwordHash, /^scrypt\$/);
    assert.equal(disk.password, undefined);
    assert.equal(disk.passwordSetupVersion, 1);
  } finally {
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('忘记密码后用本机电视一次性码重置，并拒绝反向代理发起', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-password-recovery-'));
  const configFile = path.join(tmp, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ port: 0 }));
  const srv = await start({
    rootDir: path.join(__dirname, '..'), configFile,
    host: '127.0.0.1', port: 0, password: 'forgotten-password', passwordRecoveryCode: '654321',
    mediaDirs: [], dataFile: path.join(tmp, 'data.json'), cacheDir: path.join(tmp, 'cache'),
    disableCache: true, disableScheduler: true, disableChannelTimer: true, sessionTtlHours: 1
  });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const login = await fetch(base + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'forgotten-password' })
    });
    const oldCookie = login.headers.get('set-cookie').split(';')[0];

    const proxied = await fetch(base + '/api/password/recovery/request', {
      method: 'POST', headers: { 'X-Forwarded-For': '203.0.113.8' }
    });
    assert.equal(proxied.status, 403);
    assert.equal(isPrivateAddress('tv.example.com'), false);
    assert.equal(isPrivateAddress('192.168.50.245'), true);

    const requested = await fetch(base + '/api/password/recovery/request', { method: 'POST' });
    assert.equal(requested.status, 200);
    const publicStatus = await (await fetch(base + '/api/password/recovery/status')).json();
    assert.equal(publicStatus.active, true);
    assert.equal(publicStatus.code, undefined);
    const tvInfo = await (await fetch(base + '/tv/setup-info')).json();
    assert.equal(tvInfo.passwordRecovery.code, '654321');

    assert.equal((await fetch(base + '/api/password/recovery/confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '000000', newPassword: 'recovered-password' })
    })).status, 403);

    const recovered = await fetch(base + '/api/password/recovery/confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '654321', newPassword: 'recovered-password' })
    });
    assert.equal(recovered.status, 200);
    const newCookie = recovered.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(base + '/api/state', { headers: { Cookie: oldCookie } })).status, 401);
    assert.equal((await fetch(base + '/api/state', { headers: { Cookie: newCookie } })).status, 200);
    assert.equal((await fetch(base + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'forgotten-password' })
    })).status, 401);
    assert.equal((await fetch(base + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'recovered-password' })
    })).status, 200);
    assert.equal((await (await fetch(base + '/api/password/recovery/status')).json()).active, false);
  } finally {
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
