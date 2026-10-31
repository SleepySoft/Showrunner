'use strict';
/**
 * yt-dlp 封装：查找可执行文件、抓取视频信息、下载并解析进度。
 * spawnImpl 可注入，便于测试（测试不触网、不起真实进程）。
 *
 * 查找顺序：config.ytdlpPath → PATH → <项目>/bin/yt-dlp(.exe)
 * ffmpeg 可用时用高画质合并格式；没有 ffmpeg 退回单文件格式，避免合并失败。
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

function findOnPath(names) {
  const pathExt = (process.env.PATHEXT || '.EXE;.BAT;.CMD').split(';');
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      for (const ext of ['', ...pathExt]) {
        const p = path.join(dir, name + ext);
        try { if (fs.existsSync(p)) return p; } catch { /* 继续 */ }
      }
    }
  }
  return null;
}

function findYtdlp(cfgPath, rootDir) {
  if (cfgPath && fs.existsSync(cfgPath)) return cfgPath;
  const onPath = findOnPath(['yt-dlp']);
  if (onPath) return onPath;
  const local = path.join(rootDir, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  if (fs.existsSync(local)) return local;
  return null;
}

function findFfmpeg(rootDir) {
  const onPath = findOnPath(['ffmpeg']);
  if (onPath) return onPath;
  if (rootDir) {
    const local = path.join(rootDir, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (fs.existsSync(local)) return local;
  }
  return null;
}

function hasFfmpeg(rootDir) {
  return !!findFfmpeg(rootDir);
}

/** 解析 yt-dlp --newline 的进度行，返回 0~100 或 null */
function parseProgress(line) {
  const m = String(line).match(/\[download\]\s+([\d.]+)%/);
  return m ? parseFloat(m[1]) : null;
}

/** 抓取视频信息：标题、内容 ID、站点、时长（秒）。失败返回 null。 */
function fetchInfo(ytdlp, url, { spawnImpl = spawn, timeoutMs = 30000 } = {}) {
  return new Promise(resolve => {
    const args = ['--dump-json', '--no-playlist', '--no-warnings', url];
    let out = '';
    let proc;
    try { proc = spawnImpl(ytdlp, args, { stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { return resolve(null); }
    if (!proc || !proc.stdout) return resolve(null);
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    proc.stdout.on('data', d => { out += d; });
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      try {
        const j = JSON.parse(out);
        resolve({
          title: j.title || null,
          contentId: j.id || null,
          site: (j.extractor_key || j.extractor || 'web').toLowerCase(),
          duration: j.duration || null
        });
      } catch { resolve(null); }
    });
  });
}

/**
 * 下载到目标路径模板（含 %(ext)s）。onProgress(percent) 回报进度。
 * 返回 Promise<{ ok, error? }>。
 */
function download(ytdlp, url, outTemplate, onProgress, { spawnImpl = spawn, ffmpeg = true, cookiesFromBrowser = null, timeoutMs = 30 * 60000 } = {}) {
  return new Promise(resolve => {
    const format = ffmpeg ? 'bv*+ba/b' : 'best[ext=mp4]/best';
    const args = [
      '--no-playlist', '--newline', '--no-warnings',
      '-f', format,
      '--merge-output-format', 'mp4',
      '-o', outTemplate,
      url
    ];
    // ffmpeg 为路径字符串时显式告知 yt-dlp（PATH 里的可省略，但传了更稳）
    if (typeof ffmpeg === 'string') args.push('--ffmpeg-location', ffmpeg);
    if (cookiesFromBrowser) args.push('--cookies-from-browser', cookiesFromBrowser);

    let proc;
    try { proc = spawnImpl(ytdlp, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ ok: false, error: e.message }); }

    let lastErr = '';
    let done = false;
    const finish = r => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      finish({ ok: false, error: '下载超时' });
    }, timeoutMs);

    proc.stdout.on('data', d => {
      for (const line of String(d).split('\n')) {
        const p = parseProgress(line);
        if (p !== null && onProgress) onProgress(p);
      }
    });
    proc.stderr.on('data', d => { lastErr = String(d).slice(-500); });
    proc.on('error', e => finish({ ok: false, error: e.message }));
    proc.on('close', code => {
      finish(code === 0 ? { ok: true } : { ok: false, error: lastErr.trim() || `yt-dlp 退出码 ${code}` });
    });
  });
}

/** 校验 yt-dlp 可用性（同步、快速） */
function checkYtdlp(ytdlp) {
  try {
    const out = execFileSync(ytdlp, ['--version'], { timeout: 10000, encoding: 'utf8' });
    return { ok: true, version: out.trim() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { findYtdlp, findFfmpeg, hasFfmpeg, fetchInfo, download, parseProgress, checkYtdlp };
