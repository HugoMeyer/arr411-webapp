'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { HttpError } = require('./util');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2'
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg', '.txt', '.ico']);
const LONG_CACHE = new Set(['.png', '.ico', '.svg', '.woff2']);
const MAX_CACHED = 4 * 1024 * 1024;

// Weak comparison, as proxies in front of us may turn strong ETags into weak ones.
function etagMatches(header, etag) {
  if (!header) return false;
  const bare = (t) => t.trim().replace(/^W\//, '');
  const mine = bare(etag);
  return String(header)
    .split(',')
    .some((t) => t.trim() === '*' || bare(t) === mine);
}

class StaticFiles {
  constructor(root) {
    this.root = path.resolve(root);
    this.cache = new Map();
  }

  // Maps a URL pathname to a file inside the root, or null.
  resolve(pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, 'Chemin invalide');
    }
    if (/[\0\\]/.test(decoded)) throw new HttpError(400, 'Chemin invalide');
    const segs = decoded.split('/').filter(Boolean);
    if (segs.some((s) => s === '..' || s === '.' || s.startsWith('.'))) return null;
    const file = path.join(this.root, ...segs);
    if (file !== this.root && !file.startsWith(this.root + path.sep)) return null;
    return file;
  }

  async load(file) {
    let st = await fsp.stat(file).catch(() => null);
    if (st && st.isDirectory()) {
      file = path.join(file, 'index.html');
      st = await fsp.stat(file).catch(() => null);
    }
    if (!st || !st.isFile()) return null;
    const hit = this.cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
    if (st.size > MAX_CACHED) return { file, size: st.size, mtimeMs: st.mtimeMs, buf: null, etag: `W/"${st.size}-${Math.round(st.mtimeMs)}"`, ext: path.extname(file).toLowerCase() };
    const buf = await fsp.readFile(file);
    const ext = path.extname(file).toLowerCase();
    const entry = {
      file,
      size: st.size,
      mtimeMs: st.mtimeMs,
      buf,
      gz: null,
      ext,
      etag: `W/"${crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 20)}"`
    };
    this.cache.set(file, entry);
    return entry;
  }

  async serve(req, res, pathname, extra) {
    const file = this.resolve(pathname);
    const entry = file && (await this.load(file));
    if (!entry) return false;
    const type = TYPES[entry.ext] || 'application/octet-stream';
    const headers = Object.assign({ 'Content-Type': type, ETag: entry.etag, Vary: 'Accept-Encoding' }, extra);
    headers['Cache-Control'] = LONG_CACHE.has(entry.ext) ? 'public, max-age=86400' : 'no-cache';
    if (etagMatches(req.headers['if-none-match'], entry.etag)) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    if (!entry.buf) {
      headers['Content-Length'] = entry.size;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') res.end();
      else fs.createReadStream(entry.file).on('error', () => res.destroy()).pipe(res);
      return true;
    }
    let body = entry.buf;
    if (COMPRESSIBLE.has(entry.ext) && entry.size > 1024 && /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))) {
      if (!entry.gz) entry.gz = zlib.gzipSync(entry.buf, { level: 9 });
      body = entry.gz;
      headers['Content-Encoding'] = 'gzip';
    }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }
}

module.exports = { StaticFiles };
