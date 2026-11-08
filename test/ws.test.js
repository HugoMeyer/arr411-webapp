'use strict';
// The WebSocket server of the C411 view: handshake, framing, the limits that protect it, closing and keep-alive.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const ws = require('../server/ws');
const { OP, encode, closePayload, connect, until, sleep } = require('./wsclient');

// A server that upgrades every request on any path and records what happens on each connection.
async function serve(opts = {}, onConn = () => {}) {
  const server = http.createServer((req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const conns = [];
  server.on('upgrade', (req, socket, head) => {
    const conn = ws.upgrade(req, socket, head, opts);
    if (!conn) return;
    conn.messages = [];
    conn.closes = [];
    conn.on('message', (data, isBinary) => conn.messages.push({ data, isBinary }));
    conn.on('close', (code, reason) => conn.closes.push({ code, reason }));
    conns.push(conn);
    onConn(conn);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    conns,
    async stop() {
      for (const c of conns) c.terminate();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    }
  };
}

async function withServer(opts, fn, onConn) {
  const s = await serve(opts, onConn);
  try {
    return await fn(s);
  } finally {
    await s.stop();
  }
}

const open = async (s, o) => {
  const r = await connect(s.port, o);
  assert.equal(r.status, 101, `handshake refused: ${r.status} ${r.body}`);
  return r.peer;
};

test('the accept key follows RFC 6455', () => {
  assert.equal(ws.acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('a valid handshake is answered with 101 and offers no extension nor sub-protocol', async () => {
  await withServer({}, async (s) => {
    const r = await connect(s.port, { headers: { 'Sec-WebSocket-Extensions': 'permessage-deflate', 'Sec-WebSocket-Protocol': 'chat' } });
    assert.equal(r.status, 101);
    assert.equal(r.headers.upgrade, 'websocket');
    assert.equal(r.headers.connection, 'Upgrade');
    assert.equal(r.headers['sec-websocket-accept'], ws.acceptKey(r.key));
    assert.equal(r.headers['sec-websocket-extensions'], undefined);
    assert.equal(r.headers['sec-websocket-protocol'], undefined);
    r.peer.destroy();
  });
});

test('a handshake that is not a proper WebSocket request is refused before anything is upgraded', async () => {
  await withServer({}, async (s) => {
    const cases = [
      ['a wrong version', { headers: { 'Sec-WebSocket-Version': '8' } }, 426, { 'sec-websocket-version': '13' }],
      ['no version', { headers: { 'Sec-WebSocket-Version': null } }, 426],
      ['no key', { headers: { 'Sec-WebSocket-Key': null } }, 400],
      ['a short key', { key: 'abcd' }, 400],
      ['a key that is not base64', { key: '!!!!!!!!!!!!!!!!!!!!!!==' }, 400],
      ['a long key', { key: 'A'.repeat(40) + '==' }, 400],
      ['another protocol', { headers: { Upgrade: 'h2c' } }, 400],
      ['a method other than GET', { method: 'POST', headers: { 'Content-Length': '0' } }, 405, { allow: 'GET' }]
    ];
    for (const [name, o, status, headers] of cases) {
      const r = await connect(s.port, o);
      assert.equal(r.status, status, name);
      assert.equal(r.peer, null, name);
      assert.equal(r.headers.connection, 'close', name);
      for (const [k, v] of Object.entries(headers || {})) assert.equal(r.headers[k], v, `${name}: ${k}`);
    }
    assert.equal(s.conns.length, 0);
  });
});

test('checkUpgrade is strict about every part of the request', () => {
  const good = { method: 'GET', httpVersion: '1.1', headers: { upgrade: 'WebSocket', connection: 'keep-alive, Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } };
  assert.deepEqual(ws.checkUpgrade(good), { ok: true, key: 'dGhlIHNhbXBsZSBub25jZQ==' });
  const bad = (patch, status) => {
    const req = { ...good, ...patch, headers: { ...good.headers, ...(patch.headers || {}) } };
    const r = ws.checkUpgrade(req);
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.equal(r.status, status, JSON.stringify(patch));
  };
  bad({ method: 'POST' }, 405);
  bad({ method: 'HEAD' }, 405);
  bad({ httpVersion: '1.0' }, 400);
  bad({ headers: { upgrade: undefined } }, 400);
  bad({ headers: { upgrade: 'websocket2' } }, 400);
  bad({ headers: { connection: 'keep-alive' } }, 400);
  bad({ headers: { connection: undefined } }, 400);
  bad({ headers: { 'sec-websocket-version': '12' } }, 426);
  bad({ headers: { 'sec-websocket-version': undefined } }, 426);
  bad({ headers: { 'sec-websocket-key': undefined } }, 400);
  bad({ headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ' } }, 400);
});

test('answers written on an upgrade socket cannot be split by a hostile value', async () => {
  const sock = new PassThrough();
  let out = '';
  sock.setEncoding('utf8');
  sock.on('data', (d) => (out += d));
  ws.reject(sock, 403, 'Origine\r\nX-Injected: 1', { 'X-Test': 'a\r\nInjected: 1\0' });
  await until(() => out.includes('\r\n\r\n'));
  const [head, body] = out.split('\r\n\r\n');
  const lines = head.split('\r\n');
  assert.equal(lines[0], 'HTTP/1.1 403 Forbidden');
  assert.ok(!lines.some((l) => /^(Injected|X-Injected):/i.test(l)), head);
  assert.ok(lines.includes('Connection: close'));
  assert.equal(Number(lines.find((l) => l.startsWith('Content-Length:')).split(': ')[1]), Buffer.byteLength(body));
});

test('messages of any size reach the application', async () => {
  await withServer({ maxPayload: 1 << 20 }, async (s) => {
    const peer = await open(s);
    const sizes = [0, 1, 125, 126, 1000, 65535, 65536, 70000, 300000];
    for (const n of sizes) peer.text('x'.repeat(n));
    await until(() => s.conns[0].messages.length === sizes.length);
    assert.deepEqual(s.conns[0].messages.map((m) => m.data.length), sizes);
    assert.ok(s.conns[0].messages.every((m) => m.isBinary === false && typeof m.data === 'string'));
    peer.destroy();
  });
});

test('the server sends frames with 7, 16 and 64 bit lengths and binary frames', async () => {
  await withServer({}, async (s) => {
    const peer = await open(s);
    await until(() => s.conns.length);
    const conn = s.conns[0];
    const sizes = [0, 5, 125, 126, 1000, 65535, 65536, 70000];
    for (const n of sizes) conn.sendText('é'.repeat(n));
    for (const n of sizes) {
      const f = await peer.next();
      assert.equal(f.op, OP.text);
      assert.equal(f.masked, false);
      assert.equal(f.payload.toString('utf8'), 'é'.repeat(n));
    }
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    let done = null;
    conn.sendBinary(jpeg, (ok) => (done = ok));
    const f = await peer.next();
    assert.equal(f.op, OP.binary);
    assert.deepEqual(f.payload, jpeg);
    await until(() => done !== null);
    assert.equal(done, true);
    peer.destroy();
  });
});

test('a message split in fragments is reassembled, even with pings in between', async () => {
  await withServer({}, async (s) => {
    const peer = await open(s);
    peer.send(OP.text, 'Hel', { fin: false });
    peer.ping('between');
    peer.send(OP.cont, 'lo ', { fin: false });
    peer.send(OP.cont, 'wor', { fin: false });
    peer.send(OP.cont, 'ld');
    peer.text('next');
    await until(() => s.conns[0].messages.length === 2);
    assert.deepEqual(s.conns[0].messages.map((m) => m.data), ['Hello world', 'next']);
    await until(() => peer.pongs.length === 1);
    assert.equal(peer.pongs[0].toString(), 'between');
    peer.destroy();
  });
});

test('UTF-8 is checked on the whole message, not on each fragment', async () => {
  await withServer({}, async (s) => {
    const peer = await open(s);
    const euro = Buffer.from('€'); // e2 82 ac
    peer.send(OP.text, euro.subarray(0, 2), { fin: false });
    peer.send(OP.cont, euro.subarray(2));
    await until(() => s.conns[0].messages.length === 1);
    assert.equal(s.conns[0].messages[0].data, '€');
    peer.destroy();
  });
});

test('data arriving with the handshake, in tiny pieces or glued together is parsed the same way', async () => {
  await withServer({}, async (s) => {
    const first = encode(OP.text, 'with the handshake');
    const r = await connect(s.port, { trail: first });
    assert.equal(r.status, 101);
    await until(() => s.conns[0] && s.conns[0].messages.length === 1);
    assert.equal(s.conns[0].messages[0].data, 'with the handshake');

    const peer = r.peer;
    const slow = encode(OP.text, 'one byte at a time');
    for (const b of slow) {
      peer.raw(Buffer.from([b]));
      await sleep(1);
    }
    peer.raw(Buffer.concat([encode(OP.text, 'a'), encode(OP.ping, 'p'), encode(OP.text, 'b'), encode(OP.text, 'c')]));
    await until(() => s.conns[0].messages.length === 5);
    assert.deepEqual(s.conns[0].messages.map((m) => m.data), ['with the handshake', 'one byte at a time', 'a', 'b', 'c']);
    await until(() => peer.pongs.length === 1);
    peer.destroy();
  });
});

test('a large message sent in many small TCP chunks is delivered whole', async () => {
  await withServer({ maxPayload: 1 << 20 }, async (s) => {
    const peer = await open(s);
    const body = 'abcdefghij'.repeat(30000);
    const bytes = encode(OP.text, body);
    for (let i = 0; i < bytes.length; i += 1000) peer.raw(bytes.subarray(i, i + 1000));
    await until(() => s.conns[0].messages.length === 1, 5000);
    assert.equal(s.conns[0].messages[0].data, body);
    peer.destroy();
  });
});

test('binary messages are refused unless the application accepts them', async () => {
  await withServer({}, async (s) => {
    const peer = await open(s);
    peer.binary(Buffer.from([1, 2, 3]));
    assert.equal((await peer.expectClose()).code, 1003);
    await peer.whenEnded();
    assert.equal(s.conns[0].messages.length, 0);
  });
  await withServer({ allowBinary: true }, async (s) => {
    const peer = await open(s);
    peer.binary(Buffer.from([1, 2, 3]));
    await until(() => s.conns[0].messages.length === 1);
    assert.equal(s.conns[0].messages[0].isBinary, true);
    assert.deepEqual(s.conns[0].messages[0].data, Buffer.from([1, 2, 3]));
    peer.destroy();
  });
});

const violations = [
  ['a frame that is not masked', (p) => p.text('hi', { mask: false }), 1002],
  ['the first reserved bit', (p) => p.text('hi', { rsv: 4 }), 1002],
  ['the second reserved bit', (p) => p.text('hi', { rsv: 2 }), 1002],
  ['the third reserved bit', (p) => p.text('hi', { rsv: 1 }), 1002],
  ['an unknown data opcode', (p) => p.send(3, 'x'), 1002],
  ['an unknown data opcode (7)', (p) => p.send(7, 'x'), 1002],
  ['an unknown control opcode', (p) => p.send(0xb, 'x'), 1002],
  ['an unknown control opcode (15)', (p) => p.send(0xf, ''), 1002],
  ['a fragmented ping', (p) => p.ping('x', { fin: false }), 1002],
  ['a fragmented close', (p) => p.send(OP.close, closePayload(1000), { fin: false }), 1002],
  ['a ping of 126 bytes', (p) => p.ping(Buffer.alloc(126), { wide: 16 }), 1002],
  ['a continuation with nothing to continue', (p) => p.send(OP.cont, 'x'), 1002],
  ['a new message in the middle of a fragmented one', (p) => (p.send(OP.text, 'a', { fin: false }), p.text('b')), 1002],
  ['a binary message in the middle of a fragmented one', (p) => (p.send(OP.text, 'a', { fin: false }), p.binary(Buffer.from('b'))), 1002],
  ['a 16 bit length that could have been 7 bit', (p) => p.text('y'.repeat(100), { wide: 16 }), 1002],
  ['a 64 bit length that could have been 16 bit', (p) => p.text('y'.repeat(1000), { wide: 64 }), 1002],
  ['a 64 bit length with the top bit set', (p) => p.text('', { wide: 64, declared: 2n ** 63n }), 1002],
  ['a 64 bit length over 4 GiB', (p) => p.text('', { wide: 64, declared: 2n ** 33n }), 1009],
  ['a length of 1 GiB, announced without a body', (p) => p.text('', { declared: 1 << 30 }), 1009],
  ['a length just over the limit', (p) => p.text('', { declared: 1001 }), 1009],
  ['fragments that add up to more than the limit', (p) => (p.send(OP.text, 'a'.repeat(600), { fin: false }), p.send(OP.cont, 'b'.repeat(600))), 1009],
  ['a text that is not UTF-8 (overlong)', (p) => p.send(OP.text, Buffer.from([0xc0, 0xaf])), 1007],
  ['a text that is not UTF-8 (surrogate)', (p) => p.send(OP.text, Buffer.from([0xed, 0xa0, 0x80])), 1007],
  ['a text that stops in the middle of a character', (p) => p.send(OP.text, Buffer.from([0x61, 0xe2, 0x82])), 1007],
  ['a close frame with one byte', (p) => p.send(OP.close, Buffer.from([0x03])), 1002],
  ['a close frame with a reason that is not UTF-8', (p) => p.send(OP.close, closePayload(1000, Buffer.from([0xff, 0xfe]))), 1007]
];
for (const code of [0, 999, 1004, 1005, 1006, 1015, 1016, 2999, 5000, 65535]) {
  violations.push([`a close frame with the invalid code ${code}`, (p) => p.close(code), 1002]);
}

test('every protocol violation closes the connection with the right code and nothing more is read', async () => {
  await withServer({ maxPayload: 1000 }, async (s) => {
    for (const [name, send, code] of violations) {
      const peer = await open(s);
      send(peer);
      peer.text('after the violation');
      const got = await peer.expectClose();
      assert.equal(got.code, code, name);
      await peer.whenEnded();
      assert.equal(peer.queue.length, 0, name);
      const conn = s.conns[s.conns.length - 1];
      assert.deepEqual(conn.messages, [], name);
      await until(() => conn.closes.length === 1, 2000, name);
    }
  });
});

test('a valid close handshake is echoed and the application learns the code', async () => {
  await withServer({}, async (s) => {
    for (const code of [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 3000, 4000, 4999]) {
      const peer = await open(s);
      peer.close(code, 'au revoir');
      const got = await peer.expectClose();
      assert.equal(got.code, code);
      assert.equal(got.reason, '');
      await peer.whenEnded();
      const conn = s.conns[s.conns.length - 1];
      await until(() => conn.closes.length === 1);
      assert.deepEqual(conn.closes[0], { code, reason: 'au revoir' });
    }
    const peer = await open(s);
    peer.close();
    assert.deepEqual(await peer.expectClose(), { code: 1000, reason: '' });
    await peer.whenEnded();
    await until(() => s.conns[s.conns.length - 1].closes.length === 1);
    assert.equal(s.conns[s.conns.length - 1].closes[0].code, 1005);
  });
});

test('when the server closes, the reason is cut on a character boundary and the peer answers', async () => {
  await withServer({}, async (s) => {
    const peer = await open(s);
    await until(() => s.conns.length);
    const conn = s.conns[0];
    conn.close(4000, 'é'.repeat(100));
    const got = await peer.expectClose();
    assert.equal(got.code, 4000);
    assert.equal(got.reason, 'é'.repeat(61));
    assert.equal(conn.sendText('late'), false);
    let ok = null;
    conn.sendBinary(Buffer.from('late'), (v) => (ok = v));
    assert.equal(ok, false);
    peer.close(4000);
    await peer.whenEnded();
    await until(() => conn.closes.length === 1);
    assert.equal(conn.closes[0].code, 4000);
    // closing twice is harmless
    conn.close(1000);
    assert.equal(conn.closes.length, 1);
  });
});

test('a peer that never answers the closing handshake is dropped', async () => {
  await withServer({ closeWaitMs: 100 }, async (s) => {
    const peer = await open(s);
    await until(() => s.conns.length);
    s.conns[0].close(1001, 'bye');
    assert.equal((await peer.expectClose()).code, 1001);
    await peer.whenEnded(2000);
    await until(() => s.conns[0].closes.length === 1);
    assert.equal(s.conns[0].closes[0].code, 1006);
  });
});

test('after a close frame from the server, what the peer still sends is ignored', async () => {
  await withServer({}, async (s) => {
    const peer = await open(s);
    await until(() => s.conns.length);
    s.conns[0].close(1000);
    peer.text('too late');
    peer.close(1000);
    await peer.whenEnded();
    assert.deepEqual(s.conns[0].messages, []);
  });
});

test('pings are answered with the same payload and unsolicited pongs are ignored', async () => {
  await withServer({}, async (s) => {
    const peer = await open(s);
    peer.ping('hello');
    peer.ping('');
    peer.ping(Buffer.alloc(125, 7));
    peer.pong('unsolicited');
    peer.text('still here');
    await until(() => peer.pongs.length === 3);
    assert.equal(peer.pongs[0].toString(), 'hello');
    assert.equal(peer.pongs[1].length, 0);
    assert.deepEqual(peer.pongs[2], Buffer.alloc(125, 7));
    await until(() => s.conns[0].messages.length === 1);
    assert.deepEqual(s.conns[0].messages.map((m) => m.data), ['still here']);
    peer.destroy();
  });
});

test('a peer that sends too fast is closed with 1008', async () => {
  await withServer({ rateBurst: 5, ratePerSecond: 1 }, async (s) => {
    const peer = await open(s);
    for (let i = 0; i < 30; i++) peer.text(`m${i}`);
    assert.equal((await peer.expectClose()).code, 1008);
    await peer.whenEnded();
    assert.ok(s.conns[0].messages.length <= 5);
  });
  await withServer({ rateBurst: 5, ratePerSecond: 100 }, async (s) => {
    const peer = await open(s);
    for (let i = 0; i < 20; i++) {
      peer.text(`m${i}`);
      await sleep(25);
    }
    await until(() => s.conns[0].messages.length === 20);
    assert.equal(peer.ended, false);
    peer.destroy();
  });
});

test('pings cannot be used to bypass the rate limit', async () => {
  await withServer({ rateBurst: 5, ratePerSecond: 1 }, async (s) => {
    const peer = await open(s);
    for (let i = 0; i < 30; i++) peer.ping('x');
    assert.equal((await peer.expectClose()).code, 1008);
    await peer.whenEnded();
  });
});

test('a peer that stops reading does not make the memory of the server grow', async () => {
  await withServer({ maxBuffered: 200000 }, async (s) => {
    const peer = await open(s);
    await until(() => s.conns.length);
    const conn = s.conns[0];
    peer.socket.pause();
    const chunk = Buffer.alloc(256 * 1024, 1);
    let refused = 0;
    let peak = 0;
    for (let i = 0; i < 400 && !conn.closed; i++) {
      conn.sendBinary(chunk, (ok) => {
        if (!ok) refused++;
      });
      peak = Math.max(peak, conn.buffered);
      await sleep(1);
    }
    await until(() => conn.closes.length === 1, 5000);
    assert.ok(conn.closed);
    assert.ok(peak < 200000 + 2 * chunk.length, `peak ${peak}`);
    assert.equal(conn.sendBinary(chunk), false);
    peer.destroy();
  });
});

test('the callback of a send tells when the frame was written', async () => {
  await withServer({}, async (s) => {
    const peer = await open(s);
    await until(() => s.conns.length);
    const results = [];
    for (let i = 0; i < 5; i++) s.conns[0].sendBinary(Buffer.alloc(1000, i), (ok) => results.push(ok));
    await until(() => results.length === 5);
    assert.deepEqual(results, [true, true, true, true, true]);
    for (let i = 0; i < 5; i++) assert.equal((await peer.next()).payload[0], i);
    peer.destroy();
  });
});

test('the server pings, drops a peer that stays silent and keeps one that answers', async () => {
  await withServer({ pingMs: 40 }, async (s) => {
    const silent = await open(s, { autoPong: false });
    await until(() => silent.pings.length >= 1, 1000);
    await until(() => s.conns[0].closes.length === 1, 1500);
    assert.equal(s.conns[0].closes[0].code, 1006);
    await silent.whenEnded();

    const alive = await open(s);
    const conn = s.conns[1];
    await sleep(400);
    assert.equal(conn.closed, false);
    assert.ok(alive.pings.length >= 3, `pings ${alive.pings.length}`);
    alive.destroy();
    await until(() => conn.closes.length === 1);
  });
});

test('a peer that vanishes is reported as an abnormal closure', async () => {
  await withServer({}, async (s) => {
    const peer = await open(s);
    await until(() => s.conns.length);
    peer.destroy();
    await until(() => s.conns[0].closes.length === 1);
    assert.deepEqual(s.conns[0].closes[0], { code: 1006, reason: '' });
    assert.equal(s.conns[0].closed, true);
  });
});

test('an exception in a message handler closes the connection instead of crashing the server', async () => {
  await withServer({}, async (s) => {
    const peer = await open(s);
    await until(() => s.conns.length);
    s.conns[0].on('message', () => {
      throw new Error('boom');
    });
    peer.text('go');
    assert.equal((await peer.expectClose()).code, 1011);
    await peer.whenEnded();
  });
});

test('the rate bucket allows a burst and then refills', async () => {
  const b = new ws.Bucket(3, 1000);
  assert.deepEqual([b.take(), b.take(), b.take(), b.take()], [true, true, true, false]);
  await sleep(20);
  assert.equal(b.take(), true);
});
