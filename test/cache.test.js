'use strict';
/**
 * 网页片源缓存（CacheManager）单元测试：
 * 注入假的 fetchInfo/download 实现，不触网、不起真实进程。
 * 覆盖：命名净化、key 稳定性、下载全流水线、失败与重试、
 * 预取窗口、LRU 淘汰、索引持久化、队列状态装饰、缓存流端点。
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { CacheManager, sanitizeName, cacheKey } = require('../src/cache');
const { cacheRouter } = require('../src/routes/media');
const { QueueManager } = require('../src/queue');

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-cache-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** 假下载：按 outTemplate 生成产物文件并回报两次进度 */
function fakeDownloadImpl(size = 1000) {
  return async (url, outTemplate, onProgress) => {
    const target = outTemplate.replace('%(ext)s', 'mp4');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    onProgress(42);
    fs.writeFileSync(target, Buffer.alloc(size, 1));
    onProgress(100);
    return { ok: true };
  };
}

const fakeInfo = async () => ({ title: '宇宙奇观：第一集', contentId: 'BV1xx411c7mD', site: 'bilibili', duration: 600 });

function mkCache(overrides = {}) {
  return new CacheManager({
    dir: path.join(tmp, 'cache'),
    ytdlp: 'fake-ytdlp', // 非 null 即可，实际调用被注入实现拦截
    fetchInfoImpl: fakeInfo,
    downloadImpl: fakeDownloadImpl(),
    ...overrides
  });
}

/** 等条目进入指定状态 */
function waitStatus(cache, key, status, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${status} 超时，当前 ${cache.get(key)?.status}`)), timeoutMs);
    const check = () => {
      const e = cache.get(key);
      if (e && e.status === status) { clearTimeout(timer); resolve(e); return true; }
      return false;
    };
    if (check()) return;
    cache.on('change', check);
  });
}

// ---------- 纯函数 ----------

test('sanitizeName 去掉 Windows 非法字符并限长', () => {
  assert.equal(sanitizeName('a<b>c:d"e/f\\g|h?i*j'), 'a b c d e f g h i j');
  assert.equal(sanitizeName('  多空格   折叠  '), '多空格 折叠');
  assert.equal(sanitizeName('x'.repeat(100)).length, 60);
  assert.equal(sanitizeName(''), 'untitled');
  assert.equal(sanitizeName(null), 'untitled');
});

test('cacheKey 稳定且随 URL 变化', () => {
  const u = 'https://www.bilibili.com/video/BV1xx411c7mD';
  assert.equal(cacheKey(u), cacheKey(u));
  assert.equal(cacheKey(u).length, 12);
  assert.notEqual(cacheKey(u), cacheKey(u + '?p=2'));
});

// ---------- 下载流水线 ----------

test('ensure 完成全流水线：命名规范、ready、可流式访问', async () => {
  const cache = mkCache({ fetchInfoImpl: fakeInfo, downloadImpl: fakeDownloadImpl(2048) });
  const url = 'https://www.bilibili.com/video/BV1xx411c7mD';
  const entry = cache.ensure(url, '提示标题');
  assert.ok(['pending', 'downloading'].includes(entry.status)); // 异步流水线可能已推进

  const ready = await waitStatus(cache, entry.key, 'ready');
  assert.equal(ready.progress, 100);
  assert.equal(ready.bytes, 2048);
  // 规范命名：cache/<站点>/<标题>-<内容ID>.<扩展名>
  assert.match(ready.file, /^bilibili\/宇宙奇观：第一集-BV1xx411c7mD\.mp4$/);
  assert.ok(fs.existsSync(path.join(tmp, 'cache', ready.file)));
  assert.ok(cache.resolveFile(entry.key));

  // 幂等：再次 ensure 不重复下载
  const again = cache.ensure(url);
  assert.equal(again.status, 'ready');
  assert.equal(again, ready);
});

test('下载失败进入 failed 并可重试', async () => {
  let calls = 0;
  const cache = mkCache({
    fetchInfoImpl: fakeInfo,
    downloadImpl: async () => { calls++; return { ok: false, error: '网络炸了' }; }
  });
  const url = 'https://example.com/v/1';
  const entry = cache.ensure(url);
  const failed = await waitStatus(cache, entry.key, 'failed');
  assert.equal(failed.error, '网络炸了');
  assert.equal(calls, 1);

  // 重试（ensure 对 failed 条目重新启动流水线）
  cache.downloadImpl = fakeDownloadImpl(100);
  cache.ensure(url);
  const ready = await waitStatus(cache, entry.key, 'ready');
  assert.equal(ready.status, 'ready');
});

test('下载完成但找不到产物 → failed', async () => {
  const cache = mkCache({
    fetchInfoImpl: fakeInfo,
    downloadImpl: async () => ({ ok: true }) // 谎报成功，没写文件
  });
  const entry = cache.ensure('https://example.com/v/2');
  const failed = await waitStatus(cache, entry.key, 'failed');
  assert.match(failed.error, /找不到产物/);
});

test('无 yt-dlp 时直接 failed', async () => {
  const cache = mkCache({ ytdlp: null });
  const entry = cache.ensure('https://example.com/v/3');
  const failed = await waitStatus(cache, entry.key, 'failed');
  assert.match(failed.error, /yt-dlp/);
});

// ---------- 预取窗口 ----------

test('prefetchQueue 只预取当前及之后 2 个网页条目', async () => {
  const cached = [];
  const cache = mkCache({ fetchInfoImpl: fakeInfo, downloadImpl: fakeDownloadImpl(10) });
  const origEnsure = cache.ensure.bind(cache);
  cache.ensure = (url, hint) => { cached.push(url); return origEnsure(url, hint); };

  const items = [
    { type: 'local', mediaId: 'a' },
    { type: 'web', url: 'https://e.com/1', title: 'w1' },
    { type: 'web', url: 'https://e.com/2', title: 'w2' },
    { type: 'local', mediaId: 'b' },
    { type: 'web', url: 'https://e.com/3', title: 'w3' },
    { type: 'web', url: 'https://e.com/4', title: 'w4' } // 超出窗口
  ];
  cache.prefetchQueue(items, 1);
  assert.deepEqual(cached, ['https://e.com/1', 'https://e.com/2', 'https://e.com/3']);
  // 等后台流水线跑完，避免进程残留
  await Promise.all(cached.map(u => waitStatus(cache, cacheKey(u), 'ready')));
});

// ---------- LRU 淘汰 ----------

test('超出容量上限时淘汰最久未用的 ready 条目', async () => {
  const cache = mkCache({
    maxBytes: 2500, // 只放得下两部小片
    fetchInfoImpl: fakeInfo,
    downloadImpl: fakeDownloadImpl(2048)
  });
  const u1 = 'https://e.com/a', u2 = 'https://e.com/b';
  const e1 = cache.ensure(u1);
  await waitStatus(cache, e1.key, 'ready');
  // 人为拉开使用时间
  cache.get(e1.key).lastUsedAt = Date.now() - 100000;

  const e2 = cache.ensure(u2);
  await waitStatus(cache, e2.key, 'ready');

  assert.equal(cache.get(e1.key), null, '最久未用的应被淘汰');
  assert.ok(cache.get(e2.key), '新下载的保留');
});

// ---------- 索引持久化 ----------

test('索引持久化：重启后 ready 条目仍在，中断的下载降级为 failed', async () => {
  const dir = path.join(tmp, 'cache');
  const cache = mkCache({ dir, fetchInfoImpl: fakeInfo, downloadImpl: fakeDownloadImpl(100) });
  const e1 = cache.ensure('https://e.com/persist');
  await waitStatus(cache, e1.key, 'ready');

  // 手工往索引里塞一个「下载中」的条目，模拟进程被杀
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  idx.push({ key: 'deadbeef0000', url: 'https://e.com/half', title: '半截', status: 'downloading', progress: 55, file: null, bytes: 0, createdAt: 1, lastUsedAt: 1 });
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(idx));

  const cache2 = new CacheManager({ dir, ytdlp: null });
  const restored = cache2.get(e1.key);
  assert.equal(restored.status, 'ready');
  assert.ok(cache2.resolveFile(e1.key));

  const half = cache2.get('deadbeef0000');
  assert.equal(half.status, 'failed');
  assert.match(half.error, /重启/);
});

// ---------- 装饰与流端点 ----------

test('队列公开状态的当前片带缓存装饰字段', async () => {
  const cache = mkCache({ fetchInfoImpl: fakeInfo, downloadImpl: fakeDownloadImpl(100) });
  const items = [{ type: 'web', url: 'https://e.com/deco', title: '网页片', qid: 'q1' }];
  const queue = new QueueManager({ currentIndex: 0 }, items);
  queue.decorator = item => cache.decorate(item);

  // 未缓存时
  let cur = queue.getPublicState().current;
  assert.equal(cur.cacheStatus, 'none');
  assert.equal(cur.stream, undefined);

  // 缓存完成后带 stream
  const e = cache.ensure('https://e.com/deco');
  await waitStatus(cache, e.key, 'ready');
  cur = queue.getPublicState().current;
  assert.equal(cur.cacheStatus, 'ready');
  assert.equal(cur.stream, `/cache/${e.key}/stream`);
  // 本地片不受影响
  const q2 = new QueueManager({ currentIndex: 0 }, [{ type: 'local', mediaId: 'x', title: '本地', qid: 'q2' }]);
  q2.decorator = item => cache.decorate(item);
  assert.equal(q2.getPublicState().current.cacheStatus, undefined);
});

test('/cache/:key/stream 支持 Range，未就绪返回 404', async () => {
  const cache = mkCache({ fetchInfoImpl: fakeInfo, downloadImpl: fakeDownloadImpl(5000) });
  const app = express();
  app.use('/cache', cacheRouter(cache));
  const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;

  try {
    const key = cacheKey('https://e.com/stream');
    assert.equal((await fetch(`${base}/cache/${key}/stream`)).status, 404); // 不存在

    const e = cache.ensure('https://e.com/stream');
    await waitStatus(cache, e.key, 'ready');

    const full = await fetch(`${base}/cache/${e.key}/stream`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'video/mp4');
    assert.equal((await full.arrayBuffer()).byteLength, 5000);

    const part = await fetch(`${base}/cache/${e.key}/stream`, { headers: { Range: 'bytes=0-99' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 0-99/5000');
  } finally {
    await new Promise(r => srv.close(r));
  }
});

test('remove 删除条目与文件', async () => {
  const cache = mkCache({ fetchInfoImpl: fakeInfo, downloadImpl: fakeDownloadImpl(100) });
  const e = cache.ensure('https://e.com/rm');
  await waitStatus(cache, e.key, 'ready');
  const abs = cache.resolveFile(e.key);
  assert.ok(fs.existsSync(abs));

  assert.equal(cache.remove(e.key), true);
  assert.equal(cache.get(e.key), null);
  assert.equal(fs.existsSync(abs), false);
  assert.equal(cache.remove(e.key), false);
});
