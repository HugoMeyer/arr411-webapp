'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');

h.prepareEnv();

const { authorizeArr, authorizeQb, hasSearchFlag, USER_COMMANDS } = require('../server/policy');
const { checkPath } = require('../server/proxy');
const { normalizeServiceUrl } = require('../server/upstream');
const { clientIp, parseCookies, serializeCookie } = require('../server/util');
const { safeNext } = require('../server/index');
const { Sessions, Throttle } = require('../server/auth');
const { Users, cleanPrefs } = require('../server/users');
const { JsonStore } = require('../server/store');
const { validateUsername, validatePassword, hashPassword, verifyPassword } = require('../server/password');

const json = (o) => Buffer.from(JSON.stringify(o));
const arr = (role, method, rest, body, extra) => authorizeArr(Object.assign({ role, method, rest, body: body === undefined ? null : json(body), allowSearch: false }, extra));
const FORBIDDEN = { status: 403, code: 'forbidden' };

test('arr : ce qu’un utilisateur simple peut faire', () => {
  const ok = [
    ['GET', 'movie'], ['GET', 'movie/12'], ['POST', 'movie', { title: 'Dune' }], ['PUT', 'movie/12', { id: 12 }], ['DELETE', 'movie/12'],
    ['GET', 'series'], ['GET', 'artist/3'], ['PUT', 'album/monitor', { albumIds: [1], monitored: false }],
    ['GET', 'episode'], ['PUT', 'episode/monitor', { episodeIds: [1], monitored: false }], ['DELETE', 'episodefile/4'],
    ['GET', 'moviefile'], ['DELETE', 'trackfile/2'], ['GET', 'track'],
    ['GET', 'queue'], ['DELETE', 'queue/5'], ['GET', 'history'], ['GET', 'history/movie'], ['GET', 'blocklist'], ['GET', 'calendar'],
    ['GET', 'wanted/missing'], ['GET', 'manualimport'], ['POST', 'seasonpass', { series: [] }], ['GET', 'rename'], ['GET', 'retag'], ['GET', 'parse'],
    ['GET', 'qualityprofile'], ['HEAD', 'qualityprofile'], ['GET', 'rootfolder'], ['GET', 'languageprofile'], ['GET', 'metadataprofile'], ['GET', 'qualitydefinition'],
    ['GET', 'language'], ['GET', 'diskspace'], ['GET', 'health'], ['GET', 'mediacover/1/poster.jpg'],
    ['GET', 'tag'], ['GET', 'tag/detail'], ['GET', 'tag/3'], ['POST', 'tag', { label: '4k' }],
    ['GET', 'system/status'], ['GET', 'system/task'], ['GET', 'command'], ['GET', 'command/9'],
    ['GET', 'MOVIE/1'], ['GET', 'System/Status']
  ];
  for (const [method, rest, body] of ok) assert.doesNotThrow(() => arr('user', method, rest, body), `${method} ${rest}`);
});

test('arr : ce qui reste réservé aux administrateurs', () => {
  const denied = [
    ['PUT', 'qualityprofile/1', {}], ['POST', 'qualityprofile', {}], ['DELETE', 'qualityprofile/1'],
    ['POST', 'rootfolder', {}], ['DELETE', 'rootfolder/1'], ['POST', 'metadataprofile', {}], ['PUT', 'metadataprofile/1', {}], ['DELETE', 'metadataprofile/1'],
    ['PUT', 'tag/1', {}], ['DELETE', 'tag/1'], ['POST', 'tag/detail', {}], ['POST', 'tag/1', {}],
    ['POST', 'system/status', {}], ['GET', 'system/backup'], ['POST', 'system/restart', {}], ['GET', 'system'], ['GET', 'system/status/extra'],
    ['PUT', 'config/downloadclient', {}], ['GET', 'downloadclient'], ['GET', 'indexer'], ['GET', 'notification'], ['GET', 'importlist'],
    ['GET', 'customformat'], ['GET', 'release'], ['POST', 'release', {}], ['GET', 'log'], ['GET', 'log/file'], ['GET', 'update'], ['GET', 'filesystem'],
    ['GET', 'remotepathmapping'], ['GET', 'delayprofile'], ['GET', 'autotagging'], ['GET', 'backup'], ['GET', 'config/ui'],
    ['POST', 'diskspace', {}], ['DELETE', 'health/1'], ['POST', 'language', {}], ['PUT', 'mediacover/1', {}]
  ];
  for (const [method, rest, body] of denied) {
    assert.throws(() => arr('user', method, rest, body), FORBIDDEN, `${method} ${rest}`);
    assert.doesNotThrow(() => arr('admin', method, rest, body), `admin ${method} ${rest}`);
  }
  assert.throws(() => arr('user', 'GET', ''), FORBIDDEN);
  assert.throws(() => arr('admin', 'GET', ''), FORBIDDEN);
});

test('arr : les réglages d’hôte du service (sa clé d’API) ne sont à la portée de personne', () => {
  for (const rest of ['config/host', 'config/host/1', 'CONFIG/HOST', 'Config/Host/1', 'config//host', '/config/host/']) {
    for (const role of ['user', 'admin']) {
      for (const method of ['GET', 'HEAD', 'DELETE']) assert.throws(() => arr(role, method, rest), FORBIDDEN, `${role} ${method} ${rest}`);
      for (const method of ['POST', 'PUT', 'PATCH']) assert.throws(() => arr(role, method, rest, {}), FORBIDDEN, `${role} ${method} ${rest}`);
    }
  }
  // the other settings stay open to administrators
  for (const rest of ['config/ui', 'config/naming', 'config/mediamanagement', 'config/downloadclient']) {
    assert.doesNotThrow(() => arr('admin', 'GET', rest), rest);
    assert.throws(() => arr('user', 'GET', rest), FORBIDDEN, rest);
  }
});

test('arr : les commandes d’un utilisateur sont limitées à une liste', () => {
  for (const name of USER_COMMANDS) assert.doesNotThrow(() => arr('user', 'POST', 'command', { name }), name);
  for (const name of ['ApplicationUpdate', 'DeleteLogFiles', 'CleanUpRecycleBin', 'DownloadedMoviesScan', 'ImportListSync', 'Restart']) {
    assert.throws(() => arr('user', 'POST', 'command', { name }), FORBIDDEN, name);
    assert.doesNotThrow(() => arr('admin', 'POST', 'command', { name }), `admin ${name}`);
  }
});

test('arr : aucune recherche ni synchronisation RSS par défaut', () => {
  const searches = ['MoviesSearch', 'EpisodeSearch', 'SeasonSearch', 'SeriesSearch', 'MissingMoviesSearch', 'CutoffUnmetMoviesSearch', 'AlbumSearch', 'ArtistSearch', 'RssSync', 'rsssync', 'RSSSYNC', 'missingEpisodeSEARCH'];
  for (const name of searches) {
    for (const role of ['admin', 'user']) assert.throws(() => arr(role, 'POST', 'command', { name }), FORBIDDEN, `${role} ${name}`);
  }
  for (const role of ['admin', 'user']) {
    assert.throws(() => arr(role, 'POST', 'command', {}), { status: 400 });
    assert.throws(() => arr(role, 'POST', 'command', { name: 42 }), { status: 400 });
    assert.throws(() => arr(role, 'POST', 'command', [{ name: 'RefreshMovie' }]), { status: 400 });
    assert.throws(() => authorizeArr({ role, method: 'POST', rest: 'command', body: Buffer.from('nope'), allowSearch: false }), { status: 400 });
    assert.throws(() => authorizeArr({ role, method: 'POST', rest: 'command', body: null, allowSearch: false }), { status: 400 });
  }
});

test('arr : le nom d’une commande est une suite de lettres, lue sous la clé « name » et nulle part ailleurs', () => {
  const names = ['Refresh Movie', 'RefreshMovie ', ' RefreshMovie', 'RefreshMovie\n', 'Refresh\u00adMovie', 'Refresh\u200bMovie', 'RefreshMovie\u0000', 'RefreshMovıe', 'Refresh1', 'Refresh-Movie', 'Refresh_Movie', '', 'A'.repeat(65)];
  for (const role of ['admin', 'user']) {
    for (const name of names) assert.throws(() => arr(role, 'POST', 'command', { name }), { status: 400 }, `${role} ${JSON.stringify(name)}`);
    for (const body of [{ Name: 'RefreshMovie' }, { NAME: 'RefreshMovie' }, { ' name': 'RefreshMovie' }, { 'name ': 'RefreshMovie' }, { nam: 'RefreshMovie' }]) {
      assert.throws(() => arr(role, 'POST', 'command', body), { status: 400 }, `${role} ${JSON.stringify(body)}`);
    }
  }
  assert.doesNotThrow(() => arr('user', 'POST', 'command', { name: 'RefreshMovie', movieIds: [1] }));
  assert.doesNotThrow(() => arr('admin', 'POST', 'command', { name: 'A'.repeat(64) }));
});

test('arr : un corps JSON ambigu (une même clé deux fois, casse ou échappement près) est refusé, pas transmis', () => {
  const send = (role, method, rest, text) => authorizeArr({ role, method, rest, body: Buffer.from(text), allowSearch: false, contentType: 'application/json' });
  const ambiguous = [
    '{"name":"RefreshMovie","Name":"CleanUpRecycleBin"}',
    '{"name":"RefreshMovie","NAME":"CleanUpRecycleBin"}',
    '{"name":"RefreshMovie","name":"CleanUpRecycleBin"}',
    '{"name":"CleanUpRecycleBin","name":"RefreshMovie"}',
    '{"na\\u006de":"RefreshMovie","name":"CleanUpRecycleBin"}',
    '{"name":"RefreshMovie" ,\n\t"nam\\u0065" :\r\n"CleanUpRecycleBin"}',
    '{"name":"RefreshMovie","a":{"x":1,"X":2}}',
    '{"name":"RefreshMovie","a":[{"x":1},{"y":1,"Y":2}]}',
    '{"name":"RefreshMovie","a":{"b":{"c":{"d":1,"D":1}}}}',
    '{"name":"RefreshMovie","\u017f":1,"S":2}',
    '{"name":"RefreshMovie","stra\u00dfe":1,"STRASSE":2}',
    '{"name":"RefreshMovie","a\\"b":1,"A\\"B":2}'
  ];
  for (const text of ambiguous) {
    for (const role of ['admin', 'user']) {
      assert.throws(() => send(role, 'POST', 'command', text), { status: 400 }, `${role} command ${text}`);
      assert.throws(() => send(role, 'PUT', 'movie/1', text), { status: 400 }, `${role} movie ${text}`);
    }
  }
  const fine = [
    '{"name":"RefreshMovie"}',
    ' { "name" : "RefreshMovie" , "movieIds" : [ 1 , 2 ] } ',
    '{"name":"RefreshMovie","a":{"x":1},"b":{"x":2}}',
    '{"name":"RefreshMovie","list":[{"x":1},{"x":2},{"X":3,"y":4}]}',
    '{"name":"RefreshMovie","text":"a\\",\\"x\\":1,\\"x\\":2","other":"x"}',
    '{"name":"RefreshMovie","a":"x","b":"x","c":["x","x"]}'
  ];
  for (const text of fine) {
    for (const role of ['admin', 'user']) assert.doesNotThrow(() => send(role, 'POST', 'command', text), `${role} ${text}`);
  }
  // an ambiguous flag cannot be used to slip a search past the check either
  assert.throws(() => send('user', 'POST', 'movie', '{"addOptions":{"searchForMovie":false,"SearchForMovie":true}}'), { status: 400 });
  assert.throws(() => send('admin', 'POST', 'movie', '{"addOptions":{"searchForMovie":true,"searchformovie":false}}'), { status: 400 });
});

test('arr : les options de recherche à l’ajout sont refusées, sauf si elles valent « faux »', () => {
  const flagged = [
    { addOptions: { searchForMovie: true } },
    { addOptions: { searchForMissingEpisodes: true } },
    { addOptions: { searchForCutoffUnmetEpisodes: 1 } },
    { addOptions: { searchForMissingAlbums: true } },
    { addOptions: { searchForNewAlbum: true } },
    { addOptions: { searchformovie: true } },
    { addOptions: { SEARCHFORMOVIE: 'yes' } },
    { addOptions: { searchForMovie: 'false' } },
    [{ addOptions: { searchForMovie: true } }],
    { a: { b: { c: { d: { e: { f: { g: { h: { searchForMovie: true } } } } } } } } }
  ];
  for (const body of flagged) {
    for (const method of ['POST', 'PUT', 'PATCH']) {
      assert.throws(() => arr('admin', method, 'movie', body), FORBIDDEN, `${method} ${JSON.stringify(body)}`);
      assert.throws(() => arr('user', method, 'series', body), FORBIDDEN, `user ${method} ${JSON.stringify(body)}`);
    }
  }
  const clean = [
    { addOptions: { monitor: 'none', searchForMovie: false } },
    { addOptions: { searchForMissingEpisodes: false, searchForCutoffUnmetEpisodes: false } },
    { addOptions: { searchForMovie: 0 } },
    { addOptions: { searchForMovie: null } },
    { title: 'Search for Dune', monitored: false }
  ];
  for (const body of clean) assert.doesNotThrow(() => arr('user', 'POST', 'movie', body), JSON.stringify(body));
  // a flag that is not in a body that is being written is irrelevant
  assert.doesNotThrow(() => arr('user', 'DELETE', 'movie/1', { addOptions: { searchForMovie: true } }));
  assert.doesNotThrow(() => arr('user', 'GET', 'movie/lookup'));
});

test('arr : un corps illisible est refusé, pas transmis tel quel', () => {
  const bodies = ['{"addOptions": {\'searchForMovie\': true}}', '/* c */ {"addOptions":{"searchForMovie":true}}', '{"a":1,}', 'x'.repeat(10)];
  for (const b of bodies) {
    assert.throws(() => authorizeArr({ role: 'user', method: 'POST', rest: 'movie', body: Buffer.from(b), allowSearch: false }), { status: 400 }, b);
    assert.throws(() => authorizeArr({ role: 'admin', method: 'PUT', rest: 'movie/1', body: Buffer.from(b), allowSearch: false }), { status: 400 }, b);
  }
  // multipart uploads (torrent, backup restore) are not JSON
  const multipart = Buffer.from('--b\r\nContent-Disposition: form-data; name="f"; filename="a.zip"\r\n\r\nPK\x03\x04\r\n--b--\r\n');
  assert.doesNotThrow(() => authorizeArr({ role: 'admin', method: 'POST', rest: 'system/backup/restore/upload', body: multipart, allowSearch: false, contentType: 'multipart/form-data; boundary=b' }));
  // padding the body does not hide a flag
  const padded = { junk: 'x'.repeat(3 * 1024 * 1024), addOptions: { searchForMovie: true } };
  assert.throws(() => arr('user', 'POST', 'movie', padded), FORBIDDEN);
});

test('arr : avec ALLOW_SEARCH_COMMANDS, les recherches passent mais pas les commandes d’administration', () => {
  const on = { allowSearch: true };
  assert.doesNotThrow(() => arr('admin', 'POST', 'command', { name: 'MoviesSearch' }, on));
  assert.doesNotThrow(() => arr('admin', 'POST', 'command', { name: 'RssSync' }, on));
  assert.doesNotThrow(() => arr('admin', 'POST', 'movie', { addOptions: { searchForMovie: true } }, on));
  assert.doesNotThrow(() => arr('user', 'POST', 'movie', { addOptions: { searchForMovie: true } }, on));
  // an ordinary user still cannot run commands outside the allowed list
  assert.throws(() => arr('user', 'POST', 'command', { name: 'ApplicationUpdate' }, on), FORBIDDEN);
  assert.throws(() => arr('user', 'POST', 'command', { name: 'DeleteLogFiles' }, on), FORBIDDEN);
  assert.throws(() => arr('user', 'POST', 'command', { name: 'MoviesSearch' }, on), FORBIDDEN);
  assert.doesNotThrow(() => arr('user', 'POST', 'command', { name: 'RefreshMovie' }, on));
  assert.throws(() => arr('user', 'POST', 'command', {}, on), { status: 400 });
});

test('hasSearchFlag', () => {
  assert.equal(hasSearchFlag(null), false);
  assert.equal(hasSearchFlag('searchForMovie'), false);
  assert.equal(hasSearchFlag({}), false);
  assert.equal(hasSearchFlag({ searchForMovie: false }), false);
  assert.equal(hasSearchFlag({ searchForMovie: true }), true);
  assert.equal(hasSearchFlag({ '\u017fearchForMovie': true }), true, 'la casse est repliée comme le fait le service (ſ -> s)');
  assert.equal(hasSearchFlag({ SEARCHFORMOVIE: 1 }), true);
  assert.equal(hasSearchFlag({ search: true, searchfo: true }), false);
  assert.equal(hasSearchFlag([[{ x: { searchForNewAlbum: true } }]]), true);
  let deep = { searchForMovie: true };
  for (let i = 0; i < 40; i++) deep = { n: deep };
  assert.equal(hasSearchFlag(deep), true);
});

test('qBittorrent : droits par rôle', () => {
  for (const rest of ['app/preferences', 'app/setPreferences', 'app/shutdown', 'rss/items', 'search/start', 'log/main', 'torrents/info', 'auth/login', 'torrentcreator/addTask', 'future/endpoint']) {
    assert.doesNotThrow(() => authorizeQb({ role: 'admin', rest }), rest);
  }
  const allowed = [
    'auth/login', 'auth/logout', 'app/version', 'app/webapiVersion', 'app/WebAPIVersion', 'app/buildInfo', 'torrents/info', 'torrents/add', 'torrents/setLocation',
    'sync/maindata', 'sync/torrentPeers', 'transfer/info', 'transfer/banPeers', 'transfer/toggleSpeedLimitsMode', 'torrents/files', 'torrents/createCategory', 'Torrents/Info'
  ];
  for (const rest of allowed) assert.doesNotThrow(() => authorizeQb({ role: 'user', rest }), rest);
  const denied = [
    'app/preferences', 'app/setPreferences', 'app/shutdown', 'app/defaultSavePath', 'app', 'app/', 'rss/items', 'RSS/items', 'rss/addFeed', 'search/start', 'search/results', 'log/main', 'LOG/peers',
    'torrentcreator/addTask', 'TorrentCreator/status', 'auth/foo', 'app/versions', 'future/endpoint', '_x/y'
  ];
  for (const rest of denied) assert.throws(() => authorizeQb({ role: 'user', rest }), FORBIDDEN, rest);
});

test('qBittorrent : seule la forme « portée/action » est relayée, y compris pour un administrateur', () => {
  // qBittorrent decodes the path before routing it: whatever is not written the way it routes is refused here.
  const malformed = [
    '', '/', 'torrents', 'torrents/', '/torrents/info', 'torrents/info/', 'torrents/info/extra', 'torrents//info', 'app/setPreferences/', 'app/setPreferences/x',
    '%61pp/setPreferences', '%41pp/setPreferences', 'app%2fsetPreferences', 'app/set%50references', 'torrents/in fo', 'torrents/info\n', 'to-rrents/info', 'torrents/in-fo',
    '1app/setPreferences', 'torrents/1info', 'torrents/info.json', 'torrents/info;x', 'torrents/info?x=1', '\uff41pp/setPreferences', '../app/setPreferences', 'torrents/../app/setPreferences'
  ];
  for (const role of ['admin', 'user']) {
    for (const rest of malformed) assert.throws(() => authorizeQb({ role, rest }), FORBIDDEN, `${role} ${JSON.stringify(rest)}`);
  }
});

test('proxy : chemins acceptés et refusés', () => {
  assert.equal(checkPath('/api/v2/torrents/info', 'qb'), 'torrents/info');
  assert.equal(checkPath('/api/v3/movie/12', 'radarr'), 'movie/12');
  assert.equal(checkPath('/api/v3/series', 'sonarr'), 'series');
  assert.equal(checkPath('/api/v1/artist/lookup', 'lidarr'), 'artist/lookup');
  assert.equal(checkPath('/api/v3/mediacover/1/poster-250.jpg', 'radarr'), 'mediacover/1/poster-250.jpg');

  const invalid = [
    '', '/', '/api/v2/../x', '/api/v2/./x', '/api/v2/%2e%2e/x', '/api/v2/%2E%2E/x', '/api/v2/a%2fb', '/api/v2/a%2Fb', '/api/v2/a%5cb', '/api/v2/a\\b',
    '//evil.example/api/v2/x', '/api/v2//x', '/api/v2/x%00', '/api/v2/x%0a', '/api/v2/x%0D', '/api/v2/x%7f', '/api/v2/x y', '/api/v2/x"', '/api/v2/<x>', '/api/v2/é',
    '/api/v2/%zz', 'api/v2/x', '/api/v2/x#frag', '/api/v2/x?q=1', 'http://evil.example/api/v2/x', '/api/v2/..%2f..%2fx',
    // any percent-encoding: the services decode the path before routing it
    '/api/v2/%61pp/setPreferences', '/api/v2/%41pp/setPreferences', '/api/v2/app/%73etPreferences', '/api/v2/torrents%2Finfo', '/api/v2/a%20b', '/api/v2/%25', '/api/v2/%', '/api/v2/x%',
    '/api/v2/torrents/info%3Fx', '/api/v3/movie/lookup%3Fx', '/api%2Fv2/torrents/info', '/%61pi/v2/torrents/info', '/api/v2%2Ftorrents/info'
  ];
  for (const raw of invalid) assert.throws(() => checkPath(raw, 'qb'), (e) => e.status === 400 || e.status === 404, JSON.stringify(raw));
  for (const raw of ['/api/v3/movie/lookup%3Fx', '/api/v3/%6dovie', '/api/v3/movie/%2e%2e/config/host']) assert.throws(() => checkPath(raw, 'radarr'), { status: 400 }, raw);
  // another service's prefix, a bare prefix and anything outside the API
  for (const [raw, svc] of [['/api/v3/movie', 'qb'], ['/api/v2/torrents/info', 'radarr'], ['/api/v1/artist', 'sonarr'], ['/api/v3/movie', 'lidarr'], ['/api/v2', 'qb'], ['/api/v2x/y', 'qb'], ['/web/index.html', 'qb'], ['/login', 'radarr']]) {
    assert.throws(() => checkPath(raw, svc), { status: 404 }, `${svc} ${raw}`);
  }
});

test('adresses de services', () => {
  assert.equal(normalizeServiceUrl(''), '');
  assert.equal(normalizeServiceUrl('   '), '');
  assert.equal(normalizeServiceUrl(null), '');
  assert.equal(normalizeServiceUrl('http://radarr:7878'), 'http://radarr:7878');
  assert.equal(normalizeServiceUrl(' http://radarr:7878/ '), 'http://radarr:7878');
  assert.equal(normalizeServiceUrl('HTTPS://Arr.Example.org:8443/radarr//'), 'https://arr.example.org:8443/radarr');
  assert.equal(normalizeServiceUrl('http://192.168.1.10:8080/qbt/'), 'http://192.168.1.10:8080/qbt');
  assert.equal(normalizeServiceUrl('http://[::1]:7878'), 'http://[::1]:7878');
  assert.equal(normalizeServiceUrl('http://radarr/?'), 'http://radarr', 'une requête vide est simplement ignorée');
  const bad = ['radarr:7878', 'ftp://radarr', 'javascript:alert(1)', 'file:///etc/passwd', '//radarr', 'http://', 'http://user:pw@radarr', 'http://user@radarr', 'http://radarr/?a=1', 'http://radarr/#x', {}, [], ['http://radarr'], 5, true];
  for (const u of bad) assert.throws(() => normalizeServiceUrl(u), { status: 400 }, String(JSON.stringify(u)));
});

test('adresse IP du client et reverse proxy', () => {
  const req = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } });
  assert.equal(clientIp(req('10.0.0.5'), 0), '10.0.0.5');
  assert.equal(clientIp(req('::ffff:10.0.0.5'), 0), '10.0.0.5');
  // without a trusted proxy, the header is only a claim made by the client
  assert.equal(clientIp(req('10.0.0.5', '1.2.3.4'), 0), '10.0.0.5');
  // one trusted proxy: it appended the address it saw, so the client's own claim (first entries) is ignored
  assert.equal(clientIp(req('172.18.0.2', '203.0.113.7'), 1), '203.0.113.7');
  assert.equal(clientIp(req('172.18.0.2', '6.6.6.6, 203.0.113.7'), 1), '203.0.113.7');
  assert.equal(clientIp(req('172.18.0.2'), 1), '172.18.0.2');
  // two trusted proxies (CDN + proxy)
  assert.equal(clientIp(req('172.18.0.2', '203.0.113.7, 198.51.100.9'), 2), '203.0.113.7');
  assert.equal(clientIp(req('172.18.0.2', '6.6.6.6, 203.0.113.7, 198.51.100.9'), 2), '203.0.113.7');
  assert.equal(clientIp(req('172.18.0.2', '198.51.100.9'), 2), '198.51.100.9');
  assert.equal(clientIp(req(undefined), 0), 'unknown');
  // what the proxy chain yields must be an address: text for the logs or endless distinct keys for the throttle never get through
  for (const bad of ['foo', '1.2.3.4:80', '1.2.3.4 evil', '999.1.1.1', 'a'.repeat(300), '203.0.113.7\u001b[31m', '::1%eth0', '[::1]', '<script>', 'unknown', '-']) {
    assert.equal(clientIp(req('172.18.0.2', bad), 1), '172.18.0.2', bad);
  }
  assert.equal(clientIp(req('172.18.0.2', '6.6.6.6, foo'), 1), '172.18.0.2');
  assert.equal(clientIp(req('172.18.0.2', ' , '), 1), '172.18.0.2');
  assert.equal(clientIp(req('172.18.0.2', '2001:db8::1'), 1), '2001:db8::1');
  assert.equal(clientIp(req('172.18.0.2', '::ffff:203.0.113.7'), 1), '203.0.113.7');
  assert.equal(clientIp(req('172.18.0.2', 'foo, 203.0.113.7'), 1), '203.0.113.7', 'only the entry added by the trusted proxy counts');
});

test('destination après connexion (next)', () => {
  const good = ['/', '/radarr', '/#tab=radarr', '/?q=1', '/share?text=magnet%3A%3Fxt%3D1', '/a/b/c', '/%09/evil.example', '/a%0d%0ab', '/.//x'];
  for (const v of good) assert.equal(safeNext(v), v);
  const bad = [undefined, null, '', 'radarr', 'https://evil.example', '//evil.example', '/\\evil.example', '/\n/evil.example', '/a\r\nSet-Cookie: x=1', '/a\0b', '/login', '/login/', '/login?next=/', '/LOGIN', '/api', '/api/admin/users', '/Api/config', 'javascript:alert(1)', '/' + 'a'.repeat(2001)];
  for (const v of bad) assert.equal(safeNext(v), '/', JSON.stringify(v));
  // browsers drop tabs and line breaks from a URL: "/<tab>/evil.example" is read as "//evil.example", and so are these
  const stripped = ['/\t/evil.example', '/\r/evil.example', '/\t\\evil.example', '/\n\t/evil.example', '/\u000b/evil.example', '/\u000c/evil.example', '/\u0000/evil.example', '/\u007f/evil.example', '/\u0085/x', '/\u00a0/x', '/\u2028/x', '/\ufeff/x'];
  const other = ['/ /evil.example', '/ x', '/x ', '/\u00e9', '/\u20ac', '/a\u0301', '/\u202e', '/\ud83d\ude00', '/a\u007fb'];
  for (const v of stripped.concat(other)) assert.equal(safeNext(v), '/', JSON.stringify(v));
});

test('cookies', () => {
  assert.deepEqual({ ...parseCookies('a=1; b="two"; c=3=4; =x; broken; a=ignored') }, { a: '1', b: 'two', c: '3=4' });
  assert.equal(parseCookies('__proto__=x').__proto__, 'x');
  assert.equal({}.x, undefined);
  assert.equal(serializeCookie('s', 'v', { maxAge: 60 }), 's=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=60');
  assert.match(serializeCookie('s', 'v', { maxAge: 60, secure: true }), /; Secure$/);
  assert.match(serializeCookie('s', '', { maxAge: 0 }), /Max-Age=0; Expires=Thu, 01 Jan 1970/);
});

test('sessions signées', () => {
  const s = new Sessions('un-secret-assez-long-1234', 3600);
  const user = { username: 'alice', sv: 3 };
  const now = Date.UTC(2030, 0, 1);
  const sid = 'AbCd0123_-AbCd01';
  const token = s.sign(user, now, sid);
  assert.match(token, /^v1\.[\w-]+\.[\w-]+$/);
  assert.deepEqual(s.verify(token, now + 1000), { u: 'alice', sv: 3, sid, iat: now / 1000, exp: now / 1000 + 3600 });
  assert.equal(s.verify(token, now + 3600 * 1000), null, 'expirée à l’échéance exacte');
  assert.ok(s.verify(token, now + 3599 * 1000));
  assert.equal(s.verify(token + 'x', now), null);
  assert.equal(s.verify(token.slice(0, -2), now), null);
  const [v, payload, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ u: 'admin', sv: 3, sid, iat: now / 1000, exp: now / 1000 + 999999 })).toString('base64url');
  assert.equal(s.verify(`${v}.${forged}.${mac}`, now), null);
  assert.equal(s.verify(`v2.${payload}.${mac}`, now), null);
  assert.equal(s.verify(`${v}.${payload}`, now), null);
  assert.equal(s.verify(`${v}.${payload}.${mac}.extra`, now), null);
  for (const t of ['', null, undefined, 'v1..', 'v1.x.y', '.', 'a.b.c', 'v1.' + 'a'.repeat(2000) + '.x']) assert.equal(s.verify(t, now), null, String(t));
  assert.equal(new Sessions('un-autre-secret-assez-long', 3600).verify(token, now), null, 'autre secret');
  // a missing session version counts as 1
  assert.equal(s.verify(s.sign({ username: 'bob' }, now), now).sv, 1);

  // Each cookie carries a session id, random unless given; a correctly signed token without a valid one is refused.
  assert.notEqual(s.verify(s.sign(user, now), now).sid, s.verify(s.sign(user, now), now).sid);
  assert.match(s.verify(s.sign(user, now), now).sid, /^[A-Za-z0-9_-]{16}$/);
  const signed = (extra) => {
    const head = 'v1.' + Buffer.from(JSON.stringify({ u: 'alice', sv: 3, iat: now / 1000, exp: now / 1000 + 3600, ...extra })).toString('base64url');
    return `${head}.${s.mac(head)}`;
  };
  assert.ok(s.verify(signed({ sid }), now), 'contrôle : le jeton fabriqué ici est valide avec un sid correct');
  for (const bad of [undefined, null, '', 'court', 'x'.repeat(17), 'AbCd0123_-AbCd0!', 'AbCd0123_-AbCd0 ', 12345678901234567, ['AbCd0123_-AbCd01'], { a: 1 }]) {
    assert.equal(s.verify(signed({ sid: bad }), now), null, `sid ${JSON.stringify(bad)}`);
  }
});

test('limitation des tentatives', () => {
  const t = new Throttle(3, 1000);
  const t0 = 1_000_000;
  assert.equal(t.wait('k', t0), 0);
  t.fail('k', t0);
  t.fail('k', t0 + 10);
  assert.equal(t.wait('k', t0 + 20), 0, 'encore 1 essai');
  t.fail('k', t0 + 30);
  assert.ok(t.wait('k', t0 + 40) >= 1, 'bloqué au 3e échec');
  assert.equal(t.wait('autre', t0 + 40), 0, 'les autres clés ne sont pas touchées');
  assert.equal(t.wait('k', t0 + 1000), 0, 'la fenêtre est écoulée');
  t.fail('k', t0 + 1001);
  assert.equal(t.wait('k', t0 + 1002), 0, 'compteur reparti de zéro');
  t.fail('k', t0 + 1003);
  t.fail('k', t0 + 1004);
  assert.ok(t.wait('k', t0 + 1005) > 0);
  t.reset('k');
  assert.equal(t.wait('k', t0 + 1006), 0);
  const small = new Throttle(1, 60000, 5);
  for (let i = 0; i < 50; i++) small.fail('k' + i, t0 + i);
  assert.ok(small.map.size <= 5, 'mémoire bornée');
});

test('identifiants et mots de passe', async () => {
  assert.equal(validateUsername('  Alice.B-2  '), 'alice.b-2');
  assert.equal(validateUsername('bob@example.org'), 'bob@example.org');
  for (const bad of ['', 'a', '-ab', '.ab', 'a b', 'a/b', '../x', 'é', 'a'.repeat(65), null, undefined, 'x\ny']) assert.throws(() => validateUsername(bad), { status: 400 }, JSON.stringify(bad));
  assert.equal(validateUsername('a'.repeat(64)), 'a'.repeat(64));
  assert.equal(validatePassword('12345678'), '12345678');
  for (const bad of ['1234567', '', null, undefined, 12345678, 'x'.repeat(257)]) assert.throws(() => validatePassword(bad), { status: 400 }, JSON.stringify(bad));
  const stored = await hashPassword('mot de passe 1');
  assert.match(stored, /^scrypt\$32768\$8\$1\$[\w+/=]+\$[\w+/=]+$/);
  assert.ok(await verifyPassword('mot de passe 1', stored));
  assert.ok(!(await verifyPassword('mot de passe 2', stored)));
  assert.ok(!(await verifyPassword('', stored)));
  assert.notEqual(stored, await hashPassword('mot de passe 1'), 'sel aléatoire');
  for (const junk of ['', null, 'plain', 'scrypt$1$2$3', 'bcrypt$32768$8$1$AAAA$AAAA', 'scrypt$1$8$1$AAAA$AAAA', 'scrypt$32768$8$1$$', 'scrypt$32769$8$1$AAAA$AAAA', 'scrypt$1048576$8$1$AAAA$AAAA']) {
    assert.ok(!(await verifyPassword('x', junk)), String(junk));
  }
});

test('préférences', () => {
  assert.deepEqual(cleanPrefs({ startTab: 'radarr', lastCategory: 'Films', notifyDone: true }), { startTab: 'radarr', lastCategory: 'Films', notifyDone: true });
  assert.deepEqual(cleanPrefs({ startTab: 'last' }), { startTab: 'last' });
  assert.deepEqual(cleanPrefs({ startTab: 'evil', lastCategory: 5, notifyDone: 'yes', other: 1, __proto__: { startTab: 'c411' } }), {});
  assert.deepEqual(cleanPrefs({ lastCategory: 'x'.repeat(101) }), {});
  assert.deepEqual(cleanPrefs({ lastCategory: 'x'.repeat(100) }), { lastCategory: 'x'.repeat(100) });
  assert.deepEqual(cleanPrefs(null), {});
  assert.deepEqual(cleanPrefs('startTab'), {});
});

test('comptes : il reste toujours un administrateur actif', async () => {
  const file = path.join(h.tmpDir(), 'users.json');
  const users = new Users(new JsonStore(file, () => ({ version: 1, users: [] })).load());
  await users.create({ username: 'root', password: 'password-root', role: 'admin' });
  await users.create({ username: 'second', password: 'password-second', role: 'admin' });
  await users.create({ username: 'simple', password: 'password-simple', role: 'user' });

  await assert.rejects(users.create({ username: 'ROOT', password: 'password-other' }), { status: 409 });
  await assert.rejects(users.create({ username: 'x', password: 'password-other' }), { status: 400 });
  await assert.rejects(users.create({ username: 'nouveau', password: 'court' }), { status: 400 });
  await assert.rejects(users.create({ username: 'nouveau', password: 'password-other', role: 'root' }), { status: 400 });

  await users.update('second', { disabled: true });
  assert.equal(users.activeAdmins().length, 1);
  await assert.rejects(users.update('root', { disabled: true }), { status: 409, message: /au moins un administrateur/ });
  await assert.rejects(users.update('root', { role: 'user' }), { status: 409 });
  await assert.rejects(users.remove('root'), { status: 409 });
  await users.update('second', { disabled: false });
  await users.update('root', { role: 'user' });
  assert.equal(users.find('ROOT').role, 'user');
  await assert.rejects(users.remove('second'), { status: 409 });
  await users.remove('simple');
  assert.equal(users.find('simple'), null);
  await assert.rejects(users.remove('simple'), { status: 404 });
  await assert.rejects(users.update('simple', { disabled: true }), { status: 404 });

  // with an actor: nobody can change their own role or status
  await users.update('root', { role: 'admin' });
  const actor = { username: 'root' };
  await assert.rejects(users.update('root', { role: 'user' }, actor), { status: 409 });
  await assert.rejects(users.update('root', { disabled: true }, actor), { status: 409 });
  await assert.rejects(users.remove('root', actor), { status: 409 });
  await users.update('root', { role: 'admin', disabled: false }, actor);

  // the password is stored hashed, and changing it signs the user out everywhere
  const before = users.find('root').sv;
  await users.setPassword('root', 'nouveau-mot-de-passe');
  assert.equal(users.find('root').sv, before + 1);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('password-root') && !raw.includes('nouveau-mot-de-passe'));
  assert.ok(await verifyPassword('nouveau-mot-de-passe', users.find('root').hash));
  assert.deepEqual(Object.keys(users.view(users.find('root'))).sort(), ['createdAt', 'disabled', 'lastLoginAt', 'role', 'username']);
});
