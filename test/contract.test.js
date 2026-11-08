'use strict';
// Contrat entre l’interface (public/) et le serveur : tout ce que l’interface demande doit être compris par le serveur,
// et ce qu’un utilisateur « simple » peut atteindre doit rester dans la politique d’accès.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');

h.prepareEnv();
const policy = require('../server/policy');
const { META } = require('../server/proxy');

const PUBLIC = path.join(__dirname, '..', 'public');
const APP_DIR = path.join(PUBLIC, 'app');
const read = (p) => fs.readFileSync(p, 'utf8');
const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const sources = fs
  .readdirSync(APP_DIR)
  .filter((f) => f.endsWith('.js'))
  .map((file) => ({ file, text: read(path.join(APP_DIR, file)) }));

// '/queue/' + id ou `/queue/${id}` : la partie dynamique est remplacée par une valeur plausible.
function concrete(literal, concatenated, fill = '1') {
  let p = literal.replace(/\$\{[^}]*\}/g, fill);
  if (concatenated && p.endsWith('/')) p += fill;
  return p.split('?')[0];
}

const API_CALL = /\bApp\.api\(\s*'([A-Z]+)'\s*,\s*(['"`])(\/api\/[^'"`]*)\2(\s*\+)?/g;
const STRING = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

// Premier argument d’un appel : on s’arrête à la première virgule (ou au point-virgule) qui n’est ni dans une chaîne ni dans une parenthèse.
function firstArg(text, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === '`') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (depth === 0) return text.slice(start, i);
      depth--;
    } else if ((c === ',' || c === ';') && depth === 0) return text.slice(start, i);
  }
  return text.slice(start);
}

// Découpe « a + b + c » sur les + qui ne sont ni dans une chaîne ni dans une parenthèse.
function splitPlus(expr) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quote) {
      cur += c;
      if (c === '\\') cur += expr[++i];
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === '`') {
      quote = c;
      cur += c;
    } else if (c === '+' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else {
      if ('([{'.includes(c)) depth++;
      if (')]}'.includes(c)) depth--;
      cur += c;
    }
  }
  out.push(cur.trim());
  return out;
}

// Expression sans ses parenthèses ni ses chaînes : ce qui reste est le niveau supérieur (là où un « ? » fait d’elle un ternaire).
function topLevel(expr) {
  let s = expr.replace(STRING, '""');
  for (let prev = ''; prev !== s; ) {
    prev = s;
    s = s.replace(/\([^()]*\)/g, '');
  }
  return s;
}

// Chemins possibles d’un appel d’après l’expression de son premier argument. `eps` : valeurs que peut prendre une variable « ep »,
// toutes essayées (sur-approximation volontaire : mieux vaut vérifier un appel de trop qu’en oublier un).
// `fill` remplace une partie dynamique : un identifiant pour les *arr, un nom d’action (lettres seulement) pour qBittorrent.
function pathsOf(expr, eps, fill = '1') {
  expr = expr.trim();
  if (topLevel(expr).includes('?')) {
    // « cond ? '/a' : '/b' » : chaque chaîne qui commence par « / » est un chemin complet
    return [...expr.matchAll(STRING)].map((m) => m[2]).filter((s) => s.startsWith('/')).map((s) => concrete(s, false, fill));
  }
  const options = splitPlus(expr).map((part) => {
    const lit = new RegExp(`^${STRING.source}$`).exec(part);
    if (lit) return [lit[2].replace(/\$\{[^}]*\}/g, fill)];
    if (/^(?:[\w$]+\.)*ep$/.test(part)) return [null];
    // « (cond ? 'a' : 'b') » : l’une ou l’autre branche
    const branches = part.startsWith('(') && part.includes('?') ? [...part.slice(part.indexOf('?')).matchAll(STRING)].map((m) => m[2]) : [];
    return branches.length ? branches : [fill];
  });
  let paths = [''];
  for (const o of options) {
    const choices = o[0] === null ? [...eps] : o;
    paths = paths.flatMap((p) => choices.map((c) => p + c));
  }
  return paths.filter((p) => p.startsWith('/')).map((p) => p.split('?')[0]);
}

function extract() {
  const arr = [];
  const qb = [];
  const server = [];
  const commands = new Map();
  const eps = new Set();
  const addCommand = (name, where) => commands.set(name, (commands.get(name) || []).concat(where));
  for (const { text } of sources) {
    for (const m of text.matchAll(/\bep(?::|\s*=)\s*/g)) {
      for (const q of firstArg(text, m.index + m[0].length).matchAll(/'(\/[A-Za-z]+)'/g)) eps.add(q[1]);
    }
  }
  for (const { file, text } of sources) {
    const at = (m) => `${file}:${lineOf(text, m.index)}`;
    for (const m of text.matchAll(/([\w$]+|\))\s*\.\s*(get|post|put|del|call|json)\(\s*/g)) {
      const isQb = m[1] === 'qb';
      if (!(isQb ? ['post', 'call', 'json'] : ['get', 'post', 'put', 'del']).includes(m[2])) continue;
      const method = isQb ? (m[2] === 'post' ? 'POST' : 'GET') : m[2] === 'del' ? 'DELETE' : m[2].toUpperCase();
      for (const p of pathsOf(firstArg(text, m.index + m[0].length), eps, isQb ? 'action' : '1')) (isQb ? qb : arr).push({ method, path: p, where: at(m) });
    }
    for (const m of text.matchAll(API_CALL)) {
      const fill = { '/api/admin/connections/': 'radarr', '/api/admin/users/': 'bob' }[m[3]] || '1';
      server.push({ method: m[1], path: concrete(m[3], m[4], fill), where: at(m) });
    }
    for (const m of text.matchAll(/\b(?:runCommand|command)\(\s*|\b(?:cmd|refreshCmd)\s*:\s*/g)) {
      for (const q of firstArg(text, m.index + m[0].length).matchAll(/'([A-Za-z]+)'/g)) addCommand(q[1], at(m));
    }
  }
  return { arr, qb, server, commands, eps };
}

const found = extract();
const key = (c) => `${c.method} ${c.path}`;

function verdict(fn) {
  try {
    fn();
    return 'ok';
  } catch (e) {
    if (e && e.status === 403) return 'denied';
    throw e;
  }
}

const arrVerdict = (role, c) => {
  const body = c.path === '/command' ? Buffer.from(JSON.stringify({ name: 'RefreshMovie' })) : Buffer.from('{}');
  return verdict(() => policy.authorizeArr({ role, method: c.method, rest: c.path.replace(/^\//, ''), body, allowSearch: false, contentType: 'application/json' }));
};
const qbVerdict = (role, c) => verdict(() => policy.authorizeQb({ role, rest: c.path.replace(/^\//, '') }));

// Écrans réservés à l’administrateur (ils sont masqués derrière App.isAdmin) : un utilisateur ne doit pas pouvoir les atteindre.
const ADMIN_ONLY_ARR = new Set([
  'GET /log',
  'POST /qualityprofile',
  'PUT /qualityprofile/1',
  'DELETE /qualityprofile/1',
  'POST /rootfolder',
  'PUT /rootfolder/1',
  'DELETE /rootfolder/1',
  'PUT /tag/1',
  'DELETE /tag/1',
  'PUT /metadataprofile/1',
  'POST /metadataprofile',
  'DELETE /metadataprofile/1'
]);
const ADMIN_ONLY_QB = new Set(['GET /app/preferences', 'GET /log/main']);

test('contrôle de l’extraction : l’interface appelle bien Radarr/Sonarr/Lidarr, qBittorrent et le serveur', () => {
  assert.ok(found.arr.length >= 60, `appels arr trouvés : ${found.arr.length}`);
  assert.ok(found.qb.length >= 30, `appels qBittorrent trouvés : ${found.qb.length}`);
  assert.ok(found.server.length >= 10, `appels serveur trouvés : ${found.server.length}`);
  for (const p of ['/queue', '/movie', '/series', '/artist', '/command', '/history', '/calendar', '/movie/lookup', '/blocklist', '/rename']) {
    assert.ok(found.arr.some((c) => c.path === p), `appel attendu : ${p}`);
  }
  for (const p of ['/sync/maindata', '/torrents/add', '/app/webapiVersion']) {
    assert.ok(found.qb.some((c) => c.path === p), `appel qBittorrent attendu : ${p}`);
  }
});

test('Radarr / Sonarr / Lidarr : l’administrateur peut tout ce que fait l’interface', () => {
  for (const c of found.arr) assert.equal(arrVerdict('admin', c), 'ok', `${key(c)} (${c.where}) refusé à l’administrateur`);
});

test('Radarr / Sonarr / Lidarr : un utilisateur n’est refusé que sur les écrans réservés à l’administrateur', () => {
  const refused = new Set();
  const unexpected = [];
  for (const c of found.arr) {
    if (arrVerdict('user', c) !== 'denied') continue;
    refused.add(key(c));
    if (!ADMIN_ONLY_ARR.has(key(c))) unexpected.push(`${key(c)} (${c.where})`);
  }
  assert.deepEqual(unexpected, [], 'appels de l’interface que la politique refuse à un utilisateur : masque l’écran derrière App.isAdmin et ajoute-le à ADMIN_ONLY_ARR, ou élargis la politique');
  const stale = [...ADMIN_ONLY_ARR].filter((k) => !refused.has(k));
  assert.deepEqual(stale, [], 'entrées de ADMIN_ONLY_ARR qui ne sont plus nécessaires');
});

test('qBittorrent : l’administrateur peut tout ; un utilisateur n’est refusé que sur les préférences et le journal', () => {
  const refused = new Set();
  const unexpected = [];
  for (const c of found.qb) {
    assert.equal(qbVerdict('admin', c), 'ok', `${key(c)} (${c.where}) refusé à l’administrateur`);
    if (qbVerdict('user', c) !== 'denied') continue;
    refused.add(key(c));
    if (!ADMIN_ONLY_QB.has(key(c)) && !(c.method === 'POST' && c.path === '/app/setPreferences')) unexpected.push(`${key(c)} (${c.where})`);
  }
  assert.deepEqual(unexpected, [], 'appels qBittorrent refusés à un utilisateur');
  assert.ok(refused.has('GET /app/preferences') && refused.has('GET /log/main'), 'les écrans de préférences et de journal restent réservés');
});

test('commandes : l’interface n’émet que des commandes d’entretien, jamais de recherche ni de synchronisation RSS', () => {
  const names = [...found.commands.keys()].sort();
  assert.deepEqual(names, [...policy.USER_COMMANDS].sort(), 'les commandes de l’interface doivent être exactement celles qu’un utilisateur peut lancer');
  for (const name of names) {
    assert.doesNotMatch(name, /search|rsssync/i, name);
    for (const role of ['user', 'admin']) {
      const body = Buffer.from(JSON.stringify({ name }));
      assert.doesNotThrow(() => policy.authorizeArr({ role, method: 'POST', rest: 'command', body, allowSearch: false, contentType: 'application/json' }), `${name} (${role})`);
    }
  }
});

test('ajouts : toute option « searchFor… » présente dans l’interface vaut false', () => {
  let count = 0;
  for (const { file, text } of sources) {
    for (const m of text.matchAll(/\bsearchFor\w*\s*[:=]\s*([^,;}\n]*)/g)) {
      count++;
      assert.equal(m[1].trim(), 'false', `${file}:${lineOf(text, m.index)} : ${m[0]}`);
    }
  }
  assert.ok(count >= 4, `options searchFor trouvées : ${count}`);
});

test('adresses des services : les préfixes d’API de l’interface sont ceux que le serveur relaie', () => {
  const core = sources.find((s) => s.file === 'core.js').text;
  const ver = /const ver = svc === 'lidarr' \? '([^']+)' : '([^']+)'/.exec(core);
  assert.ok(ver, 'préfixe arr introuvable dans core.js');
  assert.equal(ver[1] + '/', META.lidarr.prefix);
  assert.equal(ver[2] + '/', META.radarr.prefix);
  assert.equal(ver[2] + '/', META.sonarr.prefix);
  assert.ok(core.includes(`'${META.qb.prefix.slice(0, -1)}'`), 'préfixe qBittorrent');
  assert.ok(core.includes(`'/api/svc/`), 'base du relais');
});

test('API du serveur : chaque appel /api/… de l’interface correspond à une route existante', async () => {
  assert.ok(found.server.length >= 10);
  const app = await h.startApp();
  try {
    for (const c of found.server) {
      if (!app.users.find('bob')) await app.users.create({ username: 'bob', password: 'bob-password-1', role: 'user' });
      const client = await h.adminClient(app);
      const res = await client.send(c.method, c.path, c.method === 'GET' ? {} : { json: {} });
      const unknown = res.status === 405 || (res.status === 404 && /Route inconnue/.test(res.text));
      assert.ok(!unknown, `${key(c)} (${c.where}) : route inconnue du serveur (${res.status})`);
      assert.ok(res.status < 500, `${key(c)} (${c.where}) : erreur serveur ${res.status} ${res.text.slice(0, 200)}`);
    }
  } finally {
    await app.close();
  }
});

test('pages : chaque fichier référencé existe et est servi, sans script ni gestionnaire en ligne', async () => {
  const app = await h.startApp();
  try {
    const admin = await h.adminClient(app);
    const anon = new h.Client(app);
    const types = { js: /javascript/, css: /text\/css/, png: /image\/png/, webmanifest: /json/ };
    const checked = new Set();
    for (const [page, client] of [['/login', anon], ['/login/', anon], ['/', admin], ['/share?text=magnet%3A%3Fxt%3Durn%3Abtih%3Aabc', admin]]) {
      const res = await client.get(page);
      assert.equal(res.status, 200, page);
      assert.match(res.headers['content-type'], /text\/html/, page);
      assert.match(res.headers['content-security-policy'], /script-src 'self'/, page);
      const html = res.text;
      assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/i, `${page} : script en ligne (bloqué par la CSP)`);
      assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${page} : gestionnaire en ligne (bloqué par la CSP)`);
      assert.doesNotMatch(html, /javascript:/i, page);
      let refs = 0;
      for (const m of html.matchAll(/\b(?:src|href)="([^"#]+)"/g)) {
        const url = new URL(m[1], 'http://x' + page);
        if (url.host !== 'x') continue;
        refs++;
        const target = url.pathname + url.search;
        const r = await (target.startsWith('/login/') || target.startsWith('/icons/') || target.startsWith('/manifest') ? anon : admin).get(target);
        assert.equal(r.status, 200, `${page} référence ${target}`);
        assert.ok(r.body.length > 0, `${target} est vide`);
        const ext = path.extname(url.pathname).slice(1);
        if (types[ext]) assert.match(r.headers['content-type'], types[ext], target);
        checked.add(target);
      }
      assert.ok(refs >= 3, `${page} : ${refs} références`);
    }
    for (const f of ['/app.css', '/core.js', '/main.js', '/login/login.js', '/login/login.css', '/manifest.webmanifest', '/icons/icon-192.png']) {
      assert.ok(checked.has(f), `${f} n’est référencé par aucune page`);
    }

    const manifest = (await anon.get('/manifest.webmanifest')).json;
    assert.equal(manifest.start_url, '/');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.share_target.action, '/share');
    assert.ok(manifest.icons.length >= 2);
    for (const icon of manifest.icons) {
      const r = await anon.get(icon.src);
      assert.equal(r.status, 200, icon.src);
      assert.match(r.headers['content-type'], /image\/png/);
    }
  } finally {
    await app.close();
  }
});

test('code de l’interface : rien que la CSP du serveur bloquerait (eval, Function, document.write, URL javascript:)', () => {
  const files = [...sources.map((s) => path.join(APP_DIR, s.file)), path.join(PUBLIC, 'login', 'login.js')];
  for (const f of files) {
    const text = read(f).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(text, /\beval\s*\(|\bnew\s+Function\s*\(|\bdocument\.write\s*\(/, path.basename(f));
    assert.doesNotMatch(text, /['"`]javascript:/i, path.basename(f));
    assert.doesNotMatch(text, /\bset(?:Timeout|Interval)\s*\(\s*['"`]/, path.basename(f));
  }
});
