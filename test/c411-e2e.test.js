'use strict';
// The whole chain with nothing faked on the browser side: the app, a real (headless) Chrome driven through the C411 view, a
// fake web site that sends the strictest Content-Security-Policy a site can send, and a fake qBittorrent.
// It checks what the user does (signs in to the site inside the view, clicks "⇩ qBittorrent" next to "Télécharger", picks a
// category, and the .torrent lands in qBittorrent) and what a hostile page or another user must NOT be able to do.
// Skipped when no Chrome is installed (CHROME_BIN can point at one). TEST_VERBOSE=1 shows the logs of the server,
// E2E_DEBUG=1 the console of the remote page.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');

const SECRET = 'secret-de-test-assez-long-123456';
h.prepareEnv({ SESSION_SECRET: SECRET });

const { launchChrome } = require('./chrome');
const { OP, connect, sleep } = require('./wsclient');
const cdp = require('../server/c411/cdp');

const PASS = 'une phrase de passe solide';
const DEBUG = Boolean(process.env.E2E_DEBUG);
const SITE_USER = (name) => `c411-${name}`;
const SITE_PASS = 'pw-c411';
const OURS = 'button[data-qbt-injected="ours"]';

// The server must never log an error during these tests.
const errors = [];
console.error = (...args) => errors.push(args.join(' '));

let chrome = null;
let site = null;
let qb = null;
let app = null;
let base = '';
let secretBase = '';
const viewers = [];
const probes = [];

async function poll(check, ms = 10000, label = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await sleep(80);
  }
}

// ---------- the .torrent files the fake site serves ----------

function bencode(v) {
  if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from(`${v.length}:`), v]);
  if (typeof v === 'string') return bencode(Buffer.from(v, 'utf8'));
  if (typeof v === 'number') return Buffer.from(`i${v}e`);
  const keys = Object.keys(v).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return Buffer.concat([Buffer.from('d'), ...keys.map((k) => Buffer.concat([bencode(k), bencode(v[k])])), Buffer.from('e')]);
}

const torrents = new Map();
function makeTorrent(label) {
  const name = `Film.${label}.2024.1080p`;
  // Raw bytes on purpose: 0xff, 0x80 and 0x00 do not survive a trip through any text encoding.
  const pieces = Buffer.concat([Buffer.from([0xff, 0x80, 0x00, 0x7f, 0xfe, 0x81]), crypto.createHash('sha1').update(label).digest().subarray(0, 14)]);
  const info = { length: 1234567, name, 'piece length': 16384, pieces };
  const hash = crypto.createHash('sha1').update(bencode(info)).digest('hex');
  const torrent = { label, name, hash, file: bencode({ announce: 'http://tracker.invalid/announce', info }) };
  torrents.set(hash, torrent);
  return torrent;
}

// ---------- the fake site ----------

// No inline script, no inline style, no remote host: only what the page itself serves, and nothing may connect elsewhere.
const CSP = "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const SITE_CSS = `body { margin: 0; font: 16px/1.4 sans-serif; }
h1, p, form, .actions { margin: 12px 20px; }
input { display: block; box-sizing: border-box; width: 300px; height: 34px; margin: 10px 0; }
button { height: 36px; padding: 0 14px; }
.actions { display: flex; gap: 8px; align-items: center; }
`;

// "Télécharger": the file is fetched, turned into a Blob and handed over through an <a download> (flow=blob), or the browser
// is sent to the file (flow=direct). Either way the page counts the clicks it received (data-clicks on <html>).
const SITE_JS = `(function () {
  var root = document.documentElement;
  var query = new URLSearchParams(location.search);
  var hash = location.pathname.split('/').pop();
  function bump() { root.setAttribute('data-clicks', String(Number(root.getAttribute('data-clicks') || 0) + 1)); }
  async function viaBlob() {
    var res = await fetch('/dl/' + hash + '.torrent', { credentials: 'include' });
    var url = URL.createObjectURL(await res.blob());
    var a = document.createElement('a');
    a.href = url;
    a.download = 'film-' + hash.slice(0, 6) + '.torrent';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function download() {
    bump();
    if (query.get('flow') === 'direct') location.href = '/dl/' + hash + '.torrent';
    else viaBlob();
  }
  document.getElementById('dl').addEventListener('click', download);
  if (query.get('auto') === '1') setTimeout(download, 300);
})();
`;

async function startSite() {
  const state = { sessions: new Map(), serial: 0, landing: '', secretHits: 0, downloads: [], logins: [] };
  const server = await h.listen((req, res, rec) => {
    const u = new URL(req.url, 'http://site');
    const token = (/(?:^|;\s*)sess=([^;]+)/.exec(req.headers.cookie || '') || [])[1];
    const user = token ? state.sessions.get(token) : undefined;
    const reply = (status, type, body, extra) => {
      res.writeHead(status, { 'Content-Type': type, 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store', ...extra });
      res.end(body);
    };
    const html = (title, body, status = 200) =>
      reply(status, 'text/html; charset=utf-8', `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="/site.css"></head><body>${body}</body></html>`);
    const redirect = (to, extra) => reply(302, 'text/plain; charset=utf-8', '', { Location: to, ...extra });
    const route = `${req.method} ${u.pathname}`;

    if (route === 'GET /site.css') return reply(200, 'text/css; charset=utf-8', SITE_CSS);
    if (route === 'GET /app.js') return reply(200, 'text/javascript; charset=utf-8', SITE_JS);
    if (route === 'GET /') {
      if (user) return redirect(`/torrents/${state.landing}`);
      return html(
        'Connexion',
        '<h1>Connexion</h1><form method="post" action="/login"><input id="u" name="u" type="text" autocomplete="off" aria-label="Utilisateur"><input id="p" name="p" type="password" autocomplete="off" aria-label="Mot de passe"><button id="go" type="submit">Connexion</button></form>'
      );
    }
    if (route === 'POST /login') {
      const form = new URLSearchParams(rec.body.toString('utf8'));
      const name = form.get('u') || '';
      if (!name.startsWith('c411-') || form.get('p') !== SITE_PASS) return html('Connexion', '<h1>Identifiants invalides</h1>', 401);
      const sess = `s${++state.serial}${crypto.randomBytes(6).toString('hex')}`;
      state.sessions.set(sess, name);
      state.logins.push(name);
      return redirect('/', { 'Set-Cookie': `sess=${sess}; Path=/; HttpOnly; SameSite=Lax` });
    }
    if (route === 'GET /whoami') return html(`qui:${user || 'anonyme'}`, '<p>whoami</p>');
    if (route === 'GET /secret') {
      state.secretHits++;
      return html('SECRET', '<p>secret</p>');
    }
    const page = /^\/torrents\/([0-9a-f]{40})$/.exec(u.pathname);
    if (req.method === 'GET' && page) {
      if (!user) return redirect('/');
      const t = torrents.get(page[1]);
      if (!t) return html('Introuvable', '<p>?</p>', 404);
      return html(
        t.name,
        `<h1>${t.name}</h1><p>Hash : ${t.hash}</p><div class="actions"><button id="dl" type="button">Télécharger</button><button id="magnet" type="button">Magnet</button></div><p><a id="evil" href="${secretBase}/secret">Un lien vers une autre adresse</a></p><script src="/app.js"></script>`
      );
    }
    const file = /^\/dl\/([0-9a-f]{40})\.torrent$/.exec(u.pathname);
    if (req.method === 'GET' && file) {
      const t = torrents.get(file[1]);
      if (!user || !t) return reply(403, 'text/plain; charset=utf-8', 'Interdit');
      state.downloads.push(t.hash);
      return reply(200, 'application/x-bittorrent', t.file, { 'Content-Disposition': `attachment; filename="${t.name}.torrent"` });
    }
    return reply(404, 'text/plain; charset=utf-8', 'Introuvable');
  });
  server.state = state;
  return server;
}

// ---------- the fake qBittorrent ----------

function parseMultipart(contentType, body) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '');
  if (!m) return [];
  const delimiter = Buffer.from(`--${m[1] || m[2]}`);
  const parts = [];
  let at = body.indexOf(delimiter);
  while (at >= 0) {
    const start = at + delimiter.length;
    if (body.subarray(start, start + 2).toString('latin1') === '--') break;
    const end = body.indexOf(delimiter, start);
    if (end < 0) break;
    const chunk = body.subarray(start + 2, end - 2);
    const cut = chunk.indexOf('\r\n\r\n');
    const head = chunk.subarray(0, cut).toString('utf8');
    parts.push({
      name: (/ name="([^"]*)"/.exec(head) || [])[1],
      filename: (/filename="([^"]*)"/.exec(head) || [])[1],
      type: (/content-type:\s*([^\r\n]+)/i.exec(head) || [])[1],
      data: chunk.subarray(cut + 4)
    });
    at = end;
  }
  return parts;
}

async function startQb() {
  const state = {
    sessions: new Set(),
    serial: 0,
    logins: 0,
    adds: [],
    torrents: [],
    categories: { films: { name: 'films', savePath: '/downloads/films' }, series: { name: 'series', savePath: '/downloads/series' } }
  };
  const server = await h.listen((req, res, rec) => {
    const u = new URL(req.url, 'http://qb');
    const text = (status, body, headers) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=UTF-8', ...headers });
      res.end(body);
    };
    const json = (obj) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'POST' && u.pathname === '/api/v2/auth/login') {
      state.logins++;
      const form = new URLSearchParams(rec.body.toString());
      if (form.get('username') !== 'qbuser' || form.get('password') !== 'qbpass') return text(200, 'Fails.');
      const sid = `sid${++state.serial}`;
      state.sessions.add(sid);
      return text(200, 'Ok.', { 'Set-Cookie': `SID=${sid}; HttpOnly; path=/` });
    }
    const sid = /(?:^|;\s*)SID=([^;]+)/.exec(req.headers.cookie || '');
    if (!sid || !state.sessions.has(sid[1])) return text(403, 'Forbidden');
    const route = `${req.method} ${u.pathname}`;
    if (route === 'GET /api/v2/torrents/categories') return json(state.categories);
    if (route === 'GET /api/v2/transfer/info') return json({ dl_info_speed: 0, up_info_speed: 0 });
    if (route === 'GET /api/v2/torrents/info') {
      const wanted = u.searchParams.get('hashes');
      return json(wanted ? state.torrents.filter((t) => wanted.split('|').includes(t.hash)) : state.torrents);
    }
    if (route === 'POST /api/v2/torrents/add') {
      const parts = parseMultipart(req.headers['content-type'], rec.body);
      const file = parts.find((p) => p.name === 'torrents');
      const field = (name) => {
        const p = parts.find((x) => x.name === name);
        return p ? p.data.toString('utf8') : undefined;
      };
      const add = { bytes: file ? file.data : null, filename: file ? file.filename : null, type: file ? file.type : null, category: field('category'), paused: field('paused'), stopped: field('stopped'), fields: parts.map((p) => p.name) };
      state.adds.push(add);
      const known = file && [...torrents.values()].find((t) => Buffer.compare(t.file, file.data) === 0);
      if (known) {
        state.torrents.push({ hash: known.hash, name: known.name, state: add.paused === 'true' ? 'stoppedDL' : 'downloading', progress: 0, category: add.category || '', added_on: Math.floor(Date.now() / 1000) });
      }
      return text(200, 'Ok.');
    }
    return text(404, 'Not Found');
  });
  server.state = state;
  return server;
}

// ---------- the viewer: what a browser tab of the app does over the WebSocket ----------

class Viewer {
  constructor(peer) {
    this.peer = peer;
    this.msgs = [];
    this.view = null;
    this.status = null;
    this.frames = 0;
    this.jpeg = null;
    this.closeInfo = null;
    peer.on('frame', () => this.pump());
    this.pump();
  }

  pump() {
    for (let f = this.peer.queue.shift(); f; f = this.peer.queue.shift()) {
      if (f.op === OP.text) {
        const m = JSON.parse(f.payload.toString('utf8'));
        this.msgs.push(m);
        if (m.t === 'view') this.view = m;
        else if (m.t === 'status') this.status = m;
      } else if (f.op === OP.binary) {
        this.frames++;
        this.last = Buffer.from(f.payload);
        if (!this.jpeg) this.jpeg = this.last.subarray(0, 3);
      } else if (f.op === OP.close) {
        this.closeInfo = { code: f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005, reason: f.payload.subarray(2).toString('utf8') };
      }
    }
  }

  send(obj) {
    this.peer.text(JSON.stringify(obj));
  }

  // E2E_SHOTS=<folder> keeps what the view showed at the key moments, to look at with human eyes.
  async shot(name) {
    const dir = process.env.E2E_SHOTS;
    if (!dir) return;
    await sleep(500);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.jpg`), this.last);
  }

  // A real click: the remote browser receives the same mouse events a person would produce.
  async click(x, y) {
    this.send({ t: 'mouse', a: 'move', x, y });
    await sleep(30);
    this.send({ t: 'mouse', a: 'down', x, y, b: 0, n: 1 });
    await sleep(30);
    this.send({ t: 'mouse', a: 'up', x, y, b: 0, n: 1 });
    await sleep(80);
  }

  text(s) {
    this.send({ t: 'text', s });
  }

  async press(key) {
    this.send({ t: 'key', a: 'down', key, code: key });
    await sleep(30);
    this.send({ t: 'key', a: 'up', key, code: key });
    await sleep(80);
  }
}

// ---------- the probe: our own, independent DevTools connection to the same tab (it only reads and measures) ----------

function walk(node, fn) {
  if (!node) return;
  fn(node);
  for (const c of node.children || []) walk(c, fn);
  for (const s of node.shadowRoots || []) walk(s, fn);
  if (node.contentDocument) walk(node.contentDocument, fn);
}
const first = (root, pred) => {
  let hit = null;
  walk(root, (n) => {
    if (!hit && pred(n)) hit = n;
  });
  return hit;
};
const all = (root, pred) => {
  const out = [];
  walk(root, (n) => {
    if (pred(n)) out.push(n);
  });
  return out;
};
function attrs(node) {
  const out = {};
  const a = node.attributes || [];
  for (let i = 0; i + 1 < a.length; i += 2) out[a[i]] = a[i + 1];
  return out;
}
const hasClass = (n, c) => (attrs(n).class || '').split(/\s+/).includes(c);
const el = (name, cls) => (n) => n.nodeName === name && (!cls || hasClass(n, cls));
const marked = (name, mark) => (n) => n.nodeName === name && attrs(n)['data-qbt-injected'] === mark;
// The text of a node: its own children only (the browser's built-in shadow trees of form controls repeat it).
function textOf(node) {
  let s = '';
  const visit = (n) => {
    if (n.nodeType === 3) s += n.nodeValue;
    for (const c of n.children || []) visit(c);
  };
  visit(node);
  return s.trim();
}

class Probe {
  constructor(conn, sessionId) {
    this.conn = conn;
    this.sessionId = sessionId;
  }

  static async attach(targetId) {
    const conn = await cdp.connect(chrome.url);
    const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true });
    const probe = new Probe(conn, sessionId);
    probes.push(probe);
    await probe.send('DOM.enable');
    if (DEBUG) {
      conn.route(sessionId, (ev) => {
        if (ev.method === 'Runtime.consoleAPICalled') {
          const text = (ev.params.args || []).map((a) => (a.value !== undefined ? a.value : a.description)).join(' ');
          process.stderr.write(`[page ${ev.params.type}] ${text}\n`);
        } else if (ev.method === 'Runtime.exceptionThrown') {
          process.stderr.write(`[page exception] ${JSON.stringify(ev.params.exceptionDetails).slice(0, 800)}\n`);
        }
      });
      await probe.send('Runtime.enable');
    }
    return probe;
  }

  send(method, params) {
    return this.conn.send(method, params, this.sessionId);
  }

  // In the main world of the page, like any script of the page itself.
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval failed: ${(r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text}`);
    return r.result.value;
  }

  // The centre of an element of the page (null when there is none or it has no size).
  rect(selector) {
    return this.eval(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)});
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return r.width && r.height ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
    })()`);
  }

  async tree() {
    const { root } = await this.send('DOM.getDocument', { depth: -1, pierce: true });
    return root;
  }

  async box(node) {
    const { model } = await this.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId });
    const q = model.content;
    return { x: Math.round((q[0] + q[2] + q[4] + q[6]) / 4), y: Math.round((q[1] + q[3] + q[5] + q[7]) / 4), top: q[1], height: q[5] - q[1] };
  }

  async prop(node, name) {
    const { object } = await this.send('DOM.resolveNode', { backendNodeId: node.backendNodeId });
    const r = await this.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: `function () { return this[${JSON.stringify(name)}]; }`, returnByValue: true });
    return r.result.value;
  }
}

// ---------- scenes ----------

// A user of the app with a tab of the view: the WebSocket the page of the app opens, and the probe on the remote tab.
async function openSession(username, known = null) {
  const client = known || (await h.clientFor(app, username, PASS));
  const cookie = client.cookie;
  const r = await connect(app.port, { path: '/api/c411/ws', headers: { Origin: `http://127.0.0.1:${app.port}`, Cookie: cookie } });
  assert.equal(r.status, 101, `the WebSocket was refused (${r.status})`);
  const v = new Viewer(r.peer);
  viewers.push(v);
  v.send({ t: 'hello', w: 1000, h: 700 });
  await poll(() => v.status && v.status.url && !v.status.loading, 20000, 'the remote page is loaded');
  const s = app.c411.hub.sessions.get(username);
  assert.ok(s && s.page, 'the user has a remote tab');
  const probe = await Probe.attach(s.page.targetId);
  return { client, cookie, v, probe, page: s.page, username };
}

const wsHeaders = (cookie) => ({ Origin: `http://127.0.0.1:${app.port}`, ...(cookie ? { Cookie: cookie } : {}) });

const torrentUrl = (hash, query = '') => `${base}/torrents/${hash}${query}`;

async function loaded(s, url, ms = 15000) {
  await poll(() => s.v.status && s.v.status.url === url && !s.v.status.loading, ms, `the view shows ${url}`);
}

async function go(s, url) {
  s.v.send({ t: 'goto', url });
  await loaded(s, url);
}

async function clickOn(s, selector) {
  const at = await poll(() => s.probe.rect(selector), 10000, `${selector} is on the page`);
  await s.v.click(at.x, at.y);
}

// The user types into the form of the site, inside the view.
async function signIn(s, name) {
  await clickOn(s, '#u');
  s.v.text(SITE_USER(name));
  await clickOn(s, '#p');
  s.v.text(SITE_PASS);
  await clickOn(s, '#go');
  await poll(() => site.state.logins.includes(SITE_USER(name)), 10000, 'the site received the login');
  await loaded(s, torrentUrl(site.state.landing));
}

async function readyDialog(s) {
  return poll(async () => {
    const root = await s.probe.tree();
    const host = first(root, marked('DIV', 'dialog'));
    const shadow = host && (host.shadowRoots || [])[0];
    if (!shadow) return null;
    const ok = first(shadow, el('BUTTON', 'ok'));
    const cat = first(shadow, el('SELECT', 'cat'));
    const cancel = first(shadow, el('BUTTON', 'cancel'));
    if (!ok || !cat || !cancel || 'disabled' in attrs(ok) || all(cat, el('OPTION')).length < 2) return null;
    return { host, shadow, ok, cat, cancel };
  }, 15000, 'the dialog is ready');
}

async function clickNode(s, node) {
  const at = await s.probe.box(node);
  await s.v.click(at.x, at.y);
}

// Clicks the row of a category in the open list of the dialog.
async function pickCategory(s, dlg, label) {
  const options = all(dlg.cat, el('OPTION'));
  const i = options.findIndex((o) => textOf(o) === label);
  assert.ok(i >= 0, `option « ${label} » missing: ${options.map(textOf).join(' | ')}`);
  let at = await s.probe.box(options[i]).catch(() => null);
  if (!at) {
    // An option without a box of its own: work it out from the list.
    const list = await s.probe.box(dlg.cat);
    at = { x: list.x, y: list.top + ((i + 0.5) * list.height) / options.length };
  }
  await s.v.click(at.x, at.y);
  await poll(async () => (await s.probe.prop(dlg.cat, 'value')) === label, 3000, `« ${label} » is selected`);
}

async function texts(s, tag, mark, cls) {
  const root = await s.probe.tree();
  const host = first(root, marked(tag, mark));
  const shadow = host && (host.shadowRoots || [])[0];
  if (!shadow) return [];
  return cls ? all(shadow, el('DIV', cls)).map(textOf) : [textOf(shadow)];
}
const toasts = (s) => texts(s, 'DIV', 'toasts', 't');
const badge = (s) => texts(s, 'SPAN', 'badge');
const hasDialog = (s) => s.probe.eval(`!!document.querySelector('[data-qbt-injected="dialog"]')`);
const clicksOf = (s) => s.probe.eval(`document.documentElement.getAttribute('data-clicks')`);
const categoryRequests = () => qb.reqs.filter((r) => r.url.startsWith('/api/v2/torrents/categories')).length;
const hex = (b) => Buffer.from(b).toString('hex');

before(async () => {
  chrome = await launchChrome();
  if (!chrome) return;
  site = await startSite();
  qb = await startQb();
  base = `http://localhost:${site.port}`;
  secretBase = `http://127.0.0.1:${site.port}`;
  app = await h.startApp({
    c411: { browserUrl: chrome.url, allowHttp: true, hosts: ['localhost'], bridgeHosts: ['localhost'], homeUrl: `${base}/`, maxSessions: 10, upgradesPerMinute: 1000, maxSocketsPerUser: 20, armMs: 8000 }
  });
  const admin = await h.adminClient(app);
  const r = await admin.put('/api/admin/connections/qb', { url: qb.url, username: 'qbuser', password: 'qbpass' });
  assert.equal(r.status, 200, r.text);
});

afterEach(() => {
  for (const v of viewers.splice(0)) v.peer.destroy();
  for (const p of probes.splice(0)) p.conn.close();
});

after(async () => {
  for (const v of viewers.splice(0)) v.peer.destroy();
  for (const p of probes.splice(0)) p.conn.close();
  if (app) await app.close();
  if (chrome) await chrome.stop();
  if (site) await site.close();
  if (qb) await qb.close();
});

// ---------- the user's path ----------

test('parcours complet : connexion au site dans la vue, bouton « ⇩ qBittorrent », catégorie, envoi, badge, puis envoi au clavier', { timeout: 120000 }, async (t) => {
  if (!chrome) return t.skip('Chrome introuvable');
  const alpha = makeTorrent('alpha');
  const beta = makeTorrent('beta');
  site.state.landing = alpha.hash;
  const s = await openSession('alice');

  await poll(() => s.v.frames > 0, 10000, 'the first image');
  assert.deepEqual([...s.v.jpeg.subarray(0, 2)], [0xff, 0xd8], 'the images are JPEG');
  assert.deepEqual([s.v.view.w, s.v.view.h], [1000, 700]);
  assert.equal(s.v.status.url, `${base}/`, 'the site asks to sign in');
  await s.v.shot('1-connexion-site');

  // The user signs in to the site, in the view: the password goes to the site and nowhere else.
  await signIn(s, 'alice');
  const ours = await poll(() => s.probe.rect(OURS), 15000, 'the « ⇩ qBittorrent » button');
  assert.ok(ours);
  assert.equal(await s.probe.eval(`document.querySelectorAll('${OURS}').length`), 1, 'one button of ours, next to the only « Télécharger »');
  assert.equal(await s.probe.eval(`document.querySelector('${OURS}').textContent`), '⇩ qBittorrent');
  assert.equal(await s.probe.eval(`document.querySelector('#dl').nextElementSibling === document.querySelector('${OURS}')`), true);
  await s.v.shot('2-bouton');

  // 1. blob flow: the dialog, a category, « Envoyer ».
  await clickOn(s, OURS);
  let dlg = await readyDialog(s);
  await s.v.shot('3-dialogue');
  assert.equal(await s.probe.prop(dlg.cat, 'value'), '', 'no category chosen yet');
  assert.deepEqual(all(dlg.cat, el('OPTION')).map(textOf), ['(aucune catégorie)', 'films', 'series']);
  await pickCategory(s, dlg, 'films');
  await s.v.shot('4-categorie');
  assert.equal(qb.state.adds.length, 0, 'nothing is sent before the confirmation');
  await clickNode(s, dlg.ok);

  await poll(() => qb.state.adds.length === 1, 15000, 'qBittorrent received the torrent');
  let add = qb.state.adds[0];
  assert.equal(hex(add.bytes), hex(alpha.file), 'the .torrent arrives byte for byte');
  assert.equal(add.category, 'films');
  assert.equal(add.paused, undefined, 'not paused');
  assert.match(add.filename, /\.torrent$/i);
  await poll(async () => (await toasts(s)).some((x) => x.includes('Envoyé à qBittorrent (catégorie : films)')), 8000, 'the confirmation toast');
  await s.v.shot('5-envoye');
  await poll(async () => (await badge(s)).some((x) => /qBittorrent : 0 % · téléchargement/.test(x)), 12000, 'the badge shows the torrent in qBittorrent');
  await s.v.shot('6-badge');
  assert.equal(await hasDialog(s), false, 'the dialog is closed');

  // 2. direct flow, the keyboard: the category of the last send is already chosen; Enter confirms.
  site.state.landing = beta.hash;
  await go(s, torrentUrl(beta.hash, '?flow=direct'));
  await poll(() => s.probe.rect(OURS), 15000, 'the button on the second page');
  await clickOn(s, OURS);
  dlg = await readyDialog(s);
  assert.equal(await s.probe.prop(dlg.cat, 'value'), 'films', 'the category of the last send is preselected');
  await pickCategory(s, dlg, 'series');
  await s.v.press('Enter');

  await poll(() => qb.state.adds.length === 2, 15000, 'the second torrent arrives');
  add = qb.state.adds[1];
  assert.equal(hex(add.bytes), hex(beta.file));
  assert.equal(add.category, 'series');
  await sleep(1500);
  assert.equal(qb.state.adds.length, 2, 'exactly one send per confirmation');
  assert.equal(await hasDialog(s), false);
  assert.deepEqual(s.v.msgs.filter((m) => m.t === 'error'), []);
});

// ---------- a hostile page ----------

test('une page hostile ne peut ni ouvrir le dialogue, ni le confirmer, ni provoquer un envoi qui n’a pas été confirmé', { timeout: 120000 }, async (t) => {
  if (!chrome) return t.skip('Chrome introuvable');
  const gamma = makeTorrent('gamma');
  site.state.landing = gamma.hash;
  const s = await openSession('mallory');
  await signIn(s, 'mallory');
  await poll(() => s.probe.rect(OURS), 15000, 'the button');
  const adds = qb.state.adds.length;
  const asked = categoryRequests();

  // Clicks made by a script of the page are not clicks of the user.
  await s.probe.eval(`(() => {
    const b = document.querySelector('${OURS}');
    b.click();
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
    b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, composed: true }));
    return true;
  })()`);
  await sleep(1500);
  assert.equal(await hasDialog(s), false, 'a synthetic click opens nothing');
  assert.equal(categoryRequests(), asked, 'a synthetic click does not even reach qBittorrent');

  // A real click opens the dialog, which the page can neither read nor confirm.
  await clickOn(s, OURS);
  const dlg = await readyDialog(s);
  assert.equal(await s.probe.eval(`document.querySelector('[data-qbt-injected="dialog"]').shadowRoot === null`), true, 'the dialog is in a closed shadow root');
  await s.probe.eval(`(() => {
    const host = document.querySelector('[data-qbt-injected="dialog"]');
    for (const type of ['keydown', 'keypress', 'keyup']) host.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, composed: true }));
    host.click();
    host.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    return true;
  })()`);
  await sleep(1500);
  assert.equal(qb.state.adds.length, adds, 'forged keys and clicks confirm nothing');
  assert.equal(await hasDialog(s), true, 'the dialog is still waiting for the user');
  await clickNode(s, dlg.cancel);
  await poll(async () => !(await hasDialog(s)), 5000, 'Annuler closes the dialog');
  assert.equal(qb.state.adds.length, adds, 'Annuler sends nothing');

  // The site's own « Télécharger » (the user does not use ours): the browser downloads, the extension does nothing.
  await clickOn(s, '#dl');
  await poll(async () => (await clicksOf(s)) === '1', 5000, 'the page received the click');
  await sleep(2500);
  assert.equal(qb.state.adds.length, adds, 'a download nobody armed goes nowhere');
  assert.deepEqual(await toasts(s), [], 'and it does not complain either');

  // A page that starts downloads by itself, by both flows.
  for (const query of ['?auto=1', '?auto=1&flow=direct']) {
    await go(s, torrentUrl(gamma.hash, query));
    await poll(async () => (await clicksOf(s)) === '1', 8000, `the page downloads by itself (${query})`);
    await sleep(2500);
    assert.equal(qb.state.adds.length, adds, `nothing is sent (${query})`);
    assert.deepEqual(await toasts(s), [], `no toast (${query})`);
  }
});

// ---------- other users, other sites, the door ----------

test('chaque utilisateur a son navigateur ; les adresses non autorisées et les secrets de l’application restent hors du site', { timeout: 120000 }, async (t) => {
  if (!chrome) return t.skip('Chrome introuvable');
  const delta = makeTorrent('delta');
  site.state.landing = delta.hash;
  const carol = await openSession('carol');
  await signIn(carol, 'carol');
  const dave = await openSession('dave');
  assert.notEqual(carol.page.contextId, dave.page.contextId, 'one browser context per user');

  await go(carol, `${base}/whoami`);
  assert.equal(carol.v.status.title, `qui:${SITE_USER('carol')}`);
  await go(dave, `${base}/whoami`);
  assert.equal(dave.v.status.title, 'qui:anonyme', 'the session of one user is not the session of another');

  // An address that is not on the list: not even tried when the app is asked for it, and refused when a link of the page leads there.
  const hits = site.state.secretHits;
  const shown = carol.v.status.url;
  carol.v.send({ t: 'goto', url: `${secretBase}/secret` });
  await sleep(1500);
  assert.equal(carol.v.status.url, shown, 'the tab does not move');
  await go(carol, torrentUrl(delta.hash));
  const seenLink = carol.v.msgs.length;
  await clickOn(carol, '#evil');
  await poll(() => carol.v.msgs.slice(seenLink).some((m) => m.t === 'toast' && /Adresse bloquée : 127\.0\.0\.1/.test(m.text)), 8000, 'the link is refused');
  await carol.v.shot('7-adresse-bloquee');
  await sleep(500);
  assert.equal(site.state.secretHits, hits, 'the other address never received a request');
  assert.equal(String(carol.v.status.url).startsWith(secretBase), false, 'the tab is not on the other address');

  // Nothing of the app reaches the site, and qBittorrent’s credentials are nowhere in the tab or in what the app tells the viewer.
  const journal = JSON.stringify(site.reqs.map((r) => ({ url: r.url, headers: r.headers })));
  for (const secret of ['arr_session', 'qbpass', 'qbuser', 'SID=', 'x-requested-with', 'arr411']) {
    assert.equal(journal.toLowerCase().includes(secret.toLowerCase()), false, `the site never saw « ${secret} »`);
  }
  const dom = JSON.stringify(await carol.probe.tree());
  const wire = JSON.stringify([...carol.v.msgs, ...dave.v.msgs]);
  for (const secret of ['qbpass', 'qbuser', 'arr_session']) {
    assert.equal(dom.includes(secret), false, `« ${secret} » is not in the page`);
    assert.equal(wire.includes(secret), false, `« ${secret} » is not in the messages of the view`);
  }

  // The door: no session, no WebSocket, and no request reaches the site on its behalf.
  const requests = site.reqs.length;
  const door = await connect(app.port, { path: '/api/c411/ws', headers: wsHeaders() });
  assert.equal(door.status, 401);
  const forged = await connect(app.port, { path: '/api/c411/ws', headers: { Origin: 'http://evil.example', Cookie: carol.cookie } });
  assert.notEqual(forged.status, 101, 'a page of another site cannot open the view with the cookie of the user');
  await sleep(300);
  assert.equal(site.reqs.length, requests);

  // The cookies kept for the next visit are the site's only, and nothing else.
  for (const s of [carol, dave]) s.v.peer.destroy();
  const dir = path.join(app.dataDir, 'c411');
  await poll(() => fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.json') && fs.readFileSync(path.join(dir, f), 'utf8').includes('"sess"')), 8000, 'the cookies are saved');
  for (const f of fs.readdirSync(dir)) {
    const saved = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const secret of ['qbpass', 'qbuser', 'arr_session', 'SID']) assert.equal(saved.includes(secret), false, `${f} does not hold « ${secret} »`);
  }
});

// ---------- signing out, and losing the right to use the view ----------

test('se déconnecter de l’application ferme la vue, et le cookie rejoué n’ouvre plus rien', { timeout: 60000 }, async (t) => {
  if (!chrome) return t.skip('Chrome introuvable');
  const s = await openSession('erin');
  const out = await s.client.post('/api/auth/logout', {});
  assert.equal(out.status, 200, out.text);
  await poll(() => s.v.closeInfo, 8000, 'the view is closed');
  assert.equal(s.v.closeInfo.code, 4401);
  assert.ok(s.v.msgs.some((m) => m.t === 'error' && m.code === 'signed_out'), 'the viewer is told why');

  // The session is ended on the server: the same cookie, replayed, opens nothing (the tab itself is kept until it is idle).
  const replay = await connect(app.port, { path: '/api/c411/ws', headers: wsHeaders(s.cookie) });
  assert.equal(replay.status, 401);
});

test('désactiver un compte ferme sa vue et son onglet distant, et efface sa connexion c411.org enregistrée', { timeout: 120000 }, async (t) => {
  if (!chrome) return t.skip('Chrome introuvable');
  const zeta = makeTorrent('zeta');
  site.state.landing = zeta.hash;
  const first = await openSession('frank');
  await signIn(first, 'frank');
  const token = [...site.state.sessions].find(([, who]) => who === SITE_USER('frank'))[0];
  const dir = path.join(app.dataDir, 'c411');
  const savedFile = () => (fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes(token)) : undefined);

  // Leaving the view keeps the connection to the site for the next visit.
  first.v.peer.destroy();
  const file = await poll(savedFile, 10000, 'the connection to the site is saved');
  assert.match(file, /^[0-9a-f]{64}\.json$/);

  // A new window finds the same tab, still signed in to the site.
  const again = await openSession('frank', first.client);
  assert.equal(again.page.targetId, first.page.targetId, 'the tab of the user is kept while he is away');
  const targetId = again.page.targetId;

  const admin = await h.adminClient(app);
  const off = await admin.patch('/api/admin/users/frank', { disabled: true });
  assert.equal(off.status, 200, off.text);

  await poll(() => again.v.closeInfo, 10000, 'the view is closed');
  assert.equal(again.v.closeInfo.code, 4401);
  assert.ok(again.v.msgs.some((m) => m.t === 'error' && m.code === 'signed_out'), 'the viewer is told why');
  const conn = await cdp.connect(chrome.url);
  try {
    await poll(async () => !(await conn.send('Target.getTargets')).targetInfos.some((i) => i.targetId === targetId), 10000, 'the remote tab is gone');
  } finally {
    conn.close();
  }
  await poll(() => !savedFile(), 10000, 'the saved connection to the site is deleted');
  const door = await connect(app.port, { path: '/api/c411/ws', headers: wsHeaders(first.cookie) });
  assert.equal(door.status, 401, 'the account cannot open the view any more');
});

test('le serveur n’a consigné aucune erreur', (t) => {
  if (!chrome) return t.skip('Chrome introuvable');
  assert.deepEqual(errors, []);
});

// By hand: E2E_KEEP=<seconds> node --test-name-pattern=démonstration test/c411-e2e.test.js keeps the app, Chrome, the fake site
// and the fake qBittorrent up for that long, to try the view in a browser.
test('démonstration à la main', { skip: !process.env.E2E_KEEP, timeout: 3600000 }, async (t) => {
  if (!chrome) return t.skip('Chrome introuvable');
  site.state.landing = makeTorrent('demo').hash;
  process.stderr.write(`\n[e2e] application : http://127.0.0.1:${app.port}  (${h.ADMIN.username} / ${h.ADMIN.password})\n[e2e] faux site : ${base}/  (${SITE_USER('demo')} / ${SITE_PASS})\n`);
  await sleep(Number(process.env.E2E_KEEP) * 1000);
});
