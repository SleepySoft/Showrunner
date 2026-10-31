'use strict';
/**
 * 浏览器进程托管：
 *  - 普通模式：确保 kiosk Chrome 活着（退出自动重拉，10 秒冷却防风暴）
 *  - 维护模式：杀掉 kiosk，用系统默认浏览器开一次普通窗口；
 *    超时（默认 10 分钟）自动回到普通模式并重新拉起 kiosk
 * kiosk 用独立 user-data-dir，与用户日常 Chrome 完全隔离，
 * taskkill 只杀受控进程树，不会误伤用户自己的浏览窗口。
 * spawnImpl / execImpl 可注入，便于测试。
 */
const { EventEmitter } = require('events');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

/** 探测 Chrome / Edge 可执行文件（可用 config.json 的 chromePath 覆盖） */
function findBrowser() {
  if (process.platform === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA];
    const rels = [
      'Google\\Chrome\\Application\\chrome.exe',
      'Microsoft\\Edge\\Application\\msedge.exe'
    ];
    for (const r of roots) {
      for (const rel of rels) {
        const p = r && path.join(r, rel);
        try { if (p && fs.existsSync(p)) return p; } catch { /* 继续找 */ }
      }
    }
    return null;
  }
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return 'google-chrome';
}

class BrowserController extends EventEmitter {
  constructor({
    tvUrl, chromePath, manage = true, maintenanceMinutes = 10,
    spawnImpl = spawn, execImpl = exec, relaunchCooldownMs = 10000
  }) {
    super();
    this.tvUrl = tvUrl;
    this.chromePath = chromePath || findBrowser();
    this.manage = manage;
    this.maintenanceMs = maintenanceMinutes * 60000;
    this.spawnImpl = spawnImpl;
    this.execImpl = execImpl;
    this.relaunchCooldownMs = relaunchCooldownMs;

    this.mode = 'normal';          // normal | maintenance
    this.kiosk = null;
    this.lastLaunch = 0;
    this.maintenanceUntil = 0;
    this.timer = null;
    this._warned = false;
  }

  start(intervalMs = 5000) {
    if (!this.manage) return;
    this.timer = setInterval(() => this.tick(), intervalMs);
    if (this.timer.unref) this.timer.unref();
    this.tick(); // 立即确保 kiosk 拉起
  }

  stop() {
    clearInterval(this.timer);
    this._killKiosk();
  }

  status() {
    return {
      mode: this.mode,
      manageBrowser: this.manage,
      kioskRunning: !!this.kiosk,
      maintenanceUntil: this.maintenanceUntil || null,
      browserFound: !!this.chromePath
    };
  }

  setMode(mode) {
    if (mode !== 'normal' && mode !== 'maintenance') return null;
    if (mode === this.mode) return this.status();
    this.mode = mode;
    if (mode === 'maintenance') {
      this.maintenanceUntil = Date.now() + this.maintenanceMs;
      if (this.manage) { this._killKiosk(); this._openNormalOnce(); }
    } else {
      this.maintenanceUntil = 0;
      if (this.manage) this._ensureKiosk();
    }
    this.emit('change', this.status());
    return this.status();
  }

  tick() {
    if (!this.manage) return;
    if (this.mode === 'maintenance') {
      if (Date.now() > this.maintenanceUntil) this.setMode('normal'); // 超时自动回锁
      return;
    }
    this._ensureKiosk();
  }

  _ensureKiosk() {
    if (this.kiosk) return;
    if (!this.chromePath) { this._warnOnce(); return; }
    if (Date.now() - this.lastLaunch < this.relaunchCooldownMs) return;
    this.lastLaunch = Date.now();

    const profile = path.join(os.tmpdir(), 'showrunner-kiosk-profile');
    const args = [
      `--user-data-dir=${profile}`,
      '--kiosk', '--no-first-run', '--no-default-browser-check',
      '--disable-session-crashed-bubble', '--autoplay-policy=no-user-gesture-required',
      this.tvUrl
    ];
    let proc;
    try { proc = this.spawnImpl(this.chromePath, args, { stdio: 'ignore' }); }
    catch { this.chromePath = null; this._warnOnce(); return; }
    this.kiosk = proc;
    proc.on('exit', () => { this.kiosk = null; this.emit('change', this.status()); });
    proc.on('error', () => { this.kiosk = null; });
    this.emit('change', this.status());
  }

  _killKiosk() {
    const proc = this.kiosk;
    this.kiosk = null;
    if (!proc) return;
    try {
      if (process.platform === 'win32') this.execImpl(`taskkill /PID ${proc.pid} /T /F`);
      else proc.kill('SIGKILL');
    } catch { /* 已退出 */ }
  }

  /** 维护模式：系统默认浏览器开一个普通窗口（用户自己的浏览器，非受控实例） */
  _openNormalOnce() {
    const url = this.tvUrl;
    try {
      if (process.platform === 'win32') this.execImpl(`cmd /c start "" "${url}"`);
      else if (process.platform === 'darwin') this.execImpl(`open "${url}"`);
      else this.execImpl(`xdg-open "${url}"`);
    } catch { /* 打不开就算了 */ }
  }

  _warnOnce() {
    if (!this.chromePath && !this._warned) {
      this._warned = true;
      console.warn('未找到 Chrome/Edge，kiosk 自动管理不可用。可在 config.json 配置 chromePath。');
    }
  }
}

module.exports = { BrowserController, findBrowser };
