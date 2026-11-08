'use strict';
// The two scripts that the remote browser runs on the C411 site: `main` for the world of the page, `isolated` for the
// isolated world (the content script). The configuration is checked here and enters the code only as a JSON literal
// made of the validated values; unknown fields are ignored. `main` never gets the names of the binding or of the
// receiving function: it does not need them, and the page must not be able to learn them.
const fs = require('node:fs');
const path = require('node:path');
const { normalizeHost } = require('../hosts');

const PLACEHOLDER = '__ARR411_CONFIG__';
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{2,40}$/;
const TOPIC = /^[A-Za-z0-9_-]{8,64}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,31}$/;
const MAX_HOSTS = 64;
const MAX_PATTERN = 260;
// The engine accepts uploads of up to 200 MiB; the script itself keeps what it sends within what the DevTools connection carries.
const MIN_TORRENT_BYTES = 1024;
const MAX_TORRENT_BYTES = 256 * 1024 * 1024;
const MIN_ARM_MS = 1000;
const MAX_ARM_MS = 30000;
const DEFAULT_ARM_MS = 20000;
// Names that would hide something the scripts (or the site) rely on.
const RESERVED = new Set([
  '__proto__', 'constructor', 'prototype', 'window', 'self', 'top', 'parent', 'frames', 'globalThis', 'document', 'location',
  'history', 'navigator', 'console', 'fetch', 'eval', 'name', 'length', 'opener', 'Object', 'Function', 'Array', 'Promise',
  'Reflect', 'Proxy', 'JSON', 'URL', 'Date', 'Math', 'String', 'Number', 'Symbol', 'Event', 'EventTarget', 'CustomEvent'
]);

const bad = (field, why) => new Error(`Scripts C411 : « ${field} » ${why}`);
const own = (cfg, key) => (Object.hasOwn(cfg, key) ? cfg[key] : undefined);

function identifier(cfg, key) {
  const v = own(cfg, key);
  if (typeof v !== 'string' || !IDENT.test(v)) {
    throw bad(key, 'doit être un identifiant (lettres, chiffres et _, de 3 à 41 caractères, sans chiffre au début)');
  }
  if (RESERVED.has(v)) throw bad(key, `ne peut pas s’appeler « ${v} » (nom réservé)`);
  return v;
}

// "example.org", "*.example.org" (sub-domains only) or "*", as in hosts.js; returns '' when invalid.
function pattern(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_PATTERN) return '';
  const p = raw.trim().toLowerCase();
  if (p === '*') return p;
  if (p.startsWith('*.')) {
    const host = normalizeHost(p.slice(2));
    return host ? `*.${host}` : '';
  }
  return normalizeHost(p);
}

function hostPatterns(cfg) {
  const v = own(cfg, 'hosts');
  if (!Array.isArray(v) || !v.length || v.length > MAX_HOSTS) throw bad('hosts', `doit être un tableau de 1 à ${MAX_HOSTS} motifs`);
  const out = [];
  for (const raw of v) {
    const p = pattern(raw);
    if (!p) throw bad('hosts', 'contient un motif invalide (exemples : exemple.org, *.exemple.org, *)');
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

function integer(cfg, key, min, max, fallback) {
  const v = own(cfg, key);
  if (v === undefined && fallback !== undefined) return fallback;
  if (!Number.isSafeInteger(v) || v < min || v > max) throw bad(key, `doit être un entier entre ${min} et ${max}`);
  return v;
}

function flag(cfg, key) {
  const v = own(cfg, key);
  if (v === undefined) return false;
  if (typeof v !== 'boolean') throw bad(key, 'doit être un booléen');
  return v;
}

function topicName(cfg) {
  const v = own(cfg, 'topic');
  if (typeof v !== 'string' || !TOPIC.test(v)) throw bad('topic', 'doit comporter de 8 à 64 caractères parmi A-Z a-z 0-9 _ -');
  return v;
}

function versionName(cfg) {
  const v = own(cfg, 'version');
  if (v === undefined) return '0';
  if (Number.isSafeInteger(v) && v >= 0) return String(v);
  if (typeof v === 'string' && VERSION.test(v)) return v;
  throw bad('version', 'doit être un entier positif ou une courte chaîne (lettres, chiffres, . _ + -)');
}

// JSON, with the two line separators that older JavaScript does not accept inside a string.
const literal = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

let sources = null;

function load() {
  if (sources) return sources;
  const read = (name) => {
    const text = fs.readFileSync(path.join(__dirname, name), 'utf8');
    if (text.split(PLACEHOLDER).length !== 2) throw new Error(`${name} : « ${PLACEHOLDER} » doit apparaître exactement une fois`);
    return text;
  };
  sources = { main: read('main.js'), isolated: read('isolated.js') };
  return sources;
}

// cfg: { hosts, allowHttp?, binding, recv, topic, maxTorrentBytes, armMs?, version? } → { main, isolated }, ready to be injected.
function build(cfg) {
  if (Object.prototype.toString.call(cfg) !== '[object Object]') throw new Error('Scripts C411 : la configuration doit être un objet');
  const binding = identifier(cfg, 'binding');
  const recv = identifier(cfg, 'recv');
  if (binding === recv) throw bad('recv', 'doit différer de « binding »');
  const clean = {
    hosts: hostPatterns(cfg),
    allowHttp: flag(cfg, 'allowHttp'),
    binding,
    recv,
    topic: topicName(cfg),
    maxTorrentBytes: integer(cfg, 'maxTorrentBytes', MIN_TORRENT_BYTES, MAX_TORRENT_BYTES),
    armMs: integer(cfg, 'armMs', MIN_ARM_MS, MAX_ARM_MS, DEFAULT_ARM_MS),
    version: versionName(cfg)
  };
  const forMain = literal({ hosts: clean.hosts, allowHttp: clean.allowHttp, topic: clean.topic, maxTorrentBytes: clean.maxTorrentBytes });
  const forIsolated = literal(clean);
  const code = load();
  return {
    main: code.main.replace(PLACEHOLDER, () => forMain),
    isolated: code.isolated.replace(PLACEHOLDER, () => forIsolated)
  };
}

module.exports = { build };
