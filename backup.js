'use strict';
// Sauvegarde cohérente de la base :  node backup.js   (crée backups/marketplace-AAAA-MM-JJ-HHMM.db)
const fs = require('node:fs');
const path = require('node:path');
const { db } = require('./db');
const dir = path.join(__dirname, 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, (c) => (c === 'T' ? '-' : c === ':' ? '' : '-'));
const file = path.join(dir, `marketplace-${stamp}.db`);
db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
console.log('Sauvegarde créée :', file);
