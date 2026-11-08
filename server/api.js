'use strict';
const config = require('./config');
const auth = require('./auth');
const { normalizeServiceUrl } = require('./upstream');
const { HttpError, readJson, sendJson, clientIp, log } = require('./util');
const { verifyPassword, dummyHash, validatePassword } = require('./password');

const TTL_SEC = config.sessionDays * 86400;
const WINDOW_MS = 15 * 60 * 1000;

// Server-wide defaults (shared by every user, editable by admins).
const DEFAULT_KEYS = [
  'defaultCategory', 'radarrCategory', 'sonarrCategory', 'lidarrCategory',
  'radarrProfile', 'radarrRoot', 'sonarrProfile', 'sonarrRoot', 'lidarrProfile', 'lidarrRoot', 'lidarrMetaProfile'
];

const forbidden = () => new HttpError(403, 'Action réservée aux administrateurs', { code: 'forbidden' });
const notFound = () => new HttpError(404, 'Route inconnue');
const userView = (u) => ({ username: u.username, role: u.role });

function cleanDefaults(body) {
  const out = {};
  for (const k of DEFAULT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(body, k)) continue;
    const v = body[k];
    if (v === null || v === '') out[k] = null;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string' && v.length <= 500) out[k] = v;
    else throw new HttpError(400, `Valeur invalide pour ${k}`);
  }
  return out;
}

const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};

// onUserDropped(name): the account was removed, disabled or given a new password.
// onSignedOut(sid): the session was ended by a sign-out.
function createApi({ users, sessions, revoked, cfgStore, proxy, onUserDropped, onSignedOut }) {
  const ipFail = new auth.Throttle(10, WINDOW_MS);
  const pairFail = new auth.Throttle(5, WINDOW_MS);
  const userFail = new auth.Throttle(30, WINDOW_MS);
  const sweeper = setInterval(() => [ipFail, pairFail, userFail].forEach((t) => t.sweep()), 5 * 60 * 1000);
  sweeper.unref();

  const secure = (req) => auth.requestIsSecure(req, config);
  // `sid` is given when a cookie is renewed (the session stays the same), and made up for a new sign-in.
  const setSession = (req, res, user, sid) => res.setHeader('Set-Cookie', auth.sessionCookie(sessions.sign(user, Date.now(), sid), TTL_SEC, secure(req)));
  const userDropped = (name) => {
    proxy.dropUser(name);
    if (onUserDropped) onUserDropped(name);
  };

  // The user behind a session token (signature, expiry, session not signed out, account still enabled, same session
  // version), or null.
  function lookup(token) {
    if (!token) return null;
    const p = sessions.verify(token);
    if (!p || revoked.has(p.sid)) return null;
    users.refresh();
    const user = users.find(p.u);
    if (!user || user.disabled || (user.sv || 1) !== p.sv) return null;
    return { user, p };
  }

  // { user, sid } for a valid token, otherwise null.
  const identify = (token) => {
    const found = lookup(token);
    return found ? { user: found.user, sid: found.p.sid } : null;
  };

  // Returns the signed-in user, or null. Also renews the cookie once a day (sliding session).
  function authenticate(req, res) {
    const found = lookup(auth.readSessionToken(req));
    if (!found) return null;
    if (Date.now() - found.p.iat * 1000 > auth.RENEW_AFTER_SEC * 1000) setSession(req, res, found.user, found.p.sid);
    return found.user;
  }

  function throttled(ip, pair, username) {
    const wait = Math.max(ipFail.wait(ip), pairFail.wait(pair), userFail.wait(username));
    if (!wait) return;
    throw new HttpError(429, `Trop de tentatives. Réessaie dans ${Math.max(1, Math.ceil(wait / 60))} min.`, {
      code: 'throttled',
      headers: { 'Retry-After': String(wait) }
    });
  }

  const recordFailure = (ip, pair, username) => {
    ipFail.fail(ip);
    pairFail.fail(pair);
    userFail.fail(username);
  };

  async function login(ctx) {
    const { req, res } = ctx;
    const body = await readJson(req);
    users.refresh();
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase().slice(0, 64) : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const ip = clientIp(req, config.trustProxy);
    const pair = `${ip}|${username}`;
    throttled(ip, pair, username);
    const user = username ? users.find(username) : null;
    const usable = !!user && !user.disabled;
    // Unknown and disabled accounts are verified against a dummy hash so timing does not reveal them.
    const ok = !!password && password.length <= 256 && (await verifyPassword(password, usable ? user.hash : await dummyHash()));
    if (!ok || !usable) {
      recordFailure(ip, pair, username);
      throw new HttpError(401, 'Identifiant ou mot de passe incorrect', { code: 'bad-credentials' });
    }
    pairFail.reset(pair);
    await users.touchLogin(user.username);
    setSession(req, res, user);
    sendJson(res, 200, { user: userView(user) });
  }

  // Ends the session behind the cookie, not only the copy in this browser: the same cookie replayed later is refused,
  // and the live views opened with it are closed.
  async function logout(ctx) {
    const { req, res } = ctx;
    const found = lookup(auth.readSessionToken(req));
    res.setHeader('Set-Cookie', auth.clearCookie(secure(req)));
    if (found) {
      try {
        await revoked.revoke(found.p.sid);
      } catch (e) {
        log.error('Déconnexion : impossible d’enregistrer la session révoquée (elle reste révoquée jusqu’au redémarrage)', (e && e.message) || e);
      }
      if (onSignedOut) onSignedOut(found.p.sid);
    }
    sendJson(res, 200, { ok: true });
  }

  async function changePassword(ctx) {
    const { req, res, user } = ctx;
    const body = await readJson(req);
    const current = typeof body.current === 'string' ? body.current : '';
    validatePassword(body.password);
    const ip = clientIp(req, config.trustProxy);
    const pair = `${ip}|${user.username}`;
    throttled(ip, pair, user.username);
    const ok = !!current && current.length <= 256 && (await verifyPassword(current, user.hash));
    if (!ok) {
      recordFailure(ip, pair, user.username);
      throw new HttpError(403, 'Mot de passe actuel incorrect', { code: 'bad-password' });
    }
    pairFail.reset(pair);
    const updated = await users.setPassword(user.username, body.password);
    // The new session version signs out every other device; keep this one.
    setSession(req, res, updated);
    sendJson(res, 200, { ok: true });
  }

  function publicConfig(user) {
    const d = cfgStore.data;
    const services = {};
    for (const svc of config.SERVICES) {
      const info = proxy.connInfo(svc);
      services[svc] = { configured: !!info, web: info ? info.conn.publicUrl || '' : '', rev: d.rev[svc] || 1 };
    }
    return { version: config.version, user: userView(user), services, prefs: user.prefs || {}, defaults: d.defaults };
  }

  function connectionView(svc) {
    const c = cfgStore.data.connections[svc] || {};
    const v = { url: c.url || '', publicUrl: c.publicUrl || '' };
    if (svc === 'qb') Object.assign(v, { username: c.username || '', hasPassword: !!c.password });
    else v.hasKey = !!c.apiKey;
    return v;
  }

  async function saveConnection(svc, body) {
    const d = cfgStore.data;
    // Only an explicit empty string removes a connection: a partial request must not wipe it.
    if (typeof body.url !== 'string') throw new HttpError(400, 'Adresse manquante');
    const url = normalizeServiceUrl(body.url);
    const publicUrl = body.publicUrl === undefined ? undefined : normalizeServiceUrl(body.publicUrl);
    const cur = d.connections[svc] || null;
    if (!url) {
      delete d.connections[svc];
    } else {
      const next = Object.assign({}, cur);
      next.url = url;
      if (publicUrl !== undefined) next.publicUrl = publicUrl;
      const newSecret = svc === 'qb' ? (typeof body.password === 'string' && body.password !== '') || body.clearPassword === true : typeof body.apiKey === 'string' && body.apiKey.trim() !== '';
      const hadSecret = !!(cur && (svc === 'qb' ? cur.password : cur.apiKey));
      // A stored secret never follows a change of address: it would be sent to the new host.
      if (cur && hadSecret && !newSecret && originOf(cur.url) !== originOf(url)) {
        throw new HttpError(400, svc === 'qb' ? 'L’adresse a changé : saisis à nouveau le mot de passe qBittorrent.' : 'L’adresse a changé : saisis à nouveau la clé API.');
      }
      if (svc === 'qb') {
        if (typeof body.username === 'string') next.username = body.username.trim().slice(0, 200);
        if (body.clearPassword === true) next.password = '';
        else if (typeof body.password === 'string' && body.password !== '') next.password = body.password.slice(0, 500);
        next.username = next.username || '';
        next.password = next.password || '';
      } else {
        if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') next.apiKey = body.apiKey.trim().slice(0, 200);
        next.apiKey = next.apiKey || '';
      }
      next.publicUrl = next.publicUrl || '';
      d.connections[svc] = next;
    }
    // Starts from the revision the web app was shown (1 when never saved), so every save changes it.
    d.rev[svc] = (d.rev[svc] || 1) + 1;
    await cfgStore.save();
    proxy.invalidate(svc);
    return connectionView(svc);
  }

  async function admin(ctx, pathname) {
    const { req, res, user } = ctx;
    const method = req.method;
    let m;
    if (pathname === '/api/admin/users') {
      if (method === 'GET') {
        users.fresh();
        return sendJson(res, 200, { users: users.list() });
      }
      if (method === 'POST') {
        const b = await readJson(req);
        const u = await users.create({ username: b.username, password: b.password, role: b.role });
        return sendJson(res, 201, { user: users.view(u) });
      }
    } else if ((m = /^\/api\/admin\/users\/([^/]+)$/.exec(pathname))) {
      let name;
      try {
        name = decodeURIComponent(m[1]).toLowerCase();
      } catch {
        throw new HttpError(400, 'Identifiant invalide');
      }
      if (method === 'PATCH') {
        const b = await readJson(req);
        if (b.disabled !== undefined && typeof b.disabled !== 'boolean') throw new HttpError(400, 'Valeur « disabled » invalide');
        if (b.password !== undefined) {
          if (name === user.username) throw new HttpError(409, 'Pour ton propre compte, utilise « Changer mon mot de passe »');
          validatePassword(b.password);
        }
        let u = await users.update(name, { role: b.role, disabled: b.disabled }, user);
        if (b.password !== undefined) u = await users.setPassword(name, b.password);
        if (u.disabled || b.password !== undefined) userDropped(name);
        return sendJson(res, 200, { user: users.view(u) });
      }
      if (method === 'DELETE') {
        await users.remove(name, user);
        userDropped(name);
        return sendJson(res, 200, { ok: true });
      }
    } else if (pathname === '/api/admin/connections' && method === 'GET') {
      const out = {};
      for (const svc of config.SERVICES) out[svc] = connectionView(svc);
      return sendJson(res, 200, { connections: out });
    } else if ((m = /^\/api\/admin\/connections\/(qb|radarr|sonarr|lidarr)$/.exec(pathname)) && method === 'PUT') {
      const view = await saveConnection(m[1], await readJson(req));
      return sendJson(res, 200, { connection: view, rev: cfgStore.data.rev[m[1]] });
    } else if (pathname === '/api/admin/defaults' && method === 'PUT') {
      const clean = cleanDefaults(await readJson(req));
      const d = cfgStore.data;
      for (const [k, v] of Object.entries(clean)) {
        if (v === null) delete d.defaults[k];
        else d.defaults[k] = v;
      }
      await cfgStore.save();
      return sendJson(res, 200, { defaults: d.defaults });
    }
    throw notFound();
  }

  async function handle(ctx, pathname) {
    const { req, res, user } = ctx;
    const method = req.method;
    if (pathname === '/api/auth/me' && method === 'GET') return sendJson(res, 200, { user: userView(user) });
    if (pathname === '/api/auth/password' && method === 'POST') return changePassword(ctx);
    if (pathname === '/api/config' && method === 'GET') return sendJson(res, 200, publicConfig(user));
    if (pathname === '/api/prefs' && method === 'PUT') {
      const prefs = await users.setPrefs(user.username, await readJson(req));
      return sendJson(res, 200, { prefs });
    }
    if (pathname.startsWith('/api/admin/')) {
      if (user.role !== 'admin') throw forbidden();
      return admin(ctx, pathname);
    }
    throw notFound();
  }

  return { authenticate, identify, login, logout, handle };
}

module.exports = { createApi, DEFAULT_KEYS };
