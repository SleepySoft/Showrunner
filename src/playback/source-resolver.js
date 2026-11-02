'use strict';

const path = require('path');

/** 只把片库登记文件和已完成缓存转换为前端可加载的源。 */
class PlayableSourceResolver {
  constructor({ library, cache }) {
    this.library = library;
    this.cache = cache;
  }

  resolve(item, frontend) {
    if (!item) return { status: 'standby' };
    if (item.type === 'local') {
      const media = this.library.get(item.mediaId);
      if (!media) return { status: 'error', error: '片库中找不到文件' };
      return frontend === 'mpv'
        ? { status: 'ready', source: { kind: 'file', uri: path.resolve(media.absPath), trusted: true } }
        : { status: 'ready', source: { kind: 'url', uri: `/media/${encodeURIComponent(media.id)}/stream`, trusted: true } };
    }
    if (item.type === 'web') {
      const entry = this.cache?.byUrl(item.url);
      if (!entry || entry.status === 'pending' || entry.status === 'downloading') {
        return { status: 'waiting', reason: 'cache', progress: entry?.progress || 0 };
      }
      if (entry.status !== 'ready') return { status: 'error', error: entry.error || '网页节目缓存失败' };
      if (frontend === 'mpv') {
        const file = this.cache.resolveFile(entry.key);
        return file
          ? { status: 'ready', source: { kind: 'file', uri: path.resolve(file), trusted: true } }
          : { status: 'error', error: '缓存文件不存在' };
      }
      return { status: 'ready', source: { kind: 'url', uri: `/cache/${encodeURIComponent(entry.key)}/stream`, trusted: true } };
    }
    return { status: 'error', error: `不支持的节目类型：${item.type || 'unknown'}` };
  }
}

module.exports = { PlayableSourceResolver };
