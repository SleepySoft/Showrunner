'use strict';
/** Windows 登录时开机启动：使用固定任务名和固定脚本路径，不经过 shell。 */
const path = require('path');
const { execFile } = require('child_process');

class AutostartManager {
  constructor({ rootDir, execFileImpl = execFile, platform = process.platform } = {}) {
    this.rootDir = rootDir;
    this.execFileImpl = execFileImpl;
    this.platform = platform;
    this.taskName = 'Showrunner';
  }

  _run(args) {
    return new Promise((resolve, reject) => {
      this.execFileImpl('schtasks.exe', args, { windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stderr }));
        else resolve(stdout || '');
      });
    });
  }

  async status() {
    if (this.platform !== 'win32') return { supported: false, enabled: false };
    try {
      await this._run(['/Query', '/TN', this.taskName, '/FO', 'LIST']);
      return { supported: true, enabled: true };
    } catch {
      return { supported: true, enabled: false };
    }
  }

  async setEnabled(enabled) {
    if (this.platform !== 'win32') return { supported: false, enabled: false, error: '仅支持 Windows' };
    try {
      if (enabled) {
        const runner = path.join(this.rootDir, 'scripts', 'run-hidden.vbs');
        await this._run([
          '/Create', '/TN', this.taskName, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F',
          '/TR', `wscript.exe "${runner}"`
        ]);
      } else {
        const current = await this.status();
        if (current.enabled) await this._run(['/Delete', '/TN', this.taskName, '/F']);
      }
      return { supported: true, enabled: !!enabled };
    } catch (e) {
      return { supported: true, enabled: !(await this.status()).enabled ? false : true, error: e.stderr || e.message };
    }
  }
}

module.exports = { AutostartManager };
