'use strict';
const { db, audit, getSettings, setSetting } = require('../db');
const { HttpError, route, str, numIn, intIn } = require('../core');
const { platformStats, sellerBalance } = require('../money');
const L = require('../orderlib');

const adminOnly = { roles: ['admin'] };

route('GET', '/api/admin/stats', adminOnly, () => ({ stats: platformStats(), settings: getSettings() }));

/* -------- Vendeurs et utilisateurs -------- */
route('GET', '/api/admin/users', adminOnly, ({ query }) => {
  const role = query.get('role');
  const rows = db.prepare(
    `SELECT id, name, email, role, active, seller_status, commission_rate, created_at FROM users
     ${role ? 'WHERE role = ?' : ''} ORDER BY (seller_status = 'pending' AND role = 'seller') DESC, id DESC LIMIT 300`
  ).all(...(role ? [role] : []));
  return {
    users: rows.map((u) => ({
      ...u,
      balance: u.role === 'seller' ? sellerBalance(u.id) : undefined,
      products: u.role === 'seller' ? db.prepare('SELECT COUNT(*) AS n FROM products WHERE seller_id = ?').get(u.id).n : undefined,
    })),
  };
});

route('PATCH', '/api/admin/users/:id', adminOnly, ({ params, body, user, ip }) => {
  const id = Number(params.id);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) throw new HttpError(404, 'Utilisateur introuvable');
  if (target.id === user.id) throw new HttpError(400, 'Vous ne pouvez pas modifier votre propre compte ici');
  if (target.role === 'admin') throw new HttpError(403, "Un compte administrateur ne se modifie pas depuis l'interface");
  const changes = {};
  if (body.seller_status !== undefined) {
    if (target.role !== 'seller') throw new HttpError(400, "Cet utilisateur n'est pas vendeur");
    if (!['pending', 'approved', 'suspended'].includes(body.seller_status)) throw new HttpError(400, 'Statut invalide');
    changes.seller_status = body.seller_status;
  }
  if (body.active !== undefined) changes.active = body.active ? 1 : 0;
  if (body.commission_rate !== undefined) {
    changes.commission_rate = body.commission_rate === null || body.commission_rate === ''
      ? null : numIn(body.commission_rate, 0, 50, 'Taux de commission');
  }
  if (!Object.keys(changes).length) throw new HttpError(400, 'Rien à modifier');
  const cols = Object.keys(changes);
  db.prepare(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')}${changes.active === 0 ? ', token_version = token_version + 1' : ''} WHERE id = ?`)
    .run(...cols.map((c) => changes[c]), id);
  audit(user.id, 'user_updated', `user:${id}`, changes, ip);
  return { ok: true };
});

/* -------- Réglages et commissions -------- */
route('GET', '/api/admin/commissions', adminOnly, () => ({
  settings: getSettings(),
  categories: db.prepare('SELECT id, name, commission_rate FROM categories ORDER BY name').all().map((c) => ({ ...c })),
}));

route('PUT', '/api/admin/settings', adminOnly, ({ body, user, ip }) => {
  const rules = {
    commission_default: [0, 50, 'Commission par défaut'],
    hold_days: [0, 30, 'Jours de séquestre'],
    min_payout: [0, 100000, 'Versement minimum'],
    manual_payment_hours: [1, 336, 'Délai de paiement manuel'],
  };
  const applied = {};
  for (const [key, [min, max, label]] of Object.entries(rules)) {
    if (body[key] === undefined) continue;
    applied[key] = numIn(body[key], min, max, label);
  }
  if (!Object.keys(applied).length) throw new HttpError(400, 'Rien à modifier');
  for (const [k, v] of Object.entries(applied)) setSetting(k, v);
  audit(user.id, 'settings_changed', 'settings', applied, ip);
  return { settings: getSettings() };
});

route('PUT', '/api/admin/categories/:id', adminOnly, ({ params, body, user, ip }) => {
  const id = intIn(params.id, 1, 1e9, 'Catégorie');
  if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(id)) throw new HttpError(404, 'Catégorie introuvable');
  const rate = body.commission_rate === null || body.commission_rate === '' ? null : numIn(body.commission_rate, 0, 50, 'Taux');
  db.prepare('UPDATE categories SET commission_rate = ? WHERE id = ?').run(rate, id);
  audit(user.id, 'category_rate_changed', `category:${id}`, { rate }, ip);
  return { ok: true };
});

/* -------- Paiements à confirmer, remboursements -------- */
route('GET', '/api/admin/payments-to-confirm', adminOnly, ({ user }) => ({
  orders: db.prepare(
    `SELECT o.id FROM orders o JOIN payments p ON p.order_id = o.id
     WHERE o.status = 'pending' AND p.method IN ('bank_transfer','cash_agency') AND p.status = 'pending' ORDER BY o.id`
  ).all().map((r) => L.loadOrder(r.id, user)),
}));

route('POST', '/api/admin/orders/:id/confirm-payment', adminOnly, ({ params, body, user, ip }) => {
  const order = L.loadOrder(Number(params.id), user);
  if (!order) throw new HttpError(404, 'Commande introuvable');
  if (!order.actions.includes('confirm_payment')) throw new HttpError(409, 'Aucun paiement à confirmer sur cette commande');
  L.confirmManualPayment(order.id, user.id, str(body.reference, 80, 'référence', { required: false }), ip);
  return { order: L.loadOrder(order.id, user) };
});

route('POST', '/api/admin/orders/:id/refund', adminOnly, async ({ params, body, user, ip }) => {
  const order = L.loadOrder(Number(params.id), user);
  if (!order) throw new HttpError(404, 'Commande introuvable');
  if (!order.actions.includes('refund')) throw new HttpError(409, 'Cette commande ne peut pas être remboursée');
  const reason = str(body.reason, 300, 'motif', { min: 3 });
  const { manual } = await L.refundOrder(order, user.id, reason, ip);
  return { order: L.loadOrder(order.id, user), manual_refund_required: manual };
});

route('GET', '/api/admin/orders', adminOnly, ({ query, user }) => {
  const status = query.get('status');
  const rows = db.prepare(`SELECT id FROM orders ${status ? 'WHERE status = ?' : ''} ORDER BY id DESC LIMIT 200`).all(...(status ? [status] : []));
  return { orders: rows.map((r) => L.loadOrder(r.id, user)) };
});

/* -------- Litiges -------- */
route('GET', '/api/admin/disputes', adminOnly, ({ user }) => ({
  disputes: db.prepare("SELECT order_id FROM disputes ORDER BY (status = 'open') DESC, id DESC LIMIT 100").all()
    .map((d) => L.loadOrder(d.order_id, user)),
}));

route('POST', '/api/admin/disputes/:orderId/resolve', adminOnly, async ({ params, body, user, ip }) => {
  const order = L.loadOrder(Number(params.orderId), user);
  if (!order?.dispute || order.dispute.status !== 'open') throw new HttpError(404, 'Aucun litige ouvert sur cette commande');
  const resolution = str(body.resolution, 10, 'décision');
  const note = str(body.note, 500, 'note', { required: false });
  if (resolution === 'refund') {
    const { manual } = await L.refundOrder(order, user.id, `litige : ${note || 'remboursement'}`, ip);
    db.prepare("UPDATE disputes SET note = ? WHERE order_id = ?").run(note, order.id);
    audit(user.id, 'dispute_resolved', `order:${order.id}`, { resolution, manual }, ip);
    return { order: L.loadOrder(order.id, user), manual_refund_required: manual };
  }
  if (resolution === 'release') {
    db.prepare("UPDATE disputes SET status = 'released', note = ?, resolved_at = datetime('now') WHERE order_id = ?").run(note, order.id);
    audit(user.id, 'dispute_resolved', `order:${order.id}`, { resolution }, ip);
    return { order: L.loadOrder(order.id, user) };
  }
  throw new HttpError(400, 'Décision invalide (refund ou release)');
});

/* -------- Versements aux vendeurs -------- */
route('GET', '/api/admin/payouts', adminOnly, () => ({
  payouts: db.prepare(
    `SELECT p.id, p.seller_id, u.name AS seller_name, p.amount, p.status, p.method, p.details, p.reference, p.created_at, p.paid_at
     FROM payouts p JOIN users u ON u.id = p.seller_id ORDER BY (p.status = 'requested') DESC, p.id DESC LIMIT 200`
  ).all().map((p) => ({ ...p })),
}));

route('POST', '/api/admin/payouts/:id/pay', adminOnly, ({ params, body, user, ip }) => {
  const id = Number(params.id);
  const p = db.prepare('SELECT * FROM payouts WHERE id = ?').get(id);
  if (!p || p.status !== 'requested') throw new HttpError(404, 'Demande de versement introuvable');
  const reference = str(body.reference, 80, 'référence du virement', { min: 3 });
  db.prepare("UPDATE payouts SET status = 'paid', reference = ?, paid_at = datetime('now') WHERE id = ?").run(reference, id);
  audit(user.id, 'payout_paid', `payout:${id}`, { amount: p.amount, reference }, ip);
  return { ok: true };
});

route('POST', '/api/admin/payouts/:id/reject', adminOnly, ({ params, body, user, ip }) => {
  const id = Number(params.id);
  const p = db.prepare('SELECT * FROM payouts WHERE id = ?').get(id);
  if (!p || p.status !== 'requested') throw new HttpError(404, 'Demande de versement introuvable');
  db.prepare("UPDATE payouts SET status = 'rejected', reference = ? WHERE id = ?").run(str(body.reason, 200, 'motif', { required: false }), id);
  audit(user.id, 'payout_rejected', `payout:${id}`, '', ip);
  return { ok: true };
});

/* -------- Journal d'audit -------- */
route('GET', '/api/admin/audit', adminOnly, ({ query }) => {
  const limit = Math.min(200, Math.max(1, Number(query.get('limit')) || 100));
  return {
    entries: db.prepare(
      `SELECT a.id, a.ts, a.action, a.target, a.details, a.ip, u.name AS actor
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT ?`
    ).all(limit).map((e) => ({ ...e })),
  };
});
