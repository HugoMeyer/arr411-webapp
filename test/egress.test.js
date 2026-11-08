'use strict';
// Filtered CONNECT proxy: address classification, CONNECT targets, policy and tunnel.
// Everything is offline: a local echo server stands for the Internet and the DNS answers are injected.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const path = require('node:path');
const { createMatcher, normalizeHost } = require('../server/c411/hosts');
const egress = require('../server/egress');

const { createEgressProxy, isPublicIp, classifyIp, parseConnectTarget } = egress;
const ROOT = path.join(__dirname, '..');
const POSIX = process.platform !== 'win32';
const LIMIT = { timeout: 30000 };
const PUBLIC_V4 = '93.184.216.34';
const PUBLIC_V6 = '2606:4700:4700::1111';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PUBLIC = [
  '1.0.0.0', '1.1.1.1', '8.8.8.8', '9.255.255.255', '11.0.0.0', '93.184.216.34', '100.63.255.255', '100.128.0.0', '126.255.255.255',
  '128.0.0.0', '169.253.255.255', '169.255.0.0', '172.15.255.255', '172.32.0.0', '192.0.1.0', '192.0.3.0', '192.88.98.255',
  '192.88.100.0', '192.167.255.255', '192.169.0.0', '198.17.255.255', '198.20.0.0', '198.51.99.255', '198.51.101.0',
  '203.0.112.255', '203.0.114.0', '223.255.255.255',
  '2606:4700:4700::1111', '2a00:1450:4001:81b::200e', '2001:4860:4860::8888', '2400:cb00:2048:1::c629:d7a2', '2620:fe::fe',
  '2001:200::1', '2001:db7:ffff::1', '2001:db9::1', '::ffff:8.8.8.8', '::ffff:808:808', '::ffff:5db8:d822', '64:ff9b::8.8.8.8',
  '64:ff9b::808:808', '2002:808:808::1', '2002:5db8:d822::1'
];

const NON_PUBLIC = [
  ['0.0.0.0', 'unspecified'], ['0.1.2.3', 'unspecified'], ['0.255.255.255', 'unspecified'],
  ['10.0.0.0', 'private'], ['10.1.2.3', 'private'], ['10.255.255.255', 'private'],
  ['100.64.0.0', 'cgnat'], ['100.100.100.100', 'cgnat'], ['100.127.255.255', 'cgnat'],
  ['127.0.0.0', 'loopback'], ['127.0.0.1', 'loopback'], ['127.255.255.255', 'loopback'],
  ['169.254.0.0', 'link-local'], ['169.254.169.254', 'link-local'], ['169.254.255.255', 'link-local'],
  ['172.16.0.0', 'private'], ['172.20.1.1', 'private'], ['172.31.255.255', 'private'],
  ['192.0.0.0', 'reserved'], ['192.0.0.255', 'reserved'],
  ['192.0.2.0', 'documentation'], ['192.0.2.255', 'documentation'],
  ['192.88.99.0', 'reserved'], ['192.88.99.255', 'reserved'],
  ['192.168.0.0', 'private'], ['192.168.1.1', 'private'], ['192.168.255.255', 'private'],
  ['198.18.0.0', 'benchmarking'], ['198.19.255.255', 'benchmarking'],
  ['198.51.100.0', 'documentation'], ['198.51.100.255', 'documentation'],
  ['203.0.113.0', 'documentation'], ['203.0.113.255', 'documentation'],
  ['224.0.0.0', 'multicast'], ['224.0.0.251', 'multicast'], ['239.255.255.255', 'multicast'],
  ['240.0.0.0', 'reserved'], ['250.1.2.3', 'reserved'], ['255.255.255.254', 'reserved'],
  ['255.255.255.255', 'broadcast'],
  ['::', 'unspecified'], ['0:0:0:0:0:0:0:0', 'unspecified'],
  ['::1', 'loopback'], ['0:0:0:0:0:0:0:1', 'loopback'], ['0000:0000:0000:0000:0000:0000:0000:0001', 'loopback'], ['::0001', 'loopback'],
  ['::2', 'reserved'], ['::7f00:1', 'reserved'], ['::127.0.0.1', 'reserved'], ['::1.2.3.4', 'reserved'], ['::808:808', 'reserved'],
  ['::ffff:0.0.0.0', 'unspecified'], ['::ffff:127.0.0.1', 'loopback'], ['::ffff:7f00:1', 'loopback'], ['::FFFF:7F00:0001', 'loopback'],
  ['0:0:0:0:0:ffff:7f00:1', 'loopback'], ['0:0:0:0:0:ffff:127.0.0.1', 'loopback'], ['::0:ffff:7f00:1', 'loopback'],
  ['::ffff:10.0.0.1', 'private'], ['::ffff:a00:1', 'private'], ['::ffff:172.16.0.1', 'private'], ['::ffff:192.168.1.1', 'private'],
  ['::ffff:c0a8:101', 'private'], ['::ffff:169.254.169.254', 'link-local'], ['::ffff:a9fe:a9fe', 'link-local'],
  ['::ffff:100.64.0.1', 'cgnat'], ['::ffff:224.0.0.1', 'multicast'], ['::ffff:255.255.255.255', 'broadcast'],
  ['::ffff:0:7f00:1', 'reserved'],
  ['64:ff9b::', 'unspecified'], ['64:ff9b::7f00:1', 'loopback'], ['64:ff9b::127.0.0.1', 'loopback'], ['64:ff9b::a00:1', 'private'],
  ['64:ff9b::10.0.0.1', 'private'], ['64:ff9b::a9fe:a9fe', 'link-local'], ['64:ff9b::c0a8:1', 'private'],
  ['64:ff9b:1::', 'reserved'], ['64:ff9b:1::1', 'reserved'], ['64:ff9b:1:ffff:ffff:ffff:ffff:ffff', 'reserved'],
  ['64:ff9b:2::1', 'reserved'], ['64:ff9a::1', 'reserved'],
  ['100::', 'discard'], ['100::1', 'discard'], ['100:0:0:0:ffff:ffff:ffff:ffff', 'discard'], ['100:0:0:1::', 'reserved'],
  ['2001::', 'teredo'], ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'teredo'], ['2001:0:ffff:ffff:ffff:ffff:ffff:ffff', 'teredo'],
  ['2001:1::', 'reserved'], ['2001:2::', 'benchmarking'], ['2001:2:0:ffff::1', 'benchmarking'], ['2001:2:1::', 'reserved'],
  ['2001:10::', 'reserved'], ['2001:1f:ffff::1', 'reserved'], ['2001:20::', 'reserved'], ['2001:2f:ffff::1', 'reserved'],
  ['2001:1ff:ffff::1', 'reserved'],
  ['2001:db8::', 'documentation'], ['2001:0db8::1', 'documentation'], ['2001:db8:ffff:ffff:ffff:ffff:ffff:ffff', 'documentation'],
  ['2002::', 'unspecified'], ['2002:7f00:1::', 'loopback'], ['2002:7f00:0001:abcd::1', 'loopback'], ['2002:a00:1::1', 'private'],
  ['2002:ac10:1::1', 'private'], ['2002:c0a8:101::1', 'private'], ['2002:a9fe:a9fe::1', 'link-local'], ['2002:6440:1::1', 'cgnat'],
  ['2002:ffff:ffff::1', 'broadcast'],
  ['3fff::', 'documentation'], ['3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff', 'documentation'],
  ['fc00::', 'ula'], ['fd12:3456:789a::1', 'ula'], ['fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'ula'],
  ['fe80::', 'link-local'], ['fe80::1', 'link-local'], ['febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'link-local'],
  ['fec0::', 'site-local'], ['feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'site-local'],
  ['ff00::', 'multicast'], ['ff02::1', 'multicast'], ['ff05::1:3', 'multicast'], ['ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'multicast'],
  ['1fff::1', 'reserved'], ['4000::1', 'reserved'], ['8000::1', 'reserved'], ['c000::1', 'reserved'], ['e000::1', 'reserved'],
  ['fbff::1', 'reserved'], ['fe00::1', 'reserved'], ['fe7f::1', 'reserved']
];

const INVALID = [
  '', ' ', 'localhost', 'example.com', '1', '1.2.3', '1.2.3.4.5', '256.1.1.1', '1.2.3.256', '999.999.999.999', '01.2.3.4', '1.2.3.04',
  '1.2.3.-4', '+1.2.3.4', '1.2.3.4 ', ' 1.2.3.4', '1.2.3.4\n', '1.2.3.4\0', '1,2,3,4', '１２７.０.０.１', '127.1', '127.0.1', '0x7f.0.0.1',
  '0x7f000001', '017700000001', '2130706433', '4294967295', '0177.0.0.1', '1e2.0.0.1',
  'fe80::1%eth0', '::1%lo', '::1%', '[::1]', '[::1]:443', '::1/128', 'g::1', '::g', '12345::', ':::', '::::', '1::2::3', ':1', '1:',
  ':1:2:3:4:5:6:7', '1:2:3:4:5:6:7:', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6::7:8', '::1:2:3:4:5:6:7:8', '::ffff:1.2.3',
  '::ffff:256.1.1.1', '::ffff:01.2.3.4', '::ffff:1.2.3.4.5', '::ffff:1.2.3.4:5', '1.2.3.4::', '1.2.3.4::1', '::1.2.3.4:5',
  '::1.2.3.4.5', '::ffff:0x7f.1', '0:0:0:0:0:0:0:0:0', '1'.repeat(50), ':'.repeat(50), '::1 ', ' ::1', '::1\n', '::\0'
];

const NOT_STRINGS = [null, undefined, 4, 2130706433, true, {}, [], ['127.0.0.1'], Buffer.from('127.0.0.1'), { toString: () => '8.8.8.8' }];

const GOOD_TARGETS = [
  ['c411.org:443', 'c411.org', 443],
  ['C411.ORG:443', 'c411.org', 443],
  ['www.c411.org:443', 'www.c411.org', 443],
  ['c411.org.:443', 'c411.org', 443],
  ['challenges.cloudflare.com:443', 'challenges.cloudflare.com', 443],
  ['localhost:8080', 'localhost', 8080],
  ['a-b.c411.org:65535', 'a-b.c411.org', 65535],
  ['xn--bcher-kva.example:1', 'xn--bcher-kva.example', 1],
  ['127.0.0.1.nip.io:443', '127.0.0.1.nip.io', 443],
  ['x:80', 'x', 80]
];

const BAD_TARGETS = [
  '', 'c411.test', 'c411.test:', ':443', ':', 'c411.test:0', 'c411.test:00', 'c411.test:0443', 'c411.test:65536', 'c411.test:99999',
  'c411.test:100000', 'c411.test:-1', 'c411.test:+443', 'c411.test:44.3', 'c411.test:0x1bb', 'c411.test:https',
  ' c411.test:443', 'c411.test:443 ', 'c411.test :443', 'c411.test: 443', 'c411.test:44 3', 'c411.test:443\r\n', 'c411.test\r\n:443',
  'c411.test\0:443', 'c411.test\t:443',
  'user@c411.test:443', 'user:pw@c411.test:443', '@c411.test:443', 'c411.test:443:443', 'c411.test:443@evil.test:443',
  'c411.test@evil.test:443', 'c411.test:443@evil.test',
  '/c411.test:443', 'c411.test/:443', 'c411.test:443/', 'c411.test:443/path', 'c411.test?x=1:443', 'c411.test#x:443',
  'c411.test\\evil.test:443', 'http://c411.test:443', 'https://c411.test:443/', '//c411.test:443', '*', '*:443', '*.c411.test:443',
  'a_b.test:443', '-a.test:443', 'a-.test:443', 'a..test:443', '.a.test:443', '..:443', '.:443', 'bücher.test:443', 'ex%61mple.test:443',
  `${'a'.repeat(64)}.test:443`, `${'a.'.repeat(130)}test:443`,
  '1.2.3.4:443', '127.0.0.1:443', '0.0.0.0:443', '10.0.0.1:443', '169.254.169.254:443', '[::1]:443', '[2001:db8::1]:443',
  '[::ffff:10.0.0.1]:443', '::1:443', '::1', '2001:db8::1:443', '2130706433:443', '0x7f.1:443', '0x7f000001:443', '0177.0.0.1:443',
  '127.1:443', '0x0a0000fe:443', '10.0.0.1.:443', '010.0.0.1:443', '1.2.3.0x4:443', '0xdeadbeef:443', '4294967296:443', 'a.1:443',
  'foo.0x7f:443', '01:443', '7:443'
];

const PRIVATE_ANSWERS = [
  '127.0.0.1', '127.1.2.3', '10.1.2.3', '192.168.1.10', '169.254.169.254', '172.16.0.1', '100.64.0.1', '0.0.0.0', '224.0.0.1',
  '255.255.255.255', '::1', '::', '::ffff:10.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', 'fd00::1', 'fe80::1', 'fec0::1',
  'ff02::1', '2002:7f00:1::1', '64:ff9b::a00:1', '2001:db8::1'
];

const MIXED_ANSWERS = [
  [PUBLIC_V4, '10.0.0.1'], ['10.0.0.1', PUBLIC_V4], [PUBLIC_V4, PUBLIC_V6, '::1'], [PUBLIC_V6, '169.254.169.254'],
  [PUBLIC_V4, '::ffff:127.0.0.1'], [PUBLIC_V4, 'fe80::1'], [PUBLIC_V4, PUBLIC_V4, PUBLIC_V4, '192.168.0.1']
];

const LITERAL_TARGETS = [
  '1.2.3.4:443', '127.0.0.1:443', '[::1]:443', '2130706433:443', '0x7f.1:443', '0177.0.0.1:443', '10.0.0.1:443', '169.254.169.254:443',
  '[::ffff:10.0.0.1]:443', '0x0a0000fe:443', '1.2.3.4.:443', '127.0.0.1:PORT', '[::1]:PORT', '8.8.8.8:PORT'
];

const answer = (...addresses) => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
const connectRequest = (authority, headers = '') => `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${headers}\r\n`;

function deferred() {
  const d = {};
  d.promise = new Promise((resolve, reject) => {
    d.resolve = resolve;
    d.reject = reject;
  });
  return d;
}

async function until(predicate, what, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await sleep(5);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function drained(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the proxy stopped reading')), 10000);
    timer.unref();
    socket.once('drain', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function writeAll(socket, data) {
  for (let offset = 0; offset < data.length; offset += 65536) {
    if (!socket.write(data.subarray(offset, offset + 65536))) await drained(socket);
  }
}

const clients = new Set();

afterEach(() => {
  for (const client of clients) client.socket.destroy();
  clients.clear();
});

// Raw TCP client of the proxy: keeps everything it receives.
class Client {
  constructor(port) {
    this.chunks = [];
    this.size = 0;
    this.ended = false;
    this.closed = false;
    this.socket = net.connect({ port, host: '127.0.0.1' });
    this.socket.on('data', (chunk) => {
      this.chunks.push(chunk);
      this.size += chunk.length;
    });
    this.socket.on('end', () => (this.ended = true));
    this.socket.on('close', () => (this.closed = true));
    this.socket.on('error', () => {});
    clients.add(this);
  }

  get bytes() {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks)];
    return this.chunks[0] || Buffer.alloc(0);
  }

  get text() {
    return this.bytes.toString('latin1');
  }

  write(data) {
    this.socket.write(data);
  }

  async take(n, ms = 5000) {
    await until(() => this.size >= n || this.closed, `${n} bytes from the proxy (got ${this.size})`, ms);
    const all = this.bytes;
    assert.ok(all.length >= n, `the connection closed after ${all.length} of ${n} bytes`);
    this.chunks = [all.subarray(n)];
    this.size = all.length - n;
    return all.subarray(0, n);
  }

  reset() {
    if (this.socket.resetAndDestroy) this.socket.resetAndDestroy();
    else this.socket.destroy();
  }
}

function parseHead(text) {
  const end = text.indexOf('\r\n\r\n');
  if (end < 0) return null;
  const [statusLine, ...lines] = text.slice(0, end).split('\r\n');
  const headers = {};
  for (const line of lines) {
    const i = line.indexOf(':');
    headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  return { statusLine, status: Number(statusLine.split(' ')[1]), headers, size: end + 4 };
}

// Sends `raw` and waits for the answer and the end of the connection: every refusal is sent with Connection: close.
async function exchange(port, raw) {
  const client = new Client(port);
  client.write(raw);
  await until(() => client.closed, `the proxy to close after ${JSON.stringify(String(raw).slice(0, 40))}`);
  const head = parseHead(client.text);
  assert.ok(head, `no answer: ${JSON.stringify(client.text)}`);
  return { ...head, body: client.text.slice(head.size), client };
}

async function openTunnel(port, authority, trailer = '') {
  const client = new Client(port);
  client.write(connectRequest(authority) + trailer);
  await until(() => client.closed || client.text.includes('\r\n\r\n'), 'the answer to CONNECT');
  const head = parseHead(client.text);
  assert.ok(head && head.status === 200, `unexpected answer ${JSON.stringify(client.text)}`);
  assert.equal(head.statusLine, 'HTTP/1.1 200 Connection Established');
  assert.equal(head.size, 'HTTP/1.1 200 Connection Established\r\n\r\n'.length);
  await client.take(head.size);
  return client;
}

function startEcho(t) {
  const echo = { port: 0, connections: 0, sockets: new Set() };
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    echo.connections++;
    echo.sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => echo.sockets.delete(socket));
    socket.pipe(socket);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        for (const socket of echo.sockets) socket.destroy();
        server.close(() => resolve());
      })
  );
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      echo.port = server.address().port;
      resolve(echo);
    });
  });
}

// The proxy under test, listening on a free local port. By default the name resolves to a public address and the connection
// is redirected to the echo server, so the whole default policy runs without any network access.
async function startProxy(t, echo, options = {}) {
  const { lookup = async () => answer(PUBLIC_V4), connect = () => net.connect({ host: '127.0.0.1', port: echo.port, allowHalfOpen: true }), tune, ...rest } = options;
  const spy = { logs: [], lookups: [], connects: [] };
  const record = (level) => (...args) => spy.logs.push({ level, text: args.join(' ') });
  const proxy = createEgressProxy({
    matcher: createMatcher('c411.test'),
    ports: [echo.port],
    log: { info: record('info'), warn: record('warn'), error: record('error') },
    ...rest,
    lookup: (host) => {
      spy.lookups.push(host);
      return lookup(host);
    },
    connect: (connectOptions) => {
      spy.connects.push(connectOptions);
      return connect(connectOptions);
    }
  });
  if (tune) tune(proxy.server);
  const { port } = await proxy.listen(0, '127.0.0.1');
  t.after(() => proxy.close());
  return Object.assign(proxy, { port, spy });
}

function assertUntouched(proxy, echo) {
  assert.deepEqual(proxy.spy.lookups, [], 'no name must be resolved');
  assert.deepEqual(proxy.spy.connects, [], 'no connection must be attempted');
  assert.equal(echo.connections, 0);
  assert.equal(proxy.stats.active, 0);
}

test('classifyIp separates public addresses from every special-purpose range', () => {
  for (const ip of PUBLIC) assert.equal(classifyIp(ip), 'public', ip);
  for (const [ip, reason] of NON_PUBLIC) assert.equal(classifyIp(ip), reason, ip);
  for (const ip of INVALID) assert.equal(classifyIp(ip), 'invalid', JSON.stringify(ip));
  for (const value of NOT_STRINGS) assert.equal(classifyIp(value), 'invalid', String(value));
});

test('isPublicIp is true for public addresses only', () => {
  for (const ip of PUBLIC) assert.equal(isPublicIp(ip), true, ip);
  for (const [ip] of NON_PUBLIC) assert.equal(isPublicIp(ip), false, ip);
  for (const ip of INVALID) assert.equal(isPublicIp(ip), false, JSON.stringify(ip));
  for (const value of NOT_STRINGS) assert.equal(isPublicIp(value), false, String(value));
});

test('every IPv6 spelling of an address is classified the same way', () => {
  const spellings = ['::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '0000:0000:0000:0000:0000:ffff:7f00:0001', '::FFFF:7F00:1', '::ffff:127.0.0.1', '0::ffff:127.0.0.1'];
  for (const text of spellings) assert.equal(classifyIp(text), 'loopback', text);
  for (const text of ['2001:db8::1', '2001:DB8:0:0:0:0:0:1', '2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8:0::0:1']) {
    assert.equal(classifyIp(text), 'documentation', text);
  }
});

test('parseConnectTarget accepts only a plain DNS name and a decimal port', () => {
  for (const [authority, host, port] of GOOD_TARGETS) assert.deepEqual(parseConnectTarget(authority), { host, port }, authority);
  for (const bad of BAD_TARGETS) assert.equal(parseConnectTarget(bad), null, JSON.stringify(bad));
  for (const value of NOT_STRINGS) assert.equal(parseConnectTarget(value), null, String(value));
});

test('parseConnectTarget refuses everything the host rules refuse', () => {
  const disguised = ['127.0.0.1', '2130706433', '0x7f.1', '0177.0.0.1', '127.1', '0x7f000001', '0x0a0000fe', '10.0.0.1.', '[::1]', '::1', '1.2.3.4', '01.02.03.04', '192.168.1', '4294967296', '0xdeadbeef', 'a.1', 'foo.0x7f', '1.2.3.0x4'];
  for (const host of disguised) {
    assert.equal(normalizeHost(host), '', host);
    assert.equal(parseConnectTarget(`${host}:443`), null, host);
  }
});

test('a tunnel carries data both ways, including a large volume', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const proxy = await startProxy(t, echo, { allowPrivate: true, connect: net.connect, lookup: async () => answer('127.0.0.1') });
  const tunnel = await openTunnel(proxy.port, `c411.test:${echo.port}`);
  assert.equal(proxy.stats.active, 1);
  assert.equal(proxy.stats.established, 1);
  assert.equal(proxy.spy.connects[0].host, '127.0.0.1');
  tunnel.write('hello');
  assert.equal((await tunnel.take(5)).toString(), 'hello');
  const payload = crypto.randomBytes(4 * 1024 * 1024);
  const sent = writeAll(tunnel.socket, payload);
  sent.catch(() => {});
  const back = await tunnel.take(payload.length, 15000);
  await sent;
  assert.ok(back.equals(payload), 'the echoed volume differs from what was sent');
  assert.equal(proxy.stats.active, 1);
  tunnel.socket.destroy();
  await until(() => proxy.stats.active === 0, 'the slot to be released');
  await until(() => echo.sockets.size === 0, 'the upstream connection to be closed');
  assert.equal(echo.connections, 1);
});

test('the connection goes to the validated address and the name is resolved once', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const proxy = await startProxy(t, echo);
  const tunnel = await openTunnel(proxy.port, `C411.Test:${echo.port}`);
  tunnel.write('ping');
  assert.equal((await tunnel.take(4)).toString(), 'ping');
  assert.deepEqual(proxy.spy.lookups, ['c411.test']);
  assert.equal(proxy.spy.connects.length, 1);
  const [options] = proxy.spy.connects;
  assert.equal(options.host, PUBLIC_V4);
  assert.equal(net.isIP(options.host), 4);
  assert.equal(options.port, echo.port);
  const guard = await new Promise((resolve) => options.lookup('c411.test', {}, resolve));
  assert.ok(guard instanceof Error, 'a name must never be resolved when connecting');
});

test('the second half of a half-closed tunnel still works', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const proxy = await startProxy(t, echo);
  const tunnel = await openTunnel(proxy.port, `c411.test:${echo.port}`);
  tunnel.write('bye');
  tunnel.socket.end();
  await until(() => tunnel.closed, 'the tunnel to close');
  assert.equal(tunnel.text, 'bye');
  await until(() => proxy.stats.active === 0, 'the slot to be released');
  await until(() => echo.sockets.size === 0, 'the upstream connection to be closed');
});

test('bytes sent right after the CONNECT headers reach the destination', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const proxy = await startProxy(t, echo);
  const early = await openTunnel(proxy.port, `c411.test:${echo.port}`, 'early-bytes');
  assert.equal((await early.take(11)).toString(), 'early-bytes');
  const gate = deferred();
  const slow = await startProxy(t, echo, { lookup: () => gate.promise.then(() => answer(PUBLIC_V4)) });
  const client = new Client(slow.port);
  client.write(connectRequest(`c411.test:${echo.port}`));
  await until(() => slow.spy.lookups.length === 1, 'the resolution to start');
  client.write('\x16\x03\x01during');
  gate.resolve();
  await until(() => client.text.includes('\r\n\r\n'), 'the answer to CONNECT');
  const head = parseHead(client.text);
  assert.equal(head.status, 200);
  await client.take(head.size);
  assert.equal((await client.take(9)).toString('latin1'), '\x16\x03\x01during');
});

test('an allowed name that resolves to a private address is refused by the default policy', LIMIT, async (t) => {
  const echo = await startEcho(t);
  let current;
  const proxy = await startProxy(t, echo, { connect: net.connect, lookup: async () => current });
  for (const address of PRIVATE_ANSWERS) {
    current = answer(address);
    const res = await exchange(proxy.port, connectRequest(`c411.test:${echo.port}`));
    assert.equal(res.status, 403, address);
  }
  assert.deepEqual(proxy.spy.connects, []);
  assert.equal(echo.connections, 0);
  assert.equal(proxy.stats.active, 0);
  assert.equal(proxy.stats.refused, PRIVATE_ANSWERS.length);
  assert.equal(proxy.stats.established, 0);
});

test('a name that resolves to public and private addresses at once is refused', LIMIT, async (t) => {
  const echo = await startEcho(t);
  let current;
  const proxy = await startProxy(t, echo, { connect: net.connect, lookup: async () => current });
  for (const addresses of MIXED_ANSWERS) {
    current = answer(...addresses);
    const res = await exchange(proxy.port, connectRequest(`c411.test:${echo.port}`));
    assert.equal(res.status, 403, addresses.join(' '));
  }
  assert.deepEqual(proxy.spy.connects, []);
  assert.equal(echo.connections, 0);
});

test('allowPrivate lets private addresses through but never something that is not an IP address', LIMIT, async (t) => {
  const echo = await startEcho(t);
  let current;
  const proxy = await startProxy(t, echo, { allowPrivate: true, lookup: async () => current });
  current = answer('10.1.2.3');
  const tunnel = await openTunnel(proxy.port, `c411.test:${echo.port}`);
  tunnel.write('ok');
  assert.equal((await tunnel.take(2)).toString(), 'ok');
  for (const garbage of [[{}], [{ address: 42 }], [{ address: 'not-an-ip' }], [null], [{ address: '127.0.0.1%lo' }], [{ address: 'localhost' }], [{ address: '0x7f.1' }]]) {
    current = garbage;
    const res = await exchange(proxy.port, connectRequest(`c411.test:${echo.port}`));
    assert.equal(res.status, 403, JSON.stringify(garbage));
  }
  assert.equal(proxy.spy.connects.length, 1);
});

test('IP literals, in any notation, are refused before anything is resolved', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const proxy = await startProxy(t, echo, { matcher: createMatcher('*') });
  for (const target of LITERAL_TARGETS) {
    const res = await exchange(proxy.port, connectRequest(target.replace('PORT', echo.port)));
    assert.equal(res.status, 400, target);
  }
  assertUntouched(proxy, echo);
  assert.equal(proxy.stats.refused, LITERAL_TARGETS.length);
});

test('a host outside the allowed list is refused before anything is resolved', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const proxy = await startProxy(t, echo);
  for (const host of ['evil.test', 'c411.test.evil.test', 'xc411.test', 'sub.c411.test', 'localhost', 'example.org', 'evilc411.org', 'c411.org.evil.test']) {
    const res = await exchange(proxy.port, connectRequest(`${host}:${echo.port}`));
    assert.equal(res.status, 403, host);
  }
  assertUntouched(proxy, echo);
});

test('the default hosts stay allowed next to the configured ones', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const proxy = await startProxy(t, echo);
  for (const host of ['c411.org', 'www.c411.org', 'challenges.cloudflare.com', 'c411.test']) {
    const tunnel = await openTunnel(proxy.port, `${host}:${echo.port}`);
    tunnel.write('x');
    assert.equal((await tunnel.take(1)).toString(), 'x', host);
  }
  assert.deepEqual(proxy.spy.lookups, ['c411.org', 'www.c411.org', 'challenges.cloudflare.com', 'c411.test']);
});

test('a wildcard accepts its sub-domains and never its apex', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const proxy = await startProxy(t, echo, { matcher: createMatcher('*.wild.test') });
  for (const host of ['a.wild.test', 'deep.sub.wild.test']) {
    const tunnel = await openTunnel(proxy.port, `${host}:${echo.port}`);
    tunnel.write('x');
    assert.equal((await tunnel.take(1)).toString(), 'x', host);
  }
  const before = proxy.spy.lookups.length;
  for (const host of ['wild.test', 'evilwild.test', 'wild.test.evil.test', 'awild.test', 'a.wild.test.evil.test']) {
    const res = await exchange(proxy.port, connectRequest(`${host}:${echo.port}`));
    assert.equal(res.status, 403, host);
  }
  assert.equal(proxy.spy.lookups.length, before);
});

test('only the configured ports are reachable', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const proxy = await startProxy(t, echo, { ports: [echo.port, 8443] });
  for (const port of [22, 25, 80, 443, 3128, 8080, 8444, 65535, 1]) {
    const res = await exchange(proxy.port, connectRequest(`c411.test:${port}`));
    assert.equal(res.status, 403, String(port));
  }
  assertUntouched(proxy, echo);
  const tunnel = await openTunnel(proxy.port, `c411.test:8443`);
  tunnel.write('x');
  assert.equal((await tunnel.take(1)).toString(), 'x');
  assert.equal(proxy.spy.connects[0].port, 8443);
});

test('by default only port 443 is reachable', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const spy = [];
  const proxy = createEgressProxy({
    matcher: createMatcher('c411.test'),
    lookup: async (host) => {
      spy.push(host);
      return answer(PUBLIC_V4);
    },
    connect: () => net.connect({ host: '127.0.0.1', port: echo.port, allowHalfOpen: true }),
    log: { info() {}, warn() {}, error() {} }
  });
  const { port } = await proxy.listen(0, '127.0.0.1');
  t.after(() => proxy.close());
  for (const denied of [80, 8080, echo.port]) {
    const res = await exchange(port, connectRequest(`c411.test:${denied}`));
    assert.equal(res.status, 403, String(denied));
  }
  assert.deepEqual(spy, []);
  const tunnel = await openTunnel(port, 'c411.test:443');
  tunnel.write('x');
  assert.equal((await tunnel.take(1)).toString(), 'x');
});

const NOT_CONNECT = [
  ['GET with an absolute URL', 'GET http://c411.test/ HTTP/1.1\r\nHost: c411.test\r\n\r\n'],
  ['GET of a path', 'GET / HTTP/1.1\r\nHost: c411.test\r\n\r\n'],
  ['GET in HTTP/1.0', 'GET /healthz HTTP/1.0\r\n\r\n'],
  ['HEAD', 'HEAD http://c411.test/ HTTP/1.1\r\nHost: c411.test\r\n\r\n'],
  ['POST with a body', 'POST http://c411.test/login HTTP/1.1\r\nHost: c411.test\r\nContent-Length: 7\r\n\r\nsecret1'],
  ['PUT', 'PUT http://c411.test/x HTTP/1.1\r\nHost: c411.test\r\nContent-Length: 0\r\n\r\n'],
  ['DELETE', 'DELETE http://c411.test/x HTTP/1.1\r\nHost: c411.test\r\n\r\n'],
  ['PATCH with a body', 'PATCH / HTTP/1.1\r\nHost: c411.test\r\nContent-Length: 2\r\n\r\n{}'],
  ['OPTIONS *', 'OPTIONS * HTTP/1.1\r\nHost: c411.test\r\n\r\n'],
  ['TRACE', 'TRACE / HTTP/1.1\r\nHost: c411.test\r\n\r\n'],
  ['GET with an Upgrade request', 'GET / HTTP/1.1\r\nHost: c411.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'],
  ['POST with Expect', 'POST /upload HTTP/1.1\r\nHost: c411.test\r\nContent-Length: 5\r\nExpect: 100-continue\r\n\r\n'],
  ['GET with an unknown expectation', 'GET / HTTP/1.1\r\nHost: c411.test\r\nExpect: something-else\r\n\r\n']
];

test('every method other than CONNECT gets 405 and nothing is forwarded', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const proxy = await startProxy(t, echo);
  for (const [name, raw] of NOT_CONNECT) {
    const res = await exchange(proxy.port, raw);
    assert.equal(res.status, 405, name);
    assert.equal(res.headers.allow, 'CONNECT', name);
    assert.equal(res.headers.connection, 'close', name);
    if (!raw.startsWith('HEAD')) {
      assert.ok(res.body.length > 0 && res.body.length < 100, `${name}: short body`);
      assert.equal(Number(res.headers['content-length']), res.body.length, name);
    }
  }
  assertUntouched(proxy, echo);
  assert.equal(proxy.stats.refused, NOT_CONNECT.length);
});

const MALFORMED = [
  ['no port', 'CONNECT c411.test HTTP/1.1\r\nHost: c411.test\r\n\r\n'],
  ['port 0', connectRequest('c411.test:0')],
  ['port 65536', connectRequest('c411.test:65536')],
  ['port 99999', connectRequest('c411.test:99999')],
  ['empty port', connectRequest('c411.test:')],
  ['a port that is not a number', connectRequest('c411.test:https')],
  ['a port with a leading zero', connectRequest('c411.test:0443')],
  ['userinfo', connectRequest('user@c411.test:443')],
  ['userinfo with a password', connectRequest('user:secret@c411.test:443')],
  ['a path', 'CONNECT /path HTTP/1.1\r\nHost: c411.test\r\n\r\n'],
  ['an absolute URL', 'CONNECT http://c411.test:443/ HTTP/1.1\r\nHost: c411.test\r\n\r\n'],
  ['an asterisk', 'CONNECT * HTTP/1.1\r\nHost: c411.test\r\n\r\n'],
  ['a space inside the target', 'CONNECT c411.test :443 HTTP/1.1\r\nHost: c411.test\r\n\r\n'],
  ['a tab inside the target', 'CONNECT c411.test\t:443 HTTP/1.1\r\nHost: c411.test\r\n\r\n'],
  ['a line feed inside the target', 'CONNECT c411.test\n:443 HTTP/1.1\r\nHost: c411.test\r\n\r\n'],
  ['a null byte inside the target', 'CONNECT c411.test\0:443 HTTP/1.1\r\nHost: c411.test\r\n\r\n'],
  ['no HTTP version', 'CONNECT c411.test:PORT\r\n\r\n'],
  ['HTTP/0.9', 'CONNECT c411.test:PORT HTTP/0.9\r\nHost: c411.test\r\n\r\n'],
  ['HTTP/2.0 on a cleartext connection', 'CONNECT c411.test:PORT HTTP/2.0\r\nHost: c411.test\r\n\r\n'],
  ['an unknown HTTP version', 'CONNECT c411.test:PORT HTTP/9.9\r\nHost: c411.test\r\n\r\n'],
  ['line feeds only', 'CONNECT c411.test:PORT HTTP/1.1\nHost: c411.test\n\n'],
  ['a lower case method', 'connect c411.test:443 HTTP/1.1\r\nHost: c411.test\r\n\r\n'],
  ['an unknown method', 'FETCH c411.test:443 HTTP/1.1\r\nHost: c411.test\r\n\r\n'],
  ['a TLS hello sent to the wrong door', Buffer.concat([Buffer.from([0x16, 0x03, 0x01, 0x02, 0x00, 0x01, 0x00, 0x01, 0xfc, 0x03, 0x03]), crypto.randomBytes(64)])],
  ['a content length', 'CONNECT c411.test:PORT HTTP/1.1\r\nHost: c411.test\r\nContent-Length: 5\r\n\r\nhello'],
  ['a chunked body', 'CONNECT c411.test:PORT HTTP/1.1\r\nHost: c411.test\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n']
];

test('a malformed CONNECT gets 400 and the proxy keeps working', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const proxy = await startProxy(t, echo);
  for (const [name, request] of MALFORMED) {
    const raw = typeof request === 'string' ? request.replace('PORT', echo.port) : request;
    const res = await exchange(proxy.port, raw);
    assert.equal(res.status, 400, name);
  }
  assertUntouched(proxy, echo);
  const tunnel = await openTunnel(proxy.port, `c411.test:${echo.port}`);
  tunnel.write('still alive');
  assert.equal((await tunnel.take(11)).toString(), 'still alive');
});

test('the policy applies to the target exactly as the HTTP parser reads it', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const proxy = await startProxy(t, echo);
  const lenient = [
    `CONNECT  evil.test:${echo.port} HTTP/1.1\r\nHost: c411.test\r\n\r\n`,
    `CONNECT evil.test:${echo.port}  HTTP/1.1\r\nHost: c411.test\r\n\r\n`,
    `CONNECT evil.test:${echo.port} HTTP/1.0\r\n\r\n`
  ];
  for (const raw of lenient) {
    const res = await exchange(proxy.port, raw);
    assert.ok([400, 403].includes(res.status), JSON.stringify(raw));
  }
  const spoofed = await exchange(proxy.port, `CONNECT evil.test:${echo.port} HTTP/1.1\r\nHost: c411.test:${echo.port}\r\nForwarded: for=c411.test\r\nX-Forwarded-Host: c411.test\r\n\r\n`);
  assert.equal(spoofed.status, 403, 'the Host header is not the destination');
  assertUntouched(proxy, echo);
});

test('a second request pipelined behind the CONNECT is refused, not forwarded', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const proxy = await startProxy(t, echo);
  const first = connectRequest(`c411.test:${echo.port}`);
  const followers = [
    connectRequest(`c411.test:${echo.port}`),
    connectRequest(`evil.test:${echo.port}`),
    'GET http://c411.test/ HTTP/1.1\r\nHost: c411.test\r\n\r\n',
    'POST / HTTP/1.1\r\nHost: c411.test\r\nContent-Length: 0\r\n\r\n'
  ];
  for (const follower of followers) {
    const res = await exchange(proxy.port, first + follower);
    assert.equal(res.status, 400, JSON.stringify(follower));
  }
  assertUntouched(proxy, echo);
});

test('a second request sent while the name is being resolved cancels the tunnel', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const gate = deferred();
  const proxy = await startProxy(t, echo, { lookup: () => gate.promise.then(() => answer(PUBLIC_V4)) });
  const client = new Client(proxy.port);
  client.write(connectRequest(`c411.test:${echo.port}`));
  await until(() => proxy.spy.lookups.length === 1, 'the resolution to start');
  client.write(connectRequest(`c411.test:${echo.port}`));
  await until(() => client.closed, 'the proxy to close');
  assert.equal(parseHead(client.text).status, 400);
  assert.equal(proxy.stats.active, 0);
  gate.resolve();
  await sleep(100);
  assert.deepEqual(proxy.spy.connects, []);
  assert.equal(echo.connections, 0);
  assert.equal(proxy.stats.active, 0);
});

test('Content-Length: 0 on a CONNECT is harmless', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const proxy = await startProxy(t, echo);
  const client = new Client(proxy.port);
  client.write(connectRequest(`c411.test:${echo.port}`, 'Content-Length: 0\r\n'));
  await until(() => client.text.includes('\r\n\r\n'), 'the answer to CONNECT');
  assert.equal(parseHead(client.text).status, 200);
});

test('oversized headers are refused', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const proxy = await startProxy(t, echo);
  const padded = await exchange(proxy.port, connectRequest(`c411.test:${echo.port}`, `X-Padding: ${'a'.repeat(20000)}\r\n`));
  assert.equal(padded.status, 431);
  const long = await exchange(proxy.port, `CONNECT ${'a'.repeat(10000)}:443 HTTP/1.1\r\nHost: c411.test\r\n\r\n`);
  assert.ok([400, 431].includes(long.status), `status ${long.status}`);
  assertUntouched(proxy, echo);
});

test('a client that never finishes its headers is cut off', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const proxy = await startProxy(t, echo, {
    tune(server) {
      server.headersTimeout = 150;
      server.requestTimeout = 150;
      server.connectionsCheckingInterval = 40;
    }
  });
  const client = new Client(proxy.port);
  client.write(`CONNECT c411.test:${echo.port} HTTP/1.1\r\nHost: c411.test\r\n`);
  await until(() => client.closed, 'the proxy to give up', 3000);
  const head = parseHead(client.text);
  assert.ok(head === null || head.status === 408, client.text);
  assertUntouched(proxy, echo);
});

test('the proxy uses short header timeouts and a small header limit by default', () => {
  const proxy = createEgressProxy();
  assert.ok(proxy.server.headersTimeout <= 15000);
  assert.ok(proxy.server.requestTimeout <= 15000);
  assert.ok(proxy.server.keepAliveTimeout <= 5000);
  assert.deepEqual(Object.keys(proxy).sort(), ['close', 'listen', 'server', 'stats']);
  assert.deepEqual(proxy.stats, { active: 0, established: 0, refused: 0, failed: 0 });
});

test('simultaneous connections are capped and a slot is reusable once freed', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const proxy = await startProxy(t, echo, { maxConnections: 2 });
  const first = await openTunnel(proxy.port, `c411.test:${echo.port}`);
  const second = await openTunnel(proxy.port, `c411.test:${echo.port}`);
  assert.equal(proxy.stats.active, 2);
  const third = await exchange(proxy.port, connectRequest(`c411.test:${echo.port}`));
  assert.equal(third.status, 503);
  assert.equal(proxy.spy.lookups.length, 2, 'a refused connection must not be resolved');
  assert.equal(proxy.stats.active, 2);
  first.socket.destroy();
  await until(() => proxy.stats.active === 1, 'a slot to be released');
  const fourth = await openTunnel(proxy.port, `c411.test:${echo.port}`);
  fourth.write('x');
  assert.equal((await fourth.take(1)).toString(), 'x');
  second.write('y');
  assert.equal((await second.take(1)).toString(), 'y');
  assert.equal(proxy.stats.active, 2);
});

test('names being resolved count against the limit too', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const gate = deferred();
  const proxy = await startProxy(t, echo, { maxConnections: 2, lookup: () => gate.promise.then(() => answer(PUBLIC_V4)) });
  const waiting = [new Client(proxy.port), new Client(proxy.port)];
  for (const client of waiting) client.write(connectRequest(`c411.test:${echo.port}`));
  await until(() => proxy.spy.lookups.length === 2, 'both resolutions to start');
  assert.equal(proxy.stats.active, 2);
  const refused = await exchange(proxy.port, connectRequest(`c411.test:${echo.port}`));
  assert.equal(refused.status, 503);
  assert.equal(proxy.spy.lookups.length, 2);
  gate.resolve();
  for (const client of waiting) {
    await until(() => client.text.includes('\r\n\r\n'), 'the answer to CONNECT');
    assert.equal(parseHead(client.text).status, 200);
  }
  assert.equal(proxy.stats.active, 2);
});

test('refusals do not use up connection slots', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const proxy = await startProxy(t, echo, { maxConnections: 1 });
  for (let i = 0; i < 10; i++) assert.equal((await exchange(proxy.port, connectRequest(`evil.test:${echo.port}`))).status, 403);
  for (let i = 0; i < 3; i++) assert.equal((await exchange(proxy.port, 'GET / HTTP/1.1\r\nHost: x\r\n\r\n')).status, 405);
  const tunnel = await openTunnel(proxy.port, `c411.test:${echo.port}`);
  tunnel.write('x');
  assert.equal((await tunnel.take(1)).toString(), 'x');
});

test('a destination that never answers ends with 504 after the connect timeout, one address at a time', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const dangling = [];
  const proxy = await startProxy(t, echo, {
    connectTimeoutMs: 150,
    lookup: async () => answer(PUBLIC_V4, PUBLIC_V6),
    connect: () => {
      const socket = new net.Socket();
      dangling.push(socket);
      return socket;
    }
  });
  const started = Date.now();
  const res = await exchange(proxy.port, connectRequest(`c411.test:${echo.port}`));
  assert.equal(res.status, 504);
  assert.ok(Date.now() - started >= 280, 'each address gets its own timeout');
  assert.equal(dangling.length, 2);
  assert.ok(dangling.every((socket) => socket.destroyed));
  assert.deepEqual(proxy.spy.connects.map((o) => o.host), [PUBLIC_V4, PUBLIC_V6]);
  assert.equal(proxy.stats.active, 0);
  assert.equal(proxy.stats.failed, 1);
});

test('a resolution that takes too long ends with 502', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const proxy = await startProxy(t, echo, { lookupTimeoutMs: 100, lookup: () => new Promise(() => {}) });
  const started = Date.now();
  const res = await exchange(proxy.port, connectRequest(`c411.test:${echo.port}`));
  assert.equal(res.status, 502);
  assert.ok(Date.now() - started >= 90);
  assert.equal(proxy.stats.active, 0);
  assert.equal(proxy.stats.failed, 1);
  assert.deepEqual(proxy.spy.connects, []);
});

test('a failed resolution ends with 502', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const failures = [
    async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND c411.test'), { code: 'ENOTFOUND' });
    },
    () => {
      throw new Error('boom');
    },
    async () => [],
    async () => null,
    async () => undefined,
    async () => 'nope',
    () => Promise.reject(new Error('rejected'))
  ];
  let current = failures[0];
  const proxy = await startProxy(t, echo, { lookup: (host) => current(host) });
  for (const failure of failures) {
    current = failure;
    const res = await exchange(proxy.port, connectRequest(`c411.test:${echo.port}`));
    assert.equal(res.status, 502, String(failure));
  }
  assert.equal(proxy.stats.failed, failures.length);
  assert.deepEqual(proxy.spy.connects, []);
  assert.equal(proxy.stats.active, 0);
});

test('addresses are tried one after the other and the last failure ends with 502', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const refusing = () => {
    const socket = new net.Socket();
    setImmediate(() => socket.destroy(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })));
    return socket;
  };
  let failures = 2;
  const proxy = await startProxy(t, echo, {
    lookup: async () => answer(PUBLIC_V4, '8.8.8.8', PUBLIC_V6),
    connect: () => (failures-- > 0 ? refusing() : net.connect({ host: '127.0.0.1', port: echo.port, allowHalfOpen: true }))
  });
  const tunnel = await openTunnel(proxy.port, `c411.test:${echo.port}`);
  tunnel.write('x');
  assert.equal((await tunnel.take(1)).toString(), 'x');
  assert.deepEqual(proxy.spy.connects.map((o) => o.host), [PUBLIC_V4, PUBLIC_V6, '8.8.8.8'], 'families alternate, starting with the preferred one');
  assert.equal(proxy.spy.lookups.length, 1);

  const refused = await startProxy(t, echo, {
    lookup: async () => answer('1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '9.9.9.9', '9.9.9.10'),
    connect: refusing
  });
  const res = await exchange(refused.port, connectRequest(`c411.test:${echo.port}`));
  assert.equal(res.status, 502);
  assert.ok(refused.spy.connects.length <= 4, 'the number of attempts is bounded');
  assert.equal(refused.stats.failed, 1);
  assert.equal(refused.stats.active, 0);
});

test('the slot is released when the client leaves, whatever the stage', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const gate = deferred();
  const dangling = [];
  let mode = 'resolve';
  const proxy = await startProxy(t, echo, {
    connectTimeoutMs: 20000,
    lookup: () => (mode === 'resolve' ? gate.promise.then(() => answer(PUBLIC_V4)) : answer(PUBLIC_V4)),
    connect: () => {
      if (mode === 'dial') {
        const socket = new net.Socket();
        dangling.push(socket);
        return socket;
      }
      return net.connect({ host: '127.0.0.1', port: echo.port, allowHalfOpen: true });
    }
  });

  const resolving = new Client(proxy.port);
  resolving.write(connectRequest(`c411.test:${echo.port}`));
  await until(() => proxy.spy.lookups.length === 1, 'the resolution to start');
  assert.equal(proxy.stats.active, 1);
  resolving.socket.destroy();
  await until(() => proxy.stats.active === 0, 'the slot to be released during the resolution');
  gate.resolve();
  await sleep(80);
  assert.deepEqual(proxy.spy.connects, [], 'nothing is connected for a client that left');
  assert.equal(echo.connections, 0);

  mode = 'dial';
  const dialing = new Client(proxy.port);
  dialing.write(connectRequest(`c411.test:${echo.port}`));
  await until(() => dangling.length === 1, 'the connection attempt to start');
  assert.equal(proxy.stats.active, 1);
  dialing.socket.destroy();
  await until(() => proxy.stats.active === 0, 'the slot to be released during the connection');
  assert.ok(dangling[0].destroyed, 'the pending upstream socket is destroyed');

  mode = 'tunnel';
  const tunnel = await openTunnel(proxy.port, `c411.test:${echo.port}`);
  assert.equal(proxy.stats.active, 1);
  tunnel.socket.destroy();
  await until(() => proxy.stats.active === 0, 'the slot to be released once established');
  await until(() => echo.sockets.size === 0, 'the upstream connection to be closed');
});

test('the client is disconnected when the destination closes', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const proxy = await startProxy(t, echo);
  const tunnel = await openTunnel(proxy.port, `c411.test:${echo.port}`);
  tunnel.write('x');
  await tunnel.take(1);
  for (const socket of echo.sockets) socket.destroy();
  await until(() => tunnel.closed, 'the client to be disconnected');
  await until(() => proxy.stats.active === 0, 'the slot to be released');
});

test('abrupt resets at any stage neither crash the proxy nor leak slots', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const gate = deferred();
  const proxy = await startProxy(t, echo, { lookup: () => gate.promise.then(() => answer(PUBLIC_V4)) });
  new Client(proxy.port).reset();
  const partial = new Client(proxy.port);
  partial.write('CONNECT c411.test:');
  partial.reset();
  const resolving = new Client(proxy.port);
  resolving.write(connectRequest(`c411.test:${echo.port}`));
  await until(() => proxy.spy.lookups.length === 1, 'the resolution to start');
  resolving.reset();
  const refused = new Client(proxy.port);
  refused.write(connectRequest(`evil.test:${echo.port}`));
  refused.reset();
  const garbage = new Client(proxy.port);
  garbage.write(Buffer.from([0x16, 0x03, 0x01, 0x00]));
  garbage.reset();
  gate.resolve();
  const tunnel = await openTunnel(proxy.port, `c411.test:${echo.port}`);
  tunnel.reset();
  await until(() => proxy.stats.active === 0, 'every slot to be released');
  await until(() => echo.sockets.size === 0, 'every upstream connection to be closed');
  const alive = await openTunnel(proxy.port, `c411.test:${echo.port}`);
  alive.write('x');
  assert.equal((await alive.take(1)).toString(), 'x');
});

test('close() destroys the tunnels, the waiting clients and resolves', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const gate = deferred();
  const proxy = await startProxy(t, echo, { lookup: (host) => (host === 'c411.test' ? answer(PUBLIC_V4) : gate.promise) });
  const tunnels = [await openTunnel(proxy.port, `c411.test:${echo.port}`), await openTunnel(proxy.port, `c411.test:${echo.port}`)];
  const idle = new Client(proxy.port);
  const resolving = new Client(proxy.port);
  resolving.write(connectRequest(`c411.test.:${echo.port}`.replace('c411.test.', 'c411.org')));
  await until(() => proxy.spy.lookups.length === 3, 'the third resolution to start');
  await until(() => echo.connections === 2, 'both tunnels to be established');
  assert.equal(proxy.stats.active, 3);
  const started = Date.now();
  await proxy.close();
  assert.ok(Date.now() - started < 2000, 'close() is not held back by open tunnels');
  for (const client of [...tunnels, idle, resolving]) await until(() => client.closed, 'the connection to be destroyed');
  assert.equal(proxy.stats.active, 0);
  assert.equal(proxy.server.listening, false);
  await until(() => echo.sockets.size === 0, 'the upstream connections to be closed');
  gate.resolve();
  await sleep(50);
  assert.equal(echo.connections, 2, 'nothing is connected once the proxy is closed');
  await proxy.close();
});

test('close() is idempotent and works for a proxy that never listened', async () => {
  const proxy = createEgressProxy({ log: { info() {}, warn() {}, error() {} } });
  const first = proxy.close();
  assert.equal(proxy.close(), first);
  await first;
  await assert.rejects(proxy.listen(0, '127.0.0.1'), /déjà fermé/);
});

test('listen() resolves with the address, rejects when the port is taken and binds to loopback by default', LIMIT, async (t) => {
  const proxy = createEgressProxy({ log: { info() {}, warn() {}, error() {} } });
  const address = await proxy.listen(0);
  t.after(() => proxy.close());
  assert.equal(address.address, '127.0.0.1');
  assert.ok(address.port > 0);
  const other = createEgressProxy({ log: { info() {}, warn() {}, error() {} } });
  await assert.rejects(other.listen(address.port, '127.0.0.1'), { code: 'EADDRINUSE' });
  await other.close();
});

test('the star mode accepts any public name but still refuses private addresses', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const proxy = await startProxy(t, echo, {
    matcher: createMatcher('*'),
    lookup: async (host) => answer(host === 'inside.example' ? '10.0.0.1' : host === 'mixed.example' ? PUBLIC_V4 : PUBLIC_V4, ...(host === 'mixed.example' ? ['192.168.0.1'] : []))
  });
  for (const host of ['anything.example', 'a.b.c.d.other.example', 'c411.org']) {
    const tunnel = await openTunnel(proxy.port, `${host}:${echo.port}`);
    tunnel.write('x');
    assert.equal((await tunnel.take(1)).toString(), 'x', host);
  }
  for (const host of ['inside.example', 'mixed.example']) {
    const res = await exchange(proxy.port, connectRequest(`${host}:${echo.port}`));
    assert.equal(res.status, 403, host);
  }
  const literal = await exchange(proxy.port, connectRequest(`127.0.0.1:${echo.port}`));
  assert.equal(literal.status, 400);
  const echoConnections = echo.connections;
  const port = await exchange(proxy.port, connectRequest('anything.example:22'));
  assert.equal(port.status, 403);
  assert.equal(echo.connections, echoConnections);
});

test('the star mode with the real resolver still refuses localhost', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const proxy = createEgressProxy({ matcher: createMatcher('*'), ports: [echo.port], log: { info() {}, warn() {}, error() {} } });
  const { port } = await proxy.listen(0, '127.0.0.1');
  t.after(() => proxy.close());
  const res = await exchange(port, connectRequest(`localhost:${echo.port}`));
  assert.equal(res.status, 403);
  assert.equal(echo.connections, 0);
  assert.equal(proxy.stats.active, 0);
});

test('an idle tunnel is closed and traffic keeps it alive', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const proxy = await startProxy(t, echo, { idleTimeoutMs: 500 });
  const tunnel = await openTunnel(proxy.port, `c411.test:${echo.port}`);
  for (let i = 0; i < 9; i++) {
    await sleep(80);
    tunnel.write('x');
  }
  assert.equal(tunnel.closed, false, 'traffic resets the idle timer');
  await until(() => tunnel.closed, 'the idle tunnel to be closed', 4000);
  await until(() => proxy.stats.active === 0, 'the slot to be released');
  await until(() => echo.sockets.size === 0, 'the upstream connection to be closed');
});

test('a tunnel does not outlive its maximum lifetime, even when it is busy', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const proxy = await startProxy(t, echo, { maxLifetimeMs: 400, idleTimeoutMs: 60000 });
  const tunnel = await openTunnel(proxy.port, `c411.test:${echo.port}`);
  const started = Date.now();
  const traffic = setInterval(() => tunnel.write('x'), 40);
  try {
    await until(() => tunnel.closed, 'the tunnel to reach its maximum lifetime', 4000);
  } finally {
    clearInterval(traffic);
  }
  assert.ok(Date.now() - started >= 300, 'not closed before the lifetime is over');
  await until(() => proxy.stats.active === 0, 'the slot to be released');
});

test('refusals are logged once per reason and interval, without any content', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const proxy = await startProxy(t, echo, { logIntervalMs: 60000 });
  for (let i = 0; i < 30; i++) await exchange(proxy.port, connectRequest(`evil${i}.test:${echo.port}`));
  for (let i = 0; i < 5; i++) await exchange(proxy.port, connectRequest(`c411.test:${echo.port + 1}`));
  await exchange(proxy.port, connectRequest(`127.0.0.1:${echo.port}`));
  await exchange(proxy.port, `POST http://c411.test/secret-path?token=abc HTTP/1.1\r\nHost: c411.test\r\nAuthorization: Bearer SECRET123\r\nContent-Length: 7\r\n\r\nPAYLOAD`);
  const warnings = () => proxy.spy.logs.filter((line) => line.level === 'warn').map((line) => line.text);
  assert.equal(warnings().length, 4, warnings().join('\n'));
  assert.match(warnings()[0], /^egress : evil0\.test:\d+ — hôte non autorisé$/);
  assert.match(warnings()[1], new RegExp(`^egress : c411\\.test:${echo.port + 1} — port non autorisé$`));
  assert.match(warnings()[2], /^egress : 127\.0\.0\.1:\d+ — cible CONNECT invalide$/);
  assert.match(warnings()[3], /^egress : POST — méthode autre que CONNECT$/);
  await proxy.close();
  const all = warnings().join('\n');
  assert.match(all, /29 autres événements — hôte non autorisé/);
  assert.match(all, /4 autres événements — port non autorisé/);
  for (const secret of ['SECRET123', 'secret-path', 'PAYLOAD', 'token=abc', 'Bearer', 'Authorization']) assert.ok(!all.includes(secret), secret);
  assert.equal(proxy.spy.logs.filter((line) => line.level === 'error').length, 0);
});

test('hostile targets are truncated and sanitized in the log', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const proxy = await startProxy(t, echo, { logIntervalMs: 0 });
  const targets = ['x'.repeat(500), 'b\u00fccher', 'a%0d%0ab', '..', 'a b', '\u202e'];
  for (const target of targets) {
    const res = await exchange(proxy.port, `CONNECT ${target}:443 HTTP/1.1\r\nHost: c411.test\r\n\r\n`);
    assert.equal(res.status, 400, JSON.stringify(target));
  }
  const lines = proxy.spy.logs.map((line) => line.text);
  assert.ok(lines.length >= 1);
  for (const line of lines) {
    assert.ok(line.length < 200, line);
    assert.doesNotMatch(line, /[\r\n\0\u00c3\u00e2\u00fc\u202e]|x{81}/, line);
  }
  assertUntouched(proxy, echo);
});

test('a refusal because of the resolved address logs the class of the address, never the address', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const proxy = await startProxy(t, echo, { lookup: async () => answer('169.254.169.254') });
  await exchange(proxy.port, connectRequest(`c411.test:${echo.port}`));
  const lines = proxy.spy.logs.map((line) => line.text);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^egress : c411\.test:\d+ — adresse non publique \(link-local\)$/);
  assert.ok(!lines[0].includes('169.254'));
});

test('the log is quiet again after the interval', LIMIT, async (t) => {
  const echo = await startEcho(t);
  const proxy = await startProxy(t, echo, { logIntervalMs: 400 });
  const started = Date.now();
  await exchange(proxy.port, connectRequest(`evil.test:${echo.port}`));
  await exchange(proxy.port, connectRequest(`evil.test:${echo.port}`));
  await sleep(Math.max(0, 450 - (Date.now() - started)));
  await exchange(proxy.port, connectRequest(`evil.test:${echo.port}`));
  const lines = proxy.spy.logs.map((line) => line.text);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /\[\+1 autres\]$/);
});

test('invalid options are rejected when the proxy is created', () => {
  const bad = [
    { ports: [] }, { ports: [0] }, { ports: [65536] }, { ports: [1.5] }, { ports: '443' }, { ports: [443, 'x'] }, { ports: 443 },
    { maxConnections: 0 }, { maxConnections: -1 }, { maxConnections: 1.5 }, { maxConnections: '5' },
    { connectTimeoutMs: 0 }, { idleTimeoutMs: -5 }, { maxLifetimeMs: NaN }, { lookupTimeoutMs: Infinity }, { connectTimeoutMs: 2 ** 31 },
    { logIntervalMs: -1 }, { matcher: {} }, { matcher: null }, { matcher: { allows: true } }
  ];
  for (const options of bad) {
    assert.throws(() => createEgressProxy(options), (e) => e instanceof TypeError || e instanceof RangeError, JSON.stringify(options));
  }
  assert.doesNotThrow(() => createEgressProxy({ ports: [443, 8443], maxConnections: 1, connectTimeoutMs: 1, logIntervalMs: 0 }));
});

function cleanEnv(extra) {
  const env = { ...process.env };
  for (const key of ['EGRESS_PORT', 'EGRESS_HOST', 'C411_ALLOWED_HOSTS', 'NODE_TEST_CONTEXT']) delete env[key];
  return { ...env, ...extra };
}

const running = new Set();
process.on('exit', () => {
  for (const child of running) child.kill('SIGKILL');
});

function launch(extraEnv) {
  const child = spawn(process.execPath, [path.join('server', 'egress.js')], { cwd: ROOT, env: cleanEnv(extraEnv), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const run = { child, out: '', err: '', exit: null };
  running.add(child);
  child.stdout.setEncoding('utf8').on('data', (data) => (run.out += data));
  child.stderr.setEncoding('utf8').on('data', (data) => (run.err += data));
  child.on('error', (e) => (run.err += String(e)));
  run.exited = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      running.delete(child);
      run.exit = { code, signal };
      resolve(run.exit);
    });
  });
  return run;
}

async function stopRun(run) {
  if (run.exit) return run.exit;
  run.child.kill();
  const force = setTimeout(() => run.child.kill('SIGKILL'), 5000);
  const exit = await run.exited;
  clearTimeout(force);
  return exit;
}

test('the command line starts the proxy with the environment settings', LIMIT, async (t) => {
  const port = await freePort();
  const run = launch({ EGRESS_HOST: '127.0.0.1', EGRESS_PORT: String(port), C411_ALLOWED_HOSTS: 'localhost, *.extra.test' });
  t.after(() => stopRun(run));
  await until(() => /à l’écoute/.test(run.out) || run.exit, 'the startup line', 15000);
  assert.ok(!run.exit, `the proxy stopped: ${run.err}`);
  assert.match(run.out, new RegExp(`à l’écoute sur 127\\.0\\.0\\.1:${port} `));
  assert.match(run.out, /ports autorisés : 443/);
  assert.match(run.out, /hôtes autorisés : c411\.org, \*\.c411\.org, challenges\.cloudflare\.com, localhost, \*\.extra\.test/);
  assert.doesNotMatch(run.err, /\S/, 'nothing on stderr');

  assert.equal((await exchange(port, connectRequest('evil.test:443'))).status, 403);
  assert.equal((await exchange(port, connectRequest('c411.org:80'))).status, 403);
  assert.equal((await exchange(port, connectRequest('127.0.0.1:443'))).status, 400);
  assert.equal((await exchange(port, connectRequest('localhost:443'))).status, 403, 'an allowed name that resolves to loopback');
  assert.equal((await exchange(port, 'GET http://c411.org/ HTTP/1.1\r\nHost: c411.org\r\n\r\n')).status, 405);
  assert.doesNotMatch(run.out + run.err, /Bearer|secret/i);
});

test('the command line refuses an invalid configuration', LIMIT, async () => {
  const cases = [
    [{ C411_ALLOWED_HOSTS: 'http://x.example' }, /C411_ALLOWED_HOSTS/],
    [{ C411_ALLOWED_HOSTS: '10.0.0.1' }, /C411_ALLOWED_HOSTS/],
    [{ C411_ALLOWED_HOSTS: 'a.example, *.' }, /C411_ALLOWED_HOSTS/],
    [{ EGRESS_PORT: 'abc' }, /EGRESS_PORT/],
    [{ EGRESS_PORT: '0' }, /EGRESS_PORT/],
    [{ EGRESS_PORT: '65536' }, /EGRESS_PORT/],
    [{ EGRESS_PORT: '1e3' }, /EGRESS_PORT/],
    [{ EGRESS_PORT: '-1' }, /EGRESS_PORT/]
  ];
  const runs = cases.map(([env]) => launch({ EGRESS_HOST: '127.0.0.1', ...env }));
  const exits = await Promise.all(runs.map((run) => run.exited));
  runs.forEach((run, i) => {
    assert.equal(exits[i].code, 1, JSON.stringify(cases[i][0]));
    assert.match(run.err, /Démarrage impossible/, JSON.stringify(cases[i][0]));
    assert.match(run.err, cases[i][1], JSON.stringify(cases[i][0]));
    assert.doesNotMatch(run.out, /à l’écoute/);
  });
});

test('the command line stops cleanly on SIGTERM', { timeout: 30000, skip: POSIX ? false : 'Windows cannot deliver a graceful signal' }, async (t) => {
  const port = await freePort();
  const run = launch({ EGRESS_HOST: '127.0.0.1', EGRESS_PORT: String(port) });
  t.after(() => stopRun(run));
  await until(() => /à l’écoute/.test(run.out) || run.exit, 'the startup line', 15000);
  const idle = new Client(port);
  await until(() => !idle.closed, 'the client to connect');
  run.child.kill('SIGTERM');
  const exit = await run.exited;
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.match(run.out, /SIGTERM reçu : arrêt en cours/);
  await until(() => idle.closed, 'the client to be disconnected');
});

test('main() starts the proxy, then shuts down on SIGTERM and SIGINT', LIMIT, async () => {
  const port = await freePort();
  const lines = { info: [], warn: [], error: [] };
  const log = { info: (...a) => lines.info.push(a.join(' ')), warn: (...a) => lines.warn.push(a.join(' ')), error: (...a) => lines.error.push(a.join(' ')) };
  const exits = [];
  const proc = Object.assign(new EventEmitter(), { exit: (code) => exits.push(code) });
  const env = { EGRESS_HOST: '127.0.0.1', EGRESS_PORT: String(port), C411_ALLOWED_HOSTS: 'extra.example' };
  const proxy = await egress.main({ env, proc, log });
  assert.equal(proxy.server.listening, true);
  assert.equal(proxy.server.address().port, port);
  assert.equal(lines.info.length, 1);
  assert.match(lines.info[0], new RegExp(`127\\.0\\.0\\.1:${port}`));
  assert.match(lines.info[0], /ports autorisés : 443/);
  assert.match(lines.info[0], /c411\.org, \*\.c411\.org, challenges\.cloudflare\.com, extra\.example/);
  assert.deepEqual(lines.warn, []);
  assert.equal(proc.listenerCount('SIGTERM'), 1);
  assert.equal(proc.listenerCount('SIGINT'), 1);
  assert.equal((await exchange(port, connectRequest('evil.example:443'))).status, 403);
  const idle = new Client(port);
  await until(() => !idle.closed, 'the client to connect');
  proc.emit('SIGTERM');
  proc.emit('SIGINT');
  await until(() => exits.length > 0, 'the shutdown');
  await sleep(30);
  assert.deepEqual(exits, [0], 'one single, successful exit');
  assert.equal(proxy.server.listening, false);
  assert.match(lines.info.join('\n'), /SIGTERM reçu : arrêt en cours/);
  await until(() => idle.closed, 'the idle client to be disconnected');
});

test('main() reports the unhandled errors and exits on an uncaught exception', LIMIT, async (t) => {
  const port = await freePort();
  const lines = { info: [], warn: [], error: [] };
  const log = { info: (...a) => lines.info.push(a.join(' ')), warn: (...a) => lines.warn.push(a.join(' ')), error: (...a) => lines.error.push(a.join(' ')) };
  const exits = [];
  const proc = Object.assign(new EventEmitter(), { exit: (code) => exits.push(code) });
  const proxy = await egress.main({ env: { EGRESS_HOST: '127.0.0.1', EGRESS_PORT: String(port) }, proc, log });
  t.after(() => proxy.close());
  proc.emit('unhandledRejection', new Error('lost'));
  assert.deepEqual(exits, []);
  assert.match(lines.error[0], /Promesse rejetée non gérée/);
  proc.emit('uncaughtException', new Error('boom'));
  assert.deepEqual(exits, [1]);
  assert.match(lines.error[1], /Exception non gérée/);
});

test('main() warns when every public host is allowed', LIMIT, async (t) => {
  const port = await freePort();
  const lines = { info: [], warn: [] };
  const log = { info: (...a) => lines.info.push(a.join(' ')), warn: (...a) => lines.warn.push(a.join(' ')), error() {} };
  const proxy = await egress.main({ env: { EGRESS_HOST: '127.0.0.1', EGRESS_PORT: String(port), C411_ALLOWED_HOSTS: '*' }, proc: new EventEmitter(), log });
  t.after(() => proxy.close());
  assert.equal(lines.warn.length, 1);
  assert.match(lines.warn[0], /tout hôte public/);
  assert.match(lines.warn[0], /adresses privées restent refusées/);
});

test('main() fails with a clear message on a bad configuration or a busy port', LIMIT, async (t) => {
  const log = { info() {}, warn() {}, error() {} };
  const proc = Object.assign(new EventEmitter(), { exit() {} });
  await assert.rejects(egress.main({ env: { EGRESS_PORT: 'abc' }, proc, log }), /EGRESS_PORT : « abc » n’est pas un port valide/);
  await assert.rejects(egress.main({ env: { C411_ALLOWED_HOSTS: 'http://x.example' }, proc, log }), /C411_ALLOWED_HOSTS/);
  assert.equal(proc.listenerCount('SIGTERM'), 0, 'nothing is registered when the configuration is refused');
  const busy = net.createServer();
  await new Promise((resolve) => busy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => busy.close(resolve)));
  await assert.rejects(egress.main({ env: { EGRESS_HOST: '127.0.0.1', EGRESS_PORT: String(busy.address().port) }, proc, log }), { code: 'EADDRINUSE' });
});
