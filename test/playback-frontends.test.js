'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const path = require('path');
const { PlayableSourceResolver } = require('../src/playback/source-resolver');
const { MpvFrontend } = require('../src/playback/mpv');
const { FrontendSupervisor } = require('../src/playback/supervisor');

class FakeSocket extends EventEmitter {
  constructor() { super(); this.writes = []; this.destroyed = false; }
  write(value) { this.writes.push(JSON.parse(String(value))); return true; }
  destroy() { this.destroyed = true; this.emit('close'); }
}

class FakeProcess extends EventEmitter {
  constructor(pid = 123) { super(); this.pid = pid; this.killed = false; }
  kill() { this.killed = true; }
}

test('PlayableSourceResolver 只解析片库登记文件和 ready 缓存', () => {
  const mediaPath = path.resolve('D:/media/episode.mkv');
  const cachePath = path.resolve('D:/cache/site/video.mp4');
  const library = { get: id => id === 'm1' ? { id, absPath: mediaPath } : null };
  const cache = {
    byUrl: url => url === 'ready' ? { key: 'k1', status: 'ready' } : url === 'busy' ? { status: 'downloading', progress: 42 } : { status: 'failed', error: '下载失败' },
    resolveFile: key => key === 'k1' ? cachePath : null
  };
  const resolver = new PlayableSourceResolver({ library, cache });

  assert.deepEqual(resolver.resolve({ type: 'local', mediaId: 'm1' }, 'chrome').source, { kind: 'url', uri: '/media/m1/stream', trusted: true });
  assert.deepEqual(resolver.resolve({ type: 'local', mediaId: 'm1' }, 'mpv').source, { kind: 'file', uri: mediaPath, trusted: true });
  assert.equal(resolver.resolve({ type: 'local', mediaId: 'missing' }, 'mpv').status, 'error');
  assert.equal(resolver.resolve({ type: 'web', url: 'busy' }, 'mpv').progress, 42);
  assert.deepEqual(resolver.resolve({ type: 'web', url: 'ready' }, 'mpv').source, { kind: 'file', uri: cachePath, trusted: true });
});

test('MpvFrontend 使用受控参数和 IPC，拒绝任意路径', async () => {
  const proc = new FakeProcess();
  const socket = new FakeSocket();
  let launched;
  const mpv = new MpvFrontend({
    mpvPath: 'C:\\fake\\mpv.exe', available: true, ipcPath: '\\\\.\\pipe\\test-mpv',
    spawnImpl: (exe, args) => { launched = { exe, args }; return proc; },
    connectImpl: () => socket, cleanupImpl: async () => {}
  });
  assert.equal(await mpv.start(), true);
  await new Promise(resolve => setTimeout(resolve, 5));
  socket.emit('connect');
  assert.equal(launched.exe, 'C:\\fake\\mpv.exe');
  assert.ok(launched.args.includes('--fullscreen'));
  assert.ok(launched.args.includes('--title=Showrunner'));
  assert.ok(launched.args.some(arg => arg.startsWith('--input-ipc-server=')));
  assert.equal(mpv.status().ipcConnected, true);

  await assert.rejects(() => mpv.load({ kind: 'file', uri: path.resolve('movie.mkv') }), /受信任/);
  await mpv.load({ kind: 'file', uri: path.resolve('movie.mkv'), trusted: true }, { qid: 'q1', position: 12 });
  assert.ok(socket.writes.some(msg => msg.command[0] === 'loadfile' && msg.command[2] === 'replace'));

  const positions = [], ended = [], inputs = [];
  mpv.on('position', value => positions.push(value));
  mpv.on('ended', value => ended.push(value));
  mpv.on('input', value => inputs.push(value));
  socket.emit('data', Buffer.from([
    JSON.stringify({ event: 'property-change', name: 'duration', data: 100 }),
    JSON.stringify({ event: 'property-change', name: 'time-pos', data: 15 }),
    JSON.stringify({ event: 'client-message', args: ['showrunner-input', 'menu'] }),
    JSON.stringify({ event: 'end-file', reason: 'eof' })
  ].join('\n') + '\n'));
  assert.deepEqual(positions[0], { qid: 'q1', position: 15, duration: 100 });
  assert.deepEqual(ended[0], { qid: 'q1' });
  assert.deepEqual(inputs, ['menu']);
  await mpv.stop();
  assert.equal(proc.killed, true);
});

class FakeFrontend extends EventEmitter {
  constructor(type, startResult = true) { super(); this.type = type; this.startResult = startResult; this.running = false; this.calls = []; this.currentQid = null; }
  async start() { this.calls.push('start'); this.running = this.startResult; return this.startResult; }
  async stop() { this.calls.push('stop'); this.running = false; this.currentQid = null; }
  async load(source, options) { this.calls.push(['load', source, options]); this.currentQid = options.qid; }
  async play() { this.calls.push('play'); }
  async pause() { this.calls.push('pause'); }
  async seek(value) { this.calls.push(['seek', value]); }
  async setVolume(value) { this.calls.push(['volume', value]); }
  async showStandby(value) { this.calls.push(['standby', value]); this.currentQid = null; }
  async showMenu(value) { this.calls.push(['menu', value]); }
  status() { return { type: this.type, available: this.startResult, running: this.running, ready: this.running, currentQid: this.currentQid, lastError: this.startResult ? null : '不可用' }; }
}

class FakeBrowser extends EventEmitter {
  constructor(mode = 'normal') { super(); this.mode = mode; this.calls = []; }
  async start() { this.calls.push('start'); }
  async stop() { this.calls.push('stop'); }
  async setMode(mode) { this.calls.push(mode); this.mode = mode; this.emit('change'); return this.status(); }
  status() { return { mode: this.mode, kioskRunning: this.mode === 'normal', maintenanceBrowserRunning: this.mode === 'maintenance', managedBrowserRunning: this.mode !== 'offline', maintenanceUntil: null, browserFound: true }; }
}

test('FrontendSupervisor 串行停旧启新，失败时恢复 Chrome 且不保存配置', async () => {
  const browser = new FakeBrowser();
  const chrome = new FakeFrontend('chrome');
  chrome.start = async () => { chrome.calls.push('start'); chrome.running = true; await browser.setMode('normal'); return true; };
  chrome.stop = async () => { chrome.calls.push('stop'); chrome.running = false; await browser.setMode('offline'); };
  const mpv = new FakeFrontend('mpv', false);
  const saved = [];
  const supervisor = new FrontendSupervisor({
    browser, frontends: { chrome, mpv }, selected: 'chrome', resolver: {}, manage: true,
    onSelectionChange: type => saved.push(type)
  });
  await supervisor.start();
  const result = await supervisor.setFrontend('mpv');
  assert.equal(result.ok, false);
  assert.equal(supervisor.status().frontend, 'chrome');
  assert.deepEqual(saved, []);
  assert.deepEqual(chrome.calls, ['start', 'stop', 'start']);
});

test('FrontendSupervisor 将权威状态同步到 mpv，并在维护模式回收播放器', async () => {
  const browser = new FakeBrowser('offline');
  const chrome = new FakeFrontend('chrome');
  const mpv = new FakeFrontend('mpv');
  const resolver = { resolve: () => ({ status: 'ready', source: { kind: 'file', uri: path.resolve('episode.mkv'), trusted: true } }) };
  const supervisor = new FrontendSupervisor({ browser, frontends: { chrome, mpv }, selected: 'mpv', resolver, manage: true });
  await supervisor.start();
  await supervisor.sync({ status: 'playing', position: 20, volume: 0.5, updatedAt: 1, current: { qid: 'q1', type: 'local' } });
  assert.ok(mpv.calls.some(call => Array.isArray(call) && call[0] === 'load' && call[2].qid === 'q1'));
  assert.ok(mpv.calls.some(call => Array.isArray(call) && call[0] === 'volume' && call[1] === 0.5));
  assert.ok(mpv.calls.includes('play'));
  await supervisor.sync({ status: 'playing', position: 45, volume: 0.5, updatedAt: 2, current: { qid: 'q1', type: 'local' } });
  assert.ok(mpv.calls.some(call => Array.isArray(call) && call[0] === 'seek' && call[1] === 45));
  await supervisor.setMode('maintenance');
  assert.equal(mpv.running, false);
  assert.equal(browser.mode, 'maintenance');
});
