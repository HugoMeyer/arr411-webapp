'use strict';
// Server side of the C411 view: the connection to the remote browser, one tab per Arr411 account, and the link between that
// tab, the person who is watching it and the extension engine. Everything arriving from the browser or from a viewer is
// treated as untrusted input. An account is told apart by an opaque key given by the caller (the name AND the creation
// date): a tab and saved cookies are never handed to a new account that merely has the name of a removed one.
const crypto = require('node:crypto');
const { connect } = require('./cdp');
const { RemotePage } = require('./page');
const { NAV_ACTIONS } = require('./input');

const RECENT_INPUT_MS = 60000;
const TICK_MS = 15000;
const COOKIE_SAVE_MS = 60000;
const SWEEP_MS = 60 * 60 * 1000;
const POPUP_WAIT_MS = 3000;
const MAX_POPUPS = 6;
const AVAILABILITY_TTL_MS = 5000;
const MAX_ENGINE_CALLS = 4;
const quiet = () => {};

class HubError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Allows bursts, then a steady rate.
class Bucket {
  constructor(capacity, perSecond) {
    this.capacity = capacity;
    this.perSecond = perSecond;
    this.tokens = capacity;
    this.at = Date.now();
  }

  take(cost = 1) {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.at) / 1000) * this.perSecond);
    this.at = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

class Session {
  constructor(username) {
    this.username = username;
    // Key of the account that owns the tab: a new account given the name of a removed one is not the same account.
    this.account = null;
    this.page = null;
    this.viewer = null;
    this.detachedAt = Date.now();
    this.queue = Promise.resolve();
    this.pending = 0;
    this.bucket = new Bucket(40, 4);
    this.engineCalls = 0;
    this.savedHash = '';
    this.savedAt = 0;
  }
}

class Hub {
  // o: { browserUrl, matcher, bridgeMatcher, allowHttp, homeUrl, maxSessions, idleMs, persistCookies, cookieStore,
  //      engine, getUser(username, account), accounts(), buildScripts(names), maxPayload, log }
  // accounts(): the keys of every account that exists (the cookies of the others are deleted).
  constructor(o) {
    this.o = o;
    this.log = o.log || { info: quiet, warn: quiet };
    this.cdp = null;
    this.connecting = null;
    this.sessions = new Map();
    this.byContext = new Map();
    this.byTarget = new Map();
    this.popups = new Map();
    this.availability = { at: 0, value: null };
    this.closed = false;
    this.sweptAt = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
    this.sweep();
  }

  get enabled() {
    return !!this.o.browserUrl;
  }

  async status() {
    if (!this.enabled) return { enabled: false, available: false, reason: 'disabled' };
    const now = Date.now();
    if (this.availability.value && now - this.availability.at < AVAILABILITY_TTL_MS) return this.availability.value;
    let value;
    try {
      await this.ensureCdp();
      value = { enabled: true, available: true };
    } catch {
      value = { enabled: true, available: false, reason: 'unreachable' };
    }
    this.availability = { at: Date.now(), value };
    return value;
  }

  async ensureCdp() {
    if (this.closed) throw new HubError('closed', 'Service arrêté');
    if (this.cdp && !this.cdp.closed) return this.cdp;
    if (!this.connecting) {
      this.connecting = (async () => {
        const cdp = await connect(this.o.browserUrl);
        try {
          cdp.on('event', (ev) => this.onBrowserEvent(ev));
          cdp.on('handlerError', (e) => this.log.warn('Navigateur distant : erreur de traitement', e && e.message));
          cdp.on('close', () => this.onCdpClosed(cdp));
          await cdp.send('Target.setDiscoverTargets', { discover: true });
          // New pages are born paused: a window opened by the site is checked before it can send anything (see onAttached).
          await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'page', exclude: false }, { exclude: true }] });
          // This browser belongs to Arr411: anything left by a previous run is discarded.
          const left = await cdp.send('Target.getBrowserContexts');
          for (const id of Array.isArray(left.browserContextIds) ? left.browserContextIds : []) {
            await cdp.send('Target.disposeBrowserContext', { browserContextId: id }).catch(quiet);
          }
        } catch (e) {
          cdp.close();
          throw e;
        }
        this.cdp = cdp;
        this.log.info('Navigateur distant connecté');
        return cdp;
      })().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  sessionFor(username) {
    let s = this.sessions.get(username);
    if (!s) {
      s = new Session(username);
      this.sessions.set(username, s);
    }
    return s;
  }

  // Operations on one user's session never overlap.
  enqueue(s, fn) {
    s.pending++;
    const task = s.queue.then(fn);
    s.queue = task
      .catch(quiet)
      .then(() => {
        s.pending--;
        if (!s.page && !s.pending && this.sessions.get(s.username) === s) this.sessions.delete(s.username);
      });
    return task;
  }

  // The viewer is the socket of the person watching: { username, account, closed, json(obj), frame(buffer, done), close(code, reason) }.
  open(viewer, hello) {
    const s = this.sessionFor(viewer.username);
    return this.enqueue(s, () => this.doOpen(s, viewer, hello)).catch((e) => {
      const known = e instanceof HubError;
      if (!known) this.log.warn(`Vue C411 de ${viewer.username} : ${e && e.message}`);
      this.dismiss(viewer, 'error', known ? e.code : 'unavailable', known ? e.message : 'Le navigateur distant est injoignable.');
    });
  }

  dismiss(viewer, type, code, text) {
    viewer.json({ t: type, code, text });
    viewer.close(4000, text);
  }

  async doOpen(s, viewer, hello) {
    if (viewer.closed || this.closed) return;
    if (!this.enabled) throw new HubError('disabled', 'La vue C411 n’est pas activée sur ce serveur.');
    const account = viewer.account;
    if (typeof account !== 'string' || !account) throw new HubError('signed_out', 'Ta session n’est plus valide.');
    const cdp = await this.ensureCdp();
    // A tab left by an account that has since been removed is never handed to a new account with the same name.
    if (s.page && !s.page.closed && s.account !== account) await this.doClose(s, 'error', 'signed_out', 'Ta session n’est plus valide.', false);
    if (!s.page || s.page.closed) {
      if (!(await this.makeRoom(s))) throw new HubError('busy', 'Trop de navigateurs ouverts sur ce serveur. Réessaie dans quelques minutes.');
      if (viewer.closed) return;
      const cookies = this.o.persistCookies ? await this.o.cookieStore.load(account) : [];
      s.page = await RemotePage.open(
        cdp,
        {
          matcher: this.o.matcher,
          bridgeMatcher: this.o.bridgeMatcher,
          allowHttp: this.o.allowHttp,
          homeUrl: this.o.homeUrl,
          maxPayload: this.o.maxPayload,
          buildScripts: this.o.buildScripts,
          width: hello.w,
          height: hello.h
        },
        cookies
      );
      s.account = account;
      s.savedHash = '';
      this.wire(s);
      s.savedAt = Date.now();
    }
    if (viewer.closed) {
      s.detachedAt = Date.now();
      return;
    }
    if (s.viewer && s.viewer !== viewer) this.evict(s, 'kicked', 'replaced', 'Cette session a été ouverte ailleurs.');
    s.viewer = viewer;
    s.page.touch();
    await s.page.setView(hello.w, hello.h);
    viewer.json({ t: 'view', w: s.page.view.w, h: s.page.view.h });
    viewer.json({ t: 'status', ...s.page.snapshot() });
    await s.page.attachSink((buf, done) => viewer.frame(buf, done));
  }

  // Closes the oldest tabs that nobody is watching when the limit is reached.
  async makeRoom(s) {
    const live = () => [...this.sessions.values()].filter((x) => x.page && !x.page.closed);
    if (live().length < this.o.maxSessions) return true;
    const spares = live()
      .filter((x) => x !== s && !x.viewer)
      .sort((a, b) => a.detachedAt - b.detachedAt);
    for (const spare of spares) {
      const closed = await this.enqueue(spare, async () => {
        if (spare.viewer || !spare.page) return false;
        await this.doClose(spare, 'error', 'evicted', 'Session fermée pour faire de la place.');
        return true;
      }).catch(() => false);
      if (closed) return true;
    }
    return false;
  }

  closeTarget(targetId) {
    if (this.cdp) this.cdp.send('Target.closeTarget', { targetId }).catch(quiet);
  }

  wire(s) {
    const page = s.page;
    this.byContext.set(page.contextId, s);
    this.byTarget.set(page.targetId, s);
    page.on('status', (st) => s.viewer && s.viewer.json({ t: 'status', ...st }));
    page.on('toast', (level, text) => s.viewer && s.viewer.json({ t: 'toast', level, text }));
    page.on('bridge', (payload, reply) => this.onBridge(s, payload, reply));
    page.on('closed', () => {
      if (this.byContext.get(page.contextId) === s) this.byContext.delete(page.contextId);
      if (this.byTarget.get(page.targetId) === s) this.byTarget.delete(page.targetId);
    });
  }

  evict(s, type, code, text) {
    const v = s.viewer;
    if (!v) return;
    s.viewer = null;
    s.detachedAt = Date.now();
    this.dismiss(v, type, code, text);
  }

  // Messages from a viewer; the user is always the one the socket was authenticated as.
  message(viewer, msg) {
    const s = this.sessions.get(viewer.username);
    if (!s || s.viewer !== viewer || !s.page || s.page.closed || !msg || typeof msg !== 'object') return;
    const page = s.page;
    switch (msg.t) {
      case 'mouse':
        page.mouse(msg);
        break;
      case 'key':
        page.key(msg);
        break;
      case 'text':
        page.text(msg);
        break;
      case 'resize':
        page
          .setView(msg.w, msg.h)
          .then((v) => s.viewer === viewer && viewer.json({ t: 'view', w: v.w, h: v.h }))
          .catch(quiet);
        break;
      case 'nav':
        if (NAV_ACTIONS.has(msg.a)) page.nav(msg.a).catch(quiet);
        break;
      case 'goto':
        page.goto(msg.url).catch(quiet);
        break;
      default:
        break;
    }
  }

  // The viewer's socket is gone: the tab stays for a while so that coming back finds it as it was.
  release(viewer) {
    const s = this.sessions.get(viewer.username);
    if (!s || s.viewer !== viewer) return;
    s.viewer = null;
    s.detachedAt = Date.now();
    this.enqueue(s, async () => {
      if (s.viewer || !s.page || s.page.closed) return;
      await s.page.detachSink();
      await this.saveCookies(s);
    }).catch(quiet);
  }

  async saveCookies(s) {
    if (!this.o.persistCookies || !s.account || !s.page || s.page.closed) return;
    s.savedAt = Date.now();
    try {
      const list = this.o.cookieStore.clean(await s.page.cookies());
      const hash = crypto.createHash('sha256').update(JSON.stringify(list)).digest('hex');
      if (hash === s.savedHash) return;
      await this.o.cookieStore.save(s.account, list);
      s.savedHash = hash;
    } catch (e) {
      this.log.warn(`Cookies C411 de ${s.username} non enregistrés : ${e && e.message}`);
    }
  }

  async doClose(s, type, code, text, save = true) {
    const page = s.page;
    this.evict(s, type, code, text);
    if (!page) return;
    if (save) await this.saveCookies(s);
    s.page = null;
    s.account = null;
    await page.close();
  }

  closeSession(s, type, code, text, save = true) {
    return this.enqueue(s, () => this.doClose(s, type, code, text, save)).catch(quiet);
  }

  // The tab of an account that may no longer use the view: closed without saving, its saved cookies deleted.
  revoke(s) {
    return this.enqueue(s, async () => {
      const account = s.account;
      await this.doClose(s, 'error', 'signed_out', 'Ta session n’est plus valide.', false);
      if (account && this.o.cookieStore) await this.o.cookieStore.remove(account);
    }).catch(quiet);
  }

  // Account removed, disabled or given a new password. `account` is the key of the account that still has this name
  // (none once it is removed: its cookies are then found by the sweep).
  async dropUser(username, account) {
    const s = this.sessions.get(String(username));
    if (s) await this.revoke(s);
    if (account && this.o.cookieStore) await this.o.cookieStore.remove(account).catch(quiet);
    await this.sweep();
  }

  // The keys of the accounts that may use the view, or null when the server cannot tell (then nothing is revoked or swept).
  liveAccounts() {
    if (typeof this.o.accounts !== 'function') return null;
    try {
      return new Set(this.o.accounts());
    } catch {
      return null;
    }
  }

  // Deletes the saved cookies of the accounts that no longer exist or are disabled (changed from the command line, which
  // does not tell the running server, or while it was off).
  async sweep() {
    this.sweptAt = Date.now();
    const live = this.liveAccounts();
    if (!live || !this.o.cookieStore) return;
    try {
      await this.o.cookieStore.sweep(live);
    } catch (e) {
      this.log.warn(`Cookies C411 : nettoyage impossible : ${e && e.message}`);
    }
  }

  async onBridge(s, payload, reply) {
    let m;
    try {
      m = JSON.parse(payload);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id || m.id.length > 64) return;
    const msg = m.msg;
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') return;
    const id = m.id;
    const fail = (error) => reply({ id, res: { ok: false, error } });
    const heavy = msg.type === 'upload' || msg.type === 'toggleTorrent';
    if (!s.bucket.take(heavy ? 5 : 1) || s.engineCalls >= MAX_ENGINE_CALLS) return fail('Trop de requêtes, réessaie dans un instant');
    const user = this.o.getUser(s.username, s.account);
    const page = s.page;
    if (!user || !page) return;
    s.engineCalls++;
    let res;
    try {
      res = await this.o.engine.handle(user, msg, { recentInput: Date.now() - page.lastHumanAt < RECENT_INPUT_MS });
    } catch {
      res = { ok: false, error: 'Erreur interne' };
    } finally {
      s.engineCalls--;
    }
    reply({ id, res });
  }

  onBrowserEvent({ method, params }) {
    try {
      const info = params && params.targetInfo;
      if (method === 'Target.attachedToTarget') this.onAttached(params);
      else if (method === 'Target.detachedFromTarget') this.endPopup(this.popups.get(params.sessionId));
      else if (method === 'Target.targetInfoChanged') this.onTargetChanged(info);
      else if (method === 'Target.targetDestroyed') this.onTargetGone(params.targetId, 'La page distante a été fermée.');
      else if (method === 'Target.targetCrashed') this.onTargetGone(params.targetId, 'La page distante a planté.');
    } catch (e) {
      this.log.warn('Navigateur distant : évènement ignoré', e && e.message);
    }
  }

  // Every new page starts paused. Our own tab is let go; a window opened by the site is kept paused until its first
  // request has been seen (and refused): it never gets to send anything, whatever address it was given.
  onAttached(p) {
    const info = p && p.targetInfo;
    if (!info || info.type !== 'page' || typeof p.sessionId !== 'string' || p.waitingForDebugger !== true || !this.cdp) return;
    const s = this.byContext.get(info.browserContextId);
    if (info.openerId) {
      if (s && s.page && !s.page.closed && this.popups.size < MAX_POPUPS) this.watchPopup(p, s);
      else this.closeTarget(info.targetId);
      return;
    }
    // A second page that nobody asked for in a tab's own context never lives; the first one is the tab being created.
    if (s && s.page && s.page.targetId !== info.targetId) this.closeTarget(info.targetId);
    else this.cdp.send('Runtime.runIfWaitingForDebugger', {}, p.sessionId).catch(quiet);
  }

  watchPopup(p, s) {
    const cdp = this.cdp;
    const popup = { sessionId: p.sessionId, targetId: p.targetInfo.targetId, s, timer: null };
    popup.timer = setTimeout(() => this.endPopup(popup), POPUP_WAIT_MS);
    popup.timer.unref();
    this.popups.set(popup.sessionId, popup);
    cdp.route(popup.sessionId, (ev) => this.onPopupEvent(popup, ev));
    cdp
      .send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] }, popup.sessionId)
      .then(() => cdp.send('Runtime.runIfWaitingForDebugger', {}, popup.sessionId))
      .catch(() => this.endPopup(popup));
  }

  onPopupEvent(popup, { method, params }) {
    if (method !== 'Fetch.requestPaused' || this.popups.get(popup.sessionId) !== popup || !this.cdp) return;
    const url = params.request && typeof params.request.url === 'string' ? params.request.url : '';
    this.cdp.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }, popup.sessionId).catch(quiet);
    this.endPopup(popup);
    const page = popup.s.page;
    if (page && !page.closed) page.onPopup(url).catch(quiet);
  }

  endPopup(popup) {
    if (!popup || this.popups.get(popup.sessionId) !== popup) return;
    clearTimeout(popup.timer);
    this.popups.delete(popup.sessionId);
    if (this.cdp) this.cdp.unroute(popup.sessionId);
    this.closeTarget(popup.targetId);
  }

  onTargetChanged(info) {
    if (!info) return;
    const s = this.byTarget.get(info.targetId);
    if (s && s.page) s.page.onTargetInfo(info);
  }

  // Only the loss of the session's current page counts: the destroyed event of a tab that was closed on purpose (and
  // whose place a new tab has taken) arrives late and must not close its successor.
  onTargetGone(targetId, text) {
    const s = this.byTarget.get(targetId);
    const page = s && s.page;
    if (!page || page.targetId !== targetId) return;
    this.enqueue(s, async () => {
      if (s.page === page) await this.doClose(s, 'error', 'page_lost', text, false);
    }).catch(quiet);
  }

  onCdpClosed(cdp) {
    if (this.cdp !== cdp) return;
    this.cdp = null;
    this.availability = { at: 0, value: null };
    for (const t of this.popups.values()) clearTimeout(t.timer);
    this.popups.clear();
    for (const s of [...this.sessions.values()]) {
      this.evict(s, 'error', 'browser_lost', 'Le navigateur distant s’est arrêté.');
      const page = s.page;
      s.page = null;
      if (page) page.close().catch(quiet);
      if (!s.pending) this.sessions.delete(s.username);
    }
    this.byContext.clear();
    this.byTarget.clear();
    if (!this.closed) this.log.warn('Navigateur distant déconnecté');
  }

  tick() {
    const now = Date.now();
    if (now - this.sweptAt > SWEEP_MS) this.sweep();
    const live = this.liveAccounts();
    for (const s of [...this.sessions.values()]) {
      if (s.pending || !s.page || s.page.closed) continue;
      if (live && s.account && !live.has(s.account)) {
        this.revoke(s);
      } else if (s.viewer && now - s.page.activeAt > this.o.idleMs) {
        this.enqueue(s, async () => {
          this.evict(s, 'idle', 'idle', 'Session mise en veille par inactivité.');
          await s.page.detachSink();
          await this.saveCookies(s);
        }).catch(quiet);
      } else if (!s.viewer && now - s.detachedAt > this.o.idleMs) {
        this.closeSession(s, 'idle', 'idle', 'Session fermée par inactivité.');
      } else if (now - s.savedAt > COOKIE_SAVE_MS) {
        this.enqueue(s, () => this.saveCookies(s)).catch(quiet);
      }
    }
  }

  stats() {
    const live = [...this.sessions.values()].filter((s) => s.page && !s.page.closed);
    return { sessions: live.length, viewers: live.filter((s) => s.viewer).length };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    await Promise.allSettled([...this.sessions.values()].map((s) => this.closeSession(s, 'error', 'shutdown', 'Le serveur s’arrête.')));
    for (const t of this.popups.values()) clearTimeout(t.timer);
    this.popups.clear();
    if (this.cdp) this.cdp.close();
  }
}

module.exports = { Hub, HubError, Bucket };
