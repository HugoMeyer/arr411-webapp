'use strict';
// A bare WebSocket client for the tests. Unlike the WebSocket of Node it can send any header (Cookie, Origin …) and any
// frame, well-formed or not, and it shows exactly what the server answered.
const net = require('node:net');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const OP = { cont: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 };
const noop = () => {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, ms = 3000, label = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await sleep(5);
  }
}

// One frame as bytes. Options: fin, rsv (0–7), mask (false = not masked), maskKey, wide (7, 16 or 64: the length encoding),
// declared (the length announced in the header, when it must differ from the real one; a number or a BigInt).
function encode(op, payload, o = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  const masked = o.mask !== false;
  const declared = o.declared === undefined ? body.length : o.declared;
  const n = typeof declared === 'bigint' ? declared : BigInt(declared);
  const wide = o.wide || (n < 126n ? 7 : n < 65536n ? 16 : 64);
  const b0 = (o.fin === false ? 0 : 0x80) | ((o.rsv || 0) << 4) | op;
  const m = masked ? 0x80 : 0;
  let head;
  if (wide === 7) {
    head = Buffer.from([b0, m | Number(n)]);
  } else if (wide === 16) {
    head = Buffer.alloc(4);
    head[0] = b0;
    head[1] = m | 126;
    head.writeUInt16BE(Number(n), 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = b0;
    head[1] = m | 127;
    head.writeBigUInt64BE(n, 2);
  }
  if (!masked) return Buffer.concat([head, body]);
  const key = o.maskKey || crypto.randomBytes(4);
  const out = Buffer.from(body);
  for (let i = 0; i < out.length; i++) out[i] ^= key[i & 3];
  return Buffer.concat([head, key, out]);
}

const closePayload = (code, reason = '') => {
  if (code === undefined) return Buffer.alloc(0);
  const text = Buffer.isBuffer(reason) ? reason : Buffer.from(reason);
  const out = Buffer.alloc(2 + text.length);
  out.writeUInt16BE(code, 0);
  text.copy(out, 2);
  return out;
};

// The connection once it is upgraded: frames written to it, frames read from it.
class Peer extends EventEmitter {
  constructor(socket, head, o = {}) {
    super();
    this.socket = socket;
    this.autoPong = o.autoPong !== false;
    this.buf = Buffer.alloc(0);
    this.queue = []; // data and close frames not yet read by the test
    this.pings = [];
    this.pongs = [];
    this.ended = false;
    socket.on('error', noop);
    socket.on('data', (d) => this.feed(d));
    socket.on('close', () => {
      this.ended = true;
      this.emit('end');
    });
    if (head && head.length) this.feed(head);
  }

  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      let len = b[1] & 0x7f;
      let at = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = Number(b.readBigUInt64BE(2));
        at = 10;
      }
      if (b.length < at + len) return;
      const frame = { fin: !!(b[0] & 0x80), rsv: (b[0] >> 4) & 7, op: b[0] & 0x0f, masked: !!(b[1] & 0x80), payload: Buffer.from(b.subarray(at, at + len)) };
      this.buf = b.subarray(at + len);
      if (frame.op === OP.ping) {
        this.pings.push(frame.payload);
        if (this.autoPong) this.pong(frame.payload);
      } else if (frame.op === OP.pong) {
        this.pongs.push(frame.payload);
      } else {
        this.queue.push(frame);
        this.emit('frame');
      }
    }
  }

  raw(bytes) {
    this.socket.write(bytes);
  }

  send(op, payload, o) {
    this.raw(encode(op, payload, o));
  }

  text(s, o) {
    this.send(OP.text, Buffer.from(s), o);
  }

  binary(b, o) {
    this.send(OP.binary, b, o);
  }

  ping(p, o) {
    this.send(OP.ping, p, o);
  }

  pong(p, o) {
    this.send(OP.pong, p, o);
  }

  close(code, reason, o) {
    this.send(OP.close, closePayload(code, reason), o);
  }

  next(ms = 3000) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.ended) return Promise.reject(new Error('connection closed'));
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.off('frame', onFrame);
        this.off('end', onEnd);
      };
      const onFrame = () => {
        done();
        resolve(this.queue.shift());
      };
      const onEnd = () => {
        done();
        reject(new Error('connection closed'));
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`no frame within ${ms} ms`));
      }, ms);
      this.on('frame', onFrame);
      this.on('end', onEnd);
    });
  }

  // The next frame, which must be a close frame: { code, reason } (code 1005 when it carries none).
  async expectClose(ms = 3000) {
    const f = await this.next(ms);
    if (f.op !== OP.close) throw new Error(`expected a close frame, got opcode ${f.op}`);
    return { code: f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005, reason: f.payload.subarray(2).toString('utf8') };
  }

  whenEnded(ms = 3000) {
    if (this.ended) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`connection still open after ${ms} ms`)), ms);
      this.once('end', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  destroy() {
    this.socket.destroy();
  }
}

// Opens a connection and reads the answer to the handshake. Resolves { status, headers, body, key, peer }: `peer` is set only
// when the server switched protocols; otherwise the body is what it answered before closing. Status 0 = closed without a word.
// Options: path, method, httpVersion, headers (a null value removes a header), key, trail (bytes sent right after the request),
// host, autoPong.
function connect(port, o = {}) {
  const key = o.key === undefined ? crypto.randomBytes(16).toString('base64') : o.key;
  const headers = {
    Host: `127.0.0.1:${port}`,
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': key,
    ...(o.headers || {})
  };
  const lines = [`${o.method || 'GET'} ${o.path || '/'} HTTP/${o.httpVersion || '1.1'}`];
  for (const [k, v] of Object.entries(headers)) if (v !== null && v !== undefined) lines.push(`${k}: ${v}`);
  const request = Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`), o.trail || Buffer.alloc(0)]);
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, o.host || '127.0.0.1');
    let buf = Buffer.alloc(0);
    let result = null;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      socket.destroy();
      if (!settled) {
        settled = true;
        reject(new Error('no answer to the handshake'));
      }
    }, 8000);
    socket.on('error', (e) => {
      if (!settled && !result) {
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    });
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (result) {
        result.body += chunk.toString('utf8');
        return;
      }
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const lines2 = buf.subarray(0, end).toString('latin1').split('\r\n');
      const rest = buf.subarray(end + 4);
      const status = Number(lines2[0].split(' ')[1]);
      const hs = {};
      for (const line of lines2.slice(1)) {
        const i = line.indexOf(':');
        if (i > 0) hs[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      if (status === 101) {
        socket.removeListener('data', onData);
        finish({ status, headers: hs, body: '', key, peer: new Peer(socket, rest, { autoPong: o.autoPong }) });
        return;
      }
      result = { status, headers: hs, body: rest.toString('utf8'), key, peer: null };
    };
    socket.on('data', onData);
    socket.on('close', () => finish(result || { status: 0, headers: {}, body: '', key, peer: null }));
    socket.on('connect', () => socket.write(request));
  });
}

module.exports = { OP, encode, closePayload, Peer, connect, until, sleep };
