'use strict';
/**
 * 网站源统一接口与注册表。
 * 适配器可实现：id、matches(url)、resolveTitle、analyzeCollection、normalizeYtdlpEntry。
 * 专用合集解析返回 null 表示“无法专门处理”，注册表会自动交给通用 yt-dlp 源。
 */
const { bilibiliSource } = require('./bilibili');
const { genericSource } = require('./generic');

class SourceRegistry {
  constructor(sources = [], fallback = genericSource) {
    this.sources = [...sources];
    this.fallback = fallback;
  }

  register(source) {
    if (!source || !source.id || typeof source.matches !== 'function') throw new TypeError('无效的网站源适配器');
    this.sources.push(source);
    return this;
  }

  resolve(url) {
    return this.sources.find(source => {
      try { return source.matches(url); } catch { return false; }
    }) || this.fallback;
  }

  async resolveTitle(url, context = {}) {
    const source = this.resolve(url);
    return (source.resolveTitle || this.fallback.resolveTitle)(url, { ...context, source });
  }

  async analyzeCollection(url, context = {}) {
    const source = this.resolve(url);
    if (source !== this.fallback && source.analyzeCollection) {
      const result = await source.analyzeCollection(url, { ...context, source });
      if (result) return result;
    }
    return this.fallback.analyzeCollection(url, { ...context, source });
  }
}

const defaultRegistry = new SourceRegistry([bilibiliSource]);

module.exports = { SourceRegistry, defaultRegistry, bilibiliSource, genericSource };
