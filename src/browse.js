'use strict';
/**
 * 服务器文件系统浏览：供遥控器在网页上挑选媒体目录。
 * 仅限已登录会话访问；家庭场景下不做目录白名单限制。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { VIDEO_EXTS } = require('./library');

let cachedRoots = null;

/**
 * 列出根位置（结果缓存）。
 * Windows 上用 fsutil 枚举盘符——逐个探测盘符会撞上断开的网络映射盘，
 * accessSync 可能挂起几十秒；fsutil 由系统直接给出清单，毫秒级返回。
 */
function roots() {
  if (cachedRoots) return cachedRoots;
  if (process.platform !== 'win32') {
    cachedRoots = [{ name: '/', path: '/' }];
    return cachedRoots;
  }
  cachedRoots = detectDrives();
  return cachedRoots;
}

function detectDrives() {
  try {
    const out = execFileSync('fsutil', ['fsinfo', 'drives'], { timeout: 5000, encoding: 'utf8' });
    const drives = out.match(/[A-Z]:\\/gi);
    if (drives && drives.length) {
      return drives.map(d => ({ name: d.toUpperCase(), path: d.toUpperCase() }));
    }
  } catch { /* fsutil 不可用则走兜底 */ }
  return [{ name: 'C:\\', path: 'C:\\' }];
}

/** 浏览指定目录：子目录（可进入）+ 视频文件数统计 */
function browse(dirPath) {
  if (!dirPath) return { path: null, parent: null, dirs: roots(), videoCount: 0, isMediaCandidate: false };
  const abs = path.resolve(dirPath);
  const entries = fs.readdirSync(abs, { withFileTypes: true }); // 不存在/无权限会抛错，由路由转 400
  const dirs = [];
  let videoCount = 0;
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.startsWith('$')) continue; // 隐藏/系统目录不进列表
    if (e.isDirectory()) {
      dirs.push({ name: e.name, path: path.join(abs, e.name) });
    } else if (VIDEO_EXTS.has(path.extname(e.name).toLowerCase())) {
      videoCount++;
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  const parent = path.dirname(abs);
  return {
    path: abs,
    parent: parent === abs ? null : parent,
    dirs,
    videoCount,
    isMediaCandidate: videoCount > 0
  };
}

module.exports = { browse, roots };
