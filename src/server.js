'use strict';
/**
 * Showrunner 服务端入口。
 * 既可 `node src/server.js` 直接启动，也可被测试代码 require 后在临时端口启动。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const express = require('express');

const { loadConfig, savePasswordHash, saveConfigPatch } = require('./config');
const { Store } = require('./store');
const { AssetVault } = require('./assets');
const { Library } = require('./library');
const { QueueManager } = require('./queue');
const { PlaylistManager } = require('./playlists');
const { CollectionManager } = require('./collections');
const { Scheduler } = require('./scheduler');
const { BrowserController } = require('./browserctl');
const { PlayableSourceResolver } = require('./playback/source-resolver');
const { ChromeFrontend } = require('./playback/chrome');
const { MpvFrontend, findMpv } = require('./playback/mpv');
const { FrontendSupervisor } = require('./playback/supervisor');
const { Auth } = require('./auth');
const { apiRouter } = require('./routes/api');
const { mediaRouter, cacheRouter, compatibilityRouter } = require('./routes/media');
const { setupWs } = require('./ws');
const { CacheManager } = require('./cache');
const { Updater } = require('./updater');
const { AutostartManager } = require('./autostart');
const { PlaybackIssueLogger } = require('./playback-issues');
const { CompatibilityManager } = require('./compatibility');
const { startStorageGate } = require('./storage-gate');
const { PasswordRecovery } = require('./password-recovery');
const { findYtdlp, findFfmpeg, hasFfmpeg, fetchCollection, checkYtdlp } = require('./ytdlp');

function createApp(cfg) {
  const store = new Store(cfg.dataFile);
  const assetVault = new AssetVault({ dataFile: cfg.dataFile, externalDir: cfg.assetVaultDir || null });
  const emptyState = { schemaVersion: 1, playlists: [], activeId: null, currentIndex: -1, playback: null, settings: {}, collections: [] };
  let persisted;
  try { persisted = store.load(emptyState); }
  catch (error) {
    const recoveredAssets = error.code === 'STORE_CORRUPT' ? assetVault.loadCurrent() : null;
    if (!recoveredAssets) throw error;
    persisted = JSON.parse(JSON.stringify(emptyState));
    persisted.playlists = recoveredAssets.playlists;
    persisted.activeId = recoveredAssets.activeId;
    persisted.collections = recoveredAssets.collections;
    persisted.settings.schedules = recoveredAssets.schedules;
    store.loadStatus = 'recovered-assets';
    store.save(persisted, { skipBackup: true });
    console.warn(`实时状态损坏，已从资产保险库恢复；损坏文件保留在：${error.quarantined}`);
  }
  if (store.loadStatus === 'missing') {
    const recoveredAssets = assetVault.loadCurrent();
    if (recoveredAssets) {
      persisted.playlists = recoveredAssets.playlists;
      persisted.activeId = recoveredAssets.activeId;
      persisted.collections = recoveredAssets.collections;
      persisted.settings = { ...persisted.settings, schedules: recoveredAssets.schedules };
      console.warn('实时数据文件不存在，已从独立资产保险库恢复频道、合集和时刻表。');
    }
  }
  if (Number(persisted.schemaVersion || 0) > 1) {
    throw new Error(`数据文件版本 ${persisted.schemaVersion} 高于当前程序支持的版本 1；已拒绝启动以防止旧程序覆盖新数据`);
  }
  persisted.schemaVersion = 1;

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
  // 数据迁移/异常恢复：若有启用频道但当前频道丢失，自动选第一个，避免电视无入口可切换。
  if (!playlists.active()) playlists.activeId = playlists.playlists.find(p => p.enabled)?.id || null;
  const collections = new CollectionManager(persisted);
  // 旧数据只有 mediaId/relPath；补齐片库来源名，资产跨机器导入时可消除同路径歧义。
  let assetMetadataMigrated = false;
  const enrichLocalItem = item => {
    if (!item || item.type !== 'local') return;
    const media = library.get(item.mediaId);
    if (!media) return;
    if (!item.sourceId) { item.sourceId = media.sourceId; assetMetadataMigrated = true; }
    if (!item.sourceName) { item.sourceName = media.sourceName; assetMetadataMigrated = true; }
  };
  for (const channel of playlists.playlists) channel.items.forEach(enrichLocalItem);
  for (const collection of collections.collections) collection.items.forEach(enrichLocalItem);
  const scheduler = new Scheduler(persisted);
  // 队列与播出中节目单共享 items 数组引用：编辑节目单即编辑直播队列
  const queue = new QueueManager(persisted, playlists.active()?.items || []);
  const setup = {
    required: cfg.setupRequired === undefined ? !cfg.password && !cfg.passwordHash : !!cfg.setupRequired,
    code: cfg.setupCode || String(crypto.randomInt(0, 1000000)).padStart(6, '0')
  };
  if (!setup.required) setup.code = null;
  const auth = new Auth(cfg.password, cfg.sessionTtlHours, cfg.password ? null : cfg.passwordHash);
  const passwordRecovery = cfg.passwordRecovery || new PasswordRecovery({
    codeFactory: cfg.passwordRecoveryCode ? () => String(cfg.passwordRecoveryCode) : undefined
  });
  let channelSlotKey = null;
  let onDemandActive = false;
  let schedulerHoldingStandby = false;

  // 合集解析器：轮到「合集抽一集」条目时，从合集取下一集
  queue.resolver = (qItem) => {
    const r = collections.takeNext(qItem.collectionId);
    if (!r) return null;
    return { ...r.item, episode: r.episode, total: r.total };
  };

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
  const compatibility = cfg.compatibilityManager || new CompatibilityManager({
    dir: cfg.compatibilityCacheDir || path.join(cfg.cacheDir || path.join(cfg.rootDir, 'cache'), 'compatible'),
    ffmpeg: cfg.disableCompatibility ? null : findFfmpeg(cfg.rootDir),
    maxBytes: (cfg.compatibilityCacheMaxGB || 10) * 1024 * 1024 * 1024
  });
  queue.decorator = item => ({
    ...cache.decorate(item),
    ...compatibility.decorate(item, item?.mediaId ? library.get(item.mediaId) : null)
  });

  // 播放前端：Chrome 与 mpv 共用队列权威状态、受信任源解析和维护/下线生命周期。
  const selectedFrontend = cfg.playerFrontend === 'mpv' ? 'mpv' : 'chrome';
  const initialMode = persisted.settings?.offline ? 'offline' : 'normal';
  const browserProcess = new BrowserController({
    tvUrl: `http://localhost:${cfg.port}/tv/`,
    chromePath: cfg.chromePath,
    manage: !!cfg.manageBrowser,
    initialMode: selectedFrontend === 'chrome' && initialMode === 'normal' ? 'normal' : 'offline'
  });
  const resolver = new PlayableSourceResolver({ library, cache });
  const chromeFrontend = new ChromeFrontend(browserProcess);
  const mpvFrontend = cfg.mpvFrontend || new MpvFrontend({
    mpvPath: findMpv(cfg.mpvPath, cfg.rootDir), rootDir: cfg.rootDir,
    ipcPath: cfg.mpvIpcPath, inputConf: cfg.mpvInputConf, windowed: !!cfg.mpvWindowed
  });
  const frontendSupervisor = cfg.frontendSupervisor || new FrontendSupervisor({
    browser: browserProcess,
    frontends: { chrome: chromeFrontend, mpv: mpvFrontend },
    selected: selectedFrontend,
    resolver,
    manage: !!cfg.manageBrowser,
    manageFrontend: cfg.manageFrontend === undefined ? !!cfg.manageBrowser : !!cfg.manageFrontend,
    initialMode,
    onSelectionChange: type => saveConfigPatch(cfg.configFile || path.join(cfg.rootDir, 'config.json'), { playerFrontend: type })
  });
  const siteCollectionImporter = cfg.siteCollectionImporter || (async url => {
    if (!ytdlp) return { ok: false, error: '未找到 yt-dlp，无法解析网站合集' };
    return fetchCollection(ytdlp, url, { cookiesFromBrowser: cfg.cookiesFromBrowser || null });
  });

  // 应用内自更新：config.json 的 updateRepo（"owner/repo"）决定从哪检查新版本
  const updater = new Updater({
    repo: cfg.updateRepo || '',
    currentVersion: require('../package.json').version,
    rootDir: cfg.rootDir,
    dataDir: cfg.dataDir || path.dirname(cfg.dataFile)
  });
  const autostart = cfg.autostartManager || new AutostartManager({ rootDir: cfg.rootDir });
  const playbackIssues = cfg.playbackIssueLogger || new PlaybackIssueLogger(
    cfg.playbackIssueLog || path.join(path.dirname(cfg.dataFile), 'playback-events.log')
  );
  // 预取时合集条目用已解析的那一集（未解析的等轮到它再说）
  const effectiveItems = items => items.map(i => (i && i.type === 'collection' ? i.resolved : i));
  if (!cfg.disableCache) queue.on('change', () => cache.prefetchQueue(effectiveItems(queue.queue), queue.currentIndex));

  const persistentState = () => ({
    schemaVersion: 1,
    ...playlists.serialize(),
    ...collections.serialize(),
    currentIndex: queue.currentIndex,
    playback: queue.playback,
    settings: { mediaDirs: library.mediaDirs, schedules: scheduler.serialize(), offline: frontendSupervisor.mode === 'offline' }
  });
  const persist = () => {
    try {
      const state = persistentState();
      store.save(state);
      assetVault.capture(state);
    } catch (e) { console.error('持久化失败:', e.message); }
  };
  queue.on('change', persist);
  playlists.on('change', persist);
  collections.on('change', persist);
  frontendSupervisor.on('change', persist);
  const onDirsChange = () => persist();
  // 首次启动建立独立镜像；从保险库恢复时也立即补回实时数据文件。
  try {
    const state = persistentState();
    assetVault.capture(state);
    if (store.loadStatus === 'missing' || assetMetadataMigrated) store.save(state);
  } catch (e) { console.error('资产保险库初始化失败:', e.message); }

  const parseStartTime = value => {
    const m = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
    if (!m || +m[1] > 23 || +m[2] > 59) return null;
    return +m[1] * 60 + +m[2];
  };
  const scheduledItems = channel => channel.items
    .map(item => ({ item, minute: parseStartTime(item.startTime) }))
    .filter(x => x.minute !== null)
    .sort((a, b) => a.minute - b.minute);
  const dateKey = now => `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;

  function nextScheduled(channel, now) {
    const items = scheduledItems(channel);
    if (!items.length) return null;
    const minuteNow = now.getHours() * 60 + now.getMinutes();
    let target = items.find(x => x.minute > minuteNow);
    const at = new Date(now);
    if (!target) { target = items[0]; at.setDate(at.getDate() + 1); }
    at.setHours(Math.floor(target.minute / 60), target.minute % 60, 0, 0);
    return { at: at.getTime(), title: target.item.title };
  }

  /** 对齐当前频道内每个节目的 HH:MM 开播点；提前播完时保持待机直到下一档。 */
  function applyChannelTimingTick(now = new Date()) {
    const channel = playlists.active();
    if (!channel) return { action: 'none' };
    const playing = queue.current();
    if (playing?.maxPlaySeconds && queue.playback.status === 'playing' && queue.playback.position >= playing.maxPlaySeconds) {
      handleChannelEnded();
      return { action: 'cutoff' };
    }
    if (schedulerHoldingStandby || channel.autoPlay === false || onDemandActive) return { action: 'none' };
    const slots = scheduledItems(channel);
    if (!slots.length) {
      return { action: 'none' };
    }

    const minuteNow = now.getHours() * 60 + now.getMinutes();
    const slot = [...slots].reverse().find(x => x.minute <= minuteNow);
    if (!slot) {
      const key = `${dateKey(now)}:before-first`;
      if (channelSlotKey !== key) {
        channelSlotKey = key;
        const next = nextScheduled(channel, now);
        queue.standby({ reason: 'schedule', nextStartAt: next?.at, nextTitle: next?.title });
        return { action: 'standby' };
      }
      return { action: 'none' };
    }

    const key = `${dateKey(now)}:${slot.item.qid}:${slot.item.startTime}`;
    if (channelSlotKey !== key) {
      channelSlotKey = key;
      queue.jump(slot.item.qid);
      return { action: 'switch', qid: slot.item.qid };
    }
    return { action: 'none' };
  }

  function waitForNextSlot(channel, now = new Date()) {
    const next = nextScheduled(channel, now);
    queue.standby({
      reason: channel.autoPlay === false ? 'on-demand' : 'schedule',
      nextStartAt: next?.at || null,
      nextTitle: next?.title || null
    });
  }

  function handleChannelEnded() {
    const channel = playlists.active();
    if (!channel) return false;
    if (onDemandActive) {
      onDemandActive = false;
      if (scheduledItems(channel).length) {
        channelSlotKey = null;
        applyChannelTimingTick();
      } else {
        queue.standby({ reason: 'on-demand' });
      }
      return true;
    }
    if (queue.current()?.startTime) {
      waitForNextSlot(channel);
      return true;
    }
    queue.next();
    return true;
  }

  let lastPlaybackIssue = { qid: null, at: 0 };
  function handlePlaybackIssue(issue) {
    const current = queue.current();
    if (!current || !issue?.qid || issue.qid !== current.qid) return false;
    const now = Date.now();
    if (lastPlaybackIssue.qid === current.qid && now - lastPlaybackIssue.at < 10000) return false;
    lastPlaybackIssue = { qid: current.qid, at: now };
    const publicCurrent = queue.getPublicState().current || current;
    const logged = playbackIssues.record(issue, publicCurrent, queue.playback);
    console.warn(`播放异常，跳过节目：${publicCurrent.title || current.qid}（${issue.kind || 'unknown'}${issue.detail ? '：' + String(issue.detail).slice(0, 200) : ''}）`);
    handleChannelEnded();
    return !!logged;
  }

  function handleCompatibilityRequest(issue) {
    const current = queue.current();
    if (!current || !issue?.qid || issue.qid !== current.qid) return false;
    const publicCurrent = queue.getPublicState().current || current;
    const media = library.get(publicCurrent.mediaId);
    if (!media) {
      return handlePlaybackIssue({ ...issue, kind: 'compatibility_failed', detail: '片库中找不到源文件' });
    }
    playbackIssues.record({ ...issue, kind: 'compatibility_fallback' }, publicCurrent, queue.playback);
    const entry = compatibility.ensure(media);
    console.warn(`浏览器不支持，开始兼容转换：${publicCurrent.title || current.qid}`);
    return !!entry;
  }

  function selectChannel(id, { tv = false, play = true } = {}) {
    const channel = playlists.get(id);
    if (!channel || (tv && !channel.enabled)) return false;
    playlists.activate(id);
    queue.loadPlaylist(channel.items, { loop: channel.loop });
    channelSlotKey = null;
    onDemandActive = false;
    schedulerHoldingStandby = false;
    if (channel.autoPlay === false) queue.standby({ reason: 'on-demand' });
    else if (scheduledItems(channel).length) applyChannelTimingTick();
    else if (play) queue.play();
    return true;
  }

  function playOnDemand(qid) {
    const channel = playlists.active();
    if (!channel?.enabled || !channel.allowOnDemand || !channel.items.some(i => i.qid === qid)) return false;
    onDemandActive = true;
    return queue.jump(qid);
  }

  function getTvState() {
    return { ...queue.getPublicState(), channels: playlists.tvList(), selectedChannelId: playlists.activeId };
  }

  let frontendMenu = null;
  const frontendMenuModel = () => {
    if (!frontendMenu) return null;
    if (frontendMenu.level === 'programs') {
      const channel = playlists.get(frontendMenu.channelId);
      const items = channel?.items || [];
      frontendMenu.index = Math.max(0, Math.min(frontendMenu.index, Math.max(0, items.length - 1)));
      return { title: `点播 · ${channel?.name || ''}`, index: frontendMenu.index, items: items.map(item => ({ label: item.title })) };
    }
    const channels = playlists.tvList();
    frontendMenu.index = Math.max(0, Math.min(frontendMenu.index, Math.max(0, channels.length - 1)));
    return { title: '切换频道', index: frontendMenu.index, items: channels.map(channel => ({ label: channel.name })) };
  };
  const showFrontendMenu = () => frontendSupervisor.showMenu(frontendMenuModel());
  function handleFrontendInput(action) {
    if (!['up', 'down', 'confirm', 'menu'].includes(action)) return false;
    if (action === 'menu') {
      if (frontendMenu?.level === 'programs') frontendMenu = { level: 'channels', index: 0 };
      else if (frontendMenu) frontendMenu = null;
      else frontendMenu = { level: 'channels', index: Math.max(0, playlists.tvList().findIndex(c => c.id === playlists.activeId)) };
      if (frontendMenu) showFrontendMenu();
      else frontendSupervisor.sync(getTvState());
      return true;
    }
    if (!frontendMenu) return false;
    const model = frontendMenuModel();
    if (!model?.items.length) return false;
    if (action === 'up' || action === 'down') {
      const delta = action === 'up' ? -1 : 1;
      frontendMenu.index = (frontendMenu.index + delta + model.items.length) % model.items.length;
      showFrontendMenu();
      return true;
    }
    if (frontendMenu.level === 'channels') {
      const channel = playlists.tvList()[frontendMenu.index];
      if (!channel) return false;
      if (channel.id === playlists.activeId && channel.allowOnDemand && channel.items?.length) {
        frontendMenu = { level: 'programs', channelId: channel.id, index: 0 };
        showFrontendMenu();
      } else {
        selectChannel(channel.id, { tv: true, play: true });
        frontendMenu = null;
      }
    } else {
      const channel = playlists.get(frontendMenu.channelId);
      const item = channel?.items?.[frontendMenu.index];
      if (channel && channel.id !== playlists.activeId) selectChannel(channel.id, { tv: true, play: false });
      if (item) playOnDemand(item.qid);
      frontendMenu = null;
    }
    return true;
  }

  frontendSupervisor.on('position', event => {
    if (event.qid === queue.current()?.qid) queue.reportPosition(event.position, event.duration);
  });
  frontendSupervisor.on('ended', event => {
    if (!event.qid || event.qid === queue.current()?.qid) handleChannelEnded();
  });
  frontendSupervisor.on('playbackError', handlePlaybackIssue);
  frontendSupervisor.on('input', handleFrontendInput);
  queue.on('change', () => frontendSupervisor.sync(getTvState()));

  /** 切到某节目单并开播（时刻表跃迁用） */
  const switchToPlaylist = (playlistId, loop) => {
    const p = playlists.get(playlistId);
    if (!p) return false;
    if (loop !== undefined) p.loop = !!loop;
    return selectChannel(p.id);
  };

  /** 时刻表跃迁执行器：只在窗口进出时动作，不抢家长的手动操作 */
  const applySchedulerTick = (now = new Date()) => {
    const d = scheduler.tick(now);
    if (d.action === 'switch') {
      if (switchToPlaylist(d.rule.playlistId, d.rule.loop)) {
        scheduler.applied(d.rule.id);
      }
    } else if (d.action === 'standby') {
      schedulerHoldingStandby = true;
      queue.standby({ reason: 'schedule-window' });
      scheduler.applied(null);
    }
    return d;
  };

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    next();
  });

  const isLoopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(address || '').toLowerCase());
  const remoteUrls = port => {
    const urls = [];
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries || []) {
        const family = typeof entry.family === 'string' ? entry.family : (entry.family === 4 ? 'IPv4' : '');
        if (family === 'IPv4' && !entry.internal) urls.push(`http://${entry.address}:${port}/remote/`);
      }
    }
    return [...new Set(urls)].slice(0, 4);
  };

  // 配对码只给本机 kiosk。局域网设备只能提交电视上看到的码，不能读取它。
  app.get('/tv/setup-info', (req, res) => {
    if (!isLoopback(req.socket.remoteAddress)) return res.status(404).end();
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      required: setup.required,
      code: setup.required ? setup.code : null,
      passwordRecovery: setup.required ? null : passwordRecovery.localInfo(),
      remoteUrls: remoteUrls(req.socket.localPort || cfg.port)
    });
  });

  // 播放端与媒体流：局域网专用，不鉴权
  // 非托管（开发/调试）模式给电视页注入环境标记，页面据此解除 kiosk 专属的
  // 锁定交互（隐藏光标、禁右键/双击），恢复普通浏览器的可操作性。
  if (!cfg.manageBrowser) {
    const tvIndexFile = path.join(cfg.rootDir, 'public', 'tv', 'index.html');
    const serveTvIndex = (_req, res) => {
      const html = fs.readFileSync(tvIndexFile, 'utf8').replace('</head>', '<script>window.__SHOWRUNNER_UNMANAGED__=true</script></head>');
      res.setHeader('Cache-Control', 'no-store');
      res.type('html').send(html);
    };
    app.get('/tv', serveTvIndex);
    app.get('/tv/', serveTvIndex);
    app.get('/tv/index.html', serveTvIndex);
  }
  app.use('/tv', express.static(path.join(cfg.rootDir, 'public', 'tv')));
  app.use('/media', mediaRouter(library));
  app.use('/cache', cacheRouter(cache));
  app.use('/compatible', compatibilityRouter(compatibility));

  // 遥控器：静态页 + API
  app.use('/remote', express.static(path.join(cfg.rootDir, 'public', 'remote')));
  const onPasswordChange = hash => savePasswordHash(cfg.configFile || path.join(cfg.rootDir, 'config.json'), hash);
  app.use('/api', apiRouter({ auth, setup, passwordRecovery, library, queue, playlists, collections, scheduler, frontendSupervisor, cache, compatibility, playbackIssues, updater, autostart, siteCollectionImporter, selectChannel, applyChannelTimingTick, onPasswordChange, onDirsChange, onPersist: persist, applySchedulerTick }));

  app.get('/', (req, res) => res.redirect('/remote/'));

  return { app, queue, library, playlists, collections, scheduler, frontendSupervisor, browserctl: frontendSupervisor, auth, setup, store, assetVault, cache, compatibility, updater, autostart, playbackIssues, applySchedulerTick, applyChannelTimingTick, selectChannel, handleChannelEnded, handlePlaybackIssue, handleCompatibilityRequest, handleFrontendInput, playOnDemand, getTvState };
}

async function start(cfg) {
  if (cfg.storageMigration?.required) return startStorageGate(cfg);
  const { app, queue, library, playlists, collections, scheduler, frontendSupervisor, auth, setup, store, cache, compatibility, updater, playbackIssues, applySchedulerTick, applyChannelTimingTick, selectChannel, handleChannelEnded, handlePlaybackIssue, handleCompatibilityRequest, playOnDemand, getTvState } = createApp(cfg);
  const server = http.createServer(app);
  const ws = setupWs(server, {
    auth, queue, getState: getTvState,
    onTvEnded: handleChannelEnded,
    onTvIssue: handlePlaybackIssue,
    onTvCompatibility: handleCompatibilityRequest,
    onTvSelectChannel: id => selectChannel(id, { tv: true, play: true }),
    onTvOnDemand: playOnDemand
  });
  // 启用频道、点播权限等不一定改变队列，也要让电视端立即刷新频道选择器。
  playlists.on('change', () => ws.pushState());

  // 缓存状态变化 / 下载进度 → 推送给电视与遥控器（进度已在 CacheManager 内节流）
  cache.on('change', () => ws.pushState());
  cache.on('change', () => frontendSupervisor.sync(getTvState()));
  cache.on('progress', () => ws.pushState());
  compatibility.on('change', entry => {
    if (entry.status === 'failed') {
      const current = queue.getPublicState().current;
      if (current?.mediaId === entry.mediaId) {
        playbackIssues.record({ kind: 'compatibility_failed', detail: entry.error, qid: current.qid }, current, queue.playback);
      }
    }
    ws.pushState();
  });

  // 播放前端托管启动 + 模式/前端变更广播
  frontendSupervisor.on('change', s => ws.broadcast({ type: 'mode', data: s }));

  // 时刻表：每 15 秒检查一次窗口跃迁（测试可传 cfg.disableScheduler 关闭）
  const schedTimer = cfg.disableScheduler ? null : setInterval(() => applySchedulerTick(), 15000);
  if (schedTimer) schedTimer.unref?.();
  applySchedulerTick(); // 启动即对齐一次（如重启时正处于窗口中）
  const channelTimer = cfg.disableChannelTimer ? null : setInterval(() => applyChannelTimingTick(), 1000);
  if (channelTimer) channelTimer.unref?.();
  applyChannelTimingTick();

  // 跟踪活跃连接，close 时全部销毁，保证进程（和测试）能干净退出
  const sockets = new Set();
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.on('upgrade', (req, s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  await new Promise(resolve => server.listen(cfg.port, cfg.host, resolve));
  const addr = server.address();
  // 先成功占用服务端口，再清理/启动受控浏览器；避免重复服务实例争抢浏览器。
  await frontendSupervisor.start();
  await frontendSupervisor.sync(getTvState());
  if (setup.required && frontendSupervisor.status().frontend === 'mpv') {
    await frontendSupervisor.showMenu({
      title: 'Showrunner 首次设置', index: -1,
      items: [{ label: `电视配对码：${setup.code}` }, { label: `手机访问本机 ${addr.port} 端口完成设置` }]
    });
  }

  return {
    server, app, queue, library, playlists, collections, scheduler, frontendSupervisor, browserctl: frontendSupervisor, auth, store, cache, compatibility, ws, updater, playbackIssues,
    applySchedulerTick, applyChannelTimingTick, selectChannel, playOnDemand, getTvState,
    port: addr.port, host: addr.address,
    close: async () => {
      if (schedTimer) clearInterval(schedTimer);
      if (channelTimer) clearInterval(channelTimer);
      await frontendSupervisor.stop();
      for (const c of ws.wss.clients) c.terminate();
      for (const s of sockets) s.destroy();
      ws.wss.close();
      await new Promise(resolve => server.close(() => resolve()));
    }
  };
}

if (require.main === module) {
  const cfg = loadConfig(path.join(__dirname, '..'));
  // 真实运行默认托管 kiosk 浏览器（config.json 可用 "manageBrowser": false 关闭）
  if (cfg.manageBrowser === undefined) cfg.manageBrowser = true;
  start(cfg).then(({ port, host }) => {
    const shownHost = host === '0.0.0.0' || host === '::' ? '本机IP' : host;
    console.log('');
    console.log(cfg.storageMigration?.required ? '  Showrunner 等待确认数据迁移' : '  Showrunner 放映员已启动');
    console.log(`  电视播放端:  http://localhost:${port}/tv/`);
    console.log(`  手机遥控器:  http://${shownHost}:${port}/remote/`);
    if (cfg.setupRequired && !cfg.storageMigration?.required) console.log('  首次运行：请在电视画面查看配对码，并用手机设置遥控器密码');
    if (cfg.storageMigration?.required) console.log('  检测到旧版内置数据；未经电视确认码确认前不会迁移或播放');
    console.log('');
  });
}

module.exports = { createApp, start };
