'use strict';
/**
 * 队列管理器 —— 全系统的「唯一权威」。
 * 电视端不持有任何列表，只能通过 getPublicState() 拿到「现在该放什么」。
 * 所有变更通过 'change' 事件抛出，由 server 负责持久化和广播。
 */
const { EventEmitter } = require('events');
const crypto = require('crypto');

const EMPTY_PLAYBACK = () => ({ status: 'idle', position: 0, duration: 0, volume: 1, updatedAt: Date.now() });

class QueueManager extends EventEmitter {
  /**
   * @param {object} persisted 反序列化的历史状态（currentIndex / playback）
   * @param {Array}  items     播出中节目单的 items 数组（与 PlaylistManager 共享引用）
   */
  constructor(persisted, items) {
    super();
    this.queue = Array.isArray(items) ? items : [];
    this.currentIndex = typeof persisted?.currentIndex === 'number' ? persisted.currentIndex : -1;
    this.playback = persisted?.playback ? { ...EMPTY_PLAYBACK(), ...persisted.playback } : EMPTY_PLAYBACK();
    if (this.currentIndex >= this.queue.length) this.currentIndex = this.queue.length ? this.queue.length - 1 : -1;
    // 条目装饰器：由 server 注入（如缓存状态），输出到 getPublicState().current
    this.decorator = null;
  }

  /** 切换播出节目单：装入其 items，回到第一部待机（保留音量） */
  loadPlaylist(items) {
    this.queue = items;
    this.currentIndex = items.length ? 0 : -1;
    this.playback = { ...EMPTY_PLAYBACK(), volume: this.playback.volume };
    this._changed();
  }

  serialize() {
    return { queue: this.queue, currentIndex: this.currentIndex, playback: this.playback };
  }

  _changed() {
    this.playback.updatedAt = Date.now();
    this.emit('change');
  }

  current() {
    return this.currentIndex >= 0 ? this.queue[this.currentIndex] || null : null;
  }

  /** 加入队尾。item: {mediaId, title, relPath} */
  add(item) {
    const entry = { qid: crypto.randomUUID(), addedAt: Date.now(), ...item };
    this.queue.push(entry);
    // 队列原本为空且未在播放时，自动定位到第一部（但不自动开播）
    if (this.currentIndex === -1) this.currentIndex = 0;
    this._changed();
    return entry;
  }

  remove(qid) {
    const idx = this.queue.findIndex(i => i.qid === qid);
    if (idx === -1) return false;
    this.queue.splice(idx, 1);
    if (this.queue.length === 0) {
      this.currentIndex = -1;
      this.playback = { ...EMPTY_PLAYBACK(), volume: this.playback.volume };
    } else if (idx < this.currentIndex) {
      this.currentIndex--;
    } else if (idx === this.currentIndex) {
      // 删掉了正在播的：原位播下一部，位置归零
      if (this.currentIndex >= this.queue.length) this.currentIndex = this.queue.length - 1;
      this.playback.position = 0;
    }
    this._changed();
    return true;
  }

  move(qid, toIndex) {
    const from = this.queue.findIndex(i => i.qid === qid);
    if (from === -1) return false;
    const to = Math.max(0, Math.min(toIndex, this.queue.length - 1));
    if (from === to) return true;
    const currentQid = this.current()?.qid;
    const [item] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, item);
    if (currentQid) this.currentIndex = this.queue.findIndex(i => i.qid === currentQid);
    this._changed();
    return true;
  }

  clear() {
    this.queue = [];
    this.currentIndex = -1;
    this.playback = { ...EMPTY_PLAYBACK(), volume: this.playback.volume };
    this._changed();
  }

  /** 下一部。到队尾返回 false 并进入「全部播完」待机态。 */
  next() {
    if (this.currentIndex < this.queue.length - 1) {
      this.currentIndex++;
      this.playback.position = 0;
      if (this.playback.status !== 'idle') this.playback.status = 'playing';
      this._changed();
      return true;
    }
    this.currentIndex = -1;
    this.playback = { ...EMPTY_PLAYBACK(), volume: this.playback.volume, status: 'idle' };
    this._changed();
    return false;
  }

  prev() {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      this.playback.position = 0;
      if (this.playback.status !== 'idle') this.playback.status = 'playing';
      this._changed();
      return true;
    }
    return false;
  }

  /** 跳到队列中任意一部并开播 */
  jump(qid) {
    const idx = this.queue.findIndex(i => i.qid === qid);
    if (idx === -1) return false;
    this.currentIndex = idx;
    this.playback.position = 0;
    this.playback.status = 'playing';
    this._changed();
    return true;
  }

  play() {
    if (!this.current() && this.queue.length) this.currentIndex = 0;
    if (!this.current()) return false;
    this.playback.status = 'playing';
    this._changed();
    return true;
  }

  pause() {
    if (!this.current()) return false;
    this.playback.status = 'paused';
    this._changed();
    return true;
  }

  seek(position) {
    this.playback.position = Math.max(0, Number(position) || 0);
    this._changed();
    return true;
  }

  setVolume(volume) {
    this.playback.volume = Math.max(0, Math.min(1, Number(volume)));
    this._changed();
    return true;
  }

  /** 电视端心跳：回报真实播放进度（不触发广播风暴，由 server 节流） */
  reportPosition(position, duration) {
    this.playback.position = Math.max(0, Number(position) || 0);
    if (duration > 0) this.playback.duration = Number(duration);
  }

  /** 对外公开状态：电视端和遥控器共用这一份 */
  getPublicState() {
    const cur = this.current();
    return {
      status: this.playback.status,
      position: this.playback.position,
      duration: this.playback.duration,
      volume: this.playback.volume,
      updatedAt: this.playback.updatedAt,
      current: cur ? { ...cur, ...(this.decorator ? this.decorator(cur) : {}), index: this.currentIndex } : null,
      queueLength: this.queue.length,
      upcoming: this.queue.slice(Math.max(this.currentIndex, 0) + (cur ? 1 : 0), Math.max(this.currentIndex, 0) + 4)
        .map(i => ({ qid: i.qid, title: i.title }))
    };
  }
}

module.exports = { QueueManager };
