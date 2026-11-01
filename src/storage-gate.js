'use strict';
/** 用户确认式存储迁移门禁：不加载业务状态，只提供电视提示和迁移确认页。 */
const http = require('http');
const path = require('path');
const os = require('os');
const express = require('express');
const { spawn } = require('child_process');
const { confirmStorage } = require('./storage-layout');
const { BrowserController } = require('./browserctl');

function isLoopback(address) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(address || '').toLowerCase());
}

function remoteUrls(port) {
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      const family = typeof entry.family === 'string' ? entry.family : (entry.family === 4 ? 'IPv4' : '');
      if (family === 'IPv4' && !entry.internal) urls.push(`http://${entry.address}:${port}/remote/`);
    }
  }
  return [...new Set(urls)].slice(0, 4);
}

function publicStatus(plan) {
  return {
    required: true,
    conflict: !!plan.conflict,
    legacy: { directoryName: path.basename(plan.rootDir), files: plan.legacy.files, bytes: plan.legacy.bytes },
    target: { directoryName: path.basename(plan.dataDir), files: plan.target.files, bytes: plan.target.bytes }
  };
}

async function startStorageGate(cfg) {
  const plan = cfg.storageMigration;
  if (!plan?.required) throw new Error('没有待确认的存储迁移');
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    next();
  });
  app.use(express.json({ limit: '16kb' }));

  app.get('/tv/setup-info', (req, res) => {
    if (!isLoopback(req.socket.remoteAddress)) return res.status(404).end();
    res.json({
      required: false,
      storageMigration: { ...publicStatus(plan), code: plan.code },
      remoteUrls: remoteUrls(req.socket.localPort || cfg.port)
    });
  });
  app.get('/api/storage/status', (_req, res) => res.json(publicStatus(plan)));

  let decided = false;
  let failures = 0;
  let shutdownTimer = null;
  app.post('/api/storage/confirm', (req, res) => {
    if (decided) return res.status(409).json({ error: '已经提交迁移决定，请等待程序重启' });
    if (failures >= 5) return res.status(429).json({ error: '确认码错误次数过多，请重启程序后再试' });
    if (String(req.body?.code || '') !== String(plan.code)) {
      failures++;
      return res.status(403).json({ error: '电视确认码不正确' });
    }
    const action = String(req.body?.action || '');
    if (action === 'fresh' && req.body?.confirmFresh !== true) {
      return res.status(400).json({ error: '创建全新数据目录需要二次确认' });
    }
    if (!['migrate', 'use-target', 'fresh', 'postpone'].includes(action)) {
      return res.status(400).json({ error: '未知迁移操作' });
    }
    try {
      const result = action === 'postpone' ? { action, dataDir: null, backupDir: null } : confirmStorage(plan, action);
      decided = true;
      res.json({ ok: true, action, restarting: action !== 'postpone', backupCreated: !!result.backupDir });
      shutdownTimer = setTimeout(() => finish(result), 600);
      shutdownTimer.unref?.();
    } catch (error) {
      res.status(500).json({ error: `迁移失败，旧数据未删除：${error.message}` });
    }
  });

  app.use('/tv', express.static(path.join(cfg.rootDir, 'public', 'tv')));
  app.use('/remote', express.static(path.join(cfg.rootDir, 'public', 'remote')));
  app.get('/', (_req, res) => res.redirect('/remote/'));

  const server = http.createServer(app);
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(cfg.port, cfg.host, resolve));
  const addr = server.address();
  const browserctl = new BrowserController({
    tvUrl: `http://localhost:${addr.port}/tv/`, chromePath: cfg.chromePath, manage: !!cfg.manageBrowser
  });
  await browserctl.start();

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    if (shutdownTimer) clearTimeout(shutdownTimer);
    await browserctl.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(() => resolve()));
  }

  async function finish(result) {
    await close();
    if (cfg.storageDecisionImpl) return cfg.storageDecisionImpl(result);
    if (result.action === 'postpone') return process.exit(0);
    const child = spawn(process.execPath, process.argv.slice(1), {
      cwd: cfg.rootDir, detached: true, stdio: 'ignore', windowsHide: true
    });
    child.unref?.();
    process.exit(0);
  }

  return {
    server, app, browserctl, migrationPending: true,
    port: addr.port, host: addr.address, close
  };
}

module.exports = { startStorageGate, publicStatus };
