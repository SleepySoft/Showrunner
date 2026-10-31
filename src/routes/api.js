'use strict';
/**
 * 遥控器 API：登录、片库、目录管理、文件浏览、节目单管理、队列、播放控制。
 * 除 /login 外全部需要会话。
 * 节目单与队列的关系：播出中节目单的 items 与 QueueManager.queue 共享同一数组——
 * 编辑播出中的节目单 = 编辑直播队列；编辑其他节目单不影响播出。
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { COOKIE, Auth } = require('../auth');
const { browse } = require('../browse');
const { resolveTitle } = require('../webtitle');

function apiRouter({ auth, library, queue, playlists, browserctl, cache, onDirsChange }) {
  const router = express.Router();
  router.use(express.json());

  router.post('/login', (req, res) => {
    const token = auth.login(String(req.body?.password ?? ''));
    if (!token) return res.status(401).json({ error: 'wrong password' });
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`);
    res.json({ ok: true, token });
  });

  router.post('/logout', (req, res) => {
    const token = Auth.tokenFromReq(req);
    if (token) auth.logout(token);
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
    res.json({ ok: true });
  });

  // ---- 以下需要登录 ----
  router.use(auth.middleware());

  router.get('/state', (req, res) => {
    res.json({
      state: queue.getPublicState(),
      queue: queue.queue,
      playlists: playlists.list(),
      activeId: playlists.activeId,
      cache: cache ? cache.brief() : []
    });
  });

  // ---- 网页片源缓存管理 ----

  router.get('/cache', (req, res) => {
    res.json({ items: cache ? cache.brief() : [] });
  });

  router.delete('/cache/:key', (req, res) => {
    if (!cache || !cache.remove(req.params.key)) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  // 重试一个失败的缓存
  router.post('/cache/:key/retry', (req, res) => {
    if (!cache) return res.status(503).json({ error: 'cache disabled' });
    const e = cache.get(req.params.key);
    if (!e) return res.status(404).json({ error: 'not found' });
    if (e.status !== 'failed') return res.status(409).json({ error: '只有失败的条目需要重试' });
    cache.remove(e.key);
    cache.ensure(e.url, e.title);
    res.json({ ok: true });
  });

  router.get('/library', (req, res) => {
    const items = req.query.rescan === '1' ? library.rescan() : library.list();
    res.json({ items, mediaDirs: library.mediaDirs });
  });

  // ---- 媒体目录管理 ----

  router.get('/dirs', (req, res) => {
    res.json({ dirs: library.mediaDirs });
  });

  router.post('/dirs', (req, res) => {
    const dir = String(req.body?.path || '');
    let stat;
    try { stat = fs.statSync(dir); }
    catch { return res.status(400).json({ error: '目录不存在或不可访问' }); }
    if (!stat.isDirectory()) return res.status(400).json({ error: '不是目录' });
    const abs = path.resolve(dir);
    library.addDir(abs);
    library.rescan();
    if (onDirsChange) onDirsChange(library.mediaDirs);
    res.status(201).json({ dirs: library.mediaDirs });
  });

  router.delete('/dirs', (req, res) => {
    const dir = path.resolve(String(req.body?.path || ''));
    library.removeDir(dir);
    library.rescan();
    if (onDirsChange) onDirsChange(library.mediaDirs);
    res.json({ dirs: library.mediaDirs });
  });

  // ---- 文件浏览 ----

  router.get('/browse', (req, res) => {
    try {
      res.json(browse(req.query.path ? String(req.query.path) : null));
    } catch {
      res.status(400).json({ error: '目录不存在或不可访问' });
    }
  });

  // ---- 节目单管理 ----

  router.get('/playlists', (req, res) => {
    res.json({ playlists: playlists.list(), activeId: playlists.activeId });
  });

  router.post('/playlists', (req, res) => {
    const p = playlists.create(req.body?.name);
    res.status(201).json({ playlist: { id: p.id, name: p.name, count: 0, active: false } });
  });

  router.post('/playlists/:id/rename', (req, res) => {
    if (!playlists.rename(req.params.id, req.body?.name)) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  router.delete('/playlists/:id', (req, res) => {
    const r = playlists.remove(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    if (r.wasActive) queue.loadPlaylist([]); // 删除播出中的节目单 → 直播队列清空待机
    res.json({ ok: true });
  });

  router.post('/playlists/:id/activate', (req, res) => {
    const p = playlists.activate(req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    queue.loadPlaylist(p.items); // 共享数组引用，此后编辑即直播
    res.json({ ok: true, state: queue.getPublicState() });
  });

  /** 读取单个节目单（含条目全文） */
  router.get('/playlists/:id', (req, res) => {
    const p = playlists.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    res.json({ playlist: { id: p.id, name: p.name, active: p.id === playlists.activeId, items: p.items } });
  });

  /** 构建条目：本地媒体 ID（单个/批量）或网页链接。错误抛 { status, error }。 */
  async function buildItems(body) {
    const url = body?.url;
    if (url) {
      let u;
      try { u = new URL(String(url)); } catch { throw { status: 400, error: '链接格式不正确' }; }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw { status: 400, error: '只支持 http/https 链接' };
      const title = await resolveTitle(u.toString());
      return [{ type: 'web', url: u.toString(), title, relPath: u.host }];
    }
    const ids = Array.isArray(body?.mediaIds) ? body.mediaIds : [body?.mediaId];
    if (!ids.length || !ids[0]) throw { status: 400, error: '缺少 mediaId 或 url' };
    return ids.map(id => {
      const item = library.get(id);
      if (!item) throw { status: 404, error: `media not found: ${id}` };
      return { type: 'local', mediaId: item.id, title: item.title, relPath: item.relPath };
    });
  }

  /** 向指定节目单添加条目（播出中的走队列状态机） */
  router.post('/playlists/:id/items', async (req, res) => {
    const p = playlists.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    let items;
    try { items = await buildItems(req.body); }
    catch (e) { return res.status(e.status || 500).json({ error: e.error || 'failed' }); }

    const added = p.id === playlists.activeId
      ? items.map(it => queue.add(it))       // 播出中：走队列，电视实时收到
      : items.map(it => playlists.addItem(p.id, it)); // 非播出中：直接编辑
    res.status(201).json({ added });
  });

  router.delete('/playlists/:id/items/:qid', (req, res) => {
    const ok = req.params.id === playlists.activeId
      ? queue.remove(req.params.qid)
      : playlists.removeItem(req.params.id, req.params.qid);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  router.post('/playlists/:id/items/move', (req, res) => {
    const { qid, toIndex } = req.body || {};
    const ok = req.params.id === playlists.activeId
      ? queue.move(qid, Number(toIndex))
      : playlists.moveItem(req.params.id, qid, toIndex);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  // ---- 直播队列（= 播出中节目单）----

  router.post('/queue', async (req, res) => {
    if (!playlists.active()) {
      return res.status(409).json({ error: '还没有播出中的节目单，请先在「节目单」页创建并播出一个' });
    }
    let items;
    try { items = await buildItems(req.body); }
    catch (e) { return res.status(e.status || 500).json({ error: e.error || 'failed' }); }
    res.status(201).json({ added: items.map(it => queue.add(it)) });
  });

  router.delete('/queue/:qid', (req, res) => {
    if (!queue.remove(req.params.qid)) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  router.post('/queue/move', (req, res) => {
    const { qid, toIndex } = req.body || {};
    if (!queue.move(qid, Number(toIndex))) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  router.post('/queue/clear', (req, res) => {
    queue.clear();
    res.json({ ok: true });
  });

  // ---- 维护模式（kiosk 托管）----

  router.get('/mode', (req, res) => {
    res.json(browserctl.status());
  });

  router.post('/mode', (req, res) => {
    const s = browserctl.setMode(String(req.body?.mode));
    if (!s) return res.status(400).json({ error: 'mode 只能是 normal 或 maintenance' });
    res.json(s);
  });

  // ---- 播放控制 ----

  router.post('/control', (req, res) => {
    const { action, qid, position, volume } = req.body || {};
    let ok = false;
    switch (action) {
      case 'play': ok = queue.play(); break;
      case 'pause': ok = queue.pause(); break;
      case 'next': queue.next(); ok = true; break;
      case 'prev': queue.prev(); ok = true; break;
      case 'jump': ok = queue.jump(qid); break;
      case 'seek': queue.seek(position); ok = true; break;
      case 'volume': queue.setVolume(volume); ok = true; break;
      case 'standby': // 停播待机：保留队列，回到第一部开头
        queue.pause(); queue.currentIndex = queue.queue.length ? 0 : -1;
        queue.seek(0); queue.playback.status = 'idle'; ok = true;
        queue._changed();
        break;
      default: return res.status(400).json({ error: 'unknown action' });
    }
    if (!ok) return res.status(409).json({ error: 'action not applicable' });
    res.json({ ok: true, state: queue.getPublicState() });
  });

  return router;
}

module.exports = { apiRouter };
