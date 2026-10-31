// 真实链路冒烟：启动服务（不开 kiosk、隔离数据/缓存）→ 登录 → 建单播出
// → 贴真实 B 站链接 → 等待 yt-dlp 下载 → 校验命名 / 状态字段 / 流式播放
const fs = require('fs');
const path = require('path');
const { start } = require('./src/server');

const TMP = 'C:/D/code/unname/showrunner/.smoke-tmp';
const VIDEO_URL = 'https://www.bilibili.com/video/BV1QqxY6jEPY';

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  const srv = await start({
    rootDir: __dirname,
    host: '127.0.0.1',
    port: 7199,
    password: 'smoke',
    mediaDirs: [],
    dataFile: path.join(TMP, 'data.json'),
    cacheDir: path.join(TMP, 'cache'),
    manageBrowser: false,   // 冒烟不弹浏览器
    sessionTtlHours: 1
  });
  const base = 'http://127.0.0.1:7199';
  console.log('[1] 服务已启动');

  // 登录
  const login = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'smoke' })
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const authed = (p, opts = {}) => fetch(base + p, {
    ...opts,
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie }
  });
  console.log('[2] 登录 OK');

  // 建节目单并播出
  const pl = await (await authed('/api/playlists', { method: 'POST', body: JSON.stringify({ name: '冒烟单' }) })).json();
  await authed(`/api/playlists/${pl.playlist.id}/activate`, { method: 'POST' });
  console.log('[3] 节目单已播出');

  // 贴真实 B 站链接
  const add = await authed(`/api/playlists/${pl.playlist.id}/items`, {
    method: 'POST', body: JSON.stringify({ url: VIDEO_URL })
  });
  const added = (await add.json()).added[0];
  console.log('[4] 网页条目入列:', added.title, '| type =', added.type);

  // 等待缓存完成（最多 150 秒）
  console.log('[5] 等待 yt-dlp 下载…');
  let cacheItem = null;
  const deadline = Date.now() + 150000;
  let lastPct = -1;
  while (Date.now() < deadline) {
    const st = await (await authed('/api/state')).json();
    cacheItem = (st.cache || []).find(c => c.url === VIDEO_URL);
    if (cacheItem && cacheItem.status === 'ready') break;
    if (cacheItem && cacheItem.status === 'failed') {
      console.log('[X] 缓存失败:', cacheItem.error);
      break;
    }
    const pct = cacheItem ? Math.floor(cacheItem.progress || 0) : 0;
    if (pct !== lastPct) { console.log(`    缓存中 ${pct}%`); lastPct = pct; }
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!cacheItem || cacheItem.status !== 'ready') {
    console.log('[X] 缓存未就绪，最终状态:', JSON.stringify(cacheItem));
    process.exitCode = 1;
  } else {
    console.log('[6] 缓存 ready:', cacheItem.title, `(${(cacheItem.bytes / 1e6).toFixed(1)} MB)`);

    // 校验命名规范
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(f =>
      f.isDirectory() ? walk(path.join(d, f.name)) : [path.join(d, f.name)]);
    const files = walk(path.join(TMP, 'cache')).filter(f => !f.endsWith('.json'));
    console.log('[7] 缓存产物:', files.map(f => path.relative(TMP, f)).join(', '));

    // 校验状态装饰
    const st = await (await authed('/api/state')).json();
    const cur = st.state.current;
    console.log('[8] 当前片装饰字段: cacheStatus =', cur.cacheStatus, '| stream =', cur.stream);

    // 校验流式端点（含 Range）
    const full = await fetch(base + cur.stream);
    const part = await fetch(base + cur.stream, { headers: { Range: 'bytes=0-1023' } });
    console.log('[9] 流式: 完整 =', full.status, full.headers.get('content-type'),
      '| Range =', part.status, part.headers.get('content-range'));
    await full.arrayBuffer(); await part.arrayBuffer(); // 排空连接

    // ffmpeg 探针：验证音视频流齐全（B 站是分离流，必须合并成功才可播）
    const { execFileSync } = require('child_process');
    const mp4 = path.join(TMP, 'cache', 'bilibili', '小时候直肠子就这样讲话-BV1QqxY6jEPY.mp4');
    let probe = '';
    try { execFileSync(path.join(__dirname, 'bin', 'ffmpeg.exe'), ['-i', mp4], { encoding: 'utf8', stdio: 'pipe' }); }
    catch (e) { probe = e.stderr || ''; } // ffmpeg -i 总是以非零退出，信息在 stderr
    const streams = probe.split('\n').filter(l => l.includes('Duration') || l.includes('Stream'));
    console.log('[10] 探针:', streams.map(s => s.trim()).join(' | '));

    // ---- 合集链路：建合集 → 装入同一链接 → 抽一集入列 → 跳播验证集数推进 ----
    const col = await (await authed('/api/collections', {
      method: 'POST', body: JSON.stringify({ name: '冒烟合集' })
    })).json();
    const cid = col.collection.id;
    for (let i = 0; i < 2; i++) {
      await authed(`/api/collections/${cid}/items`, {
        method: 'POST', body: JSON.stringify({ url: VIDEO_URL })
      });
    }
    console.log('[11] 合集已建，装入 2 集（同一链接模拟两集）');

    await authed(`/api/playlists/${pl.playlist.id}/items`, {
      method: 'POST', body: JSON.stringify({ collectionId: cid })
    });
    await authed(`/api/playlists/${pl.playlist.id}/items`, {
      method: 'POST', body: JSON.stringify({ collectionId: cid })
    });
    const st2 = await (await authed('/api/state')).json();
    const colItems = st2.queue.filter(q => q.type === 'collection');
    console.log('[12] 合集抽一集 ×2 已入列，队列长度 =', st2.queue.length);

    // 跳到第一个合集条目 → 应抽第 1 集
    await authed('/api/control', { method: 'POST', body: JSON.stringify({ action: 'jump', qid: colItems[0].qid }) });
    let cur2 = (await (await authed('/api/state')).json()).state.current;
    console.log('[13] 第一抽:', cur2.title, '| type =', cur2.type, '| cacheStatus =', cur2.cacheStatus);
    const ok1 = cur2.title.includes('第1集') && cur2.type === 'web';

    // 跳到第二个合集条目 → 应抽第 2 集
    await authed('/api/control', { method: 'POST', body: JSON.stringify({ action: 'jump', qid: colItems[1].qid }) });
    cur2 = (await (await authed('/api/state')).json()).state.current;
    console.log('[14] 第二抽:', cur2.title, '| type =', cur2.type);
    const ok2 = cur2.title.includes('第2集');

    // 合集解析出的 web 条目应能拿到缓存流
    const colStream = await fetch(base + cur2.stream, { headers: { Range: 'bytes=0-99' } });
    console.log('[15] 合集条目流式 Range =', colStream.status);
    await colStream.arrayBuffer();

    // 节目表导出
    const mdRes = await authed('/api/export.md');
    const md = await mdRes.text();
    const hasSections = md.includes('# Showrunner 节目表') && md.includes('冒烟合集') && md.includes('抽一集');
    console.log('[16] 节目表导出:', mdRes.status, hasSections ? '章节齐全' : '【章节缺失】', `(${md.length} 字符)`);

    if (!(ok1 && ok2 && colStream.status === 206 && hasSections)) {
      console.log('[X] 合集链路验证未全部通过');
      process.exitCode = 1;
    }
  }

  await srv.close();
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); }
  catch { console.log('[17] 服务已关闭（临时目录清理被系统占用，可稍后手动删 .smoke-tmp）'); return; }
  console.log('[17] 服务已关闭，临时文件已清理');
}

main().catch(e => { console.error('冒烟异常:', e); process.exit(1); });
