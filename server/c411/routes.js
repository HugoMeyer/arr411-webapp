'use strict';
// The C411 view as the HTTP server sees it: the status of the remote browser and the WebSocket that carries the live view.
// Nothing here works without a valid session. The cookie is checked on the handshake itself (before the protocol switch),
// the Origin must be this site (no cross-site WebSocket hijacking), the sockets are capped, and the session is checked
// again regularly, so a signed-out, disabled or expired account loses the view within seconds.
const path = require('node:path');
const auth = require('../auth');
const ws = require('../ws');
const { HttpError, clientIp, sendJson, log: defaultLog } = require('../util');
const { createMatcher, BRIDGE_HOSTS } = require('./hosts');
const { createCookieStore } = require('./cookies');
const { createEngine } = require('./engine');
const inject = require('./inject');
const input = require('./input');
const { Hub } = require('./sessions');

const STATUS_PATH = '/api/c411/status';
const WS_PATH = '/api/c411/ws';
// The largest message of the viewer is a pasted text of 5000 characters: 64 KiB is far more than any real message.
const MAX_MESSAGE = 64 * 1024;
// A .torrent beyond this size is not a torrent: it also keeps what crosses the DevTools connection (base64) under its own limit.
const MAX_TORRENT_BYTES = 16 * 1024 * 1024;
const ARM_MS = 20000;
const MAX_SOCKETS = 50;
const MAX_SOCKETS_PER_USER = 3;
const UPGRADES_PER_MINUTE = 60;
const HELLO_MS = 10000;
const RECHECK_MS = 15000;
// Under the 60 s idle timeout that reverse proxies usually apply to a WebSocket.
const PING_MS = 25000;
const SHUTDOWN_HUB_MS = 4000;
const SHUTDOWN_SOCKETS_MS = 1500;
const WARN_EVERY_MS = 60000;
const noop = () => {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The promise, or nothing after `ms`; the timer never outlives the call.
function within(promise, ms) {
  let timer;
  const limit = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

// opts is the test seam (never read from the environment): { browserUrl, allowHttp, homeUrl, hosts, bridgeHosts,
// maxSessions, idleMs, persistCookies, helloMs, recheckMs, pingMs, armMs, maxSockets, maxSocketsPerUser, upgradesPerMinute }.
function createC411({ config, api, users, proxy, cfgStore, opts = {}, log = defaultLog }) {
  const settings = config.c411;
  const pick = (key) => (opts[key] !== undefined ? opts[key] : settings[key]);
  const allowHttp = opts.allowHttp === true;
  const helloMs = opts.helloMs || HELLO_MS;
  const recheckMs = opts.recheckMs || RECHECK_MS;
  const pingMs = opts.pingMs || PING_MS;
  const armMs = opts.armMs || ARM_MS;
  const maxSockets = opts.maxSockets || MAX_SOCKETS;
  const maxSocketsPerUser = opts.maxSocketsPerUser || MAX_SOCKETS_PER_USER;

  // One list for the navigation and the network (see egress.js); the extension script only ever runs on the site itself.
  const matcher = createMatcher(opts.hosts !== undefined ? opts.hosts : settings.allowedHosts);
  const bridgeMatcher = createMatcher(opts.bridgeHosts || [], BRIDGE_HOSTS);
  const maxTorrentBytes = Math.min(config.maxUploadBytes, MAX_TORRENT_BYTES);
  const maxPayload = Math.ceil(maxTorrentBytes / 3) * 4 + 64 * 1024;

  const buildScripts = ({ binding, recv, topic }) =>
    inject.build({ hosts: bridgeMatcher.patterns, allowHttp, binding, recv, topic, maxTorrentBytes, armMs, version: config.version });
  // A configuration the scripts would refuse stops the server at start-up rather than at the first visit.
  buildScripts({ binding: 'bprobe0000', recv: 'rprobe0000', topic: 'tprobe0000' });

  const cookieStore = createCookieStore(path.join(config.dataDir, 'c411'), matcher);
  const engine = createEngine({ proxy, users, cfgStore, config });
  // What the remote browser calls an account: the name AND the creation date. An account created later with the name of a
  // removed one is another account: it finds neither its tab nor its saved cookies.
  const accountKey = (u) => `${u.username}\n${u.createdAt}`;
  const getUser = (name, account) => {
    const u = users.find(name);
    return u && !u.disabled && accountKey(u) === account ? u : null;
  };
  // The accounts that may use the view. Edits made from the command line are picked up first.
  const accounts = () => {
    users.refresh();
    return users.all.filter((u) => !u.disabled).map(accountKey);
  };
  const hub = new Hub({
    browserUrl: pick('browserUrl'),
    matcher,
    bridgeMatcher,
    allowHttp,
    homeUrl: opts.homeUrl || 'https://c411.org/',
    maxSessions: pick('maxSessions'),
    idleMs: pick('idleMs'),
    persistCookies: pick('persistCookies') !== false,
    cookieStore,
    engine,
    getUser,
    accounts,
    buildScripts,
    maxPayload,
    log
  });

  const sockets = new Set();
  const attempts = new auth.Throttle(opts.upgradesPerMinute || UPGRADES_PER_MINUTE, 60000);
  let closing = false;
  let warnedAt = 0;

  const warnOnce = (...args) => {
    const now = Date.now();
    if (now - warnedAt < WARN_EVERY_MS) return;
    warnedAt = now;
    log.warn(...args);
  };

  async function handle(ctx, pathname) {
    const { req, res } = ctx;
    if (pathname === STATUS_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Méthode non autorisée', { headers: { Allow: 'GET, HEAD' } });
      return sendJson(res, 200, await hub.status());
    }
    if (pathname === WS_PATH) throw new HttpError(426, 'Cette adresse attend une connexion WebSocket.', { headers: { Upgrade: 'websocket', Connection: 'Upgrade' } });
    throw new HttpError(404, 'Introuvable');
  }

  // Every request that asks for a protocol switch ends here, whatever its path: this is the only door to the view.
  function upgrade(req, socket, head) {
    socket.on('error', noop);
    try {
      accept(req, socket, head);
    } catch (e) {
      log.error('Vue C411 : connexion WebSocket impossible', (e && e.stack) || e);
      socket.destroy();
    }
  }

  function accept(req, socket, head) {
    if (!req.url || req.url[0] !== '/' || req.url.length > 2000) return ws.reject(socket, 400, 'Requête invalide');
    let pathname;
    try {
      pathname = new URL('http://x' + req.url).pathname;
    } catch {
      return ws.reject(socket, 400, 'Requête invalide');
    }
    if (pathname !== WS_PATH) return ws.reject(socket, 404, 'Introuvable');
    if (closing) return ws.reject(socket, 503, 'Le serveur s’arrête.', { 'Retry-After': '5' });

    const ip = clientIp(req, config.trustProxy);
    const wait = attempts.wait(ip);
    if (wait) return ws.reject(socket, 429, 'Trop de tentatives, réessaie dans un instant.', { 'Retry-After': String(wait) });
    attempts.fail(ip);

    // Who is asking, before anything else is learned about the request.
    const token = auth.readSessionToken(req);
    const found = api.identify(token);
    if (!found) return ws.reject(socket, 401, 'Authentification requise');
    const user = found.user;

    // Browsers always send the Origin of the page that opens a WebSocket; a page of another site is refused.
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !auth.originIsOurs(req, config, origin)) {
      warnOnce(
        `Vue C411 : origine refusée (${JSON.stringify(String(origin).slice(0, 200))}, hôte ${JSON.stringify(String(auth.requestHost(req, config.trustProxy)).slice(0, 200))}).`,
        'Derrière un reverse proxy, définis TRUST_PROXY=true et/ou PUBLIC_URL.'
      );
      return ws.reject(socket, 403, 'Origine refusée');
    }

    if (sockets.size >= maxSockets) return ws.reject(socket, 503, 'Trop de connexions ouvertes sur ce serveur.', { 'Retry-After': '30' });
    let mine = 0;
    for (const e of sockets) if (e.username === user.username) mine++;
    if (mine >= maxSocketsPerUser) return ws.reject(socket, 429, 'Trop de fenêtres ouvertes pour ce compte.', { 'Retry-After': '10' });

    const conn = ws.upgrade(req, socket, head, { maxPayload: MAX_MESSAGE, allowBinary: false, pingMs });
    if (!conn) return undefined;
    if (config.logRequests) log.info(`${ip} ${user.username} WS ${WS_PATH} -> 101`);
    serve(conn, user, token, found.sid);
    return undefined;
  }

  function serve(conn, user, token, sid) {
    const username = user.username;
    const account = accountKey(user);
    const entry = { username, sid, conn };
    sockets.add(entry);
    let opened = false;

    const viewer = {
      username,
      account,
      get closed() {
        return conn.closed;
      },
      json(obj) {
        if (!conn.closed) conn.sendText(JSON.stringify(obj));
      },
      // done() is always called: the remote browser sends the next frame only after it.
      frame(buf, done) {
        if (conn.closed) return done();
        conn.sendBinary(buf, () => done());
        return undefined;
      },
      close(code, reason) {
        conn.close(code, reason);
      }
    };

    const signOut = () => {
      viewer.json({ t: 'error', code: 'signed_out', text: 'Ta session n’est plus valide.' });
      conn.close(4401, 'Session expirée');
    };
    entry.signOut = signOut;

    const helloTimer = setTimeout(() => conn.close(1008, 'Message d’ouverture attendu'), helloMs);
    helloTimer.unref();
    const recheckTimer = setInterval(() => {
      let current = null;
      try {
        current = api.identify(token);
      } catch {
        /* an account that cannot be checked is treated as signed out */
      }
      if (!current || current.user.username !== username || accountKey(current.user) !== account) signOut();
    }, recheckMs);
    recheckTimer.unref();

    conn.on('message', (data) => {
      let m;
      try {
        m = JSON.parse(data);
      } catch {
        return conn.close(1008, 'Message invalide');
      }
      if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') return conn.close(1008, 'Message invalide');
      // The heartbeat of the page: answered here, and it is not activity (it must not keep an idle tab alive).
      if (m.t === 'ping') return viewer.json({ t: 'pong' });
      if (!opened) {
        const size = m.t === 'hello' ? input.size(m.w, m.h) : null;
        if (!size) return conn.close(1008, 'Message d’ouverture attendu');
        opened = true;
        clearTimeout(helloTimer);
        hub.open(viewer, size).catch(noop);
        return undefined;
      }
      if (m.t === 'hello') return undefined;
      try {
        hub.message(viewer, m);
      } catch (e) {
        // What the viewer typed or clicked is never written to the logs.
        log.warn(`Vue C411 : message ignoré (${(e && e.name) || 'erreur'})`);
      }
      return undefined;
    });

    conn.on('close', () => {
      clearTimeout(helloTimer);
      clearInterval(recheckTimer);
      sockets.delete(entry);
      if (opened) hub.release(viewer);
    });
  }

  // Account removed, disabled or given a new password: its tab, its cookies and its sockets go away.
  function dropUser(name) {
    for (const e of [...sockets]) if (e.username === name) e.signOut();
    const u = users.find(name);
    return hub.dropUser(name, u ? accountKey(u) : null).catch(noop);
  }

  // The session was ended by a sign-out: every socket opened with it is closed at once.
  function closeSession(sid) {
    if (!sid) return;
    for (const e of [...sockets]) if (e.sid === sid) e.signOut();
  }

  async function close() {
    if (closing) return;
    closing = true;
    await within(hub.close().catch(noop), SHUTDOWN_HUB_MS);
    for (const e of [...sockets]) e.conn.close(1001, 'Le serveur s’arrête.');
    const until = Date.now() + SHUTDOWN_SOCKETS_MS;
    while (sockets.size && Date.now() < until) await sleep(25);
    for (const e of [...sockets]) e.conn.terminate();
    engine.close();
  }

  return { handle, upgrade, dropUser, closeSession, close, hub, engine, stats: () => ({ sockets: sockets.size, ...hub.stats() }) };
}

module.exports = { createC411, STATUS_PATH, WS_PATH };
