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
  }

  load(defaults) {
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = JSON.parse(JSON.stringify(defaults));
    }
    return this.data;
  }

  save(data) {
    this.data = data;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
