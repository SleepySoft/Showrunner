'use strict';
/**
 * 本地媒体兼容缓存：浏览器明确报告格式/解码不支持后，用 FFmpeg 转为 H.264/AAC MP4。
 * 原文件永不修改；产物带源文件签名并按最近使用时间做独立容量淘汰。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

class CompatibilityManager extends EventEmitter {
  constructor({ dir, ffmpeg, maxBytes = 10 * 1024 ** 3, transcodeImpl } = {}) {
    super();
    this.dir = dir;
    this.ffmpeg = ffmpeg || null;
    this.maxBytes = maxBytes;
    this.transcodeImpl = transcodeImpl || ((source, output) => this._ffmpeg(source, output));
    this.entries = new Map();
    fs.mkdirSync(this.dir, { recursive: true });
    this._load();
  }

  _indexPath() { return path.join(this.dir, 'index.json'); }
  _output(id) { return path.join(this.dir, `${id}.mp4`); }
  _sourceSignature(item) {
    try {
      const stat = fs.statSync(item.absPath);
      return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    } catch { return null; }
  }

  _load() {
    try {
      for (const entry of JSON.parse(fs.readFileSync(this._indexPath(), 'utf8'))) {
        const file = this._output(entry.mediaId);
        if (entry.status === 'ready' && fs.existsSync(file)) this.entries.set(entry.mediaId, entry);
      }
    } catch { /* 首次运行或旧索引损坏时按空缓存处理 */ }
  }

  _save() {
    const tmp = this._indexPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...this.entries.values()], null, 2));
    fs.renameSync(tmp, this._indexPath());
  }

  get(mediaId) { return this.entries.get(mediaId) || null; }

  ensure(item) {
    if (!item?.id || !item.absPath) return null;
    const signature = this._sourceSignature(item);
    let entry = this.entries.get(item.id);
    if (entry && entry.sourceSignature === signature && ['pending', 'transcoding', 'ready'].includes(entry.status)) {
      entry.lastUsedAt = Date.now();
      return entry;
    }
    if (entry?.status === 'ready') {
      try { fs.unlinkSync(this._output(item.id)); } catch {}
    }
    entry = {
      mediaId: item.id, title: item.title, sourceSignature: signature,
      status: 'pending', error: null, bytes: 0,
      createdAt: Date.now(), lastUsedAt: Date.now()
    };
    this.entries.set(item.id, entry);
    this._save();
    this.emit('change', entry);
    this._pipeline(item, entry).catch(() => {});
    return entry;
  }

  async _pipeline(item, entry) {
    if (!this.ffmpeg) return this._fail(entry, '未找到 FFmpeg，无法转换兼容格式');
    if (!entry.sourceSignature) return this._fail(entry, '源文件不可访问（可能是 NAS 映射盘未连接）');
    entry.status = 'transcoding';
    this._save(); this.emit('change', entry);
    const output = this._output(item.id);
    const partial = path.join(this.dir, `${item.id}.part.mp4`);
    try { fs.unlinkSync(partial); } catch {}
    let result;
    try { result = await this.transcodeImpl(item.absPath, partial); }
    catch (error) { result = { ok: false, error: error.message }; }
    if (!result?.ok || !fs.existsSync(partial)) {
      try { fs.unlinkSync(partial); } catch {}
      const safeError = String(result?.error || 'FFmpeg 未生成转换文件').split(item.absPath).join('[媒体文件]');
      return this._fail(entry, safeError);
    }
    try {
      fs.renameSync(partial, output);
      entry.bytes = fs.statSync(output).size;
    } catch (error) { return this._fail(entry, `保存转换文件失败：${error.message}`); }
    entry.status = 'ready'; entry.error = null; entry.lastUsedAt = Date.now();
    this._save(); this._evict(); this.emit('change', entry);
  }

  _ffmpeg(source, output) {
    return new Promise(resolve => {
      const args = [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', source,
        '-map', '0:v:0', '-map', '0:a:0?',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', output
      ];
      let stderr = '';
      let child;
      try { child = spawn(this.ffmpeg, args, { windowsHide: true }); }
      catch (error) { return resolve({ ok: false, error: error.message }); }
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
      child.on('error', error => resolve({ ok: false, error: error.message }));
      child.on('close', code => resolve({ ok: code === 0, error: code === 0 ? null : (stderr.trim() || `FFmpeg 退出码 ${code}`) }));
    });
  }

  _fail(entry, error) {
    entry.status = 'failed'; entry.error = String(error || '转换失败').slice(0, 1000);
    this._save(); this.emit('change', entry);
    return entry;
  }

  decorate(item, sourceItem = null) {
    if (!item || item.type !== 'local' || !item.mediaId) return {};
    const entry = this.entries.get(item.mediaId);
    if (!entry) return {};
    if (sourceItem && entry.status === 'ready' && entry.sourceSignature !== this._sourceSignature(sourceItem)) {
      try { fs.unlinkSync(this._output(item.mediaId)); } catch {}
      this.entries.delete(item.mediaId);
      this._save();
      return {};
    }
    entry.lastUsedAt = Date.now();
    const out = { compatibilityStatus: entry.status };
    if (entry.status === 'ready' && fs.existsSync(this._output(item.mediaId))) {
      out.stream = `/compatible/${encodeURIComponent(item.mediaId)}/stream`;
    }
    if (entry.status === 'failed') out.compatibilityError = entry.error || '兼容转换失败';
    return out;
  }

  resolveFile(mediaId) {
    const entry = this.entries.get(mediaId);
    if (!entry || entry.status !== 'ready') return null;
    const file = this._output(mediaId);
    return fs.existsSync(file) ? file : null;
  }

  brief() {
    return [...this.entries.values()].map(e => ({
      mediaId: e.mediaId, title: e.title, status: e.status,
      error: e.error || undefined, bytes: e.bytes || 0, createdAt: e.createdAt
    }));
  }

  _evict() {
    const ready = [...this.entries.values()].filter(e => e.status === 'ready').sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    let total = ready.reduce((sum, e) => sum + (e.bytes || 0), 0);
    while (total > this.maxBytes && ready.length) {
      const victim = ready.shift();
      try { fs.unlinkSync(this._output(victim.mediaId)); } catch {}
      total -= victim.bytes || 0;
      this.entries.delete(victim.mediaId);
    }
    this._save();
  }
}

module.exports = { CompatibilityManager };
