'use strict';
// Minimal Chrome DevTools Protocol client on the WebSocket built into Node 22 (no dependency).
// The browser is a lower-trust peer: every message is size-checked and parsed defensively.
const dns = require('node:dns');
const http = require('node:http');
const net = require('node:net');
const { EventEmitter } = require('node:events');

const COMMAND_TIMEOUT_MS = 20000;
const HEARTBEAT_MS = 20000;
const MAX_MESSAGE = 24 * 1024 * 1024;
const MAX_HTTP_BODY = 256 * 1024;

class CdpError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CdpError';
    this.code = code;
  }
}

// Chrome only answers DevTools HTTP requests addressed to an IP (or localhost): resolve the name ourselves.
async function resolveEndpoint(browserUrl) {
  let u;
  try {
    u = new URL(String(browserUrl));
  } catch {
    throw new CdpError('C411_BROWSER_URL n’est pas une adresse valide (exemple : http://browser:9223)');
  }
  if (u.protocol !== 'http:' || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
    throw new CdpError('C411_BROWSER_URL doit être de la forme http://hôte:port');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ip = net.isIP(host) ? host : (await dns.promises.lookup(host)).address;
  const port = Number(u.port || 80);
  return { ip, port, hostHeader: (net.isIPv6(ip) ? `[${ip}]` : ip) + ':' + port };
}

function getJson(ep, path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: ep.ip, port: ep.port, path, headers: { host: ep.hostHeader }, timeout: timeoutMs, agent: false }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_HTTP_BODY) {
          req.destroy(new CdpError('Réponse DevTools trop grande'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new CdpError(`Le navigateur distant a répondu ${res.statusCode}`));
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new CdpError('Réponse DevTools illisible'));
        }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new CdpError('Le navigateur distant ne répond pas')));
    req.on('error', (e) => reject(e instanceof CdpError ? e : new CdpError('Navigateur distant injoignable')));
  });
}

class Cdp extends EventEmitter {
  constructor(ws) {
    super();
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.routes = new Map();
    this.closed = false;
    ws.addEventListener('message', (ev) => this.onMessage(ev.data));
    ws.addEventListener('close', () => this.shutdown('Connexion au navigateur fermée'));
    ws.addEventListener('error', () => {});
    this.heartbeat = setInterval(() => {
      this.send('Browser.getVersion', {}, undefined, 10000).catch(() => this.shutdown('Le navigateur distant ne répond plus'));
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  onMessage(data) {
    if (typeof data !== 'string' || data.length > MAX_MESSAGE) {
      this.shutdown('Message DevTools invalide');
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error && typeof msg.error === 'object') p.reject(new CdpError(`${String(msg.error.message || 'Erreur DevTools').slice(0, 200)} (${p.method})`, msg.error.code));
      else p.resolve(msg.result && typeof msg.result === 'object' ? msg.result : {});
      return;
    }
    if (typeof msg.method !== 'string') return;
    const event = { method: msg.method, params: msg.params && typeof msg.params === 'object' ? msg.params : {}, sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : undefined };
    const handler = event.sessionId ? this.routes.get(event.sessionId) : null;
    try {
      if (handler) handler(event);
      else if (!event.sessionId) this.emit('event', event);
    } catch (e) {
      this.emit('handlerError', e);
    }
  }

  send(method, params, sessionId, timeoutMs) {
    if (this.closed) return Promise.reject(new CdpError('Connexion au navigateur fermée'));
    const id = this.nextId++;
    const msg = { id, method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`Délai dépassé (${method})`));
      }, timeoutMs || COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.ws.send(JSON.stringify(msg));
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new CdpError('Connexion au navigateur fermée'));
      }
    });
  }

  route(sessionId, handler) {
    this.routes.set(sessionId, handler);
  }

  unroute(sessionId) {
    this.routes.delete(sessionId);
  }

  shutdown(reason) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new CdpError(reason));
    }
    this.pending.clear();
    this.routes.clear();
    try {
      this.ws.close();
    } catch {
      // already closed
    }
    this.emit('close', reason);
  }

  close() {
    this.shutdown('Connexion fermée');
  }
}

async function connect(browserUrl, { timeoutMs = 10000 } = {}) {
  if (typeof WebSocket !== 'function') throw new CdpError('Node 22 ou plus récent est requis pour la vue C411');
  const ep = await resolveEndpoint(browserUrl);
  const info = await getJson(ep, '/json/version', timeoutMs);
  let wsPath = '';
  try {
    wsPath = new URL(String(info.webSocketDebuggerUrl)).pathname;
  } catch {
    // handled below
  }
  if (!/^\/devtools\/browser\/[A-Za-z0-9-]{8,64}$/.test(wsPath)) throw new CdpError('Réponse DevTools inattendue');
  const ws = new WebSocket(`ws://${ep.hostHeader}${wsPath}`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new CdpError('Le navigateur distant ne répond pas'));
    }, timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new CdpError('Navigateur distant injoignable'));
    });
  });
  return new Cdp(ws);
}

module.exports = { Cdp, CdpError, connect, resolveEndpoint };
