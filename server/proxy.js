'use strict';
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream');
const config = require('./config');
const up = require('./upstream');
const policy = require('./policy');
const { QbPool } = require('./qb');
const { CoverCache } = require('./covers');
const { HttpError, readBody, send } = require('./util');

const META = {
  qb: { prefix: '/api/v2/', name: 'qBittorrent' },
  radarr: { prefix: '/api/v3/', name: 'Radarr' },
  sonarr: { prefix: '/api/v3/', name: 'Sonarr' },
  lidarr: { prefix: '/api/v1/', name: 'Lidarr' }
};
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH']);
const FORWARD_HEADERS = ['content-type', 'accept', 'accept-language', 'accept-encoding'];
const PASS_HEADERS = ['content-type', 'content-encoding', 'content-disposition'];
const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;

const badPath = () => new HttpError(400, 'Chemin invalide');

// Returns the part after the API prefix ("movie/12"), or throws.
// No "%" at all: the services decode the path before routing it, so "%61pp/setPreferences" would reach a route
// that was never authorized here. Nothing the interface sends needs it, values travel in the query string.
function checkPath(raw, svc) {
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*$/.test(raw) || raw.includes('//')) throw badPath();
  if (raw.split('/').some((s) => s === '.' || s === '..')) throw badPath();
  const prefix = META[svc].prefix;
  if (!raw.startsWith(prefix)) throw new HttpError(404, 'Chemin inconnu');
  return raw.slice(prefix.length);
}

function clientHeaders(req) {
  const h = {};
  for (const k of FORWARD_HEADERS) if (req.headers[k]) h[k] = req.headers[k];
  return h;
}

function clientIdOf(req) {
  const v = String(req.headers['x-arr411-client'] || '');
  return CLIENT_ID.test(v) ? v : 'default';
}

class Proxy {
  constructor({ store }) {
    this.store = store;
    this.qb = new QbPool(() => this.connInfo('qb'));
    this.covers = new CoverCache(path.join(config.dataDir, 'cache', 'covers'));
    this.inflight = new Map();
  }

  connInfo(svc) {
    const d = this.store.data;
    const c = d.connections[svc];
    return c && c.url && (svc === 'qb' || c.apiKey) ? { conn: c, rev: d.rev[svc] || 1 } : null;
  }

  invalidate(svc) {
    if (svc === 'qb') this.qb.reset();
  }

  dropUser(username) {
    this.qb.dropUser(username);
  }

  close() {
    return this.qb.closeAll();
  }

  // `tail` is everything after /api/svc/<svc>, query string included.
  async handle(ctx, svc, tail) {
    const { req, user } = ctx;
    const meta = META[svc];
    if (!meta) throw new HttpError(404, 'Service inconnu');
    if (!METHODS.has(req.method)) throw new HttpError(405, 'Méthode non autorisée');
    const qi = tail.indexOf('?');
    const rawPath = qi < 0 ? tail : tail.slice(0, qi);
    const rawQuery = qi < 0 ? '' : tail.slice(qi + 1);
    const rest = checkPath(rawPath, svc);
    if (rawQuery && (rawQuery.length > 8192 || !/^[\x21-\x7e]*$/.test(rawQuery))) throw new HttpError(400, 'Requête invalide');
    const info = this.connInfo(svc);
    if (!info) {
      const hint = user.role === 'admin' ? 'Renseigne-le dans Réglages.' : 'Demande à un administrateur de le configurer.';
      throw new HttpError(503, `${meta.name} n’est pas configuré. ${hint}`, { code: 'unconfigured' });
    }
    if (svc === 'qb') policy.authorizeQb({ role: user.role, rest });
    const body = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req, config.maxUploadBytes);
    const target = { path: meta.prefix + rest, rest, query: rawQuery ? '?' + rawQuery : '', body };
    return svc === 'qb' ? this.qbRequest(ctx, info, target) : this.arrRequest(ctx, svc, info, target);
  }

  async call(o) {
    try {
      return await up.request(o);
    } catch (e) {
      throw up.netError(e, o.base);
    }
  }

  async qbRequest(ctx, info, t) {
    const { req, res, user } = ctx;
    const client = clientIdOf(req);
    const lower = t.rest.toLowerCase();
    if (lower === 'auth/login' || lower === 'auth/logout') {
      if (req.method !== 'POST') throw new HttpError(405, 'Méthode non autorisée');
      // The browser never knows the qBittorrent credentials: "login" re-opens the server-side session.
      if (lower === 'auth/login') await this.qb.cookieFor(user.username, client, true);
      send(res, 204, null, { 'Cache-Control': 'no-store' });
      return;
    }
    const base = up.parseBase(info.conn.url);
    const headers = Object.assign(clientHeaders(req), { Origin: base.origin, Referer: base.origin + '/' });
    const make = (cookie) => ({
      base,
      method: req.method,
      path: base.path + t.path + t.query,
      headers: cookie ? Object.assign({ Cookie: cookie }, headers) : headers,
      body: t.body
    });
    const cookie = await this.qb.cookieFor(user.username, client);
    let r = await this.call(make(cookie));
    if (r.statusCode === 401 || r.statusCode === 403) {
      // Expired or unknown session: log in again once and replay the request.
      r.resume();
      r = await this.call(make(await this.qb.cookieFor(user.username, client, true, cookie)));
    }
    this.pipe(ctx, r);
  }

  async arrRequest(ctx, svc, info, t) {
    const { req, user } = ctx;
    policy.authorizeArr({ role: user.role, method: req.method, rest: t.rest, body: t.body, allowSearch: config.allowSearchCommands, contentType: req.headers['content-type'] });
    const base = up.parseBase(info.conn.url);
    const p = base.path + t.path + t.query;
    if (req.method === 'GET' && /^mediacover\//i.test(t.rest)) return this.cover(ctx, svc, info, base, p);
    const headers = Object.assign(clientHeaders(req), { 'X-Api-Key': info.conn.apiKey || '' });
    const r = await this.call({ base, method: req.method, path: p, headers, body: t.body });
    this.pipe(ctx, r);
  }

  async cover(ctx, svc, info, base, p) {
    const key = this.covers.key(svc, info.conn.url, p);
    let entry = await this.covers.get(key);
    if (!entry) {
      if (this.covers.isMiss(key)) throw new HttpError(404, 'Image introuvable', { code: 'upstream' });
      let job = this.inflight.get(key);
      if (!job) {
        job = this.fetchCover(info, base, p, key).finally(() => this.inflight.delete(key));
        this.inflight.set(key, job);
      }
      entry = await job;
    }
    send(ctx.res, 200, entry.body, {
      'Content-Type': entry.type,
      'Cache-Control': 'private, max-age=604800',
      'X-Content-Type-Options': 'nosniff'
    });
  }

  async fetchCover(info, base, p, key) {
    let r;
    try {
      r = await up.requestBuffered(
        { base, method: 'GET', path: p, headers: { 'X-Api-Key': info.conn.apiKey || '', Accept: 'image/*', 'Accept-Encoding': 'identity' } },
        15 * 1024 * 1024
      );
    } catch (e) {
      throw up.netError(e, base);
    }
    if (r.status === 404) {
      this.covers.markMiss(key);
      throw new HttpError(404, 'Image introuvable', { code: 'upstream' });
    }
    if (r.status !== 200) {
      throw new HttpError(r.status >= 500 || r.status < 400 ? 502 : r.status, `Image indisponible (HTTP ${r.status})`, { code: 'upstream' });
    }
    const type = String(r.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (this.covers.typeIndex(type) < 0) throw new HttpError(502, 'Type d’image non pris en charge', { code: 'upstream' });
    await this.covers.put(key, type, r.body).catch(() => {});
    return { type, body: r.body };
  }

  // Streams the upstream response to the browser. Cookies, auth challenges and
  // redirects from the service never reach the client.
  pipe(ctx, r) {
    const { req, res } = ctx;
    const status = r.statusCode;
    if (status >= 300 && status < 400 && status !== 304) {
      r.resume();
      let where = '';
      try {
        where = ' vers ' + new URL(r.headers.location, 'http://x').pathname;
      } catch {
        /* no usable location */
      }
      const advice = 'Vérifie l’URL (http/https, URL de base).';
      throw new HttpError(502, `Le service a répondu par une redirection (HTTP ${status}). ${advice}`, {
        code: 'upstream',
        adminMessage: `Le service a répondu par une redirection (HTTP ${status}${where}). ${advice}`
      });
    }
    const headers = { 'Cache-Control': 'no-store' };
    for (const k of PASS_HEADERS) if (r.headers[k]) headers[k] = r.headers[k];
    const bodyless = req.method === 'HEAD' || status === 204 || status === 304;
    const gzip =
      !bodyless &&
      !r.headers['content-encoding'] &&
      /json|text|javascript|xml/i.test(String(r.headers['content-type'] || '')) &&
      /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
    if (gzip) {
      headers['Content-Encoding'] = 'gzip';
      headers.Vary = 'Accept-Encoding';
    } else if (r.headers['content-length'] && !bodyless) {
      headers['Content-Length'] = r.headers['content-length'];
    }
    res.writeHead(status, headers);
    if (bodyless) {
      res.end();
      r.resume();
      return;
    }
    res.on('close', () => r.destroy());
    pipeline(...(gzip ? [r, zlib.createGzip(), res] : [r, res]), () => {});
  }
}

module.exports = { Proxy, checkPath, META };
