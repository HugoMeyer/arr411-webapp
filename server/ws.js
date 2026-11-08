'use strict';
// A small WebSocket server (RFC 6455) for the C411 view. It does only what this application needs: no extension, no
// sub-protocol, no client side. Everything that arrives is untrusted and is checked before it is delivered: masked
// frames only, no reserved bit, bounded sizes and rate, well-formed control frames, valid UTF-8 and valid close codes.
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { isUtf8 } = require('node:buffer');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;
const KEY = /^[A-Za-z0-9+/]{22}==$/;
const EMPTY = Buffer.alloc(0);
const CLOSE_WAIT_MS = 2500;
const MAX_REASON_BYTES = 123;
const MAX_CONTROL_ECHO_BUFFER = 64 * 1024;
const noop = () => {};

const STATUS = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  426: 'Upgrade Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  500: 'Internal Server Error',
  503: 'Service Unavailable'
};

// Allows bursts, then a steady rate.
class Bucket {
  constructor(capacity, perSecond) {
    this.capacity = capacity;
    this.perSecond = perSecond;
    this.tokens = capacity;
    this.at = Date.now();
  }

  take() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.at) / 1000) * this.perSecond);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

const clean = (v) => String(v).replace(/[\r\n\0]/g, ' ');

// An HTTP answer written straight on the socket of an upgrade request, which is then closed.
function reject(socket, status, text = '', headers = {}) {
  socket.on('error', noop);
  if (socket.destroyed) return;
  const body = text ? `${clean(text)}\n` : '';
  const lines = [
    `HTTP/1.1 ${status} ${STATUS[status] || 'Error'}`,
    'Connection: close',
    'Cache-Control: no-store',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`
  ];
  for (const [k, v] of Object.entries(headers)) lines.push(`${clean(k)}: ${clean(v)}`);
  const timer = setTimeout(() => socket.destroy(), 2000);
  timer.unref();
  socket.once('close', () => clearTimeout(timer));
  socket.end(`${lines.join('\r\n')}\r\n\r\n${body}`);
}

const acceptKey = (key) => crypto.createHash('sha1').update(key + GUID).digest('base64');

const refusal = (status, text, headers) => ({ ok: false, status, text, headers });

// Checks the handshake of an upgrade request: { ok: true, key } or { ok: false, status, text, headers }.
function checkUpgrade(req) {
  if (req.method !== 'GET') return refusal(405, 'Méthode non autorisée', { Allow: 'GET' });
  if (req.httpVersion !== '1.1') return refusal(400, 'HTTP/1.1 requis');
  const h = req.headers;
  if (String(h.upgrade || '').trim().toLowerCase() !== 'websocket') return refusal(400, 'Connexion WebSocket attendue');
  const tokens = String(h.connection || '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim());
  if (!tokens.includes('upgrade')) return refusal(400, 'Connexion WebSocket attendue');
  if (String(h['sec-websocket-version'] || '').trim() !== '13') return refusal(426, 'Version WebSocket non prise en charge', { 'Sec-WebSocket-Version': '13' });
  const key = String(h['sec-websocket-key'] || '').trim();
  if (!KEY.test(key)) return refusal(400, 'Clé WebSocket invalide');
  return { ok: true, key };
}

const validCloseCode = (c) => (c >= 1000 && c <= 1003) || (c >= 1007 && c <= 1014) || (c >= 3000 && c <= 4999);

class Connection extends EventEmitter {
  // o: { maxPayload (bytes of one message), maxBuffered (bytes waiting to be sent), allowBinary, pingMs,
  //      rateBurst, ratePerSecond (frames), closeWaitMs }
  constructor(socket, head, o = {}) {
    super();
    this.socket = socket;
    this.maxPayload = o.maxPayload || 64 * 1024;
    this.maxBuffered = o.maxBuffered || 8 * 1024 * 1024;
    this.allowBinary = o.allowBinary === true;
    this.pingMs = o.pingMs || 20000;
    this.closeWaitMs = o.closeWaitMs || CLOSE_WAIT_MS;
    this.rate = new Bucket(o.rateBurst || 400, o.ratePerSecond || 200);
    this.closed = false; // the socket is gone
    this.sentClose = false;
    this.sentCode = 0;
    this.gotClose = false;
    this.stopped = false; // nothing more is read
    this.code = 1006; // what the peer sent, 1006 when it vanished
    this.reason = '';
    this.chunks = [];
    this.len = 0;
    this.need = 2;
    this.step = 'head';
    this.hdr = null;
    this.fragments = [];
    this.fragmentOp = 0;
    this.fragmentLen = 0;
    this.lastRx = Date.now();
    this.closeTimer = null;

    socket.on('error', noop);
    socket.on('data', (chunk) => this.receive(chunk));
    socket.on('end', () => socket.end());
    socket.on('close', () => this.finish());
    socket.setNoDelay(true);
    socket.setTimeout(0);
    this.heartbeat = setInterval(() => this.tick(), this.pingMs);
    this.heartbeat.unref();
    socket.resume();
    // Bytes that came with the handshake are read once the caller has had the chance to listen for messages.
    if (head && head.length) {
      this.chunks.push(head);
      this.len += head.length;
      process.nextTick(() => this.drain());
    }
  }

  // Bytes written to the socket and not yet flushed.
  get buffered() {
    return this.socket.writableLength;
  }

  sendText(text, cb) {
    return this.data(OP_TEXT, Buffer.from(String(text), 'utf8'), cb);
  }

  sendBinary(buf, cb) {
    return this.data(OP_BINARY, buf, cb);
  }

  data(op, payload, cb) {
    if (this.sentClose) {
      if (cb) cb(false);
      return false;
    }
    return this.put(op, payload, cb);
  }

  // Starts the closing handshake; the socket is dropped if the peer does not answer in time.
  close(code = 1000, reason = '') {
    if (this.closed || this.sentClose) return;
    this.sendClose(code, reason);
    this.armCloseTimer();
  }

  terminate() {
    this.socket.destroy();
  }

  // ---------- sending ----------
  put(op, payload, cb) {
    const s = this.socket;
    if (this.closed || s.destroyed || !s.writable) {
      if (cb) cb(false);
      return false;
    }
    // A peer that does not read must not make the memory grow.
    if (s.writableLength > this.maxBuffered) {
      s.destroy();
      if (cb) cb(false);
      return false;
    }
    const n = payload.length;
    let head;
    if (n < 126) {
      head = Buffer.allocUnsafe(2);
      head[1] = n;
    } else if (n < 65536) {
      head = Buffer.allocUnsafe(4);
      head[1] = 126;
      head.writeUInt16BE(n, 2);
    } else {
      head = Buffer.allocUnsafe(10);
      head[1] = 127;
      head.writeUInt32BE(Math.floor(n / 4294967296), 2);
      head.writeUInt32BE(n >>> 0, 6);
    }
    head[0] = 0x80 | op;
    s.cork();
    s.write(head);
    s.write(payload, cb ? (err) => cb(!err) : undefined);
    s.uncork();
    return true;
  }

  sendClose(code, reason) {
    const text = Buffer.from(String(reason || ''), 'utf8');
    let end = Math.min(text.length, MAX_REASON_BYTES);
    // never cut a character in two
    while (end > 0 && end < text.length && (text[end] & 0xc0) === 0x80) end--;
    const payload = Buffer.allocUnsafe(2 + end);
    payload.writeUInt16BE(code, 0);
    text.copy(payload, 2, 0, end);
    this.sentClose = true;
    this.sentCode = code;
    this.put(OP_CLOSE, payload);
  }

  armCloseTimer() {
    if (this.closeTimer) return;
    this.closeTimer = setTimeout(() => this.socket.destroy(), this.closeWaitMs);
    this.closeTimer.unref();
  }

  tick() {
    if (this.closed) return;
    // The peer answers pings by itself: nothing at all for this long means that it is gone.
    if (Date.now() - this.lastRx > this.pingMs * 2.5) {
      this.socket.destroy();
      return;
    }
    if (!this.sentClose && this.socket.writableLength < MAX_CONTROL_ECHO_BUFFER) this.put(OP_PING, EMPTY);
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.closeTimer);
    this.chunks = [];
    this.fragments = [];
    this.len = 0;
    this.emit('close', this.code, this.reason);
  }

  // A violation: the connection is closed with the given code and nothing else is read.
  fail(code, reason) {
    this.stopped = true;
    this.chunks = [];
    this.len = 0;
    this.fragments = [];
    if (!this.sentClose) this.sendClose(code, reason);
    this.socket.end();
    this.armCloseTimer();
  }

  // ---------- receiving ----------
  receive(chunk) {
    if (this.stopped || this.closed) return;
    this.lastRx = Date.now();
    this.chunks.push(chunk);
    this.len += chunk.length;
    this.drain();
  }

  drain() {
    while (!this.stopped && !this.closed && this.len >= this.need) this.advance();
  }

  // Removes exactly n bytes from the queue.
  take(n) {
    if (n === 0) return EMPTY;
    const first = this.chunks[0];
    this.len -= n;
    if (first.length === n) {
      this.chunks.shift();
      return first;
    }
    if (first.length > n) {
      this.chunks[0] = first.subarray(n);
      return first.subarray(0, n);
    }
    const out = Buffer.allocUnsafe(n);
    let at = 0;
    while (at < n) {
      const c = this.chunks[0];
      const k = Math.min(c.length, n - at);
      c.copy(out, at, 0, k);
      at += k;
      if (k === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(k);
    }
    return out;
  }

  advance() {
    switch (this.step) {
      case 'head':
        return this.readHead(this.take(2));
      case 'len16': {
        const n = this.take(2).readUInt16BE(0);
        if (n < 126) return this.fail(1002, 'Longueur non minimale');
        return this.gotLength(n);
      }
      case 'len64': {
        const b = this.take(8);
        const hi = b.readUInt32BE(0);
        const lo = b.readUInt32BE(4);
        if (hi & 0x80000000) return this.fail(1002, 'Longueur invalide');
        if (hi > 0) return this.fail(1009, 'Message trop volumineux');
        if (lo < 65536) return this.fail(1002, 'Longueur non minimale');
        return this.gotLength(lo);
      }
      case 'mask':
        this.hdr.mask = this.take(4);
        this.step = 'payload';
        this.need = this.hdr.len;
        return undefined;
      default: {
        const h = this.hdr;
        const payload = this.take(h.len);
        const mask = h.mask;
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        this.hdr = null;
        this.step = 'head';
        this.need = 2;
        return this.dispatch(h.fin, h.op, payload);
      }
    }
  }

  readHead(b) {
    const fin = (b[0] & 0x80) !== 0;
    const op = b[0] & 0x0f;
    if (b[0] & 0x70) return this.fail(1002, 'Bits réservés non pris en charge');
    // Every frame from a client is masked.
    if (!(b[1] & 0x80)) return this.fail(1002, 'Trame non masquée');
    const control = op >= 0x8;
    if (control ? op !== OP_CLOSE && op !== OP_PING && op !== OP_PONG : op > OP_BINARY) return this.fail(1002, 'Opcode inconnu');
    const len = b[1] & 0x7f;
    if (control && (!fin || len > 125)) return this.fail(1002, 'Trame de contrôle invalide');
    if (!control) {
      if (op === OP_CONT) {
        if (!this.fragmentOp) return this.fail(1002, 'Suite de message inattendue');
      } else if (this.fragmentOp) {
        return this.fail(1002, 'Message fragmenté interrompu');
      }
    }
    this.hdr = { fin, op, control, len, mask: null };
    if (len === 126) {
      this.step = 'len16';
      this.need = 2;
      return undefined;
    }
    if (len === 127) {
      this.step = 'len64';
      this.need = 8;
      return undefined;
    }
    return this.gotLength(len);
  }

  gotLength(len) {
    const h = this.hdr;
    if (len > this.maxPayload || (!h.control && this.fragmentLen + len > this.maxPayload)) return this.fail(1009, 'Message trop volumineux');
    h.len = len;
    this.step = 'mask';
    this.need = 4;
    return undefined;
  }

  dispatch(fin, op, payload) {
    if (!this.rate.take()) return this.fail(1008, 'Trop de messages');
    if (op === OP_PING) {
      if (!this.sentClose && this.socket.writableLength < MAX_CONTROL_ECHO_BUFFER) this.put(OP_PONG, payload);
      return undefined;
    }
    if (op === OP_PONG) return undefined;
    if (op === OP_CLOSE) return this.onCloseFrame(payload);
    return this.collect(fin, op, payload);
  }

  onCloseFrame(payload) {
    let code = 1005;
    let reason = '';
    if (payload.length === 1) return this.fail(1002, 'Trame de fermeture invalide');
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      if (!validCloseCode(code)) return this.fail(1002, 'Code de fermeture invalide');
      const text = payload.subarray(2);
      if (!isUtf8(text)) return this.fail(1007, 'Motif de fermeture invalide');
      reason = text.toString('utf8');
    }
    this.gotClose = true;
    this.code = code;
    this.reason = reason;
    this.stopped = true;
    this.chunks = [];
    this.len = 0;
    if (!this.sentClose) this.sendClose(code === 1005 ? 1000 : code, '');
    this.socket.end();
    this.armCloseTimer();
    return undefined;
  }

  collect(fin, op, payload) {
    // After our own close frame the peer's messages are of no use any more.
    if (this.sentClose) return undefined;
    if (op !== OP_CONT) {
      this.fragmentOp = op;
      this.fragments = [];
      this.fragmentLen = 0;
    }
    this.fragments.push(payload);
    this.fragmentLen += payload.length;
    if (!fin) return undefined;
    const data = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments, this.fragmentLen);
    const kind = this.fragmentOp;
    this.fragmentOp = 0;
    this.fragments = [];
    this.fragmentLen = 0;
    if (kind === OP_TEXT) {
      if (!isUtf8(data)) return this.fail(1007, 'Texte invalide');
    } else if (!this.allowBinary) {
      return this.fail(1003, 'Données binaires non prises en charge');
    }
    try {
      this.emit('message', kind === OP_TEXT ? data.toString('utf8') : data, kind === OP_BINARY);
    } catch {
      this.fail(1011, 'Erreur interne');
    }
    return undefined;
  }
}

// Completes the handshake of an upgrade request and returns the connection, or answers an error and returns null.
// The caller has already decided that this request may be upgraded (login, origin, limits).
function upgrade(req, socket, head, opts) {
  const check = checkUpgrade(req);
  if (!check.ok) {
    reject(socket, check.status, check.text, check.headers);
    return null;
  }
  socket.on('error', noop);
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(check.key)}\r\n\r\n`);
  return new Connection(socket, head, opts);
}

module.exports = { Connection, upgrade, reject, checkUpgrade, acceptKey, validCloseCode, Bucket, GUID };
