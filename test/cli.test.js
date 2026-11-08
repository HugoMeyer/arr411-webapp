'use strict';
// Gestion des comptes en ligne de commande. On lance vraiment `node server/cli.js`,
// comme `docker compose exec arr411 node server/cli.js …`.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');

h.prepareEnv();
const config = require('../server/config');
const { start } = require('../server/index');
const { Client } = h;

const CLI = path.join(__dirname, '..', 'server', 'cli.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Le serveur relit users.json au plus une fois par seconde.
const settle = () => sleep(1100);

function cli(dataDir, ...args) {
  const env = Object.assign({}, process.env, { DATA_DIR: dataDir });
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`cli ${args[0] || ''} ne se termine pas`));
    }, 30000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

async function ok(dataDir, ...args) {
  const r = await cli(dataDir, ...args);
  assert.equal(r.code, 0, `cli ${args[0]} ${args[1] || ''} : ${r.err || r.out}`);
  assert.equal(r.err, '');
  return r;
}

async function serve(dir) {
  config.dataDir = dir;
  const app = await start({ port: 0, host: '127.0.0.1' });
  app.port = app.server.address().port;
  return app;
}

test('dossier de données absent : list le dit, le dossier est créé', async () => {
  const dir = path.join(h.tmpDir(), 'pas', 'encore', 'cree');
  const r = await ok(dir, 'list');
  assert.match(r.out, /Aucun compte \(il sera créé au prochain démarrage du serveur\)\./);
  assert.ok(fs.statSync(dir).isDirectory());
});

test('add : mot de passe généré ou fourni, rôle, doublons et valeurs invalides', async () => {
  const dir = h.tmpDir();

  const a = await ok(dir, 'add', 'Alice');
  assert.match(a.out, /^Compte « alice » créé \(user\)\.$/m);
  const generated = /^Mot de passe temporaire : (\S+)$/m.exec(a.out);
  assert.ok(generated, a.out);
  assert.match(generated[1], /^[A-Za-z0-9_-]{16}$/);

  const b = await ok(dir, 'add', 'bob', '--admin', '--password', 'bob-password-1');
  assert.match(b.out, /^Compte « bob » créé \(admin\)\.$/m);
  const c = await ok(dir, 'add', 'carol', '-p', 'carol-password-1');
  const d = await ok(dir, 'add', 'dave', '--password=dave-password-1');
  for (const r of [b, c, d]) assert.doesNotMatch(r.out, /Mot de passe/, 'un mot de passe fourni n’est pas réaffiché');

  const refused = [
    [['add', 'alice'], /Cet identifiant existe déjà/],
    [['add', 'ALICE'], /Cet identifiant existe déjà/],
    [['add', 'x'], /Identifiant invalide/],
    [['add', 'avec espace'], /Identifiant invalide/],
    [['add', 'erin', '--password', 'court'], /au moins 8 caractères/],
    [['add'], /Identifiant manquant/]
  ];
  for (const [args, message] of refused) {
    const r = await cli(dir, ...args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, message, args.join(' '));
    assert.equal(r.out, '', args.join(' '));
  }

  const lines = (await ok(dir, 'list')).out.trim().split('\n');
  assert.equal(lines.length, 4, lines.join('\n'));
  [['alice', 'user'], ['bob', 'admin'], ['carol', 'user'], ['dave', 'user']].forEach(([name, role], i) => {
    assert.match(lines[i], new RegExp(`^${name}\\s+${role}\\s+actif\\s+dernière connexion : jamais$`));
  });

  const raw = fs.readFileSync(path.join(dir, 'users.json'), 'utf8');
  for (const secret of [generated[1], 'bob-password-1', 'carol-password-1', 'dave-password-1']) {
    assert.ok(!raw.includes(secret), 'aucun mot de passe en clair dans users.json');
  }

  // Les quatre comptes se connectent vraiment, et aucun compte « boss » n’est créé par-dessus.
  const app = await serve(dir);
  try {
    for (const [user, pw] of [['alice', generated[1]], ['bob', 'bob-password-1'], ['carol', 'carol-password-1'], ['dave', 'dave-password-1']]) {
      assert.equal((await new Client(app).login(user, pw)).status, 200, user);
    }
    assert.equal(app.users.find('boss'), null, 'le compte d’amorçage n’est créé que si aucun compte n’existe');
  } finally {
    await app.close();
  }
});

test('un serveur déjà lancé voit les changements de la CLI : mot de passe, désactivation, rôle, suppression', async () => {
  const dir = h.tmpDir();
  const app = await serve(dir);
  try {
    await ok(dir, 'add', 'alice', '--admin', '--password', 'alice-password-1');
    await settle();
    const alice = new Client(app);
    assert.equal((await alice.login('alice', 'alice-password-1')).status, 200);
    assert.equal((await alice.get('/api/admin/users')).status, 200, 'alice est administratrice');

    const reset = await ok(dir, 'passwd', 'alice');
    assert.match(reset.out, /^Mot de passe de « alice » modifié ; ses appareils connectés sont déconnectés\.$/m);
    const fresh = /^Nouveau mot de passe : (\S+)$/m.exec(reset.out)[1];
    await settle();
    assert.equal((await alice.get('/api/auth/me')).status, 401, 'la session ouverte avant le changement est révoquée');
    assert.equal((await new Client(app).login('alice', 'alice-password-1')).status, 401, 'ancien mot de passe');
    assert.equal((await alice.login('alice', fresh)).status, 200, 'mot de passe généré par la CLI');

    await ok(dir, 'disable', 'alice');
    await settle();
    assert.equal((await alice.get('/api/auth/me')).status, 401, 'compte désactivé : session coupée');
    assert.equal((await new Client(app).login('alice', fresh)).status, 401, 'compte désactivé : connexion refusée');
    await ok(dir, 'enable', 'alice');
    await settle();
    assert.equal((await alice.login('alice', fresh)).status, 200, 'compte réactivé');

    await ok(dir, 'role', 'alice', 'user');
    await settle();
    assert.equal((await alice.get('/api/admin/users')).status, 403, 'rétrogradée : plus d’administration, sans se reconnecter');
    assert.equal((await alice.get('/api/auth/me')).json.user.role, 'user');

    const listed = (await ok(dir, 'list')).out;
    assert.match(listed, /^alice\s+user\s+actif\s+dernière connexion : \d{4}-\d\d-\d\dT/m, 'la dernière connexion est enregistrée par le serveur');
    assert.match(listed, /^boss\s+admin\s+actif/m, 'le compte d’amorçage est toujours là');

    await ok(dir, 'remove', 'alice');
    await settle();
    assert.equal((await alice.get('/api/auth/me')).status, 401);
    assert.equal((await new Client(app).login('alice', fresh)).status, 401);
  } finally {
    await app.close();
  }
});

test('une connexion sur le serveur n’écrase pas un compte créé à l’instant en ligne de commande', async () => {
  const dir = h.tmpDir();
  const app = await serve(dir);
  try {
    await ok(dir, 'add', 'alice', '--password', 'alice-password-1');
    // Pas de pause : le serveur n’a pas encore relu le fichier quand il écrit la date de connexion de boss.
    assert.equal((await new Client(app).login()).status, 200);
    const listed = (await ok(dir, 'list')).out;
    assert.match(listed, /^alice\s/m);
    assert.match(listed, /^boss\s+admin\s+actif\s+dernière connexion : \d{4}-/m);
    await settle();
    assert.equal((await new Client(app).login('alice', 'alice-password-1')).status, 200);
  } finally {
    await app.close();
  }
});

test('le dernier administrateur actif ne peut être ni rétrogradé, ni désactivé, ni supprimé', async () => {
  const dir = h.tmpDir();
  await ok(dir, 'add', 'root', '--admin', '--password', 'root-password-1');
  await ok(dir, 'add', 'alice', '--password', 'alice-password-1');
  const refusing = async (...args) => {
    const r = await cli(dir, ...args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, /Il doit rester au moins un administrateur actif/, args.join(' '));
    assert.equal(r.out, '', args.join(' '));
  };

  await refusing('role', 'root', 'user');
  await refusing('disable', 'root');
  await refusing('remove', 'root');

  // Un second administrateur actif lève l’interdiction, tant qu’il en reste un.
  await ok(dir, 'role', 'alice', 'admin');
  await ok(dir, 'disable', 'root');
  await refusing('role', 'alice', 'user');
  await refusing('remove', 'alice');
  await ok(dir, 'enable', 'root');
  await ok(dir, 'remove', 'root');
  const lines = (await ok(dir, 'list')).out.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^alice\s+admin\s+actif/);
});

test('passwd, role, disable, enable, remove : messages, et erreurs lisibles', async () => {
  const dir = h.tmpDir();
  await ok(dir, 'add', 'root', '--admin', '-p', 'root-password-1');
  await ok(dir, 'add', 'alice', '-p', 'alice-password-1');

  assert.match((await ok(dir, 'passwd', 'alice', '--password=nouveau-mot-de-passe')).out, /^Mot de passe de « alice » modifié/m);
  assert.doesNotMatch((await ok(dir, 'passwd', 'alice', '-p', 'encore-un-autre-1')).out, /Nouveau mot de passe/);
  assert.match((await ok(dir, 'role', 'alice', 'admin')).out, /^« alice » est maintenant admin\.$/m);
  assert.match((await ok(dir, 'disable', 'alice')).out, /^« alice » est désactivé\.$/m);
  assert.match((await ok(dir, 'list')).out, /^alice\s+admin\s+désactivé\s+dernière connexion : jamais$/m);
  assert.match((await ok(dir, 'enable', 'alice')).out, /^« alice » est réactivé\.$/m);
  assert.match((await ok(dir, 'remove', 'alice')).out, /^Compte « alice » supprimé\.$/m);

  const refused = [
    [['passwd', 'fantome'], /Utilisateur introuvable/],
    [['passwd', 'root', '--password', 'court'], /au moins 8 caractères/],
    [['role', 'fantome', 'user'], /Utilisateur introuvable/],
    [['role', 'root', 'chef'], /Rôle attendu : admin ou user/],
    [['role', 'root'], /Rôle attendu : admin ou user/],
    [['disable', 'fantome'], /Utilisateur introuvable/],
    [['enable'], /Identifiant manquant/],
    [['remove', 'fantome'], /Utilisateur introuvable/],
    [['frobnicate'], /Commande inconnue : frobnicate/],
    [['list', '--bogus'], /Option inconnue : --bogus/]
  ];
  for (const [args, message] of refused) {
    const r = await cli(dir, ...args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, message, args.join(' '));
    assert.equal(r.out, '', args.join(' '));
  }
  assert.equal((await ok(dir, 'list')).out.trim().split('\n').length, 1, 'les erreurs ne changent rien');
});

test('aide : sans commande (code 2), avec -h ou --help (code 0)', async () => {
  const dir = h.tmpDir();
  const none = await cli(dir);
  assert.equal(none.code, 2);
  assert.match(none.out, /Usage : node server\/cli\.js <commande>/);
  assert.match(none.out, /docker compose exec arr411 node server\/cli\.js list/);
  for (const args of [['--help'], ['-h'], ['add', '--help'], ['list', '-h']]) {
    const r = await cli(dir, ...args);
    assert.equal(r.code, 0, args.join(' '));
    assert.match(r.out, /Usage : node server\/cli\.js/, args.join(' '));
    assert.equal(r.err, '');
  }
  assert.equal(fs.existsSync(path.join(dir, 'users.json')), false, 'l’aide ne crée aucun compte');
});

test('users.json illisible : message clair, le fichier n’est pas touché', async () => {
  const dir = h.tmpDir();
  const file = path.join(dir, 'users.json');
  fs.writeFileSync(file, '{ pas du json');
  for (const args of [['list'], ['add', 'alice', '--password', 'alice-password-1']]) {
    const r = await cli(dir, ...args);
    assert.equal(r.code, 1, args[0]);
    assert.match(r.err, /Impossible de lire .*users\.json/);
    assert.match(r.err, /Corrige ou supprime ce fichier/);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), '{ pas du json');
});

test('configuration invalide : la CLI le dit au lieu de planter', async () => {
  const dir = h.tmpDir();
  const env = Object.assign({}, process.env, { DATA_DIR: dir, COOKIE_SECURE: 'peut-etre' });
  delete env.NODE_TEST_CONTEXT;
  const r = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'list'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let err = '';
    child.stderr.setEncoding('utf8').on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, err }));
  });
  assert.equal(r.code, 1);
  assert.match(r.err, /Configuration invalide : COOKIE_SECURE doit valoir auto, true ou false/);
});
