'use strict';
// Briques communes : erreurs HTTP, validation, mini-routeur, limitation de débit, session.
const config = require('./config');
const { db } = require('./db');
const { verifyToken, readCookie } = require('./auth');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Réponse personnalisée (statut, cookies, redirection)
class Reply {
  constructor(data = {}, { status = 200, cookies = [], redirect = null, html = null } = {}) {
    Object.assign(this, { data, status, cookies, redirect, html });
  }
}
const redirectTo = (url) => new Reply({}, { status: 302, redirect: url });

/* ------------------------------ Validation ------------------------------ */
const money = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+0-9 ()-]{6,20}$/;

function str(value, max, label, { required = true, min = 0 } = {}) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (required && !s) throw new HttpError(400, `Champ requis : ${label}`);
  if (s && s.length < min) throw new HttpError(400, `${label} trop court (min ${min} caractères)`);
  if (s.length > max) throw new HttpError(400, `${label} trop long (max ${max} caractères)`);
  return s;
}

function intIn(value, min, max, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${label} invalide (entier entre ${min} et ${max})`);
  }
  return n;
}

function numIn(value, min, max, label) {
  const n = Number(value);
  if (value === '' || value === null || value === undefined || !Number.isFinite(n) || n < min || n > max) {
    throw new HttpError(400, `${label} invalide (nombre entre ${min} et ${max})`);
  }
  return n;
}

function httpsUrl(value, label) {
  const s = str(value, 500, label, { required: false });
  if (!s) return '';
  if (/^\/img\/[a-z0-9-]+\.(svg|jpg|png|webp)$/.test(s)) return s; // images fournies par la plateforme
  let u;
  try { u = new URL(s); } catch { throw new HttpError(400, `${label} invalide`); }
  if (u.protocol !== 'https:') throw new HttpError(400, `${label} : le lien doit commencer par https://`);
  return s;
}

// Empêche de contourner la plateforme : pas de téléphone, email, lien ou réseau social dans les textes publics.
const CONTACT_PATTERNS = [
  /[^\s@]+@[^\s@]+\.[a-z]{2,}/i,
  /(?:\+?\d[\s.\-()]*){8,}/,
  /(?:https?:\/\/|www\.)\S+/i,
  /\b(?:whats?\s?app|wh?atsap|watsap|telegram|instagram|insta|facebook|messenger|snapchat|tiktok)\b/i,
];
function noContactInfo(text, label) {
  if (CONTACT_PATTERNS.some((re) => re.test(text))) {
    throw new HttpError(400,
      `${label} : les coordonnées (téléphone, email, lien, WhatsApp, réseaux sociaux) sont interdites. Tout se passe via la plateforme, c'est ce qui protège le paiement des deux côtés.`);
  }
  return text;
}

/* --------------------------- Limitation de débit -------------------------- */
const buckets = new Map();
function rateLimit(key, max, windowMs, message = 'Trop de requêtes, réessayez dans quelques minutes') {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset <= now) {
    b = { count: 0, reset: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  if (b.count > max) throw new HttpError(429, message);
}
function peekLimit(key, max) {          // vrai si la limite est déjà atteinte (sans compter)
  const b = buckets.get(key);
  return Boolean(b && b.reset > Date.now() && b.count >= max);
}
function resetLimit(key) { buckets.delete(key); }
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
}, 60_000).unref();

function clientIp(req) {
  if (config.trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || '';
}

/* ------------------------------- Session ---------------------------------- */
function currentUser(req) {
  const token = readCookie(req);
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;
  const row = db.prepare(
    'SELECT id, name, email, role, active, seller_status, commission_rate, token_version, payout_method, payout_details FROM users WHERE id = ?'
  ).get(payload.sub);
  if (!row || !row.active || row.token_version !== payload.ver) return null;
  return { ...row };
}

const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role, seller_status: u.seller_status,
});

/* -------------------------------- Routeur --------------------------------- */
const routes = [];
// opts : { auth, roles, limit: [clé, max, fenêtre ms], noCsrf }
function route(method, pattern, opts, handler) {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, regex, keys, opts, handler });
}

function readBody(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) tooBig = true;
      else chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return reject(new HttpError(413, 'Requête trop volumineuse'));
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch {
        reject(new HttpError(400, 'JSON invalide'));
      }
    });
    req.on('error', reject);
  });
}

// Protection CSRF : les requêtes qui modifient des données doivent venir de notre propre page
// (en-tête personnalisé + origine identique). Un site tiers ne peut ni l'un ni l'autre.
function checkCsrf(req) {
  if (req.headers['x-requested-with'] !== 'souk') {
    throw new HttpError(403, 'Requête refusée (en-tête de sécurité manquant)');
  }
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { throw new HttpError(403, 'Origine invalide'); }
    const own = config.baseUrl ? new URL(config.baseUrl).host : req.headers.host;
    if (host !== own) throw new HttpError(403, 'Origine non autorisée');
  }
}

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

async function handleApi(req, res, url) {
  const ip = clientIp(req);
  rateLimit(`ip:${ip}`, 600, 60_000);           // 600 requêtes / minute / IP

  let pathMatched = false;
  for (const r of routes) {
    const m = r.regex.exec(url.pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== req.method) continue;

    const params = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));

    const mutating = !['GET', 'HEAD'].includes(req.method);
    if (mutating && !r.opts.noCsrf) checkCsrf(req);

    const user = currentUser(req);
    if (r.opts.auth || r.opts.roles) {
      if (!user) throw new HttpError(401, 'Connexion requise');
      if (r.opts.roles && !r.opts.roles.includes(user.role)) {
        throw new HttpError(403, "Vous n'avez pas le droit d'effectuer cette action");
      }
    }
    if (r.opts.limit) rateLimit(`${r.opts.limit[0]}:${user ? 'u' + user.id : ip}`, r.opts.limit[1], r.opts.limit[2]);

    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    const out = await r.handler({ req, res, params, query: url.searchParams, body, user, ip });
    const reply = out instanceof Reply ? out : new Reply(out ?? {});
    const extra = reply.cookies.length ? { 'Set-Cookie': reply.cookies } : {};
    if (reply.redirect) {
      res.writeHead(reply.status, { Location: reply.redirect, 'Cache-Control': 'no-store', ...extra });
      return res.end();
    }
    if (reply.html !== null) {
      res.writeHead(reply.status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
      return res.end(reply.html);
    }
    return sendJson(res, reply.status, reply.data, extra);
  }
  throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Méthode non autorisée' : 'Route introuvable');
}

// URL publique du site (utilisée pour les retours PayPal). En production, BASE_URL est obligatoire.
function publicBase(req) {
  if (config.baseUrl) return config.baseUrl;
  if (config.production) throw new HttpError(500, 'BASE_URL non configurée');
  return `http://${req.headers.host}`;
}

module.exports = {
  HttpError, Reply, redirectTo, money, EMAIL_RE, PHONE_RE,
  str, intIn, numIn, httpsUrl, noContactInfo,
  rateLimit, peekLimit, resetLimit, clientIp,
  currentUser, publicUser, route, handleApi, sendJson, publicBase,
};
