'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const stamp = (file) => {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '';
  }
};

class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.data = null;
    this.queue = Promise.resolve();
    this.pending = 0;
    this.stamp = '';
    this.checkedAt = 0;
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('contenu inattendu');
      this.data = data;
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`Impossible de lire ${this.file} : ${e.message}. Corrige ou supprime ce fichier.`);
      this.data = this.defaults();
    }
    this.stamp = stamp(this.file);
    return this;
  }

  // Picks up edits made by another process (the CLI), at most once per second
  // unless forced. Returns true when the data was reloaded.
  refresh(force = false) {
    const now = Date.now();
    if (this.pending || (!force && now - this.checkedAt < 1000)) return false;
    this.checkedAt = now;
    const s = stamp(this.file);
    if (!s || s === this.stamp) return false;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
      this.data = data;
      this.stamp = s;
      return true;
    } catch {
      return false;
    }
  }

  // Serialised atomic writes: the snapshot is taken when save() is called.
  save() {
    const json = JSON.stringify(this.data, null, 2);
    const run = async () => {
      const tmp = `${this.file}.${process.pid}.tmp`;
      try {
        await fsp.writeFile(tmp, json, { mode: 0o600 });
        await fsp.rename(tmp, this.file);
        this.stamp = stamp(this.file);
      } finally {
        this.pending--;
      }
    };
    this.pending++;
    this.queue = this.queue.then(run, run);
    return this.queue;
  }
}

function ensureDataDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const probe = path.join(dir, `.write-test-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (e) {
    throw new Error(`Le dossier de données ${dir} n’est pas accessible en écriture (${e.code || e.message}). Vérifie le volume et ses droits.`);
  }
}

function loadSecret(dir, fromEnv) {
  if (fromEnv) {
    if (fromEnv.length < 16) throw new Error('SESSION_SECRET doit faire au moins 16 caractères');
    return Buffer.from(fromEnv, 'utf8');
  }
  const file = path.join(dir, 'secret.key');
  try {
    const b = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    if (b.length >= 32) return b;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const secret = crypto.randomBytes(48);
  fs.writeFileSync(file, secret.toString('base64'), { mode: 0o600 });
  return secret;
}

module.exports = { JsonStore, ensureDataDir, loadSecret };
