'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CompatibilityManager } = require('../src/compatibility');

const waitFor = async predicate => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('等待兼容转换超时');
};

test('不兼容本地视频转换为可 Range 播放的 MP4 缓存', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-compat-'));
  try {
    const source = path.join(tmp, 'source.avi');
    fs.writeFileSync(source, 'source bytes');
    const manager = new CompatibilityManager({
      dir: path.join(tmp, 'cache'), ffmpeg: 'fake-ffmpeg', maxBytes: 1024,
      transcodeImpl: async (_source, output) => { fs.writeFileSync(output, 'compatible mp4'); return { ok: true }; }
    });
    const item = { id: 'm1', type: 'local', mediaId: 'm1', title: '旧格式', absPath: source };
    manager.ensure(item);
    await waitFor(() => manager.get('m1')?.status === 'ready');
    assert.equal(manager.decorate(item).compatibilityStatus, 'ready');
    assert.equal(manager.decorate(item).stream, '/compatible/m1/stream');
    assert.equal(fs.readFileSync(manager.resolveFile('m1'), 'utf8'), 'compatible mp4');
    fs.appendFileSync(source, ' changed');
    assert.deepEqual(manager.decorate(item, item), {});
    assert.equal(manager.resolveFile('m1'), null);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('FFmpeg 不可用和 NAS 源文件不可访问时给出可诊断失败', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-compat-fail-'));
  try {
    const source = path.join(tmp, 'source.ts'); fs.writeFileSync(source, 'x');
    const noFfmpeg = new CompatibilityManager({ dir: path.join(tmp, 'a'), ffmpeg: null });
    noFfmpeg.ensure({ id: 'm1', title: '片一', absPath: source });
    await waitFor(() => noFfmpeg.get('m1')?.status === 'failed');
    assert.match(noFfmpeg.get('m1').error, /FFmpeg/);

    const missing = new CompatibilityManager({ dir: path.join(tmp, 'b'), ffmpeg: 'fake' });
    missing.ensure({ id: 'm2', title: '片二', absPath: path.join(tmp, 'missing.avi') });
    await waitFor(() => missing.get('m2')?.status === 'failed');
    assert.match(missing.get('m2').error, /NAS|不可访问/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
