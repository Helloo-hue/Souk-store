'use strict';
const crypto = require('node:crypto');
const config = require('../config');
const { db, transaction, audit, getSettings } = require('../db');
const {
  HttpError, Reply, route, str, intIn, money, EMAIL_RE, PHONE_RE, noContactInfo, publicBase,
} = require('../core');
const { commissionRate } = require('../money');
const { getClient, toPayPalAmount } = require('../paypal');
const L = require('../orderlib');

/* --------------------------- Validation du paiement --------------------------- */
function luhn(number) {
  let sum = 0;
  let dbl = false;
  for (let i = number.length - 1; i >= 0; i--) {
    let d = number.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}
const cardBrand = (n) => (/^4/.test(n) ? 'Visa' : /^(5[1-5]|2[2-7])/.test(n) ? 'Mastercard' : 'Carte');

function validatePayment(pay) {
  const code = str(pay?.method, 30, 'mode de paiement');
  const method = L.availableMethods().find((m) => m.code === code);
  if (!method) throw new HttpError(400, 'Mode de paiement indisponible');
  if (code === 'card') {                       // simulation : on contrôle le format, on ne garde rien de sensible
    const number = String(pay.card_number || '').replace(/[\s-]/g, '');
    if (!/^\d{13,19}$/.test(number) || !luhn(number)) throw new HttpError(400, 'Numéro de carte invalide');
    const exp = /^(0[1-9]|1[0-2])\/(\d{2})$/.exec(String(pay.card_expiry || '').trim());
    if (!exp) throw new HttpError(400, "Date d'expiration invalide (MM/AA)");
    if (new Date(2000 + Number(exp[2]), Number(exp[1]), 1) <= new Date()) throw new HttpError(400, 'Carte expirée');
    if (!/^\d{3,4}$/.test(String(pay.card_cvc || ''))) throw new HttpError(400, 'Code CVC invalide');
    str(pay.card_holder, 80, 'titulaire de la carte');
    return { method, number, details: { brand: cardBrand(number), last4: number.slice(-4) } };
  }
  return { method, details: {} };
}

/* --------------------------------- Commande ---------------------------------- */
route('GET', '/api/payment-methods', () => ({ methods: L.availableMethods() }));

route('POST', '/api/orders', { auth: true, limit: ['order', 20, 600_000] }, async ({ body, user, req, ip }) => {
  const idem = typeof body.idempotency_key === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.idempotency_key)
    ? body.idempotency_key : null;
  if (idem) {                                   // double clic / rechargement : on renvoie la même commande
    const ex = db.prepare('SELECT group_ref FROM checkouts WHERE user_id = ? AND idem_key = ?').get(user.id, idem);
    if (ex) return new Reply(L.checkoutResult(ex.group_ref, user));
  }

  const itemsIn = Array.isArray(body.items) ? body.items : [];
  if (!itemsIn.length) throw new HttpError(400, 'Le panier est vide');
  if (itemsIn.length > 50) throw new HttpError(400, "Trop d'articles dans le panier");
  const wanted = new Map();
  for (const it of itemsIn) {
    const pid = intIn(it?.product_id, 1, 1e9, 'Produit');
    const qty = intIn(it?.quantity, 1, 99, 'Quantité');
    const total = (wanted.get(pid) || 0) + qty;
    if (total > 99) throw new HttpError(400, 'Quantité maximale : 99 par produit');
    wanted.set(pid, total);
  }
  const s = body.shipping || {};
  const shipping = {
    name: str(s.name, 100, 'nom du destinataire', { min: 2 }),
    phone: str(s.phone, 20, 'téléphone'),
    address: str(s.address, 200, 'adresse', { min: 5 }),
    city: str(s.city, 80, 'ville'),
  };
  if (!PHONE_RE.test(shipping.phone)) throw new HttpError(400, 'Numéro de téléphone invalide');
  const validated = validatePayment(body.payment);
  const code = validated.method.code;
  const settings = getSettings();

  // PayPal a besoin d'une adresse publique de retour : on la vérifie AVANT de toucher au stock.
  let returnBase = null;
  if (code === 'paypal') returnBase = publicBase(req);

  const groupRef = L.randomRef('CK');
  const initial = code === 'card' ? 'paid' : code === 'paypal' ? 'awaiting_payment' : 'pending';
  const expiry = code === 'paypal' ? '+30 minutes' : L.MANUAL_METHODS.includes(code) ? `+${settings.manual_payment_hours} hours` : null;

  // --- Création atomique : stock + une commande par vendeur + paiements. Tout ou rien.
  const { orderIds, grandTotal } = transaction(() => {
    const bySeller = new Map();
    for (const [pid, qty] of wanted) {
      const p = db.prepare(
        `SELECT p.*, u.active AS seller_active, u.seller_status, u.commission_rate AS seller_rate, c.commission_rate AS cat_rate
         FROM products p JOIN users u ON u.id = p.seller_id LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?`
      ).get(pid);
      if (!p || !p.seller_active || p.seller_status !== 'approved') throw new HttpError(404, `Produit #${pid} indisponible`);
      if (p.seller_id === user.id) throw new HttpError(400, `Vous ne pouvez pas acheter votre propre produit (« ${p.title} »)`);
      const dec = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?').run(qty, pid, qty);
      if (dec.changes !== 1) throw new HttpError(409, `Stock insuffisant pour « ${p.title} » (${p.stock} restant)`);
      const rate = commissionRate(p.seller_rate, p.cat_rate, settings.commission_default);
      if (!bySeller.has(p.seller_id)) bySeller.set(p.seller_id, []);
      bySeller.get(p.seller_id).push({ p, qty, rate });
    }

    // Les prix et la commission viennent TOUJOURS de la base, jamais du navigateur.
    let grand = 0;
    for (const lines of bySeller.values()) for (const l of lines) grand += l.p.price * l.qty;
    grand = money(grand);

    if (code === 'card' && validated.number === '4000000000000002') {
      throw new HttpError(402, 'Paiement refusé par la banque (carte de test « refusée »)');
    }
    const ppCurrency = code === 'paypal' ? config.paypal.currency : null;
    const ppAmount = code === 'paypal' ? toPayPalAmount(grand) : null;
    if (code === 'paypal' && !(ppAmount > 0)) throw new HttpError(400, 'Montant trop faible pour PayPal');

    const ids = [];
    for (const [sellerId, lines] of bySeller) {
      const total = money(lines.reduce((sum, l) => sum + l.p.price * l.qty, 0));
      const commission = money(lines.reduce((sum, l) => sum + (l.p.price * l.qty * l.rate) / 100, 0));
      const info = db.prepare(
        `INSERT INTO orders (group_ref, buyer_id, seller_id, total, commission_amount, seller_net, status,
                             shipping_name, shipping_phone, shipping_address, shipping_city, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${expiry ? "datetime('now', ?)" : 'NULL'})`
      ).run(groupRef, user.id, sellerId, total, commission, money(total - commission), initial,
            shipping.name, shipping.phone, shipping.address, shipping.city, ...(expiry ? [expiry] : []));
      const orderId = Number(info.lastInsertRowid);
      for (const l of lines) {
        db.prepare('INSERT INTO order_items (order_id, product_id, title, price, quantity, commission_rate) VALUES (?, ?, ?, ?, ?, ?)')
          .run(orderId, l.p.id, l.p.title, l.p.price, l.qty, l.rate);
      }
      const ref = code === 'card' ? 'SIM-CARD-' + crypto.randomBytes(4).toString('hex').toUpperCase()
        : L.MANUAL_METHODS.includes(code) ? groupRef : null;
      db.prepare(
        `INSERT INTO payments (order_id, method, amount, status, transaction_ref, currency, charged_amount, details, paid_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${code === 'card' ? "datetime('now')" : 'NULL'})`
      ).run(orderId, code, total, code === 'card' ? 'paid' : 'pending', ref, ppCurrency, ppAmount, JSON.stringify(validated.details));
      ids.push(orderId);
    }
    if (idem) db.prepare('INSERT INTO checkouts (user_id, idem_key, group_ref) VALUES (?, ?, ?)').run(user.id, idem, groupRef);
    return { orderIds: ids, grandTotal: grand };
  });
  audit(user.id, 'order_created', `group:${groupRef}`, { method: code, total: grandTotal, orders: orderIds }, ip);

  // --- PayPal : on crée la commande côté PayPal (montant calculé ici, jamais fourni par le navigateur)
  if (code === 'paypal') {
    const amount = db.prepare('SELECT charged_amount, currency FROM payments WHERE order_id = ?').get(orderIds[0]);
    try {
      const created = await getClient().createOrder({
        reference: groupRef, amount: amount.charged_amount, currency: amount.currency,
        returnUrl: `${returnBase}/api/paypal/return`, cancelUrl: `${returnBase}/api/paypal/cancel`, brand: config.paypal.brand,
      });
      db.prepare(`UPDATE payments SET provider_ref = ?, details = ? WHERE order_id IN (${orderIds.map(() => '?').join(',')})`)
        .run(created.id, JSON.stringify({ approve_url: created.approveUrl }), ...orderIds);
    } catch (e) {
      L.cancelOrders(orderIds, user.id, 'PayPal indisponible', ip);
      if (idem) db.prepare('DELETE FROM checkouts WHERE user_id = ? AND idem_key = ?').run(user.id, idem);
      audit(user.id, 'paypal_create_failed', `group:${groupRef}`, String(e.message), ip);
      throw new HttpError(502, "PayPal est momentanément indisponible. Votre panier est conservé, aucun montant n'a été prélevé.");
    }
  }
  return new Reply(L.checkoutResult(groupRef, user), { status: 201 });
});

route('GET', '/api/checkouts/:ref', { auth: true }, ({ params, user }) => {
  const result = L.checkoutResult(params.ref, user);
  if (!result) throw new HttpError(404, 'Commande introuvable');
  return result;
});

route('GET', '/api/orders', { auth: true }, ({ user }) => ({
  orders: db.prepare('SELECT id FROM orders WHERE buyer_id = ? ORDER BY id DESC LIMIT 200').all(user.id)
    .map((r) => L.loadOrder(r.id, user)),
}));

route('GET', '/api/orders/:id', { auth: true }, ({ params, user }) => {
  const order = L.loadOrder(Number(params.id), user);
  if (!order) throw new HttpError(404, 'Commande introuvable');
  return { order };
});

/* --------------------------- Changements de statut --------------------------- */
route('PATCH', '/api/orders/:id/status', { auth: true }, ({ params, body, user, ip }) => {
  const order = L.loadOrder(Number(params.id), user);
  if (!order) throw new HttpError(404, 'Commande introuvable');
  const next = str(body.status, 20, 'statut');
  const allowed = new Set(order.actions);
  if (next === 'cancelled' && allowed.has('cancel')) L.cancelOrders([order.id], user.id, `annulée par ${user.role}`, ip);
  else if (next === 'shipped' && allowed.has('ship')) L.markShipped(order.id, user.id, ip);
  else if (next === 'delivered' && (allowed.has('deliver') || allowed.has('confirm_receipt'))) L.markDelivered(order.id, user.id, ip);
  else throw new HttpError(409, 'Cette action est impossible pour cette commande dans son état actuel');
  return { order: L.loadOrder(order.id, user) };
});

/* --------------------------------- Litiges ----------------------------------- */
route('POST', '/api/orders/:id/dispute', { auth: true, limit: ['dispute', 10, 3_600_000] }, ({ params, body, user, ip }) => {
  const order = L.loadOrder(Number(params.id), user);
  if (!order) throw new HttpError(404, 'Commande introuvable');
  if (!order.actions.includes('dispute')) {
    throw new HttpError(409, 'Un litige est impossible : la commande est déjà en litige, ou le délai de protection est dépassé');
  }
  const reason = str(body.reason, 1000, 'motif', { min: 10 });
  db.prepare('INSERT INTO disputes (order_id, buyer_id, reason) VALUES (?, ?, ?)').run(order.id, user.id, reason);
  audit(user.id, 'dispute_opened', `order:${order.id}`, '', ip);
  return new Reply({ order: L.loadOrder(order.id, user) }, { status: 201 });
});

/* ----------------------------------- Avis ------------------------------------ */
// Seuls les acheteurs d'une commande livrée peuvent noter : les avis sont fiables.
route('POST', '/api/reviews', { auth: true, limit: ['review', 20, 3_600_000] }, ({ body, user, ip }) => {
  const orderId = intIn(body.order_id, 1, 1e9, 'Commande');
  const productId = intIn(body.product_id, 1, 1e9, 'Produit');
  const rating = intIn(body.rating, 1, 5, 'Note');
  const comment = noContactInfo(str(body.comment, 1000, 'commentaire', { required: false }), 'Commentaire');
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order || order.buyer_id !== user.id) throw new HttpError(404, 'Commande introuvable');
  if (order.status !== 'delivered') throw new HttpError(409, 'Vous pourrez noter ce produit une fois la commande livrée');
  if (!db.prepare('SELECT 1 FROM order_items WHERE order_id = ? AND product_id = ?').get(orderId, productId)) {
    throw new HttpError(400, "Ce produit ne fait pas partie de cette commande");
  }
  if (db.prepare('SELECT 1 FROM reviews WHERE order_id = ? AND product_id = ?').get(orderId, productId)) {
    throw new HttpError(409, 'Vous avez déjà noté ce produit');
  }
  db.prepare('INSERT INTO reviews (product_id, order_id, buyer_id, seller_id, rating, comment) VALUES (?, ?, ?, ?, ?, ?)')
    .run(productId, orderId, user.id, order.seller_id, rating, comment);
  audit(user.id, 'review_created', `product:${productId}`, '', ip);
  return new Reply({ ok: true }, { status: 201 });
});
