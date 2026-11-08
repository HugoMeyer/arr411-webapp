/* Arr411 - qBittorrent: torrent details, categories & tags, server preferences, log. */
(function () {
  'use strict';
  const App = window.App;
  const h = App.h;
  const fmt = App.fmt;
  const qb = App.qb;
  const Q = App.qbit;
  const A = Q.act;

  const TR_STATUS = { 0: ['Désactivé', ''], 1: ['Pas contacté', 'amber'], 2: ['Fonctionne', 'green'], 3: ['Mise à jour…', 'blue'], 4: ['Erreur', 'red'] };
  const FILE_PRIOS = [
    { value: 1, label: 'Normale', icon: 'arrow-down-tray' },
    { value: 6, label: 'Haute', icon: 'arrow-up' },
    { value: 7, label: 'Maximale', icon: 'bolt' },
    { value: 0, label: 'Ne pas télécharger', icon: 'minus-circle' }
  ];
  const prioName = (p) => (p === 0 ? 'Ne pas télécharger' : p >= 7 ? 'Maximale' : p >= 2 ? 'Haute' : 'Normale');
  // Hide passkeys in announce URLs (still copied in full).
  const maskKey = (u) => String(u || '').replace(/([A-Za-z0-9]{24,})/g, (m) => m.slice(0, 4) + '•••' + m.slice(-3));
  const isC411 = (t) => /c411/i.test((t.tracker || '') + ' ' + (t.comment || ''));

  Q.cleanName = function (n) {
    let s = String(n || '').replace(/\.(mkv|mp4|avi|m4v|ts|iso)$/i, '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ');
    const cut = s.search(/\b(S\d{1,2}(E\d{1,3})?|\d{3,4}p|MULTI|VOSTFR|VOF|VFF|VFQ|VFI|VF2?|FRENCH|TRUEFRENCH|SUBFRENCH|COMPLETE|INTEGRALE|BluRay|BDRip|WEB(-?DL|Rip)?|HDTV|HDLight|4KLight|REMUX|x26[45]|HEVC)\b/i);
    if (cut > 1) s = s.slice(0, cut);
    return s.replace(/[[({].*$/, '').replace(/[-\s]+$/, '').trim() || String(n || '');
  };

  function act(ic, label, fn, danger) {
    const b = h('button.act' + (danger ? '.danger' : ''), { type: 'button' }, App.icon(ic), h('span', label));
    b.addEventListener('click', () => App.run(fn));
    return b;
  }
  function linkBtn(label, fn) {
    return h('button', { type: 'button', onclick: () => App.run(fn) }, label);
  }

  // ---------- Torrent details ----------
  Q.openDetails = async function (hash) {
    hash = String(hash || '').toLowerCase();
    if (!hash) return;
    if (App.state.tab !== 'qbit') App.goTab('qbit');
    const stack = App.tabs.qbit.stack;
    const top = stack[stack.length - 1];
    if (top && top.hash === hash) return;

    const page = App.page({ title: (Q.get(hash) || {}).name || 'Torrent', back: true });
    page.hash = hash;
    const pauseBtn = App.iconBtn('pause', 'Mettre en pause', () => Q.togglePause(hash));
    App.append(page.actions, pauseBtn, App.iconBtn('ellipsis-vertical', 'Plus d’actions', () => detailsMenu()));
    const box = h('div.sections');
    const secs = {};
    let cur = 'info';
    let gone = false;
    const builders = { info: buildInfo, files: buildFiles, trackers: buildTrackers, peers: buildPeers };
    const seg = App.seg([
      { value: 'info', label: 'Infos' },
      { value: 'files', label: 'Fichiers' },
      { value: 'trackers', label: 'Trackers' },
      { value: 'peers', label: 'Pairs' }
    ], 'info', (v) => show(v));
    App.append(page.el, seg, box);

    const loop = App.loop(async () => {
      const s = secs[cur];
      if (!s || !s.refresh || gone) return;
      try {
        await s.refresh();
      } catch (e) {
        if (s.fail) s.fail(e);
      }
    }, () => (App.isTop(page) && !gone ? (cur === 'info' ? 5000 : 3000) : null));

    function show(v) {
      cur = v;
      if (!secs[v]) {
        secs[v] = builders[v]();
        box.appendChild(secs[v].el);
        const t = Q.get(hash);
        if (t && secs[v].render) secs[v].render(t);
      }
      for (const k in secs) secs[k].el.classList.toggle('hidden', k !== v);
      loop.kick();
    }
    let lastPaused = null;
    function renderTorrent() {
      const t = Q.get(hash);
      if (!t) {
        if (Q.store.loaded && !gone) {
          gone = true;
          seg.classList.add('hidden');
          App.clear(page.actions);
          page.setSub('');
          App.fill(box, h('div.section', App.empty('trash', 'Torrent introuvable', 'Il a été supprimé de qBittorrent.', [App.btn('Retour', { onClick: () => App.pop('qbit') })])));
        }
        return;
      }
      page.setTitle(t.name);
      page.setSub(Q.stateLabel(t) + ' · ' + fmt.pct(t.progress) + ' · ' + fmt.bytes(t.size));
      const paused = Q.isPaused(t);
      if (paused !== lastPaused) {
        lastPaused = paused;
        App.fill(pauseBtn, App.icon(paused ? 'play' : 'pause'));
        pauseBtn.setAttribute('aria-label', paused ? 'Reprendre' : 'Mettre en pause');
        pauseBtn.title = paused ? 'Reprendre' : 'Mettre en pause';
      }
      for (const k in secs) if (secs[k].render) secs[k].render(t);
    }
    const off = App.on('qbit', renderTorrent);
    page.onDestroy = () => {
      loop.stop();
      off();
    };
    App.push('qbit', page);
    show('info');
    try {
      await Q.ensure();
    } catch (e) {
      if (secs.info) secs.info.fail(e);
      return;
    }
    renderTorrent();

    // ----- Infos -----
    function buildInfo() {
      const el = h('div.section');
      const pctEl = h('b');
      const stEl = h('span.muted');
      const bar = App.bar(0);
      const meta = h('div.meta');
      const card = h('div.card', { 'data-s': 'queued' }, h('div.big-progress', pctEl, stEl), bar, meta);
      const pauseAct = act('pause', 'Pause', () => Q.togglePause(hash));
      const grid = h('div.actions-grid',
        pauseAct,
        act('forward', 'Forcer', async () => {
          await A.force([hash], true);
          App.toast('Reprise forcée', 'ok');
          Q.refresh();
        }),
        act('shield-check', 'Vérifier', async () => {
          await A.recheck([hash]);
          App.toast('Vérification lancée', 'ok');
          Q.refresh();
        }),
        act('megaphone', 'Réannoncer', async () => {
          await A.reannounce([hash]);
          App.toast('Réannonce envoyée', 'ok');
        }),
        act('folder', 'Catégorie', () => Q.askCategory([hash])),
        act('tag', 'Étiquettes', () => Q.askTags([hash])),
        act('arrows-right-left', 'Déplacer', () => Q.askLocation([hash])),
        act('trash', 'Supprimer', () => Q.askDelete([hash], () => App.pop('qbit')), true)
      );
      const transfer = h('div.card', App.loading());
      const info = h('div.card');
      const pending = {};
      function optSwitch(key, label, sub, fn) {
        const s = App.switchEl(label, false, async (v, inp) => {
          pending[key] = Date.now();
          try {
            await fn(v);
          } catch (e) {
            inp.checked = !v;
            throw e;
          }
          const t = Q.get(hash);
          if (t) t[key] = v;
          Q.refresh();
        }, sub);
        s.key = key;
        return s;
      }
      const opts = [
        optSwitch('seq_dl', 'Téléchargement séquentiel', 'Pratique pour lire pendant le téléchargement', () => A.seq([hash])),
        optSwitch('f_l_piece_prio', 'Premières et dernières pièces d’abord', null, () => A.firstLast([hash])),
        optSwitch('auto_tmm', 'Gestion automatique', 'Le dossier suit celui de la catégorie', (v) => A.autoTMM([hash], v)),
        optSwitch('super_seeding', 'Super seed', 'Réservé au premier seeder d’un torrent', (v) => A.superSeed([hash], v))
      ];
      const limSub = h('div.s');
      const shareSub = h('div.s');
      const limits = h('div.group',
        h('button.item', { type: 'button', onclick: () => Q.askLimits([hash]) }, App.icon('adjustments-horizontal'), h('div.main', h('div.t', 'Limites de vitesse'), limSub), App.icon('chevron-right', 'sm')),
        h('button.item', { type: 'button', onclick: () => App.run(askShareLimits) }, App.icon('chart-bar'), h('div.main', h('div.t', 'Limites de partage'), shareSub), App.icon('chevron-right', 'sm'))
      );
      App.append(el, card, grid, App.secTitle('Transfert'), transfer, App.secTitle('Informations'), info, App.secTitle('Options'), h('div.card', { style: { padding: '0 14px' } }, opts), limits);
      let props = null;
      let pausedShown = null;
      const lim = (v) => (v > 0 ? fmt.speed(v) : '∞');
      const shareTxt = (v, unit) => (v === -2 || v == null ? 'global' : v === -1 ? 'aucune' : unit(v));
      function renderKv() {
        const t = Q.get(hash) || {};
        const p = props || {};
        if (props) {
          App.fill(transfer, App.kv([
            ['Téléchargé', fmt.bytes(p.total_downloaded) + (p.total_downloaded_session ? ' (session ' + fmt.bytes(p.total_downloaded_session) + ')' : '')],
            ['Envoyé', fmt.bytes(p.total_uploaded) + (p.total_uploaded_session ? ' (session ' + fmt.bytes(p.total_uploaded_session) + ')' : '')],
            ['Ratio', fmt.ratio(p.share_ratio != null ? p.share_ratio : t.ratio)],
            ['Seeds', p.seeds != null ? p.seeds + ' connectés (' + Math.max(0, p.seeds_total) + ' au total)' : null],
            ['Pairs', p.peers != null ? p.peers + ' connectés (' + Math.max(0, p.peers_total) + ' au total)' : null],
            ['Connexions', p.nb_connections != null ? p.nb_connections + ' / ' + (p.nb_connections_limit > 0 ? p.nb_connections_limit : '∞') : null],
            ['Vitesse moyenne', p.dl_speed_avg != null ? '↓ ' + fmt.speed(p.dl_speed_avg) + '  ↑ ' + fmt.speed(p.up_speed_avg) : null],
            ['Temps actif', p.time_elapsed != null ? fmt.dur(p.time_elapsed) : null],
            ['Temps de seed', p.seeding_time > 0 ? fmt.dur(p.seeding_time) : null],
            ['Gaspillé', p.total_wasted > 0 ? fmt.bytes(p.total_wasted) : null],
            ['Vu complet', p.last_seen > 0 ? fmt.dateTime(p.last_seen) : p.last_seen != null ? 'Jamais' : null],
            ['Prochaine annonce', p.reannounce > 0 ? fmt.dur(p.reannounce) : null],
            ['Pièces', p.pieces_num > 0 ? p.pieces_have + ' / ' + p.pieces_num + ' × ' + fmt.bytes(p.piece_size) : null],
            ['Disponibilité', t.availability >= 0 ? t.availability.toFixed(2) : null]
          ]));
        }
        const priv = p.is_private != null ? p.is_private : p.isPrivate != null ? p.isPrivate : t.private;
        App.fill(info, App.kv([
          ['Taille', fmt.bytes(p.total_size > 0 ? p.total_size : t.size)],
          ['Ajouté le', fmt.dateTime(p.addition_date || t.added_on)],
          ['Terminé le', t.completion_on > 0 ? fmt.dateTime(t.completion_on) : null],
          ['Créé le', p.creation_date > 0 ? fmt.dateTime(p.creation_date) : null],
          ['Créé par', p.created_by || null],
          ['Dossier', p.save_path || t.save_path],
          ['Contenu', t.content_path || null],
          ['Catégorie', t.category || 'Aucune'],
          ['Étiquettes', t.tags || null],
          ['Tracker', t.tracker ? maskKey(t.tracker) : null],
          ['Privé', priv == null ? null : priv ? 'Oui' : 'Non'],
          ['Hash', p.infohash_v1 || hash],
          ['Hash v2', p.infohash_v2 || null],
          ['Commentaire', p.comment || null]
        ]));
      }
      function askShareLimits() {
        const t = Q.get(hash) || {};
        function limitField(label, val, unit, isFloat) {
          const mode = App.select([
            { value: '-2', label: 'Réglage global' },
            { value: '-1', label: 'Aucune limite' },
            { value: 'v', label: 'Personnalisée' }
          ], val == null || val === -2 ? '-2' : val === -1 ? '-1' : 'v');
          const inp = App.input({ type: 'number', inputmode: isFloat ? 'decimal' : 'numeric', step: isFloat ? '0.01' : '1', placeholder: unit, value: val >= 0 ? String(val) : '' });
          const inpBox = h('div', { style: { flex: '1', minWidth: '0' } }, inp);
          const upd = () => inpBox.classList.toggle('hidden', mode.value !== 'v');
          mode.addEventListener('change', upd);
          upd();
          return {
            el: App.field(label, h('div', { style: { display: 'flex', gap: '8px' } }, h('div', { style: { flex: '1', minWidth: '0' } }, mode), inpBox)),
            get() {
              if (mode.value !== 'v') return parseInt(mode.value, 10);
              const n = isFloat ? parseFloat(inp.value) : parseInt(inp.value, 10);
              return isFinite(n) && n >= 0 ? n : -2;
            }
          };
        }
        const ratio = limitField('Ratio', t.ratio_limit, 'ratio', true);
        const time = limitField('Durée de seed', t.seeding_time_limit, 'minutes', false);
        const inactive = limitField('Durée de seed inactif', t.inactive_seeding_time_limit, 'minutes', false);
        let s = null;
        s = App.sheet({
          title: 'Limites de partage',
          body: [ratio.el, time.el, inactive.el, h('p.hint', 'Une fois une limite atteinte, qBittorrent applique l’action définie dans ses préférences.')],
          actions: [
            App.btn('Annuler', { onClick: () => s.close() }),
            App.btn('Appliquer', {
              cls: 'pri',
              onClick: async () => {
                await qb.post('/torrents/setShareLimits', { hashes: hash, ratioLimit: ratio.get(), seedingTimeLimit: time.get(), inactiveSeedingTimeLimit: inactive.get() });
                s.close();
                App.toast('Limites de partage enregistrées', 'ok');
                Q.refresh();
              }
            })
          ]
        });
      }
      return {
        el: el,
        async refresh() {
          props = await qb.json('/torrents/properties', { query: { hash: hash } });
          renderKv();
        },
        fail(e) {
          if (!props) App.fill(transfer, App.note(e.message, 'err'));
        },
        render(t) {
          card.setAttribute('data-s', Q.stateKey(t));
          pctEl.textContent = fmt.pct(t.progress);
          stEl.textContent = Q.stateLabel(t);
          bar.set(t.progress);
          App.fill(meta,
            h('span', fmt.bytes(t.completed != null ? t.completed : t.size * t.progress) + ' / ' + fmt.bytes(t.size)),
            h('span.down', t.dlspeed > 0 ? '↓ ' + fmt.speed(t.dlspeed) : ''),
            h('span.upl', t.upspeed > 0 ? '↑ ' + fmt.speed(t.upspeed) : ''),
            h('span', t.progress < 1 && t.eta > 0 && t.eta < 8640000 ? 'reste ' + fmt.dur(t.eta) : ''),
            h('span', 'ratio ' + fmt.ratio(t.ratio)),
            h('span', t.num_seeds + ' seeds · ' + t.num_leechs + ' pairs')
          );
          const paused = Q.isPaused(t);
          if (paused !== pausedShown) {
            pausedShown = paused;
            App.fill(pauseAct, App.icon(paused ? 'play' : 'pause'), h('span', paused ? 'Reprendre' : 'Pause'));
          }
          opts.forEach((s) => {
            if (!pending[s.key] || Date.now() - pending[s.key] > 4000) s.input.checked = !!t[s.key];
          });
          limSub.textContent = '↓ ' + lim(t.dl_limit) + '  ·  ↑ ' + lim(t.up_limit);
          shareSub.textContent = 'Ratio : ' + shareTxt(t.ratio_limit, (v) => fmt.ratio(v)) + ' · Seed : ' + shareTxt(t.seeding_time_limit, (v) => fmt.dur(v * 60));
          renderKv();
        }
      };
    }

    // ----- Fichiers -----
    function buildFiles() {
      const el = h('div.section');
      const titleTxt = h('span', 'Fichiers');
      const rootEl = h('p.muted.wrap.hidden', { style: { margin: '-2px 4px 10px', fontSize: '12px' } });
      const status = h('div', App.loading());
      const grp = h('div.group.hidden');
      App.append(el, h('div.section-title', titleTxt, h('span.grow'), linkBtn('Tout…', allMenu)), rootEl, status, grp);
      const frows = new Map();
      let files = [];
      let root = '';
      let first = true;
      async function applyPrio(ids, p) {
        await qb.post('/torrents/filePrio', { hash: hash, id: ids.join('|'), priority: p });
        files.forEach((f) => {
          if (ids.indexOf(f.idx) >= 0) f.priority = p;
        });
        render();
        App.toast(ids.length > 1 ? 'Priorité modifiée pour ' + ids.length + ' fichiers' : 'Priorité : ' + prioName(p), 'ok');
      }
      function allMenu() {
        if (!files.length) return;
        const ids = files.map((f) => f.idx);
        App.menu({ title: 'Tous les fichiers', items: FILE_PRIOS.map((p) => ({ icon: p.icon, label: p.label, onClick: () => applyPrio(ids, p.value) })) });
      }
      async function renameFile(f) {
        const slash = f.name.lastIndexOf('/');
        const dir = f.name.slice(0, slash + 1);
        const base = f.name.slice(slash + 1);
        const v = await App.prompt({ title: 'Renommer le fichier', label: 'Nouveau nom', value: base });
        if (v == null || !v.trim() || v.trim() === base) return;
        await qb.post('/torrents/renameFile', { hash: hash, oldPath: f.name, newPath: dir + v.trim() });
        App.toast('Fichier renommé', 'ok');
        loop.kick();
      }
      function fileMenu(f) {
        App.menu({
          title: f.base,
          items: FILE_PRIOS.map((p) => ({ icon: p.icon, label: p.label, on: f.priority === p.value, onClick: () => applyPrio([f.idx], p.value) })).concat([
            '-',
            { icon: 'pencil-square', label: 'Renommer…', onClick: () => renameFile(f) },
            { icon: 'clipboard-document', label: 'Copier le chemin', onClick: () => App.copy(f.name, 'Chemin') }
          ])
        });
      }
      function makeRow() {
        const r = {};
        r.cb = h('input.cb', { type: 'checkbox', 'aria-label': 'Télécharger ce fichier' });
        r.cb.addEventListener('click', (e) => e.stopPropagation());
        r.cb.addEventListener('change', () => App.run(() => applyPrio([r.f.idx], r.cb.checked ? 1 : 0).catch((e) => {
          r.cb.checked = !r.cb.checked;
          throw e;
        })));
        r.dir = h('div.dir');
        r.fn = h('div.fn');
        r.bar = App.bar(0);
        r.meta = h('div.meta');
        r.el = h('div.file', r.cb, h('div.main', r.dir, r.fn, r.bar, r.meta));
        r.el.addEventListener('click', () => fileMenu(r.f));
        return r;
      }
      function render() {
        let total = 0;
        files.forEach((f) => {
          total += f.size;
          let r = frows.get(f.idx);
          if (!r) {
            r = makeRow();
            frows.set(f.idx, r);
            grp.appendChild(r.el);
          }
          r.f = f;
          const sig = [f.name, f.progress, f.priority].join('|');
          if (r.sig === sig) return;
          r.sig = sig;
          const short = f.name.slice(root.length);
          const slash = short.lastIndexOf('/');
          f.base = short.slice(slash + 1);
          r.dir.textContent = slash >= 0 ? short.slice(0, slash) : '';
          r.fn.textContent = f.base;
          r.bar.set(f.progress);
          r.el.style.opacity = f.priority === 0 ? '.55' : '';
          r.cb.checked = f.priority > 0;
          App.fill(r.meta, h('span', fmt.bytes(f.size)), h('span', fmt.pct(f.progress)), h('span', f.priority === 0 ? 'Ignoré' : 'Priorité ' + prioName(f.priority).toLowerCase()));
        });
        titleTxt.textContent = fmt.plural(files.length, 'fichier') + ' · ' + fmt.bytes(total);
      }
      return {
        el: el,
        async refresh() {
          const list = await qb.json('/torrents/files', { query: { hash: hash } });
          files = list.map((f, i) => ({ idx: f.index != null ? f.index : i, name: String(f.name || ''), size: f.size || 0, progress: f.progress || 0, priority: f.priority }));
          if (first) {
            first = false;
            files.sort((a, b) => Q.cmpName(a.name, b.name));
            const slash = files.length ? files[0].name.indexOf('/') : -1;
            const cand = slash > 0 ? files[0].name.slice(0, slash + 1) : '';
            root = cand && files.every((f) => f.name.indexOf(cand) === 0) ? cand : '';
            rootEl.textContent = root ? '📁 ' + root.slice(0, -1) : '';
            rootEl.classList.toggle('hidden', !root);
            App.clear(status);
            if (!files.length) App.fill(status, App.empty('document', 'Aucun fichier', 'Les métadonnées ne sont pas encore récupérées.'));
            grp.classList.toggle('hidden', !files.length);
          } else {
            const order = new Map(Array.from(frows.keys()).map((k, i) => [k, i]));
            files.sort((a, b) => (order.has(a.idx) ? order.get(a.idx) : 1e9) - (order.has(b.idx) ? order.get(b.idx) : 1e9));
          }
          render();
        },
        fail(e) {
          if (first) App.fill(status, App.note(e.message, 'err'));
        }
      };
    }

    // ----- Trackers -----
    function buildTrackers() {
      const el = h('div.section');
      const status = h('div', App.loading());
      const grp = h('div.group.hidden');
      App.append(el, App.secTitle('Trackers', linkBtn('Ajouter', addTrackers)), status, grp);
      let sig = '';
      async function addTrackers() {
        const v = await App.prompt({ title: 'Ajouter des trackers', label: 'URL d’annonce', multiline: true, placeholder: 'udp://tracker.exemple.org:1337/announce', hint: 'Une URL par ligne.' });
        const urls = String(v || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
        if (!urls.length) return;
        await qb.post('/torrents/addTrackers', { hash: hash, urls: urls.join('\n') });
        App.toast(fmt.plural(urls.length, 'tracker ajouté', 'trackers ajoutés'), 'ok');
        loop.kick();
      }
      function trackerMenu(tr) {
        App.menu({
          title: maskKey(tr.url),
          items: [
            { icon: 'clipboard-document', label: 'Copier l’URL', onClick: () => App.copy(tr.url, 'URL') },
            {
              icon: 'pencil-square',
              label: 'Modifier l’URL…',
              onClick: async () => {
                const v = await App.prompt({ title: 'Modifier le tracker', label: 'URL d’annonce', value: tr.url });
                if (v == null || !v.trim() || v.trim() === tr.url) return;
                await qb.post('/torrents/editTracker', { hash: hash, origUrl: tr.url, newUrl: v.trim() });
                App.toast('Tracker modifié', 'ok');
                loop.kick();
              }
            },
            {
              icon: 'trash',
              label: 'Retirer ce tracker',
              danger: true,
              onClick: async () => {
                if (!(await App.confirm({ title: 'Retirer ce tracker ?', message: maskKey(tr.url), ok: 'Retirer', danger: true }))) return;
                await qb.post('/torrents/removeTrackers', { hash: hash, urls: tr.url });
                App.toast('Tracker retiré', 'ok');
                loop.kick();
              }
            }
          ]
        });
      }
      function row(tr) {
        const pseudo = /^\*\*/.test(tr.url);
        const st = TR_STATUS[tr.status] || ['?', ''];
        const nums = [];
        if (tr.num_seeds >= 0) nums.push(tr.num_seeds + ' seeds');
        if (tr.num_leeches >= 0) nums.push(tr.num_leeches + ' leechers');
        if (tr.num_peers >= 0) nums.push(tr.num_peers + ' pairs');
        if (tr.num_downloaded >= 0) nums.push(tr.num_downloaded + ' complétés');
        const r = h('div.q-row',
          h('div.main',
            h('div', { style: { fontSize: '13px', fontWeight: '600', wordBreak: 'break-all' } }, pseudo ? tr.url.replace(/\*/g, '').trim() : maskKey(tr.url)),
            nums.length ? h('div.s', (pseudo ? '' : 'Tier ' + tr.tier + ' · ') + nums.join(' · ')) : null,
            tr.msg ? h('div.s.wrap', tr.msg) : null
          ),
          App.badge(st[0], st[1])
        );
        if (!pseudo) {
          r.style.cursor = 'pointer';
          r.addEventListener('click', () => trackerMenu(tr));
        }
        return r;
      }
      return {
        el: el,
        async refresh() {
          const list = await qb.json('/torrents/trackers', { query: { hash: hash } });
          App.clear(status);
          const s = JSON.stringify(list);
          if (s === sig) return;
          sig = s;
          grp.classList.toggle('hidden', !list.length);
          App.fill(grp, list.map(row));
        },
        fail(e) {
          if (!sig) App.fill(status, App.note(e.message, 'err'));
        }
      };
    }

    // ----- Pairs -----
    function buildPeers() {
      const el = h('div.section');
      const titleTxt = h('span', 'Pairs');
      const status = h('div', App.loading());
      const grp = h('div.group.hidden');
      App.append(el, h('div.section-title', titleTxt, h('span.grow'), linkBtn('Ajouter', addPeers)), status, grp);
      let rid = 0;
      let peers = {};
      let loaded = false;
      const prow = new Map();
      async function addPeers() {
        const v = await App.prompt({ title: 'Ajouter des pairs', label: 'Adresses', multiline: true, placeholder: '203.0.113.5:51413', hint: 'Une adresse IP:port par ligne.' });
        const list = String(v || '').split(/[\r\n,]+/).map((x) => x.trim()).filter(Boolean);
        if (!list.length) return;
        await qb.post('/torrents/addPeers', { hashes: hash, peers: list.join('|') });
        App.toast(fmt.plural(list.length, 'pair ajouté', 'pairs ajoutés'), 'ok');
        loop.kick();
      }
      function peerMenu(key, p) {
        App.menu({
          title: key,
          items: [
            { icon: 'clipboard-document', label: 'Copier l’adresse', onClick: () => App.copy(key, 'Adresse') },
            {
              icon: 'x-circle',
              label: 'Bannir ce pair',
              sub: 'Bannissement permanent dans qBittorrent',
              danger: true,
              onClick: async () => {
                if (!(await App.confirm({ title: 'Bannir ' + key + ' ?', message: (p.client || '') + ' sera bloqué pour tous les torrents.', ok: 'Bannir', danger: true }))) return;
                await qb.post('/transfer/banPeers', { peers: key });
                App.toast('Pair banni', 'ok');
                loop.kick();
              }
            }
          ]
        });
      }
      function render() {
        const keys = Object.keys(peers).sort((a, b) => {
          const x = peers[a];
          const y = peers[b];
          return (y.dl_speed + y.up_speed) - (x.dl_speed + x.up_speed) || y.progress - x.progress || (a < b ? -1 : 1);
        });
        titleTxt.textContent = keys.length ? fmt.plural(keys.length, 'pair connecté', 'pairs connectés') : 'Pairs';
        App.fill(status, keys.length ? null : App.empty('users', 'Aucun pair connecté', 'Les pairs apparaissent ici quand qBittorrent échange des données.'));
        grp.classList.toggle('hidden', !keys.length);
        prow.forEach((r, k) => {
          if (!peers[k]) {
            r.el.remove();
            prow.delete(k);
          }
        });
        const frag = document.createDocumentFragment();
        keys.forEach((k) => {
          const p = peers[k];
          let r = prow.get(k);
          if (!r) {
            r = { flag: h('span.peer-flag'), t: h('div.mono', { style: { fontSize: '12.5px', fontWeight: '600' } }), s: h('div.s'), sp: h('div', { style: { fontSize: '11.5px', textAlign: 'right', flex: 'none' } }) };
            r.el = h('div.q-row', { style: { cursor: 'pointer' } }, r.flag, h('div.main', r.t, r.s), r.sp);
            r.el.addEventListener('click', () => peerMenu(k, peers[k] || {}));
            prow.set(k, r);
          }
          r.flag.textContent = App.flag(p.country_code);
          r.flag.title = p.country || '';
          r.t.textContent = k;
          r.s.textContent = [p.client || p.peer_id_client || '?', fmt.pct(p.progress), p.connection, p.flags].filter(Boolean).join(' · ');
          App.fill(r.sp,
            p.dl_speed > 0 ? h('div', { style: { color: 'var(--pri)' } }, '↓ ' + fmt.speed(p.dl_speed)) : null,
            p.up_speed > 0 ? h('div', { style: { color: 'var(--blue)' } }, '↑ ' + fmt.speed(p.up_speed)) : null
          );
          frag.appendChild(r.el);
        });
        grp.appendChild(frag);
      }
      return {
        el: el,
        async refresh() {
          const d = await qb.json('/sync/torrentPeers', { query: { hash: hash, rid: rid } });
          if (d.full_update || !loaded) peers = {};
          loaded = true;
          rid = d.rid || 0;
          const ps = d.peers || {};
          for (const k in ps) peers[k] = Object.assign(peers[k] || {}, ps[k]);
          for (const k of d.peers_removed || []) delete peers[k];
          render();
        },
        fail(e) {
          if (!loaded) App.fill(status, App.note(e.message, 'err'));
        }
      };
    }

    // ----- Page menu -----
    function detailsMenu() {
      const t = Q.get(hash);
      if (!t) return;
      const clean = Q.cleanName(t.name);
      const prio = (which, msg) => async () => {
        await A.prio([hash], which);
        App.toast(msg, 'ok');
        Q.refresh();
      };
      const items = [
        {
          icon: 'pencil-square',
          label: 'Renommer…',
          onClick: async () => {
            const v = await App.prompt({ title: 'Renommer le torrent', label: 'Nom', value: t.name, selectAll: false });
            if (v == null || !v.trim() || v.trim() === t.name) return;
            await A.rename(hash, v.trim());
            App.toast('Torrent renommé', 'ok');
            Q.refresh();
          }
        },
        { icon: 'document-duplicate', label: 'Copier le nom', onClick: () => App.copy(t.name, 'Nom') },
        { icon: 'key', label: 'Copier le hash', onClick: () => App.copy(hash, 'Hash') },
        t.magnet_uri ? { icon: 'link', label: 'Copier le lien magnet', onClick: () => App.copy(t.magnet_uri, 'Lien magnet') } : null,
        '-',
        isC411(t) ? { icon: 'globe-alt', label: 'Voir la fiche sur C411', onClick: () => App.openC411('https://c411.org/torrents/' + hash) } : null,
        { icon: 'magnifying-glass', label: 'Rechercher sur C411', sub: clean, onClick: () => App.c411Search(clean) }
      ];
      const cats = { sonarr: App.config.sonarrCategory, lidarr: App.config.lidarrCategory || 'lidarr' };
      const first = Object.keys(cats).find((k) => t.category && t.category === cats[k]);
      const pref = first ? [first].concat(['radarr', 'sonarr', 'lidarr'].filter((k) => k !== first)) : ['radarr', 'sonarr', 'lidarr'];
      pref.forEach((svc) => {
        const ui = App.arrUI && App.arrUI[svc];
        if (!ui || !App.arr(svc).configured) return;
        items.push({
          icon: svc === 'radarr' ? 'film' : svc === 'lidarr' ? 'musical-note' : 'tv',
          label: 'Importer dans ' + App.arrName(svc) + '…',
          sub: 'Import manuel des fichiers téléchargés',
          onClick: () => ui.openManualImport({ downloadId: hash.toUpperCase(), title: t.name, folder: t.content_path || t.save_path })
        });
      });
      items.push('-', {
        icon: 'queue-list',
        label: 'File d’attente…',
        onClick: () => App.menu({
          title: 'File d’attente',
          items: [
            { icon: 'arrow-up-tray', label: 'Tout en haut', onClick: prio('topPrio', 'Placé en haut de la file') },
            { icon: 'arrow-up', label: 'Monter d’un cran', onClick: prio('increasePrio', 'Priorité augmentée') },
            { icon: 'arrow-down', label: 'Descendre d’un cran', onClick: prio('decreasePrio', 'Priorité diminuée') },
            { icon: 'arrow-down-tray', label: 'Tout en bas', onClick: prio('bottomPrio', 'Placé en bas de la file') }
          ]
        })
      }, { icon: 'trash', label: 'Supprimer…', danger: true, onClick: () => Q.askDelete([hash], () => App.pop('qbit')) });
      App.menu({ title: t.name, items: items });
    }
  };

  // ---------- Categories & tags ----------
  Q.openCategories = function () {
    const page = App.page({ title: 'Catégories et étiquettes', back: true });
    const scroll = h('div.scroll', App.loading());
    page.el.appendChild(scroll);
    let sig = '';
    function catMenu(c) {
      const cat = Q.store.categories[c] || {};
      App.menu({
        title: c,
        items: [
          { icon: 'funnel', label: 'Afficher ses torrents', onClick: () => Q.setFilter({ cat: c, tag: null }) },
          {
            icon: 'folder-open',
            label: 'Modifier le dossier…',
            sub: cat.savePath || 'Dossier par défaut',
            onClick: async () => {
              const v = await App.prompt({ title: 'Dossier de « ' + c + ' »', label: 'Dossier de destination', value: cat.savePath || '', hint: 'Vide = dossier par défaut de qBittorrent.' });
              if (v == null) return;
              await qb.post('/torrents/editCategory', { category: c, savePath: v.trim() });
              App.toast('Catégorie modifiée', 'ok');
              Q.refresh();
            }
          },
          App.isAdmin ? {
            icon: 'star',
            label: 'Catégorie par défaut de l’app',
            sub: App.config.defaultCategory === c ? 'C’est déjà la catégorie par défaut' : 'Présélectionnée lors des envois',
            disabled: App.config.defaultCategory === c,
            onClick: () => {
              App.saveCfg({ defaultCategory: c });
              App.toast('« ' + c + ' » est la catégorie par défaut', 'ok');
            }
          } : null,
          '-',
          {
            icon: 'trash',
            label: 'Supprimer la catégorie',
            danger: true,
            onClick: async () => {
              const ok = await App.confirm({ title: 'Supprimer « ' + c + ' » ?', message: 'Les torrents ne sont pas supprimés : ils n’auront simplement plus de catégorie.', ok: 'Supprimer', danger: true });
              if (!ok) return;
              await qb.post('/torrents/removeCategories', { categories: c });
              App.toast('Catégorie supprimée', 'ok');
              Q.refresh();
            }
          }
        ]
      });
    }
    function tagMenu(g) {
      App.menu({
        title: g,
        items: [
          { icon: 'funnel', label: 'Afficher ses torrents', onClick: () => Q.setFilter({ tag: g, cat: null }) },
          '-',
          {
            icon: 'trash',
            label: 'Supprimer l’étiquette',
            danger: true,
            onClick: async () => {
              if (!(await App.confirm({ title: 'Supprimer l’étiquette « ' + g + ' » ?', message: 'Elle sera retirée de tous les torrents.', ok: 'Supprimer', danger: true }))) return;
              await qb.post('/torrents/deleteTags', { tags: g });
              App.toast('Étiquette supprimée', 'ok');
              Q.refresh();
            }
          }
        ]
      });
    }
    async function newTag() {
      const v = await App.prompt({ title: 'Nouvelle étiquette', label: 'Nom', hint: 'Plusieurs étiquettes possibles, séparées par des virgules.' });
      const tags = String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
      if (!tags.length) return;
      await qb.post('/torrents/createTags', { tags: tags.join(',') });
      App.toast(tags.length > 1 ? 'Étiquettes créées' : 'Étiquette créée', 'ok');
      Q.refresh();
    }
    function render() {
      const s = Q.store;
      if (!s.loaded) {
        if (s.error && sig !== 'err') {
          sig = 'err';
          App.fill(scroll, App.empty('exclamation-triangle', 'qBittorrent indisponible', s.error.message));
        }
        return;
      }
      const counts = {};
      const tagCounts = {};
      Object.values(s.torrents).forEach((t) => {
        counts[t.category || ''] = (counts[t.category || ''] || 0) + 1;
        Q.tagList(t).forEach((g) => {
          tagCounts[g] = (tagCounts[g] || 0) + 1;
        });
      });
      const cats = Q.categoryNames();
      const tags = s.tags.slice().sort(Q.cmpName);
      const nsig = JSON.stringify([cats.map((c) => [c, s.categories[c].savePath, counts[c]]), tags.map((g) => [g, tagCounts[g]]), App.config.defaultCategory]);
      if (nsig === sig) return;
      sig = nsig;
      App.fill(scroll,
        App.secTitle('Catégories', linkBtn('+ Nouvelle', () => Q.askNewCategory())),
        cats.length
          ? h('div.group', cats.map((c) => h('button.item', { type: 'button', onclick: () => catMenu(c) },
            App.icon(App.config.defaultCategory === c ? 'star' : 'folder'),
            h('div.main', h('div.t', c), h('div.s', s.categories[c].savePath || 'Dossier par défaut')),
            h('span.r', String(counts[c] || 0)),
            App.icon('chevron-right', 'sm'))))
          : h('p.muted', 'Aucune catégorie. Crées-en une pour ranger tes téléchargements (films, séries, anime…).'),
        counts[''] ? h('p.hint', { style: { margin: '-2px 4px 0' } }, fmt.plural(counts[''], 'torrent') + ' sans catégorie') : null,
        App.secTitle('Étiquettes', linkBtn('+ Nouvelle', newTag)),
        tags.length
          ? h('div.group', tags.map((g) => h('button.item', { type: 'button', onclick: () => tagMenu(g) },
            App.icon('tag'), h('div.main', h('div.t', g)), h('span.r', String(tagCounts[g] || 0)), App.icon('chevron-right', 'sm'))))
          : h('p.muted', 'Aucune étiquette.')
      );
    }
    const off = App.on('qbit', render);
    const offCfg = App.on('config', (p) => {
      if ('defaultCategory' in p) render();
    });
    page.onDestroy = () => {
      off();
      offCfg();
    };
    App.push('qbit', page);
    render();
    Q.refresh();
  };

  // ---------- Server preferences ----------
  const PREF_GROUPS = [
    ['Téléchargements', [
      ['save_path', 'Dossier par défaut', 'text'],
      ['temp_path_enabled', 'Dossier séparé pour les téléchargements en cours', 'bool'],
      ['temp_path', 'Dossier des téléchargements en cours', 'text', { dep: 'temp_path_enabled' }],
      ['auto_tmm_enabled', 'Gestion automatique par défaut', 'bool', { sub: 'Le dossier de destination suit la catégorie' }],
      ['torrent_content_layout', 'Disposition du contenu', 'select', { options: [['Original', 'Original'], ['Subfolder', 'Créer un sous-dossier'], ['NoSubfolder', 'Ne pas créer de sous-dossier']] }],
      ['add_stopped_enabled', 'Ajouter les torrents en pause', 'bool'],
      ['start_paused_enabled', 'Ajouter les torrents en pause', 'bool', { unless: 'add_stopped_enabled' }],
      ['preallocate_all', 'Pré-allouer l’espace disque', 'bool'],
      ['incomplete_files_ext', 'Extension .!qB pour les fichiers incomplets', 'bool']
    ]],
    ['Vitesse', [
      ['dl_limit', 'Limite de téléchargement (Ko/s)', 'speed'],
      ['up_limit', 'Limite d’envoi (Ko/s)', 'speed'],
      ['alt_dl_limit', 'Limite alternative de téléchargement (Ko/s)', 'speed'],
      ['alt_up_limit', 'Limite alternative d’envoi (Ko/s)', 'speed'],
      ['scheduler_enabled', 'Planifier la vitesse alternative', 'bool'],
      ['schedule_from_hour', 'Début de la plage (heure)', 'int', { dep: 'scheduler_enabled' }],
      ['schedule_to_hour', 'Fin de la plage (heure)', 'int', { dep: 'scheduler_enabled' }],
      ['limit_lan_peers', 'Appliquer les limites au réseau local', 'bool'],
      ['limit_utp_rate', 'Appliquer les limites au protocole µTP', 'bool'],
      ['limit_tcp_overhead', 'Inclure le surdébit de transport', 'bool']
    ]],
    ['File d’attente', [
      ['queueing_enabled', 'Activer la file d’attente', 'bool'],
      ['max_active_downloads', 'Téléchargements actifs maximum', 'int', { dep: 'queueing_enabled' }],
      ['max_active_uploads', 'Envois actifs maximum', 'int', { dep: 'queueing_enabled' }],
      ['max_active_torrents', 'Torrents actifs maximum', 'int', { dep: 'queueing_enabled' }],
      ['dont_count_slow_torrents', 'Ne pas compter les torrents lents', 'bool', { dep: 'queueing_enabled' }]
    ]],
    ['Limites de partage', [
      ['max_ratio_enabled', 'Limiter le ratio', 'bool'],
      ['max_ratio', 'Ratio maximum', 'float', { dep: 'max_ratio_enabled' }],
      ['max_seeding_time_enabled', 'Limiter la durée de seed', 'bool'],
      ['max_seeding_time', 'Durée de seed maximum (minutes)', 'int', { dep: 'max_seeding_time_enabled' }],
      ['max_inactive_seeding_time_enabled', 'Limiter la durée de seed inactif', 'bool'],
      ['max_inactive_seeding_time', 'Durée d’inactivité maximum (minutes)', 'int', { dep: 'max_inactive_seeding_time_enabled' }],
      ['max_ratio_act', 'Action quand la limite est atteinte', 'select', { options: [[0, 'Mettre en pause'], [1, 'Supprimer le torrent'], [3, 'Supprimer le torrent et ses fichiers'], [2, 'Activer le super seed']] }]
    ]],
    ['Connexion', [
      ['listen_port', 'Port d’écoute', 'int'],
      ['upnp', 'UPnP / NAT-PMP', 'bool', { sub: 'Redirection automatique du port sur le routeur' }],
      ['max_connec', 'Connexions maximum', 'int'],
      ['max_connec_per_torrent', 'Connexions maximum par torrent', 'int'],
      ['max_uploads', 'Slots d’envoi maximum', 'int'],
      ['max_uploads_per_torrent', 'Slots d’envoi maximum par torrent', 'int']
    ]],
    ['BitTorrent', [
      ['dht', 'DHT', 'bool', { sub: 'Toujours désactivé pour les torrents privés comme C411' }],
      ['pex', 'Échange de pairs (PeX)', 'bool'],
      ['lsd', 'Découverte de pairs locaux', 'bool'],
      ['encryption', 'Chiffrement', 'select', { options: [[0, 'Autoriser'], [1, 'Exiger'], [2, 'Désactiver']] }],
      ['anonymous_mode', 'Mode anonyme', 'bool'],
      ['add_trackers_enabled', 'Ajouter automatiquement des trackers', 'bool'],
      ['add_trackers', 'Trackers ajoutés', 'textarea', { dep: 'add_trackers_enabled' }]
    ]]
  ];

  Q.openPrefs = function () {
    const page = App.page({ title: 'Préférences qBittorrent', subtitle: 'Réglages du serveur', back: true });
    const scroll = h('div.scroll', App.loading());
    const bottom = h('div.bottom-bar.hidden', App.btn('Enregistrer', { cls: 'pri block', icon: 'check', onClick: save }));
    App.append(page.el, scroll, bottom);
    let orig = null;
    let fields = [];
    function makeField(k, label, type, o) {
      const v = orig[k];
      const f = { key: k, type: type, dep: o.dep };
      if (type === 'bool') {
        f.el = App.switchEl(label, !!v, () => updDeps(), o.sub);
        f.get = () => f.el.input.checked;
        return f;
      }
      let inp;
      if (type === 'select') {
        const opts = o.options.map((x) => ({ value: x[0], label: x[1] }));
        if (!opts.some((x) => String(x.value) === String(v))) opts.push({ value: v, label: String(v) });
        inp = App.select(opts, v);
        f.get = () => (typeof v === 'number' ? parseInt(inp.value, 10) : inp.value);
      } else if (type === 'textarea') {
        inp = h('textarea.input', { autocapitalize: 'off', spellcheck: 'false', value: v == null ? '' : String(v) });
        f.get = () => inp.value;
      } else if (type === 'speed') {
        inp = App.input({ type: 'number', inputmode: 'numeric', placeholder: 'Illimitée', value: v > 0 ? String(Math.round(v / 1024)) : '' });
        const initial = v > 0 ? Math.round(v / 1024) : 0;
        f.get = () => {
          const n = Math.max(0, parseInt(inp.value, 10) || 0);
          return n === initial ? v : n * 1024;
        };
      } else if (type === 'int' || type === 'float') {
        inp = App.input({ type: 'number', inputmode: type === 'int' ? 'numeric' : 'decimal', step: type === 'int' ? '1' : '0.01', value: v == null ? '' : String(v) });
        f.get = () => {
          const n = type === 'int' ? parseInt(inp.value, 10) : parseFloat(inp.value);
          return isFinite(n) ? n : v;
        };
      } else {
        inp = App.input({ value: v == null ? '' : String(v) });
        f.get = () => inp.value.trim();
      }
      f.el = App.field(label, inp, o.hint);
      return f;
    }
    function updDeps() {
      const byKey = {};
      fields.forEach((f) => {
        byKey[f.key] = f;
      });
      fields.forEach((f) => {
        if (f.dep && byKey[f.dep]) f.el.classList.toggle('hidden', !byKey[f.dep].get());
      });
    }
    function render() {
      fields = [];
      const out = [App.note('Ces réglages modifient directement ton serveur qBittorrent. Seules les options reconnues par ta version sont affichées.')];
      for (const g of PREF_GROUPS) {
        const items = g[1].filter((x) => x[0] in orig && !(x[3] && x[3].unless && x[3].unless in orig));
        if (!items.length) continue;
        const card = h('div.card', { style: { paddingBottom: '4px' } });
        for (const x of items) {
          const f = makeField(x[0], x[1], x[2], x[3] || {});
          fields.push(f);
          card.appendChild(f.el);
        }
        out.push(App.secTitle(g[0]), card);
      }
      App.fill(scroll, out);
      updDeps();
      bottom.classList.remove('hidden');
    }
    async function load() {
      App.fill(scroll, App.loading());
      try {
        orig = await qb.json('/app/preferences');
      } catch (e) {
        App.fill(scroll, App.empty('exclamation-triangle', 'Préférences indisponibles', e.message, [App.btn('Réessayer', { icon: 'arrow-path', onClick: load })]));
        return;
      }
      render();
    }
    async function save() {
      if (!orig) return;
      const changed = {};
      fields.forEach((f) => {
        const v = f.get();
        if (v !== orig[f.key] && !(v === '' && orig[f.key] == null)) changed[f.key] = v;
      });
      const keys = Object.keys(changed);
      if (!keys.length) {
        App.toast('Aucune modification');
        return;
      }
      await qb.post('/app/setPreferences', { json: JSON.stringify(changed) });
      Object.assign(orig, changed);
      App.toast(fmt.plural(keys.length, 'réglage enregistré', 'réglages enregistrés'), 'ok');
      Q.refresh();
    }
    App.push('qbit', page);
    load();
  };

  // ---------- Log ----------
  const LOG_TYPES = { 1: ['normal', ''], 2: ['info', 'info'], 4: ['alerte', 'warn'], 8: ['critique', 'error'] };
  Q.openLog = function () {
    const page = App.page({ title: 'Journal qBittorrent', back: true });
    const listEl = h('div.group');
    const status = h('div', App.loading());
    const scroll = h('div.scroll', status, listEl);
    let level = 'all';
    let entries = [];
    let chunk = null;
    const seg = App.seg([
      { value: 'all', label: 'Tout' },
      { value: 'warn', label: 'Alertes' },
      { value: 'err', label: 'Critiques' }
    ], 'all', (v) => {
      level = v;
      render();
    });
    App.append(page.actions, App.iconBtn('arrow-path', 'Actualiser', () => load()));
    App.append(page.el, seg, scroll);
    function render() {
      if (chunk) chunk.dispose();
      App.clear(listEl);
      const min = level === 'err' ? 8 : level === 'warn' ? 4 : 0;
      const list = entries.filter((e) => e.type >= min);
      listEl.classList.toggle('hidden', !list.length);
      App.fill(status, list.length ? null : App.empty('document-text', 'Journal vide', level === 'all' ? 'Aucun message.' : 'Aucun message de ce niveau.'));
      chunk = App.chunked(listEl, list, (e) => {
        const ty = LOG_TYPES[e.type] || ['?', ''];
        return h('div.log', h('div', h('span.lv' + (ty[1] ? '.' + ty[1] : ''), ty[0]), h('span.dim', fmt.dateTime(e.timestamp))), h('div.msg.sel', e.message));
      }, 80, scroll);
    }
    async function load() {
      try {
        const list = await qb.json('/log/main', { query: { normal: true, info: true, warning: true, critical: true, last_known_id: -1 } });
        entries = list.slice(-500).reverse();
        render();
      } catch (e) {
        App.fill(status, App.empty('exclamation-triangle', 'Journal indisponible', e.message, [App.btn('Réessayer', { icon: 'arrow-path', onClick: load })]));
      }
    }
    page.onDestroy = () => chunk && chunk.dispose();
    App.push('qbit', page);
    load();
  };
})();
