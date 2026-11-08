'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
const TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_BYTES = 150 * 1024 * 1024;
const LOW_BYTES = 100 * 1024 * 1024;
const MISS_TTL_MS = 5 * 60 * 1000;

// Disk cache for posters and banners fetched from Radarr/Sonarr/Lidarr.
// File format: one byte (index into TYPES) followed by the image bytes.
class CoverCache {
  constructor(dir) {
    this.dir = dir;
    this.written = 0;
    this.misses = new Map();
    fs.mkdirSync(dir, { recursive: true });
    this.timer = setInterval(() => this.prune().catch(() => {}), 6 * 3600 * 1000);
    this.timer.unref();
    setTimeout(() => this.prune().catch(() => {}), 30 * 1000).unref();
  }

  key(svc, url, pathAndQuery) {
    return crypto.createHash('sha256').update(`${svc}\n${url}\n${pathAndQuery}`).digest('hex');
  }

  file(key) {
    return path.join(this.dir, key.slice(0, 2), key);
  }

  typeIndex(contentType) {
    return TYPES.indexOf(String(contentType || '').split(';')[0].trim().toLowerCase());
  }

  isMiss(key) {
    const t = this.misses.get(key);
    if (t && t > Date.now()) return true;
    this.misses.delete(key);
    return false;
  }

  markMiss(key) {
    if (this.misses.size > 5000) this.misses.clear();
    this.misses.set(key, Date.now() + MISS_TTL_MS);
  }

  async get(key) {
    const file = this.file(key);
    try {
      const st = await fsp.stat(file);
      if (Date.now() - st.mtimeMs > TTL_MS) return null;
      const buf = await fsp.readFile(file);
      const type = TYPES[buf[0]];
      return type ? { type, body: buf.subarray(1) } : null;
    } catch {
      return null;
    }
  }

  async put(key, contentType, body) {
    const idx = this.typeIndex(contentType);
    if (idx < 0) return;
    const file = this.file(key);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, Buffer.concat([Buffer.from([idx]), body]));
    await fsp.rename(tmp, file);
    this.written += body.length;
    if (this.written > 20 * 1024 * 1024) {
      this.written = 0;
      this.prune().catch(() => {});
    }
  }

  async prune() {
    const files = [];
    let total = 0;
    for (const d of await fsp.readdir(this.dir, { withFileTypes: true }).catch(() => [])) {
      if (!d.isDirectory()) continue;
      const sub = path.join(this.dir, d.name);
      for (const f of await fsp.readdir(sub).catch(() => [])) {
        const full = path.join(sub, f);
        const st = await fsp.stat(full).catch(() => null);
        if (!st || !st.isFile()) continue;
        if (f.endsWith('.tmp') ? Date.now() - st.mtimeMs > 3600 * 1000 : Date.now() - st.mtimeMs > TTL_MS) {
          await fsp.unlink(full).catch(() => {});
          continue;
        }
        files.push({ full, size: st.size, mtimeMs: st.mtimeMs });
        total += st.size;
      }
    }
    if (total <= MAX_BYTES) return;
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of files) {
      if (total <= LOW_BYTES) break;
      await fsp.unlink(f.full).catch(() => {});
      total -= f.size;
    }
  }
}

module.exports = { CoverCache };
