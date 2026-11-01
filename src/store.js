'use strict';
/**
 * JSON 持久化存储：读入整个状态文件，写盘采用「临时文件 + rename」原子替换，
 * 避免写到一半断电导致文件损坏。家庭队列场景下数据量很小，全量读写足够。
 */
const fs = require('fs');
const path = require('path');

class Store {
  constructor(file) {
    this.file = file;
    this.data = null;
    this.loadStatus = 'not-loaded';
  }

  load(defaults) {
    if (!fs.existsSync(this.file)) {
      this.data = JSON.parse(JSON.stringify(defaults));
      this.loadStatus = 'missing';
      return this.data;
    }

    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.loadStatus = 'loaded';
    } catch (error) {
      const backup = this.file + '.bak';
      let recovered = null;
      try { recovered = JSON.parse(fs.readFileSync(backup, 'utf8')); } catch {}
      if (!recovered) {
        this.loadStatus = 'corrupt';
        const quarantined = `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        fs.renameSync(this.file, quarantined);
        const failure = new Error(`状态文件损坏，且没有可用实时备份：${this.file}（${error.message}）`);
        failure.code = 'STORE_CORRUPT';
        failure.quarantined = quarantined;
        throw failure;
      }

      const quarantined = `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.renameSync(this.file, quarantined);
      this.data = recovered;
      this.loadStatus = 'recovered';
      this.save(recovered, { skipBackup: true });
      console.warn(`状态文件损坏，已从备份恢复；损坏文件保留在：${quarantined}`);
    }
    return this.data;
  }

  save(data, { skipBackup = false } = {}) {
    this.data = data;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!skipBackup && fs.existsSync(this.file)) {
      fs.copyFileSync(this.file, this.file + '.bak');
    }
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
