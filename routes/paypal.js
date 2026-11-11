'use strict';
const config = require('../config');
const { db, audit } = require('../db');
const { HttpError, Reply, route, redirectTo } = require('../core');
const { getClient, paypalIsSimulated } = require('../paypal');
const L = require('../orderlib');

const tokenParam = (query) => {
  const t = (query.get('token') || '').trim();
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(t)) throw new HttpError(400, 'Jeton PayPal invalide');
  return t;
};

// Retour de PayPal après l'accord du client : on capture le paiement côté serveur.
route('GET', '/api/paypal/return', async ({ query, user, ip }) => {
  let token;
  try { token = tokenParam(query); } catch { return redirectTo('/#/cart'); }
  if (!user) return redirectTo('/#/login?next=' + encodeURIComponent('/orders'));
  try {
    const group = await L.completePayPal(token, user, ip);
    return redirectTo(`/#/confirmation?ref=${encodeURIComponent(group)}`);
  } catch (e) {
    audit(user.id, 'paypal_return_failed', token, String(e.message), ip);
    const msg = e instanceof HttpError ? e.message : 'Le paiement PayPal a échoué. Aucun montant ne doit être débité : réessayez.';
    return redirectTo(`/#/orders?error=${encodeURIComponent(msg)}`);
  }
});

// Le client a annulé chez PayPal : on libère le stock.
route('GET', '/api/paypal/cancel', ({ query, user, ip }) => {
  let token;
  try { token = tokenParam(query); } catch { return redirectTo('/#/cart'); }
  if (!user) return redirectTo('/#/login');
  const rows = db.prepare(
    `SELECT o.id, o.buyer_id FROM payments p JOIN orders o ON o.id = p.order_id
     WHERE p.provider_ref = ? AND p.method = 'paypal' AND o.status = 'awaiting_payment'`
  ).all(token);
  if (rows.length && rows[0].buyer_id === user.id) L.cancelOrders(rows.map((r) => r.id), user.id, 'paiement PayPal annulé', ip);
  return redirectTo('/#/cart?cancelled=1');
});

// Notifications de PayPal (filet de sécurité si le client ferme son navigateur avant le retour).
route('POST', '/api/paypal/webhook', { noCsrf: true }, async ({ req, body, ip }) => {
  const client = getClient();
  if (!client || paypalIsSimulated()) throw new HttpError(404, 'Webhook non configuré');
  let valid = false;
  try { valid = await client.verifyWebhook({ headers: req.headers, event: body, webhookId: config.paypal.webhookId }); }
  catch { valid = false; }
  if (!valid) {
    audit(null, 'paypal_webhook_rejected', '', '', ip);
    throw new HttpError(400, 'Signature invalide');
  }
  const type = body.event_type;
  const resource = body.resource || {};
  const orderToken = resource.supplementary_data?.related_ids?.order_id;
  if (type === 'PAYMENT.CAPTURE.COMPLETED' && orderToken) {
    try {
      const cap = await client.getOrder(orderToken);       // on revérifie auprès de PayPal, on ne fait pas confiance au corps reçu
      L.applyCapture(orderToken, cap, ip);
    } catch (e) { audit(null, 'paypal_webhook_error', orderToken, String(e.message), ip); }
  } else if (type === 'PAYMENT.CAPTURE.REFUNDED' || type === 'PAYMENT.CAPTURE.REVERSED') {
    audit(null, 'paypal_refund_or_chargeback', resource.id || '', { type }, ip);   // signalé à l'administrateur via le journal
  }
  return { ok: true };
});

/* ----- Page de simulation (développement uniquement, sans identifiants PayPal) ----- */
route('GET', '/api/dev/paypal', ({ query }) => {
  if (!paypalIsSimulated()) throw new HttpError(404, 'Introuvable');
  const t = tokenParam(query);
  const o = getClient().orders.get(t);
  if (!o) throw new HttpError(404, 'Commande PayPal simulée introuvable');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return new Reply({}, {
    html: `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PayPal (simulation)</title><link rel="stylesheet" href="/dev-paypal.css"></head><body>
<main><p class="tag">Simulation locale : ce n'est pas le vrai PayPal</p>
<h1>Payer ${esc(o.amount.toFixed(2))} ${esc(o.currency)}</h1>
<p>Commande ${esc(o.reference)}</p>
<a class="pay" href="/api/dev/paypal/pay?token=${esc(t)}">Payer maintenant</a>
<a class="cancel" href="/api/paypal/cancel?token=${esc(t)}">Annuler et retourner à la boutique</a></main></body></html>`,
  });
});

route('GET', '/api/dev/paypal/pay', ({ query }) => {
  if (!paypalIsSimulated()) throw new HttpError(404, 'Introuvable');
  const t = tokenParam(query);
  if (!getClient().approve(t)) throw new HttpError(409, 'Commande déjà traitée');
  return redirectTo(`/api/paypal/return?token=${encodeURIComponent(t)}`);
});

