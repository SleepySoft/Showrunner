'use strict';
/** 网站源适配器共享工具：URL、标题清洗、HTML 标题抓取和数量限制。 */

const CRUFT_CONTAINS = /优酷|youku|哔哩哔哩|bilibili|youtube|爱奇艺|iqiyi|腾讯视频|搜狐视频|芒果|在线观看|高清正版|免费观看|独播|首播/i;
const CRUFT_EXACT = /^(纪录片|电视剧|电影|综艺|动漫|视频|官方|高清|正版|完整版|全集|HD|4K|1080p|720p)$/i;

function parseUrl(value) {
  try { return new URL(value); } catch { return null; }
}

function fallbackTitle(value) {
  const url = parseUrl(value);
  return url ? url.host + url.pathname : String(value).slice(0, 80);
}

function decodeEntities(value) {
  return String(value)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .trim();
}

function cleanTitle(raw) {
  const parts = String(raw).split(/(\s*[\-_丨|—–·]\s*)/);
  while (parts.length >= 3) {
    const last = parts[parts.length - 1].trim();
    if (CRUFT_CONTAINS.test(last) || CRUFT_EXACT.test(last)) { parts.pop(); parts.pop(); }
    else break;
  }
  return parts.join('').trim();
}

async function resolvePageTitle(url, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const fallback = fallbackTitle(url);
  if (!parseUrl(url)) return fallback;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Showrunner/0.1', 'Accept-Language': 'zh-CN,zh' }
    });
    if (!res.ok) return fallback;
    const html = await res.text();
    const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (!match) return fallback;
    return cleanTitle(decodeEntities(match[1])) || fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

function entryLimit(value, fallback = 500) {
  return Math.max(1, Math.min(Number(value) || fallback, 2000));
}

module.exports = { parseUrl, fallbackTitle, decodeEntities, cleanTitle, resolvePageTitle, entryLimit };
