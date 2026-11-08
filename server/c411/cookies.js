'use strict';
// Cookies of the remote browser, kept per Arr411 account so that the C411 login survives a restart of the browser.
// The owner is an opaque key of the account (not its name): a new account with the name of a removed one never finds the
// cookies of the old one. Only cookies of allowed hosts are ever stored or given back to the browser, and every field is
// validated again on load.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_COOKIES = 150;
const MAX_FILE_BYTES = 512 * 1024;
const SAME_SITE = new Set(['Strict', 'Lax', 'None']);
const BAD_NAME = /[\u0000-\u0020\u007f"(),/:;<=>?@[\\\]{}]/;
const BAD_VALUE = /[\u0000-\u001f\u007f;]/;

function clean(list, matcher) {
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    if (out.length >= MAX_COOKIES) break;
    if (!c || typeof c !== 'object') continue;
    const { name, value, domain } = c;
    if (typeof name !== 'string' || !name || name.length > 256 || BAD_NAME.test(name)) continue;
    if (typeof value !== 'string' || value.length > 4096 || BAD_VALUE.test(value)) continue;
    if (typeof domain !== 'string' || !matcher.allows(domain.replace(/^\./, ''))) continue;
    const p = typeof c.path === 'string' && c.path.startsWith('/') && c.path.length <= 256 && !/[\u0000-\u001f\u007f;]/.test(c.path) ? c.path : '/';
    const cookie = { name, value, domain, path: p, secure: c.secure === true, httpOnly: c.httpOnly === true };
    if (typeof c.expires === 'number' && Number.isFinite(c.expires) && c.expires > 0) cookie.expires = c.expires;
    if (SAME_SITE.has(c.sameSite)) cookie.sameSite = c.sameSite;
    out.push(cookie);
  }
  return out;
}

const nameFor = (owner) => `${crypto.createHash('sha256').update(String(owner)).digest('hex')}.json`;
const OURS = /^[0-9a-f]{64}\.json$/;

function createCookieStore(dir, matcher) {
  const fileFor = (owner) => path.join(dir, nameFor(owner));
  return {
    clean: (list) => clean(list, matcher),

    async load(owner) {
      try {
        const file = fileFor(owner);
        const st = await fsp.stat(file);
        if (!st.isFile() || st.size > MAX_FILE_BYTES) return [];
        const data = JSON.parse(await fsp.readFile(file, 'utf8'));
        const now = Date.now() / 1000;
        return clean(data && data.cookies, matcher).filter((c) => c.expires === undefined || c.expires > now);
      } catch {
        return [];
      }
    },

    async save(owner, list) {
      const cookies = clean(list, matcher);
      const file = fileFor(owner);
      if (!cookies.length) {
        await fsp.rm(file, { force: true });
        return;
      }
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify({ version: 1, cookies }), { mode: 0o600 });
      await fsp.rename(tmp, file);
    },

    async remove(owner) {
      await fsp.rm(fileFor(owner), { force: true });
    },

    // Deletes the cookies of every owner that is not in the list (accounts removed in the meantime). Returns how many.
    async sweep(owners) {
      const keep = new Set([...owners].map(nameFor));
      let names;
      try {
        names = await fsp.readdir(dir);
      } catch {
        return 0;
      }
      let removed = 0;
      for (const name of names) {
        if (!OURS.test(name) || keep.has(name)) continue;
        await fsp.rm(path.join(dir, name), { force: true });
        removed++;
      }
      return removed;
    }
  };
}

module.exports = { createCookieStore, clean };
