'use strict';
const crypto = require('node:crypto');
const { HttpError, b64u, unb64u, parseCookies, serializeCookie, firstHeader } = require('./util');

const COOKIE = 'arr_session';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const RENEW_AFTER_SEC = 24 * 3600;

// A session id: random, and kept when the cookie is renewed, so a sign-out ends every cookie of that session.
const SID = /^[A-Za-z0-9_-]{16}$/;

// Stateless signed session: v1.<payload>.<hmac>. The server still re-checks the
// user on every request (exists, not disabled, same session version, session not signed out).
class Sessions {
  constructor(secret, ttlSec) {
    this.key = crypto.createHmac('sha256', secret).update('arr411-web session v1').digest();
    this.ttlSec = ttlSec;
  }

  mac(data) {
    return b64u(crypto.createHmac('sha256', this.key).update(data).digest());
  }

  sign(user, nowMs = Date.now(), sid = b64u(crypto.randomBytes(12))) {
    const iat = Math.floor(nowMs / 1000);
    const payload = b64u(JSON.stringify({ u: user.username, sv: user.sv || 1, sid, iat, exp: iat + this.ttlSec }));
    const head = `v1.${payload}`;
    return `${head}.${this.mac(head)}`;
  }

  verify(token, nowMs = Date.now()) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || parts[0] !== 'v1' || parts[1].length > 1024) return null;
    const head = `${parts[0]}.${parts[1]}`;
    const given = Buffer.from(parts[2]);
    const expected = Buffer.from(this.mac(head));
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    let p;
    try {
      p = JSON.parse(unb64u(parts[1]).toString('utf8'));
    } catch {
      return null;
    }
    if (!p || typeof p.u !== 'string' || typeof p.sid !== 'string' || !SID.test(p.sid) || !Number.isInteger(p.exp) || !Number.isInteger(p.iat)) return null;
    if (p.exp * 1000 <= nowMs) return null;
    return p;
  }
}

// Fixed-window failure counter, bounded in memory.
class Throttle {
  constructor(max, windowMs, cap = 20000) {
    this.max = max;
    this.windowMs = windowMs;
    this.cap = cap;
    this.map = new Map();
  }

  live(key, now) {
    const e = this.map.get(key);
    if (e && now - e.first >= this.windowMs) {
      this.map.delete(key);
      return null;
    }
    return e || null;
  }

  // Seconds to wait, or 0 when the key may try.
  wait(key, now = Date.now()) {
    const e = this.live(key, now);
    return e && e.count >= this.max ? Math.max(1, Math.ceil((e.first + this.windowMs - now) / 1000)) : 0;
  }

  fail(key, now = Date.now()) {
    const e = this.live(key, now);
    if (e) {
      e.count++;
      return;
    }
    if (this.map.size >= this.cap) this.sweep(now);
    this.map.set(key, { count: 1, first: now });
  }

  reset(key) {
    this.map.delete(key);
  }

  sweep(now = Date.now()) {
    for (const [k, e] of this.map) if (now - e.first >= this.windowMs) this.map.delete(k);
    while (this.map.size >= this.cap) this.map.delete(this.map.keys().next().value);
  }
}

function requestHost(req, trustProxy) {
  return (trustProxy && firstHeader(req, 'x-forwarded-host')) || firstHeader(req, 'host');
}

function requestIsSecure(req, cfg) {
  if (cfg.cookieSecure === 'true') return true;
  if (cfg.cookieSecure === 'false') return false;
  if (req.socket.encrypted) return true;
  return !!(cfg.trustProxy && /^https$/i.test(firstHeader(req, 'x-forwarded-proto')));
}

// True when an Origin header value names this site: the host the request was addressed to, or PUBLIC_URL.
// Only the host counts (not the scheme: a TLS-terminating proxy hides it); opaque and non-web origins never match.
function originIsOurs(req, cfg, origin) {
  let host = '';
  try {
    const u = new URL(String(origin));
    if (u.protocol === 'http:' || u.protocol === 'https:') host = u.host;
  } catch {
    /* opaque origin */
  }
  if (!host) return false;
  const allowed = [requestHost(req, cfg.trustProxy)];
  if (cfg.publicUrl) allowed.push(cfg.publicUrl.host);
  return allowed.includes(host);
}

// Unsafe API calls need a custom header (not sendable cross-site without a CORS
// preflight, which this server never grants) and a same-site Origin.
function checkCsrf(req, cfg) {
  if (SAFE_METHODS.has(req.method)) return;
  if (req.headers['x-requested-with'] !== 'arr411') throw new HttpError(403, 'Requête refusée (en-tête X-Requested-With manquant)');
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (!originIsOurs(req, cfg, origin)) {
      throw new HttpError(403, 'Origine refusée. Derrière un reverse proxy, définis TRUST_PROXY=true et/ou PUBLIC_URL.');
    }
    return;
  }
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Requête inter-sites refusée');
}

function sessionCookie(token, ttlSec, secure) {
  return serializeCookie(COOKIE, token, { maxAge: ttlSec, secure });
}

function clearCookie(secure) {
  return serializeCookie(COOKIE, '', { maxAge: 0, secure });
}

function readSessionToken(req) {
  return parseCookies(req.headers.cookie)[COOKIE] || '';
}

module.exports = { COOKIE, RENEW_AFTER_SEC, Sessions, Throttle, checkCsrf, originIsOurs, requestHost, requestIsSecure, sessionCookie, clearCookie, readSessionToken };
