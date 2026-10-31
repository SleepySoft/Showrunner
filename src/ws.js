'use strict';
/**
 * WebSocket 层：
 *  - role=tv     电视播放端：接收状态推送；上报 position / ended
 *  - role=remote 手机遥控器：接收状态推送（需会话 token）
 * 电视上报 'ended' 时服务端自动推进队列，实现无人值守连播。
 */
const { WebSocketServer } = require('ws');

function setupWs(server, { auth, queue, onBroadcast }) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Set();

  function broadcast(payload) {
    const msg = JSON.stringify(payload);
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(msg);
    }
    if (onBroadcast) onBroadcast(payload);
  }

  function pushState() {
    broadcast({ type: 'state', data: queue.getPublicState() });
  }

  queue.on('change', pushState);

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const role = url.searchParams.get('role') === 'tv' ? 'tv' : 'remote';

    if (role === 'remote' && !auth.valid(url.searchParams.get('token'))) {
      ws.close(4401, 'unauthorized');
      return;
    }

    ws._role = role;
    clients.add(ws);

    // 新连接立即下发当前状态
    ws.send(JSON.stringify({ type: 'state', data: queue.getPublicState() }));

    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (ws._role !== 'tv') return; // 只有电视端的上报被采信

      if (msg.type === 'position') {
        queue.reportPosition(msg.position, msg.duration); // 高频，不广播
      } else if (msg.type === 'ended') {
        queue.next(); // 自动连播；到队尾自动进入待机
      }
    });

    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  return { wss, broadcast, pushState, clients };
}

module.exports = { setupWs };
