'use strict';
/**
 * 媒体库：递归扫描配置的媒体目录，产出稳定 ID 的影片列表。
 * ID = sha1(相对路径) 前 16 位——文件不移动则 ID 不变，队列引用不会失效。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.ts', '.flv', '.wmv', '.mpg', '.mpeg']);

function mediaId(relPath) {
  return crypto.createHash('sha1').update(relPath).digest('hex').slice(0, 16);
}

class Library {
  constructor(mediaDirs) {
    this.mediaDirs = [...(mediaDirs || [])];
    this.items = new Map(); // id -> item
  }

  /** 动态增删目录（网页端管理），变更后需调用方触发 rescan */
  addDir(dir) {
    if (!this.mediaDirs.includes(dir)) this.mediaDirs.push(dir);
    return this.mediaDirs;
  }

  removeDir(dir) {
    this.mediaDirs = this.mediaDirs.filter(d => d !== dir);
    return this.mediaDirs;
  }

  /** 重新扫描全部目录，返回影片数组。单文件错误（权限等）跳过，不中断整体扫描。 */
  rescan() {
    this.items.clear();
    for (const dir of this.mediaDirs) {
      const source = {
        id: crypto.createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 10),
        name: path.basename(path.resolve(dir)) || path.resolve(dir)
      };
      this._scanDir(dir, dir, source);
    }
    return this.list();
  }

  _scanDir(root, current, source) {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        this._scanDir(root, full, source);
      } else if (VIDEO_EXTS.has(path.extname(e.name).toLowerCase())) {
        const rel = path.relative(root, full);
        let size = 0;
        try { size = fs.statSync(full).size; } catch { continue; }
        let id = mediaId(rel); // 保留旧 ID，避免现有频道引用失效
        // 多个片库根目录存在同名相对路径时，后出现的文件使用带根目录的 ID，避免覆盖。
        if (this.items.has(id) && this.items.get(id).absPath !== full) {
          id = crypto.createHash('sha1').update(`${path.resolve(root)}\0${rel}`).digest('hex').slice(0, 16);
        }
        this.items.set(id, {
          id,
          title: path.basename(e.name, path.extname(e.name)),
          relPath: rel,
          sourceId: source.id,
          sourceName: source.name,
          absPath: full,
          ext: path.extname(e.name).toLowerCase(),
          size
        });
      }
    }
  }

  list() {
    return [...this.items.values()]
      .sort((a, b) => a.relPath.localeCompare(b.relPath, 'zh-Hans-CN'))
      .map(({ absPath, ...pub }) => pub); // 对外不暴露绝对路径
  }

  get(id) {
    return this.items.get(id) || null;
  }
}

module.exports = { Library, VIDEO_EXTS, mediaId };
