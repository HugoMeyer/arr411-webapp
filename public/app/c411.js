/* C411 tab: a real Chromium running beside the server, streamed into a canvas. C411 refuses to be framed, so an iframe or a
   mirror cannot work: the page, its buttons and its anti-bot check are the real ones, and this file only draws the frames
   and relays the pointer and the keyboard. Without that browser the tab is a launcher with a quick-add box. */
(function () {
  'use strict';
  const App = window.App;
  const h = App.h;
  const C = (App.c411 = {});
  const MAX_TORRENT = 20 * 1024 * 1024;
  const LEAVE_MS = 10000; // another tab of the app: the stream stops, the remote browser keeps running
  const HIDDEN_MS = 30000; // the whole page is hidden
  const RETRY_MS = [700, 1800, 4000];
  const PING_MS = 20000;
  const STALE_MS = 20000; // how long a status answer is trusted
  const WHEEL_LINE = 33;
  const MAX_MIRROR = 48;
  // The typing proxy always starts with one character, so that Backspace on an on-screen keyboard still produces an input event.
  const SENT = ' ';
  const NAMED = new Set(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Insert']);
  const SHORTCUTS = new Set(['a', 'z', 'y']);

  // What the person sees when the server ends the stream on purpose (code sent by the server) or when it cannot start.
  const ENDED = {
    replaced: { icon: 'computer-desktop', title: 'Ouvert ailleurs', text: 'Ce navigateur est affiché dans un autre onglet ou sur un autre appareil.', action: 'Reprendre ici', sticky: true },
    idle: { icon: 'clock', title: 'Session fermée', text: 'Le navigateur a été fermé après une période d’inactivité.', action: 'Rouvrir' },
    evicted: { icon: 'clock', title: 'Session fermée', text: 'Le navigateur a été libéré pour laisser la place à un autre utilisateur.', action: 'Rouvrir' },
    busy: { icon: 'server-stack', title: 'Serveur occupé', text: 'Trop de navigateurs sont ouverts sur ce serveur. Réessaie dans quelques minutes.', action: 'Réessayer' },
    disabled: { icon: 'no-symbol', title: 'Vue C411 désactivée', text: 'La vue C411 intégrée est désactivée sur ce serveur.', action: '' },
    unavailable: { icon: 'exclamation-triangle', title: 'Navigateur indisponible', text: 'Le navigateur distant ne répond pas. Vérifie que le conteneur « browser » tourne.', action: 'Réessayer' },
    browser_lost: { icon: 'exclamation-triangle', title: 'Navigateur arrêté', text: 'Le navigateur distant s’est arrêté. Il redémarre en général tout seul.', action: 'Réessayer' },
    page_lost: { icon: 'exclamation-triangle', title: 'Page fermée', text: 'L’onglet C411 s’est fermé de façon inattendue.', action: 'Rouvrir' },
    shutdown: { icon: 'signal', title: 'Serveur en cours d’arrêt', text: 'Arr411 redémarre. Réessaie dans un instant.', action: 'Réessayer' }
  };
  const LOST = { icon: 'signal', title: 'Connexion perdue', text: 'La connexion avec le serveur a été interrompue.', action: 'Reconnecter' };
  const REFUSED = {
    icon: 'signal',
    title: 'Connexion impossible',
    text: 'Le flux en direct n’a pas pu s’ouvrir. Derrière un proxy inverse, il faut autoriser les WebSockets (voir le README).',
    action: 'Réessayer'
  };

  // ---------- Quick add ----------
  function readB64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
      r.onerror = () => reject(App.mkErr('Lecture du fichier impossible'));
      r.readAsDataURL(file);
    });
  }

  // Keeps only real .torrent files (picked or dropped) and tells the user about the others.
  async function sendFiles(list) {
    const files = [];
    for (const f of list) {
      if (!/\.torrent$/i.test(f.name) && f.type !== 'application/x-bittorrent') {
        App.toast((f.name || 'Fichier') + ' : ce n’est pas un fichier .torrent', 'err');
      } else if (f.size > MAX_TORRENT) {
        App.toast(f.name + ' : trop gros pour un .torrent', 'err');
      } else {
        files.push({ name: f.name, base64: await readB64(f) });
      }
    }
    if (files.length) App.handleShared({ files: files });
  }

  // A .torrent file or a magnet / page link dropped anywhere in the app goes through the same path as a share.
  function listenDrops() {
    document.addEventListener('dragover', (e) => {
      if (e.dataTransfer) e.preventDefault();
    });
    document.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      if (!dt) return;
      const files = Array.from(dt.files || []);
      const inField = e.target && e.target.closest && e.target.closest('input, textarea');
      if (inField && !files.length) return;
      e.preventDefault();
      if (files.length) return App.run(() => sendFiles(files));
      const text = (dt.getData('text/uri-list') || dt.getData('text/plain') || '').trim();
      if (text) App.handleShared({ text: text });
    });
  }

  // Text box and file picker; onSent runs once something was handed over.
  function quickAdd(onSent) {
    const text = h('textarea.input', { placeholder: 'magnet:?xt=urn:btih:…\nhttps://www.imdb.com/title/tt…', autocapitalize: 'off', spellcheck: 'false' });
    const sent = () => {
      if (onSent) onSent();
    };
    const add = () => {
      const v = text.value.trim();
      if (!v) return;
      text.value = '';
      sent();
      App.handleShared({ text: v });
    };
    const picker = h('input', { type: 'file', accept: '.torrent,application/x-bittorrent', multiple: true, style: { display: 'none' } });
    picker.addEventListener('change', () => App.run(() => {
      const list = Array.from(picker.files || []);
      picker.value = '';
      sent();
      return sendFiles(list);
    }));
    const canRegister = typeof navigator.registerProtocolHandler === 'function' && window.isSecureContext;
    const magnetBtn = canRegister
      ? App.btn('Ouvrir les liens magnet avec Arr411', {
          icon: 'link',
          cls: 'block',
          onClick: () => {
            navigator.registerProtocolHandler('magnet', location.origin + '/share?text=%s');
            App.toast('Accepte la demande de ton navigateur pour activer les liens magnet', 'ok');
          }
        })
      : null;
    return h('div',
      App.field(null, text, 'Lien magnet, URL de fichier .torrent, lien C411, IMDb, TMDB, TVDB ou MusicBrainz, ou simple titre.'),
      h('div.btn-row',
        App.btn('Ajouter', { cls: 'pri', icon: 'plus', onClick: add }),
        App.btn('Choisir un fichier .torrent', { icon: 'document', onClick: () => picker.click() })),
      picker,
      h('div.hint', { style: { marginTop: '10px' } }, 'Tu peux aussi glisser-déposer un fichier .torrent ou un lien n’importe où dans l’application.'),
      magnetBtn ? h('div', { style: { marginTop: '12px' } }, magnetBtn) : null);
  }

  // ---------- Launcher (no remote browser) ----------
  function buildLauncher(retry) {
    const top = h('div');
    const q = App.input({ type: 'search', placeholder: 'Titre, artiste, saison…', enterkeyhint: 'search' });
    const search = () => {
      const v = q.value.trim();
      if (v) App.c411Search(v);
    };
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') search();
    });
    const el = h('div.scroll',
      top,
      h('div.card',
        h('div.card-t', App.icon('magnifying-glass'), h('span', 'Rechercher sur C411')),
        App.field(null, q, 'C411 s’ouvre dans un nouvel onglet : le site refuse d’être affiché à l’intérieur d’une autre page.'),
        h('div.btn-row',
          App.btn('Rechercher', { cls: 'pri', icon: 'magnifying-glass', onClick: search }),
          App.btn('Ouvrir C411', { icon: 'arrow-top-right-on-square', onClick: () => App.openExternal('https://c411.org/') }))),
      h('div.card',
        h('div.card-t', App.icon('plus'), h('span', 'Ajout rapide')),
        quickAdd()),
      App.note('Sur téléphone, ajoute Arr411 à l’écran d’accueil depuis le menu du navigateur : l’application apparaît ensuite dans le menu Partager pour envoyer un lien C411, IMDb, TMDB… directement ici.'));
    return {
      el: el,
      // reason: why the embedded browser is not used (null = switched off on this server).
      setReason(reason) {
        if (reason == null) {
          App.fill(top, App.note('La vue C411 intégrée n’est pas activée sur ce serveur.'));
          return;
        }
        App.fill(top,
          App.note('Le navigateur intégré est indisponible pour le moment' + (reason ? ' (' + reason + ')' : '') + '.', 'warn'),
          h('div.btn-row', { style: { marginBottom: '12px' } }, App.btn('Réessayer', { icon: 'arrow-path', onClick: retry })));
      }
    };
  }

  // ---------- Live link ----------
  function wsUrl() {
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/c411/ws';
  }

  // One WebSocket at a time; handlers of a replaced socket are detached so a late event can never act on the new one.
  function createLink(on) {
    let ws = null;
    function drop() {
      const s = ws;
      ws = null;
      if (!s) return;
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      try {
        s.close(1000);
      } catch (e) { /* already closed */ }
    }
    return {
      connect() {
        drop();
        let s;
        try {
          s = new WebSocket(wsUrl());
        } catch (e) {
          setTimeout(() => on.close({ code: 1006 }), 0);
          return;
        }
        ws = s;
        s.binaryType = 'arraybuffer';
        s.onopen = () => {
          if (ws === s) on.open();
        };
        s.onmessage = (ev) => {
          if (ws !== s) return;
          if (typeof ev.data !== 'string') return on.frame(ev.data);
          let m = null;
          try {
            m = JSON.parse(ev.data);
          } catch (e) {
            return;
          }
          if (m && typeof m === 'object') on.message(m);
        };
        s.onclose = (ev) => {
          if (ws !== s) return;
          ws = null;
          on.close({ code: ev.code });
        };
        s.onerror = () => { /* the close event follows */ };
      },
      send(obj) {
        if (!ws || ws.readyState !== 1) return false;
        ws.send(JSON.stringify(obj));
        return true;
      },
      close: drop
    };
  }

  const mods = (e) => {
    // AltGr types a character: it is not Alt + Ctrl
    if (e.getModifierState && e.getModifierState('AltGraph')) return e.shiftKey ? 8 : 0;
    return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const r1 = (v) => Math.round(v * 10) / 10;
  const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

  function hostOf(url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'chrome-error:') return 'Page indisponible';
      return u.host;
    } catch (e) {
      return '';
    }
  }

  C.init = function () {
    const tabs = document.getElementById('tabs');
    const launcher = buildLauncher(() => App.run(() => show(true)));
    const link = createLink({ open: onOpen, message: onMessage, frame: onFrame, close: onClose });

    // ---------- Screen ----------
    const canvas = h('canvas.c411-canvas', { role: 'img', 'aria-label': 'Navigateur C411' });
    const ctx = canvas.getContext('2d', { alpha: false });
    const proxy = h('textarea.c411-proxy', {
      rows: '1',
      autocomplete: 'off',
      autocapitalize: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
      'aria-label': 'Saisie au clavier pour le navigateur C411',
      'data-lpignore': 'true',
      'data-1p-ignore': 'true'
    });
    const progress = h('div.c411-progress.hidden');
    const overlay = h('div.c411-overlay');
    const stage = h('div.c411-stage', canvas, proxy, progress, overlay);

    const back = App.iconBtn('chevron-left', 'Page précédente', () => nav('back'));
    const fwd = App.iconBtn('chevron-right', 'Page suivante', () => nav('forward'));
    const reload = App.iconBtn('arrow-path', 'Recharger', () => nav('reload'));
    const home = App.iconBtn('home', 'Accueil C411', () => nav('home'));
    const lockEl = App.icon('lock-closed');
    const hostEl = h('span.host');
    const titleEl = h('span.ttl');
    const addr = h('div.c411-addr', lockEl, hostEl, titleEl);
    const kbBtn = App.iconBtn('keyboard', 'Clavier', () => toggleKeyboard());
    const addBtn = App.iconBtn('plus', 'Ajout rapide', () => {
      const s = App.sheet({ title: 'Ajout rapide', body: quickAdd(() => s.close()) });
    });
    const bar = h('div.c411-bar', back, fwd, reload, home, addr, addBtn, kbBtn);
    // Pressing a button of the bar must not take the focus away from the typing proxy.
    bar.addEventListener('mousedown', (e) => e.preventDefault());
    const page = App.page({ title: 'C411', subtitle: 'Recherche et ajout rapide' });
    page.el.classList.add('c411-page');
    page.el.append(bar, stage, launcher.el);

    // ---------- State ----------
    let mode = 'boot'; // boot | view | launcher
    let enabled = null; // null until the server answered
    let checkedAt = 0;
    let checking = null;
    let state = 'idle'; // idle | connecting | live
    let opened = false; // the server confirmed the view on this socket
    let everLive = false; // a stream has worked at least once since the page was loaded
    let shown = false; // a frame was drawn on this socket
    let ended = null; // the server ended the stream on purpose
    let view = null;
    let retries = 0;
    let retryTimer = null;
    let leaveTimer = null;
    let pingTimer = null;
    let pending = null; // { url, at }: a page to open as soon as the stream is up
    let status = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false };
    let lastSize = null;
    const downKeys = new Map();
    let mirror = SENT;
    let composing = false;
    let kbWanted = false;

    const wantLive = () => mode === 'view' && App.visible('c411');
    const setState = (s) => {
      state = s;
      stage.dataset.state = s;
      renderStatus();
    };
    const send = (m) => state === 'live' && link.send(m);
    const nav = (a) => send({ t: 'nav', a: a });

    function wide() {
      tabs.classList.toggle('c411-wide', App.state.tab === 'c411' && mode !== 'launcher');
    }

    function setMode(m, reason) {
      mode = m;
      const live = m !== 'launcher';
      page.head.classList.toggle('hidden', live);
      bar.classList.toggle('hidden', !live);
      stage.classList.toggle('hidden', !live);
      launcher.el.classList.toggle('hidden', live);
      if (!live) {
        disconnect();
        launcher.setReason(reason);
      }
      wide();
    }

    // ---------- Overlay ----------
    function waiting(text) {
      App.fill(overlay, h('div.c411-wait', h('div.spin'), h('div', text || 'Ouverture du navigateur…')));
      overlay.classList.remove('hidden');
    }
    function hideOverlay() {
      overlay.classList.add('hidden');
      App.clear(overlay);
    }
    function blocked(spec, serverText) {
      App.fill(overlay, App.empty(spec.icon, spec.title, spec.text || serverText || '', spec.action
        ? [App.btn(spec.action, { cls: 'pri', icon: 'arrow-path', onClick: () => show(true) })]
        : []));
      overlay.classList.remove('hidden');
    }
    hideOverlay();

    // ---------- Status check ----------
    // Asks the server whether the remote browser is switched on and answering. A lost login redirects to the login page.
    function check() {
      if (checking) return checking;
      checking = (async () => {
        let st;
        try {
          st = await App.api('GET', '/api/c411/status');
        } catch (e) {
          st = { enabled: true, available: false, reason: e.message };
        }
        checkedAt = Date.now();
        enabled = !!(st && st.enabled);
        const ok = enabled && !!st.available;
        if (ok) {
          if (mode !== 'view') setMode('view');
        } else {
          setMode('launcher', enabled ? String((st && st.reason) || '').slice(0, 160) : null);
        }
        return ok;
      })().finally(() => {
        checking = null;
      });
      return checking;
    }

    function ensure() {
      const fresh = Date.now() - checkedAt < STALE_MS;
      if (mode === 'view' && fresh) return Promise.resolve(true);
      if (mode === 'launcher' && (enabled === false || fresh)) return Promise.resolve(false);
      return check();
    }

    // ---------- Connection ----------
    function connect() {
      if (state !== 'idle') return;
      clearTimeout(retryTimer);
      retryTimer = null;
      ended = null;
      opened = false;
      shown = false;
      setState('connecting');
      waiting();
      link.connect();
    }

    function disconnect() {
      clearTimeout(retryTimer);
      retryTimer = null;
      clearInterval(pingTimer);
      pingTimer = null;
      releaseInput();
      link.close();
      if (state !== 'idle') setState('idle');
    }

    // forced: the person pressed a button, so a stream ended on purpose may be reopened.
    async function show(forced) {
      if (forced) {
        ended = null;
        retries = 0;
        checkedAt = 0;
      }
      clearTimeout(leaveTimer);
      leaveTimer = null;
      if (state !== 'idle') return;
      if (ended && ended.sticky) return;
      if (!(await ensure()) || !wantLive()) return;
      connect();
    }

    function onOpen() {
      const s = stageSize();
      lastSize = s;
      link.send({ t: 'hello', w: s.w, h: s.h, dpr: Math.min(3, Math.round((window.devicePixelRatio || 1) * 100) / 100) });
    }

    function onMessage(m) {
      switch (m.t) {
        case 'view': {
          const w = +m.w;
          const hh = +m.h;
          if (!(w > 0 && hh > 0)) return;
          view = { w: Math.round(w), h: Math.round(hh) };
          opened = true;
          everLive = true;
          retries = 0;
          layout();
          if (state !== 'live') {
            setState('live');
            clearInterval(pingTimer);
            pingTimer = setInterval(() => link.send({ t: 'ping' }), PING_MS);
            setTimeout(() => {
              if (state === 'live' && !shown) hideOverlay();
            }, 1500);
          }
          flushGoto();
          break;
        }
        case 'status':
          onStatus(m);
          break;
        case 'toast':
          if (m.text) App.toast(String(m.text).slice(0, 300), m.level === 'error' || m.level === 'warn' ? 'err' : m.level === 'ok' || m.level === 'success' ? 'ok' : undefined);
          break;
        case 'kicked':
        case 'idle':
        case 'error': {
          const code = typeof m.code === 'string' ? m.code : m.t === 'idle' ? 'idle' : m.t === 'kicked' ? 'replaced' : '';
          if (code === 'signed_out') return relogin();
          const spec = ENDED[code] || { icon: 'exclamation-triangle', title: 'Connexion interrompue', action: 'Reconnecter' };
          ended = { code: code, sticky: !!spec.sticky };
          blocked(spec, typeof m.text === 'string' ? m.text.slice(0, 300) : '');
          // The feature was switched off: the status tells whether the launcher should take over.
          if (code === 'disabled') {
            App.run(() => {
              checkedAt = 0;
              return check();
            });
          }
          break;
        }
        default:
          break;
      }
    }

    function onClose(ev) {
      clearInterval(pingTimer);
      pingTimer = null;
      releaseInput();
      setState('idle');
      if (ended) return;
      if (ev && ev.code === 4401) return relogin();
      if (!wantLive()) return;
      // A stream that never started points at the WebSockets (proxy, login) rather than at a network blip.
      if (!opened && !everLive) return App.run(refused);
      if (retries < RETRY_MS.length) {
        waiting('Reconnexion…');
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (wantLive()) connect();
        }, RETRY_MS[retries++]);
        return;
      }
      blocked(LOST);
    }

    // The socket closed before the stream started: find out whether the feature went away or the socket was refused.
    async function refused() {
      checkedAt = 0;
      const ok = await check();
      if (ok && mode === 'view' && state === 'idle' && !ended) blocked(REFUSED);
    }

    // The server dropped the login: the status call below is answered 401, which redirects to the login page.
    async function relogin() {
      try {
        await App.api('GET', '/api/c411/status');
      } catch (e) { /* the overlay below explains */ }
      blocked(LOST);
    }

    // ---------- Navigation bar ----------
    function onStatus(m) {
      status = {
        url: typeof m.url === 'string' ? m.url.slice(0, 2048) : '',
        title: typeof m.title === 'string' ? m.title.slice(0, 300) : '',
        loading: !!m.loading,
        canGoBack: !!m.canGoBack,
        canGoForward: !!m.canGoForward
      };
      renderStatus();
    }

    function renderStatus() {
      const on = state === 'live';
      back.disabled = !on || !status.canGoBack;
      fwd.disabled = !on || !status.canGoForward;
      reload.disabled = !on;
      home.disabled = !on;
      kbBtn.disabled = !on;
      hostEl.textContent = hostOf(status.url);
      titleEl.textContent = status.title;
      addr.title = status.url;
      lockEl.classList.toggle('hidden', !/^https:/i.test(status.url));
      progress.classList.toggle('hidden', !(on && status.loading));
    }

    // ---------- Drawing ----------
    function stageSize() {
      return { w: stage.clientWidth || 1024, h: stage.clientHeight || 700 };
    }

    function layout() {
      if (!view) return;
      const sw = stage.clientWidth;
      const sh = stage.clientHeight;
      if (!sw || !sh) return;
      const k = Math.min(sw / view.w, sh / view.h);
      canvas.style.width = Math.max(1, Math.floor(view.w * k)) + 'px';
      canvas.style.height = Math.max(1, Math.floor(view.h * k)) + 'px';
    }

    const sendResize = App.debounce(() => {
      if (state !== 'live') return;
      const s = stageSize();
      if (lastSize && s.w === lastSize.w && s.h === lastSize.h) return;
      lastSize = s;
      link.send({ t: 'resize', w: s.w, h: s.h });
    }, 250);
    new ResizeObserver(() => {
      layout();
      sendResize();
    }).observe(stage);

    let latest = null;
    let drawing = false;
    function onFrame(buf) {
      latest = buf;
      if (!drawing) pump();
    }
    async function pump() {
      drawing = true;
      while (latest) {
        const buf = latest;
        latest = null;
        try {
          await draw(buf);
        } catch (e) { /* a damaged frame is skipped */ }
      }
      drawing = false;
    }
    function decode(blob) {
      if (window.createImageBitmap) return createImageBitmap(blob);
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(url);
          resolve(img);
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error('image'));
        };
        img.src = url;
      });
    }
    async function draw(buf) {
      const img = await decode(new Blob([buf], { type: 'image/jpeg' }));
      const w = img.width;
      const hh = img.height;
      if (canvas.width !== w || canvas.height !== hh) {
        canvas.width = w;
        canvas.height = hh;
      }
      ctx.drawImage(img, 0, 0);
      if (img.close) img.close();
      if (state === 'live' && !shown) {
        shown = true;
        hideOverlay();
      }
    }

    // ---------- Pointer ----------
    const ptr = { x: 0, y: 0, m: 0, bs: 0, queued: false, pressed: false, n: 1, last: null, sx: -1, sy: -1 };

    function toView(e) {
      const r = canvas.getBoundingClientRect();
      if (!view || !r.width || !r.height) return null;
      return {
        x: clamp(((e.clientX - r.left) * view.w) / r.width, 0, view.w - 1),
        y: clamp(((e.clientY - r.top) * view.h) / r.height, 0, view.h - 1)
      };
    }
    function clickCount(p) {
      const now = performance.now();
      const d = ptr.last;
      const n = d && now - d.t < 400 && Math.abs(p.x - d.x) < 6 && Math.abs(p.y - d.y) < 6 ? Math.min(3, d.n + 1) : 1;
      ptr.last = { t: now, x: p.x, y: p.y, n: n };
      return n;
    }
    function sendMove(x, y, m, bs) {
      ptr.sx = x;
      ptr.sy = y;
      send({ t: 'mouse', a: 'move', x: r1(x), y: r1(y), m: m, bs: bs });
    }
    function flushMove() {
      if (!ptr.queued) return;
      ptr.queued = false;
      sendMove(ptr.x, ptr.y, ptr.m, ptr.bs);
    }
    function press(p, e) {
      flushMove();
      // The page sees the pointer arrive before the button goes down (hover menus, tooltips).
      if (p.x !== ptr.sx || p.y !== ptr.sy) sendMove(p.x, p.y, 0, 0);
      ptr.pressed = true;
      ptr.n = clickCount(p);
      ptr.x = p.x;
      ptr.y = p.y;
      send({ t: 'mouse', a: 'down', x: r1(p.x), y: r1(p.y), b: 0, n: ptr.n, m: e ? mods(e) & 8 : 0 });
    }
    function release(p, e) {
      if (!ptr.pressed) return;
      flushMove();
      ptr.pressed = false;
      send({ t: 'mouse', a: 'up', x: r1(p.x), y: r1(p.y), b: 0, n: ptr.n, m: e ? mods(e) & 8 : 0 });
    }

    const wheelAcc = { x: 0, y: 0, dx: 0, dy: 0, queued: false };
    function addWheel(p, dx, dy) {
      wheelAcc.x = p.x;
      wheelAcc.y = p.y;
      wheelAcc.dx += dx;
      wheelAcc.dy += dy;
      if (wheelAcc.queued) return;
      wheelAcc.queued = true;
      requestAnimationFrame(() => {
        wheelAcc.queued = false;
        const dxx = clamp(Math.round(wheelAcc.dx), -1000, 1000);
        const dyy = clamp(Math.round(wheelAcc.dy), -1000, 1000);
        wheelAcc.dx = 0;
        wheelAcc.dy = 0;
        if (dxx || dyy) send({ t: 'mouse', a: 'wheel', x: r1(wheelAcc.x), y: r1(wheelAcc.y), dx: dxx, dy: dyy });
      });
    }

    // One finger: a drag scrolls, a short touch clicks. Other fingers are ignored.
    const touch = { id: null, x0: 0, y0: 0, x: 0, y: 0, moved: false };

    canvas.addEventListener('pointerdown', (e) => {
      if (state !== 'live') return;
      if (e.pointerType === 'touch') {
        if (touch.id !== null) return;
        touch.id = e.pointerId;
        touch.x0 = touch.x = e.clientX;
        touch.y0 = touch.y = e.clientY;
        touch.moved = false;
      } else {
        if (e.button !== 0) return;
        const p = toView(e);
        if (!p) return;
        focusProxy();
        press(p, e);
      }
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch (err) { /* the pointer is already gone */ }
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (state !== 'live') return;
      if (e.pointerType === 'touch') {
        if (e.pointerId !== touch.id) return;
        if (!touch.moved && Math.hypot(e.clientX - touch.x0, e.clientY - touch.y0) < 10) return;
        touch.moved = true;
        const p = toView(e);
        const r = canvas.getBoundingClientRect();
        if (p && r.width) {
          const k = r.width / view.w;
          addWheel(p, -(e.clientX - touch.x) / k, -(e.clientY - touch.y) / k);
        }
        touch.x = e.clientX;
        touch.y = e.clientY;
        return;
      }
      const p = toView(e);
      if (!p) return;
      ptr.x = p.x;
      ptr.y = p.y;
      ptr.m = mods(e) & 8;
      ptr.bs = e.buttons & 1;
      if (!ptr.queued) {
        ptr.queued = true;
        requestAnimationFrame(flushMove);
      }
    });
    function pointerEnd(e) {
      if (e.pointerType === 'touch') {
        if (e.pointerId !== touch.id) return;
        touch.id = null;
        if (e.type === 'pointerup' && !touch.moved && state === 'live') {
          const p = toView(e);
          if (p) {
            press(p, null);
            release(p, null);
          }
        }
      } else {
        const p = toView(e);
        if (p) release(p, e);
        else if (ptr.pressed) release({ x: ptr.x, y: ptr.y }, e);
      }
      if (kbWanted) focusProxy();
    }
    canvas.addEventListener('pointerup', pointerEnd);
    canvas.addEventListener('pointercancel', pointerEnd);
    canvas.addEventListener('click', () => {
      if (kbWanted) focusProxy();
    });
    canvas.addEventListener('lostpointercapture', (e) => {
      if (e.pointerType !== 'touch' && ptr.pressed) release({ x: ptr.x, y: ptr.y }, null);
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (state !== 'live') return;
      const p = toView(e);
      if (!p) return;
      const f = e.deltaMode === 1 ? WHEEL_LINE : e.deltaMode === 2 ? view.h : 1;
      addWheel(p, e.deltaX * f, e.deltaY * f);
    }, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // Keeps the focus on the keyboard proxy when a click lands on the canvas.
    canvas.addEventListener('mousedown', (e) => e.preventDefault());

    // ---------- Keyboard ----------
    // A hidden text area receives the typing. Real keys are relayed one by one; whatever an on-screen keyboard or an input
    // method puts into the text area (composition, dead keys) is relayed as the difference with what was already sent.
    function focusProxy() {
      kbWanted = true;
      try {
        proxy.focus({ preventScroll: true });
        const n = proxy.value.length;
        proxy.setSelectionRange(n, n);
      } catch (e) { /* hidden */ }
    }
    function toggleKeyboard() {
      if (document.activeElement === proxy) {
        kbWanted = false;
        proxy.blur();
      } else {
        focusProxy();
      }
    }
    function resetMirror() {
      mirror = SENT;
      proxy.value = SENT;
    }
    function tap(key, kc) {
      send({ t: 'key', a: 'down', key: key, code: key, kc: kc, m: 0, r: false });
      send({ t: 'key', a: 'up', key: key, code: key, kc: kc, m: 0 });
    }
    function syncText() {
      const v = proxy.value;
      if (v === mirror) return;
      let p = 0;
      const max = Math.min(v.length, mirror.length);
      while (p < max && v.charCodeAt(p) === mirror.charCodeAt(p)) p++;
      // never cut a surrogate pair in two
      while (p > 0 && ((p < v.length && isLow(v.charCodeAt(p))) || (p < mirror.length && isLow(mirror.charCodeAt(p))))) p--;
      const del = Math.min(60, Array.from(mirror.slice(p)).length);
      for (let i = 0; i < del; i++) tap('Backspace', 8);
      const parts = v.slice(p).split(/\r\n|\r|\n/);
      parts.forEach((s, i) => {
        if (s) send({ t: 'text', s: s });
        if (i < parts.length - 1) tap('Enter', 13);
      });
      mirror = v;
    }
    function releaseInput() {
      for (const d of downKeys.values()) link.send({ t: 'key', a: 'up', key: d.key, code: d.code, kc: d.kc, m: 0 });
      downKeys.clear();
      if (ptr.pressed) release({ x: ptr.x, y: ptr.y }, null);
      ptr.queued = false;
      touch.id = null;
    }

    proxy.addEventListener('keydown', (e) => {
      if (state !== 'live') return;
      if (e.isComposing || e.keyCode === 229 || e.key === 'Process' || e.key === 'Dead' || e.key === 'Unidentified') return;
      const k = e.key;
      const named = NAMED.has(k);
      if (!named && Array.from(k).length !== 1) return;
      const m = mods(e);
      if (named ? m & 1 : m & 6 && !SHORTCUTS.has(k.toLowerCase())) return;
      if (!named && m & 6 && m & 1) return;
      e.preventDefault();
      e.stopPropagation();
      const id = e.code || k;
      downKeys.set(id, { key: k, code: e.code || '', kc: e.keyCode || 0 });
      send({ t: 'key', a: 'down', key: k, code: e.code || '', kc: e.keyCode || 0, m: m, r: !!e.repeat });
    });
    proxy.addEventListener('keyup', (e) => {
      const d = downKeys.get(e.code || e.key);
      if (!d) return;
      downKeys.delete(e.code || e.key);
      e.preventDefault();
      e.stopPropagation();
      send({ t: 'key', a: 'up', key: d.key, code: d.code, kc: d.kc, m: mods(e) });
    });
    proxy.addEventListener('compositionstart', () => {
      composing = true;
    });
    proxy.addEventListener('compositionend', () => {
      composing = false;
      if (state === 'live') syncText();
      resetMirror();
    });
    proxy.addEventListener('input', () => {
      if (state !== 'live') return resetMirror();
      syncText();
      if (!composing && proxy.value.length > MAX_MIRROR) resetMirror();
    });
    proxy.addEventListener('paste', (e) => {
      e.preventDefault();
      if (state !== 'live') return;
      const s = e.clipboardData && e.clipboardData.getData('text/plain');
      if (s) send({ t: 'text', s: s.slice(0, 5000) });
    });
    proxy.addEventListener('focus', () => {
      kbBtn.classList.add('on');
      stage.classList.add('typing');
    });
    proxy.addEventListener('blur', () => {
      kbBtn.classList.remove('on');
      stage.classList.remove('typing');
      composing = false;
      resetMirror();
      for (const d of downKeys.values()) link.send({ t: 'key', a: 'up', key: d.key, code: d.code, kc: d.kc, m: 0 });
      downKeys.clear();
    });

    // ---------- Opening a page from the rest of the app ----------
    function flushGoto() {
      if (!pending) return;
      if (Date.now() - pending.at > 60000) {
        pending = null;
        return;
      }
      if (state === 'live' && view) {
        const url = pending.url;
        pending = null;
        link.send({ t: 'goto', url: url });
      }
    }

    // ---------- Tab visibility ----------
    function onVisibility() {
      wide();
      if (App.visible('c411')) {
        App.run(() => show(false));
        return;
      }
      // Typing must not reach the remote page while another tab is shown.
      if (document.activeElement === proxy) proxy.blur();
      if (leaveTimer !== null || mode !== 'view' || (state === 'idle' && retryTimer === null)) return;
      // Leaving the tab, or the whole page being hidden: the stream stops after a while, the remote browser stays.
      leaveTimer = setTimeout(() => {
        leaveTimer = null;
        if (!App.visible('c411')) disconnect();
      }, App.state.tab === 'c411' ? HIDDEN_MS : LEAVE_MS);
    }
    App.on('visibility', onVisibility);

    C.ctl = {
      ensure: ensure,
      goto(url) {
        pending = { url: url, at: Date.now() };
        if (state === 'live') flushGoto();
        // opening a page is an explicit request: it takes the browser back from another screen
        else if (ended && ended.sticky) App.run(() => show(true));
      }
    };

    setMode('view');
    resetMirror();
    waiting();
    stage.dataset.state = 'idle';
    renderStatus();
    App.push('c411', page);
    listenDrops();
  };

  // Opens a C411 page: in the embedded browser when there is one, else in a new browser tab.
  C.open = async function (url) {
    url = String(url || '').trim().replace(/^http:\/\//i, 'https://');
    if (!C.ctl || !/^https:\/\/\S+$/i.test(url)) return App.openExternal(url);
    if (!(await C.ctl.ensure())) return App.openExternal(url);
    App.goTab('c411');
    C.ctl.goto(url);
  };
  App.openC411 = (url) => C.open(url);
})();
