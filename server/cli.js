#!/usr/bin/env node
'use strict';
const path = require('node:path');
const crypto = require('node:crypto');

let config;
try {
  config = require('./config');
} catch (e) {
  console.error('Configuration invalide :', e.message);
  process.exit(1);
}
const { JsonStore, ensureDataDir } = require('./store');
const { Users } = require('./users');

const USAGE = `Arr411 Web — gestion des comptes

Usage : node server/cli.js <commande> [options]

  list                                     liste les comptes
  add <identifiant> [--admin] [--password <mdp>]
                                           crée un compte (mot de passe généré si absent)
  passwd <identifiant> [--password <mdp>]  change le mot de passe (déconnecte ses appareils)
  role <identifiant> <admin|user>          change le rôle
  disable <identifiant>                    bloque la connexion
  enable <identifiant>                     réactive le compte
  remove <identifiant>                     supprime le compte

Avec Docker :  docker compose exec arr411 node server/cli.js list
Le serveur prend les changements en compte en moins d’une seconde.`;

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--admin') args.flags.admin = true;
    else if (a === '--password' || a === '-p') args.flags.password = argv[++i];
    else if (a.startsWith('--password=')) args.flags.password = a.slice('--password='.length);
    else if (a === '-h' || a === '--help') args.flags.help = true;
    else if (a.startsWith('-')) throw new Error(`Option inconnue : ${a}`);
    else args._.push(a);
  }
  return args;
}

const generated = () => crypto.randomBytes(12).toString('base64url');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, name, extra] = args._;
  if (!cmd || args.flags.help) {
    console.log(USAGE);
    return args.flags.help ? 0 : 2;
  }
  ensureDataDir(config.dataDir);
  const store = new JsonStore(path.join(config.dataDir, 'users.json'), () => ({ version: 1, users: [] })).load();
  if (!Array.isArray(store.data.users)) store.data.users = [];
  const users = new Users(store);
  const need = () => {
    if (!name) throw new Error('Identifiant manquant.\n\n' + USAGE);
    return name;
  };

  switch (cmd) {
    case 'list': {
      const list = users.list();
      if (!list.length) console.log('Aucun compte (il sera créé au prochain démarrage du serveur).');
      for (const u of list) {
        console.log(`${u.username.padEnd(24)} ${u.role.padEnd(6)} ${u.disabled ? 'désactivé' : 'actif    '}  dernière connexion : ${u.lastLoginAt || 'jamais'}`);
      }
      return 0;
    }
    case 'add': {
      const password = args.flags.password || generated();
      const u = await users.create({ username: need(), password, role: args.flags.admin ? 'admin' : 'user' });
      console.log(`Compte « ${u.username} » créé (${u.role}).`);
      if (!args.flags.password) console.log(`Mot de passe temporaire : ${password}`);
      return 0;
    }
    case 'passwd': {
      const password = args.flags.password || generated();
      const u = await users.setPassword(need(), password);
      console.log(`Mot de passe de « ${u.username} » modifié ; ses appareils connectés sont déconnectés.`);
      if (!args.flags.password) console.log(`Nouveau mot de passe : ${password}`);
      return 0;
    }
    case 'role': {
      if (!['admin', 'user'].includes(extra)) throw new Error('Rôle attendu : admin ou user');
      const u = await users.update(need(), { role: extra });
      console.log(`« ${u.username} » est maintenant ${u.role}.`);
      return 0;
    }
    case 'disable':
    case 'enable': {
      const u = await users.update(need(), { disabled: cmd === 'disable' });
      console.log(`« ${u.username} » ${u.disabled ? 'est désactivé' : 'est réactivé'}.`);
      return 0;
    }
    case 'remove': {
      const u = await users.remove(need());
      console.log(`Compte « ${u.username} » supprimé.`);
      return 0;
    }
    default:
      throw new Error(`Commande inconnue : ${cmd}\n\n${USAGE}`);
  }
}

// exitCode rather than exit(): stdout is asynchronous on pipes under Linux, and the generated password must reach the terminal.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(e && e.message ? e.message : e);
    process.exitCode = 1;
  }
);
