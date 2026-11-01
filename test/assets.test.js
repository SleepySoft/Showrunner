'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAssetDocument, validateAssetDocument, AssetVault } = require('../src/assets');
const { Store } = require('../src/store');
const { start } = require('../src/server');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-assets-'));
const state = title => ({
  activeId: 'p1',
  playlists: [{ id: 'p1', name: '频道', enabled: true, allowOnDemand: true, autoPlay: true, items: [
    { qid: 'q1', type: 'web', title, url: 'https://example.test/v', startTime: '20:00', maxPlaySeconds: 60, resolved: { title: '运行态' } }
  ] }],
  collections: [{ id: 'c1', name: '合集', mode: 'random', cursor: 2, randomPool: [1], items: [] }],
  settings: { schedules: [{ id: 's1', playlistId: 'p1', days: [1], start: '20:00', end: '21:00' }] }
});

test('资产格式无损保留配置并排除播放运行态', () => {
  const doc = createAssetDocument(state('第一集'), '2026-01-01T00:00:00.000Z');
  assert.equal(doc.format, 'showrunner-assets');
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.playlists[0].items[0].startTime, '20:00');
  assert.equal(doc.playlists[0].items[0].maxPlaySeconds, 60);
  assert.equal(doc.playlists[0].items[0].resolved, undefined);
  assert.equal(doc.collections[0].cursor, 2);
  assert.equal(doc.collections[0].randomPool, undefined);
  assert.deepEqual(validateAssetDocument(doc), doc);
});

test('资产保险库保留 current 与滚动历史，并可从安装目录外恢复', () => {
  const root = temp();
  const dataFile = path.join(root, 'install', 'data', 'showrunner.json');
  const externalDir = path.join(root, 'user-data', 'assets');
  const vault = new AssetVault({ dataFile, externalDir, maxHistory: 3 });
  assert.equal(vault.capture(state('第一集')), true);
  assert.equal(vault.capture(state('第一集')), false);
  assert.equal(vault.capture(state('第二集')), true);
  assert.ok(fs.existsSync(path.join(externalDir, 'current.showrunner.json')));
  assert.equal(fs.readdirSync(path.join(externalDir, 'history')).length, 1);

  fs.rmSync(path.join(root, 'install'), { recursive: true, force: true });
  const restored = new AssetVault({ dataFile, externalDir }).loadCurrent();
  assert.equal(restored.playlists[0].items[0].title, '第二集');
});

test('状态文件损坏时从 .bak 恢复并隔离损坏文件', () => {
  const root = temp();
  const file = path.join(root, 'showrunner.json');
  const store = new Store(file);
  store.save({ value: 1 });
  store.save({ value: 2 });
  fs.writeFileSync(file, '{broken');
  assert.deepEqual(new Store(file).load({}), { value: 1 });
  assert.ok(fs.readdirSync(root).some(name => name.includes('.corrupt-')));
});

test('状态文件损坏且无备份时拒绝以空数据启动', () => {
  const root = temp();
  const file = path.join(root, 'showrunner.json');
  fs.writeFileSync(file, '{broken');
  assert.throws(() => new Store(file).load({ playlists: [] }), /状态文件损坏/);
});

test('HTTP 无损导出后可完整替换恢复频道配置和合集', async t => {
  const root = temp();
  const mediaDir = path.join(root, 'media');
  fs.mkdirSync(mediaDir);
  fs.writeFileSync(path.join(mediaDir, '节目.mp4'), 'video');
  const srv = await start({
    rootDir: path.join(__dirname, '..'), host: '127.0.0.1', port: 0, password: 'test-pwd',
    mediaDirs: [mediaDir], dataFile: path.join(root, 'data', 'showrunner.json'),
    assetVaultDir: path.join(root, 'vault'), cacheDir: path.join(root, 'cache'),
    disableCache: true, disableScheduler: true, disableChannelTimer: true
  });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port}`;
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-pwd' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = (url, options = {}) => fetch(base + '/api' + url, {
    ...options,
    headers: { Cookie: cookie, ...(options.body ? { 'Content-Type': 'application/json' } : {}) }
  });
  const library = await (await call('/library')).json();
  const channel = (await (await call('/playlists', { method: 'POST', body: JSON.stringify({ name: '珍藏频道' }) })).json()).playlist;
  const added = await (await call(`/playlists/${channel.id}/items`, { method: 'POST', body: JSON.stringify({ mediaId: library.items[0].id }) })).json();
  await call(`/playlists/${channel.id}/items/${added.added[0].qid}/timing`, { method: 'POST', body: JSON.stringify({ startTime: '20:00', maxPlaySeconds: 90 }) });
  await call(`/playlists/${channel.id}/options`, { method: 'POST', body: JSON.stringify({ enabled: true, allowOnDemand: true }) });
  const collection = (await (await call('/collections', { method: 'POST', body: JSON.stringify({ name: '珍藏合集' }) })).json()).collection;

  const exported = await (await call('/assets/export')).json();
  assert.equal(exported.playlists[0].items[0].maxPlaySeconds, 90);
  assert.equal(exported.playlists[0].items[0].sourceName, 'media');
  await call(`/playlists/${channel.id}`, { method: 'DELETE' });
  await call(`/collections/${collection.id}`, { method: 'DELETE' });
  const restored = await call('/assets/import', { method: 'POST', body: JSON.stringify({ mode: 'replace', document: exported }) });
  assert.equal(restored.status, 200);
  const result = await restored.json();
  assert.equal(result.binding.unresolved, 0);
  const finalState = await (await call('/state')).json();
  assert.equal(finalState.playlists[0].name, '珍藏频道');
  assert.equal(finalState.playlists[0].allowOnDemand, true);
  assert.equal(finalState.collections[0].name, '珍藏合集');
  assert.equal(srv.playlists.get(channel.id).items[0].startTime, '20:00');
});

test('实时文件丢失或损坏时，服务启动会从安装目录外保险库恢复', async t => {
  const root = temp();
  const dataFile = path.join(root, 'install', 'data', 'showrunner.json');
  const externalDir = path.join(root, 'user-data', 'assets');
  new AssetVault({ dataFile, externalDir }).capture(state('保险库节目'));
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(dataFile, '{broken');
  const srv = await start({
    rootDir: path.join(__dirname, '..'), host: '127.0.0.1', port: 0, password: 'test-pwd',
    mediaDirs: [], dataFile, assetVaultDir: externalDir, cacheDir: path.join(root, 'cache'),
    disableCache: true, disableScheduler: true, disableChannelTimer: true
  });
  t.after(() => srv.close());
  assert.equal(srv.playlists.get('p1').items[0].title, '保险库节目');
  assert.equal(srv.collections.get('c1').name, '合集');
  assert.equal(JSON.parse(fs.readFileSync(dataFile, 'utf8')).schemaVersion, 1);
  assert.ok(fs.readdirSync(path.dirname(dataFile)).some(name => name.includes('.corrupt-')));
});
