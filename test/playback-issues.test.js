'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { start } = require('../src/server');
const { PlaybackIssueLogger } = require('../src/playback-issues');

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
    ws.close();
  } finally {
    if (app) await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
