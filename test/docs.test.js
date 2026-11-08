'use strict';
// Cohérence entre le code, le compose, le Dockerfile, .env.example et le README.
// Docker n'est pas disponible partout : on relit les fichiers pour repérer les dérives.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { prepareEnv } = require('./helpers');

prepareEnv();
const config = require('../server/config');

const root = path.join(__dirname, '..');
// Les fichiers peuvent être en CRLF ou en LF selon le système de l'auteur.
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n?/g, '\n');

const compose = read('docker-compose.yml');
const dockerfile = read('Dockerfile').replace(/\\\n\s*/g, ' ');
const example = read('.env.example');
const readme = read('README.md');
const workflow = read('.github', 'workflows', 'docker.yml');
const pkg = JSON.parse(read('package.json'));
// Une image publiée par service construit : [nom de l'image, contexte de construction].
const matrix = [...workflow.matchAll(/^\s+- image: ([\w-]+)\n\s+context: (\S+)/gm)].map((m) => [m[1], m[2]]);

// Lignes plus indentées que la ligne d'en-tête donnée (YAML).
function block(text, header) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.trim() === header);
  assert.ok(i >= 0, `« ${header} » introuvable`);
  const indent = lines[i].search(/\S/);
  const out = [];
  for (const l of lines.slice(i + 1)) {
    if (l.trim() && l.search(/\S/) <= indent) break;
    out.push(l);
  }
  return out;
}

const configSrc = read('server', 'config.js');
const configVars = new Set([
  ...[...configSrc.matchAll(/\b(?:str|int|bool)\(\s*'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]),
  ...[...configSrc.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1])
]);
const FROM_IMAGE = new Set(['PORT', 'HOST', 'DATA_DIR']);
// Lues par le compose seulement : TZ et BROWSER_HEADLESS vont au conteneur « browser », BIND_ADDRESS au port publié.
const COMPOSE_ONLY = new Set(['HOST_PORT', 'BIND_ADDRESS', 'DOMAIN', 'TZ', 'BROWSER_HEADLESS']);
const userVars = [...configVars].filter((v) => !FROM_IMAGE.has(v));

// « ${NOM:-défaut} » (vide = défaut) ou « ${NOM-défaut} » (le défaut ne sert que si NOM n'est pas définie : vide reste vide).
const composeEnv = {};
for (const l of block(compose, 'environment:')) {
  if (!l.trim() || l.trim().startsWith('#')) continue;
  const m = l.match(/^\s+([A-Z][A-Z0-9_]*):\s*\$\{([A-Z][A-Z0-9_]*)(?::?-([^}]*))?\}\s*$/);
  assert.ok(m, `ligne inattendue dans environment : ${l.trim()}`);
  composeEnv[m[1]] = { ref: m[2], dflt: m[3] || '' };
}

const exampleVars = {};
for (const l of example.split('\n')) {
  const m = l.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (m) exampleVars[m[1]] = m[2];
}

const services = block(compose, 'services:').map((l) => /^ {2}([\w-]+):\s*$/.exec(l)?.[1]).filter(Boolean);

// Lignes d'un service (les services sont indentés de 2 espaces) et éléments d'une de ses listes (null si la clé est absente).
function service(name) {
  const lines = compose.split('\n');
  const i = lines.findIndex((l) => new RegExp(`^ {2}${name}:\\s*$`).test(l));
  assert.ok(i >= 0, `service « ${name} » introuvable`);
  const out = [];
  for (const l of lines.slice(i + 1)) {
    if (l.trim() && l.search(/\S/) <= 2) break;
    out.push(l);
  }
  return out;
}
function listOf(lines, key) {
  const i = lines.findIndex((l) => new RegExp(`^ {4}${key}:\\s*$`).test(l));
  if (i < 0) return null;
  const out = [];
  for (const l of lines.slice(i + 1)) {
    const m = /^ {6}- (.*?)\s*$/.exec(l);
    if (m) out.push(m[1].replace(/^["']|["']$/g, ''));
    else if (l.trim() && !l.trim().startsWith('#')) break;
  }
  return out;
}
const has = (lines, re) => lines.some((l) => re.test(l));

test('config.js, compose et Dockerfile : mêmes variables', () => {
  assert.ok(configVars.size >= 20, 'extraction des variables de config.js');
  for (const v of userVars) {
    assert.ok(composeEnv[v], `${v} n'est pas transmise par le compose`);
    assert.equal(composeEnv[v].ref, v, `${v} : le compose référence une autre variable`);
  }
  for (const v of Object.keys(composeEnv)) assert.ok(userVars.includes(v), `${v} est transmise mais jamais lue`);

  // Le conteneur écoute sur toutes les interfaces, sinon le port publié ne répond pas.
  const host = /\bHOST=(\S+)/.exec(dockerfile)?.[1] || config.host;
  assert.equal(host, '0.0.0.0');
  assert.equal(/\bDATA_DIR=(\S+)/.exec(dockerfile)?.[1], '/data');
  assert.ok(/\bPORT=\d+/.test(dockerfile), 'PORT absent du Dockerfile');
});

test('valeurs par défaut identiques dans le compose, .env.example et le code', () => {
  assert.deepEqual(Object.keys(exampleVars).sort(), [...userVars, ...COMPOSE_ONLY].sort());
  for (const [name, e] of Object.entries(composeEnv)) {
    assert.equal(exampleVars[name], e.dflt, `${name} : défaut différent entre .env.example et le compose`);
  }
  assert.equal(exampleVars.HOST_PORT, /\$\{HOST_PORT:-(\d+)\}/.exec(compose)?.[1]);

  const d = (name) => composeEnv[name].dflt;
  assert.equal(Number(d('SESSION_DAYS')), config.sessionDays);
  assert.equal(Number(d('MAX_UPLOAD_MB')) * 1024 * 1024, config.maxUploadBytes);
  assert.equal(Number(d('TRUST_PROXY')), config.trustProxy);
  assert.equal(d('COOKIE_SECURE'), config.cookieSecure);
  assert.equal(d('INSECURE_UPSTREAM_TLS') === 'true', config.insecureUpstreamTls);
  assert.equal(d('ALLOW_SEARCH_COMMANDS') === 'true', config.allowSearchCommands);
  assert.equal(d('LOG_REQUESTS') === 'true', config.logRequests);

  assert.equal(Number(d('C411_MAX_SESSIONS')), config.c411.maxSessions);
  assert.equal(Number(d('C411_IDLE_MINUTES')) * 60000, config.c411.idleMs);
  assert.equal(d('C411_PERSIST_COOKIES') === 'true', config.c411.persistCookies);
  assert.equal(d('C411_ALLOWED_HOSTS'), config.c411.allowedHosts);
  // Sans variable définie, la vue est désactivée ; le compose, lui, la branche sur le service « browser ».
  assert.equal(config.c411.browserUrl, '');
  for (const v of ['TZ', 'BROWSER_HEADLESS', 'BIND_ADDRESS']) {
    const dflt = new RegExp(`\\$\\{${v}:-([^}]*)\\}`).exec(compose)?.[1];
    assert.ok(dflt, `${v} : défaut absent du compose`);
    assert.equal(exampleVars[v], dflt, `${v} : défaut différent entre .env.example et le compose`);
  }
  // Le port de l'application est publié via BIND_ADDRESS : l'accès direct reste réservé à la machine quand on le demande.
  assert.deepEqual(
    listOf(service('arr411'), 'ports'),
    ['${BIND_ADDRESS:-0.0.0.0}:${HOST_PORT:-' + exampleVars.HOST_PORT + '}:3000'],
    'arr411 : le port doit être publié avec BIND_ADDRESS'
  );
});

test('README : chaque variable est documentée et le tableau ne cite que des variables existantes', () => {
  const known = new Set([...configVars, ...COMPOSE_ONLY]);
  const documented = (v) => readme.includes('`' + v + '`') || readme.includes('`' + v.split('_')[0] + '_*`');
  for (const v of known) assert.ok(documented(v), `${v} n'est pas documentée dans le README`);

  const section = readme.split(/^## Variables d'environnement$/m)[1]?.split(/^## /m)[0] || '';
  let rows = 0;
  for (const row of section.matchAll(/^\| (`[^|]+?) \| /gm)) {
    rows++;
    for (const t of row[1].matchAll(/`([A-Z][A-Z0-9_]*)(_\*)?`/g)) {
      const [, name, star] = t;
      const ok = star ? [...known].some((v) => v.startsWith(name + '_')) : known.has(name);
      assert.ok(ok, `${name} est citée dans le tableau du README mais n'existe pas`);
    }
  }
  assert.ok(rows >= 10, 'tableau des variables introuvable');
});

test('ports, services et volumes : mêmes valeurs partout', () => {
  assert.ok(['arr411', 'browser', 'egress', 'caddy'].every((s) => services.includes(s)), `services : ${services}`);
  // Ce test lit le premier bloc « environment: » du compose : c'est celui d'arr411.
  assert.equal(services[0], 'arr411');
  const port = /\$\{HOST_PORT:-\d+\}:(\d+)/.exec(compose)?.[1];
  assert.ok(port, 'port interne du compose');
  assert.equal(/\bPORT=(\d+)/.exec(dockerfile)?.[1], port, 'ENV PORT du Dockerfile');
  assert.equal(/^EXPOSE (\d+)/m.exec(dockerfile)?.[1], port, 'EXPOSE du Dockerfile');
  const to = /--to ([\w-]+):(\d+)/.exec(compose);
  assert.ok(to, 'cible de Caddy');
  assert.ok(services.includes(to[1]), 'Caddy vise un service inexistant');
  assert.equal(to[2], port, 'Caddy vise un autre port');

  let commands = 0;
  for (const [name, text] of [['README', readme], ['compose', compose], ['.env.example', example]]) {
    for (const m of text.matchAll(/docker compose (?:exec|logs)(?: -\S+)* ([a-z][\w-]*)/g)) {
      commands++;
      assert.ok(services.includes(m[1]), `${name} : service inconnu « ${m[1]} »`);
    }
  }
  assert.ok(commands >= 5, 'commandes docker compose introuvables');

  const project = /^name:\s*(\S+)/m.exec(compose)?.[1];
  const volume = block(compose, 'arr411:').map((l) => /^\s+-\s*([\w.-]+):\/data\s*$/.exec(l)?.[1]).find(Boolean);
  assert.ok(project && volume, 'nom du projet ou du volume');
  assert.ok(readme.includes(`${project}_${volume}:/data`), 'README : nom du volume dans la commande de sauvegarde');
  assert.ok(readme.includes('`' + volume + ':/data`'), 'README : volume à remplacer par un dossier local');
  assert.ok(/^VOLUME \/data$/m.test(dockerfile), 'VOLUME du Dockerfile');

  // Une image publiée par service construit ; le README donne le nom exact de chacune.
  assert.deepEqual(matrix, [['arr411-web', '.'], ['arr411-browser', './browser']], 'matrice d\'images du workflow');
  assert.ok(/context: \$\{\{ matrix\.context \}\}/.test(workflow), 'le workflow construit le contexte de la matrice');
  assert.ok(workflow.includes('/${{ matrix.image }}'), 'le workflow nomme l\'image d\'après la matrice');
  for (const [image, context] of matrix) {
    assert.ok(readme.includes(`/${image}:latest`), `README : image ${image}`);
    assert.ok(fs.existsSync(path.join(root, context, 'Dockerfile')), `${context}/Dockerfile`);
  }
  assert.ok(!/TON-COMPTE|VOTRE-COMPTE/i.test(readme), 'README : compte GitHub à renseigner');
  assert.equal(/^\s+build:\s*(\S+)/m.exec(service('arr411').join('\n'))?.[1], '.');
  assert.equal(/^\s+build:\s*(\S+)/m.exec(service('egress').join('\n'))?.[1], '.');
  assert.equal(/^\s+build:\s*(\S+)/m.exec(service('browser').join('\n'))?.[1], './browser');
});

test('docker-compose.ghcr.yml : le compose du dépôt, avec les images publiées à la place des constructions', () => {
  const significant = (text) => text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  const published = read('docker-compose.ghcr.yml');
  const owner = /\bimage: ghcr\.io\/([a-z0-9-]+)\//.exec(published)?.[1];
  assert.ok(owner, 'compte GitHub (en minuscules) des images');

  const derived = significant(compose).map((line) => {
    const build = /^ {4}build:\s*(\S+)\s*$/.exec(line);
    if (!build) return line;
    const image = matrix.find(([, context]) => context === build[1]);
    assert.ok(image, `contexte « ${build[1]} » absent de la matrice du workflow`);
    return `    image: ghcr.io/${owner}/${image[0]}:latest`;
  });
  assert.deepEqual(significant(published), derived, 'docker-compose.ghcr.yml doit rester identique à docker-compose.yml (image: à la place de build:)');

  for (const [image] of matrix) assert.ok(readme.includes(`ghcr.io/${owner}/${image}:latest`), `README : ghcr.io/${owner}/${image}:latest`);
  assert.ok(readme.includes('docker-compose.ghcr.yml'), 'README : compose à partager');
});

test('workflow : Docker Hub est facultatif, et une pull request ne publie rien', () => {
  const hubLogins = workflow.split(/^ {6}- /m).filter((step) => step.includes('docker/login-action') && !step.includes('registry:'));
  assert.equal(hubLogins.length, 1, 'une seule connexion à Docker Hub');
  assert.ok(hubLogins[0].includes("github.event_name != 'pull_request'"), 'pas de connexion à Docker Hub depuis une pull request');
  assert.ok(hubLogins[0].includes("env.DOCKERHUB_USERNAME != ''"), 'sans identifiant Docker Hub, pas de connexion');
  assert.ok(hubLogins[0].includes('password: ${{ secrets.DOCKERHUB_TOKEN }}'), 'le jeton Docker Hub vient des secrets');
  assert.ok(workflow.includes('"${DOCKERHUB_USERNAME,,}/${{ matrix.image }}"'), 'image Docker Hub nommée d\'après la matrice, en minuscules');
  assert.ok(workflow.includes('images: ${{ env.IMAGES }}'), 'les noms d\'images viennent de l\'étape qui les prépare');
  assert.ok(/push: \$\{\{ github\.event_name != 'pull_request' \}\}/.test(workflow), 'une pull request construit sans publier');
  for (const name of ['DOCKERHUB_USERNAME', 'DOCKERHUB_TOKEN']) assert.ok(readme.includes('`' + name + '`'), `README : ${name}`);
});

test('vue C411 : le navigateur n\'a aucune route vers Internet, seul le proxy de sortie en a une', () => {
  const entrypoint = read('browser', 'entrypoint.sh');
  const browserDockerfile = read('browser', 'Dockerfile');
  const egressSource = read('server', 'egress.js');

  // Les deux réseaux du navigateur n'ont pas de passerelle vers l'extérieur.
  const composeLines = compose.split('\n');
  const declared = {};
  let current = null;
  for (const l of composeLines.slice(composeLines.findIndex((x) => /^networks:\s*$/.test(x)) + 1)) {
    if (l.trim() && !l.startsWith(' ') && !l.startsWith('#')) break;
    const n = /^ {2}([\w-]+):\s*$/.exec(l);
    if (n) declared[(current = n[1])] = false;
    else if (current && /^ {4}internal:\s*true\s*$/.test(l)) declared[current] = true;
  }
  assert.deepEqual(declared, { 'c411-control': true, 'c411-egress': true });

  // arr411 pilote le navigateur (c411-control) ; seul le navigateur touche aussi le réseau du proxy de sortie.
  const nets = (s) => [...(listOf(service(s), 'networks') || ['default'])].sort();
  assert.deepEqual(nets('browser'), ['c411-control', 'c411-egress']);
  assert.deepEqual(nets('egress'), ['c411-egress', 'default']);
  assert.deepEqual(nets('arr411'), ['c411-control', 'default']);
  assert.deepEqual(nets('caddy'), ['default']);

  // Aucun port publié, sauf pour l'application (et Caddy, qui est optionnel).
  for (const s of services) {
    assert.equal(listOf(service(s), 'ports') !== null, s === 'arr411' || s === 'caddy', `${s} : ports publiés`);
  }

  // Les deux conteneurs de la vue n'ont ni secret, ni volume, ni accès à l'hôte ; leur environnement est minimal.
  const envKeys = (s) => {
    const lines = service(s);
    const i = lines.findIndex((l) => /^ {4}environment:\s*$/.test(l));
    const keys = [];
    for (const l of lines.slice(i + 1)) {
      const m = /^ {6}([A-Z][A-Z0-9_]*):/.exec(l);
      if (m) keys.push(m[1]);
      else if (l.trim() && !l.trim().startsWith('#')) break;
    }
    return keys.sort();
  };
  assert.deepEqual(envKeys('browser'), ['BROWSER_HEADLESS', 'EGRESS_PROXY', 'TZ']);
  assert.deepEqual(envKeys('egress'), ['C411_ALLOWED_HOSTS']);
  for (const s of ['browser', 'egress']) {
    for (const key of ['volumes', 'extra_hosts', 'secrets', 'configs', 'env_file', 'privileged', 'devices', 'cap_add', 'pid', 'network_mode']) {
      assert.ok(!has(service(s), new RegExp(`^ {4}${key}:`)), `${s} : « ${key} » ne doit pas être défini`);
    }
  }
  assert.equal(composeEnv.C411_ALLOWED_HOSTS.ref, 'C411_ALLOWED_HOSTS');
  assert.ok(has(service('egress'), /^ {6}C411_ALLOWED_HOSTS:\s*\$\{C411_ALLOWED_HOSTS:-\}\s*$/), 'egress et arr411 doivent lire la même liste');

  // Durcissement : système de fichiers en lecture seule, aucune capacité, pas d'élévation de privilèges.
  for (const s of ['arr411', 'browser', 'egress']) {
    const svc = service(s);
    assert.ok(has(svc, /^ {4}read_only:\s*true\s*$/), `${s} : read_only`);
    assert.deepEqual(listOf(svc, 'cap_drop'), ['ALL'], `${s} : cap_drop`);
    assert.ok((listOf(svc, 'security_opt') || []).includes('no-new-privileges:true'), `${s} : no-new-privileges`);
  }
  assert.ok(has(service('browser'), /^ {4}shm_size:/), 'browser : /dev/shm trop petit pour Chromium sans shm_size');

  // Les adresses internes visent un service qui existe, sur le port que ce service écoute.
  const browserUrl = new URL(composeEnv.C411_BROWSER_URL.dflt);
  assert.ok(services.includes(browserUrl.hostname), 'C411_BROWSER_URL vise un service inexistant');
  assert.equal(browserUrl.port, /^EXPOSE (\d+)/m.exec(browserDockerfile)?.[1], 'port DevTools : EXPOSE du Dockerfile du navigateur');
  assert.ok(new RegExp(`TCP-LISTEN:${browserUrl.port}[, ]`).test(entrypoint), 'port DevTools : relais de l\'entrypoint');
  assert.ok(browserDockerfile.includes(`/dev/tcp/127.0.0.1/${browserUrl.port}`), 'port DevTools : contrôle de santé');

  const proxyUrl = new URL(/^\s+EGRESS_PROXY:\s*(\S+)\s*$/m.exec(service('browser').join('\n'))?.[1]);
  assert.ok(services.includes(proxyUrl.hostname), 'EGRESS_PROXY vise un service inexistant');
  assert.equal(proxyUrl.port, /rawPort === '' \? (\d+)/.exec(egressSource)?.[1], 'port du proxy de sortie : valeur par défaut d\'egress.js');
  assert.ok(entrypoint.includes(`EGRESS_PROXY:-${proxyUrl.origin}`), 'l\'entrypoint doit avoir la même valeur par défaut');
  assert.ok(service('egress').join('\n').includes(`connect(${proxyUrl.port},`), 'egress : contrôle de santé sur un autre port');
  assert.ok(/^\s+command:\s*\["node", "server\/egress\.js"\]\s*$/m.test(service('egress').join('\n')));
  assert.ok(fs.existsSync(path.join(root, 'server', 'egress.js')));

  // Le navigateur ne démarre qu'une fois le proxy de sortie prêt ; arr411 n'en dépend pas (il doit démarrer sans le navigateur).
  assert.ok(/^ {6}egress:\n {8}condition: service_healthy$/m.test(service('browser').join('\n')), 'browser dépend d\'egress (healthy)');
  assert.ok(!has(service('arr411'), /^ {4}depends_on:/), 'arr411 ne doit pas dépendre du navigateur');
  assert.ok(has(service('egress'), /^ {4}healthcheck:/), 'egress : contrôle de santé');
  assert.ok(/^HEALTHCHECK /m.test(browserDockerfile), 'navigateur : contrôle de santé');

  // Entrypoint : jamais de port publié par Chromium lui-même ni de contournement du proxy.
  assert.ok(entrypoint.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(entrypoint.includes('--proxy-bypass-list="<-loopback>"'), 'même le loopback passe par le proxy');
  assert.ok(/--host-resolver-rules="MAP \* ~NOTFOUND , EXCLUDE \$PROXY_HOST"/.test(entrypoint), 'aucune résolution DNS directe');
  assert.ok(!/--disable-web-security|--disable-site-isolation|--allow-running-insecure|--ignore-certificate-errors/.test(entrypoint));
  assert.ok(/^USER browser$/m.test(browserDockerfile), 'le navigateur ne doit pas tourner en root');
});

test('secrets et données hors du dépôt et de l\'image, versions de Node alignées', () => {
  for (const f of ['.gitignore', '.dockerignore']) {
    const lines = read(f).split('\n').map((l) => l.trim());
    assert.ok(lines.includes('.env'), `${f} : .env`);
    assert.ok(lines.some((l) => /^data\/?$/.test(l)), `${f} : data`);
  }
  assert.ok(!/^COPY\s+\.\s/m.test(dockerfile), 'COPY . . embarquerait .env et data');
  assert.ok(/^USER node$/m.test(dockerfile), 'le conteneur doit tourner sans privilèges');

  assert.equal(pkg.license, 'MIT');
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.ok(/Heroicons/.test(notices) && /Tailwind Labs/.test(notices), 'THIRD_PARTY_NOTICES.md : Heroicons');
  assert.ok(/Heroicons/.test(read('public', 'app', 'icons.js').split('\n')[0]), 'icons.js : mention de Heroicons');

  const major = /^FROM node:(\d+)/m.exec(dockerfile)?.[1];
  assert.ok(Number(major) >= Number(/(\d+)/.exec(pkg.engines.node)[1]), 'image plus ancienne que engines.node');
  assert.equal(/node-version:\s*(\d+)/.exec(workflow)?.[1], major, 'version de Node du workflow');
});
