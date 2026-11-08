/* Arr411 - Radarr & Sonarr: library, details, editing and adding (activity, calendar, system: arr-more.js). */
(function () {
  'use strict';
  const App = window.App;
  const h = App.h;
  const fmt = App.fmt;
  App.arrUI = App.arrUI || {};

  const MIN_AVAIL = [
    { value: 'announced', label: 'Annoncé' },
    { value: 'inCinemas', label: 'Sorti au cinéma' },
    { value: 'released', label: 'Sorti en numérique / physique' }
  ];
  const SERIES_TYPES = [
    { value: 'standard', label: 'Standard' },
    { value: 'anime', label: 'Anime (numérotation absolue)' },
    { value: 'daily', label: 'Quotidienne (par date)' }
  ];
  const STATUS_LABEL = {
    tba: 'À venir', announced: 'Annoncé', inCinemas: 'Au cinéma', released: 'Sorti', deleted: 'Supprimé',
    continuing: 'En cours', ended: 'Terminée', upcoming: 'À venir'
  };
  const EVENTS = {
    grabbed: ['Récupéré', 'cloud-arrow-down', 'blue'],
    downloadFolderImported: ['Importé', 'inbox-arrow-down', 'green'],
    movieFolderImported: ['Importé depuis le dossier', 'folder', 'green'],
    seriesFolderImported: ['Importé depuis le dossier', 'folder', 'green'],
    downloadFailed: ['Échec du téléchargement', 'exclamation-triangle', 'red'],
    movieFileDeleted: ['Fichier supprimé', 'trash', 'red'],
    episodeFileDeleted: ['Fichier supprimé', 'trash', 'red'],
    movieFileRenamed: ['Fichier renommé', 'pencil-square', 'violet'],
    episodeFileRenamed: ['Fichier renommé', 'pencil-square', 'violet'],
    downloadIgnored: ['Ignoré', 'eye-slash', ''],
    artistFolderImported: ['Importé depuis le dossier', 'folder', 'green'],
    trackFileImported: ['Piste importée', 'inbox-arrow-down', 'green'],
    downloadImported: ['Téléchargement importé', 'inbox-arrow-down', 'green'],
    albumImportIncomplete: ['Import incomplet', 'exclamation-triangle', 'amber'],
    trackFileDeleted: ['Fichier supprimé', 'trash', 'red'],
    trackFileRenamed: ['Fichier renommé', 'pencil-square', 'violet'],
    trackFileRetagged: ['Tags mis à jour', 'tag', 'violet']
  };
  const DELETE_REASON = { Manual: 'Suppression manuelle', MissingFromDisk: 'Absent du disque', Upgrade: 'Remplacé par une meilleure version' };
  const COLOR_VAR = { green: 'var(--pri)', red: 'var(--red)', amber: 'var(--amber)', blue: 'var(--blue)', violet: 'var(--violet)', cyan: 'var(--cyan)', pink: 'var(--pink)', '': 'var(--gray)' };

  const FILTERS = {
    radarr: [
      { k: 'all', label: 'Tous les films' },
      { k: 'file', label: 'Téléchargés', fn: (x, M) => M.status(x).key === 'file' },
      { k: 'missing', label: 'Manquants', fn: (x, M) => M.status(x).key === 'missing' },
      { k: 'soon', label: 'Pas encore sortis', fn: (x, M) => M.status(x).key === 'soon' },
      { k: 'mon', label: 'Surveillés', fn: (x) => x.monitored }
    ],
    sonarr: [
      { k: 'all', label: 'Toutes les séries' },
      { k: 'complete', label: 'Complètes', fn: (x, M) => M.status(x).key === 'complete' },
      { k: 'partial', label: 'Incomplètes', fn: (x, M) => M.status(x).key === 'partial' },
      { k: 'empty', label: 'Sans épisode', fn: (x, M) => /empty|soon/.test(M.status(x).key) },
      { k: 'continuing', label: 'En cours de diffusion', fn: (x) => x.status === 'continuing' },
      { k: 'ended', label: 'Terminées', fn: (x) => x.status === 'ended' },
      { k: 'anime', label: 'Anime', fn: (x) => x.seriesType === 'anime' || /anim/i.test(x.rootFolderPath || x.path || '') },
      { k: 'mon', label: 'Surveillées', fn: (x) => x.monitored }
    ],
    lidarr: [
      { k: 'all', label: 'Tous les artistes' },
      { k: 'complete', label: 'Complets', fn: (x, M) => M.status(x).key === 'complete' },
      { k: 'partial', label: 'Incomplets', fn: (x, M) => M.status(x).key === 'partial' },
      { k: 'empty', label: 'Sans piste', fn: (x, M) => M.status(x).key === 'empty' },
      { k: 'mon', label: 'Surveillés', fn: (x) => x.monitored }
    ]
  };
  const SORTS = {
    radarr: [
      { k: 'added', label: 'Date d’ajout' },
      { k: 'title', label: 'Titre' },
      { k: 'year', label: 'Année' },
      { k: 'release', label: 'Date de sortie' },
      { k: 'size', label: 'Taille sur le disque' },
      { k: 'rating', label: 'Note' }
    ],
    sonarr: [
      { k: 'added', label: 'Date d’ajout' },
      { k: 'title', label: 'Titre' },
      { k: 'year', label: 'Année' },
      { k: 'airing', label: 'Prochaine diffusion' },
      { k: 'size', label: 'Taille sur le disque' },
      { k: 'rating', label: 'Note' }
    ],
    lidarr: [
      { k: 'added', label: 'Date d’ajout' },
      { k: 'title', label: 'Nom' },
      { k: 'albums', label: 'Nombre d’albums' },
      { k: 'size', label: 'Taille sur le disque' },
      { k: 'rating', label: 'Note' }
    ]
  };

  // ---------- Helpers ----------
  const pad = (n) => String(n == null ? 0 : n).padStart(2, '0');
  const ts = (v) => {
    const d = fmt.toDate(v);
    return d ? d.getTime() : 0;
  };
  const coll = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
  const titleKey = (x) => x.sortTitle || App.norm(x.title);
  const cleanName = (n) => (App.qbit && App.qbit.cleanName ? App.qbit.cleanName(n) : String(n || ''));
  const sizeOf = (x) => (x && ((x.statistics && x.statistics.sizeOnDisk) || x.sizeOnDisk || (x.movieFile && x.movieFile.size))) || 0;
  function ratingOf(x) {
    const r = (x && x.ratings) || {};
    if (r.imdb && r.imdb.value) return { v: r.imdb.value, src: 'IMDb' };
    if (r.tmdb && r.tmdb.value) return { v: r.tmdb.value, src: 'TMDB' };
    if (r.value) return { v: r.value, src: '' };
    return null;
  }
  function langName(l) {
    if (!l) return '';
    if (Array.isArray(l)) return l.map(langName).filter(Boolean).join(', ');
    return typeof l === 'string' ? l : l.name || '';
  }
  const qualityName = (q) => (q && q.quality && q.quality.name) || '';
  const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  function joinPath(root, leaf) {
    root = String(root || '').replace(/[\\/]+$/, '');
    const sep = root.indexOf('/') < 0 && root.indexOf('\\') >= 0 ? '\\' : '/';
    return root + sep + leaf;
  }
  function colorIcon(name, color) {
    const ic = App.icon(name);
    ic.style.color = COLOR_VAR[color || ''] || color;
    return ic;
  }
  function act(ic, label, fn, danger) {
    const b = h('button.act' + (danger ? '.danger' : ''), { type: 'button' }, App.icon(ic), h('span', label));
    b.addEventListener('click', () => App.run(fn));
    return b;
  }
  function remoteSized(u, type, size) {
    if (!u) return null;
    if (/image\.tmdb\.org\/t\/p\/original\//.test(u)) {
      const w = type === 'poster' ? (size && size <= 250 ? 'w342' : 'w500') : 'w1280';
      return u.replace('/original/', '/' + w + '/');
    }
    return u;
  }
  function looksAnime(r) {
    const g = (r.genres || []).map((x) => String(x).toLowerCase());
    if (g.indexOf('anime') >= 0) return true;
    const lang = r.originalLanguage ? r.originalLanguage.name || r.originalLanguage : '';
    return g.indexOf('animation') >= 0 && /japan|tokyo|fuji|mbs|tbs|nhk|at-x|nippon|crunchyroll|abema|wowow|bs11|asahi/i.test(lang + ' ' + (r.network || '') + ' ' + (r.originalCountry || ''));
  }
  function fileKv(f) {
    const mi = f.mediaInfo || {};
    const res = mi.resolution || (mi.width && mi.height ? mi.width + 'x' + mi.height : '');
    return App.kv([
      ['Qualité', qualityName(f.quality)],
      ['Taille', f.size ? fmt.bytes(f.size) : ''],
      ['Vidéo', [mi.videoCodec, res, mi.videoDynamicRangeType || mi.videoDynamicRange, mi.videoBitDepth ? mi.videoBitDepth + ' bits' : ''].filter(Boolean).join(' · ')],
      ['Audio', [mi.audioCodec, mi.audioChannels ? String(mi.audioChannels) : '', mi.audioLanguages].filter(Boolean).join(' · ')],
      ['Sous-titres', mi.subtitles],
      ['Durée', mi.runTime],
      ['Langues', langName(f.languages || f.language)],
      ['Groupe', f.releaseGroup],
      ['Édition', f.edition],
      ['Formats perso.', (f.customFormats || []).map((c) => c.name).join(', ')],
      ['Ajouté', fmt.dateTime(f.dateAdded)]
    ]);
  }
  App.arrUtil = { pad, ts, sizeOf, ratingOf, langName, qualityName, baseName, joinPath, colorIcon, act, fileKv, cleanName, COLOR_VAR, EVENTS, STATUS_LABEL, SERIES_TYPES, MIN_AVAIL };

  const relTs = (x) => ts(x.digitalRelease) || ts(x.physicalRelease) || ts(x.inCinemas) || 0;
  const trimSlash = (p) => String(p || '').replace(/[\\/]+$/, '');
  const rootOf = (x) => trimSlash(x.rootFolderPath || trimSlash(x.path).replace(/[\\/][^\\/]*$/, ''));
  const isFr = (a) => !!(a && a.language && /fren|fran/i.test(a.language.name || ''));
  const epCode = (s, e) => 'S' + pad(s) + (e != null ? 'E' + pad(e) : '');

  App.makeArr = function (svc) {
    const isR = svc === 'radarr';
    const isL = svc === 'lidarr';
    const M = {
      svc: svc,
      isR: isR,
      isL: isL,
      name: App.arrName(svc),
      tab: svc,
      noun: isR ? 'film' : isL ? 'artiste' : 'série',
      e: isR || isL ? '' : 'e',
      none: isR ? 'Aucun film' : isL ? 'Aucun artiste' : 'Aucune série',
      ep: isR ? '/movie' : isL ? '/artist' : '/series',
      icon: isR ? 'film' : isL ? 'musical-note' : 'tv',
      one: isR ? 'un film' : isL ? 'un artiste' : 'une série',
      refreshCmd: isR ? 'RefreshMovie' : isL ? 'RefreshArtist' : 'RefreshSeries',
      // Optional per-item normalizer (Lidarr maps artistName -> title).
      prep: null,
      cache: { items: null, byId: new Map(), at: 0, ver: 0, error: null, loading: null, meta: null, metaAt: 0, metaLoading: null, gen: 0 },
      sections: [],
      util: App.arrUtil
    };
    App.arrUI[svc] = M;
    M.api = () => App.arr(svc);
    M.configured = () => App.arr(svc).configured;

    // ---------- Library cache ----------
    M.loadLib = function (force) {
      const c = M.cache;
      if (!M.configured()) return Promise.resolve(null);
      if (c.loading) return c.loading;
      if (!force && c.items && Date.now() - c.at < 60000) return Promise.resolve(c.items);
      const gen = c.gen;
      const p = M.api().get(M.ep).then((list) => {
        if (gen !== c.gen) return c.items;
        list = Array.isArray(list) ? list : [];
        if (M.prep) list.forEach(M.prep);
        c.items = list;
        c.byId = new Map(list.map((x) => [x.id, x]));
        c.at = Date.now();
        c.ver++;
        c.error = null;
        return list;
      }, (e) => {
        if (gen === c.gen) c.error = e;
        throw e;
      });
      c.loading = p;
      const done = () => {
        if (gen === c.gen && c.loading === p) c.loading = null;
        App.emit(svc + ':lib');
      };
      p.then(done, done);
      App.emit(svc + ':lib');
      return p;
    };
    M.get = (id) => M.cache.byId.get(Number(id)) || null;
    M.upsert = function (x) {
      if (!x || x.id == null) return x;
      if (M.prep) M.prep(x);
      const c = M.cache;
      c.byId.set(x.id, x);
      if (c.items) {
        const i = c.items.findIndex((y) => y.id === x.id);
        if (i >= 0) c.items[i] = x;
        else c.items.push(x);
      }
      c.ver++;
      App.emit(svc + ':lib');
      App.emit(svc + ':item', x);
      return x;
    };
    M.remove = function (id) {
      const c = M.cache;
      c.byId.delete(id);
      if (c.items) c.items = c.items.filter((y) => y.id !== id);
      c.ver++;
      App.emit(svc + ':lib');
      App.emit(svc + ':item', { id: id, deleted: true });
    };
    M.fetchItem = async function (id) {
      return M.upsert(await M.api().get(M.ep + '/' + id));
    };
    M.reset = function () {
      const c = M.cache;
      Object.assign(c, { items: null, byId: new Map(), at: 0, error: null, loading: null, meta: null, metaAt: 0, metaLoading: null });
      c.gen++;
      c.ver++;
      App.emit(svc + ':reset');
      App.emit(svc + ':lib');
    };
    M.findByIds = function (ids) {
      ids = ids || {};
      const list = M.cache.items || Array.from(M.cache.byId.values());
      return list.find((x) =>
        (ids.tmdb && x.tmdbId === Number(ids.tmdb)) || (ids.tvdb && x.tvdbId === Number(ids.tvdb)) || (ids.imdb && x.imdbId && x.imdbId === ids.imdb)
      ) || null;
    };
    M.inLib = function (r) {
      if (!r) return null;
      if (r.id) return M.get(r.id) || r;
      return isR ? M.findByIds({ tmdb: r.tmdbId, imdb: r.imdbId }) : M.findByIds({ tvdb: r.tvdbId });
    };

    // ---------- Profiles, root folders, tags ----------
    M.meta = function (force) {
      const c = M.cache;
      if (!force && c.meta && Date.now() - c.metaAt < 300000) return Promise.resolve(c.meta);
      if (c.metaLoading) return c.metaLoading;
      const api = M.api();
      const gen = c.gen;
      const p = Promise.all([
        api.get('/qualityprofile'),
        api.get('/rootfolder'),
        api.get('/tag').catch(() => []),
        isR || isL ? null : api.get('/languageprofile').catch(() => null),
        isL ? api.get('/metadataprofile').catch(() => []) : null
      ]).then((r) => {
        const m = { profiles: r[0] || [], roots: r[1] || [], tags: r[2] || [], langs: Array.isArray(r[3]) ? r[3] : null, metaProfiles: Array.isArray(r[4]) ? r[4] : null };
        if (gen === c.gen) {
          c.meta = m;
          c.metaAt = Date.now();
        }
        return m;
      });
      c.metaLoading = p;
      const done = () => {
        if (c.metaLoading === p) c.metaLoading = null;
      };
      p.then(done, done);
      return p;
    };
    M.profileName = function (id) {
      const m = M.cache.meta;
      const p = m && m.profiles.find((x) => x.id === id);
      return p ? p.name : '';
    };
    M.tagLabels = function (ids) {
      const m = M.cache.meta;
      if (!m || !ids) return [];
      return ids.map((i) => (m.tags.find((t) => t.id === i) || {}).label).filter(Boolean);
    };

    // ---------- Images ----------
    // Local covers go through the server's cached /mediacover proxy; TMDB/TVDB remote images as fallback.
    M.mc = function (abs) {
      // Same-origin proxy: the session cookie authenticates the request and the server adds the API key.
      return abs || null;
    };
    M.cover = function (x, type, size) {
      const out = [];
      if (!x) return out;
      const api = M.api();
      const im = (x.images || []).find((i) => i.coverType === type);
      if (im) {
        // Lidarr: /MediaCover/{artistId}/… and /MediaCover/Albums/{albumId}/… -> /api/v1/mediacover/artist|album/{id}/…
        const m = /MediaCover\/(?:(Albums)\/)?(\d+)\/([^?#]+)/.exec(im.url || '');
        if (m && api.base && x.id) {
          let fn = m[3];
          if (size) fn = fn.replace(/(-\d+)?(\.\w+)$/, '-' + size + '$2');
          const kind = isL ? (m[1] ? 'album/' : 'artist/') : '';
          out.push(M.mc(api.base + api.ver + '/mediacover/' + kind + m[2] + '/' + fn));
        }
        const r = remoteSized(im.remoteUrl, type, size);
        if (r) out.push(r);
      }
      if (type === 'poster' && x.remotePoster) out.push(x.remotePoster);
      return out;
    };
    M.poster = function (x, size, st) {
      const el = h('div.poster', h('div.ph', x.title || ''), App.img(M.cover(x, 'poster', size || 500)));
      if (st) el.appendChild(h('div.st', h('i', { style: { width: Math.round(Math.max(0, Math.min(1, st.fill || 0)) * 100) + '%', background: COLOR_VAR[st.color || ''] } })));
      return el;
    };

    // ---------- Status ----------
    M.counts = function (x) {
      let have = 0;
      let total = 0;
      const ss = (x.seasons || []).filter((s) => s.seasonNumber > 0 && s.statistics);
      if (ss.length) {
        ss.forEach((s) => {
          have += s.statistics.episodeFileCount || 0;
          total += s.statistics.totalEpisodeCount || 0;
        });
      } else if (x.statistics) {
        have = x.statistics.episodeFileCount || 0;
        total = x.statistics.totalEpisodeCount || 0;
      }
      return { have: have, total: total };
    };
    M.status = function (x) {
      if (isR) {
        if (x.hasFile || x.movieFile) return { key: 'file', label: 'Téléchargé', color: 'green', fill: 1 };
        if (x.isAvailable === false) return { key: 'soon', label: x.status === 'inCinemas' ? 'Au cinéma' : 'Pas encore sorti', color: 'blue', fill: 1 };
        return { key: 'missing', label: 'Manquant', color: 'amber', fill: 1 };
      }
      const n = M.counts(x);
      if (n.total > 0 && n.have >= n.total) return { key: 'complete', label: 'Complète', color: 'green', fill: 1 };
      if (n.have > 0) return { key: 'partial', label: n.have + '/' + n.total + ' ép.', color: 'amber', fill: n.total ? n.have / n.total : 0 };
      if (x.status === 'upcoming' || (!n.total && x.nextAiring) || ts(x.firstAired) > Date.now()) return { key: 'soon', label: 'À venir', color: 'blue', fill: 0 };
      return { key: 'empty', label: 'Aucun épisode', color: '', fill: 0 };
    };
    M.metaLine = function (x) {
      const p = [];
      if (x.year) p.push(String(x.year));
      if (isR) {
        if (x.runtime) p.push(fmt.runtime(x.runtime));
        if (x.certification) p.push(x.certification);
      } else {
        const ns = (x.seasons || []).filter((s) => s.seasonNumber > 0).length || (x.statistics && x.statistics.seasonCount) || 0;
        if (ns) p.push(fmt.plural(ns, 'saison'));
        if (x.network) p.push(x.network);
      }
      return p.join(' · ');
    };

    // ---------- Shared widgets ----------
    M.tagPicker = function (meta, selected) {
      const sel = new Set(selected || []);
      const box = h('div.chips.inner', { style: { flexWrap: 'wrap', overflow: 'visible' } });
      function render() {
        App.clear(box);
        meta.tags.slice().sort((a, b) => coll.compare(a.label, b.label)).forEach((t) => {
          const on = sel.has(t.id);
          const b = h('button.chip.sm' + (on ? '.on' : ''), { type: 'button' }, App.icon(on ? 'check' : 'tag', 'xs'), h('span', t.label));
          b.addEventListener('click', () => {
            if (on) sel.delete(t.id);
            else sel.add(t.id);
            render();
          });
          box.appendChild(b);
        });
        const add = h('button.chip.sm', { type: 'button' }, App.icon('plus', 'xs'), h('span', 'Nouvelle'));
        add.addEventListener('click', () => App.run(async () => {
          const v = await App.prompt({ title: 'Nouvelle étiquette', label: 'Nom', placeholder: 'ex. 4k', ok: 'Créer', hint: 'Lettres, chiffres et tirets uniquement.' });
          const label = App.norm(v || '').trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
          if (!label) return;
          let t = meta.tags.find((x) => String(x.label).toLowerCase() === label);
          if (!t) {
            t = await M.api().post('/tag', { label: label });
            meta.tags.push(t);
          }
          sel.add(t.id);
          render();
        }));
        box.appendChild(add);
      }
      render();
      return { el: box, value: () => Array.from(sel) };
    };

    // Starts a command; with o.wait, polls until it ends (throws on failure).
    M.runCommand = async function (name, body, o) {
      o = o || {};
      const api = M.api();
      const label = o.label || name;
      let cmd = await api.post('/command', Object.assign({ name: name }, body || {}));
      if (!o.wait || !cmd || !cmd.id) {
        if (o.toast !== false) App.toast(label + ' : lancé', 'ok');
        return cmd;
      }
      const end = Date.now() + (o.timeout || 120000);
      while (Date.now() < end) {
        await App.sleep(1500);
        cmd = await api.get('/command/' + cmd.id);
        const s = String((cmd && (cmd.status || cmd.state)) || '').toLowerCase();
        if (s === 'completed') {
          if (o.toast !== false) App.toast(label + ' : terminé', 'ok');
          return cmd;
        }
        if (/failed|aborted|cancelled|orphaned/.test(s)) throw App.mkErr(label + ' : ' + (cmd.message || cmd.exception || s));
      }
      App.toast(label + ' : toujours en cours dans ' + M.name);
      return cmd;
    };

    M.searchC411 = function (x, suffix) {
      if (!x) return;
      const titles = [];
      const add = (t) => {
        t = String(t || '').trim();
        if (t && !titles.some((y) => App.norm(y) === App.norm(t))) titles.push(t);
      };
      add(x.title);
      (x.alternateTitles || []).forEach((a) => {
        if (isFr(a)) add(a.title);
      });
      add(x.originalTitle);
      const full = (t) => t + (suffix ? ' ' + suffix : '');
      if (titles.length <= 1) return App.c411Search(full(titles[0] || ''));
      return App.pick({ title: 'Chercher sur C411', options: titles.map((t) => ({ value: t, label: full(t), icon: 'magnifying-glass' })) }).then((v) => {
        if (v) App.c411Search(full(v));
      });
    };

    // ---------- History rows ----------
    const evInfo = (r) => EVENTS[r.eventType] || [r.eventType || 'Événement', 'information-circle', ''];
    const histMedia = (r) => (isR ? r.movie : isL ? r.artist : r.series) || null;
    const mediaTitle = (x) => (x ? x.title || x.artistName || '' : '');
    M.historyRow = function (r, o) {
      o = o || {};
      const ev = evInfo(r);
      const media = histMedia(r);
      const epi = isR || isL ? null : r.episode;
      const code = epi ? epCode(epi.seasonNumber, epi.episodeNumber) : isL && r.album ? r.album.title || '' : '';
      const title = o.showMedia && media ? mediaTitle(media) + (code ? ' · ' + code : '') : ev[0] + (code ? ' · ' + code : '');
      const sub = [o.showMedia ? ev[0] : null, qualityName(r.quality), fmt.rel(r.date)].filter(Boolean).join(' · ');
      const b = h('button.item', { type: 'button' }, colorIcon(ev[1], ev[2]),
        h('div.main', h('div.t.nowrap', title), h('div.s.nowrap', r.sourceTitle || ''), h('div.s', sub)));
      b.addEventListener('click', () => M.historySheet(r, o));
      return b;
    };
    M.historySheet = function (r, o) {
      o = o || {};
      const ev = evInfo(r);
      const d = r.data || {};
      const media = histMedia(r);
      const epi = isR || isL ? null : r.episode;
      const hash = /^[0-9a-f]{40}$/i.test(r.downloadId || '') ? r.downloadId.toLowerCase() : null;
      let s = null;
      const actions = [];
      if (hash && App.qbit && App.qbit.openDetails) {
        actions.push(App.btn('qBittorrent', { icon: 'arrow-down-tray', onClick: () => { s.close(); App.qbit.openDetails(hash); } }));
      }
      if (r.sourceTitle) actions.push(App.btn('C411', { icon: 'magnifying-glass', onClick: () => App.c411Search(cleanName(r.sourceTitle)) }));
      if (o.showMedia && media && media.id) {
        actions.push(App.btn('Fiche', { cls: 'pri', icon: M.icon, onClick: () => { s.close(); M.openDetails(media.id); } }));
      }
      s = App.sheet({
        title: ev[0],
        body: [
          r.sourceTitle ? h('div.card', h('div.mono.wrap.sel', r.sourceTitle)) : null,
          h('div.card', App.kv([
            [isR ? 'Film' : isL ? 'Artiste' : 'Série', mediaTitle(media)],
            [isL ? 'Album' : 'Épisode', epi ? epCode(epi.seasonNumber, epi.episodeNumber) + (epi.title ? ' · ' + epi.title : '') : isL && r.album ? r.album.title : ''],
            ['Date', fmt.dateTime(r.date)],
            ['Qualité', qualityName(r.quality)],
            ['Langues', langName(r.languages || r.language)],
            ['Groupe', d.releaseGroup],
            ['Indexeur', d.indexer],
            ['Client', d.downloadClientName || d.downloadClient],
            ['Taille', Number(d.size) ? fmt.bytes(Number(d.size)) : ''],
            ['Raison', DELETE_REASON[d.reason] || d.reason],
            ['Message', d.message],
            ['Importé vers', d.importedPath],
            ['Source', d.droppedPath]
          ]))
        ],
        actions: actions.length ? actions : null
      });
    };
    // ---------- Root page: section chips (Bibliothèque, Activité, Calendrier, Système) ----------
    let root = null;
    function updateSub() {
      if (!root) return;
      const c = M.cache;
      let t;
      if (!M.configured()) t = 'Non configuré';
      else if (c.items) {
        const size = c.items.reduce((a, x) => a + sizeOf(x), 0);
        t = fmt.plural(c.items.length, M.noun) + (size ? ' · ' + fmt.bytes(size) : '');
      } else if (c.error) t = 'Hors ligne';
      else t = 'Chargement…';
      root.page.setSub(t);
    }
    function buildRoot() {
      const page = App.page({ title: M.name });
      const chips = h('div.chips');
      const box = h('div.sections');
      const fab = h('button.fab', { type: 'button', 'aria-label': 'Ajouter ' + M.one, onclick: () => App.run(() => M.openAdd()) }, App.icon('plus'));
      App.append(page.el, chips, box, fab);
      root = { page: page, chips: chips, box: box, fab: fab, cur: null, built: {}, chipEls: {} };
      M.sections.forEach((s) => {
        const n = h('span.n.hidden');
        const dot = h('span.dot.hidden');
        const b = h('button.chip', { type: 'button', onclick: () => M.showSection(s.key) }, h('span', s.label), n, dot);
        b.n = n;
        b.dot = dot;
        root.chipEls[s.key] = b;
        chips.appendChild(b);
      });
      page.onShow = () => {
        updateSub();
        const s = root.built[root.cur];
        if (s && s.onShow) s.onShow();
      };
      page.onHide = () => {
        const s = root.built[root.cur];
        if (s && s.onHide) s.onHide();
      };
      M.root = root;
      App.push(svc, page);
      M.showSection('lib');
    }
    M.showSection = function (key) {
      if (!root) return;
      const def = M.sections.find((s) => s.key === key) || M.sections[0];
      key = def.key;
      const prev = root.built[root.cur];
      if (root.cur === key && prev) {
        if (prev.top) prev.top();
        return;
      }
      if (prev) {
        prev.el.classList.add('hidden');
        if (prev.onHide) prev.onHide();
      }
      let s = root.built[key];
      if (!s) {
        s = def.build();
        root.built[key] = s;
        root.box.appendChild(s.el);
        if (s.init) s.init();
      }
      root.cur = key;
      s.el.classList.remove('hidden');
      for (const k in root.chipEls) root.chipEls[k].classList.toggle('on', k === key);
      App.fill(root.page.actions, s.actions || []);
      root.fab.classList.toggle('hidden', key !== 'lib');
      if (s.onShow && App.isTop(root.page)) s.onShow();
    };
    M.chipCount = function (key, n) {
      const c = root && root.chipEls[key];
      if (!c) return;
      c.n.textContent = n ? String(n) : '';
      c.n.classList.toggle('hidden', !n);
    };
    M.chipDot = function (key, on) {
      const c = root && root.chipEls[key];
      if (c) c.dot.classList.toggle('hidden', !on);
    };
    M.isSectionVisible = (key) => !!root && root.cur === key && App.isTop(root.page);

    // ---------- Library section ----------
    function buildLib() {
      const prefs = Object.assign({ view: 'grid', sort: 'added', rev: false, filter: 'all' }, App.pref(svc + '.lib', {}));
      const save = () => App.setPref(svc + '.lib', prefs);
      let q = '';
      let searchOpen = false;
      let chunk = null;
      let sig = '';
      let stateKey = null;
      const el = h('div.section');
      const input = App.input({ type: 'search', placeholder: 'Rechercher ' + M.one, enterkeyhint: 'search' });
      input.addEventListener('input', App.debounce(() => {
        q = input.value;
        render();
      }, 150));
      const searchRow = h('div.sticky.hidden', h('div.search', App.icon('magnifying-glass'), input));
      const stateBox = h('div');
      const list = h('div.grid');
      App.append(el, searchRow, stateBox, list);
      const searchBtn = App.iconBtn('magnifying-glass', 'Rechercher', () => setSearch(!searchOpen));
      const filterDot = h('span.dot.hidden');
      const filterBtn = App.iconBtn('funnel', 'Filtrer', () => filterMenu());
      filterBtn.appendChild(filterDot);
      const actions = [searchBtn, filterBtn, App.iconBtn('bars-arrow-down', 'Trier et affichage', () => sortMenu()), App.iconBtn('ellipsis-vertical', 'Plus d’actions', () => moreMenu())];

      function setSearch(open) {
        searchOpen = open;
        searchRow.classList.toggle('hidden', !open);
        App.fill(searchBtn, App.icon(open ? 'x-mark' : 'magnifying-glass'));
        if (open) {
          el.scrollTop = 0;
          setTimeout(() => input.focus(), 60);
        } else {
          input.value = '';
          input.blur();
          if (q) {
            q = '';
            render();
          }
        }
      }
      function setState(key, make) {
        if (key === stateKey) return;
        stateKey = key;
        App.fill(stateBox, key ? make() : null);
      }
      function clearList() {
        if (chunk) chunk.dispose();
        chunk = null;
        App.clear(list);
        sig = '';
      }
      function sorter() {
        const k = prefs.sort;
        const dir = prefs.rev ? -1 : 1;
        const byTitle = (a, b) => coll.compare(titleKey(a), titleKey(b));
        let fn;
        if (k === 'title') fn = byTitle;
        else if (k === 'year') fn = (a, b) => (b.year || 0) - (a.year || 0);
        else if (k === 'size') fn = (a, b) => sizeOf(b) - sizeOf(a);
        else if (k === 'rating') fn = (a, b) => ((ratingOf(b) || {}).v || 0) - ((ratingOf(a) || {}).v || 0);
        else if (k === 'release') fn = (a, b) => relTs(b) - relTs(a);
        else if (k === 'airing') fn = (a, b) => (ts(a.nextAiring) || Infinity) - (ts(b.nextAiring) || Infinity);
        else if (k === 'albums') fn = (a, b) => ((b.statistics || {}).albumCount || 0) - ((a.statistics || {}).albumCount || 0);
        else fn = (a, b) => ts(b.added) - ts(a.added);
        return (a, b) => dir * fn(a, b) || byTitle(a, b);
      }
      function visibleItems() {
        const f = FILTERS[svc].find((x) => x.k === prefs.filter) || FILTERS[svc][0];
        let out = (M.cache.items || []).filter((x) => !f.fn || f.fn(x, M));
        const nq = App.norm(q).trim();
        if (nq) {
          out = out.filter((x) => App.norm([x.title, x.originalTitle, x.year].concat((x.alternateTitles || []).map((a) => a.title)).join(' ')).indexOf(nq) >= 0);
        }
        return out.sort(sorter());
      }
      function render() {
        const c = M.cache;
        filterDot.classList.toggle('hidden', prefs.filter === 'all');
        if (!M.configured()) {
          clearList();
          return setState('cfg', () => App.needSetup(M.icon, M.name, svc, 'Renseigne l’URL et la clé API de ' + M.name + ' dans les réglages.'));
        }
        if (!c.items) {
          clearList();
          if (c.error && !c.loading) {
            return setState('err:' + c.error.message, () => App.empty('exclamation-triangle', 'Impossible de joindre ' + M.name, c.error.message, [
              App.btn('Réessayer', { cls: 'pri', icon: 'arrow-path', onClick: () => M.loadLib(true).catch(() => {}) }),
              App.isAdmin ? App.btn('Réglages', { icon: 'cog-6-tooth', onClick: () => App.openSettings(svc) }) : null
            ]));
          }
          return setState('loading', () => App.loading());
        }
        const s = [prefs.view, prefs.sort, prefs.rev, prefs.filter, q, c.ver].join('|');
        if (s === sig) return;
        const items = visibleItems();
        clearList();
        sig = s;
        if (!items.length) {
          if (c.items.length) {
            return setState('none:' + s, () => App.empty(q ? 'magnifying-glass' : 'funnel', 'Aucun résultat', q ? M.none + ' ne correspond à « ' + q + ' ».' : M.none + ' dans ce filtre.', [
              App.btn('Tout afficher', { onClick: () => { prefs.filter = 'all'; save(); if (searchOpen) setSearch(false); render(); } })
            ]));
          }
          return setState('emptylib', () => App.empty(M.icon, 'Bibliothèque vide', isR ? 'Ajoute ton premier film : il restera non surveillé.' : isL ? 'Ajoute ton premier artiste : il restera non surveillé.' : 'Ajoute ta première série : elle restera non surveillée.', [
            App.btn('Ajouter', { cls: 'pri', icon: 'plus', onClick: () => M.openAdd() })
          ]));
        }
        setState(null);
        const asList = prefs.view === 'list';
        list.className = asList ? 'rows' : 'grid';
        chunk = App.chunked(list, items, asList ? rowEl : tileEl, asList ? 40 : 45, el);
      }
      function tileEl(x) {
        const st = M.status(x);
        const done = st.key === 'file' || st.key === 'complete';
        const b = h('button.tile', { type: 'button' }, M.poster(x, 500, st), h('div.tt', x.title), h('div.ty', [x.year, done ? '' : st.label].filter(Boolean).join(' · ')));
        b.addEventListener('click', () => M.openDetails(x.id));
        App.longPress(b, () => quickMenu(x));
        return b;
      }
      function rowEl(x) {
        const st = M.status(x);
        const size = sizeOf(x);
        const b = h('button.lrow', { type: 'button' }, M.poster(x, 250, st),
          h('div.main', h('div.t', x.title), h('div.s', M.metaLine(x)),
            h('div.badges', { style: { marginTop: '6px' } }, App.badge(st.label, st.color), size ? App.badge(fmt.bytes(size)) : null, x.monitored ? App.badge('Surveillé', 'violet', 'eye') : null)),
          App.icon('chevron-right', 'sm'));
        b.addEventListener('click', () => M.openDetails(x.id));
        App.longPress(b, () => quickMenu(x));
        return b;
      }
      function quickMenu(x) {
        App.menu({
          title: x.title,
          items: [
            { icon: 'magnifying-glass', label: 'Chercher sur C411', onClick: () => M.searchC411(x) },
            { icon: 'pencil-square', label: 'Modifier', onClick: () => M.openEdit(x) },
            x.monitored ? { icon: 'eye-slash', label: 'Ne plus surveiller', onClick: () => M.unmonitor(x) } : null,
            { icon: 'trash', label: 'Supprimer', danger: true, onClick: () => M.askDelete(x) }
          ]
        });
      }
      function filterMenu() {
        const items = M.cache.items || [];
        App.menu({
          title: 'Filtrer',
          checks: true,
          items: FILTERS[svc].map((f) => ({
            label: f.label,
            on: prefs.filter === f.k,
            right: h('span.dim', String(f.fn ? items.filter((x) => f.fn(x, M)).length : items.length)),
            onClick: () => {
              prefs.filter = f.k;
              save();
              render();
              el.scrollTop = 0;
            }
          }))
        });
      }
      function sortMenu() {
        const set = (patch) => {
          Object.assign(prefs, patch);
          save();
          render();
        };
        App.menu({
          title: 'Trier et afficher',
          checks: true,
          items: SORTS[svc].map((s) => ({ label: s.label, on: prefs.sort === s.k, onClick: () => { set({ sort: s.k }); el.scrollTop = 0; } })).concat([
            '-',
            { label: 'Ordre inversé', on: !!prefs.rev, onClick: () => set({ rev: !prefs.rev }) },
            '-',
            { label: 'Affichage en grille', on: prefs.view !== 'list', onClick: () => set({ view: 'grid' }) },
            { label: 'Affichage en liste', on: prefs.view === 'list', onClick: () => set({ view: 'list' }) }
          ])
        });
      }
      function moreMenu() {
        const api = M.api();
        App.menu({
          items: [
            { icon: 'plus', label: 'Ajouter ' + M.one, onClick: () => M.openAdd() },
            { icon: 'arrow-path', label: 'Actualiser la liste', onClick: () => M.loadLib(true) },
            api.configured ? { icon: 'cloud-arrow-down', label: 'Mettre à jour les métadonnées', sub: 'Toutes les fiches, sans aucune recherche', onClick: () => M.runCommand(M.refreshCmd, {}, { label: 'Mise à jour des métadonnées' }) } : null,
            '-',
            api.web ? { icon: 'arrow-top-right-on-square', label: 'Ouvrir l’interface web', onClick: () => App.openExternal(api.web) } : null,
            { icon: 'cog-6-tooth', label: 'Réglages ' + M.name, onClick: () => App.openSettings(svc) }
          ]
        });
      }
      App.on(svc + ':lib', () => render());
      return {
        el: el,
        actions: actions,
        init: render,
        onShow() {
          render();
          const c = M.cache;
          if (M.configured() && !c.loading && (!c.items || Date.now() - c.at > 60000)) M.loadLib().catch(() => {});
        },
        back() {
          if (!searchOpen) return false;
          setSearch(false);
          return true;
        },
        top() {
          el.scrollTo({ top: 0, behavior: 'smooth' });
        }
      };
    }
    // ---------- Details page ----------
    M.openDetails = function (id) {
      id = Number(id);
      if (!id) return;
      if (App.state.tab !== svc) App.goTab(svc);
      const stack = App.tabs[svc].stack;
      const top = stack[stack.length - 1];
      if (top && top.itemId === id) return;
      let x = M.get(id);
      let movieFile = null;
      let hist = null;
      let gone = false;
      const page = App.page({ title: '', back: true });
      page.itemId = id;
      App.append(page.actions,
        App.iconBtn('magnifying-glass', 'Chercher sur C411', () => M.searchC411(x)),
        App.iconBtn('ellipsis-vertical', 'Plus d’actions', () => x && detailsMenu()));
      const scroll = h('div.scroll');
      page.el.appendChild(scroll);
      const seasonsBox = h('div');
      const historyBox = h('div');
      let titled = false;
      scroll.addEventListener('scroll', () => {
        const t = !!x && scroll.scrollTop > 160;
        if (t !== titled) {
          titled = t;
          page.setTitle(t ? x.title : '');
        }
      }, { passive: true });
      const close = () => {
        if (stack[stack.length - 1] === page) App.pop(svc);
      };

      function render() {
        if (gone) return;
        if (!x) return App.fill(scroll, App.loading());
        const keep = scroll.scrollTop;
        const st = M.status(x);
        const rating = ratingOf(x);
        const ov = x.overview ? h('p.overview.clamp', x.overview) : null;
        if (ov) ov.addEventListener('click', () => ov.classList.toggle('clamp'));
        App.fill(scroll,
          h('div.hero', App.img(M.cover(x, 'fanart'))),
          h('div.hero-info', M.poster(x, 500),
            h('div.main', h('h2.sel', x.title), h('div.s', M.metaLine(x)),
              h('div.badges', App.badge(st.label, st.color),
                x.monitored ? App.badge('Surveillé', 'violet', 'eye') : App.badge('Non surveillé', '', 'eye-slash'),
                rating ? App.badge(Number(rating.v).toFixed(1) + (rating.src ? ' ' + rating.src : ''), 'amber', 'star') : null))),
          h('div.actions-grid',
            act('magnifying-glass', 'C411', () => M.searchC411(x)),
            act('pencil-square', 'Modifier', () => M.openEdit(x)),
            act('arrow-path', 'Actualiser', () => refresh()),
            act('trash', 'Supprimer', () => M.askDelete(x, close), true)),
          ov,
          isR ? fileSection(st) : [App.secTitle('Saisons'), seasonsBox],
          App.secTitle('Informations'),
          h('div.card', infoKv()),
          App.secTitle('Historique'),
          historyBox);
        scroll.scrollTop = keep;
      }
      function fileSection(st) {
        const f = x.movieFile || movieFile;
        if (f) {
          const path = f.path || (x.path && f.relativePath ? joinPath(x.path, f.relativePath) : '');
          return [App.secTitle('Fichier'), h('div.card',
            h('div.mono.wrap.sel', { style: { marginBottom: '12px' } }, f.relativePath || baseName(f.path)),
            fileKv(f),
            h('div.btn-row', { style: { marginTop: '14px' } },
              path ? App.btn('Copier le chemin', { cls: 'sm', icon: 'clipboard-document', onClick: () => App.copy(path, 'Chemin') }) : null,
              App.btn('Supprimer', { cls: 'danger sm', icon: 'trash', onClick: () => deleteMovieFile(f) })))];
        }
        if (x.hasFile) return null;
        return h('div.card', { style: { marginTop: '12px' } },
          h('div.card-t', App.icon('magnifying-glass'), h('span', st.key === 'soon' ? 'Pas encore sorti' : 'Aucun fichier')),
          h('p.muted', { style: { margin: '2px 0 12px' } }, 'Trouve une release sur C411 et envoie-la à qBittorrent.'),
          App.btn('Chercher sur C411', { cls: 'pri sm', icon: 'magnifying-glass', onClick: () => M.searchC411(x) }));
      }
      function infoKv() {
        const ml = isR ? MIN_AVAIL.find((m) => m.value === x.minimumAvailability) : SERIES_TYPES.find((m) => m.value === x.seriesType);
        const size = sizeOf(x);
        return App.kv([
          ['Statut', STATUS_LABEL[x.status] || x.status],
          ['Titre original', x.originalTitle && x.originalTitle !== x.title ? x.originalTitle : ''],
          ['Langue originale', x.originalLanguage && x.originalLanguage.name],
          ['Genres', (x.genres || []).join(', ')],
          [isR ? 'Studio' : 'Chaîne', isR ? x.studio : x.network],
          ['Classification', x.certification],
          isR ? ['Au cinéma', fmt.date(x.inCinemas)] : ['Première diffusion', fmt.date(x.firstAired)],
          isR ? ['Sortie numérique', fmt.date(x.digitalRelease)] : ['Prochain épisode', fmt.dateTime(x.nextAiring)],
          isR ? ['Sortie physique', fmt.date(x.physicalRelease)] : ['Dernier épisode', fmt.dateTime(x.previousAiring)],
          ['Profil', M.profileName(x.qualityProfileId)],
          [isR ? 'Disponibilité min.' : 'Type', ml ? ml.label : ''],
          ['Dossier', x.path],
          ['Taille', size ? fmt.bytes(size) : ''],
          ['Étiquettes', M.tagLabels(x.tags).join(', ')],
          ['Ajouté', fmt.date(x.added)]
        ]);
      }

      async function loadHistory() {
        try {
          const api = M.api();
          const r = isR ? await api.get('/history/movie', { movieId: id }) : await api.get('/history/series', { seriesId: id, includeEpisode: true });
          hist = (Array.isArray(r) ? r : (r && r.records) || []).sort((a, b) => ts(b.date) - ts(a.date)).slice(0, 50);
        } catch (e) {
          hist = e;
        }
        if (!gone) renderHistory();
      }
      function renderHistory() {
        if (hist == null) return App.fill(historyBox, App.loading());
        if (hist instanceof Error) return App.fill(historyBox, App.note(hist.message, 'err'));
        if (!hist.length) return App.fill(historyBox, h('div.card', h('div.muted', 'Aucun événement pour l’instant.')));
        App.fill(historyBox, h('div.group', hist.map((r) => M.historyRow(r))));
      }

      async function refresh() {
        await M.runCommand(isR ? 'RefreshMovie' : 'RefreshSeries', isR ? { movieIds: [id] } : { seriesId: id, seriesIds: [id] }, { label: 'Actualisation', wait: true, timeout: 90000 });
        movieFile = null;
        await M.fetchItem(id);
        afterFetch();
        if (!isR) loadEpisodes();
        loadHistory();
      }
      async function deleteMovieFile(f) {
        const ok = await App.confirm({ title: 'Supprimer le fichier ?', message: (f.relativePath || baseName(f.path)) + ' sera supprimé du disque.', ok: 'Supprimer', danger: true });
        if (!ok) return;
        await M.api().del('/moviefile/' + f.id);
        movieFile = null;
        App.toast('Fichier supprimé', 'ok');
        await M.fetchItem(id);
        loadHistory();
      }
      function detailsMenu() {
        const api = M.api();
        App.menu({
          title: x.title,
          items: [
            { icon: 'pencil-square', label: 'Modifier', onClick: () => M.openEdit(x) },
            { icon: 'document-text', label: 'Renommer les fichiers', onClick: () => M.openRename(x) },
            { icon: 'arrow-path', label: 'Actualiser et rescanner', onClick: () => refresh() },
            x.monitored ? { icon: 'eye-slash', label: 'Ne plus surveiller', onClick: () => M.unmonitor(x) } : null,
            '-',
            x.imdbId ? { icon: 'globe-alt', label: 'IMDb', sub: x.imdbId, onClick: () => App.openExternal('https://www.imdb.com/title/' + x.imdbId + '/') } : null,
            x.tmdbId ? { icon: 'globe-alt', label: 'TMDB', sub: String(x.tmdbId), onClick: () => App.openExternal('https://www.themoviedb.org/' + (isR ? 'movie/' : 'tv/') + x.tmdbId) } : null,
            !isR && x.tvdbId ? { icon: 'globe-alt', label: 'TheTVDB', sub: String(x.tvdbId), onClick: () => App.openExternal('https://thetvdb.com/dereferrer/series/' + x.tvdbId) } : null,
            x.youTubeTrailerId ? { icon: 'play-circle', label: 'Bande-annonce', onClick: () => App.openExternal('https://www.youtube.com/watch?v=' + x.youTubeTrailerId) } : null,
            api.web && x.titleSlug ? { icon: 'arrow-top-right-on-square', label: 'Ouvrir dans ' + M.name, onClick: () => App.openExternal(api.web + (isR ? '/movie/' : '/series/') + x.titleSlug) } : null,
            x.path ? { icon: 'clipboard-document', label: 'Copier le chemin', sub: x.path, onClick: () => App.copy(x.path, 'Chemin') } : null,
            '-',
            { icon: 'trash', label: 'Supprimer', danger: true, onClick: () => M.askDelete(x, close) }
          ]
        });
      }

      async function load() {
        try {
          await M.fetchItem(id);
        } catch (e) {
          if (gone) return;
          if (e.status === 404) {
            App.toast((isR ? 'Film introuvable' : 'Série introuvable') + ' dans ' + M.name, 'err');
            M.remove(id);
            return;
          }
          if (!x) {
            App.fill(scroll, App.empty('exclamation-triangle', 'Chargement impossible', e.message, [
              App.btn('Réessayer', { cls: 'pri', icon: 'arrow-path', onClick: () => { App.fill(scroll, App.loading()); return load(); } })
            ]));
            return;
          }
          App.err(e);
        }
        afterFetch();
      }
      // Some Radarr versions omit movieFile in /movie/{id}: fetch it separately.
      async function afterFetch() {
        if (!isR || !x || !x.hasFile || x.movieFile || movieFile) return;
        try {
          const fl = await M.api().get('/moviefile', { movieId: id });
          movieFile = (Array.isArray(fl) && fl[0]) || null;
          if (movieFile) render();
        } catch (e) {
          console.warn(e);
        }
      }

      // ---------- Sonarr seasons & episodes ----------
      let eps = null;
      let epFiles = new Map();
      const openSeasons = new Set();
      let autoOpened = false;
      let epSeq = 0;
      async function loadEpisodes() {
        const seq = ++epSeq;
        try {
          const api = M.api();
          const r = await Promise.all([api.get('/episode', { seriesId: id }), api.get('/episodefile', { seriesId: id }).catch(() => [])]);
          if (seq !== epSeq || gone) return;
          eps = Array.isArray(r[0]) ? r[0] : [];
          epFiles = new Map((Array.isArray(r[1]) ? r[1] : []).map((f) => [f.id, f]));
        } catch (e) {
          if (seq !== epSeq || gone) return;
          if (Array.isArray(eps)) App.err(e);
          else eps = e;
        }
        renderSeasons();
      }
      function renderSeasons() {
        if (gone || isR) return;
        if (eps == null) return App.fill(seasonsBox, App.loading());
        if (eps instanceof Error) {
          return App.fill(seasonsBox, App.note(eps.message, 'err'), h('div.btn-row', { style: { marginTop: '10px' } },
            App.btn('Réessayer', { icon: 'arrow-path', onClick: () => { eps = null; renderSeasons(); return loadEpisodes(); } })));
        }
        const by = new Map();
        eps.forEach((e) => {
          if (!by.has(e.seasonNumber)) by.set(e.seasonNumber, []);
          by.get(e.seasonNumber).push(e);
        });
        const nums = Array.from(by.keys()).sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : b - a));
        if (!nums.length) return App.fill(seasonsBox, h('div.card', h('div.muted', 'Aucun épisode connu pour l’instant. Actualise la série si besoin.')));
        if (!autoOpened) {
          autoOpened = true;
          const regular = nums.filter((n) => n > 0);
          if (regular.length === 1) openSeasons.add(regular[0]);
        }
        App.fill(seasonsBox, nums.map((n) => seasonEl(n, by.get(n).sort((a, b) => a.episodeNumber - b.episodeNumber))));
      }
      function seasonEl(n, list) {
        const now = Date.now();
        const have = list.filter((e) => e.hasFile).length;
        const future = list.filter((e) => {
          const t = ts(e.airDateUtc);
          return !t || t > now;
        }).length;
        const fids = new Set(list.filter((e) => e.episodeFileId).map((e) => e.episodeFileId));
        let size = 0;
        fids.forEach((fid) => {
          const f = epFiles.get(fid);
          if (f) size += f.size || 0;
        });
        const total = list.length;
        const color = total && have >= total ? 'var(--pri)' : have ? 'var(--amber)' : 'var(--gray)';
        const sub = [have + '/' + total + ' épisodes', future ? future + ' à venir' : '', size ? fmt.bytes(size) : ''].filter(Boolean).join(' · ');
        const head = h('div.season-h', { role: 'button', tabindex: '0' },
          h('div.main', h('div.t', n === 0 ? 'Épisodes spéciaux' : 'Saison ' + n), h('div.s', sub), App.bar(total ? have / total : 0, color)),
          App.iconBtn('ellipsis-vertical', 'Actions de la saison', () => seasonMenu(n, fids)),
          h('span.chev', App.icon('chevron-down')));
        const body = h('div.season-b');
        const wrap = h('div.season' + (openSeasons.has(n) ? '.open' : ''), head, body);
        let built = false;
        const build = () => {
          if (built) return;
          built = true;
          App.fill(body, list.map(epEl));
        };
        if (openSeasons.has(n)) build();
        head.addEventListener('click', () => {
          const open = !wrap.classList.contains('open');
          wrap.classList.toggle('open', open);
          if (open) {
            openSeasons.add(n);
            build();
          } else openSeasons.delete(n);
        });
        return wrap;
      }
      function epEl(e) {
        const t = ts(e.airDateUtc);
        const f = e.episodeFileId ? epFiles.get(e.episodeFileId) : null;
        const future = !t || t > Date.now();
        const ic = e.hasFile ? colorIcon('check-circle', 'green') : future ? colorIcon('clock', 'blue') : colorIcon('minus-circle', 'amber');
        const sub = [t ? fmt.date(e.airDateUtc) : 'Date inconnue', f ? qualityName(f.quality) : '', f && f.size ? fmt.bytes(f.size) : '',
          x && x.seriesType === 'anime' && e.absoluteEpisodeNumber ? 'abs ' + e.absoluteEpisodeNumber : ''].filter(Boolean).join(' · ');
        const el = h('div.ep', { role: 'button', tabindex: '0' }, h('span.num', pad(e.episodeNumber)), h('div.main', h('div.t', e.title || 'TBA'), h('div.s', sub)), ic);
        el.addEventListener('click', () => epMenu(e, f));
        return el;
      }
      function epMenu(e, f) {
        const code = epCode(e.seasonNumber, e.episodeNumber);
        const path = f ? f.path || (x.path && f.relativePath ? joinPath(x.path, f.relativePath) : '') : '';
        App.menu({
          title: code + (e.title ? ' · ' + e.title : ''),
          items: [
            { icon: 'information-circle', label: 'Détails de l’épisode', onClick: () => App.sheet({
              title: code + (e.title ? ' · ' + e.title : ''),
              body: [
                e.overview ? h('p.overview.sel', e.overview) : h('p.muted', 'Pas de résumé disponible.'),
                h('div.card', App.kv([
                  ['Diffusion', fmt.dateTime(e.airDateUtc)],
                  ['Durée', fmt.runtime(e.runtime)],
                  ['Numéro absolu', e.absoluteEpisodeNumber],
                  ['Fichier', f ? 'Oui' : 'Non']
                ]))
              ]
            }) },
            e.seasonNumber > 0 ? { icon: 'magnifying-glass', label: 'Chercher ' + code + ' sur C411', onClick: () => M.searchC411(x, code) } : null,
            f ? { icon: 'document', label: 'Fichier', sub: f.relativePath || baseName(f.path), onClick: () => fileSheet(f) } : null,
            path ? { icon: 'clipboard-document', label: 'Copier le chemin', onClick: () => App.copy(path, 'Chemin') } : null,
            f ? { icon: 'trash', label: 'Supprimer le fichier', danger: true, onClick: () => deleteEpFiles([f.id], 'le fichier de ' + code) } : null
          ]
        });
      }
      function fileSheet(f) {
        App.sheet({ title: 'Fichier', body: h('div.card', h('div.mono.wrap.sel', { style: { marginBottom: '12px' } }, f.relativePath || baseName(f.path)), fileKv(f)) });
      }
      function seasonMenu(n, fids) {
        const label = n === 0 ? 'Épisodes spéciaux' : 'Saison ' + n;
        App.menu({
          title: label,
          items: [
            { icon: 'magnifying-glass', label: n > 0 ? 'Chercher ' + epCode(n) + ' sur C411' : 'Chercher sur C411', onClick: () => M.searchC411(x, n > 0 ? epCode(n) : '') },
            fids.size ? { icon: 'trash', label: 'Supprimer les fichiers', sub: fmt.plural(fids.size, 'fichier'), danger: true,
              onClick: () => deleteEpFiles(Array.from(fids), n === 0 ? 'les fichiers des épisodes spéciaux' : 'les fichiers de la saison ' + n) } : null
          ]
        });
      }
      async function deleteEpFiles(ids, what) {
        const ok = await App.confirm({
          title: 'Supprimer ' + what + ' ?',
          message: ids.length > 1 ? ids.length + ' fichiers seront supprimés du disque.' : 'Le fichier sera supprimé du disque.',
          ok: 'Supprimer',
          danger: true
        });
        if (!ok) return;
        const api = M.api();
        for (const fid of ids) await api.del('/episodefile/' + fid);
        App.toast(ids.length > 1 ? ids.length + ' fichiers supprimés' : 'Fichier supprimé', 'ok');
        await loadEpisodes();
        M.fetchItem(id).catch(() => {});
        loadHistory();
      }

      const offs = [
        App.on(svc + ':item', (d) => {
          if (!d || d.id !== id || gone) return;
          if (d.deleted) {
            gone = true;
            close();
            return;
          }
          x = d;
          render();
        }),
        App.on(svc + ':files', (sid) => {
          if (sid !== id || gone) return;
          movieFile = null;
          if (!isR) loadEpisodes();
          loadHistory();
          afterFetch();
        })
      ];
      page.onDestroy = () => {
        gone = true;
        offs.forEach((f) => f());
      };
      App.push(svc, page);
      render();
      renderHistory();
      M.meta().then(() => render(), () => {});
      load();
      loadHistory();
      if (!isR) {
        renderSeasons();
        loadEpisodes();
      }
    };
    // ---------- Edit, delete, rename, unmonitor ----------
    // Everything stays unmonitored: downloads are always driven from C411.
    function forceUnmonitored(o) {
      o.monitored = false;
      if (!isR) {
        o.monitorNewItems = 'none';
        (o.seasons || []).forEach((s) => {
          s.monitored = false;
        });
      }
      return o;
    }
    M.openEdit = async function (x) {
      const meta = await M.meta();
      const api = M.api();
      const profSel = App.select(meta.profiles.map((p) => ({ value: p.id, label: p.name })), x.qualityProfileId);
      const curRoot = rootOf(x);
      const roots = meta.roots.map((r) => ({ value: trimSlash(r.path), label: trimSlash(r.path) + (r.freeSpace ? ' · ' + fmt.bytes(r.freeSpace) + ' libres' : '') }));
      if (curRoot && !roots.some((r) => r.value === curRoot)) roots.unshift({ value: curRoot, label: curRoot + ' (actuel)' });
      const rootSel = App.select(roots, curRoot);
      const moveHint = App.note('Les fichiers existants seront déplacés vers le nouveau dossier racine.', 'warn', 'folder');
      moveHint.classList.add('hidden');
      rootSel.addEventListener('change', () => moveHint.classList.toggle('hidden', rootSel.value === curRoot));
      const tags = M.tagPicker(meta, x.tags);
      let availSel = null;
      let typeSel = null;
      let langSel = null;
      let sfSw = null;
      const fields = [App.field('Profil de qualité', profSel)];
      if (isR) {
        availSel = App.select(MIN_AVAIL, x.minimumAvailability || 'released');
        fields.push(App.field('Disponibilité minimale', availSel));
      } else {
        typeSel = App.select(SERIES_TYPES, x.seriesType || 'standard');
        fields.push(App.field('Type de série', typeSel));
        if (meta.langs && meta.langs.length > 1) {
          langSel = App.select(meta.langs.map((l) => ({ value: l.id, label: l.name })), x.languageProfileId);
          fields.push(App.field('Profil de langue', langSel));
        }
        sfSw = App.switchEl('Dossiers par saison', x.seasonFolder !== false, null, 'Range les épisodes dans « Season 01 », « Season 02 »…');
        fields.push(sfSw);
      }
      fields.push(App.field('Dossier racine', rootSel), moveHint, App.field('Étiquettes', tags.el),
        App.note((isR ? 'Le film reste' : 'La série reste') + ' non surveillé' + M.e + ' : ' + M.name + ' ne lancera jamais de recherche ni de téléchargement.', '', 'eye-slash'));
      let s = null;
      const save = async () => {
        const cur = await api.get(M.ep + '/' + x.id);
        cur.qualityProfileId = Number(profSel.value);
        if (isR) cur.minimumAvailability = availSel.value;
        else {
          cur.seriesType = typeSel.value;
          cur.seasonFolder = sfSw.input.checked;
          if (langSel) cur.languageProfileId = Number(langSel.value);
        }
        cur.tags = tags.value();
        forceUnmonitored(cur);
        let q;
        if (rootSel.value && rootSel.value !== curRoot) {
          cur.rootFolderPath = rootSel.value;
          cur.path = joinPath(rootSel.value, cur.folder || baseName(cur.path));
          q = { moveFiles: true };
        }
        const saved = await api.put(M.ep + '/' + x.id, cur, q);
        s.close();
        M.upsert(saved && saved.id ? saved : cur);
        App.toast(q ? 'Enregistré · déplacement des fichiers en cours' : 'Modifications enregistrées', 'ok');
      };
      s = App.sheet({
        title: 'Modifier',
        body: [h('div.muted.nowrap', { style: { margin: '-4px 0 12px' } }, x.title)].concat(fields),
        actions: [App.btn('Annuler', { onClick: () => s.close() }), App.btn('Enregistrer', { cls: 'pri', icon: 'check', onClick: save })]
      });
    };

    M.askDelete = async function (x, done) {
      const vals = await App.confirm({
        title: 'Supprimer « ' + x.title + ' » ?',
        message: (isR ? 'Le film sera retiré' : 'La série sera retirée') + ' de ' + M.name + '. Le torrent éventuel reste dans qBittorrent.',
        ok: 'Supprimer',
        danger: true,
        checks: [
          { key: 'files', label: 'Supprimer aussi les fichiers du disque', checked: false },
          { key: 'excl', label: 'Empêcher le réajout par les listes d’import', checked: false }
        ]
      });
      if (!vals) return;
      const q = { deleteFiles: !!vals.files };
      q[isR ? 'addImportExclusion' : 'addImportListExclusion'] = !!vals.excl;
      await M.api().del(M.ep + '/' + x.id, q);
      M.remove(x.id);
      App.toast((isR ? 'Film supprimé' : 'Série supprimée') + (vals.files ? ' avec ses fichiers' : ''), 'ok');
      if (done) done();
    };

    M.openRename = async function (x) {
      const list = await M.api().get('/rename', isR ? { movieId: x.id } : { seriesId: x.id });
      if (!Array.isArray(list) || !list.length) return App.toast('Les fichiers sont déjà correctement nommés', 'ok');
      let s = null;
      s = App.sheet({
        title: 'Renommer ' + fmt.plural(list.length, 'fichier'),
        body: h('div.group', list.map((r) => h('div.item', h('div.main',
          h('div.s.mono.wrap', { style: { textDecoration: 'line-through', opacity: '.7' } }, r.existingPath),
          h('div.t.mono.wrap', { style: { marginTop: '4px' } }, r.newPath))))),
        actions: [App.btn('Annuler', { onClick: () => s.close() }), App.btn('Renommer', {
          cls: 'pri',
          icon: 'pencil-square',
          onClick: async () => {
            const ids = Array.from(new Set(list.map((r) => (isR ? r.movieFileId : r.episodeFileId)).filter(Boolean)));
            s.close();
            await M.runCommand('RenameFiles', isR ? { movieId: x.id, files: ids } : { seriesId: x.id, files: ids }, { label: 'Renommage', wait: true });
            await M.fetchItem(x.id).catch(() => {});
            App.emit(svc + ':files', x.id);
          }
        })]
      });
    };

    M.unmonitor = async function (x) {
      const api = M.api();
      const cur = forceUnmonitored(await api.get(M.ep + '/' + x.id));
      const saved = await api.put(M.ep + '/' + x.id, cur);
      if (!isR) {
        const list = await api.get('/episode', { seriesId: x.id }).catch(() => []);
        const ids = (Array.isArray(list) ? list : []).filter((e) => e.monitored).map((e) => e.id);
        if (ids.length) await api.put('/episode/monitor', { episodeIds: ids, monitored: false });
      }
      M.upsert(saved && saved.id ? saved : cur);
      App.toast(isR ? 'Film non surveillé' : 'Série non surveillée', 'ok');
    };
    // ---------- Add: lookup page & add sheet ----------
    function normTerm(t) {
      t = String(t || '').trim();
      let m;
      if ((m = /imdb\.com\/(?:[a-z-]+\/)?title\/(tt\d+)/i.exec(t)) || (m = /^(?:imdb:)?\s*(tt\d{5,})$/i.exec(t))) return 'imdb:' + m[1].toLowerCase();
      if ((m = /themoviedb\.org\/(?:movie|tv)\/(\d+)/i.exec(t)) || (m = /^tmdb:\s*(\d+)$/i.exec(t))) return 'tmdb:' + m[1];
      if ((m = /thetvdb\.com\/(?:dereferrer\/)?series\/(\d+)/i.exec(t)) || (m = /^tvdb:\s*(\d+)$/i.exec(t))) return 'tvdb:' + m[1];
      return t;
    }
    M.openAdd = function (term) {
      if (App.state.tab !== svc) App.goTab(svc);
      const stack = App.tabs[svc].stack;
      const top = stack[stack.length - 1];
      if (top && top.isAdd) {
        if (term) top.setTerm(term);
        return;
      }
      const page = App.page({ title: isR ? 'Ajouter un film' : 'Ajouter une série', back: true });
      page.isAdd = true;
      const input = App.input({ type: 'search', placeholder: isR ? 'Titre, lien IMDb ou TMDB…' : 'Titre, lien TVDB, IMDb ou TMDB…', enterkeyhint: 'search' });
      const box = h('div');
      const scroll = h('div.scroll', h('div.sticky', h('div.search', App.icon('magnifying-glass'), input)), box);
      page.el.appendChild(scroll);
      let seq = 0;
      let results = null;
      let lastQ = '';
      async function search(force) {
        const q = normTerm(input.value);
        if (!q) {
          seq++;
          lastQ = '';
          results = null;
          return renderResults();
        }
        if (q === lastQ && !force) return;
        lastQ = q;
        const my = ++seq;
        App.fill(box, App.loading());
        try {
          const r = await M.api().get(M.ep + '/lookup', { term: q });
          if (my !== seq) return;
          results = (Array.isArray(r) ? r : r ? [r] : []).slice(0, 40);
        } catch (e) {
          if (my !== seq) return;
          results = e;
        }
        renderResults();
      }
      input.addEventListener('input', App.debounce(() => search(), 600));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          input.blur();
          search(true);
        }
      });
      function renderResults() {
        if (!M.configured()) {
          return App.fill(box, App.needSetup(isR ? 'film' : 'tv', M.name, svc, 'Renseigne l’URL et la clé API dans les réglages.'));
        }
        if (results == null) {
          return App.fill(box, App.empty('magnifying-glass', isR ? 'Rechercher un film' : 'Rechercher une série',
            'Tape un titre ou colle un lien IMDb, TMDB' + (isR ? '' : ' ou TheTVDB') + '. L’ajout se fait toujours sans surveillance ni recherche automatique.'));
        }
        if (results instanceof Error) {
          return App.fill(box, App.note(results.message, 'err'), h('div.btn-row', { style: { marginTop: '10px' } },
            App.btn('Réessayer', { icon: 'arrow-path', onClick: () => search(true) })));
        }
        if (!results.length) return App.fill(box, App.empty('magnifying-glass', 'Aucun résultat', 'Essaie un autre titre, ou un identifiant : imdb:tt…, tmdb:…' + (isR ? '' : ', tvdb:…')));
        App.fill(box, results.map(resultEl));
      }
      function resultEl(r) {
        const lib = M.inLib(r);
        const rating = ratingOf(r);
        const st = STATUS_LABEL[r.status];
        const b = h('button.result', { type: 'button' }, M.poster(r, 250),
          h('div.main',
            h('div.t', r.title),
            h('div.s.muted', { style: { fontSize: '12.5px' } }, M.metaLine(r)),
            h('div.badges',
              lib && lib.id ? App.badge('Dans la bibliothèque', 'green', 'check') : null,
              st ? App.badge(st, r.status === 'continuing' ? 'blue' : '') : null,
              rating ? App.badge(Number(rating.v).toFixed(1), 'amber', 'star') : null),
            r.overview ? h('div.ov', r.overview) : null));
        b.addEventListener('click', () => App.run(() => (lib && lib.id ? M.openDetails(lib.id) : M.openAddSheet(r))));
        return b;
      }
      const off = App.on(svc + ':lib', () => {
        if (Array.isArray(results) && results.length) renderResults();
      });
      page.onDestroy = () => {
        seq++;
        off();
      };
      page.setTerm = (t) => {
        input.value = t;
        search(true);
      };
      App.push(svc, page);
      M.loadLib().catch(() => {});
      if (term) page.setTerm(term);
      else {
        renderResults();
        setTimeout(() => input.focus(), 320);
      }
    };

    // o.path: import an existing folder (library import) instead of creating one under a root folder.
    M.openAddSheet = async function (r, o) {
      o = o || {};
      const meta = await M.meta();
      if (!meta.roots.length && !o.path) throw App.mkErr('Aucun dossier racine configuré dans ' + M.name);
      if (!meta.profiles.length) throw App.mkErr('Aucun profil de qualité dans ' + M.name);
      const cfg = App.config;
      const roots = meta.roots.map((x) => trimSlash(x.path));
      let root = trimSlash(cfg[svc + 'Root'] || '');
      const anime = !isR && looksAnime(r);
      if (!isR) {
        const animeRoot = roots.find((p) => /anim/i.test(p));
        if (anime && animeRoot) root = animeRoot;
        else if (!anime && /anim/i.test(root)) root = roots.find((p) => !/anim/i.test(p)) || root;
      }
      if (o.path) root = trimSlash(o.root || trimSlash(o.path).replace(/[\\/][^\\/]*$/, ''));
      else if (roots.indexOf(root) < 0) root = roots[0];
      let prof = Number(cfg[svc + 'Profile']);
      if (!meta.profiles.some((p) => p.id === prof)) prof = meta.profiles[0].id;
      const rootSel = App.select(meta.roots.map((x) => ({ value: trimSlash(x.path), label: trimSlash(x.path) + (x.freeSpace ? ' · ' + fmt.bytes(x.freeSpace) + ' libres' : '') })), root);
      const profSel = App.select(meta.profiles.map((p) => ({ value: p.id, label: p.name })), prof);
      const tags = M.tagPicker(meta, []);
      const fields = [];
      let availSel = null;
      let typeSel = null;
      let langSel = null;
      let sfSw = null;
      const rootField = o.path
        ? App.field('Dossier existant', h('div.card.mono.wrap.sel', { style: { margin: '0', padding: '10px 12px' } }, o.path), 'Les fichiers déjà présents seront importés tels quels.')
        : null;
      if (isR) {
        fields.push(rootField || App.field('Dossier racine', rootSel), App.field('Profil de qualité', profSel));
        availSel = App.select(MIN_AVAIL, 'released');
        fields.push(App.field('Disponibilité minimale', availSel));
      } else {
        fields.push(rootField || App.field('Dossier racine', rootSel, anime ? 'Détectée comme anime : dossier anime présélectionné.' : null), App.field('Profil de qualité', profSel));
        typeSel = App.select(SERIES_TYPES, /anim/i.test(root) ? 'anime' : r.seriesType || 'standard');
        rootSel.addEventListener('change', () => {
          typeSel.value = /anim/i.test(rootSel.value) ? 'anime' : 'standard';
        });
        fields.push(App.field('Type de série', typeSel));
        if (meta.langs && meta.langs.length > 1) {
          langSel = App.select(meta.langs.map((l) => ({ value: l.id, label: l.name })), meta.langs[0].id);
          fields.push(App.field('Profil de langue', langSel));
        }
        sfSw = App.switchEl('Dossiers par saison', true, null, 'Range les épisodes dans « Season 01 », « Season 02 »…');
        fields.push(sfSw);
      }
      fields.push(App.field('Étiquettes', tags.el),
        App.note('Ajout non surveillé : ' + M.name + ' ne lancera aucune recherche ni téléchargement. Télécharge la release depuis C411.', '', 'eye-slash'));
      let s = null;
      const add = async () => {
        const body = JSON.parse(JSON.stringify(r));
        delete body.path;
        if (!body.id) delete body.id;
        Object.assign(body, { qualityProfileId: Number(profSel.value), rootFolderPath: o.path ? root : rootSel.value, monitored: false, tags: tags.value() });
        if (o.path) body.path = o.path;
        if (isR) {
          body.minimumAvailability = availSel.value;
          body.addOptions = { monitor: 'none', searchForMovie: false };
        } else {
          body.languageProfileId = langSel ? Number(langSel.value) : (meta.langs && meta.langs[0] && meta.langs[0].id) || 1;
          body.seriesType = typeSel.value;
          body.seasonFolder = sfSw.input.checked;
          body.monitorNewItems = 'none';
          body.seasons = (body.seasons || []).map((x) => Object.assign({}, x, { monitored: false }));
          body.addOptions = { monitor: 'none', searchForMissingEpisodes: false, searchForCutoffUnmetEpisodes: false };
        }
        const added = await M.api().post(M.ep, body);
        s.close();
        App.toast((isR ? 'Film ajouté' : 'Série ajoutée') + ' à ' + M.name + ' (non surveillé' + M.e + ')', 'ok');
        if (added && added.id) M.upsert(added);
        else M.loadLib(true).catch(() => {});
        if (o.onAdded) o.onAdded(added);
        else if (added && added.id) M.openDetails(added.id);
      };
      const head = h('div.result', { style: { background: 'transparent', border: '0', padding: '0', marginBottom: '14px' } }, M.poster(r, 250),
        h('div.main', h('div.t', r.title), h('div.s.muted', { style: { fontSize: '12.5px' } }, M.metaLine(r)),
          h('div', App.btn('Chercher sur C411', { cls: 'ghost sm', icon: 'magnifying-glass', onClick: () => M.searchC411(r) }))));
      s = App.sheet({
        title: o.path ? (isR ? 'Importer le film' : 'Importer la série') : isR ? 'Ajouter le film' : 'Ajouter la série',
        body: [head].concat(fields),
        actions: [App.btn('Annuler', { onClick: () => s.close() }), App.btn(o.path ? 'Importer' : 'Ajouter', { cls: 'pri', icon: o.path ? 'inbox-arrow-down' : 'plus', onClick: add })]
      });
    };
    // ---------- Init ----------
    M.init = function () {
      M.sections.unshift({ key: 'lib', label: 'Bibliothèque', build: buildLib });
      if (App.arrMore) App.arrMore(M);
      buildRoot();
      App.setTabHooks(svc, {
        onBack() {
          if (!root) return false;
          const s = root.built[root.cur];
          if (s && s.back && s.back()) return true;
          if (root.cur !== 'lib') {
            M.showSection('lib');
            return true;
          }
          return false;
        }
      });
      const sigOf = () => {
        const a = M.api();
        return a.base + '|' + a.key;
      };
      let sig = sigOf();
      App.on('config', () => {
        const n = sigOf();
        if (n === sig) return;
        sig = n;
        App.popToRoot(svc);
        M.reset();
        if (App.visible(svc) && M.configured()) M.loadLib(true).catch(() => {});
      });
      App.on(svc + ':lib', updateSub);
      updateSub();
      return M;
    };
    return M;
  };
})();
