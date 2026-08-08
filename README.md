# 🤖 Agent SAV autonome — Bexanova

Système de service client automatique. Pour chaque email reçu sur la boîte SAV :
lecture → compréhension IA → détection langue → recherche commande Shopify →
rédaction naturelle → **envoi auto** (cas simples) ou **brouillon à valider** (cas sensibles) → classement.

```
📩 Mail non lu (IMAP)
   ↓
🧠 Analyse IA (intention + langue + identifiants)   ← Claude ou Gemini
   ↓
🔍 Recherche commande (Shopify Admin API : email → n° → nom)
   ↓
📦 Récupération données réelles (statut, articles, tracking, remboursement…)
   ↓
✍️  Rédaction dans la langue du client (ES/FR/EN)
   ↓
📨 Envoi auto (simple)   |   📝 Brouillon "SAV_A_valider" (sensible)
   ↓
✅ Mail classé (SAV_Traite / SAV_A_valider / SAV_Ignore / SAV_Erreur)
```

**100% gratuit** : tourne via **GitHub Actions** (cron toutes les 15 min), sans serveur.
Aucun secret dans le code — tout passe par les *Secrets* GitHub.

---

## 🧠 Mode « hybride par confiance »

| Envoi **automatique** (cas simples) | **Brouillon à valider** (cas sensibles) |
|---|---|
| Où est ma commande, suivi, colis en retard, taille, infos produit, demande avant achat | Remboursement, annulation, échange, produit défectueux/manquant, colis perdu, livré-non-reçu, changement d'adresse, réclamation |

Garde-fou : si un client dit « rien reçu » mais que le suivi indique **livré**, la réponse passe automatiquement en **brouillon à valider** (litige).

> Pour démarrer **encore plus prudemment** : mettez le secret `AUTO_SEND=false` → **tout** part en brouillon le temps de vérifier la qualité, puis repassez à `true`.

---

## ⚙️ Installation (≈ 20 min, aucune compétence technique requise)

### 1. Créer le dépôt GitHub
1. Compte gratuit sur https://github.com → **New repository** → nom `sav-bexanova` → **Private**.
2. Uploadez tous les fichiers de ce dossier (bouton **Add file → Upload files**), puis **Commit**.

### 2. Créer l'app Shopify (jeton lecture seule)
Dans l'admin Shopify → **Paramètres → Applications et canaux de vente → Développer des apps → Créer une app** :
- Nom : `SAV Agent`.
- **Configurer les scopes Admin API** → cochez : `read_orders`, `read_customers`, `read_fulfillments`, `read_products`.
- **Installer l'app** → copiez le **jeton d'accès Admin API** (`shpat_…`). ⚠️ visible une seule fois.

> ℹ️ Par défaut Shopify limite l'API aux **commandes des 60 derniers jours**. Suffisant pour le SAV. Pour l'historique complet, demandez le scope `read_all_orders` à Shopify.

### 3. Récupérer les infos de la boîte LWS
✅ **Serveur déjà confirmé pour Bexanova** : `mail85.lwspanel.com` (IMAP `993`, SMTP `465`, SSL).
Il ne vous reste qu'à récupérer le **mot de passe** de l'adresse SAV dans votre panel LWS.

### 4. Clé IA
- **Claude** (par défaut) : https://console.anthropic.com → API Keys (petit coût ~2-5€/mois).
- **OU Gemini gratuit** : https://aistudio.google.com/apikey → mettez `LLM_PROVIDER=gemini` + `GEMINI_API_KEY`.

### 5. Ajouter les Secrets GitHub
Dépôt → **Settings → Secrets and variables → Actions → New repository secret**. À créer :

| Secret | Exemple | Obligatoire |
|---|---|---|
| `IMAP_HOST` | `mail85.lwspanel.com` | ✅ |
| `SMTP_HOST` | `mail85.lwspanel.com` | ✅ |
| `IMAP_PORT` / `SMTP_PORT` | `993` / `465` | (défauts OK) |
| `MAIL_USER` | `sav@bexanova.com` | ✅ |
| `MAIL_PASS` | *(mot de passe boîte)* | ✅ |
| `MAIL_FROM_NAME` | `Bexanova` | conseillé |
| `SHOPIFY_SHOP` | `bexanova.com` | ✅ |
| `SHOPIFY_ADMIN_TOKEN` | `shpat_…` | ✅ |
| `LLM_PROVIDER` | `claude` ou `gemini` | ✅ |
| `ANTHROPIC_API_KEY` | `sk-ant-…` | si Claude |
| `GEMINI_API_KEY` | `AIza…` | si Gemini |
| `AUTO_SEND` | `true` (ou `false` au début) | conseillé |

### 6. Tester puis activer
- **Diagnostic d'abord** : onglet **Actions** → **SAV Bexanova** → **Run workflow** → mode **`check`**. Il teste IMAP, SMTP, Shopify et l'IA, et vous dit précisément ce qui cloche (ou 🎉 si tout est bon). En local : `npm run check`.
- Onglet **Actions** → activez les workflows → **SAV Bexanova** → **Run workflow** (mode **`run`**).
- Regardez les logs. **Astuce test** : ajoutez d'abord le secret `DRY_RUN=true` → l'agent analyse et écrit les logs **sans envoyer ni déplacer** aucun mail. Retirez-le quand tout est bon.
- Une fois validé, le cron s'occupe de tout, toutes les 15 min.

---

## 🧪 Test en local (optionnel)
```bash
npm install
cp .env.example .env   # remplissez vos valeurs
npm run dry            # analyse sans rien envoyer
npm run once           # un passage réel
```

## 🔁 Changer de cerveau IA
Un seul secret à modifier : `LLM_PROVIDER` = `claude` ou `gemini`. Rien d'autre à toucher.

## 🔒 Règles de fiabilité intégrées
- Ne jamais inventer une info ni un statut ; réponses basées uniquement sur les données Shopify réelles.
- Ne jamais annoncer une livraison non confirmée.
- Ne demander que les informations réellement manquantes (jamais l'email de l'expéditeur, déjà connu).
- Un mail en erreur est classé dans `SAV_Erreur` (jamais perdu, jamais de réponse hasardeuse).
```
