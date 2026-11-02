'use strict';

const { PlaybackFrontend } = require('./frontend');

/** Chrome 的媒体控制仍由 /tv 页面和电视 WebSocket执行；此适配器统一生命周期契约。 */
class ChromeFrontend extends PlaybackFrontend {
  constructor(browserController) {
    super('chrome');
    this.browser = browserController;
  }

  async start() {
    // 非托管模式（开发/调试）绝不拉起 kiosk；调试 Chrome 前端直接打开 /tv/ 页面即可
    if (!this.browser.manage) return false;
    return !!(await this.browser.setMode('normal'));
  }
  async stop() { await this.browser.setMode('offline'); }
  async load() {}
  status() {
    const s = this.browser.status();
    return {
      type: this.type,
      available: s.browserFound,
      running: s.kioskRunning,
      ready: s.kioskRunning,
      lastError: !s.manageBrowser ? '非托管模式：不拉起 kiosk，请直接打开 /tv/ 页面调试' : (s.browserFound ? null : '未找到 Chrome/Edge')
    };
  }
}

module.exports = { ChromeFrontend };
