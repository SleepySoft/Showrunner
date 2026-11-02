'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn, spawnSync, execFile } = require('child_process');
const { PlaybackFrontend } = require('./frontend');

function findMpv(configured, rootDir) {
  const names = process.platform === 'win32' ? ['mpv.exe'] : ['mpv'];
  const candidates = [configured, ...names.map(n => path.join(rootDir || process.cwd(), 'bin', n))];
  if (process.platform === 'win32') {
    candidates.push(path.join(process.env.PROGRAMFILES || '', 'mpv', 'mpv.exe'));
    candidates.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'mpv', 'mpv.exe'));
  }
  for (const candidate of candidates) {
    try { if (candidate && fs.existsSync(candidate)) return path.resolve(candidate); } catch {}
  }
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    const found = spawnSync(command, [names[0]], { encoding: 'utf8', windowsHide: true });
    const first = String(found.stdout || '').split(/\r?\n/).find(Boolean);
    if (found.status === 0 && first) return first.trim();
  } catch {}
  return null;
}

function defaultIpcPath() {
  return process.platform === 'win32'
    ? '\\\\.\\pipe\\showrunner-mpv'
    : path.join(os.tmpdir(), `showrunner-mpv-${process.pid}.sock`);
}

/** 只清理带 Showrunner 专用 IPC 标记的遗留 mpv，不影响用户自己打开的 mpv。 */
function cleanupManagedMpv() {
  if (process.platform !== 'win32') return Promise.resolve();
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'mpv.exe' -and $_.CommandLine -like '*showrunner-mpv*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  return new Promise(resolve => {
    try { execFile('powershell', ['-NoProfile', '-Command', script], { windowsHide: true }, () => resolve()); }
    catch { resolve(); }
  });
}

class MpvFrontend extends PlaybackFrontend {
  constructor({ mpvPath, rootDir, ipcPath = defaultIpcPath(), inputConf, windowed = false, spawnImpl = spawn, connectImpl = p => net.createConnection(p), cleanupImpl = cleanupManagedMpv, available } = {}) {
    super('mpv');
    this.mpvPath = mpvPath || findMpv(null, rootDir);
    this.available = available === undefined ? !!this.mpvPath : !!available;
    this.ipcPath = ipcPath;
    this.inputConf = inputConf || path.join(__dirname, 'mpv-input.conf');
    this.windowed = !!windowed;
    this.spawnImpl = spawnImpl;
    this.connectImpl = connectImpl;
    this.cleanupImpl = cleanupImpl;
    this.proc = null;
    this.socket = null;
    this.buffer = '';
    this.currentQid = null;
    this.currentSource = null;
    this.duration = 0;
    this.lastError = null;
    this._requestId = 0;
    this._pendingSeek = 0; // 文件载入完成（拿到 duration）后再补的起始位置
    this._stopping = false;
    this._connectTimer = null;
  }

  async start() {
    if (this.proc) return true;
    if (!this.available || !this.mpvPath) {
      this.lastError = '未找到 mpv；请在 config.json 配置 mpvPath';
      this.emit('change', this.status());
      return false;
    }
    this._stopping = false;
    await this.cleanupImpl();
    if (process.platform !== 'win32') { try { fs.unlinkSync(this.ipcPath); } catch {} }
    // 开发/调试的窗口化模式用最大化普通窗口代替全屏置顶无边框，保证可自由操作
    const args = [
      ...(this.windowed ? ['--window-maximized'] : ['--fullscreen', '--ontop', '--no-border']),
      '--idle=yes', '--force-window=yes',
      '--no-osc', ...(this.windowed ? [] : ['--cursor-autohide=always']),
      '--hwdec=auto-safe', '--keep-open=no', '--title=Showrunner',
      `--input-ipc-server=${this.ipcPath}`, `--input-conf=${this.inputConf}`
    ];
    try {
      const proc = this.spawnImpl(this.mpvPath, args, { stdio: 'ignore', windowsHide: true });
      this.proc = proc;
      proc.on('exit', (code, signal) => this._onExit(proc, code, signal));
      proc.on('error', error => this._onProcessError(proc, error));
      this._scheduleConnect(0);
      this.emit('change', this.status());
      return true;
    } catch (error) {
      this.lastError = error.message;
      this.proc = null;
      this.emit('change', this.status());
      return false;
    }
  }

  async stop() {
    this._stopping = true;
    clearTimeout(this._connectTimer);
    this._connectTimer = null;
    this._pendingSeek = 0;
    const socket = this.socket;
    this.socket = null;
    try { socket?.destroy(); } catch {}
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try { proc.kill(); } catch {}
    }
    this.currentQid = null;
    this.currentSource = null;
    this.emit('change', this.status());
  }

  async load(source, { qid, position = 0, paused = false } = {}) {
    if (!source?.trusted || source.kind !== 'file' || !path.isAbsolute(source.uri)) {
      throw new Error('mpv 只接受由服务端解析的受信任绝对文件路径');
    }
    this.currentQid = qid || null;
    this.currentSource = source.uri;
    // 不带第 4 个 options 参数：mpv 0.41 的 loadfile 会拒绝 start= 形式（invalid parameter）。
    // 起始位置改为载入完成（duration 到达）后补一次 seek，兼容所有构建。
    this._pendingSeek = Math.max(0, Number(position) || 0);
    this._command(['loadfile', source.uri, 'replace']);
    this._setProperty('pause', !!paused);
  }

  async play() { this._setProperty('pause', false); }
  async pause() { this._setProperty('pause', true); }
  async seek(position) { this._command(['seek', Math.max(0, Number(position) || 0), 'absolute+exact']); }
  async setVolume(volume) { this._setProperty('volume', Math.max(0, Math.min(100, Number(volume) * 100))); }
  async showStandby(waiting = {}) {
    this.currentQid = null;
    this.currentSource = null;
    this._pendingSeek = 0;
    this._command(['stop']);
    const detail = waiting.nextTitle ? `\n下一档：${waiting.nextTitle}` : '';
    this._command(['show-text', `Showrunner 待机${detail}`, 5000]);
  }
  async showMenu(model) {
    const title = model?.title || '频道';
    const lines = (model?.items || []).map((item, index) => `${index === model.index ? '▶' : '  '} ${item.label}`);
    this._command(['show-text', [title, ...lines].join('\n'), 10000]);
  }

  status() {
    return {
      type: this.type,
      available: this.available,
      executableFound: !!this.mpvPath,
      running: !!this.proc,
      ready: !!this.socket,
      currentQid: this.currentQid,
      ipcConnected: !!this.socket,
      lastError: this.lastError
    };
  }

  _scheduleConnect(delay = 250) {
    clearTimeout(this._connectTimer);
    this._connectTimer = setTimeout(() => this._connect(), delay);
    this._connectTimer.unref?.();
  }

  _connect() {
    if (!this.proc || this.socket || this._stopping) return;
    let socket;
    try { socket = this.connectImpl(this.ipcPath); }
    catch (error) { this.lastError = error.message; this._scheduleConnect(); return; }
    const retry = () => {
      if (this.socket === socket) this.socket = null;
      try { socket.destroy(); } catch {}
      if (this.proc && !this._stopping) this._scheduleConnect();
      this.emit('change', this.status());
    };
    socket.once('connect', () => {
      if (!this.proc || this._stopping) return retry();
      this.socket = socket;
      this.lastError = null;
      socket.on('data', chunk => this._onData(chunk));
      socket.on('close', retry);
      socket.on('error', error => { this.lastError = error.message; });
      for (const [id, name] of [[1, 'time-pos'], [2, 'duration'], [3, 'pause'], [4, 'hwdec-current']]) {
        this._command(['observe_property', id, name]);
      }
      this.emit('ready');
      this.emit('change', this.status());
    });
    socket.once('error', retry);
  }

  _command(command) {
    if (!this.socket) return false;
    try {
      this.socket.write(JSON.stringify({ command, request_id: ++this._requestId }) + '\n');
      return true;
    } catch (error) { this.lastError = error.message; return false; }
  }
  _setProperty(name, value) { return this._command(['set_property', name, value]); }

  _onData(chunk) {
    this.buffer += chunk.toString('utf8');
    for (;;) {
      const pos = this.buffer.indexOf('\n');
      if (pos < 0) break;
      const line = this.buffer.slice(0, pos); this.buffer = this.buffer.slice(pos + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.event === 'property-change') {
        if (msg.name === 'duration') {
          this.duration = Number(msg.data) || 0;
          if (this.duration > 0 && this._pendingSeek) {
            const to = this._pendingSeek;
            this._pendingSeek = 0;
            this.seek(to);
          }
        }
        if (msg.name === 'time-pos' && this.currentQid) this.emit('position', { qid: this.currentQid, position: Number(msg.data) || 0, duration: this.duration });
      } else if (msg.request_id !== undefined && msg.error && msg.error !== 'success') {
        // 命令级错误（如参数被拒）不会触发 end-file 事件，必须显式暴露，避免无声失败
        this.lastError = `mpv 命令错误：${msg.error}`;
        this.emit('change', this.status());
      } else if (msg.event === 'end-file' && this.currentQid) {
        if (msg.reason === 'eof') this.emit('ended', { qid: this.currentQid });
        else if (msg.reason === 'error') this.emit('error', { qid: this.currentQid, kind: 'mpv_error', detail: String(msg.file_error || msg.error || 'mpv 播放失败') });
      } else if (msg.event === 'client-message' && msg.args?.[0] === 'showrunner-input') {
        this.emit('input', String(msg.args[1] || ''));
      }
    }
  }

  _onExit(proc, code, signal) {
    if (this.proc !== proc) return;
    this.proc = null;
    try { this.socket?.destroy(); } catch {}
    this.socket = null;
    if (!this._stopping) {
      this.lastError = `mpv 意外退出（${code ?? signal ?? 'unknown'}）`;
      this.emit('exit', { code, signal });
    }
    this.emit('change', this.status());
  }
  _onProcessError(proc, error) {
    if (this.proc !== proc) return;
    this.proc = null;
    try { this.socket?.destroy(); } catch {}
    this.socket = null;
    this.lastError = error.message;
    if (this.currentQid) this.emit('error', { qid: this.currentQid, kind: 'mpv_process_error', detail: error.message });
    if (!this._stopping) this.emit('exit', { error: error.message });
    this.emit('change', this.status());
  }
}

module.exports = { MpvFrontend, findMpv, defaultIpcPath, cleanupManagedMpv };
