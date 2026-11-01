'use strict';
/** 播放异常 JSONL 日志。第一版只记录并跳过，后续可据此增加分级恢复。 */
const fs = require('fs');
const path = require('path');

const ALLOWED_KINDS = new Set([
  'source_error', 'media_error', 'play_rejected', 'frozen', 'unexpected_pause', 'stalled',
  'compatibility_fallback', 'compatibility_failed'
]);

class PlaybackIssueLogger {
  constructor(file) {
    this.file = file;
  }

  record(issue = {}, current = {}, playback = {}) {
    const event = {
      at: new Date().toISOString(),
      kind: ALLOWED_KINDS.has(issue.kind) ? issue.kind : 'media_error',
      detail: String(issue.detail || '').slice(0, 500),
      qid: String(current.qid || issue.qid || '').slice(0, 100),
      title: String(current.title || '').slice(0, 300),
      mediaType: String(current.type || '').slice(0, 30),
      position: Number.isFinite(Number(issue.position)) ? Number(issue.position) : Number(playback.position) || 0,
      duration: Number.isFinite(Number(issue.duration)) ? Number(issue.duration) : Number(playback.duration) || 0,
      readyState: Number.isFinite(Number(issue.readyState)) ? Number(issue.readyState) : undefined,
      networkState: Number.isFinite(Number(issue.networkState)) ? Number(issue.networkState) : undefined
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(event) + '\n', 'utf8');
      return event;
    } catch (error) {
      console.error('播放异常日志写入失败:', error.message);
      return null;
    }
  }

  recent(limit = 100) {
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    try {
      const lines = fs.readFileSync(this.file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-n).reverse();
      return lines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    } catch { return []; }
  }
}

module.exports = { PlaybackIssueLogger, ALLOWED_KINDS };
