'use strict';
// Moteur C411 : messages de la vue, entrées hostiles, politique, client MusicBrainz.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const h = require('./helpers');

h.prepareEnv({ INSECURE_UPSTREAM_TLS: 'true' });

const config = require('../server/config');
const policy = require('../server/policy');
const { Proxy } = require('../server/proxy');
const { Users } = require('../server/users');
const { JsonStore } = require('../server/store');
const { HttpError } = require('../server/util');
const up = require('../server/upstream');
const { createEngine, createMusicBrainz, EngineError, cleanMedia, cleanFilename, decodeBase64, bencodeEnd, parseTorrent, MAX_BENCODE_DEPTH } = require('../server/c411/engine');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, what, ms = 4000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) assert.fail(`délai dépassé : ${what}`);
    await sleep(20);
  }
}

// ---------- données de test ----------

const SECRET = { qbUser: 'qb-user-s3cret', qbPass: 'qb-pass-Zx81!', radarr: 'radarr-key-0a1b2c3d', sonarr: 'sonarr-key-4e5f6a7b', lidarr: 'lidarr-key-8c9d0e1f' };
const DEFAULTS = {
  defaultCategory: 'Films',
  radarrCategory: 'Films',
  sonarrCategory: 'Séries',
  lidarrCategory: 'Musique',
  radarrProfile: 4,
  radarrRoot: '/movies',
  sonarrProfile: 5,
  sonarrRoot: '/tv',
  lidarrProfile: 2,
  lidarrRoot: '/music',
  lidarrMetaProfile: 3
};
const ALICE = { username: 'alice', role: 'user' };
const BOSS = { username: 'boss', role: 'admin' };

const NO_INPUT = 'Action refusée : aucune interaction récente dans la vue C411.';
const UNKNOWN = { ok: false, error: 'Message inconnu' };
const NOT_TORRENT = 'Le fichier récupéré n’est pas un .torrent valide';
const BUSY = 'Trop de requêtes simultanées. Réessaie dans un instant.';
const TIMEOUT = 'Délai dépassé. Réessaie.';
const INTERNAL = 'Erreur interne du moteur C411.';
const notConfigured = (name) => `${name} n’est pas configuré. Demande à un administrateur de le configurer dans Réglages.`;
const invalid = (field) => `Requête invalide (${field}).`;

const MB = { group: 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb', artist: 'cccccccc-1111-4222-8333-dddddddddddd', release: 'eeeeeeee-1111-4222-8333-ffffffffffff' };
const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);

// Ce que les services « connaissent » (résultats de recherche) : volontairement surveillés et avec recherche demandée.
const MATRIX = {
  title: 'The Matrix',
  tmdbId: 603,
  imdbId: 'tt0133093',
  year: 1999,
  monitored: true,
  minimumAvailability: 'announced',
  addOptions: { searchForMovie: true },
  images: [{ coverType: 'poster', remoteUrl: 'https://image.tmdb.org/poster.jpg' }]
};
const BREAKING = {
  title: 'Breaking Bad',
  tvdbId: 81189,
  imdbId: 'tt0903747',
  tmdbId: 1396,
  seriesType: 'standard',
  monitored: true,
  year: 2008,
  seasons: [
    { seasonNumber: 0, monitored: false },
    { seasonNumber: 1, monitored: true },
    { seasonNumber: 2, monitored: true }
  ]
};
const ARTIST = { foreignArtistId: MB.artist, artistName: 'Daft Punk', overview: 'Duo français' };
const ALBUM = { foreignAlbumId: MB.group, title: 'Discovery', monitored: true, addOptions: { searchForNewAlbum: true }, artist: { ...ARTIST } };

// ---------- fichiers .torrent ----------

function bencode(v) {
  if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from(`${v.length}:`), v]);
  if (typeof v === 'string') return bencode(Buffer.from(v, 'utf8'));
  if (typeof v === 'number') return Buffer.from(`i${v}e`);
  if (Array.isArray(v)) return Buffer.concat([Buffer.from('l'), ...v.map(bencode), Buffer.from('e')]);
  return Buffer.concat([Buffer.from('d'), ...Object.keys(v).sort().flatMap((k) => [bencode(k), bencode(v[k])]), Buffer.from('e')]);
}
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const b64 = (b) => Buffer.from(b).toString('base64');
const INFO = { length: 1234, name: 'Film.2024.1080p', 'piece length': 16384, pieces: Buffer.alloc(20, 7) };
const makeTorrent = (info = INFO, extra = {}) => bencode({ announce: 'http://tracker.invalid/announce', 'creation date': 1700000000, ...extra, info });
const TORRENT = makeTorrent();
const HASH = sha1(bencode(INFO));

// Valeur calculée à part : le « 4:info » du commentaire est un leurre, seul celui de la racine compte.
const LITERAL = Buffer.from(
  'd8:announce23:http://tracker.invalid/7:comment19:4:infod6:lengthi1ee13:creation datei1700000000e4:infod6:lengthi5e4:name5:hello12:piece lengthi16384e6:pieces20:AAAAAAAAAAAAAAAAAAAAee'
);
const LITERAL_HASH = '59b65970d2f8d4063954c00a0a90eddd29b0fd13';
const DECOY_HASH = 'd2f238edc9005ee74e8062a1b089866dabf82e2b';

function prng(seed) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

function randomValue(rand, depth = 0) {
  const kind = Math.floor(rand() * (depth > 3 ? 3 : 5));
  if (kind === 0) return Math.floor(rand() * 2000000) - 1000000;
  if (kind === 1) return Buffer.from(Array.from({ length: Math.floor(rand() * 24) }, () => Math.floor(rand() * 256)));
  if (kind === 2) return `s${Math.floor(rand() * 1000)}`;
  if (kind === 3) return Array.from({ length: Math.floor(rand() * 4) }, () => randomValue(rand, depth + 1));
  const o = {};
  for (let i = Math.floor(rand() * 4); i > 0; i--) o[`k${Math.floor(rand() * 50)}`] = randomValue(rand, depth + 1);
  return o;
}

// ---------- faux services ----------

let SEQ = 0;

const json = (res, status, body, headers) => {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, headers));
  res.end(JSON.stringify(body));
};

// Ajoute des routes à un faux service de helpers.js. Une requête authentifiée vers l’une d’elles est traitée ici ;
// le reste passe par le gestionnaire d’origine, qui répond 401/403 comme le vrai service.
// m.force['MÉTHODE /chemin'] (ou '*') remplace la réponse : { status, body, headers } ou { stall: true }.
function extend(m, { authed, routes }) {
  const base = m.server.listeners('request')[0];
  m.server.removeAllListeners('request');
  m.force = Object.create(null);
  m.aborted = 0;
  m.server.on('request', async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const key = `${req.method} ${u.pathname}`;
    const forced = m.force[key] || m.force['*'];
    if (!authed(req) || (!forced && !Object.hasOwn(routes, key))) return base(req, res);
    const chunks = [];
    try {
      for await (const c of req) chunks.push(c);
    } catch {
      return;
    }
    const rec = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks), seq: ++SEQ };
    m.reqs.push(rec);
    try {
      if (forced && forced.stall) {
        res.on('close', () => m.aborted++);
        return;
      }
      if (forced) {
        res.writeHead(forced.status, Object.assign({ 'Content-Type': 'text/plain' }, forced.headers));
        return res.end(forced.body);
      }
      await routes[key](req, res, rec, u);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String((e && e.stack) || e));
    }
  });
}

function parseMultipart(rec) {
  const boundary = /boundary=(.+)$/.exec(rec.headers['content-type'] || '')[1];
  const sep = Buffer.from(`--${boundary}`);
  const parts = {};
  let pos = rec.body.indexOf(sep);
  for (;;) {
    const next = rec.body.indexOf(sep, pos + sep.length);
    if (next < 0) break;
    const part = rec.body.subarray(pos + sep.length + 2, next - 2);
    const headEnd = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, headEnd).toString('utf8');
    const file = /filename="([^"]*)"/.exec(head);
    const type = /Content-Type: (.+)/i.exec(head);
    parts[/name="([^"]*)"/.exec(head)[1]] = { value: part.subarray(headEnd + 4), filename: file ? file[1] : null, type: type ? type[1].trim() : null };
    pos = next;
  }
  return { parts, boundary };
}

const sidOf = (req) => (/(?:^|;\s*)SID=([^;]+)/.exec(req.headers.cookie || '') || [])[1];

async function qbServer() {
  const m = await h.qbMock();
  Object.assign(m.state, { user: SECRET.qbUser, pass: SECRET.qbPass });
  Object.assign(m, {
    cats: {
      Séries: { name: 'Séries', savePath: '/s' },
      Films: { name: 'Films', savePath: '/f' },
      Musique: { name: 'Musique', savePath: '/m' },
      Animés: { name: 'Animés', savePath: '/a' }
    },
    torrents: [],
    speeds: { dl_info_speed: 111, up_info_speed: 22 },
    adds: [],
    addReply: { status: 200, body: 'Ok.' },
    toggles: [],
    v4: false
  });
  // qBittorrent 5 : stop/start ; avant : pause/resume (l’autre couple répond 404).
  const toggle = (verb, v4Only) => (req, res, rec) => {
    m.toggles.push({ verb, hashes: new URLSearchParams(rec.body.toString()).get('hashes') });
    const ok = m.v4 === v4Only;
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'text/plain' });
    res.end(ok ? '' : 'Not Found');
  };
  extend(m, {
    authed: (req) => m.state.noAuth || m.state.sessions.has(sidOf(req)),
    routes: {
      'GET /api/v2/torrents/categories': (req, res) => json(res, 200, m.cats),
      'GET /api/v2/torrents/info': (req, res, rec, u) => {
        const wanted = u.searchParams.get('hashes');
        json(res, 200, wanted ? m.torrents.filter((t) => wanted.split('|').includes(t.hash)) : m.torrents);
      },
      'GET /api/v2/transfer/info': (req, res) => json(res, 200, m.speeds),
      'POST /api/v2/torrents/add': (req, res, rec) => {
        m.adds.push({ ...parseMultipart(rec), seq: rec.seq });
        res.writeHead(m.addReply.status, { 'Content-Type': 'text/plain' });
        res.end(m.addReply.body);
      },
      'POST /api/v2/torrents/stop': toggle('stop', false),
      'POST /api/v2/torrents/start': toggle('start', false),
      'POST /api/v2/torrents/pause': toggle('pause', true),
      'POST /api/v2/torrents/resume': toggle('resume', true)
    }
  });
  return m;
}

const keyed = (key) => (req) => req.headers['x-api-key'] === key;
const added = (m, list, base) => (req, res, rec) => {
  const body = { ...JSON.parse(rec.body.toString()), id: base + list().length };
  list().push(body);
  json(res, 201, body);
};

async function radarrServer() {
  const m = await h.arrMock({ key: SECRET.radarr, prefix: '/api/v3', root: 'movie' });
  Object.assign(m, {
    movies: { 603: { ...MATRIX } },
    library: [],
    roots: [{ id: 1, path: '/movies', freeSpace: 99, unmappedFolders: [{ path: '/movies/old' }] }, { id: 2, path: '/films' }],
    profiles: [{ id: 4, name: 'HD', upgradeAllowed: true, items: [{ quality: { id: 1 } }] }, { id: 5, name: 'Any' }]
  });
  const at = (p) => `/api/v3/${p}`;
  extend(m, {
    authed: keyed(SECRET.radarr),
    routes: {
      [`GET ${at('movie/lookup/tmdb')}`]: (req, res, rec, u) => {
        const movie = m.movies[u.searchParams.get('tmdbId')];
        return movie ? json(res, 200, movie) : json(res, 404, { message: 'NotFound' });
      },
      [`GET ${at('movie/lookup/imdb')}`]: (req, res, rec, u) => json(res, 200, Object.values(m.movies).filter((x) => x.imdbId === u.searchParams.get('imdbId'))),
      [`GET ${at('movie')}`]: (req, res, rec, u) => json(res, 200, m.library.filter((x) => String(x.tmdbId) === u.searchParams.get('tmdbId'))),
      [`POST ${at('movie')}`]: added(m, () => m.library, 100),
      [`GET ${at('rootfolder')}`]: (req, res) => json(res, 200, m.roots),
      [`GET ${at('qualityprofile')}`]: (req, res) => json(res, 200, m.profiles)
    }
  });
  return m;
}

async function sonarrServer() {
  const m = await h.arrMock({ key: SECRET.sonarr, prefix: '/api/v3', root: 'series' });
  Object.assign(m, {
    shows: { 81189: { ...BREAKING } },
    library: [],
    roots: [{ id: 1, path: '/tv', freeSpace: 1 }, { id: 2, path: '/anime' }],
    profiles: [{ id: 5, name: 'HD', cutoff: 3 }]
  });
  const at = (p) => `/api/v3/${p}`;
  extend(m, {
    authed: keyed(SECRET.sonarr),
    routes: {
      [`GET ${at('series/lookup')}`]: (req, res, rec, u) => {
        const [kind, value] = (u.searchParams.get('term') || '').split(':');
        const field = { tvdb: 'tvdbId', imdb: 'imdbId', tmdb: 'tmdbId' }[kind];
        json(res, 200, Object.values(m.shows).filter((x) => field && String(x[field]) === value));
      },
      [`GET ${at('series')}`]: (req, res, rec, u) => json(res, 200, m.library.filter((x) => String(x.tvdbId) === u.searchParams.get('tvdbId'))),
      [`POST ${at('series')}`]: added(m, () => m.library, 100),
      [`GET ${at('rootfolder')}`]: (req, res) => json(res, 200, m.roots),
      [`GET ${at('qualityprofile')}`]: (req, res) => json(res, 200, m.profiles)
    }
  });
  return m;
}

async function lidarrServer() {
  const m = await h.arrMock({ key: SECRET.lidarr, prefix: '/api/v1', root: 'artist' });
  Object.assign(m, {
    artists: [{ ...ARTIST }],
    albums: [{ ...ALBUM, artist: { ...ARTIST } }],
    libArtists: [],
    libAlbums: [],
    roots: [{ id: 1, path: '/music', defaultQualityProfileId: 2, defaultMetadataProfileId: 3, freeSpace: 1 }],
    profiles: [{ id: 2, name: 'Lossless' }, { id: 6, name: 'MP3' }],
    metas: [{ id: 1, name: 'None' }, { id: 3, name: 'Standard' }]
  });
  const at = (p) => `/api/v1/${p}`;
  const term = (u) => u.searchParams.get('term') || '';
  const named = (text, t) => String(text).toLowerCase().includes(t.toLowerCase());
  extend(m, {
    authed: keyed(SECRET.lidarr),
    routes: {
      [`GET ${at('artist/lookup')}`]: (req, res, rec, u) => {
        const t = term(u);
        json(res, 200, t.startsWith('lidarr:') ? m.artists.filter((a) => a.foreignArtistId === t.slice(7)) : m.artists.filter((a) => named(a.artistName, t)));
      },
      [`GET ${at('album/lookup')}`]: (req, res, rec, u) => {
        const t = term(u);
        json(res, 200, t.startsWith('lidarr:') ? m.albums.filter((a) => a.foreignAlbumId === t.slice(7)) : m.albums.filter((a) => named(`${a.artist.artistName} ${a.title}`, t)));
      },
      [`GET ${at('artist')}`]: (req, res, rec, u) => {
        const id = u.searchParams.get('mbId');
        json(res, 200, id ? m.libArtists.filter((a) => a.foreignArtistId === id) : m.libArtists);
      },
      [`GET ${at('album')}`]: (req, res, rec, u) => {
        const foreign = u.searchParams.get('foreignAlbumId');
        const artistId = u.searchParams.get('artistId');
        json(res, 200, m.libAlbums.filter((a) => (!foreign || a.foreignAlbumId === foreign) && (!artistId || String(a.artistId) === artistId)));
      },
      [`POST ${at('artist')}`]: added(m, () => m.libArtists, 200),
      [`POST ${at('album')}`]: added(m, () => m.libAlbums, 300),
      [`GET ${at('rootfolder')}`]: (req, res) => json(res, 200, m.roots),
      [`GET ${at('qualityprofile')}`]: (req, res) => json(res, 200, m.profiles),
      [`GET ${at('metadataprofile')}`]: (req, res) => json(res, 200, m.metas)
    }
  });
  return m;
}

// MusicBrainz injecté : indisponible tant qu’un test ne lui donne pas de comportement.
function fakeMusicBrainz() {
  const mb = { calls: [], closed: 0, handler: async () => Promise.reject(new Error('MusicBrainz : indisponible')) };
  mb.get = (p) => {
    mb.calls.push(p);
    return mb.handler(p);
  };
  mb.close = () => {
    mb.closed++;
  };
  return mb;
}

// ---------- environnement de test ----------

let sharedUsers = null;
async function getUsers() {
  if (!sharedUsers) {
    const store = new JsonStore(path.join(h.tmpDir(), 'users.json'), () => ({ version: 1, users: [] })).load();
    const users = new Users(store);
    await users.create({ username: ALICE.username, password: 'alice-password-1', role: 'user' });
    await users.create({ username: BOSS.username, password: 'boss-password-123', role: 'admin' });
    sharedUsers = users;
  }
  for (const u of sharedUsers.all) u.prefs = {};
  return sharedUsers;
}

// Un vrai Proxy, un vrai magasin d’utilisateurs, des services factices (o.services pour n’en démarrer que certains).
async function setup(o = {}) {
  const makers = { qb: qbServer, radarr: radarrServer, sonarr: sonarrServer, lidarr: lidarrServer };
  const mocks = {};
  for (const svc of o.services || Object.keys(makers)) mocks[svc] = await makers[svc]();
  const connections = {};
  if (mocks.qb) connections.qb = { url: mocks.qb.url, username: SECRET.qbUser, password: SECRET.qbPass };
  for (const svc of ['radarr', 'sonarr', 'lidarr']) if (mocks[svc]) connections[svc] = { url: mocks[svc].url, apiKey: SECRET[svc] };
  const cfgStore = { data: { version: 1, rev: {}, connections, defaults: { ...DEFAULTS, ...o.defaults } }, save: async () => {} };
  const proxy = new Proxy({ store: cfgStore });
  const users = o.users || (await getUsers());
  const mb = o.musicbrainz || fakeMusicBrainz();
  const engine = createEngine({ proxy, users, cfgStore, config: o.config || config, musicbrainz: mb, deadlineMs: o.deadlineMs });
  const responses = [];
  const as = async (user, msg, opts) => {
    const r = await engine.handle(user, msg, opts);
    responses.push(r);
    return r;
  };
  return {
    mocks,
    cfgStore,
    proxy,
    users,
    engine,
    mb,
    responses,
    as,
    call: (msg, user = ALICE) => as(user, msg, { recentInput: true }),
    total: () => Object.values(mocks).reduce((n, m) => n + m.reqs.length, 0),
    // Aucune réponse ne doit contenir d’adresse, d’identifiant ou de clé des services.
    sweep(...extra) {
      const needles = [...Object.values(SECRET), 'SID=', '127.0.0.1', 'localhost', ...extra];
      for (const m of Object.values(mocks)) needles.push(m.url, `:${m.port}`);
      for (const r of responses) {
        const text = JSON.stringify(r);
        assert.equal(typeof r.ok, 'boolean', text);
        if (!r.ok) assert.ok(typeof r.error === 'string' && r.error, text);
        for (const n of needles) assert.ok(!text.includes(n), `fuite de « ${n} » dans la réponse : ${text.slice(0, 300)}`);
      }
    },
    async close() {
      engine.close();
      await proxy.close();
      await Promise.all(Object.values(mocks).map((m) => m.close()));
    }
  };
}

async function withSetup(fn, o) {
  const s = await setup(o);
  try {
    await fn(s);
    s.sweep();
  } finally {
    await s.close();
  }
}

const lines = (m) => m.reqs.map((r) => `${r.method} ${r.url}`);
const only = (m, method, pathname) => m.reqs.filter((r) => r.method === method && r.url.split('?')[0] === pathname);
const bodyOf = (r) => JSON.parse(r.body.toString());
const upMsg = (o = {}) => ({ type: 'upload', base64: b64(TORRENT), filename: 'Film.2024.1080p.torrent', category: 'Films', paused: false, media: null, ...o });

// Ni recherche ni commande envoyées, et aucun corps d’écriture ne porte de drapeau de recherche.
function assertNoSearch(s) {
  for (const [svc, m] of Object.entries(s.mocks)) {
    for (const r of m.reqs) {
      const p = r.url.split('?')[0];
      assert.ok(!/\/command(\/|$)/i.test(p) && !p.startsWith('/api/v2/search'), `recherche ou commande envoyée à ${svc} : ${r.method} ${r.url}`);
      if (svc !== 'qb' && r.method !== 'GET' && r.body.length) assert.equal(policy.hasSearchFlag(bodyOf(r)), false, `drapeau de recherche dans ${r.method} ${r.url}`);
    }
  }
}

// ---------- A. fonctions pures ----------

test('cleanMedia : champs connus normalisés, tout le reste ignoré', () => {
  const media = cleanMedia({
    type: 'music',
    ids: {
      imdb: 'tt0133093',
      tmdb: 603,
      tvdb: '81189',
      tmdbKind: 'tv',
      mbReleaseGroup: MB.group.toUpperCase(),
      mbRelease: MB.release,
      mbArtist: MB.artist,
      deezer: 12345,
      discogs: '999',
      evil: '../x',
      constructor: 'x'
    },
    seasons: [0, 1, 20],
    artist: '  Daft\u0000\n  Punk ',
    album: 'Discovery',
    year: 2001,
    rootFolder: '/music',
    seriesType: 'anime',
    lmode: 'artist',
    url: 'http://evil.example/',
    hacked: { a: 1 }
  });
  assert.deepEqual(media, {
    type: 'music',
    ids: { imdb: 'tt0133093', tmdb: '603', tvdb: '81189', tmdbKind: 'tv', mbReleaseGroup: MB.group, mbRelease: MB.release, mbArtist: MB.artist, deezer: '12345', discogs: '999' },
    seasons: [0, 1, 20],
    artist: 'Daft Punk',
    album: 'Discovery',
    year: '2001',
    rootFolder: '/music',
    seriesType: 'anime',
    lmode: 'artist'
  });
  assert.deepEqual(cleanMedia({ type: 'movie' }), { type: 'movie', ids: {}, seasons: [], artist: '', album: '', year: '', rootFolder: '', seriesType: '', lmode: 'album' });
});

test('cleanMedia : absence de media ou de type → null', () => {
  for (const v of [undefined, null, '', {}, { type: '' }, { type: null }, { ids: { tmdb: 1 } }]) assert.equal(cleanMedia(v), null);
});

test('cleanMedia : valeurs hostiles refusées', () => {
  const many = {};
  for (let i = 0; i < 40; i++) many[`k${i}`] = i;
  const hostile = [
    'movie', 42, true, [], [1], new Date(), new Map(),
    { type: 'film' }, { type: 5 }, { type: ['movie'] }, { type: { toString: () => 'movie' } },
    { type: 'movie', ids: 'tt0133093' }, { type: 'movie', ids: [] }, { type: 'movie', ids: many }, { ...many, type: 'movie' },
    { type: 'movie', ids: { imdb: '../../etc/passwd' } }, { type: 'movie', ids: { imdb: 'tt1' } }, { type: 'movie', ids: { imdb: 'tt0133093/../x' } }, { type: 'movie', ids: { imdb: 603 } },
    { type: 'movie', ids: { tmdb: '../1' } }, { type: 'movie', ids: { tmdb: -1 } }, { type: 'movie', ids: { tmdb: 0 } }, { type: 'movie', ids: { tmdb: 1.5 } },
    { type: 'movie', ids: { tmdb: 2 ** 40 } }, { type: 'movie', ids: { tmdb: '1e3' } }, { type: 'movie', ids: { tmdb: {} } }, { type: 'movie', ids: { tmdb: [603] } },
    { type: 'movie', ids: { tmdb: NaN } }, { type: 'movie', ids: { tvdb: '12345678901' } }, { type: 'movie', ids: { tmdbKind: 'person' } },
    { type: 'music', ids: { mbArtist: '../../x' } }, { type: 'music', ids: { mbReleaseGroup: 'not-a-uuid' } }, { type: 'music', ids: { mbRelease: `${MB.release}/..` } },
    { type: 'music', ids: { deezer: '12/../3' } }, { type: 'music', ids: { discogs: 'a1' } },
    { type: 'series', seasons: 'all' }, { type: 'series', seasons: [-1] }, { type: 'series', seasons: [1.5] }, { type: 'series', seasons: ['1'] },
    { type: 'series', seasons: [1000] }, { type: 'series', seasons: new Array(201).fill(1) },
    { type: 'movie', year: '19999' }, { type: 'movie', year: '../' }, { type: 'movie', year: {} },
    { type: 'movie', rootFolder: 'x'.repeat(501) }, { type: 'movie', rootFolder: '/a\u0000b' }, { type: 'movie', rootFolder: 5 }, { type: 'movie', rootFolder: ['/a'] },
    { type: 'movie', seriesType: 'other' }, { type: 'music', lmode: 'track' },
    { type: 'music', artist: 'x'.repeat(901) }, { type: 'music', artist: 'y'.repeat(301) }, { type: 'music', album: 12 }, { type: 'music', album: {} }
  ];
  for (const v of hostile) {
    assert.throws(() => cleanMedia(v), (e) => e instanceof EngineError && e.kind === 'input' && /^Requête invalide \(media/.test(e.message), `accepté à tort : ${JSON.stringify(v)}`);
  }
});

test('cleanMedia : __proto__ et propriétés héritées ne comptent pas', () => {
  const evil = JSON.parse('{"type":"movie","__proto__":{"polluted":true},"ids":{"__proto__":{"tmdb":"1"},"imdb":"tt0133093"},"constructor":{"x":1}}');
  const media = cleanMedia(evil);
  assert.deepEqual(media.ids, { imdb: 'tt0133093' });
  assert.equal({}.polluted, undefined);
  assert.equal(cleanMedia(Object.create({ type: 'movie' })), null);
  assert.deepEqual(cleanMedia({ type: 'movie', ids: Object.create({ imdb: 'tt0133093' }) }).ids, {});
});

test('cleanFilename : dernier composant, sans guillemets ni contrôles, 255 caractères au plus', () => {
  const cases = {
    'Film.2024.torrent': 'Film.2024.torrent',
    '../../etc/passwd': 'passwd',
    'C:\\Users\\x\\evil.torrent': 'evil.torrent',
    'a/b\\c.torrent': 'c.torrent',
    'x".torrent': 'x.torrent',
    'bad\r\nname.torrent': 'badname.torrent',
    'a\u0000b.torrent': 'ab.torrent',
    '..': 'file.torrent',
    '.': 'file.torrent',
    'dir/': 'file.torrent',
    '   ': 'file.torrent'
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(cleanFilename(input), expected, JSON.stringify(input));
  for (const v of [undefined, null, '']) assert.equal(cleanFilename(v), 'file.torrent');
  assert.equal(cleanFilename('x'.repeat(400)).length, 255);
  assert.equal(cleanFilename('é'.repeat(300)).length, 255);
  assert.equal(cleanFilename('\ud800x.torrent').isWellFormed(), true);
  for (const v of [5, {}, [], true, 'x'.repeat(4097)]) assert.throws(() => cleanFilename(v), /Requête invalide \(filename\)/);
});

test('decodeBase64 : alphabet, remplissage et tailles stricts', () => {
  assert.deepEqual(decodeBase64(Buffer.from('hello world!').toString('base64'), 100), Buffer.from('hello world!'));
  assert.deepEqual(decodeBase64('YQ==', 100), Buffer.from('a'));
  const bad = ['', 'YQ', 'YQ=', 'YQ===', 'YQ==YQ==', ' YQ==', 'YQ==\n', 'YW Jj', 'YW-j', 'YW_j', 'YW\u00e9j', '====', 'Y=Q=', null, undefined, 5, {}, ['YQ=='], Buffer.from('YQ==')];
  for (const v of bad) assert.throws(() => decodeBase64(v, 100), /vide ou mal encodé/, JSON.stringify(v));
  assert.equal(decodeBase64(Buffer.alloc(100, 1).toString('base64'), 100).length, 100);
  assert.throws(() => decodeBase64(Buffer.alloc(101).toString('base64'), 100), /trop volumineux/);
  assert.throws(() => decodeBase64('A'.repeat(4000000), 1000), /trop volumineux/);
});

test('parseTorrent : l’infohash est le SHA-1 du dictionnaire info de la racine (valeur connue)', () => {
  assert.equal(parseTorrent(LITERAL).infoHash, LITERAL_HASH);
  assert.notEqual(parseTorrent(LITERAL).infoHash, DECOY_HASH);
  assert.equal(parseTorrent(TORRENT).infoHash, HASH);
});

test('parseTorrent : info n’importe où dans la racine, leurres dans les valeurs', () => {
  for (let seed = 1; seed <= 150; seed++) {
    const rand = prng(seed);
    const info = {
      name: `n${seed}`,
      'piece length': 16384,
      pieces: Buffer.from(Array.from({ length: 20 * (1 + (seed % 3)) }, () => Math.floor(rand() * 256))),
      extra: randomValue(rand)
    };
    const root = { info, decoy: Buffer.from('4:infod6:lengthi1ee') };
    for (let i = Math.floor(rand() * 6); i > 0; i--) root[`${String.fromCharCode(97 + Math.floor(rand() * 26))}${i}`] = randomValue(rand);
    assert.equal(parseTorrent(bencode(root)).infoHash, sha1(bencode(info)), `graine ${seed}`);
  }
  // Clés non triées : tolérées, l’ordre ne change pas l’infohash.
  assert.equal(parseTorrent(Buffer.from('d4:infodee')).infoHash, sha1('de'));
  assert.equal(parseTorrent(Buffer.from('d4:infode3:abci1ee')).infoHash, sha1('de'));
  assert.equal(parseTorrent(Buffer.from('d4:infod1:a0:ee')).infoHash, sha1('d1:a0:e'));
});

test('parseTorrent : tout préfixe strict d’un torrent valide est refusé', () => {
  for (let n = 0; n < TORRENT.length; n++) {
    assert.throws(() => parseTorrent(TORRENT.subarray(0, n)), (e) => e instanceof EngineError && e.message === NOT_TORRENT, `préfixe de ${n} octets`);
  }
});

test('parseTorrent : fin de fichier, entrées non valides', () => {
  assert.equal(parseTorrent(Buffer.concat([TORRENT, Buffer.from(' \r\n\t')])).infoHash, HASH);
  const refused = [
    '', 'd', 'de', 'dee', 'l', 'le', 'i1e', '4:info', '0:', 'e', ':', 'dx',
    'd3:fooi1ee', 'd4:infoi1ee', 'd4:infolee', 'd4:info0:e', 'd4:infox', 'd4:infode', 'd4:infode4:infodee', 'di1ei2ee',
    'd4:Infodee', 'd3:infdee', 'd5:info\u0000dee', 'l4:infodee',
    'd4:infod1:ai01eee', 'd4:infod1:ai-0eee', 'd4:infod1:aieee', `d4:infod1:ai${'9'.repeat(21)}eee`,
    'd4:infod1:a01:xee', 'd4:infod1:a99999999999:xee', 'd4:infod1:a999999999:xee', 'd4:infod1:a5:abcee', 'd4:infod1:a-1:xee', 'd4:infod1:i2e1:bee',
    'd4:infodeeX', 'd4:infodee\u0000', 'd4:infodeede'
  ];
  for (const text of refused) {
    assert.throws(() => parseTorrent(Buffer.from(text, 'latin1')), (e) => e instanceof EngineError && e.message === NOT_TORRENT, JSON.stringify(text));
  }
  for (const v of [null, undefined, 'd4:infodee', 5, {}, [], new Uint8Array(TORRENT)]) assert.throws(() => parseTorrent(v), (e) => e instanceof EngineError && e.message === NOT_TORRENT);
});

test('parseTorrent : imbrication bornée, refus rapide des entrées profondes', () => {
  const lists = (n) => Buffer.from(`d4:infod1:a${'l'.repeat(n)}${'e'.repeat(n)}ee`);
  const dicts = (n) => Buffer.from(`d4:info${'d1:a'.repeat(n)}i1e${'e'.repeat(n)}e`);
  assert.equal(parseTorrent(lists(MAX_BENCODE_DEPTH - 1)).infoHash, sha1(`d1:a${'l'.repeat(MAX_BENCODE_DEPTH - 1)}${'e'.repeat(MAX_BENCODE_DEPTH - 1)}e`));
  assert.equal(parseTorrent(dicts(5)).infoHash.length, 40);
  const started = Date.now();
  for (const n of [MAX_BENCODE_DEPTH, MAX_BENCODE_DEPTH + 1, 100000, 1000000]) {
    assert.throws(() => parseTorrent(lists(n)), (e) => e instanceof EngineError && e.message === NOT_TORRENT, `listes imbriquées ${n}`);
  }
  for (const n of [40, 100000]) assert.throws(() => parseTorrent(dicts(n)), (e) => e instanceof EngineError, `dictionnaires imbriqués ${n}`);
  assert.throws(() => parseTorrent(Buffer.from(`d4:info${'l'.repeat(2000000)}`)), (e) => e instanceof EngineError);
  assert.ok(Date.now() - started < 3000, 'refus trop lent');
});

test('parseTorrent : un gros dictionnaire pieces reste accepté', () => {
  const info = { ...INFO, pieces: Buffer.alloc(10 * 1024 * 1024, 1) };
  assert.equal(parseTorrent(makeTorrent(info)).infoHash, sha1(bencode(info)));
});

test('bencodeEnd : jamais hors bornes, avance toujours', () => {
  const b = Buffer.from('l3:abci42ee');
  assert.equal(bencodeEnd(b, 0), b.length);
  assert.equal(bencodeEnd(b, 1), 6);
  assert.equal(bencodeEnd(b, 6), 10);
  for (const i of [-1, 1.5, NaN, Infinity, b.length, b.length + 5, '0', null, undefined, 2 ** 53]) assert.throws(() => bencodeEnd(b, i), /bencode/, String(i));
  for (const text of ['i', 'i-', 'i1', '3:ab', '3', 'l', 'd', 'd1:a', 'd1:ai1e']) assert.throws(() => bencodeEnd(Buffer.from(text), 0), /bencode/, text);
  assert.throws(() => bencodeEnd(Buffer.from('l'.repeat(MAX_BENCODE_DEPTH + 2)), 0), /nesting/);
});

test('parseTorrent : fuzzing déterministe, ni boucle ni exception inattendue', () => {
  const rand = prng(42);
  const pick = (n) => Math.floor(rand() * n);
  const started = Date.now();
  let accepted = 0;
  for (let i = 0; i < 4000; i++) {
    const b = Buffer.from(TORRENT);
    const mode = i % 4;
    let sample = b;
    if (mode === 0) b[pick(b.length)] = pick(256);
    else if (mode === 1) for (let k = 0; k < 6; k++) b[pick(b.length)] = pick(256);
    else if (mode === 2) sample = b.subarray(0, pick(b.length));
    else sample = Buffer.concat([b.subarray(0, pick(b.length)), Buffer.from(Array.from({ length: pick(12) }, () => pick(256))), b.subarray(pick(b.length))]);
    try {
      assert.match(parseTorrent(sample).infoHash, /^[0-9a-f]{40}$/);
      accepted++;
    } catch (e) {
      assert.ok(e instanceof EngineError && e.message === NOT_TORRENT, `exception inattendue : ${e && e.stack}`);
    }
  }
  assert.ok(accepted > 0);
  assert.ok(Date.now() - started < 5000, 'fuzzing trop lent');
});

// ---------- B. aiguillage des messages ----------

test('types inconnus : liste blanche stricte, aucune requête', async () => {
  await withSetup(async (s) => {
    const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'prototype', '', ' ', 'GetCategories', 'getcategories', 'getCategories ', 'getCategories\n', 'upload\0', 'arm ', 'Disarm', 'listTorrent'];
    for (const type of names) assert.deepEqual(await s.call({ type }), UNKNOWN, JSON.stringify(type));
    for (const type of [null, undefined, 42, true, [], ['getCategories'], {}, { toString: () => 'getCategories' }]) assert.deepEqual(await s.call({ type }), UNKNOWN);
    assert.deepEqual(await s.call({}), UNKNOWN);
    assert.deepEqual(await s.call({ Type: 'getCategories' }), UNKNOWN);
    assert.equal(s.total(), 0);
    assert.equal({}.type, undefined);
  });
});

test('message qui n’est pas un objet simple, type hérité ou trop de champs : refusé', async () => {
  await withSetup(async (s) => {
    const bad = [null, undefined, 'getCategories', 42, true, [], [{ type: 'getCategories' }], new Map([['type', 'getCategories']]), Object.create({ type: 'getCategories' }), JSON.parse('{"__proto__":{"type":"getCategories"}}')];
    for (const msg of bad) assert.deepEqual(await s.call(msg), UNKNOWN);
    const wide = (n) => ({ type: 'getCategories', ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i])) });
    assert.deepEqual(await s.call(wide(64)), { ok: false, error: invalid('message') });
    assert.equal(s.total(), 0);
    assert.equal((await s.call(wide(63))).ok, true);
  });
});

test('arm et disarm : { ok: true } sans requête, sans interaction ni session', async () => {
  await withSetup(async (s) => {
    for (const type of ['arm', 'disarm']) {
      assert.deepEqual(await s.as(ALICE, { type }, { recentInput: false }), { ok: true });
      assert.deepEqual(await s.as(ALICE, { type, junk: { deep: [1] } }), { ok: true });
      assert.deepEqual(await s.as(null, { type }, undefined), { ok: true });
    }
    assert.equal(s.total(), 0);
  });
});

test('utilisateur invalide : session refusée avant toute requête', async () => {
  await withSetup(async (s) => {
    const users = [null, undefined, 'alice', 5, [], {}, { username: '' }, { username: 5 }, { username: ['alice'] }, { username: 'x'.repeat(129) }, { role: 'admin' }, new Map()];
    for (const user of users) {
      for (const type of ['getCategories', 'upload', 'toggleTorrent']) {
        assert.deepEqual(await s.as(user, { type }, { recentInput: true }), { ok: false, error: 'Session invalide.' }, JSON.stringify([user, type]));
      }
    }
    assert.equal(s.total(), 0);
  });
});

// ---------- C. lectures ----------

test('getCategories : mêmes champs que l’extension', async () => {
  await withSetup(async (s) => {
    const r = await s.call({ type: 'getCategories' });
    assert.deepEqual(r, {
      ok: true,
      categories: ['Animés', 'Films', 'Musique', 'Séries'],
      selected: 'Films',
      byType: { movie: 'Films', series: 'Séries', music: 'Musique' },
      defaultRoot: { movie: '/movies', series: '/tv', music: '/music' },
      arrEnabled: { movie: true, series: true, music: true }
    });
    const qb = s.mocks.qb;
    assert.deepEqual(lines(qb).filter((l) => l.includes('/torrents')), ['GET /api/v2/torrents/categories']);
    assert.equal(qb.logins(), 1);
    assert.match(qb.reqs.find((x) => x.url.includes('/torrents')).headers.cookie, /^SID=sid\d+$/);
    assert.equal(s.mocks.radarr.reqs.length + s.mocks.sonarr.reqs.length + s.mocks.lidarr.reqs.length, 0);
    assert.deepEqual(await s.call({ type: 'getCategories' }, BOSS), r);
  });
});

test('getCategories : la dernière catégorie de l’utilisateur prime sur le défaut', async () => {
  await withSetup(async (s) => {
    await s.users.setPrefs('alice', { lastCategory: 'Séries' });
    assert.equal((await s.call({ type: 'getCategories' })).selected, 'Séries');
    assert.equal((await s.call({ type: 'getCategories' }, BOSS)).selected, 'Films');
    await s.users.setPrefs('alice', { lastCategory: '' });
    assert.equal((await s.call({ type: 'getCategories' })).selected, 'Films');
  });
});

test('getCategories : valeurs par défaut du serveur nettoyées', async () => {
  await withSetup(
    async (s) => {
      const r = await s.call({ type: 'getCategories' });
      assert.equal(r.selected, 'Films');
      assert.deepEqual(r.defaultRoot, { movie: '', series: '5', music: '/music' });
    },
    { defaults: { defaultCategory: 'Fi\u0000lms', radarrRoot: undefined, sonarrRoot: 5 } }
  );
});

test('getCategories : arrEnabled reflète les services réellement configurés', async () => {
  await withSetup(async (s) => assert.deepEqual((await s.call({ type: 'getCategories' })).arrEnabled, { movie: true, series: false, music: false }), { services: ['qb', 'radarr'] });
  await withSetup(async (s) => assert.deepEqual((await s.call({ type: 'getCategories' })).arrEnabled, { movie: false, series: false, music: false }), { services: ['qb'] });
  await withSetup(async (s) => {
    s.cfgStore.data.connections.sonarr.apiKey = '';
    assert.deepEqual((await s.call({ type: 'getCategories' })).arrEnabled, { movie: true, series: false, music: true });
  });
});

test('getCategories : noms invalides écartés', async () => {
  await withSetup(async (s) => {
    s.mocks.qb.cats = { Bon: {}, 'Mau\u0007vais': {}, ['x'.repeat(101)]: {}, 'Ligne\nDeux': {}, ['y'.repeat(100)]: {}, Zèbre: {} };
    const r = await s.call({ type: 'getCategories' });
    assert.deepEqual(r.categories, ['Bon', 'y'.repeat(100), 'Zèbre'].sort((a, b) => a.localeCompare(b)));
  });
});

test('getCategories : réponses inattendues de qBittorrent', async () => {
  await withSetup(async (s) => {
    const key = 'GET /api/v2/torrents/categories';
    const qb = s.mocks.qb;
    const read = () => s.call({ type: 'getCategories' });
    qb.force[key] = { status: 500, body: `boom ${qb.url}` };
    assert.deepEqual(await read(), { ok: false, error: 'Impossible de lire les catégories (qBittorrent 500).' });
    for (const body of ['[]', '<html>nope</html>', '', 'null', '"x"', '42']) {
      qb.force[key] = { status: 200, headers: { 'Content-Type': 'application/json' }, body };
      assert.deepEqual(await read(), { ok: false, error: 'Réponse inattendue de qBittorrent.' }, body);
    }
    qb.force[key] = { status: 200, headers: { 'Content-Encoding': 'gzip' }, body: zlib.gzipSync(JSON.stringify({ Zip: {} })) };
    assert.deepEqual((await read()).categories, ['Zip']);
    qb.force[key] = { status: 200, headers: { 'Content-Encoding': 'gzip' }, body: zlib.gzipSync(Buffer.alloc(20 * 1024 * 1024)) };
    assert.deepEqual(await read(), { ok: false, error: 'Réponse illisible du service.' });
    qb.force[key] = { status: 200, headers: { 'Content-Encoding': 'gzip' }, body: 'pas du gzip' };
    assert.deepEqual(await read(), { ok: false, error: 'Réponse illisible du service.' });
    qb.force[key] = { status: 200, body: Buffer.alloc(5 * 1024 * 1024, 0x20) };
    assert.deepEqual(await read(), { ok: false, error: 'Réponse du service trop volumineuse' });
  });
});

test('qBittorrent non configuré : message clair pour chaque lecture', async () => {
  await withSetup(
    async (s) => {
      const expected = { ok: false, error: 'qBittorrent n’est pas configuré. Demande à un administrateur de le configurer dans Réglages.' };
      for (const msg of [{ type: 'getCategories' }, { type: 'listTorrents' }, { type: 'qbitIndex' }, { type: 'toggleTorrent', hash: HASH_A, pause: true }]) {
        assert.deepEqual(await s.call(msg), expected, msg.type);
      }
      const media = { type: 'movie', ids: { tmdb: 603, tmdbKind: 'movie' } };
      assert.deepEqual(await s.call({ type: 'pageStatus', hash: HASH_A, media }), { ok: true, qbit: null, library: { service: 'Radarr', inLibrary: false } });
      assert.equal(only(s.mocks.radarr, 'GET', '/api/v3/movie').length, 1);
    },
    { services: ['radarr'] }
  );
});

const torrentRow = (hash, extra) => ({
  hash,
  name: `Film ${hash.slice(0, 4)}`,
  state: 'downloading',
  progress: 0.5,
  dlspeed: 1000,
  upspeed: 10,
  eta: 120,
  size: 5000,
  category: 'Films',
  ratio: 0.25,
  completion_on: -1,
  added_on: 1700000000,
  save_path: '/downloads/secret',
  tracker: 'http://tracker.invalid/announce?passkey=zzz',
  magnet_uri: 'magnet:?xt=urn:btih:aaaa',
  content_path: '/downloads/secret/x',
  ...extra
});

test('listTorrents : champs de l’extension uniquement, vitesses globales', async () => {
  await withSetup(async (s) => {
    const qb = s.mocks.qb;
    qb.torrents = [torrentRow(HASH_A), torrentRow(HASH_B, { state: 'pausedUP', progress: 1, completion_on: 1700000100 })];
    const r = await s.call({ type: 'listTorrents' });
    assert.deepEqual(r, {
      ok: true,
      torrents: [
        { hash: HASH_A, name: 'Film aaaa', state: 'downloading', progress: 0.5, dlspeed: 1000, upspeed: 10, eta: 120, size: 5000, category: 'Films', ratio: 0.25, completion_on: -1, added_on: 1700000000 },
        { hash: HASH_B, name: 'Film bbbb', state: 'pausedUP', progress: 1, dlspeed: 1000, upspeed: 10, eta: 120, size: 5000, category: 'Films', ratio: 0.25, completion_on: 1700000100, added_on: 1700000000 }
      ],
      dlspeed: 111,
      upspeed: 22
    });
    assert.doesNotMatch(JSON.stringify(r), /passkey|magnet|save_path|content_path|tracker|downloads/);
    assert.equal(only(qb, 'GET', '/api/v2/torrents/info')[0].url, '/api/v2/torrents/info?sort=added_on&reverse=true');
    assert.equal(only(qb, 'GET', '/api/v2/transfer/info').length, 1);
    assert.equal(qb.logins(), 1);
  });
});

test('listTorrents : entrées douteuses nettoyées, liste bornée', async () => {
  await withSetup(async (s) => {
    const qb = s.mocks.qb;
    qb.torrents = [
      null, 5, 'x', [], [1], {},
      { hash: 5, name: {}, state: [] },
      { hash: HASH_A, name: 'Un\u0007 nom\ttrès\nbizarre', state: 'x'.repeat(100), progress: '0.9', dlspeed: null, upspeed: 'fast', eta: 8640000, size: 1e21, category: 'Films\u0000', ratio: {}, completion_on: [], added_on: true },
      { hash: HASH_B, name: 'n'.repeat(600) }
    ];
    const blank = { hash: '', name: '', state: '', progress: 0, dlspeed: 0, upspeed: 0, eta: 0, size: 0, category: '', ratio: 0, completion_on: 0, added_on: 0 };
    const r = await s.call({ type: 'listTorrents' });
    assert.deepEqual(r.torrents, [
      blank,
      blank,
      { ...blank, hash: HASH_A, name: 'Un nom très bizarre', state: 'x'.repeat(40), eta: 8640000, size: 1e21, category: 'Films' },
      { ...blank, hash: HASH_B, name: 'n'.repeat(500) }
    ]);
    qb.torrents = Array.from({ length: 20050 }, (_, i) => ({ hash: HASH_A, name: `t${i}` }));
    const big = await s.call({ type: 'listTorrents' });
    assert.equal(big.torrents.length, 20000);
    assert.equal(big.torrents[19999].name, 't19999');
  });
});

test('listTorrents : vitesses à 0 quand transfer/info échoue, erreurs claires sinon', async () => {
  await withSetup(async (s) => {
    const qb = s.mocks.qb;
    qb.torrents = [torrentRow(HASH_A)];
    for (const reply of [{ status: 500, body: 'boom' }, { status: 200, body: 'pas du json' }, { status: 200, body: '[1]' }]) {
      qb.force['GET /api/v2/transfer/info'] = reply;
      const r = await s.call({ type: 'listTorrents' });
      assert.equal(r.ok, true);
      assert.equal(r.torrents.length, 1);
      assert.deepEqual([r.dlspeed, r.upspeed], [0, 0]);
    }
    delete qb.force['GET /api/v2/transfer/info'];
    qb.force['GET /api/v2/torrents/info'] = { status: 500, body: `erreur ${qb.url}` };
    assert.deepEqual(await s.call({ type: 'listTorrents' }), { ok: false, error: 'qBittorrent 500' });
    qb.force['GET /api/v2/torrents/info'] = { status: 200, body: '{"a":1}' };
    assert.deepEqual(await s.call({ type: 'listTorrents' }), { ok: false, error: 'Réponse inattendue de qBittorrent.' });
  });
});

test('qbitIndex : hash, nom, progression et état seulement', async () => {
  await withSetup(async (s) => {
    s.mocks.qb.torrents = [torrentRow(HASH_A), torrentRow(HASH_B, { name: 'Autre', progress: 1, state: 'stalledUP' })];
    assert.deepEqual(await s.call({ type: 'qbitIndex' }), {
      ok: true,
      torrents: [
        { hash: HASH_A, name: 'Film aaaa', progress: 0.5, state: 'downloading' },
        { hash: HASH_B, name: 'Autre', progress: 1, state: 'stalledUP' }
      ]
    });
  });
});

test('pageStatus : torrent retrouvé par son hash dans qBittorrent', async () => {
  await withSetup(async (s) => {
    const qb = s.mocks.qb;
    qb.torrents = [torrentRow(HASH_A, { name: 'Film.2024', state: 'stalledUP', progress: 1 })];
    const r = await s.call({ type: 'pageStatus', hash: HASH_A.toUpperCase(), media: null });
    assert.deepEqual(r, { ok: true, qbit: { name: 'Film.2024', state: 'stalledUP', progress: 1, category: 'Films' }, library: null });
    assert.equal(only(qb, 'GET', '/api/v2/torrents/info')[0].url, `/api/v2/torrents/info?hashes=${HASH_A}`);
    assert.deepEqual(await s.call({ type: 'pageStatus', hash: HASH_B }), { ok: true, qbit: null, library: null });
    const long = 'c'.repeat(64);
    assert.deepEqual(await s.call({ type: 'pageStatus', hash: long }), { ok: true, qbit: null, library: null });
    assert.equal(only(qb, 'GET', '/api/v2/torrents/info')[2].url, `/api/v2/torrents/info?hashes=${long}`);
    qb.force['GET /api/v2/torrents/info'] = { status: 500, body: 'boom' };
    assert.deepEqual(await s.call({ type: 'pageStatus', hash: HASH_A }), { ok: true, qbit: null, library: null });
  });
});

test('pageStatus : sans hash ni media, rien n’est demandé', async () => {
  await withSetup(async (s) => {
    for (const msg of [{ type: 'pageStatus' }, { type: 'pageStatus', hash: '', media: null }, { type: 'pageStatus', hash: null, media: {} }]) {
      assert.deepEqual(await s.call(msg), { ok: true, qbit: null, library: null });
    }
    assert.equal(s.total(), 0);
  });
});

test('pageStatus : hash invalide refusé sans requête', async () => {
  await withSetup(async (s) => {
    const hashes = ['abc', 'g'.repeat(40), 'a'.repeat(41), 'a'.repeat(39), 'a'.repeat(63), 'a'.repeat(65), 5, 0, false, true, {}, [], [HASH_A], `${HASH_A}\n`, `../${'a'.repeat(37)}`, `${'a'.repeat(20)}|${'b'.repeat(40)}`, 'all'];
    for (const hash of hashes) assert.deepEqual(await s.call({ type: 'pageStatus', hash }), { ok: false, error: invalid('hash') }, JSON.stringify(hash));
    assert.equal(s.total(), 0);
  });
});

test('pageStatus : état d’un film dans Radarr (par tmdb, par imdb)', async () => {
  await withSetup(async (s) => {
    const radarr = s.mocks.radarr;
    const media = { type: 'movie', ids: { tmdb: 603, tmdbKind: 'movie' } };
    assert.deepEqual(await s.call({ type: 'pageStatus', media }), { ok: true, qbit: null, library: { service: 'Radarr', inLibrary: false } });
    radarr.library = [{ ...MATRIX, id: 7, hasFile: true, monitored: false }];
    const found = { ok: true, qbit: null, library: { service: 'Radarr', inLibrary: true, title: 'The Matrix', hasFile: true, monitored: false } };
    assert.deepEqual(await s.call({ type: 'pageStatus', media }), found);
    assert.equal(radarr.reqs.at(-1).url, '/api/v3/movie?tmdbId=603');
    radarr.reqs.length = 0;
    assert.deepEqual(await s.call({ type: 'pageStatus', media: { type: 'movie', ids: { imdb: 'tt0133093' } } }), found);
    assert.deepEqual(lines(radarr), ['GET /api/v3/movie/lookup/imdb?imdbId=tt0133093', 'GET /api/v3/movie?tmdbId=603']);
    assert.equal(radarr.reqs[0].headers['x-api-key'], SECRET.radarr);
    assert.equal(s.mocks.qb.reqs.length, 0);
  });
});

test('pageStatus : état d’une série dans Sonarr (saisons, épisodes)', async () => {
  await withSetup(async (s) => {
    const sonarr = s.mocks.sonarr;
    const media = { type: 'series', ids: { tvdb: 81189 }, seasons: [1, 3] };
    assert.deepEqual((await s.call({ type: 'pageStatus', media })).library, { service: 'Sonarr', inLibrary: false });
    sonarr.library = [
      {
        ...BREAKING,
        id: 9,
        seasons: [
          { seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 3, totalEpisodeCount: 7, episodeCount: 6 } },
          { seasonNumber: 2, monitored: false }
        ],
        statistics: { episodeFileCount: 10, episodeCount: 13, totalEpisodeCount: 20 }
      }
    ];
    const expected = {
      service: 'Sonarr',
      inLibrary: true,
      title: 'Breaking Bad',
      seasons: [
        { number: 1, exists: true, monitored: true, files: 3, total: 7 },
        { number: 3, exists: false, monitored: false, files: 0, total: 0 }
      ],
      files: 10,
      total: 13
    };
    assert.deepEqual((await s.call({ type: 'pageStatus', media })).library, expected);
    sonarr.reqs.length = 0;
    assert.deepEqual((await s.call({ type: 'pageStatus', media: { type: 'series', ids: { imdb: 'tt0903747' }, seasons: [1, 3] } })).library, expected);
    assert.deepEqual(lines(sonarr), ['GET /api/v3/series/lookup?term=imdb%3Att0903747', 'GET /api/v3/series?tvdbId=81189']);
  });
});

test('pageStatus : état d’un album dans Lidarr (album, artiste seul, absent)', async () => {
  await withSetup(async (s) => {
    const lidarr = s.mocks.lidarr;
    const media = { type: 'music', ids: { mbReleaseGroup: MB.group }, artist: 'Daft Punk', album: 'Discovery' };
    assert.deepEqual((await s.call({ type: 'pageStatus', media })).library, { service: 'Lidarr', inLibrary: false });
    lidarr.libArtists = [{ ...ARTIST, id: 7 }];
    assert.deepEqual((await s.call({ type: 'pageStatus', media })).library, { service: 'Lidarr', inLibrary: true, artistOnly: true, title: 'Daft Punk' });
    lidarr.libAlbums = [{ ...ALBUM, id: 31, artistId: 7, statistics: { trackFileCount: 8, totalTrackCount: 14 } }];
    const album = { service: 'Lidarr', inLibrary: true, title: 'Discovery', files: 8, total: 14 };
    assert.deepEqual((await s.call({ type: 'pageStatus', media })).library, album);
    lidarr.reqs.length = 0;
    s.mb.calls.length = 0;
    assert.deepEqual((await s.call({ type: 'pageStatus', media: { type: 'music', ids: {}, artist: 'Daft Punk', album: 'Discovery' } })).library, album);
    assert.equal(s.mb.calls.length, 1);
    assert.match(s.mb.calls[0], /^release-group\?limit=10&query=/);
    assert.deepEqual(lines(lidarr), ['GET /api/v1/artist', 'GET /api/v1/album?artistId=7']);
  });
});

test('pageStatus : erreurs des services non affichées, media hostile refusé sans requête', async () => {
  await withSetup(
    async (s) => {
      const media = { type: 'movie', ids: { tmdb: 603, tmdbKind: 'movie' } };
      assert.deepEqual(await s.call({ type: 'pageStatus', media }), { ok: true, qbit: null, library: { service: 'Radarr', inLibrary: false } });
      assert.deepEqual(await s.call({ type: 'pageStatus', media: { type: 'series', ids: { tvdb: 81189 } } }), { ok: true, qbit: null, library: null });
      assert.deepEqual(await s.call({ type: 'pageStatus', media: { type: 'music', artist: 'x' } }), { ok: true, qbit: null, library: null });
      s.cfgStore.data.connections.radarr.apiKey = 'cle-radarr-erronee';
      assert.deepEqual(await s.call({ type: 'pageStatus', hash: HASH_A, media }), { ok: true, qbit: null, library: null });
      s.sweep('cle-radarr-erronee');
      const before = s.total();
      for (const hostile of [{ type: 'movie', ids: { imdb: '../../etc/passwd' } }, { type: 'movie', ids: { tmdb: '1/../2' } }, { type: 'film' }, 'movie', 5, [], { type: 'series', seasons: 'all' }]) {
        const r = await s.call({ type: 'pageStatus', hash: HASH_A, media: hostile });
        assert.equal(r.ok, false);
        assert.match(r.error, /^Requête invalide \(media/);
      }
      assert.equal(s.total(), before);
    },
    { services: ['qb', 'radarr'] }
  );
});

test('arrMeta : profils et dossiers racines de chaque service', async () => {
  await withSetup(async (s) => {
    assert.deepEqual(await s.call({ type: 'arrMeta', service: 'radarr' }), { ok: true, profiles: [{ id: 4, name: 'HD' }, { id: 5, name: 'Any' }], roots: ['/movies', '/films'] });
    assert.deepEqual(await s.call({ type: 'arrMeta', service: 'sonarr' }), { ok: true, profiles: [{ id: 5, name: 'HD' }], roots: ['/tv', '/anime'] });
    assert.deepEqual(await s.call({ type: 'arrMeta', service: 'lidarr' }, BOSS), {
      ok: true,
      profiles: [{ id: 2, name: 'Lossless' }, { id: 6, name: 'MP3' }],
      roots: ['/music'],
      metaProfiles: [{ id: 1, name: 'None' }, { id: 3, name: 'Standard' }]
    });
    assert.deepEqual(lines(s.mocks.radarr).sort(), ['GET /api/v3/qualityprofile', 'GET /api/v3/rootfolder']);
    assert.deepEqual(lines(s.mocks.lidarr).sort(), ['GET /api/v1/metadataprofile', 'GET /api/v1/qualityprofile', 'GET /api/v1/rootfolder']);
    for (const [svc, key] of [['radarr', SECRET.radarr], ['sonarr', SECRET.sonarr], ['lidarr', SECRET.lidarr]]) {
      for (const r of s.mocks[svc].reqs) assert.equal(r.headers['x-api-key'], key);
    }
    assert.equal(s.mocks.qb.reqs.length, 0);
  });
});

test('arrMeta : service hostile refusé sans requête', async () => {
  await withSetup(async (s) => {
    const services = ['Radarr', 'radar', '__proto__', 'constructor', 'toString', 'hasOwnProperty', '', ' radarr', 'radarr ', 'radarr/../x', 'radarr\n', 5, null, undefined, {}, ['radarr'], 'qb', 'qbittorrent', 'prowlarr'];
    for (const service of services) assert.deepEqual(await s.call({ type: 'arrMeta', service }), { ok: false, error: invalid('service') }, JSON.stringify(service));
    assert.deepEqual(await s.call({ type: 'arrMeta' }), { ok: false, error: invalid('service') });
    assert.equal(s.total(), 0);
  });
});

test('arrMeta : service non configuré ou clé refusée', async () => {
  await withSetup(
    async (s) => {
      assert.deepEqual(await s.call({ type: 'arrMeta', service: 'sonarr' }), { ok: false, error: notConfigured('Sonarr') });
      s.cfgStore.data.connections.radarr.apiKey = 'cle-radarr-erronee';
      assert.deepEqual(await s.call({ type: 'arrMeta', service: 'radarr' }, BOSS), {
        ok: false,
        error: 'Radarr a refusé la clé API enregistrée. Un administrateur doit la corriger dans Réglages.'
      });
      s.sweep('cle-radarr-erronee');
    },
    { services: ['qb', 'radarr'] }
  );
});

// ---------- D. pause / reprise ----------

test('toggleTorrent : exige une interaction récente', async () => {
  await withSetup(async (s) => {
    for (const opts of [undefined, null, {}, { recentInput: false }, { recentInput: 'true' }, { recentInput: 1 }, true, 'yes', []]) {
      assert.deepEqual(await s.as(ALICE, { type: 'toggleTorrent', hash: HASH_A, pause: true }, opts), { ok: false, error: NO_INPUT }, JSON.stringify(opts));
    }
    assert.equal(s.total(), 0);
  });
});

test('toggleTorrent : pause → stop, reprise → start, hash en minuscules', async () => {
  await withSetup(async (s) => {
    const qb = s.mocks.qb;
    assert.deepEqual(await s.call({ type: 'toggleTorrent', hash: HASH_A.toUpperCase(), pause: true }), { ok: true });
    assert.deepEqual(await s.call({ type: 'toggleTorrent', hash: 'b'.repeat(64), pause: false }, BOSS), { ok: true });
    assert.deepEqual(qb.toggles, [{ verb: 'stop', hashes: HASH_A }, { verb: 'start', hashes: 'b'.repeat(64) }]);
    const rec = only(qb, 'POST', '/api/v2/torrents/stop')[0];
    assert.equal(rec.body.toString(), `hashes=${HASH_A}`);
    assert.equal(rec.headers['content-type'], 'application/x-www-form-urlencoded');
  });
});

test('toggleTorrent : repli pause/resume avec qBittorrent 4, refus sans repli sur une autre erreur', async () => {
  await withSetup(async (s) => {
    const qb = s.mocks.qb;
    qb.v4 = true;
    assert.deepEqual(await s.call({ type: 'toggleTorrent', hash: HASH_A, pause: true }), { ok: true });
    assert.deepEqual(await s.call({ type: 'toggleTorrent', hash: HASH_A, pause: false }), { ok: true });
    assert.deepEqual(qb.toggles.map((t) => t.verb), ['stop', 'pause', 'start', 'resume']);
    qb.v4 = false;
    qb.toggles.length = 0;
    qb.reqs.length = 0;
    qb.force['POST /api/v2/torrents/stop'] = { status: 500, body: `boom ${qb.url}` };
    assert.deepEqual(await s.call({ type: 'toggleTorrent', hash: HASH_A, pause: true }), { ok: false, error: 'qBittorrent a refusé la commande (HTTP 500).' });
    assert.deepEqual(qb.reqs.filter((r) => r.url.endsWith('/torrents/pause')), []);
    delete qb.force['POST /api/v2/torrents/stop'];
    qb.v4 = true;
    qb.force['POST /api/v2/torrents/pause'] = { status: 404, body: 'Not Found' };
    assert.deepEqual(await s.call({ type: 'toggleTorrent', hash: HASH_A, pause: true }), { ok: false, error: 'qBittorrent a refusé la commande (HTTP 404).' });
  });
});

test('toggleTorrent : hash ou pause invalides refusés sans requête', async () => {
  await withSetup(async (s) => {
    for (const hash of ['', undefined, null, 'all', 'abc', `${HASH_A}|${HASH_B}`, 5, {}, [HASH_A], `${HASH_A}\n`]) {
      assert.deepEqual(await s.call({ type: 'toggleTorrent', hash, pause: true }), { ok: false, error: invalid('hash') }, JSON.stringify(hash));
    }
    for (const pause of ['true', 1, 0, null, undefined, {}, []]) {
      assert.deepEqual(await s.call({ type: 'toggleTorrent', hash: HASH_A, pause }), { ok: false, error: invalid('pause') }, JSON.stringify(pause));
    }
    assert.deepEqual(await s.call({ type: 'toggleTorrent', hash: HASH_A }), { ok: false, error: invalid('pause') });
    assert.equal(s.total(), 0);
  });
});

// ---------- E. upload ----------

const MOVIE = { type: 'movie', ids: { tmdb: 603, tmdbKind: 'movie' } };
const SERIES = { type: 'series', ids: { tvdb: 81189 }, seasons: [1, 2] };
const OK_UPLOAD = { ok: true, hash: HASH, arrResult: null, arrError: null };

// Ordre global des requêtes traitées par les faux services (hors connexion qBittorrent).
const timeline = (s) =>
  Object.entries(s.mocks)
    .flatMap(([svc, m]) => m.reqs.filter((r) => r.seq).map((r) => ({ seq: r.seq, text: `${svc} ${r.method} ${r.url.split('?')[0].replace(/^\/api\/v\d\//, '')}` })))
    .sort((a, b) => a.seq - b.seq)
    .map((r) => r.text);
const arrReqs = (s) => ['radarr', 'sonarr', 'lidarr'].reduce((n, svc) => n + (s.mocks[svc] ? s.mocks[svc].reqs.length : 0), 0);

test('upload sans media : qBittorrent seulement, hash calculé, catégorie mémorisée', async () => {
  await withSetup(async (s) => {
    assert.deepEqual(await s.call(upMsg()), OK_UPLOAD);
    const qb = s.mocks.qb;
    assert.equal(qb.adds.length, 1);
    const { parts } = qb.adds[0];
    assert.deepEqual(Object.keys(parts).sort(), ['category', 'torrents']);
    assert.equal(parts.torrents.filename, 'Film.2024.1080p.torrent');
    assert.equal(parts.torrents.type, 'application/x-bittorrent');
    assert.ok(parts.torrents.value.equals(TORRENT));
    assert.equal(parts.category.value.toString(), 'Films');
    assert.deepEqual(timeline(s), ['qb GET torrents/categories', 'qb POST torrents/add']);
    assert.equal(arrReqs(s), 0);
    assert.equal(s.users.find('alice').prefs.lastCategory, 'Films');
  });
});

test('upload : en pause, sans catégorie, nom de fichier nettoyé', async () => {
  await withSetup(async (s) => {
    const qb = s.mocks.qb;
    assert.deepEqual(await s.call(upMsg({ paused: true })), OK_UPLOAD);
    assert.equal(qb.adds[0].parts.paused.value.toString(), 'true');
    assert.equal(qb.adds[0].parts.stopped.value.toString(), 'true');
    qb.reqs.length = 0;
    assert.deepEqual(await s.call(upMsg({ category: '', filename: '..\\..\\dir/évil".torrent' })), OK_UPLOAD);
    const { parts } = qb.adds[1];
    assert.deepEqual(Object.keys(parts).sort(), ['torrents']);
    assert.equal(parts.torrents.filename, 'évil.torrent');
    assert.equal(only(qb, 'GET', '/api/v2/torrents/categories').length, 0);
    assert.equal(s.users.find('alice').prefs.lastCategory, '');
    assert.deepEqual(await s.call(upMsg({ category: null, paused: null, filename: undefined })), OK_UPLOAD);
    assert.equal(qb.adds[2].parts.torrents.filename, 'file.torrent');
    assert.equal(qb.adds[2].parts.paused, undefined);
  });
});

test('upload : catégorie inconnue refusée avant tout ajout', async () => {
  await withSetup(async (s) => {
    const r = await s.call(upMsg({ category: 'Inconnue', media: MOVIE }));
    assert.deepEqual(r, { ok: false, error: 'Catégorie inconnue dans qBittorrent.' });
    assert.equal(s.mocks.qb.adds.length, 0);
    assert.equal(arrReqs(s), 0);
    assert.equal(s.users.find('alice').prefs.lastCategory, undefined);
  });
});

test('upload : qBittorrent non configuré, rien n’est envoyé aux Arr', async () => {
  await withSetup(
    async (s) => {
      assert.deepEqual(await s.call(upMsg({ media: MOVIE })), { ok: false, error: notConfigured('qBittorrent') });
      assert.equal(s.mocks.radarr.reqs.length, 0);
    },
    { services: ['radarr'] }
  );
});

test('upload : service Arr non configuré → arrError, torrent tout de même envoyé', async () => {
  await withSetup(
    async (s) => {
      const r = await s.call(upMsg({ media: SERIES }));
      assert.deepEqual(r, { ok: true, hash: HASH, arrResult: null, arrError: notConfigured('Sonarr') });
      assert.equal(s.mocks.qb.adds.length, 1);
    },
    { services: ['qb', 'radarr'] }
  );
});

test('upload + film : ajouté à Radarr non surveillé, sans recherche, avant l’envoi à qBittorrent', async () => {
  await withSetup(async (s) => {
    const media = { type: 'movie', ids: { tmdb: 603, imdb: 'tt0133093', tmdbKind: 'movie' }, year: '1999' };
    const r = await s.call(upMsg({ media }));
    assert.deepEqual(r, { ok: true, hash: HASH, arrResult: 'ajouté à Radarr, non surveillé (The Matrix)', arrError: null });
    assert.deepEqual(timeline(s), ['qb GET torrents/categories', 'radarr GET movie/lookup/tmdb', 'radarr GET movie', 'radarr GET rootfolder', 'radarr POST movie', 'qb POST torrents/add']);
    const post = only(s.mocks.radarr, 'POST', '/api/v3/movie')[0];
    assert.deepEqual(bodyOf(post), {
      ...MATRIX,
      qualityProfileId: 4,
      rootFolderPath: '/movies',
      monitored: false,
      minimumAvailability: 'announced',
      addOptions: { monitor: 'none', searchForMovie: false }
    });
    assert.equal(post.headers['x-api-key'], SECRET.radarr);
    assert.equal(post.headers['content-type'], 'application/json');
    assert.deepEqual(s.mocks.radarr.library.map((m) => [m.title, m.monitored]), [['The Matrix', false]]);
    assertNoSearch(s);
  });
});

test('upload + film : même résultat pour un administrateur', async () => {
  await withSetup(async (s) => {
    const r = await s.call(upMsg({ media: MOVIE }), BOSS);
    assert.deepEqual(r, { ok: true, hash: HASH, arrResult: 'ajouté à Radarr, non surveillé (The Matrix)', arrError: null });
    assert.equal(s.users.find('boss').prefs.lastCategory, 'Films');
    assertNoSearch(s);
  });
});

test('upload + film : recherche par IMDb quand tmdb est inconnu, tmdb de série ignoré', async () => {
  await withSetup(async (s) => {
    const r = await s.call(upMsg({ media: { type: 'movie', ids: { tmdb: 999, tmdbKind: 'movie', imdb: 'tt0133093' } } }));
    assert.equal(r.arrResult, 'ajouté à Radarr, non surveillé (The Matrix)');
    assert.deepEqual(timeline(s).filter((l) => l.startsWith('radarr')), ['radarr GET movie/lookup/tmdb', 'radarr GET movie/lookup/imdb', 'radarr GET movie', 'radarr GET rootfolder', 'radarr POST movie']);
    s.mocks.radarr.reqs.length = 0;
    const tv = await s.call(upMsg({ media: { type: 'movie', ids: { tmdb: 603, tmdbKind: 'tv' } } }));
    assert.deepEqual(tv, { ok: true, hash: HASH, arrResult: null, arrError: 'Radarr : film introuvable' });
    assert.equal(s.mocks.radarr.reqs.length, 0);
  });
});

test('upload + film : déjà dans Radarr (résultat de recherche ou bibliothèque) → rien n’est ajouté', async () => {
  await withSetup(async (s) => {
    const radarr = s.mocks.radarr;
    radarr.movies[603] = { ...MATRIX, id: 12 };
    const expected = { ok: true, hash: HASH, arrResult: 'déjà dans Radarr (The Matrix)', arrError: null };
    assert.deepEqual(await s.call(upMsg({ media: MOVIE })), expected);
    radarr.movies[603] = { ...MATRIX };
    radarr.library = [{ ...MATRIX, id: 7 }];
    radarr.reqs.length = 0;
    assert.deepEqual(await s.call(upMsg({ media: MOVIE })), expected);
    assert.equal(only(radarr, 'POST', '/api/v3/movie').length, 0);
    assert.equal(only(radarr, 'GET', '/api/v3/rootfolder').length, 0);
    assert.equal(s.mocks.qb.adds.length, 2);
  });
});

test('upload + film : introuvable ou dossier inconnu → arrError, torrent tout de même envoyé', async () => {
  await withSetup(async (s) => {
    const radarr = s.mocks.radarr;
    radarr.movies = {};
    assert.deepEqual(await s.call(upMsg({ media: { type: 'movie', ids: { tmdb: 603, tmdbKind: 'movie', imdb: 'tt0000001' } } })), { ok: true, hash: HASH, arrResult: null, arrError: 'Radarr : film introuvable' });
    radarr.movies[603] = { ...MATRIX };
    assert.deepEqual(await s.call(upMsg({ media: { ...MOVIE, rootFolder: '/nulle/part' } })), { ok: true, hash: HASH, arrResult: null, arrError: 'Radarr : dossier racine introuvable' });
    assert.equal(only(radarr, 'POST', '/api/v3/movie').length, 0);
    assert.equal(s.mocks.qb.adds.length, 2);
  });
});

test('upload + film : le dossier racine envoyé est toujours celui de Radarr', async () => {
  await withSetup(async (s) => {
    const radarr = s.mocks.radarr;
    assert.equal((await s.call(upMsg({ media: { ...MOVIE, rootFolder: '/movies/' } }))).arrResult, 'ajouté à Radarr, non surveillé (The Matrix)');
    assert.equal(bodyOf(only(radarr, 'POST', '/api/v3/movie')[0]).rootFolderPath, '/movies');
    radarr.library = [];
    assert.equal((await s.call(upMsg({ media: { ...MOVIE, rootFolder: '/films//' } }))).arrResult, 'ajouté à Radarr, non surveillé (The Matrix)');
    assert.equal(bodyOf(only(radarr, 'POST', '/api/v3/movie')[1]).rootFolderPath, '/films');
    // Pas de normalisation hasardeuse : ni casse, ni remontée de dossier.
    for (const rootFolder of ['/MOVIES', '/movies/../etc', '/movies/old', '..', 'movies']) {
      radarr.library = [];
      assert.equal((await s.call(upMsg({ media: { ...MOVIE, rootFolder } }))).arrError, 'Radarr : dossier racine introuvable', rootFolder);
    }
    assert.equal(only(radarr, 'POST', '/api/v3/movie').length, 2);
  });
});

test('upload + film : profil ou dossier par défaut absent → erreur claire sans requête à Radarr', async () => {
  for (const defaults of [{ radarrProfile: '' }, { radarrProfile: 0 }, { radarrProfile: 'x' }, { radarrRoot: '' }]) {
    await withSetup(
      async (s) => {
        const r = await s.call(upMsg({ media: MOVIE }));
        assert.deepEqual(r, { ok: true, hash: HASH, arrResult: null, arrError: 'Radarr : dossier racine / profil qualité non configurés' });
        assert.equal(s.mocks.radarr.reqs.length, 0);
        assert.equal(s.mocks.qb.adds.length, 1);
      },
      { defaults }
    );
  }
});

test('upload + film : erreurs de Radarr rapportées sans adresse ni clé', async () => {
  await withSetup(async (s) => {
    const radarr = s.mocks.radarr;
    const post = 'POST /api/v3/movie';
    const attempt = async () => (await s.call(upMsg({ media: MOVIE }))).arrError;

    radarr.force[post] = {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ errorMessage: `Dossier invalide ${radarr.url}/movies (clé ${SECRET.radarr}, hôte 127.0.0.1:${radarr.port}, http://interne.local:7878/x)` }])
    };
    const withDetail = await attempt();
    assert.match(withDetail, /^Radarr 400 : Dossier invalide /);
    assert.doesNotMatch(withDetail, /127\.0\.0\.1|interne\.local|\d{4,5}|radarr-key|http/);

    radarr.force[post] = { status: 500, headers: { 'Content-Type': 'text/html' }, body: '<html><body>Erreur http://10.0.0.5:7878/secret</body></html>' };
    assert.equal(await attempt(), 'Radarr 500');
    radarr.force[post] = { status: 500, body: 'Erreur interne http://10.0.0.5:7878/api sur 10.0.0.5:7878' };
    assert.equal(await attempt(), 'Radarr 500 : Erreur interne … sur …');
    radarr.force[post] = { status: 200, body: 'pas du json' };
    assert.equal(await attempt(), 'Réponse inattendue de Radarr.');
    delete radarr.force[post];

    radarr.force['GET /api/v3/rootfolder'] = { status: 302, headers: { Location: 'http://evil.example/' }, body: '' };
    assert.equal(await attempt(), 'Radarr a répondu par une redirection : l’URL enregistrée semble incorrecte (http/https, URL de base).');
    delete radarr.force['GET /api/v3/rootfolder'];
    assert.equal(s.mocks.qb.adds.length, 5);
  });
});

test('upload + film : clé API refusée par Radarr', async () => {
  await withSetup(async (s) => {
    s.cfgStore.data.connections.radarr.apiKey = 'cle-radarr-erronee';
    const r = await s.call(upMsg({ media: MOVIE }));
    assert.deepEqual(r, { ok: true, hash: HASH, arrResult: null, arrError: 'Radarr a refusé la clé API enregistrée. Un administrateur doit la corriger dans Réglages.' });
    s.sweep('cle-radarr-erronee');
    assert.equal(s.mocks.qb.adds.length, 1);
  });
});

test('upload + film : Radarr injoignable, message sans hôte ni port (même pour un administrateur)', async () => {
  await withSetup(async (s) => {
    await s.mocks.radarr.close();
    for (const user of [ALICE, BOSS]) {
      assert.deepEqual(await s.call(upMsg({ media: MOVIE }), user), { ok: true, hash: HASH, arrResult: null, arrError: 'Réseau : connexion refusée' });
    }
    assert.equal(s.mocks.qb.adds.length, 2);
  });
});

test('upload + série : ajoutée à Sonarr non surveillée, saisons non surveillées, sans recherche', async () => {
  await withSetup(async (s) => {
    const r = await s.call(upMsg({ category: 'Séries', media: SERIES }));
    assert.deepEqual(r, { ok: true, hash: HASH, arrResult: 'ajouté à Sonarr, non surveillée (Breaking Bad)', arrError: null });
    assert.deepEqual(timeline(s), ['qb GET torrents/categories', 'sonarr GET series/lookup', 'sonarr GET series', 'sonarr GET rootfolder', 'sonarr POST series', 'qb POST torrents/add']);
    const post = only(s.mocks.sonarr, 'POST', '/api/v3/series')[0];
    assert.deepEqual(bodyOf(post), {
      ...BREAKING,
      qualityProfileId: 5,
      languageProfileId: 1,
      rootFolderPath: '/tv',
      seriesType: 'standard',
      monitored: false,
      seasonFolder: true,
      seasons: BREAKING.seasons.map((x) => ({ ...x, monitored: false })),
      addOptions: { monitor: 'none', searchForMissingEpisodes: false, searchForCutoffUnmetEpisodes: false }
    });
    assert.equal(post.headers['x-api-key'], SECRET.sonarr);
    assert.equal(s.users.find('alice').prefs.lastCategory, 'Séries');
    assertNoSearch(s);
  });
});

test('upload + série : type anime et dossier choisis, recherche par IMDb ou par tmdb de série', async () => {
  await withSetup(async (s) => {
    const sonarr = s.mocks.sonarr;
    const r = await s.call(upMsg({ category: 'Animés', media: { type: 'series', ids: { imdb: 'tt0903747' }, seriesType: 'anime', rootFolder: '/anime' } }));
    assert.equal(r.arrResult, 'ajouté à Sonarr, non surveillée (Breaking Bad)');
    const body = bodyOf(only(sonarr, 'POST', '/api/v3/series')[0]);
    assert.equal(body.seriesType, 'anime');
    assert.equal(body.rootFolderPath, '/anime');
    assert.equal(sonarr.reqs[0].url, '/api/v3/series/lookup?term=imdb%3Att0903747');
    sonarr.library = [];
    sonarr.reqs.length = 0;
    assert.equal((await s.call(upMsg({ media: { type: 'series', ids: { tmdb: 1396, tmdbKind: 'tv' } } }))).arrResult, 'ajouté à Sonarr, non surveillée (Breaking Bad)');
    assert.equal(sonarr.reqs[0].url, '/api/v3/series/lookup?term=tmdb%3A1396');
    sonarr.reqs.length = 0;
    const movieKind = await s.call(upMsg({ media: { type: 'series', ids: { tmdb: 1396, tmdbKind: 'movie' } } }));
    assert.equal(movieKind.arrError, 'Sonarr : série introuvable');
    assert.equal(sonarr.reqs.length, 0);
    assertNoSearch(s);
  });
});

test('upload + série : déjà présente ou introuvable', async () => {
  await withSetup(async (s) => {
    const sonarr = s.mocks.sonarr;
    sonarr.library = [{ ...BREAKING, id: 9, title: 'Breaking Bad (bibliothèque)' }];
    assert.deepEqual(await s.call(upMsg({ media: SERIES })), { ok: true, hash: HASH, arrResult: 'déjà dans Sonarr (Breaking Bad (bibliothèque))', arrError: null });
    assert.equal(only(sonarr, 'POST', '/api/v3/series').length, 0);
    assert.equal(only(sonarr, 'GET', '/api/v3/rootfolder').length, 0);
    assert.deepEqual(await s.call(upMsg({ media: { type: 'series', ids: { tvdb: 99999999 } } })), { ok: true, hash: HASH, arrResult: null, arrError: 'Sonarr : série introuvable' });
    assert.equal(s.mocks.qb.adds.length, 2);
  });
});

// ---------- E (suite). upload + Lidarr, MusicBrainz injecté ----------

const MUSIC = { type: 'music', artist: 'Daft Punk', album: 'Discovery', ids: { mbReleaseGroup: MB.group, mbArtist: MB.artist } };
const ARTIST_MODE = { type: 'music', artist: 'Daft Punk', lmode: 'artist', ids: { mbArtist: MB.artist } };
const TARGET_READS = ['lidarr GET metadataprofile', 'lidarr GET qualityprofile', 'lidarr GET rootfolder'];
const NEW_ARTIST = {
  ...ARTIST,
  qualityProfileId: 2,
  metadataProfileId: 3,
  rootFolderPath: '/music',
  monitored: false,
  monitorNewItems: 'none',
  albumFolder: true,
  tags: [],
  addOptions: { monitor: 'none', searchForMissingAlbums: false }
};
const NOT_FOUND_ALBUM = 'Lidarr : album introuvable (corrige artiste / album, ou choisis « L’artiste seul »)';
const lookupTerms = (m, kind) => m.reqs.filter((r) => r.url.startsWith(`/api/v1/${kind}/lookup?`)).map((r) => decodeURIComponent(r.url.split('term=')[1]));

test('upload + album : ajouté à Lidarr non surveillé, sans recherche, avec son artiste non surveillé', async () => {
  await withSetup(async (s) => {
    const lidarr = s.mocks.lidarr;
    const r = await s.call(upMsg({ category: 'Musique', media: MUSIC }));
    assert.deepEqual(r, { ok: true, hash: HASH, arrResult: 'ajouté à Lidarr, non surveillé (Discovery — Daft Punk)', arrError: null });
    const t = timeline(s);
    assert.deepEqual(t.slice(0, 4), ['qb GET torrents/categories', 'lidarr GET album/lookup', 'lidarr GET album', 'lidarr GET artist']);
    assert.deepEqual(t.slice(4, 7).sort(), TARGET_READS);
    assert.deepEqual(t.slice(7), ['lidarr POST album', 'qb POST torrents/add']);
    assert.equal(lidarr.reqs[0].url, `/api/v1/album/lookup?term=lidarr%3A${MB.group}`);
    const post = only(lidarr, 'POST', '/api/v1/album')[0];
    assert.deepEqual(bodyOf(post), { ...ALBUM, monitored: false, anyReleaseOk: true, addOptions: { searchForNewAlbum: false }, artist: NEW_ARTIST });
    assert.equal(post.headers['x-api-key'], SECRET.lidarr);
    assert.equal(only(lidarr, 'POST', '/api/v1/artist').length, 0);
    assert.equal(s.users.find('alice').prefs.lastCategory, 'Musique');
    assertNoSearch(s);
  });
});

test('upload + artiste seul : ajouté à Lidarr non surveillé, sans recherche', async () => {
  await withSetup(async (s) => {
    const lidarr = s.mocks.lidarr;
    const r = await s.call(upMsg({ category: 'Musique', media: ARTIST_MODE }));
    assert.deepEqual(r, { ok: true, hash: HASH, arrResult: 'artiste ajouté à Lidarr, non surveillé (Daft Punk)', arrError: null });
    const t = timeline(s);
    assert.deepEqual(t.slice(0, 4), ['qb GET torrents/categories', 'lidarr GET artist', 'lidarr GET artist', 'lidarr GET artist/lookup']);
    assert.deepEqual(t.slice(4, 7).sort(), TARGET_READS);
    assert.deepEqual(t.slice(7), ['lidarr POST artist', 'qb POST torrents/add']);
    assert.deepEqual(bodyOf(only(lidarr, 'POST', '/api/v1/artist')[0]), NEW_ARTIST);
    assert.equal(only(lidarr, 'POST', '/api/v1/album').length, 0);
    assertNoSearch(s);
  });
});

test('upload + artiste seul : recherche par nom quand aucun identifiant n’est connu', async () => {
  await withSetup(async (s) => {
    const lidarr = s.mocks.lidarr;
    const r = await s.call(upMsg({ category: 'Musique', media: { type: 'music', artist: 'daft punk', lmode: 'artist' } }));
    assert.equal(r.arrResult, 'artiste ajouté à Lidarr, non surveillé (Daft Punk)');
    assert.deepEqual(lines(lidarr).slice(0, 2), ['GET /api/v1/artist', 'GET /api/v1/artist/lookup?term=daft%20punk']);
    assert.deepEqual(s.mb.calls, []);
    assertNoSearch(s);
  });
});

test('upload + album : artiste déjà dans Lidarr → réutilisé, ni artiste ni dossier racine envoyés', async () => {
  await withSetup(async (s) => {
    const lidarr = s.mocks.lidarr;
    lidarr.libArtists = [{ ...ARTIST, id: 5, qualityProfileId: 6, metadataProfileId: 1, rootFolderPath: '/music' }];
    const r = await s.call(upMsg({ category: 'Musique', media: MUSIC }));
    assert.equal(r.arrResult, 'ajouté à Lidarr, non surveillé (Discovery — Daft Punk)');
    assert.equal(only(lidarr, 'POST', '/api/v1/artist').length, 0);
    assert.equal(only(lidarr, 'GET', '/api/v1/rootfolder').length, 0);
    const body = bodyOf(only(lidarr, 'POST', '/api/v1/album')[0]);
    assert.equal(body.artist.id, 5);
    assert.equal(body.artist.qualityProfileId, 6);
    assert.equal(body.monitored, false);
    assert.deepEqual(body.addOptions, { searchForNewAlbum: false });
    assertNoSearch(s);
  });
});

test('upload + Lidarr : déjà présent (résultat de recherche, bibliothèque, artiste existant) → rien n’est ajouté', async () => {
  await withSetup(async (s) => {
    const lidarr = s.mocks.lidarr;
    const known = { ok: true, hash: HASH, arrResult: 'déjà dans Lidarr (Discovery — Daft Punk)', arrError: null };
    lidarr.albums = [{ ...ALBUM, id: 8 }];
    assert.deepEqual(await s.call(upMsg({ category: 'Musique', media: MUSIC })), known);
    lidarr.albums = [{ ...ALBUM }];
    lidarr.libAlbums = [{ ...ALBUM, id: 9, artistId: 5 }];
    assert.deepEqual(await s.call(upMsg({ category: 'Musique', media: MUSIC })), known);
    lidarr.libAlbums = [];
    lidarr.libArtists = [{ ...ARTIST, id: 5 }];
    const artist = await s.call(upMsg({ category: 'Musique', media: ARTIST_MODE }));
    assert.deepEqual(artist, { ok: true, hash: HASH, arrResult: 'déjà dans Lidarr (Daft Punk)', arrError: null });
    assert.equal(lidarr.reqs.filter((r) => r.method === 'POST').length, 0);
    assert.equal(only(lidarr, 'GET', '/api/v1/rootfolder').length, 0);
    assert.equal(s.mocks.qb.adds.length, 3);
  });
});

test('upload + Lidarr : le profil de métadonnées « None » est évité pour un artiste, accepté pour un album', async () => {
  await withSetup(
    async (s) => {
      const lidarr = s.mocks.lidarr;
      await s.call(upMsg({ category: 'Musique', media: MUSIC }));
      assert.equal(bodyOf(only(lidarr, 'POST', '/api/v1/album')[0]).artist.metadataProfileId, 1);
      await s.call(upMsg({ category: 'Musique', media: ARTIST_MODE }));
      assert.equal(bodyOf(only(lidarr, 'POST', '/api/v1/artist')[0]).metadataProfileId, 3);
    },
    { defaults: { lidarrMetaProfile: 1 } }
  );
});

test('upload + Lidarr : introuvable, dossier ou profil inconnus → arrError, torrent tout de même envoyé', async () => {
  await withSetup(async (s) => {
    const lidarr = s.mocks.lidarr;
    const arrError = async (media) => {
      const r = await s.call(upMsg({ category: 'Musique', media }));
      assert.equal(r.ok, true);
      assert.equal(r.arrResult, null);
      return r.arrError;
    };
    lidarr.albums = [];
    assert.equal(await arrError({ type: 'music', artist: 'Inconnu', album: 'Rien' }), NOT_FOUND_ALBUM);
    assert.equal(await arrError({ type: 'music', ids: { mbReleaseGroup: MB.group } }), NOT_FOUND_ALBUM);
    lidarr.artists = [];
    assert.equal(await arrError({ type: 'music', artist: 'Inconnu', lmode: 'artist' }), 'Lidarr : artiste introuvable');
    const before = lidarr.reqs.length;
    assert.equal(await arrError({ type: 'music', lmode: 'artist' }), 'Lidarr : artiste introuvable');
    assert.equal(lidarr.reqs.length, before);
    lidarr.artists = [{ ...ARTIST }];
    lidarr.albums = [{ ...ALBUM }];
    assert.equal(await arrError({ ...MUSIC, rootFolder: '/nulle/part' }), 'Lidarr : dossier racine introuvable');
    lidarr.profiles = [];
    assert.equal(await arrError(MUSIC), 'Lidarr : profil qualité / métadonnées introuvable');
    assert.equal(lidarr.reqs.filter((r) => r.method === 'POST').length, 0);
    assert.equal(s.mocks.qb.adds.length, 6);
  });
});

test('upload + album : sans identifiant, MusicBrainz est interrogé (score et titre vérifiés)', async () => {
  await withSetup(async (s) => {
    const lidarr = s.mocks.lidarr;
    s.mb.handler = async () => ({ 'release-groups': [{ id: MB.group, title: 'Discovery', score: 100, 'artist-credit': [{ artist: { id: MB.artist } }] }] });
    const r = await s.call(upMsg({ category: 'Musique', media: { type: 'music', artist: 'Daft Punk', album: 'Discovery' } }));
    assert.equal(r.arrResult, 'ajouté à Lidarr, non surveillé (Discovery — Daft Punk)');
    assert.deepEqual(s.mb.calls, [`release-group?limit=10&query=${encodeURIComponent('releasegroup:"Discovery" AND artist:"Daft Punk"')}`]);
    assert.equal(lidarr.reqs[0].url, `/api/v1/album/lookup?term=lidarr%3A${MB.group}`);
    assertNoSearch(s);
  });
});

test('upload + album : candidats MusicBrainz douteux ignorés, recherche par nom dans Lidarr', async () => {
  const doubtful = [
    { id: MB.group, title: 'Discovery', score: 79 },
    { id: MB.group, title: 'Discovery (Live)', score: 100 },
    { id: MB.group, title: 'Discovery', score: 'élevé' },
    { id: 'pas-un-mbid', title: 'Discovery', score: 100 },
    { id: '../command', title: 'Discovery', score: 100 },
    null,
    7
  ];
  for (const candidate of doubtful) {
    await withSetup(async (s) => {
      s.mb.handler = async () => ({ 'release-groups': [candidate] });
      const media = { type: 'music', artist: 'Daft Punk', album: 'Discovery' };
      const r = await s.call(upMsg({ category: 'Musique', media }));
      assert.equal(r.arrResult, 'ajouté à Lidarr, non surveillé (Discovery — Daft Punk)', JSON.stringify(candidate));
      assert.equal(s.mb.calls.length, 1);
      assert.deepEqual(lookupTerms(s.mocks.lidarr, 'album'), ['Daft Punk Discovery']);
    });
  }
});

test('upload + album : sortie MusicBrainz convertie en groupe de sorties', async () => {
  await withSetup(async (s) => {
    const lidarr = s.mocks.lidarr;
    s.mb.handler = async () => ({ 'release-group': { id: MB.group }, 'artist-credit': [{ artist: { id: MB.artist } }] });
    const media = { type: 'music', artist: 'Daft Punk', album: 'Discovery', ids: { mbRelease: MB.release } };
    const r = await s.call(upMsg({ category: 'Musique', media }));
    assert.equal(r.arrResult, 'ajouté à Lidarr, non surveillé (Discovery — Daft Punk)');
    assert.deepEqual(s.mb.calls, [`release/${MB.release}?inc=release-groups+artist-credits`]);
    assert.deepEqual(lookupTerms(lidarr, 'album'), [`lidarr:${MB.group}`]);
    assertNoSearch(s);
  });
});

test('upload + album : MusicBrainz en panne ou absurde → recherche par nom, aucune valeur dangereuse transmise', async () => {
  const replies = [
    () => Promise.reject(new Error(`MusicBrainz 503 ${SECRET.lidarr}`)),
    () => {
      throw new Error('boom');
    },
    () => null,
    () => 'texte',
    () => 42,
    () => [],
    () => ({}),
    () => ({ 'release-groups': 'x' }),
    () => ({ 'release-groups': [null, 7, 'a', []] }),
    () => ({ 'release-group': { id: '../command' }, 'artist-credit': [{ artist: { id: '../../x' } }], 'release-groups': [{ id: '../x', title: 'Discovery', score: 100 }] })
  ];
  for (const reply of replies) {
    await withSetup(async (s) => {
      s.mb.handler = reply;
      const media = { type: 'music', artist: 'Daft Punk', album: 'Discovery', ids: { mbRelease: MB.release } };
      const r = await s.call(upMsg({ category: 'Musique', media }));
      assert.equal(r.arrResult, 'ajouté à Lidarr, non surveillé (Discovery — Daft Punk)', String(reply));
      assert.deepEqual(lookupTerms(s.mocks.lidarr, 'album'), [`lidarr:${MB.release}`, 'Daft Punk Discovery']);
      for (const x of s.mocks.lidarr.reqs) assert.doesNotMatch(x.url, /\.\.|command|%2e/i);
      assertNoSearch(s);
    });
  }
});

test('upload + album : identifiants MusicBrainz hostiles refusés sans aucune requête', async () => {
  await withSetup(async (s) => {
    const hostile = [
      ['mbReleaseGroup', '../command'],
      ['mbRelease', `${MB.release}/../x`],
      ['mbArtist', `${MB.artist}?a=b`],
      ['mbReleaseGroup', MB.group + '\n'],
      ['mbReleaseGroup', 5],
      ['mbArtist', {}],
      ['mbRelease', [MB.release]]
    ];
    for (const [key, value] of hostile) {
      const media = { type: 'music', artist: 'Daft Punk', album: 'Discovery', ids: { [key]: value } };
      assert.deepEqual(await s.call(upMsg({ category: 'Musique', media })), { ok: false, error: invalid(`media.ids.${key}`) }, key);
    }
    assert.equal(s.total(), 0);
    assert.deepEqual(s.mb.calls, []);
  });
});

// ---------- E (suite). entrées hostiles, infohash, refus de qBittorrent ----------

const EMPTY_B64 = 'Le fichier .torrent est vide ou mal encodé.';
const TOO_BIG = 'Le fichier .torrent est trop volumineux.';
const HINT = ' — vérifie qu’il n’est pas déjà présent';
const manyKeys = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));

test('upload : exige une interaction récente, avant tout examen du contenu', async () => {
  await withSetup(async (s) => {
    for (const opts of [undefined, null, {}, { recentInput: false }, { recentInput: 'true' }, { recentInput: 1 }, { recentInput: [] }, true, 'yes', []]) {
      const label = JSON.stringify(opts);
      assert.deepEqual(await s.as(ALICE, upMsg({ media: MOVIE }), opts), { ok: false, error: NO_INPUT }, label);
      assert.deepEqual(await s.as(ALICE, upMsg({ base64: '%%%', media: { type: 'nope' }, category: 5 }), opts), { ok: false, error: NO_INPUT }, label);
    }
    assert.equal(s.total(), 0);
    assert.equal(s.mocks.qb.logins(), 0);
    assert.deepEqual(await s.as(ALICE, upMsg(), { recentInput: true }), OK_UPLOAD);
  });
});

test('upload : torrent invalide refusé avant tout appel réseau (connexion comprise)', async () => {
  const nested = (n) => Buffer.from(`d4:info${'l'.repeat(n)}${'e'.repeat(n)}e`);
  const cases = [
    ['vide', '', EMPTY_B64],
    ['espace dans le texte', b64(TORRENT).replace(/^(.{8})/, '$1 '), EMPTY_B64],
    ['saut de ligne final', `${b64(TORRENT)}\n`, EMPTY_B64],
    ['alphabet URL-safe', b64(Buffer.from([0xfb, 0xff, 0xfe, 0xfb, 0xff, 0xfe])).replace(/\+/g, '-').replace(/\//g, '_'), EMPTY_B64],
    ['remplissage au milieu', 'QQ==QQ==', EMPTY_B64],
    ['longueur invalide', 'QUJDR', EMPTY_B64],
    ['nombre', 5, EMPTY_B64],
    ['objet', {}, EMPTY_B64],
    ['tableau', [b64(TORRENT)], EMPTY_B64],
    ['absent', undefined, EMPTY_B64],
    ['page HTML', b64('<html>pas un torrent</html>'), NOT_TORRENT],
    ['entier seul', b64('i42e'), NOT_TORRENT],
    ['liste vide', b64('le'), NOT_TORRENT],
    ['dictionnaire vide', b64('de'), NOT_TORRENT],
    ['sans info', b64(bencode({ announce: 'http://tracker.invalid/announce' })), NOT_TORRENT],
    ['info qui n’est pas un dictionnaire', b64(bencode({ info: [1, 2] })), NOT_TORRENT],
    ['info en double', b64(Buffer.from('d4:infode4:infodee')), NOT_TORRENT],
    ['tronqué', b64(TORRENT.subarray(0, TORRENT.length - 3)), NOT_TORRENT],
    ['données après la fin', b64(Buffer.concat([TORRENT, Buffer.from('x')])), NOT_TORRENT],
    ['listes imbriquées à l’extrême', b64(nested(100000)), NOT_TORRENT],
    ['longueur de chaîne démesurée', b64('d4:infod4:name99999999999:xee'), NOT_TORRENT],
    ['longueur de chaîne hors fichier', b64('d4:infod4:name500:xee'), NOT_TORRENT]
  ];
  await withSetup(async (s) => {
    for (const [name, base64, error] of cases) assert.deepEqual(await s.call(upMsg({ base64, media: MOVIE })), { ok: false, error }, name);
    assert.equal(s.total(), 0);
    assert.equal(s.mocks.qb.logins(), 0);
    assert.equal(s.users.find('alice').prefs.lastCategory, undefined);
  });
});

test('upload : fichier trop volumineux refusé avant décodage et avant tout appel réseau', async () => {
  await withSetup(
    async (s) => {
      assert.deepEqual(await s.call(upMsg({ base64: b64(Buffer.alloc(3000, 1)) })), { ok: false, error: TOO_BIG });
      assert.deepEqual(await s.call(upMsg({ base64: b64(Buffer.alloc(2049)) })), { ok: false, error: TOO_BIG });
      assert.deepEqual(await s.call(upMsg({ base64: 'A'.repeat(40 * 1024 * 1024) })), { ok: false, error: TOO_BIG });
      assert.equal(s.total(), 0);
      // À la limite, seul le contenu est jugé.
      assert.deepEqual(await s.call(upMsg({ base64: b64(Buffer.alloc(2048)) })), { ok: false, error: NOT_TORRENT });
      assert.equal(s.total(), 0);
    },
    { config: { ...config, maxUploadBytes: 2048 } }
  );
});

test('upload : champs hostiles refusés sans aucune requête', async () => {
  await withSetup(async (s) => {
    const cases = [
      [{ category: 5 }, 'category'],
      [{ category: {} }, 'category'],
      [{ category: ['Films'] }, 'category'],
      [{ category: true }, 'category'],
      [{ category: 'x'.repeat(101) }, 'category'],
      [{ category: 'Fi\u0000lms' }, 'category'],
      [{ category: 'Films\n' }, 'category'],
      [{ category: 'Fi\u2028lms' }, 'category'],
      [{ category: '\ud800' }, 'category'],
      [{ paused: 'true' }, 'paused'],
      [{ paused: 1 }, 'paused'],
      [{ paused: {} }, 'paused'],
      [{ paused: [] }, 'paused'],
      [{ filename: 5 }, 'filename'],
      [{ filename: {} }, 'filename'],
      [{ filename: 'f'.repeat(5000) }, 'filename']
    ];
    for (const [fields, field] of cases) assert.deepEqual(await s.call(upMsg(fields)), { ok: false, error: invalid(field) }, JSON.stringify(fields).slice(0, 60));
    assert.equal(s.total(), 0);
  });
});

test('upload : media hostile refusé sans aucune requête sortante', async () => {
  await withSetup(async (s) => {
    const cases = [
      [{ type: 'movie', ids: { tmdb: '../../command' } }, 'media.ids.tmdb'],
      [{ type: 'movie', ids: { tmdb: '603/../../x' } }, 'media.ids.tmdb'],
      [{ type: 'movie', ids: { tmdb: -1 } }, 'media.ids.tmdb'],
      [{ type: 'movie', ids: { tmdb: 603.5 } }, 'media.ids.tmdb'],
      [{ type: 'movie', ids: { tmdb: 1e30 } }, 'media.ids.tmdb'],
      [{ type: 'movie', ids: { tmdb: [603] } }, 'media.ids.tmdb'],
      [{ type: 'movie', ids: { imdb: 'tt0133093/../x' } }, 'media.ids.imdb'],
      [{ type: 'movie', ids: { imdb: 'tt123' } }, 'media.ids.imdb'],
      [{ type: 'movie', ids: { imdb: 5 } }, 'media.ids.imdb'],
      [{ type: 'movie', ids: { tmdbKind: 'tv/../x' } }, 'media.ids.tmdbKind'],
      [{ type: 'series', ids: { tvdb: '1; DROP TABLE' } }, 'media.ids.tvdb'],
      [{ type: 'series', ids: { tvdb: 2 ** 40 } }, 'media.ids.tvdb'],
      [{ type: 'movie', ids: manyKeys(100) }, 'media.ids'],
      [{ type: 'movie', ids: [] }, 'media.ids'],
      [{ type: 'movie', ids: 'x' }, 'media.ids'],
      [manyKeys(100), 'media'],
      [5, 'media'],
      ['movie', 'media'],
      [[{ type: 'movie' }], 'media'],
      [true, 'media'],
      [{ type: 'film' }, 'media.type'],
      [{ type: 'MOVIE' }, 'media.type'],
      [{ type: 5 }, 'media.type'],
      [{ type: {} }, 'media.type'],
      [{ type: '__proto__' }, 'media.type'],
      [{ type: 'movie', year: '19999' }, 'media.year'],
      [{ type: 'movie', year: {} }, 'media.year'],
      [{ type: 'series', seasons: 'x' }, 'media.seasons'],
      [{ type: 'series', seasons: [1.5] }, 'media.seasons'],
      [{ type: 'series', seasons: [-1] }, 'media.seasons'],
      [{ type: 'series', seasons: Array(201).fill(1) }, 'media.seasons'],
      [{ type: 'series', seriesType: 'anime/../x' }, 'media.seriesType'],
      [{ type: 'music', lmode: 'x' }, 'media.lmode'],
      [{ type: 'music', artist: 5 }, 'media.artist'],
      [{ type: 'music', artist: 'a'.repeat(301) }, 'media.artist'],
      [{ type: 'music', album: 'a'.repeat(901) }, 'media.album'],
      [{ type: 'movie', rootFolder: 5 }, 'media.rootFolder'],
      [{ type: 'movie', rootFolder: '/movies\u0000' }, 'media.rootFolder'],
      [{ type: 'movie', rootFolder: '/m'.repeat(300) }, 'media.rootFolder']
    ];
    for (const [media, field] of cases) assert.deepEqual(await s.call(upMsg({ media })), { ok: false, error: invalid(field) }, JSON.stringify(media).slice(0, 80));
    assert.equal(s.total(), 0);
    assert.deepEqual(s.mb.calls, []);
  });
});

test('upload : champs inconnus du media ignorés (même énormes ou imbriqués), jamais transmis aux services', async () => {
  await withSetup(async (s) => {
    const radarr = s.mocks.radarr;
    const deep = {};
    let cur = deep;
    for (let i = 0; i < 20000; i++) cur = cur.next = {};
    const media = {
      ...MOVIE,
      junk: deep,
      monitored: true,
      addOptions: { searchForMovie: true },
      searchForMovie: true,
      rootFolderPath: '/etc',
      qualityProfileId: 99,
      [`x${'y'.repeat(5000)}`]: 1
    };
    const r = await s.call(upMsg({ media }));
    assert.equal(r.arrResult, 'ajouté à Radarr, non surveillé (The Matrix)');
    const body = bodyOf(only(radarr, 'POST', '/api/v3/movie')[0]);
    assert.equal(body.monitored, false);
    assert.equal(body.rootFolderPath, '/movies');
    assert.equal(body.qualityProfileId, 4);
    assert.deepEqual(body.addOptions, { monitor: 'none', searchForMovie: false });
    assert.equal(Object.keys(body).some((k) => k === 'junk' || k.length > 100), false);
    assertNoSearch(s);

    // __proto__ et constructor fournis par JSON.parse sont des propriétés propres sans effet.
    const proto = JSON.parse('{"type":"movie","__proto__":{"rootFolder":"/etc"},"ids":{"__proto__":{"tmdb":603},"constructor":{"tmdb":603}}}');
    radarr.reqs.length = 0;
    assert.deepEqual(await s.call(upMsg({ media: proto })), { ok: true, hash: HASH, arrResult: null, arrError: 'Radarr : film introuvable' });
    assert.equal(radarr.reqs.length, 0);
    assert.equal({}.rootFolder, undefined);
  });
});

test('upload : l’infohash est le SHA-1 du dictionnaire info (comparé à un calcul indépendant)', async () => {
  await withSetup(async (s) => {
    const qb = s.mocks.qb;
    const info = { length: 99, name: 'Autre', 'piece length': 32768, pieces: Buffer.alloc(40, 9), private: 1 };
    const torrent = makeTorrent(info, { comment: 'd4:infoe', 'url-list': ['http://a.invalid/'] });
    const r = await s.call(upMsg({ base64: b64(torrent), category: '' }));
    assert.equal(r.hash, crypto.createHash('sha1').update(bencode(info)).digest('hex'));
    assert.notEqual(r.hash, HASH);
    assert.ok(qb.adds[0].parts.torrents.value.equals(torrent));
    const literal = await s.call(upMsg({ base64: b64(LITERAL), category: '' }));
    assert.equal(literal.hash, LITERAL_HASH);
    assert.notEqual(literal.hash, DECOY_HASH);
    assert.ok(qb.adds[1].parts.torrents.value.equals(LITERAL));
  });
});

test('upload : un nom de fichier malveillant ne peut pas injecter de partie multipart', async () => {
  await withSetup(async (s) => {
    const qb = s.mocks.qb;
    const names = [
      ['x"; name="category"\r\nX: y.torrent', 'x; name=categoryX: y.torrent'],
      ['../../etc/passwd', 'passwd'],
      ['C:\\Windows\\system32\\evil.torrent', 'evil.torrent'],
      ['  espace.torrent  ', 'espace.torrent'],
      ['..', 'file.torrent'],
      ['.', 'file.torrent'],
      ['a/', 'file.torrent'],
      ['\u0000\u0001', 'file.torrent'],
      ['é'.repeat(300), 'é'.repeat(255)]
    ];
    for (const [filename, expected] of names) {
      assert.deepEqual(await s.call(upMsg({ filename })), OK_UPLOAD, filename);
      const { parts } = qb.adds.at(-1);
      assert.deepEqual(Object.keys(parts).sort(), ['category', 'torrents'], filename);
      assert.equal(parts.torrents.filename, expected, filename);
      assert.equal(parts.category.value.toString(), 'Films');
    }
  });
});

test('upload : la catégorie est mémorisée par utilisateur, jamais après un refus', async () => {
  await withSetup(async (s) => {
    const qb = s.mocks.qb;
    await s.call(upMsg({ category: 'Séries' }), ALICE);
    await s.call(upMsg({ category: 'Musique' }), BOSS);
    assert.equal(s.users.find('alice').prefs.lastCategory, 'Séries');
    assert.equal(s.users.find('boss').prefs.lastCategory, 'Musique');
    assert.equal((await s.call({ type: 'getCategories' }, ALICE)).selected, 'Séries');
    assert.equal((await s.call({ type: 'getCategories' }, BOSS)).selected, 'Musique');
    await s.call(upMsg({ category: 'Inconnue' }), ALICE);
    await s.call(upMsg({ category: 'Films', base64: 'xx' }), ALICE);
    await s.call(upMsg({ category: 'Films', media: { type: 'nope' } }), ALICE);
    qb.addReply = { status: 200, body: 'Fails.' };
    assert.equal((await s.call(upMsg({ category: 'Films' }), ALICE)).ok, false);
    assert.equal(s.users.find('alice').prefs.lastCategory, 'Séries');
    qb.addReply = { status: 200, body: 'Ok.' };
    await s.call(upMsg({ category: '' }), ALICE);
    assert.equal(s.users.find('alice').prefs.lastCategory, '');
    assert.equal((await s.call({ type: 'getCategories' }, ALICE)).selected, 'Films');
    assert.equal(s.users.find('boss').prefs.lastCategory, 'Musique');
  });
});

test('upload : refus de qBittorrent rapportés sans adresse, ajout Arr déjà fait', async () => {
  await withSetup(async (s) => {
    const qb = s.mocks.qb;
    const attempt = () => s.call(upMsg());
    qb.addReply = { status: 200, body: 'Fails.' };
    assert.deepEqual(await attempt(), { ok: false, error: `qBittorrent a refusé le torrent (HTTP 200 : Fails.)${HINT}` });
    qb.addReply = { status: 200, body: JSON.stringify({ failure_count: 1, success_count: 0, pending_count: 0 }) };
    const counters = await attempt();
    assert.equal(counters.ok, false);
    assert.match(counters.error, /^qBittorrent a refusé le torrent \(HTTP 200 : \{.*\}\) — vérifie/);
    for (const reply of [{ failure_count: 1, success_count: 1, pending_count: 0 }, { failure_count: 0, success_count: 1 }, { failure_count: 1, pending_count: 1 }, { failure_count: 0 }]) {
      qb.addReply = { status: 200, body: JSON.stringify(reply) };
      assert.deepEqual(await attempt(), OK_UPLOAD, JSON.stringify(reply));
    }
    qb.addReply = { status: 200, body: '{pas du json' };
    assert.deepEqual(await attempt(), OK_UPLOAD);
    qb.addReply = { status: 415, body: 'Unsupported' };
    assert.deepEqual(await attempt(), { ok: false, error: 'qBittorrent a refusé le torrent (HTTP 415 : Unsupported)' });
    qb.addReply = { status: 500, body: `erreur ${qb.url}/x sur 127.0.0.1:${qb.port} avec ${SECRET.qbPass}` };
    const leaky = await attempt();
    assert.equal(leaky.ok, false);
    assert.match(leaky.error, /^qBittorrent a refusé le torrent \(HTTP 500 : erreur /);
    assert.doesNotMatch(leaky.error, /127\.0\.0\.1|http|\d{4,5}|Zx81/);
    qb.addReply = { status: 403, body: 'Forbidden' };
    assert.equal((await attempt()).ok, false);
  });
});

test('upload : un refus de qBittorrent ne défait pas l’ajout Arr déjà fait, la catégorie n’est pas mémorisée', async () => {
  await withSetup(async (s) => {
    s.mocks.qb.addReply = { status: 200, body: 'Fails.' };
    const r = await s.call(upMsg({ category: 'Musique', media: MOVIE }));
    assert.deepEqual(r, { ok: false, error: `qBittorrent a refusé le torrent (HTTP 200 : Fails.)${HINT}` });
    assert.equal(only(s.mocks.radarr, 'POST', '/api/v3/movie').length, 1);
    assert.equal(s.users.find('alice').prefs.lastCategory, undefined);
  });
});

test('upload : session qBittorrent expirée pendant l’envoi → nouvelle connexion et rejeu', async () => {
  await withSetup(async (s) => {
    const qb = s.mocks.qb;
    assert.deepEqual(await s.call(upMsg()), OK_UPLOAD);
    assert.equal(qb.logins(), 1);
    qb.state.sessions.clear();
    assert.deepEqual(await s.call(upMsg()), OK_UPLOAD);
    assert.equal(qb.logins(), 2);
    assert.equal(qb.adds.length, 2);
    assert.equal(only(qb, 'POST', '/api/v2/torrents/add').length, 2);
  });
});

test('upload : deux envois simultanés du même utilisateur sont sérialisés (un seul ajout à Radarr)', async () => {
  await withSetup(async (s) => {
    const [a, b] = await Promise.all([s.call(upMsg({ media: MOVIE })), s.call(upMsg({ media: MOVIE }))]);
    assert.equal(a.arrResult, 'ajouté à Radarr, non surveillé (The Matrix)');
    assert.equal(b.arrResult, 'déjà dans Radarr (The Matrix)');
    assert.equal(only(s.mocks.radarr, 'POST', '/api/v3/movie').length, 1);
    assert.equal(s.mocks.qb.adds.length, 2);
    assertNoSearch(s);
  });
});

// ---------- F. politique : rien n’est envoyé sans autorisation, jamais de recherche ----------

const deepObject = (n) => {
  const root = {};
  let cur = root;
  for (let i = 0; i < n; i++) cur = cur.n = {};
  return root;
};

// Toutes les opérations de la vue : lectures, pause, envois vers Radarr, Sonarr et Lidarr.
async function everything(s, user) {
  const msgs = [
    { type: 'getCategories' },
    { type: 'listTorrents' },
    { type: 'qbitIndex' },
    { type: 'pageStatus', hash: HASH_A, media: MOVIE },
    { type: 'pageStatus', hash: HASH_A, media: SERIES },
    { type: 'pageStatus', hash: HASH_A, media: MUSIC },
    { type: 'arrMeta', service: 'radarr' },
    { type: 'arrMeta', service: 'sonarr' },
    { type: 'arrMeta', service: 'lidarr' },
    { type: 'toggleTorrent', hash: HASH_A, pause: true },
    upMsg({ media: MOVIE }),
    upMsg({ media: SERIES }),
    upMsg({ media: MUSIC }),
    upMsg({ media: ARTIST_MODE })
  ];
  for (const msg of msgs) {
    const r = await s.call(msg, user);
    assert.equal(r.ok, true, `${msg.type} : ${JSON.stringify(r)}`);
  }
}

test('politique : chaque requête passe par authorizeArr / authorizeQb avec le rôle, sans recherche, quelle que soit la config', async (t) => {
  const arr = [];
  const qbs = [];
  const realArr = policy.authorizeArr;
  const realQb = policy.authorizeQb;
  t.mock.method(policy, 'authorizeArr', (o) => {
    arr.push(o);
    return realArr(o);
  });
  t.mock.method(policy, 'authorizeQb', (o) => {
    qbs.push(o);
    return realQb(o);
  });
  for (const user of [ALICE, BOSS]) {
    for (const allowSearchCommands of [false, true]) {
      arr.length = 0;
      qbs.length = 0;
      await withSetup(
        async (s) => {
          await everything(s, user);
          assert.ok(arr.length >= 20 && qbs.length >= 10, `${arr.length} appels Arr, ${qbs.length} appels qBittorrent`);
          for (const o of arr) {
            assert.equal(o.role, user.role);
            assert.equal(o.allowSearch, false);
            assert.equal(o.contentType, 'application/json');
            assert.doesNotMatch(o.rest, /^command/i);
            assert.ok(o.method === 'GET' || o.method === 'POST', o.method);
            assert.equal(o.method === 'GET', o.body === null, `${o.method} ${o.rest}`);
          }
          for (const o of qbs) assert.equal(o.role, user.role);

          // Chaque requête reçue par un Arr a été autorisée avant son envoi, avec le corps réellement envoyé.
          assert.equal(arr.length, arrReqs(s));
          const sent = ['radarr', 'sonarr', 'lidarr'].flatMap((svc) => s.mocks[svc].reqs.filter((r) => r.method === 'POST').map((r) => r.body.toString()));
          assert.ok(sent.length >= 4);
          assert.deepEqual(
            arr.filter((o) => o.method === 'POST').map((o) => o.body.toString()).sort(),
            sent.sort()
          );
          assert.equal(qbs.length, s.mocks.qb.reqs.filter((r) => !r.url.startsWith('/api/v2/auth/')).length);
          assertNoSearch(s);
        },
        { config: { ...config, allowSearchCommands } }
      );
    }
  }
});

test('politique : un refus de authorizeArr ou de authorizeQb empêche l’envoi, sans reprendre le message d’origine', async (t) => {
  const refuse = () => {
    throw new HttpError(403, `Action réservée aux administrateurs (${SECRET.radarr} ${SECRET.qbPass})`);
  };
  await withSetup(async (s) => {
    const { qb, radarr } = s.mocks;
    const arr = t.mock.method(policy, 'authorizeArr', refuse);
    assert.deepEqual(await s.call({ type: 'arrMeta', service: 'radarr' }), { ok: false, error: 'Opération non autorisée.' });
    assert.deepEqual(await s.call(upMsg({ media: MOVIE })), { ok: true, hash: HASH, arrResult: null, arrError: 'Opération non autorisée.' });
    assert.equal((await s.call({ type: 'pageStatus', media: MOVIE })).library, null);
    assert.equal(radarr.reqs.length, 0);
    assert.ok(arr.mock.callCount() >= 3);
    arr.mock.restore();

    const before = qb.reqs.length;
    const logins = qb.logins();
    const denied = t.mock.method(policy, 'authorizeQb', refuse);
    for (const msg of [{ type: 'getCategories' }, { type: 'listTorrents' }, { type: 'qbitIndex' }, { type: 'toggleTorrent', hash: HASH_A, pause: false }, upMsg()]) {
      assert.deepEqual(await s.call(msg, BOSS), { ok: false, error: 'Opération non autorisée.' }, msg.type);
    }
    assert.equal(qb.reqs.length, before);
    assert.equal(qb.logins(), logins);
    assert.ok(denied.mock.callCount() >= 5);
  });
});

test('politique : le rôle est transmis tel quel, un rôle absent ou inattendu ne donne aucun droit', async (t) => {
  const seen = [];
  const real = policy.authorizeQb;
  t.mock.method(policy, 'authorizeQb', (o) => {
    seen.push(o.role);
    return real(o);
  });
  await withSetup(async (s) => {
    for (const role of ['admin', 'root', 'ADMIN', '', undefined, null, 1, {}, ['admin']]) {
      assert.equal((await s.as({ username: 'alice', role }, { type: 'getCategories' })).ok, true);
    }
    assert.deepEqual(seen, ['admin', 'root', 'ADMIN', '', 'user', 'user', 'user', 'user', 'user']);
  });
});

test('politique : un résultat de recherche porteur d’un drapeau de recherche n’est jamais renvoyé au service', async () => {
  const cases = [
    ['Radarr, drapeau imbriqué', 'radarr', MOVIE, 'POST /api/v3/movie', '/api/v3/rootfolder', (m) => (m.movies[603] = { ...MATRIX, extra: { nested: [{ searchForMovie: true }] } })],
    ['Radarr, imbrication suspecte', 'radarr', MOVIE, 'POST /api/v3/movie', '/api/v3/rootfolder', (m) => (m.movies[603] = { ...MATRIX, deep: deepObject(40) })],
    ['Sonarr, drapeau de premier niveau', 'sonarr', SERIES, 'POST /api/v3/series', '/api/v3/rootfolder', (m) => (m.shows[81189] = { ...BREAKING, searchForMissingEpisodes: true })],
    ['Lidarr, album', 'lidarr', MUSIC, 'POST /api/v1/album', '/api/v1/rootfolder', (m) => (m.albums = [{ ...ALBUM, artist: { ...ARTIST }, extra: { searchForNewAlbum: true } }])],
    ['Lidarr, artiste', 'lidarr', ARTIST_MODE, 'POST /api/v1/artist', '/api/v1/rootfolder', (m) => (m.artists = [{ ...ARTIST, extra: [{ searchForMissingAlbums: true }] }])]
  ];
  for (const [name, svc, media, post, reached, poison] of cases) {
    await withSetup(async (s) => {
      poison(s.mocks[svc]);
      assert.deepEqual(await s.call(upMsg({ media })), { ok: true, hash: HASH, arrResult: null, arrError: 'Opération non autorisée.' }, name);
      const [method, pathname] = post.split(' ');
      assert.equal(only(s.mocks[svc], method, pathname).length, 0, name);
      // La requête a bien été construite jusqu’au bout avant d’être refusée.
      assert.equal(only(s.mocks[svc], 'GET', reached).length, 1, name);
      assert.equal(s.mocks.qb.adds.length, 1, name);
      assertNoSearch(s);
    });
  }
});

test('politique : un drapeau de recherche déjà présent dans un résultat est neutralisé quand le moteur le remplace lui-même', async () => {
  await withSetup(async (s) => {
    // Ces champs sont réécrits par le moteur : le service reçoit des valeurs sûres.
    s.mocks.radarr.movies[603] = { ...MATRIX, monitored: true, addOptions: { searchForMovie: true, monitor: 'movieOnly' } };
    s.mocks.lidarr.artists = [{ ...ARTIST, monitored: true, addOptions: { searchForMissingAlbums: true, monitor: 'all' } }];
    assert.equal((await s.call(upMsg({ media: MOVIE }))).arrResult, 'ajouté à Radarr, non surveillé (The Matrix)');
    assert.equal((await s.call(upMsg({ media: ARTIST_MODE }))).arrResult, 'artiste ajouté à Lidarr, non surveillé (Daft Punk)');
    const movie = bodyOf(only(s.mocks.radarr, 'POST', '/api/v3/movie')[0]);
    assert.deepEqual([movie.monitored, movie.addOptions], [false, { monitor: 'none', searchForMovie: false }]);
    const artist = bodyOf(only(s.mocks.lidarr, 'POST', '/api/v1/artist')[0]);
    assert.deepEqual([artist.monitored, artist.addOptions], [false, { monitor: 'none', searchForMissingAlbums: false }]);
    assertNoSearch(s);
  });
});

// ---------- G. session qBittorrent et en-têtes ----------

// Place un faux service derrière un préfixe d’URL, comme derrière un proxy inverse.
function underPrefix(m, prefix) {
  const inner = m.server.listeners('request')[0];
  m.server.removeAllListeners('request');
  m.prefixed = [];
  m.server.on('request', (req, res) => {
    if (!req.url.startsWith(`${prefix}/`)) {
      res.writeHead(404);
      return res.end('hors préfixe');
    }
    m.prefixed.push(req.url);
    req.url = req.url.slice(prefix.length);
    return inner(req, res);
  });
}

test('qBittorrent : une connexion par utilisateur (client « c411 »), partagée par les appels simultanés', async () => {
  await withSetup(async (s) => {
    const qb = s.mocks.qb;
    const replies = await Promise.all(Array.from({ length: 6 }, (_, i) => s.call({ type: i % 2 ? 'listTorrents' : 'getCategories' })));
    assert.ok(replies.every((r) => r.ok));
    assert.equal(qb.logins(), 1);
    assert.equal((await s.call({ type: 'qbitIndex' })).ok, true);
    assert.equal(qb.logins(), 1);
    assert.equal((await s.call({ type: 'getCategories' }, BOSS)).ok, true);
    assert.equal(qb.logins(), 2);
    assert.deepEqual([...s.proxy.qb.sessions.keys()].sort(), ['alice|c411', 'boss|c411']);
    const mine = s.proxy.qb.sessions.get('alice|c411').cookie;
    const his = s.proxy.qb.sessions.get('boss|c411').cookie;
    assert.match(mine, /^SID=sid\d+$/);
    assert.match(his, /^SID=sid\d+$/);
    assert.notEqual(mine, his);
    // Une requête authentifiée porte toujours le cookie de son utilisateur.
    const cookies = new Set(qb.reqs.filter((r) => !r.url.startsWith('/api/v2/auth/')).map((r) => r.headers.cookie));
    assert.deepEqual([...cookies].sort(), [mine, his].sort());
  });
});

test('en-têtes : Origin et Referer du serveur qBittorrent, clé API seulement pour les Arr, rien d’autre', async () => {
  await withSetup(async (s) => {
    await s.call({ type: 'listTorrents' });
    await s.call({ type: 'arrMeta', service: 'radarr' });
    await s.call({ type: 'arrMeta', service: 'lidarr' });
    const qb = s.mocks.qb;
    const login = qb.reqs.filter((r) => r.url === '/api/v2/auth/login');
    assert.equal(login.length, 1);
    assert.equal(login[0].headers['content-type'], 'application/x-www-form-urlencoded');
    assert.equal(login[0].headers.origin, qb.origin);
    const authed = qb.reqs.filter((r) => !r.url.startsWith('/api/v2/auth/'));
    assert.ok(authed.length >= 2);
    for (const r of authed) {
      assert.match(r.headers.cookie, /^SID=sid\d+$/);
      assert.equal(r.headers.origin, qb.origin);
      assert.equal(r.headers.referer, `${qb.origin}/`);
      assert.equal(r.headers['accept-encoding'], 'identity');
      assert.equal(r.headers['x-api-key'], undefined);
    }
    for (const svc of ['radarr', 'lidarr']) {
      const m = s.mocks[svc];
      assert.ok(m.reqs.length >= 2);
      for (const r of m.reqs) {
        assert.equal(r.headers['x-api-key'], SECRET[svc]);
        assert.equal(r.headers.accept, 'application/json');
        assert.equal(r.headers['accept-encoding'], 'identity');
        for (const name of ['cookie', 'origin', 'referer', 'authorization']) assert.equal(r.headers[name], undefined, name);
      }
    }
  });
});

test('qBittorrent : session expirée → une seule nouvelle connexion, même pour des appels simultanés', async () => {
  await withSetup(async (s) => {
    const qb = s.mocks.qb;
    assert.equal((await s.call({ type: 'getCategories' })).ok, true);
    qb.state.sessions.clear();
    const replies = await Promise.all(Array.from({ length: 5 }, () => s.call({ type: 'getCategories' })));
    assert.ok(replies.every((r) => r.ok));
    assert.equal(qb.logins(), 2);
    assert.equal((await s.call({ type: 'toggleTorrent', hash: HASH_A, pause: false })).ok, true);
    assert.equal(qb.logins(), 2);
  });
});

test('qBittorrent : mauvais identifiants → message sans secret, une seule tentative de connexion', async () => {
  await withSetup(async (s) => {
    const qb = s.mocks.qb;
    s.cfgStore.data.connections.qb.password = 'mauvais-mot-de-passe';
    const expected = { ok: false, error: 'qBittorrent a refusé les identifiants enregistrés. Un administrateur doit les corriger dans Réglages.' };
    assert.deepEqual(await s.call({ type: 'getCategories' }), expected);
    assert.deepEqual(await s.call({ type: 'listTorrents' }, BOSS), expected);
    assert.deepEqual(await s.call(upMsg({ media: MOVIE })), expected);
    assert.equal(qb.logins(), 1);
    assert.equal(s.total(), 1);
    s.sweep('mauvais-mot-de-passe');
  });
});

test('qBittorrent : adresse bannie → message dédié, pas de nouvelle tentative pendant le blocage', async () => {
  await withSetup(async (s) => {
    const qb = s.mocks.qb;
    qb.state.mode = 'banned';
    const expected = { ok: false, error: 'qBittorrent a banni l’adresse du serveur après trop d’échecs de connexion. Réessaie dans quelques minutes.' };
    assert.deepEqual(await s.call({ type: 'getCategories' }), expected);
    assert.deepEqual(await s.call({ type: 'qbitIndex' }), expected);
    assert.deepEqual(await s.call(upMsg()), expected);
    assert.equal(qb.logins(), 1);
  });
});

test('qBittorrent : accès refusé même après reconnexion → erreur claire, un seul rejeu', async () => {
  await withSetup(async (s) => {
    const qb = s.mocks.qb;
    qb.force['*'] = { status: 403, body: 'Forbidden' };
    assert.deepEqual(await s.call({ type: 'getCategories' }), { ok: false, error: 'qBittorrent a refusé l’accès (HTTP 403).' });
    assert.equal(qb.logins(), 2);
    assert.equal(only(qb, 'GET', '/api/v2/torrents/categories').length, 2);
    qb.force['*'] = { status: 401, body: 'Unauthorized' };
    assert.deepEqual(await s.call({ type: 'toggleTorrent', hash: HASH_A, pause: true }), { ok: false, error: 'qBittorrent a refusé l’accès (HTTP 401).' });
  });
});

test('qBittorrent injoignable : message réseau sans adresse ni port, avant comme après la connexion', async () => {
  const gone = /^Réseau : (connexion refusée|connexion interrompue)$/;
  await withSetup(async (s) => {
    await s.mocks.qb.close();
    for (const msg of [{ type: 'listTorrents' }, upMsg({ media: MOVIE })]) {
      const r = await s.call(msg);
      assert.equal(r.ok, false);
      assert.match(r.error, gone);
    }
    assert.equal(s.mocks.radarr.reqs.length, 0);
  });
  await withSetup(async (s) => {
    assert.equal((await s.call({ type: 'getCategories' })).ok, true);
    await s.mocks.qb.close();
    const r = await s.call({ type: 'getCategories' });
    assert.equal(r.ok, false);
    assert.match(r.error, gone);
  });
});

test('qBittorrent sans authentification (identifiants vides) : ni connexion ni cookie', async () => {
  await withSetup(async (s) => {
    const qb = s.mocks.qb;
    qb.state.noAuth = true;
    Object.assign(s.cfgStore.data.connections.qb, { username: '', password: '' });
    assert.equal((await s.call({ type: 'getCategories' })).ok, true);
    assert.equal((await s.call(upMsg())).ok, true);
    assert.equal(qb.logins(), 0);
    assert.ok(qb.reqs.length >= 2);
    for (const r of qb.reqs) assert.equal(r.headers.cookie, undefined);
  });
});

test('URL de base : le préfixe enregistré pour qBittorrent et pour un Arr est respecté', async () => {
  await withSetup(async (s) => {
    const { qb, radarr } = s.mocks;
    underPrefix(qb, '/qbt');
    underPrefix(radarr, '/radarr');
    s.cfgStore.data.connections.qb.url = `${qb.url}/qbt`;
    s.cfgStore.data.connections.radarr.url = `${radarr.url}/radarr/`;
    assert.equal((await s.call({ type: 'getCategories' })).ok, true);
    assert.equal((await s.call(upMsg({ media: MOVIE }))).arrResult, 'ajouté à Radarr, non surveillé (The Matrix)');
    assert.ok(qb.prefixed.length >= 3 && qb.prefixed.every((u) => u.startsWith('/qbt/api/v2/')), qb.prefixed.join());
    assert.ok(radarr.prefixed.length >= 4 && radarr.prefixed.every((u) => u.startsWith('/radarr/api/v3/')), radarr.prefixed.join());
    assert.ok(qb.reqs.every((r) => r.headers.origin === qb.origin));
  });
});

// ---------- H. délais, limites de concurrence et robustesse ----------

const CATEGORIES = 'GET /api/v2/torrents/categories';
const JsProxy = globalThis.Proxy;
const visitor = (i) => ({ username: `visiteur${i}`, role: 'user' });
// Un texte qui ressemble à ce qu’une exception réseau pourrait contenir : secrets, adresses, cookie de session.
const leaky = (s) => {
  const cookies = [...s.proxy.qb.sessions.values()].map((x) => x.cookie).filter(Boolean);
  return [SECRET.qbPass, `${s.mocks.qb.url}/api/v2/auth`, SECRET.radarr, s.mocks.radarr.origin, ...cookies].join(' ');
};
const noSecretIn = (s, line) => {
  for (const n of [SECRET.qbUser, SECRET.qbPass, SECRET.radarr, 'SID=', '127.0.0.1', s.mocks.qb.url, s.mocks.radarr.origin, `:${s.mocks.qb.port}`]) {
    assert.ok(!line.includes(n), `fuite de « ${n} » dans le journal : ${line}`);
  }
};
const logged = (mock) => mock.mock.calls.map((c) => c.arguments.join(' '));

test('délai : un service muet → « Délai dépassé », requête abandonnée, moteur aussitôt disponible', async () => {
  await withSetup(
    async (s) => {
      const qb = s.mocks.qb;
      assert.equal((await s.call({ type: 'qbitIndex' })).ok, true);
      qb.force[CATEGORIES] = { stall: true };
      const t0 = Date.now();
      assert.deepEqual(await s.call({ type: 'getCategories' }), { ok: false, error: TIMEOUT });
      assert.ok(Date.now() - t0 < 3000);
      await until(() => qb.aborted === 1, 'requête abandonnée côté service');
      assert.equal(only(qb, 'GET', '/api/v2/torrents/categories').length, 1);
      delete qb.force[CATEGORIES];
      assert.equal((await s.call({ type: 'getCategories' })).ok, true);
    },
    { deadlineMs: 600 }
  );
});

test('délai : une connexion qBittorrent tardive n’envoie plus aucune requête', async (t) => {
  await withSetup(
    async (s) => {
      let finish;
      const login = t.mock.method(s.proxy.qb, 'cookieFor', () => new Promise((resolve) => (finish = resolve)));
      assert.deepEqual(await s.call({ type: 'getCategories' }), { ok: false, error: TIMEOUT });
      finish('SID=trop-tard');
      await sleep(150);
      assert.equal(s.total(), 0);
      login.mock.restore();
      assert.equal((await s.call({ type: 'getCategories' })).ok, true);
    },
    { deadlineMs: 200 }
  );
});

test('limite par utilisateur : 8 requêtes en cours, les suivantes refusées d’emblée, la place revient ensuite', async () => {
  await withSetup(
    async (s) => {
      const qb = s.mocks.qb;
      assert.equal((await s.call({ type: 'qbitIndex' })).ok, true);
      qb.force[CATEGORIES] = { stall: true };
      const replies = await Promise.all([...Array.from({ length: 11 }, () => s.call({ type: 'getCategories' })), s.call({ type: 'qbitIndex' }, BOSS)]);
      assert.deepEqual(replies.slice(0, 8), Array(8).fill({ ok: false, error: TIMEOUT }));
      assert.deepEqual(replies.slice(8, 11), Array(3).fill({ ok: false, error: BUSY }));
      assert.equal(replies[11].ok, true, 'un autre utilisateur n’est pas gêné');
      await until(() => qb.aborted === 8, 'requêtes abandonnées côté service');
      assert.equal(only(qb, 'GET', '/api/v2/torrents/categories').length, 8);
      delete qb.force[CATEGORIES];
      await until(async () => (await s.call({ type: 'getCategories' })).ok, 'place rendue');
    },
    { deadlineMs: 700 }
  );
});

test('limite globale : 64 requêtes en cours au plus, tous utilisateurs confondus, puis la place revient', async () => {
  await withSetup(
    async (s) => {
      s.mocks.qb.force[CATEGORIES] = { stall: true };
      const calls = [];
      for (let u = 0; u < 9; u++) for (let i = 0; i < 8; i++) calls.push(s.as(visitor(u), { type: 'getCategories' }, { recentInput: true }));
      const replies = await Promise.all(calls);
      assert.equal(replies.filter((r) => r.error === TIMEOUT).length, 64);
      assert.deepEqual(replies.slice(64), Array(8).fill({ ok: false, error: BUSY }));
      delete s.mocks.qb.force[CATEGORIES];
      await until(async () => (await s.as(visitor(8), { type: 'qbitIndex' }, { recentInput: true })).ok, 'place rendue');
    },
    { deadlineMs: 900 }
  );
});

test('handle ne rejette jamais : objets piégés, getters qui lèvent, mandataires révoqués', async (t) => {
  await withSetup(async (s) => {
    assert.equal((await s.call({ type: 'qbitIndex' })).ok, true);
    const sent = s.total();
    const errors = t.mock.method(console, 'error', () => {});
    const boom = () => {
      throw new Error(`piégé ${leaky(s)}`);
    };
    const trapped = (target, ...names) => new JsProxy(target, Object.fromEntries(names.map((n) => [n, boom])));
    const revoked = () => {
      const r = JsProxy.revocable({}, {});
      r.revoke();
      return r.proxy;
    };
    const asked = { recentInput: true };
    const cats = { type: 'getCategories' };
    const cases = [
      [ALICE, trapped({ ...cats }, 'get'), asked],
      [ALICE, trapped({ ...cats }, 'getOwnPropertyDescriptor'), asked],
      [ALICE, trapped({ ...cats }, 'ownKeys'), asked],
      [ALICE, trapped({ ...cats }, 'getPrototypeOf'), asked],
      [ALICE, revoked(), asked],
      [
        ALICE,
        {
          get type() {
            boom();
          }
        },
        asked
      ],
      [
        ALICE,
        {
          type: 'arrMeta',
          get service() {
            boom();
          }
        },
        asked
      ],
      [
        ALICE,
        {
          type: 'toggleTorrent',
          pause: true,
          get hash() {
            boom();
          }
        },
        asked
      ],
      [
        ALICE,
        {
          type: 'upload',
          base64: b64(TORRENT),
          get filename() {
            boom();
          }
        },
        asked
      ],
      [
        ALICE,
        {
          type: 'pageStatus',
          media: {
            type: 'movie',
            get ids() {
              boom();
            }
          }
        },
        asked
      ],
      [ALICE, { type: 'pageStatus', media: trapped({ type: 'movie' }, 'ownKeys') }, asked],
      [trapped({ username: 'alice', role: 'user' }, 'get'), cats, asked],
      [revoked(), cats, asked],
      [
        {
          get username() {
            boom();
          },
          role: 'user'
        },
        cats,
        asked
      ],
      [
        {
          username: 'alice',
          get role() {
            boom();
          }
        },
        cats,
        asked
      ],
      [ALICE, upMsg(), trapped({ recentInput: true }, 'get')],
      [ALICE, upMsg(), revoked()],
      [
        ALICE,
        { type: 'toggleTorrent', hash: HASH_A, pause: true },
        {
          get recentInput() {
            boom();
          }
        }
      ]
    ];
    for (const [i, [user, msg, opts]] of cases.entries()) {
      assert.deepEqual(await s.as(user, msg, opts), { ok: false, error: INTERNAL }, `cas ${i}`);
    }
    assert.equal(errors.mock.callCount(), cases.length);

    // Toute valeur levée est absorbée, quelle que soit sa nature.
    const thrown = [null, undefined, 'texte', 42, Symbol('x'), { message: SECRET.qbPass }, Object.create(null), new Error(leaky(s))];
    for (const v of thrown) {
      const msg = {
        type: 'arrMeta',
        get service() {
          throw v;
        }
      };
      assert.deepEqual(await s.as(ALICE, msg, asked), { ok: false, error: INTERNAL });
    }
    // Un symbole ou un objet sans prototype ne se formate pas : réponse générique, rien dans le journal.
    assert.equal(errors.mock.callCount(), cases.length + thrown.length - 2);
    for (const line of logged(errors)) noSecretIn(s, line);
    assert.equal(s.total(), sent, 'rien n’a été envoyé');
  });
});

test('exceptions inattendues des dépendances : message générique, journal sans secret, aucun envoi parasite', async (t) => {
  await withSetup(async (s) => {
    const errors = t.mock.method(console, 'error', () => {});
    const boom = () => {
      throw new TypeError(`panne ${leaky(s)}`);
    };
    const { qb, radarr } = s.mocks;

    const find = t.mock.method(s.users, 'find', boom);
    assert.deepEqual(await s.call({ type: 'getCategories' }), { ok: false, error: INTERNAL });
    find.mock.restore();

    const arr = t.mock.method(policy, 'authorizeArr', boom);
    assert.deepEqual(await s.call(upMsg({ media: MOVIE })), { ok: true, hash: HASH, arrResult: null, arrError: INTERNAL });
    assert.deepEqual(await s.call({ type: 'arrMeta', service: 'radarr' }), { ok: false, error: INTERNAL });
    assert.equal(radarr.reqs.length, 0);
    assert.equal(only(qb, 'POST', '/api/v2/torrents/add').length, 1, 'le torrent est tout de même ajouté');
    arr.mock.restore();

    const qbPolicy = t.mock.method(policy, 'authorizeQb', boom);
    const before = qb.reqs.length;
    assert.deepEqual(await s.call({ type: 'getCategories' }), { ok: false, error: INTERNAL });
    assert.deepEqual(await s.call({ type: 'listTorrents' }, BOSS), { ok: false, error: INTERNAL });
    assert.equal(qb.reqs.length, before, 'aucune requête, pas même une connexion');
    assert.equal(qb.logins(), 1);
    qbPolicy.mock.restore();

    assert.equal(errors.mock.callCount(), 5);
    for (const line of logged(errors)) {
      assert.match(line, /\[c411\] erreur inattendue : TypeError: panne/);
      noSecretIn(s, line);
    }
  });
});

test('mémorisation de la catégorie impossible : l’envoi reste réussi, avertissement sans secret', async (t) => {
  await withSetup(async (s) => {
    const warn = t.mock.method(console, 'warn', () => {});
    t.mock.method(s.users, 'setPrefs', async () => {
      throw new Error(`disque plein ${leaky(s)}`);
    });
    assert.deepEqual(await s.call(upMsg()), OK_UPLOAD);
    assert.equal(only(s.mocks.qb, 'POST', '/api/v2/torrents/add').length, 1);
    assert.equal(warn.mock.callCount(), 1);
    const [line] = logged(warn);
    assert.match(line, /\[c411\] catégorie non mémorisée : disque plein/);
    noSecretIn(s, line);
  });
});

test('un cookie de session déjà émis est masqué dans les messages d’erreur', async (t) => {
  await withSetup(async (s) => {
    const cookie = 'SID=Zq7mK2pL9xRt';
    let n = 0;
    t.mock.method(s.proxy.qb, 'cookieFor', async () => {
      if (++n === 1) return cookie;
      throw new HttpError(502, `refus pour ${cookie} / ${cookie.slice(4)} / mot de passe ${SECRET.qbPass}`);
    });
    // Le service ignore ce cookie (403) : le moteur demande une nouvelle connexion, qui échoue.
    assert.deepEqual(await s.call({ type: 'getCategories' }), { ok: false, error: 'refus pour … / … / mot de passe …' });
    assert.equal(n, 2);
    s.sweep(cookie, cookie.slice(4));
  });
});

test('createEngine : dépendances obligatoires, close() répétable, MusicBrainz injecté jamais fermé par le moteur', async () => {
  await withSetup(async (s) => {
    const { proxy, users, cfgStore } = s;
    for (const bad of [undefined, {}, { proxy }, { proxy, users }, { users, cfgStore }, { proxy, cfgStore }]) assert.throws(() => createEngine(bad), TypeError);
    s.engine.close();
    s.engine.close();
    assert.equal(s.mb.closed, 0);
    const own = createEngine({ proxy, users, cfgStore });
    assert.equal((await own.handle(ALICE, { type: 'getCategories' })).ok, true);
    own.close();
    own.close();
  });
});

// ---------- I. client MusicBrainz, sur un vrai serveur HTTPS local ----------

// Certificat auto-signé pour 127.0.0.1, écrit en DER à la main : ni dépendance ni openssl.
const der = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  const n = body.length;
  const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return Buffer.concat([Buffer.from([tag, ...len]), body]);
};
const derOid = (dotted) => {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [a * 40 + b];
  for (const n of rest) {
    const groups = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) groups.unshift((v & 0x7f) | 0x80);
    bytes.push(...groups);
  }
  return der(0x06, Buffer.from(bytes));
};
const derTime = (d) => der(0x17, Buffer.from(`${d.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`));
const DER_TRUE = der(0x01, Buffer.from([0xff]));

let TLS = null;
function tlsMaterial() {
  if (TLS) return TLS;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const name = der(0x30, der(0x31, der(0x30, derOid('2.5.4.3'), der(0x0c, Buffer.from('localhost')))));
  const algorithm = der(0x30, derOid('1.2.840.10045.4.3.2'));
  const now = Date.now();
  const extensions = der(
    0xa3,
    der(
      0x30,
      der(0x30, derOid('2.5.29.19'), DER_TRUE, der(0x04, der(0x30, DER_TRUE))),
      der(0x30, derOid('2.5.29.17'), der(0x04, der(0x30, der(0x82, Buffer.from('localhost')), der(0x87, Buffer.from([127, 0, 0, 1])))))
    )
  );
  const tbs = der(
    0x30,
    Buffer.from([0xa0, 0x03, 0x02, 0x01, 0x02]),
    der(0x02, Buffer.from([1, 2, 3, 4])),
    algorithm,
    name,
    der(0x30, derTime(new Date(now - 86400000)), derTime(new Date(now + 86400000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  const body = der(0x30, tbs, algorithm, der(0x03, Buffer.from([0]), signature))
    .toString('base64')
    .match(/.{1,64}/g)
    .join('\n');
  TLS = { cert: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  return TLS;
}

// Faux musicbrainz.org : serveur HTTPS local qui note chaque requête reçue.
async function tlsServer(handler) {
  const { cert, key } = tlsMaterial();
  const reqs = [];
  const server = https.createServer({ cert, key }, (req, res) => {
    reqs.push({ method: req.method, url: req.url, headers: req.headers, at: Date.now() });
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    reqs,
    port,
    ca: cert,
    origin: `https://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      })
  };
}

// Sans intervalle par défaut : seuls les tests de cadence le rétablissent (intervalMs: undefined).
async function withMb(handler, opts, fn) {
  const tls = await tlsServer(handler);
  const mbc = createMusicBrainz({ origin: tls.origin, ca: tls.ca, intervalMs: 0, ...opts });
  try {
    await fn(mbc, tls);
  } finally {
    mbc.close();
    await tls.close();
  }
}
const echo = (req, res) => json(res, 200, { url: req.url });

test('certificat de test : auto-signé, valable pour 127.0.0.1, signature correcte', () => {
  const x = new crypto.X509Certificate(tlsMaterial().cert);
  assert.equal(x.checkIP('127.0.0.1'), '127.0.0.1');
  assert.equal(x.ca, true);
  assert.equal(x.verify(x.publicKey), true);
});

test('MusicBrainz : certificat toujours vérifié, même avec INSECURE_UPSTREAM_TLS et NODE_TLS_REJECT_UNAUTHORIZED=0', async (t) => {
  assert.equal(config.insecureUpstreamTls, true);
  const tls = await tlsServer(echo);
  const saved = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  t.mock.method(process, 'emitWarning', () => {});
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const strict = createMusicBrainz({ origin: tls.origin, intervalMs: 0 });
  const pinned = createMusicBrainz({ origin: tls.origin, intervalMs: 0, ca: tls.ca });
  try {
    // Témoin : le transport des autres services accepte ce certificat auto-signé.
    const witness = await up.requestBuffered({ base: up.parseBase(tls.origin), method: 'GET', path: '/ws/2/artist', headers: {} }, 4096);
    assert.equal(witness.status, 200);
    assert.equal(tls.reqs.length, 1);
    await assert.rejects(strict.get('artist?query=a'), (e) => /^(DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)$/.test(e.code));
    assert.equal(tls.reqs.length, 1, 'aucune requête HTTP n’a atteint le serveur');
    assert.equal(strict.agent.options.rejectUnauthorized, true);
    assert.deepEqual(await pinned.get('artist?query=a'), { url: '/ws/2/artist?query=a&fmt=json' });
  } finally {
    if (saved === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = saved;
    strict.close();
    pinned.close();
    await tls.close();
  }
});

test('MusicBrainz : le code du moteur ne contient aucun contournement de la vérification TLS', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server', 'c411', 'engine.js'), 'utf8');
  assert.doesNotMatch(source, /insecureUpstreamTls|rejectUnauthorized:\s*false|NODE_TLS_REJECT_UNAUTHORIZED|globalAgent/);
  assert.match(source, /rejectUnauthorized: true/);
});

test('MusicBrainz : GET /ws/2/… en JSON, User-Agent identifiant, aucun en-tête superflu', async () => {
  const sentHeaders = async (opts) => {
    let headers = null;
    await withMb(echo, opts, async (mbc, tls) => {
      assert.deepEqual(await mbc.get(`release/${MB.release}?inc=release-groups+artist-credits`), { url: `/ws/2/release/${MB.release}?inc=release-groups+artist-credits&fmt=json` });
      assert.deepEqual(await mbc.get('artist'), { url: '/ws/2/artist?fmt=json' });
      assert.deepEqual(
        tls.reqs.map((r) => r.method),
        ['GET', 'GET']
      );
      headers = tls.reqs[0].headers;
    });
    return headers;
  };
  const { host, ...others } = await sentHeaders({});
  assert.match(host, /^127\.0\.0\.1:\d+$/);
  assert.deepEqual(others, { 'user-agent': `Arr411-Web/${config.version}`, accept: 'application/json', 'accept-encoding': 'identity', connection: 'keep-alive' });
  assert.equal((await sentHeaders({ version: '9.8.7' }))['user-agent'], 'Arr411-Web/9.8.7');
  assert.equal((await sentHeaders({ userAgent: 'Autre/1' }))['user-agent'], 'Autre/1');
});

test('MusicBrainz : réponses mises en cache, appels simultanés regroupés, expiration du TTL', async () => {
  let n = 0;
  await withMb((req, res) => json(res, 200, { n: ++n }), { ttlMs: 250 }, async (mbc, tls) => {
    const same = await Promise.all(Array.from({ length: 5 }, () => mbc.get('artist?query=a')));
    assert.deepEqual(same, Array(5).fill({ n: 1 }));
    assert.deepEqual(await mbc.get('artist?query=a'), { n: 1 });
    assert.equal(tls.reqs.length, 1);
    assert.deepEqual(await mbc.get('artist?query=b'), { n: 2 });
    await sleep(320);
    assert.deepEqual(await mbc.get('artist?query=a'), { n: 3 });
    assert.equal(tls.reqs.length, 3);
  });
});

test('MusicBrainz : requêtes espacées d’au moins l’intervalle, dans l’ordre d’arrivée', async () => {
  await withMb(echo, { intervalMs: 250 }, async (mbc, tls) => {
    const results = await Promise.all(['a', 'b', 'c'].map((p) => mbc.get(`artist?query=${p}`)));
    assert.deepEqual(
      results.map((r) => r.url),
      ['a', 'b', 'c'].map((p) => `/ws/2/artist?query=${p}&fmt=json`)
    );
    assert.deepEqual(
      tls.reqs.map((r) => r.url),
      results.map((r) => r.url)
    );
    for (let i = 1; i < tls.reqs.length; i++) assert.ok(tls.reqs[i].at - tls.reqs[i - 1].at >= 150, `écart de ${tls.reqs[i].at - tls.reqs[i - 1].at} ms`);
  });
});

test('MusicBrainz : cadence par défaut d’une requête par seconde', async () => {
  await withMb(echo, { intervalMs: undefined }, async (mbc, tls) => {
    await Promise.all([mbc.get('artist?query=a'), mbc.get('artist?query=b')]);
    assert.equal(tls.reqs.length, 2);
    assert.ok(tls.reqs[1].at - tls.reqs[0].at >= 600, `écart de ${tls.reqs[1].at - tls.reqs[0].at} ms`);
  });
});

test('MusicBrainz : file d’attente bornée, refus sans mise en cache', async () => {
  await withMb(echo, { maxQueue: 2, intervalMs: 150 }, async (mbc, tls) => {
    const paths = ['a', 'b', 'c', 'd'].map((p) => `artist?query=${p}`);
    const settled = await Promise.allSettled(paths.map((p) => mbc.get(p)));
    assert.deepEqual(
      settled.map((r) => r.status),
      ['fulfilled', 'fulfilled', 'rejected', 'rejected']
    );
    assert.equal(settled[2].reason.message, 'MusicBrainz : file d’attente pleine');
    assert.equal(settled[3].reason.message, 'MusicBrainz : file d’attente pleine');
    assert.equal(tls.reqs.length, 2);
    assert.deepEqual(await mbc.get(paths[2]), { url: '/ws/2/artist?query=c&fmt=json' });
    assert.equal(tls.reqs.length, 3);
  });
});

test('MusicBrainz : cache borné, l’entrée la moins récemment utilisée est évincée', async () => {
  await withMb(echo, { maxEntries: 2 }, async (mbc, tls) => {
    for (const p of ['a', 'b', 'a', 'c', 'a', 'b']) await mbc.get(`artist?query=${p}`);
    assert.deepEqual(
      tls.reqs.map((r) => r.url),
      ['a', 'b', 'c', 'b'].map((p) => `/ws/2/artist?query=${p}&fmt=json`)
    );
  });
});

test('MusicBrainz : un échec est mémorisé brièvement puis retenté', async () => {
  let status = 500;
  await withMb((req, res) => json(res, status, {}), { failTtlMs: 250 }, async (mbc, tls) => {
    await assert.rejects(mbc.get('artist?query=a'), { message: 'MusicBrainz 500' });
    await assert.rejects(mbc.get('artist?query=a'), { message: 'MusicBrainz 500' });
    assert.equal(tls.reqs.length, 1);
    status = 200;
    await sleep(320);
    assert.deepEqual(await mbc.get('artist?query=a'), {});
    assert.equal(tls.reqs.length, 2);
  });
});

test('MusicBrainz : connexion réutilisée coupée par le serveur → un seul nouvel essai', async () => {
  let n = 0;
  await withMb((req, res) => (++n === 2 ? req.socket.destroy() : json(res, 200, { n })), {}, async (mbc, tls) => {
    assert.deepEqual(await mbc.get('artist?query=a'), { n: 1 });
    assert.deepEqual(await mbc.get('artist?query=b'), { n: 3 });
    assert.equal(tls.reqs.length, 3);
  });
  n = 0;
  await withMb((req, res) => (++n >= 2 ? req.socket.destroy() : json(res, 200, { n })), {}, async (mbc, tls) => {
    assert.deepEqual(await mbc.get('artist?query=a'), { n: 1 });
    await assert.rejects(mbc.get('artist?query=b'), (e) => e.code === 'ECONNRESET');
    assert.equal(tls.reqs.length, 3);
  });
});

test('MusicBrainz : chemins hors liste blanche refusés sans aucune requête', async () => {
  const refused = [
    '../x',
    'artist/../x',
    'a b',
    '',
    '/ws/2/artist',
    'http://evil.example/',
    '#frag',
    'artist\r\nHost: evil',
    'artist\n',
    'Artist',
    'artist?x=é',
    `artist?q=${'a'.repeat(5000)}`,
    'artist//x',
    'artist/zzzz',
    `artist/${MB.artist}/x`,
    null,
    undefined,
    42,
    {},
    [],
    ['artist'],
    { toString: () => 'artist' }
  ];
  await withMb(echo, {}, async (mbc, tls) => {
    for (const p of refused) await assert.rejects(mbc.get(p), { message: 'MusicBrainz : chemin refusé' }, String(typeof p === 'string' ? p.slice(0, 40) : JSON.stringify(p)));
    assert.equal(tls.reqs.length, 0);
    const accepted = [`artist/${MB.artist}`, `release-group?limit=10&query=${encodeURIComponent('releasegroup:"L’été" AND artist:"X"')}`, "release-group?query=L'%C3%A9t%C3%A9"];
    for (const p of accepted) await mbc.get(p);
    assert.equal(tls.reqs.length, accepted.length);
    for (const r of tls.reqs) assert.match(r.url, /^\/ws\/2\/[a-z-]+(\/[0-9a-f-]{36})?\?(.*&)?fmt=json$/);
  });
});

test('MusicBrainz : redirection jamais suivie', async () => {
  const target = await tlsServer(echo);
  try {
    const redirect = (req, res) => {
      res.writeHead(302, { Location: `${target.origin}/ws/2/artist` });
      res.end();
    };
    await withMb(redirect, {}, async (mbc, tls) => {
      await assert.rejects(mbc.get('artist?query=a'), { message: 'MusicBrainz 302' });
      assert.equal(tls.reqs.length, 1);
    });
    assert.equal(target.reqs.length, 0);
  } finally {
    await target.close();
  }
});

test('MusicBrainz : réponses anormales rejetées proprement, une seule requête à chaque fois', async () => {
  const reply = (status, headers, body) => (req, res) => {
    res.writeHead(status, headers);
    res.end(body);
  };
  const JSON_TYPE = { 'Content-Type': 'application/json' };
  const cases = [
    ['404', reply(404, JSON_TYPE, '{}'), {}, 'MusicBrainz 404'],
    ['503', reply(503, { 'Retry-After': '1' }, 'surchargé'), {}, 'MusicBrainz 503'],
    ['204', reply(204, {}), {}, 'MusicBrainz 204'],
    ['JSON invalide', reply(200, JSON_TYPE, '{"a":'), {}, 'MusicBrainz : réponse invalide'],
    ['HTML', reply(200, { 'Content-Type': 'text/html' }, '<html>'), {}, 'MusicBrainz : réponse invalide'],
    ['gzip imposé', reply(200, { ...JSON_TYPE, 'Content-Encoding': 'gzip' }, zlib.gzipSync('{"a":1}')), {}, 'MusicBrainz : réponse invalide'],
    ['trop volumineuse', reply(200, JSON_TYPE, JSON.stringify({ pad: 'x'.repeat(5000) })), { maxBytes: 1000 }, 'MusicBrainz : réponse trop volumineuse'],
    ['énorme', reply(200, JSON_TYPE, 'x'.repeat(3 * 1024 * 1024)), {}, 'MusicBrainz : réponse trop volumineuse'],
    [
      'corps interrompu',
      (req, res) => {
        res.writeHead(200, JSON_TYPE);
        res.write('{"a":');
      },
      { timeoutMs: 150 },
      'MusicBrainz : délai dépassé'
    ],
    ['sans réponse', () => {}, { timeoutMs: 150 }, 'MusicBrainz : délai dépassé']
  ];
  for (const [name, handler, opts, message] of cases) {
    await withMb(handler, opts, async (mbc, tls) => {
      await assert.rejects(mbc.get('artist?query=a'), { message }, name);
      assert.equal(tls.reqs.length, 1, name);
    });
  }
  await withMb((req, res) => req.socket.destroy(), {}, async (mbc, tls) => {
    await assert.rejects(mbc.get('artist?query=a'), (e) => e.code === 'ECONNRESET');
    assert.equal(tls.reqs.length, 1, 'connexion neuve coupée : pas de nouvel essai');
  });
});

test('MusicBrainz : limite de taille exacte à l’octet près', async () => {
  const body = JSON.stringify({ pad: 'x'.repeat(2000) });
  await withMb((req, res) => res.end(body), { maxBytes: body.length }, async (mbc) => {
    assert.equal((await mbc.get('artist?query=a')).pad.length, 2000);
  });
  await withMb((req, res) => res.end(body), { maxBytes: body.length - 1 }, async (mbc) => {
    await assert.rejects(mbc.get('artist?query=a'), { message: 'MusicBrainz : réponse trop volumineuse' });
  });
});

test('MusicBrainz : close() refuse les appels suivants et libère les tâches en attente', async () => {
  const tls = await tlsServer(echo);
  const mbc = createMusicBrainz({ origin: tls.origin, ca: tls.ca, intervalMs: 500 });
  try {
    const first = mbc.get('artist?query=a');
    const second = mbc.get('artist?query=b');
    await first;
    mbc.close();
    await assert.rejects(second, { message: 'MusicBrainz : arrêté' });
    await assert.rejects(mbc.get('artist?query=c'), { message: 'MusicBrainz : arrêté' });
    await assert.rejects(mbc.get('artist?query=a'), { message: 'MusicBrainz : arrêté' });
    mbc.close();
    assert.equal(tls.reqs.length, 1);
  } finally {
    mbc.close();
    await tls.close();
  }
});

test('MusicBrainz : origine HTTPS obligatoire, agent dédié à vérification stricte', () => {
  for (const origin of ['http://musicbrainz.org', 'ftp://musicbrainz.org', 'file:///etc/passwd', 'ws://musicbrainz.org']) assert.throws(() => createMusicBrainz({ origin }), /HTTPS obligatoire/, origin);
  assert.throws(() => createMusicBrainz({ origin: 'pas une URL' }), TypeError);
  const mbc = createMusicBrainz();
  try {
    assert.ok(mbc.agent instanceof https.Agent);
    assert.notEqual(mbc.agent, https.globalAgent);
    assert.equal(mbc.agent.options.rejectUnauthorized, true);
    assert.equal(mbc.agent.keepAlive, true);
    assert.equal(mbc.agent.maxSockets, 1);
  } finally {
    mbc.close();
  }
});

test('MusicBrainz : par défaut https://musicbrainz.org/ws/2/ avec l’agent dédié', async (t) => {
  const mbc = createMusicBrainz({ intervalMs: 0 });
  let seen = null;
  t.mock.method(https, 'request', (options) => {
    seen = options;
    throw new Error('requête interceptée');
  });
  try {
    await assert.rejects(mbc.get('release-group?limit=10&query=x'), { message: 'requête interceptée' });
    assert.equal(seen.protocol, 'https:');
    assert.equal(seen.hostname, 'musicbrainz.org');
    assert.equal(seen.port, undefined);
    assert.equal(seen.method, 'GET');
    assert.equal(seen.path, '/ws/2/release-group?limit=10&query=x&fmt=json');
    assert.equal(seen.agent, mbc.agent);
    assert.equal(seen.headers['User-Agent'], `Arr411-Web/${config.version}`);
  } finally {
    mbc.close();
  }
});

// Moteur + vrai client MusicBrainz : le serveur HTTPS local joue le rôle de musicbrainz.org.
async function withMbEngine(handler, fn) {
  await withMb(handler, {}, async (mbc, tls) => {
    await withSetup(
      async (s) => {
        await fn(s, tls);
        s.sweep(`:${tls.port}`);
      },
      { musicbrainz: mbc }
    );
  });
}
const mbHandler = (req, res) => {
  const u = new URL(req.url, 'https://x');
  if (u.pathname === '/ws/2/release-group') return json(res, 200, { 'release-groups': [{ id: MB.group, title: 'Discovery', score: 100, 'artist-credit': [{ artist: { id: MB.artist } }] }] });
  if (u.pathname === `/ws/2/release/${MB.release}`) return json(res, 200, { 'release-group': { id: MB.group }, 'artist-credit': [{ artist: { id: MB.artist } }] });
  json(res, 404, {});
};
const LIDARR_ADDED = 'ajouté à Lidarr, non surveillé (Discovery — Daft Punk)';

test('moteur + vrai client MusicBrainz : groupe de sorties trouvé par titre', async () => {
  await withMbEngine(mbHandler, async (s, tls) => {
    const r = await s.call(upMsg({ category: 'Musique', media: { type: 'music', artist: 'Daft Punk', album: 'Discovery' } }));
    assert.equal(r.arrResult, LIDARR_ADDED);
    assert.deepEqual(
      tls.reqs.map((x) => x.url),
      [`/ws/2/release-group?limit=10&query=${encodeURIComponent('releasegroup:"Discovery" AND artist:"Daft Punk"')}&fmt=json`]
    );
    assert.equal(s.mocks.lidarr.reqs[0].url, `/api/v1/album/lookup?term=lidarr%3A${MB.group}`);
    assertNoSearch(s);
  });
});

test('moteur + vrai client MusicBrainz : sortie convertie en groupe de sorties', async () => {
  await withMbEngine(mbHandler, async (s, tls) => {
    const r = await s.call(upMsg({ category: 'Musique', media: { type: 'music', artist: 'Daft Punk', album: 'Discovery', ids: { mbRelease: MB.release } } }));
    assert.equal(r.arrResult, LIDARR_ADDED);
    assert.deepEqual(
      tls.reqs.map((x) => x.url),
      [`/ws/2/release/${MB.release}?inc=release-groups+artist-credits&fmt=json`]
    );
    assert.deepEqual(lookupTerms(s.mocks.lidarr, 'album'), [`lidarr:${MB.group}`]);
    assertNoSearch(s);
  });
});

test('moteur + vrai client MusicBrainz : titres tordus encodés, une seule requête acceptée chacun', async () => {
  const titles = [
    ['Daft Punk', 'Discovery'],
    ['Beyoncé', 'Lemonade (Deluxe) & Co'],
    ['AC/DC', 'Back in Black + Live #1?'],
    ['Guns N’ Roses', 'Appetite: "Destruction" \\ 1987'],
    ['Sinéad O’Connor', "I Do Not Want What I Haven't Got"],
    ['宇多田ヒカル', 'First Love 🎵'],
    ['Sigur Rós', 'ÁTTA'],
    ['!!!', '(*)~_.-'],
    ['A'.repeat(300), 'B'.repeat(300)]
  ];
  await withMbEngine(
    (req, res) => json(res, 200, { 'release-groups': [] }),
    async (s, tls) => {
      for (const [artist, album] of titles) {
        const before = tls.reqs.length;
        const r = await s.call(upMsg({ category: 'Musique', media: { type: 'music', artist, album } }));
        assert.equal(r.ok, true);
        assert.equal(tls.reqs.length, before + 1, `${artist} / ${album}`);
        const u = new URL(tls.reqs[before].url, 'https://x');
        assert.equal(u.pathname, '/ws/2/release-group');
        assert.deepEqual([...u.searchParams.keys()], ['limit', 'query', 'fmt']);
        assert.equal(u.searchParams.get('query'), `releasegroup:"${album.replace(/["\\]/g, ' ')}" AND artist:"${artist.replace(/["\\]/g, ' ')}"`);
      }
    }
  );
});

test('moteur + vrai client MusicBrainz : titres démesurés → aucune requête, repli sur Lidarr', async () => {
  await withMbEngine(mbHandler, async (s, tls) => {
    const media = { type: 'music', artist: '宇'.repeat(300), album: '多'.repeat(300) };
    const r = await s.call(upMsg({ category: 'Musique', media }));
    assert.equal(r.ok, true);
    assert.equal(tls.reqs.length, 0);
    assert.equal(only(s.mocks.qb, 'POST', '/api/v2/torrents/add').length, 1);
    assert.equal(lookupTerms(s.mocks.lidarr, 'album')[0], `${media.artist} ${media.album}`);
  });
});

test('moteur + vrai client MusicBrainz : service en erreur, coupé ou hostile → recherche par nom, rien ne fuit', async () => {
  const failures = [
    (req, res) => json(res, 500, { error: `secret ${SECRET.lidarr} ${SECRET.qbPass}` }),
    (req, res) => req.socket.destroy(),
    (req, res) => {
      res.writeHead(302, { Location: 'http://127.0.0.1:9/' });
      res.end();
    },
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>');
    },
    () => {}
  ];
  for (const handler of failures) {
    await withMb(handler, { timeoutMs: 300 }, async (mbc, tls) => {
      await withSetup(
        async (s) => {
          const r = await s.call(upMsg({ category: 'Musique', media: { type: 'music', artist: 'Daft Punk', album: 'Discovery' } }));
          assert.equal(r.arrResult, LIDARR_ADDED);
          assert.equal(tls.reqs.length, 1);
          assert.deepEqual(lookupTerms(s.mocks.lidarr, 'album'), ['Daft Punk Discovery']);
          assertNoSearch(s);
          s.sweep(`:${tls.port}`);
        },
        { musicbrainz: mbc }
      );
    });
  }
});

// ---------- J. arrêt du processus ----------

const ENGINE_PATH = path.join(ROOT, 'server', 'c411', 'engine');

// Un vrai processus Node : un minuteur ou une socket qui retiendrait la boucle d’événements dépasse la limite.
async function runNode(script, extraEnv = {}, limitMs = 15000) {
  const env = { ...process.env, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['-e', script], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  const started = Date.now();
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve('délai dépassé');
    }, limitMs);
    child.on('close', (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  return { code, stdout, stderr, ms: Date.now() - started };
}

// Un moteur dont le service qBittorrent ne répond jamais, avec trois requêtes en attente et sans close().
const hungEngine = (options, tail) => `
  const { createEngine } = require(${JSON.stringify(ENGINE_PATH)});
  const proxy = {
    connInfo: () => ({ conn: { url: 'http://127.0.0.1:9', username: 'u', password: 'p' }, rev: 1 }),
    qb: { cookieFor: () => new Promise(() => {}) }
  };
  const users = { find: () => ({ prefs: {} }), setPrefs: async () => {} };
  const engine = createEngine({ proxy, users, cfgStore: { data: { defaults: {} } }${options} });
  const calls = [1, 2, 3].map(() => engine.handle({ username: 'alice', role: 'user' }, { type: 'getCategories' }));
  ${tail}
`;

test('processus : un moteur jamais fermé, aux requêtes sans réponse, ne retient pas le processus', async () => {
  const r = await runNode(hungEngine('', "process.stdout.write('started');"));
  assert.equal(r.code, 0, `${r.code} ${r.stderr}`);
  assert.equal(r.stdout, 'started');
  assert.ok(r.ms < 12000, `${r.ms} ms`);
});

test('processus : au délai, les requêtes reçoivent « Délai dépassé » puis le processus s’arrête seul', async () => {
  // Le minuteur du délai est « unref » : un minuteur ordinaire garde le processus en vie le temps qu’il faut.
  const r = await runNode(hungEngine(', deadlineMs: 150', 'setTimeout(() => {}, 700); Promise.all(calls).then((all) => process.stdout.write(JSON.stringify(all)));'));
  assert.equal(r.code, 0, `${r.code} ${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout), [1, 2, 3].map(() => ({ ok: false, error: TIMEOUT })));
});

test('processus : un appel MusicBrainz terminé ne retient pas le processus (socket inactive, minuteurs « unref »)', async () => {
  const tls = await tlsServer(echo);
  try {
    const script = `
      const { createMusicBrainz } = require(${JSON.stringify(ENGINE_PATH)});
      const mb = createMusicBrainz({ origin: process.env.MB_ORIGIN, ca: process.env.MB_CA, intervalMs: 0 });
      mb.get('release-group?query=x').then((r) => process.stdout.write(JSON.stringify(r)));
    `;
    const r = await runNode(script, { MB_ORIGIN: tls.origin, MB_CA: tls.ca });
    assert.equal(r.code, 0, `${r.code} ${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), { url: '/ws/2/release-group?query=x&fmt=json' });
    assert.equal(tls.reqs.length, 1);
    assert.equal(tls.reqs[0].headers['user-agent'], `Arr411-Web/${config.version}`);
  } finally {
    await tls.close();
  }
});

test('processus : un MusicBrainz muet est abandonné au délai et le processus s’arrête seul', async () => {
  const tls = await tlsServer(() => {});
  try {
    const script = `
      const { createMusicBrainz } = require(${JSON.stringify(ENGINE_PATH)});
      const mb = createMusicBrainz({ origin: process.env.MB_ORIGIN, ca: process.env.MB_CA, intervalMs: 0, timeoutMs: 300 });
      mb.get('release-group?query=x').catch((e) => process.stdout.write(e.message));
    `;
    const r = await runNode(script, { MB_ORIGIN: tls.origin, MB_CA: tls.ca });
    assert.equal(r.code, 0, `${r.code} ${r.stderr}`);
    assert.match(r.stdout, /délai dépassé/);
    assert.equal(tls.reqs.length, 1);
  } finally {
    await tls.close();
  }
});

test('processus : chaque minuteur du moteur est « unref », aucun intervalle', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server', 'c411', 'engine.js'), 'utf8');
  assert.equal((source.match(/\bsetInterval\(/g) || []).length, 0);
  const timers = (source.match(/\bsetTimeout\(/g) || []).length;
  assert.ok(timers >= 3);
  assert.equal((source.match(/\.unref\(\)/g) || []).length, timers);
});

// ---------- K. rien ne fuit, rien d’inattendu ne sort ----------

const PROTOTYPES = ['Object', 'Array', 'Function', 'String', 'Number', 'Boolean'];
const prototypeKeys = () => Object.fromEntries(PROTOTYPES.map((n) => [n, Reflect.ownKeys(globalThis[n].prototype).map(String).sort()]));
const PROTOTYPES_AT_LOAD = prototypeKeys();

// Des fragments que le moteur ne peut pas connaître par la configuration : seul le masquage générique les attrape.
const TRAPS = ['10.1.2.3', '192.168.0.5', 'zzz-hidden', 'intranet.example', 'radarr:7878', '[::1]:8989'];
const READS = [
  { type: 'getCategories' },
  { type: 'listTorrents' },
  { type: 'qbitIndex' },
  { type: 'pageStatus', hash: HASH_A, media: MOVIE },
  { type: 'pageStatus', hash: HASH_A, media: SERIES },
  { type: 'pageStatus', hash: HASH_A, media: MUSIC },
  { type: 'arrMeta', service: 'radarr' },
  { type: 'arrMeta', service: 'sonarr' },
  { type: 'arrMeta', service: 'lidarr' },
  { type: 'toggleTorrent', hash: HASH_A, pause: true }
];
const SENDS = [MOVIE, SERIES, MUSIC, ARTIST_MODE].map((media) => upMsg({ media }));
const STATUSES = [302, 400, 403, 404, 500];

// Tout ce qu’un service en défaut pourrait renvoyer d’indiscret : identifiants, clés, adresses, cookies de session.
function leakText(s) {
  const cookies = [...s.proxy.qb.sessions.values()].map((x) => x.cookie).filter(Boolean);
  const addresses = Object.values(s.mocks).flatMap((m) => [m.url, m.origin, `127.0.0.1:${m.port}`, `localhost:${m.port}`]);
  return [...Object.values(SECRET), ...addresses, 'http://10.1.2.3:7878/api/v3/movie?apikey=zzz-hidden', '192.168.0.5:8989', 'ftp://intranet.example/files', 'radarr:7878', '[::1]:8989', ...cookies].join(' ');
}

const BODIES = {
  'objet JSON': (t) => ({ type: 'application/json', body: JSON.stringify({ message: t, error: t, errorMessage: t }) }),
  'liste JSON': (t) => ({ type: 'application/json', body: JSON.stringify([{ errorMessage: t, message: t }]) }),
  texte: (t) => ({ type: 'text/plain', body: t }),
  HTML: (t) => ({ type: 'text/html', body: `<html><title>${t}</title></html>` })
};

// Réponse d’erreur recalculée à chaque requête : le cookie de session, par exemple, n’existe qu’après la connexion.
const broken = (s, status, make) => ({
  status,
  get headers() {
    return { 'Content-Type': make('').type, Location: `${s.mocks.radarr.url}/login?apikey=${SECRET.radarr}` };
  },
  get body() {
    return make(leakText(s)).body;
  }
});

const spyLogs = (t) => Object.fromEntries(['error', 'warn', 'info', 'log'].map((name) => [name, t.mock.method(console, name, () => {})]));
const allLogged = (spies) => Object.values(spies).flatMap(logged);

function assertCleanLog(s, text) {
  const needles = [...Object.values(SECRET), ...TRAPS, 'SID=', '127.0.0.1', 'localhost'];
  for (const m of Object.values(s.mocks)) needles.push(m.url, `:${m.port}`);
  for (const n of needles) assert.ok(!text.includes(n), `fuite de « ${n} » dans le journal : ${text}`);
}

// Une réponse est un objet JSON ordinaire : rien qui ne passe pas tel quel dans le pont vers la page.
const assertPlain = (r) => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), r);
  return r;
};

test('services en défaut : aucune réponse ni aucun journal ne contient d’adresse, de clé, d’identifiant ni de cookie', async (t) => {
  const spies = spyLogs(t);
  await withSetup(async (s) => {
    // Le piège est armé : ce que les services renvoient contient bien tous les secrets.
    s.mocks.radarr.force['*'] = broken(s, 500, BODIES.texte);
    const bait = await (await fetch(`${s.mocks.radarr.url}/api/v3/rootfolder`, { headers: { 'X-Api-Key': SECRET.radarr } })).text();
    for (const n of [SECRET.qbUser, SECRET.qbPass, SECRET.radarr, SECRET.lidarr, s.mocks.qb.url, ...TRAPS]) assert.ok(bait.includes(n), n);

    let turn = 0;
    for (const status of STATUSES) {
      for (const make of Object.values(BODIES)) {
        for (const m of Object.values(s.mocks)) m.force['*'] = broken(s, status, make);
        const user = turn++ % 2 ? BOSS : ALICE;
        for (const msg of [...READS, upMsg(), ...SENDS]) assertPlain(await s.call(msg, user));
      }
    }
    assert.ok(s.responses.filter((r) => !r.ok).length > 150);
    assert.ok(s.responses.every((r) => r.error !== INTERNAL));
    s.sweep(...TRAPS);
    assert.equal(spies.error.mock.callCount(), 0);
    assert.equal(spies.warn.mock.callCount(), 0);
    assertCleanLog(s, allLogged(spies).join('\n'));
  });
});

test('Arr en défaut, qBittorrent sain : le torrent part quand même, arrError et journaux sans aucune fuite', async (t) => {
  const spies = spyLogs(t);
  await withSetup(async (s) => {
    t.mock.method(s.users, 'setPrefs', async () => {
      throw new Error(leakText(s));
    });
    let turn = 0;
    for (const status of STATUSES) {
      for (const make of Object.values(BODIES)) {
        for (const svc of ['radarr', 'sonarr', 'lidarr']) s.mocks[svc].force['*'] = broken(s, status, make);
        const user = turn++ % 2 ? BOSS : ALICE;
        for (const msg of SENDS) {
          const r = assertPlain(await s.call(msg, user));
          assert.equal(r.ok, true, JSON.stringify(r));
          assert.equal(r.hash, HASH);
          assert.equal(r.arrResult, null);
          assert.ok(typeof r.arrError === 'string' && r.arrError, JSON.stringify(r));
        }
        for (const msg of READS.filter((m) => m.type === 'pageStatus' || m.type === 'arrMeta')) assertPlain(await s.call(msg, user));
      }
    }
    assert.equal(s.mocks.qb.adds.length, STATUSES.length * Object.keys(BODIES).length * SENDS.length);
    assert.ok(s.responses.every((r) => r.error !== INTERNAL));
    s.sweep(...TRAPS);
    assert.equal(spies.error.mock.callCount(), 0);
    assert.ok(spies.warn.mock.callCount() >= SENDS.length, 'le journal de mise en garde doit servir de preuve');
    assertCleanLog(s, allLogged(spies).join('\n'));
  });
});

test('qBittorrent refuse l’ajout : un secret coupé par la limite de longueur n’apparaît jamais en fragment', async () => {
  await withSetup(async (s) => {
    const qb = s.mocks.qb;
    assert.equal((await s.call({ type: 'listTorrents' })).ok, true);
    const cookie = [...s.proxy.qb.sessions.values()].map((x) => x.cookie).find(Boolean);
    assert.ok(cookie);
    const secrets = [SECRET.qbPass, SECRET.qbUser, SECRET.radarr, qb.url, `127.0.0.1:${qb.port}`, cookie];
    for (const secret of secrets) {
      for (let offset = 70; offset <= 100; offset += 2) {
        qb.addReply = { status: 500, body: `${'x'.repeat(offset)}${secret} fin` };
        const r = await s.call(upMsg());
        assert.equal(r.ok, false);
        assert.ok(r.error.startsWith('qBittorrent a refusé le torrent (HTTP 500 : x'), r.error);
        for (let k = 4; k <= secret.length; k++) assert.ok(!r.error.includes(secret.slice(0, k)), `fragment « ${secret.slice(0, k)} » dans : ${r.error}`);
      }
    }
    assert.equal(qb.adds.length, secrets.length * 16);
    assert.equal(s.users.find('alice').prefs.lastCategory, undefined);
  });
});

test('clé API enregistrée avec des retours à la ligne ou un NUL : aucune requête, erreur sans fuite, le torrent part', async () => {
  await withSetup(async (s) => {
    for (const key of [`${SECRET.radarr}\r\nX-Injected: 1`, `${SECRET.radarr}\nX-Injected: 1`, `${SECRET.radarr}\u0000`]) {
      s.cfgStore.data.connections.radarr.apiKey = key;
      for (const user of [ALICE, BOSS]) {
        assert.deepEqual(await s.call({ type: 'arrMeta', service: 'radarr' }, user), { ok: false, error: 'Requête invalide.' });
        assert.deepEqual(await s.call(upMsg({ media: MOVIE }), user), { ok: true, hash: HASH, arrResult: null, arrError: 'Radarr : film introuvable' });
      }
      assert.equal(s.mocks.radarr.reqs.length, 0);
    }
    assert.equal(s.mocks.qb.adds.length, 6);
  });
});

// ---------- K (suite). fuzzing de handle : tout ce qui sort est attendu ----------

// Les seules requêtes qu’un service puisse recevoir du moteur.
const ALLOWED = {
  qb: /^\/api\/v2\/(auth\/login|torrents\/(categories|info|add|stop|start|pause|resume)|transfer\/info)$/,
  radarr: /^\/api\/v3\/(movie(\/lookup\/(tmdb|imdb))?|rootfolder|qualityprofile)$/,
  sonarr: /^\/api\/v3\/(series(\/lookup)?|rootfolder|qualityprofile)$/,
  lidarr: /^\/api\/v1\/(artist(\/lookup)?|album(\/lookup)?|rootfolder|qualityprofile|metadataprofile)$/
};
const WRITE_PATHS = /^\/api\/(v2\/(auth\/login|torrents\/(add|stop|start|pause|resume))|v[13]\/(movie|series|artist|album))$/;
const HEX_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function assertOutbound(s) {
  for (const [svc, m] of Object.entries(s.mocks)) {
    const roots = (m.roots || []).map((x) => x.path);
    for (const r of m.reqs) {
      const what = `${svc} ${r.method} ${r.url}`;
      const u = new URL(r.url, 'http://x');
      assert.match(r.url, /^\/[\w/.-]*(?:\?[\w.~!*'()%=&+-]*)?$/, what);
      assert.doesNotMatch(r.url.split('?')[0], /\.\.|\/\//, what);
      assert.match(u.pathname, ALLOWED[svc], what);
      assert.ok(r.method === 'GET' || r.method === 'POST', what);
      if (r.method === 'POST') assert.match(u.pathname, WRITE_PATHS, what);
      else assert.doesNotMatch(u.pathname, /auth\/login|torrents\/(add|stop|start|pause|resume)$/, what);
      for (const hashes of u.searchParams.getAll('hashes')) for (const one of hashes.split('|')) assert.match(one, HEX_HASH, what);
      if (svc === 'qb' && /torrents\/(stop|start|pause|resume)$/.test(u.pathname)) {
        const wanted = new URLSearchParams(r.body.toString()).get('hashes') || '';
        for (const one of wanted.split('|')) assert.match(one, HEX_HASH, what);
      }
      if (svc !== 'qb' && r.method === 'POST') {
        const body = JSON.parse(r.body.toString());
        assert.equal(body.monitored, false, what);
        assert.equal(policy.hasSearchFlag(body), false, what);
        if (body.rootFolderPath !== undefined) assert.ok(roots.includes(body.rootFolderPath), what);
      }
      if (svc === 'qb' && u.pathname.endsWith('/torrents/add')) {
        const { parts } = parseMultipart(r);
        assert.ok(parts.torrents.value.equals(TORRENT), what);
        assert.match(parts.torrents.filename, /^[^\\/"\u0000-\u001f]{1,255}$/, what);
        if (parts.category) assert.ok(Object.hasOwn(m.cats, parts.category.value.toString()), what);
      }
    }
  }
}

test('fuzzing déterministe de handle : jamais de rejet, seulement des requêtes attendues, rien d’écrit sans interaction', async () => {
  const rand = prng(20260607);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const STRINGS = [
    '', 'a', 'Films', 'Séries', 'Musique', '../../etc/passwd', '..%2f..%2f', '%2e%2e/', 'tt0133093', 'tt1', '603', '-1', '1e9', ' 603', '0x10',
    'a'.repeat(400), 'x\r\nHost: evil', 'x\u0000y', '\u202e', '/command', 'a/b', 'a?b=c&d=e', 'http://evil.example/', HASH_A, HASH_A.toUpperCase(),
    'g'.repeat(40), MB.group, 'movie', 'tv', 'anime', 'artist', '/movies', '/tv', '!!!!', 'constructor', '__proto__', 'toString'
  ];
  const NUMBERS = [0, 1, -1, 603, 81189, 1.5, 2 ** 53, Number.MAX_SAFE_INTEGER, 1e21, NaN, Infinity];
  const KEYS = [
    'type', 'hash', 'pause', 'service', 'media', 'ids', 'imdb', 'tmdb', 'tvdb', 'tmdbKind', 'mbReleaseGroup', 'mbRelease', 'mbArtist', 'title', 'artist',
    'album', 'seasons', 'lmode', 'seriesType', 'rootFolder', 'year', 'category', 'filename', 'paused', 'base64', '__proto__', 'constructor'
  ];
  // Une propriété « __proto__ » propre, comme celle que crée JSON.parse.
  const set = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, configurable: true, writable: true });
  const scalar = () => pick([() => pick(STRINGS), () => pick(NUMBERS), () => true, () => false, () => null])();
  const value = (depth = 0) => {
    const r = rand();
    if (depth < 3 && r < 0.2) return Array.from({ length: Math.floor(rand() * 4) }, () => value(depth + 1));
    if (depth < 3 && r < 0.4) {
      const o = {};
      for (let i = Math.floor(rand() * 4); i > 0; i--) set(o, pick(KEYS), value(depth + 1));
      return o;
    }
    return scalar();
  };
  const BASES = [
    { type: 'getCategories' },
    { type: 'listTorrents' },
    { type: 'qbitIndex' },
    { type: 'pageStatus', hash: HASH_A, media: MOVIE },
    { type: 'pageStatus', hash: HASH_A, media: SERIES },
    { type: 'pageStatus', hash: HASH_A, media: MUSIC },
    { type: 'arrMeta', service: 'lidarr' },
    { type: 'toggleTorrent', hash: HASH_A, pause: false },
    ...SENDS
  ];
  const mutate = (msg) => {
    const targets = [msg, msg.media, msg.media && msg.media.ids].filter((o) => o && typeof o === 'object');
    for (let n = 1 + Math.floor(rand() * 3); n > 0; n--) {
      const target = pick(targets);
      const key = pick(KEYS);
      if (rand() < 0.15) delete target[key];
      else set(target, key, value());
    }
    return msg;
  };

  await withSetup(async (s) => {
    let refused = 0;
    for (let i = 0; i < 250; i++) {
      // Comme sur le réseau : le message passe par JSON.
      const wire = JSON.parse(JSON.stringify(mutate(structuredClone(pick(BASES)))));
      const text = JSON.stringify(wire).slice(0, 400);
      const user = pick([ALICE, BOSS]);
      const interaction = rand() < 0.85;
      const before = s.total();
      const r = assertPlain(await s.as(user, wire, interaction ? { recentInput: true } : {}));
      assert.equal(typeof r.ok, 'boolean', text);
      if (!interaction && (wire.type === 'upload' || wire.type === 'toggleTorrent')) {
        assert.deepEqual(r, { ok: false, error: NO_INPUT }, text);
        assert.equal(s.total(), before, text);
        refused++;
      }
    }
    assert.ok(refused >= 3, `${refused} refus faute d’interaction`);
    assert.ok(s.responses.filter((r) => r.ok).length >= 40 && s.responses.filter((r) => !r.ok).length >= 40);
    assert.ok(s.total() > 150, `${s.total()} requêtes`);
    assertOutbound(s);
    assertNoSearch(s);
  });
});

// ---------- L. prototypes ----------

test('messages hostiles : aucun prototype natif n’est modifié (dernier test du fichier)', async () => {
  await withSetup(async (s) => {
    const polluter = '{"polluted":"oui","isAdmin":true,"type":"getCategories"}';
    const wire = [
      `{"type":"upload","base64":"${b64(TORRENT)}","filename":"a.torrent","category":"Films","paused":false,"__proto__":${polluter},"media":{"type":"movie","ids":{"tmdb":603,"__proto__":${polluter}},"constructor":{"prototype":${polluter}}}}`,
      `{"type":"pageStatus","hash":"${HASH_A}","media":{"type":"series","ids":{"tvdb":81189,"constructor":{"prototype":${polluter}}},"seasons":[1,2],"__proto__":${polluter}}}`,
      `{"type":"arrMeta","service":"radarr","__proto__":{"service":"sonarr"}}`,
      `{"type":"toggleTorrent","hash":"${HASH_A}","pause":true,"constructor":{"prototype":${polluter}}}`,
      `{"__proto__":${polluter}}`,
      `{"constructor":{"prototype":${polluter}},"type":"constructor"}`,
      '{"type":"__proto__"}',
      '{"type":"hasOwnProperty"}',
      '{"type":"toString"}'
    ].map((text) => JSON.parse(text));
    const answers = [];
    for (const msg of wire) answers.push(assertPlain(await s.call(msg)));
    assert.equal(answers[0].ok, true);
    assert.equal(answers[1].ok, true);
    assert.equal(answers[2].ok, true);
    assert.deepEqual(answers[3], { ok: true });
    assert.deepEqual(answers.slice(4), [UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN]);
    assert.deepEqual(answers[2], { ok: true, profiles: [{ id: 4, name: 'HD' }, { id: 5, name: 'Any' }], roots: ['/movies', '/films'] });
    assert.equal(s.mocks.radarr.reqs.filter((r) => r.url.startsWith('/api/v3/rootfolder')).length, 2);
    assert.deepEqual(lines(s.mocks.sonarr), ['GET /api/v3/series?tvdbId=81189']);
  });
  assert.deepEqual(prototypeKeys(), PROTOTYPES_AT_LOAD);
  for (const name of PROTOTYPES) {
    assert.equal(globalThis[name].prototype.polluted, undefined, name);
    assert.equal(globalThis[name].prototype.isAdmin, undefined, name);
  }
  assert.equal({}.polluted, undefined);
  assert.equal([].isAdmin, undefined);
});
