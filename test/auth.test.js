'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Auth } = require('../src/auth');
const { loadConfig, savePasswordHash } = require('../src/config');

test('scrypt 密码哈希可校验，改密会撤销旧会话', () => {
  const first = Auth.hashPassword('old-password');
  const auth = new Auth(null, 1, first);
  assert.equal(auth.verifyPassword('old-password'), true);
  assert.equal(auth.verifyPassword('wrong'), false);
  const token = auth.login('old-password');
  assert.equal(auth.valid(token), true);
  auth.setPasswordHash(Auth.hashPassword('new-password'));
  assert.equal(auth.valid(token), false);
  assert.equal(auth.verifyPassword('old-password'), false);
  assert.equal(auth.verifyPassword('new-password'), true);
});

test('未配置鉴权时拒绝空密码登录', () => {
  const auth = new Auth(null, 1, null);
  assert.equal(auth.isConfigured(), false);
  assert.equal(auth.verifyPassword(''), false);
  assert.equal(auth.login(''), null);
});

test('首次启动生成临时配对码，配对前不写永久密码', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-config-'));
  try {
    const first = loadConfig(root, ['node', 'test'], {});
    assert.equal(first.setupRequired, true);
    assert.match(first.setupCode, /^\d{6}$/);
    assert.equal(fs.existsSync(path.join(root, 'config.json')), false);

    const hash = Auth.hashPassword('chosen-password');
    savePasswordHash(path.join(root, 'config.json'), hash);
    const second = loadConfig(root, ['node', 'test'], {});
    assert.equal(second.setupRequired, false);
    assert.equal(second.setupCode, undefined);
    assert.equal(new Auth(null, 1, second.passwordHash).verifyPassword('chosen-password'), true);

    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ passwordHash: hash }));
    const legacy = loadConfig(root, ['node', 'test'], {});
    assert.equal(legacy.setupRequired, true);
    assert.equal(legacy.legacyPasswordNeedsPairing, true);
    assert.equal(legacy.passwordHash, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('保存新密码哈希时保留其他配置并移除旧明文密码', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-password-'));
  try {
    const file = path.join(root, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ port: 7200, password: 'legacy' }));
    const hash = Auth.hashPassword('replacement');
    savePasswordHash(file, hash);
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(disk, { port: 7200, passwordHash: hash, passwordSetupVersion: 1 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
