'use strict';
// Base de données SQLite (module intégré à Node 22+) : schéma v2 + migration depuis la v1.
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'buyer' CHECK (role IN ('buyer','seller','admin')),
  active         INTEGER NOT NULL DEFAULT 1,
  seller_status  TEXT NOT NULL DEFAULT 'approved' CHECK (seller_status IN ('pending','approved','suspended')),
  commission_rate REAL,                       -- taux négocié pour ce vendeur (NULL = taux normal)
  token_version  INTEGER NOT NULL DEFAULT 0,  -- +1 = déconnecte toutes les sessions
  payout_method  TEXT NOT NULL DEFAULT '',    -- bank | paypal | cashplus
  payout_details TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categories (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  commission_rate REAL                        -- taux propre à la catégorie (NULL = taux normal)
);

CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price       REAL NOT NULL CHECK (price >= 0),
  stock       INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  image_url   TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  group_ref        TEXT NOT NULL,
  buyer_id         INTEGER NOT NULL REFERENCES users(id),
  seller_id        INTEGER NOT NULL REFERENCES users(id),
  total            REAL NOT NULL,
  commission_amount REAL NOT NULL DEFAULT 0,  -- part de la plateforme
  seller_net       REAL NOT NULL DEFAULT 0,   -- part du vendeur (total - commission)
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('awaiting_payment','pending','paid','shipped','delivered','cancelled','refunded')),
  shipping_name    TEXT NOT NULL,
  shipping_phone   TEXT NOT NULL,
  shipping_address TEXT NOT NULL,
  shipping_city    TEXT NOT NULL,
  expires_at       TEXT,                      -- paiement non reçu après cette date : commande annulée
  delivered_at     TEXT,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  title      TEXT NOT NULL,
  price      REAL NOT NULL,
  quantity   INTEGER NOT NULL CHECK (quantity > 0),
  commission_rate REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payment_methods (
  code    TEXT PRIMARY KEY,
  label   TEXT NOT NULL,
  kind    TEXT NOT NULL CHECK (kind IN ('offline','online')),
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id        INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  method          TEXT NOT NULL REFERENCES payment_methods(code),
  amount          REAL NOT NULL,              -- en MAD, pour cette commande
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','refunded')),
  transaction_ref TEXT,                       -- identifiant de capture (PayPal) ou référence interne
  provider_ref    TEXT,                       -- identifiant de la commande PayPal (commun au panier)
  currency        TEXT,                       -- devise réellement débitée (PayPal)
  charged_amount  REAL,                       -- montant total débité pour tout le panier, dans cette devise
  details         TEXT,
  paid_at         TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS checkouts (        -- empêche le double envoi d'une même commande
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL REFERENCES users(id),
  idem_key  TEXT NOT NULL,
  group_ref TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, idem_key)
);

CREATE TABLE IF NOT EXISTS reviews (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  buyer_id   INTEGER NOT NULL REFERENCES users(id),
  seller_id  INTEGER NOT NULL REFERENCES users(id),
  rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (order_id, product_id)
);

CREATE TABLE IF NOT EXISTS disputes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  buyer_id    INTEGER NOT NULL REFERENCES users(id),
  reason      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','refunded','released')),
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS payouts (          -- versements de la plateforme vers les vendeurs
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id  INTEGER NOT NULL REFERENCES users(id),
  amount     REAL NOT NULL CHECK (amount > 0),
  status     TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','paid','rejected')),
  method     TEXT NOT NULL DEFAULT '',
  details    TEXT NOT NULL DEFAULT '',
  reference  TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at    TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (        -- journal des actions sensibles
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor_id INTEGER,
  action   TEXT NOT NULL,
  target   TEXT NOT NULL DEFAULT '',
  details  TEXT NOT NULL DEFAULT '',
  ip       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_seller   ON products(seller_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_orders_buyer      ON orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_orders_seller     ON orders(seller_id);
CREATE INDEX IF NOT EXISTS idx_orders_group      ON orders(group_ref);
CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(status);
CREATE INDEX IF NOT EXISTS idx_items_order       ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_order    ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_provider ON payments(provider_ref);
CREATE INDEX IF NOT EXISTS idx_reviews_product   ON reviews(product_id);
CREATE INDEX IF NOT EXISTS idx_payouts_seller    ON payouts(seller_id);
CREATE INDEX IF NOT EXISTS idx_audit_ts          ON audit_log(ts);
`;

const hasTable = (name) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
const hasColumn = (table, col) =>
  db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);

// Migration d'une base v1 (première version du projet) vers la v2, sans perdre de données.
function migrateFromV1() {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    const add = (table, col, def) => {
      if (!hasColumn(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    };
    add('users', 'active', 'INTEGER NOT NULL DEFAULT 1');
    add('users', 'seller_status', "TEXT NOT NULL DEFAULT 'approved'");
    add('users', 'commission_rate', 'REAL');
    add('users', 'token_version', 'INTEGER NOT NULL DEFAULT 0');
    add('users', 'payout_method', "TEXT NOT NULL DEFAULT ''");
    add('users', 'payout_details', "TEXT NOT NULL DEFAULT ''");
    add('categories', 'commission_rate', 'REAL');
    add('order_items', 'commission_rate', 'REAL NOT NULL DEFAULT 0');
    add('payments', 'provider_ref', 'TEXT');
    add('payments', 'currency', 'TEXT');
    add('payments', 'charged_amount', 'REAL');
    add('payments', 'paid_at', 'TEXT');

    if (hasTable('orders') && !hasColumn('orders', 'commission_amount')) {
      // Procédure officielle SQLite : nouvelle table, copie, suppression de l'ancienne, renommage.
      db.exec(`
        CREATE TABLE orders_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT, group_ref TEXT NOT NULL,
          buyer_id INTEGER NOT NULL REFERENCES users(id), seller_id INTEGER NOT NULL REFERENCES users(id),
          total REAL NOT NULL, commission_amount REAL NOT NULL DEFAULT 0, seller_net REAL NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('awaiting_payment','pending','paid','shipped','delivered','cancelled','refunded')),
          shipping_name TEXT NOT NULL, shipping_phone TEXT NOT NULL, shipping_address TEXT NOT NULL, shipping_city TEXT NOT NULL,
          expires_at TEXT, delivered_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO orders_new (id, group_ref, buyer_id, seller_id, total, commission_amount, seller_net, status,
                                shipping_name, shipping_phone, shipping_address, shipping_city, delivered_at, created_at)
        SELECT id, group_ref, buyer_id, seller_id, total, 0, total, status,
               shipping_name, shipping_phone, shipping_address, shipping_city,
               CASE WHEN status = 'delivered' THEN created_at END, created_at FROM orders;
        DROP TABLE orders;
        ALTER TABLE orders_new RENAME TO orders;
      `);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  db.exec('PRAGMA foreign_keys = ON');
}

const isV1 = hasTable('orders') && !hasColumn('orders', 'commission_amount');
if (isV1) migrateFromV1();
db.exec(SCHEMA);
db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

// Modes de paiement
const insertMethod = db.prepare('INSERT OR IGNORE INTO payment_methods (code, label, kind) VALUES (?, ?, ?)');
[
  ['cod', 'Paiement à la livraison (cash)', 'offline'],
  ['paypal', 'PayPal', 'online'],
  ['card', 'Carte bancaire (CMI / Visa / Mastercard)', 'online'],
  ['bank_transfer', 'Virement bancaire', 'offline'],
  ['cash_agency', 'Paiement en agence (Cash Plus / Wafacash)', 'offline'],
].forEach((m) => insertMethod.run(...m));

// Réglages modifiables par l'administrateur
const DEFAULT_SETTINGS = {
  commission_default: '10',     // % prélevé par la plateforme sur chaque vente
  hold_days: '7',               // jours de séquestre après la livraison avant versement au vendeur
  min_payout: '200',            // montant minimum d'un versement (MAD)
  manual_payment_hours: '72',   // délai pour payer un virement / paiement en agence
};
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

function getSettings() {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = Number(r.value);
  return out;
}
function setSetting(key, value) {
  if (!(key in DEFAULT_SETTINGS)) throw new Error('Réglage inconnu');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function audit(actorId, action, target = '', details = '', ip = '') {
  db.prepare('INSERT INTO audit_log (actor_id, action, target, details, ip) VALUES (?, ?, ?, ?, ?)')
    .run(actorId ?? null, action, String(target), typeof details === 'string' ? details : JSON.stringify(details), ip);
}

module.exports = { db, transaction, audit, getSettings, setSetting, DEFAULT_SETTINGS };
