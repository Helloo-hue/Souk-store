'use strict';
const { db, audit } = require('../db');
const {
  HttpError, Reply, route, str, EMAIL_RE, rateLimit, peekLimit, resetLimit, publicUser,
} = require('../core');
const {
  hashPassword, verifyPassword, dummyVerify, sessionCookie, clearCookie, checkPasswordStrength,
} = require('../auth');

route('POST', '/api/auth/register', { limit: ['register', 10, 3_600_000] }, ({ body, ip }) => {
  const name = str(body.name, 80, 'nom', { min: 2 });
  const email = str(body.email, 120, 'email').toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  const role = body.role === 'seller' ? 'seller' : 'buyer';       // jamais admin via l'API
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Email invalide');
  const weak = checkPasswordStrength(password);
  if (weak) throw new HttpError(400, weak);
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    throw new HttpError(409, 'Cet email est déjà utilisé');
  }
  // Un nouveau vendeur doit être validé par l'administrateur avant que ses produits soient visibles.
  const status = role === 'seller' ? 'pending' : 'approved';
  const info = db
    .prepare('INSERT INTO users (name, email, password_hash, role, seller_status) VALUES (?, ?, ?, ?, ?)')
    .run(name, email, hashPassword(password), role, status);
  const id = Number(info.lastInsertRowid);
  audit(id, 'register', `user:${id}`, { role }, ip);
  const user = { id, name, email, role, seller_status: status };
  return new Reply({ user }, { status: 201, cookies: [sessionCookie(id, 0)] });
});

route('POST', '/api/auth/login', ({ body, ip }) => {
  const email = str(body.email, 120, 'email').toLowerCase();
  const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
  const keyUser = `login:${ip}|${email}`;
  const keyIp = `login-ip:${ip}`;
  if (peekLimit(keyUser, 8) || peekLimit(keyIp, 40)) {
    throw new HttpError(429, 'Trop de tentatives, réessayez dans 15 minutes');
  }
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const ok = row ? verifyPassword(password, row.password_hash) : (dummyVerify(password), false);
  if (!ok || !row.active) {
    rateLimit(keyUser, 8, 900_000);
    rateLimit(keyIp, 40, 900_000);
    audit(row?.id, 'login_failed', email, '', ip);
    throw new HttpError(401, 'Email ou mot de passe incorrect');
  }
  resetLimit(keyUser);
  return new Reply({ user: publicUser(row) }, { cookies: [sessionCookie(row.id, row.token_version)] });
});

route('POST', '/api/auth/logout', () => new Reply({ ok: true }, { cookies: [clearCookie()] }));

// Déconnecte tous les appareils (invalide toutes les sessions)
route('POST', '/api/auth/logout-all', { auth: true }, ({ user, ip }) => {
  db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(user.id);
  audit(user.id, 'logout_all', `user:${user.id}`, '', ip);
  return new Reply({ ok: true }, { cookies: [clearCookie()] });
});

route('POST', '/api/auth/password', { auth: true, limit: ['pwd', 5, 900_000] }, ({ body, user, ip }) => {
  const current = typeof body.current === 'string' ? body.current : '';
  const next = typeof body.next === 'string' ? body.next : '';
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
  if (!verifyPassword(current, row.password_hash)) throw new HttpError(401, 'Mot de passe actuel incorrect');
  const weak = checkPasswordStrength(next);
  if (weak) throw new HttpError(400, weak);
  const ver = user.token_version + 1;
  db.prepare('UPDATE users SET password_hash = ?, token_version = ? WHERE id = ?').run(hashPassword(next), ver, user.id);
  audit(user.id, 'password_changed', `user:${user.id}`, '', ip);
  return new Reply({ ok: true }, { cookies: [sessionCookie(user.id, ver)] });   // les autres appareils sont déconnectés
});

route('GET', '/api/auth/me', ({ user }) => {
  // Pas d'erreur 401 ici : "non connecté" est une réponse normale.
  return { user: user ? publicUser(user) : null };
});
