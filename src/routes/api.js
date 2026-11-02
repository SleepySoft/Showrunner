'use strict';
/**
 * 遥控器 API：登录、片库、目录管理、文件浏览、节目单管理、合集、时刻表、
 * 队列、播放控制、缓存管理、节目表导出。
 * 除首次配对与 /login 外全部需要会话。
 * 节目单与队列的关系：播出中节目单的 items 与 QueueManager.queue 共享同一数组——
 * 编辑播出中的节目单 = 编辑直播队列；编辑其他节目单不影响播出。
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { COOKIE, Auth } = require('../auth');
const { browse } = require('../browse');
const { resolveTitle } = require('../webtitle');
const { createAssetDocument, validateAssetDocument } = require('../assets');
const { isDirectPrivateRequest } = require('../password-recovery');

const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function apiRouter({ auth, setup, passwordRecovery, library, queue, playlists, collections, scheduler, frontendSupervisor, cache, compatibility, playbackIssues, updater, autostart, siteCollectionImporter, selectChannel, applyChannelTimingTick, onPasswordChange, onDirsChange, onPersist, applySchedulerTick }) {
  const router = express.Router();
  router.use(express.json({ limit: '10mb' }));

  const loginFailures = new Map();
  const setupFailures = new Map();
  const cookieFor = (req, token, maxAge = 7 * 24 * 3600) => {
    const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  };

  router.get('/setup/status', (req, res) => {
    res.json({ required: !!setup?.required });
  });

  router.post('/setup', (req, res) => {
    if (!setup?.required) return res.status(409).json({ error: '首次配对已经完成' });
    const key = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const attempt = setupFailures.get(key);
    if (attempt?.blockedUntil > now) return res.status(429).json({ error: '尝试过多，请稍后再试' });
    const supplied = Buffer.from(String(req.body?.code ?? ''));
    const expected = Buffer.from(String(setup.code ?? ''));
    const codeMatches = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
    if (!codeMatches) {
      const failures = (attempt?.failures || 0) + 1;
      setupFailures.set(key, { failures, blockedUntil: failures >= 5 ? now + 15 * 60000 : 0 });
      return res.status(403).json({ error: '配对码不正确' });
    }
    const next = String(req.body?.newPassword ?? '');
    if (next.length < 8 || next.length > 128) return res.status(400).json({ error: '密码长度需为 8-128 个字符' });
    const hash = Auth.hashPassword(next);
    try { if (onPasswordChange) onPasswordChange(hash); }
    catch (e) { return res.status(500).json({ error: '密码保存失败：' + e.message }); }
    auth.setPasswordHash(hash);
    setup.required = false;
    setup.code = null;
    setupFailures.clear();
    const token = auth.createSession();
    res.setHeader('Set-Cookie', cookieFor(req, token));
    res.json({ ok: true, token });
  });

  router.post('/login', (req, res) => {
    if (setup?.required) return res.status(409).json({ error: 'setup_required' });
    const key = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const attempt = loginFailures.get(key);
    if (attempt?.blockedUntil > now) return res.status(429).json({ error: '尝试过多，请稍后再试' });
    const token = auth.login(String(req.body?.password ?? ''));
    if (!token) {
      const failures = (attempt?.failures || 0) + 1;
      loginFailures.set(key, { failures, blockedUntil: failures >= 5 ? now + 15 * 60000 : 0 });
      return res.status(401).json({ error: 'wrong password' });
    }
    loginFailures.delete(key);
    res.setHeader('Set-Cookie', cookieFor(req, token));
    res.json({ ok: true, token });
  });

  router.post('/logout', (req, res) => {
    const token = Auth.tokenFromReq(req);
    if (token) auth.logout(token);
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
    res.json({ ok: true });
  });

  router.get('/password/recovery/status', (_req, res) => {
    res.json(passwordRecovery ? passwordRecovery.status() : { active: false, expiresAt: null });
  });

  router.post('/password/recovery/request', (req, res) => {
    if (!isDirectPrivateRequest(req)) return res.status(403).json({ error: '密码恢复只能通过局域网直连发起' });
    if (setup?.required) return res.status(409).json({ error: '请直接完成首次配对' });
    if (!passwordRecovery) return res.status(503).json({ error: '密码恢复不可用' });
    const result = passwordRecovery.request();
    if (!result.ok) return res.status(429).json({ error: '尝试过多，请稍后再试', blockedUntil: result.blockedUntil });
    res.json({ active: true, expiresAt: result.expiresAt });
  });

  router.post('/password/recovery/confirm', (req, res) => {
    if (!isDirectPrivateRequest(req)) return res.status(403).json({ error: '密码恢复只能通过局域网直连完成' });
    if (!passwordRecovery) return res.status(503).json({ error: '密码恢复不可用' });
    const next = String(req.body?.newPassword ?? '');
    if (next.length < 8 || next.length > 128) return res.status(400).json({ error: '新密码长度需为 8-128 个字符' });
    const verified = passwordRecovery.verify(req.body?.code);
    if (!verified.ok) return res.status(verified.blocked ? 429 : 403).json({ error: verified.error });
    const hash = Auth.hashPassword(next);
    try { if (onPasswordChange) onPasswordChange(hash); }
    catch (e) { return res.status(500).json({ error: '密码保存失败：' + e.message }); }
    auth.setPasswordHash(hash);
    passwordRecovery.cancel();
    loginFailures.clear();
    const token = auth.createSession();
    res.setHeader('Set-Cookie', cookieFor(req, token));
    res.json({ ok: true, token });
  });

  // 正常服务已通过存储迁移门禁；该公开状态供遥控器首屏判断。
  router.get('/storage/status', (_req, res) => res.json({ required: false }));

  // ---- 以下需要登录 ----
  router.use(auth.middleware());

  router.post('/password', (req, res) => {
    const current = String(req.body?.currentPassword ?? '');
    const next = String(req.body?.newPassword ?? '');
    if (!auth.verifyPassword(current)) return res.status(403).json({ error: '当前密码不正确' });
    if (next.length < 8 || next.length > 128) return res.status(400).json({ error: '新密码长度需为 8-128 个字符' });
    if (next === current) return res.status(400).json({ error: '新密码不能与当前密码相同' });
    const hash = Auth.hashPassword(next);
    try { if (onPasswordChange) onPasswordChange(hash); }
    catch (e) { return res.status(500).json({ error: '密码保存失败：' + e.message }); }
    auth.setPasswordHash(hash);
    const token = auth.createSession();
    res.setHeader('Set-Cookie', cookieFor(req, token));
    res.json({ ok: true, token });
  });

  router.get('/autostart', async (req, res) => {
    res.json(autostart ? await autostart.status() : { supported: false, enabled: false });
  });

  router.post('/autostart', async (req, res) => {
    if (!autostart) return res.status(503).json({ error: '开机启动管理不可用' });
    const result = await autostart.setEnabled(!!req.body?.enabled);
    if (result.error) return res.status(500).json(result);
    res.json(result);
  });

  router.get('/state', (req, res) => {
    res.json({
      state: { ...queue.getPublicState(), channels: playlists.tvList(), selectedChannelId: playlists.activeId },
      queue: queue.queue,
      playlists: playlists.list(),
      activeId: playlists.activeId,
      cache: cache ? cache.brief() : [],
      collections: collections.list(),
      schedules: schedulesWithNames()
    });
  });

  function schedulesWithNames() {
    return scheduler.list().map(r => ({
      ...r,
      playlistName: playlists.get(r.playlistId)?.name || '（频道已删除）'
    }));
  }

  // ---- 网页片源缓存管理 ----

  router.get('/cache', (req, res) => {
    res.json({ items: cache ? cache.brief() : [] });
  });

  // ---- 诊断日志（只返回结构化播放事件，不暴露文件绝对路径或服务端原始日志） ----
  router.get('/diagnostics/playback', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      events: playbackIssues ? playbackIssues.recent(req.query.limit) : [],
      compatibility: compatibility ? compatibility.brief() : []
    });
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
    if (r.wasActive) {
      const fallback = playlists.playlists.find(x => x.enabled);
      if (fallback && selectChannel) selectChannel(fallback.id);
      else queue.loadPlaylist([]);
    }
    res.json({ ok: true });
  });

  router.post('/playlists/:id/activate', (req, res) => {
    const p = playlists.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    if (!p.enabled) playlists.setOptions(p.id, { enabled: true });
    if (selectChannel) selectChannel(p.id, { play: true });
    else { playlists.activate(p.id); queue.loadPlaylist(p.items, { loop: p.loop }); }
    res.json({ ok: true, state: queue.getPublicState() });
  });

  router.post('/playlists/:id/options', (req, res) => {
    const p = playlists.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    const autoPlayChanged = typeof req.body?.autoPlay === 'boolean' && req.body.autoPlay !== p.autoPlay;
    playlists.setOptions(p.id, req.body || {});
    if (!p.enabled && p.id === playlists.activeId) {
      const fallback = playlists.playlists.find(x => x.enabled);
      if (fallback && selectChannel) selectChannel(fallback.id);
      else { playlists.activeId = null; queue.standby(); }
    } else if (p.id === playlists.activeId && autoPlayChanged && selectChannel) {
      selectChannel(p.id, { play: p.autoPlay !== false });
    }
    res.json({ ok: true, channel: playlists.list().find(x => x.id === p.id) });
  });

  /** 循环开关；播出中的节目单立即作用于直播队列 */
  router.post('/playlists/:id/loop', (req, res) => {
    const p = playlists.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    playlists.setLoop(p.id, !!req.body?.loop);
    if (p.id === playlists.activeId) {
      queue.loop = !!req.body?.loop;
      queue._changed();
    }
    res.json({ ok: true, loop: !!req.body?.loop });
  });

  /** 读取单个节目单（含条目全文） */
  router.get('/playlists/:id', (req, res) => {
    const p = playlists.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    res.json({ playlist: { id: p.id, name: p.name, active: p.id === playlists.activeId, loop: !!p.loop, items: p.items } });
  });

  function localItem(id) {
    const item = library.get(id);
    if (!item) throw { status: 404, error: `media not found: ${id}` };
    return {
      type: 'local', mediaId: item.id, title: item.title, relPath: item.relPath,
      sourceId: item.sourceId, sourceName: item.sourceName
    };
  }

  /** 构建条目：本地媒体 ID（单个/批量）、网页链接、合集抽一集。错误抛 { status, error }。 */
  async function buildItems(body) {
    const url = body?.url;
    if (url) {
      let u;
      try { u = new URL(String(url)); } catch { throw { status: 400, error: '链接格式不正确' }; }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw { status: 400, error: '只支持 http/https 链接' };
      const title = await resolveTitle(u.toString());
      return [{ type: 'web', url: u.toString(), title, relPath: u.host }];
    }
    if (body?.collectionId) {
      const c = collections.get(String(body.collectionId));
      if (!c) throw { status: 404, error: '合集不存在' };
      return [{ type: 'collection', collectionId: c.id, title: c.name, relPath: '合集' }];
    }
    const ids = Array.isArray(body?.mediaIds) ? body.mediaIds : [body?.mediaId];
    if (!ids.length || !ids[0]) throw { status: 400, error: '缺少 mediaId、url 或 collectionId' };
    return [...new Set(ids.map(String))].map(localItem);
  }

  /**
   * 确认式更新本地条目集合：保留仍被选中的原条目及排序/时间配置，
   * 删除取消选中与历史重复项，新选文件追加到末尾。
   * 已在容器中但当前片库不可访问的 ID 仍可保留，避免 NAS 暂离线时误删资产。
   */
  function replaceLocalItems(container, requestedIds, { remove, add }) {
    if (!Array.isArray(requestedIds) || requestedIds.length > 10000) {
      throw { status: 400, error: 'mediaIds 必须是不超过 10000 项的数组' };
    }
    const ids = [...new Set(requestedIds.map(id => String(id ?? '')).filter(Boolean))];
    const desired = new Set(ids);
    const existingById = new Map();
    const toRemove = [];
    for (const item of container.items) {
      if (item.type !== 'local') continue;
      const mediaId = String(item.mediaId ?? '');
      if (!desired.has(mediaId) || existingById.has(mediaId)) toRemove.push(item.qid);
      else existingById.set(mediaId, item);
    }
    // 先验证所有新项，验证失败时不修改现有集合。
    const additions = ids.filter(id => !existingById.has(id)).map(localItem);
    for (const qid of toRemove) remove(qid);
    const added = additions.map(add);
    return { added, removed: toRemove.length, selected: ids.length };
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

  router.put('/playlists/:id/local-items', (req, res) => {
    const p = playlists.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    try {
      const active = p.id === playlists.activeId;
      const result = replaceLocalItems(p, req.body?.mediaIds, {
        remove: qid => active ? queue.remove(qid) : playlists.removeItem(p.id, qid),
        add: item => active ? queue.add(item) : playlists.addItem(p.id, item)
      });
      res.json(result);
    } catch (e) { res.status(e.status || 500).json({ error: e.error || 'failed' }); }
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

  router.post('/playlists/:id/items/:qid/timing', (req, res) => {
    const { maxPlaySeconds, startTime } = req.body || {};
    if (maxPlaySeconds !== null && maxPlaySeconds !== '' && maxPlaySeconds !== undefined) {
      const seconds = Number(maxPlaySeconds);
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) {
        return res.status(400).json({ error: '播放上限需为 1-86400 秒，留空表示不限制' });
      }
    }
    if (startTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(startTime))) {
      return res.status(400).json({ error: '指定开播时间需为 HH:MM' });
    }
    if (!playlists.updateItem(req.params.id, req.params.qid, { maxPlaySeconds, startTime })) {
      return res.status(404).json({ error: 'not found' });
    }
    if (req.params.id === playlists.activeId && applyChannelTimingTick) applyChannelTimingTick();
    res.json({ ok: true });
  });

  // ---- 合集 ----

  router.get('/collections', (req, res) => {
    res.json({ collections: collections.list() });
  });

  router.post('/collections', (req, res) => {
    const c = collections.create(req.body?.name, req.body?.mode);
    res.status(201).json({ collection: { id: c.id, name: c.name, mode: c.mode, count: 0, cursor: 0 } });
  });

  /** 从网站播放列表/分 P 视频创建合集。解析成功后才落库，失败不留下空合集。 */
  router.post('/collections/import', async (req, res) => {
    let url;
    try { url = new URL(String(req.body?.url || '')); }
    catch { return res.status(400).json({ error: '链接格式不正确' }); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return res.status(400).json({ error: '只支持 http/https 链接' });
    }
    if (!siteCollectionImporter) return res.status(503).json({ error: '网站合集导入不可用' });

    let result;
    try { result = await siteCollectionImporter(url.toString()); }
    catch (e) { return res.status(502).json({ error: e.message || '解析网站合集失败' }); }
    if (!result?.ok || !Array.isArray(result.entries) || !result.entries.length) {
      return res.status(422).json({ error: result?.error || '网站没有返回可导入的剧集' });
    }

    const items = result.entries.flatMap(entry => {
      try {
        const itemUrl = new URL(String(entry?.url || ''));
        if (itemUrl.protocol !== 'http:' && itemUrl.protocol !== 'https:') return [];
        return [{
          type: 'web', url: itemUrl.toString(),
          title: String(entry?.title || itemUrl.host).trim() || itemUrl.host,
          relPath: itemUrl.host
        }];
      } catch { return []; }
    });
    if (!items.length) return res.status(422).json({ error: '网站没有返回有效的剧集链接' });

    const requestedName = String(req.body?.name || '').trim();
    const c = collections.create(requestedName || result.title || '网站合集', req.body?.mode);
    const added = collections.addItems(c.id, items);
    res.status(201).json({
      collection: { id: c.id, name: c.name, mode: c.mode, count: added.length, cursor: 0 },
      imported: added.length,
      truncated: !!result.truncated
    });
  });

  router.get('/collections/:id', (req, res) => {
    const c = collections.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json({ collection: { id: c.id, name: c.name, mode: c.mode, cursor: c.cursor, items: c.items } });
  });

  router.post('/collections/:id/rename', (req, res) => {
    const c = collections.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    const name = String(req.body?.name || '').trim().slice(0, 50);
    if (!name) return res.status(400).json({ error: '合集名称不能为空' });
    // 已加入频道的「合集抽一集」条目也同步显示新名称；rename 的 change 事件会一起持久化。
    for (const channel of playlists.playlists) {
      for (const item of channel.items) {
        if (item.type === 'collection' && item.collectionId === c.id) item.title = name;
      }
    }
    collections.rename(c.id, name);
    res.json({ ok: true, collection: { id: c.id, name: c.name } });
  });

  router.delete('/collections/:id', (req, res) => {
    if (!collections.remove(req.params.id)) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  router.post('/collections/:id/mode', (req, res) => {
    if (!collections.setMode(req.params.id, req.body?.mode)) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  router.post('/collections/:id/reset', (req, res) => {
    if (!collections.resetCursor(req.params.id)) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  router.post('/collections/:id/items', async (req, res) => {
    const c = collections.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    let items;
    try { items = await buildItems(req.body); }
    catch (e) { return res.status(e.status || 500).json({ error: e.error || 'failed' }); }
    if (items.some(it => it.type === 'collection')) {
      return res.status(400).json({ error: '合集不能嵌套合集' });
    }
    res.status(201).json({ added: items.map(it => collections.addItem(c.id, it)) });
  });

  router.put('/collections/:id/local-items', (req, res) => {
    const c = collections.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    try {
      const result = replaceLocalItems(c, req.body?.mediaIds, {
        remove: qid => collections.removeItem(c.id, qid),
        add: item => collections.addItem(c.id, item)
      });
      res.json(result);
    } catch (e) { res.status(e.status || 500).json({ error: e.error || 'failed' }); }
  });

  router.delete('/collections/:id/items/:qid', (req, res) => {
    if (!collections.removeItem(req.params.id, req.params.qid)) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  router.post('/collections/:id/items/move', (req, res) => {
    const { qid, toIndex } = req.body || {};
    if (!collections.moveItem(req.params.id, qid, toIndex)) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  // ---- 播出时刻表 ----

  router.get('/schedules', (req, res) => {
    res.json({ rules: schedulesWithNames() });
  });

  router.post('/schedules', (req, res) => {
    const { playlistId, days, start, end, loop } = req.body || {};
    if (!playlists.get(String(playlistId || ''))) return res.status(404).json({ error: '频道不存在' });
    const r = scheduler.add({ playlistId, days, start, end, loop });
    if (r.error) return res.status(400).json({ error: r.error });
    persistNow();
    if (applySchedulerTick) applySchedulerTick(); // 立即对齐（可能正好在窗口内）
    res.status(201).json({ rule: r.rule });
  });

  router.delete('/schedules/:id', (req, res) => {
    if (!scheduler.remove(req.params.id)) return res.status(404).json({ error: 'not found' });
    persistNow();
    if (applySchedulerTick) applySchedulerTick();
    res.json({ ok: true });
  });

  function persistNow() { if (onPersist) onPersist(); }

  // ---- 无损资产备份 / 恢复 ----

  const assetState = () => ({
    ...playlists.serialize(),
    ...collections.serialize(),
    settings: { schedules: scheduler.serialize() }
  });

  router.get('/assets/export', (req, res) => {
    res.setHeader('Content-Disposition', `attachment; filename="showrunner-assets-${Date.now()}.showrunner.json"`);
    res.json(createAssetDocument(assetState()));
  });

  function rebindLocalItems(document) {
    const media = library.list();
    let rebound = 0, unresolved = 0;
    const visit = item => {
      if (!item || item.type === 'web' || item.type === 'collection' || !item.relPath) return;
      const exact = media.find(m => m.relPath === item.relPath && (!item.sourceName || m.sourceName === item.sourceName));
      const candidates = exact ? [exact] : media.filter(m => m.relPath === item.relPath);
      if (candidates.length === 1) {
        const found = candidates[0];
        if (item.mediaId !== found.id) rebound++;
        item.mediaId = found.id;
        item.sourceId = found.sourceId;
        item.sourceName = found.sourceName;
      } else unresolved++;
    };
    for (const p of document.playlists) p.items.forEach(visit);
    for (const c of document.collections) c.items.forEach(visit);
    return { rebound, unresolved };
  }

  router.post('/assets/import', (req, res) => {
    let document;
    try { document = validateAssetDocument(req.body?.document || req.body); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const mode = req.body?.mode === 'replace' ? 'replace' : 'merge';
    const binding = rebindLocalItems(document);

    if (mode === 'replace') {
      playlists.playlists = document.playlists;
      playlists.activeId = document.playlists.some(p => p.id === document.activeId) ? document.activeId : (document.playlists[0]?.id || null);
      collections.collections = document.collections.map(c => ({ ...c, randomPool: null }));
      scheduler.rules = document.schedules;
    } else {
      const collectionIds = new Set(collections.collections.map(c => c.id));
      const collectionMap = new Map();
      for (const c of document.collections) {
        const old = c.id;
        if (collectionIds.has(c.id)) c.id = crypto.randomUUID();
        collectionIds.add(c.id);
        collectionMap.set(old, c.id);
        collections.collections.push({ ...c, randomPool: null });
      }
      const playlistIds = new Set(playlists.playlists.map(p => p.id));
      const playlistMap = new Map();
      for (const p of document.playlists) {
        const old = p.id;
        if (playlistIds.has(p.id)) p.id = crypto.randomUUID();
        playlistIds.add(p.id);
        playlistMap.set(old, p.id);
        for (const item of p.items) if (item.type === 'collection') item.collectionId = collectionMap.get(item.collectionId) || item.collectionId;
        playlists.playlists.push(p);
      }
      const scheduleIds = new Set(scheduler.rules.map(r => r.id));
      for (const rule of document.schedules) {
        if (scheduleIds.has(rule.id)) rule.id = crypto.randomUUID();
        rule.playlistId = playlistMap.get(rule.playlistId) || rule.playlistId;
        scheduleIds.add(rule.id);
        scheduler.rules.push(rule);
      }
    }

    // 重新挂接当前频道数组，避免替换后直播队列仍引用旧数组。
    if (playlists.activeId) selectChannel(playlists.activeId, { play: false });
    else queue.clear();
    persistNow();
    res.json({ ok: true, mode, binding, playlists: document.playlists.length, collections: document.collections.length, schedules: document.schedules.length });
  });

  // ---- 节目表导出 ----

  function exportData() {
    return {
      exportedAt: new Date().toISOString(),
      schedules: schedulesWithNames(),
      playlists: playlists.list().map(p => ({
        ...p,
        items: (playlists.get(p.id)?.items || []).map(it => ({
          type: it.type, title: it.title, relPath: it.relPath,
          url: it.url, mediaId: it.mediaId, collectionId: it.collectionId
        }))
      })),
      collections: collections.list().map(c => ({
        ...c,
        items: (collections.get(c.id)?.items || []).map(it => ({
          type: it.type, title: it.title, relPath: it.relPath, url: it.url
        }))
      }))
    };
  }

  function exportMarkdown() {
    const d = exportData();
    const L = [];
    L.push('# Showrunner 节目表');
    L.push('');
    L.push(`导出时间：${new Date().toLocaleString('zh-CN')}`);
    L.push('');
    L.push('## 播出时刻表');
    L.push('');
    if (!d.schedules.length) {
      L.push('（无定时规则——全天手动播出）');
    } else {
      L.push('| 时段 | 星期 | 频道 | 循环 |');
      L.push('|---|---|---|---|');
      for (const r of d.schedules) {
        L.push(`| ${r.start}–${r.end} | ${r.days.map(d2 => DAY_NAMES[d2]).join('、')} | ${r.playlistName} | ${r.loop ? '是' : '否'} |`);
      }
    }
    L.push('');
    L.push('## 频道');
    for (const p of d.playlists) {
      L.push('');
      L.push(`### ${p.active ? '▶ ' : ''}${p.name}（${p.count} 个${p.loop ? '，循环' : ''}）`);
      L.push('');
      p.items.forEach((it, i) => {
        if (it.type === 'web') L.push(`${i + 1}. 🌐 ${it.title}（${it.relPath}）`);
        else if (it.type === 'collection') {
          const c = d.collections.find(x => x.id === it.collectionId);
          const prog = c ? `第 ${c.cursor + 1 > c.count ? 1 : c.cursor + 1} 集 / 共 ${c.count} 集` : '合集已删除';
          L.push(`${i + 1}. 📚 《${it.title}》抽一集（下次播：${prog}）`);
        }
        else L.push(`${i + 1}. ${it.title}`);
      });
      if (!p.items.length) L.push('（空）');
    }
    L.push('');
    L.push('## 合集');
    for (const c of d.collections) {
      L.push('');
      L.push(`### ${c.name}（${c.mode === 'random' ? '随机抽' : '顺序播'}，播到第 ${c.cursor} 集 / 共 ${c.count} 集）`);
      L.push('');
      c.items.forEach((it, i) => L.push(`${i + 1}. ${it.title}${i === c.cursor ? ' ← 下一集' : ''}`));
      if (!c.items.length) L.push('（空）');
    }
    L.push('');
    return L.join('\n');
  }

  router.get('/export', (req, res) => {
    res.json(exportData());
  });

  router.get('/export.md', (req, res) => {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="showrunner-guide-${Date.now()}.md"`);
    res.send(exportMarkdown());
  });

  // ---- 直播队列（= 播出中节目单）----

  router.post('/queue', async (req, res) => {
    if (!playlists.active()) {
      return res.status(409).json({ error: '还没有当前频道，请先在「频道」页创建并切换到一个频道' });
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

  // ---- 应用内自更新 ----

  router.get('/update/status', (req, res) => {
    if (!updater) return res.status(503).json({ error: 'updater unavailable' });
    res.json(updater.status());
  });

  router.post('/update/check', async (req, res) => {
    if (!updater) return res.status(503).json({ error: 'updater unavailable' });
    res.json(await updater.check());
  });

  // 一键升级：下载 → 派生更新器 → 本进程退出重启（客户端应预期连接中断）
  router.post('/update/apply', async (req, res) => {
    if (!updater) return res.status(503).json({ error: 'updater unavailable' });
    const st = await updater.apply();
    res.json(st);
  });

  // ---- 维护模式（kiosk 托管）----

  router.get('/mode', (req, res) => {
    res.json(frontendSupervisor.status());
  });

  router.get('/playback/frontend', (req, res) => res.json(frontendSupervisor.status()));

  router.put('/playback/frontend', async (req, res) => {
    const result = await frontendSupervisor.setFrontend(String(req.body?.type || ''));
    if (!result.ok) return res.status(result.error?.includes('未注册') ? 400 : 409).json(result);
    res.json(result.status);
  });

  router.post('/mode', async (req, res) => {
    const s = await frontendSupervisor.setMode(String(req.body?.mode));
    if (!s) return res.status(400).json({ error: 'mode 只能是 normal、maintenance 或 offline' });
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
