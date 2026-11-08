# Arr411 Web

La version web de **Arr411** : qBittorrent, Radarr, Sonarr et Lidarr dans une seule interface (mobile et bureau), **avec C411 intégré**, à héberger chez toi avec Docker.

- **Connexion par formulaire** : seuls les comptes que tu crées peuvent entrer. Pas d'inscription libre.
- **Les identifiants des services restent sur le serveur** (mot de passe qBittorrent, clés API). Le navigateur ne les voit jamais.
- Deux rôles : **administrateur** (connexions, comptes, réglages) et **utilisateur** (bibliothèques et torrents).
- **C411 intégré** : l'onglet C411 affiche le site dans l'application (pas une redirection), avec les boutons d'envoi vers qBittorrent, Radarr, Sonarr et Lidarr que l'extension Chrome ajoute. Tu te connectes toi-même sur c411.org.
- Même règle que l'application Android et l'extension : rien n'est ajouté en « surveillé », aucune recherche ni synchro RSS n'est lancée.
- Installable comme application (PWA), avec une page de partage pour les liens magnet, TMDB, IMDb, TheTVDB et MusicBrainz.
- Aucune dépendance à installer : Node 22 uniquement pour l'application, dans une image Docker légère (Alpine).

Le compose démarre trois conteneurs, plus un quatrième si tu le demandes :

| Conteneur | Rôle | Port publié |
| --- | --- | --- |
| `arr411` | L'application : interface, comptes, accès à tes services | `HOST_PORT` (3000) |
| `browser` | Chromium sur un écran virtuel : il affiche c411.org dans la vue C411 | aucun |
| `egress` | Seule sortie du navigateur : tunnels HTTPS vers c411.org, rien d'autre | aucun |
| `caddy` | HTTPS automatique (facultatif, profil `https`) | 80 et 443 |

## Démarrage rapide

Prérequis : Docker avec Compose v2 (la commande `docker compose`).

```bash
cp .env.example .env          # facultatif : tout se règle aussi dans l'interface
docker compose up -d --build
docker compose logs arr411    # mot de passe de l'administrateur (affiché une seule fois)
```

La première construction télécharge Chromium (l'image `browser`) : compte quelques minutes.
`docker compose ps` affiche `healthy` pour chaque conteneur quand tout répond (contrôles de santé intégrés).

Ouvre <http://localhost:3000> (ou l'adresse de ta machine) et connecte-toi avec le compte `admin`.
Puis, dans **Réglages**, change le mot de passe et renseigne les adresses de tes services.

Pour choisir toi-même le mot de passe du premier compte, mets `ADMIN_USER` et `ADMIN_PASSWORD` dans `.env` **avant** le premier démarrage.

Tu n'as pas besoin de C411 ? Voir [Désactiver la vue C411](#désactiver-la-vue-c411).

## Comptes : qui peut se connecter

Seuls les comptes enregistrés ont accès. Tout le reste (page, application, API, vue C411) répond « connexion requise ».

| Où | Comment |
| --- | --- |
| Interface | **Réglages > Utilisateurs** (administrateur) : ajouter, changer un mot de passe, désactiver, supprimer, changer le rôle. |
| Ligne de commande | `docker compose exec arr411 node server/cli.js <commande>` |

```bash
docker compose exec arr411 node server/cli.js list
docker compose exec arr411 node server/cli.js add alice            # mot de passe généré et affiché
docker compose exec arr411 node server/cli.js add bob --admin --password "un mot de passe long"
docker compose exec arr411 node server/cli.js passwd alice
docker compose exec arr411 node server/cli.js disable alice        # bloque la connexion (aussi pour les sessions ouvertes)
docker compose exec arr411 node server/cli.js enable alice
docker compose exec arr411 node server/cli.js role alice admin     # ou « user »
docker compose exec arr411 node server/cli.js remove alice
```

Mot de passe oublié ? `docker compose exec arr411 node server/cli.js passwd admin`. N'utilise pas `-u root` : le volume appartient à l'utilisateur `node`.
Le serveur en marche prend en compte ces changements en une seconde environ (un compte désactivé ou dont le mot de passe change est déconnecté). `node server/cli.js --help` liste les commandes.

Règles : identifiant de 2 à 64 caractères (`a-z`, `0-9`, `.`, `_`, `-`, `@`), mot de passe de 8 à 256 caractères, au moins un administrateur actif à tout moment, et on ne peut pas se supprimer, se désactiver ou changer son propre rôle.

| | Utilisateur | Administrateur |
| --- | :---: | :---: |
| Films, séries, artistes, albums : consulter, ajouter, modifier, supprimer ; files d'attente, historique, calendrier, import manuel | oui | oui |
| Torrents : liste, ajout, pause, suppression, catégories, étiquettes, limites | oui | oui |
| Vue C411 (avec ses boutons d'envoi) | oui | oui |
| Préférences qBittorrent, journal, recherche, RSS | non | oui |
| Réglages des services Radarr / Sonarr / Lidarr (profils, dossiers, clients…) | non | oui |
| Connexions aux services, valeurs par défaut, comptes | non | oui |

Un utilisateur ne peut lancer que des commandes sans danger (rafraîchir, renommer, rescanner, import manuel…). Les recherches automatiques et les synchros RSS sont bloquées pour tout le monde, administrateurs compris, sauf si tu définis `ALLOW_SEARCH_COMMANDS=true`. Les boutons de la vue C411 obéissent aux mêmes règles que le reste de l'application.

## Connexions aux services

Dans **Réglages** (administrateur), ou par variables d'environnement lues au démarrage (`QBITTORRENT_URL`, `QBITTORRENT_USERNAME`, `QBITTORRENT_PASSWORD`, `RADARR_URL`, `RADARR_API_KEY`, etc.).
Les variables ne remplissent que les services **jamais enregistrés** : dès qu'un administrateur enregistre ou supprime une connexion dans Réglages, c'est l'interface qui fait foi (une connexion supprimée ne revient pas au redémarrage).

L'adresse doit commencer par `http://` ou `https://`. Depuis le conteneur, **`localhost` désigne le conteneur lui-même** :

| Ton service tourne… | Adresse à utiliser |
| --- | --- |
| dans un autre conteneur du même réseau compose | `http://qbittorrent:8080` (nom du service) |
| sur la machine hôte | `http://host.docker.internal:8080` (déjà déclaré dans le compose) |
| ailleurs | l'adresse IP ou le nom de domaine habituel |

Certificat auto-signé : `INSECURE_UPSTREAM_TLS=true`.

Si tu changes le serveur d'un service (adresse ou port) dans Réglages, ressaisis aussi son mot de passe ou sa clé API : un secret enregistré n'est jamais envoyé vers un autre serveur. Le bouton **Déconnecter** (ou une adresse vide) supprime la connexion pour tous les utilisateurs.

## Vue C411 intégrée

L'onglet **C411** affiche c411.org *dans* Arr411, sans redirection : tu navigues sur le vrai site, avec ses vraies pages, et Arr411 y ajoute les boutons de l'extension Chrome.

**Pourquoi pas une simple iframe ?** c411.org refuse d'être encadré par un autre site et protège ses pages par une vérification anti-robot (Cloudflare Turnstile) : on ne peut ni l'intégrer ni le recopier sans casser la page. Arr411 fait donc ce que fait un bureau à distance : un vrai Chromium (le conteneur `browser`) ouvre le site côté serveur, son image est diffusée dans l'onglet (un `<canvas>`), et tes clics et ta saisie lui sont renvoyés. Pour tes services, rien ne change : ils ne passent jamais par ce navigateur.

**Tu te connectes toi-même sur c411.org**, dans la vue. Arr411 ne connaît pas ton compte c411.org, ne le remplit jamais et ne tente aucun contournement de la vérification anti-robot. Ta saisie transite par le serveur (comme avec n'importe quel bureau à distance) : elle n'est ni enregistrée ni journalisée.

### Les boutons de l'extension, dans la page

Arr411 injecte dans les pages de c411.org (et seulement elles) ce que fait l'extension :

- un bouton **qBittorrent** sur la page d'un torrent et près de l'icône de téléchargement des listes. Il ouvre le dialogue « Envoyer à qBittorrent » : catégorie, ajout en pause, et « Ajouter à » **Radarr** (film), **Sonarr** (série) ou **Lidarr** (musique : artiste ou album) ;
- des pastilles d'état : « Déjà dans qBittorrent », « Radarr : fichier présent », « Sonarr : … ép. », « Lidarr : n/m pistes » ;
- les mêmes règles qu'Android : rien n'est ajouté en « surveillé », aucune recherche automatique.

Le fichier `.torrent` est lu par la page, avec ta session c411.org, puis transmis au serveur, qui l'envoie à qBittorrent avec les identifiants qu'il garde : ils n'arrivent jamais dans le navigateur. Un envoi n'est accepté que juste après une vraie interaction dans la vue (60 secondes au plus) : une page ne peut pas en déclencher un toute seule.

Les boutons « Chercher sur C411 » et « Voir la fiche sur C411 » du reste de l'application, comme les liens c411.org partagés vers Arr411, ouvrent directement la page dans cette vue.

### Utilisation

- Sur ordinateur : clic, molette, clavier. Sur téléphone : touche pour cliquer, glisse pour défiler, bouton **clavier** de la barre pour saisir. La page distante prend la taille de ton écran.
- La barre du haut : page précédente et suivante, recharger, accueil C411, **Ajout rapide** (lien magnet, fichier `.torrent`, lien IMDb, TMDB, TheTVDB ou MusicBrainz) et clavier. L'adresse affichée n'est pas modifiable : on navigue dans le site, pas ailleurs.
- **Une seule vue active par compte** : si tu ouvres C411 sur un autre appareil, la première vue affiche « Ouvert ailleurs » (bouton « Reprendre ici »).
- Le flux s'arrête 10 secondes après que tu as quitté l'onglet (30 secondes si la page est cachée). Le navigateur distant continue, avec tes pages ouvertes, jusqu'à `C411_IDLE_MINUTES` minutes d'inactivité : « Session fermée », bouton « Rouvrir ».
- Chaque utilisateur a son propre contexte de navigation (cookies et stockage séparés) dans le même Chromium. Quand la limite `C411_MAX_SESSIONS` est atteinte, le navigateur le plus ancien dont personne ne regarde la vue est fermé ; si tous sont en cours d'utilisation, la personne qui arrive voit « Serveur occupé ».

### Réglages

| Variable | Effet |
| --- | --- |
| `C411_BROWSER_URL` | Adresse du navigateur distant (le compose la branche sur `http://browser:9223`). **Vide : vue désactivée.** |
| `C411_MAX_SESSIONS` | Navigateurs ouverts en même temps, un par utilisateur : 3 par défaut (de 1 à 20). Chromium est gourmand : le conteneur est limité à 2 Go (`mem_limit` du compose), garde une valeur basse sur un petit serveur. |
| `C411_IDLE_MINUTES` | Inactivité avant la fermeture du navigateur d'un utilisateur : 15 par défaut (de 1 à 240). Le flux d'une vue ouverte ne compte pas comme une activité. |
| `C411_PERSIST_COOKIES` | `true` (défaut) : ta connexion à c411.org est gardée, pour ne pas te reconnecter à chaque ouverture. `false` : rien n'est gardé. |
| `C411_ALLOWED_HOSTS` | Sites joignables **en plus** de c411.org, de ses sous-domaines et de la vérification Cloudflare : noms séparés par des virgules (`exemple.org`, `*.exemple.org`). `*` autorise tout site public : à éviter. |
| `TZ` | Fuseau horaire du navigateur (dates affichées par c411.org) : `Europe/Paris` par défaut. |
| `BROWSER_HEADLESS` | `1` : Chromium sans écran virtuel. Repli si le navigateur ne démarre pas avec l'écran virtuel. |

Une page qui reste vide ou « Adresse bloquée » ? Le site a besoin d'un hôte qui n'est pas autorisé : `docker compose logs egress` indique ce qui est refusé, puis ajoute-le à `C411_ALLOWED_HOSTS`.

**Ta connexion à c411.org** (`C411_PERSIST_COOKIES=true`) est gardée en clair dans le volume, dans `/data/c411` (droits `600`), **par compte Arr411** : un fichier par compte, que seul ce compte retrouve. Elle est liée au compte (identifiant et date de création) : un nouveau compte portant le même nom qu'un compte supprimé ne la retrouve pas. Elle est effacée quand le compte est supprimé, désactivé, ou que son mot de passe est changé par un administrateur : tout de suite depuis l'interface ; depuis la ligne de commande, la vue se ferme en 15 secondes environ et les fichiers sont nettoyés au démarrage ou dans l'heure. Un changement de mot de passe personnel garde la connexion c411.org et déconnecte seulement les autres appareils.

### Désactiver la vue C411

Mets `C411_BROWSER_URL=` (vide) dans `.env`, puis ne démarre que l'application :

```bash
docker compose up -d --build arr411
docker compose rm -sf browser egress    # seulement s'ils tournaient déjà
```

L'onglet C411 devient alors un lanceur : recherche (ouverte dans un nouvel onglet) et ajout rapide, sans les boutons injectés. Rien d'autre ne change.

### Limites

- L'image est diffusée en JPEG : le texte est un peu moins net que dans un vrai navigateur, surtout sur un écran haute densité. Le curseur affiché est celui de ton navigateur.
- Seuls le clic gauche, le défilement, la saisie et quelques raccourcis d'édition (tout sélectionner, annuler, rétablir) sont transmis : pas de menu clic droit, pas de raccourcis du navigateur. Tab et Échap vont à la page distante.
- Coller du texte fonctionne (5 000 caractères au plus). Copier depuis la page distante ne fonctionne pas : le presse-papiers du navigateur distant est partagé par tous ceux qui l'utilisent, il n'est volontairement pas relié au tien.
- Les listes déroulantes natives (`<select>`) du site ne s'affichent pas dans le flux (la fenêtre d'envoi d'Arr411 montre ses listes déjà ouvertes). Les `alert` sont acceptées automatiquement, les autres boîtes de dialogue refusées ; les sélecteurs de fichiers sont désactivés.
- Les téléchargements du navigateur distant sont refusés : seul le bouton d'envoi transmet un `.torrent`, à qBittorrent. Les fenêtres surgissantes sont fermées ; si leur adresse est autorisée, elle s'ouvre dans l'onglet courant.
- Le stockage local des sites (`localStorage`) n'est pas conservé entre deux sessions : seuls les cookies le sont.
- La vérification Cloudflare de c411.org peut refuser un Chrome piloté à distance. Arr411 ne la contourne pas : réessaie, ou connecte-toi sur c411.org avec ton navigateur habituel en attendant.

## HTTPS et reverse proxy

Sans HTTPS, les mots de passe et le cookie de session circulent en clair. Utilise HTTP seulement sur un réseau de confiance.
Pour un accès depuis Internet, mets l'application derrière un reverse proxy HTTPS, puis renseigne dans `.env` :

```ini
PUBLIC_URL=https://arr.exemple.fr   # sans « / » final
TRUST_PROXY=1                       # un seul reverse proxy devant l'application
BIND_ADDRESS=127.0.0.1              # le port de l'application n'est plus joignable que depuis la machine
```

`TRUST_PROXY` autorise l'application à lire `X-Forwarded-For`, `X-Forwarded-Proto` et `X-Forwarded-Host` (adresse réelle des clients, cookie `Secure`, vérification de l'origine). Ne l'active que si un proxy de confiance est bien devant : sinon n'importe qui peut falsifier ces en-têtes.

`BIND_ADDRESS=127.0.0.1` en est le complément : le proxy, sur la même machine, devient le seul à joindre le port de l'application. Sans lui, quelqu'un qui atteint directement `http://ta-machine:3000` contourne le proxy et le HTTPS, et peut écrire l'adresse de son choix dans `X-Forwarded-For` : les limites de tentatives de connexion par adresse (5 et 10 échecs) ne le retiennent plus ; celle par compte (30 échecs sur 15 minutes) reste en vigueur. Le Caddy intégré joint l'application par le réseau Docker, pas par ce port : il n'est pas concerné. Si ton proxy est dans un autre conteneur ou sur une autre machine, garde `0.0.0.0` et limite l'accès au port avec un pare-feu.

**Caddy intégré** (certificat Let's Encrypt automatique, ports 80 et 443 libres, domaine qui pointe vers ta machine) :

```ini
DOMAIN=arr.exemple.fr
PUBLIC_URL=https://arr.exemple.fr
TRUST_PROXY=1
BIND_ADDRESS=127.0.0.1
```

```bash
docker compose --profile https up -d --build
```

**Autre reverse proxy** : transmets `Host`, `X-Forwarded-For` et `X-Forwarded-Proto`, garde les mêmes variables, autorise les envois de fichiers `.torrent` (`client_max_body_size 25m` sous Nginx) et **laisse passer les WebSockets** : la vue C411 en a besoin (`/api/c411/ws`). Caddy, Traefik et les tunnels Cloudflare les transmettent sans réglage. Sous Nginx :

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  # … listen 443 ssl, server_name, certificat …
  client_max_body_size 25m;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 120s;    # 60 s au moins : le serveur envoie un signal toutes les 25 s
  }
}
```

Le serveur n'accepte le flux de la vue que depuis la page d'Arr411 elle-même (contrôle de l'en-tête `Origin`) : sans `TRUST_PROXY` et `PUBLIC_URL` corrects derrière un proxy, il le refuse et le dit dans `docker compose logs arr411`.

## Variables d'environnement

Toutes sont facultatives et se mettent dans `.env`.

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `HOST_PORT` | `3000` | Port publié sur la machine hôte. |
| `BIND_ADDRESS` | `0.0.0.0` | Interface sur laquelle ce port est publié : `127.0.0.1` = cette machine seulement (derrière un reverse proxy). |
| `ADMIN_USER`, `ADMIN_PASSWORD` | `admin`, généré | Compte créé au tout premier démarrage (liste de comptes vide), jamais réappliqué ensuite. |
| `PUBLIC_URL` | — | Adresse publique. Indispensable derrière un proxy qui change l'en-tête `Host`. |
| `TRUST_PROXY` | `0` | Nombre de reverse proxies devant l'application (à `1`, mets aussi `BIND_ADDRESS=127.0.0.1`). |
| `COOKIE_SECURE` | `auto` | `auto` (cookie `Secure` en HTTPS), `true` ou `false`. |
| `SESSION_SECRET` | généré | Clé de signature des sessions (16 caractères minimum). Gardée dans le volume si absente. |
| `SESSION_DAYS` | `7` | Durée d'une session. |
| `QBITTORRENT_*`, `RADARR_*`, `SONARR_*`, `LIDARR_*` | — | Connexions initiales, pour les services jamais enregistrés (voir plus haut). |
| `INSECURE_UPSTREAM_TLS` | `false` | Accepte les certificats HTTPS auto-signés des services. |
| `ALLOW_SEARCH_COMMANDS` | `false` | Autorise recherches automatiques et synchro RSS (déconseillé). |
| `MAX_UPLOAD_MB` | `25` | Taille maximale d'un fichier `.torrent` envoyé. |
| `LOG_REQUESTS` | `false` | Journalise chaque requête. |
| `DOMAIN` | — | Nom de domaine du profil `https` (Caddy). |
| `C411_BROWSER_URL` | `http://browser:9223` | Navigateur distant de la vue C411. Vide : vue désactivée. |
| `C411_MAX_SESSIONS` | `3` | Navigateurs ouverts en même temps, un par utilisateur (1 à 20). |
| `C411_IDLE_MINUTES` | `15` | Minutes d'inactivité avant la fermeture du navigateur d'un utilisateur (1 à 240). |
| `C411_PERSIST_COOKIES` | `true` | Garde la connexion à c411.org dans le volume, par compte. |
| `C411_ALLOWED_HOSTS` | — | Sites joignables en plus de c411.org et de la vérification Cloudflare. |
| `TZ` | `Europe/Paris` | Fuseau horaire du navigateur. |
| `BROWSER_HEADLESS` | `0` | `1` : Chromium sans écran virtuel (repli). |

L'image utilise aussi `PORT` (3000), `HOST` (0.0.0.0) et `DATA_DIR` (`/data`) : inutile d'y toucher.

Dans `.env`, une valeur qui contient `$`, `#` ou des espaces se met entre apostrophes : `ADMIN_PASSWORD='pa$word #1'` est lu tel quel. Sans apostrophes, un `$` s'écrit `$$`.

## Données, sauvegarde, mise à jour

Tout est dans le volume `arr411-data` (monté sur `/data`) :

| Fichier | Contenu |
| --- | --- |
| `users.json` | Comptes, rôles, mots de passe hachés (scrypt). |
| `config.json` | Connexions aux services, **mots de passe et clés API en clair**, valeurs par défaut. |
| `secret.key` | Clé de signature des sessions. |
| `revoked.json` | Sessions déconnectées (un cookie copié ne marche plus). |
| `c411/` | **Connexion à c411.org de chaque compte, en clair** (si `C411_PERSIST_COOKIES=true`). |
| `cache/covers` | Affiches en cache (reconstruites au besoin). |

Sauvegarde : `docker run --rm -v arr411_arr411-data:/data -v "$PWD":/backup alpine tar czf /backup/arr411-data.tgz -C /data .` (le nom du volume est préfixé par celui du projet : `docker volume ls`).
Protège cette sauvegarde, elle contient les clés de tes services et les connexions c411.org.

Un dossier local à la place du volume nommé : remplace `arr411-data:/data` par `./data:/data` dans le compose, puis `mkdir data && sudo chown 1000:1000 data`.

Mise à jour : `git pull` (ou nouveaux fichiers), puis `docker compose up -d --build`. Les données sont conservées. Avec les images publiées (voir plus bas) : `docker compose pull`, puis `docker compose up -d`. Chaque push sur `main` republie `:latest` ; pour pouvoir revenir en arrière, remplace `:latest` dans le compose par une étiquette précise : `:sha-` suivi des 7 premiers caractères du commit, ou `:1.2.0` pour un tag Git `v1.2.0`.

## Partager le docker-compose

Le `docker-compose.yml` du dépôt **construit** les images à partir du dossier : pour le partager, donne tout le dossier (dépôt Git ou archive), sans `.env` ni `data/`.

Pour ne partager qu'**un seul fichier**, utilise `docker-compose.ghcr.yml` : c'est le même compose, avec les images publiées à la place des constructions. Il suffit de l'enregistrer sous le nom `docker-compose.yml` dans un dossier vide :

```bash
mkdir arr411 && cd arr411
# enregistre-y docker-compose.ghcr.yml sous le nom docker-compose.yml
docker compose up -d
docker compose logs arr411    # mot de passe de l'administrateur (affiché une seule fois)
```

Les réglages se mettent dans un fichier `.env` à côté (le modèle est `.env.example`, dans le dépôt). Les deux fichiers utilisent le même volume : tu peux passer de l'un à l'autre sans perdre tes données.

Les images sont `ghcr.io/hugomeyer/arr411-web:latest` (l'application, et le proxy de sortie `egress`, qui utilise la même image) et `ghcr.io/hugomeyer/arr411-browser:latest` (le navigateur). Le workflow `.github/workflows/docker.yml` les teste, puis les construit pour amd64 et arm64 et les pousse dans GitHub Container Registry à chaque push sur `main` et à chaque tag `v*`.

- Les deux paquets doivent être **publics** (GitHub > Packages > Paramètres du paquet > Visibilité) pour que les autres les téléchargent sans compte.
- Si tu publies avec un autre compte GitHub, remplace `hugomeyer` (en minuscules) dans `docker-compose.ghcr.yml`.

### Aussi sur Docker Hub (facultatif)

Le même workflow publie les deux images sur Docker Hub (`<identifiant>/arr411-web` et `<identifiant>/arr411-browser`, avec les mêmes étiquettes) quand le dépôt GitHub a, dans **Settings > Secrets and variables > Actions** :

| Onglet | Nom | Valeur |
| --- | --- | --- |
| Variables | `DOCKERHUB_USERNAME` | ton identifiant Docker Hub |
| Secrets | `DOCKERHUB_TOKEN` | un jeton d'accès créé dans Docker Hub (Account settings > Personal access tokens), droits « Read & Write » |

Crée d'abord les deux dépôts sur Docker Hub (`arr411-web` et `arr411-browser`), publics pour que d'autres les téléchargent sans compte. Sans la variable et le secret, rien ne change : seul GHCR est utilisé, et aucune pull request ne publie quoi que ce soit.
Pour que ton compose télécharge depuis Docker Hub, remplace `ghcr.io/hugomeyer/` par `<identifiant>/` dans ses trois lignes `image:`.

## Application installable, partage, liens magnet

En HTTPS (ou sur `localhost`), le navigateur propose d'**installer** Arr411 : menu du navigateur > « Installer l'application » ou « Ajouter à l'écran d'accueil ».

- **Partage** (Chrome sur Android, application installée) : Arr411 apparaît dans le menu Partager. Lien magnet ou `.torrent` : qBittorrent. Lien c411.org : ouvert dans la vue C411. Film TMDB, IMDb ou `tt…` : Radarr (ou Sonarr au choix). Série TMDB ou TheTVDB : Sonarr. MusicBrainz : Lidarr.
- **Fichiers `.torrent` et liens** : **Ajout rapide** (onglet C411), ou glisser-déposer n'importe où dans l'application (le partage de fichiers depuis le téléphone n'est pas disponible).
- **Liens magnet** : le bouton « Ouvrir les liens magnet avec Arr411 », dans Ajout rapide, fait de Arr411 le gestionnaire des liens `magnet:` (Chrome et Edge, en HTTPS).

## Différences avec l'application Android

- **Onglet C411** : la vue est un navigateur distant diffusé en image, pas le navigateur intégré du téléphone. Elle est donc un peu moins fluide, sans curseur ni presse-papiers distants (voir [Limites](#limites)), et chaque vue ouverte consomme de la mémoire sur le serveur. Sans navigateur distant (`C411_BROWSER_URL` vide, ou navigateur indisponible), l'onglet devient un lanceur : recherche dans un nouvel onglet et ajout rapide, sans les boutons injectés.
- Pas de notifications de téléchargement terminé, ni de pastille sur l'icône, ni de mode bureau.
- Réglages partagés (catégories, profils, dossiers par défaut) : communs à tous et modifiables par les administrateurs. L'onglet de démarrage est personnel.
- Sur grand écran : barre latérale à gauche, contenu centré.

## Sécurité

**Accès**

- Mots de passe hachés avec **scrypt**. Sessions signées (cookie `HttpOnly`, `SameSite=Lax`, `Secure` en HTTPS), renouvelées à l'usage, valables `SESSION_DAYS` jours.
- Chaque requête revérifie le compte : un compte **désactivé ou supprimé** est coupé immédiatement, un **changement de mot de passe** déconnecte tous ses appareils. « Se déconnecter » met fin à la session **côté serveur** : le même cookie rejoué plus tard est refusé, et la vue C411 ouverte avec cette session est fermée.
- Limite des tentatives : 5 échecs par adresse et compte, 10 par adresse, 30 par compte, sur 15 minutes (réponse 429). Conséquence : quelqu'un qui connaît un identifiant peut le verrouiller 15 minutes en multipliant les essais depuis plusieurs adresses ; les autres comptes ne sont pas touchés.
- Protection CSRF (en-tête dédié et contrôle de l'origine), en-têtes de sécurité (CSP stricte sans script inline, `nosniff`, `X-Frame-Options`, etc.).
- Le serveur n'appelle que les adresses configurées par un administrateur. Il ne relaie ni cookies ni redirections des services.
- Chaque requête vers un service est vérifiée avant d'être transmise : chemin sans `%` ni `..`, forme exacte `portée/action` pour qBittorrent, avec une liste blanche pour les utilisateurs (torrents, transferts, synchro : ni préférences, ni journal, ni recherche, ni RSS, ni création de torrents), commandes Radarr, Sonarr et Lidarr limitées à une liste sûre, corps JSON refusé s'il répète une clé. La configuration d'hôte des services (`config/host`, qui contient leur clé d'API) n'est relayée à personne, administrateurs compris.
- Les secrets des services sont stockés en clair dans `config.json` (droits `600`) : ils doivent pouvoir être réutilisés. Protège le volume et ses sauvegardes.

**Vue C411**

- Le flux (`/api/c411/ws`) n'est accessible qu'avec une session valide : sans elle, 401 ; avec une origine qui n'est pas celle d'Arr411, 403. Le nombre de tentatives est limité (60 par minute et par adresse, avant même la vérification de la session), ainsi que les vues ouvertes (3 par compte, 50 au total). Seuls des messages JSON valides, de 64 Ko au plus, sont acceptés ; le serveur ne transmet au navigateur que des clics, du défilement et de la saisie qu'il a vérifiés.
- Le serveur revérifie le compte toutes les 15 secondes : un compte désactivé, supprimé, dont un administrateur change le mot de passe, ou une session déconnectée, ferme la vue (tout de suite quand le changement passe par l'interface).
- **Le navigateur n'a aucune route directe vers Internet.** `browser` n'est branché qu'à deux réseaux Docker `internal` (sans passerelle) : `c411-control`, partagé avec `arr411` qui le pilote, et `c411-egress`, partagé avec `egress`. Il n'a pas de DNS direct, et Chromium est lancé avec ce proxy comme seule sortie.
- **`egress` ne relaie que des tunnels HTTPS** (port 443) vers les sites autorisés : c411.org, ses sous-domaines, la vérification Cloudflare et `C411_ALLOWED_HOSTS`. C'est lui qui résout les noms et **refuse toute adresse qui n'est pas publique** (réseaux privés, loopback, link-local, CGNAT) : le navigateur ne peut pas atteindre ton réseau local, ni un service du serveur, par son intermédiaire. Il se connecte à l'adresse qu'il a vérifiée, et journalise ses refus.
- Dans le navigateur, une navigation vers un site non autorisé est bloquée (« Adresse bloquée »), les téléchargements, les permissions (caméra, micro, position, notifications) et les sélecteurs de fichiers sont refusés. Ce filtre n'est qu'une première barrière : la vraie limite est le réseau ci-dessus.
- Le script injecté ne tourne que sur c411.org et ses sous-domaines, dans un contexte isolé des scripts du site, et n'envoie rien sans interaction récente dans la vue.
- Aucun port n'est publié, hormis celui de l'application (et ceux de Caddy si tu l'actives) : ni le port DevTools du navigateur (9223, sans authentification), ni celui du proxy (3128).
- Durcissement des conteneurs : utilisateur non-root, système de fichiers en lecture seule (hors `/data` et `/tmp`), aucune capacité Linux, `no-new-privileges`. `browser` et `egress` n'ont ni volume, ni secret, ni accès à l'hôte ; leur environnement se limite à ce dont ils ont besoin, et ils sont bornés en mémoire et en processus.

**Ce que ça ne garantit pas**

- Chromium tourne avec `--no-sandbox` (le bac à sable de Chromium n'est pas activé dans ce conteneur sans privilèges) : **la frontière, c'est le conteneur**. Si une faille de Chromium était exploitée par une page, elle resterait dans `browser`, qui n'a ni secret ni accès à l'hôte.
- Les contextes des utilisateurs sont isolés par Chromium, mais partagent le même processus et le même conteneur. N'invite que des personnes de confiance.
- Le port DevTools et le proxy ne sont pas publiés, mais ils sont joignables depuis les conteneurs qui partagent un réseau avec eux : `arr411` et `egress`, qui n'exécutent que du code de ce dépôt. Ne branche aucun autre conteneur sur les réseaux `c411-control` et `c411-egress`.
- `egress` est aussi sur le réseau `default` du compose, comme `arr411` : il peut joindre la page de connexion d'Arr411, comme n'importe quel client, et les autres conteneurs de ce réseau. Ne mets pas d'autres services sensibles dans ce projet compose.
- Qui administre le serveur peut lire les cookies c411.org gardés dans `/data/c411` et la saisie qui transite par le serveur. N'héberge Arr411 que pour des personnes qui te font confiance.
- Les adresses des clients (limite des tentatives, journaux) viennent de `X-Forwarded-For` quand `TRUST_PROXY` est activé : si le port de l'application est joignable sans passer par le proxy, quelqu'un peut en choisir une. Publie-le sur `127.0.0.1` (`BIND_ADDRESS`) ou filtre-le avec un pare-feu.
- Un compte « utilisateur » n'est pas cantonné à un dossier : il peut ajouter un torrent avec le dossier de destination de son choix (côté qBittorrent), déplacer des torrents, rescanner des dossiers et lancer un import manuel. Ne crée de comptes que pour des personnes de confiance.

## Développement

```bash
node server/index.js              # http://localhost:3000, données dans ./data
npm test                          # tests (Node 22, aucune dépendance)
```

Structure : `server/` (serveur HTTP, authentification, proxy vers les services, CLI, proxy de sortie `egress.js`), `server/c411/` (vue C411 : pilotage de Chromium par DevTools, saisie, moteur d'envoi, script injecté dans c411.org), `browser/` (image de Chromium et son écran virtuel), `public/app/` (interface ; `c411.js` affiche le flux), `public/login/` (page de connexion), `test/`.

Les tests qui pilotent un vrai navigateur (`test/c411-hub.test.js`) sont ignorés si Chrome, Chromium ou Edge est introuvable (`CHROME_BIN` désigne un exécutable précis).

## Dépannage

| Symptôme | Cause probable |
| --- | --- |
| « Origine refusée » à la connexion | Reverse proxy : définis `TRUST_PROXY=1` et `PUBLIC_URL`. |
| Retour systématique à la page de connexion | `COOKIE_SECURE=true` alors que le site est ouvert en HTTP, ou cookies bloqués par le navigateur. |
| « Le dossier de données n'est pas accessible en écriture » | Droits du volume : `chown 1000:1000` sur le dossier monté. |
| « Réseau : connexion refusée (localhost:8080) » | `localhost` est le conteneur : utilise le nom du service ou `host.docker.internal`. L'adresse n'est affichée qu'aux administrateurs ; les autres utilisateurs voient seulement « connexion refusée ». |
| « qBittorrent a refusé les identifiants » | Corrige-les dans Réglages. Le serveur attend 30 secondes avant de réessayer (qBittorrent bannit après quelques échecs). |
| « certificat TLS refusé » | `INSECURE_UPSTREAM_TLS=true`, ou certificat valide sur le service. |
| Envoi d'un `.torrent` refusé | Augmente `MAX_UPLOAD_MB` (et la limite du proxy). |
| Le conteneur s'arrête au démarrage | `docker compose logs arr411` : le message dit quoi corriger (`users.json` ou `config.json` illisible, `SESSION_SECRET` ou `ADMIN_PASSWORD` trop court, `PUBLIC_URL` invalide…). |
| `port is already allocated` | Un autre programme utilise déjà le port : change `HOST_PORT` dans `.env`. |
| L'application ne répond plus depuis un autre appareil du réseau | `BIND_ADDRESS=127.0.0.1` : le port n'écoute que sur la machine, passe par le reverse proxy (ou remets `0.0.0.0`). |
| C411 : « Connexion impossible » | Un reverse proxy bloque les WebSockets : voir [HTTPS et reverse proxy](#https-et-reverse-proxy). |
| C411 : « Navigateur indisponible » ou « Navigateur arrêté » | `docker compose ps` : `browser` et `egress` doivent être `healthy`. Cause : `docker compose logs browser`. Si Chromium ne démarre pas avec l'écran virtuel, essaie `BROWSER_HEADLESS=1` puis `docker compose up -d browser`. |
| C411 : « Vue C411 désactivée » ou simple lanceur | `C411_BROWSER_URL` est vide : mets `http://browser:9223` (ou retire la ligne) et relance `docker compose up -d --build`. |
| C411 : page vide, chargement qui n'aboutit pas, « Adresse bloquée » | Un hôte nécessaire n'est pas autorisé : `docker compose logs egress`, puis `C411_ALLOWED_HOSTS`. |
| C411 : « Serveur occupé » | Tous les navigateurs sont en cours d'utilisation : attends, ou augmente `C411_MAX_SESSIONS`. |
| C411 : « Session fermée » | Inactivité (`C411_IDLE_MINUTES`) : bouton « Rouvrir ». Avec `C411_PERSIST_COOKIES=true`, tu restes connecté à c411.org. |
| C411 : « Ouvert ailleurs » | Ton compte a pris le navigateur sur un autre appareil : bouton « Reprendre ici ». |
| C411 : la vérification Cloudflare boucle | Elle peut refuser un navigateur piloté à distance (voir [Limites](#limites)). Réessaie plus tard. |
| C411 : « Action refusée : aucune interaction récente dans la vue C411 » | Un envoi doit suivre un clic ou une frappe dans la vue : recommence en cliquant sur le bouton. |

## Licence

MIT (fichier `LICENSE`). Les icônes viennent de Heroicons (MIT, Tailwind Labs) : voir `THIRD_PARTY_NOTICES.md`.
