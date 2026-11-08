'use strict';
// Pure building blocks of the C411 view: address rules, input filtering and the cookie store.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const hosts = require('../server/c411/hosts');
const input = require('../server/c411/input');
const { createCookieStore, clean } = require('../server/c411/cookies');

test('host names are normalised and IP literals are never accepted', () => {
  assert.equal(hosts.normalizeHost('C411.ORG.'), 'c411.org');
  assert.equal(hosts.normalizeHost('localhost'), 'localhost');
  for (const bad of ['', '127.0.0.1', '2130706433', '0x7f.1', '0177.0.0.1', '[::1]', '::1', 'a_b.com', 'exa mple.com', '-a.com', 'a-.com', 'a..com', 'x'.repeat(64) + '.com']) {
    assert.equal(hosts.normalizeHost(bad), '', JSON.stringify(bad));
  }
  assert.equal(hosts.normalizeHost(null), '');
});

test('the allowed hosts list accepts names, wildcards and rejects anything else', () => {
  assert.deepEqual(hosts.parseHosts('a.com, *.B.org  *'), ['a.com', '*.b.org', '*']);
  assert.deepEqual(hosts.parseHosts(''), []);
  for (const bad of ['http://a.com', 'a.com/path', '10.0.0.1', '*a.com', 'a.*', '*.']) {
    assert.throws(() => hosts.parseHosts(bad), /C411_ALLOWED_HOSTS/, bad);
  }
});

test('the default matcher only accepts C411 and its challenge provider', () => {
  const m = hosts.createMatcher('');
  for (const ok of ['c411.org', 'www.c411.org', 'a.b.c411.org', 'C411.org', 'challenges.cloudflare.com']) assert.ok(m.allows(ok), ok);
  for (const no of ['evilc411.org', 'c411.org.evil.com', 'xc411.org', 'cloudflare.com', 'www.cloudflare.com', 'localhost', '127.0.0.1', '', 'c411.org\u0000.evil.com']) {
    assert.ok(!m.allows(no), JSON.stringify(no));
  }
  assert.equal(m.any, false);
});

test('extra hosts extend the list and a bare star still never accepts IP literals', () => {
  const extra = hosts.createMatcher('img.example.com *.cdn.example.org');
  assert.ok(extra.allows('img.example.com'));
  assert.ok(extra.allows('a.cdn.example.org'));
  assert.ok(!extra.allows('cdn.example.org'));
  assert.ok(!extra.allows('example.com'));
  const any = hosts.createMatcher('*');
  assert.ok(any.any);
  assert.ok(any.allows('anything.example'));
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '[::1]', '2130706433']) assert.ok(!any.allows(ip), ip);
});

test('the bridge matcher is the site itself: never the challenge provider, never the extra hosts', () => {
  const m = hosts.createMatcher([], hosts.BRIDGE_HOSTS);
  for (const ok of ['c411.org', 'www.c411.org', 'a.b.c411.org']) assert.ok(m.allows(ok), ok);
  for (const no of ['challenges.cloudflare.com', 'evilc411.org', 'c411.org.evil.com', 'localhost', '127.0.0.1', '']) assert.ok(!m.allows(no), no);
  assert.equal(m.any, false);
  const test2 = hosts.createMatcher(['localhost'], hosts.BRIDGE_HOSTS);
  assert.ok(test2.allows('localhost'));
  assert.ok(!test2.allows('challenges.cloudflare.com'));
});

test('addresses are https only, on the default port, without credentials', () => {
  const m = hosts.createMatcher('');
  const ok = (u, opts) => hosts.allowedHttpsUrl(u, m, opts);
  assert.ok(ok('https://c411.org/'));
  assert.ok(ok('https://www.c411.org:443/torrents?q=a#b'));
  for (const bad of [
    'http://c411.org/', 'https://c411.org:8443/', 'https://user:pw@c411.org/', 'https://c411.org.evil.com/', 'https://c411.org@evil.com/',
    'https://evil.com/c411.org', 'https://c411.org%2eevil.com/', 'https://\u0441411.org/', 'javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd',
    'blob:https://c411.org/x', 'about:blank', 'ftp://c411.org/', 'https://127.0.0.1/', 'https://[::1]/', 'https://2130706433/', 'not a url', '', null, undefined, 42
  ]) {
    assert.equal(ok(bad), null, String(bad));
  }
});

test('plain http and other ports are accepted only when a test turns that option on', () => {
  const m = hosts.createMatcher(['localhost']);
  assert.equal(hosts.allowedHttpsUrl('http://localhost:8080/x', m), null);
  assert.ok(hosts.allowedHttpsUrl('http://localhost:8080/x', m, { allowHttp: true }));
  assert.equal(hosts.allowedHttpsUrl('http://127.0.0.1:8080/x', m, { allowHttp: true }), null);
  assert.equal(hosts.allowedHttpsUrl('http://evil.test:8080/x', m, { allowHttp: true }), null);
  assert.equal(hosts.allowedHttpsUrl('https://localhost:8443/x', m), null);
  assert.equal(hosts.allowedHttpsUrl('ws://localhost:8080/x', m, { allowHttp: true }), null);
});

test('the view size is clamped and refuses non-numbers', () => {
  assert.deepEqual(input.size(1280, 800), { w: 1280, h: 800 });
  assert.deepEqual(input.size(10, 10), { w: input.LIMITS.minW, h: input.LIMITS.minH });
  assert.deepEqual(input.size(99999, 99999), { w: input.LIMITS.maxW, h: input.LIMITS.maxH });
  assert.deepEqual(input.size(800.6, 600.4), { w: 801, h: 600 });
  for (const bad of [[NaN, 1], ['1280', 800], [null, 800], [1280, undefined], [Infinity, 800], [{}, []]]) assert.equal(input.size(...bad), null);
});

test('only left clicks, moves and wheel scrolling are passed to the browser', () => {
  const view = { w: 1000, h: 700 };
  const move = input.mouse({ a: 'move', x: 10.123, y: 20, bs: 1, m: 8 }, view);
  assert.equal(move.type, 'mouseMoved');
  assert.equal(move.button, 'left');
  assert.equal(move.modifiers, 8);
  assert.equal(input.mouse({ a: 'move', x: 1, y: 1 }, view).button, 'none');
  const down = input.mouse({ a: 'down', x: 5, y: 5, b: 0, n: 2 }, view);
  assert.equal(down.type, 'mousePressed');
  assert.equal(down.clickCount, 2);
  assert.equal(input.mouse({ a: 'up', x: 5, y: 5, b: 0 }, view).type, 'mouseReleased');
  assert.equal(input.mouse({ a: 'down', x: 5, y: 5, b: 2 }, view), null, 'right button');
  assert.equal(input.mouse({ a: 'down', x: 5, y: 5, b: 1 }, view), null, 'middle button');
  assert.equal(input.mouse({ a: 'up', x: 5, y: 5, b: 2 }, view), null);
  const wheel = input.mouse({ a: 'wheel', x: 5, y: 5, dx: 0, dy: 99999, m: 2 }, view);
  assert.equal(wheel.deltaY, 1000);
  assert.equal(wheel.modifiers, 0);
  const edge = input.mouse({ a: 'move', x: -50, y: 99999 }, view);
  assert.deepEqual([edge.x, edge.y], [0, 699]);
  for (const bad of [{ a: 'drag', x: 1, y: 1 }, { a: 'move', x: 'a', y: 1 }, { a: 'move', x: NaN, y: 1 }, { a: 'move', y: 1 }, { x: 1, y: 1 }, { a: 'wheel', x: 1, y: 1, dx: 'z', dy: 1 }]) {
    assert.equal(input.mouse(bad, view), null, JSON.stringify(bad));
  }
});

test('typing and editing keys pass, browser shortcuts and function keys do not', () => {
  const a = input.key({ a: 'down', key: 'a', code: 'KeyA', m: 0 });
  assert.equal(a.type, 'keyDown');
  assert.equal(a.text, 'a');
  assert.equal(input.key({ a: 'up', key: 'a', code: 'KeyA' }).type, 'keyUp');
  assert.equal(input.key({ a: 'down', key: 'é', code: 'Digit2' }).text, 'é');
  assert.equal(input.key({ a: 'down', key: '@', code: 'Digit0', m: 1 | 2 }).text, '@', 'AltGr is plain typing');
  assert.equal(input.key({ a: 'down', key: 'A', code: 'KeyA', m: 8 }).modifiers, 8);
  const enter = input.key({ a: 'down', key: 'Enter', code: 'Enter' });
  assert.equal(enter.text, '\r');
  assert.equal(input.key({ a: 'down', key: 'Backspace' }).type, 'rawKeyDown');
  const ctrlA = input.key({ a: 'down', key: 'a', code: 'KeyA', m: 2 });
  assert.equal(ctrlA.type, 'rawKeyDown');
  assert.equal(ctrlA.text, undefined);
  assert.equal(ctrlA.modifiers, 2);
  assert.equal(input.key({ a: 'down', key: 'a', code: 'KeyA', m: 4 }).modifiers, 2, 'Cmd+A on a Mac is Ctrl+A for the remote Linux browser');
  assert.equal(input.key({ a: 'down', key: 'z', code: 'KeyZ', m: 2 | 8 }).modifiers, 2 | 8);
  for (const bad of [
    { a: 'down', key: 'c', m: 2 }, { a: 'down', key: 'v', m: 2 }, { a: 'down', key: 'x', m: 2 }, { a: 'down', key: 'V', m: 4 }, { a: 'down', key: 'v', m: 2 | 8 },
    { a: 'down', key: 't', m: 2 }, { a: 'down', key: 'w', m: 2 }, { a: 'down', key: 'l', m: 2 }, { a: 'down', key: 'r', m: 2 }, { a: 'down', key: 'n', m: 2 | 8 },
    { a: 'down', key: 'd', m: 4 }, { a: 'down', key: 'ArrowLeft', m: 1 }, { a: 'down', key: 'F5' }, { a: 'down', key: 'F12' }, { a: 'down', key: 'ContextMenu' },
    { a: 'down', key: 'Dead' }, { a: 'down', key: 'Process' }, { a: 'down', key: 'Control' }, { a: 'down', key: '\u0000' }, { a: 'down', key: '' },
    { a: 'down', key: 'x'.repeat(40) }, { a: 'press', key: 'a' }, { a: 'down', key: 5 }, { a: 'down' }
  ]) {
    assert.equal(input.key(bad), null, JSON.stringify(bad));
  }
});

test('pasted text loses its control characters and is capped', () => {
  assert.deepEqual(input.text({ s: 'a\u0000b\u0007c\td\ne' }), { text: 'abc\td\ne' });
  assert.equal(input.text({ s: 'x'.repeat(9000) }).text.length, 5000);
  for (const bad of [{ s: '' }, { s: '\u0000' }, { s: 5 }, {}, { s: null }]) assert.equal(input.text(bad), null);
});

test('only the four navigation actions exist', () => {
  assert.deepEqual([...input.NAV_ACTIONS].sort(), ['back', 'forward', 'home', 'reload']);
});

const m = hosts.createMatcher('');
const cookie = (extra) => Object.assign({ name: 'sid', value: 'abc', domain: '.c411.org', path: '/', secure: true, httpOnly: true, expires: Date.now() / 1000 + 3600, sameSite: 'Lax' }, extra);

test('saved cookies keep only well formed cookies of allowed hosts', () => {
  const good = cookie();
  const list = clean(
    [
      good,
      cookie({ name: 'host', domain: 'c411.org' }),
      cookie({ domain: '.evil.com' }),
      cookie({ domain: '127.0.0.1' }),
      cookie({ domain: '.c411.org.evil.com' }),
      cookie({ name: 'bad name' }),
      cookie({ name: '' }),
      cookie({ value: 'a;b' }),
      cookie({ value: 'a\r\nSet-Cookie: x=y' }),
      cookie({ value: 'x'.repeat(5000) }),
      cookie({ path: 'nope' }),
      cookie({ sameSite: 'weird', expires: -1, name: 's2' }),
      null,
      'text',
      42
    ],
    m
  );
  assert.deepEqual(list.map((c) => c.name), ['sid', 'host', 'sid', 's2']);
  assert.equal(list[2].path, '/', 'a bad path falls back to /');
  assert.equal(list[3].sameSite, undefined);
  assert.equal(list[3].expires, undefined, 'session cookies have no expiry');
  assert.deepEqual(Object.keys(list[0]).sort(), ['domain', 'expires', 'httpOnly', 'name', 'path', 'sameSite', 'secure', 'value']);
  assert.equal(clean('nope', m).length, 0);
  assert.equal(clean(Array.from({ length: 400 }, (_, i) => cookie({ name: 'c' + i })), m).length, 150);
});

test('the cookie store round-trips, drops expired cookies and forgets users', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arr411-cookies-'));
  try {
    const store = createCookieStore(path.join(dir, 'c411'), m);
    assert.deepEqual(await store.load('alice'), []);
    await store.save('alice', [cookie(), cookie({ name: 'old', expires: 5 }), cookie({ name: 'gone', domain: '.evil.com' })]);
    assert.deepEqual((await store.load('alice')).map((c) => c.name), ['sid']);
    assert.deepEqual(await store.load('bob'), [], 'users never share cookies');
    const files = fs.readdirSync(path.join(dir, 'c411'));
    assert.equal(files.length, 1);
    assert.ok(!files[0].includes('alice'), 'the file name does not reveal the user');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'c411', files[0])).mode & 0o777, 0o600);
    await store.save('alice', []);
    assert.equal(fs.readdirSync(path.join(dir, 'c411')).length, 0, 'an empty list removes the file');
    await store.save('alice', [cookie()]);
    await store.remove('alice');
    assert.deepEqual(await store.load('alice'), []);
    await store.remove('nobody');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the cookie store sweep deletes the cookies of owners that no longer exist, and only those', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arr411-cookies-'));
  try {
    const folder = path.join(dir, 'c411');
    const store = createCookieStore(folder, m);
    assert.equal(await store.sweep(['alice']), 0, 'no folder yet: nothing to do');
    // The same name with another creation date is another owner.
    const old = 'alice\n2026-01-01T00:00:00.000Z';
    const fresh = 'alice\n2026-06-01T00:00:00.000Z';
    for (const owner of [old, fresh, 'bob']) await store.save(owner, [cookie()]);
    const foreign = ['notes.txt', `${'a'.repeat(64)}.json.1234.tmp`, `${'A'.repeat(64)}.json`];
    for (const name of foreign) fs.writeFileSync(path.join(folder, name), 'x');

    assert.equal(await store.sweep(new Set([fresh, 'bob'])), 1);
    assert.deepEqual(await store.load(old), []);
    assert.equal((await store.load(fresh)).length, 1);
    assert.equal((await store.load('bob')).length, 1);
    for (const name of foreign) assert.ok(fs.existsSync(path.join(folder, name)), `${name} is not ours to delete`);
    assert.equal(await store.sweep([fresh, 'bob']), 0, 'nothing left to delete');

    assert.equal(await store.sweep([]), 2, 'no account at all: every cookie file goes');
    assert.equal(fs.readdirSync(folder).length, foreign.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a damaged or oversized cookie file is ignored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arr411-cookies-'));
  try {
    const store = createCookieStore(dir, m);
    await store.save('alice', [cookie()]);
    const file = path.join(dir, fs.readdirSync(dir)[0]);
    fs.writeFileSync(file, '{not json');
    assert.deepEqual(await store.load('alice'), []);
    fs.writeFileSync(file, JSON.stringify({ cookies: [cookie({ domain: '.evil.com' })] }));
    assert.deepEqual(await store.load('alice'), [], 'a foreign domain is refused even if the file was edited');
    fs.writeFileSync(file, 'x'.repeat(600 * 1024));
    assert.deepEqual(await store.load('alice'), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
