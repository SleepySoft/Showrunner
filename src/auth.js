'use strict';
/**
 * 鉴权：密码登录换取会话 token（内存保存，重启失效）。
 * /api 与 /remote 需要会话；/tv 与 /media 面向局域网播放端，不鉴权（部署文档禁止公网暴露）。
 */
const crypto = require('crypto');

const COOKIE = 'sr_session';

class Auth {
  constructor(password, ttlHours = 720, passwordHash = null) {
    this.password = password;
    this.passwordHash = passwordHash;
    this.ttlMs = ttlHours * 3600 * 1000;
    this.sessions = new Map(); // token -> expiresAt
  }

  login(password) {
    if (!this.isConfigured()) return null;
    if (!this.verifyPassword(password)) return null;
    return this.createSession();
  }

  isConfigured() { return !!(this.passwordHash || this.password); }

  createSession() {
    const token = crypto.randomBytes(24).toString('hex');
    this.sessions.set(token, Date.now() + this.ttlMs);
    return token;
  }

  verifyPassword(password) {
    if (!this.isConfigured()) return false;
    const value = String(password ?? '');
    if (this.passwordHash) {
      const parts = String(this.passwordHash).split('$');
      if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
      try {
        const salt = Buffer.from(parts[1], 'hex');
        const expected = Buffer.from(parts[2], 'hex');
        const actual = crypto.scryptSync(value, salt, expected.length);
        return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
      } catch { return false; }
    }
    const actual = Buffer.from(value);
    const expected = Buffer.from(String(this.password ?? ''));
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  setPasswordHash(hash) {
    this.password = null;
    this.passwordHash = hash;
    this.sessions.clear(); // 改密后所有旧设备必须重新登录
  }

  static hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const derived = crypto.scryptSync(String(password), salt, 32);
    return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
  }

  logout(token) {
    this.sessions.delete(token);
  }

  valid(token) {
    if (!token) return false;
    const exp = this.sessions.get(token);
    if (!exp) return false;
    if (Date.now() > exp) { this.sessions.delete(token); return false; }
    return true;
  }

  static tokenFromReq(req) {
    const header = req.headers.cookie || '';
    const m = header.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([a-f0-9]+)'));
    return m ? m[1] : (req.query.token || null);
  }

  /** Express 中间件：保护 /api */
  middleware() {
    return (req, res, next) => {
      if (this.valid(Auth.tokenFromReq(req))) return next();
      res.status(401).json({ error: 'unauthorized' });
    };
  }
}

module.exports = { Auth, COOKIE };
