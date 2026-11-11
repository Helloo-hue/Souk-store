'use strict';
// Client PayPal (API REST Orders v2) + simulateur local pour le développement sans identifiants.
// Les deux exposent la même interface : createOrder, captureOrder, getOrder, refundCapture, verifyWebhook.
const crypto = require('node:crypto');
const config = require('./config');

class PayPalError extends Error {
  constructor(status, body) {
    const issue = body?.details?.[0]?.issue || body?.name || 'ERREUR_PAYPAL';
    super(`PayPal ${status} : ${issue}`);
    this.status = status;
    this.issue = issue;
    this.body = body;
  }
}

const fixed = (n) => (Math.round((Number(n) + Number.EPSILON) * 100) / 100).toFixed(2);

// Normalise une réponse "order" de PayPal
function normalize(o) {
  const unit = o.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  const amount = capture?.amount || unit?.amount;
  return {
    id: o.id,
    status: o.status,                                  // CREATED, APPROVED, COMPLETED...
    captureId: capture?.id || null,
    captureStatus: capture?.status || null,            // COMPLETED, PENDING, DECLINED...
    currency: amount?.currency_code || null,
    value: amount ? Number(amount.value) : null,
    customId: unit?.custom_id || unit?.reference_id || null,
  };
}

/* ------------------------------- Client réel ------------------------------- */
class PayPalClient {
  constructor({ clientId, secret, apiBase }) {
    this.clientId = clientId;
    this.secret = secret;
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.cached = null;
  }

  async accessToken() {
    if (this.cached && this.cached.exp > Date.now() + 30_000) return this.cached.value;
    const auth = Buffer.from(`${this.clientId}:${this.secret}`).toString('base64');
    const res = await fetch(`${this.apiBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new PayPalError(res.status, body);
    this.cached = { value: body.access_token, exp: Date.now() + (body.expires_in || 300) * 1000 };
    return this.cached.value;
  }

  async request(method, path, body, requestId) {
    const headers = { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' };
    if (requestId) headers['PayPal-Request-Id'] = requestId;     // idempotence côté PayPal
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new PayPalError(res.status, data);
    return data;
  }

  async createOrder({ reference, amount, currency, returnUrl, cancelUrl, brand }) {
    const data = await this.request('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: reference,
        custom_id: reference,
        amount: { currency_code: currency, value: fixed(amount) },
      }],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: String(brand).slice(0, 127),
            locale: 'fr-FR',
            landing_page: 'LOGIN',
            shipping_preference: 'NO_SHIPPING',
            user_action: 'PAY_NOW',              // le montant final est connu : pas d'étape de revue
            return_url: returnUrl,
            cancel_url: cancelUrl,
          },
        },
      },
    }, reference);
    const link = (data.links || []).find((l) => l.rel === 'payer-action') || (data.links || []).find((l) => l.rel === 'approve');
    if (!link) throw new PayPalError(502, { name: 'NO_APPROVAL_LINK' });
    return { id: data.id, approveUrl: link.href };
  }

  async captureOrder(id) {
    return normalize(await this.request('POST', `/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {}, `capture-${id}`));
  }

  async getOrder(id) {
    return normalize(await this.request('GET', `/v2/checkout/orders/${encodeURIComponent(id)}`));
  }

  async refundCapture(captureId, { amount, currency, reference }) {
    const data = await this.request('POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
      amount: { currency_code: currency, value: fixed(amount) },
      note_to_payer: 'Remboursement de votre commande',
    }, `refund-${reference}`);
    return { id: data.id, status: data.status };
  }

  // Vérifie qu'un webhook vient bien de PayPal (signature vérifiée par PayPal lui-même).
  async verifyWebhook({ headers, event, webhookId }) {
    if (!webhookId) return false;
    const h = (k) => headers[k] || headers[k.toLowerCase()];
    const data = await this.request('POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: h('paypal-auth-algo'),
      cert_url: h('paypal-cert-url'),
      transmission_id: h('paypal-transmission-id'),
      transmission_sig: h('paypal-transmission-sig'),
      transmission_time: h('paypal-transmission-time'),
      webhook_id: webhookId,
      webhook_event: event,
    });
    return data.verification_status === 'SUCCESS';
  }
}

/* ------------------------------- Simulateur -------------------------------- */
// Imite PayPal en mémoire (développement uniquement). La page d'approbation est servie par /api/dev/paypal.
class SimulatedPayPal {
  constructor() { this.orders = new Map(); }

  async createOrder({ reference, amount, currency, returnUrl, cancelUrl }) {
    const id = 'SIM-' + crypto.randomBytes(8).toString('hex').toUpperCase();
    this.orders.set(id, { id, reference, amount: Number(fixed(amount)), currency, status: 'CREATED', returnUrl, cancelUrl, captureId: null });
    const base = new URL(returnUrl).origin;
    return { id, approveUrl: `${base}/api/dev/paypal?token=${id}` };
  }
  approve(id) {
    const o = this.orders.get(id);
    if (!o || o.status !== 'CREATED') return false;
    o.status = 'APPROVED';
    return true;
  }
  async captureOrder(id) {
    const o = this.orders.get(id);
    if (!o) throw new PayPalError(404, { name: 'RESOURCE_NOT_FOUND' });
    if (o.status === 'COMPLETED') throw new PayPalError(422, { details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] });
    if (o.status !== 'APPROVED') throw new PayPalError(422, { details: [{ issue: 'ORDER_NOT_APPROVED' }] });
    o.status = 'COMPLETED';
    o.captureId = 'SIMCAP-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    return this.view(o);
  }
  async getOrder(id) {
    const o = this.orders.get(id);
    if (!o) throw new PayPalError(404, { name: 'RESOURCE_NOT_FOUND' });
    return this.view(o);
  }
  view(o) {
    return { id: o.id, status: o.status, captureId: o.captureId, captureStatus: o.captureId ? 'COMPLETED' : null,
      currency: o.currency, value: o.amount, customId: o.reference };
  }
  async refundCapture() { return { id: 'SIMREF-' + crypto.randomBytes(5).toString('hex').toUpperCase(), status: 'COMPLETED' }; }
  async verifyWebhook() { return false; }
}

/* ------------------------------ Sélection --------------------------------- */
let client = null;
function getClient() {
  if (client) return client;
  if (config.paypal.configured) client = new PayPalClient(config.paypal);
  else if (config.paypal.simulation) client = new SimulatedPayPal();
  return client;
}
const paypalAvailable = () => Boolean(getClient());
const paypalIsSimulated = () => getClient() instanceof SimulatedPayPal;
// Pour les tests : remplacer le client
function setClient(c) { client = c; }

// Montant en devise PayPal à partir du total en dirhams
function toPayPalAmount(totalMad) {
  const rate = config.paypal.rate || 1;
  return Number(fixed(totalMad / rate));
}

module.exports = {
  PayPalClient, SimulatedPayPal, PayPalError, getClient, setClient,
  paypalAvailable, paypalIsSimulated, toPayPalAmount,
};
