# Souk — marketplace v2 (commission, séquestre, PayPal, sécurité)

Marketplace multi-vendeurs sans aucune dépendance : Node.js **22.5+** suffit.

```bash
npm run seed     # données de démo (dev uniquement)
npm start        # http://localhost:3000
npm test         # 28 tests automatiques
npm run make-admin -- email@exemple.com   # promouvoir un admin (node make-admin.js)
node backup.js   # sauvegarde de la base
```

Comptes démo : admin@demo.ma/admin123 · seller1@demo.ma/seller123 (approuvé) · seller3@demo.ma/seller123 (en attente) · buyer@demo.ma/buyer123.

## Ton revenu : la commission
- Taux par défaut **10 %** (admin → Commissions). Priorité : taux du vendeur > taux de la catégorie > taux par défaut (0–50 %).
- Calculé **uniquement côté serveur**, figé sur chaque commande (`commission_amount`, `seller_net`). Le vendeur voit en direct « Commission X % : vous recevez Y MAD ». L'acheteur ne la voit pas.
- Les frais PayPal sont payés par la plateforme (ils sortent de ta commission) : garde un taux ≥ 8 %.

## Flux d'argent (séquestre)
- **PayPal, carte, virement, agence cash** : la plateforme encaisse, l'argent du vendeur est « en séquestre » puis devient « disponible » `hold_days` (7) jours après la livraison, s'il n'y a pas de litige.
- **Paiement à la livraison** : le vendeur encaisse et te doit la commission une fois la commande livrée.
- Le vendeur demande un versement (minimum 200 MAD) ; l'admin le paie manuellement (virement) puis le marque « payé ».
- Virement et agence cash : **seul l'admin** confirme la réception du paiement.
- Litiges, remboursements (PayPal remboursé via l'API, au prorata pour un panier multi-vendeurs).

## Paiements
| Mode | État |
|---|---|
| Paiement à la livraison | réel |
| Virement bancaire (`BANK_IBAN`, `BANK_HOLDER`) | réel, confirmation manuelle admin |
| Agence cash Cash Plus/Wafacash (`CASH_AGENCY_*`) | réel, confirmation manuelle admin |
| PayPal | réel dès que configuré, sinon simulateur en dev |
| Carte bancaire | **simulée** : il faut un contrat avec une banque marocaine (CMI) ; Stripe n'accepte pas les sociétés marocaines |

### Brancher PayPal
Raccourci : copie `.env.example` en `.env`, remplis les clés, relance `npm start` (le serveur lit `.env` tout seul).
1. developer.paypal.com → Apps → créer une app (Sandbox d'abord).
2. Variables : `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_MODE=sandbox|live`, `BASE_URL=https://ton-domaine`, `PAYPAL_CURRENCY=EUR` et `PAYPAL_RATE=0.092` (MAD→EUR) car PayPal ne supporte peut‑être pas le MAD : **vérifie dans ton compte**.
3. Webhook (PAYMENT.CAPTURE.COMPLETED / REFUNDED) vers `BASE_URL/api/paypal/webhook`, puis `PAYPAL_WEBHOOK_ID`.
4. Teste avec les comptes sandbox avant de passer en `live`.
Le montant est recapturé et vérifié côté serveur (montant + devise), les retours rejoués sont idempotents.

## Sécurité
Cookie HttpOnly SameSite (`__Host-` en HTTPS), CSRF (en-tête + Origin), révocation de session (changement de mot de passe, déconnexion partout), limites de débit (login, inscription, commandes, global), hash scrypt, anti‑énumération de comptes, mots de passe forts, CSP stricte sans inline, HSTS, approbation des vendeurs, filtre anti‑contournement (téléphone/email dans annonces et avis), journal d'audit, transactions atomiques et clés d'idempotence, protection contre le path traversal, graine refusée en production.

## Leçons des autres marketplaces
- **Évasion** (vendeur et acheteur finissent hors plateforme) : on garde la valeur sur la plateforme (séquestre, protection acheteur, avis uniquement via commande) et on ne sur‑taxe pas ; les filtres seuls ne suffisent pas.
- **Fraude vendeur** : approbation manuelle + argent bloqué jusqu'à livraison.
- **Litiges flous** : statuts clairs, litige bloque le versement.
- **Commissions cachées** : le vendeur voit toujours son net avant de publier.

## Mise en production (checklist)
`NODE_ENV=production`, `JWT_SECRET` long et aléatoire, `BASE_URL` en https, `TRUST_PROXY=1` derrière un proxy, HTTPS (Caddy/Nginx), ne pas lancer `seed`, créer l'admin avec `make-admin`, sauvegardes régulières, conditions d'utilisation + mentions légales + déclaration fiscale (auto‑entrepreneur au Maroc).
