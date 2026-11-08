'use strict';
const crypto = require('node:crypto');
const net = require('node:net');

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    if (extra) Object.assign(this, extra);
  }
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (str) => Buffer.from(String(str), 'base64url');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > limit) {
      req.resume();
      reject(new HttpError(413, 'Requête trop volumineuse'));
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(err);
    };
    req.on('data', (c) => {
      if (settled) return;
      size += c.length;
      if (size > limit) {
        fail(new HttpError(413, 'Requête trop volumineuse'));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', fail);
    req.on('aborted', () => fail(new HttpError(400, 'Requête interrompue')));
  });
}

async function readJson(req, limit = 64 * 1024) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw new HttpError(400, 'JSON invalide');
  }
}

function send(res, status, body, headers) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body == null ? '' : String(body));
  res.writeHead(status, Object.assign({ 'Content-Length': buf.length }, headers));
  res.end(buf);
}

function sendJson(res, status, obj, headers) {
  send(res, status, JSON.stringify(obj), Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers));
}

function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    let v = part.slice(i + 1).trim();
    if (v.length > 1 && v[0] === '"' && v[v.length - 1] === '"') v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

function serializeCookie(name, value, o = {}) {
  let s = `${name}=${value}; Path=${o.path || '/'}; HttpOnly; SameSite=Lax`;
  if (o.maxAge != null) s += `; Max-Age=${Math.max(0, Math.floor(o.maxAge))}`;
  if (o.maxAge === 0) s += '; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
  if (o.secure) s += '; Secure';
  return s;
}

function normalizeIp(ip) {
  ip = String(ip || '');
  if (ip.startsWith('::ffff:') && ip.includes('.')) ip = ip.slice(7);
  return ip || 'unknown';
}

// trustHops = number of reverse proxies in front of the server (0 = none).
// Only a real address can be picked from X-Forwarded-For: anything else (text for the logs, endless distinct
// keys for the login throttle) falls back to the address of the connection. A well-formed forged address still
// passes when the port is reachable without the proxy, which is why the compose file can bind it to 127.0.0.1.
function clientIp(req, trustHops) {
  const peer = normalizeIp(req.socket.remoteAddress);
  if (!trustHops) return peer;
  const xff = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const chain = xff.concat(peer);
  const picked = normalizeIp(chain[Math.max(0, chain.length - 1 - trustHops)]);
  return net.isIP(picked) && !picked.includes('%') ? picked : peer;
}

function firstHeader(req, name) {
  const v = req.headers[name];
  return String(Array.isArray(v) ? v[0] : v || '')
    .split(',')[0]
    .trim();
}

const ts = () => new Date().toISOString();
const log = {
  info: (...a) => console.log(ts(), 'INFO ', ...a),
  warn: (...a) => console.warn(ts(), 'WARN ', ...a),
  error: (...a) => console.error(ts(), 'ERROR', ...a)
};

module.exports = { HttpError, b64u, unb64u, safeEqual, readBody, readJson, send, sendJson, parseCookies, serializeCookie, clientIp, firstHeader, normalizeIp, log };
