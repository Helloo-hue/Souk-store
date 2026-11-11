'use strict';
const { db, audit, getSettings } = require('../db');
const { HttpError, Reply, route, str, numIn, money } = require('../core');
const { sellerBalance } = require('../money');
const L = require('../orderlib');

const sellerOnly = { roles: ['seller', 'admin'] };

route('GET', '/api/seller/orders', sellerOnly, ({ user }) => {
  const rows = user.role === 'admin'
    ? db.prepare('SELECT id FROM orders ORDER BY id DESC LIMIT 300').all()
    : db.prepare('SELECT id FROM orders WHERE seller_id = ? ORDER BY id DESC LIMIT 300').all(user.id);
  return { orders: rows.map((r) => L.loadOrder(r.id, user)) };
});

// Revenus : ce qui est en séquestre, ce qui est disponible, ce qui a déjà été versé.
route('GET', '/api/seller/earnings', sellerOnly, ({ user }) => {
  const s = getSettings();
  const me = db.prepare('SELECT payout_method, payout_details, seller_status FROM users WHERE id = ?').get(user.id);
  return {
    balance: sellerBalance(user.id),
    min_payout: s.min_payout,
    payout_info: { method: me.payout_method, details: me.payout_details },
    seller_status: me.seller_status,
    payouts: db.prepare('SELECT id, amount, status, method, reference, created_at, paid_at FROM payouts WHERE seller_id = ? ORDER BY id DESC LIMIT 50')
      .all(user.id).map((p) => ({ ...p })),
  };
});

const PAYOUT_METHODS = { bank: 'Virement bancaire (RIB)', paypal: 'PayPal', cashplus: 'Cash Plus / Wafacash' };

route('PUT', '/api/seller/payout-info', { roles: ['seller'], limit: ['payout-info', 10, 3_600_000] }, ({ body, user, ip }) => {
  const method = str(body.method, 20, 'mode de versement');
  if (!PAYOUT_METHODS[method]) throw new HttpError(400, 'Mode de versement invalide');
  const details = str(body.details, 200, 'coordonnées', { min: 5 });
  db.prepare('UPDATE users SET payout_method = ?, payout_details = ? WHERE id = ?').run(method, details, user.id);
  audit(user.id, 'payout_info_changed', `user:${user.id}`, { method }, ip);    // les coordonnées ne sont pas écrites dans le journal
  return { ok: true };
});

route('POST', '/api/seller/payouts', { roles: ['seller'], limit: ['payout', 5, 3_600_000] }, ({ body, user, ip }) => {
  if (user.seller_status !== 'approved') throw new HttpError(403, "Votre compte vendeur n'est pas encore validé");
  const s = getSettings();
  const me = db.prepare('SELECT payout_method, payout_details FROM users WHERE id = ?').get(user.id);
  if (!me.payout_method || !me.payout_details) throw new HttpError(400, 'Ajoutez d\'abord vos coordonnées de versement');
  const amount = money(numIn(body.amount, 0.01, 10_000_000, 'Montant'));
  if (amount < s.min_payout) throw new HttpError(400, `Le montant minimum d'un versement est ${s.min_payout} MAD`);
  const balance = sellerBalance(user.id);
  if (amount > balance.available) throw new HttpError(400, `Montant supérieur à votre solde disponible (${balance.available} MAD)`);
  const info = db.prepare('INSERT INTO payouts (seller_id, amount, method, details) VALUES (?, ?, ?, ?)')
    .run(user.id, amount, me.payout_method, me.payout_details);
  const id = Number(info.lastInsertRowid);
  audit(user.id, 'payout_requested', `payout:${id}`, { amount }, ip);
  return new Reply({ ok: true, id }, { status: 201 });
});
