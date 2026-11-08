'use strict';
// Server-side port of the "c411-qbittorrent" extension service worker (background.js).
// Messages come from a script running inside a third-party web page: they are hostile input.
// The engine only ever answers with JSON built from validated fields; connection URLs, credentials
// and API keys stay on the server and never appear in a response, an error message or a log line.
const https = require('node:https');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const config = require('../config');
const up = require('../upstream');
const policy = require('../policy');
const { HttpError, log } = require('../util');

const CLIENT_ID = 'c411';
const ARR = {
  radarr: { label: 'Radarr', prefix: '/api/v3' },
  sonarr: { label: 'Sonarr', prefix: '/api/v3' },
  lidarr: { label: 'Lidarr', prefix: '/api/v1' }
};
const SERVICES = Object.keys(ARR);
const MEDIA_TYPES = new Set(['movie', 'series', 'music']);
const SERIES_TYPES = new Set(['standard', 'anime', 'daily']);
const LIDARR_MODES = new Set(['album', 'artist']);
const MAX_MESSAGE_KEYS = 64;
const MAX_OBJECT_KEYS = 32;
const MAX_TITLE = 300;
const MAX_SEASONS = 200;
const MAX_BENCODE_DEPTH = 32;
const MAX_PER_USER = 8;
const MAX_TOTAL = 64;
const MAX_TORRENTS = 20000;
const MAX_LIST = 1000;
const LIMIT_JSON = 4 * 1024 * 1024;
const LIMIT_TORRENTS = 16 * 1024 * 1024;
const LIMIT_ARTISTS = 32 * 1024 * 1024;
const LIMIT_SMALL = 64 * 1024;
const DEADLINE_MS = 120 * 1000;

const MSG = {
  unknown: 'Message inconnu',
  session: 'Session invalide.',
  noInput: 'Action refusée : aucune interaction récente dans la vue C411.',
  busy: 'Trop de requêtes simultanées. Réessaie dans un instant.',
  timeout: 'Délai dépassé. Réessaie.',
  denied: 'Opération non autorisée.',
  internal: 'Erreur interne du moteur C411.',
  notTorrent: 'Le fichier récupéré n’est pas un .torrent valide',
  tooBig: 'Le fichier .torrent est trop volumineux.'
};

class EngineError extends Error {
  constructor(message, kind = 'error') {
    super(message);
    this.name = 'EngineError';
    this.kind = kind;
  }
}

// Failures that must never be hidden behind a fallback (unlike a lookup that simply finds nothing).
const HARD_KINDS = new Set(['network', 'auth', 'config', 'denied', 'timeout']);
const fail = (message, kind) => new EngineError(message, kind);
const invalid = (field) => fail(`Requête invalide (${field}).`, 'input');
const notConfigured = (name) => fail(`${name} n’est pas configuré. Demande à un administrateur de le configurer dans Réglages.`, 'config');
const unexpected = (name) => fail(`Réponse inattendue de ${name}.`, 'upstream');
const soft = (fallback) => (e) => {
  if (e instanceof EngineError && !HARD_KINDS.has(e.kind)) return fallback;
  throw e;
};

// ---------- validation of what the page sends ----------

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const CONTROL_ALL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const own = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined);
const isObject = (v) => Object.prototype.toString.call(v) === '[object Object]';
const asList = (x) => (Array.isArray(x) ? x : isObject(x) ? [x] : []);
const first = (x) => (Array.isArray(x) ? x[0] : x);

function plainObject(v, name, max = MAX_OBJECT_KEYS) {
  if (!isObject(v)) throw invalid(name);
  let n = 0;
  for (const k in v) if (Object.hasOwn(v, k) && ++n > max) throw invalid(name);
  return v;
}

// Kept as is or refused, never "repaired": category names and folders must match exactly.
function strictString(v, max, name) {
  if (v == null || v === '') return '';
  if (typeof v !== 'string' || v.length > max || CONTROL.test(v) || !v.isWellFormed()) throw invalid(name);
  return v;
}

// Free text (titles): control characters and lone surrogates are removed, blanks collapsed.
function titleText(v, max, name) {
  if (v == null) return '';
  if (typeof v !== 'string' || v.length > max * 3) throw invalid(name);
  const t = v.toWellFormed().replace(CONTROL_ALL, ' ').replace(/\s+/g, ' ').trim();
  if (t.length > max) throw invalid(name);
  return t;
}

function hashOf(v, required) {
  if (v == null || v === '') {
    if (required) throw invalid('hash');
    return '';
  }
  if (typeof v !== 'string' || !HASH.test(v)) throw invalid('hash');
  return v.toLowerCase();
}

function flag(v, name, fallback) {
  if (v == null && fallback !== undefined) return fallback;
  if (typeof v !== 'boolean') throw invalid(name);
  return v;
}

function intId(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n >= 1 && n <= 2147483647 ? String(n) : null;
}

function digits(v) {
  if (typeof v === 'string' && /^\d{1,12}$/.test(v)) return v;
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v < 1e12 ? String(v) : null;
}

function mbidOrNull(v) {
  return typeof v === 'string' && MBID.test(v) ? v.toLowerCase() : null;
}

const ID_RULES = {
  imdb: (v) => (typeof v === 'string' && /^tt\d{5,10}$/.test(v) ? v : null),
  tmdb: intId,
  tvdb: intId,
  tmdbKind: (v) => (v === 'movie' || v === 'tv' ? v : null),
  mbReleaseGroup: mbidOrNull,
  mbRelease: mbidOrNull,
  mbArtist: mbidOrNull,
  deezer: digits,
  discogs: digits
};

// Only the fields the extension knows are read; anything else is dropped. A known field with an
// unexpected type or value rejects the whole message.
function cleanMedia(raw) {
  if (raw == null || raw === '') return null;
  const m = plainObject(raw, 'media');
  const type = own(m, 'type');
  if (type == null || type === '') return null;
  if (typeof type !== 'string' || !MEDIA_TYPES.has(type)) throw invalid('media.type');

  const ids = {};
  const rawIds = own(m, 'ids');
  if (rawIds != null) {
    const r = plainObject(rawIds, 'media.ids');
    for (const key of Object.keys(ID_RULES)) {
      const v = own(r, key);
      if (v == null || v === '') continue;
      const clean = ID_RULES[key](v);
      if (clean == null) throw invalid(`media.ids.${key}`);
      ids[key] = clean;
    }
  }

  const seasons = [];
  const rawSeasons = own(m, 'seasons');
  if (rawSeasons != null) {
    if (!Array.isArray(rawSeasons) || rawSeasons.length > MAX_SEASONS) throw invalid('media.seasons');
    for (const n of rawSeasons) {
      if (!Number.isInteger(n) || n < 0 || n > 999) throw invalid('media.seasons');
      seasons.push(n);
    }
  }

  const rawYear = own(m, 'year');
  let year = '';
  if (rawYear != null && rawYear !== '') {
    if ((typeof rawYear !== 'string' && typeof rawYear !== 'number') || !/^(?:19|20)\d{2}$/.test(String(rawYear))) throw invalid('media.year');
    year = String(rawYear);
  }
  const seriesType = own(m, 'seriesType');
  if (seriesType != null && seriesType !== '' && !SERIES_TYPES.has(seriesType)) throw invalid('media.seriesType');
  const lmode = own(m, 'lmode');
  if (lmode != null && lmode !== '' && !LIDARR_MODES.has(lmode)) throw invalid('media.lmode');

  return {
    type,
    ids,
    seasons,
    artist: titleText(own(m, 'artist'), MAX_TITLE, 'media.artist'),
    album: titleText(own(m, 'album'), MAX_TITLE, 'media.album'),
    year,
    rootFolder: strictString(own(m, 'rootFolder'), 500, 'media.rootFolder'),
    seriesType: seriesType || '',
    lmode: lmode || 'album'
  };
}

// Last path component only, no quotes or control characters, 255 characters at most.
function cleanFilename(v) {
  if (v == null || v === '') return 'file.torrent';
  if (typeof v !== 'string' || v.length > 4096) throw invalid('filename');
  const name = v
    .toWellFormed()
    .split(/[\\/]/)
    .pop()
    .replace(CONTROL_ALL, '')
    .replace(/"/g, '')
    .trim()
    .slice(0, 255)
    .toWellFormed();
  return name && name !== '.' && name !== '..' ? name : 'file.torrent';
}

// Strict base64 (no blanks, no URL alphabet), size checked before and after decoding.
function decodeBase64(s, limit) {
  if (typeof s !== 'string' || !s) throw fail('Le fichier .torrent est vide ou mal encodé.', 'input');
  if (s.length > Math.ceil(limit / 3) * 4) throw fail(MSG.tooBig, 'input');
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) throw fail('Le fichier .torrent est vide ou mal encodé.', 'input');
  const buf = Buffer.from(s, 'base64');
  if (buf.length > limit) throw fail(MSG.tooBig, 'input');
  return buf;
}

// ---------- bencode / torrent ----------

const isDigit = (c) => c >= 0x30 && c <= 0x39;
const bad = (why) => new Error(`bencode: ${why}`);

// Returns the index just past the bencoded element starting at i. Never reads outside the
// buffer, always moves forward, and nesting is bounded.
function bencodeEnd(b, i, depth = 0) {
  if (depth > MAX_BENCODE_DEPTH) throw bad('nesting too deep');
  if (!Number.isInteger(i) || i < 0 || i >= b.length) throw bad('truncated');
  const c = b[i];
  if (c === 0x69) {
    let j = i + 1;
    const negative = b[j] === 0x2d;
    if (negative) j++;
    const start = j;
    while (j < b.length && isDigit(b[j])) j++;
    const len = j - start;
    if (len === 0 || len > 20 || b[j] !== 0x65) throw bad('bad integer');
    if (b[start] === 0x30 && (len > 1 || negative)) throw bad('bad integer');
    return j + 1;
  }
  if (c === 0x6c || c === 0x64) {
    const dict = c === 0x64;
    let j = i + 1;
    for (;;) {
      if (j >= b.length) throw bad('truncated');
      if (b[j] === 0x65) return j + 1;
      if (dict) {
        if (!isDigit(b[j])) throw bad('bad dictionary key');
        j = bencodeEnd(b, j, depth + 1);
      }
      j = bencodeEnd(b, j, depth + 1);
    }
  }
  if (isDigit(c)) {
    let j = i;
    while (j < b.length && isDigit(b[j]) && j - i <= 9) j++;
    if (j - i > 9 || b[j] !== 0x3a || (c === 0x30 && j - i > 1)) throw bad('bad string length');
    const end = j + 1 + Number(b.toString('latin1', i, j));
    if (end > b.length) throw bad('truncated');
    return end;
  }
  throw bad('unexpected byte');
}

const BLANKS = new Set([0x09, 0x0a, 0x0d, 0x20]);

// v1 infohash = SHA-1 of the raw bencoded "info" dictionary of the root dictionary.
function parseTorrent(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 2 || buf[0] !== 0x64) throw bad('not a dictionary');
    let i = 1;
    let info = null;
    for (;;) {
      if (i >= buf.length) throw bad('truncated');
      if (buf[i] === 0x65) {
        i++;
        break;
      }
      if (!isDigit(buf[i])) throw bad('bad dictionary key');
      const keyEnd = bencodeEnd(buf, i, 1);
      const valueEnd = bencodeEnd(buf, keyEnd, 1);
      const colon = buf.indexOf(0x3a, i);
      if (keyEnd - colon - 1 === 4 && buf.toString('latin1', colon + 1, keyEnd) === 'info') {
        if (info || buf[keyEnd] !== 0x64) throw bad('bad info');
        info = [keyEnd, valueEnd];
      }
      i = valueEnd;
    }
    if (!info) throw bad('no info');
    for (; i < buf.length; i++) if (!BLANKS.has(buf[i])) throw bad('trailing data');
    return { infoHash: crypto.createHash('sha1').update(buf.subarray(info[0], info[1])).digest('hex') };
  } catch {
    throw fail(MSG.notTorrent, 'input');
  }
}

function multipart(parts) {
  const boundary = `----arr411-${crypto.randomBytes(16).toString('hex')}`;
  const chunks = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename != null) head += `; filename="${p.filename}"\r\nContent-Type: ${p.type}`;
    chunks.push(Buffer.from(`${head}\r\n\r\n`), Buffer.isBuffer(p.value) ? p.value : Buffer.from(String(p.value)), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

// ---------- small pure helpers ----------

const normTitle = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const sameTitle = (a, b) => {
  a = normTitle(a);
  b = normTitle(b);
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
};
const quote = (s) => `"${String(s).replace(/["\\]/g, ' ')}"`;
const mbArtistOf = (x) => mbidOrNull(((((x && x['artist-credit']) || [])[0] || {}).artist || {}).id);

const txt = (v, max = MAX_TITLE) => (typeof v === 'string' ? v.toWellFormed().replace(CONTROL_ALL, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const safeId = (v) => (Number.isSafeInteger(v) && v > 0 ? v : typeof v === 'string' && /^\d{1,12}$/.test(v) ? Number(v) : 0);
const positiveInt = (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};
const qs = (o) =>
  Object.entries(o)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
const trimSlash = (p) => String(p).replace(/[\\/]+$/, '');
const findRoot = (roots, wanted) => roots.find((r) => isObject(r) && typeof r.path === 'string' && trimSlash(r.path) === trimSlash(wanted)) || null;

function errorText(data) {
  if (Array.isArray(data)) {
    return data
      .slice(0, 5)
      .map((e) => (isObject(e) ? e.errorMessage || e.message : ''))
      .filter((s) => typeof s === 'string' && s)
      .join(' ; ');
  }
  if (isObject(data)) return [data.message, data.error].find((s) => typeof s === 'string' && s) || '';
  return typeof data === 'string' ? data : '';
}

// ---------- MusicBrainz ----------

const MB_PATH = /^[a-z][a-z-]*(?:\/[0-9a-f-]{36})?(?:\?[A-Za-z0-9_.~!*'()%+=&:,-]*)?$/;

// Public MusicBrainz web service: HTTPS with certificate checks always on (whatever INSECURE_UPSTREAM_TLS
// says for the other services), one request per second at most, answers cached with a bounded size.
function createMusicBrainz(opts = {}) {
  const origin = new URL(opts.origin || 'https://musicbrainz.org');
  if (origin.protocol !== 'https:') throw new Error('MusicBrainz : HTTPS obligatoire');
  const intervalMs = opts.intervalMs ?? 1000;
  const ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
  const failTtlMs = opts.failTtlMs ?? 30 * 1000;
  const maxEntries = opts.maxEntries ?? 200;
  const maxQueue = opts.maxQueue ?? 8;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxBytes = opts.maxBytes ?? 1024 * 1024;
  const userAgent = opts.userAgent || `Arr411-Web/${opts.version || config.version}`;
  const agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 1, rejectUnauthorized: true, ca: opts.ca });
  const cache = new Map();
  let tail = Promise.resolve();
  let queued = 0;
  let lastStart = 0;
  let closed = false;

  const sleep = (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms).unref();
    });

  function fetchJson(path, retried = false) {
    return new Promise((resolve, reject) => {
      let timer = null;
      let done = false;
      let answered = false;
      const finish = (fn, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        fn(value);
      };
      const req = https.request(
        {
          protocol: 'https:',
          hostname: origin.hostname.replace(/^\[|\]$/g, ''),
          port: origin.port || undefined,
          method: 'GET',
          path: `/ws/2/${path}${path.includes('?') ? '&' : '?'}fmt=json`,
          headers: { 'User-Agent': userAgent, Accept: 'application/json', 'Accept-Encoding': 'identity' },
          agent
        },
        (res) => {
          answered = true;
          if (res.statusCode !== 200) {
            res.resume();
            finish(reject, new Error(`MusicBrainz ${res.statusCode}`));
            return;
          }
          const chunks = [];
          let size = 0;
          res.on('data', (c) => {
            size += c.length;
            if (size > maxBytes) {
              res.destroy();
              finish(reject, new Error('MusicBrainz : réponse trop volumineuse'));
            } else chunks.push(c);
          });
          res.on('end', () => {
            try {
              finish(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
              finish(reject, new Error('MusicBrainz : réponse invalide'));
            }
          });
          res.on('error', (e) => finish(reject, e));
        }
      );
      timer = setTimeout(() => {
        req.destroy();
        finish(reject, new Error('MusicBrainz : délai dépassé'));
      }, timeoutMs);
      timer.unref();
      req.on('error', (e) => {
        // A pooled connection the server had already closed: one more try, on a fresh connection.
        if (!retried && !done && !answered && !closed && req.reusedSocket && (e.code === 'ECONNRESET' || e.code === 'EPIPE')) finish(resolve, fetchJson(path, true));
        else finish(reject, e);
      });
      req.end();
    });
  }

  // Requests start one after the other, at least intervalMs apart.
  function enqueue(job) {
    queued++;
    const run = tail.then(async () => {
      const wait = lastStart + intervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      if (closed) throw new Error('MusicBrainz : arrêté');
      lastStart = Date.now();
      return job();
    });
    tail = run.then(
      () => {},
      () => {}
    );
    return run.finally(() => {
      queued--;
    });
  }

  function get(path) {
    if (closed) return Promise.reject(new Error('MusicBrainz : arrêté'));
    if (typeof path !== 'string' || path.length > 4096 || !MB_PATH.test(path)) return Promise.reject(new Error('MusicBrainz : chemin refusé'));
    const hit = cache.get(path);
    if (hit && hit.until > Date.now()) {
      cache.delete(path);
      cache.set(path, hit);
      return hit.promise;
    }
    // Refused before anything is cached: a busy queue says nothing about the service itself.
    if (queued >= maxQueue) return Promise.reject(new Error('MusicBrainz : file d’attente pleine'));
    const entry = { until: Infinity, promise: null };
    entry.promise = enqueue(() => fetchJson(path)).then(
      (value) => {
        entry.until = Date.now() + ttlMs;
        return value;
      },
      (e) => {
        entry.until = Date.now() + failTtlMs;
        throw e;
      }
    );
    cache.delete(path);
    cache.set(path, entry);
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
    return entry.promise;
  }

  return {
    get,
    agent,
    close() {
      closed = true;
      cache.clear();
      agent.destroy();
    }
  };
}

// ---------- engine ----------

function createEngine({ proxy, users, cfgStore, config: conf = config, musicbrainz, deadlineMs = DEADLINE_MS } = {}) {
  if (!proxy || !users || !cfgStore) throw new TypeError('createEngine : proxy, users et cfgStore sont requis');
  const ownMb = !(musicbrainz && typeof musicbrainz.get === 'function');
  const mb = ownMb ? createMusicBrainz({ version: conf.version }) : musicbrainz;
  const perUser = new Map();
  const chains = new Map();
  const cookies = new Set();
  let total = 0;

  // qBittorrent session cookies handed out so far (bounded): like the credentials, never shown or logged.
  function remember(cookie) {
    if (typeof cookie !== 'string' || cookie.length < 4 || cookies.has(cookie)) return;
    if (cookies.size >= 256) cookies.delete(cookies.values().next().value);
    cookies.add(cookie);
  }
  const defaults = () => (cfgStore.data && cfgStore.data.defaults) || {};
  const dflt = (key) => {
    const v = defaults()[key];
    return v == null ? '' : String(v).replace(CONTROL_ALL, '').slice(0, 500);
  };

  // Everything the server knows about the services that must never reach the page.
  function secrets() {
    const out = new Set();
    for (const svc of ['qb', ...SERVICES]) {
      let c = null;
      try {
        const info = proxy.connInfo(svc);
        c = info && info.conn;
      } catch {
        continue;
      }
      if (!c) continue;
      for (const v of [c.url, c.publicUrl, c.apiKey, c.username, c.password]) if (typeof v === 'string' && v.length >= 4) out.add(v);
      try {
        const u = new URL(c.url);
        for (const v of [u.origin, u.host, u.hostname]) if (v.length >= 4) out.add(v);
      } catch {
        /* no usable URL */
      }
    }
    for (const cookie of cookies) {
      for (const part of cookie.split(';')) {
        const pair = part.trim();
        if (pair.length >= 4) out.add(pair);
        const value = pair.slice(pair.indexOf('=') + 1);
        if (value.length >= 8) out.add(value);
      }
    }
    return [...out].sort((a, b) => b.length - a.length);
  }

  // For text that comes from a service (error messages, replies): URLs, addresses and secrets are masked.
  function scrub(text, max = 200) {
    let t = String(text == null ? '' : text);
    for (const s of secrets()) t = t.split(s).join('…');
    t = t
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, '…')
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, '…')
      .replace(/\[[0-9a-f:.]*:[0-9a-f:.]*\](?::\d{1,5})?/gi, '…')
      .replace(/\b[a-z][a-z0-9_.-]*:\d{2,5}\b/gi, '…')
      .replace(CONTROL_ALL, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return (t.length > max ? `${t.slice(0, max - 1)}…` : t).toWellFormed();
  }

  function failure(e) {
    try {
      if (e instanceof EngineError) return { ok: false, error: e.message };
      if (e instanceof HttpError) return { ok: false, error: scrub(e.message) || MSG.internal };
      log.error('[c411] erreur inattendue :', scrub(`${(e && e.name) || 'Error'}: ${(e && e.message) || e}`, 300));
    } catch {
      /* fall through to the generic answer */
    }
    return { ok: false, error: MSG.internal };
  }

  // The message shown for a failure that does not abort the whole request (the Arr part of an upload).
  const messageOf = (e) => {
    const r = failure(e);
    return r.error;
  };

  // Turns a failed upstream call into a message without any address (see scrub).
  function upstreamError(ctx, e, base) {
    if (ctx.signal.aborted) return fail(MSG.timeout, 'timeout');
    if (e instanceof EngineError) return e;
    if (!base && !(e instanceof HttpError)) return e;
    const he = up.netError(e, base);
    if (he.status === 400) return fail('Requête invalide.', 'upstream');
    return fail(scrub(he.message), he.code === 'network' ? 'network' : 'upstream');
  }

  // One signal per request: upstream.request never removes its abort listener, and a request
  // made of many calls would otherwise pile listeners up on the shared signal.
  async function send(ctx, o, limit) {
    ctx.check();
    const one = new AbortController();
    const stop = () => one.abort();
    ctx.signal.addEventListener('abort', stop, { once: true });
    try {
      return await up.requestBuffered(Object.assign({ signal: one.signal }, o), limit);
    } catch (e) {
      throw upstreamError(ctx, e, o.base);
    } finally {
      ctx.signal.removeEventListener('abort', stop);
    }
  }

  function bodyOf(r, limit) {
    const enc = String(r.headers['content-encoding'] || '').trim().toLowerCase();
    if (!enc || enc === 'identity') return r.body;
    try {
      const o = { maxOutputLength: limit };
      if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(r.body, o);
      if (enc === 'deflate') return zlib.inflateSync(r.body, o);
      if (enc === 'br') return zlib.brotliDecompressSync(r.body, o);
    } catch {
      /* answered below */
    }
    throw fail('Réponse illisible du service.', 'upstream');
  }

  function jsonBody(r, name, limit) {
    try {
      return JSON.parse(bodyOf(r, limit).toString('utf8'));
    } catch (e) {
      if (e instanceof EngineError) throw e;
      throw unexpected(name);
    }
  }

  // ----- qBittorrent -----

  async function qbCookie(ctx, force, stale) {
    ctx.check();
    try {
      const cookie = await proxy.qb.cookieFor(ctx.username, CLIENT_ID, force, stale);
      remember(cookie);
      return cookie;
    } catch (e) {
      if (!(e instanceof HttpError)) throw upstreamError(ctx, e, null);
      if (e.code === 'unconfigured') throw notConfigured('qBittorrent');
      if (e.code === 'qb-credentials' || e.code === 'qb-banned') throw fail(e.message, 'auth');
      throw fail(scrub(e.message), e.code === 'network' ? 'network' : 'upstream');
    }
  }

  async function qb(ctx, method, rest, o = {}) {
    const info = proxy.connInfo('qb');
    if (!info) throw notConfigured('qBittorrent');
    try {
      policy.authorizeQb({ role: ctx.role, rest });
    } catch (e) {
      throw e instanceof HttpError ? fail(MSG.denied, 'denied') : e;
    }
    let base;
    try {
      base = up.parseBase(info.conn.url);
    } catch {
      throw notConfigured('qBittorrent');
    }
    const headers = { Origin: base.origin, Referer: `${base.origin}/`, Accept: '*/*', 'Accept-Encoding': 'identity' };
    if (o.contentType) headers['Content-Type'] = o.contentType;
    const limit = o.limit || LIMIT_JSON;
    const make = (cookie) => ({
      base,
      method,
      path: `${base.path}/api/v2/${rest}${o.query ? `?${o.query}` : ''}`,
      headers: cookie ? Object.assign({ Cookie: cookie }, headers) : headers,
      body: o.body || null
    });
    const cookie = await qbCookie(ctx);
    let r = await send(ctx, make(cookie), limit);
    if (r.status === 401 || r.status === 403) {
      // Expired session: log in again once and replay the request.
      r = await send(ctx, make(await qbCookie(ctx, true, cookie)), limit);
      if (r.status === 401 || r.status === 403) throw fail(`qBittorrent a refusé l’accès (HTTP ${r.status}).`, 'auth');
    }
    return r;
  }

  async function categoryNames(ctx) {
    const r = await qb(ctx, 'GET', 'torrents/categories');
    if (r.status !== 200) throw fail(`Impossible de lire les catégories (qBittorrent ${r.status}).`, 'http');
    const data = jsonBody(r, 'qBittorrent', LIMIT_JSON);
    if (!isObject(data)) throw unexpected('qBittorrent');
    return Object.keys(data)
      .filter((n) => n.length <= 100 && !CONTROL.test(n))
      .sort((a, b) => a.localeCompare(b));
  }

  async function fetchTorrents(ctx) {
    const [t, i] = await Promise.all([
      qb(ctx, 'GET', 'torrents/info', { query: 'sort=added_on&reverse=true', limit: LIMIT_TORRENTS }),
      qb(ctx, 'GET', 'transfer/info').catch(() => null)
    ]);
    if (t.status !== 200) throw fail(`qBittorrent ${t.status}`, 'http');
    const list = jsonBody(t, 'qBittorrent', LIMIT_TORRENTS);
    if (!Array.isArray(list)) throw unexpected('qBittorrent');
    let info = {};
    if (i && i.status === 200) {
      try {
        info = jsonBody(i, 'qBittorrent', LIMIT_SMALL);
      } catch {
        info = {};
      }
    }
    const torrents = list.filter(isObject).slice(0, MAX_TORRENTS).map((t) => ({
      hash: txt(t.hash, 64),
      name: txt(t.name, 500),
      state: txt(t.state, 40),
      progress: num(t.progress),
      dlspeed: num(t.dlspeed),
      upspeed: num(t.upspeed),
      eta: num(t.eta),
      size: num(t.size),
      category: txt(t.category, 100),
      ratio: num(t.ratio),
      completion_on: num(t.completion_on),
      added_on: num(t.added_on)
    }));
    return { torrents, dlspeed: num(isObject(info) ? info.dl_info_speed : 0), upspeed: num(isObject(info) ? info.up_info_speed : 0) };
  }

  async function qbTorrentByHash(ctx, hash) {
    const r = await qb(ctx, 'GET', 'torrents/info', { query: qs({ hashes: hash }) });
    if (r.status !== 200) throw fail(`qBittorrent ${r.status}`, 'http');
    const t = first(jsonBody(r, 'qBittorrent', LIMIT_JSON));
    return isObject(t) ? { name: txt(t.name, 500), state: txt(t.state, 40), progress: num(t.progress), category: txt(t.category, 100) } : null;
  }

  async function qbAdd(ctx, bytes, filename, category, paused) {
    const parts = [{ name: 'torrents', value: bytes, filename, type: 'application/x-bittorrent' }];
    if (category) parts.push({ name: 'category', value: category });
    if (paused) parts.push({ name: 'paused', value: 'true' }, { name: 'stopped', value: 'true' });
    const { body, contentType } = multipart(parts);
    const r = await qb(ctx, 'POST', 'torrents/add', { body, contentType, limit: LIMIT_SMALL });
    const raw = bodyOf(r, LIMIT_SMALL).toString('utf8');
    const text = txt(raw, 100);
    let refused = r.status < 200 || r.status >= 300 || text === 'Fails.';
    if (!refused && raw.startsWith('{')) {
      // qBittorrent 5.1 answers with counters instead of "Ok." / "Fails."
      try {
        const counts = JSON.parse(raw);
        refused = isObject(counts) && num(counts.failure_count) > 0 && !num(counts.success_count) && !num(counts.pending_count);
      } catch {
        refused = false;
      }
    }
    if (refused) {
      const hint = r.status < 300 ? ' — vérifie qu’il n’est pas déjà présent' : '';
      // Masked before being cut: a secret split by the limit would no longer be recognised.
      const detail = scrub(raw, 100);
      throw fail(`qBittorrent a refusé le torrent (HTTP ${r.status}${detail ? ` : ${detail}` : ''})${hint}`, 'http');
    }
  }

  // ----- Radarr / Sonarr / Lidarr -----

  async function arrJson(ctx, svc, method, rest, o = {}) {
    const meta = ARR[svc];
    const info = proxy.connInfo(svc);
    if (!info) throw notConfigured(meta.label);
    // This engine never starts a search or a command, whatever the server settings are.
    if (/^command/i.test(rest)) throw fail(MSG.denied, 'denied');
    let body = null;
    if (o.json !== undefined) {
      if (policy.hasSearchFlag(o.json)) throw fail(MSG.denied, 'denied');
      body = Buffer.from(JSON.stringify(o.json));
    }
    try {
      policy.authorizeArr({ role: ctx.role, method, rest, body, allowSearch: false, contentType: 'application/json' });
    } catch (e) {
      throw e instanceof HttpError ? fail(MSG.denied, 'denied') : e;
    }
    let base;
    try {
      base = up.parseBase(info.conn.url);
    } catch {
      throw notConfigured(meta.label);
    }
    const headers = { 'X-Api-Key': info.conn.apiKey || '', Accept: 'application/json', 'Accept-Encoding': 'identity' };
    if (body) headers['Content-Type'] = 'application/json';
    const limit = o.limit || LIMIT_JSON;
    const r = await send(ctx, { base, method, path: `${base.path}${meta.prefix}/${rest}${o.query ? `?${qs(o.query)}` : ''}`, headers, body }, limit);

    if (r.status === 401 || r.status === 403) {
      throw fail(`${meta.label} a refusé la clé API enregistrée. Un administrateur doit la corriger dans Réglages.`, 'auth');
    }
    if (r.status >= 300 && r.status < 400) {
      throw fail(`${meta.label} a répondu par une redirection : l’URL enregistrée semble incorrecte (http/https, URL de base).`, 'upstream');
    }
    const text = bodyOf(r, limit).toString('utf8');
    let data = null;
    if (text.trim()) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }
    if (r.status < 200 || r.status >= 300) {
      const detail = scrub(errorText(data === undefined ? (/^\s*</.test(text) ? '' : text) : data));
      throw fail(`${meta.label} ${r.status}${detail ? ` : ${detail}` : ''}`, 'http');
    }
    if (data === undefined) throw unexpected(meta.label);
    return data;
  }

  async function arrMeta(ctx, msg) {
    const service = own(msg, 'service');
    if (typeof service !== 'string' || !Object.hasOwn(ARR, service)) throw invalid('service');
    const lidarr = service === 'lidarr';
    const [profiles, roots, metas] = await Promise.all([
      arrJson(ctx, service, 'GET', 'qualityprofile'),
      arrJson(ctx, service, 'GET', 'rootfolder'),
      lidarr ? arrJson(ctx, service, 'GET', 'metadataprofile') : null
    ]);
    const named = (list) =>
      asList(list)
        .filter(isObject)
        .slice(0, MAX_LIST)
        .map((p) => ({ id: num(p.id), name: txt(p.name, 100) }));
    const out = {
      profiles: named(profiles),
      roots: asList(roots)
        .filter((r) => isObject(r) && typeof r.path === 'string' && r.path)
        .slice(0, MAX_LIST)
        .map((r) => txt(r.path, 500))
    };
    if (lidarr) out.metaProfiles = named(metas);
    return out;
  }

  // The folder sent to the service is always one of its own root folders, never the raw page value.
  async function resolveRoot(ctx, svc, wanted) {
    const root = findRoot(asList(await arrJson(ctx, svc, 'GET', 'rootfolder')), wanted);
    if (!root) throw fail(`${ARR[svc].label} : dossier racine introuvable`, 'input');
    return root.path;
  }

  // ----- movies and series -----

  async function lookupMovie(ctx, ids) {
    let movie = null;
    if (ids.tmdb && ids.tmdbKind !== 'tv') {
      movie = first(await arrJson(ctx, 'radarr', 'GET', 'movie/lookup/tmdb', { query: { tmdbId: ids.tmdb } }).catch(soft(null)));
    }
    if (!movie && ids.imdb) {
      movie = first(await arrJson(ctx, 'radarr', 'GET', 'movie/lookup/imdb', { query: { imdbId: ids.imdb } }).catch(soft(null)));
    }
    return isObject(movie) && safeId(movie.tmdbId) ? movie : null;
  }

  async function findMovieInLibrary(ctx, tmdbId) {
    const list = asList(await arrJson(ctx, 'radarr', 'GET', 'movie', { query: { tmdbId } }));
    return list.find((m) => String(m.tmdbId) === String(tmdbId)) || null;
  }

  async function lookupSeries(ctx, ids) {
    const terms = [];
    if (ids.tvdb) terms.push(`tvdb:${ids.tvdb}`);
    if (ids.imdb) terms.push(`imdb:${ids.imdb}`);
    if (ids.tmdb && ids.tmdbKind === 'tv') terms.push(`tmdb:${ids.tmdb}`);
    for (const term of terms) {
      const results = await arrJson(ctx, 'sonarr', 'GET', 'series/lookup', { query: { term } }).catch(soft([]));
      if (Array.isArray(results) && results.length) {
        const s = (ids.tvdb && results.find((r) => isObject(r) && String(r.tvdbId) === ids.tvdb)) || results[0];
        if (isObject(s) && safeId(s.tvdbId)) return s;
      }
    }
    return null;
  }

  async function findSeriesInLibrary(ctx, tvdbId) {
    const list = asList(await arrJson(ctx, 'sonarr', 'GET', 'series', { query: { tvdbId } }));
    return list.find((s) => String(s.tvdbId) === String(tvdbId)) || null;
  }

  // Entries are always added unmonitored and nothing is searched: downloads come from C411.
  async function addMovie(ctx, media) {
    const rootFolder = media.rootFolder || dflt('radarrRoot');
    const profile = positiveInt(dflt('radarrProfile'));
    if (!rootFolder || !profile) throw fail('Radarr : dossier racine / profil qualité non configurés', 'config');
    const movie = await lookupMovie(ctx, media.ids);
    if (!movie) throw fail('Radarr : film introuvable', 'upstream');
    const title = txt(movie.title, 200);
    if (movie.id || (await findMovieInLibrary(ctx, safeId(movie.tmdbId)))) return `déjà dans Radarr (${title})`;
    const root = await resolveRoot(ctx, 'radarr', rootFolder);
    await arrJson(ctx, 'radarr', 'POST', 'movie', {
      json: {
        ...movie,
        qualityProfileId: profile,
        rootFolderPath: root,
        monitored: false,
        minimumAvailability: movie.minimumAvailability || 'released',
        addOptions: { monitor: 'none', searchForMovie: false }
      }
    });
    return `ajouté à Radarr, non surveillé (${title})`;
  }

  async function addSeries(ctx, media) {
    const rootFolder = media.rootFolder || dflt('sonarrRoot');
    const profile = positiveInt(dflt('sonarrProfile'));
    if (!rootFolder || !profile) throw fail('Sonarr : dossier racine / profil qualité non configurés', 'config');
    const series = await lookupSeries(ctx, media.ids);
    if (!series) throw fail('Sonarr : série introuvable', 'upstream');
    const existing = await findSeriesInLibrary(ctx, safeId(series.tvdbId));
    if (existing) return `déjà dans Sonarr (${txt(existing.title, 200)})`;
    const root = await resolveRoot(ctx, 'sonarr', rootFolder);
    await arrJson(ctx, 'sonarr', 'POST', 'series', {
      json: {
        ...series,
        qualityProfileId: profile,
        languageProfileId: 1,
        rootFolderPath: root,
        seriesType: media.seriesType || (SERIES_TYPES.has(series.seriesType) ? series.seriesType : 'standard'),
        monitored: false,
        seasonFolder: true,
        seasons: asList(series.seasons).map((s) => ({ ...s, monitored: false })),
        addOptions: { monitor: 'none', searchForMissingEpisodes: false, searchForCutoffUnmetEpisodes: false }
      }
    });
    return `ajouté à Sonarr, non surveillée (${txt(series.title, 200)})`;
  }

  // ----- music (Lidarr works with MusicBrainz release groups) -----

  // C411 links MusicBrainz releases; without any ID the release group is searched by name.
  // Any failure of the (optional) lookup just means "no ID found".
  const mbGet = (path) => Promise.resolve().then(() => mb.get(path)).catch(() => null);

  async function musicIds(media) {
    const ids = { ...media.ids };
    if (ids.mbRelease && !ids.mbReleaseGroup) {
      const r = await mbGet(`release/${ids.mbRelease}?inc=release-groups+artist-credits`);
      const group = isObject(r) && isObject(r['release-group']) ? mbidOrNull(r['release-group'].id) : null;
      if (group) {
        ids.mbReleaseGroup = group;
        ids.mbArtist = ids.mbArtist || mbArtistOf(r);
      }
    }
    if (!ids.mbReleaseGroup && media.album && media.lmode !== 'artist') {
      const q = `releasegroup:${quote(media.album)}${media.artist ? ` AND artist:${quote(media.artist)}` : ''}`;
      const r = await mbGet(`release-group?limit=10&query=${encodeURIComponent(q)}`);
      const groups = isObject(r) && Array.isArray(r['release-groups']) ? r['release-groups'] : [];
      const found = groups.find((g) => isObject(g) && g.score >= 80 && normTitle(g.title) === normTitle(media.album) && mbidOrNull(g.id));
      if (found) {
        ids.mbReleaseGroup = mbidOrNull(found.id);
        ids.mbArtist = ids.mbArtist || mbArtistOf(found);
      }
    }
    return ids;
  }

  async function lidarrFindArtist(ctx, mbArtist, name) {
    if (typeof mbArtist === 'string' && MBID.test(mbArtist)) {
      const a = asList(await arrJson(ctx, 'lidarr', 'GET', 'artist', { query: { mbId: mbArtist } })).find((x) => x.foreignArtistId === mbArtist);
      if (a || !name) return a || null;
    }
    if (!name) return null;
    const all = asList(await arrJson(ctx, 'lidarr', 'GET', 'artist', { limit: LIMIT_ARTISTS }));
    return all.find((x) => normTitle(x.artistName) === normTitle(name)) || null;
  }

  async function lidarrLookupArtist(ctx, media, ids) {
    if (ids.mbArtist) {
      const a = first(await arrJson(ctx, 'lidarr', 'GET', 'artist/lookup', { query: { term: `lidarr:${ids.mbArtist}` } }).catch(soft(null)));
      if (isObject(a) && a.foreignArtistId) return a;
    }
    if (!media.artist) return null;
    const list = asList(await arrJson(ctx, 'lidarr', 'GET', 'artist/lookup', { query: { term: media.artist } }).catch(soft([])));
    return list.find((a) => normTitle(a.artistName) === normTitle(media.artist)) || null;
  }

  async function lidarrLookupAlbum(ctx, media, ids) {
    for (const id of [ids.mbReleaseGroup, ids.mbRelease]) {
      if (!id) continue;
      const a = first(await arrJson(ctx, 'lidarr', 'GET', 'album/lookup', { query: { term: `lidarr:${id}` } }).catch(soft(null)));
      if (isObject(a) && a.foreignAlbumId) return a;
    }
    if (!media.album) return null;
    const artistOk = (x) => !media.artist || (isObject(x.artist) && ((ids.mbArtist && x.artist.foreignArtistId === ids.mbArtist) || sameTitle(x.artist.artistName, media.artist)));
    for (const term of [[media.artist, media.album].filter(Boolean).join(' '), media.album]) {
      const list = asList(await arrJson(ctx, 'lidarr', 'GET', 'album/lookup', { query: { term } }).catch(soft([])));
      const a = list.find((x) => sameTitle(x.title, media.album) && artistOk(x));
      if (a) return a;
    }
    return null;
  }

  // Root folder and profiles: the options first, then the defaults of the root folder.
  // The "None" metadata profile only keeps manually added albums, so it cannot be used for an artist.
  async function lidarrTarget(ctx, rootFolder, forArtist) {
    const [roots, qps, mps] = (await Promise.all(['rootfolder', 'qualityprofile', 'metadataprofile'].map((p) => arrJson(ctx, 'lidarr', 'GET', p)))).map(asList);
    const wanted = rootFolder || dflt('lidarrRoot') || (roots[0] && roots[0].path);
    if (!wanted) throw fail('Lidarr : aucun dossier racine', 'config');
    const rf = findRoot(roots, wanted);
    if (!rf) throw fail('Lidarr : dossier racine introuvable', 'input');
    const pick = (list, wantedIds, ok = () => true) => wantedIds.map(Number).find((id) => list.some((p) => isObject(p) && p.id === id && ok(p)));
    const quality = pick(qps, [dflt('lidarrProfile'), rf.defaultQualityProfileId, qps[0] && qps[0].id]);
    const realMeta = mps.find((p) => isObject(p) && p.name !== 'None');
    const metadata = pick(mps, [dflt('lidarrMetaProfile'), rf.defaultMetadataProfileId, realMeta && realMeta.id], (p) => !forArtist || p.name !== 'None');
    if (!quality || !metadata) throw fail('Lidarr : profil qualité / métadonnées introuvable', 'config');
    return { path: rf.path, quality, metadata };
  }

  const lidarrArtistBody = (artist, t) => ({
    ...artist,
    qualityProfileId: t.quality,
    metadataProfileId: t.metadata,
    rootFolderPath: t.path,
    monitored: false,
    monitorNewItems: 'none',
    albumFolder: true,
    tags: [],
    addOptions: { monitor: 'none', searchForMissingAlbums: false }
  });

  async function addMusic(ctx, media) {
    const ids = await musicIds(media);
    if (media.lmode === 'artist') {
      let artist = await lidarrFindArtist(ctx, ids.mbArtist, media.artist);
      if (!artist) artist = await lidarrLookupArtist(ctx, media, ids);
      if (!artist) throw fail('Lidarr : artiste introuvable', 'upstream');
      const name = txt(artist.artistName, 200);
      if (artist.id) return `déjà dans Lidarr (${name})`;
      const t = await lidarrTarget(ctx, media.rootFolder, true);
      await arrJson(ctx, 'lidarr', 'POST', 'artist', { json: lidarrArtistBody(artist, t) });
      return `artiste ajouté à Lidarr, non surveillé (${name})`;
    }
    const album = await lidarrLookupAlbum(ctx, media, ids);
    if (!album) throw fail('Lidarr : album introuvable (corrige artiste / album, ou choisis « L’artiste seul »)', 'upstream');
    const artistName = isObject(album.artist) ? txt(album.artist.artistName, 100) : '';
    const name = txt(album.title, 100) + (artistName ? ` — ${artistName}` : '');
    if (album.id) return `déjà dans Lidarr (${name})`;
    const foreignId = mbidOrNull(album.foreignAlbumId);
    if (foreignId) {
      const inLibrary = asList(await arrJson(ctx, 'lidarr', 'GET', 'album', { query: { foreignAlbumId: foreignId } })).find((x) => x.foreignAlbumId === album.foreignAlbumId);
      if (inLibrary) return `déjà dans Lidarr (${name})`;
    }
    let artist = isObject(album.artist) ? album.artist : {};
    if (!artist.id) {
      artist = (await lidarrFindArtist(ctx, artist.foreignArtistId)) || lidarrArtistBody(artist, await lidarrTarget(ctx, media.rootFolder, false));
    }
    await arrJson(ctx, 'lidarr', 'POST', 'album', {
      json: { ...album, artist, monitored: false, anyReleaseOk: true, addOptions: { searchForNewAlbum: false } }
    });
    return `ajouté à Lidarr, non surveillé (${name})`;
  }

  async function addToArr(ctx, media) {
    if (!media) return null;
    const svc = media.type === 'movie' ? 'radarr' : media.type === 'series' ? 'sonarr' : 'lidarr';
    if (!proxy.connInfo(svc)) throw notConfigured(ARR[svc].label);
    if (media.type === 'music') return addMusic(ctx, media);
    return media.type === 'movie' ? addMovie(ctx, media) : addSeries(ctx, media);
  }

  // ----- page status (duplicates / library) -----

  async function movieStatus(ctx, ids) {
    let movie = null;
    if (ids.tmdb && ids.tmdbKind === 'movie') movie = await findMovieInLibrary(ctx, ids.tmdb);
    else {
      const found = await lookupMovie(ctx, ids);
      if (found) movie = found.id ? found : await findMovieInLibrary(ctx, safeId(found.tmdbId));
    }
    if (!movie) return { service: 'Radarr', inLibrary: false };
    return { service: 'Radarr', inLibrary: true, title: txt(movie.title, 200), hasFile: !!movie.hasFile, monitored: !!movie.monitored };
  }

  async function seriesStatus(ctx, ids, seasons) {
    let tvdbId = ids.tvdb;
    if (!tvdbId) {
      const found = await lookupSeries(ctx, ids);
      tvdbId = found && safeId(found.tvdbId);
    }
    const series = tvdbId ? await findSeriesInLibrary(ctx, tvdbId) : null;
    if (!series) return { service: 'Sonarr', inLibrary: false };
    const seasonInfo = seasons.map((n) => {
      const s = asList(series.seasons).find((x) => x.seasonNumber === n);
      const st = (s && isObject(s.statistics) && s.statistics) || {};
      return { number: n, exists: !!s, monitored: !!(s && s.monitored), files: num(st.episodeFileCount), total: num(st.totalEpisodeCount || st.episodeCount) };
    });
    const st = isObject(series.statistics) ? series.statistics : {};
    return {
      service: 'Sonarr',
      inLibrary: true,
      title: txt(series.title, 200),
      seasons: seasonInfo,
      files: num(st.episodeFileCount),
      total: num(st.episodeCount || st.totalEpisodeCount)
    };
  }

  async function musicStatus(ctx, media) {
    const ids = await musicIds(media);
    let album = null;
    let artist = null;
    if (ids.mbReleaseGroup) {
      album = asList(await arrJson(ctx, 'lidarr', 'GET', 'album', { query: { foreignAlbumId: ids.mbReleaseGroup } })).find((x) => x.foreignAlbumId === ids.mbReleaseGroup) || null;
    }
    if (!album) {
      artist = await lidarrFindArtist(ctx, ids.mbArtist, media.artist);
      const artistId = artist && safeId(artist.id);
      if (artistId && media.album) {
        album = asList(await arrJson(ctx, 'lidarr', 'GET', 'album', { query: { artistId } })).find((x) => normTitle(x.title) === normTitle(media.album)) || null;
      }
    }
    if (!album) return artist ? { service: 'Lidarr', inLibrary: true, artistOnly: true, title: txt(artist.artistName, 200) } : { service: 'Lidarr', inLibrary: false };
    const st = isObject(album.statistics) ? album.statistics : {};
    return { service: 'Lidarr', inLibrary: true, title: txt(album.title, 200), files: num(st.trackFileCount), total: num(st.totalTrackCount) };
  }

  async function libraryStatus(ctx, media) {
    const svc = media.type === 'movie' ? 'radarr' : media.type === 'series' ? 'sonarr' : 'lidarr';
    if (!proxy.connInfo(svc)) return null;
    if (media.type === 'movie') return movieStatus(ctx, media.ids);
    if (media.type === 'series') return seriesStatus(ctx, media.ids, media.seasons);
    return musicStatus(ctx, media);
  }

  // ----- message handlers -----

  async function getCategories(ctx) {
    const categories = await categoryNames(ctx);
    const me = users.find(ctx.username);
    const last = me && me.prefs && typeof me.prefs.lastCategory === 'string' ? me.prefs.lastCategory : '';
    return {
      categories: categories.slice(0, MAX_LIST),
      selected: last || dflt('defaultCategory'),
      byType: { movie: dflt('radarrCategory'), series: dflt('sonarrCategory'), music: dflt('lidarrCategory') },
      defaultRoot: { movie: dflt('radarrRoot'), series: dflt('sonarrRoot'), music: dflt('lidarrRoot') },
      arrEnabled: { movie: !!proxy.connInfo('radarr'), series: !!proxy.connInfo('sonarr'), music: !!proxy.connInfo('lidarr') }
    };
  }

  // Errors of either lookup are not shown: the page only displays what could be found.
  async function pageStatus(ctx, msg) {
    const hash = hashOf(own(msg, 'hash'), false);
    const media = cleanMedia(own(msg, 'media'));
    const [qbit, library] = await Promise.all([
      hash ? qbTorrentByHash(ctx, hash).catch(() => null) : null,
      media ? libraryStatus(ctx, media).catch(() => null) : null
    ]);
    return { qbit, library };
  }

  const listTorrents = (ctx) => fetchTorrents(ctx);

  async function qbitIndex(ctx) {
    const { torrents } = await fetchTorrents(ctx);
    return { torrents: torrents.map(({ hash, name, progress, state }) => ({ hash, name, progress, state })) };
  }

  // qBittorrent 5 renamed pause/resume to stop/start.
  async function toggleTorrent(ctx, msg) {
    const hash = hashOf(own(msg, 'hash'), true);
    const pause = flag(own(msg, 'pause'), 'pause');
    const form = Buffer.from(new URLSearchParams({ hashes: hash }).toString());
    const call = (verb) => qb(ctx, 'POST', `torrents/${verb}`, { body: form, contentType: 'application/x-www-form-urlencoded', limit: LIMIT_SMALL });
    let r = await call(pause ? 'stop' : 'start');
    if (r.status === 404) r = await call(pause ? 'pause' : 'resume');
    if (r.status < 200 || r.status >= 300) throw fail(`qBittorrent a refusé la commande (HTTP ${r.status}).`, 'http');
    return {};
  }

  // Uploads of one user run one at a time: two clicks never add the same item twice.
  function serial(key, fn) {
    const run = (chains.get(key) || Promise.resolve()).then(fn);
    const tail = run.then(
      () => {},
      () => {}
    );
    chains.set(key, tail);
    tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return run;
  }

  async function upload(ctx, msg) {
    const filename = cleanFilename(own(msg, 'filename'));
    const category = strictString(own(msg, 'category'), 100, 'category');
    const paused = flag(own(msg, 'paused'), 'paused', false);
    const media = cleanMedia(own(msg, 'media'));
    const base64 = own(msg, 'base64');
    return serial(ctx.username, async () => {
      const bytes = decodeBase64(base64, conf.maxUploadBytes);
      const { infoHash } = parseTorrent(bytes);
      if (!proxy.connInfo('qb')) throw notConfigured('qBittorrent');
      // qBittorrent would create any category it is given: only existing ones are accepted.
      if (category && !(await categoryNames(ctx)).includes(category)) throw fail('Catégorie inconnue dans qBittorrent.', 'input');
      // Added to Radarr/Sonarr/Lidarr first so they already know the item when the download completes.
      let arrResult = null;
      let arrError = null;
      try {
        arrResult = await addToArr(ctx, media);
      } catch (e) {
        ctx.check();
        arrError = messageOf(e);
      }
      await qbAdd(ctx, bytes, filename, category, paused);
      try {
        await users.setPrefs(ctx.username, { lastCategory: category });
      } catch (e) {
        log.warn('[c411] catégorie non mémorisée :', scrub(e && e.message));
      }
      return { hash: infoHash, arrResult, arrError };
    });
  }

  const ack = async () => ({});
  const HANDLERS = { __proto__: null, getCategories, pageStatus, listTorrents, qbitIndex, toggleTorrent, arrMeta, upload, arm: ack, disarm: ack };
  const WRITES = new Set(['upload', 'toggleTorrent']);

  function run(who, type, msg) {
    const name = who.username;
    if (total >= MAX_TOTAL || (perUser.get(name) || 0) >= MAX_PER_USER) throw fail(MSG.busy, 'busy');
    total++;
    perUser.set(name, (perUser.get(name) || 0) + 1);
    const abort = new AbortController();
    const ctx = {
      username: name,
      role: typeof who.role === 'string' ? who.role : 'user',
      signal: abort.signal,
      check() {
        if (abort.signal.aborted) throw fail(MSG.timeout, 'timeout');
      }
    };
    const work = Promise.resolve().then(() => HANDLERS[type](ctx, msg));
    const settled = () => {
      total--;
      const n = (perUser.get(name) || 1) - 1;
      if (n > 0) perUser.set(name, n);
      else perUser.delete(name);
    };
    work.then(settled, settled);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        abort.abort();
        reject(fail(MSG.timeout, 'timeout'));
      }, deadlineMs);
      timer.unref();
      work.then(
        (data) => {
          clearTimeout(timer);
          resolve({ ok: true, ...data });
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        }
      );
    });
  }

  // Never rejects: { ok: true, ...data } or { ok: false, error }.
  async function handle(user, msg, opts) {
    try {
      const type = isObject(msg) ? own(msg, 'type') : undefined;
      if (typeof type !== 'string' || !Object.hasOwn(HANDLERS, type)) return { ok: false, error: MSG.unknown };
      // Arming a download is a page-side matter: nothing to do on the server.
      if (type === 'arm' || type === 'disarm') return { ok: true };
      // The identity is read once: later code only sees this snapshot.
      const who = isObject(user) ? { username: user.username, role: user.role } : null;
      if (!who || typeof who.username !== 'string' || !who.username || who.username.length > 128) return { ok: false, error: MSG.session };
      // Writes need a real user interaction in the remote browser shortly before.
      if (WRITES.has(type) && !(isObject(opts) && opts.recentInput === true)) return { ok: false, error: MSG.noInput };
      plainObject(msg, 'message', MAX_MESSAGE_KEYS);
      return await run(who, type, msg);
    } catch (e) {
      return failure(e);
    }
  }

  return {
    handle,
    close() {
      if (ownMb) mb.close();
    }
  };
}

module.exports = {
  createEngine,
  createMusicBrainz,
  EngineError,
  cleanMedia,
  cleanFilename,
  decodeBase64,
  bencodeEnd,
  parseTorrent,
  normTitle,
  sameTitle,
  MAX_BENCODE_DEPTH
};
