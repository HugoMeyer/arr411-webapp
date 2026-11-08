/* Arr411 Web settings: account, preferences and, for administrators, service connections, shared defaults and users. */
(function () {
  'use strict';
  const App = window.App;
  const h = App.h;
  const TAB = 'settings';
  const S = (App.settings = { anchors: {} });
  const cfg = () => App.config;
  const trimSlash = (s) => String(s || '').trim().replace(/[\\/]+$/, '');
  const NAMES = { qb: 'qBittorrent', radarr: 'Radarr', sonarr: 'Sonarr', lidarr: 'Lidarr' };
  const refreshers = [];
  const loaders = [];
  let page = null;
  let scroll = null;
  let pendingAnchor = null;
  // Connections as the server describes them (addresses and "secret stored" flags, never the secrets themselves).
  let conns = {};

  // Without a scheme: http for container names, LAN addresses and *.local hosts, https for anything else.
  function fixUrl(u) {
    u = String(u || '').trim().replace(/\/+$/, '');
    if (!u || /^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return u;
    const host = u.split(/[/?#]/)[0].replace(/:\d+$/, '');
    const lan = !host.includes('.') || /^(10|127)\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host) || /\.(local|lan|internal|home|localdomain)$/i.test(host);
    return (lan ? 'http://' : 'https://') + u;
  }

  // Rebuilds a <select>. A saved value missing from the options stays visible (missing(v) gives its label).
  function fillSel(sel, opts, value, emptyLabel, missing) {
    const v = value == null ? '' : String(value);
    const list = (emptyLabel != null ? [{ value: '', label: emptyLabel }] : []).concat(opts);
    if (v && !list.some((o) => String(o.value) === v)) list.push({ value: v, label: missing ? missing(v) : v + ' (enregistrée)' });
    App.clear(sel);
    for (const o of list) sel.appendChild(h('option', { value: String(o.value) }, o.label));
    sel.value = v;
    if (sel.selectedIndex < 0 && sel.options.length) sel.selectedIndex = 0;
  }

  function secret(placeholder, autocomplete) {
    const inp = App.input({ type: 'password', placeholder: placeholder || '', autocomplete: autocomplete || 'new-password' });
    const eye = App.iconBtn('eye', 'Afficher', () => {
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      App.fill(eye, App.icon(show ? 'eye-slash' : 'eye'));
    });
    const row = h('div.pw', inp, eye);
    row.input = inp;
    return row;
  }
  const okNote = (t) => App.note(t, 'ok', 'check-circle');
  const waitNote = (t) => App.note(t || 'Connexion…', 'wait', 'arrow-path');
  const errNote = (e) => App.note((e && e.message) || String(e), 'err');
  function card(key, ic, title) {
    const kids = Array.prototype.slice.call(arguments, 3);
    const el = h('div.card', h('div.card-t', App.icon(ic), h('span', title)), kids);
    if (key) S.anchors[key] = el;
    return el;
  }
  function onEnter(inputs, fn) {
    for (const el of inputs) {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') App.run(fn);
      });
    }
  }
  // Marks a card as edited so a refresh from the server never overwrites what is being typed.
  function tracker(inputs) {
    const t = { dirty: false };
    for (const el of inputs) {
      el.addEventListener('input', () => {
        t.dirty = true;
      });
    }
    return t;
  }
  function refreshAll() {
    for (const r of refreshers) {
      try {
        r();
      } catch (e) {
        console.error(e);
      }
    }
  }

  // ---------- Account ----------
  function clearLocal() {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.indexOf('arr411.') === 0) localStorage.removeItem(k);
      }
    } catch (e) { /* storage unavailable */ }
  }
  async function logout() {
    await App.api('POST', '/api/auth/logout');
    clearLocal();
    location.replace('/login');
  }
  function passwordSheet() {
    const cur = secret('Mot de passe actuel', 'current-password');
    const next = secret('8 caractères minimum');
    const again = secret('Confirme le nouveau mot de passe');
    const status = h('div');
    let s = null;
    async function submit() {
      if (!cur.input.value) return App.fill(status, App.note('Saisis ton mot de passe actuel.', 'warn'));
      if (next.input.value.length < 8) return App.fill(status, App.note('Le nouveau mot de passe doit faire au moins 8 caractères.', 'warn'));
      if (next.input.value !== again.input.value) return App.fill(status, App.note('Les deux mots de passe ne correspondent pas.', 'warn'));
      App.fill(status, waitNote('Enregistrement…'));
      try {
        await App.api('POST', '/api/auth/password', { current: cur.input.value, password: next.input.value });
      } catch (e) {
        return App.fill(status, errNote(e));
      }
      s.close();
      App.toast('Mot de passe modifié : tes autres appareils sont déconnectés', 'ok');
    }
    s = App.sheet({
      title: 'Changer le mot de passe',
      body: [App.field('Mot de passe actuel', cur), App.field('Nouveau mot de passe', next), App.field('Confirmation', again), status],
      actions: [App.btn('Annuler', { onClick: () => s.close() }), App.btn('Enregistrer', { cls: 'pri', onClick: submit })]
    });
    onEnter([cur.input, next.input, again.input], submit);
    setTimeout(() => cur.input.focus(), 260);
  }
  function accountCard() {
    const u = App.user || {};
    return card('account', 'user', 'Compte',
      App.kv([['Utilisateur', u.username], ['Rôle', u.role === 'admin' ? 'Administrateur' : 'Utilisateur']]),
      h('div.set-sep'),
      h('div.btn-row',
        App.btn('Changer le mot de passe', { icon: 'key', onClick: passwordSheet }),
        App.btn('Se déconnecter', { cls: 'danger', icon: 'arrow-left-on-rectangle', onClick: logout }))
    );
  }

  // ---------- Preferences ----------
  function prefsCard() {
    const start = App.select([
      { value: 'c411', label: 'C411' },
      { value: 'radarr', label: 'Radarr' },
      { value: 'sonarr', label: 'Sonarr' },
      { value: 'lidarr', label: 'Lidarr' },
      { value: 'qbit', label: 'qBittorrent' },
      { value: 'last', label: 'Dernier onglet utilisé' }
    ], cfg().startTab || 'qbit');
    start.addEventListener('change', () => App.saveCfg({ startTab: start.value }));
    refreshers.push(() => {
      start.value = cfg().startTab || 'qbit';
    });
    return card('prefs', 'cog-6-tooth', 'Préférences', App.field('Onglet à l’ouverture', start, 'Réglage personnel : il ne concerne que ton compte.'));
  }

  // ---------- Services seen by a regular user ----------
  function servicesCard() {
    const box = h('div');
    const render = () => {
      App.fill(box, App.kv(Object.keys(NAMES).map((svc) => {
        const ok = svc === 'qb' ? App.qb.configured() : App.arr(svc).configured;
        return [NAMES[svc], ok ? 'Configuré' : 'Non configuré'];
      })));
    };
    refreshers.push(render);
    render();
    return card('services', 'server-stack', 'Services', App.note('Les connexions à qBittorrent, Radarr, Sonarr et Lidarr sont gérées par l’administrateur.'), box);
  }

  // ---------- qBittorrent categories (shared by several selects) ----------
  const catSels = [];
  let catSig = null;
  function catSelect(key) {
    const sel = App.select([{ value: '', label: 'Aucune' }], '');
    sel.addEventListener('change', () => App.saveCfg({ [key]: sel.value }));
    catSels.push({ sel: sel, key: key });
    return sel;
  }
  function fillCats() {
    const names = App.qbit && App.qbit.store.loaded ? App.qbit.categoryNames() : [];
    const sig = names.join('\n') + '|' + catSels.map((c) => cfg()[c.key] || '').join('\n');
    if (sig === catSig) return;
    catSig = sig;
    const opts = names.map((n) => ({ value: n, label: n }));
    for (const c of catSels) fillSel(c.sel, opts, cfg()[c.key] || '', 'Aucune');
  }
  function loadCats() {
    fillCats();
    if (App.qbit && App.qb.configured()) App.qbit.ensure(8000).then(fillCats, () => {});
  }
  App.on('qbit', () => {
    if (page) fillCats();
  });

  // ---------- Saving a connection ----------
  // Stores the connection on the server, reloads the shared config, then runs the service-specific test.
  async function saveConn(svc, body, status, onSaved, test) {
    App.fill(status, waitNote('Enregistrement…'));
    try {
      const res = await App.api('PUT', '/api/admin/connections/' + svc, body);
      conns[svc] = res.connection;
      await App.loadConfig();
    } catch (e) {
      return App.fill(status, errNote(e));
    }
    onSaved();
    if (!body.url) {
      loadCats();
      return App.fill(status, App.note('Connexion supprimée.'));
    }
    App.fill(status, waitNote());
    try {
      await test();
    } catch (e) {
      App.fill(status, App.note('Enregistré, mais : ' + ((e && e.message) || String(e)), 'err'));
    }
  }
  async function disconnect(svc, status, onSaved) {
    const ok = await App.confirm({
      title: 'Déconnecter ' + NAMES[svc] + ' ?',
      message: 'L’adresse et les identifiants enregistrés seront supprimés pour tous les utilisateurs.',
      ok: 'Déconnecter',
      danger: true
    });
    if (ok) await saveConn(svc, { url: '' }, status, onSaved, null);
  }

  // ---------- qBittorrent ----------
  function qbitCard() {
    const url = App.input({ type: 'url', inputmode: 'url', placeholder: 'http://qbittorrent:8080' });
    const user = App.input({ placeholder: 'admin' });
    const pass = secret('Mot de passe');
    const clear = App.checkRow('Effacer le mot de passe enregistré', false);
    const pub = App.input({ type: 'url', inputmode: 'url', placeholder: 'https://qbittorrent.exemple.fr' });
    const status = h('div');
    const T = tracker([url, user, pass.input, clear.input, pub]);
    const rm = App.btn('Déconnecter', { cls: 'danger', icon: 'trash', onClick: () => disconnect('qb', status, fill) });
    function fill() {
      const c = conns.qb || {};
      url.value = c.url || '';
      user.value = c.username || '';
      pass.input.value = '';
      pass.input.placeholder = c.hasPassword ? '•••••••• (enregistré)' : 'Mot de passe';
      clear.input.checked = false;
      clear.classList.toggle('hidden', !c.hasPassword);
      pub.value = c.publicUrl || '';
      rm.classList.toggle('hidden', !c.url);
      T.dirty = false;
    }
    refreshers.push(() => {
      if (!T.dirty) fill();
    });
    async function test() {
      await App.qb.login();
      const v = String(await App.qb.call('/app/version', { noRetry: true })).trim();
      App.fill(status, okNote('Connecté à qBittorrent ' + v + '.'));
      if (App.qbit) App.qbit.refresh();
      loadCats();
    }
    function save() {
      const body = { url: fixUrl(url.value), username: user.value.trim(), publicUrl: fixUrl(pub.value) };
      if (pass.input.value) body.password = pass.input.value;
      else if (clear.input.checked) body.clearPassword = true;
      return saveConn('qb', body, status, fill, test);
    }
    onEnter([url, user, pass.input, pub], save);
    fill();
    return card('qbit', 'arrow-down-tray', 'qBittorrent',
      App.field('Adresse (URL)', url, 'Adresse jointe par le serveur Arr411, pas par ton navigateur. Dans Docker : le nom du conteneur (http://qbittorrent:8080) ou l’adresse de la machine.'),
      App.field('Utilisateur', user, 'Laisse vide si l’authentification est désactivée.'),
      App.field('Mot de passe', pass),
      clear,
      App.field('Adresse publique (facultatif)', pub, 'Adresse que ton navigateur peut ouvrir : elle sert au lien « Ouvrir l’interface web ».'),
      status,
      h('div.btn-row', App.btn('Enregistrer et tester', { cls: 'pri', icon: 'check', onClick: save }), rm),
      h('div.set-sep'),
      App.field('Catégorie par défaut', catSelect('defaultCategory'), 'Pré-sélectionnée quand quelqu’un ajoute un torrent (lien magnet, fichier .torrent…).')
    );
  }

  // ---------- Radarr / Sonarr / Lidarr ----------
  function arrCard(svc) {
    const isR = svc === 'radarr';
    const isL = svc === 'lidarr';
    const name = App.arrName(svc);
    const url = App.input({ type: 'url', inputmode: 'url', placeholder: 'http://' + svc + ':' + (isR ? '7878' : isL ? '8686' : '8989') });
    const key = secret('32 caractères');
    const pub = App.input({ type: 'url', inputmode: 'url', placeholder: 'https://' + svc + '.exemple.fr' });
    const status = h('div');
    const T = tracker([url, key.input, pub]);
    const rm = App.btn('Déconnecter', { cls: 'danger', icon: 'trash', onClick: () => disconnect(svc, status, fill) });
    function fill() {
      const c = conns[svc] || {};
      url.value = c.url || '';
      key.input.value = '';
      key.input.placeholder = c.hasKey ? '•••••••• (enregistrée)' : '32 caractères';
      pub.value = c.publicUrl || '';
      rm.classList.toggle('hidden', !c.url);
      T.dirty = false;
    }
    refreshers.push(() => {
      if (!T.dirty) fill();
    });
    const profSel = App.select([], '');
    const rootSel = App.select([], '');
    const metaSel = isL ? App.select([], '') : null;
    const rootNote = h('div');
    profSel.addEventListener('change', () => App.saveCfg({ [svc + 'Profile']: profSel.value }));
    rootSel.addEventListener('change', () => App.saveCfg({ [svc + 'Root']: rootSel.value }));
    if (metaSel) metaSel.addEventListener('change', () => App.saveCfg({ lidarrMetaProfile: metaSel.value }));
    let loadedSig = null;
    function idle(msg) {
      for (const s of [profSel, rootSel, metaSel]) {
        if (!s) continue;
        fillSel(s, [], '', msg);
        s.disabled = true;
      }
    }
    async function loadLists(force) {
      const api = App.arr(svc);
      if (!api.configured) {
        loadedSig = null;
        App.clear(rootNote);
        return idle('Configure ' + name + ' d’abord');
      }
      const sig = api.base + '|' + api.key;
      if (sig === loadedSig && !force) return;
      loadedSig = sig;
      idle('Chargement…');
      let m;
      try {
        const M = App.arrUI && App.arrUI[svc];
        m = M ? await M.meta(true) : {
          profiles: await api.get('/qualityprofile'),
          roots: await api.get('/rootfolder'),
          metaProfiles: isL ? await api.get('/metadataprofile') : null
        };
      } catch (e) {
        if (loadedSig === sig) {
          loadedSig = null;
          idle('Liste indisponible');
        }
        throw e;
      }
      if (loadedSig !== sig) return;
      const P = Array.isArray(m.profiles) ? m.profiles : [];
      const R = Array.isArray(m.roots) ? m.roots : [];
      const c = cfg();
      const patch = {};
      let prof = String(c[svc + 'Profile'] || '');
      if (!prof && P.length) prof = patch[svc + 'Profile'] = String(P[0].id);
      const saved = String(c[svc + 'Root'] || '');
      const match = R.find((r) => trimSlash(r.path) === trimSlash(saved));
      let root = match ? match.path : saved;
      if (!root && R.length) root = patch[svc + 'Root'] = R[0].path;
      // Lidarr: "None" only lists hand-added albums, so the default goes to the first real profile.
      const MP = isL && Array.isArray(m.metaProfiles) ? m.metaProfiles : [];
      const isNone = (p) => /^none$/i.test(p.name || '');
      let meta = isL ? String(c.lidarrMetaProfile || '') : '';
      if (isL && !meta && MP.length) meta = patch.lidarrMetaProfile = String((MP.find((p) => !isNone(p)) || MP[0]).id);
      if (Object.keys(patch).length) App.saveCfg(patch);
      fillSel(profSel, P.map((p) => ({ value: String(p.id), label: p.name })), prof, P.length ? null : 'Aucun profil', (v) => 'Profil introuvable (#' + v + ')');
      const free = (r) => (r.freeSpace != null ? ' · ' + App.fmt.bytes(r.freeSpace) + ' libres' : '');
      fillSel(rootSel, R.map((r) => ({ value: r.path, label: r.path + free(r) })), root, R.length ? null : 'Aucun dossier racine', (v) => v + ' (introuvable)');
      profSel.disabled = !P.length;
      rootSel.disabled = !R.length;
      if (metaSel) {
        fillSel(metaSel, MP.map((p) => ({ value: String(p.id), label: isNone(p) ? 'None (seulement les albums ajoutés à la main)' : p.name })),
          meta, MP.length ? null : 'Aucun profil', (v) => 'Profil introuvable (#' + v + ')');
        metaSel.disabled = !MP.length;
      }
      App.fill(rootNote, R.length ? null : App.note('Aucun dossier racine dans ' + name + ' : ajoutes-en un dans ' + name + ' › Réglages › Dossiers racine.', 'warn'));
    }
    refreshers.push(() => loadLists(false).catch(() => {}));
    async function test() {
      const api = App.arr(svc);
      if (!api.configured) throw App.mkErr('renseigne l’adresse et la clé API de ' + name + '.');
      const st = await api.get('/system/status');
      if (!st || typeof st !== 'object') throw App.mkErr(name + ' : réponse inattendue (adresse incorrecte ?)');
      const other = st.appName && !new RegExp(svc, 'i').test(st.appName);
      App.fill(status, other
        ? App.note('Cette adresse répond « ' + st.appName + ' » et pas ' + name + ' : vérifie l’URL.', 'warn')
        : okNote('Connecté à ' + name + ' ' + String(st.version || '').trim() + '.'));
      await loadLists(true);
    }
    function save() {
      const body = { url: fixUrl(url.value), publicUrl: fixUrl(pub.value) };
      if (key.input.value.trim()) body.apiKey = key.input.value.trim();
      return saveConn(svc, body, status, () => {
        fill();
        if (!body.url) loadLists(false).catch(() => {});
      }, test);
    }
    onEnter([url, key.input, pub], save);
    fill();
    const films = isR ? 'films' : isL ? 'albums' : 'séries';
    const rootHint = isR ? null : isL ? 'Pré-sélectionné : le dossier est demandé à chaque ajout.' : 'Pré-sélectionné : le dossier (séries ou animes) est demandé à chaque ajout.';
    return card(svc, isR ? 'film' : isL ? 'musical-note' : 'tv', name,
      App.field('Adresse (URL)', url, 'Adresse jointe par le serveur Arr411 (nom du conteneur, adresse locale ou publique).'),
      App.field('Clé API', key, 'Dans ' + name + ' : Paramètres › Général › Sécurité › Clé API.'),
      App.field('Adresse publique (facultatif)', pub, 'Adresse que ton navigateur peut ouvrir : elle sert au lien « Ouvrir dans ' + name + ' ».'),
      status,
      h('div.btn-row', App.btn('Enregistrer et tester', { cls: 'pri', icon: 'check', onClick: save }), rm),
      h('div.set-sep'),
      App.field('Profil de qualité par défaut', profSel),
      metaSel ? App.field('Profil de métadonnées par défaut', metaSel, 'Types d’albums (albums, EP, singles…) que Lidarr liste pour un nouvel artiste.') : null,
      App.field('Dossier racine par défaut', rootSel, rootHint),
      rootNote,
      App.field('Catégorie qBittorrent associée', catSelect(svc + 'Category'), 'Les torrents de cette catégorie proposent d’abord l’import dans ' + name + '.'),
      App.note(isL
        ? 'Les artistes et albums ajoutés ne sont jamais surveillés : Lidarr ne lance aucune recherche ni aucun téléchargement de lui-même.'
        : 'Les ' + films + ' ajouté' + (isR ? 's' : 'es') + ' ne sont jamais surveillé' + (isR ? 's' : 'es') + ' : ' + name + ' ne lance aucune recherche ni aucun téléchargement de lui-même.', '', 'shield-check')
    );
  }

  // ---------- Users (administrators) ----------
  function genPassword() {
    const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const buf = new Uint32Array(16);
    window.crypto.getRandomValues(buf);
    let s = '';
    for (const n of buf) s += alphabet[n % alphabet.length];
    return s;
  }
  // Password shown in clear on purpose: the administrator hands it over to the person.
  function passwordField(initial) {
    const inp = App.input({ type: 'text', placeholder: '8 caractères minimum', value: initial || '' });
    const gen = App.iconBtn('arrow-path', 'Générer un mot de passe', () => {
      inp.value = genPassword();
    });
    const cp = App.iconBtn('clipboard-document', 'Copier', () => {
      if (inp.value) App.copy(inp.value, 'Mot de passe');
    });
    const row = h('div.pw', inp, gen, cp);
    row.input = inp;
    return row;
  }
  // Second step of the add / reset sheets: shows what to pass on, since the password is never displayed again.
  function shareCredentials(s, title, username, password) {
    const text = 'Arr411\nAdresse : ' + location.origin + '\nUtilisateur : ' + username + '\nMot de passe : ' + password;
    s.setTitle(title);
    App.fill(s.body,
      App.note('Note ce mot de passe maintenant : il ne sera plus affiché. ' + username + ' pourra le changer dans Réglages › Compte.', 'warn'),
      App.kv([['Adresse', location.origin], ['Utilisateur', username], ['Mot de passe', password]]));
    App.fill(s.actionsEl,
      App.btn('Copier', { icon: 'clipboard-document', onClick: () => App.copy(text, 'Identifiants') }),
      App.btn('Terminer', { cls: 'pri', onClick: () => s.close() }));
  }

  function usersCard() {
    const box = h('div', App.loading());
    let users = null;
    async function load() {
      try {
        const j = await App.api('GET', '/api/admin/users');
        users = j.users || [];
        App.fill(box, users.length ? h('div.group', users.map(userRow)) : null);
      } catch (e) {
        App.fill(box, errNote(e));
      }
    }
    loaders.push(load);

    function addSheet() {
      const name = App.input({ placeholder: 'prenom', maxlength: '64' });
      const pw = passwordField(genPassword());
      const role = App.select([{ value: 'user', label: 'Utilisateur' }, { value: 'admin', label: 'Administrateur' }], 'user');
      const status = h('div');
      let s = null;
      async function submit() {
        const username = name.value.trim().toLowerCase();
        App.fill(status, waitNote('Création…'));
        try {
          await App.api('POST', '/api/admin/users', { username: username, password: pw.input.value, role: role.value });
        } catch (e) {
          return App.fill(status, errNote(e));
        }
        load();
        shareCredentials(s, 'Compte créé', username, pw.input.value);
      }
      s = App.sheet({
        title: 'Ajouter un utilisateur',
        body: [
          App.field('Identifiant', name, '2 à 64 caractères : lettres, chiffres, . _ - @ (les majuscules sont converties).'),
          App.field('Mot de passe', pw, 'Généré pour toi : copie-le avant de valider, ou saisis le tien.'),
          App.field('Rôle', role, 'Un administrateur gère les connexions, les valeurs par défaut et les comptes.'),
          status
        ],
        actions: [App.btn('Annuler', { onClick: () => s.close() }), App.btn('Créer', { cls: 'pri', icon: 'user-plus', onClick: submit })]
      });
      onEnter([name, pw.input], submit);
      setTimeout(() => name.focus(), 260);
    }

    function resetSheet(u) {
      const pw = passwordField(genPassword());
      const status = h('div');
      let s = null;
      async function submit() {
        App.fill(status, waitNote('Enregistrement…'));
        try {
          await App.api('PATCH', '/api/admin/users/' + encodeURIComponent(u.username), { password: pw.input.value });
        } catch (e) {
          return App.fill(status, errNote(e));
        }
        load();
        shareCredentials(s, 'Mot de passe modifié', u.username, pw.input.value);
      }
      s = App.sheet({
        title: 'Nouveau mot de passe',
        body: [App.note('Les sessions ouvertes de ' + u.username + ' seront fermées.'), App.field('Mot de passe pour ' + u.username, pw), status],
        actions: [App.btn('Annuler', { onClick: () => s.close() }), App.btn('Enregistrer', { cls: 'pri', onClick: submit })]
      });
      onEnter([pw.input], submit);
    }

    async function patchUser(u, patch, msg) {
      await App.api('PATCH', '/api/admin/users/' + encodeURIComponent(u.username), patch);
      App.toast(msg, 'ok');
      await load();
    }
    async function removeUser(u) {
      const ok = await App.confirm({
        title: 'Supprimer « ' + u.username + ' » ?',
        message: 'Le compte est supprimé et ses sessions sont fermées immédiatement.',
        ok: 'Supprimer',
        danger: true
      });
      if (!ok) return;
      await App.api('DELETE', '/api/admin/users/' + encodeURIComponent(u.username));
      App.toast('Compte supprimé', 'ok');
      await load();
    }
    function userMenu(u) {
      const admin = u.role === 'admin';
      App.menu({
        title: u.username,
        items: [
          { icon: 'key', label: 'Nouveau mot de passe…', onClick: () => resetSheet(u) },
          {
            icon: 'shield-check',
            label: admin ? 'Passer en utilisateur' : 'Passer administrateur',
            onClick: () => patchUser(u, { role: admin ? 'user' : 'admin' }, admin ? 'Compte repassé en utilisateur' : 'Compte passé administrateur')
          },
          {
            icon: u.disabled ? 'check-circle' : 'no-symbol',
            label: u.disabled ? 'Réactiver le compte' : 'Désactiver le compte',
            onClick: () => patchUser(u, { disabled: !u.disabled }, u.disabled ? 'Compte réactivé' : 'Compte désactivé')
          },
          '-',
          { icon: 'trash', label: 'Supprimer…', danger: true, onClick: () => removeUser(u) }
        ]
      });
    }
    function userRow(u) {
      const me = !!App.user && u.username === App.user.username;
      const admin = u.role === 'admin';
      return h('div.item',
        App.icon(u.disabled ? 'no-symbol' : 'user'),
        h('div.main',
          h('div.t', u.username),
          h('div.s', u.lastLoginAt ? 'Dernière connexion ' + App.fmt.rel(u.lastLoginAt) : 'Jamais connecté'),
          h('div.badges', { style: { marginTop: '5px' } },
            App.badge(admin ? 'Admin' : 'Utilisateur', admin ? 'green' : ''),
            u.disabled ? App.badge('Désactivé', 'red') : null,
            me ? App.badge('Toi', 'blue') : null)),
        me ? null : App.iconBtn('ellipsis-vertical', 'Actions pour ' + u.username, () => userMenu(u)));
    }

    return card('users', 'users', 'Utilisateurs',
      App.note('Seuls ces comptes peuvent se connecter. Il n’y a pas d’inscription libre.', '', 'lock-closed'),
      box,
      h('div.btn-row', App.btn('Ajouter un utilisateur', { cls: 'pri', icon: 'user-plus', onClick: addSheet }))
    );
  }

  function about() {
    return h('div.about', h('div.logo', h('span', 'Arr'), '411'), h('div', 'C411 · qBittorrent · Radarr · Sonarr · Lidarr'), App.version ? h('div', 'Version web ' + App.version) : null);
  }

  // ---------- Page ----------
  function leave() {
    const p = App.state.prevTab;
    App.goTab(p && p !== TAB ? p : 'qbit');
    return true;
  }
  function scrollToAnchor() {
    const el = pendingAnchor && S.anchors[pendingAnchor];
    pendingAnchor = null;
    if (!el || !scroll) return;
    setTimeout(() => {
      scroll.scrollTop += el.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 8;
    }, 60);
  }
  async function loadConns() {
    const j = await App.api('GET', '/api/admin/connections');
    conns = j.connections || {};
  }
  let syncing = false;
  // Fetches what the server knows (connections, users, shared config) without blocking the page.
  async function sync() {
    if (syncing) return;
    syncing = true;
    try {
      const jobs = [(App.isAdmin ? loadConns() : App.loadConfig()).then(refreshAll)];
      if (App.isAdmin) for (const f of loaders) jobs.push(f());
      await Promise.all(jobs.map((p) => p.catch(App.err)));
    } finally {
      syncing = false;
    }
  }
  function onShow() {
    refreshAll();
    loadCats();
    scrollToAnchor();
    sync();
  }
  S.init = function () {
    if (page) return;
    const u = App.user || {};
    page = App.page({ title: 'Réglages', subtitle: 'Arr411' + (u.username ? ' · ' + u.username : ''), back: true, onBack: leave });
    const kids = [accountCard(), prefsCard()];
    if (App.isAdmin) {
      kids.push(
        App.secTitle('Administration'),
        App.note('Les connexions, les valeurs par défaut et les comptes sont communs à tous. Les mots de passe et clés API restent sur le serveur : ils ne sont jamais renvoyés au navigateur.', '', 'shield-check'),
        qbitCard(), arrCard('radarr'), arrCard('sonarr'), arrCard('lidarr'), usersCard()
      );
    } else {
      kids.push(servicesCard());
    }
    kids.push(about());
    scroll = h('div.scroll', kids);
    page.el.appendChild(scroll);
    page.onShow = onShow;
    App.push(TAB, page);
    App.setTabHooks(TAB, { onBack: leave });
  };
  App.openSettings = function (section) {
    if (!page) S.init();
    if (section && !App.isAdmin && section !== 'account' && section !== 'prefs') section = 'services';
    App.popToRoot(TAB);
    pendingAnchor = section || null;
    if (scroll && !section) scroll.scrollTop = 0;
    if (App.state.tab === TAB) scrollToAnchor();
    else App.goTab(TAB);
  };
})();
