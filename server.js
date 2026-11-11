'use strict';
// Marketplace : serveur HTTP + API REST + fichiers du site (zéro dépendance, Node 22.5+)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
require('./db');
require('./routes/auth');
require('./routes/catalog');
require('./routes/orders');
require('./routes/paypal');
require('./routes/seller');
require('./routes/admin');
const { HttpError, handleApi, sendJson } = require('./core');
const { expireStale } = require('./orderlib');
const { paypalAvailable, paypalIsSimulated } = require('./paypal');

const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { throw new HttpError(400, 'URL invalide'); }
  if (rel.includes('\0')) throw new HttpError(400, 'URL invalide');
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Accès refusé');
  if (path.basename(file).startsWith('.')) throw new HttpError(404, 'Page introuvable');
  let stat;
  try { stat = fs.statSync(file); } catch { throw new HttpError(404, 'Page introuvable'); }
  if (!stat.isFile()) throw new HttpError(404, 'Page introuvable');
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  // En-têtes de sécurité sur toutes les réponses
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; " +
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  if (config.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Méthode non autorisée');
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    const message = status === 500 ? 'Erreur interne du serveur' : err.message;
    if (res.headersSent) return res.end();
    if (req.url.startsWith('/api/')) return sendJson(res, status, { error: message });
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(message);
  }
});

server.requestTimeout = 30_000;
server.headersTimeout = 15_000;

// Annulation automatique des commandes non payées à temps (et remise en stock)
function startSweeper() {
  const timer = setInterval(() => {
    expireStale().catch((e) => console.error('expireStale:', e.message));
  }, 60_000);
  timer.unref();
}

if (require.main === module) {
  server.listen(config.port, config.host, () => {
    console.log(`Marketplace en ligne : http://localhost:${config.port}`);
    const pp = paypalAvailable() ? (paypalIsSimulated() ? 'simulé (développement)' : `réel (${config.paypal.mode})`) : 'désactivé';
    console.log(`PayPal : ${pp} | carte : ${config.cardSimulation ? 'simulée' : 'désactivée'}`);
    if (config.production && !config.baseUrl) console.warn('ATTENTION : BASE_URL manquante, PayPal restera désactivé.');
  });
  startSweeper();
}

module.exports = { server, startSweeper };
