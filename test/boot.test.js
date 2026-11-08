'use strict';
// Démarrage réel : on lance `node server/index.js` comme le fait le conteneur (CMD du Dockerfile),
// puis on rejoue le HEALTHCHECK du Dockerfile tel qu'il est écrit.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const h = require('./helpers');

const { Client, ADMIN } = h;
const ROOT = path.join(__dirname, '..');
const VERSION = require('../package.json').version;
const POSIX = process.platform !== 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// Rien de l'environnement du développeur ne doit influencer le serveur lancé.
function cleanEnv(extra) {
  const env = Object.assign({}, process.env);
  for (const k of h.ENV_KEYS) delete env[k];
  delete env.NODE_TEST_CONTEXT;
  return Object.assign(env, extra);
}

const alive = new Set();
process.on('exit', () => {
  for (const child of alive) child.kill('SIGKILL');
});

function spawnProc(file, args, { env, cwd = ROOT }) {
  const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const p = { child, out: '', err: '', exit: null };
  alive.add(child);
  child.stdout.setEncoding('utf8').on('data', (d) => (p.out += d));
  child.stderr.setEncoding('utf8').on('data', (d) => (p.err += d));
  p.exited = new Promise((resolve) => {
    const finish = (exit) => {
      if (p.exit) return;
      alive.delete(child);
      p.exit = exit;
      resolve(exit);
    };
    child.once('error', (e) => {
      p.err += String(e);
      finish({ code: -1, signal: null });
    });
    child.once('close', (code, signal) => finish({ code, signal }));
  });
  const hard = setTimeout(() => child.kill('SIGKILL'), 60000);
  hard.unref();
  p.exited.then(() => clearTimeout(hard));
  return p;
}

const READY = /Arr411 Web \S+ : http:\/\/\S+/;

// Lance le serveur sur un port libre ; `ready` se résout quand la ligne de démarrage apparaît.
async function boot(extraEnv = {}, { cwd = ROOT, entry = path.join('server', 'index.js') } = {}) {
  const port = extraEnv.PORT ? Number(extraEnv.PORT) : await freePort();
  const env = cleanEnv(Object.assign({ NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port) }, extraEnv));
  const p = spawnProc(process.execPath, [entry], { env, cwd });
  p.port = port;
  p.ready = new Promise((resolve, reject) => {
    const done = (err) => {
      clearTimeout(timer);
      if (err) reject(new Error(`${err.message}\n--- stdout\n${p.out}--- stderr\n${p.err}`));
      else resolve(p);
    };
    const timer = setTimeout(() => done(new Error('serveur pas prêt après 20 s')), 20000);
    p.child.stdout.on('data', () => {
      if (READY.test(p.out)) done();
    });
    p.exited.then(() => {
      if (!READY.test(p.out)) done(new Error(`serveur arrêté (code ${p.exit.code}) avant d’être prêt`));
    });
  });
  p.ready.catch(() => {});
  return p;
}

async function stop(p) {
  if (!p.exit) {
    p.child.kill();
    const force = setTimeout(() => p.child.kill('SIGKILL'), 10000);
    await p.exited;
    clearTimeout(force);
  }
  return p.exit;
}

async function withServer(env, fn, opts) {
  const p = await boot(env, opts);
  try {
    await p.ready;
    return await fn(p);
  } finally {
    await stop(p);
  }
}

async function until(cond, what, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`attendu : ${what}`);
    await sleep(25);
  }
}

// La commande exacte du HEALTHCHECK, lue dans le Dockerfile (continuations de ligne comprises).
function healthcheckCommand() {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8').replace(/\r\n/g, '\n').replace(/\\\n\s*/g, ' ');
  const line = dockerfile.split('\n').find((l) => /^HEALTHCHECK\b/.test(l));
  assert.ok(line, 'le Dockerfile déclare un HEALTHCHECK');
  const m = /\bCMD (node -e ".*")\s*$/.exec(line);
  assert.ok(m, `HEALTHCHECK inattendu : ${line}`);
  return m[1];
}

// Rejoue le HEALTHCHECK contre `port`. Sous Linux il passe par /bin/sh -c, comme dans le conteneur.
async function healthcheck(port) {
  const command = healthcheckCommand();
  const env = cleanEnv({ PORT: String(port) });
  let p;
  if (POSIX && path.basename(process.execPath) === 'node') {
    env.PATH = path.dirname(process.execPath) + path.delimiter + (env.PATH || '');
    p = spawnProc('/bin/sh', ['-c', command], { env });
  } else {
    p = spawnProc(process.execPath, ['-e', /^node -e "(.*)"$/.exec(command)[1]], { env });
  }
  await p.exited;
  return p;
}

test('démarrage réel : santé, redirection, connexion, cookie, données, HEALTHCHECK, redémarrage', async () => {
  const dir = h.tmpDir();
  const env = { DATA_DIR: dir, SESSION_DAYS: '2', ADMIN_USER: ADMIN.username, ADMIN_PASSWORD: ADMIN.password };
  const html = { Accept: 'text/html' };
  const changed = 'un autre mot de passe';
  let firstPort;
  let renewed;

  await withServer(env, async (p) => {
    firstPort = p.port;
    assert.match(p.out, new RegExp(`Arr411 Web ${escapeRe(VERSION)} : http://127\\.0\\.0\\.1:${p.port}\\b`));
    const c = new Client({ port: p.port });

    const health = await c.get('/healthz');
    assert.equal(health.status, 200);
    assert.equal(health.text, 'ok\n');

    const root = await c.get('/', { headers: html });
    assert.equal(root.status, 302);
    assert.equal(root.headers.location, '/login');

    const page = await c.get('/login');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /^text\/html/);
    assert.match(page.headers['content-security-policy'], /default-src 'none'/);
    assert.equal(page.headers['strict-transport-security'], undefined, 'pas de HSTS en HTTP simple');

    const anonymous = await c.get('/api/config');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.json.code, 'auth');

    const wrong = await c.login(ADMIN.username, 'pas le bon mot de passe');
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.code, 'bad-credentials');
    assert.equal(c.jar.size, 0);

    const login = await c.login();
    assert.equal(login.status, 200);
    const cookie = login.setCookie.find((l) => l.startsWith('arr_session='));
    assert.ok(cookie, 'cookie de session');
    assert.match(cookie, /Max-Age=172800(;|$)/, 'SESSION_DAYS=2');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.doesNotMatch(cookie, /Secure/, 'pas de Secure en HTTP simple (COOKIE_SECURE=auto)');
    const first = c.jar.get('arr_session');

    const config = await c.get('/api/config');
    assert.equal(config.status, 200);
    assert.equal(config.json.version, VERSION);
    assert.equal(config.json.user.username, ADMIN.username);
    assert.equal(config.json.user.role, 'admin');
    for (const svc of ['qb', 'radarr', 'sonarr', 'lidarr']) assert.equal(config.json.services[svc].configured, false, svc);

    const app = await c.get('/', { headers: html });
    assert.equal(app.status, 200);
    assert.match(app.text, /\/main\.js/);

    const usersFile = path.join(dir, 'users.json');
    const users = fs.readFileSync(usersFile, 'utf8');
    assert.deepEqual(JSON.parse(users).users.map((u) => u.username), [ADMIN.username]);
    assert.ok(!users.includes(ADMIN.password), 'mot de passe haché, jamais en clair');
    assert.ok(fs.readFileSync(path.join(dir, 'secret.key'), 'utf8').trim().length >= 44, 'secret.key créé');
    if (POSIX) {
      for (const f of ['users.json', 'secret.key']) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o077, 0, `${f} réservé à son propriétaire`);
    }
    assert.ok(!(p.out + p.err).includes(ADMIN.password), 'le mot de passe n’est jamais journalisé');

    assert.equal((await healthcheck(p.port)).exit.code, 0, 'HEALTHCHECK : serveur en marche');

    // ADMIN_PASSWORD reste dans l'environnement : le changer dans l'application doit survivre au redémarrage.
    const change = await c.post('/api/auth/password', { current: ADMIN.password, password: changed });
    assert.equal(change.status, 200);
    renewed = c.jar.get('arr_session');
    assert.notEqual(renewed, first);
    const old = new Client({ port: p.port });
    old.jar.set('arr_session', first);
    assert.equal((await old.get('/api/auth/me')).status, 401, 'les autres appareils sont déconnectés');
    assert.equal((await c.get('/api/auth/me')).status, 200, 'l’appareil courant reste connecté');
  });

  assert.equal((await healthcheck(firstPort)).exit.code, 1, 'HEALTHCHECK : rien n’écoute');

  // Redémarrage sur le même volume, depuis un autre dossier de travail.
  await withServer(env, async (p) => {
    const c = new Client({ port: p.port });
    c.jar.set('arr_session', renewed);
    const me = await c.get('/api/auth/me');
    assert.equal(me.status, 200, 'la session survit au redémarrage (secret.key conservé)');
    assert.equal(me.json.user.username, ADMIN.username);
    assert.equal((await c.get('/', { headers: html })).status, 200, 'les fichiers statiques ne dépendent pas du dossier courant');

    const fresh = new Client({ port: p.port });
    assert.equal((await fresh.login(ADMIN.username, ADMIN.password)).status, 401, 'ADMIN_PASSWORD ne réinitialise pas un compte existant');
    assert.equal((await fresh.login(ADMIN.username, changed)).status, 200);
    assert.doesNotMatch(p.out + p.err, /Premier démarrage/);
  }, { cwd: h.tmpDir(), entry: path.join(ROOT, 'server', 'index.js') });
});

test('HEALTHCHECK : seul un 2xx de /healthz compte comme sain', async () => {
  for (const [status, expected] of [[200, 0], [500, 1], [503, 1]]) {
    const server = http.createServer((req, res) => {
      res.statusCode = req.url === '/healthz' ? status : 404;
      res.end('x');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const r = await healthcheck(server.address().port);
      assert.equal(r.exit.code, expected, `/healthz répond ${status}`);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }
});

test('premier démarrage sans ADMIN_PASSWORD : mot de passe temporaire affiché une seule fois', async () => {
  const dir = h.tmpDir();
  let temp;

  await withServer({ DATA_DIR: dir }, async (p) => {
    await until(() => /Mot de passe temporaire/.test(p.err), 'le mot de passe temporaire dans les logs');
    assert.match(p.err, /Premier démarrage : compte administrateur « admin » créé\./);
    temp = /Mot de passe temporaire \(affiché une seule fois\) : (\S+)/.exec(p.err)[1];
    assert.match(temp, /^[A-Za-z0-9_-]{16}$/);
    const c = new Client({ port: p.port });
    assert.equal((await c.login('admin', temp)).status, 200);
    assert.ok(!fs.readFileSync(path.join(dir, 'users.json'), 'utf8').includes(temp), 'jamais écrit en clair');
  });

  await withServer({ DATA_DIR: dir }, async (p) => {
    const c = new Client({ port: p.port });
    assert.equal((await c.login('admin', temp)).status, 200, 'le mot de passe temporaire reste valable tant qu’il n’est pas changé');
    assert.doesNotMatch(p.out + p.err, /Premier démarrage|Mot de passe temporaire/);
    assert.ok(!(p.out + p.err).includes(temp));
  });
});

// Un démarrage impossible doit s'arrêter vite, avec un code 1 et une explication, sans rien casser sur le volume.
const FAILURES = [
  { name: 'PUBLIC_URL invalide', env: { PUBLIC_URL: 'nope' }, message: /Configuration invalide : PUBLIC_URL invalide/ },
  { name: 'COOKIE_SECURE invalide', env: { COOKIE_SECURE: 'peut-etre' }, message: /Configuration invalide : COOKIE_SECURE doit valoir auto, true ou false/ },
  { name: 'SESSION_SECRET trop court', env: { SESSION_SECRET: 'court' }, message: /Démarrage impossible : SESSION_SECRET doit faire au moins 16 caractères/ },
  { name: 'ADMIN_USER invalide', env: { ADMIN_USER: '!!', ADMIN_PASSWORD: 'un mot de passe correct' }, message: /Démarrage impossible : ADMIN_USER \/ ADMIN_PASSWORD : Identifiant invalide/, noAccount: true },
  { name: 'ADMIN_PASSWORD trop court', env: { ADMIN_PASSWORD: 'court' }, message: /Démarrage impossible : ADMIN_USER \/ ADMIN_PASSWORD : Le mot de passe doit faire au moins 8 caractères/, noAccount: true },
  { name: 'users.json illisible', files: { 'users.json': '{ pas du json' }, message: /Démarrage impossible : Impossible de lire .*users\.json .*Corrige ou supprime ce fichier/ },
  { name: 'config.json inattendu', files: { 'config.json': '[]' }, message: /Démarrage impossible : Impossible de lire .*config\.json : contenu inattendu\. Corrige ou supprime ce fichier/ }
];

for (const f of FAILURES) {
  test(`démarrage impossible : ${f.name}`, async () => {
    const dir = h.tmpDir();
    for (const [name, content] of Object.entries(f.files || {})) fs.writeFileSync(path.join(dir, name), content);
    const p = await boot(Object.assign({ DATA_DIR: dir }, f.env));
    try {
      const exit = await Promise.race([p.exited, sleep(15000).then(() => null)]);
      assert.ok(exit, `le serveur ne s’arrête pas\n${p.out}${p.err}`);
      assert.equal(exit.code, 1, p.out + p.err);
    } finally {
      await stop(p);
    }
    assert.match(p.err, f.message);
    assert.doesNotMatch(p.out, /Arr411 Web/, 'jamais annoncé comme démarré');
    for (const [name, content] of Object.entries(f.files || {})) {
      assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), content, `${name} n’est pas touché`);
    }
    if (f.noAccount) assert.ok(!fs.existsSync(path.join(dir, 'users.json')), 'aucun compte à moitié créé');
  });
}

test('démarrage impossible : port déjà utilisé', async () => {
  const port = await freePort();
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(port, '127.0.0.1', r));
  try {
    const p = await boot({ PORT: String(port), DATA_DIR: h.tmpDir() });
    try {
      const exit = await Promise.race([p.exited, sleep(15000).then(() => null)]);
      assert.ok(exit, `le serveur ne s’arrête pas\n${p.out}${p.err}`);
      assert.equal(exit.code, 1, p.out + p.err);
    } finally {
      await stop(p);
    }
    assert.match(p.err, /Démarrage impossible : .*EADDRINUSE/);
    assert.doesNotMatch(p.out, /Arr411 Web/);
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});
