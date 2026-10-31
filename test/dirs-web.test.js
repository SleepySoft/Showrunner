'use strict';
/** 目录管理 / 文件浏览 / 网页片源入列 的端到端测试。 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('../src/server');

let tmp, srv, base, cookie;
let dirA, dirB;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-dirs-'));
  dirA = path.join(tmp, '电影');
  dirB = path.join(tmp, '纪录片');
  fs.mkdirSync(path.join(dirA, '子目录'), { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  fs.writeFileSync(path.join(dirA, '甲方乙方.mp4'), Buffer.alloc(1000, 1));
  fs.writeFileSync(path.join(dirB, '舌尖上的中国.mp4'), Buffer.alloc(1000, 2));
  fs.writeFileSync(path.join(dirA, 'readme.txt'), 'x');

  srv = await start({
    rootDir: path.join(__dirname, '..'),
    host: '127.0.0.1', port: 0,
    password: 'pw',
    mediaDirs: [], // 从空目录开始，全靠网页添加
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

  // 多节目单模型：入列需先创建并播出一个节目单
  const pl = await (await fetch(base + '/api/playlists', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: '默认' })
  })).json();
  await fetch(base + `/api/playlists/${pl.playlist.id}/activate`, {
    method: 'POST', headers: { Cookie: cookie }
  });
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

// ---------- 文件浏览 ----------

test('浏览根位置返回可用入口', async () => {
  const r = await (await authed('/api/browse')).json();
  assert.ok(Array.isArray(r.dirs));
  assert.ok(r.dirs.length >= 1); // win: 盘符；其他: '/'
});

test('浏览目录列出子目录与影片数', async () => {
  const r = await (await authed('/api/browse?path=' + encodeURIComponent(dirA))).json();
  assert.equal(r.path, path.resolve(dirA));
  assert.equal(r.videoCount, 1); // readme.txt 不算
  assert.deepEqual(r.dirs.map(d => d.name), ['子目录']);
  assert.ok(r.parent);
});

test('浏览不存在目录返回 400', async () => {
  const res = await authed('/api/browse?path=' + encodeURIComponent(path.join(tmp, 'nope')));
  assert.equal(res.status, 400);
});

test('浏览接口需要登录', async () => {
  const res = await fetch(base + '/api/browse');
  assert.equal(res.status, 401);
});

// ---------- 目录管理 ----------

test('网页添加目录后片库立即可见', async () => {
  const res = await post('/api/dirs', { path: dirA });
  assert.equal(res.status, 201);
  const { dirs } = await res.json();
  assert.deepEqual(dirs, [path.resolve(dirA)]);

  const lib = await (await authed('/api/library')).json();
  assert.equal(lib.items.length, 1);
  assert.equal(lib.items[0].title, '甲方乙方');
});

test('重复添加同一目录不产生重复项', async () => {
  await post('/api/dirs', { path: dirA });
  const { dirs } = await (await authed('/api/dirs')).json();
  assert.equal(dirs.length, 1);
});

test('添加不存在的目录返回 400', async () => {
  const res = await post('/api/dirs', { path: path.join(tmp, 'ghost') });
  assert.equal(res.status, 400);
});

test('添加文件而非目录返回 400', async () => {
  const res = await post('/api/dirs', { path: path.join(dirA, 'readme.txt') });
  assert.equal(res.status, 400);
});

test('目录变更持久化到数据文件', async () => {
  await post('/api/dirs', { path: dirB });
  const data = JSON.parse(fs.readFileSync(path.join(tmp, 'data.json'), 'utf8'));
  assert.deepEqual(data.settings.mediaDirs, [path.resolve(dirA), path.resolve(dirB)]);
});

test('移除目录后片库同步减少', async () => {
  const res = await authed('/api/dirs', { method: 'DELETE', body: JSON.stringify({ path: dirA }) });
  assert.equal(res.status, 200);
  const lib = await (await authed('/api/library')).json();
  assert.equal(lib.items.length, 1);
  assert.equal(lib.items[0].title, '舌尖上的中国');
});

// ---------- 网页片源入列 ----------

test('贴链接入列：标题自动解析，类型为 web', async () => {
  // 用本服务的 /tv/ 页面当「网页片源」，其 <title> 为 Showrunner 电视端
  const res = await post('/api/queue', { url: `${base}/tv/` });
  assert.equal(res.status, 201);
  const { added } = await res.json();
  assert.equal(added[0].type, 'web');
  assert.equal(added[0].title, 'Showrunner 电视端');
  assert.equal(added[0].url, `${base}/tv/`);
});

test('非法链接返回 400', async () => {
  assert.equal((await post('/api/queue', { url: 'not a url' })).status, 400);
  assert.equal((await post('/api/queue', { url: 'ftp://x/y' })).status, 400);
});

test('抓不到标题时退化为「主机名+路径」，入列依然成功', async () => {
  // 指向一个不存在页面的地址：本服务 404 页无 <title>
  const res = await post('/api/queue', { url: `${base}/no-such-page` });
  assert.equal(res.status, 201);
  const { added } = await res.json();
  assert.equal(added[0].title, `127.0.0.1:${srv.port}/no-such-page`);
});

test('网页片源进入公开状态（电视端可见 type=web）', async () => {
  const { queue } = await (await authed('/api/state')).json();
  const web = queue.filter(i => i.type === 'web');
  assert.ok(web.length >= 2);
});
