'use strict';
// Hosts the remote browser may reach. Shared by the application (navigation checks) and the egress proxy
// (network checks), so both always apply the same list.
const net = require('node:net');

const DEFAULT_HOSTS = ['c411.org', '*.c411.org', 'challenges.cloudflare.com'];
// Where the extension script is allowed to run and to talk to the application: the site itself, never the challenge frames.
const BRIDGE_HOSTS = ['c411.org', '*.c411.org'];
const LABEL = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/;

// Lower-case host name without trailing dot, or '' when it is not a plain DNS name (IP literals included).
function normalizeHost(input) {
  const h = String(input == null ? '' : input).trim().toLowerCase().replace(/\.$/, '');
  if (!h || h.length > 253) return '';
  if (h.startsWith('[') || net.isIP(h)) return '';
  const labels = h.split('.');
  // Same rule as the URL standard: a last label that is a decimal or 0x… number makes the whole host an IPv4 address in disguise
  // (2130706433, 0x7f.1, 127.1 …).
  if (/^(?:[0-9]+|0x[0-9a-f]*)$/.test(labels[labels.length - 1])) return '';
  return labels.every((l) => LABEL.test(l)) ? h : '';
}

// Comma or space separated patterns: "example.com", "*.example.com" (sub-domains only) or "*" (any public host).
function parseHosts(text) {
  const out = [];
  for (const raw of String(text || '').split(/[\s,;]+/)) {
    const p = raw.trim().toLowerCase();
    if (!p) continue;
    if (p === '*') out.push(p);
    else if (p.startsWith('*.') && normalizeHost(p.slice(2))) out.push('*.' + normalizeHost(p.slice(2)));
    else if (normalizeHost(p)) out.push(normalizeHost(p));
    else throw new Error(`C411_ALLOWED_HOSTS : « ${raw} » n’est pas un nom de domaine valide (exemples : exemple.org, *.exemple.org, *)`);
  }
  return out;
}

function createMatcher(extra, base = DEFAULT_HOSTS) {
  const list = Array.isArray(extra) ? extra : parseHosts(extra);
  const patterns = [...new Set([...base, ...list])];
  const any = patterns.includes('*');
  const exact = new Set(patterns.filter((p) => !p.startsWith('*')));
  const suffixes = patterns.filter((p) => p.startsWith('*.')).map((p) => p.slice(1));
  return {
    patterns,
    any,
    allows(host) {
      const h = normalizeHost(host);
      if (!h) return false;
      return any || exact.has(h) || suffixes.some((s) => h.endsWith(s) && h.length > s.length);
    }
  };
}

// https only, default port, no credentials, allowed host. Returns the parsed URL or null.
// `allowHttp` (tests only, never reachable from the configuration) also accepts plain http on any port.
function allowedHttpsUrl(href, matcher, { allowHttp = false } = {}) {
  let u;
  try {
    u = new URL(String(href));
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol === 'https:') {
    if (u.port && u.port !== '443') return null;
  } else if (!(allowHttp && u.protocol === 'http:')) {
    return null;
  }
  return matcher.allows(u.hostname) ? u : null;
}

module.exports = { DEFAULT_HOSTS, BRIDGE_HOSTS, normalizeHost, parseHosts, createMatcher, allowedHttpsUrl };
