// Content script of the C411 view, ported from the "C411 → qBittorrent" extension (content.js 1.7.1).
// It runs in an isolated world, from the start of the document, on the C411 site only. What the page provides
// (DOM, events, values) is untrusted: it is bounded and checked before use, and never becomes markup.
// The only way out is the server binding, and nothing is written (upload) without a trusted click.
(() => {
  'use strict';
  const CFG = __ARR411_CONFIG__;

  // @pure-begin
  // Nothing in this part touches the page (apart from `location` and `URL` in checkDownloadUrl): the tests run it alone.

  const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
  const CONTROL_ALL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
  const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const BRIDGE_POLL_MS = 25;
  const BRIDGE_WAIT_MS = 15000;
  const REQUEST_TIMEOUT_MS = 60000;
  const MAX_INFLIGHT = 3;
  const MAX_REPLY_CHARS = 8 * 1024 * 1024;
  const MAX_BRIDGE_CHARS = 20 * 1024 * 1024;
  const BRIDGE_ENVELOPE = 16384;
  const MAX_URL = 4096;
  const KNOWN_TYPES = ['hello', 'getCategories', 'pageStatus', 'listTorrents', 'qbitIndex', 'toggleTorrent', 'arrMeta', 'upload'];

  const isPlain = (v) => Object.prototype.toString.call(v) === '[object Object]';
  const fail = (error) => ({ ok: false, error });
  const cut = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const strList = (v, maxItems, maxLen) => (Array.isArray(v) ? v.slice(0, maxItems).filter((s) => typeof s === 'string' && s.length <= maxLen) : []);
  // Whatever the configured size, a request (base64 included) stays far below the limit of the DevTools connection.
  const torrentLimit = (configured) => Math.min(configured, Math.floor((MAX_BRIDGE_CHARS - BRIDGE_ENVELOPE) / 4) * 3);

  // A message meant for the user, as opposed to an unexpected failure.
  class Notice extends Error {}

  // ----- where the script may run: same rules as server/c411/hosts.js -----

  // Lower-case DNS name without trailing dot, or '' (IP literals included, even in disguise: 2130706433, 0x7f.1, 127.1).
  function normalizeHost(input) {
    const h = String(input == null ? '' : input).trim().toLowerCase().replace(/\.$/, '');
    if (!h || h.length > 253 || h.startsWith('[')) return '';
    const labels = h.split('.');
    if (/^(?:[0-9]+|0x[0-9a-f]*)$/.test(labels[labels.length - 1])) return '';
    return labels.every((l) => LABEL.test(l)) ? h : '';
  }

  function hostAllowed(host, patterns) {
    const h = normalizeHost(host);
    if (!h || !Array.isArray(patterns)) return false;
    return patterns.some((p) => p === '*' || p === h || (typeof p === 'string' && p.startsWith('*.') && h.endsWith(p.slice(1)) && h.length > p.length - 1));
  }

  // ----- the link with the server -----

  function cleanReply(res) {
    if (!isPlain(res) || typeof res.ok !== 'boolean') return fail('Réponse invalide');
    return res.ok ? res : fail(cut(res.error, 500) || 'Erreur');
  }

  // Requests go through the CDP binding, which the server adds a few milliseconds after the document starts:
  // until it shows up they wait in line (and fail after BRIDGE_WAIT_MS). Answers never reject: { ok: false, error }.
  // io: { token, version, maxChars, now(), setTimeout(fn, ms), clearTimeout(handle), find(), onPush(url, filename) }
  function createLink(io) {
    const pending = new Map();
    const outbox = [];
    const probeUntil = io.now() + BRIDGE_WAIT_MS;
    let bridge = null;
    let helloSent = false;
    let probeTimer = null;
    let inflight = 0;
    let seq = 0;

    function settle(entry, res) {
      if (pending.get(entry.id) !== entry) return;
      pending.delete(entry.id);
      io.clearTimeout(entry.timer);
      const queued = outbox.indexOf(entry);
      if (queued >= 0) outbox.splice(queued, 1);
      if (entry.sent) inflight--;
      entry.resolve(res);
      pump();
    }

    function post(entry) {
      entry.sent = true;
      inflight++;
      try {
        bridge(entry.body);
      } catch (e) {
        settle(entry, fail('Pont indisponible'));
      }
    }

    // The first time the binding is seen, it is kept (the page world never gets to see it) and the server is greeted.
    function ensure() {
      if (bridge) return true;
      let fn = null;
      try {
        fn = io.find();
      } catch (e) {
        fn = null;
      }
      if (typeof fn !== 'function') return false;
      bridge = fn;
      if (!helloSent) {
        helloSent = true;
        send({ type: 'hello', version: io.version }, true);
      }
      return true;
    }

    function pump() {
      if (!ensure()) {
        if (outbox.length) startProbe();
        return;
      }
      while (outbox.length && inflight < MAX_INFLIGHT) post(outbox.shift());
    }

    function startProbe() {
      if (probeTimer === null) probeTimer = io.setTimeout(probe, BRIDGE_POLL_MS);
    }

    function probe() {
      probeTimer = null;
      if (ensure()) {
        pump();
        return;
      }
      const now = io.now();
      for (const entry of outbox.slice()) if (now - entry.queuedAt >= BRIDGE_WAIT_MS) settle(entry, fail('Pont indisponible'));
      if (outbox.length || now < probeUntil) startProbe();
    }

    function send(msg, first) {
      return new Promise((resolve) => {
        const type = isPlain(msg) ? msg.type : '';
        if (!KNOWN_TYPES.includes(type)) {
          resolve(fail('Message inconnu'));
          return;
        }
        const id = `${io.token}_${++seq}`;
        let body = '';
        try {
          body = JSON.stringify({ id, msg });
        } catch (e) {
          body = '';
        }
        if (!body) {
          resolve(fail('Requête invalide'));
          return;
        }
        if (body.length > io.maxChars) {
          resolve(fail('Le fichier .torrent est trop volumineux.'));
          return;
        }
        const entry = { id, body, resolve, sent: false, queuedAt: io.now(), timer: null };
        entry.timer = io.setTimeout(() => settle(entry, fail('Délai dépassé. Réessaie.')), REQUEST_TIMEOUT_MS);
        pending.set(id, entry);
        if (first) outbox.unshift(entry);
        else outbox.push(entry);
        pump();
      });
    }

    // What the server evaluates in this world: { id, res } for an answer, { push: 'download', url, filename } for a download
    // seen by the browser. Anything malformed is ignored.
    function receive(raw) {
      if (typeof raw !== 'string' || raw.length > MAX_REPLY_CHARS) return;
      let m;
      try {
        m = JSON.parse(raw);
      } catch (e) {
        return;
      }
      if (!isPlain(m)) return;
      if (typeof m.id === 'string') {
        const entry = pending.get(m.id);
        if (entry) settle(entry, cleanReply(m.res));
      } else if (m.push === 'download' && typeof m.url === 'string' && m.url.length <= MAX_URL) {
        try {
          io.onPush(m.url, typeof m.filename === 'string' ? m.filename : '');
        } catch (e) {
          // a download that cannot be handled is dropped
        }
      }
    }

    return {
      send,
      receive,
      start() {
        if (!ensure()) startProbe();
      }
    };
  }

  // ----- what goes to the server -----

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const MEDIA_TYPES = ['movie', 'series', 'music'];
  const SERIES_TYPES = ['standard', 'anime', 'daily'];
  const LIDARR_MODES = ['album', 'artist'];

  // Kept as is or dropped, never repaired: the server compares these values exactly.
  function strict(v, max) {
    if (typeof v !== 'string' || v.length > max || CONTROL.test(v)) return '';
    return typeof v.isWellFormed !== 'function' || v.isWellFormed() ? v : '';
  }

  // Free text: control characters become blanks, blanks are collapsed.
  const clip = (v, max) => (typeof v === 'string' ? v.replace(CONTROL_ALL, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

  const cleanCategory = (v) => strict(v, 100);

  function intId(v) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : NaN;
    return Number.isSafeInteger(n) && n >= 1 && n <= 2147483647 ? String(n) : '';
  }

  const uuid = (v) => (typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : '');
  const digits = (v) => (typeof v === 'string' && /^\d{1,12}$/.test(v) ? v : '');

  // Same shapes as the server accepts: a value that does not fit is dropped here instead of failing the whole request.
  const ID_RULES = {
    imdb: (v) => (typeof v === 'string' && /^tt\d{5,10}$/.test(v) ? v : ''),
    tmdb: intId,
    tvdb: intId,
    tmdbKind: (v) => (v === 'movie' || v === 'tv' ? v : ''),
    mbReleaseGroup: uuid,
    mbRelease: uuid,
    mbArtist: uuid,
    deezer: digits,
    discogs: digits
  };

  function cleanIds(raw) {
    const ids = {};
    if (!isPlain(raw)) return ids;
    for (const key of Object.keys(ID_RULES)) {
      const v = Object.hasOwn(raw, key) ? ID_RULES[key](raw[key]) : '';
      if (v) ids[key] = v;
    }
    return ids;
  }

  // What the page showed (titles, IDs) is bounded and reduced to the known fields before it is sent. Empty fields are left out.
  function cleanMedia(raw) {
    if (!isPlain(raw) || !MEDIA_TYPES.includes(raw.type)) return null;
    const out = { type: raw.type, ids: cleanIds(raw.ids), seasons: [] };
    if (Array.isArray(raw.seasons)) {
      for (const n of raw.seasons.slice(0, 200)) if (Number.isInteger(n) && n >= 0 && n <= 999) out.seasons.push(n);
    }
    const optional = {
      artist: clip(raw.artist, 200),
      album: clip(raw.album, 200),
      year: (typeof raw.year === 'string' || typeof raw.year === 'number') && /^(?:19|20)\d{2}$/.test(String(raw.year)) ? String(raw.year) : '',
      rootFolder: strict(raw.rootFolder, 500),
      seriesType: SERIES_TYPES.includes(raw.seriesType) ? raw.seriesType : '',
      lmode: LIDARR_MODES.includes(raw.lmode) ? raw.lmode : ''
    };
    for (const key of Object.keys(optional)) if (optional[key]) out[key] = optional[key];
    return out;
  }

  // ----- what comes from the server -----

  // Fixed keys and bounded values: what the dialog shows and offers never depends on anything else.
  function cleanCategories(res) {
    const section = (v) => (isPlain(v) ? v : {});
    const byType = section(res.byType);
    const defaultRoot = section(res.defaultRoot);
    const arrEnabled = section(res.arrEnabled);
    const out = {
      categories: strList(res.categories, 1000, 100).filter((c) => c && cleanCategory(c) === c),
      selected: cut(res.selected, 100),
      byType: {},
      defaultRoot: {},
      arrEnabled: {}
    };
    for (const kind of MEDIA_TYPES) {
      out.byType[kind] = cut(byType[kind], 100);
      out.defaultRoot[kind] = cut(defaultRoot[kind], 500);
      out.arrEnabled[kind] = arrEnabled[kind] === true;
    }
    return out;
  }

  const SERVICES = ['Radarr', 'Sonarr', 'Lidarr'];

  function cleanStatus(res) {
    const out = { qbit: null, library: null };
    const q = res.qbit;
    if (isPlain(q)) out.qbit = { name: cut(q.name, 500), state: cut(q.state, 40), progress: num(q.progress), category: cut(q.category, 100) };
    const l = res.library;
    if (isPlain(l) && SERVICES.includes(l.service)) {
      out.library = {
        service: l.service,
        inLibrary: l.inLibrary === true,
        artistOnly: l.artistOnly === true,
        hasFile: l.hasFile === true,
        title: cut(l.title, 200),
        files: num(l.files),
        total: num(l.total),
        seasons: []
      };
      if (Array.isArray(l.seasons)) {
        for (const s of l.seasons.slice(0, 200)) {
          if (isPlain(s)) out.library.seasons.push({ number: num(s.number), exists: s.exists === true, files: num(s.files), total: num(s.total) });
        }
      }
    }
    return out;
  }

  function cleanTorrents(res) {
    const list = [];
    if (!res.ok || !Array.isArray(res.torrents)) return list;
    for (const t of res.torrents.slice(0, 20000)) {
      if (isPlain(t)) list.push({ hash: cut(t.hash, 64).toLowerCase(), name: cut(t.name, 500), progress: num(t.progress), state: cut(t.state, 40) });
    }
    return list;
  }

  const QB_STATES = {
    downloading: 'téléchargement', stalledDL: 'en attente', metaDL: 'métadonnées', forcedDL: 'téléchargement',
    queuedDL: 'en file', pausedDL: 'en pause', stoppedDL: 'en pause', checkingDL: 'vérification',
    uploading: 'seed', stalledUP: 'seed', forcedUP: 'seed', queuedUP: 'seed (file)', pausedUP: 'terminé',
    stoppedUP: 'terminé', checkingUP: 'vérification', error: 'erreur', missingFiles: 'fichiers manquants'
  };

  function qbitText(q) {
    const pct = Math.floor((q.progress || 0) * 100);
    const state = Object.hasOwn(QB_STATES, q.state) ? QB_STATES[q.state] : q.state;
    return `qBittorrent : ${pct >= 100 ? 'complet' : pct + ' %'} · ${state}`;
  }

  // ----- reading the page (heuristics validated on the real site) -----

  const normName = (s) => (s || '').toLowerCase().replace(/\.torrent$/, '').replace(/[^a-z0-9]+/g, '');

  // "S01", "S02E05", "S01-S03" → [1], [2], [1, 2, 3]. Complete packs without Sxx → [].
  function detectSeasons(title) {
    const found = new Set();
    for (const m of title.matchAll(/S(\d{1,2})\s*-\s*S(\d{1,2})(?![0-9])/gi)) {
      const [a, b] = [Number(m[1]), Number(m[2])].sort((x, y) => x - y);
      if (b - a <= 50) for (let n = a; n <= b; n++) found.add(n);
    }
    for (const m of title.matchAll(/(?:^|[^A-Za-z0-9])S(\d{1,2})(?=E\d|[^A-Za-z0-9]|$)/g)) found.add(Number(m[1]));
    return [...found].sort((a, b) => a - b);
  }

  // Without a music card: "Artiste - Album (2001) [FLAC]" or scene style "Artiste-Album-WEB-2001-GROUPE".
  function guessMusic(title) {
    const t = title.replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ');
    let parts = t.split(/\s+[-–—]\s+/);
    if (parts.length < 2) parts = t.replace(/[._]/g, ' ').split('-');
    const clean = (s) => (s || '').replace(/\(([^)]*)\)/g, (m, x) => (/^(19|20)\d{2}$/.test(x.trim()) ? ' ' : m))
      .replace(/\s(19|20)\d{2}\b.*$/, '').replace(/\s+/g, ' ').trim();
    const year = t.match(/\b(19|20)\d{2}\b/);
    return { artist: clean(parts[0]), album: clean(parts[1]), year: year ? year[0] : '' };
  }

  // ----- the .torrent file -----

  // The file must come from the site on display (or be a blob made by it): nothing else is fetched.
  function checkDownloadUrl(raw) {
    let u = null;
    try {
      u = new URL(raw, location.href);
    } catch (e) {
      u = null;
    }
    const scheme = u ? u.protocol : '';
    const known = scheme === 'https:' || scheme === 'blob:' || (CFG.allowHttp === true && scheme === 'http:');
    if (!u || !known || u.username || u.password || u.origin !== location.origin) throw new Notice('Téléchargement refusé : adresse non autorisée');
    return u.href;
  }

  const INFO_KEY = [0x34, 0x3a, 0x69, 0x6e, 0x66, 0x6f]; // "4:info"

  // Minimal bencode check: a dictionary that has an "info" key. The server parses the file for real.
  function looksLikeTorrent(bytes) {
    if (!bytes.length || bytes[0] !== 0x64) return false;
    const last = bytes.length - INFO_KEY.length;
    for (let i = 1; i <= last; i++) {
      if (bytes[i] !== INFO_KEY[0]) continue;
      let k = 1;
      while (k < INFO_KEY.length && bytes[i + k] === INFO_KEY[k]) k++;
      if (k === INFO_KEY.length) return true;
    }
    return false;
  }

  function toBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x2000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x2000));
    return btoa(bin);
  }

  // The reverse, for a file that the page-world script read for us: strict padded base64, and never more than `limit` bytes.
  function fromBase64(text, limit) {
    const tooBig = () => new Notice('Le fichier .torrent est trop volumineux.');
    if (typeof text !== 'string') throw new Notice('Téléchargement du .torrent impossible');
    if (text.length > Math.ceil(limit / 3) * 4) throw tooBig();
    if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Notice('Téléchargement du .torrent impossible');
    let bin = '';
    try {
      bin = atob(text);
    } catch (e) {
      throw new Notice('Téléchargement du .torrent impossible');
    }
    if (bin.length > limit) throw tooBig();
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // A file that came with the hand-off event is only believed when it belongs to a blob of the site, and is checked like a fetched one.
  function decodeTorrent(href, data, limit) {
    if (!href.startsWith('blob:')) throw new Notice('Téléchargement refusé : adresse non autorisée');
    const bytes = fromBase64(data, limit);
    if (!looksLikeTorrent(bytes)) throw new Notice('Le fichier récupéré n’est pas un .torrent valide');
    return { bytes, name: '' };
  }

  // Reads a response body and gives up as soon as it goes over `limit` bytes.
  async function readLimited(res, limit) {
    const tooBig = () => new Notice('Le fichier .torrent est trop volumineux.');
    if (Number(res.headers.get('content-length')) > limit) throw tooBig();
    if (!res.body || typeof res.body.getReader !== 'function') {
      const all = new Uint8Array(await res.arrayBuffer());
      if (all.length > limit) throw tooBig();
      return all;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || typeof value.length !== 'number') throw new Notice('Téléchargement du .torrent impossible');
      total += value.length;
      if (total > limit) {
        reader.cancel().catch(() => {});
        throw tooBig();
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    return bytes;
  }

  function dispositionName(header) {
    if (typeof header !== 'string') return '';
    const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
    if (star) {
      try {
        return decodeURIComponent(star[1].trim());
      } catch (e) {
        // the plain parameter is tried next
      }
    }
    const plain = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header) || /filename\s*=\s*([^;]+)/i.exec(header);
    return plain ? plain[1].trim() : '';
  }

  function urlName(href) {
    try {
      const u = new URL(href);
      return u.protocol === 'blob:' ? '' : decodeURIComponent(u.pathname.split('/').pop());
    } catch (e) {
      return '';
    }
  }

  // Last path component only, without control characters or quotes, 200 characters at most.
  function safeName(...candidates) {
    for (const c of candidates) {
      if (typeof c !== 'string') continue;
      const name = c.split(/[\\/]/).pop().replace(CONTROL_ALL, '').replace(/"/g, '').trim().slice(0, 200);
      if (name && name !== '.' && name !== '..') return name;
    }
    return 'file.torrent';
  }
  // @pure-end

  function allowedHere() {
    try {
      if (window !== window.top) return false;
      const loc = window.location;
      const secure = loc.protocol === 'https:' || (CFG.allowHttp === true && loc.protocol === 'http:');
      return secure && hostAllowed(loc.hostname, CFG.hosts);
    } catch (e) {
      return false;
    }
  }

  if (!allowedHere()) return;
  if (Object.prototype.hasOwnProperty.call(window, CFG.recv)) return;

  const MARK = 'data-qbt-injected';
  const PILL = 'data-qbt-pill';
  const MAX_TORRENT = torrentLimit(CFG.maxTorrentBytes);
  // The hand-off event carries the file in base64, with a few lines of envelope around it.
  const MAX_EVENT_CHARS = Math.ceil(MAX_TORRENT / 3) * 4 + 8192;

  const detach = (p) => {
    Promise.resolve(p).catch(() => {});
  };

  // The server answers by calling window[recv] in this world: it exists from the very start, before anything waits.
  let armed = null; // { category, paused, media, until }
  let armTimer = 0;

  const link = createLink({
    token: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    version: CFG.version,
    maxChars: Math.ceil(MAX_TORRENT / 3) * 4 + BRIDGE_ENVELOPE,
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    find() {
      const fn = window[CFG.binding];
      if (typeof fn !== 'function') return null;
      try {
        delete window[CFG.binding];
      } catch (e) {
        // the captured function keeps working
      }
      return fn;
    },
    onPush: (url, filename) => onDownload(url, filename)
  });
  const sendMessage = link.send;

  Object.defineProperty(window, CFG.recv, { value: link.receive, writable: true, configurable: true, enumerable: false });
  link.start();

  const norm = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

  // ----- the interface: createElement and text nodes only, nothing read from the page or the server is parsed as markup -----

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const name of Object.keys(attrs)) {
        const v = attrs[name];
        if (v !== false && v != null) el.setAttribute(name, v === true ? '' : String(v));
      }
    }
    for (const kid of kids) if (kid != null && kid !== false) el.append(kid);
    return el;
  }

  const sheets = new Map();

  // Constructable stylesheets first: unlike a <style> element, they are not blocked by the CSP of the page.
  function adopt(root, css) {
    let sheet = sheets.get(css);
    if (sheet === undefined) {
      try {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
      } catch (e) {
        sheet = null;
      }
      sheets.set(css, sheet);
    }
    if (sheet) root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    else root.append(h('style', null, css));
  }

  // An element of the page that holds a closed shadow root: the page cannot get to what is inside.
  function shadowHost(tag, attrs, styles) {
    const host = h(tag, attrs);
    Object.assign(host.style, styles);
    return { host, root: host.attachShadow({ mode: 'closed' }) };
  }

  const TOAST_CSS = `
    .t { padding: 12px 16px; border-radius: 8px; font: 14px system-ui, sans-serif; color: #fff; background: #27ae60;
         box-shadow: 0 4px 16px rgba(0,0,0,.3); max-width: 400px; overflow-wrap: anywhere; }
    .t.err { background: #c0392b; }`;

  let toasts = null; // { host, root, count }

  function toast(text, isError = false) {
    if (!toasts) {
      const { host, root } = shadowHost('div', { [MARK]: 'toasts' }, {
        all: 'initial', position: 'fixed', bottom: '20px', right: '20px', zIndex: '2147483647',
        display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-end'
      });
      adopt(root, TOAST_CSS);
      toasts = { host, root, count: 0 };
    }
    if (!toasts.host.isConnected) (document.body || document.documentElement).append(toasts.host);
    const el = h('div', { class: isError ? 't err' : 't' }, cut(String(text), 500));
    toasts.root.append(el);
    toasts.count++;
    setTimeout(() => {
      el.remove();
      if (--toasts.count <= 0) toasts.host.remove();
    }, isError ? 8000 : 5000);
  }

  // ----- the download: armed here, taken over by the page-world script (or seen by the browser), then sent -----

  // The page-world script is told through a DOM event; the server never hears of arming.
  function tellMain(ms) {
    try {
      document.dispatchEvent(new CustomEvent(`${CFG.topic}:arm`, { detail: String(ms) }));
    } catch (e) {
      // the page-world script stays disarmed
    }
  }

  function disarm() {
    clearTimeout(armTimer);
    armTimer = 0;
    if (!armed) return;
    armed = null;
    tellMain(0);
  }

  function arm(choice) {
    disarm();
    armed = { category: choice.category, paused: choice.paused, media: choice.media, until: Date.now() + CFG.armMs };
    tellMain(CFG.armMs);
    armTimer = setTimeout(() => {
      armTimer = 0;
      if (!armed) return;
      armed = null;
      tellMain(0);
      toast('Aucun téléchargement détecté. Réessaie.', true);
    }, CFG.armMs);
  }

  // From the page-world script or from the server: acted upon only while armed, and only once.
  // `data` is the file itself, in base64, when the page-world script could read it (a blob of the site); null otherwise.
  function onDownload(url, hint, data = null) {
    const job = armed;
    if (!job || Date.now() >= job.until) return;
    disarm();
    detach(saveTorrent(url, hint, job, data));
  }

  // The page can forge this event: its content is checked like any other input.
  document.addEventListener(`${CFG.topic}:dl`, (e) => {
    if (!armed) return;
    let d = null;
    try {
      d = typeof e.detail === 'string' && e.detail.length <= MAX_EVENT_CHARS ? JSON.parse(e.detail) : null;
    } catch (err) {
      d = null;
    }
    if (isPlain(d) && typeof d.url === 'string' && d.url.length <= MAX_URL) {
      onDownload(d.url, typeof d.filename === 'string' ? d.filename : '', typeof d.data === 'string' ? d.data : null);
    }
  });

  async function fetchTorrent(href) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(href, { credentials: 'include', signal: abort.signal });
      if (!res.ok) throw new Notice(`Téléchargement du .torrent impossible (${res.status})`);
      if (res.url && new URL(res.url).origin !== location.origin) throw new Notice('Téléchargement refusé : adresse non autorisée');
      const bytes = await readLimited(res, MAX_TORRENT);
      if (!looksLikeTorrent(bytes)) throw new Notice('Le fichier récupéré n’est pas un .torrent valide');
      return { bytes, name: dispositionName(res.headers.get('content-disposition')) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function saveTorrent(rawUrl, hint, job, data) {
    try {
      const href = checkDownloadUrl(rawUrl);
      const file = typeof data === 'string' ? decodeTorrent(href, data, MAX_TORRENT) : await fetchTorrent(href);
      const filename = safeName(hint, file.name, urlName(href));
      const up = await sendMessage({ type: 'upload', base64: toBase64(file.bytes), filename, category: job.category, paused: job.paused, media: job.media });
      if (!up.ok) throw new Notice(up.error);
      toast(`Envoyé à qBittorrent${job.category ? ` (catégorie : ${job.category})` : ''} ✔`);
      const added = cut(up.arrResult, 500);
      const failed = cut(up.arrError, 500);
      if (added) toast(`✔ ${added}`);
      if (failed) toast(failed, true);
      setTimeout(() => {
        detach(refreshStatus(true));
        dropIndex();
        detach(refreshListBadges());
      }, 1500);
    } catch (e) {
      toast(e instanceof Notice ? e.message : e && e.name === 'AbortError' ? 'Délai dépassé. Réessaie.' : 'Téléchargement du .torrent impossible', true);
    }
  }

  // ----- reading the page: selectors and heuristics validated on the real site -----

  const MUSIC_SOURCES = ['Deezer', 'MusicBrainz', 'Discogs', 'NFO (partiel)'];

  // C411 music card: purple border, album title in the h3, artist in p[title], MusicBrainz/Deezer/Discogs links.
  function detectMusic() {
    const card = [...document.querySelectorAll('div.border-l-purple-500')].find((d) => d.querySelector('h3') &&
      [...d.querySelectorAll('span')].some((s) => MUSIC_SOURCES.includes(norm(s))));
    if (!card) return null;
    const h3 = card.querySelector('h3');
    let album = [...h3.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent)
      .join(' ').replace(/\s+/g, ' ').trim();
    if (album === 'Album inconnu') album = '';
    const year = ((h3.querySelector('span') || {}).textContent || '').match(/\b(19|20)\d{2}\b/);
    const artistEl = [...card.querySelectorAll('p[title]')].find((p) => !/^Crédits/.test(norm(p)));
    const ids = {};
    const MB = { 'release-group': 'mbReleaseGroup', release: 'mbRelease', artist: 'mbArtist' };
    for (const a of card.querySelectorAll('a[href]')) {
      const href = a.href;
      let m;
      if ((m = href.match(/musicbrainz\.org\/(release-group|release|artist)\/([0-9a-f-]{36})/i))) ids[MB[m[1].toLowerCase()]] = m[2].toLowerCase();
      else if ((m = href.match(/deezer\.com\/(?:[a-z]{2}\/)?album\/(\d+)/i))) ids.deezer = m[1];
      else if ((m = href.match(/discogs\.com\/(?:[^?#]*\/)?release\/(\d+)/i))) ids.discogs = m[1];
    }
    return {
      type: 'music', ids, fromCard: true, seasons: [], album, year: year ? year[0] : '',
      artist: artistEl ? artistEl.getAttribute('title').trim() : ''
    };
  }

  function detectMedia() {
    const label = [...document.querySelectorAll('span')].find((s) => norm(s) === 'Fiches :');
    if (!label) {
      const music = detectMusic();
      if (music) return music;
    }
    let links = label ? [...label.parentElement.querySelectorAll('a[href]')] : [];
    if (!links.length) links = [...document.querySelectorAll('a[href]')];

    const ids = {};
    for (const a of links) {
      const href = a.href;
      let m;
      if (!ids.imdb && (m = href.match(/imdb\.com\/title\/(tt\d+)/))) ids.imdb = m[1];
      else if (!ids.tmdb && (m = href.match(/themoviedb\.org\/(movie|tv)\/(\d+)/))) { ids.tmdbKind = m[1]; ids.tmdb = m[2]; }
      else if (!ids.tvdb && (m = href.match(/thetvdb\.com\/.*\bseries\/(\d+)/))) ids.tvdb = m[1];
    }
    const type = ids.tmdbKind === 'tv' || ids.tvdb ? 'series' : ids.tmdbKind === 'movie' ? 'movie' : '';
    return { type, ids, fromFiches: !!label, seasons: type === 'series' ? detectSeasons(pageTitle()) : [] };
  }

  function pageTitle() {
    const h1 = document.querySelector('h1');
    return h1 ? norm(h1) : document.title;
  }

  const pageHashFromUrl = () => {
    const m = location.pathname.match(/\/torrents\/([a-f0-9]{40})\b/i);
    return m ? m[1].toLowerCase() : '';
  };

  function detectHash() {
    const fromUrl = pageHashFromUrl();
    if (fromUrl) return fromUrl;
    const label = [...document.querySelectorAll('span, div, dt, p')].find((el) => /^Hash\s*:?$/i.test(norm(el)));
    const scope = label ? label.parentElement : document.body;
    const m = ((scope && scope.textContent) || '').match(/\b([a-f0-9]{40})\b/i);
    return m ? m[1].toLowerCase() : '';
  }

  // ----- status badge (duplicates / library) -----

  let badge = null; // { host, root }
  let lastStatus = null;
  let statusKey = '';
  let statusRequest = 0;

  function badgeRoot() {
    const ours = document.querySelector(`button[${MARK}="ours"]`);
    if (!ours) return null;
    if (!badge) {
      badge = shadowHost('span', { [MARK]: 'badge' }, {
        display: 'inline-flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center',
        marginLeft: '0.5rem', font: '12px system-ui, sans-serif', verticalAlign: 'middle'
      });
    }
    if (badge.host.previousElementSibling !== ours) ours.insertAdjacentElement('afterend', badge.host);
    return badge.root;
  }

  const paint = (el, color) => Object.assign(el.style, { background: color + '26', color, border: `1px solid ${color}66` });

  function pill(text, color, title) {
    const el = h('span', null, text);
    if (title) el.title = title;
    Object.assign(el.style, { padding: '3px 8px', borderRadius: '999px', whiteSpace: 'nowrap' });
    paint(el, color);
    return el;
  }

  function renderBadge() {
    const el = badgeRoot();
    if (!el) return;
    el.replaceChildren();
    const s = lastStatus;
    if (!s) return;
    if (s.qbit) el.append(pill('⚠ ' + qbitText(s.qbit), '#f59e0b', s.qbit.name + (s.qbit.category ? ` — catégorie : ${s.qbit.category}` : '')));
    const lib = s.library;
    if (!lib) return;
    if (!lib.inLibrary) { el.append(pill(`Pas dans ${lib.service}`, '#9ca3af')); return; }
    if (lib.service === 'Lidarr') {
      if (lib.artistOnly) el.append(pill('Lidarr : artiste présent, album absent', '#9ca3af', lib.title));
      else if (!lib.total) el.append(pill('Lidarr : album présent', '#3b82f6', lib.title));
      else {
        const complete = lib.files >= lib.total;
        el.append(pill(`${complete ? '✔ ' : ''}Lidarr : ${lib.files}/${lib.total} pistes`, complete ? '#22c55e' : '#3b82f6', lib.title));
      }
      return;
    }
    if (lib.service === 'Radarr') {
      el.append(pill(lib.hasFile ? '✔ Radarr : fichier présent' : 'Radarr : fichier manquant',
        lib.hasFile ? '#22c55e' : '#3b82f6', lib.title));
      return;
    }
    if (lib.seasons.length) {
      for (const se of lib.seasons) {
        const name = 'S' + String(se.number).padStart(2, '0');
        if (!se.exists) { el.append(pill(`Sonarr : ${name} inconnue`, '#9ca3af', lib.title)); continue; }
        const complete = se.total > 0 && se.files >= se.total;
        el.append(pill(`${complete ? '✔ ' : ''}Sonarr ${name} : ${se.files}/${se.total} ép.`,
          complete ? '#22c55e' : '#3b82f6', lib.title));
      }
    } else {
      el.append(pill(`Sonarr : ${lib.files}/${lib.total} ép.`, '#3b82f6', lib.title));
    }
  }

  async function refreshStatus(force = false) {
    if (!document.querySelector(`button[${MARK}="ours"]`)) return;
    const media = detectMedia();
    const hash = detectHash();
    const useMedia = (media.fromFiches || media.fromCard) && media.type;
    const key = [location.pathname, hash, useMedia ? JSON.stringify(media) : ''].join('|');
    if (!force && key === statusKey) { renderBadge(); return; }
    statusKey = key;
    lastStatus = null;
    renderBadge();
    if (!hash && !useMedia) return;
    const reqId = ++statusRequest;
    const res = await sendMessage({ type: 'pageStatus', hash, media: useMedia ? cleanMedia(media) : null });
    if (reqId !== statusRequest || !res.ok) return;
    lastStatus = cleanStatus(res);
    renderBadge();
  }

  // ----- the dialog: category of the torrent, and where to add the item (Radarr/Sonarr/Lidarr, never monitored) -----

  const DIALOG_CSS = `
    :host { all: initial; }
    .bg { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 2147483646;
          display: flex; align-items: center; justify-content: center; font: 14px system-ui, sans-serif; }
    .box { background: #1e1e24; color: #eee; border-radius: 10px; padding: 20px; width: 340px;
           max-height: 92vh; overflow-y: auto; box-shadow: 0 10px 40px rgba(0,0,0,.5); }
    h3 { margin: 0 0 14px; font-size: 16px; }
    select { width: 100%; padding: 8px; border-radius: 6px; background: #2b2b33; color: #eee; border: 1px solid #444; }
    select.list { padding: 4px; }
    option { padding: 4px 8px; border-radius: 4px; }
    option:checked { background: #3b82f6; color: #fff; }
    option:disabled { color: #777; }
    label { display: flex; gap: 8px; align-items: center; margin-top: 12px; }
    .row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
    button { padding: 8px 14px; border-radius: 6px; border: 0; cursor: pointer; font-weight: 600; }
    .ok { background: #3b82f6; color: #fff; } .ok:disabled { opacity: .5; cursor: default; }
    .cancel { background: #3a3a44; color: #eee; }
    .err { color: #ff7b72; margin-top: 10px; white-space: pre-wrap; }
    .lbl { margin: 12px 0 4px; font-weight: 600; } .lbl:first-of-type { margin-top: 0; }
    .ids { margin-top: 4px; font-size: 12px; color: #999; }
    .warn { background: #f59e0b22; color: #fbbf24; border: 1px solid #f59e0b66; border-radius: 6px;
            padding: 8px 10px; margin-bottom: 12px; }
    input[type=text] { width: 100%; box-sizing: border-box; padding: 8px; border-radius: 6px;
            background: #2b2b33; color: #eee; border: 1px solid #444; }
    .hint { font-size: 12px; color: #999; margin-top: 4px; }
    .tname { font-size: 12px; color: #bbb; margin: -6px 0 12px; word-break: break-all; }
    .listhint { margin: 0 0 4px; }`;

  // The menu of a drop-down list is drawn by the browser outside the page, where a remote view cannot show it:
  // lists with several choices are shown open instead (nothing changes for a list with a single choice).
  function listbox(select, max) {
    const count = select.options.length;
    select.size = count > 1 ? Math.min(max, count) : 1;
    select.classList.toggle('list', count > 1);
    if (count && select.selectedIndex < 0) select.selectedIndex = 0;
    return select;
  }

  function buildDialog(idsText) {
    const typeSelect = listbox(h('select', { class: 'type' },
      h('option', { value: '' }, 'Ne pas ajouter'),
      h('option', { value: 'movie' }, 'Radarr (film)'),
      h('option', { value: 'series' }, 'Sonarr (série)'),
      h('option', { value: 'music' }, 'Lidarr (musique)')), 4);
    const rootSelect = h('select', { class: 'root', disabled: true }, h('option', null, 'Chargement…'));
    const stypeSelect = listbox(h('select', { class: 'stype' },
      h('option', { value: 'standard' }, 'Standard'),
      h('option', { value: 'anime' }, 'Anime'),
      h('option', { value: 'daily' }, 'Quotidienne')), 3);
    const lmodeSelect = listbox(h('select', { class: 'lmode' },
      h('option', { value: 'album' }, 'L’album (et l’artiste si besoin)'),
      h('option', { value: 'artist' }, 'L’artiste seul')), 2);
    const artistInput = h('input', { type: 'text', class: 'artist', placeholder: 'Nom de l’artiste' });
    const albumInput = h('input', { type: 'text', class: 'album', placeholder: 'Titre de l’album' });
    const select = h('select', { class: 'cat', disabled: true }, h('option', null, 'Chargement des catégories…'));
    const paused = h('input', { type: 'checkbox', class: 'paused' });
    const cancel = h('button', { class: 'cancel' }, 'Annuler');
    const ok = h('button', { class: 'ok', disabled: true }, 'Envoyer');
    const tname = h('div', { class: 'tname', hidden: true });
    const warn = h('div', { class: 'warn', hidden: true });
    const err = h('div', { class: 'err', hidden: true });
    const arrsel = h('div', { class: 'arrsel' }, h('div', { class: 'lbl' }, 'Ajouter à'), typeSelect, h('div', { class: 'ids' }, idsText));
    const listhint = h('div', { class: 'ids listhint', hidden: true }, 'Radarr/Sonarr/Lidarr : ouvre la fiche du torrent pour l’ajout automatique.');
    const stypeWrap = h('div', { class: 'stype-wrap', hidden: true }, h('div', { class: 'lbl' }, 'Type de série'), stypeSelect);
    const albumWrap = h('div', { class: 'album-wrap' }, h('div', { class: 'lbl' }, 'Album'), albumInput);
    const musicWrap = h('div', { class: 'music-wrap', hidden: true },
      h('div', { class: 'lbl' }, 'Ajouter dans Lidarr'), lmodeSelect, h('div', { class: 'lbl' }, 'Artiste'), artistInput, albumWrap);
    const arrBox = h('div', { class: 'arr', hidden: true }, h('div', { class: 'lbl' }, 'Dossier racine'), rootSelect, stypeWrap, musicWrap);
    const bg = h('div', { class: 'bg' }, h('div', { class: 'box' },
      h('h3', null, 'Envoyer à qBittorrent'), tname, warn, arrsel, listhint, arrBox,
      h('div', { class: 'lbl' }, 'Catégorie qBittorrent'), select,
      h('label', null, paused, ' Ajouter en pause'), err,
      h('div', { class: 'row' }, cancel, ok)));
    const { host, root } = shadowHost('div', { [MARK]: 'dialog' }, { all: 'initial' });
    adopt(root, DIALOG_CSS);
    root.append(bg);
    return {
      host, root, bg, tname, warn, err, arrsel, listhint, arrBox, stypeWrap, musicWrap, albumWrap,
      typeSelect, rootSelect, stypeSelect, lmodeSelect, artistInput, albumInput, select, paused, cancel, ok
    };
  }

  // ctx (list rows): { name, qbit }; no Radarr/Sonarr/Lidarr IDs are available outside the torrent page.
  function chooseCategory(ctx = null) {
    const listMode = !!ctx;
    const detected = listMode ? { type: '', ids: {} } : detectMedia();
    detected.ids = cleanIds(detected.ids);
    detected.artist = clip(detected.artist, 200);
    detected.album = clip(detected.album, 200);
    const knownQbit = listMode ? ctx.qbit : lastStatus && lastStatus.qbit;
    const idsText = [
      detected.ids.imdb && `IMDb ${detected.ids.imdb}`,
      detected.ids.tmdb && `TMDB ${detected.ids.tmdb}`,
      detected.ids.tvdb && `TVDB ${detected.ids.tvdb}`,
      (detected.ids.mbRelease || detected.ids.mbReleaseGroup) && 'MusicBrainz',
      detected.ids.deezer && `Deezer ${detected.ids.deezer}`,
      detected.ids.discogs && `Discogs ${detected.ids.discogs}`
    ].filter(Boolean).join(' · ') || 'aucun ID trouvé';

    return new Promise((resolve) => {
      const ui = buildDialog(idsText);
      const { host, root, bg, tname, warn, err, arrsel, listhint, arrBox, stypeWrap, musicWrap, albumWrap, cancel, ok } = ui;
      const { typeSelect, rootSelect, stypeSelect, lmodeSelect, artistInput, albumInput, select, paused } = ui;
      (document.body || document.documentElement).append(host);
      // Typing in our fields must not trigger C411 keyboard shortcuts.
      for (const t of ['keydown', 'keyup', 'keypress']) host.addEventListener(t, (e) => e.stopPropagation());

      let closed = false;
      const close = (value) => {
        if (closed) return;
        closed = true;
        host.remove();
        resolve(value);
      };

      const SERVICE = { movie: 'radarr', series: 'sonarr', music: 'lidarr' };
      const guess = detected.type === 'music' ? detected : guessMusic(pageTitle());
      artistInput.value = clip(guess.artist, 200);
      albumInput.value = clip(guess.album, 200);
      lmodeSelect.addEventListener('change', () => { albumWrap.hidden = lmodeSelect.value === 'artist'; });
      // Names edited by hand: the MusicBrainz IDs found on the page may no longer match.
      const musicMedia = () => {
        const artist = artistInput.value.trim();
        const album = albumInput.value.trim();
        const sameArtist = detected.type === 'music' && artist === (detected.artist || '');
        const sameAlbum = sameArtist && album === (detected.album || '');
        return {
          type: 'music', artist, album, year: guess.year, rootFolder: rootSelect.value, lmode: lmodeSelect.value,
          ids: sameAlbum ? detected.ids : sameArtist && detected.ids.mbArtist ? { mbArtist: detected.ids.mbArtist } : {}
        };
      };
      if (knownQbit) {
        warn.hidden = false;
        warn.textContent = `⚠ Ce torrent est déjà dans qBittorrent (${qbitText(knownQbit).replace('qBittorrent : ', '')}).`;
      }
      if (listMode) {
        arrsel.hidden = true;
        listhint.hidden = false;
        if (ctx.name) {
          tname.hidden = false;
          tname.textContent = ctx.name;
        }
      }

      // Only a real click or key press sends: nothing the page dispatches can.
      const submit = () => {
        if (closed || ok.disabled) return;
        const kind = typeSelect.value;
        close({
          category: cleanCategory(select.value),
          paused: paused.checked,
          media: cleanMedia(kind === 'music' ? musicMedia() : kind ? {
            type: kind,
            ids: detected.ids,
            rootFolder: rootSelect.value,
            seriesType: kind === 'series' ? stypeSelect.value : undefined
          } : null)
        });
      };
      cancel.addEventListener('click', () => close(null));
      bg.addEventListener('click', (e) => { if (e.target === bg) close(null); });
      ok.addEventListener('click', (e) => { if (e.isTrusted) submit(); });
      root.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close(null);
        else if (e.key === 'Enter' && e.isTrusted && e.target !== cancel) submit();
      });

      const load = async () => {
        const res = await sendMessage({ type: 'getCategories' });
        if (closed) return;
        if (!res.ok) {
          select.replaceChildren(h('option', { value: '' }, '(aucune catégorie)'));
          err.hidden = false;
          err.textContent = res.error + '\nVérifie la configuration dans les Réglages.';
          return;
        }
        const conf = cleanCategories(res);
        select.replaceChildren(h('option', { value: '' }, '(aucune catégorie)'), ...conf.categories.map((c) => h('option', { value: c }, c)));
        listbox(select, 6);
        select.value = conf.categories.includes(conf.selected) ? conf.selected : '';

        for (const opt of typeSelect.options) {
          if (opt.value && !conf.arrEnabled[opt.value]) {
            opt.disabled = true;
            opt.textContent += ' — non configuré';
          }
        }
        const hasIds = detected.type === 'music' || detected.ids.imdb || detected.ids.tmdb || detected.ids.tvdb;
        typeSelect.value = hasIds && conf.arrEnabled[detected.type] ? detected.type : '';
        const applyTypeCategory = () => {
          const cat = conf.byType[typeSelect.value];
          if (cat && conf.categories.includes(cat)) select.value = cat;
        };
        const guessSeriesType = () => {
          stypeSelect.value = /anim/i.test(rootSelect.value) ? 'anime' : 'standard';
        };
        rootSelect.addEventListener('change', guessSeriesType);
        let rootsRequest = 0;
        const loadRoots = async () => {
          const kind = typeSelect.value;
          arrBox.hidden = !kind;
          stypeWrap.hidden = kind !== 'series';
          musicWrap.hidden = kind !== 'music';
          if (!kind) {
            rootsRequest++;
            err.hidden = true;
            ok.disabled = false;
            return;
          }
          const reqId = ++rootsRequest;
          rootSelect.disabled = true;
          ok.disabled = true;
          rootSelect.replaceChildren(h('option', null, 'Chargement…'));
          listbox(rootSelect, 4);
          const meta = await sendMessage({ type: 'arrMeta', service: SERVICE[kind] });
          if (closed || reqId !== rootsRequest) return;
          rootSelect.replaceChildren();
          const roots = meta.ok ? strList(meta.roots, 200, 500).filter((r) => r && strict(r, 500) === r) : [];
          if (!roots.length) {
            err.hidden = false;
            err.textContent = meta.ok ? 'Aucun dossier racine configuré.' : meta.error;
            return;
          }
          err.hidden = true;
          for (const r of roots) rootSelect.append(h('option', { value: r }, r));
          listbox(rootSelect, 4);
          rootSelect.value = roots.includes(conf.defaultRoot[kind]) ? conf.defaultRoot[kind] : roots[0];
          guessSeriesType();
          rootSelect.disabled = false;
          ok.disabled = false;
        };
        typeSelect.addEventListener('change', () => {
          applyTypeCategory();
          detach(loadRoots());
        });
        applyTypeCategory();

        select.disabled = false;
        ok.disabled = false;
        ok.focus();
        detach(loadRoots());
      };
      detach(load());
    });
  }

  function clickNormalDownloadIfOffered() {
    const deadline = Date.now() + 5000;
    const tryClick = () => {
      const label = [...document.querySelectorAll('span, div, button, a')]
        .find((el) => norm(el) === 'Téléchargement normal' && el.offsetParent !== null);
      if (label) {
        (label.closest('button, a, [role="menuitem"], [role="option"], [role="button"], li') || label).click();
        return;
      }
      if (Date.now() < deadline) setTimeout(tryClick, 150);
    };
    setTimeout(tryClick, 150);
  }

  async function sendToQbit(nativeButton, ctx = null) {
    const choice = await chooseCategory(ctx);
    if (!choice) return;
    arm(choice);
    nativeButton.click();
    clickNormalDownloadIfOffered();
  }

  // ----- list badges (search results, etc.) -----

  let qbIndex = null; // { byName: Map, byHash: Map, at }
  let indexLoad = null;
  let indexGen = 0;

  function dropIndex() {
    qbIndex = null;
    indexLoad = null;
    indexGen++;
  }

  // Callers share one request; an answer that comes back after dropIndex() is not kept.
  function loadIndex() {
    if (qbIndex && Date.now() - qbIndex.at < 30000) return Promise.resolve(qbIndex);
    if (indexLoad) return indexLoad;
    const gen = indexGen;
    const load = sendMessage({ type: 'qbitIndex' }).then((res) => {
      const torrents = cleanTorrents(res);
      const idx = {
        at: Date.now(),
        byName: new Map(torrents.map((t) => [normName(t.name), t])),
        byHash: new Map(torrents.map((t) => [t.hash, t]))
      };
      if (gen === indexGen) qbIndex = idx;
      return idx;
    });
    const settle = () => {
      if (indexLoad === load) indexLoad = null;
    };
    load.then(settle, settle);
    indexLoad = load;
    return load;
  }

  function matchAnchor(a, idx) {
    const m = (a.getAttribute('href') || '').match(/[a-f0-9]{40}/i);
    if (m && idx.byHash.has(m[0].toLowerCase())) return idx.byHash.get(m[0].toLowerCase());
    const candidates = [a.title, norm(a)];
    for (const el of a.querySelectorAll('*')) if (!el.children.length) candidates.push(el.textContent);
    for (const c of candidates) {
      const k = normName(c);
      if (k.length >= 12 && idx.byName.has(k)) return idx.byName.get(k);
    }
    return null;
  }

  // Where to put the pill: next to the "copy file name" button of the result row, if any.
  function pillSlots(a) {
    let el = a;
    for (let depth = 0; el && depth < 8; depth++, el = el.parentElement) {
      const btns = el.querySelectorAll('button[aria-label="Copier le nom du fichier"]');
      if (btns.length && btns.length <= 2) return [...btns].map((b) => ({ ref: b, where: 'beforebegin' }));
      if (btns.length > 2) break;
    }
    // Card-like links (e.g. notifications): put it at the end of the last text line, inside the link.
    const lines = a.querySelectorAll('p');
    if (lines.length) return [{ ref: lines[lines.length - 1], where: 'beforeend' }];
    return [{ ref: a, where: 'afterend' }];
  }

  function existingPillAt(ref, where) {
    const el = where === 'beforebegin' ? ref.previousElementSibling
      : where === 'beforeend' ? ref.lastElementChild
        : ref.nextElementSibling;
    return !!(el && el.hasAttribute(PILL));
  }

  // The pill sits in a closed shadow root; its host takes no box of its own, so the page lays it out as before.
  function listPill(text, color, title, where) {
    const { host, root } = shadowHost('span', { [PILL]: '' }, { display: 'contents' });
    const el = pill(text, color, title);
    Object.assign(el.style, { fontSize: '10px', padding: '1px 6px', flexShrink: '0', lineHeight: '1.4' });
    if (where !== 'beforebegin') el.style.marginLeft = '6px';
    if (where === 'beforeend') el.style.display = 'inline-block';
    root.append(el);
    return { host, el, text, color, title };
  }

  const anchorPills = new WeakMap(); // link → [{ host, el, text, color, title }]

  function dropPills(a) {
    for (const p of anchorPills.get(a) || []) p.host.remove();
    anchorPills.delete(a);
  }

  async function refreshListBadges() {
    const idx = await loadIndex();
    if (!idx.byName.size) return;
    const onDetail = !!document.querySelector(`button[${MARK}="ours"]`);
    const currentHash = pageHashFromUrl() || (onDetail ? detectHash() : '');
    const h1 = onDetail ? document.querySelector('h1') : null;
    const titleKey = h1 ? normName(h1.textContent) : '';
    for (const a of document.querySelectorAll('a[href]')) {
      // The torrent of the current page is already shown next to the qBittorrent button.
      const selfLink = currentHash && (a.getAttribute('href') || '').toLowerCase().includes(currentHash);
      const hidden = !a.getClientRects().length;
      if (selfLink || hidden) {
        dropPills(a);
        continue;
      }
      let t = matchAnchor(a, idx);
      if (t && ((currentHash && t.hash === currentHash) || (titleKey.length >= 12 && normName(t.name) === titleKey))) t = null;
      if (!t) {
        dropPills(a);
        continue;
      }
      const done = t.progress >= 1;
      const text = done ? '✔ qBit' : `⇩ ${Math.floor(t.progress * 100)} %`;
      const color = done ? '#22c55e' : '#3b82f6';
      const title = `Déjà dans qBittorrent : ${t.name}`;
      let pills = (anchorPills.get(a) || []).filter((p) => p.host.isConnected);
      if (!pills.length) {
        pills = pillSlots(a)
          .filter(({ ref, where }) => !existingPillAt(ref, where))
          .map(({ ref, where }) => {
            const p = listPill(text, color, title, where);
            ref.insertAdjacentElement(where, p.host);
            return p;
          });
        anchorPills.set(a, pills);
      } else {
        for (const p of pills) {
          if (p.text === text && p.color === color && p.title === title) continue;
          p.el.textContent = text;
          p.el.title = title;
          paint(p.el, color);
          Object.assign(p, { text, color, title });
        }
      }
    }
  }

  // ----- qBittorrent buttons: torrent page, and right after each download icon in lists -----

  // Native download button -> our button. C411's own elements are never modified (Vue may re-render or
  // reuse them); our button is recreated whenever it is no longer in the page.
  const pairs = new Map();

  function pairUp(native, make) {
    const ours = pairs.get(native);
    if (ours && ours.isConnected) return;
    const el = make();
    pairs.set(native, el);
    native.insertAdjacentElement('afterend', el);
  }

  function sweepPairs() {
    for (const [native, ours] of pairs) {
      if (native.isConnected && ours.isConnected) continue;
      if (!native.isConnected) ours.remove();
      pairs.delete(native);
    }
  }

  // These buttons live in the page: a script of the page can click them, a real click is the only one that counts.
  function pageButton(btn) {
    const ours = btn.cloneNode(false);
    ours.removeAttribute('id');
    ours.setAttribute(MARK, 'ours');
    const icon = btn.querySelector('[data-slot="leadingIcon"], .iconify, svg');
    if (icon) ours.append(icon.cloneNode(true));
    ours.append(document.createTextNode(icon ? ' qBittorrent' : '⇩ qBittorrent'));
    ours.title = 'Envoyer à qBittorrent';
    ours.style.marginLeft = '0.5rem';
    ours.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.isTrusted) detach(sendToQbit(btn));
    });
    return ours;
  }

  const gridToken = (el) => (typeof el.className === 'string'
    ? (el.className.split(/\s+/).find((c) => c.startsWith('lg:grid-cols-[')) || '') : '');

  // Result rows are CSS grids whose columns come from a `lg:grid-cols-[…]` class. Only a few levels up
  // are checked, so that a page-layout grid is never taken for a row.
  function rowGrid(btn) {
    let el = btn.parentElement;
    for (let depth = 0; el && depth < 3; depth++, el = el.parentElement) if (gridToken(el)) return el;
    return null;
  }

  // On desktop, the download-icon column (the last one) is doubled so that our icon fits next to C411's.
  // The rule targets the class itself: rows and header sharing it stay aligned, rows added later are
  // covered, and the mobile layout (below Tailwind's `lg` breakpoint) is left untouched.
  // The class name comes from the page: it ends up in a stylesheet only if it has the shape of a Tailwind value.
  const GRID_TOKEN = /^lg:grid-cols-\[(?!.*(?:\/\*|\*\/))[A-Za-z0-9_.,%()+*/-]+\]$/;
  const gridRules = new Map();

  function widenColumn(token) {
    if (gridRules.has(token)) return;
    const cols = GRID_TOKEN.test(token) && token.length <= 200 ? token.slice('lg:grid-cols-['.length, -1).split('_') : [];
    const last = /^(\d+(?:\.\d+)?)px$/.exec(cols[cols.length - 1] || '');
    if (!last) {
      gridRules.set(token, '');
      return;
    }
    cols[cols.length - 1] = `${Number(last[1]) * 2}px`;
    const sel = `.${CSS.escape(token)}`;
    gridRules.set(token, `@media (min-width: 64rem) { ${sel}${sel} { grid-template-columns: ${cols.join(' ')}; } }`);
  }

  let gridSheet; // undefined: not tried yet, null: not supported
  let gridStyle = null;
  let gridCss = '';

  function applyGridRules() {
    const css = [...gridRules.values()].filter(Boolean).join('\n');
    if (!css) return;
    if (gridSheet === undefined) {
      try {
        gridSheet = new CSSStyleSheet();
      } catch (e) {
        gridSheet = null;
      }
    }
    if (gridSheet) {
      try {
        if (css !== gridCss) {
          gridSheet.replaceSync(css);
          gridCss = css;
        }
        if (!document.adoptedStyleSheets.includes(gridSheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, gridSheet];
        return;
      } catch (e) {
        gridSheet = null;
      }
    }
    if (!gridStyle) gridStyle = h('style', { [MARK]: 'style' });
    if (!gridStyle.isConnected) (document.head || document.documentElement).append(gridStyle);
    if (gridStyle.textContent !== css) gridStyle.textContent = css;
  }

  function rowLink(row) {
    const wrapping = row.closest('a[href*="/torrents/"]');
    if (wrapping) return wrapping;
    let el = row.parentElement;
    for (let depth = 0; el && depth < 5; depth++, el = el.parentElement) {
      const links = [...el.querySelectorAll('a[href*="/torrents/"]')]
        .filter((a) => /\/torrents\/[^/?#]+/.test(a.getAttribute('href')));
      const uniq = [...new Set(links.map((a) => a.getAttribute('href')))];
      if (uniq.length === 1) return links.find((a) => norm(a)) || links[0];
      if (uniq.length > 1) return null;
    }
    return null;
  }

  function listButton(btn, row) {
    const ours = btn.cloneNode(true);
    for (const attr of ['id', 'data-state', 'data-grace-area-trigger']) ours.removeAttribute(attr);
    ours.setAttribute(MARK, 'ours-list');
    ours.setAttribute('aria-label', 'Envoyer à qBittorrent');
    ours.title = 'Envoyer à qBittorrent';
    ours.style.color = '#60a5fa';
    ours.style.marginLeft = '2px';
    ours.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!e.isTrusted) return;
      const a = rowLink(row);
      let qbit = null;
      if (a) {
        const t = matchAnchor(a, await loadIndex());
        if (t) qbit = { name: t.name, progress: t.progress, state: t.state };
      }
      // innerText: only the layout shown at this screen size (rows hold both a desktop and a mobile one).
      const name = a ? clip(a.innerText || a.textContent || '', 300) : '';
      detach(sendToQbit(btn, { name, qbit }));
    });
    return ours;
  }

  const hasDownloadIcon = (btn) => !!btn.querySelector('[class*="arrow-down-tray"]');

  function inject() {
    sweepPairs();
    for (const btn of document.querySelectorAll('button')) {
      if (btn.hasAttribute(MARK)) continue;
      const text = norm(btn);
      if (text === 'Télécharger') {
        pairUp(btn, () => pageButton(btn));
        continue;
      }
      if (text) continue;
      const grid = rowGrid(btn);
      const label = btn.getAttribute('aria-label');
      // Desktop rows and search "media" rows label their download icon; the mobile result cards don't.
      const listed = label === 'Télécharger'
        || (label === null && !grid && hasDownloadIcon(btn) && !!btn.closest('a[href*="/torrents/"]'));
      if (!listed) continue;
      if (grid) widenColumn(gridToken(grid));
      pairUp(btn, () => listButton(btn, grid || btn.parentElement));
    }
    applyGridRules();
  }

  // ----- start: wait for the DOM, then for Vue to be done with it, then follow the page -----

  const isOwn = (n) => n.nodeType === 1 && (n.hasAttribute(PILL) || n.hasAttribute(MARK));
  // The removal of one of our buttons (e.g. by a Vue re-render) is a page change: it must be put back.
  const isOwnButton = (n) => n.nodeType === 1 && n.tagName === 'BUTTON' && n.hasAttribute(MARK);
  const isOwnMutation = (m) => isOwn(m.target)
    || ([...m.addedNodes, ...m.removedNodes].every(isOwn) && ![...m.removedNodes].some(isOwnButton));

  let started = false;

  function start() {
    if (started) return;
    started = true;
    let refreshTimer = 0;
    new MutationObserver((mutations) => {
      if (mutations.every(isOwnMutation)) return;
      inject();
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        detach(refreshStatus());
        detach(refreshListBadges());
      }, 600);
    }).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(() => {
      if (!document.hidden) detach(refreshListBadges());
    }, 30000);
    inject();
    detach(refreshStatus());
    detach(refreshListBadges());
  }

  // C411 is rendered by the server, then Vue "hydrates" it: nodes added before that are thrown away or
  // reused by Vue (buttons lost after a reload). The page-world script flags <html> once hydration is over.
  function boot() {
    const t0 = Date.now();
    const wait = () => {
      const root = document.documentElement;
      if ((root && root.hasAttribute('data-qbt-hydrated')) || Date.now() - t0 > 15000) start();
      else setTimeout(wait, 100);
    };
    wait();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
