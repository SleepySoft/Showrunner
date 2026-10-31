'use strict';
/**
 * 节目单管理器：多节目单 CRUD + 复用。
 * 关键设计：「当前播出」的节目单，其 items 数组与 QueueManager.queue 是同一引用——
 * 遥控器对播出中节目单的编辑直接作用于直播队列，无需同步逻辑。
 * 非播出中节目单的条目编辑走本类的 addItem/removeItem/moveItem。
 */
const { EventEmitter } = require('events');
const crypto = require('crypto');

class PlaylistManager extends EventEmitter {
  constructor(persisted) {
    super();
    this.playlists = Array.isArray(persisted?.playlists) ? persisted.playlists : [];
    this.activeId = persisted?.activeId || null;
    if (this.activeId && !this.get(this.activeId)) this.activeId = null;
    for (const p of this.playlists) {
      if (!Array.isArray(p.items)) p.items = [];
    }
  }

  serialize() {
    return { playlists: this.playlists, activeId: this.activeId };
  }

  list() {
    return this.playlists.map(p => ({
      id: p.id, name: p.name, count: p.items.length, active: p.id === this.activeId
    }));
  }

  get(id) { return this.playlists.find(p => p.id === id) || null; }
  active() { return this.get(this.activeId); }

  create(name) {
    const p = {
      id: crypto.randomUUID(),
      name: String(name || '未命名节目单').trim().slice(0, 50) || '未命名节目单',
      items: [],
      createdAt: Date.now()
    };
    this.playlists.push(p);
    this.emit('change');
    return p;
  }

  rename(id, name) {
    const p = this.get(id);
    if (!p) return false;
    const n = String(name || '').trim().slice(0, 50);
    if (n) p.name = n;
    this.emit('change');
    return true;
  }

  /** 删除节目单。返回 { ok, wasActive }；删除播出中的节目单由调用方清空直播队列。 */
  remove(id) {
    const i = this.playlists.findIndex(p => p.id === id);
    if (i === -1) return null;
    const wasActive = this.activeId === id;
    this.playlists.splice(i, 1);
    if (wasActive) this.activeId = null;
    this.emit('change');
    return { ok: true, wasActive };
  }

  /** 设为当前播出。返回节目单（调用方把 items 交给 QueueManager.loadPlaylist）。 */
  activate(id) {
    const p = this.get(id);
    if (!p) return null;
    this.activeId = id;
    this.emit('change');
    return p;
  }

  // ---- 非播出中节目单的条目编辑（播出中的走 QueueManager，共享同一数组）----

  addItem(id, item) {
    const p = this.get(id);
    if (!p) return null;
    const entry = { qid: crypto.randomUUID(), addedAt: Date.now(), ...item };
    p.items.push(entry);
    this.emit('change');
    return entry;
  }

  removeItem(id, qid) {
    const p = this.get(id);
    if (!p) return false;
    const i = p.items.findIndex(x => x.qid === qid);
    if (i === -1) return false;
    p.items.splice(i, 1);
    this.emit('change');
    return true;
  }

  moveItem(id, qid, toIndex) {
    const p = this.get(id);
    if (!p) return false;
    const from = p.items.findIndex(x => x.qid === qid);
    if (from === -1) return false;
    const to = Math.max(0, Math.min(Number(toIndex), p.items.length - 1));
    const [it] = p.items.splice(from, 1);
    p.items.splice(to, 0, it);
    this.emit('change');
    return true;
  }
}

module.exports = { PlaylistManager };
