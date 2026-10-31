'use strict';
/**
 * 播出时刻表：电视台式的「什么时段播什么节目单」。
 *
 * 规则：{ id, playlistId, days: [1,2,3,4,5]（0=周日）, start: '18:00', end: '20:00', loop }
 * 语义：
 *  - 进入窗口：切到指定节目单并开播（loop 则循环播出）
 *  - 离开窗口：停播待机
 *  - 只在「状态跃迁」时动作（transition-only）——窗口内家长手动切了别的，调度器不抢回来；
 *    重启、规则编辑后若正处于窗口中，会补一次对齐。
 *
 * decide(rules, now, last) 是纯函数，便于测试注入时钟。
 */
const crypto = require('crypto');

function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function fmtHM(min) {
  return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
}

/** now 时刻命中的规则（不跨午夜；多条命中时取列表中靠前的） */
function matchRule(rules, now) {
  const day = now.getDay();
  const mins = now.getHours() * 60 + now.getMinutes();
  for (const r of rules) {
    if (!r.days.includes(day)) continue;
    const s = parseHM(r.start), e = parseHM(r.end);
    if (s === null || e === null || e <= s) continue;
    if (mins >= s && mins < e) return r;
  }
  return null;
}

/**
 * 决定该做什么。
 * @returns { action: 'switch', rule } | { action: 'standby' } | { action: 'none' }
 */
function decide(rules, now, last) {
  const rule = matchRule(rules, now);
  if (rule) {
    // 同一条规则已在生效 → 不动（家长手动干预不被抢回）
    if (last && last.ruleId === rule.id) return { action: 'none', rule };
    return { action: 'switch', rule };
  }
  // 无命中规则：之前在窗口内 → 离开窗口，待机；本来就没有 → 不动
  if (last && last.ruleId) return { action: 'standby' };
  return { action: 'none' };
}

class Scheduler {
  constructor(persisted) {
    const s = persisted?.settings?.schedules;
    this.rules = Array.isArray(s) ? s : [];
    this.last = null; // { ruleId } 上次对齐的规则
  }

  serialize() { return this.rules; }

  list() { return this.rules.map(r => ({ ...r })); }

  add({ playlistId, days, start, end, loop }) {
    const s = parseHM(start), e = parseHM(end);
    if (!playlistId) return { error: '缺少 playlistId' };
    if (!Array.isArray(days) || !days.length || days.some(d => d < 0 || d > 6)) return { error: 'days 需要是 0-6 的非空数组' };
    if (s === null || e === null || e <= s) return { error: '时间段非法（需 HH:MM 且结束晚于开始，不跨午夜）' };
    const rule = {
      id: crypto.randomUUID(),
      playlistId: String(playlistId),
      days: [...new Set(days.map(Number))].sort(),
      start: fmtHM(s), end: fmtHM(e),
      loop: !!loop
    };
    this.rules.push(rule);
    return { rule };
  }

  remove(id) {
    const i = this.rules.findIndex(r => r.id === id);
    if (i === -1) return false;
    this.rules.splice(i, 1);
    // 注意：刻意保留 this.last——若删掉的正是生效中的规则，
    // 下个 tick 无命中 + last 仍在 → decide 给出 standby，播出停掉归位
    return true;
  }

  /** 每个 tick 调用。返回决定（调用方执行后应回传 applied） */
  tick(now = new Date()) {
    return decide(this.rules, now, this.last);
  }

  /** 调用方执行完决定后记录，防止同窗口内重复动作 */
  applied(ruleId) {
    this.last = ruleId ? { ruleId } : null;
  }
}

module.exports = { Scheduler, matchRule, decide, parseHM };
