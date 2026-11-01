'use strict';
/**
 * 队列管理器 —— 全系统的「唯一权威」。
 * 电视端不持有任何列表，只能通过 getPublicState() 拿到「现在该放什么」。
 * 所有变更通过 'change' 事件抛出，由 server 负责持久化和广播。
 *
 * 合集条目（type='collection'）：轮到它成为当前片时经 resolver 抽一集，
 * 解析结果记录在条目上（resolved），重启续播不串集；新一轮播出（换节目单、
 * 循环回卷）强制抽新集。
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
    // 合集解析器：由 server 注入，轮到「合集抽一集」条目时取其下一集
    this.resolver = null;
    // 循环播放标志（播出节目单/时刻表规则设定）
    this.loop = false;
    this.waiting = null; // { reason, nextStartAt, nextTitle }，严格排时/纯点播的待机画面
    // 重启续播：当前条目若已解析过合集剧集，保持原解析（进度才不串集）
    this._lastCurrentQid = this.current()?.qid ?? null;
  }

  /** 切换播出节目单：装入其 items，回到第一部待机（保留音量） */
  loadPlaylist(items, opts = {}) {
    this.queue = items;
    this.loop = !!opts.loop;
    this.currentIndex = items.length ? 0 : -1;
    this.playback = { ...EMPTY_PLAYBACK(), volume: this.playback.volume };
    this.waiting = null;
    this._resolveCurrent(true); // 换节目单 = 新一轮播出，合集条目抽新集
    this._changed();
  }

  serialize() {
    return { queue: this.queue, currentIndex: this.currentIndex, playback: this.playback };
  }

  _changed() {
    this.playback.updatedAt = Date.now();
    this.emit('change');
  }

  /**
   * 合集条目解析：轮到「合集抽一集」时，向 resolver 取下一集并记到条目上。
   * 同一 qid 连续停留不重复抽取；换节目单/循环回卷时由 force 强制换新一集。
   */
  _resolveCurrent(force = false) {
    const cur = this.current();
    if (cur && cur.type === 'collection') {
      if (force || !cur.resolved || cur.qid !== this._lastCurrentQid) {
        const r = this.resolver ? this.resolver(cur) : null;
        cur.resolved = r || null;
        if (r) delete cur.resolvedError;
        else cur.resolvedError = '合集为空或不存在';
      }
    }
    this._lastCurrentQid = cur ? cur.qid : null;
  }

  /** 条目的有效播放体：合集条目取已解析的那一集 */
  _effective(item) {
    return item && item.type === 'collection' ? (item.resolved || null) : item;
  }

  current() {
    return this.currentIndex >= 0 ? this.queue[this.currentIndex] || null : null;
  }

  /** 加入队尾。item: {mediaId, title, relPath} 或网页/合集条目 */
  add(item) {
    const entry = { qid: crypto.randomUUID(), addedAt: Date.now(), ...item };
    this.queue.push(entry);
    // 队列原本为空且未在播放时，自动定位到第一部（但不自动开播）
    if (this.currentIndex === -1) {
      this.currentIndex = 0;
      this._resolveCurrent();
    }
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
      // 删掉了正在播的：原位接下一部，进度归零
      if (this.currentIndex >= this.queue.length) this.currentIndex = this.queue.length - 1;
      this.playback.position = 0;
    }
    this._resolveCurrent();
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
    this._lastCurrentQid = null;
    this.playback = { ...EMPTY_PLAYBACK(), volume: this.playback.volume };
    this.waiting = null;
    this._changed();
  }

  /** 下一部。到队尾：loop 则回卷重播（合集条目抽新集），否则进入待机态。 */
  next() {
    this.waiting = null;
    if (this.currentIndex < this.queue.length - 1) {
      this.currentIndex++;
      this.playback.position = 0;
      if (this.playback.status !== 'idle') this.playback.status = 'playing';
      this._resolveCurrent();
      this._changed();
      return true;
    }
    if (this.loop && this.queue.length) {
      this.currentIndex = 0;
      this.playback.position = 0;
      if (this.playback.status !== 'idle') this.playback.status = 'playing';
      this._resolveCurrent(true);
      this._changed();
      return true;
    }
    this.currentIndex = -1;
    this._lastCurrentQid = null;
    this.playback = { ...EMPTY_PLAYBACK(), volume: this.playback.volume, status: 'idle' };
    this._changed();
    return false;
  }

  prev() {
    this.waiting = null;
    if (this.currentIndex > 0) {
      this.currentIndex--;
      this.playback.position = 0;
      if (this.playback.status !== 'idle') this.playback.status = 'playing';
      this._resolveCurrent();
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
    this.waiting = null;
    this._resolveCurrent();
    this._changed();
    return true;
  }

  play() {
    if (!this.current() && this.queue.length) this.currentIndex = 0;
    if (!this.current()) return false;
    this._resolveCurrent();
    this.playback.status = 'playing';
    this.waiting = null;
    this._changed();
    return true;
  }

  pause() {
    if (!this.current()) return false;
    this.playback.status = 'paused';
    this._changed();
    return true;
  }

  /** 保留频道内容但进入空闲画面，等待定时节目或点播。 */
  standby(waiting = null) {
    this.currentIndex = -1;
    this._lastCurrentQid = null;
    this.playback = { ...EMPTY_PLAYBACK(), volume: this.playback.volume, status: 'idle' };
    this.waiting = waiting;
    this._changed();
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
    let current = null;
    if (cur) {
      const eff = this._effective(cur);
      current = { ...cur, index: this.currentIndex };
      if (cur.type === 'collection') {
        if (eff) {
          // 对外伪装成普通条目：电视端无感播放，标题带集数
          current.type = eff.type;
          current.mediaId = eff.mediaId;
          current.url = eff.url;
          current.relPath = eff.relPath;
          current.title = `《${cur.title}》第${eff.episode}集 ${eff.title}`;
          current.collectionId = cur.collectionId;
        } else {
          current.cacheError = cur.resolvedError || '合集为空';
        }
      }
      Object.assign(current, this.decorator ? this.decorator(eff || cur) : {});
    }
    return {
      status: this.playback.status,
      position: this.playback.position,
      duration: this.playback.duration,
      volume: this.playback.volume,
      updatedAt: this.playback.updatedAt,
      waiting: this.waiting,
      current,
      queueLength: this.queue.length,
      upcoming: this.queue.slice(Math.max(this.currentIndex, 0) + (cur ? 1 : 0), Math.max(this.currentIndex, 0) + 4)
        .map(i => ({ qid: i.qid, title: i.type === 'collection' ? `《${i.title}》抽一集` : i.title }))
    };
  }
}

module.exports = { QueueManager };
