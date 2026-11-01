'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { AutostartManager } = require('../src/autostart');

function fakeExec(initial = false) {
  let enabled = initial;
  const calls = [];
  const impl = (file, args, opts, cb) => {
    calls.push({ file, args });
    if (args[0] === '/Query') return enabled ? cb(null, 'TaskName: Showrunner', '') : cb(Object.assign(new Error('not found'), { code: 1 }), '', 'not found');
    if (args[0] === '/Create') { enabled = true; return cb(null, 'SUCCESS', ''); }
    if (args[0] === '/Delete') { enabled = false; return cb(null, 'SUCCESS', ''); }
    cb(new Error('unexpected'));
  };
  return { impl, calls, get enabled() { return enabled; } };
}

test('查询、启用和停用 Windows 开机启动', async () => {
  const f = fakeExec(false);
  const a = new AutostartManager({ rootDir: 'C:\\showrunner', execFileImpl: f.impl, platform: 'win32' });
  assert.deepEqual(await a.status(), { supported: true, enabled: false });
  assert.equal((await a.setEnabled(true)).enabled, true);
  assert.equal(f.enabled, true);
  const create = f.calls.find(c => c.args[0] === '/Create');
  const command = create.args[create.args.indexOf('/TR') + 1];
  assert.match(command, /runtime\\node\\node\.exe/);
  assert.match(command, /src\\server\.js/);
  assert.doesNotMatch(command, /wscript|\.vbs/i);
  assert.equal((await a.setEnabled(false)).enabled, false);
  assert.equal(f.enabled, false);
});

test('非 Windows 平台明确返回不支持', async () => {
  const a = new AutostartManager({ rootDir: '/tmp/showrunner', platform: 'linux' });
  assert.deepEqual(await a.status(), { supported: false, enabled: false });
  assert.equal((await a.setEnabled(true)).supported, false);
});

test('手动自启脚本用纯 ASCII bat 调用 PowerShell，任务仍直接运行 Node', () => {
  const scripts = path.join(__dirname, '..', 'scripts');
  for (const name of ['autostart-on.bat', 'autostart-off.bat']) {
    const content = fs.readFileSync(path.join(scripts, name));
    assert.ok([...content].every(byte => byte < 128), `${name} 必须保持纯 ASCII`);
    assert.match(content.toString('ascii'), /powershell\.exe .*autostart\.ps1/i);
  }
  const ps1 = fs.readFileSync(path.join(scripts, 'autostart.ps1'), 'utf8');
  assert.match(ps1, /runtime\\node\\node\.exe/);
  assert.match(ps1, /schtasks\.exe \/Create/);
  assert.doesNotMatch(ps1, /wscript|\.vbs/i);
});
