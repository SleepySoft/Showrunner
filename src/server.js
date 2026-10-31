'use strict';
/**
 * Showrunner 服务端入口。
 * 既可 `node src/server.js` 直接启动，也可被测试代码 require 后在临时端口启动。
 */
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const { loadConfig } = require('./config');
const { Store } = require('./store');
const { Library } = require('./library');
const { QueueManager } = require('./queue');
const { PlaylistManager } = require('./playlists');
const { CollectionManager } = require('./collections');
const { Scheduler } = require('./scheduler');
const { BrowserController } = require('./browserctl');
const { Auth } = require('./auth');
const { apiRouter } = require('./routes/api');
const { mediaRouter, cacheRouter } = require('./routes/media');
const { setupWs } = require('./ws');
const { CacheManager } = require('./cache');
const { findYtdlp, findFfmpeg, hasFfmpeg, checkYtdlp } = require('./ytdlp');

function createApp(cfg) {
  const store = new Store(cfg.dataFile);
  const persisted = store.load({ playlists: [], activeId: null, currentIndex: -1, playback: null, settings: {}, collections: [] });

  // 旧版数据迁移：单 queue → 包成「默认节目单」
  if (!Array.isArray(persisted.playlists)) {
    persisted.playlists = [];
    persisted.activeId = null;
  }
  if (Array.isArray(persisted.queue) && persisted.queue.length && persisted.playlists.length === 0) {
    const legacy = {
      id: crypto.randomUUID(), name: '默认节目单',
      items: persisted.queue, createdAt: Date.now()
    };
    persisted.playlists.push(legacy);
    persisted.activeId = legacy.id;
  }
  delete persisted.queue;

  // 媒体目录 = config.json/命令行 + 网页端运行时添加的（存在数据文件 settings 里）
  const storedDirs = persisted.settings?.mediaDirs || [];
  const allDirs = [...new Set([...(cfg.mediaDirs || []), ...storedDirs])];

  const library = new Library(allDirs);
  library.rescan();

  const playlists = new PlaylistManager(persisted);
  const collections = new CollectionManager(persisted);
  const scheduler = new Scheduler(persisted);
  // 队列与播出中节目单共享 items 数组引用：编辑节目单即编辑直播队列
  const queue = new QueueManager(persisted, playlists.active()?.items || []);
  const auth = new Auth(cfg.password, cfg.sessionTtlHours);

  // 合集解析器：轮到「合集抽一集」条目时，从合集取下一集
  queue.resolver = (qItem) => {
    const r = collections.takeNext(qItem.collectionId);
    if (!r) return null;
    return { ...r.item, episode: r.episode, total: r.total };
  };

  // kiosk 浏览器托管：默认仅真实启动时开启（cfg.manageBrowser），测试默认关闭
  const browserctl = new BrowserController({
    tvUrl: `http://localhost:${cfg.port}/tv/`,
    chromePath: cfg.chromePath,
    manage: !!cfg.manageBrowser
  });

  // 网页片源缓存：yt-dlp 预下载，播出队列变化时自动预取当前 + 后 2 个
  // cfg.disableCache 供测试使用：不找 yt-dlp、不挂预取钩子
  const ytdlp = cfg.disableCache ? null : findYtdlp(cfg.ytdlpPath, cfg.rootDir);
  const cache = new CacheManager({
    dir: cfg.cacheDir || path.join(cfg.rootDir, 'cache'),
    ytdlp,
    ffmpeg: findFfmpeg(cfg.rootDir) || hasFfmpeg(cfg.rootDir),
    cookiesFromBrowser: cfg.cookiesFromBrowser || null,
    maxBytes: (cfg.cacheMaxGB || 20) * 1024 * 1024 * 1024
  });
  if (!ytdlp && !cfg.disableCache) console.warn('未找到 yt-dlp，网页片源将无法缓存（可安装 yt-dlp 或在 config.json 配置 ytdlpPath）');
  queue.decorator = item => cache.decorate(item);
  // 预取时合集条目用已解析的那一集（未解析的等轮到它再说）
  const effectiveItems = items => items.map(i => (i && i.type === 'collection' ? i.resolved : i));
  if (!cfg.disableCache) queue.on('change', () => cache.prefetchQueue(effectiveItems(queue.queue), queue.currentIndex));

  const persist = () => {
    try {
      store.save({
        ...playlists.serialize(),
        ...collections.serialize(),
        currentIndex: queue.currentIndex,
        playback: queue.playback,
        settings: { mediaDirs: library.mediaDirs, schedules: scheduler.serialize() }
      });
    } catch (e) { console.error('持久化失败:', e.message); }
  };
  queue.on('change', persist);
  playlists.on('change', persist);
  collections.on('change', persist);
  const onDirsChange = () => persist();

  /** 切到某节目单并开播（时刻表跃迁用） */
  const switchToPlaylist = (playlistId, loop) => {
    const p = playlists.activate(playlistId);
    if (!p) return false;
    queue.loadPlaylist(p.items, { loop: loop || p.loop });
    queue.play();
    return true;
  };

  /** 时刻表跃迁执行器：只在窗口进出时动作，不抢家长的手动操作 */
  const applySchedulerTick = (now = new Date()) => {
    const d = scheduler.tick(now);
    if (d.action === 'switch') {
      if (switchToPlaylist(d.rule.playlistId, d.rule.loop)) {
        scheduler.applied(d.rule.id);
      }
    } else if (d.action === 'standby') {
      queue.pause();
      queue.currentIndex = queue.queue.length ? 0 : -1;
      queue.seek(0);
      queue.playback.status = 'idle';
      queue._changed();
      scheduler.applied(null);
    }
    return d;
  };

  const app = express();
  app.disable('x-powered-by');

  // 播放端与媒体流：局域网专用，不鉴权
  app.use('/tv', express.static(path.join(cfg.rootDir, 'public', 'tv')));
  app.use('/media', mediaRouter(library));
  app.use('/cache', cacheRouter(cache));

  // 遥控器：静态页 + API
  app.use('/remote', express.static(path.join(cfg.rootDir, 'public', 'remote')));
  app.use('/api', apiRouter({ auth, library, queue, playlists, collections, scheduler, browserctl, cache, onDirsChange, onPersist: persist, applySchedulerTick }));

  app.get('/', (req, res) => res.redirect('/remote/'));

  return { app, queue, library, playlists, collections, scheduler, browserctl, auth, store, cache, applySchedulerTick };
}

async function start(cfg) {
  const { app, queue, library, playlists, collections, scheduler, browserctl, auth, store, cache, applySchedulerTick } = createApp(cfg);
  const server = http.createServer(app);
  const ws = setupWs(server, { auth, queue });

  // 缓存状态变化 / 下载进度 → 推送给电视与遥控器（进度已在 CacheManager 内节流）
  cache.on('change', () => ws.pushState());
  cache.on('progress', () => ws.pushState());

  // kiosk 托管启动 + 模式变更广播
  browserctl.on('change', s => ws.broadcast({ type: 'mode', data: s }));
  browserctl.start();

  // 时刻表：每 15 秒检查一次窗口跃迁（测试可传 cfg.disableScheduler 关闭）
  const schedTimer = cfg.disableScheduler ? null : setInterval(() => applySchedulerTick(), 15000);
  if (schedTimer) schedTimer.unref?.();
  applySchedulerTick(); // 启动即对齐一次（如重启时正处于窗口中）

  // 跟踪活跃连接，close 时全部销毁，保证进程（和测试）能干净退出
  const sockets = new Set();
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.on('upgrade', (req, s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  await new Promise(resolve => server.listen(cfg.port, cfg.host, resolve));
  const addr = server.address();

  return {
    server, app, queue, library, playlists, collections, scheduler, browserctl, auth, store, cache, ws,
    applySchedulerTick,
    port: addr.port, host: addr.address,
    close: () => new Promise(resolve => {
      if (schedTimer) clearInterval(schedTimer);
      browserctl.stop();
      for (const c of ws.wss.clients) c.terminate();
      for (const s of sockets) s.destroy();
      ws.wss.close();
      server.close(() => resolve());
    })
  };
}

if (require.main === module) {
  const cfg = loadConfig(path.join(__dirname, '..'));
  // 真实运行默认托管 kiosk 浏览器（config.json 可用 "manageBrowser": false 关闭）
  if (cfg.manageBrowser === undefined) cfg.manageBrowser = true;
  start(cfg).then(({ port, host }) => {
    const shownHost = host === '0.0.0.0' || host === '::' ? '本机IP' : host;
    console.log('');
    console.log('  Showrunner 放映员已启动');
    console.log(`  电视播放端:  http://localhost:${port}/tv/`);
    console.log(`  手机遥控器:  http://${shownHost}:${port}/remote/`);
    if (cfg.generatedPassword) console.log(`  首次运行，已生成遥控器密码: ${cfg.password}  （已写入 config.json）`);
    console.log('');
  });
}

module.exports = { createApp, start };
