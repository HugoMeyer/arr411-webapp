/* Arr411 core: native bridge, API clients, UI helpers and navigation. */
(function () {
  'use strict';
  const App = (window.App = window.App || {});

  // ---------- HTTP: same-origin calls to the Arr411 Web server ----------
  // Answers from the services (qBittorrent, Radarr...) come back as { status, text }. Errors produced by the server itself
  // carry an X-Arr411-Error header and are thrown with the shape the Android bridge used (status, code).
  const CLIENT_ID = (function () {
    const a = new Uint8Array(12);
    window.crypto.getRandomValues(a);
    return Array.prototype.map.call(a, (b) => (b < 16 ? '0' : '') + b.toString(16)).join('');
  })();
  let leaving = false;
  function toLogin() {
    if (!leaving) {
      leaving = true;
      location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search));
    }
    return new Promise(() => {});
  }
  function blobFromB64(b64, type) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: type || 'application/octet-stream' });
  }
  App.http = async function (req) {
    const init = {
      method: req.method || 'GET',
      headers: Object.assign({}, req.headers, { 'X-Requested-With': 'arr411', 'X-Arr411-Client': CLIENT_ID }),
      cache: 'no-store',
      credentials: 'same-origin'
    };
    const b = req.body;
    if (b && b.type === 'text') init.body = b.text;
    else if (b && b.type === 'multipart') {
      const fd = new FormData();
      for (const p of b.parts || []) {
        if (p.base64 != null) fd.append(p.name, blobFromB64(p.base64, p.contentType), p.filename || 'fichier');
        else fd.append(p.name, p.value == null ? '' : String(p.value));
      }
      init.body = fd;
    }
    let r;
    let text;
    try {
      r = await fetch(req.url, init);
      text = await r.text();
    } catch (e) {
      throw mkErr('Réseau : ' + ((e && e.message) || e), 0, 'network');
    }
    const code = r.headers.get('X-Arr411-Error');
    if (!code) return { status: r.status, text: text };
    if (code === 'auth') return toLogin();
    let msg = '';
    try {
      msg = JSON.parse(text).message || '';
    } catch (e) {
      msg = '';
    }
    throw mkErr(msg || 'Erreur ' + r.status, code === 'network' ? 0 : r.status, code);
  };
  // JSON call to the server's own API (/api/...).
  App.api = async function (method, path, body) {
    const req = { url: path, method: method, headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      req.headers['Content-Type'] = 'application/json';
      req.body = { type: 'text', text: JSON.stringify(body) };
    }
    const r = await App.http(req);
    let j = null;
    try {
      j = r.text ? JSON.parse(r.text) : null;
    } catch (e) {
      j = null;
    }
    if (r.status < 200 || r.status >= 300) throw mkErr((j && j.message) || 'HTTP ' + r.status, r.status, j && j.code);
    return j;
  };

  function mkErr(msg, status, code) {
    const e = new Error(msg);
    e.status = status || 0;
    if (code) e.code = code;
    return e;
  }
  App.mkErr = mkErr;

  function stripHtml(t) {
    return String(t || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // ---------- Config & prefs ----------
  // The server owns the connections (never sent to the browser), the shared defaults (admin) and each user's prefs.
  // App.config exposes them with the field names the modules already use; service URLs point at the server's proxy.
  const SHARED_KEYS = ['defaultCategory', 'radarrCategory', 'sonarrCategory', 'lidarrCategory', 'radarrProfile', 'radarrRoot', 'sonarrProfile', 'sonarrRoot', 'lidarrProfile', 'lidarrRoot', 'lidarrMetaProfile'];
  const USER_KEYS = ['startTab', 'lastCategory', 'notifyDone'];
  App.config = {};
  App.user = null;
  App.isAdmin = false;
  App.version = '';
  App.loadConfig = async function () {
    const j = await App.api('GET', '/api/config');
    const c = {};
    const sv = j.services || {};
    const q = sv.qb || {};
    c.qbUrl = q.configured ? '/api/svc/qb' : '';
    c.qbWeb = q.web || '';
    c.qbRev = q.rev || 0;
    for (const s of ['radarr', 'sonarr', 'lidarr']) {
      const x = sv[s] || {};
      c[s + 'Url'] = x.configured ? '/api/svc/' + s : '';
      c[s + 'Key'] = x.configured ? 'srv' + (x.rev || 0) : '';
      c[s + 'Web'] = x.web || '';
    }
    Object.assign(c, j.defaults || {}, j.prefs || {});
    const old = App.config;
    App.config = c;
    App.user = j.user;
    App.isAdmin = !!j.user && j.user.role === 'admin';
    App.version = j.version || '';
    const patch = {};
    for (const k in c) if (k in old && old[k] !== c[k]) patch[k] = c[k];
    if (Object.keys(patch).length) App.emit('config', patch);
    return c;
  };
  App.saveCfg = function (patch) {
    Object.assign(App.config, patch);
    const shared = {};
    const mine = {};
    for (const k in patch) {
      if (SHARED_KEYS.indexOf(k) >= 0) shared[k] = patch[k];
      else if (USER_KEYS.indexOf(k) >= 0) mine[k] = patch[k];
    }
    if (App.isAdmin && Object.keys(shared).length) App.api('PUT', '/api/admin/defaults', shared).catch(App.err);
    if (Object.keys(mine).length) App.api('PUT', '/api/prefs', mine).catch(App.err);
    App.emit('config', patch);
  };
  App.pref = function (k, d) {
    try {
      const v = localStorage.getItem('arr411.' + k);
      return v == null ? d : JSON.parse(v);
    } catch (e) {
      return d;
    }
  };
  App.setPref = function (k, v) {
    try {
      localStorage.setItem('arr411.' + k, JSON.stringify(v));
    } catch (e) { /* storage unavailable */ }
  };

  // ---------- Events ----------
  const listeners = {};
  App.on = function (ev, fn) {
    (listeners[ev] = listeners[ev] || []).push(fn);
    return () => {
      listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn);
    };
  };
  App.emit = function (ev, data) {
    (listeners[ev] || []).slice().forEach((fn) => {
      try {
        fn(data);
      } catch (e) {
        console.error(e);
      }
    });
  };

  // ---------- Encoding helpers ----------
  function enc(s) {
    return encodeURIComponent(s == null ? '' : String(s));
  }
  function qs(o) {
    return Object.keys(o)
      .filter((k) => o[k] != null)
      .map((k) => enc(k) + '=' + enc(typeof o[k] === 'boolean' ? String(o[k]) : o[k]))
      .join('&');
  }
  App.qs = qs;
  App.cmpVer = function (a, b) {
    const pa = String(a || '0').split('.').map((x) => parseInt(x, 10) || 0);
    const pb = String(b || '0').split('.').map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d > 0 ? 1 : -1;
    }
    return 0;
  };
  App.cleanUrl = function (u) {
    u = String(u || '').trim().replace(/\/+$/, '');
    if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
    return u;
  };

  // ---------- qBittorrent client ----------
  let qbLogin = null;
  const qb = (App.qb = {
    api: null,
    base() {
      return String(App.config.qbUrl || '').trim().replace(/\/+$/, '');
    },
    // Address of the real qBittorrent web UI, only when the admin published one.
    web() {
      return String(App.config.qbWeb || '').trim().replace(/\/+$/, '');
    },
    configured() {
      return !!qb.base();
    },
    login() {
      if (!qbLogin) {
        qbLogin = (async () => {
          // The server holds the credentials: this only asks it to open a fresh qBittorrent session.
          const r = await App.http({
            url: qb.base() + '/api/v2/auth/login',
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: { type: 'text', text: '' }
          });
          const t = (r.text || '').trim();
          // Recent qBittorrent answers 204 with an empty body; older versions answer 200 "Ok." / "Fails.".
          if (r.status === 204 || (r.status === 200 && /^ok/i.test(t))) return;
          if (r.status === 403) throw mkErr('qBittorrent : IP bannie après trop d’échecs de connexion', 403);
          if (r.status === 401 || (r.status === 200 && /^fails/i.test(t))) throw mkErr('qBittorrent : identifiants refusés (' + r.status + ' ' + stripHtml(t).slice(0, 60) + ')', 401);
          // Neither accepted nor refused (proxy page, 5xx...): status 0 so the refresh loop keeps retrying.
          throw mkErr('qBittorrent : réponse inattendue à la connexion (HTTP ' + r.status + ')', 0, 'unexpected');
        })().finally(() => {
          qbLogin = null;
        });
      }
      return qbLogin;
    },
    async call(path, o) {
      o = o || {};
      if (!qb.configured()) throw mkErr('qBittorrent n’est pas configuré', 0, 'config');
      const req = {
        url: qb.base() + '/api/v2' + path + (o.query ? '?' + qs(o.query) : ''),
        method: o.method || (o.form || o.parts ? 'POST' : 'GET'),
        headers: {}
      };
      if (o.form) {
        req.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        req.body = { type: 'text', text: qs(o.form) };
      } else if (o.parts) {
        req.body = { type: 'multipart', parts: o.parts };
      }
      let r = await App.http(req);
      if ((r.status === 401 || r.status === 403) && !o.noRetry) {
        await qb.login();
        r = await App.http(req);
      }
      if (r.status < 200 || r.status >= 300) {
        let t = stripHtml(r.text).slice(0, 160);
        if (r.status === 404) t = 'fonction indisponible (' + path + ')';
        else if (r.status === 415) t = 'fichier torrent invalide';
        throw mkErr('qBittorrent : ' + (t || 'HTTP ' + r.status), r.status);
      }
      return r.text;
    },
    async json(path, o) {
      const t = await qb.call(path, o);
      try {
        return JSON.parse(t);
      } catch (e) {
        throw mkErr('qBittorrent : réponse inattendue');
      }
    },
    post(path, form) {
      return qb.call(path, { form: form || {} });
    },
    async version() {
      if (qb.api == null) {
        try {
          qb.api = (await qb.call('/app/webapiVersion')).trim();
        } catch (e) {
          if (e.code === 'network' || e.status === 401) throw e;
          qb.api = '';
        }
      }
      return qb.api;
    },
    isV5() {
      return App.cmpVer(qb.api || '0', '2.11') >= 0;
    },
    // qBittorrent 5 renamed pause/resume to stop/start.
    async pauseResume(hashes, pause) {
      await qb.version().catch(() => '');
      const names = pause ? ['stop', 'pause'] : ['start', 'resume'];
      if (!qb.isV5()) names.reverse();
      try {
        await qb.post('/torrents/' + names[0], { hashes: hashes });
      } catch (e) {
        if (e.status !== 404) throw e;
        await qb.post('/torrents/' + names[1], { hashes: hashes });
      }
    }
  });
  App.on('config', (p) => {
    if ('qbUrl' in p || 'qbRev' in p) qb.api = null;
  });

  // ---------- Radarr / Sonarr / Lidarr client ----------
  const ARR_NAME = { radarr: 'Radarr', sonarr: 'Sonarr', lidarr: 'Lidarr' };
  function arrErrText(r) {
    let t = r.text || '';
    try {
      const j = JSON.parse(t);
      if (Array.isArray(j)) t = j.map((x) => x.errorMessage || x.message || '').filter(Boolean).join(' · ');
      else if (j && typeof j === 'object') t = j.message || j.error || j.title || '';
      else t = String(j);
    } catch (e) {
      t = stripHtml(t);
    }
    if (r.status === 401) return 'clé API refusée (401)';
    return (t || 'HTTP ' + r.status).slice(0, 240);
  }
  App.arrName = (svc) => ARR_NAME[svc];
  App.arr = function (svc) {
    const c = App.config;
    const base = String(c[svc + 'Url'] || '').trim().replace(/\/+$/, '');
    // Placeholder: the real API key stays on the server, which adds it to every request.
    const key = String(c[svc + 'Key'] || '').trim();
    const web = String(c[svc + 'Web'] || '').trim().replace(/\/+$/, '');
    const name = ARR_NAME[svc];
    const ver = svc === 'lidarr' ? '/api/v1' : '/api/v3';
    async function call(method, path, query, body) {
      if (!base || !key) throw mkErr(name + ' n’est pas configuré', 0, 'config');
      const req = {
        url: base + ver + path + (query ? '?' + qs(query) : ''),
        method: method,
        headers: { Accept: 'application/json' }
      };
      if (body !== undefined) {
        req.headers['Content-Type'] = 'application/json';
        req.body = { type: 'text', text: JSON.stringify(body) };
      }
      const r = await App.http(req);
      if (r.status < 200 || r.status >= 300) throw mkErr(name + ' : ' + arrErrText(r), r.status);
      if (!r.text) return null;
      try {
        return JSON.parse(r.text);
      } catch (e) {
        if (/^\s*</.test(r.text)) throw mkErr(name + ' : réponse HTML inattendue (URL incorrecte ?)', r.status);
        return r.text;
      }
    }
    return {
      svc: svc,
      name: name,
      base: base,
      web: web,
      key: key,
      ver: ver,
      configured: !!(base && key),
      get: (p, q) => call('GET', p, q),
      post: (p, b, q) => call('POST', p, q, b === undefined ? {} : b),
      put: (p, b, q) => call('PUT', p, q, b),
      del: (p, q, b) => call('DELETE', p, q, b),
      command: (cmd, extra) => call('POST', '/command', null, Object.assign({ name: cmd }, extra || {}))
    };
  };

  // ---------- DOM helpers ----------
  const PROPS = { value: 1, checked: 1, selected: 1, indeterminate: 1, textContent: 1 };
  function appendKids(el, kids) {
    for (const k of kids) {
      if (k == null || k === false || k === true) continue;
      if (Array.isArray(k)) appendKids(el, k);
      else el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
    }
  }
  function h(sel, attrs) {
    const kids = Array.prototype.slice.call(arguments, 2);
    let tag = 'div';
    let id = null;
    const classes = [];
    sel.replace(/([#.]?)([^#.]+)/g, (m, p, v) => {
      if (p === '#') id = v;
      else if (p === '.') classes.push(v);
      else tag = v;
      return '';
    });
    const el = document.createElement(tag);
    if (id) el.id = id;
    if (classes.length) el.className = classes.join(' ');
    if (attrs != null && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
      kids.unshift(attrs);
      attrs = null;
    }
    const props = [];
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = (el.className ? el.className + ' ' : '') + v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (PROPS[k]) props.push([k, v]);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    appendKids(el, kids);
    for (const p of props) el[p[0]] = p[1];
    return el;
  }
  App.h = h;
  App.append = (el, ...kids) => {
    appendKids(el, kids);
    return el;
  };
  App.clear = (el) => {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  };
  App.fill = (el, ...kids) => {
    App.clear(el);
    appendKids(el, kids);
    return el;
  };

  const SVGNS = 'http://www.w3.org/2000/svg';
  function icon(name, cls) {
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.6');
    s.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
    s.setAttribute('aria-hidden', 'true');
    for (const d of (window.ICONS && window.ICONS[name]) || []) {
      const p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
      s.appendChild(p);
    }
    return s;
  }
  App.icon = icon;

  App.run = function (fn, btn) {
    let r;
    try {
      r = fn();
    } catch (e) {
      App.err(e);
      return;
    }
    if (r && typeof r.then === 'function') {
      if (btn) btn.classList.add('busy');
      r.catch(App.err).then(() => {
        if (btn) btn.classList.remove('busy');
      });
    }
  };

  App.btn = function (label, o) {
    o = o || {};
    const cls = o.cls ? '.' + o.cls.trim().split(/\s+/).join('.') : '';
    const b = h('button.btn' + cls, { type: 'button', disabled: !!o.disabled, title: o.title }, o.icon ? icon(o.icon) : null, label != null && label !== '' ? h('span', label) : null);
    if (o.onClick) {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!b.classList.contains('busy')) App.run(() => o.onClick(b, e), b);
      });
    }
    return b;
  };
  App.iconBtn = function (name, label, onClick, cls) {
    const b = h('button.icon-btn' + (cls ? '.' + cls.trim().split(/\s+/).join('.') : ''), { type: 'button', 'aria-label': label, title: label }, icon(name));
    if (onClick) {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        App.run(() => onClick(b, e));
      });
    }
    return b;
  };
  App.input = function (o) {
    return h('input.input', Object.assign({ type: 'text', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' }, o || {}));
  };
  App.select = function (options, value, o) {
    const s = h('select.input', o || {});
    for (const op of options) s.appendChild(h('option', { value: String(op.value) }, op.label));
    s.value = value == null ? '' : String(value);
    if (s.selectedIndex < 0 && s.options.length) s.selectedIndex = 0;
    return s;
  };
  App.field = function (label, input, hint) {
    return h('div.field', label ? h('label', label) : null, input, hint ? h('div.hint', hint) : null);
  };
  App.switchEl = function (label, checked, onChange, sub) {
    const inp = h('input', { type: 'checkbox', checked: !!checked });
    if (onChange) inp.addEventListener('change', () => App.run(() => onChange(inp.checked, inp)));
    const el = h('label.switch', h('span.lbl', h('span', label), sub ? h('span.sub', sub) : null), inp);
    el.input = inp;
    return el;
  };
  App.checkRow = function (label, checked, onChange) {
    const inp = h('input.cb', { type: 'checkbox', checked: !!checked });
    if (onChange) inp.addEventListener('change', () => onChange(inp.checked));
    const el = h('label.check-row', inp, h('span', label));
    el.input = inp;
    return el;
  };
  App.seg = function (items, value, onChange) {
    const el = h('div.seg');
    const btns = items.map((it) => {
      const b = h('button', { type: 'button' }, it.label);
      b.addEventListener('click', () => {
        if (el.value === it.value) return;
        set(it.value);
        if (onChange) onChange(it.value);
      });
      el.appendChild(b);
      return b;
    });
    function set(v) {
      el.value = v;
      items.forEach((it, i) => btns[i].classList.toggle('on', it.value === v));
    }
    set(value);
    el.set = set;
    return el;
  };
  App.badge = function (text, color, ic) {
    return h('span.badge' + (color ? '.' + color : ''), ic ? icon(ic) : null, text);
  };
  App.bar = function (frac, color) {
    const i = h('i', { style: { width: Math.max(0, Math.min(100, (frac || 0) * 100)).toFixed(1) + '%' } });
    const el = h('div.bar', i);
    if (color) el.style.setProperty('--c', color);
    el.set = (f) => {
      i.style.width = Math.max(0, Math.min(100, (f || 0) * 100)).toFixed(1) + '%';
    };
    return el;
  };
  App.empty = function (ic, title, sub, actions) {
    const acts = (actions || []).filter(Boolean);
    return h('div.empty', icon(ic), h('div.empty-t', title), sub ? h('div.empty-s', sub) : null, acts.length ? h('div.btn-row', acts) : null);
  };
  // Empty state for a service with no connection yet: only an administrator can set it up.
  App.needSetup = function (ic, name, section, sub) {
    return App.empty(ic, name + ' n’est pas configuré',
      App.isAdmin ? sub : 'Demande à l’administrateur de connecter ' + name + '.',
      App.isAdmin ? [App.btn('Configurer', { cls: 'pri', icon: 'cog-6-tooth', onClick: () => App.openSettings(section) })] : []);
  };
  App.loading = () => h('div.loading', h('div.spin'));
  App.secTitle = function (text, right) {
    return h('div.section-title', h('span', text), h('span.grow'), right || null);
  };
  App.kv = function (pairs) {
    const dl = h('dl.kv');
    for (const p of pairs) {
      if (!p || p[1] == null || p[1] === '') continue;
      dl.appendChild(h('dt', p[0]));
      dl.appendChild(h('dd.sel', p[1]));
    }
    return dl;
  };
  App.note = function (text, kind, ic) {
    return h('div.note' + (kind ? '.' + kind : ''), icon(ic || (kind === 'err' ? 'exclamation-triangle' : kind === 'warn' ? 'exclamation-triangle' : 'information-circle')), h('div', text));
  };
  App.flag = function (cc) {
    cc = String(cc || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc)) return '🏳';
    return String.fromCodePoint(0x1f1e6 + cc.charCodeAt(0) - 65, 0x1f1e6 + cc.charCodeAt(1) - 65);
  };

  // ---------- Formatting ----------
  const UNITS = ['o', 'Ko', 'Mo', 'Go', 'To', 'Po'];
  function toDate(v) {
    if (v == null || v === '' || v === -1) return null;
    if (v instanceof Date) return v;
    if (typeof v === 'number') return v > 0 ? new Date(v < 1e12 ? v * 1000 : v) : null;
    const d = new Date(v);
    return isNaN(d) || d.getFullYear() < 1971 ? null : d;
  }
  const fmt = (App.fmt = {
    toDate: toDate,
    bytes(n) {
      n = +n || 0;
      if (n < 0) n = 0;
      let i = 0;
      while (n >= 1024 && i < UNITS.length - 1) {
        n /= 1024;
        i++;
      }
      return (i === 0 ? String(Math.round(n)) : n.toFixed(1)) + ' ' + UNITS[i];
    },
    speed(n) {
      return fmt.bytes(n) + '/s';
    },
    pct(p) {
      p = Math.max(0, Math.min(1, +p || 0));
      return (p >= 1 ? '100' : p === 0 ? '0' : (Math.floor(p * 1000) / 10).toFixed(1)) + '%';
    },
    dur(s) {
      s = Math.round(+s);
      if (!isFinite(s) || s < 0 || s >= 8640000) return '∞';
      const d = Math.floor(s / 86400);
      const hh = Math.floor((s % 86400) / 3600);
      const m = Math.floor((s % 3600) / 60);
      if (d) return d + ' j' + (hh ? ' ' + hh + ' h' : '');
      if (hh) return hh + ' h ' + String(m).padStart(2, '0');
      if (m) return m + ' min' + (m < 10 && s % 60 ? ' ' + (s % 60) + ' s' : '');
      return s + ' s';
    },
    runtime(min) {
      min = +min || 0;
      if (!min) return '';
      return min >= 60 ? Math.floor(min / 60) + ' h ' + String(min % 60).padStart(2, '0') : min + ' min';
    },
    date(v) {
      const d = toDate(v);
      return d ? d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    },
    dateTime(v) {
      const d = toDate(v);
      if (!d) return '';
      const sameYear = d.getFullYear() === new Date().getFullYear();
      return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric' }) + ' ' + fmt.time(d);
    },
    time(v) {
      const d = toDate(v);
      return d ? d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
    },
    day(v) {
      const d = toDate(v);
      return d ? d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }) : '';
    },
    rel(v) {
      const d = toDate(v);
      if (!d) return '';
      const s = (d.getTime() - Date.now()) / 1000;
      const a = Math.abs(s);
      let t;
      if (a < 60) return 'à l’instant';
      if (a < 3600) t = Math.round(a / 60) + ' min';
      else if (a < 86400) t = Math.round(a / 3600) + ' h';
      else if (a < 86400 * 30) t = Math.round(a / 86400) + ' j';
      else if (a < 86400 * 365) t = Math.round(a / (86400 * 30)) + ' mois';
      else t = Math.round(a / (86400 * 365)) + ' an' + (Math.round(a / (86400 * 365)) > 1 ? 's' : '');
      return s < 0 ? 'il y a ' + t : 'dans ' + t;
    },
    num(n) {
      return (+n || 0).toLocaleString('fr-FR');
    },
    ratio(r) {
      r = +r;
      if (!isFinite(r) || r < 0 || r > 1e4) return '∞';
      return r.toFixed(2);
    },
    plural(n, one, many) {
      return fmt.num(n) + ' ' + (Math.abs(n) > 1 ? many || one + 's' : one);
    }
  });
  App.norm = function (s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  };
  App.debounce = function (fn, ms) {
    let t = null;
    return function () {
      const args = arguments;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(null, args), ms);
    };
  };
  App.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- Toasts & errors ----------
  App.toast = function (msg, type) {
    const box = document.getElementById('toasts');
    if (!box) return;
    const el = h('div.toast' + (type ? '.' + type : ''), icon(type === 'err' ? 'exclamation-triangle' : type === 'ok' ? 'check-circle' : 'information-circle'), h('span', String(msg)));
    box.appendChild(el);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    el.getBoundingClientRect();
    el.classList.add('in');
    setTimeout(() => {
      el.classList.remove('in');
      setTimeout(() => el.remove(), 250);
    }, type === 'err' ? 4800 : 2600);
  };
  App.err = function (e) {
    if (!e) return;
    console.error(e);
    App.toast(e.message || String(e), 'err');
  };

  // ---------- Overlays ----------
  const overlays = [];
  function openOverlay(content, o) {
    o = o || {};
    const backdrop = h('div.backdrop');
    const ov = h('div.overlay', backdrop, content);
    document.getElementById('overlays').appendChild(ov);
    const entry = { ov: ov, tab: App.state.tab, closed: false };
    entry.close = function () {
      if (entry.closed) return;
      entry.closed = true;
      const i = overlays.indexOf(entry);
      if (i >= 0) overlays.splice(i, 1);
      ov.classList.remove('open');
      ov.style.pointerEvents = 'none';
      setTimeout(() => ov.remove(), 260);
      if (o.onClose) {
        try {
          o.onClose();
        } catch (e) {
          console.error(e);
        }
      }
    };
    if (o.dismiss !== false) backdrop.addEventListener('click', () => entry.close());
    overlays.push(entry);
    ov.getBoundingClientRect();
    ov.classList.add('open');
    return entry;
  }
  App.closeOverlays = function () {
    overlays.slice().forEach((e) => e.close());
  };

  App.sheet = function (o) {
    o = o || {};
    const titleEl = h('h3', o.title || '');
    const body = h('div.sheet-body');
    const actions = o.actions ? h('div.sheet-actions') : null;
    let s;
    const closeBtn = App.iconBtn('x-mark', 'Fermer', () => s.close());
    const el = h('div.sheet' + (o.full ? '.full' : '') + (o.cls ? '.' + o.cls : ''), h('div.grip'), h('div.sheet-head', titleEl, o.headActions || null, closeBtn), body, actions);
    if (o.body) appendKids(body, [o.body]);
    if (actions) appendKids(actions, [o.actions]);
    s = openOverlay(el, o);
    s.el = el;
    s.body = body;
    s.actionsEl = actions;
    s.setTitle = (t) => {
      titleEl.textContent = t;
    };
    return s;
  };

  App.menu = function (o) {
    const m = h('div.menu');
    const s = App.sheet({ title: o.title, body: m, onClose: o.onClose });
    const items = (o.items || []).filter(Boolean);
    const hasIcons = items.some((it) => it !== '-' && it.icon);
    for (const it of items) {
      if (it === '-') {
        m.appendChild(h('div.menu-sep'));
        continue;
      }
      let lead = null;
      if (it.icon) lead = icon(it.icon);
      else if (o.checks || !hasIcons) lead = it.on ? icon('check') : h('span', { style: { width: '22px', flex: 'none' } });
      const b = h(
        'button.menu-item' + (it.danger ? '.danger' : '') + (it.on ? '.on' : ''),
        { type: 'button', disabled: !!it.disabled },
        lead,
        h('span.mi-text', h('span', it.label), it.sub ? h('span.sub', it.sub) : null),
        it.on && it.icon ? icon('check', 'sm') : null,
        it.right || null
      );
      b.addEventListener('click', () => {
        s.close();
        if (it.onClick) App.run(it.onClick);
      });
      m.appendChild(b);
    }
    return s;
  };

  App.pick = function (o) {
    return new Promise((resolve) => {
      App.menu({
        title: o.title,
        checks: true,
        items: o.options.map((op) =>
          op === '-' ? '-' : { label: op.label, sub: op.sub, icon: op.icon, on: o.value !== undefined && op.value === o.value, danger: op.danger, onClick: () => resolve(op.value) }
        ),
        onClose: () => setTimeout(() => resolve(undefined), 0)
      });
    });
  };

  App.confirm = function (o) {
    return new Promise((resolve) => {
      const vals = {};
      let done = false;
      const body = [];
      if (o.message) body.push(h('p.muted.wrap', o.message));
      for (const c of o.checks || []) {
        vals[c.key] = !!c.checked;
        body.push(App.checkRow(c.label, c.checked, (v) => {
          vals[c.key] = v;
        }));
      }
      let s = null;
      const ok = App.btn(o.ok || 'Confirmer', {
        cls: o.danger ? 'danger-solid' : 'pri',
        onClick: () => {
          done = true;
          s.close();
          resolve(vals);
        }
      });
      s = App.sheet({
        title: o.title,
        body: body,
        actions: [App.btn('Annuler', { onClick: () => s.close() }), ok],
        onClose: () => {
          if (!done) resolve(false);
        }
      });
    });
  };

  App.prompt = function (o) {
    return new Promise((resolve) => {
      let done = false;
      const inp = o.multiline
        ? h('textarea.input', { placeholder: o.placeholder || '', autocapitalize: 'off', spellcheck: 'false', value: o.value || '' })
        : App.input({ type: o.type || 'text', placeholder: o.placeholder || '', value: o.value == null ? '' : String(o.value), inputmode: o.inputmode });
      let s = null;
      const submit = () => {
        done = true;
        const v = inp.value;
        s.close();
        resolve(v);
      };
      if (!o.multiline) {
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') submit();
        });
      }
      s = App.sheet({
        title: o.title,
        body: [o.message ? h('p.muted.wrap', o.message) : null, App.field(o.label, inp, o.hint)],
        actions: [App.btn('Annuler', { onClick: () => s.close() }), App.btn(o.ok || 'OK', { cls: 'pri', onClick: submit })],
        onClose: () => {
          if (!done) resolve(null);
        }
      });
      setTimeout(() => {
        inp.focus();
        if (inp.select && o.selectAll !== false) inp.select();
      }, 260);
    });
  };

  // ---------- Tabs & page stacks ----------
  App.state = { tab: 'c411', fg: true, prevTab: 'c411' };
  App.tabs = {};
  App.registerTab = function (name, el, hooks) {
    App.tabs[name] = { name: name, el: el, stack: [], hooks: hooks || {} };
    el.classList.add('hidden');
  };
  App.setTabHooks = function (name, hooks) {
    Object.assign(App.tabs[name].hooks, hooks);
  };
  App.showTab = function (name) {
    if (name !== App.state.tab) App.state.prevTab = App.state.tab;
    App.state.tab = name;
    for (const k in App.tabs) App.tabs[k].el.classList.toggle('hidden', k !== name);
    for (const e of overlays) e.ov.style.visibility = e.tab === name ? '' : 'hidden';
    const t = App.tabs[name];
    if (t && t.hooks.onShow) {
      try {
        t.hooks.onShow();
      } catch (e) {
        console.error(e);
      }
    }
    const top = t && t.stack[t.stack.length - 1];
    if (top && top.onShow) top.onShow();
    App.emit('visibility', name);
    return true;
  };
  App.goTab = function (name) {
    App.showTab(name);
  };
  // C411 forbids being embedded in a frame: its pages always open in a new browser tab.
  // Without a recent click or tap (a shared link at startup, a drop) browsers block pop-ups: ask for one first.
  function openWindow(url) {
    if (!/^https?:\/\//i.test(String(url || ''))) return;
    const ua = navigator.userActivation;
    if (ua && !ua.isActive) {
      const s = App.sheet({
        title: 'Ouvrir ce lien ?',
        body: [h('p.muted.wrap.sel', String(url))],
        actions: [
          App.btn('Annuler', { onClick: () => s.close() }),
          App.btn('Ouvrir', {
            cls: 'pri',
            icon: 'arrow-top-right-on-square',
            onClick: () => {
              window.open(url, '_blank', 'noopener');
              s.close();
            }
          })
        ]
      });
      return;
    }
    window.open(url, '_blank', 'noopener');
  }
  App.openC411 = openWindow;
  App.c411Search = function (q) {
    const terms = App.norm(q)
      .replace(/['’`]/g, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    App.openC411('https://c411.org/torrents?q=' + encodeURIComponent(terms) + '&sortBy=relevance');
  };
  App.openExternal = openWindow;
  App.copy = function (text, label) {
    text = String(text == null ? '' : text);
    const fallback = () => {
      const t = h('textarea', { style: { position: 'fixed', top: '0', left: '0', opacity: '0' }, value: text });
      document.body.appendChild(t);
      t.select();
      try {
        document.execCommand('copy');
      } catch (e) { /* nothing more to try */ }
      t.remove();
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).catch(fallback);
    else fallback();
    App.toast((label || 'Texte') + ' copié', 'ok');
  };
  App.haptic = () => {
    if (navigator.vibrate) navigator.vibrate(12);
  };

  App.page = function (o) {
    o = o || {};
    const titleEl = h('div.title', o.title || '');
    const subEl = h('div.subtitle', o.subtitle || '');
    const actions = h('div.head-actions');
    const backBtn = o.back
      ? App.iconBtn('chevron-left', 'Retour', () => {
          if (o.onBack) o.onBack();
          else App.back();
        })
      : null;
    const head = h('div.head' + (o.back ? '.has-back' : ''), backBtn, h('div.head-text', titleEl, subEl), actions);
    const el = h('div.page', head);
    if (o.actions) appendKids(actions, [o.actions]);
    return {
      el: el,
      head: head,
      actions: actions,
      titleEl: titleEl,
      setTitle(t) {
        titleEl.textContent = t || '';
      },
      setSub(t) {
        subEl.textContent = t || '';
      }
    };
  };
  App.push = function (tabName, page) {
    const t = App.tabs[tabName];
    const prev = t.stack[t.stack.length - 1];
    if (prev) {
      prev.el.classList.add('hidden');
      if (prev.onHide) prev.onHide();
    }
    page.tab = tabName;
    t.stack.push(page);
    if (t.stack.length > 1) page.el.classList.add('enter');
    t.el.appendChild(page.el);
    page.el.getBoundingClientRect();
    page.el.classList.remove('enter');
    if (page.onShow && App.state.tab === tabName) page.onShow();
    return page;
  };
  App.pop = function (tabName) {
    const t = App.tabs[tabName || App.state.tab];
    if (!t || t.stack.length <= 1) return false;
    const p = t.stack.pop();
    if (p.onHide) p.onHide();
    if (p.onDestroy) p.onDestroy();
    p.el.remove();
    const top = t.stack[t.stack.length - 1];
    top.el.classList.remove('hidden');
    if (top.onShow) top.onShow();
    App.emit('visibility', t.name);
    return true;
  };
  App.popToRoot = function (tabName) {
    while (App.pop(tabName)) { /* unwind */ }
  };
  App.isTop = function (page) {
    const t = App.tabs[page.tab];
    return !!t && App.state.fg && App.state.tab === page.tab && t.stack[t.stack.length - 1] === page;
  };
  // Back button: closes the top overlay of the visible tab, then pops a page. Returns true when handled.
  App.back = function () {
    for (let i = overlays.length - 1; i >= 0; i--) {
      if (overlays[i].tab === App.state.tab) {
        overlays[i].close();
        return true;
      }
    }
    if (App.pop(App.state.tab)) return true;
    const t = App.tabs[App.state.tab];
    if (t && t.hooks.onBack) return !!t.hooks.onBack();
    return false;
  };
  App.setForeground = function (fg) {
    App.state.fg = !!fg;
    App.emit('visibility', App.state.tab);
  };
  App.visible = (tab) => App.state.fg && App.state.tab === tab;

  // Repeating task whose delay depends on visibility (null = paused).
  App.loop = function (fn, delayFn) {
    let timer = null;
    let running = false;
    let stopped = false;
    let again = false;
    async function tick() {
      timer = null;
      if (stopped) return;
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        await fn();
      } catch (e) {
        console.error(e);
      }
      running = false;
      if (again) {
        again = false;
        return tick();
      }
      schedule();
    }
    function schedule() {
      if (stopped || timer || running) return;
      const d = delayFn();
      if (d == null) return;
      timer = setTimeout(tick, d);
    }
    function kick() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      tick();
    }
    const off = App.on('visibility', () => {
      const d = delayFn();
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (d != null && d <= 5000) tick();
      else schedule();
    });
    return {
      kick: kick,
      schedule: schedule,
      stop() {
        stopped = true;
        clearTimeout(timer);
        off();
      }
    };
  };

  // ---------- Gestures ----------
  App.longPress = function (el, fn) {
    let timer = null;
    let sx = 0;
    let sy = 0;
    let fired = false;
    el.addEventListener('touchstart', (e) => {
      fired = false;
      const p = e.touches[0];
      sx = p.clientX;
      sy = p.clientY;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fired = true;
        App.haptic();
        fn(e);
      }, 480);
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (!timer) return;
      const p = e.touches[0];
      if (Math.abs(p.clientX - sx) > 10 || Math.abs(p.clientY - sy) > 10) {
        clearTimeout(timer);
        timer = null;
      }
    }, { passive: true });
    el.addEventListener('touchend', () => {
      clearTimeout(timer);
      timer = null;
    });
    el.addEventListener('touchcancel', () => {
      clearTimeout(timer);
      timer = null;
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (fired) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
        fired = true;
      }
      fn(e);
    });
    el.addEventListener('click', (e) => {
      if (fired) {
        fired = false;
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    }, true);
  };

  // ---------- Images ----------
  App.img = function (srcs) {
    srcs = (srcs || []).filter(Boolean);
    const img = h('img', { alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
    let i = 0;
    img.addEventListener('error', () => {
      i++;
      if (i < srcs.length) img.src = srcs[i];
      else img.classList.add('broken');
    });
    if (srcs.length) img.src = srcs[0];
    else img.classList.add('broken');
    return img;
  };

  // Lazily renders a long list in chunks as the user scrolls.
  App.chunked = function (container, items, renderItem, chunk, root) {
    chunk = chunk || 60;
    let idx = 0;
    const sentinel = h('div', { style: { height: '1px' } });
    let io = null;
    function more() {
      const end = Math.min(items.length, idx + chunk);
      const frag = document.createDocumentFragment();
      for (; idx < end; idx++) frag.appendChild(renderItem(items[idx], idx));
      container.appendChild(frag);
      if (idx >= items.length) {
        if (io) io.disconnect();
        sentinel.remove();
      }
    }
    more();
    if (idx < items.length) {
      container.parentNode.insertBefore(sentinel, container.nextSibling);
      io = new IntersectionObserver((ents) => {
        if (ents.some((e) => e.isIntersecting)) more();
      }, { root: root || null, rootMargin: '600px' });
      io.observe(sentinel);
    }
    return {
      dispose() {
        if (io) io.disconnect();
        sentinel.remove();
      }
    };
  };
})();
