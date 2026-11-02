'use strict';
/**
 * 端到端 API 集成测试：
 * 真实启动服务（临时端口 + 临时媒体目录），覆盖登录鉴权、片库、
 * 队列增删改排、播放控制、Range 流式、WebSocket 推送与自动连播。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { start } = require('../src/server');

let tmp, srv, base, cookie, token;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-api-'));
  const mediaDir = path.join(tmp, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  // 造两个「影片」文件（内容任意，测试流式与 Range 即可）
  fs.writeFileSync(path.join(mediaDir, '宇宙奇观.mp4'), Buffer.alloc(10000, 7));
  fs.writeFileSync(path.join(mediaDir, '深海世界.mp4'), Buffer.alloc(5000, 9));

  srv = await start({
    rootDir: path.join(__dirname, '..'),
    host: '127.0.0.1',
    port: 0, // 随机端口
    password: 'test-pwd',
    mediaDirs: [mediaDir],
    dataFile: path.join(tmp, 'data.json'),
    cacheDir: path.join(tmp, 'cache'),
    disableCache: true, // 集成测试不触发真实 yt-dlp 下载
    sessionTtlHours: 1
  });
  base = `http://127.0.0.1:${srv.port}`;

  const res = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-pwd' })
  });
  assert.equal(res.status, 200);
  cookie = res.headers.get('set-cookie').split(';')[0];
  token = (await res.json()).token;
});

after(async () => {
  await srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const authed = (p, opts = {}) => fetch(base + p, {
  ...opts,
  headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie, ...(opts.headers || {}) }
});

// ---------- 鉴权 ----------

test('未登录访问 API 返回 401', async () => {
  const res = await fetch(base + '/api/state');
  assert.equal(res.status, 401);
});

test('错误密码登录返回 401', async () => {
  const res = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong' })
  });
  assert.equal(res.status, 401);
});

test('登出后会话立即失效', async () => {
  const res = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-pwd' })
  });
  const c = res.headers.get('set-cookie').split(';')[0];
  await fetch(base + '/api/logout', { method: 'POST', headers: { Cookie: c } });
  const res2 = await fetch(base + '/api/state', { headers: { Cookie: c } });
  assert.equal(res2.status, 401);
});

// ---------- 片库 ----------

test('片库列出媒体目录内容', async () => {
  const res = await authed('/api/library');
  const { items } = await res.json();
  assert.equal(items.length, 2);
  assert.ok(items.some(i => i.title === '宇宙奇观'));
});

test('重新扫描接口可用', async () => {
  const res = await authed('/api/library?rescan=1');
  assert.equal(res.status, 200);
});

// ---------- 队列 ----------

let mediaId1, mediaId2;

test('加入队列（批量）', async () => {
  // 多节目单模型：需先创建并播出一个节目单
  const pl = await (await authed('/api/playlists', { method: 'POST', body: JSON.stringify({ name: '测试节目单' }) })).json();
  const act = await authed(`/api/playlists/${pl.playlist.id}/activate`, { method: 'POST' });
  assert.equal(act.status, 200);

  const lib = await (await authed('/api/library')).json();
  mediaId1 = lib.items.find(i => i.title === '宇宙奇观').id;
  mediaId2 = lib.items.find(i => i.title === '深海世界').id;
  const res = await authed('/api/queue', {
    method: 'POST', body: JSON.stringify({ mediaIds: [mediaId1, mediaId2] })
  });
  assert.equal(res.status, 201);
  const { added } = await res.json();
  assert.equal(added.length, 2);
});

test('加入不存在的媒体返回 404', async () => {
  const res = await authed('/api/queue', {
    method: 'POST', body: JSON.stringify({ mediaId: 'ffffffffffffffff' })
  });
  assert.equal(res.status, 404);
});

test('队列状态正确', async () => {
  const { queue, state } = await (await authed('/api/state')).json();
  assert.equal(queue.length, 2);
  assert.equal(state.current.title, '宇宙奇观');
  assert.equal(state.status, 'idle');
});

test('播放控制：play → next → pause → standby', async () => {
  let r = await (await authed('/api/control', { method: 'POST', body: JSON.stringify({ action: 'play' }) })).json();
  assert.equal(r.state.status, 'playing');

  r = await (await authed('/api/control', { method: 'POST', body: JSON.stringify({ action: 'next' }) })).json();
  assert.equal(r.state.current.title, '深海世界');

  r = await (await authed('/api/control', { method: 'POST', body: JSON.stringify({ action: 'pause' }) })).json();
  assert.equal(r.state.status, 'paused');

  r = await (await authed('/api/control', { method: 'POST', body: JSON.stringify({ action: 'standby' }) })).json();
  assert.equal(r.state.status, 'idle');
});

test('未知控制动作返回 400', async () => {
  const res = await authed('/api/control', { method: 'POST', body: JSON.stringify({ action: 'hack' }) });
  assert.equal(res.status, 400);
});

test('排序 move', async () => {
  const { queue } = await (await authed('/api/state')).json();
  const res = await authed('/api/queue/move', {
    method: 'POST', body: JSON.stringify({ qid: queue[1].qid, toIndex: 0 })
  });
  assert.equal(res.status, 200);
  const after = await (await authed('/api/state')).json();
  assert.equal(after.queue[0].title, '深海世界');
  // 排回来，供后续用例使用
  await authed('/api/queue/move', { method: 'POST', body: JSON.stringify({ qid: after.queue[1].qid, toIndex: 0 }) });
});

test('删除条目', async () => {
  const { queue } = await (await authed('/api/state')).json();
  const res = await authed('/api/queue/' + queue[1].qid, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const res2 = await authed('/api/queue/' + queue[1].qid, { method: 'DELETE' });
  assert.equal(res2.status, 404);
  // 补回第二部供 WS 连播测试
  await authed('/api/queue', { method: 'POST', body: JSON.stringify({ mediaId: mediaId2 }) });
});

// ---------- 流式 ----------

test('完整流式下载', async () => {
  const res = await fetch(`${base}/media/${mediaId1}/stream`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.length, 10000);
});

test('Range 分段请求返回 206 与正确切片', async () => {
  const res = await fetch(`${base}/media/${mediaId1}/stream`, { headers: { Range: 'bytes=100-199' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 100-199/10000');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.length, 100);
  assert.equal(buf[0], 7);
});

test('越界 Range 返回 416', async () => {
  const res = await fetch(`${base}/media/${mediaId1}/stream`, { headers: { Range: 'bytes=99999-' } });
  assert.equal(res.status, 416);
});

test('未登记媒体 ID 返回 404（无目录穿越）', async () => {
  const res = await fetch(`${base}/media/..%2f..%2fetc/stream`);
  assert.equal(res.status, 404);
});

// ---------- WebSocket ----------

function openWs(role, tk) {
  return new Promise((resolve, reject) => {
    const endpoint = role === 'tv' ? '/ws-tv' : '/ws-remote';
    const url = `ws://127.0.0.1:${srv.port}${endpoint}` + (tk ? `?token=${tk}` : '');
    const ws = new WebSocket(url);
    // 消息缓冲：解决「消息在监听挂上之前到达」的竞态
    const inbox = [];
    const waiters = [];
    ws.on('message', d => {
      let msg;
      try { msg = JSON.parse(d); } catch { return; }
      if (waiters.length) waiters.shift()(msg);
      else inbox.push(msg);
    });
    ws.next = () => inbox.length ? Promise.resolve(inbox.shift()) : new Promise(r => waiters.push(r));
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

test('遥控器 WS 无 token 被拒', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws-remote`);
  const code = await new Promise(resolve => {
    ws.on('close', c => resolve(c));
    ws.on('error', () => resolve(-1));
  });
  assert.equal(code, 4401); // 服务端完成握手后立即以 4401 关闭
});

test('遥控器 WS 可用 HttpOnly 会话 Cookie 鉴权，无需在 URL 暴露 token', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws-remote`, { headers: { Cookie: cookie } });
  const first = await new Promise((resolve, reject) => {
    ws.once('message', d => resolve(JSON.parse(d)));
    ws.once('error', reject);
  });
  assert.equal(first.type, 'state');
  ws.close();
});

test('电视端连接即收状态，控制变更实时推送', async () => {
  const tv = await openWs('tv');
  const first = await tv.next();
  assert.equal(first.type, 'state');
  assert.ok('current' in first.data);

  const waiting = tv.next();
  await authed('/api/control', { method: 'POST', body: JSON.stringify({ action: 'play' }) });
  const pushed = await waiting;
  assert.equal(pushed.data.status, 'playing');
  tv.close();
});

test('电视上报 ended → 服务端自动连播下一部', async () => {
  const tv = await openWs('tv');
  await tv.next(); // 初始状态

  const waiting = tv.next();
  tv.send(JSON.stringify({ type: 'ended' }));
  const pushed = await waiting;
  assert.equal(pushed.data.current.title, '深海世界');
  assert.equal(pushed.data.position, 0);
  tv.close();
});

test('电视上报 position 不引发广播风暴', async () => {
  const remote = await openWs('remote', token);
  await remote.next(); // 初始状态
  const tv = await openWs('tv');
  await tv.next();

  let gotBroadcast = false;
  remote.on('message', () => { gotBroadcast = true; });
  tv.send(JSON.stringify({ type: 'position', position: 12.5, duration: 100 }));
  await new Promise(r => setTimeout(r, 300));
  assert.equal(gotBroadcast, false);
  assert.equal(srv.queue.playback.position, 12.5); // 但服务端已记录
  tv.close();
  remote.close();
});

test('遥控器端不能伪造 ended/position 上报', async () => {
  const remote = await openWs('remote', token);
  await remote.next();
  const before = srv.queue.playback.position;
  remote.send(JSON.stringify({ type: 'position', position: 9999 }));
  await new Promise(r => setTimeout(r, 200));
  assert.equal(srv.queue.playback.position, before);
  remote.close();
});

test('电视端可在多个启用频道间切换，并仅在授权后点播', async () => {
  const before = await (await authed('/api/state')).json();
  const originalId = before.activeId;
  const created = await (await authed('/api/playlists', {
    method: 'POST', body: JSON.stringify({ name: '点播频道' })
  })).json();
  const channelId = created.playlist.id;
  const add = await (await authed(`/api/playlists/${channelId}/items`, {
    method: 'POST', body: JSON.stringify({ mediaId: mediaId1 })
  })).json();
  await authed(`/api/playlists/${channelId}/options`, {
    method: 'POST', body: JSON.stringify({ enabled: true, allowOnDemand: true, autoPlay: false })
  });

  const tv = await openWs('tv');
  const initial = await tv.next();
  assert.equal(initial.data.channels.length, 2);
  const vod = initial.data.channels.find(c => c.id === channelId);
  assert.equal(vod.allowOnDemand, true);
  assert.equal(vod.items[0].qid, add.added[0].qid);

  tv.send(JSON.stringify({ type: 'selectChannel', channelId }));
  let selected;
  for (let i = 0; i < 6; i++) {
    selected = await tv.next();
    if (selected.data?.selectedChannelId === channelId && selected.data.waiting?.reason === 'on-demand') break;
  }
  assert.equal(selected.data.selectedChannelId, channelId);
  assert.equal(selected.data.waiting.reason, 'on-demand');

  tv.send(JSON.stringify({ type: 'onDemand', qid: add.added[0].qid }));
  let playing;
  for (let i = 0; i < 4; i++) {
    playing = await tv.next();
    if (playing.data?.status === 'playing' && playing.data.current?.qid === add.added[0].qid) break;
  }
  assert.equal(playing.data.current.title, '宇宙奇观');
  tv.close();

  await authed(`/api/playlists/${channelId}`, { method: 'DELETE' });
  await authed(`/api/playlists/${originalId}/activate`, { method: 'POST' });
});

// ---------- 静态页 ----------

test('电视端与遥控器页面可访问', async () => {
  const tvRes = await fetch(base + '/tv/');
  assert.equal(tvRes.status, 200);
  const tvHtml = await tvRes.text();
  assert.match(tvHtml, /key === 'ArrowUp'.*key === 'ArrowLeft'/s);
  assert.match(tvHtml, /key === 'ArrowDown'.*key === 'ArrowRight'/s);
  assert.match(tvHtml, /key === 'Enter'.*key === 'OK'/s);
  assert.match(tvHtml, /contextmenu[\s\S]*remoteMenuKey\(\)/);
  assert.match(tvHtml, /菜单外等同取消/);
  assert.match(tvHtml, /compatibilityRequest/);
  assert.match(tvHtml, /reason: 'compatibility_failed'/);
  assert.doesNotMatch(tvHtml, /addEventListener\('mousemove'/);
  assert.match(tvHtml, /音量、电源等系统键不拦截/);
  const remoteRes = await fetch(base + '/remote/');
  assert.equal(remoteRes.status, 200);
  const remoteHtml = await remoteRes.text();
  assert.match(remoteHtml, /draftSelected \?\? options\.initialSelected/);
  assert.match(remoteHtml, /initialSelected: c\.items[\s\S]*draftSelected: pendingLocalIds/);
  assert.equal((await fetch(base + '/')).status, 200); // 重定向跟随
});
