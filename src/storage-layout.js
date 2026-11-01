'use strict';
/**
 * 程序与用户数据分离：默认把数据放在安装目录同级的 <目录名>-data。
 * 发现旧版内置数据时只生成迁移计划；真正复制必须由用户输入电视确认码后触发。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LAYOUT_VERSION = 1;
const LOCATION_FIELDS = ['dataFile', 'cacheDir', 'compatibilityCacheDir', 'assetVaultDir', 'playbackIssueLog'];

function defaultDataDir(rootDir) {
  const root = path.resolve(rootDir);
  return path.join(path.dirname(root), `${path.basename(root)}-data`);
}

function exists(file) { try { return fs.existsSync(file); } catch { return false; } }

function treeStats(target) {
  const result = { files: 0, bytes: 0 };
  if (!exists(target)) return result;
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory()) return { files: 1, bytes: stat.size };
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const child = treeStats(path.join(target, entry.name));
    result.files += child.files;
    result.bytes += child.bytes;
  }
  return result;
}

function storageStats(base, legacy = false) {
  const config = path.join(base, 'config.json');
  const data = path.join(base, 'data');
  const cache = path.join(base, 'cache');
  const parts = [treeStats(config), treeStats(data), treeStats(cache)];
  const files = parts.reduce((n, p) => n + p.files, 0);
  const bytes = parts.reduce((n, p) => n + p.bytes, 0);
  return { base, config, data, cache, files, bytes, exists: files > 0, legacy };
}

function readMarker(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'storage-layout.json'), 'utf8')); }
  catch { return null; }
}

function inspectStorage(rootDir, dataDir = defaultDataDir(rootDir)) {
  const legacy = storageStats(path.resolve(rootDir), true);
  const target = storageStats(path.resolve(dataDir), false);
  const marker = readMarker(dataDir);
  const accepted = Number(marker?.layoutVersion || 0) === LAYOUT_VERSION;
  return {
    required: legacy.exists && !accepted,
    conflict: legacy.exists && target.exists && !accepted,
    rootDir: path.resolve(rootDir), dataDir: path.resolve(dataDir),
    legacy, target, marker
  };
}

function isInside(file, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function sanitizedLegacyConfig(plan) {
  if (!exists(plan.legacy.config)) return null;
  const config = JSON.parse(fs.readFileSync(plan.legacy.config, 'utf8').replace(/^\uFEFF/, ''));
  for (const key of LOCATION_FIELDS) {
    if (config[key] && isInside(config[key], plan.rootDir)) delete config[key];
  }
  return config;
}

function validateJsonIfPresent(file, label) {
  if (!exists(file)) return;
  try { JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { throw new Error(`${label}无法解析：${error.message}`); }
}

function validateStaged(dir) {
  validateJsonIfPresent(path.join(dir, 'config.json'), '配置文件');
  const state = path.join(dir, 'data', 'showrunner.json');
  if (exists(state)) {
    try { validateJsonIfPresent(state, '状态文件'); }
    catch (error) {
      const backup = state + '.bak';
      if (!exists(backup)) throw error;
      validateJsonIfPresent(backup, '状态备份');
    }
  }
}

function writeMarker(dir, action, plan) {
  fs.mkdirSync(dir, { recursive: true });
  const marker = {
    layoutVersion: LAYOUT_VERSION,
    acceptedAt: new Date().toISOString(),
    action,
    legacyDirectoryName: path.basename(plan.rootDir)
  };
  const file = path.join(dir, 'storage-layout.json');
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(marker, null, 2));
  fs.renameSync(tmp, file);
  return marker;
}

function copyLegacy(plan, staging) {
  fs.mkdirSync(staging, { recursive: true });
  const config = sanitizedLegacyConfig(plan);
  if (config) fs.writeFileSync(path.join(staging, 'config.json'), JSON.stringify(config, null, 2));
  if (exists(plan.legacy.data)) fs.cpSync(plan.legacy.data, path.join(staging, 'data'), { recursive: true, errorOnExist: true });
  if (exists(plan.legacy.cache)) fs.cpSync(plan.legacy.cache, path.join(staging, 'cache'), { recursive: true, errorOnExist: true });
  validateStaged(staging);
  const source = {
    files: treeStats(plan.legacy.data).files + treeStats(plan.legacy.cache).files + (config ? 1 : 0),
    bytes: treeStats(plan.legacy.data).bytes + treeStats(plan.legacy.cache).bytes
      + (config ? Buffer.byteLength(JSON.stringify(config, null, 2)) : 0)
  };
  const copied = storageStats(staging);
  if (source.files !== copied.files || source.bytes !== copied.bytes) {
    throw new Error(`迁移校验失败：源 ${source.files} 个文件/${source.bytes} 字节，目标 ${copied.files} 个文件/${copied.bytes} 字节`);
  }
}

function backupName(dataDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${dataDir}.before-migration-${stamp}`;
}

function confirmStorage(plan, action) {
  if (!plan?.required) throw new Error('当前没有待确认的存储迁移');
  if (!['migrate', 'use-target', 'fresh'].includes(action)) throw new Error('未知迁移操作');
  const target = plan.dataDir;
  if (action === 'use-target') {
    if (!plan.target.exists) throw new Error('同级数据目录不存在，不能选择使用它');
    validateStaged(target);
    const marker = writeMarker(target, action, plan);
    return { action, dataDir: target, marker, backupDir: null };
  }

  const staging = `${target}.migration-staging-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  let backupDir = null;
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    if (action === 'migrate') copyLegacy(plan, staging);
    else fs.mkdirSync(staging, { recursive: true });
    writeMarker(staging, action, plan);

    if (exists(target) && !plan.target.exists) fs.rmSync(target, { recursive: true, force: true });
    if (exists(target)) {
      backupDir = backupName(target);
      fs.renameSync(target, backupDir);
    }
    fs.renameSync(staging, target);
    return { action, dataDir: target, marker: readMarker(target), backupDir };
  } catch (error) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    if (backupDir && !exists(target) && exists(backupDir)) {
      try { fs.renameSync(backupDir, target); } catch {}
    }
    throw error;
  }
}

module.exports = {
  LAYOUT_VERSION, defaultDataDir, inspectStorage, confirmStorage, storageStats, treeStats, readMarker
};
