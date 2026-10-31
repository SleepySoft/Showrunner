'use strict';
/**
 * 网页片源标题解析：抓取页面 <title>，剥离站点 SEO 后缀。
 * 策略：按分隔符（- _ | 丨 — · 空格）切段，从尾部逐段丢弃垃圾词段
 * （站点名 / 「高清正版在线观看」类），保留正文标题。
 * 抓取失败时退化为「主机:端口 + 路径」，保证入列永远成功。
 * fetchImpl 可注入，便于测试。
 */

// 段内包含即丢弃（SEO 营销词）
const CRUFT_CONTAINS = /优酷|youku|哔哩哔哩|bilibili|youtube|爱奇艺|iqiyi|腾讯视频|搜狐视频|芒果|在线观看|高清正版|免费观看|独播|首播/i;
// 整段匹配才丢弃（内容分类词，避免误伤「纪录片：地球脉动」这类正常标题）
const CRUFT_EXACT = /^(纪录片|电视剧|电影|综艺|动漫|视频|官方|高清|正版|完整版|全集|HD|4K|1080p|720p)$/i;

function cleanTitle(raw) {
  const parts = String(raw).split(/(\s*[\-_丨|—–·]\s*)/);
  // parts 交替为 [文本, 分隔符, 文本, 分隔符, ...]
  while (parts.length >= 3) {
    const last = parts[parts.length - 1].trim();
    if (CRUFT_CONTAINS.test(last) || CRUFT_EXACT.test(last)) {
      parts.pop(); parts.pop();
    } else break;
  }
  return parts.join('').trim();
}

async function resolveTitle(url, fetchImpl = fetch, timeoutMs = 8000) {
  let fallback;
  try {
    const u = new URL(url);
    fallback = u.host + u.pathname;
  } catch {
    return String(url).slice(0, 80);
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Showrunner/0.1', 'Accept-Language': 'zh-CN,zh' }
    });
    clearTimeout(timer);
    if (!res.ok) return fallback;
    const html = await res.text();
    const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (!m) return fallback;
    const clean = cleanTitle(decodeEntities(m[1]));
    return clean || fallback;
  } catch {
    return fallback;
  }
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .trim();
}

module.exports = { resolveTitle, cleanTitle };
