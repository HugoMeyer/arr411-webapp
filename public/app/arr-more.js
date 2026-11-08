/* Arr411 - Radarr, Sonarr & Lidarr: activity (queue, history), calendar, system (health, profiles, root folders, tags, blocklist, logs, tasks) and manual import. */
(function () {
  'use strict';
  const App = window.App;
  const h = App.h;
  const fmt = App.fmt;

  const Q_STATUS = {
    downloading: 'Téléchargement', paused: 'En pause', queued: 'En file', completed: 'Terminé', delay: 'Différé',
    downloadclientunavailable: 'Client indisponible', warning: 'Avertissement', failed: 'Échec', fallback: 'En attente'
  };
  const TD_STATE = {
    importpending: ['Import en attente', 'cyan'], importing: ['Import en cours', 'cyan'], imported: ['Importé', 'green'],
    failedpending: ['Échec en attente', 'red'], failed: ['Échec', 'red'], ignored: ['Ignoré', ''], importblocked: ['Import bloqué', 'amber']
  };
  const HASH_RE = /^[0-9a-f]{40}$/i;
  const trimSlash = (p) => String(p || '').replace(/[\\/]+$/, '');
  const parentOf = (p) => trimSlash(p).replace(/[\\/][^\\/]*$/, '');
  const coll = new Intl.Collator('fr', { sensitivity: 'base', numeric: true }).compare;

  function parseSpan(s) {
    const m = /^(?:(\d+)\.)?(\d+):(\d+):(\d+)/.exec(String(s || ''));
    return m ? (+m[1] || 0) * 86400 + +m[2] * 3600 + +m[3] * 60 + +m[4] : null;
  }
  function qState(r) {
    const td = TD_STATE[String(r.trackedDownloadState || '').toLowerCase()];
    const tds = String(r.trackedDownloadStatus || '').toLowerCase();
    const st = String(r.status || '').toLowerCase();
    if (td) return { label: td[0], color: tds === 'error' ? 'red' : tds === 'warning' ? 'amber' : td[1] };
    if (tds === 'error' || st === 'failed') return { label: st === 'failed' ? 'Échec' : 'Erreur', color: 'red' };
    const label = Q_STATUS[st] || r.status || '';
    if (tds === 'warning' || st === 'warning') return { label: label, color: 'amber' };
    return { label: label, color: st === 'downloading' ? 'blue' : /paused|queued|delay/.test(st) ? '' : 'green' };
  }
  function qMessages(r) {
    const out = [];
    (r.statusMessages || []).forEach((m) => {
      (m.messages && m.messages.length ? m.messages : [m.title]).forEach((x) => {
        if (x && out.indexOf(x) < 0) out.push(x);
      });
    });
    if (r.errorMessage && out.indexOf(r.errorMessage) < 0) out.push(r.errorMessage);
    return out;
  }
  function navItem(ic, label, sub, fn, right) {
    const b = h('button.item', { type: 'button' }, App.icon(ic), h('div.main', h('div.t', label), sub ? h('div.s', sub) : null), right || App.icon('chevron-right', 'sm'));
    b.addEventListener('click', () => App.run(fn));
    return b;
  }
  // Action row that stays disabled while its promise runs.
  function actItem(ic, label, sub, fn, danger) {
    const b = h('button.item' + (danger ? '.danger' : ''), { type: 'button' }, App.icon(ic), h('div.main', h('div.t', label), sub ? h('div.s', sub) : null));
    if (danger) b.style.color = 'var(--red)';
    b.addEventListener('click', () => {
      if (b.disabled) return;
      let r;
      try {
        r = fn();
      } catch (e) {
        return App.err(e);
      }
      if (r && r.then) {
        b.disabled = true;
        r.catch(App.err).then(() => {
          b.disabled = false;
        });
      }
    });
    return b;
  }
  const numInput = (v) => {
    const i = App.input({ type: 'number', inputmode: 'numeric', value: String(v || 0) });
    i.classList.add('score');
    return i;
  };
  const scrollPage = (o) => {
    const page = App.page(Object.assign({ back: true }, o));
    const box = h('div.scroll');
    page.el.appendChild(box);
    return { page: page, box: box };
  };

  App.arrMore = function (M) {
    const svc = M.svc;
    const isR = M.isR;
    const isL = M.isL;
    const U = App.arrUtil;
    const pad = U.pad;
    const COLOR_VAR = U.COLOR_VAR;
    const epCode = (s, e) => 'S' + pad(s) + (e != null ? 'E' + pad(e) : '');
    const mediaOf = (r) => (isR ? r.movie : isL ? r.artist : r.series);
    const mediaIdOf = (r) => (isR ? r.movieId : isL ? r.artistId : r.seriesId) || (mediaOf(r) || {}).id || null;
    const nameOf = (x) => (x && (x.artistName || x.title)) || '';
    const prepped = (x) => {
      if (x && M.prep) M.prep(x);
      return x;
    };
    const metaChanged = () => {
      if (M.cache.meta) M.cache.metaAt = 0;
    };
    const cfgEmpty = (ic) => App.needSetup(ic, M.name, svc, 'Renseigne l’URL et la clé API dans les réglages.');

    M.sections.push(
      { key: 'activity', label: 'Activité', build: buildActivity },
      { key: 'calendar', label: 'Calendrier', build: buildCalendar },
      { key: 'system', label: 'Système', build: buildSystem }
    );

    // ---------- Queue data (shared by the chip counter and the Activité section) ----------
    const queue = { groups: null, error: null, at: 0, keys: new Set() };
    function groupQueue(recs) {
      const map = new Map();
      const out = [];
      recs.forEach((r) => {
        const k = r.downloadId ? 'd:' + r.downloadId : 'i:' + r.id;
        let g = map.get(k);
        if (!g) {
          g = { key: k, recs: [] };
          map.set(k, g);
          out.push(g);
        }
        g.recs.push(r);
      });
      return out;
    }
    function groupTitle(g) {
      const r = g.recs[0];
      const media = mediaOf(r);
      if (!media) return U.cleanName(r.title) || 'Élément inconnu';
      if (isR) return media.title + (media.year ? ' (' + media.year + ')' : '') + (g.recs.length > 1 ? ' +' + (g.recs.length - 1) : '');
      if (isL) {
        const albums = Array.from(new Set(g.recs.map((x) => x.album && x.album.title).filter(Boolean)));
        return nameOf(media) + (albums.length ? ' — ' + albums[0] + (albums.length > 1 ? ' +' + (albums.length - 1) : '') : '');
      }
      const eps = g.recs.map((x) => x.episode).filter(Boolean);
      if (!eps.length) return media.title;
      if (eps.length === 1) return media.title + ' · ' + epCode(eps[0].seasonNumber, eps[0].episodeNumber);
      const seasons = Array.from(new Set(eps.map((e) => e.seasonNumber))).sort((a, b) => a - b);
      return media.title + ' · ' + seasons.map((s) => epCode(s)).join(', ') + ' (' + eps.length + ' ép.)';
    }
    async function fetchQueue() {
      if (!M.configured()) return;
      queue.at = Date.now();
      try {
        const q = isR
          ? { page: 1, pageSize: 200, includeMovie: true, includeUnknownMovieItems: true }
          : isL
            ? { page: 1, pageSize: 200, includeArtist: true, includeAlbum: true, includeUnknownArtistItems: true }
            : { page: 1, pageSize: 200, includeSeries: true, includeEpisode: true, includeUnknownSeriesItems: true };
        const r = await M.api().get('/queue', q);
        const recs = (r && r.records) || (Array.isArray(r) ? r : []);
        queue.groups = groupQueue(recs);
        queue.error = null;
        const keys = new Set(queue.groups.map((g) => g.key));
        let gone = false;
        queue.keys.forEach((k) => {
          if (!keys.has(k)) gone = true;
        });
        queue.keys = keys;
        if (gone && M.cache.items) M.loadLib(true).catch(() => {});
        M.chipCount('activity', queue.groups.length);
        M.chipDot('activity', recs.some((x) => /warning|error/i.test(x.trackedDownloadStatus || '')));
      } catch (e) {
        queue.error = e;
      }
      App.emit(svc + ':queue');
    }
    // Fast refresh while the queue is on screen, slow one for the chip counter otherwise.
    const qLoop = App.loop(fetchQueue, () => {
      if (!App.visible(svc) || !M.configured()) return null;
      const iv = M.isSectionVisible('activity') ? 5000 : 30000;
      return Math.max(0, iv - (Date.now() - queue.at));
    });
    App.on(svc + ':reset', () => {
      Object.assign(queue, { groups: null, error: null, at: 0, keys: new Set() });
      M.chipCount('activity', 0);
      M.chipDot('activity', false);
      App.emit(svc + ':queue');
      if (App.visible(svc)) qLoop.kick();
    });

    async function removeQueue(r, done) {
      const v = await App.confirm({
        title: 'Retirer de la file ?',
        message: M.name + ' arrêtera de suivre ce téléchargement' + (r.title ? ' : « ' + r.title + ' »' : '') + '.',
        ok: 'Retirer',
        danger: true,
        checks: [
          { key: 'client', label: 'Supprimer aussi le torrent dans qBittorrent', checked: false },
          { key: 'block', label: 'Ajouter la release à la liste noire', checked: false }
        ]
      });
      if (!v) return;
      // skipRedownload: never let a removal trigger a new search.
      await M.api().del('/queue/' + r.id, { removeFromClient: v.client, blocklist: v.block, blacklist: v.block, skipRedownload: true });
      if (done) done();
      App.toast('Retiré de la file d’attente', 'ok');
      qLoop.kick();
    }

    // ---------- Activité: queue + history ----------
    function buildActivity() {
      const el = h('div.section');
      let mode = App.pref(svc + '.act', 'queue');
      const seg = App.seg([{ value: 'queue', label: 'File d’attente' }, { value: 'history', label: 'Historique' }], mode, (v) => {
        mode = v;
        App.setPref(svc + '.act', v);
        show();
      });
      seg.style.marginTop = '2px';
      const qBox = h('div');
      const qNote = h('div');
      const qState0 = h('div');
      const qGroup = h('div.group.hidden');
      App.append(qBox, qNote, qState0, qGroup);
      const hBox = h('div.hidden');
      App.append(el, seg, qBox, hBox);
      const rows = new Map();

      function makeRow() {
        const t = h('div.t.nowrap');
        const rel = h('div.s.nowrap');
        const bar = App.bar(0);
        const st = h('span.st');
        const left = h('span');
        const size = h('span');
        const qual = h('span');
        const msgs = h('div.msgs.hidden');
        const row = h('button.item.q-item', { type: 'button' }, h('div.main', t, rel, bar, h('div.meta', st, left, size, qual), msgs));
        let cur = null;
        row.addEventListener('click', () => App.run(() => queueSheet(cur)));
        return {
          el: row,
          set(g) {
            cur = g;
            const r = g.recs[0];
            const s = qState(r);
            row.style.setProperty('--c', COLOR_VAR[s.color] || COLOR_VAR['']);
            t.textContent = groupTitle(g);
            rel.textContent = r.title || '';
            const total = +r.size || 0;
            const done = Math.max(0, total - (+r.sizeleft || 0));
            bar.set(total ? done / total : 0);
            st.textContent = s.label;
            const secs = parseSpan(r.timeleft);
            left.textContent = secs && String(r.status).toLowerCase() === 'downloading' ? fmt.dur(secs) : '';
            size.textContent = total ? (done < total ? fmt.bytes(done) + ' / ' : '') + fmt.bytes(total) : '';
            qual.textContent = U.qualityName(r.quality);
            const m = qMessages(r);
            msgs.textContent = m.join(' · ');
            msgs.classList.toggle('hidden', !m.length);
          }
        };
      }
      function clearRows() {
        rows.clear();
        App.clear(qGroup);
        qGroup.classList.add('hidden');
      }
      function renderQueue() {
        if (!M.configured()) {
          clearRows();
          App.clear(qNote);
          return App.fill(qState0, cfgEmpty('inbox-arrow-down'));
        }
        if (!queue.groups) {
          clearRows();
          App.clear(qNote);
          if (queue.error) {
            return App.fill(qState0, App.empty('exclamation-triangle', 'File d’attente indisponible', queue.error.message, [
              App.btn('Réessayer', { cls: 'pri', icon: 'arrow-path', onClick: fetchQueue })
            ]));
          }
          return App.fill(qState0, App.loading());
        }
        App.fill(qNote, queue.error ? App.note(queue.error.message, 'err') : null);
        if (!queue.groups.length) {
          clearRows();
          return App.fill(qState0, App.empty('inbox-arrow-down', 'Rien en cours', 'Les téléchargements suivis par ' + M.name + ' apparaissent ici jusqu’à leur import.'));
        }
        App.clear(qState0);
        qGroup.classList.remove('hidden');
        const seen = new Set();
        queue.groups.forEach((g, i) => {
          seen.add(g.key);
          let row = rows.get(g.key);
          if (!row) {
            row = makeRow();
            rows.set(g.key, row);
          }
          row.set(g);
          if (qGroup.children[i] !== row.el) qGroup.insertBefore(row.el, qGroup.children[i] || null);
        });
        rows.forEach((row, k) => {
          if (!seen.has(k)) {
            row.el.remove();
            rows.delete(k);
          }
        });
      }
      App.on(svc + ':queue', () => {
        if (mode === 'queue') renderQueue();
      });

      function queueSheet(g) {
        if (!g) return;
        const r = g.recs[0];
        const mid = mediaIdOf(r);
        const hash = HASH_RE.test(r.downloadId || '') ? r.downloadId.toLowerCase() : null;
        const st = qState(r);
        const msgs = qMessages(r);
        let s = null;
        const go = (fn) => () => {
          s.close();
          return fn();
        };
        const secs = parseSpan(r.timeleft);
        const note = msgs.length ? App.note(msgs.join('\n'), st.color === 'red' ? 'err' : 'warn') : null;
        if (note) note.style.whiteSpace = 'pre-line';
        s = App.sheet({
          title: groupTitle(g),
          body: [
            h('div.card', h('div.mono.wrap.sel', r.title || '')),
            note,
            h('div.card', App.kv([
              ['État', st.label],
              ['Progression', r.size ? fmt.pct(1 - (+r.sizeleft || 0) / r.size) + ' de ' + fmt.bytes(r.size) : ''],
              ['Temps restant', secs ? fmt.dur(secs) : ''],
              ['Fin estimée', fmt.dateTime(r.estimatedCompletionTime)],
              ['Qualité', U.qualityName(r.quality)],
              ['Langues', U.langName(r.languages || r.language)],
              [isL ? 'Albums' : 'Épisodes', g.recs.length > 1 ? String(g.recs.length) : ''],
              ['Client', r.downloadClient],
              ['Indexeur', r.indexer],
              ['Dossier', r.outputPath],
              ['Ajouté', fmt.dateTime(r.added)]
            ])),
            h('div.btn-row', [
              mid ? App.btn('Fiche', { icon: M.icon, onClick: go(() => M.openDetails(mid)) }) : null,
              hash && App.qbit && App.qb.configured() ? App.btn('qBittorrent', { icon: 'arrow-down-tray', onClick: go(() => App.qbit.openDetails(hash)) }) : null,
              App.btn('Import manuel', { icon: 'inbox-arrow-down', onClick: go(() => M.openManualImport({ downloadId: r.downloadId, title: r.title, folder: r.outputPath })) }),
              App.btn('C411', { icon: 'magnifying-glass', onClick: () => App.c411Search(U.cleanName(r.title)) })
            ])
          ],
          actions: [App.btn('Retirer de la file', { cls: 'danger', icon: 'trash', onClick: () => removeQueue(r, () => s.close()) })]
        });
      }

      // History (paged)
      const hist = { list: [], page: 0, total: 0, loading: false, error: null, at: 0, seq: 0 };
      const hState = h('div');
      const hList = h('div.group.hidden');
      const hMore = h('div.more');
      App.append(hBox, hState, hList, hMore);
      async function loadHistory(reset) {
        if (!M.configured()) return renderHistory();
        if (hist.loading && !reset) return;
        const my = ++hist.seq;
        const page = reset ? 1 : hist.page + 1;
        hist.loading = true;
        if (reset) hist.error = null;
        renderHistory();
        try {
          const q = { page: page, pageSize: 30, sortKey: 'date', sortDirection: 'descending' };
          if (isR) q.includeMovie = true;
          else if (isL) {
            q.includeArtist = true;
            q.includeAlbum = true;
          } else {
            q.includeSeries = true;
            q.includeEpisode = true;
          }
          const r = await M.api().get('/history', q);
          if (my !== hist.seq) return;
          const recs = (r && r.records) || [];
          hist.list = reset ? recs : hist.list.concat(recs);
          hist.page = page;
          hist.total = (r && r.totalRecords) || hist.list.length;
          hist.error = null;
          hist.at = Date.now();
        } catch (e) {
          if (my !== hist.seq) return;
          hist.error = e;
        }
        hist.loading = false;
        renderHistory();
      }
      function renderHistory() {
        if (!M.configured()) {
          hList.classList.add('hidden');
          App.clear(hMore);
          return App.fill(hState, cfgEmpty('clock'));
        }
        const l = hist.list;
        if (!l.length) {
          hList.classList.add('hidden');
          App.clear(hMore);
          if (hist.loading || !hist.at && !hist.error) return App.fill(hState, App.loading());
          if (hist.error) {
            return App.fill(hState, App.empty('exclamation-triangle', 'Historique indisponible', hist.error.message, [
              App.btn('Réessayer', { cls: 'pri', icon: 'arrow-path', onClick: () => loadHistory(true) })
            ]));
          }
          return App.fill(hState, App.empty('clock', 'Historique vide', 'Les récupérations, imports et suppressions apparaîtront ici.'));
        }
        App.fill(hState, hist.error ? App.note(hist.error.message, 'err') : null);
        if (hList.childElementCount !== l.length) App.fill(hList, l.map((r) => M.historyRow(r, { showMedia: true })));
        hList.classList.remove('hidden');
        App.fill(hMore, hist.loading ? h('div.spin') : l.length < hist.total
          ? App.btn('Charger plus', { cls: 'sm', icon: 'chevron-down', onClick: () => loadHistory(false) })
          : h('span.dim', fmt.plural(l.length, 'événement')));
      }
      App.on(svc + ':reset', () => {
        Object.assign(hist, { list: [], page: 0, total: 0, loading: false, error: null, at: 0 });
        hist.seq++;
        App.clear(hList);
        if (mode === 'history') renderHistory();
      });

      function show() {
        qBox.classList.toggle('hidden', mode !== 'queue');
        hBox.classList.toggle('hidden', mode !== 'history');
        if (mode === 'queue') {
          renderQueue();
          if (M.isSectionVisible('activity')) qLoop.kick();
        } else {
          renderHistory();
          if (!hist.loading && (!hist.at || Date.now() - hist.at > 60000)) {
            App.clear(hList);
            loadHistory(true);
          }
        }
      }
      function moreMenu() {
        const api = M.api();
        App.menu({
          items: [
            { icon: 'arrows-right-left', label: 'Synchroniser avec qBittorrent', sub: 'Relit l’état des téléchargements suivis', onClick: () => M.runCommand('RefreshMonitoredDownloads', {}, { label: 'Synchronisation', wait: true, timeout: 60000 }).then(() => qLoop.kick()) },
            { icon: 'inbox-arrow-down', label: 'Import manuel depuis un dossier…', sub: 'Fichiers déjà présents sur le serveur', onClick: () => promptFolderImport() },
            '-',
            api.web ? { icon: 'arrow-top-right-on-square', label: 'Ouvrir dans l’interface web', onClick: () => App.openExternal(api.web + '/activity/' + mode) } : null
          ]
        });
      }
      return {
        el: el,
        actions: [
          App.iconBtn('arrow-path', 'Actualiser', () => (mode === 'queue' ? fetchQueue() : (App.clear(hList), loadHistory(true)))),
          App.iconBtn('ellipsis-vertical', 'Plus d’actions', moreMenu)
        ],
        init() {
          qBox.classList.toggle('hidden', mode !== 'queue');
          hBox.classList.toggle('hidden', mode !== 'history');
          if (mode === 'queue') renderQueue();
          else renderHistory();
        },
        onShow: show,
        top() {
          el.scrollTo({ top: 0, behavior: 'smooth' });
        }
      };
    }
    async function promptFolderImport() {
      const v = await App.prompt({
        title: 'Import manuel',
        label: 'Dossier sur le serveur',
        placeholder: '/data/torrents/' + (isR ? 'films' : isL ? 'musique' : 'series') + '/…',
        value: App.pref(svc + '.miFolder', ''),
        ok: 'Analyser',
        hint: 'Chemin tel que ' + M.name + ' le voit (dans son conteneur).'
      });
      const f = trimSlash((v || '').trim());
      if (!f) return;
      App.setPref(svc + '.miFolder', f);
      return M.openManualImport({ folder: f, title: f });
    }

    // ---------- Calendrier ----------
    function buildCalendar() {
      const el = h('div.section');
      const box = h('div');
      el.appendChild(box);
      const cal = { back: 0, ahead: 28, data: null, at: 0, seq: 0 };
      const dayStart = (d) => {
        const x = new Date(d);
        x.setHours(0, 0, 0, 0);
        return x;
      };
      async function load() {
        if (!M.configured()) return render();
        const my = ++cal.seq;
        const today = dayStart(Date.now());
        const start = new Date(today.getTime() - cal.back * 86400000);
        const end = new Date(today.getTime() + cal.ahead * 86400000);
        if (!cal.data) render();
        try {
          // unmonitored=true: everything added by Arr411 is unmonitored.
          const q = { start: start.toISOString(), end: end.toISOString(), unmonitored: true };
          if (isL) q.includeArtist = true;
          else if (!isR) {
            q.includeSeries = true;
            q.includeEpisodeFile = false;
          }
          const list = await M.api().get('/calendar', q);
          if (my !== cal.seq) return;
          cal.data = toEvents(Array.isArray(list) ? list : [], start.getTime(), end.getTime());
          cal.at = Date.now();
        } catch (e) {
          if (my !== cal.seq) return;
          cal.data = e;
        }
        render();
      }
      function toEvents(list, s0, e0) {
        const ev = [];
        if (isR) {
          list.forEach((m) => {
            [['inCinemas', 'Sortie au cinéma'], ['digitalRelease', 'Sortie numérique'], ['physicalRelease', 'Sortie Blu-ray / DVD']].forEach((k) => {
              const t = U.ts(m[k[0]]);
              if (t && t >= s0 && t < e0) ev.push({ t: t, item: M.get(m.id) || m, id: m.id, kind: k[1] });
            });
          });
        } else if (isL) {
          list.forEach((a) => {
            const t = U.ts(a.releaseDate);
            if (!t || t < s0 || t >= e0) return;
            const art = M.get(a.artistId) || prepped(a.artist) || { id: a.artistId, title: 'Artiste ' + a.artistId };
            ev.push({ t: t, item: art, id: a.artistId, album: a });
          });
        } else {
          const groups = new Map();
          list.forEach((e) => {
            const t = U.ts(e.airDateUtc) || U.ts(e.airDate);
            if (!t) return;
            const k = dayStart(t).getTime() + ':' + e.seriesId + ':' + e.seasonNumber;
            let g = groups.get(k);
            if (!g) {
              g = { t: t, item: e.series || M.get(e.seriesId) || { id: e.seriesId, title: 'Série ' + e.seriesId }, id: e.seriesId, eps: [] };
              groups.set(k, g);
              ev.push(g);
            }
            g.t = Math.min(g.t, t);
            g.eps.push(e);
          });
        }
        return ev.sort((a, b) => a.t - b.t);
      }
      function render() {
        if (!M.configured()) return App.fill(box, cfgEmpty('calendar-days'));
        const d = cal.data;
        if (!d) return App.fill(box, App.loading());
        if (d instanceof Error) {
          return App.fill(box, App.empty('exclamation-triangle', 'Calendrier indisponible', d.message, [App.btn('Réessayer', { cls: 'pri', icon: 'arrow-path', onClick: load })]));
        }
        const out = [h('div.btn-row', { style: { marginTop: '2px' } }, App.btn(cal.back ? 'Masquer les jours passés' : 'Voir les 7 derniers jours', {
          cls: 'sm',
          icon: cal.back ? 'eye-slash' : 'clock',
          onClick: () => {
            cal.back = cal.back ? 0 : 7;
            return load();
          }
        }))];
        if (!d.length) out.push(App.empty('calendar-days', 'Rien de prévu', (isR ? 'Aucune sortie' : isL ? 'Aucun album' : 'Aucun épisode') + ' dans les ' + cal.ahead + ' prochains jours.'));
        const today = dayStart(Date.now()).getTime();
        let lastDay = null;
        let rowsEl = null;
        d.forEach((e) => {
          const day = dayStart(e.t).getTime();
          if (day !== lastDay) {
            lastDay = day;
            const diff = Math.round((day - today) / 86400000);
            const rel = diff === 0 ? 'Aujourd’hui · ' : diff === 1 ? 'Demain · ' : diff === -1 ? 'Hier · ' : '';
            rowsEl = h('div.rows');
            out.push(h('div.day' + (diff === 0 ? '.today' : ''), rel + fmt.day(day)), rowsEl);
          }
          rowsEl.appendChild(eventRow(e));
        });
        out.push(h('div.more', App.btn('Voir plus loin', {
          cls: 'sm',
          icon: 'chevron-down',
          onClick: () => {
            cal.ahead += 28;
            return load();
          }
        })));
        App.fill(box, out);
      }
      function eventRow(e) {
        const x = e.item;
        let t;
        let s;
        let code = '';
        const badges = [];
        if (isR) {
          t = x.title + (x.year ? ' (' + x.year + ')' : '');
          s = e.kind;
          const st = M.status(x);
          badges.push(App.badge(st.label, st.color));
        } else if (isL) {
          const a = e.album;
          const st = a.statistics || {};
          const tot = st.totalTrackCount || st.trackCount || 0;
          t = nameOf(x);
          code = a.title || '';
          s = code + (a.albumType && a.albumType !== 'Album' ? ' · ' + a.albumType : '') + (tot ? ' · ' + fmt.plural(tot, 'piste') : '');
          if (tot && st.trackFileCount >= tot) badges.push(App.badge('Téléchargé', 'green', 'check'));
          else if (st.trackFileCount) badges.push(App.badge(st.trackFileCount + '/' + tot + ' pistes', 'amber'));
          else if (e.t <= Date.now()) badges.push(App.badge('Manquant', 'amber'));
        } else {
          const eps = e.eps.slice().sort((a, b) => a.episodeNumber - b.episodeNumber);
          const first = eps[0];
          const last = eps[eps.length - 1];
          t = x.title;
          code = eps.length > 1 ? epCode(first.seasonNumber, first.episodeNumber) + '–E' + pad(last.episodeNumber) : epCode(first.seasonNumber, first.episodeNumber);
          s = code + (eps.length === 1 ? (first.title ? ' · ' + first.title : '') : ' · ' + eps.length + ' épisodes');
          const have = eps.filter((ep) => ep.hasFile).length;
          badges.push(App.badge(fmt.time(e.t), '', 'clock'));
          if (have === eps.length) badges.push(App.badge('Téléchargé', 'green', 'check'));
          else if (e.t <= Date.now()) badges.push(App.badge(have ? have + '/' + eps.length + ' ép.' : 'Manquant', 'amber'));
          if (first.episodeNumber === 1) badges.push(App.badge(first.seasonNumber === 1 ? 'Première' : 'Nouvelle saison', 'blue'));
          const fin = eps.map((ep) => ep.finaleType).filter(Boolean)[0];
          if (fin) badges.push(App.badge(fin === 'series' ? 'Fin de série' : fin === 'midseason' ? 'Mi-saison' : 'Fin de saison', 'violet'));
        }
        const b = h('button.lrow', { type: 'button' }, M.poster(isL ? e.album : x, 250), h('div.main', h('div.t', t), h('div.s.nowrap', s), h('div.badges', { style: { marginTop: '6px' } }, badges)), App.icon('chevron-right', 'sm'));
        const open = () => M.openDetails(e.id, isL ? { album: e.album.id } : undefined);
        b.addEventListener('click', () => App.run(open));
        App.longPress(b, () => App.menu({
          title: t,
          items: [
            { icon: 'magnifying-glass', label: 'Chercher sur C411', sub: code || null, onClick: () => M.searchC411(x, code.replace(/–E\d+$/, '')) },
            { icon: M.icon, label: 'Ouvrir la fiche', onClick: open }
          ]
        }));
        return b;
      }
      App.on(svc + ':reset', () => {
        Object.assign(cal, { data: null, at: 0 });
        cal.seq++;
        render();
      });
      return {
        el: el,
        actions: [App.iconBtn('arrow-path', 'Actualiser', load)],
        init: render,
        onShow() {
          if (!cal.data || cal.data instanceof Error || Date.now() - cal.at > 300000) load();
        },
        top() {
          el.scrollTo({ top: 0, behavior: 'smooth' });
        }
      };
    }

    // ---------- Système ----------
    function buildSystem() {
      const el = h('div.section');
      const box = h('div');
      const tools = h('div');
      App.append(el, box, tools);
      const sys = { data: null, at: 0, seq: 0 };
      async function load() {
        if (!M.configured()) return render();
        const my = ++sys.seq;
        if (!sys.data) render();
        const api = M.api();
        try {
          const r = await Promise.all([
            api.get('/system/status'),
            api.get('/health').catch(() => []),
            api.get('/diskspace').catch(() => []),
            api.get('/rootfolder').catch(() => [])
          ]);
          if (my !== sys.seq) return;
          sys.data = { status: r[0] || {}, health: r[1] || [], disks: r[2] || [], roots: r[3] || [] };
          sys.at = Date.now();
          M.chipDot('system', sys.data.health.some((x) => String(x.type).toLowerCase() === 'error'));
        } catch (e) {
          if (my !== sys.seq) return;
          sys.data = e;
        }
        render();
      }
      function diskRows(d) {
        const disks = d.disks.filter((k) => k.totalSpace > 0);
        const used = new Map();
        d.roots.forEach((r) => {
          const p = trimSlash(r.path) + '/';
          let best = null;
          let len = -1;
          disks.forEach((k) => {
            const kp = trimSlash(k.path) + '/';
            if (p.indexOf(kp) === 0 && kp.length > len) {
              best = k;
              len = kp.length;
            }
          });
          if (!best) return;
          const e = used.get(best) || { disk: best, roots: [] };
          e.roots.push(trimSlash(r.path));
          used.set(best, e);
        });
        const list = used.size ? Array.from(used.values()) : disks.map((k) => ({ disk: k, roots: [] }));
        return list.map((e) => {
          const k = e.disk;
          const f = 1 - k.freeSpace / k.totalSpace;
          return h('div.disk',
            h('div.row1', h('span.nowrap', e.roots.length ? e.roots.join(', ') : k.label || k.path), h('span.dim', { style: { flex: 'none' } }, fmt.bytes(k.freeSpace) + ' libres / ' + fmt.bytes(k.totalSpace))),
            App.bar(f, f > 0.92 ? 'var(--red)' : f > 0.8 ? 'var(--amber)' : null));
        });
      }
      function healthNote(x) {
        const t = String(x.type || '').toLowerCase();
        const n = App.note(x.message || x.source || '', t === 'error' ? 'err' : t === 'warning' ? 'warn' : '');
        const wiki = typeof x.wikiUrl === 'string' ? x.wikiUrl : x.wikiUrl && (x.wikiUrl.fullUri || x.wikiUrl.uri);
        if (wiki) {
          n.lastChild.appendChild(h('div', { style: { marginTop: '4px', fontWeight: '650', textDecoration: 'underline' } }, 'En savoir plus'));
          n.addEventListener('click', () => App.openExternal(wiki));
        }
        return n;
      }
      function render() {
        if (!M.configured()) {
          App.clear(tools);
          return App.fill(box, cfgEmpty('server-stack'));
        }
        const d = sys.data;
        if (!d) return App.fill(box, App.loading());
        if (d instanceof Error) {
          App.clear(tools);
          return App.fill(box, App.empty('exclamation-triangle', M.name + ' injoignable', d.message, [
            App.btn('Réessayer', { cls: 'pri', icon: 'arrow-path', onClick: load }),
            App.btn('Réglages', { icon: 'cog-6-tooth', onClick: () => App.openSettings(svc) })
          ]));
        }
        const s = d.status;
        const disks = diskRows(d);
        App.fill(box,
          h('div.card', { style: { marginTop: '2px' } },
            h('div.card-t', App.icon('server-stack'), h('span', M.name + (s.version ? ' ' + s.version : ''))),
            App.kv([
              ['Démarré', s.startTime ? fmt.dateTime(s.startTime) + ' (' + fmt.rel(s.startTime) + ')' : ''],
              ['Système', [s.osName, s.osVersion].filter(Boolean).join(' ') + (s.isDocker ? ' · Docker' : '')],
              ['Runtime', [s.runtimeName, s.runtimeVersion].filter(Boolean).join(' ')],
              ['Branche', s.branch],
              ['Base de données', [s.databaseType, s.databaseVersion].filter(Boolean).join(' ')],
              ['URL', M.api().web]
            ])),
          App.secTitle('Santé'),
          d.health.length ? d.health.map(healthNote) : App.note('Aucun problème détecté.', '', 'check-circle'),
          disks.length ? [App.secTitle('Espace disque'), h('div.card', disks)] : null);
        renderTools();
      }
      function renderTools() {
        const web = M.api().web;
        App.fill(tools,
          App.secTitle('Gestion'),
          h('div.group',
            App.isAdmin ? navItem('adjustments-horizontal', 'Profils de qualité', 'Qualités, formats personnalisés, seuils', openProfiles) : null,
            App.isAdmin ? (M.sysTools || []).map((t) => navItem(t.icon, t.label, t.sub, t.fn)) : null,
            App.isAdmin ? navItem('folder', 'Dossiers racine', isL ? 'Espace libre, profils par défaut' : 'Espace libre, dossier par défaut, import de l’existant', openRoots) : null,
            App.isAdmin ? navItem('tag', 'Étiquettes', 'Créer, renommer, supprimer', openTags) : null,
            navItem('x-circle', 'Liste noire', 'Releases bloquées', openBlocklist),
            App.isAdmin ? navItem('document-text', 'Journal', 'Événements, avertissements et erreurs', openLogs) : null,
            navItem('clock', 'Tâches planifiées', 'Dernière et prochaine exécution', openTasks)),
          App.secTitle('Actions'),
          h('div.group',
            actItem('eye-slash', 'Tout passer en non surveillé', 'Garantit que ' + M.name + ' ne télécharge jamais rien de lui-même', unmonitorAll),
            actItem('arrow-path', 'Actualiser toutes les fiches', 'Met à jour les métadonnées', () => M.runCommand(M.refreshCmd, {}, { label: 'Actualisation' })),
            actItem('folder-open', 'Rescanner les dossiers', 'Détecte les fichiers ajoutés ou supprimés', () => M.runCommand(isR ? 'RescanMovie' : isL ? 'RescanFolders' : 'RescanSeries', {}, { label: 'Rescan' })),
            actItem('shield-check', 'Vérifier la santé', null, () => M.runCommand('CheckHealth', {}, { label: 'Vérification', wait: true, timeout: 60000 }).then(load)),
            actItem('circle-stack', 'Sauvegarder maintenant', 'Sauvegarde de la base ' + M.name, () => M.runCommand('Backup', {}, { label: 'Sauvegarde', wait: true, timeout: 180000 })),
            web ? actItem('arrow-top-right-on-square', 'Ouvrir l’interface web', null, () => App.openExternal(web)) : null));
      }
      App.on(svc + ':reset', () => {
        Object.assign(sys, { data: null, at: 0 });
        sys.seq++;
        M.chipDot('system', false);
        render();
      });
      return {
        el: el,
        actions: [App.iconBtn('arrow-path', 'Actualiser', load)],
        init: render,
        onShow() {
          if (!sys.data || sys.data instanceof Error || Date.now() - sys.at > 60000) load();
        },
        top() {
          el.scrollTo({ top: 0, behavior: 'smooth' });
        }
      };
    }

    // Safety net: everything must stay unmonitored so the *arr apps never grab on their own.
    async function unmonitorAll() {
      await M.loadLib(true);
      const items = M.cache.items || [];
      const api = M.api();
      const mon = isR ? items.filter((x) => x.monitored)
        : isL ? items.filter((x) => x.monitored || (x.monitorNewItems && x.monitorNewItems !== 'none'))
          : items.filter((x) => x.monitored || (x.seasons || []).some((s) => s.monitored) || (x.monitorNewItems && x.monitorNewItems !== 'none'));
      const albums = isL ? ((await api.get('/album')) || []).filter((a) => a.monitored) : [];
      if (!mon.length && !albums.length) return App.toast('Tout est déjà en non surveillé', 'ok');
      const n = mon.length + albums.length;
      const what = [mon.length ? fmt.plural(mon.length, M.noun) : '', albums.length ? fmt.plural(albums.length, 'album') : ''].filter(Boolean).join(' et ');
      const agree = (albums.length ? '' : M.e) + (n > 1 ? 's' : '');
      const ok = await App.confirm({
        title: 'Tout passer en non surveillé ?',
        message: what + ' encore surveillé' + agree + '. Après ça, ' + M.name + ' ne lancera plus aucune recherche ni téléchargement automatique.',
        ok: 'Appliquer'
      });
      if (!ok) return;
      if (isR) {
        await api.put('/movie/editor', { movieIds: mon.map((x) => x.id), monitored: false });
      } else if (isL) {
        if (mon.length) {
          try {
            await api.put('/artist/editor', { artistIds: mon.map((x) => x.id), monitored: false, monitorNewItems: 'none' });
          } catch (e) {
            if (e.status !== 404 && e.status !== 405) throw e;
            for (const x of mon) {
              const full = await api.get('/artist/' + x.id);
              full.monitored = false;
              full.monitorNewItems = 'none';
              await api.put('/artist/' + x.id, full);
            }
          }
        }
        if (albums.length) await api.put('/album/monitor', { albumIds: albums.map((a) => a.id), monitored: false });
      } else {
        let done = false;
        try {
          await api.post('/seasonpass', {
            series: mon.map((x) => ({ id: x.id, monitored: false, seasons: (x.seasons || []).map((s) => ({ seasonNumber: s.seasonNumber, monitored: false })) })),
            monitoringOptions: { monitor: 'none' }
          });
          await api.put('/series/editor', { seriesIds: mon.map((x) => x.id), monitored: false, monitorNewItems: 'none' });
          done = true;
        } catch (e) {
          if (e.status !== 404 && e.status !== 405) throw e;
        }
        if (!done) {
          for (const x of mon) {
            const full = await api.get('/series/' + x.id);
            full.monitored = false;
            full.monitorNewItems = 'none';
            (full.seasons || []).forEach((s) => {
              s.monitored = false;
            });
            await api.put('/series/' + x.id, full);
          }
        }
      }
      await M.loadLib(true);
      App.toast(what + ' passé' + agree + ' en non surveillé', 'ok');
    }

    // ---------- Profils de qualité ----------
    const itemName = (it) => (it.quality ? it.quality.name : it.name) || '?';
    const itemId = (it) => (it.quality ? it.quality.id : it.id);
    const allowedNames = (p) => (p.items || []).filter((it) => it.allowed).map(itemName).reverse();
    function cutoffName(p) {
      const it = (p.items || []).find((x) => itemId(x) === p.cutoff);
      return it ? itemName(it) : '';
    }
    const usedBy = (p) => (M.cache.items || []).filter((x) => x.qualityProfileId === p.id).length;
    function openProfiles() {
      const box = h('div');
      let profiles = null;
      const sp = scrollPage({ title: 'Profils de qualité', subtitle: M.name, actions: [App.iconBtn('plus', 'Nouveau profil', newProfile)] });
      sp.box.appendChild(box);
      App.push(svc, sp.page);
      async function load() {
        if (!profiles) App.fill(box, App.loading());
        try {
          const r = await Promise.all([M.api().get('/qualityprofile'), M.loadLib().catch(() => null)]);
          profiles = r[0] || [];
          render();
        } catch (e) {
          App.fill(box, App.empty('exclamation-triangle', 'Profils indisponibles', e.message, [App.btn('Réessayer', { cls: 'pri', icon: 'arrow-path', onClick: load })]));
        }
      }
      function render() {
        const def = Number(App.config[svc + 'Profile']);
        if (!profiles.length) return App.fill(box, App.empty('adjustments-horizontal', 'Aucun profil', 'Crée un profil avec le bouton +.'));
        App.fill(box,
          App.note('Le profil par défaut est présélectionné à l’ajout depuis C411. Appui long sur un profil pour plus d’options.', '', 'information-circle'),
          h('div.group', profiles.map((p) => {
            const n = usedBy(p);
            const cut = cutoffName(p);
            const b = h('button.item', { type: 'button' }, App.icon('adjustments-horizontal'),
              h('div.main', h('div.t.nowrap', p.name), h('div.s.nowrap', allowedNames(p).join(' · ') || 'Aucune qualité'),
                h('div.badges', { style: { marginTop: '5px' } },
                  p.id === def ? App.badge('Par défaut', 'green', 'star') : null,
                  p.upgradeAllowed && cut ? App.badge('Seuil : ' + cut, 'blue') : App.badge('Sans mise à niveau'),
                  n ? App.badge(fmt.plural(n, M.noun)) : null)),
              App.icon('chevron-right', 'sm'));
            b.addEventListener('click', () => App.run(() => openProfileEditor(p, false, load)));
            App.longPress(b, () => profileMenu(p));
            return b;
          })));
      }
      function profileMenu(p) {
        const def = Number(App.config[svc + 'Profile']) === p.id;
        App.menu({
          title: p.name,
          items: [
            { icon: 'pencil-square', label: 'Modifier', onClick: () => openProfileEditor(p, false, load) },
            { icon: 'star', label: def ? 'Profil par défaut' : 'Définir par défaut', sub: 'Pour les ajouts depuis C411', disabled: def, onClick: () => {
              App.saveCfg({ [svc + 'Profile']: p.id });
              render();
              App.toast('Profil par défaut enregistré', 'ok');
            } },
            { icon: 'document-duplicate', label: 'Dupliquer', onClick: () => {
              const c = JSON.parse(JSON.stringify(p));
              delete c.id;
              c.name = p.name + ' (copie)';
              return openProfileEditor(c, true, load);
            } },
            '-',
            { icon: 'trash', label: 'Supprimer', danger: true, onClick: () => delProfile(p, load) }
          ]
        });
      }
      async function newProfile() {
        const schema = await M.api().get('/qualityprofile/schema');
        delete schema.id;
        schema.name = '';
        return openProfileEditor(schema, true, load);
      }
      load();
    }
    async function delProfile(p, done) {
      const n = usedBy(p);
      if (n) throw App.mkErr('Profil utilisé par ' + fmt.plural(n, M.noun) + ' : change leur profil avant de le supprimer.');
      if (!(await App.confirm({ title: 'Supprimer « ' + p.name + ' » ?', message: 'Ce profil sera supprimé de ' + M.name + '.', ok: 'Supprimer', danger: true }))) return false;
      await M.api().del('/qualityprofile/' + p.id);
      metaChanged();
      App.toast('Profil supprimé', 'ok');
      if (done) done();
      return true;
    }
    async function openProfileEditor(p0, isNew, done) {
      const P = JSON.parse(JSON.stringify(p0));
      P.items = P.items || [];
      const api = M.api();
      const langs = isR && P.language ? await api.get('/language').catch(() => null) : null;
      const sp = scrollPage({
        title: isNew ? 'Nouveau profil' : P.name,
        subtitle: 'Profil de qualité · ' + M.name,
        actions: isNew ? [] : [App.iconBtn('trash', 'Supprimer', async () => {
          if (await delProfile(p0, done)) App.pop(svc);
        })]
      });
      const name = App.input({ value: P.name || '', placeholder: 'ex. HD-1080p', autocapitalize: 'sentences' });
      const cutSel = h('select.input');
      function refreshCut() {
        App.clear(cutSel);
        P.items.filter((it) => it.allowed).reverse().forEach((it) => cutSel.appendChild(h('option', { value: String(itemId(it)) }, itemName(it))));
        cutSel.value = String(P.cutoff);
        if (cutSel.selectedIndex < 0 && cutSel.options.length) cutSel.selectedIndex = 0;
      }
      refreshCut();
      const cutField = App.field('Seuil de mise à niveau', cutSel, 'Une fois cette qualité atteinte, plus de mise à niveau.');
      cutField.classList.toggle('hidden', !P.upgradeAllowed);
      const upSw = App.switchEl('Autoriser les mises à niveau', !!P.upgradeAllowed, (v) => {
        P.upgradeAllowed = v;
        cutField.classList.toggle('hidden', !v);
      }, 'Remplacer un fichier par une meilleure qualité');
      let langSel = null;
      if (Array.isArray(langs) && langs.length) {
        const ls = langs.slice().sort((a, b) => (b.id < 0) - (a.id < 0) || coll(a.name || '', b.name || ''));
        langSel = App.select(ls.map((l) => ({ value: l.id, label: l.name })), P.language.id);
      }
      const qBox = h('div.group', { style: { padding: '0 14px' } });
      P.items.slice().reverse().forEach((it) => {
        const sub = !it.quality && it.items && it.items.length ? ' (' + it.items.map(itemName).join(', ') + ')' : '';
        qBox.appendChild(App.checkRow(itemName(it) + sub, !!it.allowed, (v) => {
          it.allowed = v;
          refreshCut();
        }));
      });
      const fmtInputs = [];
      const fi = (P.formatItems || []).slice().sort((a, b) => coll(a.name || '', b.name || ''));
      const cfBox = fi.length
        ? h('div.group', fi.map((f) => {
          const inp = numInput(f.score);
          fmtInputs.push([f, inp]);
          return h('div.item', { style: { padding: '8px 14px' } }, h('div.main', h('div.t.nowrap', f.name)), inp);
        }))
        : App.note('Aucun format personnalisé défini dans ' + M.name + '.', '', 'information-circle');
      const scoreFields = [];
      [['minFormatScore', 'Score minimum', 'Une release sous ce score est refusée.'],
        ['cutoffFormatScore', 'Score seuil', 'Plus de mise à niveau au-delà de ce score.'],
        ['minUpgradeFormatScore', 'Gain minimum pour mise à niveau', 'Au moins 1.']].forEach((k) => {
        if (P[k[0]] == null) return;
        const inp = App.input({ type: 'number', inputmode: 'numeric', value: String(P[k[0]] || 0) });
        scoreFields.push([k[0], inp, App.field(k[1], inp, k[2])]);
      });
      App.append(sp.box,
        App.field('Nom', name),
        h('div.card', upSw, cutField),
        langSel ? App.field('Langue', langSel, '« Any » accepte toutes les langues.') : null,
        App.secTitle('Qualités autorisées'),
        h('div.dim', { style: { fontSize: '12px', margin: '-4px 4px 8px' } }, 'De la meilleure à la moins bonne.'),
        qBox,
        App.secTitle('Formats personnalisés'),
        cfBox,
        scoreFields.length ? h('div.card', scoreFields.map((x) => x[2])) : null);
      const save = async () => {
        P.name = name.value.trim();
        if (!P.name) throw App.mkErr('Donne un nom au profil');
        if (!P.items.some((it) => it.allowed)) throw App.mkErr('Coche au moins une qualité');
        if (cutSel.value) P.cutoff = Number(cutSel.value);
        if (langSel) {
          const l = langs.find((x) => String(x.id) === langSel.value);
          if (l) P.language = { id: l.id, name: l.name };
        }
        fmtInputs.forEach((x) => {
          x[0].score = parseInt(x[1].value, 10) || 0;
        });
        scoreFields.forEach((x) => {
          P[x[0]] = parseInt(x[1].value, 10) || 0;
        });
        if (P.minUpgradeFormatScore != null && P.minUpgradeFormatScore < 1) P.minUpgradeFormatScore = 1;
        const saved = isNew ? await api.post('/qualityprofile', P) : await api.put('/qualityprofile/' + P.id, P);
        metaChanged();
        App.toast(isNew ? 'Profil créé' : 'Profil enregistré', 'ok');
        App.pop(svc);
        if (done) done(saved);
      };
      sp.page.el.appendChild(h('div.bottom-bar', App.btn('Enregistrer', { cls: 'pri block', icon: 'check', onClick: save })));
      App.push(svc, sp.page);
    }

    // ---------- Dossiers racine ----------
    function openRoots() {
      const box = h('div');
      let roots = null;
      const sp = scrollPage({ title: 'Dossiers racine', subtitle: M.name, actions: [App.iconBtn('plus', 'Ajouter un dossier', addRoot)] });
      sp.box.appendChild(box);
      App.push(svc, sp.page);
      async function load() {
        if (!roots) App.fill(box, App.loading());
        try {
          const r = await Promise.all([M.api().get('/rootfolder'), M.loadLib().catch(() => null)]);
          roots = r[0] || [];
          render();
        } catch (e) {
          App.fill(box, App.empty('exclamation-triangle', 'Dossiers indisponibles', e.message, [App.btn('Réessayer', { cls: 'pri', icon: 'arrow-path', onClick: load })]));
        }
      }
      function render() {
        const def = trimSlash(App.config[svc + 'Root'] || '');
        const items = M.cache.items || [];
        App.fill(box,
          App.note('Le dossier par défaut est présélectionné quand tu ajoutes ' + M.one + ' depuis C411' + (isR || isL ? '.' : ' (le dossier « anime » reste choisi automatiquement pour les animes).'), '', 'information-circle'),
          roots.length ? null : App.empty('folder', 'Aucun dossier racine', 'Ajoute le dossier où ' + M.name + ' range ' + (isR ? 'les films.' : isL ? 'la musique.' : 'les séries.')),
          roots.map((r) => {
            const p = trimSlash(r.path);
            const isDef = p === def;
            const count = items.filter((x) => trimSlash(x.rootFolderPath || parentOf(x.path)) === p).length;
            const unm = Array.isArray(r.unmappedFolders) ? r.unmappedFolders.length : null;
            return h('div.card',
              h('div.card-t', App.icon(r.accessible === false ? 'exclamation-triangle' : 'folder'), h('span.sel', { style: { flex: '1', minWidth: '0', wordBreak: 'break-all' } }, r.path), isDef ? App.badge('Par défaut', 'green', 'star') : null),
              h('div.meta', h('span', r.freeSpace != null ? fmt.bytes(r.freeSpace) + ' libres' : ''), h('span', fmt.plural(count, M.noun)), h('span', unm ? fmt.plural(unm, 'dossier non importé', 'dossiers non importés') : ''), isL && r.name ? h('span', r.name) : null),
              r.accessible === false ? App.note('Dossier inaccessible pour ' + M.name + ' (vérifie le montage du conteneur).', 'err') : null,
              h('div.btn-row', { style: { marginTop: '12px' } },
                isDef ? null : App.btn('Par défaut', { cls: 'sm', icon: 'star', onClick: () => {
                  App.saveCfg({ [svc + 'Root']: p });
                  render();
                  App.toast('Dossier par défaut enregistré', 'ok');
                } }),
                isL ? App.btn('Profils', { cls: 'sm', icon: 'adjustments-horizontal', onClick: () => editRootDefaults(r) })
                  : App.btn('Importer l’existant', { cls: 'sm', icon: 'inbox-arrow-down', onClick: () => openUnmapped(r, load) }),
                App.btn('', { cls: 'sm danger', icon: 'trash', title: 'Supprimer', onClick: () => delRoot(r) })));
          }));
      }
      // Lidarr root folders carry the defaults used by its own UI: always "none" for monitoring.
      async function rootBody(p, r) {
        const meta = await M.meta(true);
        const real = (meta.metaProfiles || []).filter((x) => x.name !== 'None');
        const pick = (list, id) => ((list.find((x) => x.id === id) || list[0]) || {}).id;
        return Object.assign({}, r || {}, {
          name: (r && r.name) || U.baseName(p) || p,
          path: p,
          defaultQualityProfileId: pick(meta.profiles, r && r.defaultQualityProfileId),
          defaultMetadataProfileId: pick(real.length ? real : meta.metaProfiles || [], r && r.defaultMetadataProfileId),
          defaultMonitorOption: 'none',
          defaultNewItemMonitorOption: 'none',
          defaultTags: (r && r.defaultTags) || []
        });
      }
      async function editRootDefaults(r) {
        const meta = await M.meta(true);
        const body = await rootBody(r.path, r);
        const name = App.input({ value: body.name || '' });
        const qSel = App.select(meta.profiles.map((x) => ({ value: x.id, label: x.name })), body.defaultQualityProfileId);
        const mSel = App.select((meta.metaProfiles || []).map((x) => ({ value: x.id, label: x.name })), body.defaultMetadataProfileId);
        const s = App.sheet({
          title: 'Dossier racine',
          body: [
            h('div.mono.wrap.dim', { style: { margin: '0 4px 10px', fontSize: '12px' } }, r.path),
            App.field('Nom', name),
            App.field('Profil de qualité par défaut', qSel),
            App.field('Profil de métadonnées par défaut', mSel, '« None » : seuls les albums ajoutés à la main sont suivis.'),
            App.note('La surveillance par défaut reste sur « Aucune » : Lidarr ne cherche jamais rien de lui-même.', '', 'eye-slash')
          ],
          actions: [App.btn('Enregistrer', { cls: 'pri', icon: 'check', onClick: async () => {
            body.name = name.value.trim() || body.name;
            body.defaultQualityProfileId = Number(qSel.value);
            body.defaultMetadataProfileId = Number(mSel.value);
            await M.api().put('/rootfolder/' + r.id, body);
            metaChanged();
            s.close();
            App.toast('Dossier enregistré', 'ok');
            await load();
          } })]
        });
      }
      async function addRoot() {
        const v = await App.prompt({ title: 'Nouveau dossier racine', label: 'Chemin sur le serveur', placeholder: isR ? '/data/media/films' : isL ? '/data/media/musique' : '/data/media/series', ok: 'Ajouter', hint: 'Chemin tel que ' + M.name + ' le voit (dans son conteneur).' });
        const p = trimSlash((v || '').trim());
        if (!p) return;
        await M.api().post('/rootfolder', isL ? await rootBody(p) : { path: p });
        metaChanged();
        App.toast('Dossier ajouté', 'ok');
        await load();
      }
      async function delRoot(r) {
        if (!(await App.confirm({ title: 'Retirer ce dossier racine ?', message: '« ' + r.path + ' » : les fichiers ne sont pas supprimés, ' + M.name + ' cesse seulement de proposer ce dossier.', ok: 'Retirer', danger: true }))) return;
        await M.api().del('/rootfolder/' + r.id);
        metaChanged();
        App.toast('Dossier retiré', 'ok');
        await load();
      }
      load();
    }

    // Folder name -> lookup term ("Title (2021) {imdb-tt123}" -> "imdb:tt123").
    function folderTerm(name) {
      const id = /[{[](imdb|tmdb|tvdb)(?:id)?[-=](tt\d+|\d+)[}\]]/i.exec(name);
      if (id) return id[1].toLowerCase() + ':' + id[2];
      let t = String(name || '').replace(/\{[^}]*\}|\[[^\]]*\]/g, ' ');
      const y = /\((\d{4})\)/.exec(t);
      t = t.replace(/\(\d{4}\)/g, ' ').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
      return isR && y ? t + ' ' + y[1] : t;
    }
    async function openUnmapped(r, reload) {
      const sp = scrollPage({ title: 'Importer l’existant', subtitle: r.path });
      App.push(svc, sp.page);
      App.fill(sp.box, App.loading());
      let full = r;
      try {
        full = (await M.api().get('/rootfolder/' + r.id)) || r;
      } catch (e) {
        if (!r.unmappedFolders) return App.fill(sp.box, App.empty('exclamation-triangle', 'Lecture impossible', e.message));
      }
      const list = (full.unmappedFolders || r.unmappedFolders || []).slice().sort((a, b) => coll(a.name || '', b.name || ''));
      if (!list.length) {
        return App.fill(sp.box, App.empty('check-circle', 'Rien à importer', 'Tous les dossiers de ' + r.path + ' sont déjà associés à ' + (isR ? 'un film.' : 'une série.')));
      }
      const done = new Set();
      sp.page.onDestroy = () => {
        if (done.size && reload) reload();
      };
      function render() {
        App.fill(sp.box,
          App.note('Dossiers présents sur le disque mais absents de ' + M.name + '. Choisis la fiche correspondante : les fichiers sont importés sur place, sans surveillance ni recherche.', '', 'information-circle'),
          h('div.group', list.map((f) => {
            const ok = done.has(f.path);
            const b = h('button.item', { type: 'button', disabled: ok }, App.icon(ok ? 'check-circle' : 'folder'),
              h('div.main', h('div.t.nowrap', f.name), h('div.s.nowrap', f.path)),
              ok ? App.badge('Importé', 'green') : App.icon('chevron-right', 'sm'));
            if (!ok) {
              b.addEventListener('click', () => App.run(() => lookupFor(f, r, () => {
                done.add(f.path);
                render();
              })));
            }
            return b;
          })));
      }
      render();
    }
    function lookupFor(f, r, onDone) {
      const input = App.input({ type: 'search', value: folderTerm(f.name), enterkeyhint: 'search' });
      const res = h('div');
      let seq = 0;
      const s = App.sheet({ title: f.name, full: true, body: [h('div.search', App.icon('magnifying-glass'), input), h('div', { style: { height: '12px' } }), res] });
      async function run() {
        const term = input.value.trim();
        if (!term) return App.clear(res);
        const my = ++seq;
        App.fill(res, App.loading());
        try {
          const list = await M.api().get(M.ep + '/lookup', { term: term });
          if (my !== seq) return;
          if (!list || !list.length) {
            return App.fill(res, App.empty('magnifying-glass', 'Aucun résultat', 'Modifie la recherche : titre, année, imdb:tt…' + (isR ? ', tmdb:…' : ', tvdb:…')));
          }
          App.fill(res, list.slice(0, 20).map((x) => {
            const lib = M.inLib(x);
            const has = lib && lib.id;
            const b = h('button.result', { type: 'button' }, M.poster(x, 250),
              h('div.main', h('div.t', x.title + (x.year ? ' (' + x.year + ')' : '')), h('div.s.dim', M.metaLine(x)),
                has ? h('div', App.badge('Déjà dans ' + M.name, 'amber')) : null, x.overview ? h('div.ov', x.overview) : null));
            b.addEventListener('click', () => App.run(() => {
              if (has) throw App.mkErr('Déjà dans ' + M.name + ' (dans ' + (lib.path || 'un autre dossier') + ')');
              return M.openAddSheet(x, { path: f.path, root: trimSlash(r.path), onAdded: (added) => {
                s.close();
                onDone(added);
              } });
            }));
            return b;
          }));
        } catch (e) {
          if (my === seq) App.fill(res, App.note(e.message, 'err'));
        }
      }
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          input.blur();
          run();
        }
      });
      run();
    }

    // ---------- Étiquettes ----------
    const tagSlug = (v) => App.norm(v).trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    const TAG_OTHER = ['delayProfileIds', 'importListIds', 'notificationIds', 'restrictionIds', 'releaseProfileIds', 'indexerIds', 'downloadClientIds', 'autoTagIds'];
    function openTags() {
      const box = h('div');
      let tags = null;
      const sp = scrollPage({ title: 'Étiquettes', subtitle: M.name, actions: [App.iconBtn('plus', 'Nouvelle étiquette', () => editTag(null))] });
      sp.box.appendChild(box);
      App.push(svc, sp.page);
      async function load() {
        if (!tags) App.fill(box, App.loading());
        const api = M.api();
        try {
          let list;
          try {
            list = await api.get('/tag/detail');
          } catch (e) {
            if (e.status !== 404) throw e;
            list = await api.get('/tag');
          }
          tags = (list || []).slice().sort((a, b) => coll(a.label || '', b.label || ''));
          render();
        } catch (e) {
          App.fill(box, App.empty('exclamation-triangle', 'Étiquettes indisponibles', e.message, [App.btn('Réessayer', { cls: 'pri', icon: 'arrow-path', onClick: load })]));
        }
      }
      function usage(t) {
        const ids = isR ? t.movieIds : isL ? t.artistIds : t.seriesIds;
        if (!ids) return null;
        return { n: ids.length, other: TAG_OTHER.reduce((a, k) => a + (t[k] ? t[k].length : 0), 0) };
      }
      function render() {
        if (!tags.length) {
          return App.fill(box, App.empty('tag', 'Aucune étiquette', 'Les étiquettes classent ' + (isR ? 'les films' : isL ? 'les artistes' : 'les séries') + ' et relient profils de délai, indexeurs ou notifications.', [
            App.btn('Créer une étiquette', { cls: 'pri', icon: 'plus', onClick: () => editTag(null) })
          ]));
        }
        App.fill(box, h('div.group', tags.map((t) => {
          const u = usage(t);
          const sub = u ? [fmt.plural(u.n, M.noun), u.other ? fmt.plural(u.other, 'autre usage', 'autres usages') : null].filter(Boolean).join(' · ') : '';
          const b = h('button.item', { type: 'button' }, App.icon('tag'), h('div.main', h('div.t.nowrap', t.label), sub ? h('div.s', sub) : null), App.icon('ellipsis-vertical', 'sm'));
          b.addEventListener('click', () => App.menu({
            title: t.label,
            items: [
              u && u.n ? { icon: M.icon, label: isR ? 'Voir les films' : isL ? 'Voir les artistes' : 'Voir les séries', onClick: () => showTagged(t) } : null,
              { icon: 'pencil-square', label: 'Renommer', onClick: () => editTag(t) },
              '-',
              { icon: 'trash', label: 'Supprimer', danger: true, onClick: () => delTag(t, u) }
            ]
          }));
          return b;
        })));
      }
      async function editTag(t) {
        const v = await App.prompt({ title: t ? 'Renommer l’étiquette' : 'Nouvelle étiquette', label: 'Nom', value: t ? t.label : '', placeholder: 'ex. anime', ok: t ? 'Renommer' : 'Créer', hint: 'Minuscules, chiffres et tirets uniquement.' });
        if (v == null) return;
        const label = tagSlug(v);
        if (!label) throw App.mkErr('Nom invalide');
        if (t && t.label === label) return;
        if (tags.some((x) => x.label === label)) throw App.mkErr('L’étiquette « ' + label + ' » existe déjà');
        if (t) await M.api().put('/tag/' + t.id, { id: t.id, label: label });
        else await M.api().post('/tag', { label: label });
        metaChanged();
        App.toast(t ? 'Étiquette renommée' : 'Étiquette « ' + label + ' » créée', 'ok');
        await load();
      }
      async function delTag(t, u) {
        const used = u ? u.n + u.other : 0;
        const msg = used ? 'Encore utilisée par ' + fmt.plural(used, 'élément') + ' : ' + M.name + ' peut refuser tant qu’elle n’est pas retirée partout.' : 'Cette étiquette sera supprimée.';
        if (!(await App.confirm({ title: 'Supprimer « ' + t.label + ' » ?', message: msg, ok: 'Supprimer', danger: true }))) return;
        await M.api().del('/tag/' + t.id);
        metaChanged();
        App.toast('Étiquette supprimée', 'ok');
        await load();
      }
      function showTagged(t) {
        const ids = (isR ? t.movieIds : isL ? t.artistIds : t.seriesIds) || [];
        const list = ids.map((id) => M.get(id)).filter(Boolean).sort((a, b) => coll(a.sortTitle || a.title || '', b.sortTitle || b.title || ''));
        const p = scrollPage({ title: t.label, subtitle: fmt.plural(ids.length, M.noun) });
        App.fill(p.box, list.length ? h('div.rows', list.map((x) => {
          const st = M.status(x);
          const b = h('button.lrow', { type: 'button' }, M.poster(x, 250, st),
            h('div.main', h('div.t', x.title), h('div.s', M.metaLine(x)), h('div.badges', { style: { marginTop: '6px' } }, App.badge(st.label, st.color))),
            App.icon('chevron-right', 'sm'));
          b.addEventListener('click', () => M.openDetails(x.id));
          return b;
        })) : App.empty('tag', 'Bibliothèque non chargée', 'Ouvre la bibliothèque puis réessaie.'));
        App.push(svc, p.page);
      }
      load();
    }

    // ---------- Liste noire (blocklist) ----------
    function openBlocklist() {
      const box = h('div');
      const PAGE = 50;
      let ep = '/blocklist';
      let recs = null;
      let total = 0;
      let pageNo = 0;
      const sp = scrollPage({ title: 'Liste noire', subtitle: M.name, actions: [App.iconBtn('trash', 'Vider la liste noire', clearAll)] });
      sp.box.appendChild(box);
      App.push(svc, sp.page);
      async function fetchPage(p, size) {
        const q = { page: p, pageSize: size, sortKey: 'date', sortDirection: 'descending' };
        try {
          return await M.api().get(ep, q);
        } catch (e) {
          if (e.status !== 404 || ep === '/blacklist') throw e;
          ep = '/blacklist';
          return M.api().get(ep, q);
        }
      }
      async function load(more) {
        if (!more && !recs) App.fill(box, App.loading());
        try {
          const r = await fetchPage(more ? pageNo + 1 : 1, PAGE);
          const list = (r && r.records) || [];
          recs = more ? recs.concat(list) : list;
          pageNo = more ? pageNo + 1 : 1;
          total = (r && r.totalRecords) || recs.length;
          render();
        } catch (e) {
          if (more) throw e;
          App.fill(box, App.empty('exclamation-triangle', 'Liste noire indisponible', e.message, [App.btn('Réessayer', { cls: 'pri', icon: 'arrow-path', onClick: () => load() })]));
        }
      }
      function render() {
        sp.page.setSub(M.name + (total ? ' · ' + fmt.plural(total, 'release') : ''));
        if (!recs.length) return App.fill(box, App.empty('check-circle', 'Liste noire vide', 'Aucune release bloquée dans ' + M.name + '.'));
        App.fill(box,
          App.note('Releases refusées par ' + M.name + ' (échec ou suppression avec blocage). Les retirer permet de les réimporter.', '', 'information-circle'),
          h('div.group', recs.map((r) => {
            const m = mediaOf(r) || M.get(mediaIdOf(r));
            const b = h('button.item', { type: 'button' }, U.colorIcon('x-circle', 'red'),
              h('div.main', h('div.t.nowrap', r.sourceTitle || '?'), h('div.s.nowrap', [m ? nameOf(m) : null, U.qualityName(r.quality), fmt.rel(r.date)].filter(Boolean).join(' · '))));
            b.addEventListener('click', () => sheetFor(r, m));
            return b;
          })),
          recs.length < total ? h('div.more', App.btn('Charger plus', { icon: 'arrow-down', onClick: () => load(true) })) : null);
      }
      function sheetFor(r, m) {
        let s = null;
        s = App.sheet({
          title: 'Release bloquée',
          body: [
            h('div.mono.wrap.sel', { style: { fontSize: '12.5px', marginBottom: '12px' } }, r.sourceTitle || ''),
            App.kv([
              [isR ? 'Film' : isL ? 'Artiste' : 'Série', m ? nameOf(m) : ''],
              ['Qualité', U.qualityName(r.quality)],
              ['Langues', U.langName(r.languages || r.language)],
              ['Formats perso.', (r.customFormats || []).map((c) => c.name).join(', ')],
              ['Indexeur', r.indexer],
              ['Protocole', r.protocol],
              ['Date', fmt.dateTime(r.date)]
            ]),
            r.message ? h('div', { style: { marginTop: '12px' } }, App.note(r.message, 'warn')) : null
          ],
          actions: [
            r.sourceTitle ? App.btn('C411', { icon: 'magnifying-glass', onClick: () => App.c411Search(U.cleanName(r.sourceTitle)) }) : null,
            App.btn('Retirer', { cls: 'danger', icon: 'trash', onClick: async () => {
              await M.api().del(ep + '/' + r.id);
              s.close();
              recs = recs.filter((x) => x.id !== r.id);
              total = Math.max(0, total - 1);
              render();
              App.toast('Release retirée de la liste noire', 'ok');
            } })
          ].filter(Boolean)
        });
      }
      async function clearAll() {
        if (!recs || !recs.length) return App.toast('La liste noire est déjà vide');
        if (!(await App.confirm({ title: 'Vider la liste noire ?', message: fmt.plural(total, 'release') + ' ne ser' + (total > 1 ? 'ont' : 'a') + ' plus bloquée' + (total > 1 ? 's' : '') + '.', ok: 'Vider', danger: true }))) return;
        const r = await fetchPage(1, Math.max(total, 1000));
        const ids = ((r && r.records) || []).map((x) => x.id);
        if (ids.length) await M.api().del(ep + '/bulk', null, { ids: ids });
        App.toast('Liste noire vidée', 'ok');
        recs = null;
        await load();
      }
      load();
    }

    // ---------- Journal ----------
    const LV_FR = { fatal: 'Fatal', error: 'Erreur', warn: 'Avertissement', info: 'Info', debug: 'Debug', trace: 'Trace' };
    function openLogs() {
      const box = h('div');
      const PAGE = 100;
      let lv = App.pref(svc + '.logLv', 'all');
      let recs = null;
      let total = 0;
      let pageNo = 0;
      let seq = 0;
      const seg = App.seg([{ value: 'all', label: 'Tout' }, { value: 'warn', label: 'Avertissements' }, { value: 'error', label: 'Erreurs' }], lv, (v) => {
        lv = v;
        App.setPref(svc + '.logLv', v);
        recs = null;
        load();
      });
      const sp = scrollPage({ title: 'Journal', subtitle: M.name, actions: [App.iconBtn('arrow-path', 'Actualiser', () => load())] });
      sp.page.el.insertBefore(seg, sp.box);
      sp.box.appendChild(box);
      App.push(svc, sp.page);
      async function load(more) {
        const my = ++seq;
        if (!more && !recs) App.fill(box, App.loading());
        const q = { page: more ? pageNo + 1 : 1, pageSize: PAGE, sortKey: 'time', sortDirection: 'descending' };
        if (lv !== 'all') Object.assign(q, { level: lv, filterKey: 'level', filterValue: lv });
        try {
          const r = await M.api().get('/log', q);
          if (my !== seq) return;
          const list = (r && r.records) || [];
          recs = more ? recs.concat(list) : list;
          pageNo = q.page;
          total = (r && r.totalRecords) || recs.length;
          render();
        } catch (e) {
          if (my !== seq) return;
          if (more) throw e;
          App.fill(box, App.empty('exclamation-triangle', 'Journal indisponible', e.message, [App.btn('Réessayer', { cls: 'pri', icon: 'arrow-path', onClick: () => load() })]));
        }
      }
      function render() {
        if (!recs.length) {
          return App.fill(box, App.empty('document-text', 'Journal vide', lv === 'all' ? 'Aucun événement enregistré (journal en base désactivé ?).' : 'Rien à ce niveau, tout va bien.'));
        }
        App.fill(box, h('div.group', recs.map((r) => {
          const l = String(r.level || 'info').toLowerCase().replace(/[^a-z]/g, '') || 'info';
          const b = h('button.log', { type: 'button' },
            h('div', { style: { display: 'flex', alignItems: 'center', minWidth: '0', marginBottom: '3px' } }, h('span.lv.' + l, LV_FR[l] || l),
              h('span.dim.nowrap', { style: { fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis' } }, fmt.dateTime(r.time) + (r.logger ? ' · ' + r.logger : ''))),
            h('div.msg', r.message || ''));
          b.addEventListener('click', () => logSheet(r, l));
          return b;
        })), recs.length < total ? h('div.more', App.btn('Charger plus', { icon: 'arrow-down', onClick: () => load(true) })) : null);
      }
      function logSheet(r, l) {
        const text = (r.message || '') + (r.exception ? '\n\n' + (r.exceptionType ? r.exceptionType + '\n' : '') + r.exception : '');
        const pre = { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '12px', margin: '12px 0 0' };
        App.sheet({
          title: LV_FR[l] || l,
          full: !!r.exception,
          body: [
            App.kv([['Date', fmt.dateTime(r.time)], ['Source', r.logger], ['Méthode', r.method]]),
            h('div.card.mono.sel', { style: pre }, r.message || ''),
            r.exception ? h('div.card.mono.sel', { style: Object.assign({}, pre, { fontSize: '11px', color: '#f6c4c4' }) }, (r.exceptionType ? r.exceptionType + '\n' : '') + r.exception) : null
          ],
          actions: [App.btn('Copier', { icon: 'clipboard-document', onClick: () => App.copy(text, 'Message') })]
        });
      }
      load();
    }

    // ---------- Tâches planifiées & commandes (lecture seule) ----------
    const TASK_FR = {
      ApplicationCheckUpdate: 'Recherche de mise à jour', ApplicationUpdateCheck: 'Recherche de mise à jour', ApplicationUpdate: 'Mise à jour',
      Backup: 'Sauvegarde', CheckHealth: 'Vérification de l’état', CleanUpRecycleBin: 'Vidage de la corbeille', Housekeeping: 'Maintenance',
      ImportListSync: 'Synchro des listes d’import', MessagingCleanup: 'Nettoyage des messages', RefreshCollections: 'Actualisation des collections',
      RefreshMonitoredDownloads: 'Suivi des téléchargements', ProcessMonitoredDownloads: 'Traitement des téléchargements',
      RefreshMovie: 'Actualisation des films', RefreshSeries: 'Actualisation des séries', RssSync: 'Synchro RSS', UpdateSceneMapping: 'Correspondances scène',
      ManualImport: 'Import manuel', DownloadedMoviesScan: 'Scan des téléchargements', DownloadedEpisodesScan: 'Scan des téléchargements',
      RescanMovie: 'Analyse du disque', RescanSeries: 'Analyse du disque', RenameFiles: 'Renommage', RenameMovie: 'Renommage', RenameSeries: 'Renommage',
      MoveMovie: 'Déplacement', MoveSeries: 'Déplacement', BulkMoveMovie: 'Déplacement', BulkMoveSeries: 'Déplacement',
      RefreshArtist: 'Actualisation des artistes', RefreshAlbum: 'Actualisation des albums', RescanFolders: 'Analyse du disque',
      DownloadedAlbumsScan: 'Scan des téléchargements', RenameArtist: 'Renommage', RetagFiles: 'Réécriture des tags', RetagArtist: 'Réécriture des tags',
      MoveArtist: 'Déplacement', BulkMoveArtist: 'Déplacement'
    };
    const CMD_ST = {
      queued: ['En file', ''], started: ['En cours', 'blue'], completed: ['Terminée', 'green'], failed: ['Échec', 'red'],
      aborted: ['Interrompue', 'amber'], cancelled: ['Annulée', ''], orphaned: ['Orpheline', 'amber']
    };
    function openTasks() {
      const box = h('div');
      let timer = null;
      let loaded = false;
      const sp = scrollPage({ title: 'Tâches planifiées', subtitle: M.name, actions: [App.iconBtn('arrow-path', 'Actualiser', () => load())] });
      sp.box.appendChild(box);
      sp.page.onDestroy = () => clearTimeout(timer);
      App.push(svc, sp.page);
      async function load() {
        clearTimeout(timer);
        timer = null;
        if (!loaded) App.fill(box, App.loading());
        try {
          const api = M.api();
          const r = await Promise.all([api.get('/system/task'), api.get('/command').catch(() => [])]);
          loaded = true;
          render(r[0] || [], Array.isArray(r[1]) ? r[1] : []);
        } catch (e) {
          App.fill(box, App.empty('exclamation-triangle', 'Tâches indisponibles', e.message, [App.btn('Réessayer', { cls: 'pri', icon: 'arrow-path', onClick: load })]));
        }
      }
      function cmdRow(c) {
        const st = CMD_ST[String(c.status || '').toLowerCase()] || [c.status || '', ''];
        const when = c.ended || c.started || c.queued;
        const dur = parseSpan(c.duration);
        return h('div.item', U.colorIcon(st[1] === 'blue' ? 'arrow-path' : st[1] === 'red' ? 'x-circle' : 'check-circle', st[1]),
          h('div.main', h('div.t.nowrap', TASK_FR[c.name] || c.commandName || c.name),
            h('div.s.nowrap', [c.message, c.trigger === 'scheduled' ? 'planifiée' : c.trigger === 'manual' ? 'manuelle' : null].filter(Boolean).join(' · '))),
          h('div.r', App.badge(st[0], st[1]), h('div', { style: { marginTop: '4px' } }, fmt.rel(when) + (dur ? ' · ' + fmt.dur(dur) : ''))));
      }
      function render(tasks, cmds) {
        const running = cmds.filter((c) => /queued|started/i.test(c.status || ''));
        const recent = cmds.filter((c) => running.indexOf(c) < 0)
          .sort((a, b) => U.ts(b.ended || b.queued) - U.ts(a.ended || a.queued)).slice(0, 8);
        tasks = tasks.slice().sort((a, b) => U.ts(a.nextExecution) - U.ts(b.nextExecution));
        App.fill(box,
          App.note('Lecture seule : Arr411 ne déclenche jamais de recherche ni de synchro RSS. Les ajouts restent non surveillés.', '', 'shield-check'),
          running.length ? [App.secTitle('En cours'), h('div.group', running.map(cmdRow))] : null,
          App.secTitle('Planifiées'),
          h('div.group', tasks.map((t) => {
            const last = parseSpan(t.lastDuration);
            return h('div.item', App.icon('clock'),
              h('div.main', h('div.t.nowrap', TASK_FR[t.taskName] || t.name),
                h('div.s', t.interval > 0 ? 'Intervalle : ' + fmt.dur(t.interval * 60) : 'Manuelle'),
                h('div.s', 'Dernière : ' + (fmt.rel(t.lastExecution) || 'jamais') + (last ? ' (' + fmt.dur(last) + ')' : ''))),
              h('div.r', t.interval > 0 ? fmt.rel(t.nextExecution) : ''));
          })),
          recent.length ? [App.secTitle('Commandes récentes'), h('div.group', recent.map(cmdRow))] : null);
        if (running.length) {
          timer = setTimeout(() => {
            if (App.isTop(sp.page)) load();
          }, 3000);
        }
      }
      load();
    }

    // ---------- Import manuel : sélecteurs ----------
    const nk = (s) => App.norm(s).replace(/[^a-z0-9]+/g, ' ').trim();
    const titlesOf = (x) => [x.title, x.originalTitle].concat((x.alternateTitles || []).map((a) => a.title)).filter(Boolean);
    // How well a library item matches a file name (0 = no match).
    function scoreOf(x, fk) {
      const pad2 = ' ' + fk + ' ';
      let best = 0;
      titlesOf(x).forEach((t) => {
        t = nk(t);
        if (!t) return;
        let s = 0;
        if (pad2.indexOf(' ' + t + ' ') >= 0) s = 2 + t.length / 100;
        else {
          const w = t.split(' ').filter((p) => p.length > 2);
          const hit = w.length ? w.filter((p) => pad2.indexOf(' ' + p + ' ') >= 0).length / w.length : 0;
          if (hit >= 0.5) s = hit;
        }
        if (s > best) best = s;
      });
      if (best && x.year && pad2.indexOf(' ' + x.year + ' ') >= 0) best += 1;
      return best;
    }
    function pickMedia(f, cur) {
      return new Promise((resolve) => {
        let done = false;
        const fk = nk(isL ? [(f.audioTags || {}).artistTitle, f.path || f.name].filter(Boolean).join(' ') : f.relativePath || f.name || f.path);
        const inp = App.input({ type: 'search', placeholder: 'Rechercher dans la bibliothèque', enterkeyhint: 'search' });
        const list = h('div.group');
        const all = (M.cache.items || []).map((x) => ({ x: x, k: titlesOf(x).map(nk).join(' | ') + ' ' + (x.year || ''), score: scoreOf(x, fk) }));
        const s = App.sheet({
          title: isR ? 'Quel film ?' : isL ? 'Quel artiste ?' : 'Quelle série ?',
          full: true,
          body: [h('div.search', App.icon('magnifying-glass'), inp), h('div', { style: { height: '12px' } }), list,
            App.note('Absent' + M.e + ' de la liste ? Ajoute-l' + (isR || isL ? 'e' : 'a') + ' d’abord depuis la bibliothèque ' + M.name + ' (non surveillé' + M.e + ').', '', 'information-circle')],
          onClose: () => {
            if (!done) resolve(null);
          }
        });
        function render() {
          const q = nk(inp.value);
          let res = q ? all.filter((e) => e.k.indexOf(q) >= 0) : all.filter((e) => e.score > 0);
          res = res.sort((a, b) => b.score - a.score || coll(a.x.sortTitle || a.x.title || '', b.x.sortTitle || b.x.title || '')).slice(0, 40);
          if (!res.length) {
            return App.fill(list, h('div.item', App.icon('magnifying-glass'), h('div.main', h('div.s', q ? 'Aucun résultat dans la bibliothèque' : 'Aucune correspondance évidente : tape un titre'))));
          }
          App.fill(list, res.map((e) => {
            const on = cur && cur.id === e.x.id;
            const b = h('button.item', { type: 'button' }, App.icon(M.icon),
              h('div.main', h('div.t.nowrap', e.x.title), h('div.s.nowrap', M.metaLine(e.x))), on ? App.icon('check', 'sm') : null);
            if (on) b.style.color = 'var(--pri)';
            b.addEventListener('click', () => {
              done = true;
              s.close();
              resolve(e.x);
            });
            return b;
          }));
        }
        inp.addEventListener('input', App.debounce(render, 150));
        render();
      });
    }
    // Sonarr: choose the episodes contained in a file (pre-selects SxxEyy from the file name).
    async function pickEpisodes(series, st) {
      const eps = ((await M.api().get('/episode', { seriesId: series.id })) || []).slice()
        .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
      if (!eps.length) throw App.mkErr('Aucun épisode connu pour ' + series.title + ' : actualise la série dans Sonarr');
      const sel = new Set((st.media && st.media.id === series.id ? st.episodes : []).map((e) => e.id));
      const fn = st.f.relativePath || st.f.name || st.f.path || '';
      const m = /S(\d{1,2})((?:[ ._-]?E\d{1,4})+)/i.exec(fn);
      const fileSeason = m ? +m[1] : st.f.seasonNumber != null ? st.f.seasonNumber : null;
      if (!sel.size && m) {
        const nums = m[2].match(/\d+/g).map(Number);
        if (nums.length === 2 && /-/.test(m[2]) && nums[1] > nums[0]) for (let n = nums[0] + 1; n < nums[1]; n++) nums.push(n);
        eps.filter((e) => e.seasonNumber === fileSeason && nums.indexOf(e.episodeNumber) >= 0).forEach((e) => sel.add(e.id));
      }
      return new Promise((resolve) => {
        let done = false;
        const bySeason = new Map();
        eps.forEach((e) => {
          if (!bySeason.has(e.seasonNumber)) bySeason.set(e.seasonNumber, []);
          bySeason.get(e.seasonNumber).push(e);
        });
        const nums = Array.from(bySeason.keys()).sort((a, b) => (a === 0) - (b === 0) || a - b);
        const ok = App.btn('Valider', { cls: 'pri', icon: 'check', onClick: () => {
          done = true;
          s.close();
          resolve(eps.filter((e) => sel.has(e.id)));
        } });
        const upd = () => {
          ok.querySelector('span').textContent = sel.size ? 'Valider (' + sel.size + ')' : 'Valider';
          ok.disabled = !sel.size;
        };
        const blocks = nums.map((sn) => {
          const list = bySeason.get(sn);
          const sub = h('div.s');
          const count = () => {
            const n = list.filter((e) => sel.has(e.id)).length;
            sub.textContent = fmt.plural(list.length, 'épisode') + (n ? ' · ' + n + ' sélectionné' + (n > 1 ? 's' : '') : '');
          };
          const head = h('button.item.season-h', { type: 'button' }, h('div.main', h('div.t', sn === 0 ? 'Spéciaux' : 'Saison ' + sn), sub), App.icon('chevron-down', 'sm'));
          const body = h('div.season-b', { style: { padding: '0 14px' } }, list.map((e) => App.checkRow(epCode(e.seasonNumber, e.episodeNumber) + (e.title ? ' · ' + e.title : ''), sel.has(e.id), (v) => {
            if (v) sel.add(e.id);
            else sel.delete(e.id);
            count();
            upd();
          })));
          const open = list.some((e) => sel.has(e.id)) || (!sel.size && (sn === fileSeason || nums.length === 1));
          const wrap = h('div.group.season' + (open ? '.open' : ''), head, body);
          head.addEventListener('click', () => wrap.classList.toggle('open'));
          count();
          return wrap;
        });
        const s = App.sheet({
          title: series.title,
          full: true,
          body: [h('div.s.mono.wrap', { style: { fontSize: '12px', color: 'var(--muted)', marginBottom: '12px' } }, U.baseName(fn)), blocks],
          actions: [App.btn('Annuler', { onClick: () => s.close() }), ok],
          onClose: () => {
            if (!done) resolve(null);
          }
        });
        upd();
      });
    }
    let qDefs = null;
    async function pickQuality(st) {
      if (!qDefs) qDefs = ((await M.api().get('/qualitydefinition')) || []).slice().sort((a, b) => (b.weight || 0) - (a.weight || 0));
      const cur = st.quality && st.quality.quality ? st.quality.quality.id : undefined;
      const v = await App.pick({ title: 'Qualité du fichier', value: cur, options: qDefs.map((d) => ({ value: d.quality.id, label: d.title || d.quality.name })) });
      if (v == null) return false;
      const d = qDefs.find((x) => x.quality.id === v);
      st.quality = { quality: d.quality, revision: (st.quality && st.quality.revision) || { version: 1, real: 0, isRepack: false } };
      return true;
    }
    App.on(svc + ':reset', () => {
      qDefs = null;
    });

    // Lidarr: album, then tracks (pre-selected from the file's tags / name).
    const relOf = (a) => (((a && a.releases) || []).find((r) => r.monitored) || ((a && a.releases) || [])[0] || {}).id || null;
    async function pickAlbum(artist, cur) {
      const albums = ((await M.api().get('/album', { artistId: artist.id })) || []).slice().sort((a, b) => U.ts(b.releaseDate) - U.ts(a.releaseDate));
      if (!albums.length) throw App.mkErr('Aucun album connu pour ' + nameOf(artist) + ' : actualise l’artiste dans Lidarr');
      const id = await App.pick({
        title: nameOf(artist),
        value: cur ? cur.id : undefined,
        options: albums.map((a) => {
          const n = (a.statistics || {}).totalTrackCount;
          const y = U.ts(a.releaseDate) ? new Date(U.ts(a.releaseDate)).getFullYear() : '';
          return { value: a.id, label: a.title, sub: [a.albumType, y, n ? fmt.plural(n, 'piste') : ''].filter(Boolean).join(' · ') };
        })
      });
      return id == null ? null : albums.find((a) => a.id === id) || null;
    }
    function trkNo(t, multi, padded) {
      const raw = /^\d+$/.test(String(t.trackNumber || '')) ? +t.trackNumber : t.trackNumber || t.absoluteTrackNumber;
      if (raw == null || raw === '') return null;
      return (multi ? (t.mediumNumber || 1) + '-' : '') + (padded && typeof raw === 'number' ? pad(raw) : raw);
    }
    async function pickTracks(album, st) {
      const rel = st.albumReleaseId || relOf(album);
      const tracks = ((await M.api().get('/track', rel ? { albumReleaseId: rel } : { albumId: album.id })) || []).slice()
        .sort((a, b) => (a.mediumNumber || 0) - (b.mediumNumber || 0) || (a.absoluteTrackNumber || 0) - (b.absoluteTrackNumber || 0));
      if (!tracks.length) throw App.mkErr('Aucune piste connue pour ' + album.title);
      const sel = new Set(st.tracks.map((t) => t.id));
      if (!sel.size) {
        const tags = st.f.audioTags || {};
        const fm = /^(?:\d+[-.])?(\d{1,3})(?=[ ._-])/.exec(U.baseName(st.f.path || st.f.name || ''));
        const nums = (tags.trackNumbers || []).length ? tags.trackNumbers : fm ? [+fm[1]] : [];
        const perDisc = (t) => (/^\d+$/.test(String(t.trackNumber || '')) ? +t.trackNumber : t.absoluteTrackNumber);
        tracks.filter((t) => (tags.discNumber ? (t.mediumNumber || 1) === tags.discNumber && nums.indexOf(perDisc(t)) >= 0 : nums.indexOf(t.absoluteTrackNumber) >= 0)).forEach((t) => sel.add(t.id));
      }
      return new Promise((resolve) => {
        let done = false;
        const ok = App.btn('Valider', { cls: 'pri', icon: 'check', onClick: () => {
          done = true;
          s.close();
          if (rel) st.albumReleaseId = rel;
          resolve(tracks.filter((t) => sel.has(t.id)));
        } });
        const upd = () => {
          ok.querySelector('span').textContent = sel.size ? 'Valider (' + sel.size + ')' : 'Valider';
          ok.disabled = !sel.size;
        };
        const multi = tracks.some((t) => (t.mediumNumber || 1) > 1);
        const s = App.sheet({
          title: album.title,
          full: true,
          body: [h('div.s.mono.wrap', { style: { fontSize: '12px', color: 'var(--muted)', marginBottom: '12px' } }, U.baseName(st.f.path || st.f.name || '')),
            h('div.group', { style: { padding: '0 14px' } }, tracks.map((t) => App.checkRow((trkNo(t, multi, true) || '?') + ' · ' + (t.title || '?'), sel.has(t.id), (v) => {
              if (v) sel.add(t.id);
              else sel.delete(t.id);
              upd();
            })))],
          actions: [App.btn('Annuler', { onClick: () => s.close() }), ok],
          onClose: () => {
            if (!done) resolve(null);
          }
        });
        upd();
      });
    }

    // ---------- Import manuel ----------
    // o = { downloadId, folder, title }. Files are matched to items already in the library; nothing is searched or monitored.
    M.openManualImport = async function (o) {
      o = o || {};
      if (!M.configured()) return App.openSettings(svc);
      let folder = trimSlash(o.folder || '');
      let downloadId = o.downloadId || '';
      let files = [];
      const listEl = h('div');
      const folderEl = h('div.mono.wrap.sel', { style: { fontSize: '12px', flex: '1', minWidth: '0' } });
      const modeSel = App.select([
        { value: 'copy', label: 'Copier / lien physique (garde le seed)' },
        { value: 'move', label: 'Déplacer (arrête le seed)' }
      ], App.pref(svc + '.miMode', 'copy'));
      const go = App.btn('Importer', { cls: 'pri', icon: 'inbox-arrow-down', onClick: submit });
      const ready = (st) => !!st.media && (isR || (isL ? !!st.album && st.tracks.length > 0 : st.episodes.length > 0));
      const s = App.sheet({
        title: 'Import manuel',
        full: true,
        body: [
          o.title ? h('div', { style: { fontWeight: '650', marginBottom: '8px', wordBreak: 'break-word' } }, o.title) : null,
          h('div.card', { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px' } }, App.icon('folder-open'), folderEl,
            App.btn('Changer', { cls: 'ghost sm', onClick: changeFolder })),
          App.field('Mode', modeSel),
          listEl
        ],
        actions: [App.btn('Annuler', { onClick: () => s.close() }), go]
      });
      function setFolderText() {
        folderEl.textContent = folder || (downloadId ? 'Téléchargement suivi par ' + M.name : 'Aucun dossier');
      }
      function updateCount() {
        const n = files.filter((st) => st.sel).length;
        go.querySelector('span').textContent = n ? 'Importer (' + n + ')' : 'Importer';
        go.disabled = !n;
      }
      async function fetchItems() {
        const api = M.api();
        let list = null;
        let err = null;
        if (downloadId) {
          try {
            list = await api.get('/manualimport', { downloadId: downloadId, filterExistingFiles: true });
          } catch (e) {
            err = e;
          }
        }
        if ((!list || !list.length) && folder) list = await api.get('/manualimport', { folder: folder, filterExistingFiles: true });
        else if (err) throw err;
        return Array.isArray(list) ? list : [];
      }
      async function load() {
        setFolderText();
        files = [];
        updateCount();
        App.fill(listEl, App.loading());
        try {
          const r = await Promise.all([fetchItems(), M.loadLib().catch(() => null)]);
          files = r[0].map((f) => {
            const st = { f: f, media: (isR ? f.movie : isL ? f.artist : f.series) || null, episodes: (!isR && !isL && f.episodes) || [], quality: f.quality, sel: false };
            if (isL) Object.assign(st, { album: f.album || null, albumReleaseId: f.albumReleaseId || null, tracks: f.tracks || [] });
            if (st.media && st.media.id) st.media = M.get(st.media.id) || prepped(st.media);
            st.sel = ready(st) && !(f.rejections || []).length;
            return st;
          });
          if (!folder && files.length && files[0].f.path) folder = parentOf(files[0].f.path);
          setFolderText();
          renderList();
        } catch (e) {
          App.fill(listEl, App.empty('exclamation-triangle', 'Lecture impossible', e.message, [App.btn('Choisir un dossier', { icon: 'folder-open', onClick: changeFolder })]));
        }
      }
      async function changeFolder() {
        const v = await App.prompt({ title: 'Dossier à importer', label: 'Chemin vu par ' + M.name, value: folder, placeholder: '/data/torrents/' + svc, ok: 'Analyser' });
        if (v == null || !v.trim()) return;
        folder = trimSlash(v.trim());
        downloadId = '';
        App.setPref(svc + '.miFolder', folder);
        await load();
      }
      function matchLabel(st) {
        if (isL) {
          if (!st.media) return 'Choisir l’artiste';
          const a = nameOf(st.media);
          if (!st.album) return a + ' · choisir l’album';
          if (!st.tracks.length) return a + ' · ' + st.album.title + ' · choisir les pistes';
          const multi = st.tracks.some((x) => (x.mediumNumber || 1) > 1);
          const n = st.tracks.slice().sort((x, y) => (x.mediumNumber || 0) - (y.mediumNumber || 0) || (x.absoluteTrackNumber || 0) - (y.absoluteTrackNumber || 0))
            .map((x) => trkNo(x, multi, multi)).filter((x) => x != null);
          return a + ' · ' + st.album.title + ' · ' + (n.length === st.tracks.length && n.length <= 3 ? 'piste' + (n.length > 1 ? 's ' : ' ') + n.join(', ') : fmt.plural(st.tracks.length, 'piste'));
        }
        if (!st.media) return isR ? 'Choisir le film' : 'Choisir la série';
        const t = st.media.title + (isR && st.media.year ? ' (' + st.media.year + ')' : '');
        if (isR) return t;
        if (!st.episodes.length) return t + ' · choisir les épisodes';
        const e = st.episodes.slice().sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
        const one = e.every((x) => x.seasonNumber === e[0].seasonNumber);
        return t + ' · ' + (one ? 'S' + pad(e[0].seasonNumber) + e.map((x) => 'E' + pad(x.episodeNumber)).join('') : e.map((x) => epCode(x.seasonNumber, x.episodeNumber)).join(', '));
      }
      // Lidarr re-matches the tracks once artist + album are known (same call as its own interactive import).
      async function reprocess(sts) {
        const res = await M.api().post('/manualimport', sts.map((st) => ({
          id: st.f.id, path: st.f.path, name: st.f.name, size: st.f.size,
          artistId: st.media ? st.media.id : undefined, albumId: st.album ? st.album.id : undefined,
          albumReleaseId: st.albumReleaseId || undefined, quality: st.quality, releaseGroup: st.f.releaseGroup,
          indexerFlags: st.f.indexerFlags || 0, downloadId: st.f.downloadId || downloadId || undefined,
          additionalFile: !!st.f.additionalFile, replaceExistingFiles: false, disableReleaseSwitching: !!st.f.disableReleaseSwitching
        })));
        (Array.isArray(res) ? res : []).forEach((r) => {
          const st = sts.find((x) => x.f.id != null && x.f.id === r.id) || sts.find((x) => x.f.path === r.path);
          if (!st) return;
          st.tracks = r.tracks || [];
          if (r.albumReleaseId) st.albumReleaseId = r.albumReleaseId;
          st.f.rejections = r.rejections || [];
          st.sel = ready(st) && !st.f.rejections.length;
        });
      }
      async function pickMusic(st) {
        let artist = st.media;
        if (artist) {
          const what = await App.pick({ title: nameOf(artist), options: [
            st.album ? { value: 'tracks', label: 'Choisir les pistes', icon: 'list-bullet' } : null,
            { value: 'album', label: st.album ? 'Changer d’album' : 'Choisir l’album', icon: 'musical-note' },
            { value: 'artist', label: 'Changer d’artiste', icon: 'arrows-right-left' }
          ].filter(Boolean) });
          if (!what) return;
          if (what === 'tracks') {
            const tr = await pickTracks(st.album, st);
            if (tr) Object.assign(st, { tracks: tr, sel: tr.length > 0 });
            return renderList();
          }
          if (what === 'artist') artist = null;
        }
        if (!artist) artist = await pickMedia(st.f, st.media);
        if (!artist) return;
        const album = await pickAlbum(artist, st.media === artist ? st.album : null);
        if (!album) return;
        // Same album for this file and the unmatched files of its folder.
        const dir = parentOf(st.f.path);
        const group = files.filter((x) => x === st || (!x.album && parentOf(x.f.path) === dir));
        group.forEach((x) => Object.assign(x, { media: artist, album: album, albumReleaseId: null, tracks: [], sel: false }));
        App.fill(listEl, App.loading());
        try {
          await reprocess(group);
        } catch (e) {
          App.err(e);
        }
        renderList();
      }
      async function pickMatch(st) {
        if (!M.cache.items) await M.loadLib();
        if (isL) return pickMusic(st);
        if (!isR && st.media) {
          const what = await App.pick({ title: st.media.title, options: [
            { value: 'eps', label: 'Choisir les épisodes', icon: 'list-bullet' },
            { value: 'series', label: 'Changer de série', icon: 'tv' }
          ] });
          if (!what) return;
          if (what === 'eps') {
            const eps = await pickEpisodes(st.media, st);
            if (eps) Object.assign(st, { episodes: eps, sel: eps.length > 0 });
            return renderList();
          }
        }
        const x = await pickMedia(st.f, st.media);
        if (!x) return;
        if (isR) {
          Object.assign(st, { media: x, sel: true });
          return renderList();
        }
        const eps = await pickEpisodes(x, st);
        if (!eps) return;
        Object.assign(st, { media: x, episodes: eps, sel: eps.length > 0 });
        renderList();
      }
      function fileRow(st) {
        const f = st.f;
        const cb = h('input.cb', { type: 'checkbox', checked: st.sel });
        cb.addEventListener('change', () => {
          if (cb.checked && !ready(st)) {
            cb.checked = false;
            App.toast(isR ? 'Choisis d’abord le film' : isL ? 'Choisis d’abord l’artiste, l’album et les pistes' : 'Choisis d’abord la série et les épisodes');
            return;
          }
          st.sel = cb.checked;
          updateCount();
        });
        const langs = (f.languages || []).map((l) => l.name).filter((n) => n && n !== 'Unknown').join(', ');
        const qBtn = h('button', { type: 'button', title: 'Changer la qualité' }, App.badge(U.qualityName(st.quality) || 'Qualité ?', 'violet', 'pencil-square'));
        qBtn.addEventListener('click', () => App.run(async () => {
          if (await pickQuality(st)) renderList();
        }));
        const match = h('button.match' + (ready(st) ? '' : '.none'), { type: 'button' }, App.icon(M.icon, 'sm'), h('span', matchLabel(st)), App.icon('chevron-right', 'xs'));
        match.addEventListener('click', () => App.run(() => pickMatch(st)));
        const tags = isL && f.audioTags ? [f.audioTags.artistTitle, f.audioTags.albumTitle, f.audioTags.title].filter(Boolean).join(' · ') : '';
        return h('div.mi-file', cb, h('div.main',
          h('div.fn.sel', f.relativePath || f.name || U.baseName(f.path)),
          tags ? h('div.s.nowrap', { style: { fontSize: '12px', color: 'var(--muted)', marginTop: '2px' } }, 'Tags : ' + tags) : null,
          h('div.badges', { style: { marginTop: '6px' } }, f.size ? App.badge(fmt.bytes(f.size)) : null, qBtn, langs ? App.badge(langs, 'cyan') : null, f.releaseGroup ? App.badge(f.releaseGroup) : null),
          match,
          (f.rejections || []).map((r) => h('div.rej', '• ' + (r.reason || r)))));
      }
      function renderList() {
        updateCount();
        if (!files.length) {
          return App.fill(listEl, App.empty('inbox-arrow-down', 'Aucun fichier à importer', 'Dossier vide, déjà importé ou inaccessible pour ' + M.name + '.', [
            App.btn('Changer de dossier', { icon: 'folder-open', onClick: changeFolder })
          ]));
        }
        const all = files.every((st) => st.sel);
        const toggle = App.btn(all ? 'Tout décocher' : 'Tout cocher', { cls: 'ghost sm', onClick: () => {
          files.forEach((st) => {
            st.sel = !all && ready(st);
          });
          renderList();
        } });
        App.fill(listEl, App.secTitle(fmt.plural(files.length, 'fichier'), toggle), h('div.group', files.map(fileRow)),
          App.note('« Copier » crée un lien physique quand c’est possible : le torrent continue de seeder sur C411.', '', 'information-circle'));
      }
      async function submit() {
        const chosen = files.filter((st) => st.sel);
        if (!chosen.length) throw App.mkErr('Sélectionne au moins un fichier');
        if (chosen.some((st) => !ready(st))) throw App.mkErr(isR ? 'Associe chaque fichier à un film' : isL ? 'Associe chaque fichier à un album et ses pistes' : 'Associe chaque fichier à une série et ses épisodes');
        const body = isL ? {
          importMode: modeSel.value,
          replaceExistingFiles: false,
          files: chosen.map((st) => ({
            path: st.f.path, artistId: st.media.id, albumId: st.album.id, albumReleaseId: st.albumReleaseId || relOf(st.album),
            trackIds: st.tracks.map((t) => t.id), quality: st.quality, indexerFlags: st.f.indexerFlags || 0,
            downloadId: st.f.downloadId || downloadId || undefined, disableReleaseSwitching: !!st.f.disableReleaseSwitching
          }))
        } : {
          importMode: modeSel.value,
          files: chosen.map((st) => {
            const f = st.f;
            const x = {
              path: f.path, folderName: f.folderName, quality: st.quality, releaseGroup: f.releaseGroup, indexerFlags: f.indexerFlags || 0,
              languages: f.languages && f.languages.length ? f.languages : [{ id: 0, name: 'Unknown' }],
              downloadId: f.downloadId || downloadId || undefined
            };
            if (isR) x.movieId = st.media.id;
            else {
              x.seriesId = st.media.id;
              x.episodeIds = st.episodes.map((e) => e.id);
              x.releaseType = f.releaseType && f.releaseType !== 'unknown' ? f.releaseType : st.episodes.length > 1 ? 'multiEpisode' : 'singleEpisode';
            }
            return x;
          })
        };
        App.setPref(svc + '.miMode', modeSel.value);
        s.close();
        App.toast('Import de ' + fmt.plural(chosen.length, 'fichier') + ' lancé…');
        await M.runCommand('ManualImport', body, { label: 'Import manuel', wait: true, timeout: 180000 });
        M.loadLib(true).catch(() => {});
        qLoop.kick();
      }
      load();
    };
  };
})();
