'use strict';
// The scripts that the remote browser injects in the C411 view (server/c411/inject). They run in a browser, so this file
// proves what Node can prove: the generated code, the constructs the sources must never contain, a silent exit outside the
// allowed pages, the page-world hooks and the bridge of the isolated script on a fake DOM, and the pure part of the
// isolated script, run alone. The real thing (Chrome and a fake C411 site) is checked separately.
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const hosts = require('../server/c411/hosts');
const { build } = require('../server/c411/inject');

const DIR = path.join(__dirname, '..', 'server', 'c411', 'inject');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const SOURCES = { 'main.js': read(DIR, 'main.js'), 'isolated.js': read(DIR, 'isolated.js') };
const ENGINE = read(__dirname, '..', 'server', 'c411', 'engine.js');
const MIB = 1024 * 1024;

// Same shapes as the names that server/c411/page.js makes up for every page.
const NAMES = { binding: 'b0123456789abcdef', recv: 'r0123456789abcdef', topic: 't0123456789abcdef' };
const CFG = { hosts: ['c411.org', '*.c411.org'], allowHttp: false, ...NAMES, maxTorrentBytes: 25 * MIB, armMs: 20000, version: '1.0.0' };
const cfg = (over) => ({ ...CFG, ...over });
const BUILT = build(CFG);

const literal = (src) => JSON.parse(/^ {2}const CFG = (.*);\r?$/m.exec(src)[1]);

// ----- build() -----

test('build() returns the two scripts as valid JavaScript, with the configuration inlined as JSON', () => {
  assert.deepEqual(Object.keys(BUILT).sort(), ['isolated', 'main']);
  for (const [name, src] of Object.entries(BUILT)) {
    assert.equal(typeof src, 'string', name);
    assert.doesNotThrow(() => new vm.Script(src, { filename: `${name}.js` }), name);
    assert.ok(!src.includes('__ARR411_CONFIG__'), name);
  }
  assert.deepEqual(literal(BUILT.isolated), CFG);
  assert.deepEqual(literal(BUILT.main), { hosts: CFG.hosts, allowHttp: false, topic: CFG.topic, maxTorrentBytes: CFG.maxTorrentBytes });
});

test('the page-world script never receives the names of the binding or of the receiving function', () => {
  assert.ok(!BUILT.main.includes(NAMES.binding));
  assert.ok(!BUILT.main.includes(NAMES.recv));
  assert.ok(BUILT.isolated.includes(NAMES.binding));
  assert.ok(BUILT.isolated.includes(NAMES.recv));
});

test('the configuration is read field by field: defaults, normalisation, unknown and inherited fields', () => {
  const minimal = { hosts: ['C411.ORG.', '*.c411.org', 'c411.org'], ...NAMES, maxTorrentBytes: 1024 };
  const withJunk = Object.assign(JSON.parse('{"__proto__": {"polluted": true}, "extra": "zz-unknown-zz"}'), minimal);
  const out = build(withJunk);
  assert.deepEqual(literal(out.isolated), {
    hosts: ['c411.org', '*.c411.org'], allowHttp: false, ...NAMES, maxTorrentBytes: 1024, armMs: 20000, version: '0'
  });
  assert.ok(!out.isolated.includes('zz-unknown-zz') && !out.main.includes('zz-unknown-zz'));
  assert.equal({}.polluted, undefined);
  assert.throws(() => build(Object.create(CFG)), /binding/);
});

test('build() accepts the host patterns of hosts.js and the numbers on both ends of their ranges', () => {
  for (const list of [['*'], ['c411.org'], ['*.c411.org'], ['localhost'], ['a.b.example', '*.example.org', '*']]) {
    assert.deepEqual(literal(build(cfg({ hosts: list })).isolated).hosts, list);
  }
  for (const [field, values] of [['maxTorrentBytes', [1024, 256 * MIB]], ['armMs', [1000, 30000]]]) {
    for (const value of values) assert.equal(literal(build(cfg({ [field]: value })).isolated)[field], value);
  }
  for (const [given, kept] of [[7, '7'], ['1.7.1', '1.7.1'], ['v1', 'v1']]) assert.equal(literal(build(cfg({ version: given })).isolated).version, kept);
  assert.equal(literal(build(cfg({ allowHttp: true })).isolated).allowHttp, true);
});

test('build() refuses anything that is not a configuration object', () => {
  for (const bad of [null, undefined, 42, 'cfg', [], () => {}]) assert.throws(() => build(bad), /objet/, String(bad));
});

const BAD_NAMES = [undefined, null, 42, '', 'ab', '1abc', 'a-bc', 'a b c', 'a.b.c', 'ééé', 'a'.repeat(42), 'window', 'document', 'fetch', '__proto__', 'constructor'];
const BAD = {
  binding: BAD_NAMES,
  recv: BAD_NAMES,
  topic: [undefined, null, 42, '', 'short', 'a'.repeat(7), 'a'.repeat(65), 'bad topic', 'bad:topic', 'bad.topic1', 'topic\n123456', 'tòpic1234', '<script>x'],
  hosts: [
    undefined, null, 'c411.org', {}, [], [''], [42], [null], ['c411.org', 42], ['127.0.0.1'], ['2130706433'], ['0x7f.1'], ['[::1]'],
    ['http://c411.org'], ['c411.org/path'], ['c411.org:443'], ['*c411.org'], ['c411.*'], ['*.'], ['*.*'], ['**'], ['a b'], ['a..b'],
    ['-a.com'], [`${'a'.repeat(64)}.com`], Array.from({ length: 65 }, (_, i) => `h${i}.example`)
  ],
  allowHttp: ['true', 1, 0, null, {}],
  maxTorrentBytes: [undefined, null, 0, -1, 1023, 256 * MIB + 1, 1.5, NaN, Infinity, '1024', true, 2 ** 53],
  armMs: [null, 0, 999, 30001, 20000.5, '20000', NaN, Infinity, -1, true],
  version: [null, '', ' ', 'v 1', 'a'.repeat(33), '-1', '.1', -1, 1.5, {}, [], true, 'x\u2028y']
};

for (const [field, values] of Object.entries(BAD)) {
  test(`build() rejects an invalid "${field}" with an error that names it`, () => {
    for (const value of values) assert.throws(() => build(cfg({ [field]: value })), new RegExp(field), `${field} = ${String(value)}`);
  });
}

test('the binding and the receiving function must have different names, and the names are required', () => {
  assert.throws(() => build(cfg({ recv: NAMES.binding })), /binding/);
  for (const field of ['hosts', 'binding', 'recv', 'topic', 'maxTorrentBytes']) {
    const missing = { ...CFG };
    delete missing[field];
    assert.throws(() => build(missing), new RegExp(field), field);
  }
});

test('build() leaves its argument alone, accepts frozen input and gives the same code for the same input', () => {
  const frozen = Object.freeze({ ...CFG, hosts: Object.freeze([...CFG.hosts]) });
  assert.deepEqual(build(frozen), build(cfg()));
  assert.deepEqual(frozen, CFG);
  const other = build(cfg({ topic: 'another-topic-1' }));
  assert.ok(other.main.includes('another-topic-1') && !other.main.includes(CFG.topic));
  assert.ok(other.isolated.includes('another-topic-1') && !other.isolated.includes(CFG.topic));
});

test('no value can bring a line separator or markup into the generated code', () => {
  for (const out of Object.values(BUILT)) assert.doesNotMatch(out, /[\u2028\u2029]/);
  for (const field of ['topic', 'version', 'binding']) {
    for (const bad of ['abcdefgh\u2028', 'abcdefgh\u2029', 'abcdefgh</script>', 'abcdefgh"+alert(1)+"']) {
      assert.throws(() => build(cfg({ [field]: bad })), new RegExp(field), `${field} ${JSON.stringify(bad)}`);
    }
  }
});

test('the sources are read once, whatever the number of builds', () => {
  const file = require.resolve('../server/c411/inject');
  delete require.cache[file];
  const fresh = require('../server/c411/inject');
  const reads = mock.method(fs, 'readFileSync');
  try {
    for (let i = 0; i < 3; i++) fresh.build(cfg({ topic: `topic-number-${i}` }));
    const files = reads.mock.calls.map((c) => String(c.arguments[0])).filter((f) => f.startsWith(DIR)).map((f) => path.basename(f));
    assert.deepEqual(files.sort(), ['isolated.js', 'main.js']);
  } finally {
    reads.mock.restore();
  }
});

// ----- the sources -----

const FORBIDDEN = [
  ['eval', /\beval\s*\(/],
  ['new Function', /\bnew\s+Function\b|\bFunction\s*\(/],
  ['a timer given a string', /\bset(?:Timeout|Interval)\s*\(\s*['"`]/],
  ['markup parsing (innerHTML and the like; no static template is kept)', /innerHTML|outerHTML|insertAdjacentHTML|srcdoc|createContextualFragment|DOMParser/],
  ['document.write', /document\s*\.\s*write(?:ln)?\s*\(/],
  ['chrome.* (nothing of the extension API is left)', /\bchrome\s*\.|\bbrowser\s*\.\s*(?:runtime|storage|tabs|downloads)/],
  ['dynamic code loading', /\bimport\s*\(|\bimportScripts\b/],
  ['an inline event handler attribute', /setAttribute\(\s*['"`]on/i],
  ['storage and cookies', /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|document\s*\.\s*cookie/],
  ['a channel other than the binding', /\bXMLHttpRequest\b|\bWebSocket\b|\bsendBeacon\b|\bEventSource\b|\bpostMessage\b|\bBroadcastChannel\b/],
  ['a secret', /api[-_ ]?key|authorization|password|passwd/i],
  ['a property set on the global object', /\b(?:window|globalThis|self)\s*\.\s*[A-Za-z_$][\w$]*\s*=(?!=)|\bwindow\s*\[[^\]]*\]\s*=(?!=)/]
];

const SCRIPTS = [['main.js', SOURCES['main.js']], ['isolated.js', SOURCES['isolated.js']], ['built main', BUILT.main], ['built isolated', BUILT.isolated]];

// The only word of the list above that the code uses: the check that refuses an address with credentials in it.
const ALLOWED = ['u.username || u.password ||'];

test('the scripts never use eval, string timers, markup parsing, document.write, chrome.* or other forbidden constructs', () => {
  for (const allowed of ALLOWED) assert.equal(SOURCES['isolated.js'].split(allowed).length, 2, allowed);
  for (const [name, src] of SCRIPTS) {
    const code = ALLOWED.reduce((rest, allowed) => rest.split(allowed).join(' '), src);
    for (const [what, re] of FORBIDDEN) assert.ok(!re.test(code), `${name}: ${what}`);
  }
});

test('the sources have the expected shape: one strict IIFE, one configuration placeholder, no BOM', () => {
  for (const [name, src] of Object.entries(SOURCES)) {
    assert.ok(!src.startsWith('\uFEFF'), `${name}: BOM`);
    assert.match(src, /^(?:\/\/[^\n]*\r?\n)*\(\(\) => \{\r?\n {2}'use strict';\r?\n {2}const CFG = __ARR411_CONFIG__;\r?\n/, `${name}: header`);
    assert.match(src, /\r?\n\}\)\(\);\r?\n$/, `${name}: end`);
    assert.equal(src.split('__ARR411_CONFIG__').length, 2, `${name}: placeholder`);
  }
  const iso = SOURCES['isolated.js'];
  assert.equal(iso.split('// @pure-begin').length, 2);
  assert.equal(iso.split('// @pure-end').length, 2);
  assert.ok(iso.indexOf('// @pure-begin') < iso.indexOf('// @pure-end'));
});

test('every configuration field that a script reads is one that build() provides, and the other way round', () => {
  const used = (src) => [...new Set([...src.matchAll(/\bCFG\.([A-Za-z]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(used(SOURCES['main.js']), Object.keys(literal(BUILT.main)).sort());
  assert.deepEqual(used(SOURCES['isolated.js']), Object.keys(literal(BUILT.isolated)).sort());
});

test('the isolated script builds its interface in a closed shadow root, creates one global at most, and trusts clicks only', () => {
  const iso = SOURCES['isolated.js'];
  assert.match(iso, /attachShadow\(\{ mode: 'closed' \}\)/);
  assert.doesNotMatch(iso, /mode:\s*'open'/);
  assert.equal(iso.match(/Object\.defineProperty\(window,/g).length, 1);
  assert.match(iso, /Object\.defineProperty\(window, CFG\.recv, \{[^}]*enumerable: false/);
  assert.ok(iso.match(/\.isTrusted\b/g).length >= 4, 'submit, Enter, page button and list button each check isTrusted');
  assert.equal(iso.match(/new MutationObserver\(/g).length, 1);
  assert.equal(iso.match(/\bsetInterval\(/g).length, 1);
  assert.equal(iso.match(/\bfetch\(/g).length, 1);
  assert.match(iso, /fetch\(href, \{ credentials: 'include'/);
  assert.doesNotMatch(SOURCES['main.js'], /\bfetch\(/);
});

test('a grid class of the page reaches our stylesheet only when it has the shape of a Tailwind value', () => {
  const found = /const GRID_TOKEN = (\/.*\/);/.exec(SOURCES['isolated.js']);
  assert.ok(found, 'GRID_TOKEN not found in isolated.js: update this test');
  const shape = vm.runInNewContext(found[1]);
  for (const ok of ['lg:grid-cols-[1fr_2fr_48px]', 'lg:grid-cols-[minmax(0,1fr)_100px]', 'lg:grid-cols-[calc(100%-20px)_1fr]', 'lg:grid-cols-[1fr_calc(100%/3)]']) assert.ok(shape.test(ok), ok);
  for (const bad of [
    'lg:grid-cols-[]', 'grid-cols-[1fr]', 'xlg:grid-cols-[1fr]', 'lg:grid-cols-[1fr]x', 'lg:grid-cols-[1fr;}body{display:none}]', 'lg:grid-cols-[1fr}x]',
    'lg:grid-cols-[1fr_{]', 'lg:grid-cols-[a"b]', 'lg:grid-cols-[a\'b]', 'lg:grid-cols-[a\\b]', 'lg:grid-cols-[a b]', 'lg:grid-cols-[a:b]', 'lg:grid-cols-[@import]',
    'lg:grid-cols-[<]', 'lg:grid-cols-[1fr\n]', 'lg:grid-cols-[/*]', 'lg:grid-cols-[*/]', 'lg:grid-cols-[1fr_/*_2fr]', 'lg:grid-cols-[1fr_2fr_*/_3fr]'
  ]) assert.ok(!shape.test(bad), JSON.stringify(bad));
});

test('the messages sent to the server are the ones the engine handles, and arming stays local', () => {
  const handlers = /const HANDLERS = \{([^}]*)\}/.exec(ENGINE);
  assert.ok(handlers, 'HANDLERS not found in engine.js: update this test');
  const handled = handlers[1].split(',').map((s) => s.split(':')[0].trim()).filter((s) => s && s !== '__proto__');
  const { KNOWN_TYPES } = loadPure();
  assert.ok(KNOWN_TYPES.includes('hello'));
  for (const type of KNOWN_TYPES.filter((t) => t !== 'hello')) assert.ok(handled.includes(type), type);
  assert.ok(!KNOWN_TYPES.includes('arm') && !KNOWN_TYPES.includes('disarm'));
  const sent = [...SOURCES['isolated.js'].matchAll(/sendMessage\(\{ type: '(\w+)'/g)].map((m) => m[1]);
  assert.ok(sent.length >= 5);
  for (const type of sent) assert.ok(KNOWN_TYPES.includes(type), type);
});

// ----- a clean exit outside the allowed pages -----

const GUARDED = [
  'document', 'location', 'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame', 'MutationObserver',
  'CustomEvent', 'EventTarget', 'HTMLAnchorElement', 'XMLHttpRequest', 'WebSocket', 'Node', 'localStorage', 'sessionStorage', 'indexedDB',
  'navigator', 'console', 'URL', 'btoa', 'AbortController', 'CSSStyleSheet'
];

// A window that records every write and every read except `top` and `location`, in a context whose other globals are tripwires.
function trapped({ hostname = 'c411.org', protocol = 'https:', top = true } = {}) {
  const touched = [];
  const reads = [];
  const writes = [];
  const sandbox = {};
  for (const name of GUARDED) Object.defineProperty(sandbox, name, { configurable: true, get() { touched.push(name); return undefined; } });
  const location = { protocol, hostname, host: hostname, origin: `${protocol}//${hostname}`, href: `${protocol}//${hostname}/torrents/1` };
  const win = new Proxy({}, {
    get(target, key) {
      if (key === 'location') return location;
      if (key === 'top') return top ? win : {};
      reads.push(String(key));
      return undefined;
    },
    set(target, key) { writes.push(`set ${String(key)}`); return true; },
    defineProperty(target, key) { writes.push(`define ${String(key)}`); return true; },
    deleteProperty(target, key) { writes.push(`delete ${String(key)}`); return true; }
  });
  sandbox.window = win;
  const context = vm.createContext(sandbox);
  const globals = () => vm.runInContext('Object.getOwnPropertyNames(globalThis).sort()', context);
  return { context, touched, reads, writes, globals };
}

const OUTSIDE = [
  ['an unrelated site', { hostname: 'evil.example' }],
  ['a look-alike suffix', { hostname: 'c411.org.evil.example' }],
  ['a look-alike prefix', { hostname: 'evilc411.org' }],
  ['the bare parent domain of a wildcard', { hostname: 'org' }],
  ['an IP literal', { hostname: '127.0.0.1' }],
  ['a number that stands for an IP address', { hostname: '2130706433' }],
  ['localhost', { hostname: 'localhost' }],
  ['an empty host name', { hostname: '' }],
  ['plain http', { protocol: 'http:' }],
  ['a file', { protocol: 'file:', hostname: '' }],
  ['about:blank', { protocol: 'about:', hostname: '' }],
  ['a data URL', { protocol: 'data:', hostname: '' }],
  ['a sub-frame of an allowed site', { top: false }]
];

for (const [name, where] of OUTSIDE) {
  test(`both scripts leave at once, without a trace, on ${name}`, () => {
    for (const [file, src] of [['main', BUILT.main], ['isolated', BUILT.isolated]]) {
      const env = trapped(where);
      const before = env.globals();
      vm.runInContext(src, env.context, { filename: `${file}.js` });
      assert.deepEqual(env.touched, [], `${file}: globals used`);
      assert.deepEqual(env.reads, [], `${file}: window properties read`);
      assert.deepEqual(env.writes, [], `${file}: window properties written`);
      assert.deepEqual(env.globals(), before, `${file}: global properties created`);
    }
  });
}

test('both scripts also leave when the configuration does not list the host, or lists it for http only with the test option off', () => {
  const run = (src, where) => {
    const env = trapped(where);
    vm.runInContext(src, env.context);
    return env;
  };
  const other = build(cfg({ hosts: ['example.org'] }));
  const insecure = build(cfg({ allowHttp: true }));
  for (const [src, where] of [[other.main, {}], [other.isolated, {}], [insecure.main, { hostname: 'evil.example', protocol: 'http:' }], [insecure.isolated, { hostname: 'evil.example', protocol: 'http:' }]]) {
    const env = run(src, where);
    assert.deepEqual([env.touched, env.reads, env.writes], [[], [], []]);
  }
});

test('the exit checks would notice a script that carried on', () => {
  for (const [file, src] of [['main', BUILT.main], ['isolated', BUILT.isolated]]) {
    const env = trapped();
    try {
      vm.runInContext(src, env.context);
    } catch (e) {
      // the fake page is too poor for the script to finish
    }
    assert.ok(env.touched.length + env.reads.length + env.writes.length > 0, file);
  }
});

// ----- fake browser pieces shared by the tests below -----

function clock() {
  let now = 1700000000000;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: now + Math.max(0, Number(ms) || 0), every: 0 });
      return id;
    },
    setInterval(fn, ms) {
      const id = nextId++;
      const every = Math.max(1, Number(ms) || 1);
      timers.set(id, { fn, at: now + every, every });
      return id;
    },
    clear(id) {
      timers.delete(id);
    },
    get pending() {
      return timers.size;
    },
    tick(ms) {
      const end = now + ms;
      for (;;) {
        let due = null;
        for (const [id, t] of timers) if (t.at <= end && (!due || t.at < due[1].at)) due = [id, t];
        if (!due) break;
        const [id, t] = due;
        now = Math.max(now, t.at);
        if (t.every) t.at += t.every;
        else timers.delete(id);
        t.fn();
      }
      now = end;
    }
  };
}

class FakeCustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init && Object.hasOwn(init, 'detail') ? init.detail : null;
  }
}

class FakeEventTarget {
  constructor() {
    this.listeners = [];
  }

  addEventListener(type, fn, options) {
    const object = options !== null && typeof options === 'object';
    this.listeners.push({ type, fn, capture: options === true || (object && options.capture === true), once: object && options.once === true });
  }

  dispatchEvent(event) {
    for (const l of this.listeners.slice()) {
      if (l.type !== event.type) continue;
      if (l.once) this.listeners.splice(this.listeners.indexOf(l), 1);
      l.fn(event);
    }
    return true;
  }
}

const globalsOf = (context) => vm.runInContext('Object.getOwnPropertyNames(globalThis).sort()', context);
const ownNames = (o) => Object.getOwnPropertyNames(o).sort();

// ----- main.js on a fake page -----

const TORRENT = Buffer.from('d8:announce21:http://tracker.test/a4:infod6:lengthi3e4:name5:a.bin12:piece lengthi16384e6:pieces20:01234567890123456789ee');
const LIMIT_OF_MAIN = Math.floor((20 * MIB - 16384) / 4) * 3;

function pageWorld({ readyState = 'complete', root = null, withHtml = true, failDl = false, hostname = 'c411.org', blobApi = false, reader = 'ok', main = BUILT.main } = {}) {
  const clk = clock();
  const log = { nativeClicks: [], nativeOpens: [], revoked: [], attributes: [], handoffs: [], created: [], reads: [] };
  const html = () => ({ setAttribute: (name, value) => log.attributes.push([name, value]) });

  class Target extends FakeEventTarget {
    dispatchEvent(event) {
      if (event.type === `${NAMES.topic}:dl`) {
        if (failDl) throw new Error('dispatch failed');
        log.handoffs.push(JSON.parse(event.detail));
      }
      return super.dispatchEvent(event);
    }
  }

  class Anchor {
    constructor(href, attrs = {}) {
      this.href = href;
      this.attrs = attrs;
    }

    hasAttribute(name) {
      return Object.hasOwn(this.attrs, name);
    }

    getAttribute(name) {
      return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null;
    }

    click() {
      log.nativeClicks.push(this);
      return 'native-click';
    }
  }

  // The size is a getter of the prototype, as in a browser; `size` lets a test announce a size without the bytes.
  class FakeBlob {
    constructor(bytes, size = bytes.length) {
      this.bytes = bytes;
      this.announced = size;
    }

    get size() {
      if (!(this instanceof FakeBlob)) throw new TypeError('Illegal invocation');
      return this.announced;
    }
  }

  class FakeReader extends Target {
    readAsDataURL(blob) {
      if (!(blob instanceof FakeBlob)) throw new TypeError('not a Blob');
      log.reads.push(blob);
      if (reader === 'throw') throw new Error('read failed');
      clk.setTimeout(() => {
        if (reader === 'error') return this.dispatchEvent({ type: 'error' });
        if (reader === 'abort') return this.dispatchEvent({ type: 'abort' });
        this.result = reader === 'malformed' ? 'data:text/plain,hello' : reader === 'number' ? 42 : `data:application/octet-stream;base64,${Buffer.from(blob.bytes).toString('base64')}`;
        return this.dispatchEvent({ type: 'load' });
      }, 0);
    }
  }

  class FakeURL extends URL {
    static revokeObjectURL(url) {
      log.revoked.push(url);
    }

    static createObjectURL(blob) {
      if (!(blob instanceof FakeBlob) && !(blob && blob.mediaSource === true)) throw new TypeError('not a Blob');
      log.created.push(blob);
      return `blob:https://${hostname}/0b2f6c1e-0000-4000-8000-${String(log.created.length).padStart(12, '0')}`;
    }
  }

  const document = new Target();
  document.readyState = readyState;
  document.documentElement = withHtml ? html() : null;
  document.getElementById = (id) => (id === '__nuxt' ? root : null);

  const win = {
    location: new URL(`https://${hostname}/torrents/42`),
    CustomEvent: FakeCustomEvent,
    URL: FakeURL,
    setTimeout: (fn, ms) => clk.setTimeout(fn, ms),
    open: (...args) => {
      log.nativeOpens.push(args);
      return 'native-open';
    }
  };
  if (blobApi) Object.assign(win, { Blob: FakeBlob, FileReader: FakeReader });
  win.top = win;

  const context = vm.createContext({ window: win, document, EventTarget: Target, HTMLAnchorElement: Anchor, Date: { now: () => clk.now() } });
  const before = { globals: globalsOf(context), window: ownNames(win) };
  vm.runInContext(main, context, { filename: 'main.js' });

  const world = {
    clk, log, win, document, context, before, Anchor, FakeURL, FakeBlob, Blob: FakeBlob, html,
    arm: (detail) => document.dispatchEvent(new FakeCustomEvent(`${NAMES.topic}:arm`, { detail })),
    // A blob made by the page, with its address.
    blob(bytes = TORRENT, size) {
      const blob = new FakeBlob(bytes, size);
      return { blob, url: win.URL.createObjectURL(blob) };
    },
    click(target) {
      const event = { type: 'click', target, prevented: 0, stopped: 0, preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; } };
      document.dispatchEvent(event);
      return event;
    }
  };
  return world;
}

const BLOB = 'blob:https://c411.org/0b2f6c1e-0000-4000-8000-000000000000';

test('main.js registers its two listeners and changes nothing else', () => {
  const w = pageWorld();
  assert.deepEqual(w.document.listeners.map((l) => [l.type, l.capture]), [[`${NAMES.topic}:arm`, false], ['click', true]]);
  assert.deepEqual(globalsOf(w.context), w.before.globals);
  assert.deepEqual(ownNames(w.win), w.before.window);
  assert.deepEqual(w.log.handoffs, []);
});

test('main.js is transparent while nothing is armed: same calls, same results, same this and arguments', () => {
  const w = pageWorld();
  const a = new w.Anchor(BLOB, { download: 'x.torrent' });
  const b = new w.Anchor('https://c411.org/x.torrent');
  assert.equal(a.click(), 'native-click');
  assert.equal(w.Anchor.prototype.click.call(b, 1, 2), 'native-click');
  assert.deepEqual(w.log.nativeClicks, [a, b]);
  assert.equal(w.win.open('https://c411.org/x.torrent', '_blank', 'noopener'), 'native-open');
  assert.equal(w.win.open(), 'native-open');
  assert.deepEqual(w.log.nativeOpens, [['https://c411.org/x.torrent', '_blank', 'noopener'], []]);
  const event = w.click({ closest: () => a });
  assert.deepEqual([event.prevented, event.stopped], [0, 0]);
  assert.deepEqual(w.log.handoffs, []);
});

test('main.js takes over the first file download once armed, then disarms', () => {
  const w = pageWorld();
  w.arm('5000');
  const note = new w.Anchor('https://c411.org/page');
  assert.equal(note.click(), 'native-click', 'a link that is not a file goes its way');
  const file = new w.Anchor(BLOB, { download: 'a b.torrent' });
  assert.equal(file.click(), undefined);
  assert.deepEqual(w.log.nativeClicks, [note]);
  assert.deepEqual(w.log.handoffs, [{ url: BLOB, filename: 'a b.torrent' }]);
  assert.equal(file.click(), 'native-click', 'disarmed after the first one');
  assert.equal(w.log.handoffs.length, 1);
});

test('main.js knows a file by its download attribute, a blob address or a .torrent address', () => {
  for (const [href, attrs, isFile] of [
    ['https://c411.org/api/x', { download: '' }, true],
    [BLOB, {}, true],
    ['https://c411.org/dl/x.torrent', {}, true],
    ['https://c411.org/dl/x.TORRENT?token=1', {}, true],
    ['https://c411.org/dl/x.torrentx', {}, false],
    ['https://c411.org/dl/x.torrent/more', {}, false],
    ['https://c411.org/torrents/1', {}, false]
  ]) {
    const w = pageWorld();
    w.arm('5000');
    const a = new w.Anchor(href, attrs);
    assert.equal(a.click() === undefined, isFile, href);
    assert.equal(w.log.handoffs.length, isFile ? 1 : 0, href);
  }
});

test('main.js lets the browser carry on when the hand-off fails or the anchor misbehaves', () => {
  const w = pageWorld({ failDl: true });
  w.arm('5000');
  const a = new w.Anchor(BLOB, { download: 'x.torrent' });
  assert.equal(a.click(), 'native-click');
  const odd = new w.Anchor(BLOB, { download: 'x.torrent' });
  Object.defineProperty(odd, 'href', { get() { throw new Error('boom'); } });
  w.arm('5000');
  assert.equal(odd.click(), 'native-click');
  assert.equal(w.click({ closest: () => odd }).prevented, 0);
});

test('main.js only believes a plain number of milliseconds, never above 30 s, and 0 disarms', () => {
  const w = pageWorld();
  const tryClick = () => new w.Anchor(BLOB).click() === undefined;
  w.arm('100');
  w.clk.tick(99);
  assert.ok(tryClick(), 'still armed after 99 ms');
  w.arm('100');
  w.clk.tick(101);
  assert.ok(!tryClick(), 'expired');
  w.arm('999999');
  w.clk.tick(29999);
  assert.ok(tryClick(), 'the duration is capped at 30 s');
  w.arm('999999');
  w.clk.tick(30001);
  assert.ok(!tryClick(), 'and not a millisecond more');
  w.arm('5000');
  w.arm('0');
  assert.ok(!tryClick(), '0 disarms');
  for (const bad of [undefined, null, 5000, {}, [], '', '-5', '1e3', '1.5', '12345678', 'abc', ' 5000', '5000 ', '٥٠٠٠', '5000;']) {
    w.arm('5000');
    w.arm(bad);
    assert.ok(!tryClick(), `a bad detail disarms: ${String(bad)}`);
  }
  assert.equal(w.log.handoffs.length, 2);
});

test('main.js also takes over window.open and a click on a file link while armed', () => {
  const w = pageWorld();
  w.arm('5000');
  assert.equal(w.win.open(), 'native-open');
  assert.equal(w.win.open(''), 'native-open');
  assert.equal(w.win.open('/download/x.torrent', '_blank'), null);
  assert.deepEqual(w.log.handoffs, [{ url: 'https://c411.org/download/x.torrent', filename: '' }]);
  assert.equal(w.win.open('/download/y.torrent'), 'native-open', 'disarmed after the first one');
  assert.deepEqual(w.log.nativeOpens.map((args) => args[0]), [undefined, '', '/download/y.torrent']);

  w.arm('5000');
  const plain = w.click({ closest: () => new w.Anchor('https://c411.org/torrents/9') });
  assert.deepEqual([plain.prevented, plain.stopped], [0, 0]);
  assert.equal(w.click({}).prevented, 0, 'a target without closest()');
  assert.equal(w.click(null).prevented, 0, 'no target');
  const file = w.click({ closest: (selector) => (selector === 'a[href]' ? new w.Anchor(BLOB, { download: 'z.torrent' }) : null) });
  assert.deepEqual([file.prevented, file.stopped], [1, 1]);
  assert.deepEqual(w.log.handoffs[1], { url: BLOB, filename: 'z.torrent' });
  assert.equal(w.click({ closest: () => new w.Anchor(BLOB) }).prevented, 0, 'disarmed after the first one');
});

test('main.js keeps blob URLs alive for 120 s and leaves a call without argument to the browser', () => {
  const w = pageWorld();
  assert.equal(w.FakeURL.revokeObjectURL(BLOB), undefined);
  w.clk.tick(119999);
  assert.deepEqual(w.log.revoked, []);
  w.clk.tick(2);
  assert.deepEqual(w.log.revoked, [BLOB]);
  w.FakeURL.revokeObjectURL();
  assert.deepEqual(w.log.revoked, [BLOB, undefined]);
  assert.equal(w.clk.pending, 0);
});

// The site's policy (connect-src 'self') also forbids fetching a blob from the isolated world: the bytes travel with the hand-off.

const B64 = TORRENT.toString('base64');

// Takes over one download of the blob at `url`, waits for the (fake) read to end, and gives the last hand-off.
function take(w, url, filename = 'x.torrent') {
  const before = w.log.handoffs.length;
  w.arm('5000');
  assert.equal(new w.Anchor(url, { download: filename }).click(), undefined, 'the click is taken over');
  w.clk.tick(1);
  assert.equal(w.log.handoffs.length, before + 1, 'one hand-off');
  return w.log.handoffs[before];
}

test('main.js reads the blob of a taken-over download, and tells the isolated script with the bytes', () => {
  const w = pageWorld({ blobApi: true });
  const { blob, url } = w.blob();
  assert.equal(url, 'blob:https://c411.org/0b2f6c1e-0000-4000-8000-000000000001', 'the page gets the address of the browser');
  assert.deepEqual(w.log.created, [blob]);
  w.clk.tick(60000);
  assert.deepEqual(w.log.reads, [], 'nothing is read while no download is armed');
  w.arm('5000');
  const a = new w.Anchor(url, { download: 'a b.torrent' });
  assert.equal(a.click(), undefined, 'the click is taken over at once');
  assert.deepEqual(w.log.handoffs, [], 'the file is still being read');
  w.clk.tick(1);
  assert.deepEqual(w.log.handoffs, [{ url, filename: 'a b.torrent', data: B64 }]);
  assert.deepEqual(w.log.nativeClicks, []);
  assert.deepEqual(w.log.reads, [blob]);
  assert.equal(a.click(), 'native-click', 'disarmed after the first one');
  w.clk.tick(1);
  assert.equal(w.log.handoffs.length, 1);
});

test('main.js reads the bytes for window.open and for a click on a link as well', () => {
  const w = pageWorld({ blobApi: true });
  const one = w.blob();
  w.arm('5000');
  assert.equal(w.win.open(one.url, '_blank'), null);
  w.clk.tick(1);
  assert.deepEqual(w.log.handoffs, [{ url: one.url, filename: '', data: B64 }]);

  const two = w.blob();
  w.arm('5000');
  const event = w.click({ closest: (selector) => (selector === 'a[href]' ? new w.Anchor(two.url, { download: 'z.torrent' }) : null) });
  assert.deepEqual([event.prevented, event.stopped], [1, 1]);
  w.clk.tick(1);
  assert.deepEqual(w.log.handoffs[1], { url: two.url, filename: 'z.torrent', data: B64 });
});

test('main.js still tells the isolated script, without bytes, when the file cannot be read', () => {
  for (const reader of ['throw', 'error', 'abort', 'malformed', 'number']) {
    const w = pageWorld({ blobApi: true, reader });
    const { url } = w.blob();
    assert.deepEqual(take(w, url), { url, filename: 'x.torrent' }, reader);
  }
});

test('main.js hands over a file that is not a known blob by its address alone', () => {
  const w = pageWorld({ blobApi: true });
  w.blob();
  w.arm('5000');
  assert.equal(new w.Anchor('https://c411.org/dl/x.torrent').click(), undefined);
  assert.deepEqual(w.log.handoffs, [{ url: 'https://c411.org/dl/x.torrent', filename: '' }], 'at once: nothing to read');
  assert.deepEqual(w.log.reads, []);
  const stranger = 'blob:https://c411.org/00000000-0000-4000-8000-000000000000';
  assert.deepEqual(take(w, stranger), { url: stranger, filename: 'x.torrent' });
  assert.deepEqual(w.log.reads, []);
});

test('main.js reads blobs of up to the size the isolated script accepts, and no more', () => {
  assert.equal(LIMIT_OF_MAIN, loadPure().torrentLimit(CFG.maxTorrentBytes));
  assert.equal(LIMIT_OF_MAIN, loadPure().torrentLimit(256 * MIB));
  let w = pageWorld({ blobApi: true });
  const exact = w.blob(TORRENT, LIMIT_OF_MAIN);
  const over = w.blob(TORRENT, LIMIT_OF_MAIN + 1);
  assert.equal(take(w, exact.url).data, B64);
  assert.equal(take(w, over.url).data, undefined);

  const small = build(cfg({ maxTorrentBytes: 2048 })).main;
  w = pageWorld({ blobApi: true, main: small });
  const fits = w.blob(TORRENT, 2048);
  const toobig = w.blob(TORRENT, 2049);
  assert.equal(take(w, fits.url).data, B64);
  assert.equal(take(w, toobig.url).data, undefined);
});

test('main.js remembers the last eight blobs of the page, and lets one go when the page has revoked it for good', () => {
  const w = pageWorld({ blobApi: true });
  const made = Array.from({ length: 9 }, () => w.blob());
  assert.equal(take(w, made[0].url).data, undefined, 'the oldest is forgotten');
  assert.equal(take(w, made[1].url).data, B64);
  assert.equal(take(w, made[8].url).data, B64);

  const early = w.blob();
  const late = w.blob();
  w.win.URL.revokeObjectURL(early.url);
  w.clk.tick(60000);
  w.win.URL.revokeObjectURL(late.url);
  assert.equal(take(w, early.url).data, B64, 'revoked by the page, but alive for the isolated script');
  w.clk.tick(60000);
  assert.deepEqual(w.log.revoked, [early.url], 'revoked for real after 120 s');
  assert.equal(take(w, early.url).data, undefined, 'and forgotten');
  assert.equal(take(w, late.url).data, B64, 'the other one still has a minute to live');
  w.clk.tick(60000);
  assert.deepEqual(w.log.revoked, [early.url, late.url]);
  assert.equal(take(w, late.url).data, undefined);
});

test('main.js leaves createObjectURL as it was for the page, and ignores what is not a blob', () => {
  const w = pageWorld({ blobApi: true });
  const blob = new w.Blob(TORRENT);
  assert.equal(w.win.URL.createObjectURL(blob), 'blob:https://c411.org/0b2f6c1e-0000-4000-8000-000000000001');
  assert.throws(() => w.win.URL.createObjectURL({}), (e) => e instanceof TypeError && e.message === 'not a Blob');
  assert.throws(() => w.win.URL.createObjectURL(), TypeError);
  const stream = w.win.URL.createObjectURL({ mediaSource: true });
  assert.match(stream, /^blob:/);
  assert.deepEqual(take(w, stream), { url: stream, filename: 'x.torrent' }, 'no bytes for something that is not a blob');
  assert.deepEqual(w.log.reads, []);
  assert.equal(w.clk.pending, 0);
});

test('main.js without FileReader or Blob in the page behaves as before: nothing is remembered, the address alone is handed over', () => {
  const w = pageWorld();
  const url = w.win.URL.createObjectURL(new w.Blob(TORRENT));
  assert.deepEqual(take(w, url), { url, filename: 'x.torrent' });
});

test('main.js with the blob hooks adds no listener, no global and no property to the page', () => {
  const w = pageWorld({ blobApi: true });
  assert.deepEqual(w.document.listeners.map((l) => [l.type, l.capture]), [[`${NAMES.topic}:arm`, false], ['click', true]]);
  assert.deepEqual(globalsOf(w.context), w.before.globals);
  assert.deepEqual(ownNames(w.win), w.before.window);
});

test('main.js flags <html> once the page is hydrated, and gives up cleanly when it never is', () => {
  let w = pageWorld();
  assert.deepEqual(w.log.attributes, [['data-qbt-hydrated', '1']], 'no Nuxt root and the document is parsed');
  assert.equal(w.clk.pending, 0);

  w = pageWorld({ readyState: 'loading' });
  w.clk.tick(5000);
  assert.deepEqual(w.log.attributes, [], 'still loading');
  w.document.readyState = 'interactive';
  w.clk.tick(100);
  assert.deepEqual(w.log.attributes, [['data-qbt-hydrated', '1']]);
  assert.equal(w.clk.pending, 0);

  const nuxt = { isHydrating: true };
  w = pageWorld({ root: { __vue_app__: { $nuxt: nuxt } } });
  w.clk.tick(3000);
  assert.deepEqual(w.log.attributes, [], 'Nuxt is hydrating');
  nuxt.isHydrating = false;
  w.clk.tick(100);
  assert.deepEqual(w.log.attributes, [['data-qbt-hydrated', '1']]);

  w = pageWorld({ root: { __vue_app__: { $nuxt: { isHydrating: true } } } });
  w.clk.tick(14900);
  assert.deepEqual(w.log.attributes, []);
  w.clk.tick(200);
  assert.deepEqual(w.log.attributes, [['data-qbt-hydrated', '1']], 'flagged anyway after 15 s');

  w = pageWorld({ withHtml: false });
  w.clk.tick(1000);
  assert.deepEqual(w.log.attributes, [], 'no <html> yet');
  w.document.documentElement = w.html();
  w.clk.tick(100);
  assert.deepEqual(w.log.attributes, [['data-qbt-hydrated', '1']]);

  w = pageWorld({ withHtml: false });
  w.clk.tick(61000);
  assert.equal(w.clk.pending, 0, 'no timer is left behind');
  assert.deepEqual(w.log.attributes, []);
});

// ----- isolated.js on a fake page: the bridge -----

function isolatedWorld({ bridgeAtStart = false, readyState = 'loading' } = {}) {
  const clk = clock();
  const fetched = [];
  const posted = [];
  const document = new FakeEventTarget();
  document.readyState = readyState;
  const location = new URL('https://c411.org/torrents/42');
  const win = { location };
  win.top = win;
  const bridge = (text) => posted.push(text);
  if (bridgeAtStart) win[NAMES.binding] = bridge;
  const context = vm.createContext({
    window: win, document, location, CustomEvent: FakeCustomEvent, URL, btoa, atob,
    Date: { now: () => clk.now() },
    setTimeout: (fn, ms) => clk.setTimeout(fn, ms),
    setInterval: (fn, ms) => clk.setInterval(fn, ms),
    clearTimeout: (id) => clk.clear(id),
    clearInterval: (id) => clk.clear(id),
    fetch: (...args) => {
      fetched.push(args);
      return new Promise(() => {});
    }
  });
  const before = { globals: globalsOf(context), window: ownNames(win) };
  vm.runInContext(BUILT.isolated, context, { filename: 'isolated.js' });
  return {
    clk, win, document, context, before, fetched, posted,
    appear() {
      win[NAMES.binding] = bridge;
    },
    answer: (id, res) => win[NAMES.recv](JSON.stringify({ id, res })),
    push: (message) => win[NAMES.recv](JSON.stringify(message)),
    requests: () => posted.map((text) => JSON.parse(text))
  };
}

test('isolated.js defines its receiving function at the very start, and nothing else on the window', () => {
  const w = isolatedWorld();
  assert.equal(typeof w.win[NAMES.recv], 'function');
  assert.equal(Object.getOwnPropertyDescriptor(w.win, NAMES.recv).enumerable, false);
  assert.deepEqual(ownNames(w.win), [...w.before.window, NAMES.recv].sort());
  assert.deepEqual(globalsOf(w.context), w.before.globals);
  assert.deepEqual(w.posted, []);
  assert.deepEqual(w.document.listeners.map((l) => l.type), [`${NAMES.topic}:dl`, 'DOMContentLoaded'], 'the page is not touched before the DOM is there');
});

test('isolated.js probes every 25 ms until the binding exists, then greets the server and hides the binding', () => {
  const w = isolatedWorld();
  assert.equal(w.clk.pending, 1);
  w.clk.tick(1000);
  assert.deepEqual(w.posted, []);
  w.appear();
  w.clk.tick(24);
  assert.deepEqual(w.posted, [], 'the next probe comes 25 ms after the previous one');
  w.clk.tick(1);
  assert.equal(w.posted.length, 1);
  const hello = w.requests()[0];
  assert.deepEqual(Object.keys(hello).sort(), ['id', 'msg']);
  assert.ok(typeof hello.id === 'string' && hello.id.length > 0 && hello.id.length <= 64);
  assert.deepEqual(hello.msg, { type: 'hello', version: CFG.version });
  assert.ok(!(NAMES.binding in w.win), 'the binding is out of reach of the page');
  w.answer(hello.id, { ok: false, error: 'Message inconnu' });
  assert.equal(w.clk.pending, 0, 'no timer is left once the greeting is answered');
});

test('isolated.js greets at once when the binding is already there', () => {
  const w = isolatedWorld({ bridgeAtStart: true });
  assert.deepEqual(w.requests().map((r) => r.msg.type), ['hello']);
  assert.ok(!(NAMES.binding in w.win));
  assert.equal(w.clk.pending, 1, 'only the time limit of the greeting');
});

test('isolated.js stops probing after 15 s without a binding', () => {
  const w = isolatedWorld();
  w.clk.tick(14999);
  assert.equal(w.clk.pending, 1);
  w.clk.tick(1);
  assert.equal(w.clk.pending, 0);
  w.clk.tick(60000);
  assert.deepEqual(w.posted, []);
});

test('isolated.js ignores what the server could not have sent, and nothing is fetched unless a download is armed', () => {
  const w = isolatedWorld({ bridgeAtStart: true });
  const long = `https://c411.org/${'a'.repeat(5000)}`;
  const bad = [
    undefined, null, 42, {}, [], '', '{', '[]', 'null', '"x"', '{"id":5}', '{"id":"nope","res":{"ok":true}}', '{"push":"other"}',
    '{"push":"download"}', '{"push":"download","url":5}', JSON.stringify({ push: 'download', url: long }), 'x'.repeat(9 * MIB)
  ];
  for (const raw of bad) assert.doesNotThrow(() => w.win[NAMES.recv](raw));
  w.push({ push: 'download', url: 'https://c411.org/a.torrent', filename: 'a.torrent' });
  w.push({ push: 'download', url: BLOB, filename: 5 });
  const forged = [undefined, 5, {}, '', '{', '[]', JSON.stringify({ url: 'https://c411.org/a.torrent' }), JSON.stringify({ url: 5 }), 'x'.repeat(9000)];
  for (const detail of forged) w.document.dispatchEvent(new FakeCustomEvent(`${NAMES.topic}:dl`, { detail }));
  w.document.dispatchEvent(new FakeCustomEvent(`${NAMES.topic}:dl`, { detail: JSON.stringify({ url: 'https://c411.org/a.torrent', filename: 'a.torrent' }) }));
  const withFile = { url: BLOB, filename: 'a.torrent', data: Buffer.from('d4:info').toString('base64') };
  w.document.dispatchEvent(new FakeCustomEvent(`${NAMES.topic}:dl`, { detail: JSON.stringify(withFile) }));
  w.document.dispatchEvent(new FakeCustomEvent(`${NAMES.topic}:dl`, { detail: JSON.stringify({ ...withFile, data: 'A'.repeat(9 * MIB) }) }));
  assert.deepEqual(w.fetched, []);
  assert.deepEqual(w.requests().map((r) => r.msg.type), ['hello'], 'only the greeting went out');
});

test('isolated.js does nothing more when the page loads it a second time', () => {
  const w = isolatedWorld({ bridgeAtStart: true });
  const listeners = w.document.listeners.length;
  const pending = w.clk.pending;
  const names = ownNames(w.win);
  vm.runInContext(BUILT.isolated, w.context);
  assert.equal(w.document.listeners.length, listeners);
  assert.equal(w.clk.pending, pending);
  assert.deepEqual(ownNames(w.win), names);
  assert.equal(w.posted.length, 1);
});

// ----- the pure part of isolated.js, run alone -----

// The region between the @pure markers only needs CFG and location: it is evaluated here as a function of these two.
function loadPure(over = {}, where = 'https://c411.org/torrents/42') {
  const src = SOURCES['isolated.js'];
  const begin = src.indexOf('// @pure-begin');
  const end = src.indexOf('// @pure-end');
  assert.ok(begin > 0 && end > begin, 'pure markers not found');
  const exported = [
    'Notice', 'normalizeHost', 'hostAllowed', 'createLink', 'cleanReply', 'cleanIds', 'cleanMedia', 'cleanCategories', 'cleanStatus',
    'cleanTorrents', 'qbitText', 'normName', 'detectSeasons', 'guessMusic', 'checkDownloadUrl', 'looksLikeTorrent', 'toBase64', 'fromBase64', 'decodeTorrent', 'readLimited',
    'dispositionName', 'urlName', 'safeName', 'torrentLimit', 'strict', 'clip', 'KNOWN_TYPES', 'MAX_BRIDGE_CHARS', 'BRIDGE_ENVELOPE'
  ];
  const wrapper = `(function (CFG, location) {\n'use strict';\n${src.slice(begin, end)}\nreturn { ${exported.join(', ')} };\n})`;
  const factory = new vm.Script(wrapper, { filename: 'isolated.js (pure part)' }).runInThisContext();
  return factory({ ...CFG, ...over }, new URL(where));
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const HOST_CORPUS = [
  'c411.org', 'C411.ORG', 'c411.org.', ' c411.org ', 'www.c411.org', 'a.b.c411.org', 'evilc411.org', 'c411.org.evil.example', 'org', 'localhost',
  'challenges.cloudflare.com', 'example.org', 'www.example.org', 'notexample.org', 'x1', 'x-y.example', '-x.example', 'x-.example', 'a_b.example',
  'xn--bcher-kva.example', 'bücher.example', '127.0.0.1', '127.1', '0x7f.1', '0x7f000001', '2130706433', '1.2.3.4', 'a.1', 'a.0x', 'a.0xg',
  '[::1]', '::1', '', '.', '..', 'a..b', `${'a'.repeat(63)}.example`, `${'a'.repeat(64)}.example`, `${'a.'.repeat(130)}com`,
  null, undefined, 42, {}, []
];

test('the host rules of the isolated script are the ones of server/c411/hosts.js', () => {
  const P = loadPure();
  for (const h of HOST_CORPUS) assert.equal(P.normalizeHost(h), hosts.normalizeHost(h), String(h));
  for (const list of [[], ['*'], ['example.org'], ['*.example.org'], ['localhost'], ['a.example.org', '*.b.example.org']]) {
    const matcher = hosts.createMatcher(list);
    for (const h of HOST_CORPUS) assert.equal(P.hostAllowed(h, matcher.patterns), matcher.allows(h), `${String(h)} against ${list}`);
  }
  assert.equal(P.hostAllowed('c411.org', null), false);
  assert.equal(P.hostAllowed('c411.org', 'c411.org'), false);
  assert.equal(P.hostAllowed('c411.org', [42, null, {}]), false);
});

// ----- the link with the server -----

function linkRig(over = {}) {
  const clk = clock();
  const sent = [];
  const pushes = [];
  const state = { bridge: null };
  const bridge = (text) => sent.push(JSON.parse(text));
  const link = loadPure().createLink({
    token: 'tok', version: '9.9', maxChars: 2000, now: clk.now, setTimeout: clk.setTimeout, clearTimeout: clk.clear,
    find: () => state.bridge, onPush: (url, filename) => pushes.push([url, filename]), ...over
  });
  return {
    clk, link, sent, pushes, state, bridge,
    answer: (id, res) => link.receive(JSON.stringify({ id, res })),
    byType: (type) => sent.filter((m) => m.msg.type === type)
  };
}

test('requests wait in line for the binding, then leave in order behind a greeting', async () => {
  const r = linkRig();
  const first = r.link.send({ type: 'getCategories' });
  const second = r.link.send({ type: 'pageStatus', url: 'https://c411.org/torrents/1' });
  r.link.start();
  r.clk.tick(1000);
  assert.deepEqual(r.sent, [], 'nothing leaves without the binding');
  r.state.bridge = r.bridge;
  r.clk.tick(24);
  assert.deepEqual(r.sent, [], 'the probe comes every 25 ms');
  r.clk.tick(1);
  assert.deepEqual(r.sent.map((m) => m.msg.type), ['hello', 'getCategories', 'pageStatus']);
  assert.deepEqual(r.sent[0].msg, { type: 'hello', version: '9.9' });
  assert.equal(r.sent[2].msg.url, 'https://c411.org/torrents/1');
  const ids = r.sent.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^tok_\d+$/);
  assert.deepEqual(Object.keys(r.sent[0]).sort(), ['id', 'msg']);

  r.answer(r.byType('pageStatus')[0].id, { ok: true, qbit: null });
  r.answer(r.byType('getCategories')[0].id, { ok: false, error: 'qBittorrent injoignable' });
  assert.deepEqual(await second, { ok: true, qbit: null });
  assert.deepEqual(await first, { ok: false, error: 'qBittorrent injoignable' });
  r.answer(r.byType('hello')[0].id, { ok: false, error: 'Message inconnu' });
  assert.equal(r.clk.pending, 0, 'every time limit is released, no probe is left');
});

test('the greeting leaves at once when the binding is already there, and only once', () => {
  const r = linkRig();
  r.state.bridge = r.bridge;
  r.link.start();
  assert.deepEqual(r.sent.map((m) => m.msg), [{ type: 'hello', version: '9.9' }]);
  r.link.start();
  r.link.send({ type: 'getCategories' });
  assert.deepEqual(r.sent.map((m) => m.msg.type), ['hello', 'getCategories']);
});

test('requests fail with "Pont indisponible" after exactly 15 s without a binding, and the probe stops', async () => {
  const r = linkRig();
  const p = r.link.send({ type: 'getCategories' });
  let done = false;
  p.then(() => { done = true; });
  r.clk.tick(14999);
  await flush();
  assert.equal(done, false);
  r.clk.tick(1);
  assert.deepEqual(await p, { ok: false, error: 'Pont indisponible' });
  assert.equal(r.clk.pending, 0);
  r.clk.tick(120000);
  assert.deepEqual(r.sent, []);
});

test('a request made after the first 15 s waits its own 15 s, and still catches a binding that shows up late', async () => {
  const r = linkRig();
  r.link.start();
  r.clk.tick(15000);
  assert.equal(r.clk.pending, 0, 'the first probe loop ends by itself');
  r.clk.tick(5000);
  const lost = r.link.send({ type: 'getCategories' });
  r.clk.tick(14999);
  assert.equal(r.clk.pending, 2, 'the probe and the time limit of the request');
  r.clk.tick(1);
  assert.deepEqual(await lost, { ok: false, error: 'Pont indisponible' });
  assert.equal(r.clk.pending, 0);

  const late = r.link.send({ type: 'getCategories' });
  r.clk.tick(40);
  r.state.bridge = r.bridge;
  r.clk.tick(25);
  assert.deepEqual(r.sent.map((m) => m.msg.type), ['hello', 'getCategories']);
  r.answer(r.byType('getCategories')[0].id, { ok: true, categories: [] });
  assert.deepEqual(await late, { ok: true, categories: [] });
});

test('a binding that throws, a probe that throws or finds something else than a function never crash the link', async () => {
  let r = linkRig();
  r.state.bridge = () => { throw new Error('closed'); };
  assert.deepEqual(await r.link.send({ type: 'getCategories' }), { ok: false, error: 'Pont indisponible' });
  assert.equal(r.clk.pending, 0);

  r = linkRig({ find() { throw new Error('no window'); } });
  const p = r.link.send({ type: 'getCategories' });
  r.clk.tick(15000);
  assert.deepEqual(await p, { ok: false, error: 'Pont indisponible' });

  r = linkRig();
  r.state.bridge = { not: 'a function' };
  const q = r.link.send({ type: 'getCategories' });
  r.clk.tick(15000);
  assert.deepEqual(await q, { ok: false, error: 'Pont indisponible' });
});

test('a request that gets no answer fails after 60 s, and a late answer changes nothing', async () => {
  const r = linkRig();
  r.state.bridge = r.bridge;
  const p = r.link.send({ type: 'listTorrents' });
  const { id } = r.byType('listTorrents')[0];
  let done = false;
  p.then(() => { done = true; });
  r.clk.tick(59999);
  await flush();
  assert.equal(done, false);
  r.clk.tick(1);
  assert.deepEqual(await p, { ok: false, error: 'Délai dépassé. Réessaie.' });
  assert.doesNotThrow(() => r.answer(id, { ok: true, torrents: [] }));
  r.clk.tick(120000);
  assert.equal(r.clk.pending, 0);
});

test('no more than three requests are in flight at once, the greeting included, and the others follow as answers come', async () => {
  const r = linkRig();
  r.state.bridge = r.bridge;
  const results = [1, 2, 3, 4, 5].map((n) => r.link.send({ type: 'toggleTorrent', n }));
  assert.equal(r.sent.length, 3);
  r.answer(r.sent[0].id, { ok: false, error: 'Message inconnu' });
  assert.equal(r.sent.length, 4);
  r.answer(r.sent[1].id, { ok: true });
  assert.equal(r.sent.length, 5);
  r.answer(r.sent[2].id, { ok: true });
  assert.equal(r.sent.length, 6);
  for (const m of r.sent.slice(3)) r.answer(m.id, { ok: true });
  assert.deepEqual(await Promise.all(results), results.map(() => ({ ok: true })));
  assert.deepEqual(r.sent.slice(1).map((m) => m.msg.n).sort(), [1, 2, 3, 4, 5]);
  assert.equal(r.clk.pending, 0);
});

test('only the messages the engine knows are sent, whatever is asked, and arm/disarm are not among them', async () => {
  const r = linkRig();
  r.state.bridge = r.bridge;
  const bad = [
    { type: 'evil' }, { type: 'arm' }, { type: 'disarm' }, { type: 'Upload' }, { type: '__proto__' }, { type: 'constructor' }, { type: '' },
    { type: ['upload'] }, { type: { toString: () => 'upload' } }, { type: null }, {}, [], null, undefined, '', 'upload', 42, true, () => {}
  ];
  for (const msg of bad) assert.deepEqual(await r.link.send(msg), { ok: false, error: 'Message inconnu' }, String(msg && msg.type));
  assert.deepEqual(r.sent, []);
  assert.equal(r.clk.pending, 0);
});

test('a body that is too big or cannot be serialised never leaves', async () => {
  const r = linkRig({ maxChars: 200 });
  r.state.bridge = r.bridge;
  assert.deepEqual(await r.link.send({ type: 'upload', base64: 'A'.repeat(300) }), { ok: false, error: 'Le fichier .torrent est trop volumineux.' });
  const cyclic = { type: 'upload' };
  cyclic.self = cyclic;
  assert.deepEqual(await r.link.send(cyclic), { ok: false, error: 'Requête invalide' });
  assert.deepEqual(await r.link.send({ type: 'upload', n: 1n }), { ok: false, error: 'Requête invalide' });
  assert.deepEqual(r.sent, []);
  assert.equal(r.clk.pending, 0);
  const fits = r.link.send({ type: 'upload', base64: 'A'.repeat(50) });
  r.answer(r.byType('upload')[0].id, { ok: true });
  assert.deepEqual(await fits, { ok: true });
});

test('cleanReply turns anything but a well-formed answer into an error, and bounds the error text', () => {
  const { cleanReply } = loadPure();
  const invalid = { ok: false, error: 'Réponse invalide' };
  for (const res of [undefined, null, 0, 'ok', true, [], [{ ok: true }], () => {}, {}, { ok: 'true' }, { ok: 1 }, { ok: null }, { error: 'x' }]) {
    assert.deepEqual(cleanReply(res), invalid, String(res));
  }
  assert.deepEqual(cleanReply({ ok: true, a: [1] }), { ok: true, a: [1] });
  assert.deepEqual(cleanReply({ ok: false }), { ok: false, error: 'Erreur' });
  assert.deepEqual(cleanReply({ ok: false, error: '' }), { ok: false, error: 'Erreur' });
  assert.deepEqual(cleanReply({ ok: false, error: 5 }), { ok: false, error: 'Erreur' });
  assert.deepEqual(cleanReply({ ok: false, error: 'x'.repeat(900) }), { ok: false, error: 'x'.repeat(500) });
});

test('answers that make no sense are ignored, and so is a request that cannot be matched', async () => {
  const r = linkRig();
  r.state.bridge = r.bridge;
  let settled = 0;
  const p = r.link.send({ type: 'getCategories' }).then((res) => {
    settled++;
    return res;
  });
  const long = `https://c411.org/${'a'.repeat(5000)}`;
  const junk = [
    undefined, null, 42, true, {}, [], () => {}, '', ' ', '{', '[]', 'null', '42', '"text"', '{"id":5}', '{"id":null}', '[{"id":"tok_1"}]',
    '{"id":"unknown","res":{"ok":true}}', '{"id":"__proto__","res":{"ok":true}}', '{"id":"constructor","res":{"ok":true}}',
    '{"push":"upload","url":"https://c411.org/a"}', '{"push":"download"}', '{"push":"download","url":5}', '{"push":"download","url":null}',
    JSON.stringify({ push: 'download', url: long }), JSON.stringify({ id: 'unknown', push: 'download', url: 'https://c411.org/a' }), 'x'.repeat(8 * MIB + 1)
  ];
  for (const raw of junk) assert.doesNotThrow(() => r.link.receive(raw), String(raw).slice(0, 40));
  await flush();
  assert.equal(settled, 0);
  assert.deepEqual(r.pushes, []);
  r.answer(r.byType('getCategories')[0].id, { ok: true, categories: [] });
  assert.deepEqual(await p, { ok: true, categories: [] });
  assert.equal(settled, 1);
});

test('a download announced by the server is passed on with its address and name, and a failing handler is not fatal', () => {
  const r = linkRig();
  const edge = `https://c411.org/${'a'.repeat(4096 - 'https://c411.org/'.length)}`;
  r.link.receive(JSON.stringify({ push: 'download', url: 'https://c411.org/a.torrent', filename: 'a.torrent' }));
  r.link.receive(JSON.stringify({ push: 'download', url: 'blob:https://c411.org/x', filename: 42 }));
  r.link.receive(JSON.stringify({ push: 'download', url: edge }));
  assert.deepEqual(r.pushes.slice(0, 2), [['https://c411.org/a.torrent', 'a.torrent'], ['blob:https://c411.org/x', '']]);
  assert.equal(r.pushes[2][0].length, 4096);
  assert.equal(r.pushes[2][1], '');
  assert.equal(r.pushes.length, 3);

  const fragile = linkRig({ onPush() { throw new Error('boom'); } });
  assert.doesNotThrow(() => fragile.link.receive(JSON.stringify({ push: 'download', url: 'https://c411.org/a.torrent' })));
});

test('the link exposes nothing but send, receive and start', () => {
  assert.deepEqual(Object.keys(linkRig().link), ['send', 'receive', 'start']);
});

// ----- the rest of the pure part -----

test('cleanIds keeps the identifiers in the shapes the server accepts and drops the others', () => {
  const { cleanIds } = loadPure();
  const uuid = '0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D';
  assert.deepEqual(cleanIds({
    imdb: 'tt1234567', tmdb: 42, tvdb: '81189', tmdbKind: 'tv', mbReleaseGroup: uuid, mbRelease: uuid, mbArtist: uuid, deezer: '123', discogs: '456', junk: 'x'
  }), {
    imdb: 'tt1234567', tmdb: '42', tvdb: '81189', tmdbKind: 'tv', mbReleaseGroup: uuid.toLowerCase(), mbRelease: uuid.toLowerCase(), mbArtist: uuid.toLowerCase(), deezer: '123', discogs: '456'
  });
  assert.deepEqual(cleanIds({
    imdb: 'tt12', tmdb: 0, tvdb: '99999999999', tmdbKind: 'film', mbReleaseGroup: 'not-a-uuid', mbRelease: 5, mbArtist: `${uuid}x`, deezer: '12345678901234', discogs: 5
  }), {});
  assert.deepEqual(cleanIds({ tmdb: 2147483647, tvdb: 2147483648 }), { tmdb: '2147483647' });
  assert.deepEqual(cleanIds({ tmdb: 1.5, tvdb: -3, imdb: 'tt123456789012' }), {});
  for (const raw of [undefined, null, 'tt1234567', [], 42]) assert.deepEqual(cleanIds(raw), {});
  assert.deepEqual(cleanIds(Object.create({ imdb: 'tt1234567' })), {});
  assert.deepEqual(cleanIds(JSON.parse('{"__proto__": {"imdb": "tt1234567"}}')), {});
});

test('cleanMedia keeps what the server accepts, drops what it would refuse and leaves empty fields out', () => {
  const { cleanMedia } = loadPure();
  for (const raw of [null, undefined, 'movie', [], 42, {}, { type: 'game' }, { type: '__proto__' }, { type: ['movie'] }]) assert.equal(cleanMedia(raw), null, String(raw));
  assert.deepEqual(cleanMedia({ type: 'movie' }), { type: 'movie', ids: {}, seasons: [] });
  assert.deepEqual(cleanMedia({
    type: 'series',
    ids: { tvdb: '81189', junk: 1 },
    seasons: [1, 2, 2.5, -1, 1000, '3', null, 0, 999],
    artist: '  A\u0000  B  ', album: 'Al', year: 1999, rootFolder: '/tv', seriesType: 'anime', lmode: 'artist', extra: 'zz'
  }), {
    type: 'series', ids: { tvdb: '81189' }, seasons: [1, 2, 0, 999], artist: 'A B', album: 'Al', year: '1999', rootFolder: '/tv', seriesType: 'anime', lmode: 'artist'
  });
  assert.deepEqual(cleanMedia({
    type: 'music', artist: '   ', album: 5, year: 1899, rootFolder: 'a\nb', seriesType: 'weird', lmode: 'x'
  }), { type: 'music', ids: {}, seasons: [] });
  assert.equal(cleanMedia({ type: 'music', year: '2001' }).year, '2001');
  assert.equal('year' in cleanMedia({ type: 'music', year: '20011' }), false);
  assert.equal('year' in cleanMedia({ type: 'music', year: {} }), false);
  assert.equal(cleanMedia({ type: 'music', artist: 'x'.repeat(500) }).artist.length, 200);
  assert.equal('rootFolder' in cleanMedia({ type: 'movie', rootFolder: '/'.repeat(501) }), false);
  assert.equal(cleanMedia({ type: 'movie', rootFolder: '/'.repeat(500) }).rootFolder.length, 500);
  assert.equal('rootFolder' in cleanMedia({ type: 'movie', rootFolder: '/movies\ud800' }), false);
  assert.equal(cleanMedia({ type: 'movie', seasons: Array.from({ length: 500 }, (_, i) => i) }).seasons.length, 200);
  assert.equal(cleanMedia({ type: 'series', seasons: 'all' }).seasons.length, 0);
});

test('cleanCategories fixes the keys of what the dialog shows and bounds the values', () => {
  const { cleanCategories } = loadPure();
  const out = cleanCategories({
    ok: true,
    categories: ['films', 'séries', 'bad\ncat', 42, '', 'x'.repeat(101), null],
    selected: 'films',
    byType: { movie: 'films', series: 's'.repeat(200), music: 5, junk: 'x' },
    defaultRoot: { movie: '/m', music: '/mu'.repeat(300) },
    arrEnabled: { movie: true, series: 'true', music: 1, junk: true }
  });
  assert.deepEqual(Object.keys(out).sort(), ['arrEnabled', 'byType', 'categories', 'defaultRoot', 'selected']);
  assert.deepEqual(out.categories, ['films', 'séries']);
  assert.equal(out.selected, 'films');
  assert.deepEqual(out.byType, { movie: 'films', series: 's'.repeat(100), music: '' });
  assert.deepEqual(out.defaultRoot, { movie: '/m', series: '', music: '/mu'.repeat(300).slice(0, 500) });
  assert.deepEqual(out.arrEnabled, { movie: true, series: false, music: false });
  assert.deepEqual(cleanCategories({ ok: true }), {
    categories: [], selected: '', byType: { movie: '', series: '', music: '' }, defaultRoot: { movie: '', series: '', music: '' },
    arrEnabled: { movie: false, series: false, music: false }
  });
  assert.equal(cleanCategories({ categories: Array.from({ length: 1500 }, (_, i) => `c${i}`) }).categories.length, 1000);
  assert.deepEqual(cleanCategories({ byType: [], defaultRoot: 'x', arrEnabled: null }).byType, { movie: '', series: '', music: '' });
});

test('cleanStatus keeps a few bounded fields, and a library only for the three known services', () => {
  const { cleanStatus } = loadPure();
  assert.deepEqual(cleanStatus({ ok: true }), { qbit: null, library: null });
  assert.deepEqual(cleanStatus({
    ok: true,
    qbit: { name: 'n'.repeat(900), state: 'downloading', progress: 0.5, category: 'c', hash: 'abc' },
    library: {
      service: 'Radarr', inLibrary: true, hasFile: 1, title: 'T', files: '3', total: 4,
      seasons: [{ number: 1, exists: true, files: 2, total: 3 }, null, 5, { number: 'x' }]
    }
  }), {
    qbit: { name: 'n'.repeat(500), state: 'downloading', progress: 0.5, category: 'c' },
    library: {
      service: 'Radarr', inLibrary: true, artistOnly: false, hasFile: false, title: 'T', files: 0, total: 4,
      seasons: [{ number: 1, exists: true, files: 2, total: 3 }, { number: 0, exists: false, files: 0, total: 0 }]
    }
  });
  for (const service of ['radarr', 'Evil', '', null, 5]) assert.equal(cleanStatus({ library: { service, title: 'x' } }).library, null, String(service));
  assert.equal(cleanStatus({ qbit: { progress: Infinity } }).qbit.progress, 0);
  assert.equal(cleanStatus({ qbit: { progress: NaN } }).qbit.progress, 0);
  assert.equal(cleanStatus({ qbit: [] }).qbit, null);
  assert.equal(cleanStatus({ library: { service: 'Sonarr', seasons: Array.from({ length: 500 }, () => ({})) } }).library.seasons.length, 200);
});

test('cleanTorrents keeps hashes in lower case and bounded fields, and nothing from a failed answer', () => {
  const { cleanTorrents } = loadPure();
  assert.deepEqual(cleanTorrents({ ok: false, torrents: [{ hash: 'a' }] }), []);
  assert.deepEqual(cleanTorrents({ ok: true, torrents: 'x' }), []);
  assert.deepEqual(cleanTorrents({ ok: true }), []);
  assert.deepEqual(cleanTorrents({
    ok: true, torrents: [{ hash: 'ABCdef', name: 'n', progress: 1, state: 'pausedUP', extra: 1 }, null, 4, { hash: 5, progress: '1' }]
  }), [{ hash: 'abcdef', name: 'n', progress: 1, state: 'pausedUP' }, { hash: '', name: '', progress: 0, state: '' }]);
  assert.equal(cleanTorrents({ ok: true, torrents: Array.from({ length: 20001 }, () => ({ hash: 'a' })) }).length, 20000);
  assert.equal(cleanTorrents({ ok: true, torrents: [{ hash: 'a'.repeat(100), name: 'n'.repeat(900), state: 's'.repeat(90) }] })[0].hash.length, 64);
});

test('qbitText reads like the badge of the extension, and never trusts a state name as a property name', () => {
  const { qbitText } = loadPure();
  assert.equal(qbitText({ progress: 0.5, state: 'downloading' }), 'qBittorrent : 50 % · téléchargement');
  assert.equal(qbitText({ progress: 1, state: 'stalledUP' }), 'qBittorrent : complet · seed');
  assert.equal(qbitText({ progress: 0.25, state: 'queuedDL' }), 'qBittorrent : 25 % · en file');
  assert.equal(qbitText({ state: 'pausedUP' }), 'qBittorrent : 0 % · terminé');
  assert.equal(qbitText({ progress: 0.999, state: 'weird' }), 'qBittorrent : 99 % · weird');
  for (const state of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) assert.equal(qbitText({ progress: 0, state }), `qBittorrent : 0 % · ${state}`);
});

test('detectSeasons finds the seasons of an episode or of a range, and none for a complete pack', () => {
  const { detectSeasons } = loadPure();
  for (const [title, seasons] of [
    ['Show.S01E02.1080p.WEB', [1]],
    ['Show S02', [2]],
    ['Show S01-S03 MULTi', [1, 2, 3]],
    ['Show S03-S01 MULTi', [1, 2, 3]],
    ['Show S01 S02 S03', [1, 2, 3]],
    ['Show S01E01-E05', [1]],
    ['Show S01-S99', [1, 99]],
    ['Show.COMPLETE.1080p', []],
    ['Show S2020', []],
    ['Show S100', []],
    ['ASS01', []],
    ['', []]
  ]) assert.deepEqual(detectSeasons(title), seasons, title);
});

test('guessMusic splits "Artiste - Album (année)" and scene style names', () => {
  const { guessMusic } = loadPure();
  for (const [title, guess] of [
    ['Daft Punk - Discovery (2001) [FLAC]', { artist: 'Daft Punk', album: 'Discovery', year: '2001' }],
    ['Artist - Album 2001 Deluxe', { artist: 'Artist', album: 'Album', year: '2001' }],
    ['Artiste-Album-WEB-2001-GROUPE', { artist: 'Artiste', album: 'Album', year: '2001' }],
    ['Artiste.Name-Album.Title-WEB-2001-GRP', { artist: 'Artiste Name', album: 'Album Title', year: '2001' }],
    ['Artist – Album {2001}', { artist: 'Artist', album: 'Album', year: '' }],
    ['JustATitle', { artist: 'JustATitle', album: '', year: '' }],
    ['', { artist: '', album: '', year: '' }]
  ]) assert.deepEqual(guessMusic(title), guess, title);
});

test('normName only keeps lower-case letters and digits, without the .torrent extension', () => {
  const { normName } = loadPure();
  assert.equal(normName('Some.Show-S01.torrent'), 'someshows01');
  assert.equal(normName('Ab_C d.TORRENT'), 'abcd');
  for (const v of [null, undefined, '', 0]) assert.equal(normName(v), '');
});

test('strict keeps a value as it is or drops it, clip tidies free text', () => {
  const { strict, clip } = loadPure();
  assert.equal(strict('abc', 5), 'abc');
  assert.equal(strict('é', 5), 'é');
  for (const v of ['abcdef', 'a\nb', 'a\u0000', 'a\u007f', 'a\u0085', 'a\u2028', 'a\u2029', '\ud800', 'a\udc00b', 5, null, undefined, {}, ['a']]) assert.equal(strict(v, 5), '', String(v));
  assert.equal(clip('  a \n\t b\u0000c  ', 20), 'a b c');
  assert.equal(clip('x'.repeat(50), 10), 'x'.repeat(10));
  for (const v of [5, null, undefined, {}, ['a']]) assert.equal(clip(v, 10), '');
});

// ----- the .torrent file -----

test('checkDownloadUrl accepts the site on display and its blobs, and nothing else', () => {
  const { checkDownloadUrl, Notice } = loadPure();
  for (const [raw, href] of [
    ['https://c411.org/dl/x.torrent', 'https://c411.org/dl/x.torrent'],
    ['/dl/x.torrent?t=1', 'https://c411.org/dl/x.torrent?t=1'],
    ['dl/x.torrent', 'https://c411.org/torrents/dl/x.torrent'],
    ['https://C411.ORG:443/x', 'https://c411.org/x'],
    [BLOB, BLOB]
  ]) assert.equal(checkDownloadUrl(raw), href, raw);
  const refused = (e) => e instanceof Notice && e.message === 'Téléchargement refusé : adresse non autorisée';
  for (const raw of [
    'https://evil.example/a.torrent', 'https://c411.org.evil.example/a', 'https://www.c411.org/a.torrent', 'http://c411.org/a.torrent',
    'https://c411.org:8443/a', 'https://user:pw@c411.org/a', 'https://user@c411.org/a', '//evil.example/a', 'https://',
    'blob:null/0b2f6c1e-0000-4000-8000-000000000000', 'blob:https://evil.example/0b2f6c1e-0000-4000-8000-000000000000',
    'blob:http://c411.org/0b2f6c1e-0000-4000-8000-000000000000', 'blob:blob:https://c411.org/x',
    'javascript:alert(1)', 'data:text/plain;base64,AAAA', 'file:///etc/passwd', 'ftp://c411.org/a', 'about:blank', 'wss://c411.org/a'
  ]) assert.throws(() => checkDownloadUrl(raw), refused, raw);

  const local = loadPure({ allowHttp: true }, 'http://localhost:8080/torrents/1');
  assert.equal(local.checkDownloadUrl('/a.torrent'), 'http://localhost:8080/a.torrent');
  for (const raw of ['http://localhost:9090/a', 'https://localhost:8080/a', 'http://localhost/a', 'http://evil.example:8080/a', 'blob:http://localhost:9090/x']) {
    assert.throws(() => local.checkDownloadUrl(raw), (e) => e instanceof local.Notice, raw);
  }
  const strictHttps = loadPure({}, 'https://c411.org/');
  assert.throws(() => strictHttps.checkDownloadUrl('http://c411.org/a'), (e) => e instanceof strictHttps.Notice);
});

test('looksLikeTorrent wants a bencoded dictionary with an "info" key, nothing more', () => {
  const { looksLikeTorrent } = loadPure();
  const bytes = (s) => new Uint8Array(Buffer.from(s, 'latin1'));
  for (const ok of ['d4:info', 'd4:infod4:name1:xee', 'd8:announce3:url4:infod6:lengthi1eee', `d${'x'.repeat(5000)}4:info`]) assert.equal(looksLikeTorrent(bytes(ok)), true, ok.slice(0, 30));
  for (const no of ['', 'd', 'd4:inf', 'd4:inf0', '4:infod', 'e4:info', 'x'.repeat(100), '<html>4:info</html>', 'd3:abc3:def', 'd4:nifo', 'd5:info']) assert.equal(looksLikeTorrent(bytes(no)), false, no);
  assert.equal(looksLikeTorrent(Buffer.from('d4:info')), true);
  const big = new Uint8Array(2 * MIB).fill(0x61);
  big[0] = 0x64;
  assert.equal(looksLikeTorrent(big), false);
  big.set(bytes('4:info'), big.length - 6);
  assert.equal(looksLikeTorrent(big), true);
});

test('toBase64 gives the standard encoding of any bytes, without a stack overflow on big files', () => {
  const { toBase64 } = loadPure();
  const make = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255);
  assert.equal(toBase64(new Uint8Array(0)), '');
  for (const n of [1, 2, 3, 4, 255, 256, 0x2000, 3 * 0x2000 + 5, 100000]) assert.equal(toBase64(make(n)), Buffer.from(make(n)).toString('base64'), String(n));
  assert.equal(toBase64(new Uint8Array(5 * MIB).fill(255)), Buffer.alloc(5 * MIB, 255).toString('base64'));
});

test('fromBase64 is the strict reverse of toBase64, and never gives more than the limit', () => {
  const { fromBase64, toBase64, Notice } = loadPure();
  const impossible = (e) => e instanceof Notice && e.message === 'Téléchargement du .torrent impossible';
  const big = (e) => e instanceof Notice && e.message === 'Le fichier .torrent est trop volumineux.';
  const make = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255);
  for (const n of [0, 1, 2, 3, 4, 5, 255, 256, 0x2000, 100000]) {
    const out = fromBase64(Buffer.from(make(n)).toString('base64'), 200000);
    assert.ok(out instanceof Uint8Array, String(n));
    assert.deepEqual([...out], [...make(n)], String(n));
    assert.equal(toBase64(out), Buffer.from(make(n)).toString('base64'), String(n));
  }
  assert.equal(fromBase64(Buffer.alloc(5 * MIB, 255).toString('base64'), 5 * MIB).length, 5 * MIB);

  for (const bad of [
    undefined, null, 5, {}, [], ['QQ=='], 'QQ', 'QQ=', 'QQ===', 'Q', 'QUJD\n', 'QU JD', 'QUJD=', '=QUJ', 'QU=D', 'QQ==QQ==', 'A===', '====',
    'QUJ_', 'QUJ-', 'éééé', 'QUJD\u0000', ' QUJD', 'QUJD ', 'data:text/plain;base64,QUJD'
  ]) assert.throws(() => fromBase64(bad, 1000), impossible, JSON.stringify(bad));

  assert.deepEqual([...fromBase64('', 0)], []);
  assert.equal(fromBase64(Buffer.alloc(100).toString('base64'), 100).length, 100);
  assert.throws(() => fromBase64(Buffer.alloc(102).toString('base64'), 100), big, '102 bytes, 136 characters: the characters fit, the bytes do not');
  assert.throws(() => fromBase64(Buffer.alloc(101).toString('base64'), 100), big);
  assert.throws(() => fromBase64('A'.repeat(1000), 100), big, 'refused before anything is decoded');
  assert.throws(() => fromBase64(`${'A'.repeat(1000)}!`, 100), big, 'the length is checked first');
});

test('decodeTorrent only believes a file that comes with a blob of the site and looks like a torrent', () => {
  const { decodeTorrent, Notice } = loadPure();
  const refused = (e) => e instanceof Notice && e.message === 'Téléchargement refusé : adresse non autorisée';
  const notTorrent = (e) => e instanceof Notice && e.message === 'Le fichier récupéré n’est pas un .torrent valide';
  const blob = 'blob:https://c411.org/0b2f6c1e-0000-4000-8000-000000000000';
  const decoded = decodeTorrent(blob, TORRENT.toString('base64'), MIB);
  assert.deepEqual([...decoded.bytes], [...TORRENT]);
  assert.equal(decoded.name, '');
  for (const href of ['https://c411.org/a.torrent', 'http://c411.org/a.torrent', 'data:application/x-bittorrent;base64,ZDQ6aW5mbw==', 'file:///a.torrent', 'javascript:1', '']) {
    assert.throws(() => decodeTorrent(href, TORRENT.toString('base64'), MIB), refused, href);
  }
  for (const text of ['<html>4:info</html>', '', 'd', 'd3:abc3:def']) assert.throws(() => decodeTorrent(blob, Buffer.from(text).toString('base64'), MIB), notTorrent, text);
  assert.throws(() => decodeTorrent(blob, TORRENT.toString('base64'), TORRENT.length - 1), (e) => e instanceof Notice && e.message === 'Le fichier .torrent est trop volumineux.');
  assert.equal(decodeTorrent(blob, TORRENT.toString('base64'), TORRENT.length).bytes.length, TORRENT.length);
});

test('readLimited gives up when the length is announced as too big, or as soon as the body goes over the limit', async () => {
  const { readLimited, Notice } = loadPure();
  const big = (e) => e instanceof Notice && e.message === 'Le fichier .torrent est trop volumineux.';
  const headers = (length) => ({ get: (name) => (name === 'content-length' ? length : null) });

  await assert.rejects(readLimited({ headers: headers('101'), body: { getReader() { throw new Error('the body must not be read'); } } }, 100), big);
  assert.equal((await readLimited(new Response(new Uint8Array(100).fill(7)), 100)).length, 100);
  await assert.rejects(readLimited(new Response(new Uint8Array(101)), 100), big);

  const chunks = [Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5), Uint8Array.of(6)];
  const reading = (list, cancelled) => {
    let read = 0;
    return {
      headers: headers(null),
      body: { getReader: () => ({ read: async () => (read < list.length ? { done: false, value: list[read++] } : { done: true }), cancel: async () => { cancelled.push(read); } }) }
    };
  };
  assert.deepEqual([...await readLimited(reading(chunks, []), 6)], [1, 2, 3, 4, 5, 6]);
  const cancelled = [];
  await assert.rejects(readLimited(reading(chunks, cancelled), 4), big);
  assert.deepEqual(cancelled, [2], 'the stream is cancelled as soon as the limit is passed, and not read any further');
  await assert.rejects(readLimited(reading([Uint8Array.of(1), null], []), 10), (e) => e instanceof Notice && e.message === 'Téléchargement du .torrent impossible');

  const noStream = (n) => ({ headers: headers(null), body: null, arrayBuffer: async () => new Uint8Array(n).fill(9).buffer });
  assert.equal((await readLimited(noStream(10), 10)).length, 10);
  await assert.rejects(readLimited(noStream(11), 10), big);
  assert.equal((await readLimited({ headers: headers('10'), body: {}, arrayBuffer: async () => new ArrayBuffer(10) }, 10)).length, 10);
});

test('the name of the file comes from the headers, then the address, and is reduced to a harmless last component', () => {
  const { dispositionName, urlName, safeName } = loadPure();
  assert.equal(dispositionName('attachment; filename="a b.torrent"'), 'a b.torrent');
  assert.equal(dispositionName('attachment; filename=a.torrent'), 'a.torrent');
  assert.equal(dispositionName('attachment; filename*=UTF-8\'\'%C3%A9t%C3%A9.torrent; filename="fallback.torrent"'), 'été.torrent');
  assert.equal(dispositionName('attachment; filename*=UTF-8\'\'%E0%A4%A; filename="fallback.torrent"'), 'fallback.torrent');
  assert.equal(dispositionName('attachment; filename*=UTF-8\'\'%E0%A4%A'), '');
  assert.equal(dispositionName('inline'), '');
  for (const v of [null, undefined, 5, {}]) assert.equal(dispositionName(v), '');

  assert.equal(urlName('https://c411.org/dl/My%20File.torrent?x=1'), 'My File.torrent');
  for (const v of [BLOB, 'https://c411.org/', 'https://c411.org/dl/%E0%A4%A', 'not a url', '']) assert.equal(urlName(v), '', v);

  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('C:\\x\\a.torrent'), 'a.torrent');
  assert.equal(safeName('a\u0000b"c".torrent'), 'abc.torrent');
  assert.equal(safeName('  été.torrent  '), 'été.torrent');
  assert.equal(safeName('x'.repeat(300)).length, 200);
  assert.equal(safeName('', null, 5, 'second.torrent', 'third'), 'second.torrent');
  for (const v of [[], [''], ['   '], ['..'], ['.'], ['/'], ['\\'], ['a/..'], [undefined, null, 5, {}], ['\u0000\u0001']]) assert.equal(safeName(...v), 'file.torrent', JSON.stringify(v));
});

test('the limit of a .torrent stays below what the DevTools connection carries, whatever is configured', () => {
  const { torrentLimit, MAX_BRIDGE_CHARS, BRIDGE_ENVELOPE } = loadPure();
  const cdp = read(__dirname, '..', 'server', 'c411', 'cdp.js');
  const cdpMax = /const MAX_MESSAGE = (\d+) \* 1024 \* 1024;/.exec(cdp);
  assert.ok(cdpMax, 'MAX_MESSAGE not found in cdp.js: update this test');
  assert.ok(MAX_BRIDGE_CHARS < Number(cdpMax[1]) * MIB, 'a request would close the DevTools connection');
  for (const limit of [1024, MIB, 14 * MIB, 25 * MIB, 200 * MIB, 256 * MIB]) {
    const kept = torrentLimit(limit);
    assert.ok(kept <= limit, String(limit));
    assert.ok(4 * Math.ceil(kept / 3) + BRIDGE_ENVELOPE <= MAX_BRIDGE_CHARS, `${limit}: the base64 form and the envelope fit`);
  }
  assert.equal(torrentLimit(1000), 1000);
  assert.equal(torrentLimit(25 * MIB), torrentLimit(256 * MIB));
  assert.ok(torrentLimit(25 * MIB) > 14 * MIB);
});
