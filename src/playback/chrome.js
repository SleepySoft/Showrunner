'use strict';

const { PlaybackFrontend } = require('./frontend');

/** Chrome 的媒体控制仍由 /tv 页面和电视 WebSocket执行；此适配器统一生命周期契约。 */
class ChromeFrontend extends PlaybackFrontend {
  constructor(browserController) {
    super('chrome');
    this.browser = browserController;
  }

  async start() { return !!(await this.browser.setMode('normal')); }
  async stop() { await this.browser.setMode('offline'); }
  async load() {}
  status() {
    const s = this.browser.status();
    return {
      type: this.type,
      available: s.browserFound,
      running: s.kioskRunning,
      ready: s.kioskRunning,
      lastError: s.browserFound ? null : '未找到 Chrome/Edge'
    };
  }
}

module.exports = { ChromeFrontend };
