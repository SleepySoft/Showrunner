'use strict';
/**
 * 合集（连续剧式内容包）与队列合集解析、循环播放的单元测试。
 * 不启动 HTTP 服务，直接驱动 CollectionManager / QueueManager。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { CollectionManager } = require('../src/collections');
const { QueueManager } = require('../src/queue');

const localItem = (title) => ({ type: 'local', mediaId: 'm-' + title, title, relPath: title + '.mp4' });

// ---------- CollectionManager ----------

test('合集 CRUD 与序列化', () => {
  const cm = new CollectionManager(null);
  const c = cm.create('蓝色星球', 'sequential');
  assert.equal(cm.list().length, 1);
  assert.equal(cm.list()[0].name, '蓝色星球');
  cm.addItem(c.id, localItem('第一集'));
  cm.addItem(c.id, localItem('第二集'));
  assert.equal(cm.get(c.id).items.length, 2);

  cm.rename(c.id, '蓝色星球 II');
  assert.equal(cm.get(c.id).name, '蓝色星球 II');
  cm.setMode(c.id, 'random');
  assert.equal(cm.get(c.id).mode, 'random');

  // 序列化往返
  const cm2 = new CollectionManager(cm.serialize());
  assert.equal(cm2.get(c.id).items.length, 2);
  assert.equal(cm2.get(c.id).mode, 'random');

  assert.equal(cm2.remove(c.id), true);
  assert.equal(cm2.list().length, 0);
  assert.equal(cm2.remove('不存在'), false);
});

test('未指定名称时创建为“新合集”', () => {
  const cm = new CollectionManager(null);
  assert.equal(cm.create().name, '新合集');
  assert.equal(cm.create('   ').name, '新合集');
});

test('批量加入合集只发出一次 change', () => {
  const cm = new CollectionManager(null);
  const c = cm.create('网站合集');
  let changes = 0;
  cm.on('change', () => changes++);
  const added = cm.addItems(c.id, [localItem('E1'), localItem('E2'), localItem('E3')]);
  assert.equal(added.length, 3);
  assert.equal(cm.get(c.id).items.length, 3);
  assert.equal(changes, 1);
});

test('顺序模式 takeNext 逐集推进并回卷', () => {
  const cm = new CollectionManager(null);
  const c = cm.create('纪录片');
  cm.addItem(c.id, localItem('E1'));
  cm.addItem(c.id, localItem('E2'));
  cm.addItem(c.id, localItem('E3'));

  let r = cm.takeNext(c.id);
  assert.equal(r.item.title, 'E1');
  assert.equal(r.episode, 1);
  assert.equal(r.total, 3);
  assert.equal(cm.get(c.id).cursor, 1);

  r = cm.takeNext(c.id);
  assert.equal(r.item.title, 'E2');
  r = cm.takeNext(c.id);
  assert.equal(r.item.title, 'E3');
  r = cm.takeNext(c.id); // 回卷
  assert.equal(r.item.title, 'E1');
});

test('随机模式一轮内不重复，抽完重置', () => {
  const cm = new CollectionManager(null);
  const c = cm.create('短片集', 'random');
  for (const t of ['A', 'B', 'C', 'D']) cm.addItem(c.id, localItem(t));

  const seen = new Set();
  for (let i = 0; i < 4; i++) seen.add(cm.takeNext(c.id).item.title);
  assert.equal(seen.size, 4); // 一轮 4 次抽到 4 个不同条目

  const seen2 = new Set();
  for (let i = 0; i < 4; i++) seen2.add(cm.takeNext(c.id).item.title);
  assert.equal(seen2.size, 4); // 第二轮同样不重复
});

test('resetCursor 归零游标', () => {
  const cm = new CollectionManager(null);
  const c = cm.create('剧');
  cm.addItem(c.id, localItem('E1'));
  cm.addItem(c.id, localItem('E2'));
  cm.takeNext(c.id);
  cm.takeNext(c.id);
  assert.equal(cm.get(c.id).cursor, 0); // 已回卷
  cm.resetCursor(c.id);
  assert.equal(cm.get(c.id).cursor, 0);
  assert.equal(cm.takeNext(c.id).item.title, 'E1');
});

test('takeAt 取指定一集并把游标推进到该集之后', () => {
  const cm = new CollectionManager(null);
  const c = cm.create('剧');
  const a = cm.addItem(c.id, localItem('E1'));
  const b = cm.addItem(c.id, localItem('E2'));
  cm.addItem(c.id, localItem('E3'));

  const r = cm.takeAt(c.id, b.qid);
  assert.equal(r.item.title, 'E2');
  assert.equal(r.episode, 2);
  assert.equal(r.total, 3);
  assert.equal(cm.get(c.id).cursor, 2); // 下次自动连播从 E3 开始
  assert.equal(cm.takeAt(c.id, '不存在'), null);
  assert.equal(cm.takeAt('不存在', a.qid), null);
  assert.equal(cm.takeNext(c.id).item.title, 'E3');
});

test('删除游标之前的条目时游标同步前移', () => {
  const cm = new CollectionManager(null);
  const c = cm.create('剧');
  const a = cm.addItem(c.id, localItem('E1'));
  cm.addItem(c.id, localItem('E2'));
  cm.addItem(c.id, localItem('E3'));
  cm.takeNext(c.id);
  cm.takeNext(c.id); // cursor = 2
  cm.removeItem(c.id, a.qid); // 删掉第 0 位
  assert.equal(cm.get(c.id).cursor, 1); // 下一集仍是 E3
  assert.equal(cm.takeNext(c.id).item.title, 'E3');
});

test('空合集 takeNext 返回 null', () => {
  const cm = new CollectionManager(null);
  const c = cm.create('空');
  assert.equal(cm.takeNext(c.id), null);
  assert.equal(cm.takeNext('不存在'), null);
});

// ---------- 队列 × 合集解析 ----------

function makeQueueWithCollection(cm, collectionId, extraItems = []) {
  const items = [
    { qid: 'q-col', type: 'collection', collectionId, title: cm.get(collectionId)?.name || '合集', relPath: '合集' },
    ...extraItems
  ];
  const q = new QueueManager(null, items);
  q.resolver = (qItem) => {
    const r = cm.takeNext(qItem.collectionId);
    if (!r) return null;
    return { ...r.item, episode: r.episode, total: r.total };
  };
  return q;
}

test('合集条目成为当前片时抽一集，对外伪装成普通条目', () => {
  const cm = new CollectionManager(null);
  const c = cm.create('纪录片合集');
  cm.addItem(c.id, localItem('E1'));
  cm.addItem(c.id, localItem('E2'));

  const q = makeQueueWithCollection(cm, c.id, [{ qid: 'q-2', type: 'local', mediaId: 'm-x', title: '普通片', relPath: 'x.mp4' }]);
  q.jump('q-col');

  const st = q.getPublicState();
  assert.equal(st.current.type, 'local'); // 伪装成本地条目
  assert.equal(st.current.title, '《纪录片合集》第1集 E1');
  assert.equal(st.current.mediaId, 'm-E1');
  assert.equal(cm.get(c.id).cursor, 1);
});

test('同一 qid 停留不重复抽集；跳走再跳回抽下一集', () => {
  const cm = new CollectionManager(null);
  const c = cm.create('剧');
  cm.addItem(c.id, localItem('E1'));
  cm.addItem(c.id, localItem('E2'));
  cm.addItem(c.id, localItem('E3'));

  const q = makeQueueWithCollection(cm, c.id, [{ qid: 'q-2', type: 'local', mediaId: 'm-x', title: '普通片', relPath: 'x.mp4' }]);
  q.jump('q-col');
  q.play();
  q.pause(); // 停留操作不重抽
  assert.equal(q.getPublicState().current.title, '《剧》第1集 E1');

  q.next(); // 跳走
  q.prev(); // 再回来 → 抽第 2 集
  assert.equal(q.getPublicState().current.title, '《剧》第2集 E2');
});

test('空合集条目给出 cacheError，不崩溃', () => {
  const cm = new CollectionManager(null);
  const c = cm.create('空合集');
  const q = makeQueueWithCollection(cm, c.id);
  q.jump('q-col');
  const st = q.getPublicState();
  assert.ok(st.current.cacheError);
  assert.equal(st.current.type, 'collection'); // 未解析时保持合集类型，电视端走提示分支
});

test('loadPlaylist 强制抽新集', () => {
  const cm = new CollectionManager(null);
  const c = cm.create('剧');
  cm.addItem(c.id, localItem('E1'));
  cm.addItem(c.id, localItem('E2'));

  const items = [{ qid: 'q-col', type: 'collection', collectionId: c.id, title: '剧', relPath: '合集' }];
  const q = new QueueManager(null, items);
  q.resolver = (qItem) => {
    const r = cm.takeNext(qItem.collectionId);
    return r ? { ...r.item, episode: r.episode, total: r.total } : null;
  };
  q.play();
  assert.equal(q.getPublicState().current.title, '《剧》第1集 E1');

  q.loadPlaylist(items); // 模拟切走又切回同一节目单
  assert.equal(q.getPublicState().current.title, '《剧》第2集 E2');
});

test('重启续播：已解析的合集条目保持原集，不串集', () => {
  const cm = new CollectionManager(null);
  const c = cm.create('剧');
  cm.addItem(c.id, localItem('E1'));
  cm.addItem(c.id, localItem('E2'));

  const items = [{ qid: 'q-col', type: 'collection', collectionId: c.id, title: '剧', relPath: '合集' }];
  const q1 = new QueueManager(null, items);
  q1.resolver = (qi) => {
    const r = cm.takeNext(qi.collectionId);
    return r ? { ...r.item, episode: r.episode, total: r.total } : null;
  };
  q1.play();
  assert.equal(q1.getPublicState().current.title, '《剧》第1集 E1');

  // 模拟重启：序列化 → 新实例（resolved 已在条目上，persist 由 server 保存 queue 数组）
  const data = q1.serialize();
  const q2 = new QueueManager({ currentIndex: data.currentIndex, playback: data.playback }, data.queue);
  q2.resolver = q1.resolver;
  q2.play(); // 续播
  assert.equal(q2.getPublicState().current.title, '《剧》第1集 E1'); // 不重抽
  assert.equal(cm.get(c.id).cursor, 1); // 游标只推进过一次
});

// ---------- 循环播放 ----------

test('loop 开启：队尾 next 回卷到第一部，合集条目抽新集', () => {
  const cm = new CollectionManager(null);
  const c = cm.create('剧');
  cm.addItem(c.id, localItem('E1'));
  cm.addItem(c.id, localItem('E2'));

  const items = [
    { qid: 'q-1', type: 'local', mediaId: 'm-a', title: '普通片', relPath: 'a.mp4' },
    { qid: 'q-col', type: 'collection', collectionId: c.id, title: '剧', relPath: '合集' }
  ];
  const q = new QueueManager(null, items);
  q.loop = true;
  q.resolver = (qi) => {
    const r = cm.takeNext(qi.collectionId);
    return r ? { ...r.item, episode: r.episode, total: r.total } : null;
  };
  q.play();
  q.next(); // 到合集条目，抽 E1
  assert.equal(q.getPublicState().current.title, '《剧》第1集 E1');

  const ok = q.next(); // 队尾 → 回卷
  assert.equal(ok, true);
  assert.equal(q.currentIndex, 0);
  assert.equal(q.getPublicState().current.title, '普通片');
  assert.equal(q.getPublicState().status, 'playing');

  q.next(); // 第二轮的合集条目 → 抽 E2
  assert.equal(q.getPublicState().current.title, '《剧》第2集 E2');
});

test('loop 关闭：队尾 next 进入待机', () => {
  const q = new QueueManager(null, [{ qid: 'q-1', type: 'local', mediaId: 'm-a', title: 'A', relPath: 'a.mp4' }]);
  q.loop = false;
  q.play();
  const ok = q.next();
  assert.equal(ok, false);
  assert.equal(q.getPublicState().status, 'idle');
  assert.equal(q.getPublicState().current, null);
});

test('upcoming 列表中合集条目显示为「抽一集」', () => {
  const q = new QueueManager(null, [
    { qid: 'q-1', type: 'local', mediaId: 'm-a', title: 'A', relPath: 'a.mp4' },
    { qid: 'q-col', type: 'collection', collectionId: 'c1', title: '剧', relPath: '合集' }
  ]);
  q.resolver = () => null;
  q.play();
  const st = q.getPublicState();
  assert.equal(st.upcoming[0].title, '《剧》抽一集');
});
