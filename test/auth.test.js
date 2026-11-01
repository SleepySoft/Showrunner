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

test('首次启动只保存密码哈希，后续可从哈希登录', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-config-'));
  try {
    const first = loadConfig(root, ['node', 'test'], {});
    assert.equal(first.generatedPassword, true);
    assert.ok(first.password);
    const disk = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    assert.equal(disk.password, undefined);
    assert.match(disk.passwordHash, /^scrypt\$/);
    const second = loadConfig(root, ['node', 'test'], {});
    assert.equal(new Auth(null, 1, second.passwordHash).verifyPassword(first.password), true);
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
    assert.deepEqual(disk, { port: 7200, passwordHash: hash });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
