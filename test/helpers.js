'use strict';
// Shared test helpers: environment, throw-away apps, an HTTP client with a cookie jar, and fake services.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const ENV_KEYS = [
  'PORT', 'HOST', 'DATA_DIR', 'PUBLIC_URL', 'TRUST_PROXY', 'COOKIE_SECURE', 'SESSION_SECRET', 'SESSION_DAYS',
  'ADMIN_USER', 'ADMIN_PASSWORD', 'INSECURE_UPSTREAM_TLS', 'ALLOW_SEARCH_COMMANDS', 'LOG_REQUESTS', 'MAX_UPLOAD_MB',
  'QBITTORRENT_URL', 'QBITTORRENT_USERNAME', 'QBITTORRENT_PASSWORD', 'RADARR_URL', 'RADARR_API_KEY',
  'SONARR_URL', 'SONARR_API_KEY', 'LIDARR_URL', 'LIDARR_API_KEY',
  'C411_BROWSER_URL', 'C411_MAX_SESSIONS', 'C411_IDLE_MINUTES', 'C411_PERSIST_COOKIES', 'C411_ALLOWED_HOSTS',
  'EGRESS_PORT', 'EGRESS_HOST'
];
const ADMIN = { username: 'boss', password: 'correct horse battery' };

const tmpDirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arr411-test-'));
  tmpDirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

// Must run before anything from ../server is required: the configuration is read once from the environment.
function prepareEnv(extra) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, { DATA_DIR: tmpDir(), ADMIN_USER: ADMIN.username, ADMIN_PASSWORD: ADMIN.password }, extra);
  if (!process.env.TEST_VERBOSE) {
    console.log = () => {};
    console.warn = () => {};
  }
}

// A running app on a free port, with its own empty data directory. `extra` is given to start() (for example { c411: {...} }).
async function startApp(extra = {}) {
  const config = require('../server/config');
  const { start } = require('../server/index');
  config.dataDir = tmpDir();
  const app = await start({ port: 0, host: '127.0.0.1', ...extra });
  app.port = app.server.address().port;
  app.dataDir = config.dataDir;
  return app;
}

function rawRequest(port, { method = 'GET', path: reqPath = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, headers);
    if (body != null && !Object.keys(h).some((k) => k.toLowerCase() === 'content-length')) h['Content-Length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          setCookie: [].concat(res.headers['set-cookie'] || []),
          body: buf,
          get text() {
            return buf.toString('utf8');
          },
          get json() {
            return JSON.parse(buf.toString('utf8'));
          }
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body != null ? body : undefined);
  });
}

const hasHeader = (headers, name) => Object.keys(headers).some((k) => k.toLowerCase() === name);

class Client {
  constructor(app, defaults = {}) {
    this.port = app.port;
    this.jar = new Map();
    this.defaults = defaults;
  }

  get cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(setCookie) {
    for (const line of setCookie) {
      const [pair, ...attrs] = line.split(';').map((s) => s.trim());
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      const maxAge = attrs.find((a) => /^max-age=/i.test(a));
      if (!value || (maxAge && Number(maxAge.split('=')[1]) <= 0)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  // o: { headers, json, form, body, csrf: false, jar: false }
  async send(method, reqPath, o = {}) {
    const headers = Object.assign({}, this.defaults, o.headers);
    let body = o.body;
    if (o.json !== undefined) {
      body = JSON.stringify(o.json);
      if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json';
    } else if (o.form) {
      body = new URLSearchParams(o.form).toString();
      if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    if (o.csrf !== false && method !== 'GET' && method !== 'HEAD' && !hasHeader(headers, 'x-requested-with')) headers['X-Requested-With'] = 'arr411';
    if (o.jar !== false && this.jar.size && !hasHeader(headers, 'cookie')) headers.Cookie = this.cookie;
    const res = await rawRequest(this.port, { method, path: reqPath, headers, body });
    if (o.jar !== false) this.absorb(res.setCookie);
    return res;
  }

  get(p, o) {
    return this.send('GET', p, o);
  }

  post(p, json, o) {
    return this.send('POST', p, Object.assign({ json }, o));
  }

  put(p, json, o) {
    return this.send('PUT', p, Object.assign({ json }, o));
  }

  patch(p, json, o) {
    return this.send('PATCH', p, Object.assign({ json }, o));
  }

  del(p, o) {
    return this.send('DELETE', p, o);
  }

  async login(username = ADMIN.username, password = ADMIN.password, o) {
    return this.post('/api/auth/login', { username, password }, o);
  }
}

// Creates a user straight in the store, then returns a client that is signed in as that user.
async function clientFor(app, username, password, role = 'user') {
  if (!app.users.find(username)) await app.users.create({ username, password, role });
  const c = new Client(app);
  const res = await c.login(username, password);
  if (res.status !== 200) throw new Error(`login ${username} -> ${res.status} ${res.text}`);
  return c;
}

async function adminClient(app) {
  const c = new Client(app);
  const res = await c.login();
  if (res.status !== 200) throw new Error(`admin login -> ${res.status} ${res.text}`);
  return c;
}

// ---------- fake services ----------
async function listen(handler) {
  const reqs = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rec = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
    reqs.push(rec);
    try {
      await handler(req, res, rec);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String((e && e.stack) || e));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    server,
    port,
    reqs,
    url: `http://127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections();
      })
  };
}

const sendJson = (res, status, obj, headers) => {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, headers));
  res.end(JSON.stringify(obj));
};

// qBittorrent: SID cookie after /auth/login, 403 without it. state.mode: '204' (default), '200' (older "Ok."), 'banned', '401'.
// state.noAuth turns the authentication off, like "bypass for clients on localhost".
async function qbMock() {
  const state = { user: 'qbuser', pass: 'qbpass', mode: '204', noAuth: false, sessions: new Set(), logins: 0, serial: 0 };
  const m = await listen((req, res, rec) => {
    const u = new URL(req.url, 'http://x');
    const text = (status, body, headers) => {
      res.writeHead(status, Object.assign({ 'Content-Type': 'text/plain; charset=UTF-8' }, headers));
      res.end(body);
    };
    if (u.pathname === '/api/v2/auth/login' && req.method === 'POST') {
      state.logins++;
      const form = new URLSearchParams(rec.body.toString());
      if (state.mode === 'banned') return text(403, 'Your IP address has been banned after too many failed authentication attempts.');
      if (form.get('username') !== state.user || form.get('password') !== state.pass) {
        return state.mode === '401' ? text(401, 'Unauthorized') : text(200, 'Fails.');
      }
      const sid = `sid${++state.serial}`;
      state.sessions.add(sid);
      const cookie = { 'Set-Cookie': `SID=${sid}; HttpOnly; path=/` };
      return state.mode === '200' ? text(200, 'Ok.', cookie) : text(204, '', cookie);
    }
    const sid = /(?:^|;\s*)SID=([^;]+)/.exec(req.headers.cookie || '');
    if (u.pathname === '/api/v2/auth/logout' && req.method === 'POST') {
      if (sid) state.sessions.delete(sid[1]);
      return text(200, '');
    }
    if (!state.noAuth && (!sid || !state.sessions.has(sid[1]))) return text(403, 'Forbidden');
    switch (`${req.method} ${u.pathname}`) {
      case 'GET /api/v2/app/webapiVersion': return text(200, '2.11.2');
      case 'GET /api/v2/app/version': return text(200, 'v5.0.3');
      case 'GET /api/v2/app/preferences': return sendJson(res, 200, { save_path: '/downloads' });
      case 'POST /api/v2/app/setPreferences': return text(200, 'Ok.');
      case 'GET /api/v2/torrents/info': return sendJson(res, 200, [{ hash: 'abc', name: 'Film.2024.1080p' }]);
      case 'GET /api/v2/sync/maindata': return sendJson(res, 200, { rid: 1, full_update: true, torrents: {} });
      case 'POST /api/v2/torrents/add': return text(200, 'Ok.');
      case 'GET /api/v2/log/main': return sendJson(res, 200, []);
      case 'GET /api/v2/rss/items': return sendJson(res, 200, {});
      case 'POST /api/v2/search/start': return sendJson(res, 200, { id: 1 });
      case 'GET /api/v2/app/redirect': return text(302, '', { Location: '/login' });
      default: return text(404, 'Not Found');
    }
  });
  m.state = state;
  m.logins = () => state.logins;
  m.seen = (pathname) => m.reqs.filter((r) => r.url.split('?')[0] === pathname);
  return m;
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// Radarr / Sonarr (prefix /api/v3) or Lidarr (/api/v1): the API key goes in X-Api-Key.
async function arrMock({ key = 'the-api-key', prefix = '/api/v3', root = 'movie' } = {}) {
  const m = await listen((req, res, rec) => {
    if (req.headers['x-api-key'] !== key) return sendJson(res, 401, { message: 'Unauthorized' });
    const u = new URL(req.url, 'http://x');
    if (!u.pathname.startsWith(prefix + '/')) return sendJson(res, 404, { message: 'NotFound' });
    const p = u.pathname.slice(prefix.length);
    if (req.method === 'GET' && p === `/${root}`) return sendJson(res, 200, [{ id: 1, title: 'Dune' }]);
    if (req.method === 'GET' && p === `/${root}/lookup`) return sendJson(res, 200, { query: u.search });
    if (req.method === 'POST' && p === `/${root}`) {
      let body = null;
      try {
        body = JSON.parse(rec.body.toString());
      } catch {
        /* not JSON */
      }
      return sendJson(res, 201, { id: 99, echo: body });
    }
    if (req.method === 'POST' && p === '/command') return sendJson(res, 201, { id: 5, name: 'ok' });
    if (req.method === 'GET' && p === '/system/status') return sendJson(res, 200, { version: '5.0' });
    if (req.method === 'GET' && p === '/config/host') return sendJson(res, 200, { port: 7878 });
    if (req.method === 'GET' && p === '/bad') return sendJson(res, 400, [{ errorMessage: 'Titre invalide' }]);
    if (req.method === 'GET' && p === '/redirect') {
      res.writeHead(302, { Location: '/login?ReturnUrl=%2F' });
      return res.end();
    }
    if (req.method === 'GET' && p === '/leak') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'upstream=1; Path=/',
        'WWW-Authenticate': 'Basic realm="x"',
        Server: 'UpstreamServer/1.0',
        'X-Powered-By': 'Upstream',
        'Content-Disposition': 'attachment; filename="export.json"'
      });
      return res.end('{"ok":true}');
    }
    if (req.method === 'GET' && p === '/mediacover/1/poster.jpg') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(PNG);
    }
    if (req.method === 'GET' && p === '/mediacover/2/poster.jpg') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('nope');
    }
    if (req.method === 'GET' && p === '/mediacover/3/poster.jpg') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html>not an image</html>');
    }
    return sendJson(res, 404, { message: 'NotFound' });
  });
  m.key = key;
  m.seen = (pathname) => m.reqs.filter((r) => r.url.split('?')[0] === pathname);
  return m;
}

// multipart/form-data body, like the browser builds for a torrent upload.
function multipart(parts, boundary = '----arr411Test' + Math.random().toString(16).slice(2)) {
  const chunks = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename) head += `; filename="${p.filename}"\r\nContent-Type: ${p.type || 'application/octet-stream'}`;
    chunks.push(Buffer.from(head + '\r\n\r\n'), Buffer.isBuffer(p.value) ? p.value : Buffer.from(String(p.value)), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

const gunzip = (buf) => zlib.gunzipSync(buf).toString('utf8');

module.exports = { ADMIN, ENV_KEYS, prepareEnv, tmpDir, startApp, rawRequest, Client, clientFor, adminClient, listen, qbMock, arrMock, multipart, gunzip, PNG };
