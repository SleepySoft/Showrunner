'use strict';
/**
 * 应用内自更新：手机遥控器点「检查更新 → 一键升级」，服务端从 GitHub Releases
 * 拉取最新的 showrunner-portable-*.zip，下载完成后派生一个独立的 PowerShell
 * 更新器并退出自己；由该脚本完成「等旧进程退出 → 覆盖文件（保留数据）→ 重启」。
 *
 * 配置：config.json 里 "updateRepo": "用户名/仓库名"（公开仓库，无需 token）。
 * 不配置则检查更新返回「未配置」，其余功能不受影响。
 *
 * 可注入 fetchImpl / spawnImpl / exitImpl 便于测试。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/** 语义化版本比较：a<b → -1，a==b → 0，a>b → 1。容忍 "v" 前缀与非数字尾巴。 */
function compareVersions(a, b) {
  const parse = v => String(v || '').replace(/^v/i, '').split('.').map(x => parseInt(x, 10) || 0);
  const pa = parse(a), pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** 从 release 的 assets 里挑分发包：优先 showrunner-portable-*.zip，退而任意 .zip */
function pickAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const portable = assets.find(a => /showrunner-portable-.*\.zip$/i.test(a.name || ''));
  const anyZip = assets.find(a => /\.zip$/i.test(a.name || ''));
  const picked = portable || anyZip;
  return picked ? { name: picked.name, url: picked.browser_download_url, size: picked.size || 0 } : null;
}

class Updater {
  /**
   * @param {object} o
   * @param {string} o.repo           GitHub "owner/repo"，空则未配置
   * @param {string} o.currentVersion 当前版本（package.json）
   * @param {string} o.rootDir        安装根目录
   * @param {string} o.dataDir        数据目录（下载暂存 + 更新日志，更新时不会被覆盖）
   */
  constructor({ repo, currentVersion, rootDir, dataDir, fetchImpl, spawnImpl, exitImpl }) {
    this.repo = repo || '';
    this.currentVersion = currentVersion || '0.0.0';
    this.rootDir = rootDir;
    this.dataDir = dataDir || path.join(rootDir, 'data');
    this._fetch = fetchImpl || fetch;
    this._spawn = spawnImpl || spawn;
    this._exit = exitImpl || (code => process.exit(code));
    this.phase = 'idle'; // idle | checking | downloading | ready | applying | error
    this.progress = 0;   // 下载百分比
    this.latest = null;  // { version, name, url, size, notes }
    this.error = null;
  }

  status() {
    return {
      configured: !!this.repo,
      currentVersion: this.currentVersion,
      phase: this.phase,
      progress: this.progress,
      latest: this.latest,
      error: this.error
    };
  }

  /** 检查最新版本。有更新时进入 'ready' 之前的 'idle' 并带上 latest。 */
  async check() {
    if (!this.repo) { this.error = '未配置 updateRepo'; return this.status(); }
    this.phase = 'checking';
    this.error = null;
    try {
      const res = await this._fetch(`https://api.github.com/repos/${this.repo}/releases/latest`, {
        headers: { 'User-Agent': 'showrunner-updater', 'Accept': 'application/vnd.github+json' }
      });
      if (!res.ok) throw new Error(`GitHub API 返回 ${res.status}`);
      const release = await res.json();
      const version = String(release.tag_name || '').replace(/^v/i, '');
      const asset = pickAsset(release);
      if (!asset) throw new Error('最新 Release 里没有 zip 分发包');
      if (compareVersions(version, this.currentVersion) > 0) {
        this.latest = { version, name: asset.name, url: asset.url, size: asset.size, notes: release.name || '' };
      } else {
        this.latest = null; // 已是最新
      }
      this.phase = 'idle';
    } catch (e) {
      this.phase = 'error';
      this.error = e.message;
    }
    return this.status();
  }

  /** 下载 + 应用。下载完成派生更新器后本进程退出。 */
  async apply() {
    if (this.phase === 'downloading' || this.phase === 'applying') return this.status();
    if (!this.latest) await this.check();
    if (!this.latest) { if (!this.error) this.error = '已是最新，无需更新'; return this.status(); }

    this.phase = 'downloading';
    this.progress = 0;
    this.error = null;
    try {
      const zipPath = await this._download(this.latest.url);
      this._launchUpdater(zipPath);
      this.phase = 'applying';
    } catch (e) {
      this.phase = 'error';
      this.error = e.message;
    }
    return this.status();
  }

  async _download(url) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const dest = path.join(this.dataDir, 'update-pending.zip');
    const res = await this._fetch(url, { headers: { 'User-Agent': 'showrunner-updater' }, redirect: 'follow' });
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || this.latest.size || 0;
    const out = fs.createWriteStream(dest);
    let got = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.write(Buffer.from(value));
      got += value.length;
      if (total) this.progress = Math.min(99, Math.round(got / total * 100));
    }
    await new Promise((resolve, reject) => { out.end(err => err ? reject(err) : resolve()); });
    this.progress = 100;
    return dest;
  }

  /**
   * 派生独立更新器并退出本进程。
   * 更新器脚本先复制到数据目录再执行——避免覆盖安装目录时写到自己。
   */
  _launchUpdater(zipPath) {
    const src = path.join(this.rootDir, 'scripts', 'self-update.ps1');
    const runCopy = path.join(this.dataDir, 'self-update-run.ps1');
    fs.copyFileSync(src, runCopy);
    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runCopy,
      '-WaitPid', String(process.pid),
      '-InstallDir', this.rootDir,
      '-PackageZip', zipPath
    ];
    const child = this._spawn('powershell', args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref?.();
    // 给更新器一点启动时间后退出自己（退出后它才开始覆盖文件）
    setTimeout(() => this._exit(0), 800).unref?.();
  }
}

module.exports = { Updater, compareVersions, pickAsset };
