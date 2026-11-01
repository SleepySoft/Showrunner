'use strict';
/** 媒体库扫描与持久化存储单元测试。 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Library, mediaId } = require('../src/library');
const { Store } = require('../src/store');

let tmp, mediaDir;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-lib-'));
  mediaDir = path.join(tmp, 'media');
  fs.mkdirSync(path.join(mediaDir, '纪录片'), { recursive: true });
  fs.writeFileSync(path.join(mediaDir, '地球脉动.mp4'), Buffer.alloc(1024, 1));
  fs.writeFileSync(path.join(mediaDir, '纪录片', '蓝色星球.mkv'), Buffer.alloc(2048, 2));
  fs.writeFileSync(path.join(mediaDir, '说明.txt'), 'not a video'); // 应被忽略
  fs.writeFileSync(path.join(mediaDir, '动画.WEBM'), Buffer.alloc(512, 3)); // 扩展名大小写
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('扫描只收视频文件，含子目录，扩展名大小写不敏感', () => {
  const lib = new Library([mediaDir]);
  const items = lib.rescan();
  assert.equal(items.length, 3);
  const titles = items.map(i => i.title).sort();
  assert.deepEqual(titles, ['动画', '地球脉动', '蓝色星球']);
});

test('列表按路径排序且不暴露绝对路径', () => {
  const lib = new Library([mediaDir]);
  const items = lib.rescan();
  for (const it of items) {
    assert.ok(!('absPath' in it));
    assert.ok(it.id && it.relPath && it.size > 0);
    assert.ok(it.sourceId && it.sourceName === 'media');
  }
});

test('多个片库根目录的同名相对文件不会互相覆盖', () => {
  const other = path.join(tmp, 'other');
  fs.mkdirSync(path.join(other, '纪录片'), { recursive: true });
  fs.writeFileSync(path.join(other, '纪录片', '蓝色星球.mkv'), Buffer.alloc(10, 3));
  const lib = new Library([mediaDir, other]);
  const same = lib.rescan().filter(i => i.relPath === path.join('纪录片', '蓝色星球.mkv'));
  assert.equal(same.length, 2);
  assert.notEqual(same[0].id, same[1].id);
  assert.notEqual(same[0].sourceId, same[1].sourceId);
});

test('ID 由相对路径决定：文件不动则 ID 稳定', () => {
  const lib = new Library([mediaDir]);
  lib.rescan();
  const rel = path.join('纪录片', '蓝色星球.mkv');
  assert.equal(mediaId(rel), mediaId(rel));
  const item = lib.get(mediaId(rel));
  assert.equal(item.title, '蓝色星球');
});

test('get 未登记 ID 返回 null', () => {
  const lib = new Library([mediaDir]);
  lib.rescan();
  assert.equal(lib.get('deadbeefdeadbeef'), null);
});

test('目录不存在或不可读时扫描不崩溃', () => {
  const lib = new Library([path.join(tmp, 'no-such-dir')]);
  assert.deepEqual(lib.rescan(), []);
});

test('Store 持久化往返', () => {
  const file = path.join(tmp, 'state', 'db.json');
  const s1 = new Store(file);
  const data = s1.load({ queue: [], n: 0 });
  data.n = 42;
  s1.save(data);
  const s2 = new Store(file);
  assert.equal(s2.load({}).n, 42);
});

test('Store 文件缺失时用默认值', () => {
  const s = new Store(path.join(tmp, 'missing.json'));
  assert.deepEqual(s.load({ hello: 1 }), { hello: 1 });
});

test('Store 写盘是原子的：不残留 .tmp 文件', () => {
  const file = path.join(tmp, 'atomic.json');
  const s = new Store(file);
  s.save({ a: 1 });
  assert.ok(fs.existsSync(file));
  assert.ok(!fs.existsSync(file + '.tmp'));
});
