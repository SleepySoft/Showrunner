// 网页片源缓存管理器：预下载、规范命名、LRU 淘汰、状态跟踪
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const ytdlpMod = require('./ytdlp');

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024 * 1024; // 20GB

// 文件名净化：去掉 Windows 非法字符，限制长度
function sanitizeName(name) {
  if (!name) return 'untitled';
  let s = String(name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > 60) s = s.slice(0, 60).trim();
  return s || 'untitled';
}

// URL → 稳定的缓存 key（sha1 前 12 位）
function cacheKey(url) {
  return crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 12);
}

class CacheManager extends EventEmitter {
  /**
   * @param {object} opts
   *   dir: 缓存根目录
   *   ytdlp: yt-dlp 可执行文件路径（null 则禁用下载）
   *   ffmpeg: 是否有 ffmpeg
   *   cookiesFromBrowser: 浏览器名或 null
   *   maxBytes: LRU 容量上限
   *   fetchInfoImpl / downloadImpl: 测试注入
   */
  constructor(opts = {}) {
    super();
    this.dir = opts.dir;
    this.ytdlp = opts.ytdlp || null;
    this.ffmpeg = !!opts.ffmpeg;
    this.cookiesFromBrowser = opts.cookiesFromBrowser || null;
    this.maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
    this.fetchInfoImpl = opts.fetchInfoImpl || null;
    this.downloadImpl = opts.downloadImpl || null;
    this.entries = new Map(); // key -> entry
    fs.mkdirSync(this.dir, { recursive: true });
    this._loadIndex();
  }

  _indexPath() { return path.join(this.dir, 'index.json'); }

  _loadIndex() {
    try {
      const raw = fs.readFileSync(this._indexPath(), 'utf8');
      const arr = JSON.parse(raw);
      for (const e of arr) {
        // 上次进程退出时还在下载中的条目降级为失败，可重试
        if (e.status === 'downloading' || e.status === 'pending') {
          e.status = 'failed';
          e.error = '服务重启，下载中断';
          e.progress = 0;
          e.file = null;
        }
        this.entries.set(e.key, e);
      }
    } catch { /* 无索引或损坏，从空开始 */ }
  }

  _saveIndex() {
    const arr = [...this.entries.values()].map(e => ({ ...e }));
    const tmp = this._indexPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
    fs.renameSync(tmp, this._indexPath());
  }

  get(key) { return this.entries.get(key) || null; }

  byUrl(url) { return this.entries.get(cacheKey(url)) || null; }

  /**
   * 确保 url 被缓存。幂等：ready/downloading 直接返回现有条目。
   * 启动后台流水线后立即返回。
   */
  ensure(url, titleHint) {
    const key = cacheKey(url);
    const existing = this.entries.get(key);
    if (existing && (existing.status === 'ready' || existing.status === 'downloading' || existing.status === 'pending')) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    const entry = {
      key,
      url: String(url),
      title: titleHint || null,
      site: null,
      contentId: null,
      status: 'pending',
      progress: 0,
      error: null,
      file: null,        // 相对缓存根目录的路径
      bytes: 0,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    this.entries.set(key, entry);
    this._saveIndex();
    this.emit('change');
    this._pipeline(entry).catch(() => {});
    return entry;
  }

  async _pipeline(entry) {
    if (!this.ytdlp) {
      entry.status = 'failed';
      entry.error = '未找到 yt-dlp';
      this._saveIndex();
      this.emit('change');
      return;
    }
    entry.status = 'downloading';
    entry.progress = 0;
    this.emit('change');

    // 1. 获取视频信息（标题 / 站点 / 内容 ID）
    let info = null;
    try {
      info = this.fetchInfoImpl
        ? await this.fetchInfoImpl(entry.url)
        : await ytdlpMod.fetchInfo(this.ytdlp, entry.url);
    } catch { info = null; }
    if (info) {
      entry.title = info.title || entry.title;
      entry.site = info.site || null;
      entry.contentId = info.contentId || null;
    }
    const site = sanitizeName(entry.site || 'web').toLowerCase().replace(/\s+/g, '_');
    const baseName = sanitizeName(entry.title || 'video') +
      (entry.contentId ? '-' + sanitizeName(entry.contentId) : '-' + entry.key);
    const siteDir = path.join(this.dir, site);
    fs.mkdirSync(siteDir, { recursive: true });
    const outTemplate = path.join(siteDir, baseName + '.%(ext)s');

    // 2. 下载（进度节流后广播）
    let lastEmit = 0;
    const onProgress = (pct) => {
      entry.progress = pct;
      const now = Date.now();
      if (now - lastEmit > 900) {
        lastEmit = now;
        this.emit('progress', { key: entry.key, progress: pct });
      }
    };
    const result = this.downloadImpl
      ? await this.downloadImpl(entry.url, outTemplate, onProgress)
      : await ytdlpMod.download(this.ytdlp, entry.url, outTemplate, onProgress, {
          ffmpeg: this.ffmpeg,
          cookiesFromBrowser: this.cookiesFromBrowser,
        });

    if (!result.ok) {
      entry.status = 'failed';
      entry.error = result.error || '下载失败';
      entry.progress = 0;
      this._saveIndex();
      this.emit('change');
      return;
    }

    // 3. 定位产物文件（排除 .part / .ytdl 临时文件）
    let found = null;
    try {
      const files = fs.readdirSync(siteDir)
        .filter(f => f.startsWith(baseName) && !f.endsWith('.part') && !f.endsWith('.ytdl'));
      if (files.length > 0) {
        // 取最大的文件（主视频）
        let bestSize = -1;
        for (const f of files) {
          const st = fs.statSync(path.join(siteDir, f));
          if (st.size > bestSize) { bestSize = st.size; found = f; }
        }
      }
    } catch { /* ignore */ }
    if (!found) {
      entry.status = 'failed';
      entry.error = '下载完成但找不到产物文件';
      this._saveIndex();
      this.emit('change');
      return;
    }
    entry.file = site + '/' + found;
    entry.bytes = bestSizeFromDisk(path.join(siteDir, found));
    entry.progress = 100;
    entry.status = 'ready';
    entry.error = null;
    this._saveIndex();
    this.emit('change');
    this._evict();
  }

  /**
   * 预取：从 fromIndex 开始，缓存当前 + 后续 ahead 个 web 条目
   */
  prefetchQueue(items, fromIndex, ahead = 2) {
    if (!Array.isArray(items)) return;
    let count = 0;
    for (let i = Math.max(0, fromIndex); i < items.length && count <= ahead; i++) {
      const it = items[i];
      if (it && it.type === 'web' && it.url) {
        this.ensure(it.url, it.title || it.name || null);
        count++;
      }
    }
  }

  /**
   * 装饰播出队列条目：web 项附加缓存状态与可播流地址
   */
  decorate(item) {
    if (!item || item.type !== 'web' || !item.url) return {};
    const e = this.byUrl(item.url);
    if (!e) return { cacheStatus: 'none', progress: 0 };
    const out = {
      cacheStatus: e.status,
      progress: e.progress,
      cachedTitle: e.title || undefined,
    };
    if (e.status === 'ready' && e.file) out.stream = `/cache/${e.key}/stream`;
    if (e.status === 'failed') out.cacheError = e.error || '缓存失败';
    return out;
  }

  /** 遥控器 /api/state 用的摘要列表 */
  brief() {
    return [...this.entries.values()].map(e => ({
      key: e.key,
      url: e.url,
      title: e.title,
      status: e.status,
      progress: e.progress,
      error: e.error || undefined,
      bytes: e.bytes,
    }));
  }

  /** 已 ready 条目的产物绝对路径；否则 null */
  resolveFile(key) {
    const e = this.entries.get(key);
    if (!e || e.status !== 'ready' || !e.file) return null;
    const root = path.resolve(this.dir);
    const abs = path.resolve(root, e.file);
    if (abs !== root && !abs.startsWith(root + path.sep)) return null;
    return fs.existsSync(abs) ? abs : null;
  }

  /** 手动删除一个缓存条目及其文件 */
  remove(key) {
    const e = this.entries.get(key);
    if (!e) return false;
    if (e.file) {
      try { fs.unlinkSync(path.join(this.dir, e.file)); } catch { /* ignore */ }
    }
    this.entries.delete(key);
    this._saveIndex();
    this.emit('change');
    return true;
  }

  /** LRU：超出 maxBytes 时淘汰最久未用的 ready 条目 */
  _evict() {
    const ready = [...this.entries.values()]
      .filter(e => e.status === 'ready' && e.file)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    let total = ready.reduce((s, e) => s + (e.bytes || 0), 0);
    while (total > this.maxBytes && ready.length > 0) {
      const victim = ready.shift();
      try { fs.unlinkSync(path.join(this.dir, victim.file)); } catch { /* ignore */ }
      total -= victim.bytes || 0;
      this.entries.delete(victim.key);
    }
    this._saveIndex();
  }
}

function bestSizeFromDisk(absPath) {
  try { return fs.statSync(absPath).size; } catch { return 0; }
}

module.exports = { CacheManager, sanitizeName, cacheKey };
