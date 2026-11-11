'use strict';
// Logique partagée des commandes : lecture, annulation, paiement confirmé, remboursement, expiration.
const crypto = require('node:crypto');
const config = require('./config');
const { db, transaction, audit, getSettings } = require('./db');
const { HttpError, money } = require('./core');
const { getClient, PayPalError, paypalAvailable, paypalIsSimulated } = require('./paypal');

const MANUAL_METHODS = ['bank_transfer', 'cash_agency'];
const parseSqlDate = (s) => new Date(String(s).replace(' ', 'T') + 'Z').getTime();

/* ------------------------------ Modes de paiement ------------------------------ */
function availableMethods() {
  const rows = db.prepare('SELECT code, label, kind FROM payment_methods WHERE enabled = 1 ORDER BY rowid').all();
  return rows.filter((m) => {
    if (m.code === 'paypal') return paypalAvailable() && (!config.production || Boolean(config.baseUrl));
    if (m.code === 'card') return config.cardSimulation;
    if (m.code === 'bank_transfer') return Boolean(config.bank.iban);
    if (m.code === 'cash_agency') return Boolean(config.cashAgency.receiver);
    return true;
  }).map((m) => ({
    ...m,
    simulated: (m.code === 'card' && config.cardSimulation) || (m.code === 'paypal' && paypalIsSimulated()),
    ...(m.code === 'paypal' ? { currency: config.paypal.currency, rate: config.paypal.rate || 1 } : {}),
  }));
}

/* --------------------------------- Lecture ---------------------------------- */
function disputeWindowOpen(order) {
  if (order.status !== 'delivered') return true;
  const { hold_days } = getSettings();
  return Boolean(order.delivered_at) && parseSqlDate(order.delivered_at) + hold_days * 86_400_000 > Date.now();
}

// Actions possibles pour ce visiteur sur cette commande (une seule source de vérité, côté serveur)
function actionsFor(o, viewer) {
  const isBuyer = viewer.id === o.buyer_id;
  const isSeller = viewer.id === o.seller_id;
  const isAdmin = viewer.role === 'admin';
  const method = o.payment?.method;
  const pay = o.payment?.status;
  const a = [];
  if (['awaiting_payment', 'pending'].includes(o.status) && pay !== 'paid') {
    if (isBuyer || isAdmin || (isSeller && method === 'cod')) a.push('cancel');
  }
  if ((isSeller || isAdmin) && (o.status === 'paid' || (o.status === 'pending' && method === 'cod'))) a.push('ship');
  if (o.status === 'shipped') {
    if (isBuyer) a.push('confirm_receipt');
    else if (isSeller || isAdmin) a.push('deliver');
  }
  if (isAdmin && o.status === 'pending' && MANUAL_METHODS.includes(method) && pay === 'pending') a.push('confirm_payment');
  if (isAdmin && ['paid', 'shipped', 'delivered'].includes(o.status)) a.push('refund');
  if (isBuyer && ['paid', 'shipped', 'delivered'].includes(o.status) && !o.dispute && disputeWindowOpen(o)) a.push('dispute');
  return a;
}

// Renvoie null si le visiteur n'a pas accès à cette commande.
function loadOrder(id, viewer) {
  const o = db.prepare(
    `SELECT o.*, b.name AS buyer_name, s.name AS seller_name
     FROM orders o JOIN users b ON b.id = o.buyer_id JOIN users s ON s.id = o.seller_id WHERE o.id = ?`
  ).get(id);
  if (!o) return null;
  const isBuyer = viewer.id === o.buyer_id;
  const isSeller = viewer.id === o.seller_id;
  const isAdmin = viewer.role === 'admin';
  if (!isBuyer && !isSeller && !isAdmin) return null;

  const items = db.prepare(
    `SELECT oi.product_id, oi.title, oi.price, oi.quantity,
            EXISTS (SELECT 1 FROM reviews r WHERE r.order_id = oi.order_id AND r.product_id = oi.product_id) AS reviewed
     FROM order_items oi WHERE oi.order_id = ?`
  ).all(id).map((i) => ({ ...i, reviewed: Boolean(i.reviewed) }));

  const payRow = db.prepare(
    `SELECT pm.method, m.label AS method_label, pm.amount, pm.status, pm.transaction_ref, pm.currency, pm.charged_amount, pm.details
     FROM payments pm JOIN payment_methods m ON m.code = pm.method WHERE pm.order_id = ?`
  ).get(id);
  let details = {};
  try { details = payRow?.details ? JSON.parse(payRow.details) : {}; } catch { /* ignore */ }
  const payment = payRow && {
    method: payRow.method, method_label: payRow.method_label, amount: payRow.amount, status: payRow.status,
    transaction_ref: isBuyer || isAdmin ? payRow.transaction_ref : null,
    currency: payRow.currency, charged_amount: payRow.charged_amount,
    details: { brand: details.brand, last4: details.last4, payer_email: isAdmin ? details.payer_email : undefined },
  };
  const dispute = db.prepare('SELECT id, status, reason, note, created_at, resolved_at FROM disputes WHERE order_id = ?').get(id);

  const out = {
    id: o.id, group_ref: o.group_ref, buyer_id: o.buyer_id, buyer_name: o.buyer_name,
    seller_id: o.seller_id, seller_name: o.seller_name, total: o.total, status: o.status,
    shipping_name: o.shipping_name, shipping_phone: o.shipping_phone,
    shipping_address: o.shipping_address, shipping_city: o.shipping_city,
    expires_at: o.expires_at, delivered_at: o.delivered_at, created_at: o.created_at,
    items, payment, dispute: dispute ? { ...dispute } : null,
  };
  if (isSeller || isAdmin) { out.commission_amount = o.commission_amount; out.seller_net = o.seller_net; }
  out.actions = actionsFor({ ...out }, viewer);
  out.can_review = isBuyer && o.status === 'delivered';
  return out;
}

// Résultat complet d'un panier validé (une commande par vendeur)
function checkoutResult(groupRef, viewer) {
  const ids = db.prepare('SELECT id FROM orders WHERE group_ref = ? ORDER BY id').all(groupRef).map((r) => r.id);
  const orders = ids.map((id) => loadOrder(id, viewer)).filter(Boolean);
  if (!orders.length) return null;
  const pay = orders[0].payment;
  const allPaid = orders.every((o) => o.payment.status === 'paid');
  const result = {
    group_ref: groupRef,
    total: money(orders.reduce((s, o) => s + o.total, 0)),
    method: pay.method,
    method_label: pay.method_label,
    payment_status: allPaid ? 'paid' : orders[0].payment.status,
    simulated: (pay.method === 'card' && config.cardSimulation) || (pay.method === 'paypal' && paypalIsSimulated()),
    orders,
  };
  const first = db.prepare('SELECT details, p.status FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.group_ref = ? ORDER BY o.id LIMIT 1').get(groupRef);
  let det = {};
  try { det = first?.details ? JSON.parse(first.details) : {}; } catch { /* ignore */ }
  if (pay.method === 'paypal' && orders[0].status === 'awaiting_payment' && det.approve_url) result.redirect_url = det.approve_url;
  if (pay.method === 'bank_transfer') {
    result.instructions = {
      reference: groupRef, beneficiary: config.bank.holder, iban: config.bank.iban,
      message: `Indiquez la référence ${groupRef} dans le motif du virement. La commande est expédiée dès que l'administrateur confirme la réception.`,
      deadline: orders[0].expires_at,
    };
  } else if (pay.method === 'cash_agency') {
    result.instructions = {
      reference: groupRef, agency: config.cashAgency.name, receiver: config.cashAgency.receiver, phone: config.cashAgency.phone,
      message: `Envoyez ${result.total} MAD à ce bénéficiaire dans une agence ${config.cashAgency.name} et gardez le reçu. Indiquez la référence ${groupRef} (ou envoyez-la avec la photo du reçu).`,
      deadline: orders[0].expires_at,
    };
  } else if (pay.method === 'cod') {
    result.instructions = { message: 'Vous paierez en espèces au livreur à la réception.' };
  }
  return result;
}

/* ------------------------- Changements d'état (sûrs) ------------------------- */
const restock = (orderId) => {
  for (const it of db.prepare('SELECT product_id, quantity FROM order_items WHERE order_id = ?').all(orderId)) {
    db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(it.quantity, it.product_id);
  }
};

// Annule des commandes non payées et remet les produits en vente.
function cancelOrders(orderIds, actorId, reason, ip = '') {
  transaction(() => {
    for (const id of orderIds) {
      const o = db.prepare('SELECT status FROM orders WHERE id = ?').get(id);
      if (!o || !['awaiting_payment', 'pending'].includes(o.status)) continue;
      db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(id);
      db.prepare("UPDATE payments SET status = 'failed' WHERE order_id = ? AND status = 'pending'").run(id);
      restock(id);
      audit(actorId, 'order_cancelled', `order:${id}`, reason, ip);
    }
  });
}

function markShipped(orderId, actorId, ip) {
  db.prepare("UPDATE orders SET status = 'shipped' WHERE id = ?").run(orderId);
  audit(actorId, 'order_shipped', `order:${orderId}`, '', ip);
}

function markDelivered(orderId, actorId, ip) {
  transaction(() => {
    db.prepare("UPDATE orders SET status = 'delivered', delivered_at = datetime('now') WHERE id = ?").run(orderId);
    // Paiement à la livraison : l'argent vient d'être remis en main propre
    db.prepare(
      "UPDATE payments SET status = 'paid', paid_at = datetime('now') WHERE order_id = ? AND method = 'cod' AND status = 'pending'"
    ).run(orderId);
  });
  audit(actorId, 'order_delivered', `order:${orderId}`, '', ip);
}

// Virement / agence : l'administrateur confirme avoir reçu l'argent
function confirmManualPayment(orderId, adminId, reference, ip) {
  transaction(() => {
    db.prepare("UPDATE orders SET status = 'paid', expires_at = NULL WHERE id = ? AND status = 'pending'").run(orderId);
    db.prepare(
      "UPDATE payments SET status = 'paid', paid_at = datetime('now'), transaction_ref = COALESCE(NULLIF(?, ''), transaction_ref) WHERE order_id = ?"
    ).run(reference || '', orderId);
  });
  audit(adminId, 'payment_confirmed', `order:${orderId}`, { reference }, ip);
}

/* --------------------------------- PayPal ---------------------------------- */
// Applique le résultat d'une capture PayPal après avoir tout vérifié (statut, devise, montant).
function applyCapture(token, cap, ip = '') {
  const pays = db.prepare(
    `SELECT p.*, o.group_ref FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.provider_ref = ? AND p.method = 'paypal'`
  ).all(token);
  if (!pays.length) throw new HttpError(404, 'Paiement introuvable');
  const group = pays[0].group_ref;
  if (pays.every((p) => p.status === 'paid')) return group;
  if (cap.status !== 'COMPLETED' || cap.captureStatus !== 'COMPLETED') {
    audit(null, 'paypal_not_completed', token, { status: cap.status, capture: cap.captureStatus }, ip);
    throw new HttpError(402, "PayPal n'a pas encore confirmé le paiement. Réessayez dans un instant.");
  }
  const expected = pays[0].charged_amount;
  if (cap.currency !== pays[0].currency || Math.abs(cap.value - expected) > 0.005) {
    audit(null, 'paypal_amount_mismatch', token, { expected, got: cap.value, currency: cap.currency }, ip);
    throw new HttpError(502, 'Le montant payé ne correspond pas à la commande. Contactez le support avec votre référence.');
  }
  transaction(() => {
    for (const p of pays) {
      db.prepare("UPDATE orders SET status = 'paid', expires_at = NULL WHERE id = ? AND status = 'awaiting_payment'").run(p.order_id);
      db.prepare("UPDATE payments SET status = 'paid', transaction_ref = ?, paid_at = datetime('now') WHERE id = ? AND status = 'pending'")
        .run(cap.captureId, p.id);
    }
  });
  audit(null, 'paypal_paid', token, { group, capture: cap.captureId, amount: cap.value, currency: cap.currency }, ip);
  return group;
}

async function completePayPal(token, user, ip) {
  const pays = db.prepare(
    `SELECT p.status, o.buyer_id, o.status AS order_status, o.group_ref
     FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.provider_ref = ? AND p.method = 'paypal'`
  ).all(token);
  if (!pays.length) throw new HttpError(404, 'Paiement introuvable');
  if (pays[0].buyer_id !== user.id) throw new HttpError(403, 'Ce paiement ne vous appartient pas');
  if (pays.every((p) => p.status === 'paid')) return pays[0].group_ref;
  if (pays.some((p) => p.order_status === 'cancelled')) {
    throw new HttpError(409, "Cette commande a expiré ou a été annulée. Aucun montant n'a été prélevé.");
  }
  const client = getClient();
  let cap;
  try {
    cap = await client.captureOrder(token);
  } catch (e) {
    if (e instanceof PayPalError && e.issue === 'ORDER_ALREADY_CAPTURED') cap = await client.getOrder(token);
    else throw e;
  }
  return applyCapture(token, cap, ip);
}

// Montant remboursé pour UNE commande d'un panier payé en une seule fois
function refundShare(orderId) {
  const p = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(orderId);
  const groupSum = db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE provider_ref = ?').get(p.provider_ref).s;
  if (Math.abs(groupSum - p.amount) < 0.005) return p.charged_amount;
  return money((p.amount / groupSum) * p.charged_amount);
}

async function refundOrder(order, actorId, reason, ip) {
  const pay = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(order.id);
  if (!['paid', 'shipped', 'delivered'].includes(order.status)) throw new HttpError(409, 'Cette commande ne peut pas être remboursée');
  let manual = false;
  let refundRef = null;
  if (pay.method === 'paypal' && pay.status === 'paid') {
    if (!pay.transaction_ref) throw new HttpError(409, 'Capture PayPal introuvable pour cette commande');
    try {
      const r = await getClient().refundCapture(pay.transaction_ref, {
        amount: refundShare(order.id), currency: pay.currency, reference: `order-${order.id}`,
      });
      refundRef = r.id;
    } catch (e) {
      audit(actorId, 'refund_failed', `order:${order.id}`, String(e.message), ip);
      throw new HttpError(502, `Le remboursement PayPal a échoué (${e.issue || e.message}). Rien n'a été modifié.`);
    }
  } else if (pay.status === 'paid' && pay.method !== 'cod') {
    manual = true;      // virement / agence / carte simulée : l'administrateur rembourse lui-même
  }
  transaction(() => {
    const wasPaidOnly = order.status === 'paid';          // pas encore expédiée : les produits reviennent en stock
    db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").run(order.id);
    db.prepare("UPDATE payments SET status = 'refunded' WHERE order_id = ?").run(order.id);
    if (wasPaidOnly) restock(order.id);
    db.prepare("UPDATE disputes SET status = 'refunded', resolved_at = datetime('now') WHERE order_id = ? AND status = 'open'").run(order.id);
  });
  audit(actorId, 'order_refunded', `order:${order.id}`, { reason, refundRef, manual }, ip);
  return { manual };
}

/* ------------------------------- Expiration -------------------------------- */
// Annule les commandes dont le paiement n'est pas arrivé à temps. Pour PayPal, on interroge d'abord
// PayPal : si l'argent est bien arrivé (retour du client perdu), on valide la commande au lieu de l'annuler.
async function expireStale() {
  const rows = db.prepare(
    `SELECT o.id, p.method, p.provider_ref
     FROM orders o JOIN payments p ON p.order_id = o.id
     WHERE o.status IN ('awaiting_payment', 'pending') AND p.status = 'pending'
       AND o.expires_at IS NOT NULL AND o.expires_at <= datetime('now')`
  ).all();
  const handledRefs = new Set();
  let cancelled = 0;
  for (const r of rows) {
    if (r.method === 'paypal' && r.provider_ref) {
      if (handledRefs.has(r.provider_ref)) continue;
      handledRefs.add(r.provider_ref);
      const ids = db.prepare('SELECT order_id FROM payments WHERE provider_ref = ?').all(r.provider_ref).map((x) => x.order_id);
      try {
        const cap = await getClient().getOrder(r.provider_ref);
        if (cap.status === 'COMPLETED' && cap.captureStatus === 'COMPLETED') { applyCapture(r.provider_ref, cap); continue; }
      } catch (e) {
        if (!(e instanceof PayPalError && e.status === 404)) { audit(null, 'expire_check_failed', r.provider_ref, String(e.message)); continue; }
      }
      cancelOrders(ids, null, 'expiré (PayPal non payé)');
      cancelled += ids.length;
    } else {
      cancelOrders([r.id], null, 'expiré (paiement non reçu)');
      cancelled += 1;
    }
  }
  return cancelled;
}

const randomRef = (prefix) => `${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

module.exports = {
  availableMethods, loadOrder, checkoutResult, actionsFor, disputeWindowOpen,
  restock, cancelOrders, markShipped, markDelivered, confirmManualPayment,
  completePayPal, applyCapture, refundOrder, expireStale, randomRef, MANUAL_METHODS,
};
