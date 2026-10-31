'use strict';
/** 队列状态机单元测试：纯逻辑，不启动服务。 */
const { test } = require('node:test');
const assert = require('node:assert');
const { QueueManager } = require('../src/queue');

function makeQueue(titles = ['A', 'B', 'C']) {
  const q = new QueueManager(null);
  for (const t of titles) q.add({ mediaId: 'id-' + t, title: t, relPath: t + '.mp4' });
  return q;
}

test('空队列初始状态', () => {
  const q = new QueueManager(null);
  assert.equal(q.currentIndex, -1);
  assert.equal(q.current(), null);
  assert.equal(q.getPublicState().status, 'idle');
});

test('首部入列自动定位到 index 0，但不自动开播', () => {
  const q = new QueueManager(null);
  q.add({ mediaId: 'm1', title: '纪录片', relPath: 'a.mp4' });
  assert.equal(q.currentIndex, 0);
  assert.equal(q.getPublicState().status, 'idle');
  assert.equal(q.current().title, '纪录片');
});

test('play / pause 状态流转', () => {
  const q = makeQueue();
  assert.equal(q.play(), true);
  assert.equal(q.playback.status, 'playing');
  assert.equal(q.pause(), true);
  assert.equal(q.playback.status, 'paused');
});

test('空队列 play 返回 false', () => {
  const q = new QueueManager(null);
  assert.equal(q.play(), false);
});

test('next 连播并在队尾进入待机', () => {
  const q = makeQueue();
  q.play();
  assert.equal(q.next(), true);
  assert.equal(q.current().title, 'B');
  assert.equal(q.playback.position, 0);
  q.next();
  assert.equal(q.current().title, 'C');
  // 队尾再 next：播完，回到待机
  assert.equal(q.next(), false);
  assert.equal(q.current(), null);
  assert.equal(q.getPublicState().status, 'idle');
});

test('prev 回到上一部，队首返回 false', () => {
  const q = makeQueue();
  assert.equal(q.prev(), false);
  q.next();
  assert.equal(q.prev(), true);
  assert.equal(q.current().title, 'A');
});

test('jump 跳播任意一部', () => {
  const q = makeQueue();
  const target = q.queue[2].qid;
  assert.equal(q.jump(target), true);
  assert.equal(q.current().title, 'C');
  assert.equal(q.playback.status, 'playing');
  assert.equal(q.jump('no-such-qid'), false);
});

test('remove 正在播的条目：原位接下一部并归零进度', () => {
  const q = makeQueue();
  q.play();
  q.seek(120);
  const curQid = q.current().qid;
  q.remove(curQid);
  assert.equal(q.current().title, 'B');
  assert.equal(q.playback.position, 0);
});

test('remove 当前之前的条目：currentIndex 同步前移，当前片不变', () => {
  const q = makeQueue(['A', 'B', 'C', 'D']);
  q.jump(q.queue[2].qid); // 播 C
  q.remove(q.queue[0].qid); // 删 A
  assert.equal(q.current().title, 'C');
  assert.equal(q.currentIndex, 1);
});

test('remove 最后一部：队列清空回到待机', () => {
  const q = makeQueue(['A']);
  q.play();
  q.remove(q.queue[0].qid);
  assert.equal(q.currentIndex, -1);
  assert.equal(q.getPublicState().status, 'idle');
});

test('remove 不存在的 qid 返回 false', () => {
  const q = makeQueue();
  assert.equal(q.remove('nope'), false);
});

test('move 排序且当前片跟随', () => {
  const q = makeQueue(['A', 'B', 'C', 'D']);
  q.jump(q.queue[1].qid); // 播 B
  q.move(q.queue[3].qid, 0); // D 挪到队首
  assert.deepEqual(q.queue.map(i => i.title), ['D', 'A', 'B', 'C']);
  assert.equal(q.current().title, 'B');
  assert.equal(q.currentIndex, 2);
});

test('move 越界索引被钳制', () => {
  const q = makeQueue();
  q.move(q.queue[0].qid, 99);
  assert.equal(q.queue[2].title, 'A');
});

test('clear 清空并待机', () => {
  const q = makeQueue();
  q.play();
  q.clear();
  assert.equal(q.queue.length, 0);
  assert.equal(q.currentIndex, -1);
  assert.equal(q.getPublicState().status, 'idle');
});

test('seek 负数归零', () => {
  const q = makeQueue();
  q.seek(-5);
  assert.equal(q.playback.position, 0);
});

test('setVolume 钳制在 0~1', () => {
  const q = makeQueue();
  q.setVolume(2);
  assert.equal(q.playback.volume, 1);
  q.setVolume(-1);
  assert.equal(q.playback.volume, 0);
});

test('持久化往返：序列化 → 重建 → 状态一致', () => {
  const q = makeQueue();
  q.play();
  q.seek(77);
  const snap = q.serialize();
  const restored = new QueueManager(snap, snap.queue);
  assert.equal(restored.current().title, 'A');
  assert.equal(restored.playback.status, 'playing');
  assert.equal(restored.playback.position, 77);
  assert.equal(restored.queue.length, 3);
});

test('损坏的持久化状态能安全兜底', () => {
  const q = new QueueManager({ queue: [], currentIndex: 5, playback: null });
  assert.equal(q.currentIndex, -1);
  assert.equal(q.current(), null);
});

test('每次变更都发出 change 事件', () => {
  const q = new QueueManager(null);
  let n = 0;
  q.on('change', () => n++);
  q.add({ mediaId: 'm', title: 't', relPath: 'r' });
  q.play();
  q.pause();
  assert.equal(n, 3);
});

test('getPublicState 不暴露队列全文，只有当前与即将播出', () => {
  const q = makeQueue(['A', 'B', 'C', 'D', 'E']);
  const pub = q.getPublicState();
  assert.equal(pub.queueLength, 5);
  assert.equal(pub.upcoming.length, 3); // 最多预告 3 部
  assert.ok(!('queue' in pub));
});
