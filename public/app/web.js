/* Web shell: navigation bar, browser back button, Escape key and page visibility. */
(function () {
  'use strict';
  const App = window.App;
  const h = App.h;
  const W = (App.web = {});
  const TABS = [
    { name: 'c411', label: 'C411', icon: 'magnifying-glass' },
    { name: 'radarr', label: 'Radarr', icon: 'film', section: 'radarr' },
    { name: 'sonarr', label: 'Sonarr', icon: 'tv', section: 'sonarr' },
    { name: 'lidarr', label: 'Lidarr', icon: 'musical-note', section: 'lidarr' },
    { name: 'qbit', label: 'qBit', long: 'qBittorrent', icon: 'arrow-down-tray', section: 'qbit' },
    { name: 'settings', label: 'Réglages', icon: 'cog-6-tooth', end: true }
  ];
  const btns = {};
  let marked = null;

  const tabUrl = (tab) => location.pathname + location.search + '#tab=' + tab;

  function select(name) {
    if (name === 'settings') return App.openSettings();
    if (App.state.tab === name) App.popToRoot(name);
    App.showTab(name);
  }

  function buildNav() {
    const nav = document.getElementById('nav');
    nav.appendChild(h('div.brand', h('span', 'Arr'), '411'));
    for (const t of TABS) {
      const b = h('button.nav-btn' + (t.end ? '.end' : ''), { type: 'button', 'data-tab': t.name, 'aria-label': t.long || t.label },
        App.icon(t.icon),
        h('span.lbl', t.long ? [h('span.sh', t.label), h('span.lg', t.long)] : t.label));
      // Registered first so its capture listener can swallow the click that follows a long press.
      if (t.section) {
        App.longPress(b, () => {
          if (App.isAdmin) App.openSettings(t.section);
        });
      }
      b.addEventListener('click', () => select(t.name));
      btns[t.name] = b;
      nav.appendChild(b);
    }
    const badge = h('span.nav-badge.hidden');
    btns.qbit.appendChild(badge);
    App.on('badge', (n) => {
      n = +n || 0;
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.classList.toggle('hidden', n <= 0);
    });
  }

  // Highlights the current tab, remembers it for the "last used tab" setting and keeps it in the URL.
  function mark() {
    const tab = App.state.tab;
    if (tab === marked) return;
    marked = tab;
    for (const k in btns) {
      btns[k].classList.toggle('on', k === tab);
      if (k === tab) btns[k].setAttribute('aria-current', 'page');
      else btns[k].removeAttribute('aria-current');
    }
    if (tab !== 'settings') App.setPref('lastTab', tab);
    history.replaceState(history.state, '', tabUrl(tab));
  }

  // Two history entries: the browser (or Android) back button first closes sheets and pages, then leaves the app.
  function listenBack() {
    if (!(history.state && history.state.app)) {
      history.replaceState({ base: true }, '', location.href);
      history.pushState({ app: true }, '', location.href);
    }
    window.addEventListener('popstate', () => {
      if (App.back()) history.pushState({ app: true }, '', tabUrl(App.state.tab));
      else history.back();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented && App.back()) e.preventDefault();
    });
  }

  W.init = function () {
    buildNav();
    App.on('visibility', mark);
    listenBack();
    App.state.fg = !document.hidden;
    document.addEventListener('visibilitychange', () => App.setForeground(!document.hidden));
  };
})();
