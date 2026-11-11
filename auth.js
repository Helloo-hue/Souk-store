'use strict';
// Authentification sans dépendance : mots de passe (scrypt), jetons signés HS256, cookie de session.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

function loadSecret() {
  if (config.jwtSecret) {
    if (config.jwtSecret.length < 32) throw new Error('JWT_SECRET doit contenir au moins 32 caractères.');
    return config.jwtSecret;
  }
  if (config.production) {
    throw new Error('JWT_SECRET est obligatoire en production (au moins 32 caractères aléatoires).');
  }
  const file = path.join(__dirname, '.secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
const SECRET = loadSecret();

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// Hash factice : on le vérifie même quand l'email n'existe pas, pour que le temps de réponse
// ne révèle pas si un compte existe.
const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex'));
const dummyVerify = (password) => verifyPassword(password, DUMMY_HASH);

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function signToken(payload, expiresInSec = 7 * 24 * 3600) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + expiresInSec }));
  const sig = crypto.createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = crypto.createHmac('sha256', SECRET).update(`${header}.${body}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// --- Cookie de session : HttpOnly (illisible par JavaScript), SameSite=Lax, Secure sur HTTPS
const COOKIE_NAME = config.secureCookies ? '__Host-sid' : 'sid';
const MAX_AGE = 7 * 24 * 3600;

function sessionCookie(userId, tokenVersion) {
  const token = signToken({ sub: userId, ver: tokenVersion }, MAX_AGE);
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${config.secureCookies ? '; Secure' : ''}`;
}
function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.secureCookies ? '; Secure' : ''}`;
}
function readCookie(req, name = COOKIE_NAME) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// Mots de passe trop courants refusés
const COMMON = new Set(['12345678', '123456789', '1234567890', 'password', 'password1', 'motdepasse', 'azertyuiop',
  'qwertyuiop', 'azerty123', '11111111', '00000000', 'iloveyou', 'admin123', 'buyer123', 'seller123']);
function checkPasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Le mot de passe doit contenir au moins 8 caractères';
  if (pw.length > 128) return 'Mot de passe trop long (128 caractères maximum)';
  if (COMMON.has(pw.toLowerCase())) return 'Ce mot de passe est trop courant, choisissez-en un autre';
  if (/^(.)\1+$/.test(pw)) return 'Mot de passe trop simple';
  return null;
}

module.exports = {
  hashPassword, verifyPassword, dummyVerify, signToken, verifyToken,
  sessionCookie, clearCookie, readCookie, COOKIE_NAME, checkPasswordStrength,
};
