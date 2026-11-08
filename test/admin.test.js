'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');

const SECRET = 'secret-de-test-assez-long-123456';
h.prepareEnv({ SESSION_SECRET: SECRET });

const config = require('../server/config');
const { start } = require('../server/index');
const { version } = require('../package.json');
const { Client, adminClient, clientFor, ADMIN } = h;

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const SERVICES = ['qb', 'radarr', 'sonarr', 'lidarr'];

async function withApp(fn) {
  const app = await h.startApp();
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

const readText = (app, name) => fs.readFileSync(path.join(app.dataDir, name), 'utf8');
const readJsonFile = (app, name) => JSON.parse(readText(app, name));
const rawJson = (client, method, url, body) => client.send(method, url, { body, headers: JSON_HEADERS });

function assertForbidden(r, what) {
  assert.equal(r.status, 403, what);
  assert.equal(r.json.code, 'forbidden', what);
  assert.equal(r.headers['x-arr411-error'], 'forbidden', what);
}

test('administration : réservée aux administrateurs, sans aucun effet pour un utilisateur simple', () =>
  withApp(async (app) => {
    const erin = await clientFor(app, 'erin', 'erin-password');
    const calls = [
      ['GET', '/api/admin/users'],
      ['POST', '/api/admin/users', { username: 'mallory', password: 'mallory-password', role: 'admin' }],
      ['PATCH', '/api/admin/users/erin', { role: 'admin' }],
      ['PATCH', '/api/admin/users/boss', { disabled: true }],
      ['PATCH', '/api/admin/users/boss', { password: 'owned-password-1' }],
      ['DELETE', '/api/admin/users/boss'],
      ['GET', '/api/admin/connections'],
      ['PUT', '/api/admin/connections/radarr', { url: 'http://radarr:7878', apiKey: 'key' }],
      ['PUT', '/api/admin/connections/qb', { url: 'http://qb:8080' }],
      ['PUT', '/api/admin/defaults', { radarrCategory: 'x' }],
      ['GET', '/api/admin/inconnu'],
      ['GET', '/api/admin/']
    ];
    for (const [method, url, body] of calls) {
      assertForbidden(await erin.send(method, url, body === undefined ? {} : { json: body }), `${method} ${url}`);
    }

    const admin = await adminClient(app);
    const list = (await admin.get('/api/admin/users')).json.users;
    assert.deepEqual(list.map((u) => [u.username, u.role, u.disabled]), [['boss', 'admin', false], ['erin', 'user', false]]);
    assert.equal((await admin.get('/api/admin/connections')).json.connections.radarr.url, '');
    assert.deepEqual((await erin.get('/api/config')).json.defaults, {});

    // un administrateur reçoit une vraie 404 sur une route inconnue
    assert.equal((await admin.get('/api/admin/inconnu')).status, 404);
    assert.equal((await admin.put('/api/admin/users', {})).status, 404);
  }));

test('comptes : création, validation, aucun secret dans les réponses ni dans le fichier', () =>
  withApp(async (app) => {
    const admin = await adminClient(app);
    let r = await admin.get('/api/admin/users');
    assert.equal(r.status, 200);
    assert.equal(r.json.users.length, 1);
    assert.deepEqual(Object.keys(r.json.users[0]).sort(), ['createdAt', 'disabled', 'lastLoginAt', 'role', 'username']);
    assert.equal(r.json.users[0].username, 'boss');
    assert.equal(r.json.users[0].role, 'admin');
    assert.ok(r.json.users[0].lastLoginAt, 'la connexion de l’administrateur est datée');

    r = await admin.post('/api/admin/users', { username: '  Alice ', password: 'alice-password-1' });
    assert.equal(r.status, 201);
    assert.deepEqual(r.json.user, { username: 'alice', role: 'user', disabled: false, createdAt: r.json.user.createdAt, lastLoginAt: null });
    assert.ok(!Number.isNaN(Date.parse(r.json.user.createdAt)));

    // identifiants refusés
    const badNames = ['', ' ', 'a', '-alice', '.alice', 'ali ce', 'alice/../x', 'ali\u00e7e', 'x'.repeat(65), ['alice2'], null, 42, {}];
    for (const username of badNames) {
      r = await admin.post('/api/admin/users', { username, password: 'valid-password-1' });
      assert.equal(r.status, 400, JSON.stringify(username));
      assert.equal(r.json.code, 'error');
    }
    assert.equal((await admin.post('/api/admin/users', { password: 'valid-password-1' })).status, 400, 'identifiant absent');

    // mots de passe refusés
    for (const password of ['', 'short', '1234567', 'x'.repeat(257), null, 12345678, ['12345678'], {}]) {
      r = await admin.post('/api/admin/users', { username: 'bob', password });
      assert.equal(r.status, 400, JSON.stringify(password));
    }
    assert.equal((await admin.post('/api/admin/users', { username: 'bob' })).status, 400, 'mot de passe absent');

    // rôles refusés
    for (const role of ['root', 'ADMIN', ['admin'], 1, {}]) {
      r = await admin.post('/api/admin/users', { username: 'bob', password: 'valid-password-1', role });
      assert.equal(r.status, 400, JSON.stringify(role));
    }

    // corps inutilisables
    for (const body of ['[]', 'null', '"alice"', '{']) assert.equal((await rawJson(admin, 'POST', '/api/admin/users', body)).status, 400, body);

    // doublons, quelle que soit la casse
    for (const username of ['alice', 'ALICE', ' Alice ']) {
      r = await admin.post('/api/admin/users', { username, password: 'valid-password-1' });
      assert.equal(r.status, 409, username);
    }

    // bornes acceptées
    assert.equal((await admin.post('/api/admin/users', { username: 'ab', password: '12345678' })).status, 201);
    assert.equal((await admin.post('/api/admin/users', { username: 'x'.repeat(64), password: 'x'.repeat(256), role: 'user' })).status, 201);
    assert.equal((await admin.post('/api/admin/users', { username: 'first.last@home-lab_1', password: 'valid-password-1', role: 'admin' })).status, 201);

    // rien de ce qui a été refusé n’existe
    const names = (await admin.get('/api/admin/users')).json.users.map((u) => u.username);
    assert.deepEqual(names, ['ab', 'alice', 'boss', 'first.last@home-lab_1', 'x'.repeat(64)]);

    // la personne créée peut se connecter (casse libre) ; elle a le rôle demandé
    const alice = new Client(app);
    assert.equal((await alice.login('Alice', 'alice-password-1')).status, 200);
    assert.deepEqual((await alice.get('/api/auth/me')).json, { user: { username: 'alice', role: 'user' } });
    assert.equal((await alice.get('/api/admin/users')).status, 403);
    const first = new Client(app);
    assert.equal((await first.login('first.last@home-lab_1', 'valid-password-1')).status, 200);
    assert.equal((await first.get('/api/admin/users')).status, 200);

    // aucun secret dans les réponses, ni en clair dans le fichier
    const listText = (await admin.get('/api/admin/users')).text;
    for (const word of ['scrypt', 'hash', '"sv"', 'password', 'alice-password-1']) assert.ok(!listText.includes(word), word);
    const file = readText(app, 'users.json');
    for (const clear of ['alice-password-1', ADMIN.password, 'valid-password-1']) assert.ok(!file.includes(clear), `${clear} en clair dans users.json`);
    assert.ok(readJsonFile(app, 'users.json').users.every((u) => /^scrypt\$/.test(u.hash)));
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(app.dataDir, 'users.json')).mode & 0o077, 0, 'users.json illisible par les autres');
  }));

test('comptes : plusieurs créations simultanées, un même nom ne peut être créé qu’une fois', () =>
  withApp(async (app) => {
    const admin = await adminClient(app);
    const both = await Promise.all([
      admin.post('/api/admin/users', { username: 'twin', password: 'twin-password-1' }),
      admin.post('/api/admin/users', { username: 'twin', password: 'twin-password-2' })
    ]);
    assert.deepEqual(both.map((r) => r.status).sort(), [201, 409]);
    const winner = both.find((r) => r.status === 201);
    const password = winner === both[0] ? 'twin-password-1' : 'twin-password-2';
    assert.equal((await new Client(app).login('twin', password)).status, 200);

    const many = await Promise.all(['u1', 'u2', 'u3', 'u4', 'u5'].map((username) => admin.post('/api/admin/users', { username, password: `${username}-password` })));
    assert.deepEqual(many.map((r) => r.status), [201, 201, 201, 201, 201]);
    const expected = ['boss', 'twin', 'u1', 'u2', 'u3', 'u4', 'u5'];
    assert.deepEqual((await admin.get('/api/admin/users')).json.users.map((u) => u.username), expected);
    assert.deepEqual(readJsonFile(app, 'users.json').users.map((u) => u.username).sort(), expected, 'tout est dans le fichier');
  }));

test('rôles : promotion et rétrogradation prennent effet tout de suite, sans nouvelle connexion', () =>
  withApp(async (app) => {
    const admin = await adminClient(app);
    const erin = await clientFor(app, 'erin', 'erin-password');
    assert.equal((await erin.get('/api/admin/users')).status, 403);

    let r = await admin.patch('/api/admin/users/erin', { role: 'admin' });
    assert.equal(r.status, 200);
    assert.equal(r.json.user.role, 'admin');
    assert.equal((await erin.get('/api/admin/users')).status, 200, 'la session existante a les nouveaux droits');
    assert.equal((await erin.get('/api/auth/me')).json.user.role, 'admin');

    r = await admin.patch('/api/admin/users/ERIN', { role: 'user' });
    assert.equal(r.status, 200);
    assert.equal((await erin.get('/api/admin/users')).status, 403);
    assert.equal((await erin.get('/api/auth/me')).json.user.role, 'user');

    for (const role of ['root', 'ADMIN', ['admin'], 1, {}, null]) {
      assert.equal((await admin.patch('/api/admin/users/erin', { role })).status, 400, JSON.stringify(role));
    }
    assert.equal(app.users.find('erin').role, 'user');

    // une modification vide ne change rien
    r = await admin.patch('/api/admin/users/erin', {});
    assert.equal(r.status, 200);
    assert.equal(r.json.user.role, 'user');
    assert.equal((await erin.get('/api/auth/me')).status, 200);
  }));

test('un administrateur ne peut pas se couper lui-même ; un autre administrateur le peut', () =>
  withApp(async (app) => {
    const boss = await adminClient(app);
    for (const [method, body] of [['PATCH', { role: 'user' }], ['PATCH', { disabled: true }], ['PATCH', { password: 'another-password-1' }], ['DELETE']]) {
      const r = await boss.send(method, '/api/admin/users/boss', body ? { json: body } : {});
      assert.equal(r.status, 409, `${method} ${JSON.stringify(body)}`);
    }
    // des valeurs inchangées ne sont pas une modification
    assert.equal((await boss.patch('/api/admin/users/boss', { role: 'admin', disabled: false })).status, 200);
    assert.equal((await boss.get('/api/admin/users')).status, 200, 'la session est intacte');
    assert.equal((await new Client(app).login()).status, 200, 'l’ancien mot de passe fonctionne toujours');

    const root2 = await clientFor(app, 'root2', 'root2-password', 'admin');
    let r = await root2.patch('/api/admin/users/boss', { role: 'user' });
    assert.equal(r.status, 200, 'un autre administrateur peut le rétrograder');
    assert.equal((await boss.get('/api/admin/users')).status, 403);

    // root2 est le seul administrateur actif : il ne peut pas se retirer à son tour
    for (const [method, body] of [['PATCH', { role: 'user' }], ['PATCH', { disabled: true }], ['DELETE']]) {
      r = await root2.send(method, '/api/admin/users/root2', body ? { json: body } : {});
      assert.equal(r.status, 409, method);
    }
    assert.equal(app.users.activeAdmins().length, 1);
    assert.equal((await root2.get('/api/admin/users')).status, 200);
  }));

test('désactiver, réactiver, réinitialiser le mot de passe, supprimer : chaque action coupe les sessions concernées', () =>
  withApp(async (app) => {
    const admin = await adminClient(app);
    const erin = await clientFor(app, 'erin', 'erin-password');
    assert.equal((await erin.get('/api/auth/me')).status, 200);

    // désactivation
    let r = await admin.patch('/api/admin/users/erin', { disabled: 'yes' });
    assert.equal(r.status, 400);
    assert.equal((await erin.get('/api/auth/me')).status, 200, 'refusé : rien n’a changé');
    r = await admin.patch('/api/admin/users/erin', { disabled: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.user.disabled, true);
    assert.equal((await erin.get('/api/auth/me')).status, 401);
    r = await new Client(app).login('erin', 'erin-password');
    assert.equal(r.status, 401);
    assert.equal(r.json.code, 'bad-credentials');

    // réactivation : l’ancien cookie ne revient pas, une nouvelle connexion fonctionne
    r = await admin.patch('/api/admin/users/erin', { disabled: false });
    assert.equal(r.json.user.disabled, false);
    assert.equal((await erin.get('/api/auth/me')).status, 401, 'les anciennes sessions ne reviennent pas');
    const erin2 = new Client(app);
    assert.equal((await erin2.login('erin', 'erin-password')).status, 200);
    assert.equal((await erin2.get('/api/auth/me')).status, 200);

    // réinitialisation : validée en entier avant d’être appliquée
    r = await admin.patch('/api/admin/users/erin', { password: 'short' });
    assert.equal(r.status, 400);
    r = await admin.patch('/api/admin/users/erin', { role: 'admin', password: 'short' });
    assert.equal(r.status, 400);
    assert.equal(app.users.find('erin').role, 'user', 'le rôle n’a pas été appliqué avec un mot de passe refusé');
    r = await admin.patch('/api/admin/users/erin', { role: 'root', password: 'brand-new-password' });
    assert.equal(r.status, 400);
    assert.equal((await erin2.get('/api/auth/me')).status, 200, 'le mot de passe n’a pas été changé avec un rôle refusé');

    r = await admin.patch('/api/admin/users/erin', { password: 'brand-new-password' });
    assert.equal(r.status, 200);
    assert.equal(r.json.user.username, 'erin');
    assert.ok(!r.text.includes('brand-new-password'));
    assert.equal((await erin2.get('/api/auth/me')).status, 401, 'la réinitialisation coupe les sessions');
    assert.equal((await new Client(app).login('erin', 'erin-password')).status, 401, 'l’ancien mot de passe est refusé');
    const erin3 = new Client(app);
    assert.equal((await erin3.login('erin', 'brand-new-password')).status, 200);

    // suppression
    r = await admin.del('/api/admin/users/erin');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    assert.equal((await erin3.get('/api/auth/me')).status, 401);
    assert.equal((await new Client(app).login('erin', 'brand-new-password')).status, 401);
    assert.equal((await admin.del('/api/admin/users/erin')).status, 404);
    assert.equal((await admin.patch('/api/admin/users/erin', { disabled: true })).status, 404);
    assert.equal(app.users.find('erin'), null);

    // un identifiant illisible ou inconnu
    assert.equal((await admin.patch('/api/admin/users/%E0%A4%A', { disabled: true })).status, 400);
    assert.equal((await admin.patch('/api/admin/users/a%2Fb', { disabled: true })).status, 404);
    assert.equal((await admin.del('/api/admin/users/')).status, 404);
  }));

test('un compte supprimé puis recréé avec le même nom ne récupère aucune ancienne session', () =>
  withApp(async (app) => {
    const admin = await adminClient(app);
    const old = await clientFor(app, 'bob', 'bob-password-1');
    assert.equal((await old.get('/api/auth/me')).status, 200);
    assert.equal((await admin.del('/api/admin/users/bob')).status, 200);
    assert.equal((await old.get('/api/auth/me')).status, 401);

    assert.equal((await admin.post('/api/admin/users', { username: 'bob', password: 'bob-password-2' })).status, 201);
    assert.equal((await old.get('/api/auth/me')).status, 401, 'le vieux cookie n’ouvre pas le nouveau compte');
    const fresh = new Client(app);
    assert.equal((await fresh.login('bob', 'bob-password-2')).status, 200);
    assert.equal((await fresh.get('/api/auth/me')).status, 200);
  }));

test('connexions : secrets gardés côté serveur, adresses validées, révision qui change à chaque enregistrement', () =>
  withApp(async (app) => {
    const admin = await adminClient(app);
    const erin = await clientFor(app, 'erin', 'erin-password');
    const SECRETS = ['KEY-radarr-123', 'qb-s3cret-pass', 'KEY-sonarr-456', 'KEY-lidarr-789'];
    const noSecret = (r, what) => {
      for (const s of SECRETS) assert.ok(!r.text.includes(s), `${what} contient ${s}`);
    };
    const configFile = () => readJsonFile(app, 'config.json');

    // au départ : rien n’est configuré
    let r = await admin.get('/api/admin/connections');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.connections, {
      qb: { url: '', publicUrl: '', username: '', hasPassword: false },
      radarr: { url: '', publicUrl: '', hasKey: false },
      sonarr: { url: '', publicUrl: '', hasKey: false },
      lidarr: { url: '', publicUrl: '', hasKey: false }
    });
    r = await erin.get('/api/config');
    for (const svc of SERVICES) assert.deepEqual(r.json.services[svc], { configured: false, web: '', rev: 1 }, svc);

    // Radarr : adresse nettoyée, clé nettoyée et jamais renvoyée
    r = await admin.put('/api/admin/connections/radarr', { url: ' http://radarr:7878/ ', apiKey: '  KEY-radarr-123 ', publicUrl: 'https://radarr.example.org/' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { connection: { url: 'http://radarr:7878', publicUrl: 'https://radarr.example.org', hasKey: true }, rev: 2 });
    noSecret(r, 'la réponse');
    assert.deepEqual(configFile().connections.radarr, { url: 'http://radarr:7878', apiKey: 'KEY-radarr-123', publicUrl: 'https://radarr.example.org' });
    r = await erin.get('/api/config');
    assert.deepEqual(r.json.services.radarr, { configured: true, web: 'https://radarr.example.org', rev: 2 });
    assert.equal(r.headers['cache-control'], 'no-store');
    noSecret(r, '/api/config (utilisateur)');
    noSecret(await admin.get('/api/config'), '/api/config (administrateur)');
    noSecret(await admin.get('/api/admin/connections'), 'la liste des connexions');
    assert.equal((await admin.get('/api/admin/connections')).json.connections.radarr.hasKey, true);

    // même hôte, autre chemin : la clé suit, la révision avance
    r = await admin.put('/api/admin/connections/radarr', { url: 'http://radarr:7878/radarr/' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { connection: { url: 'http://radarr:7878/radarr', publicUrl: 'https://radarr.example.org', hasKey: true }, rev: 3 });
    assert.equal(configFile().connections.radarr.apiKey, 'KEY-radarr-123');

    // autre hôte, autre port ou autre protocole sans nouvelle clé : refusé, rien ne change
    const before = readText(app, 'config.json');
    for (const url of ['http://evil.example:7878', 'http://radarr:7879', 'https://radarr:7878']) {
      r = await admin.put('/api/admin/connections/radarr', { url });
      assert.equal(r.status, 400, url);
      assert.match(r.json.message, /saisis à nouveau/);
      assert.equal(readText(app, 'config.json'), before, `${url} : fichier inchangé`);
    }
    // avec une nouvelle clé, le changement d’adresse est accepté
    r = await admin.put('/api/admin/connections/radarr', { url: 'http://radarr2:7878', apiKey: 'KEY-radarr-123' });
    assert.equal(r.status, 200);
    assert.equal(r.json.connection.url, 'http://radarr2:7878');
    assert.equal(r.json.rev, 4);

    // adresses invalides : refusées, fichier inchangé
    const saved = readText(app, 'config.json');
    const badUrls = ['radarr:7878', 'ftp://radarr', 'javascript:alert(1)', 'file:///etc/passwd', 'http://u:p@radarr', 'http://radarr/?a=1', 'http://radarr/#x', 'http://', ['http://radarr'], {}, 5, true, null];
    for (const url of badUrls) {
      r = await admin.put('/api/admin/connections/radarr', { url, apiKey: 'KEY-radarr-123' });
      assert.equal(r.status, 400, JSON.stringify(url));
    }
    assert.equal((await admin.put('/api/admin/connections/radarr', { apiKey: 'KEY-radarr-123' })).status, 400, 'adresse absente : pas de suppression');
    assert.equal((await admin.put('/api/admin/connections/radarr', { publicUrl: 'https://x.example' })).status, 400);
    for (const publicUrl of ['javascript:alert(1)', 'ftp://x', 'x.example', 'http://u:p@x', 5]) {
      r = await admin.put('/api/admin/connections/radarr', { url: 'http://radarr2:7878', publicUrl });
      assert.equal(r.status, 400, `publicUrl ${JSON.stringify(publicUrl)}`);
    }
    assert.equal(readText(app, 'config.json'), saved, 'les refus ne modifient rien');
    for (const body of ['[]', 'null', '"x"', '{']) assert.equal((await rawJson(admin, 'PUT', '/api/admin/connections/radarr', body)).status, 400, body);

    // adresse publique effacée
    r = await admin.put('/api/admin/connections/radarr', { url: 'http://radarr2:7878', publicUrl: '' });
    assert.equal(r.json.connection.publicUrl, '');
    assert.equal((await erin.get('/api/config')).json.services.radarr.web, '');

    // une adresse sans clé : enregistrée, mais le service n’est pas utilisable
    r = await admin.put('/api/admin/connections/sonarr', { url: 'http://sonarr:8989' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.connection, { url: 'http://sonarr:8989', publicUrl: '', hasKey: false });
    assert.equal((await erin.get('/api/config')).json.services.sonarr.configured, false);
    r = await admin.put('/api/admin/connections/sonarr', { url: 'http://sonarr:8989', apiKey: '   ' });
    assert.equal(r.json.connection.hasKey, false, 'une clé vide n’est pas une clé');
    r = await admin.put('/api/admin/connections/sonarr', { url: 'http://sonarr:8989', apiKey: 'KEY-sonarr-456' });
    assert.equal(r.json.connection.hasKey, true);
    assert.equal((await erin.get('/api/config')).json.services.sonarr.configured, true);

    // Lidarr
    r = await admin.put('/api/admin/connections/lidarr', { url: 'https://lidarr.example.org/lidarr', apiKey: 'KEY-lidarr-789' });
    assert.equal(r.json.connection.url, 'https://lidarr.example.org/lidarr');

    // qBittorrent : identifiant, mot de passe, mot de passe conservé ou effacé
    r = await admin.put('/api/admin/connections/qb', { url: 'http://qb:8080/', username: '  admin ', password: 'qb-s3cret-pass' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.connection, { url: 'http://qb:8080', publicUrl: '', username: 'admin', hasPassword: true });
    noSecret(r, 'la réponse qBittorrent');
    assert.deepEqual(configFile().connections.qb, { url: 'http://qb:8080', username: 'admin', password: 'qb-s3cret-pass', publicUrl: '' });
    r = await admin.put('/api/admin/connections/qb', { url: 'http://qb:8080', username: 'other', password: '' });
    assert.deepEqual(r.json.connection, { url: 'http://qb:8080', publicUrl: '', username: 'other', hasPassword: true }, 'un mot de passe vide veut dire « inchangé »');
    assert.equal(configFile().connections.qb.password, 'qb-s3cret-pass');
    r = await admin.put('/api/admin/connections/qb', { url: 'http://qb:9090', username: 'other' });
    assert.equal(r.status, 400, 'autre port sans nouveau mot de passe');
    r = await admin.put('/api/admin/connections/qb', { url: 'http://qb:8080', clearPassword: true });
    assert.deepEqual(r.json.connection, { url: 'http://qb:8080', publicUrl: '', username: 'other', hasPassword: false });
    r = await admin.put('/api/admin/connections/qb', { url: 'http://qb:9090' });
    assert.equal(r.status, 200, 'sans mot de passe enregistré, l’adresse peut changer librement');
    assert.equal((await erin.get('/api/config')).json.services.qb.configured, true, 'qBittorrent sans identifiants (accès local) est utilisable');

    // jamais un secret dans ce que voit un utilisateur ou l’administrateur
    for (const [client, url] of [[erin, '/api/config'], [admin, '/api/config'], [admin, '/api/admin/connections'], [admin, '/api/admin/users'], [erin, '/api/auth/me']]) {
      noSecret(await client.get(url), url);
    }

    // une adresse vide supprime la connexion, secrets compris
    const revBefore = (await erin.get('/api/config')).json.services.radarr.rev;
    r = await admin.put('/api/admin/connections/radarr', { url: '' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.connection, { url: '', publicUrl: '', hasKey: false });
    assert.equal(r.json.rev, revBefore + 1);
    assert.equal(configFile().connections.radarr, undefined);
    assert.ok(!readText(app, 'config.json').includes('KEY-radarr-123'));
    assert.equal((await erin.get('/api/config')).json.services.radarr.configured, false);
    r = await admin.put('/api/admin/connections/radarr', { url: 'http://radarr:7878', apiKey: 'KEY-radarr-123' });
    assert.equal(r.json.rev, revBefore + 2, 'la révision ne revient jamais en arrière');

    // services et méthodes inconnus
    for (const [method, url, body] of [
      ['PUT', '/api/admin/connections/foo', { url: 'http://x' }],
      ['PUT', '/api/admin/connections/__proto__', { url: 'http://x' }],
      ['PUT', '/api/admin/connections/Radarr', { url: 'http://x' }],
      ['PUT', '/api/admin/connections/radarr/extra', { url: 'http://x' }],
      ['GET', '/api/admin/connections/radarr'],
      ['DELETE', '/api/admin/connections/radarr'],
      ['POST', '/api/admin/connections', { url: 'http://x' }]
    ]) {
      r = await admin.send(method, url, body ? { json: body } : {});
      assert.equal(r.status, 404, `${method} ${url}`);
    }
  }));

test('/api/config : forme, version, résumé des services', () =>
  withApp(async (app) => {
    const admin = await adminClient(app);
    const erin = await clientFor(app, 'erin', 'erin-password');
    for (const [client, username, role] of [[admin, 'boss', 'admin'], [erin, 'erin', 'user']]) {
      const r = await client.get('/api/config');
      assert.equal(r.status, 200);
      assert.deepEqual(Object.keys(r.json).sort(), ['defaults', 'prefs', 'services', 'user', 'version']);
      assert.equal(r.json.version, version);
      assert.deepEqual(r.json.user, { username, role });
      assert.deepEqual(Object.keys(r.json.services).sort(), ['lidarr', 'qb', 'radarr', 'sonarr']);
      for (const svc of SERVICES) assert.deepEqual(Object.keys(r.json.services[svc]).sort(), ['configured', 'rev', 'web'], svc);
      assert.equal(r.headers['cache-control'], 'no-store');
    }
    assert.equal((await new Client(app).get('/api/config')).status, 401);
  }));

test('valeurs par défaut du serveur : clés connues seulement, valeurs validées, tout ou rien', () =>
  withApp(async (app) => {
    const admin = await adminClient(app);
    const erin = await clientFor(app, 'erin', 'erin-password');
    let r = await admin.put('/api/admin/defaults', { radarrCategory: 'films', radarrProfile: 4, sonarrRoot: '/tv', inconnue: 'x', username: 'boss' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { defaults: { radarrCategory: 'films', radarrProfile: 4, sonarrRoot: '/tv' } });
    assert.deepEqual((await erin.get('/api/config')).json.defaults, r.json.defaults, 'les utilisateurs voient les mêmes valeurs');
    assert.deepEqual(readJsonFile(app, 'config.json').defaults, r.json.defaults);

    // mise à jour partielle ; null et chaîne vide effacent
    r = await admin.put('/api/admin/defaults', { radarrCategory: null, sonarrRoot: '', defaultCategory: 'tout' });
    assert.deepEqual(r.json.defaults, { radarrProfile: 4, defaultCategory: 'tout' });
    const before = JSON.stringify(r.json.defaults);

    // tout ou rien : une valeur refusée n’applique pas les autres
    const bad = [{ radarrProfile: {} }, { radarrProfile: [] }, { radarrProfile: true }, { sonarrRoot: 'x'.repeat(501) }, { lidarrProfile: ['1'] }];
    for (const one of bad) {
      r = await admin.put('/api/admin/defaults', Object.assign({ lidarrCategory: 'musique' }, one));
      assert.equal(r.status, 400, JSON.stringify(one).slice(0, 50));
    }
    r = await rawJson(admin, 'PUT', '/api/admin/defaults', '{"lidarrCategory":"musique","radarrProfile":1e999}');
    assert.equal(r.status, 400, 'un nombre infini n’est pas une valeur');
    r = await admin.put('/api/admin/defaults', {});
    assert.equal(JSON.stringify(r.json.defaults), before, 'rien n’a été appliqué');
    for (const body of ['[]', 'null', '"x"', '{']) assert.equal((await rawJson(admin, 'PUT', '/api/admin/defaults', body)).status, 400, body);

    // pas de pollution de prototype
    r = await rawJson(admin, 'PUT', '/api/admin/defaults', '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"lidarrCategory":"musique"}');
    assert.equal(r.status, 200);
    assert.equal({}.polluted, undefined);
    assert.equal(Object.getPrototypeOf(r.json.defaults), Object.prototype);
    assert.deepEqual(Object.keys(r.json.defaults).sort(), ['defaultCategory', 'lidarrCategory', 'radarrProfile']);
    assert.ok(!readText(app, 'config.json').includes('polluted'));
  }));

test('préférences : propres à chaque utilisateur, valeurs validées, rien d’autre que les clés prévues', () =>
  withApp(async (app) => {
    const admin = await adminClient(app);
    const erin = await clientFor(app, 'erin', 'erin-password');
    let r = await erin.put('/api/prefs', { startTab: 'radarr', lastCategory: 'films', notifyDone: true });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { prefs: { startTab: 'radarr', lastCategory: 'films', notifyDone: true } });
    assert.deepEqual((await erin.get('/api/config')).json.prefs, r.json.prefs);
    assert.deepEqual((await admin.get('/api/config')).json.prefs, {}, 'les préférences d’erin ne sont pas celles de l’administrateur');

    // mise à jour partielle : fusion
    r = await erin.put('/api/prefs', { startTab: 'last' });
    assert.deepEqual(r.json.prefs, { startTab: 'last', lastCategory: 'films', notifyDone: true });

    // valeurs invalides et clés inconnues ignorées ; aucune élévation de droits
    r = await erin.put('/api/prefs', { startTab: 'nope', lastCategory: 5, notifyDone: 'yes', role: 'admin', username: 'boss', disabled: true, hash: 'x', sv: 1 });
    assert.deepEqual(r.json.prefs, { startTab: 'last', lastCategory: 'films', notifyDone: true });
    assert.deepEqual((await erin.get('/api/auth/me')).json.user, { username: 'erin', role: 'user' });
    assert.equal((await erin.get('/api/admin/users')).status, 403);
    assert.equal(app.users.find('erin').disabled, false);

    // limite de longueur
    assert.equal((await erin.put('/api/prefs', { lastCategory: 'x'.repeat(100) })).json.prefs.lastCategory, 'x'.repeat(100));
    assert.equal((await erin.put('/api/prefs', { lastCategory: 'y'.repeat(101) })).json.prefs.lastCategory, 'x'.repeat(100), 'trop long : ignoré');
    assert.equal((await erin.put('/api/prefs', { lastCategory: '' })).json.prefs.lastCategory, '', 'vide : accepté');

    for (const tab of ['c411', 'radarr', 'sonarr', 'lidarr', 'last', 'qbit']) {
      assert.equal((await erin.put('/api/prefs', { startTab: tab })).json.prefs.startTab, tab, tab);
    }
    assert.equal((await erin.put('/api/prefs', { startTab: 'settings' })).json.prefs.startTab, 'qbit', 'onglet inconnu : ignoré');
    assert.equal((await erin.put('/api/prefs', { notifyDone: false })).json.prefs.notifyDone, false);

    // corps inutilisables ; un corps vide ne change rien
    for (const body of ['[]', 'null', '"x"', '1', '{']) assert.equal((await rawJson(erin, 'PUT', '/api/prefs', body)).status, 400, body);
    r = await erin.send('PUT', '/api/prefs', {});
    assert.equal(r.status, 200);
    assert.equal(r.json.prefs.startTab, 'qbit');

    // conservées d’une connexion à l’autre, et dans le fichier
    const expected = { startTab: 'qbit', lastCategory: '', notifyDone: false };
    const again = new Client(app);
    assert.equal((await again.login('erin', 'erin-password')).status, 200);
    assert.deepEqual((await again.get('/api/config')).json.prefs, expected);
    const stored = readJsonFile(app, 'users.json').users;
    assert.deepEqual(stored.find((u) => u.username === 'erin').prefs, expected);
    assert.deepEqual(stored.find((u) => u.username === 'boss').prefs, {});
  }));

test('redémarrage : comptes, connexions, préférences et sessions conservés ; ADMIN_PASSWORD ne revient pas', async () => {
  const app = await h.startApp();
  const dir = app.dataDir;
  let app2;
  try {
    const admin = await adminClient(app);
    assert.equal((await admin.post('/api/admin/users', { username: 'alice', password: 'alice-password-1' })).status, 201);
    assert.equal((await admin.put('/api/admin/connections/radarr', { url: 'http://radarr:7878', apiKey: 'KEY-1', publicUrl: 'https://radarr.example.org' })).status, 200);
    assert.equal((await admin.put('/api/admin/defaults', { radarrCategory: 'films' })).status, 200);
    const alice = await clientFor(app, 'alice', 'alice-password-1');
    assert.equal((await alice.put('/api/prefs', { startTab: 'sonarr' })).status, 200);
    // l’administrateur change son mot de passe : celui de l’environnement ne doit pas revenir
    assert.equal((await admin.post('/api/auth/password', { current: ADMIN.password, password: 'a-brand-new-admin-password' })).status, 200);
    const rev = (await admin.get('/api/config')).json.services.radarr.rev;
    await app.close();

    config.dataDir = dir;
    app2 = await start({ port: 0, host: '127.0.0.1' });
    app2.port = app2.server.address().port;
    admin.port = app2.port;
    alice.port = app2.port;

    assert.equal((await admin.get('/api/auth/me')).json.user.username, 'boss', 'le cookie de l’administrateur est toujours valable');
    assert.equal((await alice.get('/api/auth/me')).json.user.username, 'alice');
    assert.equal((await new Client(app2).login()).status, 401, 'le mot de passe de ADMIN_PASSWORD ne rouvre pas le compte');
    assert.equal((await new Client(app2).login('boss', 'a-brand-new-admin-password')).status, 200);
    assert.deepEqual((await admin.get('/api/admin/users')).json.users.map((u) => u.username), ['alice', 'boss'], 'pas de second administrateur créé');

    const cfg = (await alice.get('/api/config')).json;
    assert.deepEqual(cfg.services.radarr, { configured: true, web: 'https://radarr.example.org', rev });
    assert.deepEqual(cfg.defaults, { radarrCategory: 'films' });
    assert.deepEqual(cfg.prefs, { startTab: 'sonarr' });
    assert.equal((await admin.get('/api/admin/connections')).json.connections.radarr.hasKey, true);
  } finally {
    if (app2) await app2.close();
    else await app.close().catch(() => {});
  }
});

test('fichiers de données illisibles : le démarrage échoue avec un message clair, sans rien écraser', async () => {
  const cases = [
    ['users.json', '{"users": ['],
    ['users.json', 'null'],
    ['users.json', '[]'],
    ['users.json', '"texte"'],
    ['config.json', 'oups'],
    ['config.json', 'null'],
    ['config.json', '[1,2]']
  ];
  for (const [file, content] of cases) {
    const dir = h.tmpDir();
    fs.writeFileSync(path.join(dir, file), content);
    config.dataDir = dir;
    await assert.rejects(
      start({ port: 0, host: '127.0.0.1' }),
      (e) => e.message.includes('Impossible de lire') && e.message.includes(file) && e.message.includes('Corrige ou supprime'),
      `${file} : ${content}`
    );
    assert.equal(fs.readFileSync(path.join(dir, file), 'utf8'), content, `${file} n’a pas été modifié`);
  }

  // des objets vides sont acceptés : c’est comme un premier démarrage
  const dir = h.tmpDir();
  fs.writeFileSync(path.join(dir, 'users.json'), '{}');
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  config.dataDir = dir;
  const app = await start({ port: 0, host: '127.0.0.1' });
  app.port = app.server.address().port;
  try {
    const admin = await adminClient(app);
    const cfg = (await admin.get('/api/config')).json;
    assert.equal(cfg.services.qb.configured, false);
    assert.deepEqual(cfg.defaults, {});
    assert.equal((await admin.put('/api/admin/connections/qb', { url: 'http://qb:8080' })).status, 200, 'et la configuration reste modifiable');
  } finally {
    await app.close();
  }
});
