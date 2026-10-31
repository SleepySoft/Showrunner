'use strict';
/** 节目单管理：PlaylistManager 单元测试 + API 端到端测试。 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PlaylistManager } = require('../src/playlists');
const { start } = require('../src/server');

// ---------- 单元 ----------

test('创建 / 重命名 / 列表摘要', () => {
  const m = new PlaylistManager(null);
  const p = m.create('周末纪录片');
  assert.equal(m.list().length, 1);
  assert.equal(m.list()[0].count, 0);
  assert.equal(m.list()[0].active, false);
  m.rename(p.id, '改名了');
  assert.equal(m.get(p.id).name, '改名了');
  assert.equal(m.rename('nope', 'x'), false);
});

test('activate / remove 的 wasActive 语义', () => {
  const m = new PlaylistManager(null);
  const a = m.create('A');
  const b = m.create('B');
  m.activate(a.id);
  assert.equal(m.active().name, 'A');
  assert.equal(m.remove(b.id).wasActive, false);
  assert.equal(m.remove(a.id).wasActive, true);
  assert.equal(m.active(), null);
  assert.equal(m.remove('ghost'), null);
});

test('非播出中节目单的条目编辑', () => {
  const m = new PlaylistManager(null);
  const p = m.create('P');
  const i1 = m.addItem(p.id, { type: 'web', url: 'https://x/1', title: 'T1' });
  const i2 = m.addItem(p.id, { type: 'local', mediaId: 'm2', title: 'T2' });
  assert.equal(m.get(p.id).items.length, 2);
  m.moveItem(p.id, i2.qid, 0);
  assert.equal(m.get(p.id).items[0].title, 'T2');
  assert.equal(m.removeItem(p.id, i1.qid), true);
  assert.equal(m.removeItem(p.id, 'nope'), false);
  assert.equal(m.addItem('ghost', {}), null);
});

test('持久化往返 + 损坏 activeId 兜底', () => {
  const m = new PlaylistManager(null);
  const p = m.create('P');
  m.addItem(p.id, { type: 'web', url: 'https://x/1', title: 'T1' });
  m.activate(p.id);
  const m2 = new PlaylistManager(m.serialize());
  assert.equal(m2.active().items.length, 1);
  const m3 = new PlaylistManager({ playlists: [], activeId: 'ghost' });
  assert.equal(m3.activeId, null);
});

// ---------- 端到端 ----------

let tmp, srv, base, cookie;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-pl-'));
  const mediaDir = path.join(tmp, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, '本地片.mp4'), Buffer.alloc(1000, 1));

  srv = await start({
    rootDir: path.join(__dirname, '..'),
    host: '127.0.0.1', port: 0,
    password: 'pw',
    mediaDirs: [mediaDir],
    dataFile: path.join(tmp, 'data.json'),
    cacheDir: path.join(tmp, 'cache'),
    disableCache: true,
    sessionTtlHours: 1
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
const post = (p, body) => authed(p, { method: 'POST', body: JSON.stringify(body) });

let plA, plB;

test('没有播出节目单时，/api/queue 拒绝入列', async () => {
  const lib = await (await authed('/api/library')).json();
  const res = await post('/api/queue', { mediaId: lib.items[0].id });
  assert.equal(res.status, 409);
});

test('创建两个节目单并出现在状态里', async () => {
  plA = (await (await post('/api/playlists', { name: '日常' })).json()).playlist;
  plB = (await (await post('/api/playlists', { name: '周末' })).json()).playlist;
  const r = await (await authed('/api/state')).json();
  assert.equal(r.playlists.length, 2);
  assert.equal(r.activeId, null);
});

test('向非播出节目单添加条目不影响直播队列', async () => {
  const lib = await (await authed('/api/library')).json();
  await post(`/api/playlists/${plA.id}/items`, { mediaId: lib.items[0].id });
  await post(`/api/playlists/${plA.id}/items`, { url: `${base}/tv/` });

  const p = await (await authed(`/api/playlists/${plA.id}`)).json();
  assert.equal(p.playlist.items.length, 2);
  assert.equal(p.playlist.items[0].type, 'local');
  assert.equal(p.playlist.items[1].type, 'web');

  const r = await (await authed('/api/state')).json();
  assert.equal(r.queue.length, 0); // 直播队列不受影响
});

test('播出节目单：队列装入、回到待机', async () => {
  const r = await (await post(`/api/playlists/${plA.id}/activate`)).json();
  assert.equal(r.ok, true);
  assert.equal(r.state.current.title, '本地片');
  assert.equal(r.state.status, 'idle');

  const s = await (await authed('/api/state')).json();
  assert.equal(s.activeId, plA.id);
  assert.equal(s.queue.length, 2);
});

test('编辑播出中的节目单 = 编辑直播队列（共享数组）', async () => {
  const lib = await (await authed('/api/library')).json();
  await post(`/api/playlists/${plA.id}/items`, { mediaId: lib.items[0].id }); // 再加一部本地片
  const s = await (await authed('/api/state')).json();
  assert.equal(s.queue.length, 3); // 经节目单端点添加，队列同步可见
});

test('删除播出中的节目单：队列清空待机', async () => {
  await post('/api/control', { action: 'play' });
  const res = await authed(`/api/playlists/${plA.id}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const s = await (await authed('/api/state')).json();
  assert.equal(s.queue.length, 0);
  assert.equal(s.activeId, null);
  assert.equal(s.state.status, 'idle');
  assert.equal(s.state.current, null);
});

test('切换播出到另一个节目单', async () => {
  const lib = await (await authed('/api/library')).json();
  await post(`/api/playlists/${plB.id}/items`, { mediaId: lib.items[0].id });
  await post(`/api/playlists/${plB.id}/activate`);
  const s = await (await authed('/api/state')).json();
  assert.equal(s.queue.length, 1);
  assert.equal(s.activeId, plB.id);
});

test('节目单操作需要登录 + 404', async () => {
  assert.equal((await fetch(base + '/api/playlists')).status, 401);
  assert.equal((await post('/api/playlists/ghost/activate', {})).status, 404);
  assert.equal((await authed('/api/playlists/ghost', { method: 'DELETE' })).status, 404);
  assert.equal((await post('/api/playlists/ghost/items', { url: `${base}/tv/` })).status, 404);
});

test('节目单与队列持久化到数据文件', async () => {
  const data = JSON.parse(fs.readFileSync(path.join(tmp, 'data.json'), 'utf8'));
  assert.equal(data.playlists.length, 1); // A 已删，剩 B
  assert.equal(data.activeId, plB.id);
  assert.equal(data.playlists[0].items.length, 1);
  assert.ok(typeof data.currentIndex === 'number');
});

test('旧版单队列数据自动迁移为默认节目单', async () => {
  const legacyFile = path.join(tmp, 'legacy.json');
  fs.writeFileSync(legacyFile, JSON.stringify({
    queue: [{ qid: 'q1', type: 'local', mediaId: 'x', title: '旧片子', relPath: 'a.mp4' }],
    currentIndex: 0,
    playback: null
  }));
  const srv2 = await start({
    rootDir: path.join(__dirname, '..'),
    host: '127.0.0.1', port: 0, password: 'pw',
    mediaDirs: [], dataFile: legacyFile, sessionTtlHours: 1,
    cacheDir: path.join(tmp, 'cache2'), disableCache: true
  });
  assert.equal(srv2.playlists.playlists.length, 1);
  assert.equal(srv2.playlists.playlists[0].name, '默认节目单');
  assert.equal(srv2.playlists.activeId, srv2.playlists.playlists[0].id);
  assert.equal(srv2.queue.current().title, '旧片子');
  await srv2.close();
});
