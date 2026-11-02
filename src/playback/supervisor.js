'use strict';

const { EventEmitter } = require('events');

/**
 * 统一托管播放前端和维护浏览器，保持“正常播放实例最多一个”的不变量。
 * 模式切换及前端切换均串行执行。
 * watchdog（自动拉起）开启时：正常模式自动启动所选前端、崩溃自动重拉；
 * 关闭时：前端保持关闭，只能由 openFrontend() 手动打开。
 */
class FrontendSupervisor extends EventEmitter {
  constructor({ browser, frontends, selected = 'chrome', resolver, manage = true, watchdog = true, initialMode = 'normal', onSelectionChange, relaunchCooldownMs = 5000 }) {
    super();
    this.browser = browser;
    this.frontends = frontends;
    this.selected = frontends[selected] ? selected : 'chrome';
    this.resolver = resolver;
    this.manageBrowser = typeof browser.manage === 'boolean' ? !!browser.manage : !!manage;
    this.manage = !!manage;
    this.watchdog = !!watchdog;
    this.mode = initialMode === 'offline' ? 'offline' : 'normal';
    this.onSelectionChange = onSelectionChange;
    this.relaunchCooldownMs = relaunchCooldownMs;
    this._transition = Promise.resolve();
    this._lastState = null;
    this._lastLoadKey = null;
    this._lastReportedError = null;
    this._restartTimer = null;

    for (const frontend of Object.values(frontends)) {
      frontend.on('change', () => this.emit('change', this.status()));
      frontend.on('position', event => this.emit('position', event));
      frontend.on('ended', event => this.emit('ended', event));
      frontend.on('error', event => this.emit('playbackError', event));
      frontend.on('audioFailed', event => { this.emit('audioFailed', event); this._restartAfterAudioFailure(); });
      frontend.on('input', action => this.emit('input', action));
      frontend.on('ready', () => this.sync(this._lastState));
      frontend.on('exit', () => this._scheduleRestart());
    }
    browser.on('change', () => this.emit('change', this.status()));
  }

  async start() {
    if (!this.manage) return this.status();
    await this.browser.start();
    if (this.mode === 'offline') await this.browser.setMode('offline');
    else if (this.watchdog) await this._startSelected(); // 看门狗关闭时保持关闭，等手动打开
    return this.status();
  }

  async stop() {
    clearTimeout(this._restartTimer);
    await this.frontends.mpv?.stop();
    await this.browser.stop();
  }

  status() {
    const browser = this.browser.status();
    const player = this.frontends[this.selected]?.status() || null;
    return {
      mode: this.mode,
      manageBrowser: this.manageBrowser,
      manageFrontend: this.manage,
      watchdog: this.watchdog,
      frontend: this.selected,
      playerRunning: !!player?.running,
      kioskRunning: this.selected === 'chrome' && !!browser.kioskRunning,
      maintenanceBrowserRunning: !!browser.maintenanceBrowserRunning,
      managedBrowserRunning: !!browser.managedBrowserRunning,
      maintenanceUntil: browser.maintenanceUntil,
      browserFound: browser.browserFound,
      player,
      frontends: Object.fromEntries(Object.entries(this.frontends).map(([key, value]) => [key, value.status()]))
    };
  }

  setMode(mode) {
    if (!['normal', 'maintenance', 'offline'].includes(mode)) return Promise.resolve(null);
    return this._serial(() => this._applyMode(mode));
  }

  setFrontend(type) {
    if (!this.frontends[type]) {
      return Promise.resolve({ ok: false, error: `未注册播放前端：${type || '空'}`, status: this.status() });
    }
    return this._serial(() => this._applyFrontend(type));
  }

  /** 看门狗开关：开启时按模式自动拉起；关闭时停止当前前端并保持关闭。 */
  setWatchdog(enabled) {
    return this._serial(async () => {
      enabled = !!enabled;
      const changed = enabled !== this.watchdog;
      this.watchdog = enabled;
      this.browser.setWatchdog?.(enabled);
      if (this.mode === 'normal') {
        if (enabled) {
          if (!this.frontends[this.selected]?.status().running) await this._startSelected();
        } else {
          await this._stopSelected();
        }
      }
      if (changed) this.emit('change', this.status());
      return this.status();
    });
  }

  /** 手动打开所选前端（一次性；不改变看门狗状态）。 */
  openFrontend() {
    return this._serial(async () => {
      if (!this.manage) return { ok: false, error: '播放前端托管未启用', status: this.status() };
      if (this.mode !== 'normal') {
        return {
          ok: false,
          error: this.mode === 'offline' ? '已下线，请先重新上线' : '维护模式中，回锁后可打开',
          status: this.status()
        };
      }
      const ok = await this._startSelected();
      this.emit('change', this.status());
      return { ok, error: ok ? null : (this.frontends[this.selected].status().lastError || '前端启动失败'), status: this.status() };
    });
  }

  /** 手动关闭所选前端，同时停用看门狗，保证关闭后不再被自动拉起。 */
  closeFrontend() {
    return this._serial(async () => {
      if (!this.manage) return { ok: false, error: '播放前端托管未启用', status: this.status() };
      await this._stopSelected();
      this.watchdog = false;
      this.browser.setWatchdog?.(false);
      this.emit('change', this.status());
      return { ok: true, status: this.status() };
    });
  }

  async _applyMode(mode) {
    if (mode === this.mode) return this.status();
    clearTimeout(this._restartTimer);
    if (mode === 'maintenance') {
      await this._stopSelected();
      await this.browser.setMode('maintenance');
    } else if (mode === 'offline') {
      await this._stopSelected();
      await this.browser.setMode('offline');
    } else {
      await this.browser.setMode('offline');
      this.mode = 'normal';
      if (this.watchdog) {
        const ok = await this._startSelected();
        if (!ok) this.emit('change', this.status());
      }
    }
    this.mode = mode;
    this.emit('change', this.status());
    return this.status();
  }

  async _applyFrontend(type) {
    if (type === this.selected) return { ok: true, status: this.status() };
    const previous = this.selected;
    await this._stopSelected();
    this.selected = type;
    this._lastLoadKey = null;
    let ok = true;
    if (this.mode === 'normal') ok = await this._startSelected();
    if (!ok) {
      await this._stopSelected();
      this.selected = previous;
      if (this.mode === 'normal') await this._startSelected();
      const error = this.frontends[type].status().lastError || `${type} 启动失败`;
      this.emit('change', this.status());
      return { ok: false, error, status: this.status() };
    }
    try { await this.onSelectionChange?.(type); }
    catch (error) {
      await this._stopSelected();
      this.selected = previous;
      if (this.mode === 'normal') await this._startSelected();
      return { ok: false, error: `配置保存失败：${error.message}`, status: this.status() };
    }
    this.emit('change', this.status());
    return { ok: true, status: this.status() };
  }

  async _startSelected() {
    if (!this.manage || this.mode !== 'normal') return true;
    if (this.selected === 'chrome') {
      const ok = await this.frontends.chrome.start();
      this._lastLoadKey = null;
      return ok;
    }
    await this.browser.setMode('offline');
    const ok = await this.frontends.mpv.start();
    if (ok) this.sync(this._lastState);
    return ok;
  }

  async _stopSelected() {
    this._lastLoadKey = null;
    if (this.selected === 'chrome') await this.frontends.chrome.stop();
    else await this.frontends[this.selected]?.stop();
  }

  async sync(state) {
    const previous = this._lastState;
    if (state) this._lastState = state;
    if (!this.manage || this.mode !== 'normal' || this.selected !== 'mpv' || !this._lastState) return;
    const frontend = this.frontends.mpv;
    if (!frontend.status().running) return;
    if (!frontend.status().ready) return; // IPC 连上后 ready 事件会重放最后权威状态
    const { current, status, position, volume, waiting } = this._lastState;
    if (!current || status === 'idle') {
      this._lastLoadKey = null;
      await frontend.showStandby(waiting || {});
      return;
    }
    const resolved = this.resolver.resolve(current, 'mpv');
    if (resolved.status === 'waiting') {
      this._lastLoadKey = null;
      await frontend.showStandby({ nextTitle: `正在缓存 ${resolved.progress || 0}%` });
      return;
    }
    if (resolved.status === 'error') {
      const key = `${current.qid}:${resolved.error}`;
      if (this._lastReportedError !== key) {
        this._lastReportedError = key;
        this.emit('playbackError', { qid: current.qid, kind: 'source_error', detail: resolved.error });
      }
      return;
    }
    const key = `${current.qid}:${resolved.source.uri}`;
    if (this._lastLoadKey !== key || frontend.status().currentQid !== current.qid) {
      this._lastLoadKey = key;
      this._lastReportedError = null;
      await frontend.load(resolved.source, { qid: current.qid, position, paused: status === 'paused' });
    } else if (previous?.current?.qid === current.qid
      && previous.updatedAt !== this._lastState.updatedAt
      && Math.abs((Number(previous.position) || 0) - (Number(position) || 0)) > 0.5) {
      await frontend.seek(position);
    }
    await frontend.setVolume(volume ?? 1);
    if (status === 'paused') await frontend.pause();
    else if (status === 'playing') await frontend.play();
  }

  showMenu(model) {
    if (this.selected === 'mpv' && this.mode === 'normal') return this.frontends.mpv.showMenu(model);
  }

  _scheduleRestart() {
    if (!this.manage || !this.watchdog || this.mode !== 'normal' || this.selected !== 'mpv') return;
    clearTimeout(this._restartTimer);
    this._restartTimer = setTimeout(() => this._serial(async () => {
      if (this.mode !== 'normal' || this.selected !== 'mpv') return;
      await this.frontends.mpv.stop();
      await this.frontends.mpv.start();
      await this.sync(this._lastState);
    }), this.relaunchCooldownMs);
    this._restartTimer.unref?.();
  }

  /**
   * mpv 报告音频输出未启动（文件有音轨但 ao 为空）：重启 mpv 让音频设备重新初始化。
   * 同一节目只重启一次，避免设备确实不可用时陷入重启循环。
   */
  async _restartAfterAudioFailure() {
    if (!this.manage || this.mode !== 'normal' || this.selected !== 'mpv') return;
    const key = this._lastLoadKey;
    if (!key || this._audioRestartedKey === key) return;
    this._audioRestartedKey = key;
    clearTimeout(this._restartTimer);
    await this._serial(async () => {
      if (this.mode !== 'normal' || this.selected !== 'mpv') return;
      if (!this.frontends.mpv.status().running) return;
      await this.frontends.mpv.stop();
      await this.frontends.mpv.start();
      await this.sync(this._lastState);
    });
  }

  _serial(action) {
    const run = this._transition.then(action);
    this._transition = run.catch(() => {});
    return run;
  }
}

module.exports = { FrontendSupervisor };
