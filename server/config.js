'use strict';
const path = require('node:path');

const env = process.env;
const str = (name, d = '') => (env[name] == null ? d : String(env[name]).trim());
const bool = (name, d) => {
  const v = str(name);
  return v ? /^(1|true|yes|on)$/i.test(v) : d;
};
const int = (name, d, min, max) => {
  const v = parseInt(str(name), 10);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
};

function trustProxy() {
  const v = str('TRUST_PROXY');
  if (!v || /^(0|false|no|off)$/i.test(v)) return 0;
  if (/^\d+$/.test(v)) return Math.min(parseInt(v, 10), 10);
  return /^(true|yes|on)$/i.test(v) ? 1 : 0;
}

let publicUrl = null;
if (str('PUBLIC_URL')) {
  try {
    const u = new URL(str('PUBLIC_URL'));
    if (!/^https?:$/.test(u.protocol)) throw new Error('protocole');
    publicUrl = { origin: u.origin, host: u.host, secure: u.protocol === 'https:' };
  } catch {
    throw new Error('PUBLIC_URL invalide (exemple : https://arr.exemple.fr)');
  }
}

const cookieSecure = (str('COOKIE_SECURE', 'auto') || 'auto').toLowerCase();
if (!['auto', 'true', 'false'].includes(cookieSecure)) throw new Error('COOKIE_SECURE doit valoir auto, true ou false');

const SERVICES = ['qb', 'radarr', 'sonarr', 'lidarr'];

const seeds = {
  qb: { url: str('QBITTORRENT_URL'), username: str('QBITTORRENT_USERNAME'), password: env.QBITTORRENT_PASSWORD || '' },
  radarr: { url: str('RADARR_URL'), apiKey: str('RADARR_API_KEY') },
  sonarr: { url: str('SONARR_URL'), apiKey: str('SONARR_API_KEY') },
  lidarr: { url: str('LIDARR_URL'), apiKey: str('LIDARR_API_KEY') }
};

module.exports = {
  version: require('../package.json').version,
  SERVICES,
  port: int('PORT', 3000, 1, 65535),
  host: str('HOST', '0.0.0.0'),
  dataDir: path.resolve(str('DATA_DIR', path.join(process.cwd(), 'data'))),
  publicDir: path.join(__dirname, '..', 'public'),
  publicUrl,
  trustProxy: trustProxy(),
  cookieSecure,
  sessionSecret: env.SESSION_SECRET || '',
  sessionDays: int('SESSION_DAYS', 7, 1, 365),
  adminUser: str('ADMIN_USER'),
  adminPassword: env.ADMIN_PASSWORD || '',
  insecureUpstreamTls: bool('INSECURE_UPSTREAM_TLS', false),
  allowSearchCommands: bool('ALLOW_SEARCH_COMMANDS', false),
  logRequests: bool('LOG_REQUESTS', false),
  maxUploadBytes: int('MAX_UPLOAD_MB', 25, 1, 200) * 1024 * 1024,
  upstreamConnectMs: 20000,
  upstreamIdleMs: 60000,
  // Remote browser behind the C411 view (empty: the view is off and the C411 tab only offers the link to the site).
  c411: {
    browserUrl: str('C411_BROWSER_URL'),
    maxSessions: int('C411_MAX_SESSIONS', 3, 1, 20),
    idleMs: int('C411_IDLE_MINUTES', 15, 1, 240) * 60000,
    persistCookies: bool('C411_PERSIST_COOKIES', true),
    allowedHosts: str('C411_ALLOWED_HOSTS')
  },
  seeds
};
