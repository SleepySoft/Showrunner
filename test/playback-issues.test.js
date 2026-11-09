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

test('mpv 音频输出未启动只记录不跳过节目，诊断页返回打码的 mpv 日志尾部', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-mpv-audio-fail-'));
  let app;
  try {
    const dataFile = path.join(tmp, 'showrunner.json');
    const logFile = path.join(tmp, 'playback-events.log');
    const mpvLogFile = path.join(tmp, 'logs', 'mpv.log');
    fs.mkdirSync(path.dirname(mpvLogFile), { recursive: true });
    fs.writeFileSync(mpvLogFile, 'line one\n[ao/wasapi] Init wasapi failed D:\\Download\\某剧\\E01.mkv extra\n');
    fs.writeFileSync(dataFile, JSON.stringify({
      playlists: [{ id: 'p1', name: '频道', enabled: true, autoPlay: true, items: [
        { qid: 'q1', type: 'local', mediaId: 'm1', title: '正片' },
        { qid: 'q2', type: 'local', mediaId: 'm2', title: '下一集' }
      ] }],
      activeId: 'p1', currentIndex: 0,
      playback: { status: 'playing', position: 8, duration: 100, volume: 1 },
      settings: {}, collections: []
    }));
    class FakeMpv extends EventEmitter {
      constructor() { super(); this.running = false; }
      async start() { this.running = true; return true; }
      async stop() { this.running = false; }
      async load() {}
      async play() {}
      async pause() {}
      async seek() {}
      async setVolume() {}
      async showStandby() {}
      async showMenu() {}
      status() { return { type: 'mpv', available: true, running: this.running, ready: this.running, currentQid: null, lastError: null }; }
    }
    const mpvFrontend = new FakeMpv();
    app = await start({
      rootDir: path.join(__dirname, '..'), password: 'pw', sessionTtlHours: 1,
      host: '127.0.0.1', port: 0,
      dataFile, mediaDirs: [], cacheDir: path.join(tmp, 'cache'), disableCache: true,
      playbackIssueLog: logFile, disableScheduler: true, disableChannelTimer: true, manageBrowser: false,
      playerFrontend: 'mpv', mpvFrontend, mpvLogPath: mpvLogFile
    });
    mpvFrontend.emit('audioFailed', { qid: 'q1' });
    await new Promise(resolve => setTimeout(resolve, 50));
    const event = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
    assert.equal(event.kind, 'mpv_no_audio');
    assert.equal(event.qid, 'q1');
    assert.equal(app.queue.current().qid, 'q1', '音频输出故障不跳过节目');

    const login = await fetch(`http://127.0.0.1:${app.port}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw' })
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const diagnostics = await (await fetch(`http://127.0.0.1:${app.port}/api/diagnostics/playback`, { headers: { Cookie: cookie } })).json();
    assert.ok(Array.isArray(diagnostics.mpvLog));
    const joined = diagnostics.mpvLog.join('\n');
    assert.ok(!joined.includes('D:\\Download'), 'mpv 日志中的绝对路径必须打码');
    assert.ok(joined.includes('<路径>'));
  } finally {
    if (app) await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('遥控器按键连发簇报文在服务端合并，每动作独立计窗', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-input-debounce-'));
  let app;
  try {
    const dataFile = path.join(tmp, 'showrunner.json');
    fs.writeFileSync(dataFile, JSON.stringify({
      playlists: [{ id: 'p1', name: '频道', enabled: true, autoPlay: true, items: [
        { qid: 'q1', type: 'local', mediaId: 'm1', title: '正片' }
      ] }],
      activeId: 'p1', currentIndex: 0,
      playback: { status: 'idle', position: 0, duration: 0, volume: 1 },
      settings: {}, collections: []
    }));
    const menus = [];
    const standbys = [];
    class FakeMpv extends EventEmitter {
      constructor() { super(); this.running = true; }
      async start() { this.running = true; return true; }
      async stop() { this.running = false; }
      async load() {} async play() {} async pause() {} async seek() {}
      async setVolume() {}
      async showStandby() { standbys.push(1); }
      showMenu(model) { menus.push(model); }
      status() { return { type: 'mpv', available: true, running: this.running, ready: this.running, currentQid: null, lastError: null }; }
    }
    const mpvFrontend = new FakeMpv();
    app = await start({
      rootDir: path.join(__dirname, '..'), password: 'pw', host: '127.0.0.1', port: 0,
      dataFile, mediaDirs: [], cacheDir: path.join(tmp, 'cache'), disableCache: true,
      playbackIssueLog: path.join(tmp, 'events.log'), disableScheduler: true, disableChannelTimer: true,
      manageBrowser: false, playerFrontend: 'mpv', mpvFrontend
    });
    mpvFrontend.emit('input', 'menu');
    await new Promise(r => setTimeout(r, 10));
    mpvFrontend.emit('input', 'menu'); // 连发簇内重复报文：应被吞掉
    await new Promise(r => setTimeout(r, 10));
    mpvFrontend.emit('input', 'menu');
    assert.equal(menus.length, 1, '连发簇内重复的 menu 只生效一次');
    mpvFrontend.emit('input', 'up');
    mpvFrontend.emit('input', 'up'); // 连发簇内：第二步被吞
    assert.equal(menus.length, 2, 'up 连发簇内只移动一步');
    await new Promise(r => setTimeout(r, 460));
    mpvFrontend.emit('input', 'up'); // 簇安静后恢复移动
    assert.equal(menus.length, 3, 'up 簇安静后恢复一步移动');
    await new Promise(r => setTimeout(r, 460));
    mpvFrontend.emit('input', 'menu'); // 簇安静后正常生效，此时菜单开着 → 关闭
    assert.equal(menus.length, 3, '关闭菜单不再刷新 OSD 菜单');
    await new Promise(r => setTimeout(r, 460));
    mpvFrontend.emit('input', 'menu'); // 再安静一个窗口：重新打开（manage=false 时关闭路径无界面副作用，用再开验证）
    assert.equal(menus.length, 4, '连发簇安静后 menu 恢复正常切换');
    mpvFrontend.emit('input', 'back'); // 连发簇内：被吞
    assert.equal(menus.length, 4, 'back 在簇内同样合并');
    await new Promise(r => setTimeout(r, 460));
    mpvFrontend.emit('input', 'back'); // 菜单开着：back 关闭，无界面刷新
    assert.equal(menus.length, 4, 'back 关闭菜单不刷新 OSD');
    await new Promise(r => setTimeout(r, 460));
    mpvFrontend.emit('input', 'back'); // 菜单已关：back 只关不开
    assert.equal(menus.length, 4, 'back 不会误开菜单');
    await new Promise(r => setTimeout(r, 460));
    mpvFrontend.emit('input', 'menu');
    assert.equal(menus.length, 5, '菜单键仍能正常打开');
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
