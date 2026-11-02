'use strict';

const { EventEmitter } = require('events');

/**
 * 播放前端契约。具体前端只负责呈现和回报事实，不拥有频道或推进队列。
 * 事件：ready、position、ended、error、input、exit、change。
 */
class PlaybackFrontend extends EventEmitter {
  constructor(type) {
    super();
    this.type = type;
  }

  async start() { throw new Error(`${this.type}.start() 未实现`); }
  async stop() { throw new Error(`${this.type}.stop() 未实现`); }
  async load(_source, _options) { throw new Error(`${this.type}.load() 未实现`); }
  async play() {}
  async pause() {}
  async seek(_position) {}
  async setVolume(_volume) {}
  async showStandby(_waiting) {}
  async showMenu(_model) {}
  status() { return { type: this.type, running: false, ready: false, lastError: null }; }
}

module.exports = { PlaybackFrontend };
