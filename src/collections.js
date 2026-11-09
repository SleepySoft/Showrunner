'use strict';
/**
 * 合集管理器：连续剧式的有序内容包。
 * 合集自己维护「播到第几集」的游标（cursor），节目单里放一个「合集抽一集」条目，
 * 每次轮到它播出时就从合集里取下一集——像电视台每天播一集连续剧。
 *
 * mode: 'sequential' 按顺序播，播完自动从头再来
 *       'random'    随机抽（不重复，直到全部抽完一轮后重置池子）
 */
const { EventEmitter } = require('events');
const crypto = require('crypto');

class CollectionManager extends EventEmitter {
  constructor(persisted) {
    super();
    this.collections = Array.isArray(persisted?.collections) ? persisted.collections : [];
    for (const c of this.collections) {
      if (!Array.isArray(c.items)) c.items = [];
      for (const item of c.items) {
        if (!item.qid) item.qid = crypto.randomUUID();
        if (!item.type) item.type = item.url ? 'web' : 'local';
      }
      if (typeof c.cursor !== 'number') c.cursor = 0;
      if (!c.mode) c.mode = 'sequential';
      if (!Array.isArray(c.randomPool)) c.randomPool = null; // random 模式的剩余池
      if (c.cursor >= c.items.length) c.cursor = 0;
    }
  }

  serialize() { return { collections: this.collections }; }

  list() {
    return this.collections.map(c => ({
      id: c.id, name: c.name, count: c.items.length, cursor: c.cursor, mode: c.mode
    }));
  }

  get(id) { return this.collections.find(c => c.id === id) || null; }

  create(name, mode = 'sequential') {
    const c = {
      id: crypto.randomUUID(),
      name: String(name || '新合集').trim().slice(0, 50) || '新合集',
      mode: mode === 'random' ? 'random' : 'sequential',
      items: [], cursor: 0, randomPool: null,
      createdAt: Date.now()
    };
    this.collections.push(c);
    this.emit('change');
    return c;
  }

  rename(id, name) {
    const c = this.get(id);
    if (!c) return false;
    const n = String(name || '').trim().slice(0, 50);
    if (n) c.name = n;
    this.emit('change');
    return true;
  }

  remove(id) {
    const i = this.collections.findIndex(c => c.id === id);
    if (i === -1) return false;
    this.collections.splice(i, 1);
    this.emit('change');
    return true;
  }

  setMode(id, mode) {
    const c = this.get(id);
    if (!c) return false;
    c.mode = mode === 'random' ? 'random' : 'sequential';
    c.randomPool = null;
    this.emit('change');
    return true;
  }

  addItem(id, item) {
    const c = this.get(id);
    if (!c) return null;
    const entry = { qid: crypto.randomUUID(), addedAt: Date.now(), ...item };
    c.items.push(entry);
    this.emit('change');
    return entry;
  }

  /** 批量加入条目，只广播一次 change，避免导入大型网站合集时反复写盘。 */
  addItems(id, items) {
    const c = this.get(id);
    if (!c || !Array.isArray(items)) return null;
    const entries = items.map(item => ({ qid: crypto.randomUUID(), addedAt: Date.now(), ...item }));
    c.items.push(...entries);
    if (entries.length) this.emit('change');
    return entries;
  }

  removeItem(id, qid) {
    const c = this.get(id);
    if (!c) return false;
    const i = c.items.findIndex(x => x.qid === qid);
    if (i === -1) return false;
    c.items.splice(i, 1);
    if (c.cursor > i) c.cursor--;
    if (c.cursor >= c.items.length) c.cursor = 0;
    c.randomPool = null;
    this.emit('change');
    return true;
  }

  moveItem(id, qid, toIndex) {
    const c = this.get(id);
    if (!c) return false;
    const from = c.items.findIndex(x => x.qid === qid);
    if (from === -1) return false;
    const to = Math.max(0, Math.min(Number(toIndex), c.items.length - 1));
    const [it] = c.items.splice(from, 1);
    c.items.splice(to, 0, it);
    this.emit('change');
    return true;
  }

  /** 游标归零（sequential）/ 重置随机池（random） */
  resetCursor(id) {
    const c = this.get(id);
    if (!c) return false;
    c.cursor = 0;
    c.randomPool = null;
    this.emit('change');
    return true;
  }

  /**
   * 取指定一集（按条目 qid），不依赖游标；sequential 模式把游标推进到该集之后
   * （下次自动连播从下一集开始）。返回 { item, episode, total } 或 null。
   */
  takeAt(id, qid) {
    const c = this.get(id);
    if (!c || c.items.length === 0) return null;
    const idx = c.items.findIndex(i => i.qid === qid);
    if (idx < 0) return null;
    if (c.mode !== 'random') c.cursor = (idx + 1) % c.items.length;
    this.emit('change');
    return { item: c.items[idx], episode: idx + 1, total: c.items.length };
  }

  /**
   * 取下一集并推进游标。返回 { item, episode, total } 或 null（空合集）。
   * episode 从 1 起，供展示「第 N 集」。
   */
  takeNext(id) {
    const c = this.get(id);
    if (!c || c.items.length === 0) return null;
    let idx;
    if (c.mode === 'random') {
      if (!Array.isArray(c.randomPool) || c.randomPool.length === 0) {
        c.randomPool = c.items.map((_, i) => i);
      }
      const pick = Math.floor(Math.random() * c.randomPool.length);
      idx = c.randomPool.splice(pick, 1)[0];
    } else {
      idx = c.cursor;
      c.cursor = (c.cursor + 1) % c.items.length;
    }
    this.emit('change');
    return { item: c.items[idx], episode: idx + 1, total: c.items.length };
  }
}

module.exports = { CollectionManager };
