'use strict';
// Réglages d’exploitation : reverse proxy (TRUST_PROXY, PUBLIC_URL, COOKIE_SECURE), variables d’initialisation des services, secret de session.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');

h.prepareEnv();
const config = require('../server/config');
const { start } = require('../server/index');
const { Client, adminClient } = h;

// Modifie la configuration le temps d’un test (elle est lue à chaque requête) puis la remet.
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

async function withApp(fn) {
  const app = await h.startApp();
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

async function restart(dataDir) {
  config.dataDir = dataDir;
  const app = await start({ port: 0, host: '127.0.0.1' });
  app.port = app.server.address().port;
  return app;
}

const login = (app, headers) => new Client(app).login(undefined, undefined, { headers });
const secureCookie = (res) => /; Secure$/.test(res.setCookie[0]);

test('derrière un proxy HTTPS : cookie Secure et HSTS, seulement si TRUST_PROXY l’autorise', () =>
  withApp(async (app) => {
    const https = { 'X-Forwarded-Proto': 'https' };

    let r = await login(app, https);
    assert.equal(r.status, 200);
    assert.equal(secureCookie(r), false, 'sans TRUST_PROXY, l’en-tête est ignoré');
    assert.equal(r.headers['strict-transport-security'], undefined);

    await withConfig({ trustProxy: 1 }, async () => {
      r = await login(app, https);
      assert.equal(secureCookie(r), true);
      assert.match(r.headers['strict-transport-security'], /^max-age=\d+$/);
      assert.equal(secureCookie(await login(app, { 'X-Forwarded-Proto': 'https, http' })), true, 'le premier proxy compte');

      for (const headers of [undefined, { 'X-Forwarded-Proto': 'http' }]) {
        r = await login(app, headers);
        assert.equal(secureCookie(r), false, JSON.stringify(headers));
        assert.equal(r.headers['strict-transport-security'], undefined);
      }

      const c = new Client(app);
      assert.equal((await c.login(undefined, undefined, { headers: https })).status, 200);
      const out = await c.post('/api/auth/logout', {}, { headers: https });
      assert.equal(out.status, 200);
      assert.match(out.setCookie[0], /^arr_session=; .*Max-Age=0; .*; Secure$/, 'le cookie effacé garde les mêmes attributs');
      const page = await c.get('/login', { headers: https });
      assert.match(page.headers['strict-transport-security'], /max-age/, 'HSTS aussi sur les pages');
    });
  }));

test('COOKIE_SECURE=true ou false l’emporte sur ce que dit le proxy', () =>
  withApp(async (app) => {
    const cases = [
      ['true', undefined, true],
      ['true', { 'X-Forwarded-Proto': 'http' }, true],
      ['false', { 'X-Forwarded-Proto': 'https' }, false],
      ['auto', { 'X-Forwarded-Proto': 'https' }, true]
    ];
    for (const [cookieSecure, headers, expected] of cases) {
      await withConfig({ cookieSecure, trustProxy: 1 }, async () => {
        const r = await login(app, headers);
        assert.equal(secureCookie(r), expected, `${cookieSecure} ${JSON.stringify(headers)}`);
        assert.equal(Boolean(r.headers['strict-transport-security']), expected, `HSTS ${cookieSecure}`);
      });
    }
  }));

test('origine : PUBLIC_URL, ou X-Forwarded-Host avec TRUST_PROXY, rendent l’adresse publique acceptable', () =>
  withApp(async (app) => {
    const origin = 'https://arr.example.org';
    const post = (headers) => login(app, headers);

    const refused = await post({ Origin: origin });
    assert.equal(refused.status, 403, 'un proxy qui réécrit Host : refusé tant que rien n’est configuré');
    assert.match(refused.json.message, /TRUST_PROXY.*PUBLIC_URL/, 'le message dit quoi régler');

    await withConfig({ publicUrl: { origin, host: 'arr.example.org', secure: true } }, async () => {
      assert.equal((await post({ Origin: origin })).status, 200);
      assert.equal((await post({ Origin: 'https://arr.example.org:8443' })).status, 403, 'le port compte');
      assert.equal((await post({ Origin: 'https://arr.example.org.evil.example' })).status, 403);
      assert.equal((await post({ Origin: 'https://evil.example' })).status, 403);
      assert.equal((await post({ Origin: 'null' })).status, 403);
    });

    const forwarded = { 'X-Forwarded-Host': 'arr.example.org', Origin: origin };
    assert.equal((await post(forwarded)).status, 403, 'sans TRUST_PROXY, X-Forwarded-Host est ignoré');
    await withConfig({ trustProxy: 1 }, async () => {
      assert.equal((await post(forwarded)).status, 200);
      assert.equal((await post({ 'X-Forwarded-Host': 'arr.example.org', Origin: 'https://evil.example' })).status, 403);
    });
  }));

test('TRUST_PROXY=1 : le blocage suit l’adresse vue par le proxy, pas celles qu’un client ajoute', () =>
  withApp(async (app) => {
    await withConfig({ trustProxy: 1 }, async () => {
      const attempt = (xff, user) => new Client(app).login(user, 'mauvais-mot-de-passe', { headers: { 'X-Forwarded-For': xff } });
      // le client invente des adresses en tête de liste ; le proxy ajoute la vraie à la fin
      for (let i = 0; i < 10; i++) assert.equal((await attempt(`10.9.9.${i}, 203.0.113.7`, `inconnu${i}`)).status, 401, `essai ${i + 1}`);
      const blocked = await attempt('10.1.1.1, 203.0.113.7', 'inconnu-bis');
      assert.equal(blocked.status, 429, 'même adresse réelle : bloquée');
      assert.equal(blocked.headers['x-arr411-error'], 'throttled');
      assert.equal((await attempt('203.0.113.8', 'inconnu-ter')).status, 401, 'une autre adresse réelle n’est pas touchée');
    });
  }));

const SEEDS = {
  qb: { url: 'http://qbittorrent:8080/', username: 'admin', password: 'adminadmin' },
  radarr: { url: 'http://radarr:7878', apiKey: 'RADARR-KEY' },
  sonarr: { url: '', apiKey: 'ignorée : pas d’adresse' },
  lidarr: { url: 'ftp://lidarr:8686', apiKey: 'ignorée : adresse invalide' }
};

test('variables d’environnement : elles initialisent un service jamais enregistré, une seule fois', () =>
  withConfig({ seeds: SEEDS }, async () => {
    const app = await h.startApp();
    const dir = app.dataDir;
    const open = [app];
    try {
      const expected = {
        qb: { url: 'http://qbittorrent:8080', username: 'admin', password: 'adminadmin', publicUrl: '' },
        radarr: { url: 'http://radarr:7878', apiKey: 'RADARR-KEY', publicUrl: '' }
      };
      assert.deepEqual(app.cfgStore.data.connections, expected);
      assert.deepEqual(app.cfgStore.data.rev, { qb: 2, radarr: 2 });
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).connections, expected, 'écrit dans le volume');

      const admin = await adminClient(app);
      const services = (await admin.get('/api/config')).json.services;
      assert.deepEqual(Object.fromEntries(Object.entries(services).map(([svc, s]) => [svc, s.configured])), { qb: true, radarr: true, sonarr: false, lidarr: false });
      const shown = (await admin.get('/api/admin/connections')).text;
      assert.ok(!shown.includes('adminadmin') && !shown.includes('RADARR-KEY'), 'les secrets ne sont jamais renvoyés');

      // Réglages fait foi : radarr supprimé, qBittorrent déplacé
      assert.equal((await admin.put('/api/admin/connections/radarr', { url: '' })).status, 200);
      assert.equal((await admin.put('/api/admin/connections/qb', { url: 'http://qb2:8080', username: 'admin', password: 'nouveau-secret' })).status, 200);
      await app.close();
      open.pop();

      config.seeds = Object.assign({}, SEEDS, { sonarr: { url: 'http://sonarr:8989/', apiKey: 'SONARR-KEY' } });
      const again = await restart(dir);
      open.push(again);
      const c = again.cfgStore.data.connections;
      assert.equal(c.radarr, undefined, 'supprimé dans Réglages : il ne revient pas au redémarrage');
      assert.equal(c.qb.url, 'http://qb2:8080', 'la modification faite dans Réglages est conservée');
      assert.deepEqual(c.sonarr, { url: 'http://sonarr:8989', apiKey: 'SONARR-KEY', publicUrl: '' }, 'un service jamais enregistré est initialisé');
      assert.equal(c.lidarr, undefined);
    } finally {
      for (const a of open) await a.close().catch(() => {});
    }
  }));

test('secret de session : créé une fois dans le volume, les sessions survivent au redémarrage', () =>
  withConfig({ sessionSecret: '' }, async () => {
    const app = await h.startApp();
    const dir = app.dataDir;
    const keyFile = path.join(dir, 'secret.key');
    const open = [app];
    try {
      const key = fs.readFileSync(keyFile, 'utf8');
      assert.ok(Buffer.from(key, 'base64').length >= 32, 'clé de 256 bits au moins');
      const admin = await adminClient(app);
      await app.close();
      open.pop();

      const second = await restart(dir);
      open.push(second);
      admin.port = second.port;
      assert.equal((await admin.get('/api/auth/me')).status, 200, 'même clé : la session est toujours valable');
      assert.equal(fs.readFileSync(keyFile, 'utf8'), key, 'la clé n’est pas régénérée');
      await second.close();
      open.pop();

      fs.rmSync(keyFile);
      const third = await restart(dir);
      open.push(third);
      admin.port = third.port;
      assert.equal((await admin.get('/api/auth/me')).status, 401, 'nouvelle clé : les anciennes sessions ne passent plus');
      assert.notEqual(fs.readFileSync(keyFile, 'utf8'), key);
      await third.close();
      open.pop();

      const fixed = 'secret-fourni-par-l-environnement';
      config.sessionSecret = fixed;
      fs.rmSync(keyFile);
      const fourth = await restart(dir);
      open.push(fourth);
      assert.equal(fs.existsSync(keyFile), false, 'avec SESSION_SECRET, aucun fichier de clé n’est créé');
      await fourth.close();
      open.pop();

      config.sessionSecret = 'trop-court';
      await assert.rejects(restart(dir), /SESSION_SECRET doit faire au moins 16 caractères/);
    } finally {
      for (const a of open) await a.close().catch(() => {});
    }
  }));
