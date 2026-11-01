'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { fetchCollection, fetchBilibiliCollection } = require('../src/ytdlp');

function fakeSpawn(json, { code = 0, stderr = '' } = {}, capture = {}) {
  return (cmd, args) => {
    capture.cmd = cmd;
    capture.args = args;
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = () => {};
    process.nextTick(() => {
      if (json !== undefined) proc.stdout.end(typeof json === 'string' ? json : JSON.stringify(json));
      else proc.stdout.end();
      proc.stderr.end(stderr);
      proc.emit('close', code);
    });
    return proc;
  };
}

test('fetchCollection 展开播放列表并保留顺序和标题', async () => {
  const capture = {};
  const result = await fetchCollection('fake-ytdlp', 'https://example.com/list/1', {
    spawnImpl: fakeSpawn({
      title: '自然纪录片',
      entries: [
        { title: '第一集', webpage_url: 'https://example.com/watch/1' },
        { title: '第二集', url: 'https://example.com/watch/2' }
      ]
    }, {}, capture),
    cookiesFromBrowser: 'edge'
  });
  assert.equal(result.ok, true);
  assert.equal(result.title, '自然纪录片');
  assert.deepEqual(result.entries.map(e => e.title), ['第一集', '第二集']);
  assert.deepEqual(result.entries.map(e => e.url), ['https://example.com/watch/1', 'https://example.com/watch/2']);
  assert.ok(capture.args.includes('--flat-playlist'));
  assert.ok(capture.args.includes('--yes-playlist'));
  assert.deepEqual(capture.args.slice(capture.args.indexOf('--cookies-from-browser'), capture.args.indexOf('--cookies-from-browser') + 2), ['--cookies-from-browser', 'edge']);
});

test('fetchCollection 为 B 站分 P 的相对条目补全 p 参数', async () => {
  const result = await fetchCollection('fake-ytdlp', 'https://www.bilibili.com/video/BV1abc/?spm_id_from=x', {
    fetchImpl: async () => ({ ok: false }),
    spawnImpl: fakeSpawn({
      title: '课程合集', extractor_key: 'BiliBili',
      entries: [{ title: '序章', url: 'opaque-1' }, { title: '正片', url: 'opaque-2' }]
    })
  });
  assert.equal(result.ok, true);
  assert.equal(result.entries.length, 2);
  assert.equal(new URL(result.entries[0].url).searchParams.get('p'), '1');
  assert.equal(new URL(result.entries[1].url).searchParams.get('p'), '2');
});

test('fetchBilibiliCollection 从合集内任意一集反查整个 UGC 合集', async () => {
  const result = await fetchBilibiliCollection('https://www.bilibili.com/video/BV1k3Jtz7EF2/?from=fav', {
    fetchImpl: async url => {
      assert.match(url, /bvid=BV1k3Jtz7EF2/);
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            title: '当前视频',
            ugc_season: {
              title: '乐高机械',
              sections: [{ episodes: [
                { bvid: 'BV111', title: '第一集' },
                { bvid: 'BV222', title: '第二集' }
              ] }]
            }
          }
        })
      };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.title, '乐高机械');
  assert.deepEqual(result.entries, [
    { title: '第一集', url: 'https://www.bilibili.com/video/BV111/' },
    { title: '第二集', url: 'https://www.bilibili.com/video/BV222/' }
  ]);
});

test('fetchBilibiliCollection 兼容传统多 P 视频', async () => {
  const result = await fetchBilibiliCollection('https://www.bilibili.com/video/BV1multi/', {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ code: 0, data: { title: '教程', pages: [{ part: '安装' }, { part: '使用' }] } })
    })
  });
  assert.equal(result.title, '教程');
  assert.deepEqual(result.entries.map(e => e.url), [
    'https://www.bilibili.com/video/BV1multi/?p=1',
    'https://www.bilibili.com/video/BV1multi/?p=2'
  ]);
});

test('fetchCollection 兼容普通单视频并返回解析错误', async () => {
  const one = await fetchCollection('fake-ytdlp', 'https://example.com/watch/one', {
    spawnImpl: fakeSpawn({ title: '单集', webpage_url: 'https://example.com/watch/one' })
  });
  assert.equal(one.ok, true);
  assert.equal(one.entries.length, 1);

  const bad = await fetchCollection('fake-ytdlp', 'https://example.com/bad', {
    spawnImpl: fakeSpawn(undefined, { code: 1, stderr: 'unsupported URL' })
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unsupported URL/);
});
