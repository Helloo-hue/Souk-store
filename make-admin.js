'use strict';
// Crée (ou promeut) un compte administrateur :  node make-admin.js email@exemple.com "Nom Prénom"
// Le mot de passe est demandé en ligne de commande (jamais écrit dans un fichier).
const readline = require('node:readline');
const { db, audit } = require('./db');
const { hashPassword, checkPasswordStrength } = require('./auth');

const [email, name = 'Administrateur'] = process.argv.slice(2);
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
  console.error('Usage : node make-admin.js email@exemple.com "Nom Prénom"');
  process.exit(1);
}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Mot de passe (8 caractères minimum, visible pendant la saisie) : ', (pw) => {
  rl.close();
  const weak = checkPasswordStrength(pw);
  if (weak) { console.error(weak); process.exit(1); }
  const e = email.toLowerCase();
  const row = db.prepare('SELECT id FROM users WHERE email = ?').get(e);
  if (row) {
    db.prepare("UPDATE users SET role = 'admin', active = 1, password_hash = ?, token_version = token_version + 1 WHERE id = ?").run(hashPassword(pw), row.id);
  } else {
    db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')").run(name, e, hashPassword(pw));
  }
  audit(null, 'admin_created_cli', e);
  console.log('Compte administrateur prêt :', e);
});
