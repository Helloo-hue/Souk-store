'use strict';
// Tests d'intégration : sécurité, commission, séquestre, versements, PayPal (faux serveur), litiges, avis.
// Lancer :  npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { startFakePayPal } = require('./fake-paypal');

const PASSWORD = 'Tr0ub4dor&3x';
const SHIP = { name: 'Amine Client', phone: '+212 600 000 000', address: '12 rue des Souks', city: 'Marrakech' };
let fake, base, server, dbFile, M;
const F = {};                           // utilisateurs, produits, sessions

before(async () => {
  fake = await startFakePayPal();
  dbFile = path.join(os.tmpdir(), `mk-test-${process.pid}.db`);
  for (const s of ['', '-wal', '-shm']) fs.rmSync(dbFile + s, { force: true });
  Object.assign(process.env, {
    DB_FILE: dbFile, JWT_SECRET: 'x'.repeat(40), NODE_ENV: 'test', BASE_URL: '',
    PAYPAL_CLIENT_ID: 'test-client', PAYPAL_CLIENT_SECRET: 'test-secret',
    PAYPAL_API_BASE: `http://127.0.0.1:${fake.port}`, PAYPAL_CURRENCY: 'EUR', PAYPAL_RATE: '10', PAYPAL_WEBHOOK_ID: 'wh-1',
  });
  ({ server } = require('../server'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  M = { db: require('../db'), auth: require('../auth'), lib: require('../orderlib'), core: require('../core') };

  // --- Jeu de données
  const sql = M.db.db;
  const user = (name, role, extra = {}) => {
    const id = Number(sql.prepare('INSERT INTO users (name, email, password_hash, role, seller_status, commission_rate) VALUES (?,?,?,?,?,?)')
      .run(name, `${name.toLowerCase().replace(/\s/g, '')}@test.ma`, M.auth.hashPassword(PASSWORD), role,
        extra.status || 'approved', extra.rate ?? null).lastInsertRowid);
    return { id, email: `${name.toLowerCase().replace(/\s/g, '')}@test.ma` };
  };
  F.admin = user('Admin', 'admin');
  F.sellerA = user('Seller A', 'seller');
  F.sellerB = user('Seller B', 'seller');
  F.sellerC = user('Seller C', 'seller', { rate: 5 });           // taux négocié 5 %
  F.sellerP = user('Seller P', 'seller', { status: 'pending' });
  F.buyer = user('Buyer One', 'buyer');
  F.buyer2 = user('Buyer Two', 'buyer');
  const cat = (name, rate) => Number(sql.prepare('INSERT INTO categories (name, commission_rate) VALUES (?, ?)').run(name, rate).lastInsertRowid);
  F.catGeneral = cat('General', null);
  F.catCraft = cat('Craft', 8);
  const product = (seller, title, price, stock, c = F.catGeneral) =>
    Number(sql.prepare('INSERT INTO products (seller_id, category_id, title, description, price, stock) VALUES (?,?,?,?,?,?)')
      .run(seller.id, c, title, 'Un bon produit', price, stock).lastInsertRowid);
  F.pA1 = product(F.sellerA, 'Produit A1', 100, 20);
  F.pA2 = product(F.sellerA, 'Produit A2 artisanat', 200, 20, F.catCraft);
  F.pB1 = product(F.sellerB, 'Produit B1', 50, 30);
  F.pC1 = product(F.sellerC, 'Produit C1', 1000, 20);
  F.pP1 = product(F.sellerP, 'Produit P1 en attente', 100, 5);
});

after(async () => {
  await new Promise((r) => server.close(r));
  await fake.close();
  for (const s of ['', '-wal', '-shm']) fs.rmSync(dbFile + s, { force: true });
});

/* -------------------------------- Outils -------------------------------- */
async function call(sess, method, url, body, headers = {}) {
  const h = { 'X-Requested-With': 'souk', ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (sess?.cookie) h.Cookie = sess.cookie;
  const res = await fetch(base + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const setCookie = res.headers.getSetCookie();
  if (sess && setCookie.length) { const c = setCookie[0].split(';')[0]; sess.cookie = c.endsWith('=') ? '' : c; }
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* texte brut */ }
  return { status: res.status, data, headers: res.headers, setCookie, location: res.headers.get('location') };
}
async function login(u, password = PASSWORD) {
  const s = { cookie: '', uid: u.id };
  const r = await call(s, 'POST', '/api/auth/login', { email: u.email, password });
  assert.equal(r.status, 200, `login ${u.email}: ${JSON.stringify(r.data)}`);
  return s;
}
const sql = () => M.db.db;
const stock = (pid) => sql().prepare('SELECT stock FROM products WHERE id = ?').get(pid).stock;
const orderRow = (id) => sql().prepare('SELECT * FROM orders WHERE id = ?').get(id);
const payRow = (orderId) => sql().prepare('SELECT * FROM payments WHERE order_id = ?').get(orderId);
const auditHas = (action) => sql().prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get(action).n > 0;
const checkout = (sess, items, payment, extra = {}) => {
  if (sess.uid) M.core.resetLimit(`order:u${sess.uid}`);          // la limite a son propre test, plus bas
  return call(sess, 'POST', '/api/orders', { items, shipping: SHIP, payment, ...extra });
};
const cod = { method: 'cod' };
const earnings = async (s) => (await call(s, 'GET', '/api/seller/earnings')).data;
const back = (orderId, days) => sql().prepare("UPDATE orders SET delivered_at = datetime('now', ?) WHERE id = ?").run(`-${days} days`, orderId);

test('boot : sessions utilisateurs', async () => {
  F.sAdmin = await login(F.admin);
  F.sA = await login(F.sellerA);
  F.sB = await login(F.sellerB);
  F.sC = await login(F.sellerC);
  F.sP = await login(F.sellerP);
  F.s1 = await login(F.buyer);
  F.s2 = await login(F.buyer2);
});

/* ------------------------------- Sécurité -------------------------------- */
test('sécurité : cookie HttpOnly, pas de jeton lisible, CSRF refusé', async () => {
  const s = { cookie: '' };
  const r = await call(s, 'POST', '/api/auth/login', { email: F.buyer.email, password: PASSWORD });
  assert.match(r.setCookie[0], /HttpOnly/);
  assert.match(r.setCookie[0], /SameSite=Lax/);
  assert.equal(r.data.token, undefined, 'aucun jeton dans le corps de la réponse');

  const noHeader = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: F.buyer.email, password: PASSWORD }) });
  assert.equal(noHeader.status, 403, 'sans en-tête X-Requested-With');
  const evil = await call(s, 'POST', '/api/auth/logout', {}, { Origin: 'http://evil.example' });
  assert.equal(evil.status, 403, 'origine étrangère');
  assert.equal((await call(null, 'GET', '/api/orders')).status, 401);
  assert.equal((await call(null, 'GET', '/api/auth/me')).data.user, null);
});

test('sécurité : fichiers sensibles et traversée de dossiers', async () => {
  for (const p of ['/.secret', '/%2e%2e/%2e%2e/etc/passwd', '/..%2fserver.js', '/marketplace.db']) {
    const r = await fetch(base + p);
    assert.notEqual(r.status, 200, p);
  }
  const home = await fetch(base + '/');
  assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(home.headers.get('content-security-policy'), /unsafe-inline/);
});

test('sécurité : mots de passe faibles refusés, vendeur en attente de validation', async () => {
  const s = { cookie: '' };
  assert.equal((await call(s, 'POST', '/api/auth/register', { name: 'Nouveau', email: 'n1@test.ma', password: '12345678' })).status, 400);
  assert.equal((await call(s, 'POST', '/api/auth/register', { name: 'Nouveau', email: 'n1@test.ma', password: 'court' })).status, 400);
  const r = await call(s, 'POST', '/api/auth/register', { name: 'Nouveau Vendeur', email: 'n2@test.ma', password: PASSWORD, role: 'seller' });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.seller_status, 'pending');
  const adminTry = await call({ cookie: '' }, 'POST', '/api/auth/register', { name: 'Pirate', email: 'n3@test.ma', password: PASSWORD, role: 'admin' });
  assert.equal(adminTry.data.user.role, 'buyer', 'impossible de se créer administrateur');
});

test('sécurité : coordonnées interdites dans les annonces', async () => {
  const base_ = { title: 'Super produit', price: 50, stock: 2 };
  for (const description of ['Appelez-moi au 06 12 34 56 78', 'contact@exemple.com', 'Écrivez sur WhatsApp', 'Voir https://exemple.com/moi']) {
    const r = await call(F.sA, 'POST', '/api/products', { ...base_, description });
    assert.equal(r.status, 400, description);
  }
  assert.equal((await call(F.sA, 'POST', '/api/products', { ...base_, description: 'Tapis 160×230 cm en laine' })).status, 201);
  assert.equal((await call(F.sA, 'POST', '/api/products', { ...base_, description: 'x', image_url: 'http://insecure.example/a.png' })).status, 400, 'image http refusée');
});

test('sécurité : produits d\'un vendeur non validé invisibles et non achetables', async () => {
  const list = await call(null, 'GET', '/api/products?limit=50');
  assert.ok(!list.data.items.some((p) => p.id === F.pP1));
  assert.equal((await call(null, 'GET', `/api/products/${F.pP1}`)).status, 404);
  assert.equal((await call(F.sP, 'GET', `/api/products/${F.pP1}`)).status, 200, 'visible par son vendeur');
  assert.equal((await checkout(F.s1, [{ product_id: F.pP1, quantity: 1 }], cod)).status, 404);
  assert.equal(stock(F.pP1), 5);
  // validation par l'admin
  assert.equal((await call(F.s1, 'PATCH', `/api/admin/users/${F.sellerP.id}`, { seller_status: 'approved' })).status, 403, 'un acheteur ne valide pas');
  assert.equal((await call(F.sAdmin, 'PATCH', `/api/admin/users/${F.sellerP.id}`, { seller_status: 'approved' })).status, 200);
  assert.ok((await call(null, 'GET', '/api/products?limit=50')).data.items.some((p) => p.id === F.pP1));
  await call(F.sAdmin, 'PATCH', `/api/admin/users/${F.sellerP.id}`, { seller_status: 'suspended' });
  assert.equal((await call(null, 'GET', `/api/products/${F.pP1}`)).status, 404, 'suspendu : de nouveau invisible');
});

test('sécurité : limitation des tentatives de connexion', async () => {
  const email = 'victime@test.ma';
  let last;
  for (let i = 0; i < 10; i++) last = await call({ cookie: '' }, 'POST', '/api/auth/login', { email, password: 'mauvais-mot-de-passe' });
  assert.equal(last.status, 429);
});

test('sécurité : sessions révocables (logout-all, changement de mot de passe, compte désactivé)', async () => {
  const old = await login(F.buyer2);
  const keep = { cookie: old.cookie };
  assert.equal((await call(old, 'GET', '/api/orders')).status, 200);
  assert.equal((await call(old, 'POST', '/api/auth/logout-all', {})).status, 200);
  assert.equal((await call(keep, 'GET', '/api/orders')).status, 401, 'ancien cookie invalide');
  F.s2 = await login(F.buyer2);

  const a = await login(F.buyer2); const b = await login(F.buyer2);
  const pw = await call(a, 'POST', '/api/auth/password', { current: PASSWORD, next: 'Nouveau-Mot-2-Passe!' });
  assert.equal(pw.status, 200);
  assert.equal((await call(b, 'GET', '/api/orders')).status, 401, "l'autre appareil est déconnecté");
  assert.equal((await call(a, 'GET', '/api/orders')).status, 200, "l'appareil courant reste connecté");
  await call(a, 'POST', '/api/auth/password', { current: 'Nouveau-Mot-2-Passe!', next: PASSWORD });
  F.s2 = await login(F.buyer2);

  const victim = await login(F.sellerP);
  await call(F.sAdmin, 'PATCH', `/api/admin/users/${F.sellerP.id}`, { active: false });
  assert.equal((await call(victim, 'GET', '/api/auth/me')).data.user, null, 'compte désactivé : session coupée');
  await call(F.sAdmin, 'PATCH', `/api/admin/users/${F.sellerP.id}`, { active: true });
});

test('sécurité : droits d\'accès (acheteur, vendeur, admin)', async () => {
  for (const s of [F.s1, F.sA]) assert.equal((await call(s, 'GET', '/api/admin/stats')).status, 403);
  assert.equal((await call(F.s1, 'GET', '/api/seller/earnings')).status, 403);
  assert.equal((await call(F.s1, 'POST', '/api/products', { title: 'abc', price: 10, stock: 1 })).status, 403);
  assert.equal((await call(F.sAdmin, 'GET', '/api/admin/stats')).status, 200);
  // un vendeur ne modifie pas le produit d'un autre
  assert.equal((await call(F.sB, 'PUT', `/api/products/${F.pA1}`, { price: 1 })).status, 403);
  assert.equal((await call(F.sB, 'DELETE', `/api/products/${F.pA1}`)).status, 403);
  // commission invalide
  assert.equal((await call(F.sAdmin, 'PATCH', `/api/admin/users/${F.sellerA.id}`, { commission_rate: 60 })).status, 400);
});

/* ------------------------------ Commission ------------------------------- */
test('commission : taux normal, taux de catégorie, taux négocié', async () => {
  // Vendeur A : 2 × 100 (10 %) + 1 × 200 artisanat (8 %) = 20 + 16 = 36 sur 400
  const r = await checkout(F.s1, [{ product_id: F.pA1, quantity: 2 }, { product_id: F.pA2, quantity: 1 }], cod);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.orders.length, 1);
  const o = r.data.orders[0];
  F.codOrder = o.id;
  assert.equal(o.total, 400);
  assert.equal(o.commission_amount, undefined, "l'acheteur ne voit pas la commission");
  const seller = (await call(F.sA, 'GET', '/api/seller/orders')).data.orders.find((x) => x.id === o.id);
  assert.equal(seller.commission_amount, 36);
  assert.equal(seller.seller_net, 364);

  // Vendeur C : taux négocié 5 % sur 1000 = 50
  const c = await checkout(F.s1, [{ product_id: F.pC1, quantity: 1 }], cod);
  const oc = (await call(F.sC, 'GET', '/api/seller/orders')).data.orders.find((x) => x.id === c.data.orders[0].id);
  assert.equal(oc.commission_amount, 50);
  await call(F.s1, 'PATCH', `/api/orders/${oc.id}/status`, { status: 'cancelled' });
});

test('commission : le réglage global change les nouvelles commandes seulement', async () => {
  const before = await checkout(F.s1, [{ product_id: F.pB1, quantity: 2 }], cod);              // 100 MAD à 10 %
  assert.equal((await call(F.sAdmin, 'PUT', '/api/admin/settings', { commission_default: 12 })).status, 200);
  const after = await checkout(F.s1, [{ product_id: F.pB1, quantity: 2 }], cod);
  const get = async (id) => (await call(F.sB, 'GET', '/api/seller/orders')).data.orders.find((x) => x.id === id).commission_amount;
  assert.equal(await get(before.data.orders[0].id), 10);
  assert.equal(await get(after.data.orders[0].id), 12);
  await call(F.sAdmin, 'PUT', '/api/admin/settings', { commission_default: 10 });
  assert.equal((await call(F.sAdmin, 'PUT', '/api/admin/settings', { commission_default: 80 })).status, 400);
  for (const o of [before, after]) await call(F.s1, 'PATCH', `/api/orders/${o.data.orders[0].id}/status`, { status: 'cancelled' });
});

/* ------------------------- Paiement à la livraison ------------------------ */
test('livraison (COD) : cycle complet, la commission est due par le vendeur', async () => {
  const id = F.codOrder;
  assert.equal((await call(F.s1, 'PATCH', `/api/orders/${id}/status`, { status: 'shipped' })).status, 409, "l'acheteur n'expédie pas");
  assert.equal((await call(F.s2, 'GET', `/api/orders/${id}`)).status, 404, "un autre acheteur ne voit pas la commande");
  assert.equal((await call(F.sA, 'PATCH', `/api/orders/${id}/status`, { status: 'shipped' })).status, 200);
  assert.equal((await call(F.s1, 'PATCH', `/api/orders/${id}/status`, { status: 'delivered' })).status, 200, "l'acheteur confirme la réception");
  assert.equal(payRow(id).status, 'paid', 'le cash est considéré encaissé à la livraison');
  const e = await earnings(F.sA);
  assert.equal(e.balance.cod_commission_due, 36);
  assert.equal(e.balance.available, -36, 'le vendeur doit 36 MAD à la plateforme');
  assert.equal(e.balance.pending, 0);
});

/* ------------------------- Virement + séquestre + versements ---------------- */
test('virement : seul l\'admin confirme, séquestre, versement', async () => {
  const r = await checkout(F.s1, [{ product_id: F.pC1, quantity: 1 }], { method: 'bank_transfer' });   // 1000 MAD, 5 % → net 950
  assert.equal(r.status, 201);
  assert.ok(r.data.instructions.iban && r.data.instructions.reference);
  const id = r.data.orders[0].id;
  assert.equal(r.data.orders[0].status, 'pending');
  assert.equal((await call(F.sC, 'PATCH', `/api/orders/${id}/status`, { status: 'shipped' })).status, 409, "pas d'expédition avant paiement");
  assert.equal((await call(F.sC, 'POST', `/api/admin/orders/${id}/confirm-payment`, {})).status, 403, 'le vendeur ne confirme pas un virement');
  assert.equal((await call(F.s1, 'POST', `/api/admin/orders/${id}/confirm-payment`, {})).status, 403, "l'acheteur non plus");
  assert.equal((await call(F.sAdmin, 'POST', `/api/admin/orders/${id}/confirm-payment`, { reference: 'VIR-001' })).status, 200);
  assert.equal(orderRow(id).status, 'paid');
  assert.equal((await call(F.sC, 'PATCH', `/api/orders/${id}/status`, { status: 'shipped' })).status, 200);
  assert.equal((await call(F.sC, 'PATCH', `/api/orders/${id}/status`, { status: 'delivered' })).status, 200);

  let e = await earnings(F.sC);
  assert.equal(e.balance.pending, 950, 'en séquestre pendant 7 jours');
  assert.equal(e.balance.available, 0);
  back(id, 8);
  e = await earnings(F.sC);
  assert.equal(e.balance.available, 950, 'séquestre terminé');

  // versement
  assert.equal((await call(F.sC, 'POST', '/api/seller/payouts', { amount: 300 })).status, 400, "coordonnées manquantes");
  assert.equal((await call(F.sC, 'PUT', '/api/seller/payout-info', { method: 'bank', details: 'RIB 000 000 0000000000000000 00' })).status, 200);
  assert.equal((await call(F.sC, 'POST', '/api/seller/payouts', { amount: 100 })).status, 400, 'sous le minimum');
  assert.equal((await call(F.sC, 'POST', '/api/seller/payouts', { amount: 951 })).status, 400, 'au-dessus du solde');
  const p = await call(F.sC, 'POST', '/api/seller/payouts', { amount: 300 });
  assert.equal(p.status, 201);
  assert.equal((await call(F.sC, 'POST', '/api/seller/payouts', { amount: 700 })).status, 400, 'solde déjà réservé');
  assert.equal((await earnings(F.sC)).balance.available, 650);
  assert.equal((await call(F.sC, 'POST', `/api/admin/payouts/${p.data.id}/pay`, { reference: 'X' })).status, 403);
  assert.equal((await call(F.sAdmin, 'POST', `/api/admin/payouts/${p.data.id}/pay`, { reference: 'VIR-SELLER-1' })).status, 200);
  e = await earnings(F.sC);
  assert.equal(e.balance.paid_out, 300);
  assert.equal(e.balance.available, 650);
});

test('virement : expiration automatique et remise en stock', async () => {
  const before = stock(F.pB1);
  const r = await checkout(F.s1, [{ product_id: F.pB1, quantity: 3 }], { method: 'cash_agency' });
  assert.equal(r.status, 201);
  assert.ok(r.data.instructions.receiver);
  const id = r.data.orders[0].id;
  assert.equal(stock(F.pB1), before - 3);
  sql().prepare("UPDATE orders SET expires_at = datetime('now', '-1 hour') WHERE id = ?").run(id);
  assert.equal(await M.lib.expireStale(), 1);
  assert.equal(orderRow(id).status, 'cancelled');
  assert.equal(stock(F.pB1), before, 'stock remis en vente');
});

/* --------------------------------- PayPal --------------------------------- */
test('PayPal : création de la commande (montant calculé par le serveur, converti en EUR)', async () => {
  const stockBefore = stock(F.pA1);
  const r = await checkout(F.s1, [{ product_id: F.pA1, quantity: 1 }], { method: 'paypal' }, { total: 1, price: 1 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.match(r.data.redirect_url, /^http:\/\/paypal\.test\/checkoutnow\?token=PP/);
  assert.equal(r.data.orders[0].status, 'awaiting_payment');
  assert.equal(stock(F.pA1), stockBefore - 1, 'stock réservé pendant le paiement');
  F.ppToken = new URL(r.data.redirect_url).searchParams.get('token');
  F.ppOrder = r.data.orders[0].id;
  F.ppRef = r.data.group_ref;

  const create = fake.state.requests.filter((q) => q.method === 'POST' && q.url === '/v2/checkout/orders').at(-1);
  assert.equal(create.body.purchase_units[0].amount.value, '10.00', '100 MAD / 10 = 10.00 EUR, jamais le montant du navigateur');
  assert.equal(create.body.purchase_units[0].amount.currency_code, 'EUR');
  assert.equal(create.headers['paypal-request-id'], F.ppRef, 'idempotence PayPal');
  assert.equal(create.body.payment_source.paypal.experience_context.user_action, 'PAY_NOW');
  assert.match(create.body.payment_source.paypal.experience_context.return_url, /\/api\/paypal\/return$/);
});

test('PayPal : retour avant paiement, mauvais utilisateur, puis paiement réussi (et rejeu)', async () => {
  let r = await call(F.s1, 'GET', `/api/paypal/return?token=${F.ppToken}`);       // PayPal pas encore approuvé
  assert.equal(r.status, 302);
  assert.match(r.location, /^\/#\/orders\?error=/);
  assert.equal(orderRow(F.ppOrder).status, 'awaiting_payment');

  fake.approve(F.ppToken);
  r = await call(F.s2, 'GET', `/api/paypal/return?token=${F.ppToken}`);           // un autre compte tente de valider
  assert.match(r.location, /error=/);
  assert.equal(orderRow(F.ppOrder).status, 'awaiting_payment');
  r = await call(null, 'GET', `/api/paypal/return?token=${F.ppToken}`);
  assert.match(r.location, /login/);

  r = await call(F.s1, 'GET', `/api/paypal/return?token=${F.ppToken}`);
  assert.equal(r.status, 302);
  assert.equal(r.location, `/#/confirmation?ref=${F.ppRef}`);
  assert.equal(orderRow(F.ppOrder).status, 'paid');
  assert.match(payRow(F.ppOrder).transaction_ref, /^CAP/);
  assert.equal(payRow(F.ppOrder).status, 'paid');

  const captures = () => fake.state.requests.filter((q) => q.url.endsWith('/capture')).length;
  const nBefore = captures();
  r = await call(F.s1, 'GET', `/api/paypal/return?token=${F.ppToken}`);           // rafraîchissement de la page
  assert.equal(r.location, `/#/confirmation?ref=${F.ppRef}`);
  assert.equal(captures(), nBefore, 'aucun second prélèvement demandé à PayPal');

  const res = await call(F.s1, 'GET', `/api/checkouts/${F.ppRef}`);
  assert.equal(res.data.payment_status, 'paid');
  assert.equal((await call(F.s2, 'GET', `/api/checkouts/${F.ppRef}`)).status, 404);
});

test('PayPal : un montant capturé différent n\'est jamais accepté', async () => {
  const r = await checkout(F.s1, [{ product_id: F.pA1, quantity: 1 }], { method: 'paypal' });
  const token = new URL(r.data.redirect_url).searchParams.get('token');
  fake.approve(token);
  fake.state.captureOverride = { currency_code: 'EUR', value: '1.00' };
  const ret = await call(F.s1, 'GET', `/api/paypal/return?token=${token}`);
  fake.state.captureOverride = null;
  assert.match(ret.location, /error=/);
  assert.equal(orderRow(r.data.orders[0].id).status, 'awaiting_payment');
  assert.ok(auditHas('paypal_amount_mismatch'));
  await call(F.s1, 'GET', `/api/paypal/cancel?token=${token}`);
});

test('PayPal : annulation par le client et panne PayPal libèrent le stock', async () => {
  const s0 = stock(F.pA1);
  const r = await checkout(F.s1, [{ product_id: F.pA1, quantity: 2 }], { method: 'paypal' });
  const token = new URL(r.data.redirect_url).searchParams.get('token');
  assert.equal(stock(F.pA1), s0 - 2);
  const c = await call(F.s1, 'GET', `/api/paypal/cancel?token=${token}`);
  assert.equal(c.location, '/#/cart?cancelled=1');
  assert.equal(orderRow(r.data.orders[0].id).status, 'cancelled');
  assert.equal(stock(F.pA1), s0);

  fake.state.failCreate = true;
  const down = await checkout(F.s1, [{ product_id: F.pA1, quantity: 2 }], { method: 'paypal' }, { idempotency_key: 'retry-after-fail' });
  fake.state.failCreate = false;
  assert.equal(down.status, 502);
  assert.equal(stock(F.pA1), s0, 'rien n\'est resté réservé');
  const retry = await checkout(F.s1, [{ product_id: F.pA1, quantity: 2 }], { method: 'paypal' }, { idempotency_key: 'retry-after-fail' });
  assert.equal(retry.status, 201, 'la même clé peut être réutilisée après un échec');
  await call(F.s1, 'GET', `/api/paypal/cancel?token=${new URL(retry.data.redirect_url).searchParams.get('token')}`);
});

test('PayPal : panier multi-vendeurs, remboursement proportionnel', async () => {
  const sA = stock(F.pA1); const sB = stock(F.pB1);
  const r = await checkout(F.s1, [{ product_id: F.pA1, quantity: 1 }, { product_id: F.pB1, quantity: 1 }], { method: 'paypal' });   // 100 + 50
  assert.equal(r.data.orders.length, 2);
  const token = new URL(r.data.redirect_url).searchParams.get('token');
  const created = fake.state.requests.filter((q) => q.url === '/v2/checkout/orders').at(-1);
  assert.equal(created.body.purchase_units[0].amount.value, '15.00');
  fake.approve(token);
  await call(F.s1, 'GET', `/api/paypal/return?token=${token}`);
  const [oA, oB] = r.data.orders.map((o) => o.id);
  assert.equal(orderRow(oA).status, 'paid'); assert.equal(orderRow(oB).status, 'paid');

  assert.equal((await call(F.s1, 'POST', `/api/admin/orders/${oA}/refund`, { reason: 'test' })).status, 403);
  const ref = await call(F.sAdmin, 'POST', `/api/admin/orders/${oA}/refund`, { reason: 'Client insatisfait' });
  assert.equal(ref.status, 200, JSON.stringify(ref.data));
  assert.equal(ref.data.manual_refund_required, false);
  assert.equal(fake.state.refunds.at(-1).amount.value, '10.00', '100 / 150 de 15,00 EUR');
  assert.equal(orderRow(oA).status, 'refunded');
  assert.equal(payRow(oA).status, 'refunded');
  assert.equal(stock(F.pA1), sA, 'commande non expédiée : stock remis');
  assert.equal(orderRow(oB).status, 'paid', "l'autre commande du panier n'est pas touchée");
  const again = await call(F.sAdmin, 'POST', `/api/admin/orders/${oA}/refund`, { reason: 'deux fois' });
  assert.equal(again.status, 409, 'pas de double remboursement');
  assert.equal(fake.state.refunds.length, 1);
  void sB;
});

test('PayPal : webhook signé accepté, webhook falsifié refusé', async () => {
  const post = (sig) => fetch(`${base}/api/paypal/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'paypal-transmission-sig': sig, 'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.paypal.com/cert', 'paypal-transmission-id': 't1', 'paypal-transmission-time': new Date().toISOString() },
    body: JSON.stringify({ event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'CAPX' } }),
  });
  assert.equal((await post('forged')).status, 400);
  assert.equal((await post('valid-signature')).status, 200);
});

test('PayPal : expiration, l\'argent bien reçu valide la commande au lieu de l\'annuler', async () => {
  const mk = async () => {
    const r = await checkout(F.s1, [{ product_id: F.pB1, quantity: 1 }], { method: 'paypal' });
    sql().prepare("UPDATE orders SET expires_at = datetime('now', '-1 minute') WHERE id = ?").run(r.data.orders[0].id);
    return r;
  };
  const lost = await mk();                                           // le client a fermé son navigateur sans payer
  const paidButLost = await mk();                                    // le client a payé mais n'est jamais revenu sur le site
  const t = new URL(paidButLost.data.redirect_url).searchParams.get('token');
  const o = fake.state.orders.get(t);
  o.status = 'COMPLETED'; o.captureId = 'CAPLOST1';
  await M.lib.expireStale();
  assert.equal(orderRow(lost.data.orders[0].id).status, 'cancelled');
  assert.equal(orderRow(paidButLost.data.orders[0].id).status, 'paid');
  assert.equal(payRow(paidButLost.data.orders[0].id).transaction_ref, 'CAPLOST1');
});

/* ------------------------------ Carte (simulée) --------------------------- */
test('carte simulée : acceptée, refusée, invalide', async () => {
  const card = (n) => ({ method: 'card', card_number: n, card_expiry: '12/35', card_cvc: '123', card_holder: 'AMINE' });
  const s0 = stock(F.pB1);
  const ok = await checkout(F.s1, [{ product_id: F.pB1, quantity: 1 }], card('4242 4242 4242 4242'));
  assert.equal(ok.status, 201);
  assert.equal(ok.data.payment_status, 'paid');
  assert.equal(ok.data.simulated, true);
  assert.equal(JSON.parse(payRow(ok.data.orders[0].id).details).last4, '4242');
  assert.ok(!JSON.stringify(sql().prepare('SELECT * FROM payments').all()).includes('4242424242424242'), 'numéro complet jamais stocké');
  assert.equal((await checkout(F.s1, [{ product_id: F.pB1, quantity: 1 }], card('4000 0000 0000 0002'))).status, 402);
  assert.equal((await checkout(F.s1, [{ product_id: F.pB1, quantity: 1 }], card('4242 4242 4242 4241'))).status, 400);
  assert.equal(stock(F.pB1), s0 - 1, 'les paiements refusés ne consomment pas de stock');
});

/* ------------------------- Intégrité des commandes ------------------------ */
test('commande : idempotence, atomicité, bornes, achat de son propre produit', async () => {
  const s0 = stock(F.pB1);
  const a = await checkout(F.s1, [{ product_id: F.pB1, quantity: 1 }], cod, { idempotency_key: 'same-click-1234' });
  const b = await checkout(F.s1, [{ product_id: F.pB1, quantity: 1 }], cod, { idempotency_key: 'same-click-1234' });
  assert.equal(a.data.group_ref, b.data.group_ref, 'double clic : même commande');
  assert.equal(stock(F.pB1), s0 - 1, 'stock décrémenté une seule fois');

  const countBefore = sql().prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  const sA = stock(F.pA1);
  const bad = await checkout(F.s1, [{ product_id: F.pA1, quantity: 1 }, { product_id: F.pB1, quantity: 99 }], cod);
  assert.equal(bad.status, 409);
  assert.equal(stock(F.pA1), sA, 'rollback complet du panier');
  assert.equal(sql().prepare('SELECT COUNT(*) AS n FROM orders').get().n, countBefore);

  for (const q of [0, -1, 1.5, 100, 'abc']) {
    assert.equal((await checkout(F.s1, [{ product_id: F.pB1, quantity: q }], cod)).status, 400, `quantité ${q}`);
  }
  assert.equal((await checkout(F.s1, [], cod)).status, 400);
  assert.equal((await checkout(F.sA, [{ product_id: F.pA1, quantity: 1 }], cod)).status, 400, 'on n\'achète pas ses propres produits');
  assert.equal((await checkout(F.s1, [{ product_id: F.pB1, quantity: 1 }], { method: 'bitcoin' })).status, 400);
  assert.equal((await call(F.s1, 'POST', '/api/orders', { items: [{ product_id: F.pB1, quantity: 1 }], payment: cod, shipping: { ...SHIP, phone: 'abc' } })).status, 400);
  await call(F.s1, 'PATCH', `/api/orders/${a.data.orders[0].id}/status`, { status: 'cancelled' });
  assert.equal(stock(F.pB1), s0, 'annulation : stock remis');
});

test('commande : limite de 20 commandes par 10 minutes et par compte', async () => {
  M.core.resetLimit(`order:u${F.s2.uid}`);
  let last;
  for (let i = 0; i < 22; i++) last = await call(F.s2, 'POST', '/api/orders', { items: [] });
  assert.equal(last.status, 429);
  M.core.resetLimit(`order:u${F.s2.uid}`);
});

/* -------------------------------- Avis ------------------------------------ */
test('avis : réservés aux acheteurs d\'une commande livrée, un seul par produit', async () => {
  const body = (o) => ({ order_id: F.codOrder, product_id: F.pA1, rating: 5, comment: 'Très bien', ...o });
  assert.equal((await call(F.s2, 'POST', '/api/reviews', body())).status, 404, "pas l'acheteur");
  const pending = await checkout(F.s1, [{ product_id: F.pB1, quantity: 1 }], cod);
  assert.equal((await call(F.s1, 'POST', '/api/reviews', body({ order_id: pending.data.orders[0].id, product_id: F.pB1 }))).status, 409, 'pas encore livré');
  assert.equal((await call(F.s1, 'POST', '/api/reviews', body({ product_id: F.pB1 }))).status, 400, "produit absent de la commande");
  assert.equal((await call(F.s1, 'POST', '/api/reviews', body({ rating: 6 }))).status, 400);
  assert.equal((await call(F.s1, 'POST', '/api/reviews', body({ comment: 'Appelez 0612345678' }))).status, 400);
  assert.equal((await call(F.s1, 'POST', '/api/reviews', body())).status, 201);
  assert.equal((await call(F.s1, 'POST', '/api/reviews', body())).status, 409, 'un seul avis');
  const p = (await call(null, 'GET', `/api/products/${F.pA1}`)).data;
  assert.equal(p.product.rating, 5);
  assert.equal(p.product.review_count, 1);
  assert.equal(p.reviews[0].buyer_name, 'Buyer', 'seul le prénom est public');
  await call(F.s1, 'PATCH', `/api/orders/${pending.data.orders[0].id}/status`, { status: 'cancelled' });
});

/* ------------------------------- Litiges ---------------------------------- */
test('litiges : bloquent le versement, résolus par l\'admin', async () => {
  const mk = async () => {
    const r = await checkout(F.s1, [{ product_id: F.pC1, quantity: 1 }], { method: 'bank_transfer' });
    const id = r.data.orders[0].id;
    await call(F.sAdmin, 'POST', `/api/admin/orders/${id}/confirm-payment`, {});
    await call(F.sC, 'PATCH', `/api/orders/${id}/status`, { status: 'shipped' });
    return id;
  };
  const e0 = (await earnings(F.sC)).balance;
  const id = await mk();
  assert.equal((await call(F.s2, 'POST', `/api/orders/${id}/dispute`, { reason: 'Je ne suis pas l\'acheteur' })).status, 404);
  assert.equal((await call(F.s1, 'POST', `/api/orders/${id}/dispute`, { reason: 'court' })).status, 400);
  assert.equal((await call(F.s1, 'POST', `/api/orders/${id}/dispute`, { reason: 'Le colis est arrivé cassé et incomplet' })).status, 201);
  assert.equal((await call(F.s1, 'POST', `/api/orders/${id}/dispute`, { reason: 'Un deuxième litige identique' })).status, 409);
  await call(F.sC, 'PATCH', `/api/orders/${id}/status`, { status: 'delivered' });
  back(id, 10);
  let e = (await earnings(F.sC)).balance;
  assert.equal(e.available, e0.available, 'litige ouvert : rien n\'est libéré');
  assert.equal(e.pending, e0.pending + 950);
  assert.equal((await call(F.sC, 'POST', `/api/admin/disputes/${id}/resolve`, { resolution: 'release' })).status, 403);
  assert.equal((await call(F.sAdmin, 'POST', `/api/admin/disputes/${id}/resolve`, { resolution: 'release', note: 'Photos non concluantes' })).status, 200);
  e = (await earnings(F.sC)).balance;
  assert.equal(e.available, e0.available + 950, 'litige rejeté : le vendeur est libéré');

  const id2 = await mk();
  await call(F.s1, 'POST', `/api/orders/${id2}/dispute`, { reason: 'Produit non conforme à la description' });
  const res = await call(F.sAdmin, 'POST', `/api/admin/disputes/${id2}/resolve`, { resolution: 'refund', note: 'Remboursement accordé' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.manual_refund_required, true, 'virement : remboursement manuel à faire par l\'admin');
  assert.equal(orderRow(id2).status, 'refunded');
  assert.equal((await earnings(F.sC)).balance.pending, e.pending, 'commande remboursée : rien n\'est ajouté au séquestre');
});

/* --------------------------- Tableau de bord admin ------------------------- */
test('admin : statistiques, journal d\'audit, liste des vendeurs', async () => {
  const s = (await call(F.sAdmin, 'GET', '/api/admin/stats')).data.stats;
  assert.ok(s.sales_total > 0 && s.orders_total > 0);
  assert.ok(s.commission_earned > 0);
  const log = (await call(F.sAdmin, 'GET', '/api/admin/audit?limit=200')).data.entries;
  for (const a of ['order_created', 'paypal_paid', 'payment_confirmed', 'order_refunded', 'payout_paid', 'login_failed']) {
    assert.ok(log.some((e) => e.action === a), `journal : ${a}`);
  }
  assert.ok(!JSON.stringify(log).includes('RIB 000'), 'les coordonnées bancaires ne sont pas dans le journal');
  const users = (await call(F.sAdmin, 'GET', '/api/admin/users?role=seller')).data.users;
  assert.ok(users.every((u) => u.balance && typeof u.products === 'number'));
});

/* ------------------------------ Migration v1 ------------------------------- */
test('migration : une base de la première version est conservée', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const old = path.join(os.tmpdir(), `mk-v1-${process.pid}.db`);
  for (const s of ['', '-wal', '-shm']) fs.rmSync(old + s, { force: true });
  const v1 = new DatabaseSync(old);
  v1.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'buyer' CHECK (role IN ('buyer','seller','admin')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
    CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, seller_id INTEGER NOT NULL REFERENCES users(id), category_id INTEGER REFERENCES categories(id),
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', price REAL NOT NULL, stock INTEGER NOT NULL DEFAULT 0, image_url TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, group_ref TEXT NOT NULL, buyer_id INTEGER NOT NULL REFERENCES users(id), seller_id INTEGER NOT NULL REFERENCES users(id),
      total REAL NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','shipped','delivered','cancelled')),
      shipping_name TEXT NOT NULL, shipping_phone TEXT NOT NULL, shipping_address TEXT NOT NULL, shipping_city TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, product_id INTEGER NOT NULL REFERENCES products(id),
      title TEXT NOT NULL, price REAL NOT NULL, quantity INTEGER NOT NULL);
    CREATE TABLE payment_methods (code TEXT PRIMARY KEY, label TEXT NOT NULL, kind TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE payments (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, method TEXT NOT NULL REFERENCES payment_methods(code),
      amount REAL NOT NULL, status TEXT NOT NULL DEFAULT 'pending', transaction_ref TEXT, details TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO users (name, email, password_hash, role) VALUES ('Vieux Vendeur', 'v@old.ma', 'x:y', 'seller'), ('Vieil Acheteur', 'a@old.ma', 'x:y', 'buyer');
    INSERT INTO products (seller_id, title, price, stock) VALUES (1, 'Ancien produit', 80, 5);
    INSERT INTO payment_methods VALUES ('cod', 'COD', 'offline', 1);
    INSERT INTO orders (group_ref, buyer_id, seller_id, total, status, shipping_name, shipping_phone, shipping_address, shipping_city) VALUES ('CK-OLD', 2, 1, 160, 'delivered', 'A', '0600000000', 'rue', 'Fès');
    INSERT INTO order_items (order_id, product_id, title, price, quantity) VALUES (1, 1, 'Ancien produit', 80, 2);
    INSERT INTO payments (order_id, method, amount, status) VALUES (1, 'cod', 160, 'paid');
  `);
  v1.close();
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, ['--no-warnings', '-e', `
    const { db } = require('./db');
    const o = db.prepare('SELECT status, total, commission_amount, seller_net, delivered_at FROM orders').get();
    const u = db.prepare("SELECT seller_status, active FROM users WHERE id = 1").get();
    const items = db.prepare('SELECT COUNT(*) AS n FROM order_items').get().n;
    const pays = db.prepare('SELECT COUNT(*) AS n FROM payments').get().n;
    const fk = db.prepare('PRAGMA foreign_key_check').all().length;
    const insertOk = (() => { db.prepare("INSERT INTO orders (group_ref,buyer_id,seller_id,total,status,shipping_name,shipping_phone,shipping_address,shipping_city) VALUES ('X',2,1,1,'awaiting_payment','a','b','c','d')").run(); return true; })();
    console.log(JSON.stringify({ o, u, items, pays, fk, insertOk }));
  `], { cwd: path.join(__dirname, '..'), env: { ...process.env, DB_FILE: old }, encoding: 'utf8' });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.o.status, 'delivered');
  assert.equal(r.o.total, 160);
  assert.equal(r.o.seller_net, 160, 'anciennes commandes : pas de commission rétroactive');
  assert.equal(r.u.seller_status, 'approved', 'anciens vendeurs conservés comme validés');
  assert.equal(r.items, 1); assert.equal(r.pays, 1);
  assert.equal(r.fk, 0, 'aucune clé étrangère cassée');
  assert.equal(r.insertOk, true, 'les nouveaux statuts sont acceptés');
  for (const s of ['', '-wal', '-shm']) fs.rmSync(old + s, { force: true });
});
