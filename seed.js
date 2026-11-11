'use strict';
// Données de démonstration : npm run seed   (ajouter --reset pour vider la base avant)
// Interdit en production : les comptes de démonstration ont des mots de passe connus de tous.
const config = require('./config');
if (config.production && !process.argv.includes('--i-know-this-is-demo-data')) {
  console.error('Refusé : NODE_ENV=production. Créez votre administrateur avec « node make-admin.js » à la place.');
  process.exit(1);
}
const { db, transaction } = require('./db');
const { hashPassword } = require('./auth');

const reset = process.argv.includes('--reset');
if (!reset && db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) {
  console.log('La base contient déjà des données. Utilisez « npm run seed -- --reset » pour repartir de zéro.');
  process.exit(0);
}

transaction(() => {
  if (reset) {
    db.exec(`DELETE FROM audit_log; DELETE FROM payouts; DELETE FROM disputes; DELETE FROM reviews; DELETE FROM checkouts;
             DELETE FROM payments; DELETE FROM order_items; DELETE FROM orders; DELETE FROM products;
             DELETE FROM categories; DELETE FROM users; DELETE FROM sqlite_sequence;`);
  }
  const addUser = db.prepare('INSERT INTO users (name, email, password_hash, role, seller_status) VALUES (?, ?, ?, ?, ?)');
  const users = [
    ['Administrateur', 'admin@demo.ma', 'admin123', 'admin', 'approved'],
    ['Atelier Fès Artisanat', 'seller1@demo.ma', 'seller123', 'seller', 'approved'],
    ['Maroc Gourmet', 'seller2@demo.ma', 'seller123', 'seller', 'approved'],
    ['Amine Client', 'buyer@demo.ma', 'buyer123', 'buyer', 'approved'],
    ['Nouvelle Boutique', 'seller3@demo.ma', 'seller123', 'seller', 'pending'],   // pour tester la validation des vendeurs
  ];
  const ids = users.map(([name, email, pwd, role, st]) =>
    Number(addUser.run(name, email, hashPassword(pwd), role, st).lastInsertRowid));
  const [, seller1, seller2] = ids;

  const addCat = db.prepare('INSERT INTO categories (name, commission_rate) VALUES (?, ?)');
  const cat = {};
  // Commission plus basse sur l'artisanat (pour attirer les artisans), plus haute sur l'électronique
  [['Mode', null], ['Maison & Déco', null], ['Beauté & Bien-être', null], ['Alimentation', null],
   ['Électronique', 12], ['Artisanat', 8]].forEach(([n, r]) => (cat[n] = Number(addCat.run(n, r).lastInsertRowid)));

  const IMAGES = ['babouches', 'caftan', 'tapis', 'theiere', 'lanterne', 'poterie', 'argan', 'savon', 'miel', 'epices', 'amlou', 'ecouteurs'];
  const addProduct = db.prepare(
    `INSERT INTO products (seller_id, category_id, title, description, price, stock, image_url) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  [
    [seller1, 'Mode', 'Babouches en cuir véritable', 'Babouches traditionnelles cousues main à Fès, cuir souple, semelle renforcée.', 189, 25],
    [seller1, 'Mode', 'Caftan brodé main', 'Caftan élégant en tissu léger avec broderies dorées, idéal pour les occasions.', 1290, 6],
    [seller1, 'Maison & Déco', 'Tapis berbère en laine', 'Tapis tissé à la main en laine naturelle, motifs géométriques, 160×230 cm.', 2450, 4],
    [seller1, 'Artisanat', 'Théière marocaine en laiton', 'Théière gravée avec plateau assorti, parfaite pour le thé à la menthe.', 320, 15],
    [seller1, 'Artisanat', 'Lanterne en fer forgé', 'Lanterne ajourée qui projette de beaux jeux de lumière, hauteur 35 cm.', 240, 12],
    [seller1, 'Maison & Déco', 'Poterie de Safi, assiette décorée', 'Assiette en céramique peinte à la main, diamètre 28 cm.', 95, 40],
    [seller2, 'Beauté & Bien-être', "Huile d'argan pure 100 ml", "Huile d'argan cosmétique pressée à froid par une coopérative féminine.", 140, 60],
    [seller2, 'Beauté & Bien-être', 'Savon noir beldi + gant kessa', 'Kit hammam traditionnel : savon noir à l’eucalyptus et gant gommant.', 55, 80],
    [seller2, 'Alimentation', 'Miel d’oranger 500 g', 'Miel naturel récolté dans la région de Berkane.', 85, 35],
    [seller2, 'Alimentation', 'Ras el hanout, mélange d’épices 100 g', 'Mélange artisanal de 27 épices pour tajines et couscous.', 38, 100],
    [seller2, 'Alimentation', 'Amlou aux amandes 250 g', 'Pâte à tartiner d’amandes, huile d’argan et miel.', 65, 3],
    [seller2, 'Électronique', 'Écouteurs Bluetooth sans fil', 'Autonomie 24 h, réduction de bruit, boîtier de charge USB-C.', 349, 20],
  ].forEach(([seller, c, title, desc, price, stock], i) => addProduct.run(seller, cat[c], title, desc, price, stock, `/img/${IMAGES[i]}.svg`));
});

console.log('Base remplie avec des données de démonstration.');
console.log('Comptes de test (à ne jamais utiliser en production) :');
console.log('  admin    admin@demo.ma    / admin123');
console.log('  vendeur  seller1@demo.ma  / seller123   (validé)');
console.log('  vendeur  seller2@demo.ma  / seller123   (validé)');
console.log('  vendeur  seller3@demo.ma  / seller123   (en attente de validation)');
console.log('  acheteur buyer@demo.ma    / buyer123');
