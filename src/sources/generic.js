'use strict';
/** 公共网站源：HTML 标题 + yt-dlp 播放列表兜底。 */
const { resolvePageTitle } = require('./common');

const genericSource = {
  id: 'generic',
  displayName: '通用网站',
  matches: () => true,
  resolveTitle: (url, context) => resolvePageTitle(url, context),
  analyzeCollection(url, context) {
    return context.fetchCollectionViaYtdlp(context.ytdlp, url, {
      ...context,
      normalizeEntry: payload => context.source?.normalizeYtdlpEntry?.(payload) || null
    });
  }
};

module.exports = { genericSource };
