'use strict';
const { HttpError } = require('./util');
const up = require('./upstream');

const MAX_PER_USER = 8;
const IDLE_MS = 5 * 60 * 1000;

const credentialsError = () =>
  new HttpError(401, 'qBittorrent a refusé les identifiants enregistrés. Un administrateur doit les corriger dans Réglages.', { code: 'qb-credentials' });
const bannedError = () =>
  new HttpError(403, 'qBittorrent a banni l’adresse du serveur après trop d’échecs de connexion. Réessaie dans quelques minutes.', { code: 'qb-banned' });

function cookieHeader(setCookie) {
  return (setCookie || [])
    .map((c) => String(c).split(';')[0].trim())
    .filter((c) => c.includes('='))
    .join('; ');
}

// qBittorrent keeps the /sync rid state per session, so every browser tab gets
// its own qBittorrent login (user + tab id), created lazily and expired when idle.
class QbPool {
  constructor(getConn) {
    this.getConn = getConn;
    this.sessions = new Map();
    this.serial = Promise.resolve();
    this.rev = null;
    this.lock = null;
    this.credFails = 0;
    this.timer = setInterval(() => this.sweep(), 60 * 1000);
    this.timer.unref();
  }

  // Called when the connection settings change.
  reset() {
    this.sessions.clear();
    this.lock = null;
    this.credFails = 0;
  }

  touch(user, client) {
    const key = `${user}|${client}`;
    let s = this.sessions.get(key);
    if (!s) {
      s = { key, user, cookie: null, rev: null, pending: null, lastUsed: 0, loginAt: 0 };
      this.sessions.set(key, s);
      this.enforceLimit(user);
    }
    s.lastUsed = Date.now();
    return s;
  }

  enforceLimit(user) {
    const mine = [...this.sessions.values()].filter((s) => s.user === user);
    if (mine.length <= MAX_PER_USER) return;
    mine.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const s of mine.slice(0, mine.length - MAX_PER_USER)) this.drop(s);
  }

  drop(s) {
    this.sessions.delete(s.key);
    this.logout(s);
  }

  dropUser(user) {
    for (const s of [...this.sessions.values()]) if (s.user === user) this.drop(s);
  }

  sweep() {
    const limit = Date.now() - IDLE_MS;
    for (const s of [...this.sessions.values()]) if (s.lastUsed < limit && !s.pending) this.drop(s);
  }

  logout(s) {
    const c = this.getConn();
    if (!c || !s.cookie || s.rev !== c.rev) return;
    let base;
    try {
      base = up.parseBase(c.conn.url);
    } catch {
      return;
    }
    up.requestBuffered({
      base,
      method: 'POST',
      path: `${base.path}/api/v2/auth/logout`,
      headers: { Cookie: s.cookie, Origin: base.origin, Referer: base.origin + '/' }
    }).catch(() => {});
  }

  async closeAll() {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.race([
      Promise.allSettled(all.map((s) => this.logoutAsync(s))),
      new Promise((r) => setTimeout(r, 2000))
    ]);
  }

  logoutAsync(s) {
    const c = this.getConn();
    if (!c || !s.cookie || s.rev !== c.rev) return Promise.resolve();
    const base = up.parseBase(c.conn.url);
    return up
      .requestBuffered({ base, method: 'POST', path: `${base.path}/api/v2/auth/logout`, headers: { Cookie: s.cookie, Origin: base.origin, Referer: base.origin + '/' } })
      .catch(() => {});
  }

  // Cookie header to use for this user/tab (logs in when needed).
  // force: the caller got a 401/403 and wants a fresh login. `stale` is the cookie it used:
  // when the session was already renewed meanwhile (or just logged in), it is reused.
  async cookieFor(user, client, force = false, stale = null) {
    const c = this.getConn();
    if (!c) throw new HttpError(503, 'qBittorrent n’est pas configuré', { code: 'unconfigured' });
    const s = this.touch(user, client);
    const usable = s.cookie != null && s.rev === c.rev;
    if (usable && !force) return s.cookie;
    if (usable && force) {
      if (stale != null && s.cookie !== stale) return s.cookie;
      if (stale == null && Date.now() - s.loginAt < 3000) return s.cookie;
    }
    if (s.pending) return s.pending;
    s.pending = this.login(c)
      .then((cookie) => {
        s.cookie = cookie;
        s.rev = c.rev;
        s.loginAt = Date.now();
        return cookie;
      })
      .finally(() => {
        s.pending = null;
      });
    return s.pending;
  }

  // Logins are serialised so a wrong password cannot trigger a burst of failures
  // (qBittorrent bans an address after a few consecutive ones).
  login(c) {
    const run = async () => {
      if (this.rev !== c.rev) {
        this.rev = c.rev;
        this.lock = null;
        this.credFails = 0;
      }
      if (this.lock && this.lock.until > Date.now()) throw this.lock.kind === 'banned' ? bannedError() : credentialsError();
      const conn = c.conn;
      if (!conn.username && !conn.password) return '';
      const base = up.parseBase(conn.url);
      const body = Buffer.from(new URLSearchParams({ username: conn.username || '', password: conn.password || '' }).toString());
      let r;
      try {
        r = await up.requestBuffered(
          {
            base,
            method: 'POST',
            path: `${base.path}/api/v2/auth/login`,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base.origin, Referer: base.origin + '/', Accept: '*/*' },
            body
          },
          64 * 1024
        );
      } catch (e) {
        throw up.netError(e, base);
      }
      const text = r.body.toString('utf8').trim();
      if (r.status === 204 || (r.status === 200 && /^ok/i.test(text))) {
        this.lock = null;
        this.credFails = 0;
        return cookieHeader(r.headers['set-cookie']);
      }
      if (r.status === 403) {
        this.lock = { kind: 'banned', until: Date.now() + 5 * 60 * 1000 };
        throw bannedError();
      }
      if (r.status === 401 || (r.status === 200 && /fails/i.test(text))) {
        this.credFails++;
        this.lock = { kind: 'credentials', until: Date.now() + (this.credFails === 1 ? 30 * 1000 : 10 * 60 * 1000) };
        throw credentialsError();
      }
      if (r.status >= 300 && r.status < 400) {
        throw new HttpError(502, 'qBittorrent a répondu par une redirection : vérifie l’URL (http/https, URL de base).', { code: 'upstream' });
      }
      throw new HttpError(502, `Réponse inattendue de qBittorrent (HTTP ${r.status}).`, { code: 'upstream' });
    };
    const p = this.serial.then(run, run);
    this.serial = p.catch(() => {});
    return p;
  }
}

module.exports = { QbPool, cookieHeader, credentialsError, bannedError };
