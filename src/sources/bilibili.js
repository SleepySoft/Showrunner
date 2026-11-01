'use strict';
/** B 站源：UGC 合集/分 P 反查，以及旧版 yt-dlp flat 元数据 URL 修补。 */
const { parseUrl, entryLimit } = require('./common');

function matches(url) {
  const parsed = typeof url === 'string' ? parseUrl(url) : url;
  return !!parsed && /(^|\.)bilibili\.com$/i.test(parsed.hostname);
}

async function analyzeCollection(url, { fetchImpl = fetch, timeoutMs = 15000, maxEntries = 500 } = {}) {
  const parsed = parseUrl(url);
  if (!matches(parsed)) return null;
  const bvid = parsed.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1];
  if (!bvid) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 showrunner', 'Referer': 'https://www.bilibili.com/' },
      signal: controller.signal
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (body?.code !== 0 || !body.data) return null;
    const data = body.data;
    const limit = entryLimit(maxEntries);
    const episodes = (data.ugc_season?.sections || []).flatMap(section => section.episodes || []);
    if (episodes.length) {
      const entries = episodes.slice(0, limit).flatMap((episode, index) => {
        const id = episode.bvid || episode.arc?.bvid;
        return id ? [{
          title: String(episode.title || episode.arc?.title || `第 ${index + 1} 集`).trim(),
          url: `https://www.bilibili.com/video/${id}/`
        }] : [];
      });
      if (entries.length) return {
        ok: true,
        title: String(data.ugc_season.title || data.title || 'B站合集').trim(),
        entries,
        truncated: episodes.length > limit
      };
    }

    const pages = Array.isArray(data.pages) ? data.pages : [];
    if (pages.length > 1) return {
      ok: true,
      title: String(data.title || 'B站分P视频').trim(),
      entries: pages.slice(0, limit).map((page, index) => ({
        title: String(page.part || `第 ${index + 1} P`).trim(),
        url: `https://www.bilibili.com/video/${bvid}/?p=${index + 1}`
      })),
      truncated: pages.length > limit
    };
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeYtdlpEntry({ itemUrl, root, rawEntries, sourceUrl, index }) {
  if (itemUrl || rawEntries.length <= 1 || !/bili/i.test(String(root.extractor_key || root.extractor || ''))) return null;
  const parsed = parseUrl(sourceUrl);
  if (!parsed) return null;
  parsed.searchParams.set('p', String(index + 1));
  return { url: parsed.toString() };
}

const bilibiliSource = {
  id: 'bilibili',
  displayName: '哔哩哔哩',
  matches,
  analyzeCollection,
  normalizeYtdlpEntry
};

module.exports = { bilibiliSource, analyzeCollection };
