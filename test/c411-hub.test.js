'use strict';
// The C411 view against a real (headless) Chrome and a fake web site on localhost: remote tab, input, address guard,
// popups, extension bridge, cookies, limits. Skipped when no Chrome is installed (CHROME_BIN can point at one).
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchChrome, sleep } = require('./chrome');
const { Hub } = require('../server/c411/sessions');
const { createMatcher } = require('../server/c411/hosts');
const { createCookieStore } = require('../server/c411/cookies');
const { connect } = require('../server/c411/cdp');

let chrome = null;
let site = null;
let base = '';
let secretBase = '';
const hits = { secret: 0, requests: [] };
const hubs = [];
const dirs = [];

const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'arr411-hub-'));
  dirs.push(d);
  return d;
};

function page(title, body) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{margin:0;font:18px sans-serif}.a{position:absolute;left:20px;width:300px;height:40px}</style>${body}`;
}

function homeHtml(auto) {
  return page(
    'Home',
    `<button class="a" id="b" style="top:10px" onclick="document.title='clicked:'+event.isTrusted">Go</button>
<input class="a" id="i" style="top:60px" oninput="document.title='typed:'+this.value">
<a class="a" id="evil" style="top:110px" href="${secretBase}/secret">evil</a>
<a class="a" id="redir" style="top:160px" href="/redir">redir</a>
<button class="a" id="popup" style="top:210px" onclick="window.open('/popped')">popup</button>
<button class="a" id="popevil" style="top:260px" onclick="window.open('${secretBase}/secret')">popevil</button>
<a class="a" id="dl" style="top:310px" href="/file" download>dl</a>
<button class="a" id="ask" style="top:360px" onclick="__ask('7',{type:'ping'})">ask</button>
<a class="a" id="set" style="top:410px" href="/set">set</a>
<a class="a" id="who" style="top:460px" href="/whoami">who</a>
${auto ? `<script>setTimeout(function(){ if (window.__ask) __ask('auto',{type:'ping'}); }, 300)</script>` : ''}`
  );
}

const TOP = { b: 10, i: 60, evil: 110, redir: 160, popup: 210, popevil: 260, dl: 310, ask: 360, set: 410, who: 460 };
const at = (name) => ({ x: 170, y: TOP[name] + 20 });

before(async () => {
  site = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.requests.push({ path: u.pathname, cookie: req.headers.cookie || '' });
    const html = (s, extra) => {
      res.writeHead(200, Object.assign({ 'content-type': 'text/html; charset=utf-8' }, extra));
      res.end(s);
    };
    switch (u.pathname) {
      case '/':
        return html(homeHtml(false));
      case '/auto':
        return html(homeHtml(true));
      case '/popped':
        return html(page('Popped', '<p>popup content</p>'));
      case '/set':
        return html(page('Set', '<p>cookie set</p>'), { 'set-cookie': 'sess=v1; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600' });
      case '/whoami':
        return html(page('cookie[' + (req.headers.cookie || '') + ']', '<p>who</p>'));
      case '/redir':
        res.writeHead(302, { location: `${secretBase}/secret` });
        return res.end();
      case '/secret':
        hits.secret++;
        return html(page('SECRET', '<p>secret</p>'));
      case '/file':
        res.writeHead(200, { 'content-type': 'application/x-bittorrent', 'content-disposition': 'attachment; filename="x.torrent"' });
        return res.end('d4:infod4:name1:xee');
      default:
        res.writeHead(404);
        return res.end('nope');
    }
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const port = site.address().port;
  base = `http://localhost:${port}`;
  secretBase = `http://127.0.0.1:${port}`;
  chrome = await launchChrome();
});

// One hub per browser: a second hub would treat the first one's windows as foreign and close them.
afterEach(async () => {
  while (hubs.length) await hubs.pop().close().catch(() => {});
});

after(async () => {
  for (const h of hubs) await h.close().catch(() => {});
  if (chrome) await chrome.stop();
  site.closeAllConnections();
  await new Promise((r) => site.close(r));
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

// A minimal stand-in for the extension scripts: the site asks through __ask(), the answer comes back in the title.
function buildScripts(names) {
  const main = `(function(){var T=${JSON.stringify(names.topic)};
window.__ask=function(id,msg){document.dispatchEvent(new CustomEvent(T,{detail:JSON.stringify({id:id,msg:msg})}));};
document.addEventListener(T+'r',function(e){document.title='got:'+e.detail;});})();`;
  const isolated = `(function(){var B=${JSON.stringify(names.binding)},R=${JSON.stringify(names.recv)},T=${JSON.stringify(names.topic)};
var q=[],send=null;
window[R]=function(s){document.dispatchEvent(new CustomEvent(T+'r',{detail:s}));};
document.addEventListener(T,function(e){if(send)send(e.detail);else q.push(e.detail);});
var t0=Date.now();(function poll(){var b=window[B];if(typeof b==='function'){delete window[B];send=b;q.splice(0).forEach(b);return;}
if(Date.now()-t0<15000)setTimeout(poll,25);})();})();`;
  return { main, isolated };
}

// What Arr411 calls an account: the name and the creation date. A generation number stands for the date here.
const acct = (name, generation = 1) => `acct:${name}:${generation}`;

function makeHub(extra = {}) {
  const matcher = createMatcher(['localhost']);
  const calls = [];
  const engine = {
    handle: async (user, msg, opts) => {
      calls.push({ user: user.username, type: msg.type, recentInput: opts.recentInput });
      return { ok: true, echo: msg.type };
    }
  };
  const cookieDir = path.join(tmp(), 'c411');
  const hub = new Hub(
    Object.assign(
      {
        browserUrl: chrome.url, matcher, bridgeMatcher: matcher, allowHttp: true, homeUrl: base + '/', maxSessions: 3, idleMs: 60000,
        persistCookies: true, cookieStore: createCookieStore(cookieDir, matcher), engine,
        getUser: (n, a) => (typeof a === 'string' && a.startsWith(`acct:${n}:`) ? { username: n } : null), buildScripts,
        maxPayload: 100000, log: { info() {}, warn: (...a) => process.stderr.write('[hub warn] ' + a.join(' ') + '\n') }
      },
      extra
    )
  );
  hubs.push(hub);
  return { hub, calls, cookieDir, matcher };
}

function makeViewer(username, account = acct(username)) {
  const v = {
    username, account, closed: false, msgs: [], frames: 0, lastFrame: null, closeInfo: null,
    json: (o) => v.msgs.push(o),
    frame: (buf, done) => {
      v.frames++;
      v.lastFrame = buf;
      setImmediate(done);
    },
    close: (code, reason) => {
      v.closed = true;
      v.closeInfo = { code, reason };
    },
    last: (t) => [...v.msgs].reverse().find((m) => m.t === t),
    count: (t) => v.msgs.filter((m) => m.t === t).length
  };
  return v;
}

async function waitFor(fn, ms = 8000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const r = await fn();
    if (r) return r;
    if (Date.now() - t0 > ms) throw new Error('timeout: ' + what);
    await sleep(50);
  }
}

const click = (hub, v, pos) => {
  hub.message(v, { t: 'mouse', a: 'move', x: pos.x, y: pos.y });
  hub.message(v, { t: 'mouse', a: 'down', x: pos.x, y: pos.y, b: 0, n: 1 });
  hub.message(v, { t: 'mouse', a: 'up', x: pos.x, y: pos.y, b: 0, n: 1 });
};
const titleIs = (v, re) => () => v.last('status') && re.test(v.last('status').title || '');
const urlIs = (v, re) => () => v.last('status') && re.test(v.last('status').url || '');

async function opened(hub, name = 'alice', account = acct(name)) {
  const v = makeViewer(name, account);
  await hub.open(v, { w: 800, h: 600 });
  try {
    await waitFor(titleIs(v, /^Home$/), 10000, 'home page');
  } catch (e) {
    throw new Error(`${e.message} ${JSON.stringify(v.msgs.slice(-6))} requests=${JSON.stringify(hits.requests.slice(-4))}`);
  }
  return v;
}

const needChrome = (t) => {
  if (chrome) return false;
  t.skip('Chrome introuvable (CHROME_BIN)');
  return true;
};

test('a tab is opened for the user, streamed as JPEG frames and described', async (t) => {
  if (needChrome(t)) return;
  const { hub } = makeHub();
  const v = await opened(hub);
  assert.deepEqual(v.last('view'), { t: 'view', w: 800, h: 600 });
  assert.equal(v.last('status').url, base + '/');
  assert.equal(v.last('status').canGoBack, false);
  await waitFor(() => v.frames > 0, 5000, 'a frame');
  assert.deepEqual([v.lastFrame[0], v.lastFrame[1]], [0xff, 0xd8], 'JPEG');
  assert.equal(hub.stats().sessions, 1);
  assert.equal(hub.stats().viewers, 1);
});

test('clicks, keys and pasted text reach the page as real user input', async (t) => {
  if (needChrome(t)) return;
  const { hub } = makeHub();
  const v = await opened(hub);
  click(hub, v, at('b'));
  await waitFor(titleIs(v, /^clicked:true$/), 5000, 'trusted click');
  click(hub, v, at('i'));
  hub.message(v, { t: 'key', a: 'down', key: 'h', code: 'KeyH' });
  hub.message(v, { t: 'key', a: 'up', key: 'h', code: 'KeyH' });
  await waitFor(titleIs(v, /^typed:h$/), 5000, 'typed letter');
  hub.message(v, { t: 'text', s: 'ello' });
  await waitFor(titleIs(v, /^typed:hello$/), 5000, 'pasted text');
  hub.message(v, { t: 'key', a: 'down', key: 'Backspace', code: 'Backspace' });
  hub.message(v, { t: 'key', a: 'up', key: 'Backspace', code: 'Backspace' });
  await waitFor(titleIs(v, /^typed:hell$/), 5000, 'backspace');
});

test('hostile or malformed viewer messages do nothing', async (t) => {
  if (needChrome(t)) return;
  const { hub } = makeHub();
  const v = await opened(hub);
  const before = hits.secret;
  for (const m of [
    null, 'x', 5, [], {}, { t: 'eval', code: 'alert(1)' }, { t: 'mouse', a: 'down', x: 1, y: 1, b: 2 }, { t: 'mouse', a: 'move', x: 'a', y: 1 },
    { t: 'key', a: 'down', key: 'F12' }, { t: 'key', a: 'down', key: 't', m: 2 }, { t: 'nav', a: 'close' }, { t: 'nav', a: '__proto__' }, { t: 'text', s: 5 },
    { t: 'goto', url: `${secretBase}/secret` }, { t: 'goto', url: 'javascript:alert(1)' }, { t: 'goto', url: 'file:///etc/passwd' },
    { t: 'goto', url: 'https://evil.example/' }, { t: 'goto', url: { toString: () => base } }, { t: 'goto', url: 'https://c411.org:8443/' },
    { t: 'resize', w: 'x', h: 5 }, { t: '__proto__', constructor: { prototype: {} } }
  ]) {
    hub.message(v, m);
  }
  await sleep(600);
  assert.equal(hits.secret, before);
  assert.equal(v.last('status').url, base + '/');
  assert.equal(v.closed, false);
});

test('the page cannot reach addresses that are not allowed, even through links, redirects or windows', async (t) => {
  if (needChrome(t)) return;
  const { hub } = makeHub();
  const v = await opened(hub);
  const before = hits.secret;
  click(hub, v, at('evil'));
  await waitFor(() => v.count('toast') >= 1, 5000, 'a warning');
  assert.match(v.last('toast').text, /bloquée/);
  await sleep(400);
  assert.equal(hits.secret, before, 'a link');
  hub.message(v, { t: 'nav', a: 'home' });
  await waitFor(titleIs(v, /^Home$/), 8000, 'back home');
  click(hub, v, at('redir'));
  await sleep(1000);
  assert.equal(hits.secret, before, 'a redirect');
  hub.message(v, { t: 'nav', a: 'home' });
  await waitFor(titleIs(v, /^Home$/), 8000, 'back home again');
  click(hub, v, at('popevil'));
  await sleep(1200);
  assert.equal(hits.secret, before, 'a window');
  assert.equal(v.last('status').url, base + '/');
});

test('windows opened by the site are closed and an allowed address opens in the tab', async (t) => {
  if (needChrome(t)) return;
  const { hub } = makeHub();
  const v = await opened(hub);
  click(hub, v, at('popup'));
  await waitFor(titleIs(v, /^Popped$/), 8000, 'popup content in the tab');
  assert.equal(v.last('status').url, base + '/popped');
  await sleep(500);
  const cdp = await connect(chrome.url);
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const ctx = hub.sessions.get('alice').page.contextId;
    assert.equal(targetInfos.filter((x) => x.type === 'page' && x.browserContextId === ctx).length, 1);
  } finally {
    cdp.close();
  }
  assert.equal(v.last('status').canGoBack, true);
  hub.message(v, { t: 'nav', a: 'back' });
  await waitFor(titleIs(v, /^Home$/), 8000, 'back');
  hub.message(v, { t: 'nav', a: 'forward' });
  await waitFor(titleIs(v, /^Popped$/), 8000, 'forward');
  hub.message(v, { t: 'nav', a: 'reload' });
  await waitFor(() => v.last('status').loading === false, 5000, 'reload done');
});

test('the extension bridge answers only on bridge hosts, and says whether a person was at the keyboard', async (t) => {
  if (needChrome(t)) return;
  const { hub, calls } = makeHub({ homeUrl: base + '/auto' });
  const v = makeViewer('alice');
  await hub.open(v, { w: 800, h: 600 });
  await waitFor(() => calls.length >= 1, 8000, 'the automatic request');
  assert.deepEqual(calls[0], { user: 'alice', type: 'ping', recentInput: false }, 'nobody has touched the page yet');
  await waitFor(titleIs(v, /^got:/), 5000, 'its answer');
  assert.deepEqual(JSON.parse(v.last('status').title.slice(4)), { id: 'auto', res: { ok: true, echo: 'ping' } });
  click(hub, v, at('ask'));
  await waitFor(() => calls.length >= 2, 5000, 'the request after the click');
  assert.equal(calls[1].recentInput, true);
  assert.equal(calls.every((c) => c.user === 'alice'), true);

  const plain = makeHub({ bridgeMatcher: createMatcher([]) });
  const w = await opened(plain.hub, 'carol');
  click(plain.hub, w, at('ask'));
  await sleep(1200);
  assert.equal(plain.calls.length, 0, 'no bridge outside the bridge hosts');
  assert.equal(w.last('status').title, 'Home');
});

test('a download is refused and announced to the extension instead', async (t) => {
  if (needChrome(t)) return;
  const { hub } = makeHub();
  const v = await opened(hub);
  click(hub, v, at('dl'));
  await waitFor(titleIs(v, /"push":"download"/), 8000, 'the download notice');
  const note = JSON.parse(v.last('status').title.slice(4));
  assert.deepEqual(note, { push: 'download', url: base + '/file', filename: 'x.torrent' });
  assert.equal(v.last('status').url, base + '/', 'the tab stays where it was');
});

test('each user has a separate browser context, and cookies survive a restart of the tab', async (t) => {
  if (needChrome(t)) return;
  const first = makeHub();
  const alice = await opened(first.hub, 'alice');
  const bob = await opened(first.hub, 'bob');
  assert.notEqual(first.hub.sessions.get('alice').page.contextId, first.hub.sessions.get('bob').page.contextId);
  hub_goto(first.hub, alice, '/set');
  await waitFor(titleIs(alice, /^Set$/), 8000, 'cookie page');
  hub_goto(first.hub, alice, '/whoami');
  await waitFor(titleIs(alice, /^cookie\[sess=v1\]$/), 8000, 'cookie sent back');
  hub_goto(first.hub, bob, '/whoami');
  await waitFor(titleIs(bob, /^cookie\[\]$/), 8000, 'bob has no cookie');
  first.hub.release(alice);
  await waitFor(() => fs.existsSync(first.cookieDir) && fs.readdirSync(first.cookieDir).length === 1, 8000, 'saved cookies');
  const stored = fs.readdirSync(first.cookieDir);
  assert.equal(stored.length, 1, 'only alice has cookies');
  assert.ok(!stored[0].includes('alice'));
  await first.hub.close();

  const second = makeHub({ cookieStore: createCookieStore(first.cookieDir, first.matcher) });
  const again = await opened(second.hub, 'alice');
  hub_goto(second.hub, again, '/whoami');
  await waitFor(titleIs(again, /^cookie\[sess=v1\]$/), 8000, 'cookie restored');
  const other = await opened(second.hub, 'bob');
  hub_goto(second.hub, other, '/whoami');
  await waitFor(titleIs(other, /^cookie\[\]$/), 8000, 'bob still has nothing');
});

function hub_goto(hub, v, p) {
  hub.message(v, { t: 'goto', url: base + p });
}

test('a second viewer for the same user takes over, and a returning viewer finds the tab as it was', async (t) => {
  if (needChrome(t)) return;
  const { hub } = makeHub();
  const one = await opened(hub);
  click(hub, one, at('i'));
  hub.message(one, { t: 'text', s: 'abc' });
  await waitFor(titleIs(one, /^typed:abc$/), 5000, 'text');
  const page = hub.sessions.get('alice').page;
  const two = makeViewer('alice');
  await hub.open(two, { w: 800, h: 600 });
  assert.equal(one.closed, true);
  assert.equal(one.last('kicked').code, 'replaced');
  assert.equal(one.closeInfo.code, 4000);
  assert.equal(hub.sessions.get('alice').page, page, 'the same tab');
  assert.equal(two.last('status').title, 'typed:abc');
  hub.message(one, { t: 'text', s: 'zzz' });
  await sleep(300);
  assert.equal(two.last('status').title, 'typed:abc', 'the replaced viewer is deaf');
  hub.release(two);
  await sleep(200);
  const three = makeViewer('alice');
  await hub.open(three, { w: 800, h: 600 });
  assert.equal(hub.sessions.get('alice').page, page);
  assert.equal(three.last('status').title, 'typed:abc');
  await waitFor(() => three.frames > 0, 5000, 'frames again');
});

test('the number of tabs is limited and the oldest unused one makes room', async (t) => {
  if (needChrome(t)) return;
  const { hub } = makeHub({ maxSessions: 2 });
  const a = await opened(hub, 'a');
  const b = await opened(hub, 'b');
  const c = makeViewer('c');
  await hub.open(c, { w: 800, h: 600 });
  assert.equal(c.closed, true);
  assert.equal(c.last('error').code, 'busy');
  assert.equal(hub.stats().sessions, 2);
  hub.release(a);
  await sleep(100);
  const d = makeViewer('d');
  await hub.open(d, { w: 800, h: 600 });
  await waitFor(titleIs(d, /^Home$/), 10000, 'home for d');
  assert.equal(d.closed, false);
  assert.equal(hub.sessions.has('a'), false, 'a was the unused one');
  assert.equal(hub.stats().sessions, 2);
  assert.equal(b.closed, false);
});

test('an idle viewer is put to sleep, then an abandoned tab is closed', async (t) => {
  if (needChrome(t)) return;
  const { hub } = makeHub({ idleMs: 700 });
  const v = await opened(hub);
  await sleep(900);
  hub.tick();
  await waitFor(() => v.closed, 3000, 'idle');
  assert.equal(v.last('idle').code, 'idle');
  assert.equal(hub.stats().sessions, 1, 'the tab itself stays for a while');
  await sleep(900);
  hub.tick();
  await waitFor(() => hub.stats().sessions === 0, 5000, 'abandoned tab closed');
});

test('typing keeps a tab awake, simply looking does not', async (t) => {
  if (needChrome(t)) return;
  const { hub } = makeHub({ idleMs: 1500 });
  const v = await opened(hub);
  for (let i = 0; i < 3; i++) {
    await sleep(600);
    hub.message(v, { t: 'key', a: 'down', key: 'a', code: 'KeyA' });
    hub.tick();
  }
  assert.equal(v.closed, false);
  await sleep(1700);
  hub.tick();
  await waitFor(() => v.closed, 3000, 'idle after silence');
});

test('removing a user closes the tab and forgets the saved cookies', async (t) => {
  if (needChrome(t)) return;
  const { hub, cookieDir } = makeHub();
  const v = await opened(hub, 'dave');
  hub_goto(hub, v, '/set');
  await waitFor(titleIs(v, /^Set$/), 8000, 'cookie page');
  hub.release(v);
  await waitFor(() => fs.existsSync(cookieDir) && fs.readdirSync(cookieDir).length === 1, 8000, 'saved cookies');
  const w = makeViewer('dave');
  await hub.open(w, { w: 800, h: 600 });
  await hub.dropUser('dave', acct('dave'));
  assert.equal(w.closed, true);
  assert.equal(w.last('error').code, 'signed_out');
  assert.equal(hub.stats().sessions, 0);
  assert.equal(fs.readdirSync(cookieDir).length, 0);
});

test('an account created with the name of a removed one finds neither its tab nor its cookies', async (t) => {
  if (needChrome(t)) return;
  const { hub, cookieDir } = makeHub();
  const old = await opened(hub, 'erin', acct('erin', 1));
  hub_goto(hub, old, '/set');
  await waitFor(titleIs(old, /^Set$/), 8000, 'cookie page');
  hub_goto(hub, old, '/whoami');
  await waitFor(titleIs(old, /^cookie\[sess=v1\]$/), 8000, 'cookie sent back');

  // The old account was removed from the command line (the server is not told) and its viewer is still attached.
  const fresh = await opened(hub, 'erin', acct('erin', 2));
  assert.equal(old.closed, true, 'the old viewer is sent away');
  assert.equal(old.last('error').code, 'signed_out');
  hub_goto(hub, fresh, '/whoami');
  await waitFor(titleIs(fresh, /^cookie\[\]$/), 8000, 'the new account starts without the old cookies');
  // The old tab's own destruction is announced late: it must not take the new tab with it.
  await sleep(300);
  assert.equal(fresh.closed, false);
  assert.equal(fresh.last('error'), undefined);
  assert.equal(hub.sessions.get('erin').account, acct('erin', 2));
  assert.equal(hub.stats().sessions, 1);
  assert.equal(fs.existsSync(cookieDir) ? fs.readdirSync(cookieDir).length : 0, 0, 'nothing of the old account was saved on the way');
});

test('saved cookies belong to the account: a new account with the same name does not get them', async (t) => {
  if (needChrome(t)) return;
  const first = makeHub();
  const old = await opened(first.hub, 'frank', acct('frank', 1));
  hub_goto(first.hub, old, '/set');
  await waitFor(titleIs(old, /^Set$/), 8000, 'cookie page');
  first.hub.release(old);
  await waitFor(() => fs.existsSync(first.cookieDir) && fs.readdirSync(first.cookieDir).length === 1, 8000, 'saved cookies');
  await first.hub.close();

  const second = makeHub({ cookieStore: createCookieStore(first.cookieDir, first.matcher) });
  const fresh = await opened(second.hub, 'frank', acct('frank', 2));
  hub_goto(second.hub, fresh, '/whoami');
  await waitFor(titleIs(fresh, /^cookie\[\]$/), 8000, 'the new account starts empty');
  await second.hub.close();

  const third = makeHub({ cookieStore: createCookieStore(first.cookieDir, first.matcher) });
  const back = await opened(third.hub, 'frank', acct('frank', 1));
  hub_goto(third.hub, back, '/whoami');
  await waitFor(titleIs(back, /^cookie\[sess=v1\]$/), 8000, 'the account itself gets its cookies back');
});

test('a viewer without an account key is refused', async (t) => {
  if (needChrome(t)) return;
  const { hub } = makeHub();
  for (const account of [undefined, '', null, 5]) {
    const v = makeViewer('mallory');
    v.account = account;
    await hub.open(v, { w: 800, h: 600 });
    assert.equal(v.closed, true, String(account));
    assert.equal(v.last('error').code, 'signed_out');
  }
  assert.equal(hub.stats().sessions, 0);
});

test('requests of a tab are only answered for the account that owns it', async (t) => {
  if (needChrome(t)) return;
  let current = acct('ivan', 1);
  const { hub, calls } = makeHub({ homeUrl: base + '/auto', getUser: (n, a) => (a === current ? { username: n } : null) });
  const v = makeViewer('ivan', current);
  await hub.open(v, { w: 800, h: 600 });
  await waitFor(() => calls.length >= 1, 8000, 'the automatic request');
  // Another account took the name while the old tab was still there: the tab is no longer theirs to speak for.
  current = acct('ivan', 2);
  click(hub, v, at('ask'));
  await sleep(1200);
  assert.equal(calls.length, 1, 'no request is answered for a tab of another account');
});

test('an account that disappears behind the server’s back loses its tab and its cookies at the next check', async (t) => {
  if (needChrome(t)) return;
  const exists = new Set([acct('gina'), acct('hank')]);
  let list = () => [...exists];
  const { hub, cookieDir, matcher } = makeHub({ accounts: () => list() });
  const gina = await opened(hub, 'gina');
  const hank = await opened(hub, 'hank');
  for (const v of [gina, hank]) {
    hub_goto(hub, v, '/set');
    await waitFor(titleIs(v, /^Set$/), 8000, 'cookie page');
  }
  hub.release(gina);
  await waitFor(() => fs.existsSync(cookieDir) && fs.readdirSync(cookieDir).length === 1, 8000, 'her cookies are saved');
  hub.release(hank);
  await waitFor(() => fs.readdirSync(cookieDir).length === 2, 8000, 'his cookies are saved');

  // A list that cannot be read revokes nothing.
  list = () => {
    throw new Error('unreadable');
  };
  hub.tick();
  await sleep(300);
  assert.equal(hub.stats().sessions, 2);

  list = () => [...exists];
  exists.delete(acct('gina'));
  hub.tick();
  await waitFor(() => !hub.sessions.has('gina'), 8000, 'her tab is closed');
  const store = createCookieStore(cookieDir, matcher);
  assert.deepEqual(await store.load(acct('gina')), []);
  assert.equal((await store.load(acct('hank'))).length, 1, 'the others are left alone');
  assert.equal(hub.stats().sessions, 1);
  assert.equal(hank.closed, false);
});

test('the saved cookies of accounts that no longer exist are deleted when the server starts', async () => {
  const matcher = createMatcher(['localhost']);
  const dir = path.join(tmp(), 'c411');
  const store = createCookieStore(dir, matcher);
  const cookie = { name: 'sess', value: 'v1', domain: 'localhost', path: '/', secure: false, httpOnly: true };
  await store.save(acct('ghost'), [cookie]);
  await store.save(acct('kept'), [cookie]);
  assert.equal(fs.readdirSync(dir).length, 2);
  const hub = new Hub({ browserUrl: '', matcher, bridgeMatcher: matcher, persistCookies: true, cookieStore: store, accounts: () => [acct('kept')], log: { info() {}, warn() {} } });
  hubs.push(hub);
  await waitFor(() => fs.readdirSync(dir).length === 1, 3000, 'the sweep');
  assert.deepEqual(await store.load(acct('ghost')), []);
  assert.equal((await store.load(acct('kept'))).length, 1);
});

test('status tells whether the view is disabled, unreachable or ready', async (t) => {
  if (needChrome(t)) return;
  const off = makeHub({ browserUrl: '' }).hub;
  assert.deepEqual(await off.status(), { enabled: false, available: false, reason: 'disabled' });
  const lost = makeHub({ browserUrl: 'http://127.0.0.1:1' }).hub;
  assert.deepEqual(await lost.status(), { enabled: true, available: false, reason: 'unreachable' });
  const ready = makeHub().hub;
  assert.deepEqual(await ready.status(), { enabled: true, available: true });
  const v = makeViewer('x');
  await off.open(v, { w: 800, h: 600 });
  assert.equal(v.last('error').code, 'disabled');
  assert.equal(v.closed, true);
});

test('losing the browser is reported to the viewers and recovered from', async (t) => {
  if (needChrome(t)) return;
  const { hub } = makeHub();
  const v = await opened(hub);
  chrome.kill();
  await waitFor(() => v.closed, 15000, 'browser lost');
  assert.equal(v.last('error').code, 'browser_lost');
  assert.equal(hub.stats().sessions, 0);
  assert.deepEqual(await hub.status(), { enabled: true, available: false, reason: 'unreachable' });
});
