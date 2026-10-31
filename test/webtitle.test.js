'use strict';
/** 网页标题解析单元测试：注入假 fetch，不触网。 */
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveTitle } = require('../src/webtitle');

const fakeFetch = (html, ok = true) => async () => ({
  ok,
  text: async () => html
});

test('解析 <title> 并剥掉站点后缀', async () => {
  const cases = [
    ['<title>【纪录片】地球脉动 第一季_哔哩哔哩_bilibili</title>', '【纪录片】地球脉动 第一季'],
    ['<title>舌尖上的中国 第一集-纪录片-高清正版在线观看-优酷</title>', '舌尖上的中国 第一集'],
    ['<title>Planet Earth III | Official Trailer - YouTube</title>', 'Planet Earth III | Official Trailer'],
    ['<title>普通标题</title>', '普通标题']
  ];
  for (const [html, want] of cases) {
    const got = await resolveTitle('https://example.com/v/1', fakeFetch(`<html><head>${html}</head></html>`));
    assert.equal(want, got, html);
  }
});

test('解码 HTML 实体', async () => {
  const t = await resolveTitle('https://example.com/v', fakeFetch('<title>Tom &amp; Jerry &#39;show&#39;</title>'));
  assert.equal(t, "Tom & Jerry 'show'");
});

test('请求失败退化为「主机名+路径」', async () => {
  const failing = async () => { throw new Error('network down'); };
  const t = await resolveTitle('https://b23.tv/abc123', failing);
  assert.equal(t, 'b23.tv/abc123');
});

test('非 200 响应退化', async () => {
  const t = await resolveTitle('https://example.com/x', fakeFetch('nope', false));
  assert.equal(t, 'example.com/x');
});

test('没有 <title> 退化', async () => {
  const t = await resolveTitle('https://example.com/x', fakeFetch('<html><body></body></html>'));
  assert.equal(t, 'example.com/x');
});

test('非法 URL 不抛异常', async () => {
  const t = await resolveTitle('::not-a-url::');
  assert.equal(typeof t, 'string');
  assert.ok(t.length > 0);
});
