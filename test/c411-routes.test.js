'use strict';
// The door of the C411 view: who may open the WebSocket, from where, how often, and when they are thrown out again.
// The remote browser is off here (the view answers "disabled" once the door is passed): the door is what is tested.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const SECRET = 'secret-de-test-assez-long-123456';
h.prepareEnv({ SESSION_SECRET: SECRET });

const config = require('../server/config');
const { Sessions } = require('../server/auth');
const { OP, connect, until, sleep } = require('./wsclient');
const { Client, adminClient, clientFor } = h;

const PASS = 'une phrase de passe solide';
const DAY = 86400;
const sessions = new Sessions(SECRET, 7 * DAY);

// What the server logs is part of what is checked: warnings are collected, and an error is never expected.
const warnings = [];
const errors = [];
console.warn = (...args) => warnings.push(args.join(' '));
console.error = (...args) => errors.push(args.join(' '));

const peers = new Set();

async function withApp(opts, fn) {
  if (typeof opts === 'function') {
    fn = opts;
    opts = {};
  }
  warnings.length = 0;
  errors.length = 0;
  const app = await h.startApp({ c411: { upgradesPerMinute: 1000, maxSocketsPerUser: 20, ...opts } });
  try {
    const out = await fn(app);
    assert.deepEqual(errors, [], 'the server logged an error');
    return out;
  } finally {
    for (const p of peers) p.destroy();
    peers.clear();
    await app.close();
  }
}

// A handshake as a tab of this site would send it (its cookie and its Origin), unless told otherwise.
// `who`: a client of the tests, a raw Cookie header, or null for none. Options: path, method, headers (null removes one).
async function dial(app, who, o = {}) {
  const headers = { Origin: `http://127.0.0.1:${app.port}`, ...o.headers };
  const cookie = who && typeof who === 'object' ? who.cookie : who;
  if (cookie) headers.Cookie = cookie;
  const r = await connect(app.port, { path: '/api/c411/ws', ...o, headers });
  if (r.peer) peers.add(r.peer);
  return r;
}

async function json(peer, ms = 3000) {
  const f = await peer.next(ms);
  assert.equal(f.op, OP.text, 'a text frame was expected');
  return JSON.parse(f.payload.toString('utf8'));
}

const alive = async (peer) => {
  peer.text('{"t":"ping"}');
  assert.deepEqual(await json(peer), { t: 'pong' });
};

// The view tells the page that the session is over, then closes with 4401.
async function signedOut(peer, ms = 3000) {
  assert.equal((await json(peer, ms)).code, 'signed_out');
  assert.equal((await peer.expectClose(ms)).code, 4401);
}

// The configuration is read at each handshake: a test changes it for its own duration only.
async function withConfig(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) saved[k] = config[k];
  Object.assign(config, overrides);
  try {
    return await fn();
  } finally {
    Object.assign(config, saved);
  }
}

const admin = (app) => app.users.find('boss');
const healthy = async (app) => assert.equal((await new Client(app).get('/healthz')).status, 200, 'the server must still answer');

// ---------- status ----------

test('statut : réservé aux comptes connectés, jamais mis en cache, méthodes limitées', () =>
  withApp(async (app) => {
    const anon = new Client(app);
    let r = await anon.get('/api/c411/status');
    assert.equal(r.status, 401);
    assert.equal(r.json.code, 'auth');
    r = await anon.get('/api/c411/ws');
    assert.equal(r.status, 401, 'the WebSocket address asks for a session too');

    const alice = await clientFor(app, 'alice', PASS);
    r = await alice.get('/api/c411/status');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { enabled: false, available: false, reason: 'disabled' });
    assert.match(r.headers['cache-control'], /no-store/);
    r = await alice.send('HEAD', '/api/c411/status');
    assert.equal(r.status, 200);
    assert.equal(r.text, '');
    r = await alice.post('/api/c411/status', {});
    assert.equal(r.status, 405);
    assert.equal(r.headers.allow, 'GET, HEAD');
    r = await alice.post('/api/c411/status', {}, { csrf: false });
    assert.equal(r.status, 403);

    r = await alice.get('/api/c411/ws');
    assert.equal(r.status, 426, 'without a protocol switch the address only explains itself');
    assert.equal(r.headers.upgrade, 'websocket');
    for (const p of ['/api/c411/', '/api/c411/status/', '/api/c411/inconnu', '/api/c411/ws/x', '/api/c411/status/x']) {
      assert.equal((await alice.get(p)).status, 404, p);
    }
  }));

// ---------- who gets in ----------

test('connexion WebSocket : sans session valide, la porte reste fermée (401)', () =>
  withApp(async (app) => {
    const alice = await clientFor(app, 'alice', PASS);
    const user = app.users.find('alice');
    const token = alice.cookie.slice('arr_session='.length);
    const flip = (t) => t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A');
    const stranger = new Sessions('un-tout-autre-secret-assez-long-42', 7 * DAY);
    const cases = {
      'sans cookie': null,
      'cookie vide': 'arr_session=',
      'cookie bidon': 'arr_session=bidon',
      'jeton sans signature': `arr_session=${token.split('.').slice(0, 2).join('.')}`,
      'signature modifiée': `arr_session=${flip(token)}`,
      'mauvais nom de cookie': `session=${token}`,
      'signé avec un autre secret': `arr_session=${stranger.sign(user)}`,
      expiré: `arr_session=${sessions.sign(user, Date.now() - 8 * DAY * 1000)}`,
      'compte inconnu': `arr_session=${sessions.sign({ username: 'fantome', sv: 1 })}`,
      'version de session périmée': `arr_session=${sessions.sign({ ...user, sv: user.sv + 1 })}`,
      'mauvais jeton en premier': `arr_session=bidon; arr_session=${token}`
    };
    for (const [name, cookie] of Object.entries(cases)) {
      const r = await dial(app, cookie);
      assert.equal(r.status, 401, name);
      assert.equal(r.peer, null, name);
      assert.doesNotMatch(r.body, /alice|boss|fantome/, name);
    }

    const bob = await clientFor(app, 'bob', PASS);
    const old = bob.cookie;
    assert.equal((await dial(app, old)).status, 101, 'bob can open the view while signed in');
    assert.equal((await bob.post('/api/auth/logout')).status, 200);
    assert.equal((await dial(app, old)).status, 401, 'a cookie signed out is dead');

    const carol = await clientFor(app, 'carol', PASS);
    await app.users.update('carol', { disabled: true }, admin(app));
    assert.equal((await dial(app, carol)).status, 401, 'a disabled account');

    const ok = await dial(app, alice);
    assert.equal(ok.status, 101);
    assert.ok(ok.peer);
    await healthy(app);
  }));

test('connexion WebSocket : seule une page de ce site peut ouvrir la vue (Origin)', () =>
  withApp(async (app) => {
    const alice = await clientFor(app, 'alice', PASS);
    const host = `127.0.0.1:${app.port}`;
    const refused = {
      absente: null,
      vide: '',
      'site tiers': 'https://evil.example',
      'autre port': `http://127.0.0.1:${app.port + 1}`,
      'origine opaque': 'null',
      fichier: 'file://',
      extension: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
      'sous-domaine piégé': `http://${host}.evil.example`,
      'hôte piégé': `http://127.0.0.1.evil.example:${app.port}`,
      'identifiants avant l’hôte': `http://${host}@evil.example`,
      'hôte dans le chemin': `http://evil.example/${host}`,
      liste: `http://${host}, https://evil.example`,
      'liste inversée': `https://evil.example, http://${host}`
    };
    for (const [name, origin] of Object.entries(refused)) {
      const r = await dial(app, alice, { headers: { Origin: origin } });
      assert.equal(r.status, 403, name);
      assert.equal(r.peer, null, name);
    }
    let r = await dial(app, alice, { headers: { Origin: `http://${host}`, origin: 'https://evil.example' } });
    assert.equal(r.status, 403, 'two Origin lines');
    r = await dial(app, alice, { headers: { Origin: 'https://evil.example', 'X-Forwarded-Host': 'evil.example', Forwarded: 'host=evil.example' } });
    assert.equal(r.status, 403, 'a forged forwarding header does not make a foreign site ours');

    for (const origin of [`http://${host}`, `https://${host}`]) {
      r = await dial(app, alice, { headers: { Origin: origin } });
      assert.equal(r.status, 101, origin);
    }
    await healthy(app);
  }));

test('origine refusée : un seul avertissement par minute, valeurs échappées et tronquées', () =>
  withApp(async (app) => {
    const alice = await clientFor(app, 'alice', PASS);
    const nasty = `https://evil.example/"\\x${'a'.repeat(3000)}`;
    for (let i = 0; i < 3; i++) assert.equal((await dial(app, alice, { headers: { Origin: nasty } })).status, 403);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /origine refusée/);
    assert.match(warnings[0], /\\"\\\\x/);
    assert.match(warnings[0], /TRUST_PROXY/);
    assert.ok(warnings[0].length < 700, `the warning is ${warnings[0].length} characters long`);
    assert.ok(!warnings[0].includes('a'.repeat(300)), 'the value is cut');
  }));

// ---------- behind a reverse proxy ----------

test('derrière un reverse proxy : l’adresse publique est acceptée (PUBLIC_URL, X-Forwarded-Host), jamais celle d’un tiers', () =>
  withApp(async (app) => {
    const alice = await clientFor(app, 'alice', PASS);
    const pub = 'https://arr.example.org';
    const status = async (origin, extra) => (await dial(app, alice, { headers: { Origin: origin, ...extra } })).status;

    assert.equal(await status(pub), 403, 'a proxy that rewrites Host is refused while nothing is configured');
    assert.equal(await status(pub, { 'X-Forwarded-Host': 'arr.example.org' }), 403, 'X-Forwarded-Host means nothing without TRUST_PROXY');

    await withConfig({ publicUrl: { origin: pub, host: 'arr.example.org', secure: true } }, async () => {
      assert.equal(await status(pub), 101, 'PUBLIC_URL');
      assert.equal(await status('https://arr.example.org:443'), 101, 'the default port is the same address');
      assert.equal(await status(`http://127.0.0.1:${app.port}`), 101, 'the address the server was reached at still counts');
      assert.equal(await status('https://arr.example.org:8443'), 403, 'the port counts');
      assert.equal(await status('https://arr.example.org.evil.example'), 403);
      assert.equal(await status('https://evil.example'), 403);
      assert.equal(await status('null'), 403);
      assert.equal(await status('https://films.example.net', { 'X-Forwarded-Host': 'films.example.net' }), 403, 'PUBLIC_URL alone does not trust forwarded headers');
    });

    await withConfig({ trustProxy: 1 }, async () => {
      const films = 'https://films.example.net';
      assert.equal(await status(films, { 'X-Forwarded-Host': 'films.example.net' }), 101, 'the host the proxy was asked for');
      assert.equal(await status('https://evil.example', { 'X-Forwarded-Host': 'films.example.net' }), 403);
      assert.equal(await status(films, { 'X-Forwarded-Host': 'films.example.net, evil.example' }), 101, 'the first proxy counts');
      assert.equal(await status('https://evil.example', { 'X-Forwarded-Host': 'films.example.net, evil.example' }), 403);
      assert.equal(await status(films), 403, 'without the forwarded host nothing names this site');
    });

    await withConfig({ trustProxy: 1, publicUrl: { origin: pub, host: 'arr.example.org', secure: true } }, async () => {
      assert.equal(await status(pub, { 'X-Forwarded-Host': 'films.example.net' }), 101, 'both addresses are ours');
      assert.equal(await status('https://films.example.net', { 'X-Forwarded-Host': 'films.example.net' }), 101);
      assert.equal(await status('https://evil.example', { 'X-Forwarded-Host': 'films.example.net' }), 403);
    });
    await healthy(app);
  }));

test('derrière un reverse proxy : la limite de tentatives suit l’adresse vue par le proxy, pas celles qu’un client ajoute', () =>
  withApp({ upgradesPerMinute: 3 }, async (app) =>
    withConfig({ trustProxy: 1 }, async () => {
      const from = (xff) => dial(app, null, { headers: xff === undefined ? {} : { 'X-Forwarded-For': xff } });
      // the client invents addresses at the head of the list; the proxy appends the real one at the end
      for (let i = 0; i < 3; i++) assert.equal((await from(`10.9.9.${i}, 203.0.113.7`)).status, 401, `attempt ${i + 1}`);
      const r = await from('10.1.1.1, 203.0.113.7');
      assert.equal(r.status, 429, 'the same real address is blocked');
      assert.ok(r.headers['retry-after']);
      assert.equal((await from('203.0.113.8')).status, 401, 'another real address is not concerned');
      assert.equal((await from()).status, 401, 'nor the proxy itself');
    })));

test('sans TRUST_PROXY : X-Forwarded-For est ignoré, annoncer une autre adresse n’évite pas la limite', () =>
  withApp({ upgradesPerMinute: 3 }, async (app) => {
    for (let i = 0; i < 3; i++) assert.equal((await dial(app, null, { headers: { 'X-Forwarded-For': `203.0.113.${i}` } })).status, 401);
    assert.equal((await dial(app, null, { headers: { 'X-Forwarded-For': '203.0.113.99' } })).status, 429);
  }));

test('connexion WebSocket : une seule adresse ouvre la vue, tout le reste est refusé', () =>
  withApp(async (app) => {
    const alice = await clientFor(app, 'alice', PASS);
    const elsewhere = ['/', '/api/c411/ws/', '/api/c411/wsx', '/api/c411/status', '//api/c411/ws', '/API/C411/WS', '/api/c411/ws%2f', '/api/c411/%77s', '/api/auth/me', '/login', '/healthz'];
    for (const p of elsewhere) {
      const r = await dial(app, alice, { path: p });
      assert.equal(r.status, 404, p);
      assert.equal(r.peer, null, p);
    }
    let r = await dial(app, alice, { path: '/api/c411/ws?x=1&y=%00' });
    assert.equal(r.status, 101, 'a query string changes nothing');
    r = await dial(app, null, { path: '/api/c411/ws?x=1' });
    assert.equal(r.status, 401);

    for (const p of [`http://127.0.0.1:${app.port}/api/c411/ws`, '*', 'api/c411/ws', `/api/c411/ws?${'a'.repeat(2100)}`]) {
      r = await dial(app, alice, { path: p });
      assert.equal(r.status, 400, p.slice(0, 60));
    }
    r = await dial(app, alice, { method: 'POST' });
    assert.notEqual(r.status, 101, 'a protocol switch asked with POST is never accepted');
    r = await dial(app, alice, { headers: { 'Sec-WebSocket-Version': '8' } });
    assert.equal(r.status, 426);
    r = await dial(app, alice, { headers: { 'Sec-WebSocket-Key': null } });
    assert.equal(r.status, 400);
    await healthy(app);
  }));

// ---------- how often, how many ----------

test('connexion WebSocket : les tentatives par minute et par adresse sont limitées, réussies ou non', () =>
  withApp({ upgradesPerMinute: 6 }, async (app) => {
    const alice = await clientFor(app, 'alice', PASS);
    for (let i = 0; i < 3; i++) assert.equal((await dial(app, null)).status, 401);
    for (let i = 0; i < 3; i++) assert.equal((await dial(app, alice)).status, 101);
    for (const who of [alice, null, 'arr_session=bidon']) {
      const r = await dial(app, who);
      assert.equal(r.status, 429);
      assert.ok(Number(r.headers['retry-after']) >= 1 && Number(r.headers['retry-after']) <= 60, `Retry-After: ${r.headers['retry-after']}`);
    }
    assert.equal((await alice.get('/api/c411/status')).status, 200, 'the rest of the API is not concerned');
    await healthy(app);
  }));

test('connexion WebSocket : plafond par compte puis plafond global, libérés à la fermeture', () =>
  withApp({ maxSocketsPerUser: 2, maxSockets: 3, helloMs: 60000 }, async (app) => {
    const alice = await clientFor(app, 'alice', PASS);
    const bob = await clientFor(app, 'bob', PASS);
    const carol = await clientFor(app, 'carol', PASS);
    const a1 = await dial(app, alice);
    const a2 = await dial(app, alice);
    assert.equal(a1.status, 101);
    assert.equal(a2.status, 101);
    let r = await dial(app, alice);
    assert.equal(r.status, 429, 'a third window for the same account');
    assert.ok(r.headers['retry-after']);
    assert.equal((await dial(app, bob)).status, 101, 'another account is not concerned by the cap of alice');

    assert.equal(app.c411.stats().sockets, 3);
    for (const who of [carol, alice]) {
      r = await dial(app, who);
      assert.equal(r.status, 503, 'the server is full');
      assert.ok(r.headers['retry-after']);
    }
    a1.peer.destroy();
    await until(() => app.c411.stats().sockets === 2, 3000, 'the socket is released');
    assert.equal((await dial(app, carol)).status, 101, 'a place was freed');
    assert.equal(app.c411.stats().sockets, 3);
  }));

// ---------- the opening of the view ----------

test('ouverture : le premier message doit être un « hello » valide, sinon 1008', () =>
  withApp({ helloMs: 5000 }, async (app) => {
    const alice = await clientFor(app, 'alice', PASS);
    const first = ['{', '[]', 'null', '1', '"hello"', '{}', '{"t":1}', '{"t":"mouse","x":1,"y":1}', '{"t":"hello"}', '{"t":"hello","w":"800","h":"600"}', '{"t":"hello","w":800}', '{"t":"hello","w":null,"h":null}', '{"t":"hello","w":800,"h":[600]}'];
    for (const message of first) {
      const r = await dial(app, alice);
      assert.equal(r.status, 101);
      r.peer.text(message);
      assert.equal((await r.peer.expectClose()).code, 1008, message);
    }

    // The size is only a wish: whatever it is, a number is accepted and clamped.
    for (const [w, h2] of [[1280, 720], [5, 5], [1e9, 1e9], [-5, -5], [800.5, 600.5]]) {
      const r = await dial(app, alice);
      r.peer.text(JSON.stringify({ t: 'hello', w, h: h2, dpr: 2 }));
      const m = await json(r.peer);
      assert.equal(m.t, 'error');
      assert.equal(m.code, 'disabled', `${w}x${h2}`);
      assert.equal((await r.peer.expectClose()).code, 4000);
    }
  }));

test('ouverture : sans « hello » à temps, 1008 ; le ping de la page ne prolonge pas le délai', () =>
  withApp({ helloMs: 700 }, async (app) => {
    const alice = await clientFor(app, 'alice', PASS);
    const silent = await dial(app, alice);
    const t0 = Date.now();
    await alive(silent.peer);
    await sleep(250);
    await alive(silent.peer);
    assert.equal((await silent.peer.expectClose(3000)).code, 1008);
    assert.ok(Date.now() - t0 < 2500);

    const polite = await dial(app, alice);
    await alive(polite.peer);
    polite.peer.text(JSON.stringify({ t: 'hello', w: 1000, h: 700 }));
    assert.equal((await json(polite.peer)).code, 'disabled');
    assert.equal((await polite.peer.expectClose()).code, 4000);
  }));

test('ouverture : binaire et messages démesurés sont refusés', () =>
  withApp(async (app) => {
    const alice = await clientFor(app, 'alice', PASS);
    let r = await dial(app, alice);
    r.peer.binary(Buffer.from('abc'));
    assert.equal((await r.peer.expectClose()).code, 1003);
    r = await dial(app, alice);
    r.peer.text('x'.repeat(64 * 1024 + 1));
    assert.equal((await r.peer.expectClose()).code, 1009);
    r = await dial(app, alice);
    r.peer.text(`{"t":"hello","w":800,"h":600,"pad":"${'x'.repeat(60 * 1024)}"}`);
    assert.equal((await json(r.peer)).code, 'disabled', 'under the limit it goes through');
    await healthy(app);
  }));

// ---------- the end of a session ----------

test('fin de session : un cookie qui expire ferme la vue en cours', () =>
  withApp({ recheckMs: 150 }, async (app) => {
    await clientFor(app, 'alice', PASS);
    // Valid for one or two more seconds.
    const token = sessions.sign(app.users.find('alice'), Date.now() - (7 * DAY - 2) * 1000);
    const r = await dial(app, `arr_session=${token}`);
    assert.equal(r.status, 101);
    await alive(r.peer);
    await signedOut(r.peer, 6000);
  }));

test('fin de session : un compte désactivé par un autre moyen que l’API perd la vue au contrôle suivant', () =>
  withApp({ recheckMs: 150 }, async (app) => {
    const alice = await clientFor(app, 'alice', PASS);
    const bob = await clientFor(app, 'bob', PASS);
    const a = await dial(app, alice);
    const b = await dial(app, bob);
    await app.users.update('alice', { disabled: true }, admin(app));
    await signedOut(a.peer);
    await sleep(400);
    await alive(b.peer);
  }));

test('fin de session : désactiver, supprimer ou réinitialiser un compte coupe tous ses sockets aussitôt', () =>
  withApp({ recheckMs: 600000 }, async (app) => {
    const root = await adminClient(app);
    const actions = {
      désactivation: (name) => root.patch(`/api/admin/users/${name}`, { disabled: true }),
      suppression: (name) => root.del(`/api/admin/users/${name}`),
      'nouveau mot de passe': (name) => root.patch(`/api/admin/users/${name}`, { password: 'un tout nouveau mot de passe' })
    };
    let n = 0;
    for (const [label, act] of Object.entries(actions)) {
      n++;
      const victim = await clientFor(app, `victime${n}`, PASS);
      const bystander = await clientFor(app, `voisin${n}`, PASS);
      const v1 = await dial(app, victim);
      const v2 = await dial(app, victim);
      const o = await dial(app, bystander);
      for (const c of [v1, v2, o]) assert.equal(c.status, 101);
      const res = await act(`victime${n}`);
      assert.equal(res.status, 200, `${label}: ${res.text}`);
      await signedOut(v1.peer);
      await signedOut(v2.peer);
      await alive(o.peer);
      assert.equal((await dial(app, victim)).status, 401, `${label}: the old cookie is dead`);
    }
  }));

test('fin de session : changer son mot de passe coupe la vue des autres appareils', () =>
  withApp({ recheckMs: 200 }, async (app) => {
    const phone = await clientFor(app, 'alice', PASS);
    const laptop = await clientFor(app, 'alice', PASS);
    const onPhone = await dial(app, phone);
    assert.equal(onPhone.status, 101);
    const res = await laptop.post('/api/auth/password', { current: PASS, password: 'un nouveau mot de passe 42' });
    assert.equal(res.status, 200, res.text);
    await signedOut(onPhone.peer, 4000);
    assert.equal((await dial(app, phone)).status, 401);
    const again = await dial(app, laptop);
    assert.equal(again.status, 101, 'the device that changed it keeps its session');
  }));

test('fin de session : la déconnexion ferme seulement les sockets de cette session', () =>
  withApp({ recheckMs: 600000 }, async (app) => {
    const phone = await clientFor(app, 'alice', PASS);
    const laptop = await clientFor(app, 'alice', PASS);
    const old = phone.cookie;
    const p1 = await dial(app, phone);
    const p2 = await dial(app, phone);
    const l1 = await dial(app, laptop);
    const res = await phone.post('/api/auth/logout');
    assert.equal(res.status, 200);
    await signedOut(p1.peer);
    await signedOut(p2.peer);
    await alive(l1.peer);
    assert.equal((await dial(app, old)).status, 401);
    assert.equal((await dial(app, laptop)).status, 101);
  }));

// ---------- the account behind a name ----------

// The remote browser keeps tabs and cookies per account. The name alone would hand them to someone else: an account that
// is removed and created again with the same name is another account.
const hello = JSON.stringify({ t: 'hello', w: 800, h: 600 });

// Replaces the hub's door with a recorder: what the hub is given is what is checked here.
function recordViewers(app) {
  const seen = [];
  app.c411.hub.open = async (viewer) => {
    seen.push(viewer);
  };
  return async (client, name) => {
    const r = await dial(app, client);
    assert.equal(r.status, 101);
    const before = seen.length;
    r.peer.text(hello);
    await until(() => seen.length > before, 3000, `the viewer of ${name} reaches the hub`);
    return { viewer: seen[before], peer: r.peer };
  };
}

test('compte : la vue est liée au compte (nom et création), pas au seul nom', () =>
  withApp({ recheckMs: 600000 }, async (app) => {
    const root = await adminClient(app);
    const open = recordViewers(app);
    const first = await clientFor(app, 'alice', PASS);
    const one = await open(first, 'alice');
    assert.equal(one.viewer.username, 'alice');
    assert.equal(typeof one.viewer.account, 'string');
    assert.ok(one.viewer.account.length > 0);
    assert.equal((await open(first, 'alice')).viewer.account, one.viewer.account, 'the same account has the same key');
    const bob = await open(await clientFor(app, 'bob', PASS), 'bob');
    assert.notEqual(bob.viewer.account, one.viewer.account);

    assert.equal((await root.del('/api/admin/users/alice')).status, 200);
    await signedOut(one.peer);
    await sleep(20);
    const second = await clientFor(app, 'alice', PASS);
    const two = await open(second, 'alice');
    assert.equal(two.viewer.username, 'alice');
    assert.notEqual(two.viewer.account, one.viewer.account, 'an account created later is another account');
  }));

test('compte : désactiver, réinitialiser ou supprimer prévient le navigateur distant', () =>
  withApp({ recheckMs: 600000 }, async (app) => {
    const root = await adminClient(app);
    const open = recordViewers(app);
    const calls = [];
    app.c411.hub.dropUser = async (name, account) => {
      calls.push([name, account]);
    };

    const still = {
      désactivation: (name) => root.patch(`/api/admin/users/${name}`, { disabled: true }),
      'nouveau mot de passe': (name) => root.patch(`/api/admin/users/${name}`, { password: 'un tout nouveau mot de passe' })
    };
    let n = 0;
    for (const [label, act] of Object.entries(still)) {
      const name = `membre${++n}`;
      const { viewer } = await open(await clientFor(app, name, PASS), name);
      calls.length = 0;
      const res = await act(name);
      assert.equal(res.status, 200, `${label}: ${res.text}`);
      assert.deepEqual(calls, [[name, viewer.account]], `${label}: the account that keeps this name is given`);
    }

    const { viewer } = await open(await clientFor(app, 'partant', PASS), 'partant');
    assert.ok(viewer.account);
    calls.length = 0;
    assert.equal((await root.del('/api/admin/users/partant')).status, 200);
    assert.deepEqual(calls, [['partant', null]], 'removed: no account keeps the name, the sweep finds what is left');
  }));

test('arrêt du serveur : les sockets reçoivent 1001 et l’arrêt n’attend pas', async () => {
  warnings.length = 0;
  errors.length = 0;
  const app = await h.startApp({ c411: { upgradesPerMinute: 1000 } });
  const alice = await clientFor(app, 'alice', PASS);
  const a = await dial(app, alice);
  const b = await dial(app, alice);
  assert.equal(a.status, 101);
  assert.equal(b.status, 101);
  const t0 = Date.now();
  const stopping = app.close();
  for (const c of [a, b]) {
    const closed = await c.peer.expectClose();
    assert.equal(closed.code, 1001);
    c.peer.close(1001);
  }
  await stopping;
  assert.ok(Date.now() - t0 < 4000, `the shutdown took ${Date.now() - t0} ms`);
  await app.close();
  assert.deepEqual(errors, []);
  for (const p of peers) p.destroy();
  peers.clear();
});
