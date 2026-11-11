'use strict';
/* Souk : frontend (page unique, routage par #hash, aucune dépendance).
   La session est un cookie HttpOnly posé par le serveur : ce script ne voit jamais de jeton. */

const $ = (sel, el = document) => el.querySelector(sel);
const main = $('#main');

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString('fr-FR', { maximumFractionDigits: 2 }) + ' MAD';
const fmtDate = (s) => (s ? new Date(String(s).replace(' ', 'T') + 'Z').toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) : '');

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

let user = null;                        // { id, name, email, role, seller_status } ou null
let cart = store.get('cart', []);       // [{ id, title, price, stock, seller_name, image_url, qty }]
let idemKey = null;                     // identifiant unique d'une tentative de paiement (évite les doubles commandes)
const productCache = new Map();

const STATUS = { awaiting_payment: 'Paiement en cours', pending: 'En attente', paid: 'Payée', shipped: 'Expédiée', delivered: 'Livrée', cancelled: 'Annulée', refunded: 'Remboursée' };
const STATUS_TONE = { awaiting_payment: 'warn', pending: 'warn', paid: 'ok', shipped: '', delivered: 'ok', cancelled: 'bad', refunded: 'bad' };
const PAY_STATUS = { pending: 'À payer', paid: 'Payé', failed: 'Échoué', refunded: 'Remboursé' };
const PAY_TONE = { pending: 'warn', paid: 'ok', failed: 'bad', refunded: '' };

/* ---------- Utilitaires ---------- */
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show ' + kind;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = ''), 4200);
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'X-Requested-With': 'souk' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch('/api' + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch { /* corps vide */ }
  if (res.status === 401 && user && path !== '/auth/login') { user = null; renderNav(); }
  if (!res.ok) throw new Error(data.error || 'Une erreur est survenue');
  return data;
}

const saveCart = () => { store.set('cart', cart); renderNav(); };
const isSeller = () => user && (user.role === 'seller' || user.role === 'admin');
const isAdmin = () => user && user.role === 'admin';
function go(hash) { if (location.hash === hash) router(); else location.hash = hash; }
const notice = (msg, tone = 'bad') => `<div class="notice ${tone}" role="${tone === 'bad' ? 'alert' : 'status'}">${esc(msg)}</div>`;
const stars = (r, n) => (n ? `<span class="stars" aria-label="Note ${r} sur 5, ${n} avis">★ ${r} <span class="muted">(${n})</span></span>` : '');

/* ---------- Visuels : motif zellige généré pour chaque produit ---------- */
const PALETTES = [
  ['#2a3bcb', '#f2b01e', '#ffffff'], ['#0e7c66', '#f6e7c1', '#e4572e'], ['#7a1f5c', '#f2b01e', '#f7d9e8'],
  ['#14172e', '#2a9d8f', '#f2b01e'], ['#1f5fa8', '#f6e7c1', '#e4572e'], ['#b3261e', '#f6e7c1', '#14172e'],
];
function motif(id) {
  const n = Number(id) || 1;
  const [a, b, c] = PALETTES[n % PALETTES.length];
  const sw = 2 + (n % 3);
  const r = 8 + (n % 4) * 3;
  const inner = n % 2
    ? `<rect x="42" y="42" width="36" height="36" fill="none" stroke="${c}" stroke-width="2" transform="rotate(45 60 60)"/>`
    : `<circle cx="60" cy="60" r="22" fill="none" stroke="${c}" stroke-width="2"/>`;
  return `<svg viewBox="0 0 120 120" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <rect width="120" height="120" fill="${a}"/>
    <g fill="${b}" opacity=".9"><circle cx="0" cy="0" r="22"/><circle cx="120" cy="0" r="22"/><circle cx="0" cy="120" r="22"/><circle cx="120" cy="120" r="22"/></g>
    <g fill="none" stroke="${b}" stroke-width="${sw}"><rect x="26" y="26" width="68" height="68"/><rect x="26" y="26" width="68" height="68" transform="rotate(45 60 60)"/></g>
    ${inner}<circle cx="60" cy="60" r="${r}" fill="${c}"/></svg>`;
}
const visual = (p) => (p.image_url ? `<img src="${esc(p.image_url)}" alt="${esc(p.title)}" loading="lazy" data-fid="${Number(p.id)}">` : motif(p.id));
document.addEventListener('error', (e) => {
  const el = e.target;
  if (el.tagName === 'IMG' && el.dataset.fid) el.outerHTML = motif(el.dataset.fid);
}, true);

/* ---------- Navigation ---------- */
function renderNav() {
  const count = cart.reduce((s, i) => s + i.qty, 0);
  const cur = (location.hash.replace(/^#/, '') || '/').split('?')[0];
  const a = (href, label) => `<a href="#${href}"${cur === href ? ' aria-current="page"' : ''}>${label}</a>`;
  $('#top').innerHTML = `<div class="top-in">
    <a class="brand" href="#/">${motif(1)}Souk</a>
    <nav aria-label="Navigation principale">
      ${a('/', 'Boutique')}
      ${isAdmin() ? a('/admin', 'Administration') : ''}
      ${isSeller() ? a('/seller', 'Espace vendeur') : ''}
      ${user ? a('/orders', 'Mes commandes') : ''}
      ${a('/cart', `Panier${count ? ` <span class="count" aria-label="${count} articles">${count}</span>` : ''}`)}
      ${user ? `${a('/account', esc(user.name.split(' ')[0]))}<button class="link" data-action="logout" type="button">Déconnexion</button>` : a('/login', 'Connexion')}
    </nav></div>`;
}

/* ---------- Routeur ---------- */
const routes = [
  [/^\/?$/, (...a) => home(...a)],
  [/^\/product\/(\d+)$/, (...a) => productPage(...a)],
  [/^\/cart$/, (...a) => cartPage(...a)],
  [/^\/checkout$/, (...a) => checkoutPage(...a)],
  [/^\/confirmation$/, (...a) => confirmationPage(...a)],
  [/^\/orders$/, (...a) => ordersPage(...a)],
  [/^\/account$/, (...a) => accountPage(...a)],
  [/^\/login$/, (...a) => loginPage(...a)],
  [/^\/register$/, (...a) => registerPage(...a)],
  [/^\/seller$/, (...a) => sellerPage(...a)],
  [/^\/admin$/, (...a) => adminPage(...a)],
];

// Les navigations sont exécutées l'une après l'autre : une page lente ne peut pas écraser une page plus récente.
let routeChain = Promise.resolve();
function router() {
  routeChain = routeChain.then(runRoute);
  return routeChain;
}

async function runRoute() {
  const [path, qs] = (location.hash.replace(/^#/, '') || '/').split('?');
  const params = new URLSearchParams(qs || '');
  renderNav();
  for (const [re, fn] of routes) {
    const m = re.exec(path);
    if (!m) continue;
    main.innerHTML = '<div class="wrap"><p class="muted">Chargement…</p></div>';
    try {
      await fn(m.slice(1), params);
    } catch (e) {
      main.innerHTML = `<div class="wrap">${notice(e.message)}<a class="btn ghost" href="#/">Retour à la boutique</a></div>`;
    }
    window.scrollTo(0, 0);
    return;
  }
  main.innerHTML = '<div class="wrap empty"><h2>Page introuvable</h2><a class="btn" href="#/">Retour à la boutique</a></div>';
}

/* ---------- Accueil / catalogue ---------- */
function productCard(p) {
  productCache.set(p.id, p);
  const stock = p.stock === 0 ? '<span class="pill bad">Épuisé</span>'
    : p.stock <= 5 ? `<span class="pill warn">Plus que ${p.stock}</span>` : '';
  return `<article class="card">
    <a class="visual" href="#/product/${p.id}" tabindex="-1" aria-hidden="true">${visual(p)}</a>
    <div class="card-body">
      <span class="seller">${esc(p.category || 'Divers')} · ${esc(p.seller_name)}</span>
      <h3><a href="#/product/${p.id}">${esc(p.title)}</a></h3>
      ${stars(p.rating, p.review_count)}
      <div class="card-foot"><span class="price">${fmt(p.price)}</span>${stock}</div>
      <button class="btn small" type="button" data-action="add" data-id="${p.id}" ${p.stock === 0 ? 'disabled' : ''}>Ajouter au panier</button>
    </div></article>`;
}

async function home(_, params) {
  const q = new URLSearchParams();
  for (const k of ['q', 'category', 'sort', 'in_stock', 'page']) if (params.get(k)) q.set(k, params.get(k));
  const [{ categories }, list] = await Promise.all([api('/categories'), api('/products?' + q)]);
  const sel = (v, cur) => (String(v) === String(cur) ? ' selected' : '');
  const tiles = Array.from({ length: 18 }, (_, i) => motif(i + 1)).join('');
  main.innerHTML = `<div class="wrap">
    <section class="hero">
      <h1>Artisans et vendeurs du Maroc, au même endroit</h1>
      <p>Payez à la livraison, par PayPal, virement ou en agence. Votre argent est gardé en sécurité jusqu'à la livraison. Vous vendez ? Créez un compte vendeur : il est validé avant la mise en ligne de vos produits.</p>
      <div class="tiles" aria-hidden="true">${tiles}</div>
    </section>
    <form class="filters" data-form="search" role="search">
      <div class="wide"><label for="f-q">Rechercher</label><input id="f-q" type="search" name="q" value="${esc(params.get('q') || '')}" placeholder="Babouches, huile d'argan…"></div>
      <div><label for="f-cat">Catégorie</label><select id="f-cat" name="category"><option value="">Toutes</option>
        ${categories.map((c) => `<option value="${c.id}"${sel(c.id, params.get('category'))}>${esc(c.name)}</option>`).join('')}</select></div>
      <div><label for="f-sort">Trier par</label><select id="f-sort" name="sort">
        <option value="new"${sel('new', params.get('sort') || 'new')}>Nouveautés</option>
        <option value="rating"${sel('rating', params.get('sort'))}>Mieux notés</option>
        <option value="price_asc"${sel('price_asc', params.get('sort'))}>Prix croissant</option>
        <option value="price_desc"${sel('price_desc', params.get('sort'))}>Prix décroissant</option></select></div>
      <label class="check"><input type="checkbox" name="in_stock" value="1"${params.get('in_stock') === '1' ? ' checked' : ''}> En stock</label>
      <button class="btn" type="submit">Filtrer</button>
    </form>
    <p class="muted" aria-live="polite">${list.total} produit${list.total > 1 ? 's' : ''}</p>
    ${list.items.length
      ? `<div class="grid">${list.items.map(productCard).join('')}</div>`
      : '<div class="empty"><h2>Aucun produit trouvé</h2><p>Essayez un autre mot-clé ou retirez un filtre.</p><a class="btn ghost" href="#/">Voir tout le catalogue</a></div>'}
    ${list.pages > 1 ? `<nav class="pager" aria-label="Pagination">
      <button class="btn ghost small" data-action="page" data-page="${list.page - 1}" ${list.page <= 1 ? 'disabled' : ''}>Précédent</button>
      <span>Page ${list.page} sur ${list.pages}</span>
      <button class="btn ghost small" data-action="page" data-page="${list.page + 1}" ${list.page >= list.pages ? 'disabled' : ''}>Suivant</button></nav>` : ''}
  </div>`;
}

/* ---------- Fiche produit ---------- */
async function productPage([id]) {
  const { product: p, reviews } = await api('/products/' + id);
  productCache.set(p.id, p);
  main.innerHTML = `<div class="wrap">
    <a class="back" href="#/">← Retour à la boutique</a>
    ${p.available ? '' : notice("Ce produit n'est pas encore visible du public : le compte vendeur doit être validé par l'administrateur.", 'warn')}
    <div class="product">
      <div class="pvisual">${visual(p)}</div>
      <div>
        <span class="pill">${esc(p.category || 'Divers')}</span>
        <h1>${esc(p.title)}</h1>
        <p class="seller">Vendu par ${esc(p.seller_name)} ${stars(p.rating, p.review_count)}</p>
        <div class="price">${fmt(p.price)}</div>
        <p>${esc(p.description || 'Aucune description.').replace(/\n/g, '<br>')}</p>
        <p>${p.stock === 0 ? '<span class="pill bad">Épuisé</span>' : p.stock <= 5 ? `<span class="pill warn">Plus que ${p.stock} en stock</span>` : '<span class="pill ok">En stock</span>'}</p>
        <div class="buy">
          <div class="qty"><label for="qty">Quantité</label><input id="qty" type="number" min="1" max="${Math.max(1, p.stock)}" value="1" ${p.stock === 0 ? 'disabled' : ''}></div>
          <button class="btn" type="button" data-action="add" data-id="${p.id}" data-qty-input="qty" ${p.stock === 0 || !p.available ? 'disabled' : ''}>Ajouter au panier</button>
        </div>
        <p class="hint">Paiement protégé : le vendeur est payé après la livraison.</p>
      </div>
    </div>
    <section class="reviews"><h2>Avis des acheteurs</h2>
      ${reviews.length ? reviews.map((r) => `<div class="review-item"><strong>${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</strong> <span class="muted">${esc(r.buyer_name)} · ${fmtDate(r.created_at)}</span>${r.comment ? `<p>${esc(r.comment)}</p>` : ''}</div>`).join('')
        : '<p class="muted">Aucun avis pour le moment. Seuls les acheteurs d\'une commande livrée peuvent noter ce produit.</p>'}
    </section></div>`;
}

/* ---------- Panier ---------- */
function addToCart(id, qty = 1) {
  const p = productCache.get(Number(id));
  if (!p) return;
  const line = cart.find((i) => i.id === p.id);
  const wanted = (line ? line.qty : 0) + qty;
  const finalQty = Math.min(wanted, p.stock, 99);
  if (finalQty < wanted) toast(`Stock limité : ${p.stock} disponible${p.stock > 1 ? 's' : ''}`, 'bad');
  else toast('Ajouté au panier');
  if (line) { line.qty = finalQty; line.stock = p.stock; line.price = p.price; }
  else cart.push({ id: p.id, title: p.title, price: p.price, stock: p.stock, seller_name: p.seller_name, image_url: p.image_url, qty: finalQty });
  saveCart();
}

// Rafraîchit prix et stock depuis le serveur (le serveur recalcule de toute façon le total)
async function refreshCart() {
  const results = await Promise.all(cart.map((i) => api('/products/' + i.id).then((r) => (r.product.available ? r.product : null), () => null)));
  cart = cart.map((i, idx) => {
    const p = results[idx];
    if (!p || p.stock === 0) return null;
    return { ...i, price: p.price, stock: p.stock, title: p.title, qty: Math.min(i.qty, p.stock) };
  }).filter(Boolean);
  store.set('cart', cart);
  renderNav();
}
const cartTotal = () => cart.reduce((s, i) => s + i.price * i.qty, 0);

async function cartPage(_, params) {
  const before = cart.length;
  if (cart.length) await refreshCart();
  const removed = before - cart.length;
  const cancelled = params.get('cancelled') ? notice('Paiement PayPal annulé. Votre panier est conservé, aucun montant n\'a été prélevé.', 'warn') : '';
  if (!cart.length) {
    main.innerHTML = `<div class="wrap empty">${cancelled}<h2>Votre panier est vide</h2><p>${removed ? 'Les articles épuisés ont été retirés.' : 'Ajoutez des produits depuis la boutique.'}</p><a class="btn" href="#/">Voir la boutique</a></div>`;
    return;
  }
  main.innerHTML = `<div class="wrap"><h1>Panier</h1>${cancelled}
    ${removed ? notice('Des articles épuisés ou supprimés ont été retirés de votre panier.', 'warn') : ''}
    <div class="two">
      <div class="panel">${cart.map((i) => `<div class="line">
        <div class="thumb">${visual(i)}</div>
        <div><strong><a href="#/product/${i.id}">${esc(i.title)}</a></strong><div class="seller">${esc(i.seller_name)} · ${fmt(i.price)}</div></div>
        <div class="right">
          <div class="qtybox"><button type="button" data-action="qty" data-id="${i.id}" data-d="-1" aria-label="Retirer une unité">−</button><span aria-live="polite">${i.qty}</span><button type="button" data-action="qty" data-id="${i.id}" data-d="1" aria-label="Ajouter une unité">+</button></div>
          <div class="price">${fmt(i.price * i.qty)}</div>
          <button class="link" type="button" data-action="remove" data-id="${i.id}">Retirer</button>
        </div></div>`).join('')}</div>
      <aside class="panel stack">
        <h2>Récapitulatif</h2>
        <div class="total"><span>Total</span><span>${fmt(cartTotal())}</span></div>
        <a class="btn" href="#/checkout">Passer la commande</a>
        <a class="btn ghost" href="#/">Continuer mes achats</a>
      </aside></div></div>`;
}

/* ---------- Commande & paiement ---------- */
const PAY_HELP = {
  cod: 'Vous payez en espèces au livreur à la réception du colis.',
  bank_transfer: 'Vous recevez les coordonnées bancaires. La commande est expédiée dès que la plateforme confirme la réception du virement.',
  cash_agency: 'Vous envoyez le montant dans une agence Cash Plus ou Wafacash. La commande est expédiée dès que la plateforme confirme le versement.',
};

async function checkoutPage() {
  if (!user) return go('#/login?next=' + encodeURIComponent('/checkout'));
  if (cart.length) await refreshCart();
  if (!cart.length) return go('#/cart');
  const { methods } = await api('/payment-methods');
  if (!idemKey) idemKey = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^A-Za-z0-9_-]/g, '');
  const demo = '<div class="notice">Mode démonstration : aucun prélèvement réel. Carte de test : 4242 4242 4242 4242 (date future, CVC au choix). Carte refusée : 4000 0000 0000 0002.</div>';
  const total = cartTotal();
  const fieldsFor = (m) => {
    if (m.code === 'card') return `${demo}
      <div><label for="c-num">Numéro de carte</label><input id="c-num" name="card_number" inputmode="numeric" autocomplete="cc-number" placeholder="1234 5678 9012 3456" maxlength="23"></div>
      <div><label for="c-holder">Titulaire</label><input id="c-holder" name="card_holder" autocomplete="cc-name" placeholder="Nom sur la carte"></div>
      <div class="row2"><div><label for="c-exp">Expiration</label><input id="c-exp" name="card_expiry" inputmode="numeric" autocomplete="cc-exp" placeholder="MM/AA" maxlength="5"></div>
      <div><label for="c-cvc">CVC</label><input id="c-cvc" name="card_cvc" inputmode="numeric" autocomplete="cc-csc" placeholder="123" maxlength="4"></div></div>`;
    if (m.code === 'paypal') {
      const eur = (total / (m.rate || 1)).toFixed(2);
      return `${m.simulated ? '<div class="notice">Mode démonstration : une fausse page PayPal s\'ouvrira, aucun argent réel n\'est utilisé.</div>' : ''}
        <p class="muted">Vous serez redirigé vers PayPal pour payer. Nous ne voyons jamais vos données bancaires.${m.currency !== 'MAD' ? ` Montant débité : environ <strong>${eur} ${esc(m.currency)}</strong> (taux fixe 1 ${esc(m.currency)} = ${m.rate} MAD).` : ''}</p>`;
    }
    return `<p class="muted">${esc(PAY_HELP[m.code] || '')}</p>`;
  };
  const first = methods[0]?.code;
  main.innerHTML = `<div class="wrap">
    <h1>Finaliser la commande</h1>
    <form class="two" data-form="checkout" novalidate>
      <div class="stack">
        <section class="panel stack"><h2>Livraison</h2>
          <div><label for="s-name">Nom du destinataire</label><input id="s-name" name="name" autocomplete="name" required value="${esc(user.name)}"></div>
          <div class="row2"><div><label for="s-phone">Téléphone</label><input id="s-phone" name="phone" type="tel" autocomplete="tel" placeholder="+212 6 00 00 00 00" required></div>
          <div><label for="s-city">Ville</label><input id="s-city" name="city" autocomplete="address-level2" required></div></div>
          <div><label for="s-addr">Adresse</label><input id="s-addr" name="address" autocomplete="street-address" required></div>
        </section>
        <section class="panel"><h2>Paiement</h2>
          <div class="notice ok">Paiement protégé : pour PayPal, virement et agence, le vendeur n'est payé qu'après la livraison. En cas de problème, vous pouvez ouvrir un litige.</div>
          ${methods.map((m) => `<div><label class="pay-opt"><input type="radio" name="method" value="${esc(m.code)}"${m.code === first ? ' checked' : ''}><span><strong>${esc(m.label)}</strong><span class="muted">${m.kind === 'online' ? 'Paiement en ligne' : 'Paiement hors ligne'}</span></span></label>
          <div class="pay-fields" data-for="${esc(m.code)}"${m.code === first ? '' : ' hidden'}>${fieldsFor(m)}</div></div>`).join('')}
        </section>
      </div>
      <aside class="panel stack">
        <h2>Votre commande</h2>
        ${cart.map((i) => `<div class="order-head"><span>${i.qty} × ${esc(i.title)}</span><span>${fmt(i.price * i.qty)}</span></div>`).join('')}
        <div class="total"><span>Total</span><span>${fmt(total)}</span></div>
        <div id="checkout-error"></div>
        <button class="btn" type="submit">Confirmer la commande</button>
        <p class="hint">Les articles de plusieurs vendeurs sont répartis en une commande par vendeur.</p>
      </aside>
    </form></div>`;
}

async function submitCheckout(form) {
  const f = new FormData(form);
  const method = f.get('method');
  const payment = { method };
  if (method === 'card') for (const k of ['card_number', 'card_holder', 'card_expiry', 'card_cvc']) payment[k] = f.get(k);
  const btn = $('button[type=submit]', form);
  const err = $('#checkout-error');
  err.innerHTML = '';
  btn.disabled = true;
  btn.textContent = method === 'paypal' ? 'Redirection vers PayPal…' : 'Traitement…';
  try {
    const res = await api('/orders', {
      method: 'POST',
      body: {
        idempotency_key: idemKey,
        items: cart.map((i) => ({ product_id: i.id, quantity: i.qty })),
        shipping: { name: f.get('name'), phone: f.get('phone'), address: f.get('address'), city: f.get('city') },
        payment,
      },
    });
    idemKey = null;
    if (res.redirect_url) { location.href = res.redirect_url; return; }       // PayPal
    go('#/confirmation?ref=' + encodeURIComponent(res.group_ref));
  } catch (e) {
    err.innerHTML = notice(e.message);
    btn.disabled = false;
    btn.textContent = 'Confirmer la commande';
  }
}

async function confirmationPage(_, params) {
  const ref = params.get('ref');
  if (!ref) return go('#/orders');
  if (!user) return go('#/login?next=' + encodeURIComponent('/orders'));
  const o = await api('/checkouts/' + encodeURIComponent(ref));
  if (o.orders[0].status !== 'awaiting_payment') { cart = []; saveCart(); idemKey = null; }
  const paid = o.payment_status === 'paid';
  main.innerHTML = `<div class="wrap narrow stack">
    <h1>${paid ? 'Paiement reçu, merci !' : 'Commande enregistrée'}</h1>
    ${o.simulated ? notice("Paiement simulé (mode démonstration) : aucun argent n'a été prélevé.", 'warn') : ''}
    <div class="panel stack">
      <div class="order-head"><span>Référence</span><strong>${esc(o.group_ref)}</strong></div>
      <div class="order-head"><span>Mode de paiement</span><strong>${esc(o.method_label)}</strong></div>
      <div class="order-head"><span>Statut</span><span class="pill ${PAY_TONE[o.payment_status]}">${PAY_STATUS[o.payment_status]}</span></div>
      <div class="total"><span>Total</span><span>${fmt(o.total)}</span></div>
    </div>
    ${o.instructions ? `<div class="panel stack"><h2>${o.method === 'cod' ? 'À savoir' : 'Comment payer'}</h2>
      ${o.instructions.iban ? `<p>Bénéficiaire : <strong>${esc(o.instructions.beneficiary)}</strong><br>IBAN / RIB : <strong>${esc(o.instructions.iban)}</strong><br>Référence à indiquer : <strong>${esc(o.instructions.reference)}</strong></p>` : ''}
      ${o.instructions.receiver ? `<p>Agence : <strong>${esc(o.instructions.agency)}</strong><br>Bénéficiaire : <strong>${esc(o.instructions.receiver)}</strong> (${esc(o.instructions.phone)})<br>Référence : <strong>${esc(o.instructions.reference)}</strong></p>` : ''}
      <p>${esc(o.instructions.message)}</p>
      ${o.instructions.deadline ? `<p class="hint">Sans paiement avant le ${fmtDate(o.instructions.deadline)}, la commande sera annulée automatiquement.</p>` : ''}</div>` : ''}
    <div class="actions"><a class="btn" href="#/orders">Suivre mes commandes</a><a class="btn ghost" href="#/">Continuer mes achats</a></div>
  </div>`;
}

/* ---------- Blocs de commande (acheteur, vendeur, administrateur) ---------- */
const ACTION_LABEL = {
  cancel: ['Annuler la commande', 'danger'], ship: ['Marquer expédiée', ''], deliver: ['Marquer livrée', ''],
  confirm_receipt: ["J'ai reçu ma commande", ''], confirm_payment: ['Paiement reçu', ''], refund: ['Rembourser', 'danger'],
};

function reviewForm(o, item) {
  return `<details class="inline"><summary>Donner mon avis</summary>
    <form class="stack" data-form="review" data-order="${o.id}" data-product="${item.product_id}">
      <div><label for="rv-${o.id}-${item.product_id}">Note</label><select id="rv-${o.id}-${item.product_id}" name="rating">
        <option value="5">5 ★ Excellent</option><option value="4">4 ★ Bien</option><option value="3">3 ★ Correct</option><option value="2">2 ★ Décevant</option><option value="1">1 ★ Mauvais</option></select></div>
      <div><label>Commentaire (facultatif)<textarea name="comment" maxlength="1000"></textarea></label></div>
      <div class="form-error"></div><button class="btn small" type="submit">Publier mon avis</button></form></details>`;
}

function disputeForm(o) {
  return `<details class="inline"><summary>Signaler un problème</summary>
    <form class="stack" data-form="dispute" data-order="${o.id}">
      <p class="hint">Votre argent reste bloqué chez nous le temps de l'examen : le vendeur ne sera pas payé tant que le litige est ouvert.</p>
      <div><label>Que s'est-il passé ?<textarea name="reason" minlength="10" maxlength="1000" required></textarea></label></div>
      <div class="form-error"></div><button class="btn small danger" type="submit">Ouvrir un litige</button></form></details>`;
}

function orderBlock(o, who, { buyerView = false, adminView = false } = {}) {
  const pay = o.payment;
  const actions = (o.actions || []).filter((a) => ACTION_LABEL[a]).map((a) =>
    `<button class="btn small ${ACTION_LABEL[a][1]}" type="button" data-action="order-act" data-id="${o.id}" data-act="${a}">${ACTION_LABEL[a][0]}</button>`).join('');
  const dispute = o.dispute
    ? `<div class="notice ${o.dispute.status === 'open' ? 'warn' : ''}">Litige ${o.dispute.status === 'open' ? 'en cours' : o.dispute.status === 'refunded' ? 'résolu : remboursement' : 'résolu : en faveur du vendeur'} : « ${esc(o.dispute.reason)} »${o.dispute.note ? `<br>Décision : ${esc(o.dispute.note)}` : ''}</div>` : '';
  const expiry = ['awaiting_payment', 'pending'].includes(o.status) && o.expires_at && pay?.status === 'pending'
    ? `<div class="hint">Paiement attendu avant le ${fmtDate(o.expires_at)}</div>` : '';
  return `<article class="order">
    <div class="order-head"><h3>Commande n° ${o.id} <span class="muted">· ${fmtDate(o.created_at)}</span></h3>
      <span class="pill ${STATUS_TONE[o.status]}">${STATUS[o.status]}</span></div>
    <div class="muted">${who}</div>
    <ul class="items">${o.items.map((i) => `<li>${i.quantity} × ${esc(i.title)} · ${fmt(i.price * i.quantity)}
      ${buyerView && o.can_review && !i.reviewed ? reviewForm(o, i) : ''}${buyerView && i.reviewed ? ' <span class="pill ok">Avis publié</span>' : ''}</li>`).join('')}</ul>
    <div class="order-head"><strong>Total : ${fmt(o.total)}</strong>
      ${pay ? `<span>${esc(pay.method_label)} · <span class="pill ${PAY_TONE[pay.status]}">${PAY_STATUS[pay.status]}</span></span>` : ''}</div>
    ${o.commission_amount !== undefined ? `<div class="kv"><span>Commission plateforme : ${fmt(o.commission_amount)}</span><strong>${adminView ? 'Part du vendeur' : 'Vous recevez'} : ${fmt(o.seller_net)}</strong></div>` : ''}
    ${expiry}${dispute}
    ${actions || (buyerView && (o.actions || []).includes('dispute')) ? `<div class="actions">${actions}</div>` : ''}
    ${buyerView && (o.actions || []).includes('dispute') ? disputeForm(o) : ''}
  </article>`;
}

async function ordersPage(_, params) {
  if (!user) return go('#/login?next=' + encodeURIComponent('/orders'));
  const { orders } = await api('/orders');
  main.innerHTML = `<div class="wrap"><h1>Mes commandes</h1>
    ${params.get('error') ? notice(params.get('error')) : ''}
    <div class="stack">${orders.length ? orders.map((o) => orderBlock(o, `Vendeur : ${esc(o.seller_name)} · Livraison : ${esc(o.shipping_city)}`, { buyerView: true })).join('')
      : '<div class="empty"><h2>Aucune commande pour le moment</h2><a class="btn" href="#/">Découvrir la boutique</a></div>'}</div></div>`;
}

/* ---------- Connexion / inscription / compte ---------- */
function authForm(mode, next) {
  const reg = mode === 'register';
  return `<div class="wrap narrow"><h1>${reg ? 'Créer un compte' : 'Connexion'}</h1>
    <form class="panel stack" data-form="${mode}" data-next="${esc(next)}" novalidate>
      ${reg ? '<div><label for="a-name">Nom</label><input id="a-name" name="name" autocomplete="name" required></div>' : ''}
      <div><label for="a-email">Email</label><input id="a-email" type="email" name="email" autocomplete="email" required></div>
      <div><label for="a-pass">Mot de passe</label><input id="a-pass" type="password" name="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required>${reg ? '<div class="hint">8 caractères minimum, pas de mot de passe courant</div>' : ''}</div>
      ${reg ? `<div><span class="label">Je veux</span>
        <label class="pay-opt"><input type="radio" name="role" value="buyer" checked><span><strong>Acheter</strong><span class="muted">Parcourir et commander</span></span></label>
        <label class="pay-opt"><input type="radio" name="role" value="seller"><span><strong>Vendre</strong><span class="muted">Le compte est validé par l'administrateur avant la mise en ligne des produits</span></span></label></div>` : ''}
      <div class="form-error"></div>
      <button class="btn" type="submit">${reg ? 'Créer mon compte' : 'Se connecter'}</button>
      <p class="muted">${reg ? 'Déjà inscrit ?' : 'Pas encore de compte ?'} <a href="#/${reg ? 'login' : 'register'}${next !== '/' ? '?next=' + encodeURIComponent(next) : ''}">${reg ? 'Se connecter' : 'Créer un compte'}</a></p>
    </form></div>`;
}
function loginPage(_, p) { main.innerHTML = authForm('login', p.get('next') || '/'); }
function registerPage(_, p) { main.innerHTML = authForm('register', p.get('next') || '/'); }

async function submitAuth(form, mode) {
  const f = new FormData(form);
  const body = { email: f.get('email'), password: f.get('password') };
  if (mode === 'register') { body.name = f.get('name'); body.role = f.get('role'); }
  const err = $('.form-error', form);
  err.innerHTML = '';
  try {
    const data = await api('/auth/' + mode, { method: 'POST', body });
    user = data.user;
    toast(`Bienvenue ${user.name.split(' ')[0]} !`);
    let next = form.dataset.next || '/';
    if (mode === 'register' && user.role === 'seller') next = '/seller';
    else if (mode === 'login' && next === '/') next = user.role === 'admin' ? '/admin' : user.role === 'seller' ? '/seller' : '/';
    go('#' + next);
  } catch (e) {
    err.innerHTML = notice(e.message);
  }
}

async function logout() {
  try { await api('/auth/logout', { method: 'POST', body: {} }); } catch { /* ignore */ }
  user = null;
  toast('Vous êtes déconnecté');
  go('#/');
}

function accountPage() {
  if (!user) return go('#/login?next=' + encodeURIComponent('/account'));
  main.innerHTML = `<div class="wrap narrow stack"><h1>Mon compte</h1>
    <div class="panel"><p><strong>${esc(user.name)}</strong><br>${esc(user.email)}<br><span class="pill">${user.role === 'admin' ? 'Administrateur' : user.role === 'seller' ? 'Vendeur' : 'Acheteur'}</span></p></div>
    <form class="panel stack" data-form="password" novalidate><h2>Changer le mot de passe</h2>
      <div><label for="pw-cur">Mot de passe actuel</label><input id="pw-cur" type="password" name="current" autocomplete="current-password" required></div>
      <div><label for="pw-new">Nouveau mot de passe</label><input id="pw-new" type="password" name="next" autocomplete="new-password" required><div class="hint">Les autres appareils seront déconnectés.</div></div>
      <div class="form-error"></div><button class="btn" type="submit">Changer le mot de passe</button></form>
    <div class="panel stack"><h2>Sécurité</h2><p class="muted">Déconnecte tous les appareils où vous êtes connecté, y compris celui-ci.</p>
      <button class="btn ghost" type="button" data-action="logout-all">Me déconnecter partout</button></div></div>`;
}

/* ---------- Événements ---------- */
async function orderAct(id, act) {
  if (act === 'cancel' && !confirm('Annuler cette commande ? Les produits seront remis en vente.')) return;
  if (act === 'confirm_receipt' && !confirm('Confirmez-vous avoir reçu votre commande en bon état ? Le vendeur sera payé après le délai de protection.')) return;
  let r;
  if (act === 'cancel') r = await api(`/orders/${id}/status`, { method: 'PATCH', body: { status: 'cancelled' } });
  else if (act === 'ship') r = await api(`/orders/${id}/status`, { method: 'PATCH', body: { status: 'shipped' } });
  else if (act === 'deliver' || act === 'confirm_receipt') r = await api(`/orders/${id}/status`, { method: 'PATCH', body: { status: 'delivered' } });
  else if (act === 'confirm_payment') {
    const reference = prompt('Référence du virement ou du reçu (facultatif) :', '');
    if (reference === null) return;
    r = await api(`/admin/orders/${id}/confirm-payment`, { method: 'POST', body: { reference } });
  } else if (act === 'refund') {
    const reason = prompt('Motif du remboursement :', '');
    if (!reason) return;
    r = await api(`/admin/orders/${id}/refund`, { method: 'POST', body: { reason } });
    if (r.manual_refund_required) alert('Remboursement enregistré. Pensez à rembourser vous-même le client (virement, agence ou carte) : ce mode de paiement ne se rembourse pas automatiquement.');
  }
  toast('Commande mise à jour');
  router();
  return r;
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const { action, id } = el.dataset;
  try {
    if (action === 'add') {
      const input = el.dataset.qtyInput ? document.getElementById(el.dataset.qtyInput) : null;
      addToCart(id, input ? Math.max(1, parseInt(input.value, 10) || 1) : 1);
    } else if (action === 'qty') {
      const line = cart.find((i) => i.id === Number(id));
      if (!line) return;
      const next = line.qty + Number(el.dataset.d);
      if (next < 1) cart = cart.filter((i) => i !== line);
      else if (next > Math.min(line.stock, 99)) return toast(`Stock limité : ${line.stock} disponible${line.stock > 1 ? 's' : ''}`, 'bad');
      else line.qty = next;
      saveCart(); router();
    } else if (action === 'remove') {
      cart = cart.filter((i) => i.id !== Number(id));
      saveCart(); router();
    } else if (action === 'page') {
      const p = new URLSearchParams(location.hash.split('?')[1] || '');
      p.set('page', el.dataset.page);
      go('#/?' + p);
    } else if (action === 'logout') {
      logout();
    } else if (action === 'logout-all') {
      await api('/auth/logout-all', { method: 'POST', body: {} });
      user = null; toast('Déconnecté de tous les appareils'); go('#/login');
    } else if (action === 'order-act') {
      await orderAct(id, el.dataset.act);
    } else if (window.extraClick) {
      await window.extraClick(action, el);            // actions vendeur / admin (seller-admin.js)
    }
  } catch (err) {
    toast(err.message, 'bad');
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.form;
  const err = $('.form-error', form);
  try {
    if (kind === 'search') {
      const p = new URLSearchParams();
      for (const [k, v] of new FormData(form)) if (String(v).trim()) p.set(k, String(v).trim());
      go('#/?' + p);
    } else if (kind === 'checkout') submitCheckout(form);
    else if (kind === 'login' || kind === 'register') submitAuth(form, kind);
    else if (kind === 'password') {
      const f = new FormData(form);
      await api('/auth/password', { method: 'POST', body: { current: f.get('current'), next: f.get('next') } });
      form.reset(); toast('Mot de passe changé');
    } else if (kind === 'review') {
      const f = new FormData(form);
      await api('/reviews', { method: 'POST', body: { order_id: Number(form.dataset.order), product_id: Number(form.dataset.product), rating: Number(f.get('rating')), comment: f.get('comment') } });
      toast('Merci pour votre avis'); router();
    } else if (kind === 'dispute') {
      await api(`/orders/${form.dataset.order}/dispute`, { method: 'POST', body: { reason: new FormData(form).get('reason') } });
      toast('Litige ouvert : nous examinons votre demande'); router();
    } else if (window.extraSubmit) await window.extraSubmit(kind, form);
  } catch (ex) {
    if (err) err.innerHTML = notice(ex.message); else toast(ex.message, 'bad');
  }
});

document.addEventListener('change', (e) => {
  if (e.target.name === 'method') {
    document.querySelectorAll('.pay-fields').forEach((box) => { box.hidden = box.dataset.for !== e.target.value; });
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.name === 'card_number') t.value = t.value.replace(/\D/g, '').slice(0, 19).replace(/(.{4})/g, '$1 ').trim();
  if (t.name === 'card_expiry') {
    const d = t.value.replace(/\D/g, '').slice(0, 4);
    t.value = d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d;
  }
  if (window.extraInput) window.extraInput(t);
});

window.addEventListener('hashchange', router);
window.addEventListener('load', async () => {
  try { user = (await api('/auth/me')).user; } catch { user = null; }
  router();
});
