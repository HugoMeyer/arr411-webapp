'use strict';
const { HttpError } = require('./util');

// Segments (first path element after /api/v3 or /api/v1) a regular user may use.
// Everything else needs the admin role. Mirrors what the Arr411 interface calls.
const ARR_FULL = new Set([
  'movie', 'series', 'artist', 'album', 'episode', 'episodefile', 'moviefile', 'trackfile', 'track',
  'queue', 'history', 'blocklist', 'blacklist', 'calendar', 'command', 'manualimport', 'seasonpass',
  'rename', 'retag', 'parse', 'wanted'
]);
const ARR_READ = new Set([
  'qualityprofile', 'rootfolder', 'languageprofile', 'metadataprofile', 'qualitydefinition', 'language',
  'diskspace', 'health', 'mediacover', 'tag'
]);
const ARR_SYSTEM_READ = new Set(['status', 'task']);

const USER_COMMANDS = new Set([
  'RefreshMonitoredDownloads', 'RefreshMovie', 'RefreshSeries', 'RefreshArtist', 'RescanMovie', 'RescanSeries',
  'RescanFolders', 'CheckHealth', 'Backup', 'RenameFiles', 'RetagFiles', 'ManualImport'
]);
const SEARCH_COMMAND = /search|rsssync/i;
const COMMAND_NAME = /^[A-Za-z]{1,64}$/;

// qBittorrent routes "<scope>/<action>" and nothing else, so nothing else is relayed. A regular user gets the
// scopes the interface uses plus the version calls; any other scope (settings, log, rss, search, torrent
// creator, one added by a later release) is for administrators.
const QB_ENDPOINT = /^([A-Za-z_][A-Za-z0-9_]*)\/([A-Za-z_][A-Za-z0-9_]*)$/;
const QB_USER_SCOPES = new Set(['sync', 'transfer', 'torrents']);
const QB_USER_AUTH = new Set(['login', 'logout']);
const QB_USER_APP = new Set(['version', 'webapiversion', 'buildinfo']);

const forbidden = (msg) => new HttpError(403, msg || 'Action réservée aux administrateurs', { code: 'forbidden' });

// Case folding wider than the services': a name they would treat as equal must never look different here.
const fold = (s) => s.toUpperCase().toLowerCase();

// Nesting this deep never happens in a real request: treat it as an attempt to hide a flag.
function hasSearchFlag(v, depth = 0) {
  if (v == null || typeof v !== 'object') return false;
  if (depth > 32) return true;
  if (Array.isArray(v)) return v.some((x) => hasSearchFlag(x, depth + 1));
  for (const [k, x] of Object.entries(v)) {
    if (/^searchfor/.test(fold(k)) && x) return true;
    if (hasSearchFlag(x, depth + 1)) return true;
  }
  return false;
}

// `text` is JSON that was just parsed. True when an object holds one key twice, escapes and letter case aside,
// at any depth: the services keep the first, the last or a mix of them, so what is checked here could differ
// from what they run.
function hasDuplicateKeys(text) {
  const open = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') open.push(new Set());
    else if (c === '[') open.push(null);
    else if (c === '}' || c === ']') open.pop();
    else if (c === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const keys = open[open.length - 1];
      if (keys) {
        let next = end + 1;
        while (text[next] === ' ' || text[next] === '\t' || text[next] === '\n' || text[next] === '\r') next++;
        if (text[next] === ':') {
          const key = fold(JSON.parse(text.slice(i, end + 1)));
          if (keys.has(key)) return true;
          keys.add(key);
        }
      }
      i = end;
    }
  }
  return false;
}

// A body this server cannot read is refused rather than forwarded: the service might parse it more leniently.
function parseJson(buf, contentType) {
  if (!buf || !buf.length) return null;
  const text = buf.toString('utf8');
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    if (/^multipart\//i.test(String(contentType || ''))) return null;
    throw new HttpError(400, 'Corps JSON invalide');
  }
  if (hasDuplicateKeys(text)) throw new HttpError(400, 'Corps JSON invalide : clé répétée');
  return json;
}

// `rest` is the path after the API prefix (e.g. "movie/12"), without the query.
function authorizeArr({ role, method, rest, body, allowSearch, contentType }) {
  const segs = rest.split('/').filter(Boolean);
  const first = (segs[0] || '').toLowerCase();
  const m = method.toUpperCase();
  if (!first) throw forbidden('Chemin non autorisé');
  // The host settings carry the service's own API key: nobody gets them through this server, administrators included.
  if (first === 'config' && (segs[1] || '').toLowerCase() === 'host') throw forbidden('Chemin non autorisé');

  if (role !== 'admin') {
    let ok = false;
    if (first === 'system') ok = m === 'GET' && segs.length === 2 && ARR_SYSTEM_READ.has(segs[1].toLowerCase());
    else if (ARR_FULL.has(first)) ok = true;
    else if (first === 'tag') ok = m === 'GET' || (m === 'POST' && segs.length === 1);
    else if (ARR_READ.has(first)) ok = m === 'GET' || m === 'HEAD';
    if (!ok) throw forbidden();
  }

  if (m !== 'POST' && m !== 'PUT' && m !== 'PATCH') return;
  const json = parseJson(body, contentType);
  if (first === 'command' && m === 'POST') {
    // The service reads this property without regard to case and binds the whole body to the command it names:
    // only the plain `name`, spelled like a command, is accepted.
    const name = json && typeof json.name === 'string' ? json.name : '';
    if (!COMMAND_NAME.test(name)) throw new HttpError(400, 'Commande invalide');
    if (role !== 'admin' && !USER_COMMANDS.has(name)) throw forbidden('Commande réservée aux administrateurs');
    if (!allowSearch && SEARCH_COMMAND.test(name)) throw forbidden('Les recherches et synchronisations RSS sont désactivées (ALLOW_SEARCH_COMMANDS)');
  }
  if (!allowSearch && json && hasSearchFlag(json)) throw forbidden('Les recherches automatiques sont désactivées (ALLOW_SEARCH_COMMANDS)');
}

function authorizeQb({ role, rest }) {
  const m = QB_ENDPOINT.exec(String(rest));
  if (!m) throw forbidden('Chemin non autorisé');
  if (role === 'admin') return;
  const scope = m[1].toLowerCase();
  const action = m[2].toLowerCase();
  const ok = scope === 'auth' ? QB_USER_AUTH.has(action) : scope === 'app' ? QB_USER_APP.has(action) : QB_USER_SCOPES.has(scope);
  if (!ok) throw forbidden();
}

module.exports = { authorizeArr, authorizeQb, hasSearchFlag, USER_COMMANDS, ARR_FULL, ARR_READ };
