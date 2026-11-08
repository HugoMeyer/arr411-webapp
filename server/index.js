'use strict';
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');

let config;
try {
  config = require('./config');
} catch (e) {
  console.error('Configuration invalide :', e.message);
  process.exit(1);
}
const auth = require('./auth');
const { JsonStore, ensureDataDir, loadSecret } = require('./store');
const { Users } = require('./users');
const { validateUsername, validatePassword } = require('./password');
const { normalizeServiceUrl } = require('./upstream');
const { Proxy } = require('./proxy');
const { createApi } = require('./api');
const { Revoked } = require('./revoked');
const { createC411 } = require('./c411/routes');
const { StaticFiles } = require('./static');
const { HttpError, send, sendJson, clientIp, log } = require('./util');

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'"
].join('; ');

const PROXY_URL = /^\/api\/svc\/(qb|radarr|sonarr|lidarr)(\/[^?]*)?(\?.*)?$/;

function securityHeaders(req, res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  if (auth.requestIsSecure(req, config)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

// Only same-site absolute paths are accepted as a post-login destination. Printable ASCII only: browsers drop tabs
// and line breaks from a URL, so "/<tab>/host" would otherwise be read as "//host" and leave the site.
function safeNext(v) {
  v = String(v || '');
  if (!v || v.length > 2000 || !/^\/(?![/\\])[\x21-\x7e]*$/.test(v)) return '/';
  if (/^\/(login|api)(\/|\?|$)/i.test(v)) return '/';
  return v;
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function sendFailure(ctx, err) {
  const { req, res } = ctx;
  const known = err instanceof HttpError;
  if (!known && !(err && err.code === 'ECONNRESET')) log.error(req.method, ctx.pathname || '-', (err && err.stack) || err);
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const status = known ? err.status : 500;
  const admin = Boolean(ctx.user && ctx.user.role === 'admin');
  const message = known ? (admin && err.adminMessage) || err.message : 'Erreur interne du serveur';
  const code = (known && err.code) || (known ? 'error' : 'internal');
  const headers = Object.assign({ 'Cache-Control': 'no-store' }, known && err.headers);
  // Every error produced by this server carries X-Arr411-Error, so the web app can tell
  // them apart from answers relayed from qBittorrent / Radarr / Sonarr / Lidarr.
  if (ctx.isApi) sendJson(res, status, { message, code }, Object.assign(headers, { 'X-Arr411-Error': code }));
  else send(res, status, message + '\n', Object.assign(headers, { 'Content-Type': 'text/plain; charset=utf-8' }));
}

async function bootstrapAdmin(users) {
  if (users.all.length) return;
  let name;
  try {
    name = config.adminUser ? validateUsername(config.adminUser) : 'admin';
    if (config.adminPassword) validatePassword(config.adminPassword);
  } catch (e) {
    throw new Error(`ADMIN_USER / ADMIN_PASSWORD : ${e.message}`);
  }
  let password = config.adminPassword;
  const generated = !password;
  if (generated) password = crypto.randomBytes(12).toString('base64url');
  await users.create({ username: name, password, role: 'admin' });
  if (generated) {
    log.warn('────────────────────────────────────────────────────────────');
    log.warn(`Premier démarrage : compte administrateur « ${name} » créé.`);
    log.warn(`Mot de passe temporaire (affiché une seule fois) : ${password}`);
    log.warn('Change-le dans Réglages > Compte, ou définis ADMIN_PASSWORD avant le premier démarrage.');
    log.warn('────────────────────────────────────────────────────────────');
  } else {
    log.info(`Premier démarrage : compte administrateur « ${name} » créé depuis ADMIN_USER / ADMIN_PASSWORD.`);
  }
}

// Environment variables only fill a service that was never saved: afterwards the settings page is the source of truth,
// so a connection removed there does not come back at the next start.
function seedConnections(cfgStore) {
  const d = cfgStore.data;
  let changed = false;
  for (const svc of config.SERVICES) {
    const s = config.seeds[svc];
    if (d.connections[svc] || (d.rev[svc] || 1) > 1 || !s.url) continue;
    try {
      const url = normalizeServiceUrl(s.url);
      d.connections[svc] = svc === 'qb' ? { url, username: s.username, password: s.password, publicUrl: '' } : { url, apiKey: s.apiKey, publicUrl: '' };
      d.rev[svc] = (d.rev[svc] || 1) + 1;
      changed = true;
      log.info(`${svc} : connexion initialisée depuis les variables d’environnement`);
    } catch (e) {
      log.warn(`${svc} : variable d’environnement ignorée (${e.message})`);
    }
  }
  return changed;
}

async function start(opts = {}) {
  ensureDataDir(config.dataDir);
  const secret = loadSecret(config.dataDir, config.sessionSecret);
  const usersStore = new JsonStore(path.join(config.dataDir, 'users.json'), () => ({ version: 1, users: [] })).load();
  const cfgStore = new JsonStore(path.join(config.dataDir, 'config.json'), () => ({ version: 1, rev: {}, connections: {}, defaults: {} })).load();
  if (!Array.isArray(usersStore.data.users)) usersStore.data.users = [];
  for (const k of ['rev', 'connections', 'defaults']) if (!cfgStore.data[k] || typeof cfgStore.data[k] !== 'object') cfgStore.data[k] = {};

  const users = new Users(usersStore);
  await bootstrapAdmin(users);
  if (seedConnections(cfgStore)) await cfgStore.save();

  const sessions = new auth.Sessions(secret, config.sessionDays * 86400);
  const revokedStore = new JsonStore(path.join(config.dataDir, 'revoked.json'), () => ({ version: 1, sessions: {} })).load();
  const revoked = new Revoked(revokedStore, config.sessionDays * 86400);
  const proxy = new Proxy({ store: cfgStore });
  // The C411 view needs the API to recognise a session, and the API tells the view when an account is dropped.
  let c411 = null;
  const api = createApi({
    users,
    sessions,
    revoked,
    cfgStore,
    proxy,
    onUserDropped: (name) => c411 && c411.dropUser(name),
    onSignedOut: (sid) => c411 && c411.closeSession(sid)
  });
  c411 = createC411({ config, api, users, proxy, cfgStore, opts: opts.c411 });
  const appFiles = new StaticFiles(path.join(config.publicDir, 'app'));
  const loginFiles = new StaticFiles(path.join(config.publicDir, 'login'));
  const iconFiles = new StaticFiles(path.join(config.publicDir, 'icons'));
  const rootFiles = new StaticFiles(config.publicDir);

  const readOnly = (req) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Méthode non autorisée', { headers: { Allow: 'GET, HEAD' } });
  };
  const serveOr404 = async (files, req, res, pathname) => {
    readOnly(req);
    if (!(await files.serve(req, res, pathname))) throw new HttpError(404, 'Introuvable');
  };
  const unauthorized = (ctx) => {
    const { req, res } = ctx;
    const navigation = req.method === 'GET' && (req.headers['sec-fetch-mode'] === 'navigate' || /\btext\/html\b/i.test(String(req.headers.accept || '')));
    if (!navigation) throw new HttpError(401, 'Authentification requise', { code: 'auth' });
    const next = safeNext(req.url);
    redirect(res, next === '/' ? '/login' : '/login?next=' + encodeURIComponent(next));
  };

  async function route(ctx, url) {
    const { req, res } = ctx;
    const pathname = url.pathname;

    if (pathname === '/healthz') {
      readOnly(req);
      return send(res, 200, req.method === 'HEAD' ? '' : 'ok\n', { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    }
    if (pathname === '/login' || pathname === '/login/') {
      // The form only posts natively if the script has not loaded yet: send the visitor back to the page instead of an error.
      if (req.method === 'POST') return redirect(res, '/login');
      readOnly(req);
      if (api.authenticate(req, res)) return redirect(res, safeNext(url.searchParams.get('next')));
      return serveOr404(loginFiles, req, res, '/');
    }
    if (pathname.startsWith('/login/')) return serveOr404(loginFiles, req, res, pathname.slice('/login'.length));
    if (pathname.startsWith('/icons/')) return serveOr404(iconFiles, req, res, pathname.slice('/icons'.length));
    if (pathname === '/manifest.webmanifest') return serveOr404(rootFiles, req, res, pathname);

    if (pathname.startsWith('/api/')) {
      ctx.isApi = true;
      if (req.method !== 'GET' && req.method !== 'HEAD') auth.checkCsrf(req, config);
      if (pathname === '/api/auth/login' && req.method === 'POST') return api.login(ctx);
      if (pathname === '/api/auth/logout' && req.method === 'POST') return api.logout(ctx);
      ctx.user = api.authenticate(req, res);
      if (!ctx.user) throw new HttpError(401, 'Session expirée : reconnecte-toi.', { code: 'auth' });
      ctx.username = ctx.user.username;
      if (pathname.startsWith('/api/c411/')) return c411.handle(ctx, pathname);
      const m = PROXY_URL.exec(req.url);
      if (m) return proxy.handle(ctx, m[1], (m[2] || '') + (m[3] || ''));
      return api.handle(ctx, pathname);
    }

    ctx.user = api.authenticate(req, res);
    if (!ctx.user) return unauthorized(ctx);
    ctx.username = ctx.user.username;
    return serveOr404(appFiles, req, res, pathname === '/share' ? '/' : pathname);
  }

  async function onRequest(req, res) {
    const t0 = Date.now();
    const ctx = { req, res, user: null, username: '-', isApi: false, pathname: '' };
    if (config.logRequests) {
      res.on('finish', () => log.info(`${clientIp(req, config.trustProxy)} ${ctx.username} ${req.method} ${ctx.pathname} -> ${res.statusCode} ${Date.now() - t0}ms`));
    }
    try {
      securityHeaders(req, res);
      if (!req.url || req.url[0] !== '/' || req.url.length > 9000) throw new HttpError(400, 'Requête invalide');
      let url;
      try {
        url = new URL('http://x' + req.url);
      } catch {
        throw new HttpError(400, 'Requête invalide');
      }
      ctx.pathname = url.pathname;
      await route(ctx, url);
    } catch (e) {
      sendFailure(ctx, e);
    }
  }

  const server = http.createServer(onRequest);
  // Every protocol switch (WebSocket) goes to the C411 view, which refuses anything but its own endpoint.
  server.on('upgrade', (req, socket, head) => c411.upgrade(req, socket, head));
  // Longer than the usual 60 s idle timeout of reverse proxies, to avoid resets on reused connections.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  const port = opts.port != null ? opts.port : config.port;
  const host = opts.host || config.host;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const shutdown = async () => {
    const closed = new Promise((r) => server.once('close', r));
    const force = setTimeout(() => server.closeAllConnections(), 3000);
    force.unref();
    server.close();
    server.closeIdleConnections();
    await Promise.allSettled([proxy.close(), c411.close()]);
    await closed;
    clearTimeout(force);
  };
  // Asking twice (two signals, a test that already stopped the app) waits for the same shutdown instead of hanging.
  let stopping = null;
  const close = () => stopping || (stopping = shutdown());
  return { server, close, users, cfgStore, usersStore, proxy, c411 };
}

module.exports = { start, safeNext };

if (require.main === module) {
  start()
    .then((app) => {
      const addr = app.server.address();
      log.info(`Arr411 Web ${config.version} : http://${addr.address === '::' || addr.address === '0.0.0.0' ? 'localhost' : addr.address}:${addr.port}  (données : ${config.dataDir})`);
      if (!config.publicUrl && !config.trustProxy) log.info('Derrière un reverse proxy HTTPS ? Définis TRUST_PROXY=true et PUBLIC_URL (voir README).');
      let closing = false;
      const shutdown = (signal) => {
        if (closing) return;
        closing = true;
        log.info(`${signal} reçu : arrêt en cours`);
        const hard = setTimeout(() => process.exit(1), 8000);
        hard.unref();
        app.close().then(() => process.exit(0), () => process.exit(1));
      };
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    })
    .catch((e) => {
      log.error('Démarrage impossible :', e && e.message ? e.message : e);
      process.exit(1);
    });
  process.on('unhandledRejection', (e) => log.error('Promesse rejetée non gérée :', (e && e.stack) || e));
  process.on('uncaughtException', (e) => {
    log.error('Exception non gérée :', (e && e.stack) || e);
    process.exit(1);
  });
}
