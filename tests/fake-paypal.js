'use strict';
// Faux serveur PayPal pour les tests : imite les routes de l'API REST utilisées par le site.
const http = require('node:http');
const crypto = require('node:crypto');

function startFakePayPal() {
  const state = { orders: new Map(), requests: [], refunds: [], captureOverride: null, failCreate: false };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      let body = {};
      try { body = raw && req.headers['content-type']?.includes('json') ? JSON.parse(raw) : raw; } catch { /* ignore */ }
      state.requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const send = (status, data) => {
        const s = JSON.stringify(data);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
        res.end(s);
      };
      const url = new URL(req.url, 'http://x');

      if (url.pathname === '/v1/oauth2/token') {
        const ok = req.headers.authorization === 'Basic ' + Buffer.from('test-client:test-secret').toString('base64');
        return ok ? send(200, { access_token: 'tok-123', expires_in: 3000 }) : send(401, { error: 'invalid_client' });
      }
      if (req.headers.authorization !== 'Bearer tok-123') return send(401, { name: 'AUTHENTICATION_FAILURE' });

      if (req.method === 'POST' && url.pathname === '/v2/checkout/orders') {
        if (state.failCreate) return send(500, { name: 'INTERNAL_SERVER_ERROR' });
        const id = 'PP' + crypto.randomBytes(6).toString('hex').toUpperCase();
        const unit = body.purchase_units[0];
        state.orders.set(id, {
          id, status: 'CREATED', amount: unit.amount, reference: unit.reference_id, captureId: null,
          returnUrl: body.payment_source.paypal.experience_context.return_url,
        });
        return send(201, { id, status: 'PAYER_ACTION_REQUIRED', links: [
          { rel: 'self', href: `http://paypal.test/v2/checkout/orders/${id}` },
          { rel: 'payer-action', href: `http://paypal.test/checkoutnow?token=${id}` },
        ] });
      }
      const m = /^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/.exec(url.pathname);
      if (m) {
        const o = state.orders.get(m[1]);
        if (!o) return send(404, { name: 'RESOURCE_NOT_FOUND' });
        const view = () => ({
          id: o.id, status: o.status,
          purchase_units: [{ reference_id: o.reference, amount: o.amount,
            payments: o.captureId ? { captures: [{ id: o.captureId, status: 'COMPLETED',
              amount: state.captureOverride || o.amount }] } : undefined }],
        });
        if (req.method === 'GET') return send(200, view());
        if (req.method === 'POST' && m[2]) {
          if (o.status === 'COMPLETED') return send(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] });
          if (o.status !== 'APPROVED') return send(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] });
          o.status = 'COMPLETED';
          o.captureId = 'CAP' + crypto.randomBytes(5).toString('hex').toUpperCase();
          return send(201, view());
        }
      }
      const r = /^\/v2\/payments\/captures\/([^/]+)\/refund$/.exec(url.pathname);
      if (r && req.method === 'POST') {
        state.refunds.push({ capture: r[1], amount: body.amount, requestId: req.headers['paypal-request-id'] });
        return send(201, { id: 'REF' + crypto.randomBytes(4).toString('hex'), status: 'COMPLETED' });
      }
      if (url.pathname === '/v1/notifications/verify-webhook-signature') {
        return send(200, { verification_status: body.transmission_sig === 'valid-signature' ? 'SUCCESS' : 'FAILURE' });
      }
      return send(404, { name: 'NOT_FOUND' });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        state,
        approve: (id) => { state.orders.get(id).status = 'APPROVED'; },   // le client "clique sur Payer" chez PayPal
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { startFakePayPal };
