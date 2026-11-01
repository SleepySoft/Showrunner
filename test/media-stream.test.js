'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { streamFile } = require('../src/routes/media');

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.headersSent = false;
    this.destroyed = false;
    this.statusCode = 200;
    this.body = null;
  }
  setHeader() {}
  status(code) { this.statusCode = code; return this; }
  json(body) { this.body = body; this.headersSent = true; return this; }
  writeHead(code) { this.statusCode = code; this.headersSent = true; }
  destroy() { this.destroyed = true; this.emit('close'); }
}

class FakeReadStream extends EventEmitter {
  constructor() { super(); this.destroyed = false; }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
  pipe() { return this; }
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-media-stream-'));
  const file = path.join(dir, 'video.mp4');
  fs.writeFileSync(file, 'video');
  return { dir, file };
}

test('ReadStream EMFILE 被转为 503，不产生未处理 error', async () => {
  const { dir, file } = fixture();
  const req = new EventEmitter(); req.headers = {};
  const res = new FakeResponse();
  const input = new FakeReadStream();
  try {
    streamFile(req, res, file, () => input);
    input.emit('error', Object.assign(new Error('too many open files'), { code: 'EMFILE' }));
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: 'media temporarily unavailable', code: 'EMFILE' });
  } finally {
    input.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('客户端中断请求时立即销毁媒体文件流', () => {
  const { dir, file } = fixture();
  const req = new EventEmitter(); req.headers = {};
  const res = new FakeResponse();
  const input = new FakeReadStream();
  try {
    streamFile(req, res, file, () => input);
    req.emit('aborted');
    assert.equal(input.destroyed, true);
  } finally {
    input.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
