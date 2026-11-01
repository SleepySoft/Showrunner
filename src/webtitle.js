'use strict';
/** 兼容入口；实际解析由 src/sources 注册表分派。 */
const { defaultRegistry } = require('./sources');
const { cleanTitle } = require('./sources/common');

async function resolveTitle(url, fetchImpl = fetch, timeoutMs = 8000) {
  return defaultRegistry.resolveTitle(url, { fetchImpl, timeoutMs });
}

module.exports = { resolveTitle, cleanTitle };
