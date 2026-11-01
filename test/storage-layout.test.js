'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { inspectStorage, confirmStorage, readMarker } = require('../src/storage-layout');
const { start } = require('../src/server');

function fixture(name) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), `showrunner-storage-${name}-`));
  const root = path.join(parent, 'showrunner');
  const target = path.join(parent, 'showrunner-data');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    port: 7200,
    dataFile: path.join(root, 'data', 'showrunner.json'),
    cacheDir: path.join(root, 'cache'),
    chromePath: 'C:\\Browser\\chrome.exe'
  }));
  fs.writeFileSync(path.join(root, 'data', 'showrunner.json'), JSON.stringify({ schemaVersion: 1, playlists: [] }));
  fs.mkdirSync(path.join(root, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(root, 'cache', 'cached.mp4'), 'cache');
  return { parent, root, target };
}

test('检测旧版内置数据时只生成计划，不静默创建或迁移', () => {
  const f = fixture('detect');
  try {
    const plan = inspectStorage(f.root, f.target);
    assert.equal(plan.required, true);
    assert.equal(plan.conflict, false);
    assert.equal(fs.existsSync(f.target), false);
    assert.equal(fs.existsSync(path.join(f.root, 'data', 'showrunner.json')), true);
  } finally { fs.rmSync(f.parent, { recursive: true, force: true }); }
});

test('确认迁移后复制并校验配置、状态和缓存，旧数据保持不动', () => {
  const f = fixture('migrate');
  try {
    const result = confirmStorage(inspectStorage(f.root, f.target), 'migrate');
    assert.equal(result.action, 'migrate');
    assert.equal(readMarker(f.target).layoutVersion, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.target, 'data', 'showrunner.json'))), { schemaVersion: 1, playlists: [] });
    assert.equal(fs.readFileSync(path.join(f.target, 'cache', 'cached.mp4'), 'utf8'), 'cache');
    const config = JSON.parse(fs.readFileSync(path.join(f.target, 'config.json')));
    assert.equal(config.dataFile, undefined);
    assert.equal(config.cacheDir, undefined);
    assert.equal(config.chromePath, 'C:\\Browser\\chrome.exe');
    assert.equal(fs.existsSync(path.join(f.root, 'config.json')), true);
    assert.equal(fs.existsSync(path.join(f.root, 'cache', 'cached.mp4')), true);
    assert.equal(inspectStorage(f.root, f.target).required, false);
  } finally { fs.rmSync(f.parent, { recursive: true, force: true }); }
});

test('新旧目录冲突时必须明确选择；创建全新目录会备份已有目标', () => {
  const f = fixture('conflict');
  try {
    fs.mkdirSync(f.target, { recursive: true });
    fs.writeFileSync(path.join(f.target, 'config.json'), JSON.stringify({ port: 7300 }));
    const plan = inspectStorage(f.root, f.target);
    assert.equal(plan.conflict, true);
    const result = confirmStorage(plan, 'fresh');
    assert.ok(result.backupDir);
    assert.equal(fs.existsSync(path.join(result.backupDir, 'config.json')), true);
    assert.equal(readMarker(f.target).action, 'fresh');
    assert.equal(fs.existsSync(path.join(f.target, 'config.json')), false);
  } finally { fs.rmSync(f.parent, { recursive: true, force: true }); }
});

test('旧状态损坏且无备份时迁移失败，新旧位置都不被覆盖', () => {
  const f = fixture('corrupt');
  try {
    fs.writeFileSync(path.join(f.root, 'data', 'showrunner.json'), '{broken');
    assert.throws(() => confirmStorage(inspectStorage(f.root, f.target), 'migrate'), /状态文件/);
    assert.equal(fs.readFileSync(path.join(f.root, 'data', 'showrunner.json'), 'utf8'), '{broken');
    assert.equal(fs.existsSync(f.target), false);
  } finally { fs.rmSync(f.parent, { recursive: true, force: true }); }
});

test('迁移门禁要求电视确认码，确认前不加载业务服务', async () => {
  const f = fixture('gate');
  let decision = null;
  const plan = inspectStorage(f.root, f.target);
  const gate = await start({
    rootDir: path.join(__dirname, '..'), host: '127.0.0.1', port: 0, manageBrowser: false,
    storageMigration: { ...plan, code: '123456' },
    storageDecisionImpl: result => { decision = result; }
  });
  const base = `http://127.0.0.1:${gate.port}`;
  try {
    assert.equal(gate.migrationPending, true);
    const status = await (await fetch(base + '/api/storage/status')).json();
    assert.equal(status.required, true);
    assert.equal(status.code, undefined);
    assert.match(await (await fetch(base + '/remote/')).text(), /storageMigrate/);
    assert.match(await (await fetch(base + '/tv/')).text(), /需要确认数据迁移/);
    assert.equal((await (await fetch(base + '/tv/setup-info')).json()).storageMigration.code, '123456');
    assert.equal((await fetch(base + '/api/state')).status, 404);
    assert.equal((await fetch(base + '/api/storage/confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '000000', action: 'migrate' })
    })).status, 403);
    const accepted = await fetch(base + '/api/storage/confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '123456', action: 'migrate' })
    });
    assert.equal(accepted.status, 200);
    for (let i = 0; i < 100 && !decision; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(decision.action, 'migrate');
    assert.equal(fs.existsSync(path.join(f.target, 'data', 'showrunner.json')), true);
  } finally {
    await gate.close();
    fs.rmSync(f.parent, { recursive: true, force: true });
  }
});
