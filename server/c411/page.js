'use strict';
// One remote browser tab per Arr411 user, inside its own browser context (cookies, storage and cache are never shared).
// The tab is only driven through DevTools commands. What comes back from it is limited to screencast frames and to the
// messages that the extension script posts on a binding that exists in an isolated world only (never visible to the site).
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const input = require('./input');
const { allowedHttpsUrl } = require('./hosts');

const WORLD = 'arr411-extension';
const BLANK = 'about:blank';
const MAX_INFLIGHT_INPUT = 64;
const MAX_FRAME_BASE64 = 12 * 1024 * 1024;
const MAX_REPLY_CHARS = 4 * 1024 * 1024;
const MIN_FRAME_GAP_MS = 40;
const STATUS_POLL_MS = 1000;
const JPEG_QUALITY = 62;

const rid = () => crypto.randomBytes(8).toString('hex');
const quiet = () => {};

class RemotePage extends EventEmitter {
  // o: { matcher, bridgeMatcher, allowHttp, homeUrl, buildScripts({binding, recv, topic}) -> {main, isolated}, maxPayload, width, height }
  constructor(cdp, o) {
    super();
    this.cdp = cdp;
    this.matcher = o.matcher;
    this.bridgeMatcher = o.bridgeMatcher;
    this.allowHttp = o.allowHttp === true;
    this.homeUrl = o.homeUrl;
    this.buildScripts = o.buildScripts;
    this.maxPayload = o.maxPayload;
    this.names = { binding: `b${rid()}`, recv: `r${rid()}`, topic: `t${rid()}` };
    this.view = input.size(o.width || 1280, o.height || 800) || { w: 1280, h: 800 };
    this.contextId = '';
    this.targetId = '';
    this.sessionId = '';
    this.mainFrameId = '';
    this.ctx = 0;
    this.navSeq = 0;
    this.url = '';
    this.title = '';
    this.loading = false;
    this.canGoBack = false;
    this.canGoForward = false;
    this.closed = false;
    this.casting = false;
    this.sink = null;
    this.inflight = 0;
    this.lastHumanAt = 0;
    this.activeAt = Date.now();
    this.lastBlockedAt = 0;
    this.statusTimer = null;
    this.pollTimer = null;
    this.lastStatusKey = '';
    if (!this.allowed(this.homeUrl)) throw new Error('Adresse d’accueil non autorisée');
  }

  static async open(cdp, o, cookies) {
    const page = new RemotePage(cdp, o);
    try {
      await page.init(cookies || []);
    } catch (e) {
      await page.close();
      throw e;
    }
    return page;
  }

  allowed(url) {
    return allowedHttpsUrl(url, this.matcher, { allowHttp: this.allowHttp });
  }

  bridgeAllowed(url) {
    return allowedHttpsUrl(url, this.bridgeMatcher, { allowHttp: this.allowHttp });
  }

  S(method, params, timeoutMs) {
    return this.cdp.send(method, params, this.sessionId, timeoutMs);
  }

  async init(cookies) {
    const { cdp } = this;
    const created = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
    this.contextId = created.browserContextId;
    const target = await cdp.send('Target.createTarget', { url: BLANK, browserContextId: this.contextId });
    this.targetId = target.targetId;
    const attached = await cdp.send('Target.attachToTarget', { targetId: this.targetId, flatten: true });
    this.sessionId = attached.sessionId;
    cdp.route(this.sessionId, (ev) => this.onEvent(ev));

    const scripts = this.buildScripts(this.names);
    await this.S('Page.enable');
    await this.S('Emulation.setFocusEmulationEnabled', { enabled: true });
    await this.applyView();
    await this.S('Page.addScriptToEvaluateOnNewDocument', { source: scripts.main });
    await this.S('Page.addScriptToEvaluateOnNewDocument', { source: scripts.isolated, worldName: WORLD });
    // Every document request (navigations and frames) is checked here, before anything is sent to the network.
    await this.S('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
    await this.S('Page.setInterceptFileChooserDialog', { enabled: true });
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny', browserContextId: this.contextId, eventsEnabled: true });
    if (cookies.length) {
      try {
        await cdp.send('Storage.setCookies', { cookies, browserContextId: this.contextId });
      } catch {
        // an unusable saved cookie must not prevent the browser from opening
      }
    }
    const tree = await this.S('Page.getFrameTree');
    this.mainFrameId = tree.frameTree && tree.frameTree.frame ? tree.frameTree.frame.id : '';
    await this.S('Page.bringToFront').catch(quiet);
    await this.S('Page.navigate', { url: this.homeUrl });
  }

  onEvent({ method, params }) {
    if (this.closed) return;
    switch (method) {
      case 'Fetch.requestPaused':
        this.onPaused(params);
        break;
      case 'Page.frameNavigated':
        this.onNavigated(params.frame).catch(quiet);
        break;
      case 'Page.navigatedWithinDocument':
        if (params.frameId === this.mainFrameId && typeof params.url === 'string') {
          this.url = params.url;
          this.scheduleStatus();
        }
        break;
      case 'Page.frameStartedLoading':
      case 'Page.frameStoppedLoading':
        if (params.frameId === this.mainFrameId) {
          this.loading = method === 'Page.frameStartedLoading';
          this.scheduleStatus();
        }
        break;
      case 'Runtime.bindingCalled':
        this.onBinding(params);
        break;
      case 'Page.screencastFrame':
        this.onFrame(params);
        break;
      case 'Page.javascriptDialogOpening':
        this.onDialog(params);
        break;
      case 'Page.downloadWillBegin':
        this.onDownload(params);
        break;
      default:
        break;
    }
  }

  onPaused(p) {
    const url = p.request && typeof p.request.url === 'string' ? p.request.url : '';
    if (this.allowed(url)) {
      this.S('Fetch.continueRequest', { requestId: p.requestId }).catch(quiet);
      return;
    }
    this.S('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(quiet);
    if (p.frameId === this.mainFrameId) this.blocked(url);
  }

  blocked(url) {
    const now = Date.now();
    if (now - this.lastBlockedAt < 2000) return;
    this.lastBlockedAt = now;
    let host = '';
    try {
      host = new URL(url).hostname.slice(0, 80);
    } catch {
      // not a URL
    }
    this.emit('toast', 'warn', host ? `Adresse bloquée : ${host}` : 'Adresse bloquée');
  }

  // A new document in the main frame: forget the previous bridge, then open one for the new document if it is on a bridge host.
  async onNavigated(frame) {
    if (!frame || frame.parentId) return;
    const seq = ++this.navSeq;
    this.mainFrameId = frame.id;
    this.url = typeof frame.url === 'string' ? frame.url : '';
    this.ctx = 0;
    this.scheduleStatus();
    const url = this.url;
    if (url === BLANK || url.startsWith('chrome-error://')) return;
    if (!this.allowed(url)) {
      // The request guard should have stopped it: never stay on a page that is not allowed.
      this.blocked(url);
      this.S('Page.navigate', { url: this.homeUrl }).catch(quiet);
      return;
    }
    if (!this.bridgeAllowed(url)) return;
    try {
      const world = await this.S('Page.createIsolatedWorld', { frameId: frame.id, worldName: WORLD });
      if (seq !== this.navSeq || this.closed) return;
      this.ctx = world.executionContextId;
      await this.S('Runtime.addBinding', { name: this.names.binding, executionContextId: world.executionContextId });
    } catch {
      if (seq === this.navSeq) this.ctx = 0;
    }
  }

  onBinding(p) {
    if (!this.ctx || p.name !== this.names.binding || p.executionContextId !== this.ctx) return;
    if (typeof p.payload !== 'string' || p.payload.length > this.maxPayload) return;
    const ctx = this.ctx;
    this.emit('bridge', p.payload, (obj) => this.reply(ctx, obj));
  }

  // Answers to the script that sent a message; dropped if that document is gone.
  reply(ctx, obj) {
    if (this.closed || ctx !== this.ctx) return;
    this.evalIn(ctx, obj);
  }

  // Message for the extension script of the current document.
  push(obj) {
    if (this.closed || !this.ctx) return;
    this.evalIn(this.ctx, obj);
  }

  evalIn(ctx, obj) {
    let text = JSON.stringify(obj);
    if (typeof text !== 'string' || text.length > MAX_REPLY_CHARS) text = JSON.stringify({ id: obj && obj.id, res: { ok: false, error: 'Réponse trop volumineuse' } });
    const expression = `window[${JSON.stringify(this.names.recv)}](${JSON.stringify(text)})`;
    this.S('Runtime.evaluate', { expression, contextId: ctx, silent: true, returnByValue: true }).catch(quiet);
  }

  onDialog(p) {
    // The site cannot block the remote tab: notices are acknowledged, questions are answered "no".
    const type = p && p.type;
    this.S('Page.handleJavaScriptDialog', { accept: type === 'alert' || type === 'beforeunload' }).catch(quiet);
    if (type === 'confirm' || type === 'prompt') this.emit('toast', 'warn', 'Une boîte de dialogue du site a été refusée');
  }

  onDownload(p) {
    if (typeof p.url !== 'string' || !this.ctx || !this.bridgeAllowed(p.url)) return;
    this.push({ push: 'download', url: p.url, filename: typeof p.suggestedFilename === 'string' ? p.suggestedFilename.slice(0, 200) : '' });
  }

  onTargetInfo() {
    this.scheduleStatus();
  }

  // A window opened by the site is never kept (the hub has already closed it): an allowed address opens in this tab instead.
  async onPopup(url) {
    if (this.closed) return;
    if (this.allowed(url)) {
      await this.S('Page.navigate', { url }).catch(quiet);
      this.S('Page.bringToFront').catch(quiet);
    } else {
      this.blocked(url);
    }
  }

  // Browsers do not always announce title changes: while somebody is watching, the state is also read every second.
  scheduleStatus() {
    if (this.statusTimer || this.closed) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      this.publishStatus().catch(quiet);
    }, 120);
    this.statusTimer.unref();
  }

  async publishStatus() {
    await this.refreshHistory();
    if (this.closed) return;
    const snap = this.snapshot();
    const key = JSON.stringify(snap);
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.emit('status', snap);
  }

  startPolling() {
    if (this.pollTimer || this.closed) return;
    this.pollTimer = setInterval(() => this.publishStatus().catch(quiet), STATUS_POLL_MS);
    this.pollTimer.unref();
  }

  stopPolling() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async refreshHistory() {
    try {
      const h = await this.S('Page.getNavigationHistory', {}, 5000);
      const prev = h.entries[h.currentIndex - 1];
      const current = h.entries[h.currentIndex];
      this.canGoBack = h.currentIndex > 0 && !!prev && prev.url !== BLANK;
      this.canGoForward = h.currentIndex < h.entries.length - 1;
      this.title = current && typeof current.title === 'string' ? current.title.slice(0, 200) : '';
    } catch {
      // keep the previous values
    }
  }

  snapshot() {
    const shown = this.url === BLANK || this.url.startsWith('chrome-error://') ? '' : this.url.slice(0, 500);
    return { url: shown, title: this.title, loading: this.loading, canGoBack: this.canGoBack, canGoForward: this.canGoForward };
  }

  async applyView() {
    const { w, h } = this.view;
    await this.S('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false, screenWidth: w, screenHeight: h });
  }

  async setView(width, height) {
    const v = input.size(width, height);
    if (!v || this.closed) return this.view;
    if (v.w === this.view.w && v.h === this.view.h) return this.view;
    this.view = v;
    await this.applyView();
    if (this.casting) {
      await this.S('Page.stopScreencast');
      await this.startScreencast();
    }
    return this.view;
  }

  // Right after a navigation starts the browser may not have a page to capture yet ("Not attached to an active page").
  async startScreencast() {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.S('Page.startScreencast', { format: 'jpeg', quality: JPEG_QUALITY, maxWidth: this.view.w, maxHeight: this.view.h, everyNthFrame: 1 });
      } catch (e) {
        if (attempt >= 30 || this.closed || !/not attached/i.test(e.message)) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }

  // sink(buffer, done): sends one JPEG frame to the viewer and calls done() when it has been flushed (back-pressure).
  async attachSink(sink) {
    this.sink = sink;
    this.startPolling();
    if (!this.casting) {
      this.casting = true;
      await this.startScreencast();
    }
    await this.snapshotFrame(sink);
  }

  async detachSink() {
    this.sink = null;
    this.stopPolling();
    if (!this.casting || this.closed) return;
    this.casting = false;
    await this.S('Page.stopScreencast').catch(quiet);
  }

  async snapshotFrame(sink) {
    try {
      const shot = await this.S('Page.captureScreenshot', { format: 'jpeg', quality: JPEG_QUALITY });
      if (this.sink === sink && typeof shot.data === 'string' && shot.data.length <= MAX_FRAME_BASE64) sink(Buffer.from(shot.data, 'base64'), quiet);
    } catch {
      // the next screencast frame will do
    }
  }

  onFrame(p) {
    const ack = () => {
      if (!this.closed) this.S('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(quiet);
    };
    const sink = this.sink;
    if (!sink || typeof p.data !== 'string' || p.data.length > MAX_FRAME_BASE64) {
      ack();
      return;
    }
    const sentAt = Date.now();
    sink(Buffer.from(p.data, 'base64'), () => {
      const wait = MIN_FRAME_GAP_MS - (Date.now() - sentAt);
      if (wait > 0) setTimeout(ack, wait).unref();
      else ack();
    });
  }

  // Somebody is looking at the tab: keeps it awake, but is not input.
  touch() {
    this.activeAt = Date.now();
  }

  // Deliberate input (click, key, text): the only kind that lets the extension send something to the download client.
  human() {
    this.lastHumanAt = Date.now();
    this.activeAt = this.lastHumanAt;
  }

  dispatch(method, params, droppable) {
    if (this.closed || (droppable && this.inflight >= MAX_INFLIGHT_INPUT)) return;
    this.inflight++;
    this.S(method, params, 5000)
      .catch(quiet)
      .finally(() => {
        this.inflight--;
      });
  }

  mouse(msg) {
    const p = input.mouse(msg, this.view);
    if (!p) return false;
    const passive = p.type === 'mouseMoved' || p.type === 'mouseWheel';
    if (passive) this.activeAt = Date.now();
    else this.human();
    this.dispatch('Input.dispatchMouseEvent', p, passive);
    return true;
  }

  key(msg) {
    const p = input.key(msg);
    if (!p) return false;
    this.human();
    this.dispatch('Input.dispatchKeyEvent', p, false);
    return true;
  }

  text(msg) {
    const p = input.text(msg);
    if (!p) return false;
    this.human();
    this.dispatch('Input.insertText', p, false);
    return true;
  }

  // Address chosen in Arr411 itself (a search from another tab): only the C411 site, same rules as any navigation.
  async goto(url) {
    if (this.closed || typeof url !== 'string' || url.length > 2000 || !this.bridgeAllowed(url)) return false;
    this.touch();
    await this.S('Page.navigate', { url });
    return true;
  }

  async nav(action) {
    if (this.closed || !input.NAV_ACTIONS.has(action)) return;
    this.human();
    if (action === 'home') {
      await this.S('Page.navigate', { url: this.homeUrl });
    } else if (action === 'reload') {
      await this.S('Page.reload', {});
    } else {
      const h = await this.S('Page.getNavigationHistory');
      const entry = h.entries[h.currentIndex + (action === 'back' ? -1 : 1)];
      if (entry && entry.url !== BLANK) await this.S('Page.navigateToHistoryEntry', { entryId: entry.id });
    }
  }

  async cookies() {
    const r = await this.cdp.send('Storage.getCookies', { browserContextId: this.contextId });
    return Array.isArray(r.cookies) ? r.cookies : [];
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.statusTimer);
    this.stopPolling();
    this.sink = null;
    if (this.sessionId) this.cdp.unroute(this.sessionId);
    if (this.contextId) await this.cdp.send('Target.disposeBrowserContext', { browserContextId: this.contextId }, undefined, 8000).catch(quiet);
    this.emit('closed');
  }
}

module.exports = { RemotePage, WORLD };
