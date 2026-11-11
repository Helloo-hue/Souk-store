'use strict';
/* Espace vendeur et administration (utilise les outils définis dans app.js). */

let feeInfo = null;   // commission applicable au vendeur connecté (pour le calcul pendant la saisie du prix)

const tabsNav = (base, current, list) => `<div class="tabs" role="tablist">${list.map(([key, label, badge]) =>
  `<a href="#/${base}${key === list[0][0] ? '' : '?tab=' + key}" ${current === key ? 'aria-current="page"' : ''}>${label}${badge ? ` <span class="count">${badge}</span>` : ''}</a>`).join('')}</div>`;

const card = (label, value, hint = '') => `<div class="stat"><div class="stat-label">${esc(label)}</div><div class="stat-value">${value}</div>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;

/* ======================== Espace vendeur ======================== */
function sellerActionsHtml(o) { return orderBlock(o, `Client : ${esc(o.shipping_name)} · ${esc(o.shipping_phone)} · ${esc(o.shipping_address)}, ${esc(o.shipping_city)}`); }

async function sellerPage(_, params) {
  if (!user) return go('#/login?next=' + encodeURIComponent('/seller'));
  if (!isSeller()) {
    main.innerHTML = '<div class="wrap empty"><h2>Espace réservé aux vendeurs</h2><p>Créez un compte vendeur pour publier vos produits.</p><a class="btn" href="#/register">Créer un compte vendeur</a></div>';
    return;
  }
  const tab = ['orders', 'earnings'].includes(params.get('tab')) ? params.get('tab') : 'products';
  const banner = user.seller_status === 'pending'
    ? notice("Votre compte est en cours de validation par l'administrateur. Vous pouvez préparer vos produits, mais ils ne seront visibles et achetables qu'après validation.", 'warn')
    : user.seller_status === 'suspended' ? notice('Votre compte vendeur est suspendu. Contactez l\'administrateur.') : '';
  const head = `<h1>Espace vendeur</h1>${banner}${tabsNav('seller', tab, [['products', 'Mes produits'], ['orders', 'Commandes reçues'], ['earnings', 'Revenus']])}`;

  if (tab === 'orders') {
    const { orders } = await api('/seller/orders');
    main.innerHTML = `<div class="wrap">${head}<div class="stack">${orders.length ? orders.map(sellerActionsHtml).join('')
      : '<div class="empty"><h2>Aucune commande reçue</h2><p>Les commandes de vos clients apparaîtront ici.</p></div>'}</div></div>`;
    return;
  }

  if (tab === 'earnings') {
    const e = await api('/seller/earnings');
    const b = e.balance;
    const methods = { bank: 'Virement bancaire (RIB)', paypal: 'PayPal (email)', cashplus: 'Cash Plus / Wafacash (nom et téléphone)' };
    main.innerHTML = `<div class="wrap">${head}
      <div class="stats">
        ${card('Disponible', fmt(b.available), 'Vous pouvez demander un versement')}
        ${card('En séquestre', fmt(b.pending), `Libéré ${b.hold_days} jours après la livraison`)}
        ${card('Déjà versé', fmt(b.paid_out))}
        ${b.cod_commission_due ? card('Commission COD due', fmt(b.cod_commission_due), 'Déduite de votre solde') : ''}
      </div>
      <p class="muted">Pour les paiements en ligne, par virement ou en agence, l'argent est d'abord gardé par la plateforme, puis libéré ${b.hold_days} jours après la livraison si aucun litige n'est ouvert. Pour le paiement à la livraison, vous encaissez vous-même et la commission est déduite de votre solde.</p>
      <div class="two">
        <form class="panel stack" data-form="payout-info" novalidate><h2>Où recevoir mes versements</h2>
          <div><label for="po-m">Mode</label><select id="po-m" name="method">${Object.entries(methods).map(([k, v]) => `<option value="${k}"${e.payout_info.method === k ? ' selected' : ''}>${v}</option>`).join('')}</select></div>
          <div><label for="po-d">Coordonnées</label><input id="po-d" name="details" value="${esc(e.payout_info.details)}" maxlength="200" placeholder="RIB, email PayPal ou nom + téléphone"></div>
          <div class="form-error"></div><button class="btn" type="submit">Enregistrer</button></form>
        <form class="panel stack" data-form="payout-request" novalidate><h2>Demander un versement</h2>
          <div><label for="pr-a">Montant (MAD)</label><input id="pr-a" name="amount" type="number" min="${e.min_payout}" step="0.01" max="${Math.max(0, b.available)}" value="${b.available >= e.min_payout ? b.available : ''}"><div class="hint">Minimum ${fmt(e.min_payout)}</div></div>
          <div class="form-error"></div><button class="btn" type="submit" ${b.available < e.min_payout ? 'disabled' : ''}>Demander le versement</button></form>
      </div>
      <h2>Historique des versements</h2>
      ${e.payouts.length ? `<div class="panel table-wrap"><table><thead><tr><th>Date</th><th>Montant</th><th>Statut</th><th>Référence</th></tr></thead><tbody>
        ${e.payouts.map((p) => `<tr><td>${fmtDate(p.created_at)}</td><td>${fmt(p.amount)}</td><td><span class="pill ${p.status === 'paid' ? 'ok' : p.status === 'rejected' ? 'bad' : 'warn'}">${{ requested: 'Demandé', paid: 'Payé', rejected: 'Refusé' }[p.status]}</span></td><td>${esc(p.reference)}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">Aucun versement pour le moment.</p>'}
    </div>`;
    return;
  }

  const [{ items }, { categories }] = await Promise.all([api('/my/products'), api('/categories')]);
  feeInfo = await api('/seller/commission');
  items.forEach((p) => productCache.set(p.id, p));
  const editing = params.get('edit') ? items.find((p) => p.id === Number(params.get('edit'))) : null;
  const showForm = editing || params.get('new') === '1';
  const v = editing || {};
  main.innerHTML = `<div class="wrap">${head}
    ${showForm ? `<form class="panel stack form-gap" data-form="product" data-id="${editing ? editing.id : ''}" novalidate>
      <h2>${editing ? 'Modifier le produit' : 'Nouveau produit'}</h2>
      <div><label for="p-title">Titre</label><input id="p-title" name="title" required value="${esc(v.title)}"></div>
      <div><label for="p-desc">Description</label><textarea id="p-desc" name="description">${esc(v.description)}</textarea>
        <div class="hint">Pas de téléphone, email, lien ni WhatsApp dans l'annonce : tout se passe par la plateforme, ce qui protège votre paiement.</div></div>
      <div class="row3">
        <div><label for="p-cat">Catégorie</label><select id="p-cat" name="category_id"><option value="">Aucune</option>
          ${categories.map((c) => `<option value="${c.id}"${v.category_id === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
        <div><label for="p-price">Prix (MAD)</label><input id="p-price" name="price" type="number" min="1" step="0.01" required value="${esc(v.price)}"></div>
        <div><label for="p-stock">Stock</label><input id="p-stock" name="stock" type="number" min="0" step="1" required value="${esc(v.stock ?? 1)}"></div>
      </div>
      <div class="notice" id="fee-hint" aria-live="polite"></div>
      <div><label for="p-img">Image (lien https, facultatif)</label><input id="p-img" name="image_url" type="url" placeholder="https://…" value="${esc(v.image_url)}">
        <div class="hint">Sans image, un motif coloré est généré automatiquement.</div></div>
      <div class="form-error"></div>
      <div class="actions"><button class="btn" type="submit">${editing ? 'Enregistrer' : 'Publier le produit'}</button><a class="btn ghost" href="#/seller">Annuler</a></div>
    </form>` : '<p><a class="btn" href="#/seller?new=1">Ajouter un produit</a></p>'}
    ${items.length ? `<div class="panel table-wrap"><table><thead><tr><th>Produit</th><th>Prix</th><th>Stock</th><th><span class="sr">Actions</span></th></tr></thead><tbody>
      ${items.map((p) => `<tr><td><a href="#/product/${p.id}">${esc(p.title)}</a><div class="seller">${esc(p.category || 'Divers')}</div></td>
        <td>${fmt(p.price)}</td><td>${p.stock === 0 ? '<span class="pill bad">Épuisé</span>' : p.stock}</td>
        <td class="right"><div class="actions end"><a class="btn ghost small" href="#/seller?edit=${p.id}">Modifier</a>
        <button class="btn danger small" type="button" data-action="delete-product" data-id="${p.id}">Supprimer</button></div></td></tr>`).join('')}
    </tbody></table></div>` : (showForm ? '' : '<div class="empty"><h2>Aucun produit publié</h2><p>Ajoutez votre premier produit pour commencer à vendre.</p></div>')}
  </div>`;
  if (showForm) updateFeeHint();
}

// "Commission 10 % : vous recevez 90 MAD" pendant la saisie
function updateFeeHint() {
  const box = $('#fee-hint');
  if (!box || !feeInfo) return;
  const price = Number($('#p-price')?.value);
  const catId = $('#p-cat')?.value;
  const rate = feeInfo.seller_rate ?? (catId && feeInfo.categories[catId] ? feeInfo.categories[catId].rate : feeInfo.default_rate);
  if (!(price > 0)) { box.textContent = `Commission de la plateforme : ${rate} % du prix de vente.`; return; }
  const fee = Math.round(price * rate) / 100;
  box.textContent = `Commission de la plateforme : ${rate} % (${fmt(fee)}). Vous recevez ${fmt(price - fee)} par vente.`;
}

/* ======================== Administration ======================== */
async function adminPage(_, params) {
  if (!user) return go('#/login?next=' + encodeURIComponent('/admin'));
  if (!isAdmin()) { main.innerHTML = '<div class="wrap empty"><h2>Accès réservé</h2></div>'; return; }
  const tab = ['sellers', 'payments', 'disputes', 'payouts', 'commissions', 'audit'].includes(params.get('tab')) ? params.get('tab') : 'overview';
  const { stats: s } = await api('/admin/stats');
  const head = `<h1>Administration</h1>${tabsNav('admin', tab, [
    ['overview', 'Aperçu'], ['sellers', 'Vendeurs', s.pending_sellers], ['payments', 'Paiements à confirmer', s.payments_to_confirm],
    ['disputes', 'Litiges', s.open_disputes], ['payouts', 'Versements', s.payouts_requested], ['commissions', 'Commissions'], ['audit', 'Journal']])}`;

  if (tab === 'overview') {
    const todo = (n, label, t) => (n ? `<li><a href="#/admin?tab=${t}"><strong>${n}</strong> ${label}</a></li>` : '');
    const items = [todo(s.pending_sellers, 'vendeur(s) à valider', 'sellers'), todo(s.payments_to_confirm, 'paiement(s) à confirmer', 'payments'),
      todo(s.open_disputes, 'litige(s) ouvert(s)', 'disputes'), todo(s.payouts_requested, `versement(s) à payer (${fmt(s.payouts_requested_amount)})`, 'payouts')].join('');
    main.innerHTML = `<div class="wrap">${head}
      <div class="stats">
        ${card('Ventes totales', fmt(s.sales_total), 'Commandes payées, expédiées ou livrées')}
        ${card('Commission gagnée', fmt(s.commission_earned), 'Sur les commandes livrées')}
        ${card('Commission à venir', fmt(s.commission_pending), 'Commandes payées ou expédiées')}
        ${card('Commandes', s.orders_total)}
      </div>
      <div class="panel"><h2>À faire</h2>${items ? `<ul class="todo">${items}</ul>` : '<p class="muted">Rien en attente.</p>'}</div></div>`;
    return;
  }

  if (tab === 'sellers') {
    const { users } = await api('/admin/users?role=seller');
    main.innerHTML = `<div class="wrap">${head}
      <p class="muted">Un nouveau vendeur doit être validé avant que ses produits soient visibles. Vous pouvez aussi fixer un taux de commission négocié pour un vendeur (vide = taux normal).</p>
      ${users.length ? `<div class="panel table-wrap"><table><thead><tr><th>Vendeur</th><th>Statut</th><th>Produits</th><th>Solde</th><th>Taux négocié</th><th><span class="sr">Actions</span></th></tr></thead><tbody>
      ${users.map((u) => `<tr><td><strong>${esc(u.name)}</strong><div class="seller">${esc(u.email)}</div></td>
        <td><span class="pill ${u.seller_status === 'approved' ? 'ok' : u.seller_status === 'pending' ? 'warn' : 'bad'}">${{ approved: 'Validé', pending: 'À valider', suspended: 'Suspendu' }[u.seller_status]}</span>${u.active ? '' : ' <span class="pill bad">Désactivé</span>'}</td>
        <td>${u.products}</td>
        <td><div>Dispo : ${fmt(u.balance.available)}</div><div class="seller">Séquestre : ${fmt(u.balance.pending)}</div></td>
        <td><form class="inline-form" data-form="seller-rate" data-id="${u.id}"><label class="sr" for="sr-${u.id}">Taux (%)</label><input id="sr-${u.id}" name="rate" type="number" min="0" max="50" step="0.1" value="${u.commission_rate ?? ''}" placeholder="normal"><button class="btn ghost small" type="submit">OK</button></form></td>
        <td class="right"><div class="actions end">
          ${u.seller_status !== 'approved' ? `<button class="btn small" type="button" data-action="seller-status" data-id="${u.id}" data-status="approved">Valider</button>` : ''}
          ${u.seller_status !== 'suspended' ? `<button class="btn danger small" type="button" data-action="seller-status" data-id="${u.id}" data-status="suspended">Suspendre</button>` : ''}
        </div></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty"><h2>Aucun vendeur</h2></div>'}</div>`;
    return;
  }

  if (tab === 'payments') {
    const { orders } = await api('/admin/payments-to-confirm');
    main.innerHTML = `<div class="wrap">${head}
      <p class="muted">Virements et paiements en agence : confirmez ici quand l'argent est bien arrivé sur votre compte. Le vendeur ne peut pas le faire à votre place.</p>
      <div class="stack">${orders.length ? orders.map((o) => orderBlock(o, `Acheteur : ${esc(o.buyer_name)} · Vendeur : ${esc(o.seller_name)}`, { adminView: true })).join('')
        : '<div class="empty"><h2>Aucun paiement à confirmer</h2></div>'}</div></div>`;
    return;
  }

  if (tab === 'disputes') {
    const { disputes } = await api('/admin/disputes');
    main.innerHTML = `<div class="wrap">${head}
      <div class="stack">${disputes.length ? disputes.map((o) => `<div class="stack">${orderBlock(o, `Acheteur : ${esc(o.buyer_name)} · Vendeur : ${esc(o.seller_name)}`, { adminView: true })}
        ${o.dispute.status === 'open' ? `<div class="actions"><button class="btn small danger" type="button" data-action="dispute-resolve" data-id="${o.id}" data-res="refund">Rembourser l'acheteur</button>
          <button class="btn small ghost" type="button" data-action="dispute-resolve" data-id="${o.id}" data-res="release">Donner raison au vendeur</button></div>` : ''}</div>`).join('')
        : '<div class="empty"><h2>Aucun litige</h2></div>'}</div></div>`;
    return;
  }

  if (tab === 'payouts') {
    const { payouts } = await api('/admin/payouts');
    main.innerHTML = `<div class="wrap">${head}
      <p class="muted">Faites le virement vous-même (banque, PayPal ou agence) vers les coordonnées indiquées, puis marquez la demande comme payée avec la référence de l'opération.</p>
      ${payouts.length ? `<div class="panel table-wrap"><table><thead><tr><th>Date</th><th>Vendeur</th><th>Montant</th><th>Vers</th><th>Statut</th><th><span class="sr">Actions</span></th></tr></thead><tbody>
      ${payouts.map((p) => `<tr><td>${fmtDate(p.created_at)}</td><td>${esc(p.seller_name)}</td><td><strong>${fmt(p.amount)}</strong></td>
        <td>${esc({ bank: 'RIB', paypal: 'PayPal', cashplus: 'Cash Plus' }[p.method] || p.method)} : ${esc(p.details)}</td>
        <td><span class="pill ${p.status === 'paid' ? 'ok' : p.status === 'rejected' ? 'bad' : 'warn'}">${{ requested: 'À payer', paid: 'Payé', rejected: 'Refusé' }[p.status]}</span>${p.reference ? `<div class="seller">${esc(p.reference)}</div>` : ''}</td>
        <td class="right">${p.status === 'requested' ? `<div class="actions end"><button class="btn small" type="button" data-action="payout-pay" data-id="${p.id}">Marquer payé</button>
          <button class="btn danger small" type="button" data-action="payout-reject" data-id="${p.id}">Refuser</button></div>` : ''}</td></tr>`).join('')}</tbody></table></div>`
        : '<div class="empty"><h2>Aucune demande de versement</h2></div>'}</div>`;
    return;
  }

  if (tab === 'commissions') {
    const { settings, categories } = await api('/admin/commissions');
    main.innerHTML = `<div class="wrap">${head}
      <div class="two">
        <form class="panel stack" data-form="settings" novalidate><h2>Réglages généraux</h2>
          <div><label for="st-c">Commission par défaut (%)</label><input id="st-c" name="commission_default" type="number" min="0" max="50" step="0.1" value="${settings.commission_default}"><div class="hint">Prélevée sur chaque vente. S'applique aux nouvelles commandes seulement.</div></div>
          <div><label for="st-h">Jours de séquestre après livraison</label><input id="st-h" name="hold_days" type="number" min="0" max="30" step="1" value="${settings.hold_days}"><div class="hint">C'est aussi le délai pendant lequel l'acheteur peut ouvrir un litige.</div></div>
          <div><label for="st-m">Versement minimum (MAD)</label><input id="st-m" name="min_payout" type="number" min="0" step="1" value="${settings.min_payout}"></div>
          <div><label for="st-p">Délai pour payer un virement ou en agence (heures)</label><input id="st-p" name="manual_payment_hours" type="number" min="1" max="336" step="1" value="${settings.manual_payment_hours}"></div>
          <div class="form-error"></div><button class="btn" type="submit">Enregistrer</button></form>
        <div class="panel stack"><h2>Taux par catégorie</h2><p class="hint">Laissez vide pour appliquer la commission par défaut. Un taux négocié pour un vendeur passe avant.</p>
          ${categories.map((c) => `<form class="inline-form spread" data-form="cat-rate" data-id="${c.id}"><label for="cr-${c.id}">${esc(c.name)}</label>
            <span><input id="cr-${c.id}" name="rate" type="number" min="0" max="50" step="0.1" value="${c.commission_rate ?? ''}" placeholder="${settings.commission_default}"> %
            <button class="btn ghost small" type="submit">OK</button></span></form>`).join('')}</div>
      </div></div>`;
    return;
  }

  const { entries } = await api('/admin/audit?limit=150');
  main.innerHTML = `<div class="wrap">${head}<p class="muted">Les actions sensibles (paiements, remboursements, versements, changements de commission, connexions échouées) sont toutes enregistrées ici.</p>
    <div class="panel table-wrap"><table><thead><tr><th>Date (UTC)</th><th>Qui</th><th>Action</th><th>Cible</th><th>Détails</th></tr></thead><tbody>
    ${entries.map((e) => `<tr><td>${esc(e.ts)}</td><td>${esc(e.actor || '—')}</td><td>${esc(e.action)}</td><td>${esc(e.target)}</td><td class="small">${esc(e.details)}</td></tr>`).join('')}</tbody></table></div></div>`;
}

/* ======================== Événements vendeur / admin ======================== */
window.extraInput = (t) => { if (t.id === 'p-price' || t.id === 'p-cat') updateFeeHint(); };

window.extraClick = async (action, el) => {
  const { id } = el.dataset;
  if (action === 'delete-product') {
    if (!confirm('Supprimer ce produit définitivement ?')) return;
    await api('/products/' + id, { method: 'DELETE' });
    toast('Produit supprimé'); router();
  } else if (action === 'seller-status') {
    await api('/admin/users/' + id, { method: 'PATCH', body: { seller_status: el.dataset.status } });
    toast('Vendeur mis à jour'); router();
  } else if (action === 'dispute-resolve') {
    const refund = el.dataset.res === 'refund';
    const note = prompt(refund ? "Décision (visible par l'acheteur) :" : 'Décision (visible par le vendeur) :', '');
    if (note === null) return;
    const r = await api(`/admin/disputes/${id}/resolve`, { method: 'POST', body: { resolution: el.dataset.res, note } });
    if (r.manual_refund_required) alert('Litige résolu. Pensez à rembourser vous-même le client : ce mode de paiement ne se rembourse pas automatiquement.');
    toast('Litige résolu'); router();
  } else if (action === 'payout-pay') {
    const reference = prompt('Référence du virement effectué :', '');
    if (!reference) return;
    await api(`/admin/payouts/${id}/pay`, { method: 'POST', body: { reference } });
    toast('Versement marqué comme payé'); router();
  } else if (action === 'payout-reject') {
    const reason = prompt('Motif du refus :', '');
    if (reason === null) return;
    await api(`/admin/payouts/${id}/reject`, { method: 'POST', body: { reason } });
    toast('Demande refusée'); router();
  }
};

window.extraSubmit = async (kind, form) => {
  const f = new FormData(form);
  if (kind === 'product') {
    const body = {
      title: f.get('title'), description: f.get('description'), price: Number(f.get('price')),
      stock: Number(f.get('stock')), category_id: f.get('category_id') || null, image_url: f.get('image_url'),
    };
    const id = form.dataset.id;
    await api(id ? '/products/' + id : '/products', { method: id ? 'PUT' : 'POST', body });
    toast(id ? 'Produit enregistré' : 'Produit publié'); go('#/seller');
  } else if (kind === 'payout-info') {
    await api('/seller/payout-info', { method: 'PUT', body: { method: f.get('method'), details: f.get('details') } });
    toast('Coordonnées enregistrées'); router();
  } else if (kind === 'payout-request') {
    await api('/seller/payouts', { method: 'POST', body: { amount: Number(f.get('amount')) } });
    toast('Demande envoyée'); router();
  } else if (kind === 'seller-rate') {
    const rate = String(f.get('rate')).trim();
    await api('/admin/users/' + form.dataset.id, { method: 'PATCH', body: { commission_rate: rate === '' ? null : Number(rate) } });
    toast('Taux enregistré');
  } else if (kind === 'settings') {
    const body = {};
    for (const [k, v] of f) body[k] = Number(v);
    await api('/admin/settings', { method: 'PUT', body });
    toast('Réglages enregistrés');
  } else if (kind === 'cat-rate') {
    const rate = String(f.get('rate')).trim();
    await api('/admin/categories/' + form.dataset.id, { method: 'PUT', body: { commission_rate: rate === '' ? null : Number(rate) } });
    toast('Taux de catégorie enregistré');
  }
};
