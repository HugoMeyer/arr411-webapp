'use strict';
// Filtered HTTP CONNECT proxy: the only way out of the remote browser container, hence its anti-SSRF barrier.
// A tunnel is opened only to an allowed host name on an allowed port, and only when EVERY address that name resolves to is
// public. The name is resolved here, once, and the connection goes to the validated address, never to the name again.
const http = require('node:http');
const net = require('node:net');
const dns = require('node:dns');
const { performance } = require('node:perf_hooks');
const { createMatcher, normalizeHost, parseHosts } = require('./c411/hosts');
const { log: defaultLog } = require('./util');

const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_ATTEMPTS = 4;
const MAX_EARLY_BYTES = 65536;
const REQUEST_LINE_BYTES = 256;
const LINGER_MS = 2000;
const REQUEST_LINE = /^[A-Z]{3,10} \S+ HTTP\/[0-9.]+\r?\n/;
const CONNECT_TARGET = /^([A-Za-z0-9.-]{1,254}):([1-9][0-9]{0,4})$/;

const noop = () => {};
const NO_LOOKUP = (host, options, callback) => callback(new Error('résolution interdite'));

// ---------------------------------------------------------------------------------------------------------------------
// IP addresses
// ---------------------------------------------------------------------------------------------------------------------

const IPV4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;
const HEX_GROUP = /^[0-9a-fA-F]{1,4}$/;

// Strict dotted quad (no leading zeros, no shortened forms) as an unsigned number, or null.
function parseIpv4(text) {
  if (!IPV4.test(text)) return null;
  return text.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}

// 16-bit groups of one side of an IPv6 text. A dotted quad is only valid as the very last element of the address.
function ipv6Groups(items, mayEndWithIpv4) {
  const groups = [];
  for (let i = 0; i < items.length; i++) {
    if (HEX_GROUP.test(items[i])) {
      groups.push(parseInt(items[i], 16));
    } else {
      const v4 = mayEndWithIpv4 && i === items.length - 1 ? parseIpv4(items[i]) : null;
      if (v4 === null) return null;
      groups.push(Math.floor(v4 / 65536), v4 % 65536);
    }
  }
  return groups;
}

// IPv6 text (compressed, mixed notation) as a 128-bit BigInt, or null. Zone ids ("%eth0") and brackets are not accepted.
function parseIpv6(text) {
  if (typeof text !== 'string' || text.length < 2 || text.length > 45 || !/^[0-9a-fA-F:.]+$/.test(text)) return null;
  const sides = text.split('::');
  if (sides.length > 2) return null;
  const items = (side) => (side === '' ? [] : side.split(':'));
  const compressed = sides.length === 2;
  const left = ipv6Groups(items(sides[0]), !compressed);
  const right = compressed ? ipv6Groups(items(sides[1]), true) : [];
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (compressed ? missing < 1 : missing !== 0) return null;
  return [...left, ...new Array(missing).fill(0), ...right].reduce((n, group) => (n << 16n) | BigInt(group), 0n);
}

// More specific ranges come first: the first match wins.
const V4_RANGES = [
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'cgnat'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'reserved'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, 'reserved'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['255.255.255.255', 32, 'broadcast'],
  ['240.0.0.0', 4, 'reserved']
].map(([text, bits, kind]) => ({ start: parseIpv4(text), size: 2 ** (32 - bits), kind }));

// A function as kind means "classify the IPv4 address embedded in this range".
const lowIpv4 = (ip) => Number(ip & 0xffffffffn);
const sixToFourIpv4 = (ip) => Number((ip >> 80n) & 0xffffffffn);
const V6_RANGES = [
  ['::', 128, 'unspecified'],
  ['::1', 128, 'loopback'],
  ['::', 96, 'reserved'],
  ['::ffff:0:0', 96, lowIpv4],
  ['64:ff9b::', 96, lowIpv4],
  ['64:ff9b:1::', 48, 'reserved'],
  ['100::', 64, 'discard'],
  ['2001::', 32, 'teredo'],
  ['2001:2::', 48, 'benchmarking'],
  ['2001:db8::', 32, 'documentation'],
  ['2001::', 23, 'reserved'],
  ['2002::', 16, sixToFourIpv4],
  ['3fff::', 20, 'documentation'],
  ['fc00::', 7, 'ula'],
  ['fe80::', 10, 'link-local'],
  ['fec0::', 10, 'site-local'],
  ['ff00::', 8, 'multicast']
].map(([text, bits, kind]) => ({ shift: BigInt(128 - bits), prefix: parseIpv6(text) >> BigInt(128 - bits), kind }));

function classifyIpv4(n) {
  const range = V4_RANGES.find((r) => n >= r.start && n < r.start + r.size);
  return range ? range.kind : 'public';
}

function classifyIpv6(ip) {
  const range = V6_RANGES.find((r) => ip >> r.shift === r.prefix);
  if (range) return typeof range.kind === 'function' ? classifyIpv4(range.kind(ip)) : range.kind;
  // Only 2000::/3 is global unicast today: everything else is refused by default.
  return ip >> 125n === 1n ? 'public' : 'reserved';
}

// 'public' or the reason why the address must not be reached ('invalid' when the text is not a plain IP address).
function classifyIp(ip) {
  if (typeof ip !== 'string') return 'invalid';
  const v4 = parseIpv4(ip);
  if (v4 !== null) return classifyIpv4(v4);
  const v6 = parseIpv6(ip);
  return v6 === null ? 'invalid' : classifyIpv6(v6);
}

function isPublicIp(ip) {
  return classifyIp(ip) === 'public';
}

// ---------------------------------------------------------------------------------------------------------------------
// CONNECT target
// ---------------------------------------------------------------------------------------------------------------------

// { host, port } for a strict "name:port" authority, null otherwise. IP literals, in any notation, are never accepted.
function parseConnectTarget(authority) {
  if (typeof authority !== 'string') return null;
  const match = CONNECT_TARGET.exec(authority);
  if (!match) return null;
  const port = Number(match[2]);
  const host = normalizeHost(match[1]);
  if (port > 65535 || !host) return null;
  try {
    // A name the URL parser would rewrite (hex or octal numbers, odd punycode) is not a plain DNS name.
    if (new URL(`https://${host}`).hostname !== host) return null;
  } catch {
    return null;
  }
  return { host, port };
}

// ---------------------------------------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------------------------------------

const REFUSALS = {
  invalid: [400, 'cible CONNECT invalide'],
  malformed: [400, 'requête HTTP invalide'],
  slow: [408, 'requête trop lente'],
  oversize: [431, 'en-têtes trop volumineux'],
  method: [405, 'méthode autre que CONNECT'],
  port: [403, 'port non autorisé'],
  host: [403, 'hôte non autorisé'],
  nonpublic: [403, 'adresse non publique'],
  busy: [503, 'trop de connexions simultanées'],
  dns: [502, 'résolution DNS impossible'],
  connect: [502, 'connexion impossible'],
  timeout: [504, 'délai de connexion dépassé']
};
const UPSTREAM_FAILURES = new Set(['dns', 'connect', 'timeout']);
const CLIENT_ERRORS = { HPE_HEADER_OVERFLOW: 'oversize', ERR_HTTP_REQUEST_TIMEOUT: 'slow' };

const printable = (value) => String(value).slice(0, 80).replace(/[^\x21-\x7e]/g, '?');

// A client that sends a second HTTP request before the tunnel exists is not a browser opening a TLS connection.
function looksLikeRequest(chunks) {
  return REQUEST_LINE.test(Buffer.concat(chunks).toString('latin1', 0, REQUEST_LINE_BYTES));
}

// One line per reason and per interval; what is skipped in between is counted and reported with the next line.
function createRefusalLog(log, intervalMs) {
  const seen = new Map();
  return {
    note(key, label, detail) {
      const now = performance.now();
      const entry = seen.get(key) || { at: -Infinity, skipped: 0 };
      seen.set(key, entry);
      if (now - entry.at < intervalMs) {
        entry.skipped++;
        return;
      }
      const more = entry.skipped ? ` [+${entry.skipped} autres]` : '';
      log.warn(`egress : ${printable(label)} — ${REFUSALS[key][1]}${detail ? ` (${detail})` : ''}${more}`);
      entry.at = now;
      entry.skipped = 0;
    },
    flush() {
      for (const [key, entry] of seen) {
        if (entry.skipped) log.warn(`egress : ${entry.skipped} autres événements — ${REFUSALS[key][1]}`);
        entry.skipped = 0;
      }
    }
  };
}

// Answers and closes. The socket keeps being read until the peer is done (or LINGER_MS): closing on unread bytes would
// make the system reset the connection and could discard the answer.
function endWithStatus(socket, status, text) {
  if (socket.destroyed) return;
  const body = `${text}\n`;
  socket.removeAllListeners('data');
  socket.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
  );
  socket.resume();
  const timer = setTimeout(() => socket.destroy(), LINGER_MS);
  timer.unref();
  socket.once('close', () => clearTimeout(timer));
}

function defaultLookup(host) {
  return dns.promises.lookup(host, { all: true, verbatim: true });
}

// Tries IPv4 and IPv6 alternately, starting with the family the resolver prefers.
function interleave(addresses) {
  const v6 = addresses.filter((a) => a.includes(':'));
  const v4 = addresses.filter((a) => !a.includes(':'));
  const [first, second] = addresses[0] && addresses[0].includes(':') ? [v6, v4] : [v4, v6];
  const out = [];
  for (let i = 0; i < first.length || i < second.length; i++) {
    if (i < first.length) out.push(first[i]);
    if (i < second.length) out.push(second[i]);
  }
  return out;
}

function checkInteger(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`egress : option ${name} invalide (entier de ${min} à ${max} attendu)`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------------------------------------------------

function createEgressProxy(opts = {}) {
  const {
    matcher = createMatcher(''),
    ports = [443],
    lookup = defaultLookup,
    allowPrivate = false,
    maxConnections = 256,
    connectTimeoutMs = 10000,
    idleTimeoutMs = 120000,
    maxLifetimeMs = 3600000,
    lookupTimeoutMs = 5000,
    logIntervalMs = 1000,
    connect = net.connect,
    log = defaultLog
  } = opts;
  if (!matcher || typeof matcher.allows !== 'function') throw new TypeError('egress : option matcher invalide');
  if (!Array.isArray(ports) || !ports.length) throw new TypeError('egress : option ports invalide (liste non vide attendue)');
  ports.forEach((port) => checkInteger('ports', port, 1, 65535));
  checkInteger('maxConnections', maxConnections, 1, 65535);
  for (const [name, value] of Object.entries({ connectTimeoutMs, idleTimeoutMs, maxLifetimeMs, lookupTimeoutMs })) {
    checkInteger(name, value, 1, MAX_TIMER_MS);
  }
  checkInteger('logIntervalMs', logIntervalMs, 0, MAX_TIMER_MS);

  const allowedPorts = new Set(ports);
  const stats = { active: 0, established: 0, refused: 0, failed: 0 };
  const refusals = createRefusalLog(log, logIntervalMs);
  const sockets = new Set();
  const sessions = new Set();
  let closing = null;

  const server = http.createServer(
    { maxHeaderSize: 8192, headersTimeout: 10000, requestTimeout: 10000, keepAliveTimeout: 1000, connectionsCheckingInterval: 1000 },
    onRequest
  );
  // Sockets that never send a byte; established tunnels have their own timers.
  server.timeout = 15000;
  server.maxConnections = maxConnections * 2 + 16;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', onClientError);
  server.on('connect', onConnect);
  // Without these, Node answers "100 Continue" (or 417) by itself and invites the client to send a body we will refuse.
  server.on('checkContinue', onRequest);
  server.on('checkExpectation', onRequest);

  function onRequest(req, res) {
    req.on('error', noop);
    refusals.note('method', req.method);
    stats.refused++;
    const [status, text] = REFUSALS.method;
    const body = `${text}\n`;
    res.writeHead(status, {
      Allow: 'CONNECT',
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      Connection: 'close'
    });
    res.end(body);
    req.resume();
  }

  function onClientError(err, socket) {
    socket.on('error', noop);
    if (socket.destroyed || !socket.writable || err.code === 'ECONNRESET') {
      socket.destroy();
      return;
    }
    const key = CLIENT_ERRORS[err.code] || 'malformed';
    refusals.note(key, err.code || 'HTTP');
    stats.refused++;
    endWithStatus(socket, ...REFUSALS[key]);
  }

  async function resolve(host) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('délai de résolution dépassé')), lookupTimeoutMs);
    });
    try {
      const list = await Promise.race([(async () => lookup(host))(), timeout]);
      if (!Array.isArray(list) || !list.length) throw new Error('réponse DNS vide');
      return [...new Set(list.map((entry) => (entry && typeof entry.address === 'string' ? entry.address : '')))];
    } finally {
      clearTimeout(timer);
    }
  }

  // The destination is the validated IP address; `lookup` is a guard so that nothing can ever resolve a name here.
  function openSocket(ip, port, onSocket) {
    return new Promise((resolveSocket, reject) => {
      const socket = connect({ host: ip, port, allowHalfOpen: true, lookup: NO_LOOKUP });
      onSocket(socket);
      socket.on('error', noop);
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeListener('connect', onConnected);
        socket.removeListener('error', fail);
        socket.removeListener('close', fail);
      };
      const onConnected = () => {
        cleanup();
        resolveSocket(socket);
      };
      const fail = (err) => {
        cleanup();
        socket.destroy();
        reject(err instanceof Error ? err : new Error('connexion fermée'));
      };
      const timer = setTimeout(() => fail(Object.assign(new Error('délai de connexion dépassé'), { code: 'ETIMEDOUT' })), connectTimeoutMs);
      socket.once('connect', onConnected);
      socket.once('error', fail);
      socket.once('close', fail);
    });
  }

  async function dial(addresses, port, onSocket, isAborted) {
    let lastError = null;
    for (const ip of interleave(addresses).slice(0, MAX_ATTEMPTS)) {
      if (isAborted()) break;
      try {
        return await openSocket(ip, port, onSocket);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('connexion abandonnée');
  }

  function onConnect(req, client, head) {
    // Node stops listening to the socket errors once the request is handed over: without this, a reset would crash the process.
    client.on('error', noop);
    if (closing) {
      client.destroy();
      return;
    }
    const target = parseConnectTarget(req.url);
    const label = target ? `${target.host}:${target.port}` : req.url;
    let counted = false;
    let ended = false;
    let denied = false;
    let upstream = null;
    const early = [];
    let earlyBytes = 0;
    const halted = () => ended || denied;
    const lifetime = setTimeout(end, maxLifetimeMs);
    lifetime.unref();
    sessions.add(end);
    client.on('error', end);
    client.on('timeout', end);
    client.on('close', end);
    client.setTimeout(idleTimeoutMs);

    function release() {
      if (!counted) return;
      counted = false;
      stats.active--;
    }

    function end() {
      if (ended) return;
      ended = true;
      clearTimeout(lifetime);
      sessions.delete(end);
      release();
      client.destroy();
      if (upstream) upstream.destroy();
    }

    // Bytes sent before the answer are kept, and the socket is read so that an early close is noticed.
    function buffer(chunk) {
      const prefixKnown = earlyBytes >= REQUEST_LINE_BYTES;
      early.push(chunk);
      earlyBytes += chunk.length;
      if (earlyBytes > MAX_EARLY_BYTES) end();
      else if (!prefixKnown && looksLikeRequest(early)) deny('invalid', label);
    }

    function stopBuffering() {
      client.removeListener('data', buffer);
      client.removeListener('end', end);
    }

    function deny(key, reason, detail) {
      if (halted()) return;
      denied = true;
      refusals.note(key, reason, detail);
      stats[UPSTREAM_FAILURES.has(key) ? 'failed' : 'refused']++;
      release();
      stopBuffering();
      if (upstream) upstream.destroy();
      endWithStatus(client, ...REFUSALS[key]);
    }

    async function serve({ host, port }) {
      let addresses;
      try {
        addresses = await resolve(host);
      } catch {
        deny('dns', label);
        return;
      }
      if (halted()) return;
      const unusable = addresses.map(classifyIp).find((kind) => (allowPrivate ? kind === 'invalid' : kind !== 'public'));
      if (unusable) {
        deny('nonpublic', label, unusable);
        return;
      }
      try {
        await dial(addresses, port, (socket) => (upstream = socket), halted);
      } catch (err) {
        deny(err && err.code === 'ETIMEDOUT' ? 'timeout' : 'connect', label);
        return;
      }
      if (halted()) return;
      const first = Buffer.concat(early);
      stopBuffering();
      client.setNoDelay(true);
      upstream.setNoDelay(true);
      upstream.setTimeout(idleTimeoutMs);
      upstream.on('error', end);
      upstream.on('timeout', end);
      upstream.on('close', () => {
        if (client.destroyed || !client.writableEnded) end();
      });
      stats.established++;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (first.length) upstream.write(first);
      client.pipe(upstream);
      upstream.pipe(client);
    }

    const length = req.headers['content-length'];
    const framed = req.headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0');
    if (!target || req.httpVersionMajor !== 1 || framed || looksLikeRequest([head])) {
      deny('invalid', label);
      return;
    }
    if (!allowedPorts.has(target.port)) {
      deny('port', label);
      return;
    }
    if (!matcher.allows(target.host)) {
      deny('host', label);
      return;
    }
    if (stats.active >= maxConnections) {
      deny('busy', label);
      return;
    }
    counted = true;
    stats.active++;
    client.on('data', buffer);
    client.once('end', end);
    if (head.length) buffer(head);
    serve(target).catch((err) => {
      log.error('egress : erreur inattendue :', err && err.message ? err.message : err);
      end();
    });
  }

  function listen(port, host = '127.0.0.1') {
    return new Promise((resolveListen, reject) => {
      if (closing) throw new Error('egress : proxy déjà fermé');
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        server.on('error', (err) => log.error('egress : erreur du serveur :', err && err.code ? err.code : err));
        resolveListen(server.address());
      });
    });
  }

  function close() {
    if (!closing) {
      refusals.flush();
      closing = new Promise((resolveClose) => {
        server.close(() => resolveClose());
        for (const end of [...sessions]) end();
        for (const socket of sockets) socket.destroy();
      });
    }
    return closing;
  }

  return { server, listen, close, stats };
}

// ---------------------------------------------------------------------------------------------------------------------
// Command line: EGRESS_PORT (3128), EGRESS_HOST (0.0.0.0), C411_ALLOWED_HOSTS. No secret, no access to /data.
// ---------------------------------------------------------------------------------------------------------------------

function readConfig(env) {
  const rawPort = String(env.EGRESS_PORT || '').trim();
  const port = rawPort === '' ? 3128 : Number(rawPort);
  if (!/^[0-9]*$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`EGRESS_PORT : « ${printable(rawPort)} » n’est pas un port valide (1 à 65535)`);
  }
  return {
    port,
    host: String(env.EGRESS_HOST || '').trim() || '0.0.0.0',
    matcher: createMatcher(parseHosts(env.C411_ALLOWED_HOSTS))
  };
}

async function main({ env = process.env, proc = process, log = defaultLog } = {}) {
  const { port, host, matcher } = readConfig(env);
  const ports = [443];
  const proxy = createEgressProxy({ matcher, ports, log });
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} reçu : arrêt en cours`);
    const hard = setTimeout(() => proc.exit(1), 5000);
    hard.unref();
    proxy.close().then(
      () => {
        clearTimeout(hard);
        proc.exit(0);
      },
      () => proc.exit(1)
    );
  };
  proc.on('SIGTERM', () => shutdown('SIGTERM'));
  proc.on('SIGINT', () => shutdown('SIGINT'));
  proc.on('unhandledRejection', (e) => log.error('Promesse rejetée non gérée :', (e && e.stack) || e));
  proc.on('uncaughtException', (e) => {
    log.error('Exception non gérée :', (e && e.stack) || e);
    proc.exit(1);
  });
  await proxy.listen(port, host);
  log.info(`egress : proxy CONNECT à l’écoute sur ${host}:${port} — ports autorisés : ${ports.join(', ')} — hôtes autorisés : ${matcher.patterns.join(', ')}`);
  if (matcher.any) log.warn('egress : « * » dans C411_ALLOWED_HOSTS — tout hôte public est joignable (les adresses privées restent refusées)');
  return proxy;
}

if (require.main === module) {
  main().catch((e) => {
    defaultLog.error('Démarrage impossible :', e && e.message ? e.message : e);
    process.exit(1);
  });
}

module.exports = { createEgressProxy, isPublicIp, classifyIp, parseConnectTarget, main };
