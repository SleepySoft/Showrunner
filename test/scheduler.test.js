'use strict';
/**
 * 播出时刻表（scheduler）纯函数与状态机测试 + 集成测试：
 * 合集入列播出、时刻表 CRUD 与跃迁、循环开关、节目表导出。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Scheduler, matchRule, decide, parseHM } = require('../src/scheduler');
const { start } = require('../src/server');

// ---------- 纯函数 ----------

const at = (day, h, m) => {
  // 2026-10-25 是周日（day 0），由此偏移构造任意星期
  const d = new Date(2026, 9, 25 + day, h, m, 0);
  assert.equal(d.getDay(), day);
  return d;
};

test('parseHM 解析与非法输入', () => {
  assert.equal(parseHM('18:30'), 18 * 60 + 30);
  assert.equal(parseHM('8:05'), 8 * 60 + 5);
  assert.equal(parseHM('24:00'), null);
  assert.equal(parseHM('18:60'), null);
  assert.equal(parseHM('abc'), null);
  assert.equal(parseHM(''), null);
});

test('matchRule 命中星期与时段，边界正确', () => {
  const rules = [{ id: 'r1', playlistId: 'p1', days: [1, 2, 3, 4, 5], start: '18:00', end: '20:00' }];
  assert.equal(matchRule(rules, at(3, 18, 0))?.id, 'r1');  // 周三 18:00 命中（含起点）
  assert.equal(matchRule(rules, at(3, 19, 59))?.id, 'r1');
  assert.equal(matchRule(rules, at(3, 20, 0)), null);      // 不含终点
  assert.equal(matchRule(rules, at(3, 17, 59)), null);
  assert.equal(matchRule(rules, at(6, 18, 30)), null);     // 周六不命中
});

test('matchRule 多条命中取靠前规则；跨午夜规则不命中', () => {
  const rules = [
    { id: 'first', playlistId: 'p1', days: [6], start: '18:00', end: '22:00' },
    { id: 'second', playlistId: 'p2', days: [6], start: '19:00', end: '21:00' }
  ];
  assert.equal(matchRule(rules, at(6, 20, 0))?.id, 'first');
  const overnight = [{ id: 'on', playlistId: 'p1', days: [6], start: '22:00', end: '02:00' }];
  assert.equal(matchRule(overnight, at(6, 23, 0)), null); // e <= s 被跳过
});

test('decide 只在跃迁时动作（transition-only）', () => {
  const rules = [{ id: 'r1', playlistId: 'p1', days: [1], start: '18:00', end: '20:00' }];
  // 进入窗口
  assert.deepEqual(decide(rules, at(1, 18, 0), null).action, 'switch');
  // 同规则已在生效 → 不动（家长手动切台不被抢回）
  assert.equal(decide(rules, at(1, 18, 30), { ruleId: 'r1' }).action, 'none');
  // 离开窗口 → 待机
  assert.equal(decide(rules, at(1, 20, 0), { ruleId: 'r1' }).action, 'standby');
  // 本来就没在窗口内 → 不动
  assert.equal(decide(rules, at(2, 10, 0), null).action, 'none');
  // 换了一条规则命中 → 切换
  const rules2 = [...rules, { id: 'r2', playlistId: 'p2', days: [1], start: '18:00', end: '20:00' }];
  // r1 排在前，仍命中 r1 → none
  assert.equal(decide(rules2, at(1, 18, 30), { ruleId: 'r1' }).action, 'none');
});

test('Scheduler add 校验与序列化、remove 清理 last', () => {
  const s = new Scheduler(null);
  assert.ok(s.add({ playlistId: 'p1', days: [], start: '18:00', end: '19:00' }).error);
  assert.ok(s.add({ playlistId: 'p1', days: [1], start: '19:00', end: '18:00' }).error);
  assert.ok(s.add({ playlistId: '', days: [1], start: '18:00', end: '19:00' }).error);
  const { rule } = s.add({ playlistId: 'p1', days: [3, 1, 1], start: '8:05', end: '9:30', loop: true });
  assert.deepEqual(rule.days, [1, 3]);        // 去重排序
  assert.equal(rule.start, '08:05');          // 规范化
  assert.equal(rule.loop, true);

  // 序列化往返
  const s2 = new Scheduler({ settings: { schedules: s.serialize() } });
  assert.equal(s2.list().length, 1);

  // 删掉生效中的规则 → 下个 tick 应决定待机
  s2.applied(rule.id);
  assert.equal(s2.remove(rule.id), true);
  assert.equal(s2.tick(at(1, 8, 30)).action, 'standby');
  assert.equal(s2.remove('不存在'), false);
});

// ---------- 集成：HTTP 层 ----------

let tmp, srv, base, cookie, mediaId;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-tv-'));
  const mediaDir = path.join(tmp, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, '地球脉动E1.mp4'), Buffer.alloc(1000, 1));
  fs.writeFileSync(path.join(mediaDir, '地球脉动E2.mp4'), Buffer.alloc(1000, 2));

  srv = await start({
    rootDir: path.join(__dirname, '..'),
    host: '127.0.0.1',
    port: 0,
    password: 'test-pwd',
    mediaDirs: [mediaDir],
    dataFile: path.join(tmp, 'data.json'),
    cacheDir: path.join(tmp, 'cache'),
    disableCache: true,
    disableScheduler: true, // 关掉 15 秒自动 tick，测试里手动对齐
    siteCollectionImporter: async url => ({
      ok: true,
      title: '网站纪录片',
      entries: [
        { title: '网站第一集', url: url + '?p=1' },
        { title: '网站第二集', url: url + '?p=2' }
      ]
    }),
    sessionTtlHours: 1
  });
  base = `http://127.0.0.1:${srv.port}`;
  const res = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-pwd' })
  });
  cookie = res.headers.get('set-cookie').split(';')[0];
});

after(async () => {
  await srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const authed = (p, opts = {}) => fetch(base + p, {
  ...opts,
  headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie, ...(opts.headers || {}) }
});
const post = (p, body) => authed(p, { method: 'POST', body: JSON.stringify(body) });

let playlistId, collectionId;

test('建立节目单并播出', async () => {
  const lib = await (await authed('/api/library')).json();
  mediaId = lib.items.find(i => i.title === '地球脉动E1').id;
  const pl = await (await post('/api/playlists', { name: '每日纪录片' })).json();
  playlistId = pl.playlist.id;
  assert.equal((await post(`/api/playlists/${playlistId}/activate`)).status, 200);
});

test('合集：创建 → 加两集 → 禁止嵌套', async () => {
  const c = await (await post('/api/collections', { name: '地球脉动' })).json();
  collectionId = c.collection.id;

  const lib = await (await authed('/api/library')).json();
  const ids = lib.items.map(i => i.id);
  const r = await post(`/api/collections/${collectionId}/items`, { mediaIds: ids });
  assert.equal(r.status, 201);
  assert.equal((await r.json()).added.length, 2);

  // 嵌套合集被拒
  const nest = await post(`/api/collections/${collectionId}/items`, { collectionId });
  assert.equal(nest.status, 400);
});

test('从网站链接创建并批量导入合集', async () => {
  const r = await post('/api/collections/import', { url: 'https://example.com/series' });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.collection.name, '网站纪录片');
  assert.equal(body.imported, 2);

  const detail = await (await authed(`/api/collections/${body.collection.id}`)).json();
  assert.deepEqual(detail.collection.items.map(i => i.title), ['网站第一集', '网站第二集']);
  assert.ok(detail.collection.items.every(i => i.type === 'web'));

  // 不影响本文件后续对原合集数量的断言
  assert.equal((await authed(`/api/collections/${body.collection.id}`, { method: 'DELETE' })).status, 200);
});

test('合集抽一集入列 → 播出显示第1集，再轮到播第2集', async () => {
  const r = await post(`/api/playlists/${playlistId}/items`, { collectionId });
  assert.equal(r.status, 201);

  await post('/api/control', { action: 'play' });
  let st = await (await authed('/api/state')).json();
  assert.equal(st.state.current.type, 'local');
  assert.equal(st.state.current.title, '《地球脉动》第1集 地球脉动E1');

  // 队列里再放一个合集条目，模拟「明天又轮到它」
  await post(`/api/playlists/${playlistId}/items`, { collectionId });
  await post('/api/control', { action: 'next' });
  st = await (await authed('/api/state')).json();
  assert.equal(st.state.current.title, '《地球脉动》第2集 地球脉动E2');

  // 合集进度持久化到数据文件
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'data.json'), 'utf8'));
  const col = saved.collections.find(c => c.id === collectionId);
  assert.equal(col.cursor, 0); // 两集播完游标已回卷
});

test('循环开关路由作用于直播队列', async () => {
  const r = await post(`/api/playlists/${playlistId}/loop`, { loop: true });
  assert.equal((await r.json()).loop, true);
  assert.equal(srv.queue.loop, true);

  // 跳到队尾再 next → 回卷到第一部
  const st0 = await (await authed('/api/state')).json();
  const lastItem = st0.queue[st0.queue.length - 1];
  await post('/api/control', { action: 'jump', qid: lastItem.qid });
  await post('/api/control', { action: 'next' }); // 回卷
  assert.equal(srv.queue.currentIndex, 0);
  assert.equal(srv.queue.getPublicState().status, 'playing');

  await post(`/api/playlists/${playlistId}/loop`, { loop: false });
  assert.equal(srv.queue.loop, false);
});

test('时刻表 CRUD + 校验 + 导出', async () => {
  // 非法规则
  assert.equal((await post('/api/schedules', { playlistId, days: [], start: '18:00', end: '19:00' })).status, 400);
  assert.equal((await post('/api/schedules', { playlistId: 'no-such', days: [1], start: '18:00', end: '19:00' })).status, 404);

  // 覆盖今天全天窗口的规则
  const now = new Date();
  const r = await post('/api/schedules', {
    playlistId, days: [now.getDay()], start: '00:00', end: '23:59', loop: true
  });
  assert.equal(r.status, 201);
  const { rule } = await r.json();
  // 新建后已立即对齐：正在播出该节目单且 loop 生效
  assert.equal(srv.queue.getPublicState().status, 'playing');
  assert.equal(srv.queue.loop, true);

  const list = await (await authed('/api/schedules')).json();
  assert.equal(list.rules.length, 1);
  assert.equal(list.rules[0].playlistName, '每日纪录片');

  // /api/state 也带时刻表
  const st = await (await authed('/api/state')).json();
  assert.equal(st.schedules.length, 1);
  assert.ok(Array.isArray(st.collections));

  // 删除规则 → 立即对齐待机（当前时刻无命中规则）
  const del = await authed(`/api/schedules/${rule.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal(srv.queue.getPublicState().status, 'idle');

  // 导出 JSON
  const exp = await (await authed('/api/export')).json();
  assert.equal(exp.playlists.length, 1);
  assert.equal(exp.collections.length, 1);
  assert.equal(exp.collections[0].items.length, 2);

  // 导出 Markdown 节目表
  const mdRes = await authed('/api/export.md');
  assert.equal(mdRes.status, 200);
  assert.match(mdRes.headers.get('content-type'), /text\/markdown/);
  assert.match(mdRes.headers.get('content-disposition'), /attachment/);
  const md = await mdRes.text();
  assert.match(md, /# Showrunner 节目表/);
  assert.match(md, /每日纪录片/);
  assert.match(md, /《地球脉动》抽一集/);
  assert.match(md, /## 合集/);
});

test('applySchedulerTick 手动注入时钟：窗口外待机，窗口内切台', async () => {
  // 当前无规则：注入任何时钟都是 none
  assert.equal(srv.applySchedulerTick(new Date(2026, 9, 28, 12, 0)).action, 'none');

  // 加一条周三 10:00-11:00 的规则，但路由创建时会以「当前真实时间」对齐一次（不命中，none）
  const r = await post('/api/schedules', { playlistId, days: [3], start: '10:00', end: '11:00', loop: true });
  const { rule } = await r.json();
  // 防测试恰好在周三 10 点运行：清掉 last，保证注入时钟后一定重新跃迁
  srv.scheduler.applied(null);

  // 注入周三 10:30 → switch 并开播
  const d = srv.applySchedulerTick(new Date(2026, 9, 28, 10, 30));
  assert.equal(d.action, 'switch');
  assert.equal(srv.queue.getPublicState().status, 'playing');
  assert.equal(srv.queue.loop, true);
  assert.equal(srv.playlists.activeId, playlistId);

  // 同窗口再 tick → none（不重复动作）
  assert.equal(srv.applySchedulerTick(new Date(2026, 9, 28, 10, 45)).action, 'none');
  assert.equal(srv.queue.getPublicState().status, 'playing');

  // 离开窗口 → standby
  assert.equal(srv.applySchedulerTick(new Date(2026, 9, 28, 11, 0)).action, 'standby');
  assert.equal(srv.queue.getPublicState().status, 'idle');

  await authed(`/api/schedules/${rule.id}`, { method: 'DELETE' });
});

test('规则指向已删除节目单：切换失败不产生崩溃', async () => {
  const pl = await (await post('/api/playlists', { name: '临时' })).json();
  const r = await post('/api/schedules', { playlistId: pl.playlist.id, days: [3], start: '10:00', end: '11:00' });
  const { rule } = await r.json();
  await authed(`/api/playlists/${pl.playlist.id}`, { method: 'DELETE' });
  // 注入窗口内时钟：switchToPlaylist 返回 false，不 applied，下轮还会再试
  const d = srv.applySchedulerTick(new Date(2026, 9, 28, 10, 30));
  assert.equal(d.action, 'switch');
  assert.equal(srv.scheduler.last, null);
  await authed(`/api/schedules/${rule.id}`, { method: 'DELETE' });
});
