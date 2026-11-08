'use strict';
const { randomInt } = require('node:crypto');
const { HttpError } = require('./util');
const { hashPassword, validatePassword, validateUsername } = require('./password');

const ROLES = ['admin', 'user'];
const START_TABS = ['c411', 'radarr', 'sonarr', 'lidarr', 'qbit', 'last'];

const now = () => new Date().toISOString();

// Per-user preferences kept on the server. Every value is validated.
const PREF_RULES = {
  startTab: (v) => (START_TABS.includes(v) ? v : undefined),
  lastCategory: (v) => (typeof v === 'string' && v.length <= 100 ? v : undefined),
  notifyDone: (v) => (typeof v === 'boolean' ? v : undefined)
};

function cleanPrefs(input) {
  const out = {};
  for (const [k, v] of Object.entries(input && typeof input === 'object' ? input : {})) {
    if (!Object.prototype.hasOwnProperty.call(PREF_RULES, k)) continue;
    const c = PREF_RULES[k](v);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

class Users {
  constructor(store) {
    this.store = store;
  }

  get all() {
    const d = this.store.data;
    if (!Array.isArray(d.users)) d.users = [];
    return d.users;
  }

  refresh() {
    return this.store.refresh();
  }

  // Mutations start from the file on disk so a CLI edit made a moment ago is not overwritten.
  fresh() {
    this.store.refresh(true);
  }

  find(username) {
    const n = String(username == null ? '' : username).toLowerCase();
    return this.all.find((u) => u.username === n) || null;
  }

  view(u) {
    return { username: u.username, role: u.role, disabled: !!u.disabled, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null };
  }

  list() {
    return this.all.map((u) => this.view(u)).sort((a, b) => a.username.localeCompare(b.username));
  }

  activeAdmins() {
    return this.all.filter((u) => u.role === 'admin' && !u.disabled);
  }

  async create({ username, password, role }) {
    username = validateUsername(username);
    validatePassword(password);
    role = role || 'user';
    if (!ROLES.includes(role)) throw new HttpError(400, 'Rôle invalide');
    this.fresh();
    if (this.find(username)) throw new HttpError(409, 'Cet identifiant existe déjà');
    const hash = await hashPassword(password);
    this.fresh();
    if (this.find(username)) throw new HttpError(409, 'Cet identifiant existe déjà');
    // Random starting version: cookies of a deleted account never match an account created later with the same name.
    const u = { username, role, hash, disabled: false, sv: randomInt(1, 2 ** 31), createdAt: now(), lastLoginAt: null, prefs: {} };
    this.all.push(u);
    await this.store.save();
    return u;
  }

  // Changing the password bumps the session version, which signs everybody out.
  async setPassword(username, password) {
    validatePassword(password);
    this.fresh();
    if (!this.find(username)) throw new HttpError(404, 'Utilisateur introuvable');
    const hash = await hashPassword(password);
    this.fresh();
    const u = this.find(username);
    if (!u) throw new HttpError(404, 'Utilisateur introuvable');
    u.hash = hash;
    u.sv = (u.sv || 1) + 1;
    await this.store.save();
    return u;
  }

  async update(username, patch, actor) {
    this.fresh();
    const u = this.find(username);
    if (!u) throw new HttpError(404, 'Utilisateur introuvable');
    const self = actor && actor.username === u.username;
    if (patch.role !== undefined && patch.role !== u.role) {
      if (!ROLES.includes(patch.role)) throw new HttpError(400, 'Rôle invalide');
      if (self) throw new HttpError(409, 'Tu ne peux pas modifier ton propre rôle');
    }
    if (patch.disabled !== undefined && !!patch.disabled !== !!u.disabled && self) {
      throw new HttpError(409, 'Tu ne peux pas désactiver ton propre compte');
    }
    const nextRole = patch.role !== undefined ? patch.role : u.role;
    const nextDisabled = patch.disabled !== undefined ? !!patch.disabled : !!u.disabled;
    const wasActiveAdmin = u.role === 'admin' && !u.disabled;
    const willBeActiveAdmin = nextRole === 'admin' && !nextDisabled;
    if (wasActiveAdmin && !willBeActiveAdmin && this.activeAdmins().length <= 1) {
      throw new HttpError(409, 'Il doit rester au moins un administrateur actif');
    }
    u.role = nextRole;
    // Cookies issued before the account was disabled must not come back to life when it is enabled again.
    if (nextDisabled && !u.disabled) u.sv = (u.sv || 1) + 1;
    u.disabled = nextDisabled;
    await this.store.save();
    return u;
  }

  async remove(username, actor) {
    this.fresh();
    const u = this.find(username);
    if (!u) throw new HttpError(404, 'Utilisateur introuvable');
    if (actor && actor.username === u.username) throw new HttpError(409, 'Tu ne peux pas supprimer ton propre compte');
    if (u.role === 'admin' && !u.disabled && this.activeAdmins().length <= 1) {
      throw new HttpError(409, 'Il doit rester au moins un administrateur actif');
    }
    this.store.data.users = this.all.filter((x) => x !== u);
    await this.store.save();
    return u;
  }

  async touchLogin(username) {
    this.fresh();
    const u = this.find(username);
    if (!u) return;
    u.lastLoginAt = now();
    await this.store.save();
  }

  async setPrefs(username, patch) {
    this.fresh();
    const u = this.find(username);
    if (!u) throw new HttpError(404, 'Utilisateur introuvable');
    u.prefs = Object.assign({}, u.prefs, cleanPrefs(patch));
    await this.store.save();
    return u.prefs;
  }
}

module.exports = { Users, ROLES, PREF_RULES, cleanPrefs };
