'use strict';
/**
 * WebSocket 层：
 *  - /ws-tv      电视播放端：接收状态推送；上报 position / ended（局域网专用）
 *  - /ws-remote  手机遥控器：接收状态推送（需会话 token，可经反代公网开放）
 *  - /ws?role=…  兼容旧版；公网反代必须屏蔽
 * 电视上报 'ended' 时服务端自动推进队列，实现无人值守连播。
 */
const { WebSocketServer } = require('ws');
const { Auth } = require('./auth');

function setupWs(server, { auth, queue, getState, onTvEnded, onTvIssue, onTvSelectChannel, onTvOnDemand, onBroadcast }) {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();

  function broadcast(payload) {
    const msg = JSON.stringify(payload);
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(msg);
    }
    if (onBroadcast) onBroadcast(payload);
  }

  function pushState() {
    broadcast({ type: 'state', data: getState ? getState() : queue.getPublicState() });
  }

  queue.on('change', pushState);

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    let role = null;
    if (url.pathname === '/ws-tv') role = 'tv';
    else if (url.pathname === '/ws-remote') role = 'remote';
    else if (url.pathname === '/ws') role = url.searchParams.get('role') === 'tv' ? 'tv' : 'remote';
    if (!role) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req, role));
  });

  wss.on('connection', (ws, req, role) => {
    const url = new URL(req.url, 'http://localhost');

    // 浏览器优先使用 HttpOnly 会话 Cookie，避免 token 出现在反代访问日志；query token 仅兼容旧客户端。
    const token = Auth.tokenFromReq({ headers: req.headers, query: Object.fromEntries(url.searchParams) });
    if (role === 'remote' && !auth.valid(token)) {
      ws.close(4401, 'unauthorized');
      return;
    }

    ws._role = role;
    clients.add(ws);

    // 新连接立即下发当前状态
    ws.send(JSON.stringify({ type: 'state', data: getState ? getState() : queue.getPublicState() }));

    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (ws._role !== 'tv') return; // 只有电视端的上报被采信

      if (msg.type === 'position') {
        queue.reportPosition(msg.position, msg.duration); // 高频，不广播
      } else if (msg.type === 'ended') {
        if (!msg.qid || msg.qid === queue.current()?.qid) {
          onTvEnded ? onTvEnded(msg) : queue.next();
        }
      } else if (msg.type === 'playbackIssue' && onTvIssue) {
        if (msg.qid && msg.qid === queue.current()?.qid) onTvIssue(msg);
      } else if (msg.type === 'selectChannel' && onTvSelectChannel) {
        onTvSelectChannel(String(msg.channelId || ''));
      } else if (msg.type === 'onDemand' && onTvOnDemand) {
        onTvOnDemand(String(msg.qid || ''));
      }
    });

    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  return { wss, broadcast, pushState, clients };
}

module.exports = { setupWs };
