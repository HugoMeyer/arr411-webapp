'use strict';
const http = require('node:http');
const https = require('node:https');
const config = require('./config');
const { HttpError } = require('./util');

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 15000 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 15000, rejectUnauthorized: !config.insecureUpstreamTls })
};
const USER_AGENT = `Mozilla/5.0 (compatible; Arr411-Web/${config.version})`;

// Validates and normalises a service URL typed by an admin.
function normalizeServiceUrl(input) {
  if (input != null && typeof input !== 'string') throw new HttpError(400, 'URL invalide');
  const raw = (input || '').trim();
  if (!raw) return '';
  if (!/^https?:\/\//i.test(raw)) throw new HttpError(400, 'L’URL doit commencer par http:// ou https://');
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, 'URL invalide');
  }
  if (!u.hostname) throw new HttpError(400, 'URL invalide');
  if (u.username || u.password) throw new HttpError(400, 'Ne mets pas d’identifiants dans l’URL : utilise les champs dédiés');
  if (u.search || u.hash) throw new HttpError(400, 'L’URL ne doit contenir ni paramètres ni ancre');
  return u.origin + u.pathname.replace(/\/+$/, '');
}

function parseBase(url) {
  const u = new URL(url);
  return {
    protocol: u.protocol,
    hostname: u.hostname.replace(/^\[|\]$/g, ''),
    port: u.port || undefined,
    path: u.pathname.replace(/\/+$/, ''),
    origin: u.origin
  };
}

function describeNetError(e, b, withHost) {
  const at = withHost ? ` (${b.hostname + (b.port ? ':' + b.port : '')})` : '';
  switch (e && e.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `hôte introuvable${at}`;
    case 'ECONNREFUSED':
      return `connexion refusée${at}`;
    case 'ETIMEDOUT':
      return 'délai dépassé';
    case 'ECONNRESET':
    case 'EPIPE':
      return 'connexion interrompue';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `hôte injoignable${at}`;
    default:
      if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(String(e && e.code))) {
        return `certificat TLS refusé (${e.code}) — voir INSECURE_UPSTREAM_TLS`;
      }
      return (e && (e.code || e.message)) || 'erreur inconnue';
  }
}

function netError(e, b) {
  if (e instanceof HttpError) return e;
  // The internal address of a service is only shown to administrators (see sendFailure).
  return new HttpError(502, 'Réseau : ' + describeNetError(e, b, false), { code: 'network', adminMessage: 'Réseau : ' + describeNetError(e, b, true) });
}

// Resolves with the raw IncomingMessage (headers received, body unread).
function request(o) {
  const attempt = (retry) =>
    new Promise((resolve, reject) => {
      const b = o.base;
      const headers = Object.assign({ 'User-Agent': USER_AGENT }, o.headers);
      if (o.body) headers['Content-Length'] = o.body.length;
      else if (o.method !== 'GET' && o.method !== 'HEAD') headers['Content-Length'] = 0;
      let req;
      try {
        req = (b.protocol === 'https:' ? https : http).request({
          protocol: b.protocol,
          hostname: b.hostname,
          port: b.port,
          method: o.method,
          path: o.path,
          headers,
          agent: agents[b.protocol]
        });
      } catch (e) {
        reject(new HttpError(400, 'Requête invalide'));
        return;
      }
      let connectTimer = null;
      req.on('socket', (sock) => {
        if (!sock.connecting) return;
        connectTimer = setTimeout(() => req.destroy(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' })), config.upstreamConnectMs);
        sock.once(b.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(connectTimer));
      });
      req.setTimeout(config.upstreamIdleMs, () => req.destroy(Object.assign(new Error('read timeout'), { code: 'ETIMEDOUT' })));
      let got = false;
      req.on('response', (res) => {
        got = true;
        clearTimeout(connectTimer);
        resolve(res);
      });
      req.on('error', (e) => {
        clearTimeout(connectTimer);
        if (got) return;
        // A kept-alive socket closed by the peer: retry once on a fresh connection.
        if (!retry && req.reusedSocket && (e.code === 'ECONNRESET' || e.code === 'EPIPE')) resolve(attempt(true));
        else reject(e);
      });
      if (o.signal) {
        const abort = () => req.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
        if (o.signal.aborted) abort();
        else o.signal.addEventListener('abort', abort, { once: true });
      }
      req.end(o.body || undefined);
    });
  return attempt(false);
}

async function readAll(res, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of res) {
    size += c.length;
    if (size > limit) {
      res.destroy();
      throw new HttpError(502, 'Réponse du service trop volumineuse', { code: 'upstream' });
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function requestBuffered(o, limit = 1024 * 1024) {
  const res = await request(o);
  const body = await readAll(res, limit);
  return { status: res.statusCode, headers: res.headers, body };
}

module.exports = { normalizeServiceUrl, parseBase, request, requestBuffered, readAll, netError, describeNetError, USER_AGENT };
