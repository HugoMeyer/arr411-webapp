'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const zlib = require('node:zlib');
const h = require('./helpers');

h.prepareEnv({ SESSION_SECRET: 'secret-de-test-assez-long-123456' });

const config = require('../server/config');
const { USER_COMMANDS } = require('../server/policy');

const QB = '/api/svc/qb/api/v2/';
const RADARR = '/api/svc/radarr/api/v3/';
const SONARR = '/api/svc/sonarr/api/v3/';
const LIDARR = '/api/svc/lidarr/api/v1/';
const TAB_A = { 'X-Arr411-Client': 'tab-AAAAAAAA' };
const TAB_B = { 'X-Arr411-Client': 'tab-BBBBBBBB' };
const ARR = [
  ['radarr', RADARR, 'movie'],
  ['sonarr', SONARR, 'series'],
  ['lidarr', LIDARR, 'artist']
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, what, ms = 4000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) assert.fail(`délai dépassé : ${what}`);
    await sleep(25);
  }
}

// Une appli neuve, quatre faux services, un administrateur (boss) et un utilisateur (alice) connectés.
async function setup({ configure = true } = {}) {
  const app = await h.startApp();
  const mocks = {
    qb: await h.qbMock(),
    radarr: await h.arrMock({ key: 'radarr-key', prefix: '/api/v3', root: 'movie' }),
    sonarr: await h.arrMock({ key: 'sonarr-key', prefix: '/api/v3', root: 'series' }),
    lidarr: await h.arrMock({ key: 'lidarr-key', prefix: '/api/v1', root: 'artist' })
  };
  const admin = await h.adminClient(app);
  if (configure) {
    const bodies = {
      qb: { url: mocks.qb.url, username: 'qbuser', password: 'qbpass' },
      radarr: { url: mocks.radarr.url, apiKey: 'radarr-key' },
      sonarr: { url: mocks.sonarr.url, apiKey: 'sonarr-key' },
      lidarr: { url: mocks.lidarr.url, apiKey: 'lidarr-key' }
    };
    for (const [svc, body] of Object.entries(bodies)) {
      const r = await admin.put(`/api/admin/connections/${svc}`, body);
      assert.equal(r.status, 200, `${svc} : ${r.text}`);
    }
  }
  const user = await h.clientFor(app, 'alice', 'alice-password-1');
  let appClosed = false;
  const closeApp = async () => {
    if (appClosed) return;
    appClosed = true;
    await app.close();
  };
  const close = async () => {
    await closeApp();
    await Promise.all(Object.values(mocks).map((m) => m.close()));
  };
  return { app, mocks, admin, user, closeApp, close };
}

async function withSetup(fn, opts) {
  const s = await setup(opts);
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

const total = (mocks) => Object.values(mocks).reduce((n, m) => n + m.reqs.length, 0);

// Erreur produite par le serveur lui-même (et non relayée depuis un service).
function assertServerError(res, status, code) {
  assert.equal(res.status, status, res.text);
  assert.equal(res.headers['x-arr411-error'], code, `X-Arr411-Error : ${res.headers['x-arr411-error']} (${res.text})`);
  assert.equal(res.json.code, code);
  assert.ok(res.json.message);
}

// Réponse relayée depuis le service : jamais marquée comme une erreur du serveur (l’interface s’en sert pour distinguer).
function assertFromService(res, status) {
  assert.equal(res.status, status, res.text);
  assert.equal(res.headers['x-arr411-error'], undefined, `réponse du service marquée comme erreur du serveur : ${res.text}`);
}

// Requête brute sur une socket : pour les cas que le client HTTP de Node refuse d’écrire (corps « chunked » trop gros).
function rawSocket(port, text) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let out = '';
    socket.setEncoding('utf8');
    socket.on('data', (d) => (out += d));
    socket.on('error', () => {});
    socket.on('close', () => resolve(out));
    socket.setTimeout(5000, () => socket.destroy());
    socket.write(text);
  });
}

test('services non configurés : 503 explicite, sans aucun trafic vers l’extérieur', () =>
  withSetup(
    async ({ admin, user, mocks }) => {
      const probes = [
        [QB, 'torrents/info'],
        [RADARR, 'movie'],
        [SONARR, 'series'],
        [LIDARR, 'artist']
      ];
      for (const [base, p] of probes) {
        const a = await admin.get(base + p);
        assertServerError(a, 503, 'unconfigured');
        assert.match(a.json.message, /Réglages/);
        const u = await user.get(base + p);
        assertServerError(u, 503, 'unconfigured');
        assert.match(u.json.message, /administrateur/);
      }
      assertServerError(await admin.post(QB + 'auth/login', {}), 503, 'unconfigured');
      assert.equal(total(mocks), 0);
    },
    { configure: false }
  ));

test('qBittorrent : la connexion se fait côté serveur, le navigateur ne voit jamais les identifiants ni le cookie SID', () =>
  withSetup(async ({ admin, user, mocks }) => {
    const qb = mocks.qb;

    // « connexion » du navigateur : 204, la vraie connexion utilise les identifiants enregistrés
    let r = await admin.send('POST', QB + 'auth/login', { form: { username: 'x', password: 'y' }, headers: TAB_A });
    assert.equal(r.status, 204);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.body.length, 0);
    assert.deepEqual(r.setCookie, [], 'le cookie SID ne doit pas atteindre le navigateur');
    assert.equal(qb.logins(), 1);
    const login = qb.seen('/api/v2/auth/login')[0];
    assert.equal(login.body.toString(), 'username=qbuser&password=qbpass');
    assert.equal(login.headers.origin, qb.origin);
    assert.equal(login.headers.referer, qb.origin + '/');
    assert.equal(login.headers.cookie, undefined);

    // rien de plus si la session est déjà ouverte, quelle que soit la casse
    r = await admin.send('POST', QB + 'AUTH/Login', { headers: TAB_A });
    assert.equal(r.status, 204);
    assert.equal(qb.logins(), 1);
    for (const [method, p] of [['GET', 'auth/login'], ['GET', 'auth/logout'], ['PUT', 'auth/login'], ['DELETE', 'auth/logout']]) {
      assert.equal((await admin.send(method, QB + p, { headers: TAB_A })).status, 405, `${method} ${p}`);
    }

    // se déconnecter de l’interface ne ferme pas la session partagée chez qBittorrent
    r = await admin.send('POST', QB + 'auth/logout', { headers: TAB_A });
    assert.equal(r.status, 204);
    assert.equal(qb.seen('/api/v2/auth/logout').length, 0);

    // en-têtes hostiles du navigateur : rien d’autre que le strict nécessaire n’est transmis
    const hostile = {
      ...TAB_A,
      'X-Api-Key': 'pirate',
      Authorization: 'Bearer pirate',
      Cookie: `${admin.cookie}; SID=pirate`,
      Accept: 'application/json',
      'Accept-Language': 'fr-FR'
    };
    r = await admin.get(QB + 'torrents/info?filter=all&hashes=abc%7Cdef', { headers: hostile });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, [{ hash: 'abc', name: 'Film.2024.1080p' }]);
    assert.equal(r.headers['cache-control'], 'no-store');
    const seen = qb.reqs.at(-1);
    assert.equal(seen.url, '/api/v2/torrents/info?filter=all&hashes=abc%7Cdef');
    assert.match(seen.headers.cookie, /^SID=sid\d+$/);
    assert.equal(seen.headers.origin, qb.origin);
    assert.equal(seen.headers.referer, qb.origin + '/');
    assert.equal(seen.headers.accept, 'application/json');
    assert.equal(seen.headers['accept-language'], 'fr-FR');
    assert.match(seen.headers['user-agent'], /Arr411-Web/);
    for (const k of ['x-api-key', 'authorization', 'x-arr411-client', 'x-requested-with', 'x-forwarded-for']) assert.equal(seen.headers[k], undefined, k);
    assert.ok(!/pirate|arr_session/.test(JSON.stringify(seen.headers)), JSON.stringify(seen.headers));
    assert.equal(qb.logins(), 1);

    // une session qBittorrent par onglet et par utilisateur ; un identifiant d’onglet invalide retombe sur « default »
    const cookieOf = async (who, headers) => {
      const res = await who.get(QB + 'torrents/info', { headers });
      assert.equal(res.status, 200);
      return qb.reqs.at(-1).headers.cookie;
    };
    const c1 = seen.headers.cookie;
    assert.equal(await cookieOf(admin, TAB_A), c1);
    const c2 = await cookieOf(admin, TAB_B);
    const c3 = await cookieOf(admin, {});
    assert.equal(await cookieOf(admin, { 'X-Arr411-Client': 'bad id!' }), c3);
    assert.equal(await cookieOf(admin, { 'X-Arr411-Client': 'x' }), c3);
    assert.equal(await cookieOf(admin, TAB_A), c1);
    const c4 = await cookieOf(user, TAB_A);
    assert.equal(new Set([c1, c2, c3, c4]).size, 4);
    assert.equal(qb.logins(), 4);

    // un onglet neuf qui envoie 30 requêtes d’un coup ne provoque qu’une seule connexion
    const flood = await Promise.all(Array.from({ length: 30 }, () => admin.get(QB + 'torrents/info', { headers: { 'X-Arr411-Client': 'tab-FLOODING' } })));
    assert.ok(flood.every((x) => x.status === 200));
    assert.equal(qb.logins(), 5);
  }));

test('qBittorrent : session expirée → une seule reconnexion, la requête est rejouée à l’identique', () =>
  withSetup(async ({ admin, mocks }) => {
    const qb = mocks.qb;
    assert.equal((await admin.get(QB + 'torrents/info')).status, 200);
    assert.equal(qb.logins(), 1);

    // qBittorrent a oublié la session (redémarrage, expiration) ; envoi d’un .torrent binaire avec ses octets exacts
    qb.state.sessions.clear();
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const { body, contentType } = h.multipart([
      { name: 'urls', value: 'magnet:?xt=urn:btih:abc' },
      { name: 'torrents', filename: 'film 2024.torrent', type: 'application/x-bittorrent', value: bytes },
      { name: 'category', value: 'films' }
    ]);
    const before = qb.reqs.length;
    let r = await admin.send('POST', QB + 'torrents/add', { body, headers: { 'Content-Type': contentType } });
    assert.equal(r.status, 200);
    assert.equal(r.text, 'Ok.');
    const sent = qb.reqs.slice(before);
    assert.deepEqual(
      sent.map((x) => `${x.method} ${x.url}`),
      ['POST /api/v2/torrents/add', 'POST /api/v2/auth/login', 'POST /api/v2/torrents/add']
    );
    for (const x of [sent[0], sent[2]]) {
      assert.ok(x.body.equals(body), 'corps modifié');
      assert.equal(x.headers['content-type'], contentType);
      assert.equal(x.headers['x-requested-with'], undefined);
    }
    assert.notEqual(sent[0].headers.cookie, sent[2].headers.cookie);
    assert.equal(qb.logins(), 2);

    // une rafale sur une session expirée : une seule reconnexion pour tout le monde
    qb.state.sessions.clear();
    const burst = await Promise.all(Array.from({ length: 6 }, () => admin.get(QB + 'torrents/info')));
    assert.deepEqual(burst.map((x) => x.status), [200, 200, 200, 200, 200, 200]);
    assert.equal(qb.logins(), 3);

    // un gros fichier .torrent (5 Mo) passe tel quel
    const big = h.multipart([{ name: 'torrents', filename: 'gros.torrent', value: crypto.randomBytes(5 * 1024 * 1024) }]);
    r = await admin.send('POST', QB + 'torrents/add', { body: big.body, headers: { 'Content-Type': big.contentType } });
    assert.equal(r.status, 200);
    assert.ok(qb.reqs.at(-1).body.equals(big.body));
  }));

test('qBittorrent : identifiants refusés → 401 « qb-credentials », aucune rafale de connexions, reprise après correction', () =>
  withSetup(async ({ admin, user, mocks }) => {
    const qb = mocks.qb;
    qb.state.pass = 'mot-de-passe-change';
    assertServerError(await admin.get(QB + 'torrents/info'), 401, 'qb-credentials');
    assert.equal(qb.logins(), 1);

    // tous les comptes, tous les onglets : le verrou évite de faire bannir le serveur par qBittorrent
    const attempts = await Promise.all([
      admin.get(QB + 'torrents/info'),
      admin.get(QB + 'sync/maindata', { headers: TAB_A }),
      user.get(QB + 'torrents/info', { headers: TAB_B }),
      user.post(QB + 'auth/login', {})
    ]);
    for (const r of attempts) assertServerError(r, 401, 'qb-credentials');
    assert.equal(qb.logins(), 1);

    // l’administrateur corrige les identifiants : le verrou saute
    const fix = await admin.put('/api/admin/connections/qb', { url: qb.url, username: 'qbuser', password: 'mot-de-passe-change' });
    assert.equal(fix.status, 200, fix.text);
    assert.equal((await admin.get(QB + 'torrents/info')).status, 200);
    assert.equal((await user.get(QB + 'torrents/info')).status, 200);
    assert.equal(qb.logins(), 3);

    // même chose quand qBittorrent répond 401 plutôt que « Fails. »
    qb.state.mode = '401';
    qb.state.pass = 'encore-un-autre';
    qb.state.sessions.clear();
    assertServerError(await admin.get(QB + 'torrents/info'), 401, 'qb-credentials');
    assert.equal(qb.logins(), 4);
    assertServerError(await user.get(QB + 'torrents/info'), 401, 'qb-credentials');
    assert.equal(qb.logins(), 4);
  }));

test('qBittorrent : adresse bannie → 403 « qb-banned », sans nouvel essai, levée par un nouvel enregistrement', () =>
  withSetup(async ({ admin, user, mocks }) => {
    const qb = mocks.qb;
    qb.state.mode = 'banned';
    const first = await admin.get(QB + 'torrents/info');
    assertServerError(first, 403, 'qb-banned');
    assert.match(first.json.message, /banni/);
    assertServerError(await user.get(QB + 'torrents/info'), 403, 'qb-banned');
    assertServerError(await admin.post(QB + 'auth/login', {}), 403, 'qb-banned');
    assert.equal(qb.logins(), 1);

    qb.state.mode = '204';
    const save = await admin.put('/api/admin/connections/qb', { url: qb.url, username: 'qbuser', password: 'qbpass' });
    assert.equal(save.status, 200, save.text);
    assert.equal((await admin.get(QB + 'torrents/info')).status, 200);
  }));

test('qBittorrent : ancien format « Ok. », redirection http → https et erreurs à la connexion', () =>
  withSetup(async ({ admin, mocks }) => {
    mocks.qb.state.mode = '200';
    assert.equal((await admin.get(QB + 'torrents/info')).status, 200);
    assert.match(mocks.qb.reqs.at(-1).headers.cookie, /^SID=/);

    const redirecting = await h.listen((req, res) => {
      res.writeHead(301, { Location: 'https://qb.example.test/' });
      res.end();
    });
    const broken = await h.listen((req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('boom');
    });
    try {
      let r = await admin.put('/api/admin/connections/qb', { url: redirecting.url, username: 'qbuser', password: 'qbpass' });
      assert.equal(r.status, 200, r.text);
      r = await admin.get(QB + 'torrents/info');
      assertServerError(r, 502, 'upstream');
      assert.match(r.json.message, /redirection/);
      assert.equal(r.headers.location, undefined);

      r = await admin.put('/api/admin/connections/qb', { url: broken.url, username: 'qbuser', password: 'qbpass' });
      assert.equal(r.status, 200, r.text);
      r = await admin.get(QB + 'torrents/info');
      assertServerError(r, 502, 'upstream');
      assert.match(r.json.message, /HTTP 500/);
    } finally {
      await redirecting.close();
      await broken.close();
    }
  }));

test('qBittorrent sans identifiants (contournement d’authentification) : aucune connexion n’est tentée', () =>
  withSetup(async ({ admin, mocks }) => {
    const qb = mocks.qb;
    qb.state.noAuth = true;
    const save = await admin.put('/api/admin/connections/qb', { url: qb.url, username: '', clearPassword: true });
    assert.equal(save.status, 200, save.text);
    assert.equal((await admin.get(QB + 'torrents/info')).status, 200);
    assert.equal((await admin.post(QB + 'auth/login', {})).status, 204);
    assert.equal(qb.logins(), 0);
    assert.equal(qb.reqs.at(-1).headers.cookie, undefined);
  }));

test('qBittorrent : désactiver, réinitialiser ou supprimer un compte ferme ses sessions chez qBittorrent', () =>
  withSetup(async ({ admin, user, mocks }) => {
    const qb = mocks.qb;
    const open = async (who) => {
      for (const tab of [TAB_A, TAB_B]) assert.equal((await who.get(QB + 'torrents/info', { headers: tab })).status, 200);
    };
    await open(admin);
    await open(user);
    assert.equal(qb.state.sessions.size, 4);

    assert.equal((await admin.patch('/api/admin/users/alice', { disabled: true })).status, 200);
    await until(() => qb.state.sessions.size === 2, 'sessions de alice fermées après désactivation');
    assert.equal(qb.seen('/api/v2/auth/logout').length, 2);
    await open(admin);
    assert.equal(qb.logins(), 4, 'les sessions de l’administrateur n’ont pas bougé');

    assert.equal((await admin.patch('/api/admin/users/alice', { disabled: false })).status, 200);
    assert.equal((await user.login('alice', 'alice-password-1')).status, 200);
    await open(user);
    assert.equal(qb.state.sessions.size, 4);

    assert.equal((await admin.patch('/api/admin/users/alice', { password: 'nouveau-mot-de-passe-1' })).status, 200);
    await until(() => qb.state.sessions.size === 2, 'sessions de alice fermées après réinitialisation');

    assert.equal((await user.login('alice', 'nouveau-mot-de-passe-1')).status, 200);
    await open(user);
    assert.equal(qb.state.sessions.size, 4);
    assert.equal((await admin.del('/api/admin/users/alice')).status, 200);
    await until(() => qb.state.sessions.size === 2, 'sessions de alice fermées après suppression');
    await open(admin);
  }));

test('arrêt du serveur : les sessions ouvertes chez qBittorrent sont fermées', async () => {
  const s = await setup();
  try {
    assert.equal((await s.admin.get(QB + 'torrents/info')).status, 200);
    assert.equal((await s.user.get(QB + 'torrents/info')).status, 200);
    assert.equal(s.mocks.qb.state.sessions.size, 2);
    await s.closeApp();
    assert.equal(s.mocks.qb.state.sessions.size, 0);
  } finally {
    await s.close();
  }
});

test('Radarr / Sonarr / Lidarr : la clé API du serveur est injectée, rien du navigateur n’est transmis', () =>
  withSetup(async ({ admin, user, mocks }) => {
    const keys = { radarr: 'radarr-key', sonarr: 'sonarr-key', lidarr: 'lidarr-key' };
    for (const [svc, base, root] of ARR) {
      for (const who of [admin, user]) {
        const m = mocks[svc];
        const before = m.reqs.length;
        const r = await who.get(base + root, {
          headers: {
            'X-Api-Key': 'pirate',
            Authorization: 'Bearer pirate',
            Cookie: `${who.cookie}; autre=1`,
            'X-Forwarded-For': '6.6.6.6',
            Origin: 'http://evil.test',
            Accept: 'application/json',
            'Accept-Language': 'fr-FR',
            ...TAB_A
          }
        });
        assert.equal(r.status, 200, `${svc} : ${r.text}`);
        assert.deepEqual(r.json, [{ id: 1, title: 'Dune' }]);
        assert.equal(r.headers['cache-control'], 'no-store');
        assert.equal(m.reqs.length, before + 1);
        const seen = m.reqs.at(-1).headers;
        assert.equal(seen['x-api-key'], keys[svc]);
        for (const k of ['cookie', 'authorization', 'x-forwarded-for', 'origin', 'referer', 'x-arr411-client', 'x-requested-with']) assert.equal(seen[k], undefined, `${svc} ${k}`);
        assert.equal(seen.accept, 'application/json');
        assert.equal(seen['accept-language'], 'fr-FR');
        assert.match(seen['user-agent'], /Arr411-Web/);
        assert.ok(!/pirate|arr_session/.test(JSON.stringify(seen)), JSON.stringify(seen));
      }
    }
  }));

test('réponses des services : statuts et corps relayés, rien d’autre que le nécessaire ne revient au navigateur', () =>
  withSetup(async ({ admin, user, mocks }) => {
    const radarr = mocks.radarr;

    // POST JSON : corps et type de contenu identiques
    const movie = { title: 'Dune', monitored: false, addOptions: { monitor: 'none', searchForMovie: false }, tags: [] };
    for (const who of [admin, user]) {
      const r = await who.post(RADARR + 'movie', movie);
      assertFromService(r, 201);
      assert.deepEqual(r.json, { id: 99, echo: movie });
    }
    const posted = radarr.reqs.at(-1);
    assert.equal(posted.headers['content-type'], 'application/json');
    assert.equal(posted.body.toString(), JSON.stringify(movie));
    assert.equal(Number(posted.headers['content-length']), Buffer.byteLength(JSON.stringify(movie)));

    // erreur 400 du service : relayée telle quelle
    let r = await admin.get(RADARR + 'bad');
    assertFromService(r, 400);
    assert.deepEqual(r.json, [{ errorMessage: 'Titre invalide' }]);

    // cookies, défis d’authentification et bannières du service : jamais relayés ; le nom de fichier d’un export l’est
    r = await admin.get(RADARR + 'leak');
    assertFromService(r, 200);
    for (const k of ['set-cookie', 'www-authenticate', 'x-powered-by', 'server']) assert.equal(r.headers[k], undefined, k);
    assert.deepEqual(r.setCookie, []);
    assert.equal(r.headers['content-disposition'], 'attachment; filename="export.json"');
    assert.match(r.headers['content-type'], /^application\/json/);
    assertServerError(await user.get(RADARR + 'leak'), 403, 'forbidden');

    // redirection : jamais suivie, jamais relayée, expliquée
    r = await admin.get(RADARR + 'redirect');
    assertServerError(r, 502, 'upstream');
    assert.match(r.json.message, /redirection \(HTTP 302 vers \/login\)/);
    assert.equal(r.headers.location, undefined);
    r = await admin.get(QB + 'app/redirect');
    assertServerError(r, 502, 'upstream');
    assert.equal(r.headers.location, undefined);

    // clé refusée par le service : relayée sans passer pour une session expirée
    const save = await admin.put('/api/admin/connections/radarr', { url: radarr.url, apiKey: 'mauvaise-cle' });
    assert.equal(save.status, 200, save.text);
    r = await user.get(RADARR + 'movie');
    assertFromService(r, 401);
    assert.deepEqual(r.json, { message: 'Unauthorized' });
  }));

test('compression : gzip seulement si le navigateur l’accepte et si le service n’a pas déjà compressé', () =>
  withSetup(async ({ admin }) => {
    const gz = await admin.get(RADARR + 'movie', { headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
    assert.equal(gz.status, 200);
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.match(gz.headers.vary || '', /Accept-Encoding/);
    assert.deepEqual(JSON.parse(h.gunzip(gz.body)), [{ id: 1, title: 'Dune' }]);

    for (const headers of [{}, { 'Accept-Encoding': 'identity' }]) {
      const plain = await admin.get(RADARR + 'movie', { headers });
      assert.equal(plain.status, 200);
      assert.equal(plain.headers['content-encoding'], undefined);
      assert.deepEqual(plain.json, [{ id: 1, title: 'Dune' }]);
      if (plain.headers['content-length']) assert.equal(Number(plain.headers['content-length']), plain.body.length);
    }

    // déjà compressé par le service : transmis sans seconde compression
    const pre = await h.listen((req, res) => {
      const body = zlib.gzipSync(JSON.stringify([{ id: 7, title: 'x'.repeat(3000) }]));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': body.length });
      res.end(body);
    });
    try {
      const save = await admin.put('/api/admin/connections/sonarr', { url: pre.url, apiKey: 'k' });
      assert.equal(save.status, 200, save.text);
      const r = await admin.get(SONARR + 'series', { headers: { 'Accept-Encoding': 'gzip' } });
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-encoding'], 'gzip');
      assert.equal(JSON.parse(h.gunzip(r.body))[0].id, 7);
      assert.equal(pre.reqs.at(-1).headers['accept-encoding'], 'gzip');
    } finally {
      await pre.close();
    }
  }));

test('services injoignables : 502 « network » avec un message exploitable', () =>
  withSetup(async ({ admin, user }) => {
    const dead = await h.listen(() => {});
    const deadUrl = dead.url;
    await dead.close();
    const reset = await h.listen((req) => req.socket.destroy());
    const silent = await h.listen(() => {});
    const savedIdle = config.upstreamIdleMs;
    config.upstreamIdleMs = 300;
    try {
      const cases = [
        ['sonarr', { url: deadUrl, apiKey: 'k' }, SONARR + 'series', /connexion refusée/],
        ['radarr', { url: reset.url, apiKey: 'k' }, RADARR + 'movie', /connexion interrompue/],
        ['lidarr', { url: silent.url, apiKey: 'k' }, LIDARR + 'artist', /délai dépassé/],
        ['radarr', { url: deadUrl, apiKey: 'k' }, RADARR + 'mediacover/9/poster.jpg', /connexion refusée/],
        ['qb', { url: deadUrl, username: 'qbuser', password: 'qbpass' }, QB + 'torrents/info', /connexion refusée/],
        ['qb', { url: reset.url, username: 'qbuser', password: 'qbpass' }, QB + 'torrents/info', /connexion interrompue/],
        ['qb', { url: silent.url, username: 'qbuser', password: 'qbpass' }, QB + 'torrents/info', /délai dépassé/]
      ];
      for (const [svc, body, url, re] of cases) {
        const save = await admin.put(`/api/admin/connections/${svc}`, body);
        assert.equal(save.status, 200, save.text);
        const r = await admin.get(url);
        assertServerError(r, 502, 'network');
        assert.match(r.json.message, /^Réseau : /);
        assert.match(r.json.message, re, `${svc} ${url}`);
        if (/refus/.test(re.source)) assert.match(r.json.message, / \(127\.0\.0\.1:\d+\)$/, 'l’administrateur voit l’adresse du service');

        // un utilisateur ordinaire voit la même cause, sans l’adresse interne
        const u = await user.get(url);
        assertServerError(u, 502, 'network');
        assert.equal(u.json.message, r.json.message.replace(/ \(127\.0\.0\.1:\d+\)$/, ''), `${svc} ${url} (utilisateur)`);
        assert.doesNotMatch(u.json.message, /127\.0\.0\.1|\d{3,}/, `adresse interne exposée : ${u.json.message}`);
      }
    } finally {
      config.upstreamIdleMs = savedIdle;
      await Promise.all([reset.close(), silent.close()]);
    }
  }));

test('redirection du service : la destination n’est détaillée qu’aux administrateurs', () =>
  withSetup(async ({ admin, user }) => {
    const redirecting = await h.listen((req, res) => {
      res.writeHead(302, { Location: '/login?ReturnUrl=%2Fapi%2Fv3%2Fmovie' });
      res.end();
    });
    try {
      const save = await admin.put('/api/admin/connections/radarr', { url: redirecting.url, apiKey: 'k' });
      assert.equal(save.status, 200, save.text);
      const a = await admin.get(RADARR + 'movie');
      assertServerError(a, 502, 'upstream');
      assert.match(a.json.message, /redirection \(HTTP 302 vers \/login\)/);
      const u = await user.get(RADARR + 'movie');
      assertServerError(u, 502, 'upstream');
      assert.match(u.json.message, /redirection \(HTTP 302\)\./);
      assert.doesNotMatch(u.json.message, /login/);
      assert.equal(u.headers.location, undefined);
    } finally {
      await redirecting.close();
    }
  }));

test('envois : la taille est limitée (MAX_UPLOAD_MB), rien de trop gros n’atteint le service', () =>
  withSetup(async ({ app, admin, user, mocks }) => {
    const saved = config.maxUploadBytes;
    assert.equal(saved, 25 * 1024 * 1024, 'valeur par défaut');
    config.maxUploadBytes = 2048;
    try {
      const big = { title: 'x'.repeat(4000) };
      const small = { title: 'y'.repeat(100), monitored: false };
      for (const who of [admin, user]) {
        let r = await who.post(RADARR + 'movie', big);
        assert.equal(r.status, 413, r.text);
        assert.match(r.json.message, /volumineuse/);
        assert.ok(r.headers['x-arr411-error']);
        r = await who.post(RADARR + 'movie', small);
        assert.equal(r.status, 201, r.text);
      }
      assert.equal(mocks.radarr.seen('/api/v3/movie').length, 2, 'seules les deux petites requêtes sont parties');

      const upload = h.multipart([{ name: 'torrents', filename: 'a.torrent', value: crypto.randomBytes(5000) }]);
      const r = await admin.send('POST', QB + 'torrents/add', { body: upload.body, headers: { 'Content-Type': upload.contentType } });
      assert.equal(r.status, 413);
      assert.equal(mocks.qb.seen('/api/v2/torrents/add').length, 0);
      assert.equal(mocks.qb.logins(), 0, 'pas de connexion à qBittorrent pour un envoi refusé');

      // corps « chunked » sans Content-Length : limité de la même façon
      const chunk = (s) => `${Buffer.byteLength(s).toString(16)}\r\n${s}\r\n`;
      const head = [
        `POST ${RADARR}movie HTTP/1.1`,
        'Host: test',
        `Cookie: ${admin.cookie}`,
        'X-Requested-With: arr411',
        'Content-Type: application/json',
        'Transfer-Encoding: chunked',
        'Connection: close',
        '',
        ''
      ].join('\r\n');
      const out = await rawSocket(app.port, head + chunk('{"title":"' + 'z'.repeat(1500)) + chunk('z'.repeat(1500) + '"}') + '0\r\n\r\n');
      assert.match(out, /^HTTP\/1\.1 413 /);
      assert.equal(mocks.radarr.seen('/api/v3/movie').length, 2);

      // le serveur n’est pas resté bloqué
      assert.equal((await admin.get(RADARR + 'movie')).status, 200);
    } finally {
      config.maxUploadBytes = saved;
    }
  }));

test('affiches : cache sur disque, cache des 404, jamais de contenu qui n’est pas une image', () =>
  withSetup(async ({ app, admin, user, mocks }) => {
    const radarr = mocks.radarr;
    const path1 = '/api/v3/mediacover/1/poster.jpg';
    const cover = RADARR + 'mediacover/1/poster.jpg';

    let r = await user.get(cover);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/png');
    assert.ok(r.body.equals(h.PNG));
    assert.equal(r.headers['cache-control'], 'private, max-age=604800');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(radarr.seen(path1).length, 1);
    const asked = radarr.seen(path1)[0].headers;
    assert.equal(asked['x-api-key'], 'radarr-key');
    assert.equal(asked['accept-encoding'], 'identity');
    assert.equal(asked.accept, 'image/*');

    // autre compte, même affiche : servie depuis le disque
    r = await admin.get(cover);
    assert.ok(r.body.equals(h.PNG));
    assert.equal(radarr.seen(path1).length, 1);

    // la requête (?lastWrite=…) fait partie de la clé : une affiche modifiée est retéléchargée
    const versioned = cover + '?lastWrite=2024-05-01T10%3A00%3A00Z';
    assert.equal((await user.get(versioned)).status, 200);
    assert.equal((await user.get(versioned)).status, 200);
    assert.equal(radarr.seen(path1).length, 2);
    assert.equal(radarr.seen(path1).at(-1).url, path1 + '?lastWrite=2024-05-01T10%3A00%3A00Z');

    // un autre service avec le même chemin n’emprunte pas le cache de Radarr
    assert.equal((await user.get(SONARR + 'mediacover/1/poster.jpg')).status, 200);
    assert.equal(mocks.sonarr.seen(path1).length, 1);

    // entrée trop ancienne ou illisible : retéléchargée, puis de nouveau servie depuis le disque
    const file = app.proxy.covers.file(app.proxy.covers.key('radarr', radarr.url, path1));
    assert.ok(fs.existsSync(file), 'fichier de cache');
    const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    fs.utimesSync(file, old, old);
    assert.equal((await user.get(cover)).status, 200);
    assert.equal(radarr.seen(path1).length, 3);
    for (const junk of [Buffer.from([0x7f, 1, 2, 3]), Buffer.alloc(0)]) {
      fs.writeFileSync(file, junk);
      const before = radarr.seen(path1).length;
      r = await user.get(cover);
      assert.equal(r.status, 200);
      assert.ok(r.body.equals(h.PNG));
      assert.equal(radarr.seen(path1).length, before + 1);
      assert.ok((await user.get(cover)).body.equals(h.PNG));
      assert.equal(radarr.seen(path1).length, before + 1);
    }

    // 404 : mémorisé quelques minutes
    const missing = RADARR + 'mediacover/2/poster.jpg';
    for (let i = 0; i < 3; i++) assertServerError(await user.get(missing), 404, 'upstream');
    assert.equal(radarr.seen('/api/v3/mediacover/2/poster.jpg').length, 1);

    // pas une image : jamais servi
    r = await user.get(RADARR + 'mediacover/3/poster.jpg');
    assertServerError(r, 502, 'upstream');
    assert.ok(!r.text.includes('<html'));

    // lecture seule
    for (const method of ['POST', 'PUT', 'DELETE']) assertServerError(await user.send(method, cover, { json: {} }), 403, 'forbidden');
  }));

test('affiches : plusieurs demandes simultanées pour la même image ne font qu’une requête vers le service', () =>
  withSetup(async ({ admin, user }) => {
    const slow = await h.listen(async (req, res) => {
      await sleep(250);
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(h.PNG);
    });
    try {
      const save = await admin.put('/api/admin/connections/lidarr', { url: slow.url, apiKey: 'k' });
      assert.equal(save.status, 200, save.text);
      const url = LIDARR + 'mediacover/artist/1/poster.jpg';
      const answers = await Promise.all([admin.get(url), user.get(url), admin.get(url), user.get(url), admin.get(url)]);
      for (const r of answers) {
        assert.equal(r.status, 200);
        assert.ok(r.body.equals(h.PNG));
      }
      assert.equal(slow.reqs.length, 1);
    } finally {
      await slow.close();
    }
  }));

test('rôles Radarr / Sonarr / Lidarr : l’utilisateur ne voit que ce que l’interface utilise', () =>
  withSetup(async ({ admin, user, mocks }) => {
    for (const [svc, base, root] of ARR) {
      const m = mocks[svc];
      const upstreamPrefix = base.slice(`/api/svc/${svc}`.length);
      // l’utilisateur : lecture, ajout, commandes d’entretien ; le faux service répond 404 aux routes qu’il ne connaît pas
      const allowed = [
        ['GET', root, 200],
        ['GET', `${root}/lookup?term=dune%20part%20two`, 200],
        ['POST', root, 201, { title: 'Dune', monitored: false }],
        ['GET', 'system/status', 200],
        ['GET', root.toUpperCase(), 404],
        ['GET', 'queue', 404],
        ['GET', 'history', 404],
        ['GET', 'qualityprofile', 404],
        ['GET', 'rootfolder', 404],
        ['GET', 'diskspace', 404],
        ['GET', 'tag', 404],
        ['POST', 'tag', 404, { label: 'x' }],
        ['DELETE', `${root}/1`, 404]
      ];
      for (const [method, p, status, body] of allowed) {
        const r = await user.send(method, base + p, body === undefined ? {} : { json: body });
        assertFromService(r, status);
      }
      const lookups = m.seen(`${upstreamPrefix}${root}/lookup`);
      assert.equal(lookups.length, 1);
      assert.equal(lookups[0].url.split('?')[1], 'term=dune%20part%20two');

      const denied = [
        ['GET', 'config/ui'],
        ['PUT', 'config/naming', { renameMovies: true }],
        ['GET', 'CONFIG/mediamanagement'],
        ['GET', 'log'],
        ['GET', 'release?movieId=1'],
        ['POST', 'release', {}],
        ['GET', 'downloadclient'],
        ['GET', 'indexer'],
        ['GET', 'notification'],
        ['GET', 'customformat'],
        ['GET', 'importlist'],
        ['GET', 'update'],
        ['GET', 'system'],
        ['GET', 'system/status/x'],
        ['GET', 'system/backup'],
        ['POST', 'system/restart', {}],
        ['PUT', 'system/status', {}],
        ['POST', 'tag/1', {}],
        ['PUT', 'tag/1', {}],
        ['DELETE', 'tag/1'],
        ['POST', 'qualityprofile', {}],
        ['PUT', 'rootfolder', {}],
        ['DELETE', 'rootfolder/1'],
        ['', '']
      ];
      const before = m.reqs.length;
      for (const [method, p, body] of denied) {
        const r = await user.send(method || 'GET', base + p, body === undefined ? {} : { json: body });
        assertServerError(r, 403, 'forbidden');
      }
      assert.equal(m.reqs.length, before, `${svc} : rien n’a atteint le service`);

      // l’administrateur atteint le reste (sauf la racine de l’API, jamais exposée)
      for (const [method, p, body] of denied.slice(0, -1)) {
        const r = await admin.send(method, base + p, body === undefined ? {} : { json: body });
        assert.equal(r.headers['x-arr411-error'], undefined, `${svc} ${method} ${p} : ${r.text}`);
      }
      assertServerError(await admin.get(base), 403, 'forbidden');

      // les réglages d’hôte contiennent la clé d’API du service : personne ne les atteint par ici, administrateur compris
      const beforeHost = m.reqs.length;
      for (const who of [user, admin]) {
        for (const [method, p, body] of [
          ['GET', 'config/host'],
          ['GET', 'CONFIG/HOST'],
          ['GET', 'config/host/1'],
          ['PUT', 'config/host', { port: 1 }],
          ['PUT', 'config/host/1', { apiKey: 'x' }],
          ['POST', 'config/host', {}]
        ]) {
          assertServerError(await who.send(method, base + p, body === undefined ? {} : { json: body }), 403, 'forbidden');
        }
      }
      assert.equal(m.reqs.length, beforeHost, `${svc} : les réglages d’hôte n’ont pas quitté le serveur`);
    }
  }));

test('recherches automatiques : bloquées par défaut pour tout le monde ; ALLOW_SEARCH_COMMANDS ne contourne pas la liste des commandes', () =>
  withSetup(async ({ admin, user, mocks }) => {
    const searches = [
      ['POST', RADARR + 'command', { name: 'MoviesSearch', movieIds: [1] }],
      ['POST', RADARR + 'command', { name: 'MissingMoviesSearch' }],
      ['POST', RADARR + 'command', { name: 'missingmoviessearch' }],
      ['POST', RADARR + 'command', { name: 'RssSync' }],
      ['POST', SONARR + 'command', { name: 'SeriesSearch', seriesId: 1 }],
      ['POST', SONARR + 'command', { name: 'EpisodeSearch', episodeIds: [1] }],
      ['POST', LIDARR + 'command', { name: 'AlbumSearch', albumIds: [1] }],
      ['POST', LIDARR + 'command', { name: 'ArtistSearch', artistId: 1 }],
      ['POST', RADARR + 'movie', { title: 'x', addOptions: { searchForMovie: true } }],
      ['PUT', RADARR + 'movie/1', { title: 'x', addOptions: { searchForMovie: true } }],
      ['PATCH', RADARR + 'movie/1', { addOptions: { SearchForMovie: 1 } }],
      ['POST', SONARR + 'series', { title: 'x', addOptions: { searchForMissingEpisodes: true, searchForCutoffUnmetEpisodes: false } }],
      ['POST', LIDARR + 'artist', { name: 'x', addOptions: { searchForMissingAlbums: true } }],
      ['POST', RADARR + 'movie', { title: 'x', a: [{ b: { searchForMovie: 'oui' } }] }]
    ];
    for (const who of [admin, user]) {
      for (const [method, url, body] of searches) assertServerError(await who.send(method, url, { json: body }), 403, 'forbidden');
    }
    assert.equal(total(mocks), 0, 'aucune recherche ne doit atteindre un service');

    // drapeaux à false, noms de commande d’entretien : acceptés
    const fine = [
      [RADARR + 'movie', { title: 'x', monitored: false, addOptions: { monitor: 'none', searchForMovie: false } }],
      [SONARR + 'series', { title: 'x', addOptions: { monitor: 'none', searchForMissingEpisodes: false, searchForCutoffUnmetEpisodes: false } }],
      [LIDARR + 'artist', { name: 'x', addOptions: { monitor: 'none', searchForMissingAlbums: false } }],
      [RADARR + 'command', { name: 'RefreshMovie', movieIds: [1] }],
      [SONARR + 'command', { name: 'RescanSeries', seriesId: 1 }],
      [LIDARR + 'command', { name: 'RefreshArtist', artistId: 1 }]
    ];
    for (const who of [admin, user]) {
      for (const [url, body] of fine) assertFromService(await who.post(url, body), 201);
    }

    // toute la liste blanche des utilisateurs est acceptée ; le reste est réservé aux administrateurs
    for (const name of USER_COMMANDS) assertFromService(await user.post(RADARR + 'command', { name }), 201);
    for (const name of ['DeleteLogFiles', 'ApplicationUpdate', 'ClearBlocklist', 'Restart', 'refreshmovie']) {
      assertServerError(await user.post(RADARR + 'command', { name }), 403, 'forbidden');
    }
    assertFromService(await admin.post(RADARR + 'command', { name: 'DeleteLogFiles' }), 201);

    // commandes mal formées : 400, jamais transmises
    const before = total(mocks);
    for (const who of [admin, user]) {
      for (const body of [{}, { name: '' }, { name: 5 }, { name: ['RefreshMovie'] }, null, []]) {
        const r = await who.send('POST', RADARR + 'command', { json: body });
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.equal(r.headers['x-arr411-error'], 'error');
      }
      for (const [url, extra] of [[RADARR + 'command', {}], [RADARR + 'movie', {}], [RADARR + 'movie', { form: { a: 'b' } }]]) {
        const r = await who.send('POST', url, Object.assign({ body: '{"name":', headers: { 'Content-Type': 'application/json' } }, extra));
        assert.equal(r.status, 400, `${url} ${JSON.stringify(extra)}`);
      }
    }
    assert.equal(total(mocks), before);
  }));

test('recherches automatiques : avec ALLOW_SEARCH_COMMANDS, l’administrateur peut tout, l’utilisateur garde sa liste de commandes', () =>
  withSetup(async ({ admin, user, mocks }) => {
    const saved = config.allowSearchCommands;
    config.allowSearchCommands = true;
    try {
      const flagged = [
        ['POST', RADARR + 'movie', { title: 'x', addOptions: { searchForMovie: true } }, 201],
        ['PUT', RADARR + 'movie/1', { title: 'x', addOptions: { searchForMovie: true } }, 404],
        ['POST', SONARR + 'series', { title: 'x', addOptions: { searchForMissingEpisodes: true } }, 201],
        ['POST', LIDARR + 'artist', { name: 'x', addOptions: { searchForMissingAlbums: true } }, 201]
      ];
      for (const who of [admin, user]) {
        for (const [method, url, body, status] of flagged) assertFromService(await who.send(method, url, { json: body }), status);
      }
      assertFromService(await admin.post(RADARR + 'command', { name: 'MoviesSearch', movieIds: [1] }), 201);
      assertFromService(await admin.post(SONARR + 'command', { name: 'SeriesSearch', seriesId: 1 }), 201);
      assertFromService(await admin.post(RADARR + 'command', { name: 'RssSync' }), 201);

      const before = total(mocks);
      for (const name of ['MoviesSearch', 'MissingMoviesSearch', 'RssSync', 'DeleteLogFiles']) {
        assertServerError(await user.post(RADARR + 'command', { name }), 403, 'forbidden');
      }
      assert.equal(total(mocks), before);
    } finally {
      config.allowSearchCommands = saved;
    }
    // et la valeur par défaut est de nouveau en vigueur
    assertServerError(await admin.post(RADARR + 'command', { name: 'MoviesSearch' }), 403, 'forbidden');
  }));

test('commandes : un corps JSON ambigu ou un nom de commande hors norme n’atteint jamais le service', () =>
  withSetup(async ({ admin, user, mocks }) => {
    const ambiguous = [
      '{"name":"RefreshMovie","Name":"CleanUpRecycleBin"}',
      '{"name":"CleanUpRecycleBin","name":"RefreshMovie"}',
      '{"na\\u006de":"RefreshMovie","name":"DeleteLogFiles"}',
      '{"name":"RefreshMovie","options":{"a":1,"A":2}}'
    ];
    for (const who of [admin, user]) {
      for (const text of ambiguous) {
        for (const base of [RADARR, SONARR, LIDARR]) {
          assertServerError(await who.send('POST', base + 'command', { body: text, headers: { 'Content-Type': 'application/json' } }), 400, 'error');
        }
      }
      for (const name of ['Refresh Movie', 'RefreshMovie\n', 'RefreshMovie\u200b', 'Refresh1', '']) {
        assertServerError(await who.post(RADARR + 'command', { name }), 400, 'error');
      }
      assertServerError(await who.post(RADARR + 'command', { Name: 'RefreshMovie' }), 400, 'error');
    }
    assert.equal(total(mocks), 0, 'rien n’a atteint un service');
    assertFromService(await user.post(RADARR + 'command', { name: 'RefreshMovie', movieIds: [1] }), 201);
    assert.equal(total(mocks), 1);
  }));

test('qBittorrent : un utilisateur n’a ni les réglages, ni les journaux, ni les flux RSS, ni la recherche', () =>
  withSetup(async ({ admin, user, mocks }) => {
    const qb = mocks.qb;
    const denied = [
      ['GET', 'app/preferences'],
      ['POST', 'app/setPreferences'],
      ['POST', 'app/shutdown'],
      ['GET', 'app/defaultSavePath'],
      ['GET', 'APP/Preferences'],
      ['GET', 'app'],
      ['GET', 'log/main'],
      ['GET', 'rss/items'],
      ['POST', 'rss/addFeed'],
      ['POST', 'search/start'],
      ['GET', 'search/status'],
      ['POST', 'torrentcreator/addTask'],
      ['GET', 'TorrentCreator/status'],
      ['POST', 'auth/foo'],
      ['GET', 'future/endpoint']
    ];
    for (const [method, p] of denied) assertServerError(await user.send(method, QB + p), 403, 'forbidden');
    assert.equal(qb.reqs.length, 0);
    assert.equal(qb.logins(), 0, 'refusé avant même d’ouvrir une session chez qBittorrent');

    // qBittorrent ne route que « portée/action » : tout le reste est refusé ici, y compris pour un administrateur
    for (const who of [admin, user]) {
      for (const p of ['torrents', 'torrents/', 'torrents/info/', 'torrents/info/extra', 'app/setPreferences/', 'app/setPreferences/x', 'app/version/']) {
        assertServerError(await who.get(QB + p), 403, 'forbidden');
      }
    }
    assert.equal(qb.reqs.length, 0);
    assert.equal(qb.logins(), 0);

    for (const p of ['app/version', 'app/webapiVersion', 'app/buildInfo', 'torrents/info', 'sync/maindata']) {
      assert.notEqual((await user.get(QB + p)).headers['x-arr411-error'], 'forbidden', p);
    }
    assert.equal((await user.get(QB + 'app/version')).text, 'v5.0.3');

    for (const [method, p] of [['GET', 'app/preferences'], ['POST', 'app/setPreferences'], ['GET', 'log/main'], ['GET', 'rss/items'], ['POST', 'search/start']]) {
      assert.equal((await admin.send(method, QB + p)).status, 200, `${method} ${p}`);
    }
  }));

test('chemins : aucune échappatoire vers un autre service, une autre route ou une autre machine', () =>
  withSetup(async ({ admin, user, mocks }) => {
    const bad = [
      RADARR + '../../../system/status',
      RADARR + 'movie/../../v1/system/status',
      RADARR + '%2e%2e/system/status',
      RADARR + '%2E%2E/system/status',
      RADARR + 'movie/%2e%2e/%2e%2e/x',
      RADARR + 'movie%2f..%2fconfig%2fhost',
      RADARR + 'movie%2Fx',
      RADARR + 'movie%5c..%5cx',
      RADARR + 'movie\\..\\x',
      RADARR + '/movie',
      RADARR + 'movie//1',
      RADARR + './movie',
      RADARR + 'movie/.',
      RADARR + 'movie%00',
      RADARR + 'movie%0d%0aX-Injected:1',
      RADARR + 'movie%7f',
      RADARR + 'movie?x=é',
      RADARR + 'movie?x=' + 'a'.repeat(9000),
      '/api/svc/radarr/movie',
      '/api/svc/radarr/api/v1/movie',
      '/api/svc/radarr/api/V3/movie',
      '/api/svc/radarr/api/v3',
      '/api/svc/radarr/api',
      '/api/svc/radarr/@evil.test/api/v3/movie',
      '/api/svc/radarr/http://evil.test/api/v3/movie',
      '/api/svc/radarr@evil.test/api/v3/movie',
      '/api/svc/radarr.evil.test/api/v3/movie',
      '/api/svc/radarrr/api/v3/movie',
      '/api/svc/RADARR/api/v3/movie',
      '/api/svc/api/v3/movie',
      '/api/svc/',
      QB + '../app/preferences',
      QB + '%2e%2e/app/preferences',
      QB + 'app%2fpreferences',
      // un pourcentage dans le chemin : qBittorrent et les *arr le décodent avant de choisir la route, donc jamais relayé
      QB + '%61pp/setPreferences',
      QB + '%41pp/setPreferences',
      QB + 'app/%73etPreferences',
      QB + 'torrents/info%3Fx',
      QB + 'app/version%2e',
      RADARR + 'movie/%6dovie',
      RADARR + 'config/%68ost',
      RADARR + 'c%6fnfig/host',
      RADARR + 'movie%',
      SONARR + 'config%2fhost',
      LIDARR + 'config/%48OST',
      QB + '/app/version',
      QB + 'app//version',
      '/api/svc/qb',
      '/api/svc/qb/',
      '/api/svc/qb/login',
      '/api/svc/qb/api/v3/app/version',
      '/api/svc/qb/api/v2',
      '/api/svc/qb/api/v2app/version',
      '/api/svc/qb/../radarr/api/v3/movie'
    ];
    for (const who of [admin, user]) {
      for (const url of bad) {
        const r = await who.get(url);
        assert.ok(r.status === 400 || r.status === 404, `${url.slice(0, 80)} → ${r.status}`);
      }
    }
    assert.equal(total(mocks), 0, 'rien n’a atteint un service');

    // seules les méthodes d’une API REST sont relayées
    for (const method of ['OPTIONS', 'TRACE', 'PROPFIND', 'LOCK']) {
      for (const url of [RADARR + 'movie', QB + 'torrents/info']) assert.equal((await admin.send(method, url)).status, 405, `${method} ${url}`);
    }
    assert.equal(total(mocks), 0);
  }));
