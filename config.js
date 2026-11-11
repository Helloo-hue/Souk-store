'use strict';
// Toute la configuration vient des variables d'environnement (voir README).
const path = require('node:path');
// Charge le fichier .env (clé=valeur) s'il existe, sans dépendance.
try {
  for (const line of require('fs').readFileSync(require('path').join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* pas de .env */ }
const env = process.env;

const production = env.NODE_ENV === 'production';
const baseUrl = (env.BASE_URL || '').trim().replace(/\/+$/, '');

const ppMode = env.PAYPAL_MODE === 'live' ? 'live' : 'sandbox';
const ppCurrency = (env.PAYPAL_CURRENCY || 'EUR').trim().toUpperCase();
// PAYPAL_RATE = combien de MAD pour 1 unité de la devise PayPal (ex : 10.8 si PAYPAL_CURRENCY=EUR).
// Si la devise est MAD, le taux est 1.
const ppRate = Number(env.PAYPAL_RATE) || (ppCurrency === 'MAD' ? 1 : 0);
const ppConfigured = Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET && ppRate > 0);

const config = {
  production,
  port: Number(env.PORT) || 3000,
  host: env.HOST || '0.0.0.0',
  baseUrl, // ex : https://monsite.ma  (obligatoire en production pour PayPal)
  trustProxy: env.TRUST_PROXY === '1', // à activer derrière un reverse proxy (Nginx, Cloudflare...)
  secureCookies: baseUrl.startsWith('https://') || env.COOKIE_SECURE === '1',
  dbFile: env.DB_FILE || path.join(__dirname, 'marketplace.db'),
  jwtSecret: env.JWT_SECRET || '',

  paypal: {
    configured: ppConfigured,
    clientId: env.PAYPAL_CLIENT_ID || '',
    secret: env.PAYPAL_CLIENT_SECRET || '',
    mode: ppMode,
    apiBase: env.PAYPAL_API_BASE || (ppMode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'),
    currency: ppCurrency,
    rate: ppRate,
    webhookId: env.PAYPAL_WEBHOOK_ID || '',
    // Sans identifiants : simulateur local en développement, désactivé en production.
    simulation: !ppConfigured && !production,
    brand: env.SITE_NAME || 'Souk',
  },

  // La carte reste simulée tant qu'aucune passerelle réelle (CMI...) n'est branchée.
  cardSimulation: env.CARD_SIMULATION ? env.CARD_SIMULATION === '1' : !production,

  bank: {
    holder: env.BANK_HOLDER || (production ? '' : 'Marketplace SARL (démo)'),
    iban: env.BANK_IBAN || (production ? '' : 'MA00 0000 0000 0000 0000 0000 000 (démo)'),
  },
  cashAgency: {
    name: env.CASH_AGENCY_NAME || 'Cash Plus / Wafacash',
    receiver: env.CASH_AGENCY_RECEIVER || (production ? '' : 'Nom Prénom (démo)'),
    phone: env.CASH_AGENCY_PHONE || (production ? '' : '06 00 00 00 00'),
  },
};

module.exports = config;
