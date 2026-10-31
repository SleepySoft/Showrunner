'use strict';
/**
 * 鉴权：密码登录换取会话 token（内存保存，重启失效）。
 * /api 与 /remote 需要会话；/tv 与 /media 面向局域网播放端，不鉴权（部署文档禁止公网暴露）。
 */
const crypto = require('crypto');

const COOKIE = 'sr_session';

class Auth {
  constructor(password, ttlHours = 720) {
    this.password = password;
    this.ttlMs = ttlHours * 3600 * 1000;
    this.sessions = new Map(); // token -> expiresAt
  }

  login(password) {
    if (password !== this.password) return null;
    const token = crypto.randomBytes(24).toString('hex');
    this.sessions.set(token, Date.now() + this.ttlMs);
    return token;
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
