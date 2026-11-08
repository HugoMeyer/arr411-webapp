'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { HttpError } = require('./util');

const scrypt = promisify(crypto.scrypt);

const PARAMS = { N: 32768, r: 8, p: 1, len: 64 };
const MAX_PENDING = 32;
let pending = 0;

async function derive(password, salt, len, N, r, p) {
  if (pending >= MAX_PENDING) throw new HttpError(503, 'Serveur occupé, réessaie dans un instant', { headers: { 'Retry-After': '2' } });
  pending++;
  try {
    return await scrypt(String(password).normalize('NFKC'), salt, len, { N, r, p, maxmem: 256 * N * r });
  } finally {
    pending--;
  }
}

async function hashPassword(password) {
  const { N, r, p, len } = PARAMS;
  const salt = crypto.randomBytes(16);
  const key = await derive(password, salt, len, N, r, p);
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || N < 1024 || N > 1 << 17 || (N & (N - 1)) !== 0) return false;
  if (!Number.isInteger(r) || r < 1 || r > 16 || !Number.isInteger(p) || p < 1 || p > 4) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (!salt.length || !expected.length) return false;
  const key = await derive(password, salt, expected.length, N, r, p);
  return crypto.timingSafeEqual(key, expected);
}

// Verified for unknown or disabled accounts so response times do not reveal them.
let dummy = null;
async function dummyHash() {
  if (!dummy) dummy = hashPassword(crypto.randomBytes(18).toString('base64'));
  return dummy;
}

function validatePassword(pw) {
  if (typeof pw !== 'string') throw new HttpError(400, 'Mot de passe manquant');
  if (pw.length < 8) throw new HttpError(400, 'Le mot de passe doit faire au moins 8 caractères');
  if (pw.length > 256) throw new HttpError(400, 'Le mot de passe est trop long (256 caractères maximum)');
  return pw;
}

function validateUsername(name) {
  const u = (typeof name === 'string' ? name : '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._@-]{1,63}$/.test(u)) {
    throw new HttpError(400, 'Identifiant invalide : 2 à 64 caractères parmi a-z, 0-9, point, tiret, tiret bas et @');
  }
  return u;
}

module.exports = { hashPassword, verifyPassword, dummyHash, validatePassword, validateUsername };
