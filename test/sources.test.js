'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { SourceRegistry, bilibiliSource, genericSource } = require('../src/sources');

test('默认注册表按 URL 选择专用源，未知网站使用公共源', () => {
  const registry = new SourceRegistry([bilibiliSource]);
  assert.equal(registry.resolve('https://www.bilibili.com/video/BV1xx').id, 'bilibili');
  assert.equal(registry.resolve('https://example.com/watch/1').id, 'generic');
  assert.equal(registry.resolve('not a url').id, 'generic');
});

test('新增网站只需注册统一接口即可覆盖标题和合集解析', async () => {
  const demo = {
    id: 'demo',
    matches: url => new URL(url).hostname === 'video.example',
    resolveTitle: async () => '专用标题',
    analyzeCollection: async () => ({ ok: true, title: '专用合集', entries: [{ title: '第一集', url: 'https://video.example/1' }] })
  };
  const registry = new SourceRegistry().register(demo);
  assert.equal(await registry.resolveTitle('https://video.example/show'), '专用标题');
  const collection = await registry.analyzeCollection('https://video.example/show');
  assert.equal(collection.title, '专用合集');
  assert.equal(collection.entries.length, 1);
});

test('专用合集解析返回 null 时自动回退公共 yt-dlp 源并保留源修补钩子', async () => {
  let normalized = false;
  const source = {
    id: 'fallback-demo',
    matches: () => true,
    analyzeCollection: async () => null,
    normalizeYtdlpEntry: () => { normalized = true; return { url: 'https://fallback.example/1' }; }
  };
  const registry = new SourceRegistry([source], genericSource);
  const result = await registry.analyzeCollection('https://fallback.example/show', {
    ytdlp: 'fake',
    fetchCollectionViaYtdlp: async (binary, url, options) => {
      const fixed = options.normalizeEntry({ itemUrl: null });
      return { ok: true, title: '公共兜底', entries: [{ title: '第一集', url: fixed.url }] };
    }
  });
  assert.equal(normalized, true);
  assert.equal(result.entries[0].url, 'https://fallback.example/1');
});

test('无效适配器会在注册时拒绝', () => {
  assert.throws(() => new SourceRegistry().register({ id: 'broken' }), /无效/);
});
