'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const h = require('./helpers');

const SECRET = 'secret-de-test-assez-long-123456';
h.prepareEnv({ SESSION_SECRET: SECRET });

const { Sessions } = require('../server/auth');
const { Revoked, MAX_ENTRIES } = require('../server/revoked');
const { JsonStore } = require('../server/store');
const { Client, rawRequest, adminClient, clientFor, ADMIN, gunzip } = h;

const DAY = 86400;
const sessions = new Sessions(SECRET, 7 * DAY);
const sessionCookieOf = (res) => res.setCookie.find((c) => c.startsWith('arr_session='));
const withCookie = (token) => ({ Cookie: `arr_session=${token}` });

async function withApp(fn) {
  const app = await h.startApp();
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

const NAVIGATION = { 'Sec-Fetch-Mode': 'navigate' };

// [next demandé, destination retenue] : la même règle côté serveur et dans le script de la page de connexion
const NEXT_CASES = [
  ['/radarr', '/radarr'], ['/share?text=x', '/share?text=x'], ['/#tab=lidarr', '/#tab=lidarr'],
  ['//evil.example', '/'], ['https://evil.example/', '/'], ['/\\evil.example', '/'], ['evil.example', '/'], ['/api/config', '/'], ['/login', '/'], ['/login?next=/x', '/'], ['', '/'],
  // browsers drop tabs and line breaks from a URL: "/<tab>/evil.example" would be read as "//evil.example"
  ['/\t/evil.example', '/'], ['/\n/evil.example', '/'], ['/\r/evil.example', '/'], ['/\t\\evil.example', '/'], ['/\u000b/evil.example', '/'], ['/\u007f/x', '/'], ['/ /evil.example', '/'],
  ['/\u00e9', '/'], ['/\u2028/evil.example', '/'], ['/' + 'a'.repeat(2001), '/'],
  ['/%09/evil.example', '/%09/evil.example']
];

// Runs the script of the sign-in page against a stub page; returns where it sends the browser after a successful sign-in.
async function destinationAfterSignIn(next) {
  const submit = [];
  const element = () => ({
    value: 'boss', type: 'password', hidden: true, disabled: false, textContent: '', classList: { toggle() {} },
    addEventListener(name, fn) { if (name === 'submit') submit.push(fn); }, setAttribute() {}, focus() {}
  });
  let target = null;
  const sandbox = {
    document: { getElementById: element },
    window: { addEventListener() {} },
    location: { search: '?next=' + encodeURIComponent(next), replace(url) { target = url; } },
    fetch: async () => ({ ok: true }),
    URLSearchParams
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'login', 'login.js'), 'utf8'), sandbox);
  assert.equal(submit.length, 1);
  await submit[0]({ preventDefault() {} });
  return target;
}

test('pages publiques : santé, connexion, manifeste, icônes', () =>
  withApp(async (app) => {
    const c = new Client(app);
    let r = await c.get('/healthz');
    assert.equal(r.status, 200);
    assert.equal(r.text, 'ok\n');
    assert.match(r.headers['content-type'], /^text\/plain/);
    r = await c.send('HEAD', '/healthz');
    assert.equal(r.status, 200);
    assert.equal(r.text, '');

    r = await c.get('/login');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.match(r.text, /<form id="form"[^>]*action="\/login"/);
    assert.match(r.text, /name="username"/);
    assert.match(r.text, /name="password"/);
    const same = await c.get('/login/');
    assert.equal(same.status, 200);
    assert.equal(same.text, r.text);

    for (const p of ['/login/login.css', '/login/login.js', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png']) {
      assert.equal((await c.get(p)).status, 200, p);
    }
    r = await c.get('/manifest.webmanifest');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^application\/manifest\+json/);
    const manifest = r.json;
    assert.equal(manifest.name, 'Arr411');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.share_target.action, '/share');
    assert.equal(manifest.share_target.method, 'GET');
    for (const icon of manifest.icons) assert.equal((await c.get(icon.src)).status, 200, icon.src);
    for (const s of manifest.shortcuts) assert.match(s.url, /^\/#tab=/);
  }));

test('rien de l’application sans session : redirection pour une page, 401 sinon', () =>
  withApp(async (app) => {
    const c = new Client(app);
    const nav = async (p, headers) => c.get(p, { headers });

    for (const headers of [{ Accept: 'text/html,application/xhtml+xml' }, NAVIGATION]) {
      let r = await nav('/', headers);
      assert.equal(r.status, 302);
      assert.equal(r.headers.location, '/login');
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.equal(r.text, '');
      r = await nav('/radarr?tab=films&q=a b'.replace(' ', '%20'), headers);
      assert.equal(r.headers.location, '/login?next=' + encodeURIComponent('/radarr?tab=films&q=a%20b'));
      r = await nav('/share?text=magnet%3A%3Fxt%3Durn%3Abtih%3A1', headers);
      assert.equal(r.headers.location, '/login?next=' + encodeURIComponent('/share?text=magnet%3A%3Fxt%3Durn%3Abtih%3A1'));
      // an address that cannot be a safe destination is dropped, not reflected
      r = await nav('//evil.example/x', headers);
      assert.equal(r.status, 302);
      assert.equal(r.headers.location, '/login');
    }

    // scripts, styles… requested by a page: no redirect, and no source code
    for (const p of ['/core.js', '/app.css', '/index.html', '/settings.js', '/main.js', '/arr.js', '/nothing']) {
      const r = await c.get(p, { headers: { Accept: '*/*' } });
      assert.equal(r.status, 401, p);
      assert.match(r.headers['content-type'], /^text\/plain/);
      assert.ok(!r.text.includes('function'), p);
    }
    const post = await c.post('/core.js', {});
    assert.equal(post.status, 401);
    assert.equal((await c.send('POST', '/', { form: { a: 'b' } })).status, 401);

    // every API route answers the same way, whether it exists or not
    const apiRoutes = [
      ['GET', '/api/config'], ['GET', '/api/auth/me'], ['GET', '/api/admin/users'], ['GET', '/api/admin/connections'], ['GET', '/api/nope'],
      ['PUT', '/api/prefs'], ['PUT', '/api/admin/defaults'], ['POST', '/api/admin/users'], ['PATCH', '/api/admin/users/boss'], ['DELETE', '/api/admin/users/boss'],
      ['POST', '/api/auth/password'], ['GET', '/api/svc/qb/api/v2/app/version'], ['GET', '/api/svc/radarr/api/v3/movie'], ['POST', '/api/svc/sonarr/api/v3/command'],
      ['GET', '/api/svc/lidarr/api/v1/artist'], ['GET', '/api/svc/other/x']
    ];
    for (const [method, p] of apiRoutes) {
      const r = await c.send(method, p, { json: method === 'GET' ? undefined : {}, headers: { Accept: 'text/html', ...NAVIGATION } });
      assert.equal(r.status, 401, `${method} ${p}`);
      assert.equal(r.json.code, 'auth', `${method} ${p}`);
      assert.equal(r.headers['x-arr411-error'], 'auth');
      assert.match(r.headers['content-type'], /^application\/json/);
    }
  }));

test('connexion réussie : cookie de session, accès à l’application, identifiant normalisé', () =>
  withApp(async (app) => {
    const c = new Client(app);
    const r = await c.login('  BOSS ', ADMIN.password);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { user: { username: 'boss', role: 'admin' } });
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.ok(!/hash|scrypt|password/i.test(r.text));
    const cookie = sessionCookieOf(r);
    assert.match(cookie, /^arr_session=v1\.[\w-]+\.[\w-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=604800$/, 'pas de « Secure » en HTTP simple');
    assert.equal(r.setCookie.length, 1);

    const me = await c.get('/api/auth/me');
    assert.deepEqual(me.json, { user: { username: 'boss', role: 'admin' } });
    const home = await c.get('/', { headers: NAVIGATION });
    assert.equal(home.status, 200);
    assert.match(home.headers['content-type'], /^text\/html/);
    assert.match(home.text, /<title>Arr411<\/title>/);
    for (const p of ['/core.js', '/app.css', '/main.js', '/settings.js', '/c411.js']) assert.equal((await c.get(p)).status, 200, p);

    // the last login date is recorded
    assert.ok(app.users.find('boss').lastLoginAt);
    // no sign of the password or its hash in the users file
    const file = require('node:fs').readFileSync(require('node:path').join(app.dataDir, 'users.json'), 'utf8');
    assert.ok(!file.includes(ADMIN.password));
    assert.match(file, /scrypt\$/);
  }));

test('identifiants refusés : même réponse que le compte existe, soit désactivé ou inconnu', () =>
  withApp(async (app) => {
    await app.users.create({ username: 'alice', password: 'alice-password-1', role: 'user' });
    await app.users.create({ username: 'dora', password: 'dora-password-1', role: 'user' });
    await app.users.update('dora', { disabled: true });
    const c = new Client(app);
    const attempts = [
      { username: 'boss', password: 'wrong' },
      { username: 'nobody', password: ADMIN.password },
      { username: 'dora', password: 'dora-password-1' },
      { username: 'alice', password: 'wrong' },
      { username: '', password: ADMIN.password },
      {},
      { username: 'boss', password: '' },
      { username: 'boss', password: 'x'.repeat(300) },
      { username: ['boss'], password: { $ne: 1 } }
    ];
    const answers = [];
    for (const body of attempts) {
      const r = await c.post('/api/auth/login', body);
      assert.equal(r.status, 401, JSON.stringify(body));
      assert.equal(r.headers['x-arr411-error'], 'bad-credentials');
      assert.deepEqual(r.setCookie, [], 'aucun cookie');
      answers.push(r.text);
    }
    assert.equal(new Set(answers).size, 1, 'une seule et même réponse');
    assert.deepEqual(JSON.parse(answers[0]), { message: 'Identifiant ou mot de passe incorrect', code: 'bad-credentials' });
    // the app is not locked after this many failures: a correct password still works
    assert.equal((await c.login('alice', 'alice-password-1')).status, 200);
  }));

test('déconnexion : le cookie est effacé', () =>
  withApp(async (app) => {
    const c = await adminClient(app);
    assert.equal((await c.get('/api/auth/me')).status, 200);
    const r = await c.post('/api/auth/logout', {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    assert.match(sessionCookieOf(r), /^arr_session=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970/);
    assert.equal(c.jar.size, 0);
    assert.equal((await c.get('/api/auth/me')).status, 401);
    // signing out without a session is harmless, and needs the same header as any other POST
    assert.equal((await new Client(app).post('/api/auth/logout', {})).status, 200);
    assert.equal((await new Client(app).post('/api/auth/logout', {}, { csrf: false })).status, 403);
  }));

test('déconnexion : le cookie rejoué ensuite est refusé, les autres sessions restent ouvertes', () =>
  withApp(async (app) => {
    const phone = await clientFor(app, 'alice', 'alice-password-1');
    const laptop = new Client(app);
    assert.equal((await laptop.login('alice', 'alice-password-1')).status, 200);
    const copy = { Cookie: phone.cookie };
    const ask = (p, extra) => rawRequest(app.port, { path: p, headers: Object.assign({}, copy, extra) });
    assert.equal((await ask('/api/auth/me')).status, 200);

    assert.equal((await phone.post('/api/auth/logout', {})).status, 200);
    const replay = await ask('/api/auth/me');
    assert.equal(replay.status, 401, 'le cookie copié avant la déconnexion ne vaut plus rien');
    assert.equal(replay.json.code, 'auth');
    assert.equal((await ask('/', NAVIGATION)).status, 302);
    assert.equal((await ask('/api/config')).status, 401);
    assert.equal((await ask('/api/c411/status')).status, 401);
    // signing out again with the copy changes nothing, and the other device keeps its own session
    const again = await rawRequest(app.port, { method: 'POST', path: '/api/auth/logout', headers: Object.assign({ 'X-Requested-With': 'arr411' }, copy), body: '{}' });
    assert.equal(again.status, 200);
    assert.equal((await laptop.get('/api/auth/me')).status, 200);
  }));

test('déconnexion : le cookie renouvelé et l’ancien sont la même session', () =>
  withApp(async (app) => {
    const boss = app.users.find('boss');
    const now = Date.now();
    const payloadOf = (token) => sessions.verify(token);
    const tokenOf = (res) => /^arr_session=([^;]+)/.exec(sessionCookieOf(res))[1];
    const me = (token) => rawRequest(app.port, { path: '/api/auth/me', headers: withCookie(token) });
    const logout = (token) => rawRequest(app.port, { method: 'POST', path: '/api/auth/logout', headers: Object.assign({ 'X-Requested-With': 'arr411' }, withCookie(token)), body: '{}' });

    for (const outWith of ['renewed', 'old']) {
      const old = sessions.sign(boss, now - 3 * DAY * 1000);
      const renewed = tokenOf(await me(old));
      assert.notEqual(renewed, old);
      assert.equal(payloadOf(renewed).sid, payloadOf(old).sid, 'le renouvellement garde la session');
      assert.equal((await me(old)).status, 200);
      assert.equal((await logout(outWith === 'renewed' ? renewed : old)).status, 200);
      assert.equal((await me(old)).status, 401, `l’ancien cookie après une déconnexion avec le cookie ${outWith}`);
      assert.equal((await me(renewed)).status, 401, `le cookie renouvelé après une déconnexion avec le cookie ${outWith}`);
    }
    // another sign-in is another session
    const other = sessions.sign(boss, now);
    assert.equal((await me(other)).status, 200);
  }));

test('sessions révoquées : conservées après un redémarrage, oubliées à l’échéance, liste bornée', async () => {
  const dir = h.tmpDir();
  const file = path.join(dir, 'revoked.json');
  const open = () => new Revoked(new JsonStore(file, () => ({ version: 1, sessions: {} })).load(), DAY);
  const a = open();
  const now = Date.now();
  const SID = 'AAAAAAAAAAAAAAAA';
  await a.revoke(SID, now);
  assert.ok(a.has(SID, now + 1000));
  assert.equal(a.has('BBBBBBBBBBBBBBBB', now + 1000), false);
  assert.ok(open().has(SID, now + 1000), 'écrite sur le disque');
  assert.equal(fs.readFileSync(file, 'utf8').includes(SID), true);
  assert.equal(a.has(SID, now + DAY * 1000 + 120 * 1000), false, 'plus aucun cookie de cette session ne peut être valide');
  for (const odd of ['__defineGetter__', 'constructor', 'hasOwnProperty', '', undefined, null, 42, {}]) assert.equal(a.has(odd), false, String(odd));

  // an expired entry disappears when the list is next written
  const b = open();
  b.store.data.sessions.CCCCCCCCCCCCCCCC = Math.floor(now / 1000) - 5;
  b.store.data.sessions.DDDDDDDDDDDDDDDD = 'pas une date';
  await b.revoke('EEEEEEEEEEEEEEEE', now);
  assert.deepEqual(Object.keys(b.store.data.sessions).sort(), [SID, 'EEEEEEEEEEEEEEEE']);

  // bounded: the entries closest to their end go first
  const c = open();
  const base = Math.floor(now / 1000) + 3600;
  for (let i = 0; i < MAX_ENTRIES + 25; i++) c.store.data.sessions[`s${String(i).padStart(15, '0')}`] = base + i;
  c.prune(now);
  const kept = Object.keys(c.store.data.sessions);
  assert.equal(kept.length, MAX_ENTRIES);
  assert.equal(c.has('s000000000000000', now), false);
  assert.ok(c.has(`s${String(MAX_ENTRIES + 24).padStart(15, '0')}`, now));
});

test('un cookie sans identifiant de session (ancien format) est refusé', () =>
  withApp(async (app) => {
    const boss = app.users.find('boss');
    const iat = Math.floor(Date.now() / 1000);
    const forge = (extra) => {
      const body = Buffer.from(JSON.stringify(Object.assign({ u: 'boss', sv: boss.sv, iat, exp: iat + DAY }, extra))).toString('base64url');
      return `v1.${body}.${sessions.mac(`v1.${body}`)}`;
    };
    const me = (token) => rawRequest(app.port, { path: '/api/auth/me', headers: withCookie(token) });
    assert.equal((await me(forge({ sid: 'AAAAAAAAAAAAAAAA' }))).status, 200, 'signé et complet');
    for (const sid of [undefined, '', 'court', 'A'.repeat(17), 'AAAAAAAAAAAAAAA!', 12345678901234567, ['AAAAAAAAAAAAAAAA']]) {
      assert.equal((await me(forge({ sid }))).status, 401, JSON.stringify(sid));
    }
  }));

test('page de connexion quand on est déjà connecté : retour à l’application, sans redirection ouverte', () =>
  withApp(async (app) => {
    const c = await adminClient(app);
    for (const [next, expected] of NEXT_CASES) {
      const r = await c.get('/login?next=' + encodeURIComponent(next));
      assert.equal(r.status, 302, next);
      assert.equal(r.headers.location, expected, next);
    }
    const bare = await c.get('/login');
    assert.equal(bare.headers.location, '/');
    assert.equal((await c.get('/login/')).headers.location, '/');
    // the static files of the login page stay reachable
    assert.equal((await c.get('/login/login.js')).status, 200);
  }));

test('page de connexion : après la saisie, le script applique la même règle de destination que le serveur', async () => {
  for (const [next, expected] of NEXT_CASES) assert.equal(await destinationAfterSignIn(next), expected, JSON.stringify(next));
});

test('formulaire sans JavaScript : POST /login renvoie vers la page, sans rien refléter', () =>
  withApp(async (app) => {
    const c = new Client(app);
    const r = await c.send('POST', '/login', { form: { username: 'boss', password: ADMIN.password, next: '/evil' }, csrf: false });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/login');
    assert.deepEqual(r.setCookie, []);
    assert.equal(r.text, '');
    assert.equal((await c.send('PUT', '/login', { body: 'x' })).status, 405);
    assert.equal((await c.send('DELETE', '/login/login.js')).status, 405);
  }));

test('/share affiche l’application (ou demande de se connecter en gardant la destination)', () =>
  withApp(async (app) => {
    const q = '/share?title=T&text=magnet%3A%3Fxt%3Durn%3Abtih%3Aabc&url=';
    const anon = await new Client(app).get(q, { headers: NAVIGATION });
    assert.equal(anon.status, 302);
    assert.equal(anon.headers.location, '/login?next=' + encodeURIComponent(q));
    const c = await adminClient(app);
    const [a, b] = [await c.get(q), await c.get('/')];
    assert.equal(a.status, 200);
    assert.equal(a.text, b.text);
  }));

test('protection CSRF des requêtes qui modifient quelque chose', () =>
  withApp(async (app) => {
    const origin = `http://127.0.0.1:${app.port}`;
    const login = (headers, o) => new Client(app).login(ADMIN.username, ADMIN.password, Object.assign({ headers }, o));

    assert.equal((await login({}, { csrf: false })).status, 403, 'sans X-Requested-With');
    assert.equal((await login({ 'X-Requested-With': 'XMLHttpRequest' })).status, 403, 'mauvaise valeur');
    assert.equal((await login({ Origin: 'https://evil.example' })).status, 403);
    assert.equal((await login({ Origin: 'null' })).status, 403);
    assert.equal((await login({ Origin: 'http://127.0.0.1.evil.example' })).status, 403);
    assert.equal((await login({ Origin: `http://127.0.0.1:${app.port + 1}` })).status, 403);
    assert.equal((await login({ Origin: `https://127.0.0.1:${app.port}` })).status, 200, 'seul l’hôte compte, pas le schéma');
    assert.equal((await login({ Origin: origin })).status, 200);
    // behind a Docker network name or a reverse proxy that keeps the Host header
    assert.equal((await login({ Host: 'arr411:3000', Origin: 'http://arr411:3000' })).status, 200);
    assert.equal((await login({ Host: 'arr411:3000', Origin: 'http://evil.example' })).status, 403);
    assert.equal((await login({ Host: 'arr411:3000', Origin: origin })).status, 403);
    // without Origin, the browser tells where the request comes from
    assert.equal((await login({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await login({ 'Sec-Fetch-Site': 'same-site' })).status, 403);
    assert.equal((await login({ 'Sec-Fetch-Site': 'same-origin' })).status, 200);
    assert.equal((await login({ 'Sec-Fetch-Site': 'none' })).status, 200);
    const refused = await login({ Origin: 'https://evil.example' });
    assert.equal(refused.headers['x-arr411-error'], 'error');
    assert.match(refused.json.message, /Origine refusée/);
    assert.deepEqual(refused.setCookie, []);

    // a signed-in browser tricked into a cross-site request changes nothing
    const c = await adminClient(app);
    for (const headers of [{ Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      assert.equal((await c.put('/api/prefs', { startTab: 'radarr' }, { headers })).status, 403);
      assert.equal((await c.post('/api/admin/users', { username: 'mallory', password: 'password-mallory' }, { headers })).status, 403);
      assert.equal((await c.del('/api/admin/users/boss', { headers })).status, 403);
      assert.equal((await c.post('/api/svc/qb/api/v2/torrents/add', {}, { headers })).status, 403);
    }
    for (const [method, p] of [['PUT', '/api/prefs'], ['POST', '/api/admin/users'], ['DELETE', '/api/admin/users/boss'], ['POST', '/api/auth/password'], ['POST', '/api/svc/radarr/api/v3/command'], ['PATCH', '/api/admin/users/boss']]) {
      const r = await c.send(method, p, { csrf: false, json: method === 'DELETE' ? undefined : {} });
      assert.equal(r.status, 403, `${method} ${p}`);
    }
    assert.equal(app.users.find('mallory'), null);
    assert.equal((await c.get('/api/config')).json.prefs.startTab, undefined);
    // reading never needs the header
    assert.equal((await c.get('/api/config', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  }));

test('cookies falsifiés, expirés ou périmés', () =>
  withApp(async (app) => {
    const boss = app.users.find('boss');
    const me = (token) => rawRequest(app.port, { path: '/api/auth/me', headers: withCookie(token) });
    const now = Date.now();

    const good = sessions.sign(boss, now);
    const r = await me(good);
    assert.equal(r.status, 200);
    assert.deepEqual(r.setCookie, [], 'pas de renouvellement pour un cookie tout frais');

    const [v, payload, mac] = good.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ u: 'boss', sv: boss.sv, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 10 * 365 * DAY })).toString('base64url');
    const bad = {
      'signature modifiée': good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A'),
      'contenu modifié': `${v}.${forgedPayload}.${mac}`,
      'tronqué': good.slice(0, -5),
      'sans signature': `${v}.${payload}`,
      'vide': '',
      'n’importe quoi': 'abc',
      'autre secret': new Sessions('un-autre-secret-assez-long-99', 7 * DAY).sign(boss, now),
      'expiré': sessions.sign(boss, now - 8 * DAY * 1000),
      'à l’échéance exacte': sessions.sign(boss, now - 7 * DAY * 1000 - 1000),
      'compte inconnu': sessions.sign({ username: 'fantome', sv: 1 }, now),
      'version de session périmée': sessions.sign({ username: 'boss', sv: boss.sv + 1 }, now),
      'version de session ancienne': sessions.sign({ username: 'boss', sv: 0.5 }, now)
    };
    for (const [why, token] of Object.entries(bad)) {
      const res = await me(token);
      assert.equal(res.status, 401, why);
      assert.equal(res.json.code, 'auth', why);
    }
    // a cookie that only lies about the user name keeps its old signature
    const nav = await rawRequest(app.port, { path: '/', headers: Object.assign({ 'Sec-Fetch-Mode': 'navigate' }, withCookie(bad['contenu modifié'])) });
    assert.equal(nav.status, 302);

    // still valid but older than a day: renewed, for another full period
    const old = sessions.sign(boss, now - 3 * DAY * 1000);
    const renewed = await me(old);
    assert.equal(renewed.status, 200);
    const fresh = sessionCookieOf(renewed);
    assert.ok(fresh, 'un cookie renouvelé est renvoyé');
    const payloadOf = (cookie) => sessions.verify(/^arr_session=([^;]+)/.exec(cookie)[1]);
    assert.ok(payloadOf(fresh).iat * 1000 >= now - 1000);
    assert.match(fresh, /Max-Age=604800/);
    assert.deepEqual((await me(sessions.sign(boss, now - 3600 * 1000))).setCookie, [], 'pas de renouvellement avant 24 h');
    // pages are renewed too, so a user who only reads stays signed in
    const page = await rawRequest(app.port, { path: '/', headers: withCookie(old) });
    assert.equal(page.status, 200);
    assert.ok(sessionCookieOf(page));
    // and an expired session is still refused even on a page
    assert.equal((await rawRequest(app.port, { path: '/core.js', headers: withCookie(bad['expiré']) })).status, 401);
  }));

test('désactiver, supprimer ou changer le mot de passe coupe les sessions', () =>
  withApp(async (app) => {
    const a1 = await clientFor(app, 'alice', 'alice-password-1');
    const a2 = new Client(app);
    assert.equal((await a2.login('alice', 'alice-password-1')).status, 200);
    const stillIn = async (c) => (await c.get('/api/auth/me')).status === 200;
    assert.ok(await stillIn(a1) && (await stillIn(a2)));

    // disabled: signed out at the next request, and old cookies do not come back when the account is enabled again
    await app.users.update('alice', { disabled: true });
    assert.equal((await a1.get('/api/auth/me')).status, 401);
    assert.equal((await a1.get('/core.js')).status, 401);
    assert.equal((await new Client(app).login('alice', 'alice-password-1')).status, 401, 'connexion impossible');
    await app.users.update('alice', { disabled: false });
    assert.equal((await a1.get('/api/auth/me')).status, 401, 'les anciens cookies restent morts');
    assert.equal((await a2.get('/api/auth/me')).status, 401);
    assert.equal((await a1.login('alice', 'alice-password-1')).status, 200);
    assert.ok(await stillIn(a1));

    // the user changes the password: this device stays signed in, the others are signed out
    const bad = await a1.post('/api/auth/password', { current: 'nope', password: 'new-password-123' });
    assert.equal(bad.status, 403);
    assert.equal(bad.headers['x-arr411-error'], 'bad-password');
    assert.equal((await a1.post('/api/auth/password', { current: '', password: 'new-password-123' })).status, 403);
    assert.equal((await a1.post('/api/auth/password', { current: 'alice-password-1', password: 'court' })).status, 400);
    assert.equal((await a1.post('/api/auth/password', { current: 'alice-password-1', password: 'x'.repeat(257) })).status, 400);
    assert.ok(await stillIn(a1), 'un échec ne déconnecte personne');
    const a3 = new Client(app);
    await a3.login('alice', 'alice-password-1');
    const ok = await a1.post('/api/auth/password', { current: 'alice-password-1', password: 'new-password-123' });
    assert.equal(ok.status, 200);
    assert.ok(sessionCookieOf(ok), 'cookie renouvelé pour cet appareil');
    assert.ok(await stillIn(a1));
    assert.equal(await stillIn(a3), false);
    assert.equal((await new Client(app).login('alice', 'alice-password-1')).status, 401);
    assert.equal((await new Client(app).login('alice', 'new-password-123')).status, 200);

    // deleted: gone
    await app.users.remove('alice');
    assert.equal(await stillIn(a1), false);
    assert.equal((await new Client(app).login('alice', 'new-password-123')).status, 401);
  }));

test('5 échecs sur un compte : bloqué, même avec le bon mot de passe ; les autres comptes ne sont pas touchés', () =>
  withApp(async (app) => {
    await app.users.create({ username: 'alice', password: 'alice-password-1', role: 'user' });
    const c = new Client(app);
    for (let i = 0; i < 5; i++) assert.equal((await c.login('boss', 'wrong-' + i)).status, 401, `essai ${i + 1}`);
    for (const headers of [undefined, { 'X-Forwarded-For': '9.9.9.9' }, { 'X-Forwarded-For': '1.1.1.1, 2.2.2.2' }]) {
      const r = await c.login('boss', ADMIN.password, { headers });
      assert.equal(r.status, 429);
      assert.equal(r.headers['x-arr411-error'], 'throttled');
      assert.equal(r.json.code, 'throttled');
      assert.match(r.json.message, /Trop de tentatives/);
      assert.ok(Number(r.headers['retry-after']) > 0 && Number(r.headers['retry-after']) <= 900);
      assert.deepEqual(r.setCookie, []);
    }
    assert.equal((await c.login(' BOSS ', ADMIN.password)).status, 429, 'la casse et les espaces ne contournent rien');
    assert.equal((await c.login('alice', 'alice-password-1')).status, 200, 'un autre compte, même adresse');
    assert.equal((await c.get('/api/auth/me')).json.user.username, 'alice');
  }));

test('10 échecs depuis une même adresse sur des comptes différents : l’adresse est bloquée', () =>
  withApp(async (app) => {
    const c = new Client(app);
    for (let i = 0; i < 10; i++) assert.equal((await c.login('inconnu' + i, 'whatever-' + i)).status, 401);
    const r = await c.login('boss', ADMIN.password);
    assert.equal(r.status, 429);
    assert.equal(r.headers['x-arr411-error'], 'throttled');
  }));

test('un succès remet le compteur du compte à zéro', () =>
  withApp(async (app) => {
    const c = new Client(app);
    for (let i = 0; i < 4; i++) assert.equal((await c.login('boss', 'wrong')).status, 401);
    assert.equal((await c.login()).status, 200);
    for (let i = 0; i < 4; i++) assert.equal((await new Client(app).login('boss', 'wrong')).status, 401, `après le succès, essai ${i + 1}`);
    assert.equal((await new Client(app).login()).status, 200);
  }));

test('changer de mot de passe : les mauvais mots de passe actuels comptent comme des échecs de connexion', () =>
  withApp(async (app) => {
    const c = await adminClient(app);
    for (let i = 0; i < 5; i++) assert.equal((await c.post('/api/auth/password', { current: 'wrong', password: 'new-password-123' })).status, 403);
    const r = await c.post('/api/auth/password', { current: ADMIN.password, password: 'new-password-123' });
    assert.equal(r.status, 429);
    assert.equal(r.headers['x-arr411-error'], 'throttled');
    assert.equal((await new Client(app).login()).status, 429, 'la connexion est bloquée aussi');
  }));

test('fichiers statiques : impossible de sortir du dossier public', () =>
  withApp(async (app) => {
    const c = await adminClient(app);
    const paths = [
      '/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json', '/%2E%2E%2Fpackage.json', '/..%2f..%2fserver/config.js', '/..%2F..%2Fserver%2Fconfig.js',
      '/.env', '/.git/config', '/%2eenv', '/%2e%2e%2f.env', '/core.js%00', '/a%5c..%5cb', '/..\\package.json', '/server/config.js', '/package.json', '/../../etc/passwd', '/..%2f..%2f..%2f..%2fetc%2fpasswd',
      '/login/..%2f..%2fserver/config.js', '/icons/..%2f..%2fserver/config.js', '/login/%2e%2e/%2e%2e/package.json', '/login/..%2fapp%2fcore.js', '/icons/..%2fapp%2fcore.js',
      '/app/core.js', '/public/app/core.js', '/node_modules/x', '/data/users.json', '/users.json', '/secret.key', '/login/.hidden', '/icons/.hidden', '/core.js/..%2fcore.js', '/%', '/%zz', '/\u00e9'
    ];
    for (const p of paths) {
      const r = await c.get(p.replace(/[^\x21-\x7e]/g, (ch) => encodeURIComponent(ch)));
      assert.ok(r.status === 400 || r.status === 404, `${p} -> ${r.status}`);
      assert.ok(!/module\.exports|"name": ?"arr411-web"|scrypt\$|require\(/.test(r.text), p);
    }
    // the files that do exist are served, and a directory serves its index
    assert.equal((await c.get('/core.js')).status, 200);
    assert.equal((await c.get('/index.html')).status, 200);
    assert.equal((await c.get('/index.html')).text, (await c.get('/')).text);
  }));

test('fichiers statiques : méthodes, ETag, compression, cache', () =>
  withApp(async (app) => {
    const c = await adminClient(app);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']) {
      const r = await c.send(method, '/core.js', { body: method === 'POST' ? '{}' : undefined });
      assert.equal(r.status, 405, method);
      assert.equal(r.headers.allow, 'GET, HEAD');
    }
    const first = await c.get('/core.js');
    assert.equal(first.status, 200);
    assert.match(first.headers['content-type'], /^(text|application)\/javascript/);
    assert.match(first.headers.etag, /^W\/"[\w-]+"$/);
    assert.equal(first.headers['cache-control'], 'no-cache');
    assert.match(first.headers.vary, /Accept-Encoding/);
    assert.ok(!first.headers['content-encoding']);
    assert.equal(Number(first.headers['content-length']), first.body.length);

    for (const inm of [first.headers.etag, first.headers.etag.slice(2), `"nope", ${first.headers.etag}`, '*']) {
      const r = await c.get('/core.js', { headers: { 'If-None-Match': inm } });
      assert.equal(r.status, 304, inm);
      assert.equal(r.body.length, 0);
      assert.equal(r.headers.etag, first.headers.etag);
    }
    assert.equal((await c.get('/core.js', { headers: { 'If-None-Match': '"other"' } })).status, 200);

    const gz = await c.get('/core.js', { headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(gunzip(gz.body), first.text);
    assert.ok(gz.body.length < first.body.length / 2);
    assert.equal(gz.headers.etag, first.headers.etag);

    const head = await c.send('HEAD', '/core.js');
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);

    const png = await c.get('/icons/icon-192.png', { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(png.headers['cache-control'], 'public, max-age=86400');
    assert.equal(png.headers['content-type'], 'image/png');
    assert.ok(!png.headers['content-encoding']);
    assert.equal(png.body.subarray(1, 4).toString(), 'PNG');
    assert.equal((await c.get('/')).headers['cache-control'], 'no-cache');
  }));

test('en-têtes de sécurité sur toutes les réponses', () =>
  withApp(async (app) => {
    const anon = new Client(app);
    const c = await adminClient(app);
    const responses = [
      await anon.get('/login'), await anon.get('/healthz'), await anon.get('/'), await anon.get('/api/config'), await anon.get('/icons/icon-192.png'), await anon.get('/manifest.webmanifest'),
      await anon.get('/login/nothing'), await c.get('/'), await c.get('/core.js'), await c.get('/nothing'), await c.get('/api/nope'), await c.get('/api/config'), await c.post('/login', {})
    ];
    for (const r of responses) {
      const csp = r.headers['content-security-policy'];
      assert.ok(csp, `CSP sur ${r.status}`);
      for (const d of ["default-src 'none'", "script-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "connect-src 'self'"]) assert.ok(csp.includes(d), d);
      assert.ok(!/script-src[^;]*unsafe/.test(csp), 'pas d’exécution de script inline');
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers['referrer-policy'], 'no-referrer');
      assert.equal(r.headers['x-frame-options'], 'DENY');
      assert.equal(r.headers['cross-origin-opener-policy'], 'same-origin');
      assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin');
      assert.match(r.headers['permissions-policy'], /camera=\(\)/);
      assert.equal(r.headers['strict-transport-security'], undefined, 'pas de HSTS en HTTP');
      assert.equal(r.headers['x-powered-by'], undefined);
      assert.equal(r.headers.server, undefined);
    }
  }));

test('API : route inconnue, JSON invalide, corps trop gros, URL trop longue', () =>
  withApp(async (app) => {
    const c = await adminClient(app);
    const unknown = await c.get('/api/nope');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.message, 'Route inconnue');
    assert.equal((await c.get('/api/auth')).status, 404);
    assert.equal((await c.get('/api/admin/users/boss')).status, 404);
    assert.equal((await c.post('/api/auth/me', {})).status, 404);
    assert.equal((await c.get('/api/auth/login')).status, 404, 'la connexion n’accepte que POST');

    const anon = new Client(app);
    const json = { 'Content-Type': 'application/json' };
    const invalid = await anon.send('POST', '/api/auth/login', { body: '{"username": "boss"', headers: json });
    assert.equal(invalid.status, 400);
    assert.equal((await anon.send('POST', '/api/auth/login', { body: '[]', headers: json })).status, 400);
    assert.equal((await anon.send('POST', '/api/auth/login', { body: 'null', headers: json })).status, 400);
    assert.equal((await anon.send('POST', '/api/auth/login', { body: '"boss"', headers: json })).status, 400);
    assert.equal((await anon.send('POST', '/api/auth/login', { body: '', headers: json })).status, 401, 'un corps vide vaut {}');
    const big = await anon.send('POST', '/api/auth/login', { body: JSON.stringify({ username: 'boss', password: 'x'.repeat(70 * 1024) }), headers: json });
    assert.equal(big.status, 413);
    assert.equal((await anon.login()).status, 200, 'le serveur reste utilisable');

    assert.equal((await c.get('/' + 'a'.repeat(9001))).status, 400);
    assert.equal((await c.get('/?' + 'a'.repeat(9001))).status, 400);
    assert.equal((await c.get('/' + 'a'.repeat(100))).status, 404);
  }));

test('premier démarrage sans ADMIN_PASSWORD : mot de passe généré, affiché une seule fois', async () => {
  const config = require('../server/config');
  const { start } = require('../server/index');
  const saved = { user: config.adminUser, password: config.adminPassword, dir: config.dataDir };
  const logged = [];
  const warn = console.warn;
  console.warn = (...a) => logged.push(a.join(' '));
  try {
    config.adminUser = '';
    config.adminPassword = '';
    config.dataDir = h.tmpDir();
    const app = await start({ port: 0, host: '127.0.0.1' });
    app.port = app.server.address().port;
    try {
      const text = logged.join('\n');
      const m = /Mot de passe temporaire \(affiché une seule fois\) : (\S+)/.exec(text);
      assert.ok(m, text);
      assert.match(m[1], /^[\w-]{16}$/);
      assert.match(text, /compte administrateur « admin »/);
      assert.deepEqual(app.users.all.map((u) => [u.username, u.role]), [['admin', 'admin']]);
      assert.equal((await new Client(app).login('admin', m[1])).status, 200);
      assert.equal((await new Client(app).login('admin', 'admin')).status, 401);
    } finally {
      await app.close();
    }
    // a restart with the same data: no new account, nothing logged
    logged.length = 0;
    const again = await start({ port: 0, host: '127.0.0.1' });
    try {
      assert.equal(again.users.all.length, 1);
      assert.equal(logged.length, 0);
    } finally {
      await again.close();
    }
    // a bad value is reported instead of silently creating a weak account
    config.dataDir = h.tmpDir();
    config.adminUser = 'bad name';
    await assert.rejects(start({ port: 0, host: '127.0.0.1' }), /ADMIN_USER \/ ADMIN_PASSWORD/);
    config.adminUser = 'boss';
    config.adminPassword = 'court';
    await assert.rejects(start({ port: 0, host: '127.0.0.1' }), /ADMIN_USER \/ ADMIN_PASSWORD/);
  } finally {
    console.warn = warn;
    Object.assign(config, { adminUser: saved.user, adminPassword: saved.password, dataDir: saved.dir });
  }
});
