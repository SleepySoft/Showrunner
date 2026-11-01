'use strict';
/** 忘记密码恢复：确认码只显示在本机电视，短时有效且失败次数受限。 */
const crypto = require('crypto');

class PasswordRecovery {
  constructor({ ttlMs = 10 * 60 * 1000, now = () => Date.now(), codeFactory } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.codeFactory = codeFactory || (() => String(crypto.randomInt(0, 1000000)).padStart(6, '0'));
    this.code = null;
    this.expiresAt = 0;
    this.failures = 0;
    this.blockedUntil = 0;
  }

  _expire() {
    if (this.code && this.now() >= this.expiresAt) this.cancel();
  }

  status() {
    this._expire();
    return { active: !!this.code, expiresAt: this.code ? this.expiresAt : null };
  }

  request() {
    this._expire();
    if (this.now() < this.blockedUntil) return { ok: false, blockedUntil: this.blockedUntil };
    if (!this.code) {
      this.code = this.codeFactory();
      this.expiresAt = this.now() + this.ttlMs;
      this.failures = 0;
    }
    return { ok: true, ...this.status() };
  }

  localInfo() {
    const status = this.status();
    return status.active ? { required: true, code: this.code, expiresAt: this.expiresAt } : null;
  }

  verify(value) {
    this._expire();
    if (!this.code) return { ok: false, error: '没有有效的密码重置请求' };
    const supplied = Buffer.from(String(value || ''));
    const expected = Buffer.from(this.code);
    const matches = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
    if (matches) return { ok: true };
    this.failures++;
    if (this.failures >= 5) {
      this.cancel();
      this.blockedUntil = this.now() + 15 * 60 * 1000;
      return { ok: false, error: '确认码错误次数过多，请 15 分钟后重试', blocked: true };
    }
    return { ok: false, error: '电视确认码不正确' };
  }

  cancel() {
    this.code = null;
    this.expiresAt = 0;
    this.failures = 0;
  }
}

function isPrivateAddress(value) {
  let address = String(value || '').toLowerCase();
  if (address.startsWith('::ffff:')) address = address.slice(7);
  if (address === 'localhost' || address === '::1' || address === '127.0.0.1') return true;
  if (/^10\./.test(address) || /^192\.168\./.test(address)) return true;
  const match = /^172\.(\d+)\./.exec(address);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return /^(fc|fd|fe8|fe9|fea|feb)/.test(address);
}

function isDirectPrivateRequest(req) {
  if (req.headers?.forwarded || req.headers?.['x-forwarded-for']) return false;
  const rawHost = String(req.headers?.host || '');
  const host = rawHost.startsWith('[')
    ? rawHost.slice(1, rawHost.indexOf(']'))
    : rawHost.replace(/:\d+$/, '');
  return isPrivateAddress(req.socket?.remoteAddress) && isPrivateAddress(host);
}

module.exports = { PasswordRecovery, isDirectPrivateRequest, isPrivateAddress };
