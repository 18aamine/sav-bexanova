// Configuration centralisée — tout vient des variables d'environnement (Secrets GitHub).
// Aucun secret n'est jamais écrit en dur dans le code.

function req(name, fallback = undefined) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`Variable d'environnement manquante: ${name}`);
  }
  return v;
}

function opt(name, fallback = '') {
  return process.env[name] ?? fallback;
}

function bool(name, fallback = false) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'oui'].includes(String(v).toLowerCase());
}

export const config = {
  // --- Boîte mail SAV (LWS) ---
  imap: {
    host: req('IMAP_HOST'),            // ex: mail85.lwspanel.com
    port: Number(opt('IMAP_PORT', '993')),
    secure: bool('IMAP_SECURE', true),
    user: req('MAIL_USER'),            // adresse SAV complète
    pass: req('MAIL_PASS'),
    inbox: opt('IMAP_INBOX', 'INBOX'),
  },
  smtp: {
    host: req('SMTP_HOST'),            // ex: mail85.lwspanel.com
    port: Number(opt('SMTP_PORT', '465')),
    secure: bool('SMTP_SECURE', true),
    user: req('MAIL_USER'),
    pass: req('MAIL_PASS'),
    fromName: opt('MAIL_FROM_NAME', 'Bexanova'),
    fromAddress: opt('MAIL_FROM_ADDRESS', process.env.MAIL_USER || ''),
  },

  // Dossiers IMAP de classement (créés automatiquement s'ils n'existent pas)
  folders: {
    validate: opt('FOLDER_VALIDATE', 'SAV_A_valider'),   // brouillons à relire (cas sensibles)
    done: opt('FOLDER_DONE', 'SAV_Traite'),              // mails traités + répondus auto
    skipped: opt('FOLDER_SKIPPED', 'SAV_Ignore'),        // non-SAV (spam, fournisseur…)
    error: opt('FOLDER_ERROR', 'SAV_Erreur'),            // à traiter à la main
  },

  // --- Shopify Admin API ---
  shopify: {
    shop: req('SHOPIFY_SHOP', 'bexanova.com').replace(/^https?:\/\//, ''),
    token: req('SHOPIFY_ADMIN_TOKEN'),
    apiVersion: opt('SHOPIFY_API_VERSION', '2024-10'),
  },

  // --- Cerveau IA (interchangeable) ---
  llm: {
    provider: opt('LLM_PROVIDER', 'claude').toLowerCase(), // 'claude' | 'gemini'
    claude: {
      apiKey: opt('ANTHROPIC_API_KEY'),
      model: opt('CLAUDE_MODEL', 'claude-haiku-4-5-20251001'),
    },
    gemini: {
      apiKey: opt('GEMINI_API_KEY'),
      model: opt('GEMINI_MODEL', 'gemini-2.0-flash'),
    },
    groq: {
      apiKey: opt('GROQ_API_KEY'),
      model: opt('GROQ_MODEL', 'llama-3.1-8b-instant'),
    },
  },

  // --- Comportement ---
  autoSend: bool('AUTO_SEND', true),     // false => tout part en brouillon "À valider"
  dryRun: bool('DRY_RUN', false),        // true => n'envoie/ne déplace rien, log seulement
  maxEmailsPerRun: Number(opt('MAX_EMAILS_PER_RUN', '4')),
  pauseBetweenMs: Number(opt('PAUSE_BETWEEN_MS', '8000')), // espace les appels IA (limite de débit gratuite)
  signature: opt(
    'MAIL_SIGNATURE',
    "L'équipe Bexanova\nservice client",
  ),
  // Emails internes à ne jamais traiter comme des clients (fournisseurs, notifs…)
  ignoreSenders: opt('IGNORE_SENDERS', 'no-reply,noreply,mailer-daemon,postmaster,shopify,klaviyo')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
};

export { bool, opt };
