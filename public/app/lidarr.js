/* Arr411 - Lidarr: artists, albums & tracks (library, activity, calendar & system come from arr.js / arr-more.js). */
(function () {
  'use strict';
  const App = window.App;
  const h = App.h;
  const fmt = App.fmt;

  const trimSlash = (p) => String(p || '').replace(/[\\/]+$/, '');
  const rootOf = (x) => trimSlash(x.rootFolderPath || trimSlash(x.path).replace(/[\\/][^\\/]*$/, ''));
  const coll = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
  const isAlbum = (x) => !!(x && x.foreignAlbumId);
  const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '');
  const yearOf = (d) => {
    const t = fmt.toDate(d);
    return t && t.getFullYear() > 1800 ? t.getFullYear() : null;
  };
  const MBID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  const mbLink = (kind, id) => 'https://musicbrainz.org/' + kind + '/' + id;
  const TYPES = ['Album', 'EP', 'Single', 'Broadcast', 'Other'];
  const TYPE_ONE = { Album: 'Album', EP: 'EP', Single: 'Single', Broadcast: 'Diffusion', Other: 'Autre' };
  const TYPE_MANY = { Album: 'Albums', EP: 'EP', Single: 'Singles', Broadcast: 'Diffusions', Other: 'Autres' };
  const ARTIST_STATUS = { continuing: 'En activité', ended: 'Inactif' };
  const ARTIST_TYPE = { Group: 'Groupe', Person: 'Artiste solo', Orchestra: 'Orchestre', Choir: 'Chœur', Character: 'Personnage', Other: 'Autre' };
  const META_FR = {
    Broadcast: 'Diffusion', Other: 'Autre', Soundtrack: 'Bande originale', Spokenword: 'Texte parlé', Audiobook: 'Livre audio',
    'Mixtape/Street': 'Mixtape', Demo: 'Démo', 'Audio drama': 'Fiction audio', Official: 'Officielle', Promotion: 'Promotionnelle',
    'DJ-mix': 'DJ mix', 'Pseudo-Release': 'Pseudo-release'
  };
  const metaFr = (n) => META_FR[n] || n || '';
  const secNames = (a) => (a.secondaryTypes || []).map((t) => (typeof t === 'string' ? t : t && t.name)).filter((t) => t && t !== 'Studio');
  const LINK_PREF = ['official homepage', 'wikipedia', 'discogs', 'allmusic', 'deezer', 'spotify', 'youtube', 'bandcamp', 'soundcloud', 'last'];
  const LINK_NAME = { 'official homepage': 'Site officiel', last: 'Last.fm', allmusic: 'AllMusic', youtube: 'YouTube', soundcloud: 'SoundCloud' };
  const hostOf = (u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, '');
    } catch (_) {
      return String(u || '');
    }
  };
  function topLinks(x) {
    const seen = new Set();
    const rank = (n) => {
      const i = LINK_PREF.indexOf(n);
      return i < 0 ? 99 : i;
    };
    return (x.links || []).filter((l) => l && l.url && !/musicbrainz\.org/i.test(l.url))
      .map((l) => ({ url: l.url, name: String(l.name || hostOf(l.url)).toLowerCase() }))
      .filter((l) => !seen.has(l.name) && seen.add(l.name))
      .sort((a, b) => rank(a.name) - rank(b.name))
      .slice(0, 5);
  }
  function albumCounts(a) {
    const s = (a && a.statistics) || {};
    return { have: s.trackFileCount || 0, total: s.totalTrackCount || s.trackCount || 0, size: s.sizeOnDisk || 0 };
  }
  function fmtDur(ms) {
    const s = Math.round((Number(ms) || 0) / 1000);
    if (s <= 0) return '';
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return hh ? hh + ':' + String(mm).padStart(2, '0') + ':' + ss : mm + ':' + ss;
  }

  App.makeLidarr = function () {
    const M = App.makeArr('lidarr');
    const U = App.arrUtil;
    const act = U.act;
    const metaName = (id) => {
      const m = M.cache.meta;
      const p = m && (m.metaProfiles || []).find((x) => x.id === id);
      return p ? p.name : '';
    };
    M.metaName = metaName;

    // Artists expose artistName/sortName: map them to title/sortTitle so the shared list code works as-is.
    M.prep = function (x) {
      if (x && !isAlbum(x)) {
        if (x.artistName) x.title = x.artistName;
        if (x.sortName) x.sortTitle = x.sortName;
      }
      return x;
    };
    M.poster = function (x, size, st) {
      const srcs = isAlbum(x)
        ? M.cover(x, 'cover', size || 500).concat(x.remoteCover ? [x.remoteCover] : [])
        : M.cover(x, 'poster', size || 500).concat(M.cover(x, 'fanart', 360));
      const el = h('div.poster.sq', h('div.ph', x.title || x.artistName || ''), App.img(srcs));
      if (st) el.appendChild(h('div.st', h('i', { style: { width: Math.round(Math.max(0, Math.min(1, st.fill || 0)) * 100) + '%', background: U.COLOR_VAR[st.color || ''] } })));
      return el;
    };
    M.counts = function (x) {
      const s = (x && x.statistics) || {};
      return { have: s.trackFileCount || 0, total: s.totalTrackCount || s.trackCount || 0 };
    };
    M.status = function (x) {
      const n = isAlbum(x) ? albumCounts(x) : M.counts(x);
      if (n.total > 0 && n.have >= n.total) return { key: 'complete', label: 'Complet', color: 'green', fill: 1 };
      if (n.have > 0) return { key: 'partial', label: n.have + '/' + n.total + ' pistes', color: 'amber', fill: n.total ? n.have / n.total : 0 };
      return { key: 'empty', label: n.total ? '0/' + n.total + ' pistes' : 'Aucune piste', color: '', fill: 0 };
    };
    M.metaLine = function (x) {
      const p = [];
      if (isAlbum(x)) {
        const y = yearOf(x.releaseDate);
        if (y) p.push(String(y));
        if (x.albumType && x.albumType !== 'Album') p.push(TYPE_ONE[x.albumType] || x.albumType);
        secNames(x).slice(0, 2).forEach((t) => p.push(metaFr(t)));
        const an = x.artist ? x.artist.artistName || x.artist.title : '';
        if (an) p.push(an);
      } else {
        if (x.artistType) p.push(ARTIST_TYPE[x.artistType] || x.artistType);
        const n = x.statistics && x.statistics.albumCount;
        if (n) p.push(fmt.plural(n, 'album'));
        (x.genres || []).slice(0, 2).forEach((g) => p.push(cap(g)));
        if (x.disambiguation) p.push(x.disambiguation);
      }
      return p.join(' · ');
    };
    M.findByIds = function (ids) {
      const mb = String((ids && (ids.mb || ids.musicbrainz)) || '').toLowerCase();
      if (!mb) return null;
      const list = M.cache.items || Array.from(M.cache.byId.values());
      return list.find((x) => String(x.foreignArtistId || '').toLowerCase() === mb) || null;
    };
    // Albums resolve to their artist (the library only lists artists).
    M.inLib = function (r) {
      if (!r) return null;
      if (isAlbum(r)) {
        const a = r.artist || {};
        return M.get(r.artistId || a.id) || M.findByIds({ mb: a.foreignArtistId || r.foreignArtistId }) || null;
      }
      if (r.id) return M.get(r.id) || r;
      return M.findByIds({ mb: r.foreignArtistId });
    };

    // ---------- Artist page: discography (albums as an accordion), tracks & files ----------
    const linkBtn = (label, fn) => h('button', { type: 'button', onclick: () => App.run(fn) }, label);
    M.openDetails = function (id, o) {
      id = Number(id);
      if (!id) return;
      const want = Number((o && o.album) || 0);
      if (App.state.tab !== 'lidarr') App.goTab('lidarr');
      const stack = App.tabs.lidarr.stack;
      const top = stack[stack.length - 1];
      if (top && top.itemId === id) {
        if (want && top.openAlbum) top.openAlbum(want);
        return;
      }
      let x = M.get(id);
      let albums = null;
      let hist = null;
      let gone = false;
      let focus = want;
      let shownMon = null;
      const open = new Set(want ? [want] : []);
      // albumId -> null while loading | Error | { list, files: Map(trackFileId -> file) }
      const tracks = new Map();
      let tGen = 0;
      let albSeq = 0;
      let retries = 0;
      let retryTimer = 0;
      const page = App.page({ title: '', back: true });
      page.itemId = id;
      App.append(page.actions,
        App.iconBtn('magnifying-glass', 'Chercher sur C411', () => M.searchC411(x)),
        App.iconBtn('ellipsis-vertical', 'Plus d’actions', () => x && detailsMenu()));
      const scroll = h('div.scroll');
      page.el.appendChild(scroll);
      const albumsBox = h('div');
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
        if (stack[stack.length - 1] === page) App.pop('lidarr');
      };
      page.openAlbum = (aid) => {
        open.add(aid);
        focus = aid;
        renderAlbums();
      };
      const anyMonitored = () => !!x && (!!x.monitored || (Array.isArray(albums) && albums.some((a) => a.monitored)));

      function render() {
        if (gone) return;
        if (!x) return App.fill(scroll, App.loading());
        const keep = scroll.scrollTop;
        const st = M.status(x);
        const rating = U.ratingOf(x);
        const ov = x.overview ? h('p.overview.clamp', x.overview) : null;
        if (ov) ov.addEventListener('click', () => ov.classList.toggle('clamp'));
        shownMon = anyMonitored();
        App.fill(scroll,
          h('div.hero', App.img(M.cover(x, 'fanart'))),
          h('div.hero-info', M.poster(x, 500),
            h('div.main', h('h2.sel', x.title), h('div.s', M.metaLine(x)),
              h('div.badges', App.badge(st.label, st.color),
                shownMon ? App.badge('Surveillé', 'violet', 'eye') : App.badge('Non surveillé', '', 'eye-slash'),
                rating ? App.badge(Number(rating.v).toFixed(1), 'amber', 'star') : null))),
          h('div.actions-grid',
            act('magnifying-glass', 'C411', () => M.searchC411(x)),
            act('pencil-square', 'Modifier', () => M.openEdit(x)),
            act('arrow-path', 'Actualiser', () => refresh()),
            act('trash', 'Supprimer', () => M.askDelete(x, close), true)),
          ov,
          App.secTitle('Discographie', linkBtn('+ Album', () => M.openAdd(x.title + ' ', 'album'))),
          albumsBox,
          App.secTitle('Informations'),
          h('div.card', infoKv()),
          App.secTitle('Historique'),
          historyBox);
        scroll.scrollTop = keep;
      }
      function infoKv() {
        const size = U.sizeOf(x);
        const s = x.statistics || {};
        const n = M.counts(x);
        return App.kv([
          ['Statut', ARTIST_STATUS[x.status] || x.status],
          ['Type', ARTIST_TYPE[x.artistType] || x.artistType],
          ['Précision', x.disambiguation],
          ['Genres', (x.genres || []).map(cap).join(', ')],
          ['Albums', s.albumCount ? String(s.albumCount) : ''],
          ['Pistes', n.total ? n.have + ' / ' + n.total : ''],
          ['Profil de qualité', M.profileName(x.qualityProfileId)],
          ['Profil de métadonnées', metaName(x.metadataProfileId)],
          ['Dossier', x.path],
          ['Taille', size ? fmt.bytes(size) : ''],
          ['Étiquettes', M.tagLabels(x.tags).join(', ')],
          ['Ajouté', fmt.date(x.added)]
        ]);
      }

      async function loadHistory() {
        try {
          const r = await M.api().get('/history/artist', { artistId: id, includeAlbum: true });
          hist = (Array.isArray(r) ? r : (r && r.records) || []).sort((a, b) => U.ts(b.date) - U.ts(a.date)).slice(0, 50);
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
      function reloadAll() {
        tracks.clear();
        tGen++;
        loadAlbums();
        loadHistory();
      }
      async function refresh() {
        await M.runCommand('RefreshArtist', { artistId: id, artistIds: [id] }, { label: 'Actualisation', wait: true, timeout: 120000 });
        await M.fetchItem(id).catch(() => {});
        reloadAll();
      }
      async function load() {
        try {
          await M.fetchItem(id);
        } catch (e) {
          if (gone) return;
          if (e.status === 404) {
            App.toast('Artiste introuvable dans Lidarr', 'err');
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
      }

      // ---------- Albums ----------
      async function loadAlbums() {
        const seq = ++albSeq;
        clearTimeout(retryTimer);
        try {
          const r = await M.api().get('/album', { artistId: id });
          if (seq !== albSeq || gone) return;
          albums = Array.isArray(r) ? r : [];
        } catch (e) {
          if (seq !== albSeq || gone) return;
          if (Array.isArray(albums)) App.err(e);
          else albums = e;
        }
        // Right after an artist is added, Lidarr fetches its discography in the background.
        if (Array.isArray(albums) && !albums.length && x && Date.now() - U.ts(x.added) < 120000 && retries < 6) {
          retries++;
          retryTimer = setTimeout(() => {
            if (!gone) loadAlbums();
          }, 5000);
        }
        renderAlbums();
        if (x && anyMonitored() !== shownMon) render();
      }
      function renderAlbums() {
        if (gone) return;
        if (albums == null) return App.fill(albumsBox, App.loading());
        if (albums instanceof Error) {
          return App.fill(albumsBox, App.note(albums.message, 'err'), h('div.btn-row', { style: { marginTop: '10px' } },
            App.btn('Réessayer', { icon: 'arrow-path', onClick: () => { albums = null; renderAlbums(); return loadAlbums(); } })));
        }
        if (!albums.length) {
          const none = /^none$/i.test(metaName(x && x.metadataProfileId));
          const waiting = retries > 0 && retries < 6;
          return App.fill(albumsBox, h('div.card',
            h('p.muted', { style: { margin: '0 0 12px' } }, none
              ? 'Profil de métadonnées « None » : seuls les albums ajoutés à la main apparaissent ici.'
              : waiting ? 'Lidarr récupère la discographie…' : 'Aucun album connu avec ce profil de métadonnées. Actualise l’artiste ou ajoute un album à la main.'),
            h('div.btn-row',
              App.btn('Ajouter un album', { cls: 'pri sm', icon: 'plus', onClick: () => M.openAdd((x ? x.title : '') + ' ', 'album') }),
              App.btn('Actualiser', { cls: 'sm', icon: 'arrow-path', onClick: () => refresh() }))));
        }
        const sorted = albums.slice().sort((a, b) => U.ts(b.releaseDate) - U.ts(a.releaseDate) || coll.compare(a.title || '', b.title || ''));
        const typeOf = (a) => (TYPES.indexOf(a.albumType) >= 0 ? a.albumType : 'Other');
        const groups = TYPES.map((t) => [t, sorted.filter((a) => typeOf(a) === t)]).filter((g) => g[1].length);
        const multi = groups.length > 1;
        App.fill(albumsBox, groups.map((g) => [multi ? h('div.alb-type', TYPE_MANY[g[0]] + ' · ' + g[1].length) : null, g[1].map(albumEl)]));
        if (focus) {
          const f = focus;
          focus = 0;
          setTimeout(() => {
            const el = albumsBox.querySelector('[data-album="' + f + '"]');
            if (el && !gone) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
          }, 60);
        }
      }
      function albumEl(a) {
        const n = albumCounts(a);
        const y = yearOf(a.releaseDate);
        const future = U.ts(a.releaseDate) > Date.now();
        const color = n.total && n.have >= n.total ? 'var(--pri)' : n.have ? 'var(--amber)' : 'var(--gray)';
        const sub = [
          future ? 'Sortie ' + fmt.date(a.releaseDate) : y ? String(y) : '',
          secNames(a).map(metaFr).join(', '),
          n.total ? n.have + '/' + n.total + ' pistes' : '',
          n.size ? fmt.bytes(n.size) : '',
          a.monitored ? 'surveillé' : ''
        ].filter(Boolean).join(' · ');
        const cover = M.poster(a, 250);
        const ph = cover.querySelector('.ph');
        if (ph) App.fill(ph, App.icon('musical-note'));
        const head = h('div.season-h', { role: 'button', tabindex: '0' }, cover,
          h('div.main', h('div.t', a.title + (a.disambiguation ? ' (' + a.disambiguation + ')' : '')), h('div.s', sub), App.bar(n.total ? n.have / n.total : 0, color)),
          App.iconBtn('ellipsis-vertical', 'Actions de l’album', () => albumMenu(a)),
          h('span.chev', App.icon('chevron-down')));
        const body = h('div.season-b');
        const wrap = h('div.season' + (open.has(a.id) ? '.open' : ''), { 'data-album': String(a.id) }, head, body);
        if (open.has(a.id)) renderTracks(a, body);
        head.addEventListener('click', () => {
          const on = !wrap.classList.contains('open');
          wrap.classList.toggle('open', on);
          if (on) {
            open.add(a.id);
            renderTracks(a, body);
          } else open.delete(a.id);
        });
        return wrap;
      }

      // ---------- Tracks ----------
      async function loadTracks(a) {
        const gen = tGen;
        tracks.set(a.id, null);
        let v;
        try {
          const api = M.api();
          const r = await Promise.all([api.get('/track', { albumId: a.id }), api.get('/trackfile', { albumId: a.id }).catch(() => [])]);
          v = {
            list: (Array.isArray(r[0]) ? r[0] : []).sort((p, q) => (p.mediumNumber || 0) - (q.mediumNumber || 0) || (p.absoluteTrackNumber || 0) - (q.absoluteTrackNumber || 0)),
            files: new Map((Array.isArray(r[1]) ? r[1] : []).map((f) => [f.id, f]))
          };
        } catch (e) {
          v = e;
        }
        if (gen !== tGen || gone) return;
        tracks.set(a.id, v);
        const wrap = albumsBox.querySelector('[data-album="' + a.id + '"]');
        if (wrap) renderTracks(a, wrap.querySelector('.season-b'));
      }
      function renderTracks(a, body) {
        if (!body) return;
        const t = tracks.get(a.id);
        if (t === undefined) {
          loadTracks(a);
          return App.fill(body, App.loading());
        }
        if (t === null) return App.fill(body, App.loading());
        if (t instanceof Error) {
          return App.fill(body, h('div', { style: { padding: '10px 14px' } }, App.note(t.message, 'err'),
            App.btn('Réessayer', { cls: 'sm', icon: 'arrow-path', onClick: () => { tracks.delete(a.id); renderTracks(a, body); } })));
        }
        if (!t.list.length) return App.fill(body, h('div.ep', h('div.main.muted', 'Aucune piste connue pour cette version.')));
        const discs = new Set(t.list.map((tr) => tr.mediumNumber || 1));
        const fmtOf = (m) => ((a.media || []).find((d) => d.mediumNumber === m) || {}).mediumFormat || '';
        const out = [];
        let cur = null;
        t.list.forEach((tr) => {
          const m = tr.mediumNumber || 1;
          if (discs.size > 1 && m !== cur) {
            cur = m;
            out.push(h('div.disc-h', ['Disque ' + m, fmtOf(m)].filter(Boolean).join(' · ')));
          }
          out.push(trackEl(a, tr, t.files.get(tr.trackFileId)));
        });
        App.fill(body, out);
      }
      function trackEl(a, tr, f) {
        const raw = String(tr.trackNumber || '');
        const num = /^\d+$/.test(raw) ? U.pad(raw) : raw || U.pad(tr.absoluteTrackNumber);
        const sub = [fmtDur(tr.duration), f ? U.qualityName(f.quality) : '', f && f.size ? fmt.bytes(f.size) : '', tr.explicit ? 'explicite' : ''].filter(Boolean).join(' · ');
        const ic = tr.hasFile ? U.colorIcon('check-circle', 'green') : U.ts(a.releaseDate) > Date.now() ? U.colorIcon('clock', 'blue') : U.colorIcon('minus-circle', 'amber');
        const el = h('div.ep', { role: 'button', tabindex: '0' }, h('span.num', num), h('div.main', h('div.t', tr.title || 'Sans titre'), sub ? h('div.s', sub) : null), ic);
        el.addEventListener('click', () => trackMenu(a, tr, f));
        return el;
      }
      function trackMenu(a, tr, f) {
        const path = f && f.path;
        App.menu({
          title: tr.title || 'Piste',
          items: [
            { icon: 'magnifying-glass', label: 'Chercher l’album sur C411', onClick: () => M.searchC411(x, a.title) },
            f ? { icon: 'document', label: 'Fichier', sub: U.baseName(f.path), onClick: () => fileSheet(f) } : null,
            path ? { icon: 'clipboard-document', label: 'Copier le chemin', onClick: () => App.copy(path, 'Chemin') } : null,
            f ? { icon: 'trash', label: 'Supprimer le fichier', danger: true, onClick: () => deleteFiles(a, [f.id], 'le fichier de « ' + (tr.title || 'cette piste') + ' »') } : null
          ]
        });
      }
      function fileSheet(f) {
        const mi = f.mediaInfo || {};
        const nz = (v) => v != null && v !== '' && !/^0+(?:\s*[a-z]|$)/i.test(String(v).trim());
        App.sheet({
          title: 'Fichier',
          body: h('div.card', h('div.mono.wrap.sel', { style: { marginBottom: '12px' } }, f.path || ''),
            App.kv([
              ['Qualité', U.qualityName(f.quality)],
              ['Taille', f.size ? fmt.bytes(f.size) : ''],
              ['Audio', [mi.audioCodec, mi.audioBitRate, mi.audioBits, mi.audioSampleRate, nz(mi.audioChannels) ? mi.audioChannels + ' canaux' : ''].filter(nz).join(' · ')],
              ['Groupe', f.releaseGroup],
              ['Release', f.sceneName],
              ['Ajouté', fmt.dateTime(f.dateAdded)]
            ]))
        });
      }
      async function deleteFiles(a, ids, what) {
        const ok = await App.confirm({
          title: 'Supprimer ' + what + ' ?',
          message: ids.length > 1 ? ids.length + ' fichiers seront supprimés du disque.' : 'Le fichier sera supprimé du disque.',
          ok: 'Supprimer',
          danger: true
        });
        if (!ok) return;
        const api = M.api();
        for (const fid of ids) await api.del('/trackfile/' + fid);
        App.toast(ids.length > 1 ? ids.length + ' fichiers supprimés' : 'Fichier supprimé', 'ok');
        tracks.delete(a.id);
        loadAlbums();
        M.fetchItem(id).catch(() => {});
        loadHistory();
      }
      function albumMenu(a) {
        const api = M.api();
        const n = albumCounts(a);
        App.menu({
          title: a.title,
          items: [
            { icon: 'magnifying-glass', label: 'Chercher sur C411', sub: x.title + ' ' + a.title, onClick: () => M.searchC411(x, a.title) },
            { icon: 'information-circle', label: 'Détails et version suivie', onClick: () => albumSheet(a) },
            a.monitored ? { icon: 'eye-slash', label: 'Ne plus surveiller', onClick: async () => {
              await api.put('/album/monitor', { albumIds: [a.id], monitored: false });
              App.toast('Album non surveillé', 'ok');
              loadAlbums();
            } } : null,
            n.have ? { icon: 'trash', label: 'Supprimer les fichiers', sub: fmt.plural(n.have, 'fichier'), danger: true, onClick: async () => {
              const t = tracks.get(a.id);
              let ids = t && t.files ? Array.from(t.files.keys()) : null;
              if (!ids) ids = ((await api.get('/trackfile', { albumId: a.id })) || []).map((f) => f.id);
              if (!ids.length) return App.toast('Aucun fichier à supprimer');
              return deleteFiles(a, ids, 'les fichiers de « ' + a.title + ' »');
            } } : null,
            '-',
            a.foreignAlbumId ? { icon: 'globe-alt', label: 'MusicBrainz', sub: a.foreignAlbumId, onClick: () => App.openExternal(mbLink('release-group', a.foreignAlbumId)) } : null,
            api.web && a.foreignAlbumId ? { icon: 'arrow-top-right-on-square', label: 'Ouvrir dans Lidarr', onClick: () => App.openExternal(api.web + '/album/' + a.foreignAlbumId) } : null,
            '-',
            { icon: 'x-circle', label: 'Retirer l’album', danger: true, onClick: () => removeAlbum(a) }
          ]
        });
      }
      async function removeAlbum(a) {
        const vals = await App.confirm({
          title: 'Retirer « ' + a.title + ' » ?',
          message: 'L’album sera retiré de Lidarr (l’artiste reste dans la bibliothèque). Le torrent éventuel reste dans qBittorrent.',
          ok: 'Retirer',
          danger: true,
          checks: [
            { key: 'files', label: 'Supprimer aussi les fichiers du disque', checked: false },
            { key: 'excl', label: 'Ne pas le réajouter à la prochaine actualisation', checked: true }
          ]
        });
        if (!vals) return;
        await M.api().del('/album/' + a.id, { deleteFiles: !!vals.files, addImportListExclusion: !!vals.excl });
        App.toast('Album retiré' + (vals.files ? ' avec ses fichiers' : ''), 'ok');
        open.delete(a.id);
        tracks.delete(a.id);
        loadAlbums();
        M.fetchItem(id).catch(() => {});
      }
      // Lidarr needs exactly one monitored release per album: it defines the expected track list.
      async function albumSheet(a0) {
        const api = M.api();
        const a = await api.get('/album/' + a0.id);
        const n = albumCounts(a.statistics ? a : a0);
        const rels = a.releases || [];
        const cur = rels.find((r) => r.monitored) || rels[0];
        const relLabel = (r) => [r.title && r.title !== a.title ? r.title : '', r.format, r.trackCount ? fmt.plural(r.trackCount, 'piste') : '',
          (r.country || []).slice(0, 2).join('/'), (r.label || [])[0], r.disambiguation].filter(Boolean).join(' · ') || 'Version ' + r.id;
        const relSel = rels.length > 1 ? App.select(rels.map((r) => ({ value: r.id, label: relLabel(r) })), cur && cur.id) : null;
        const anySw = App.switchEl('Changer de version automatiquement', a.anyReleaseOk !== false, null, 'Lidarr peut basculer vers la version qui correspond le mieux aux fichiers importés.');
        const rt = U.ratingOf(a);
        let s = null;
        const save = async () => {
          const fresh = await api.get('/album/' + a.id);
          const pick = relSel ? Number(relSel.value) : cur && cur.id;
          const list = fresh.releases || [];
          list.forEach((r) => {
            r.monitored = r.id === pick;
          });
          if (list.length && !list.some((r) => r.monitored)) list[0].monitored = true;
          fresh.anyReleaseOk = anySw.input.checked;
          fresh.monitored = false;
          await api.put('/album/' + a.id, fresh);
          s.close();
          App.toast('Album enregistré', 'ok');
          tracks.delete(a.id);
          loadAlbums();
        };
        s = App.sheet({
          title: a.title,
          body: [
            h('div.result', { style: { background: 'transparent', border: '0', padding: '0', marginBottom: '14px' } }, M.poster(a, 500),
              h('div.main', h('div.t', a.title), h('div.s.muted', { style: { fontSize: '12.5px' } }, [x.title, yearOf(a.releaseDate)].filter(Boolean).join(' · ')),
                h('div', App.btn('Chercher sur C411', { cls: 'ghost sm', icon: 'magnifying-glass', onClick: () => { s.close(); M.searchC411(x, a.title); } })))),
            a.overview ? h('p.overview.sel', a.overview) : null,
            h('div.card', App.kv([
              ['Sortie', fmt.date(a.releaseDate)],
              ['Type', [TYPE_ONE[a.albumType] || a.albumType].concat(secNames(a).map(metaFr)).filter(Boolean).join(', ')],
              ['Genres', (a.genres || []).map(cap).join(', ')],
              ['Durée', fmtDur(a.duration)],
              ['Pistes', n.total ? n.have + ' / ' + n.total : ''],
              ['Taille', n.size ? fmt.bytes(n.size) : ''],
              ['Note', rt ? Number(rt.v).toFixed(1) + ' / 10' : '']
            ])),
            relSel ? App.field('Version suivie', relSel, 'Détermine la liste des pistes attendues (édition, pays, nombre de disques…).') : null,
            anySw,
            App.note('L’album reste non surveillé : Lidarr ne lancera aucune recherche.', '', 'eye-slash')
          ],
          actions: [App.btn('Annuler', { onClick: () => s.close() }), App.btn('Enregistrer', { cls: 'pri', icon: 'check', onClick: save })]
        });
      }
      function detailsMenu() {
        const api = M.api();
        App.menu({
          title: x.title,
          items: [
            { icon: 'pencil-square', label: 'Modifier', onClick: () => M.openEdit(x) },
            { icon: 'plus', label: 'Ajouter un album', onClick: () => M.openAdd(x.title + ' ', 'album') },
            { icon: 'document-text', label: 'Renommer les fichiers', onClick: () => M.openRename(x) },
            { icon: 'tag', label: 'Réécrire les tags', sub: 'Met à jour les métadonnées des fichiers audio', onClick: () => M.openRetag(x) },
            { icon: 'arrow-path', label: 'Actualiser et rescanner', onClick: () => refresh() },
            anyMonitored() ? { icon: 'eye-slash', label: 'Ne plus surveiller', onClick: () => M.unmonitor(x) } : null,
            '-',
            x.foreignArtistId ? { icon: 'globe-alt', label: 'MusicBrainz', sub: x.foreignArtistId, onClick: () => App.openExternal(mbLink('artist', x.foreignArtistId)) } : null,
            ...topLinks(x).map((l) => ({ icon: 'link', label: LINK_NAME[l.name] || cap(l.name), sub: hostOf(l.url), onClick: () => App.openExternal(l.url) })),
            api.web && x.foreignArtistId ? { icon: 'arrow-top-right-on-square', label: 'Ouvrir dans Lidarr', onClick: () => App.openExternal(api.web + '/artist/' + x.foreignArtistId) } : null,
            x.path ? { icon: 'clipboard-document', label: 'Copier le chemin', sub: x.path, onClick: () => App.copy(x.path, 'Chemin') } : null,
            '-',
            { icon: 'trash', label: 'Supprimer', danger: true, onClick: () => M.askDelete(x, close) }
          ]
        });
      }

      const offs = [
        App.on('lidarr:item', (d) => {
          if (!d || d.id !== id || gone) return;
          if (d.deleted) {
            gone = true;
            close();
            return;
          }
          x = d;
          render();
        }),
        App.on('lidarr:files', (aid) => {
          if (Number(aid) !== id || gone) return;
          reloadAll();
        })
      ];
      page.onDestroy = () => {
        gone = true;
        clearTimeout(retryTimer);
        offs.forEach((f) => f());
      };
      App.push('lidarr', page);
      render();
      renderAlbums();
      renderHistory();
      M.meta().then(() => {
        if (x && !gone) render();
      }, () => {});
      load();
      loadAlbums();
      loadHistory();
    };

    // ---------- Edit, delete, rename, retag, unmonitor ----------
    // Nothing is ever monitored: downloads are always driven from C411.
    M.openEdit = async function (x) {
      const meta = await M.meta();
      const api = M.api();
      const profSel = App.select(meta.profiles.map((p) => ({ value: p.id, label: p.name })), x.qualityProfileId);
      const mps = meta.metaProfiles || [];
      const metaSel = mps.length ? App.select(mps.map((p) => ({ value: p.id, label: /^none$/i.test(p.name) ? 'None (albums ajoutés à la main)' : p.name })), x.metadataProfileId) : null;
      const metaHint = App.note('Lidarr va actualiser l’artiste : des albums peuvent apparaître ou disparaître selon les types autorisés par ce profil.', 'warn', 'information-circle');
      metaHint.classList.add('hidden');
      if (metaSel) metaSel.addEventListener('change', () => metaHint.classList.toggle('hidden', Number(metaSel.value) === x.metadataProfileId));
      const curRoot = rootOf(x);
      const roots = meta.roots.map((r) => ({ value: trimSlash(r.path), label: trimSlash(r.path) + (r.freeSpace ? ' · ' + fmt.bytes(r.freeSpace) + ' libres' : '') }));
      if (curRoot && !roots.some((r) => r.value === curRoot)) roots.unshift({ value: curRoot, label: curRoot + ' (actuel)' });
      const rootSel = App.select(roots, curRoot);
      const moveHint = App.note('Les fichiers existants seront déplacés vers le nouveau dossier racine.', 'warn', 'folder');
      moveHint.classList.add('hidden');
      rootSel.addEventListener('change', () => moveHint.classList.toggle('hidden', rootSel.value === curRoot));
      const tags = M.tagPicker(meta, x.tags);
      let s = null;
      const save = async () => {
        const cur = await api.get('/artist/' + x.id);
        cur.qualityProfileId = Number(profSel.value);
        const metaChanged = !!metaSel && Number(metaSel.value) !== cur.metadataProfileId;
        if (metaSel) cur.metadataProfileId = Number(metaSel.value);
        cur.tags = tags.value();
        cur.monitored = false;
        cur.monitorNewItems = 'none';
        let q;
        if (rootSel.value && rootSel.value !== curRoot) {
          cur.rootFolderPath = rootSel.value;
          cur.path = U.joinPath(rootSel.value, cur.folder || U.baseName(cur.path));
          q = { moveFiles: true };
        }
        const saved = await api.put('/artist/' + x.id, cur, q);
        s.close();
        M.upsert(saved && saved.id ? saved : cur);
        App.toast(q ? 'Enregistré · déplacement des fichiers en cours' : 'Modifications enregistrées', 'ok');
        // Lidarr refreshes the artist by itself after a metadata profile change: reload the discography afterwards.
        if (metaChanged) [5000, 15000].forEach((ms) => setTimeout(() => App.emit('lidarr:files', x.id), ms));
      };
      s = App.sheet({
        title: 'Modifier',
        body: [h('div.muted.nowrap', { style: { margin: '-4px 0 12px' } }, x.title),
          App.field('Profil de qualité', profSel),
          metaSel ? App.field('Profil de métadonnées', metaSel, 'Types de sorties (albums, EP, singles…) que Lidarr liste pour cet artiste.') : null,
          metaHint,
          App.field('Dossier racine', rootSel), moveHint,
          App.field('Étiquettes', tags.el),
          App.note('L’artiste et ses albums restent non surveillés : Lidarr ne lancera jamais de recherche ni de téléchargement.', '', 'eye-slash')],
        actions: [App.btn('Annuler', { onClick: () => s.close() }), App.btn('Enregistrer', { cls: 'pri', icon: 'check', onClick: save })]
      });
    };

    M.askDelete = async function (x, done) {
      const vals = await App.confirm({
        title: 'Supprimer « ' + x.title + ' » ?',
        message: 'L’artiste et ses albums seront retirés de Lidarr. Le torrent éventuel reste dans qBittorrent.',
        ok: 'Supprimer',
        danger: true,
        checks: [
          { key: 'files', label: 'Supprimer aussi les fichiers du disque', checked: false },
          { key: 'excl', label: 'Empêcher le réajout par les listes d’import', checked: false }
        ]
      });
      if (!vals) return;
      await M.api().del('/artist/' + x.id, { deleteFiles: !!vals.files, addImportListExclusion: !!vals.excl });
      M.remove(x.id);
      App.toast('Artiste supprimé' + (vals.files ? ' avec ses fichiers' : ''), 'ok');
      if (done) done();
    };

    async function diffSheet(o) {
      const list = await M.api().get(o.ep, { artistId: o.x.id });
      if (!Array.isArray(list) || !list.length) return App.toast(o.empty, 'ok');
      let s = null;
      s = App.sheet({
        title: o.title(list.length),
        body: h('div.group', list.map(o.row)),
        actions: [App.btn('Annuler', { onClick: () => s.close() }), App.btn(o.ok, {
          cls: 'pri',
          icon: o.icon,
          onClick: async () => {
            const ids = Array.from(new Set(list.map((r) => r.trackFileId).filter(Boolean)));
            s.close();
            await M.runCommand(o.cmd, { artistId: o.x.id, files: ids }, { label: o.label, wait: true });
            await M.fetchItem(o.x.id).catch(() => {});
            App.emit('lidarr:files', o.x.id);
          }
        })]
      });
    }
    const strike = { textDecoration: 'line-through', opacity: '.7' };
    M.openRename = (x) => diffSheet({
      x: x, ep: '/rename', cmd: 'RenameFiles', label: 'Renommage', ok: 'Renommer', icon: 'pencil-square',
      empty: 'Les fichiers sont déjà correctement nommés',
      title: (n) => 'Renommer ' + fmt.plural(n, 'fichier'),
      row: (r) => h('div.item', h('div.main',
        h('div.s.mono.wrap', { style: strike }, r.existingPath),
        h('div.t.mono.wrap', { style: { marginTop: '4px' } }, r.newPath)))
    });
    M.openRetag = (x) => diffSheet({
      x: x, ep: '/retag', cmd: 'RetagFiles', label: 'Réécriture des tags', ok: 'Réécrire', icon: 'tag',
      empty: 'Les tags sont déjà à jour',
      title: (n) => 'Réécrire les tags · ' + fmt.plural(n, 'fichier'),
      row: (r) => h('div.item', h('div.main',
        h('div.t.mono.wrap', U.baseName(r.path)),
        (r.changes || []).map((c) => h('div.s.wrap', { style: { marginTop: '3px' } },
          h('b', c.field + ' : '), h('span', { style: strike }, c.oldValue || '∅'), ' → ', h('span', c.newValue || '∅')))))
    });

    M.unmonitor = async function (x) {
      const api = M.api();
      const cur = await api.get('/artist/' + x.id);
      cur.monitored = false;
      cur.monitorNewItems = 'none';
      const saved = await api.put('/artist/' + x.id, cur);
      const list = await api.get('/album', { artistId: x.id }).catch(() => []);
      const ids = (Array.isArray(list) ? list : []).filter((a) => a.monitored).map((a) => a.id);
      if (ids.length) await api.put('/album/monitor', { albumIds: ids, monitored: false });
      M.upsert(saved && saved.id ? saved : cur);
      App.emit('lidarr:files', x.id);
      App.toast('Artiste non surveillé', 'ok');
    };

    // ---------- Add: artist / album lookup ----------
    function parseTerm(t) {
      t = String(t || '').trim();
      let m;
      if ((m = /musicbrainz\.org\/artist\/([0-9a-f-]{36})/i.exec(t))) return { mode: 'artist', term: 'lidarr:' + m[1].toLowerCase() };
      if ((m = /musicbrainz\.org\/(?:release-group|release)\/([0-9a-f-]{36})/i.exec(t))) return { mode: 'album', term: 'lidarr:' + m[1].toLowerCase() };
      if ((m = /^(?:lidarr|lidarrid|mbid|mb)\s*:\s*([0-9a-f-]{36})$/i.exec(t)) || (m = new RegExp('^' + MBID.source + '$', 'i').exec(t))) return { mode: null, term: 'lidarr:' + m[1].toLowerCase() };
      return { mode: null, term: t };
    }
    const c411Term = (r) => (isAlbum(r) ? [r.artist && (r.artist.artistName || r.artist.title), r.title].filter(Boolean).join(' ') : r.title || r.artistName || '');
    M.openAdd = function (term, mode) {
      if (App.state.tab !== 'lidarr') App.goTab('lidarr');
      const stack = App.tabs.lidarr.stack;
      const top = stack[stack.length - 1];
      if (top && top.isAdd) {
        if (term || mode) top.setTerm(term || '', mode);
        return;
      }
      const page = App.page({ title: 'Ajouter de la musique', back: true });
      page.isAdd = true;
      let kind = mode === 'album' || mode === 'artist' ? mode : App.pref('lidarr.addMode', 'artist') === 'album' ? 'album' : 'artist';
      const ph = () => (kind === 'album' ? 'Artiste et album, ou lien MusicBrainz…' : 'Nom de l’artiste ou lien MusicBrainz…');
      const input = App.input({ type: 'search', placeholder: ph(), enterkeyhint: 'search' });
      const seg = App.seg([{ value: 'artist', label: 'Artiste' }, { value: 'album', label: 'Album' }], kind, (v) => setKind(v, true));
      seg.style.marginBottom = '8px';
      const box = h('div');
      const scroll = h('div.scroll', h('div.sticky', seg, h('div.search', App.icon('magnifying-glass'), input)), box);
      page.el.appendChild(scroll);
      let seq = 0;
      let results = null;
      let lastQ = '';
      function setKind(v, user, quiet) {
        if (v !== 'artist' && v !== 'album') return;
        const changed = v !== kind;
        kind = v;
        seg.set(v);
        input.placeholder = ph();
        if (user) App.setPref('lidarr.addMode', v);
        if (changed && !quiet) search(true);
      }
      async function search(force) {
        const p = parseTerm(input.value);
        if (p.mode) setKind(p.mode, false, true);
        const q = p.term;
        if (!q) {
          seq++;
          lastQ = '';
          results = null;
          return renderResults();
        }
        const key = kind + '|' + q;
        if (key === lastQ && !force) return;
        lastQ = key;
        const my = ++seq;
        App.fill(box, App.loading());
        try {
          const r = await M.api().get(kind === 'album' ? '/album/lookup' : '/artist/lookup', { term: q });
          if (my !== seq) return;
          results = (Array.isArray(r) ? r : r ? [r] : []).slice(0, 40);
          results.forEach((x) => {
            M.prep(x);
            if (x.artist) M.prep(x.artist);
          });
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
          return App.fill(box, App.needSetup('musical-note', 'Lidarr', 'lidarr', 'Renseigne l’URL et la clé API dans les réglages.'));
        }
        if (results == null) {
          return App.fill(box, App.empty('magnifying-glass', kind === 'album' ? 'Rechercher un album' : 'Rechercher un artiste',
            (kind === 'album' ? 'Tape l’artiste suivi du titre de l’album' : 'Tape le nom de l’artiste') + ', ou colle un lien MusicBrainz. L’ajout se fait toujours sans surveillance ni recherche automatique.'));
        }
        if (results instanceof Error) {
          return App.fill(box, App.note(results.message, 'err'), h('div.btn-row', { style: { marginTop: '10px' } },
            App.btn('Réessayer', { icon: 'arrow-path', onClick: () => search(true) })));
        }
        if (!results.length) {
          return App.fill(box, App.empty('magnifying-glass', 'Aucun résultat', kind === 'album'
            ? 'Essaie « artiste album », ou passe en mode Artiste pour parcourir sa discographie.'
            : 'Essaie une autre orthographe, ou colle le lien MusicBrainz de l’artiste.'));
        }
        App.fill(box, results.map(resultEl));
      }
      function resultEl(r) {
        const alb = isAlbum(r);
        const lib = M.inLib(r);
        const rating = U.ratingOf(r);
        const has = alb ? !!r.id : !!(lib && lib.id);
        const b = h('button.result', { type: 'button' }, M.poster(r, 250),
          h('div.main',
            h('div.t', r.title),
            h('div.s.muted', { style: { fontSize: '12.5px' } }, M.metaLine(r)),
            h('div.badges',
              has ? App.badge('Dans la bibliothèque', 'green', 'check') : alb && lib && lib.id ? App.badge('Artiste suivi', 'blue', 'user-group') : null,
              !alb && r.status === 'ended' ? App.badge('Inactif', '') : null,
              rating ? App.badge(Number(rating.v).toFixed(1), 'amber', 'star') : null),
            r.overview ? h('div.ov', r.overview) : null));
        b.addEventListener('click', () => App.run(() => pickResult(r)));
        return b;
      }
      async function pickResult(r) {
        const lib = M.inLib(r);
        if (!isAlbum(r)) return lib && lib.id ? M.openDetails(lib.id) : M.openAddSheet(r);
        const artistId = (a) => a.artistId || (a.artist && a.artist.id) || (lib && lib.id);
        if (r.id) return M.openDetails(artistId(r), { album: r.id });
        if (lib && lib.id) {
          // Followed artist: the album may already be listed under another lookup result.
          const ex = await M.api().get('/album', { foreignAlbumId: r.foreignAlbumId }).catch(() => null);
          const hit = Array.isArray(ex) ? ex[0] : ex && ex.id ? ex : null;
          if (hit && hit.id) return M.openDetails(artistId(hit), { album: hit.id });
        }
        return M.openAddSheet(r);
      }
      const off = App.on('lidarr:lib', () => {
        if (Array.isArray(results) && results.length) renderResults();
      });
      page.onDestroy = () => {
        seq++;
        off();
      };
      page.setTerm = (t, m) => {
        setKind(m, false, true);
        input.value = t || '';
        if (/\s$/.test(input.value)) setTimeout(() => input.focus(), 320);
        search(true);
      };
      App.push('lidarr', page);
      M.loadLib().catch(() => {});
      if (term) page.setTerm(term, mode);
      else {
        renderResults();
        setTimeout(() => input.focus(), 320);
      }
    };

    // ---------- Add sheet (artist, or album + its artist when not followed yet) ----------
    const isNone = (p) => /^none$/i.test((p && p.name) || '');
    const allowedOf = (list, key, names) => (list || []).filter((t) => t.allowed && t[key]).map((t) => (names && names[t[key].name]) || metaFr(t[key].name));
    const metaSummary = (p) => allowedOf(p.primaryAlbumTypes, 'albumType', TYPE_MANY).join(', ') || 'aucun type';
    M.openAddSheet = async function (r, o) {
      o = o || {};
      const alb = isAlbum(r);
      const meta = await M.meta();
      const known = alb ? M.inLib(r) : null;
      const needArtist = !alb || !(known && known.id);
      if (needArtist && !meta.roots.length) throw App.mkErr('Aucun dossier racine configuré dans Lidarr');
      if (needArtist && !meta.profiles.length) throw App.mkErr('Aucun profil de qualité dans Lidarr');
      const cfg = App.config;
      const mps = meta.metaProfiles || [];
      const has = (list, v) => !!Number(v) && list.some((p) => p.id === Number(v));
      const pickId = (list, cands, fb) => {
        const c = cands.find((v) => has(list, v));
        return c != null ? Number(c) : fb;
      };
      const roots = meta.roots.map((x) => ({ value: trimSlash(x.path), label: trimSlash(x.path) + (x.freeSpace ? ' · ' + fmt.bytes(x.freeSpace) + ' libres' : ''), def: x }));
      const rootDef = (v) => (roots.find((x) => x.value === v) || {}).def || {};
      let root = trimSlash(cfg.lidarrRoot || '');
      if (roots.length && !roots.some((x) => x.value === root)) root = roots[0].value;
      const rootSel = App.select(roots, root);
      const profSel = App.select(meta.profiles.map((p) => ({ value: p.id, label: p.name })),
        pickId(meta.profiles, [cfg.lidarrProfile, rootDef(root).defaultQualityProfileId], meta.profiles.length ? meta.profiles[0].id : 0));
      // "None" only lists hand-added albums: useless for an artist added on its own.
      const metaOpts = mps.filter((p) => alb || !isNone(p));
      const firstReal = (mps.find((p) => !isNone(p)) || mps[0] || {}).id;
      const metaSel = metaOpts.length ? App.select(metaOpts.map((p) => ({ value: p.id, label: isNone(p) ? 'None (uniquement cet album)' : p.name })),
        pickId(metaOpts, [cfg.lidarrMetaProfile, rootDef(root).defaultMetadataProfileId], has(metaOpts, firstReal) ? firstReal : metaOpts[0].id)) : null;
      const metaHint = h('div.hint');
      const updHint = () => {
        const p = metaSel && mps.find((x) => x.id === Number(metaSel.value));
        metaHint.textContent = !p ? '' : isNone(p)
          ? 'Seul cet album sera listé pour l’artiste. Tu pourras en ajouter d’autres à la main.'
          : 'Lidarr listera la discographie (' + metaSummary(p) + '), sans rien surveiller.';
      };
      if (metaSel) metaSel.addEventListener('change', updHint);
      updHint();
      rootSel.addEventListener('change', () => {
        const d = rootDef(rootSel.value);
        if (!has(meta.profiles, cfg.lidarrProfile) && has(meta.profiles, d.defaultQualityProfileId)) profSel.value = String(d.defaultQualityProfileId);
        if (metaSel && !has(metaOpts, cfg.lidarrMetaProfile) && has(metaOpts, d.defaultMetadataProfileId)) {
          metaSel.value = String(d.defaultMetadataProfileId);
          updHint();
        }
      });
      const tags = M.tagPicker(meta, []);
      const fields = [];
      if (needArtist) {
        if (alb) fields.push(App.note('L’artiste' + (r.artist && r.artist.title ? ' « ' + r.artist.title + ' »' : '') + ' n’est pas encore dans Lidarr : il sera ajouté avec ces réglages.', '', 'user-group'));
        fields.push(App.field('Dossier racine', rootSel), App.field('Profil de qualité', profSel));
        if (metaSel) fields.push(h('div.field', h('label', 'Profil de métadonnées'), metaSel, metaHint));
        fields.push(App.field('Étiquettes', tags.el));
      } else {
        fields.push(App.note('Artiste déjà suivi : l’album sera rattaché à « ' + known.title + ' » avec ses réglages actuels.', '', 'user-group'));
      }
      fields.push(App.note('Ajout non surveillé : Lidarr ne lancera aucune recherche ni téléchargement. Télécharge la release depuis C411.', '', 'eye-slash'));
      const artistBody = (src) => {
        const b = JSON.parse(JSON.stringify(src || {}));
        ['id', 'path', 'title', 'sortTitle', 'statistics'].forEach((k) => delete b[k]);
        return Object.assign(b, {
          qualityProfileId: Number(profSel.value),
          metadataProfileId: metaSel ? Number(metaSel.value) : firstReal || 1,
          rootFolderPath: rootSel.value,
          monitored: false,
          monitorNewItems: 'none',
          albumFolder: true,
          tags: tags.value(),
          addOptions: { monitor: 'none', albumsToMonitor: [], monitored: false, searchForMissingAlbums: false }
        });
      };
      let s = null;
      const add = async () => {
        const api = M.api();
        let added;
        if (alb) {
          const b = JSON.parse(JSON.stringify(r));
          delete b.id;
          b.artist = needArtist ? artistBody(r.artist) : Object.assign({}, known);
          Object.assign(b, { monitored: false, anyReleaseOk: true, addOptions: { addType: 'manual', searchForNewAlbum: false } });
          added = await api.post('/album', b);
        } else {
          added = await api.post('/artist', artistBody(r));
        }
        s.close();
        App.toast((alb ? 'Album ajouté' : 'Artiste ajouté') + ' à Lidarr (non surveillé)', 'ok');
        await M.loadLib(true).catch(() => {});
        let aid = alb ? (added && added.artistId) || (known && known.id) : added && added.id;
        if (!aid && alb) {
          const f = M.findByIds({ mb: (r.artist && r.artist.foreignArtistId) || r.foreignArtistId });
          aid = f && f.id;
        }
        if (aid && alb && !needArtist) App.emit('lidarr:files', aid);
        if (o.onAdded) o.onAdded(added);
        else if (aid) M.openDetails(aid, alb && added && added.id ? { album: added.id } : undefined);
      };
      const head = h('div.result', { style: { background: 'transparent', border: '0', padding: '0', marginBottom: '14px' } }, M.poster(r, 250),
        h('div.main', h('div.t', r.title), h('div.s.muted', { style: { fontSize: '12.5px' } }, M.metaLine(r)),
          h('div', App.btn('Chercher sur C411', { cls: 'ghost sm', icon: 'magnifying-glass', onClick: () => App.c411Search(c411Term(r)) }))));
      s = App.sheet({
        title: alb ? 'Ajouter l’album' : 'Ajouter l’artiste',
        body: [head].concat(fields),
        actions: [App.btn('Annuler', { onClick: () => s.close() }), App.btn('Ajouter', { cls: 'pri', icon: 'plus', onClick: add })]
      });
    };

    // ---------- Metadata profiles (System > Gestion) ----------
    async function editMeta(p0, done) {
      const api = M.api();
      const p = p0 ? JSON.parse(JSON.stringify(p0)) : await api.get('/metadataprofile/schema');
      if (!p0) {
        delete p.id;
        p.name = '';
      }
      const name = App.input({ value: p.name || '', placeholder: 'ex. Albums et EP', autocapitalize: 'sentences' });
      const group = (title, list, key, names) => [
        App.secTitle(title),
        h('div.card', (list || []).filter((t) => t[key]).map((t) => App.switchEl((names && names[t[key].name]) || metaFr(t[key].name), !!t.allowed, (on) => {
          t.allowed = on;
        })))
      ];
      let s = null;
      const reload = async () => {
        await M.meta(true).catch(() => {});
        done();
      };
      const save = async () => {
        const n = name.value.trim();
        if (!n) throw App.mkErr('Donne un nom au profil');
        const none = (l) => !(l || []).some((t) => t.allowed);
        if (none(p.primaryAlbumTypes)) throw App.mkErr('Autorise au moins un type principal');
        if (none(p.secondaryAlbumTypes)) throw App.mkErr('Autorise au moins un type secondaire (Studio pour les albums classiques)');
        if (none(p.releaseStatuses)) throw App.mkErr('Autorise au moins un statut de sortie (Officielle en général)');
        p.name = n;
        if (p.id) await api.put('/metadataprofile/' + p.id, p);
        else await api.post('/metadataprofile', p);
        s.close();
        App.toast('Profil enregistré', 'ok');
        await reload();
      };
      const del = async () => {
        const ok = await App.confirm({ title: 'Supprimer « ' + p.name + ' » ?', message: 'Impossible si un artiste ou une liste d’import utilise ce profil.', ok: 'Supprimer', danger: true });
        if (!ok) return;
        await api.del('/metadataprofile/' + p.id);
        s.close();
        App.toast('Profil supprimé', 'ok');
        await reload();
      };
      s = App.sheet({
        title: p.id ? p.name : 'Nouveau profil',
        full: true,
        body: [
          App.field('Nom', name),
          group('Types principaux', p.primaryAlbumTypes, 'albumType', TYPE_MANY),
          group('Types secondaires', p.secondaryAlbumTypes, 'albumType'),
          group('Statuts de sortie', p.releaseStatuses, 'releaseStatus'),
          App.note('Les artistes qui utilisent ce profil seront actualisés : leur discographie suivra ces types, toujours sans surveillance.', '', 'information-circle')
        ],
        actions: [
          p.id ? App.btn('Supprimer', { cls: 'danger', icon: 'trash', onClick: del }) : null,
          App.btn('Annuler', { onClick: () => s.close() }),
          App.btn('Enregistrer', { cls: 'pri', icon: 'check', onClick: save })
        ]
      });
    }
    function openMetaProfiles() {
      const box = h('div');
      let list = null;
      const page = App.page({ title: 'Profils de métadonnées', subtitle: 'Lidarr', back: true, actions: [App.iconBtn('plus', 'Nouveau profil', () => editMeta(null, load))] });
      page.el.appendChild(h('div.scroll',
        App.note('Un profil de métadonnées choisit les sorties (albums, EP, singles, live, compilations…) que Lidarr liste pour un artiste. « None » ne liste que les albums ajoutés à la main.', '', 'information-circle'),
        box));
      App.push('lidarr', page);
      async function load() {
        if (!list) App.fill(box, App.loading());
        try {
          const r = await M.api().get('/metadataprofile');
          list = (Array.isArray(r) ? r : []).sort((a, b) => isNone(a) - isNone(b) || coll.compare(a.name || '', b.name || ''));
        } catch (e) {
          return App.fill(box, App.empty('exclamation-triangle', 'Profils indisponibles', e.message, [App.btn('Réessayer', { cls: 'pri', icon: 'arrow-path', onClick: load })]));
        }
        App.fill(box,
          h('div.group', list.map((p) => {
            const sec = allowedOf(p.secondaryAlbumTypes, 'albumType').filter((t) => t !== 'Studio');
            const sub = isNone(p) ? 'Uniquement les albums ajoutés à la main' : metaSummary(p) + (sec.length ? ' · + ' + sec.join(', ') : '');
            const b = h('button.item', { type: 'button' }, App.icon('adjustments-horizontal'), h('div.main', h('div.t', p.name), h('div.s', sub)),
              isNone(p) ? null : App.icon('chevron-right', 'sm'));
            b.addEventListener('click', () => App.run(() => (isNone(p) ? App.toast('Le profil « None » n’est pas modifiable') : editMeta(p, load))));
            return b;
          })),
          h('div.btn-row', App.btn('Nouveau profil', { cls: 'pri', icon: 'plus', onClick: () => editMeta(null, load) })));
      }
      load();
    }
    M.sysTools = [{ icon: 'adjustments-horizontal', label: 'Profils de métadonnées', sub: 'Types d’albums listés par Lidarr', fn: openMetaProfiles }];

    return M;
  };
})();
