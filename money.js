'use strict';
// Commission, séquestre et soldes des vendeurs.
const { db, getSettings } = require('./db');
const { money } = require('./core');

// Modes de paiement où l'argent passe d'abord par la plateforme (elle le garde jusqu'à la fin du séquestre).
const HELD_METHODS = ['paypal', 'card', 'bank_transfer', 'cash_agency'];

// Taux appliqué = taux négocié du vendeur, sinon taux de la catégorie, sinon taux normal.
function commissionRate(sellerRate, categoryRate, defaultRate) {
  const r = sellerRate ?? categoryRate ?? defaultRate;
  return Math.min(50, Math.max(0, Number(r)));
}

function sellerCommissionInfo(user) {
  const s = getSettings();
  const cats = {};
  for (const c of db.prepare('SELECT id, name, commission_rate FROM categories').all()) {
    cats[c.id] = { name: c.name, rate: commissionRate(user.commission_rate, c.commission_rate, s.commission_default) };
  }
  return {
    default_rate: s.commission_default,
    seller_rate: user.commission_rate,
    hold_days: s.hold_days,
    min_payout: s.min_payout,
    categories: cats,
  };
}

const parseSqlDate = (s) => new Date(String(s).replace(' ', 'T') + 'Z').getTime();

// Solde d'un vendeur :
//  - pending   : ventes payées, argent gardé par la plateforme (livraison ou séquestre en cours)
//  - available : ventes livrées dont le séquestre est terminé, moins les commissions dues sur les ventes "à la livraison"
//  - requested / paid_out : versements déjà demandés / déjà payés
function sellerBalance(sellerId) {
  const { hold_days } = getSettings();
  const holdMs = hold_days * 86_400_000;
  const now = Date.now();
  const rows = db.prepare(
    `SELECT o.id, o.status, o.seller_net, o.commission_amount, o.delivered_at,
            p.method, p.status AS pay_status,
            EXISTS (SELECT 1 FROM disputes d WHERE d.order_id = o.id AND d.status = 'open') AS disputed
     FROM orders o JOIN payments p ON p.order_id = o.id
     WHERE o.seller_id = ?`
  ).all(sellerId);

  let pending = 0;
  let released = 0;
  let codCommission = 0;
  for (const r of rows) {
    if (['cancelled', 'refunded', 'awaiting_payment'].includes(r.status)) continue;
    if (r.method === 'cod') {
      // Le vendeur encaisse l'argent lui-même : il doit la commission à la plateforme une fois livré.
      if (r.status === 'delivered') codCommission += r.commission_amount;
      continue;
    }
    if (r.pay_status !== 'paid') continue;
    const releasable = r.status === 'delivered' && r.delivered_at && !r.disputed &&
      parseSqlDate(r.delivered_at) + holdMs <= now;
    if (releasable) released += r.seller_net; else pending += r.seller_net;
  }

  const sumPayouts = (status) =>
    db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM payouts WHERE seller_id = ? AND status = ?').get(sellerId, status).s;
  const requested = sumPayouts('requested');
  const paidOut = sumPayouts('paid');
  return {
    pending: money(pending),
    available: money(released - codCommission - requested - paidOut),
    cod_commission_due: money(codCommission),
    requested: money(requested),
    paid_out: money(paidOut),
    hold_days,
  };
}

function platformStats() {
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  return {
    sales_total: money(one("SELECT COALESCE(SUM(total),0) AS v FROM orders WHERE status IN ('paid','shipped','delivered')").v),
    commission_earned: money(one("SELECT COALESCE(SUM(commission_amount),0) AS v FROM orders WHERE status = 'delivered'").v),
    commission_pending: money(one("SELECT COALESCE(SUM(commission_amount),0) AS v FROM orders WHERE status IN ('paid','shipped')").v),
    orders_total: one("SELECT COUNT(*) AS v FROM orders WHERE status NOT IN ('cancelled','awaiting_payment')").v,
    pending_sellers: one("SELECT COUNT(*) AS v FROM users WHERE role = 'seller' AND seller_status = 'pending'").v,
    payments_to_confirm: one(
      `SELECT COUNT(*) AS v FROM orders o JOIN payments p ON p.order_id = o.id
       WHERE o.status = 'pending' AND p.method IN ('bank_transfer','cash_agency') AND p.status = 'pending'`).v,
    open_disputes: one("SELECT COUNT(*) AS v FROM disputes WHERE status = 'open'").v,
    payouts_requested: one("SELECT COUNT(*) AS v FROM payouts WHERE status = 'requested'").v,
    payouts_requested_amount: money(one("SELECT COALESCE(SUM(amount),0) AS v FROM payouts WHERE status = 'requested'").v),
  };
}

module.exports = { HELD_METHODS, commissionRate, sellerCommissionInfo, sellerBalance, platformStats };
