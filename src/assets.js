'use strict';
/**
 * 频道、合集与时刻表是用户创作的长期资产。
 * 本模块定义独立于运行状态的可移植格式，并将每次实质变更镜像到滚动保险库。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FORMAT = 'showrunner-assets';
const SCHEMA_VERSION = 1;

const clone = value => JSON.parse(JSON.stringify(value));

function cleanItem(item) {
  const result = clone(item);
  // 合集条目的当前解析结果属于播放运行态，不应固化到可分享资产中。
  delete result.resolved;
  delete result.resolvedError;
  return result;
}

function createAssetDocument(state, exportedAt = new Date().toISOString()) {
  return {
    format: FORMAT,
    schemaVersion: SCHEMA_VERSION,
    exportedAt,
    activeId: state.activeId || null,
    playlists: (state.playlists || []).map(p => ({ ...clone(p), items: (p.items || []).map(cleanItem) })),
    collections: (state.collections || []).map(c => {
      const result = { ...clone(c), items: (c.items || []).map(cleanItem) };
      delete result.randomPool;
      return result;
    }),
    schedules: clone(state.settings?.schedules || state.schedules || [])
  };
}

function validateAssetDocument(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('资产文件不是 JSON 对象');
  if (input.format !== FORMAT) throw new Error('不是 Showrunner 资产文件');
  if (input.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`不支持的资产版本 ${input.schemaVersion}，当前支持 ${SCHEMA_VERSION}`);
  }
  if (!Array.isArray(input.playlists) || !Array.isArray(input.collections) || !Array.isArray(input.schedules)) {
    throw new Error('资产文件缺少频道、合集或时刻表数组');
  }
  if (input.playlists.length > 500 || input.collections.length > 5000 || input.schedules.length > 5000) {
    throw new Error('资产文件规模超过安全限制');
  }
  const assertUniqueIds = (items, label) => {
    const ids = new Set();
    for (const item of items) {
      if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id)) throw new Error(`${label} ID 缺失或重复`);
      ids.add(item.id);
      if (Array.isArray(item.items) && item.items.length > 100000) throw new Error(`${label}条目过多`);
    }
    return ids;
  };
  const playlistIds = assertUniqueIds(input.playlists, '频道');
  const collectionIds = assertUniqueIds(input.collections, '合集');
  let totalItems = 0;
  const assertItems = (items, label) => {
    const qids = new Set();
    for (const item of items) {
      totalItems++;
      if (!item || typeof item.qid !== 'string' || !item.qid || qids.has(item.qid)) throw new Error(`${label}节目 ID 缺失或重复`);
      qids.add(item.qid);
      if (!['local', 'web', 'collection'].includes(item.type)) throw new Error(`${label}包含未知节目类型`);
    }
  };
  for (const channel of input.playlists) {
    if (!Array.isArray(channel.items)) throw new Error('频道 items 不是数组');
    assertItems(channel.items, '频道');
    for (const item of channel.items) {
      if (item?.type === 'collection' && !collectionIds.has(item.collectionId)) throw new Error('频道引用了资产中不存在的合集');
    }
  }
  for (const collection of input.collections) {
    if (!Array.isArray(collection.items)) throw new Error('合集 items 不是数组');
    assertItems(collection.items, '合集');
    if (collection.items.some(item => item.type === 'collection')) throw new Error('合集不能嵌套合集');
  }
  if (totalItems > 100000) throw new Error('资产文件节目总数超过安全限制');
  const scheduleIds = new Set();
  for (const rule of input.schedules) {
    if (!rule || typeof rule.id !== 'string' || !rule.id || scheduleIds.has(rule.id)) throw new Error('时刻表 ID 缺失或重复');
    scheduleIds.add(rule.id);
    if (!playlistIds.has(rule.playlistId)) throw new Error('时刻表引用了资产中不存在的频道');
  }
  return clone(input);
}

function contentHash(document) {
  const content = clone(document);
  delete content.exportedAt;
  return crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

class AssetVault {
  constructor({ dataFile, externalDir = null, maxHistory = 30 } = {}) {
    this.dirs = [path.join(path.dirname(dataFile), 'asset-backups')];
    if (externalDir && path.resolve(externalDir) !== path.resolve(this.dirs[0])) this.dirs.push(externalDir);
    this.maxHistory = maxHistory;
    this.lastHash = null;
  }

  capture(state) {
    const document = createAssetDocument(state);
    const hash = contentHash(document);
    if (hash === this.lastHash) return false;
    for (const dir of this.dirs) this.#writeVault(dir, document, hash);
    this.lastHash = hash;
    return true;
  }

  #writeVault(dir, document, hash) {
    const current = path.join(dir, 'current.showrunner.json');
    if (fs.existsSync(current)) {
      try {
        const previous = validateAssetDocument(JSON.parse(fs.readFileSync(current, 'utf8')));
        const previousHash = contentHash(previous);
        if (previousHash === hash) return;
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        atomicWrite(path.join(dir, 'history', `${stamp}-${previousHash.slice(0, 8)}.showrunner.json`), previous);
      } catch {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
        fs.copyFileSync(current, path.join(dir, 'history', `${stamp}-corrupt.showrunner.json`));
      }
    }
    atomicWrite(current, document);
    const historyDir = path.join(dir, 'history');
    if (!fs.existsSync(historyDir)) return;
    const files = fs.readdirSync(historyDir).filter(f => f.endsWith('.showrunner.json')).sort().reverse();
    for (const old of files.slice(this.maxHistory)) fs.unlinkSync(path.join(historyDir, old));
  }

  loadCurrent() {
    for (const dir of [...this.dirs].reverse()) {
      try {
        const document = validateAssetDocument(JSON.parse(fs.readFileSync(path.join(dir, 'current.showrunner.json'), 'utf8')));
        this.lastHash = contentHash(document);
        return document;
      } catch {}
    }
    return null;
  }
}

module.exports = { FORMAT, SCHEMA_VERSION, createAssetDocument, validateAssetDocument, contentHash, AssetVault };
