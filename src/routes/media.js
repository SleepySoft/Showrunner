'use strict';
/**
 * 媒体流端点：支持 HTTP Range（拖动进度条必需）。
 * - /media/:id/stream  本地媒体库（只允许已登记的 ID，杜绝目录穿越）
 * - /cache/:key/stream 网页片源缓存（只允许已下载完成的条目）
 */
const fs = require('fs');
const path = require('path');
const express = require('express');

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.mov': 'video/quicktime',
  '.ts': 'video/mp2t', '.flv': 'video/x-flv', '.wmv': 'video/x-ms-wmv',
  '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg'
};

/** 共用的 Range 流式响应。absPath 必须由调用方保证可信。 */
function streamFile(req, res, absPath, createReadStream = fs.createReadStream) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return res.status(404).json({ error: 'file missing' });
    }
    console.error(`媒体文件访问失败（${error?.code || 'unknown'}）`);
    return res.status(503).json({ error: 'media temporarily unavailable', code: error?.code || 'UNKNOWN' });
  }

  const type = MIME[path.extname(absPath).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;

  let status = 200;
  let headers;
  let options;
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (Number.isNaN(start) || start >= stat.size) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.status(416).end();
    }
    end = Math.min(end, stat.size - 1);
    status = 206;
    headers = {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': type
    };
    options = { start, end };
  } else {
    headers = {
      'Accept-Ranges': 'bytes',
      'Content-Length': stat.size,
      'Content-Type': type
    };
  }

  // createReadStream 的 open/error 是异步事件。必须在管道建立前监听 error，
  // 否则 NAS 断开或句柄耗尽（EMFILE）会成为未处理事件并终止整个进程。
  const input = createReadStream(absPath, options);
  const release = () => {
    if (!input.destroyed) input.destroy();
  };
  const cleanup = () => {
    req.removeListener('aborted', release);
    res.removeListener('close', release);
  };

  req.once('aborted', release);
  res.once('close', release);
  input.once('close', cleanup);
  input.once('error', error => {
    console.error(`媒体流读取失败（${error?.code || 'unknown'}）`);
    if (!res.headersSent) {
      res.status(error?.code === 'ENOENT' ? 404 : 503).json({
        error: error?.code === 'ENOENT' ? 'file missing' : 'media temporarily unavailable',
        code: error?.code || 'UNKNOWN'
      });
    } else if (!res.destroyed) {
      res.destroy();
    }
  });
  input.once('open', () => {
    if (input.destroyed || res.destroyed) return;
    res.writeHead(status, headers);
    input.pipe(res);
  });
}

function mediaRouter(library) {
  const router = express.Router();

  router.get('/:id/stream', (req, res) => {
    const item = library.get(req.params.id);
    if (!item) return res.status(404).json({ error: 'not found' });
    streamFile(req, res, item.absPath);
  });

  return router;
}

/** 网页片源缓存的流式端点：key → 已下载完成的文件 */
function cacheRouter(cache) {
  const router = express.Router();

  router.get('/:key/stream', (req, res) => {
    const abs = cache.resolveFile(req.params.key);
    if (!abs) return res.status(404).json({ error: 'not ready or not found' });
    streamFile(req, res, abs);
  });

  return router;
}

function compatibilityRouter(compatibility) {
  const router = express.Router();
  router.get('/:id/stream', (req, res) => {
    const abs = compatibility.resolveFile(req.params.id);
    if (!abs) return res.status(404).json({ error: 'compatible file not ready or not found' });
    streamFile(req, res, abs);
  });
  return router;
}

module.exports = { mediaRouter, cacheRouter, compatibilityRouter, streamFile };
