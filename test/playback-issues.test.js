'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { start } = require('../src/server');
const { PlaybackIssueLogger } = require('../src/playback-issues');
const { mediaId } = require('../src/library');

test('播放异常写入单行 JSON 日志', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-issue-log-'));
  try {
    const file = path.join(tmp, 'events.log');
    const logger = new PlaybackIssueLogger(file);
    const event = logger.record(
      { kind: 'frozen', detail: '20 秒无进度', qid: 'q1', position: 12, duration: 100, readyState: 2, networkState: 2 },
      { qid: 'q1', title: '测试片', type: 'local' },
      {}
    );
    assert.equal(event.kind, 'frozen');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), event);
    assert.deepEqual(logger.recent(10), [event]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('电视通过 WS 报告当前节目异常后立即跳过，并拒绝过期 qid', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-issue-skip-'));
  let app;
  try {
    const dataFile = path.join(tmp, 'showrunner.json');
    const logFile = path.join(tmp, 'playback-events.log');
    fs.writeFileSync(dataFile, JSON.stringify({
      playlists: [{ id: 'p1', name: '频道', enabled: true, autoPlay: true, items: [
        { qid: 'q1', type: 'local', mediaId: 'm1', title: '坏片' },
        { qid: 'q2', type: 'local', mediaId: 'm2', title: '好片' }
      ] }],
      activeId: 'p1', currentIndex: 0,
      playback: { status: 'playing', position: 8, duration: 100, volume: 1 },
      settings: {}, collections: []
    }));
    app = await start({
      rootDir: path.join(__dirname, '..'), password: 'pw', sessionTtlHours: 1,
      host: '127.0.0.1', port: 0,
      dataFile, mediaDirs: [], cacheDir: path.join(tmp, 'cache'), disableCache: true,
      playbackIssueLog: logFile, disableScheduler: true, disableChannelTimer: true, manageBrowser: false
    });
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws-tv`);
    const messages = [];
    ws.on('message', raw => messages.push(JSON.parse(raw)));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    while (!messages.length) await new Promise(resolve => setTimeout(resolve, 5));
    ws.send(JSON.stringify({ type: 'playbackIssue', qid: 'stale', kind: 'frozen' }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fs.existsSync(logFile), false);
    ws.send(JSON.stringify({ type: 'playbackIssue', qid: 'q1', kind: 'media_error', detail: 'decode', position: 8 }));
    for (let i = 0; i < 100 && app.queue.current()?.qid !== 'q2'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(app.queue.current().qid, 'q2');
    const event = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
    assert.equal(event.qid, 'q1');
    assert.equal(event.title, '坏片');
    assert.equal(event.kind, 'media_error');
    const login = await fetch(`http://127.0.0.1:${app.port}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw' })
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const diagnostics = await (await fetch(`http://127.0.0.1:${app.port}/api/diagnostics/playback`, { headers: { Cookie: cookie } })).json();
    assert.equal(diagnostics.events[0].title, '坏片');
    assert.ok(Array.isArray(diagnostics.compatibility));
    ws.close();
  } finally {
    if (app) await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('电视报告格式不支持时启动兼容转换而不是跳过节目', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-compat-ws-'));
  let app;
  try {
    const mediaDir = path.join(tmp, 'media'); fs.mkdirSync(mediaDir);
    fs.writeFileSync(path.join(mediaDir, 'legacy.avi'), 'fake');
    const id = mediaId('legacy.avi');
    const dataFile = path.join(tmp, 'showrunner.json');
    const logFile = path.join(tmp, 'events.log');
    fs.writeFileSync(dataFile, JSON.stringify({
      playlists: [{ id: 'p1', name: '频道', enabled: true, items: [{ qid: 'q1', type: 'local', mediaId: id, title: '老视频' }] }],
      activeId: 'p1', currentIndex: 0, playback: { status: 'playing' }, settings: {}, collections: []
    }));
    class FakeCompatibility extends EventEmitter {
      ensure(item) { this.requested = item; return { status: 'pending' }; }
      decorate() { return {}; }
      resolveFile() { return null; }
      brief() { return []; }
    }
    const compatibilityManager = new FakeCompatibility();
    app = await start({
      rootDir: path.join(__dirname, '..'), password: 'pw', host: '127.0.0.1', port: 0,
      dataFile, mediaDirs: [mediaDir], cacheDir: path.join(tmp, 'cache'), disableCache: true,
      compatibilityManager, playbackIssueLog: logFile, disableScheduler: true, disableChannelTimer: true, manageBrowser: false
    });
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws-tv`);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'compatibilityRequest', qid: 'q1', detail: 'MEDIA_ERR_SRC_NOT_SUPPORTED' }));
    for (let i = 0; i < 100 && !compatibilityManager.requested; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(compatibilityManager.requested.id, id);
    assert.equal(app.queue.current().qid, 'q1');
    assert.equal(JSON.parse(fs.readFileSync(logFile, 'utf8').trim()).kind, 'compatibility_fallback');
    ws.close();
  } finally {
    if (app) await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
