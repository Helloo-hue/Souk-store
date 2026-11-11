'use strict';
const { db, audit } = require('../db');
const {
  HttpError, Reply, route, str, intIn, numIn, httpsUrl, noContactInfo, money,
} = require('../core');
const { sellerCommissionInfo } = require('../money');

route('GET', '/api/categories', () => ({
  categories: db.prepare('SELECT id, name FROM categories ORDER BY name').all().map((c) => ({ ...c })),
}));

const SORTS = {
  new: 'p.id DESC',
  price_asc: 'p.price ASC, p.id DESC',
  price_desc: 'p.price DESC, p.id DESC',
  rating: 'rating DESC, review_count DESC, p.id DESC',
};

// Seuls les produits de vendeurs validés et actifs sont visibles par le public.
const VISIBLE = "u.role IN ('seller','admin') AND u.active = 1 AND u.seller_status = 'approved'";
const PRODUCT_SELECT = `
  SELECT p.id, p.title, p.description, p.price, p.stock, p.image_url, p.created_at,
         p.category_id, c.name AS category, p.seller_id, u.name AS seller_name, u.seller_status,
         (SELECT ROUND(AVG(r.rating), 1) FROM reviews r WHERE r.product_id = p.id) AS rating,
         (SELECT COUNT(*) FROM reviews r WHERE r.product_id = p.id) AS review_count
  FROM products p
  JOIN users u ON u.id = p.seller_id
  LEFT JOIN categories c ON c.id = p.category_id`;

route('GET', '/api/products', ({ query }) => {
  const where = [VISIBLE];
  const args = [];
  const q = (query.get('q') || '').trim().slice(0, 100);
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (ch) => '\\' + ch)}%`;
    where.push("(p.title LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\')");
    args.push(like, like);
  }
  const category = Number(query.get('category'));
  if (Number.isInteger(category) && category > 0) { where.push('p.category_id = ?'); args.push(category); }
  const seller = Number(query.get('seller'));
  if (Number.isInteger(seller) && seller > 0) { where.push('p.seller_id = ?'); args.push(seller); }
  const minPrice = Number(query.get('min_price'));
  if (query.get('min_price') && Number.isFinite(minPrice)) { where.push('p.price >= ?'); args.push(minPrice); }
  const maxPrice = Number(query.get('max_price'));
  if (query.get('max_price') && Number.isFinite(maxPrice)) { where.push('p.price <= ?'); args.push(maxPrice); }
  if (query.get('in_stock') === '1') where.push('p.stock > 0');

  const whereSql = 'WHERE ' + where.join(' AND ');
  const orderSql = SORTS[query.get('sort')] || SORTS.new;
  const limit = Math.min(50, Math.max(1, Number(query.get('limit')) || 12));
  const page = Math.max(1, Number(query.get('page')) || 1);

  const total = db.prepare(`SELECT COUNT(*) AS n FROM products p JOIN users u ON u.id = p.seller_id ${whereSql}`).get(...args).n;
  const items = db.prepare(`${PRODUCT_SELECT} ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`)
    .all(...args, limit, (page - 1) * limit).map((r) => ({ ...r }));
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
});

route('GET', '/api/products/:id', ({ params, user }) => {
  const id = Number(params.id);
  const product = db.prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).get(id);
  if (!product) throw new HttpError(404, 'Produit introuvable');
  const visible = product.seller_status === 'approved' &&
    db.prepare('SELECT active FROM users WHERE id = ?').get(product.seller_id).active === 1;
  // Un produit en attente de validation n'est visible que par son vendeur et l'administrateur.
  if (!visible && !(user && (user.id === product.seller_id || user.role === 'admin'))) {
    throw new HttpError(404, 'Produit introuvable');
  }
  const reviews = db.prepare(
    `SELECT r.id, r.rating, r.comment, r.created_at, u.name AS buyer_name
     FROM reviews r JOIN users u ON u.id = r.buyer_id
     WHERE r.product_id = ? ORDER BY r.id DESC LIMIT 20`
  ).all(id).map((r) => ({ ...r, buyer_name: r.buyer_name.split(' ')[0] }));
  return { product: { ...product, available: visible }, reviews };
});

/* ----------------------------- Espace vendeur ----------------------------- */
const sellerOnly = { roles: ['seller', 'admin'] };

function assertSellerActive(user) {
  if (user.role === 'seller' && user.seller_status === 'suspended') {
    throw new HttpError(403, 'Votre compte vendeur est suspendu. Contactez l\'administrateur.');
  }
}

function productInput(body, existing = {}) {
  const title = noContactInfo(str(body.title ?? existing.title, 120, 'titre', { min: 3 }), 'Titre');
  const description = noContactInfo(
    str(body.description ?? existing.description ?? '', 2000, 'description', { required: false }), 'Description');
  const price = money(numIn(body.price ?? existing.price, 1, 10_000_000, 'Prix'));
  const stock = intIn(body.stock ?? existing.stock ?? 0, 0, 1_000_000, 'Stock');
  let categoryId = body.category_id ?? existing.category_id ?? null;
  if (categoryId === '' || categoryId === undefined) categoryId = null;
  if (categoryId !== null) {
    categoryId = intIn(categoryId, 1, 1_000_000, 'Catégorie');
    if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId)) throw new HttpError(400, 'Catégorie inconnue');
  }
  const image = httpsUrl(body.image_url ?? existing.image_url ?? '', "Lien de l'image");
  return { title, description, price, stock, categoryId, image };
}

route('POST', '/api/products', sellerOnly, ({ body, user, ip }) => {
  assertSellerActive(user);
  const p = productInput(body);
  const info = db.prepare(
    `INSERT INTO products (seller_id, category_id, title, description, price, stock, image_url) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(user.id, p.categoryId, p.title, p.description, p.price, p.stock, p.image);
  const id = Number(info.lastInsertRowid);
  audit(user.id, 'product_created', `product:${id}`, '', ip);
  return new Reply({ product: { ...db.prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).get(id) } }, { status: 201 });
});

function ownedProduct(id, user) {
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(id));
  if (!row) throw new HttpError(404, 'Produit introuvable');
  if (row.seller_id !== user.id && user.role !== 'admin') throw new HttpError(403, "Ce produit ne vous appartient pas");
  return row;
}

route('PUT', '/api/products/:id', sellerOnly, ({ params, body, user, ip }) => {
  assertSellerActive(user);
  const existing = ownedProduct(params.id, user);
  const p = productInput(body, existing);
  db.prepare(`UPDATE products SET category_id = ?, title = ?, description = ?, price = ?, stock = ?, image_url = ? WHERE id = ?`)
    .run(p.categoryId, p.title, p.description, p.price, p.stock, p.image, existing.id);
  if (user.role === 'admin') audit(user.id, 'product_edited_by_admin', `product:${existing.id}`, '', ip);
  return { product: { ...db.prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).get(existing.id) } };
});

route('DELETE', '/api/products/:id', sellerOnly, ({ params, user, ip }) => {
  const existing = ownedProduct(params.id, user);
  const used = db.prepare('SELECT COUNT(*) AS n FROM order_items WHERE product_id = ?').get(existing.id).n;
  if (used > 0) throw new HttpError(409, 'Ce produit a déjà été commandé : mettez son stock à 0 au lieu de le supprimer');
  db.prepare('DELETE FROM products WHERE id = ?').run(existing.id);
  audit(user.id, 'product_deleted', `product:${existing.id}`, '', ip);
  return { ok: true };
});

route('GET', '/api/my/products', sellerOnly, ({ user }) => ({
  items: db.prepare(`${PRODUCT_SELECT} WHERE p.seller_id = ? ORDER BY p.id DESC`).all(user.id).map((r) => ({ ...r })),
}));

// Taux de commission applicable à ce vendeur (pour afficher "vous recevez X" pendant la saisie du prix)
route('GET', '/api/seller/commission', sellerOnly, ({ user }) => sellerCommissionInfo(user));
