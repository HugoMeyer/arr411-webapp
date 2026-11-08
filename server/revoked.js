'use strict';
// Sessions that were signed out. A session cookie is signed and carries no state, so without this list a copy of it
// (a stolen cookie, a second tab) would keep working until it expires. An entry is only kept while a cookie of that
// session could still be valid, and the list is bounded.
const MAX_ENTRIES = 5000;
// A cookie lives `ttlSec` at most and none is issued once its session is revoked; the margin absorbs rounding.
const MARGIN_SEC = 60;

class Revoked {
  constructor(store, ttlSec) {
    this.store = store;
    this.ttlSec = ttlSec;
    const d = store.data;
    if (!d.sessions || typeof d.sessions !== 'object' || Array.isArray(d.sessions)) d.sessions = {};
    this.prune();
  }

  has(sid, nowMs = Date.now()) {
    const sessions = this.store.data.sessions;
    return typeof sid === 'string' && Object.hasOwn(sessions, sid) && Number(sessions[sid]) * 1000 > nowMs;
  }

  // `sid` comes from a cookie that was verified. The change is in memory before this returns a promise, so a disk that
  // refuses the write cannot let the session live until the restart.
  revoke(sid, nowMs = Date.now()) {
    this.store.data.sessions[sid] = Math.floor(nowMs / 1000) + this.ttlSec + MARGIN_SEC;
    this.prune(nowMs);
    return this.store.save();
  }

  prune(nowMs = Date.now()) {
    const sessions = this.store.data.sessions;
    const now = nowMs / 1000;
    for (const [sid, exp] of Object.entries(sessions)) if (typeof exp !== 'number' || !(exp > now)) delete sessions[sid];
    const sids = Object.keys(sessions);
    if (sids.length > MAX_ENTRIES) {
      sids.sort((a, b) => sessions[a] - sessions[b]);
      for (const sid of sids.slice(0, sids.length - MAX_ENTRIES)) delete sessions[sid];
    }
  }
}

module.exports = { Revoked, MAX_ENTRIES };
