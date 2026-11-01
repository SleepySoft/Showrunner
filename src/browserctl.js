'use strict';
/**
 * 浏览器进程托管：
 *  - 普通模式：确保 kiosk Chrome 活着（退出自动重拉，10 秒冷却防风暴）
 *  - 维护模式：杀掉 kiosk，启动一个同样受控的非 kiosk 维护窗口；
 *    超时（默认 10 分钟）自动回到普通模式并重新拉起 kiosk
 * 两种窗口都有独立 user-data-dir，与用户日常 Chrome 完全隔离；模式切换会先
 * 等旧受控进程树退出再启动新实例，保证本控制器任一时刻最多托管一个浏览器。
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
    spawnImpl = spawn, execImpl = exec, relaunchCooldownMs = 10000,
    initialMode = 'normal'
  }) {
    super();
    this.tvUrl = tvUrl;
    this.chromePath = chromePath || findBrowser();
    this.manage = manage;
    this.maintenanceMs = maintenanceMinutes * 60000;
    this.spawnImpl = spawnImpl;
    this.execImpl = execImpl;
    this.relaunchCooldownMs = relaunchCooldownMs;

    this.mode = initialMode === 'offline' ? 'offline' : 'normal'; // normal | maintenance | offline
    this.kiosk = null;
    this.maintenanceBrowser = null;
    this.lastLaunch = 0;
    this.maintenanceUntil = 0;
    this.timer = null;
    this._warned = false;
    this._transition = Promise.resolve();
  }

  async start(intervalMs = 5000) {
    if (!this.manage) return;
    await this._cleanupOrphanedManagedBrowsers();
    this.timer = setInterval(() => this.tick(), intervalMs);
    if (this.timer.unref) this.timer.unref();
    await this.tick(); // 立即确保 kiosk 拉起
  }

  async stop() {
    clearInterval(this.timer);
    await Promise.all([this._killKiosk(), this._killMaintenanceBrowser()]);
  }

  status() {
    return {
      mode: this.mode,
      manageBrowser: this.manage,
      kioskRunning: !!this.kiosk,
      maintenanceBrowserRunning: !!this.maintenanceBrowser,
      managedBrowserRunning: !!(this.kiosk || this.maintenanceBrowser),
      maintenanceUntil: this.maintenanceUntil || null,
      browserFound: !!this.chromePath
    };
  }

  setMode(mode) {
    if (!['normal', 'maintenance', 'offline'].includes(mode)) return Promise.resolve(null);
    const run = this._transition.then(() => this._applyMode(mode));
    this._transition = run.catch(() => {});
    return run;
  }

  async _applyMode(mode) {
    if (mode === this.mode) return this.status();
    this.mode = mode;
    if (mode === 'maintenance') {
      this.maintenanceUntil = Date.now() + this.maintenanceMs;
      if (this.manage) {
        await this._killKiosk();
        await this._killMaintenanceBrowser(); // 防御：清理任何残留引用
        this._openMaintenanceBrowser();
      }
    } else if (mode === 'offline') {
      this.maintenanceUntil = 0;
      if (this.manage) {
        await this._killKiosk();
        await this._killMaintenanceBrowser();
      }
    } else {
      this.maintenanceUntil = 0;
      if (this.manage) {
        await this._killMaintenanceBrowser();
        await this._killKiosk(); // 防御：避免丢失状态时重复拉起
        this.lastLaunch = 0; // 显式切换不受意外退出冷却限制
        this._ensureKiosk();
      }
    }
    this.emit('change', this.status());
    return this.status();
  }

  async tick() {
    if (!this.manage) return;
    if (this.mode === 'offline') return;
    if (this.mode === 'maintenance') {
      if (Date.now() > this.maintenanceUntil) await this.setMode('normal'); // 超时自动回锁
      return;
    }
    this._ensureKiosk();
  }

  _ensureKiosk() {
    if (this.kiosk) return;
    if (this.maintenanceBrowser) return; // 单实例不变量：旧模式未回收时绝不拉新实例
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
    proc.on('exit', () => { if (this.kiosk === proc) this.kiosk = null; this.emit('change', this.status()); });
    proc.on('error', () => { if (this.kiosk === proc) this.kiosk = null; });
    this.emit('change', this.status());
  }

  _killKiosk() {
    const proc = this.kiosk;
    this.kiosk = null;
    return this._killProcess(proc);
  }

  _openMaintenanceBrowser() {
    if (this.kiosk || this.maintenanceBrowser || !this.chromePath) return;
    const profile = path.join(os.tmpdir(), 'showrunner-maintenance-profile');
    const args = [
      `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble',
      '--autoplay-policy=no-user-gesture-required', '--new-window', this.tvUrl
    ];
    let proc;
    try { proc = this.spawnImpl(this.chromePath, args, { stdio: 'ignore' }); }
    catch { this.chromePath = null; this._warnOnce(); return; }
    this.maintenanceBrowser = proc;
    proc.on('exit', () => { if (this.maintenanceBrowser === proc) this.maintenanceBrowser = null; this.emit('change', this.status()); });
    proc.on('error', () => { if (this.maintenanceBrowser === proc) this.maintenanceBrowser = null; });
    this.emit('change', this.status());
  }

  _killMaintenanceBrowser() {
    const proc = this.maintenanceBrowser;
    this.maintenanceBrowser = null;
    return this._killProcess(proc);
  }

  _killProcess(proc) {
    if (!proc) return Promise.resolve();
    if (process.platform !== 'win32') {
      try { proc.kill('SIGKILL'); } catch { /* 已退出 */ }
      return Promise.resolve();
    }
    return new Promise(resolve => {
      try {
        this.execImpl(`taskkill /PID ${Number(proc.pid)} /T /F`, () => resolve());
      } catch { resolve(); }
    });
  }

  /** 清理由上次服务异常退出遗留的专用 profile 进程；不匹配用户日常浏览器。 */
  _cleanupOrphanedManagedBrowsers() {
    if (process.platform !== 'win32') return Promise.resolve();
    const script = "Get-CimInstance Win32_Process | Where-Object { $cmd=$_.CommandLine; ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and (($cmd -like '*showrunner-kiosk-profile*') -or ($cmd -like '*showrunner-maintenance-profile*')) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
    return new Promise(resolve => {
      try { this.execImpl(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`, () => resolve()); }
      catch { resolve(); }
    });
  }

  _warnOnce() {
    if (!this.chromePath && !this._warned) {
      this._warned = true;
      console.warn('未找到 Chrome/Edge，kiosk 自动管理不可用。可在 config.json 配置 chromePath。');
    }
  }
}

module.exports = { BrowserController, findBrowser };
