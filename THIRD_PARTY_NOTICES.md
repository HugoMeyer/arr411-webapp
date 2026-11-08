# Éléments tiers

Arr411 Web est publié sous licence MIT (fichier `LICENSE`). Il réutilise les éléments suivants.

## Heroicons

Les icônes de l'interface (`public/app/icons.js`) viennent de **Heroicons v2, série « outline »**, <https://heroicons.com>.
Seule l'icône `keyboard`, absente de Heroicons, a été dessinée pour Arr411 dans le même style.

```text
MIT License

Copyright (c) Tailwind Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Images Docker et paquets installés

Ce dépôt ne contient aucun de ces composants : Docker les télécharge au moment de la construction, chacun sous sa propre licence.

- `node:22-alpine` (image de l'application et du proxy de sortie) ;
- `debian:bookworm-slim`, avec les paquets Debian `chromium`, `xvfb`, `socat`, `tini`, `tzdata` et des polices (image du navigateur de la vue C411) ;
- `caddy:2-alpine` (profil `https`, facultatif).

## Marques

qBittorrent, Radarr, Sonarr, Lidarr et C411 appartiennent à leurs auteurs et propriétaires respectifs.
Arr411 n'est affilié à aucun d'eux et n'est pas approuvé par eux.
