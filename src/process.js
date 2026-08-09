// Orchestration du traitement d'UN email, de bout en bout.
import { config } from './config.js';
import { analyzeEmail } from './intent.js';
import { findOrder } from './shopify.js';
import { route } from './router.js';
import { composeReply, reviseReply } from './compose.js';
import { moveToFolder, moveFromFolder, appendDraft, sendReply } from './mailbox.js';

// Intentions qui n'ont pas besoin d'une commande pour répondre.
const NO_ORDER_NEEDED = new Set(['demande_avant_achat', 'info_produit', 'taille']);

// Lien de suivi pour le footer : suivi réel de la commande si dispo, sinon page ParcelPanel générale.
function trackingUrlFor(order) {
  if (order) {
    const t = order.fulfillments.flatMap(f => f.tracking).find(x => x.url || x.number);
    if (t?.url) return t.url;
    if (t?.number) return `https://bexanova.com/apps/parcelpanel?nums=${encodeURIComponent(t.number)}`;
  }
  return 'https://bexanova.com/apps/parcelpanel';
}

// Certains mails (formulaire de contact Shopify, no-reply) portent l'email du client dans "Reply-To".
function isSystemSender(email) {
  const f = `${email.from} ${email.fromName}`.toLowerCase();
  return /shopify|no-?reply|mailer|notif/.test(f);
}
function resolveCustomerEmail(email, analysis) {
  if (isSystemSender(email)) {
    if (email.replyTo && email.replyTo !== email.from) return email.replyTo;
    if (analysis.emailInBody) return analysis.emailInBody;
  }
  return email.from;
}

// Étiquettes FR pour la note interne du gérant.
const INTENT_FR = {
  ou_est_ma_commande: 'Où est ma commande', rien_recu: "N'a rien reçu", colis_en_retard: 'Colis en retard',
  modifier_adresse: "Modifier l'adresse", mauvaise_adresse: 'Mauvaise adresse', annulation: 'Annulation',
  remboursement: 'Remboursement', echange: 'Échange', taille: 'Question de taille', produit_manquant: 'Produit manquant',
  produit_defectueux: 'Produit défectueux', colis_perdu: 'Colis perdu', livre_non_recu: 'Livré mais non reçu',
  suivi: 'Suivi', demande_avant_achat: 'Question avant achat', info_produit: 'Info produit', reclamation: 'Réclamation', autre: 'Autre',
};
function statutFr(s) {
  const u = (s || '').toUpperCase();
  if (u.includes('DELIVERED')) return 'livrée';
  if (u === 'FULFILLED' || u.includes('TRANSIT')) return 'expédiée';
  if (u === 'UNFULFILLED' || u === '') return 'pas encore expédiée';
  return s;
}
function buildOwnerNote({ analysis, order, customerEmail, fromName }) {
  return [
    `👤 Client : ${fromName || ''} <${customerEmail}>`,
    `📩 Demande : ${analysis.summaryFr}`,
    `📦 Commande : ${order ? `#${order.orderNumber} (${statutFr(order.fulfillmentStatus)})` : 'aucune commande trouvée'}`,
    `🏷️ Type : ${INTENT_FR[analysis.intent] || analysis.intent}`,
    `✅ Reco : réponse prudente rédigée en espagnol ci-dessous. Relis, puis effectue l'action (remboursement / annulation / échange) dans Shopify si tu es d'accord.`,
  ].join('\n');
}

// Traite un brouillon annoté par le gérant (dossier SAV_Corriger) : applique la consigne et envoie au client.
export async function processCorrection(client, email) {
  const self = (config.smtp.user || '').toLowerCase();
  const to = email.to && email.to !== self ? email.to : null;
  if (!to) {
    console.log(`  [correction] ⚠️ destinataire client introuvable → SAV_Erreur`);
    await moveFromFolder(client, config.folders.correct, email.uid, config.folders.error);
    return { action: 'error' };
  }
  const body = await reviseReply(email.text);
  await sendReply(client, {
    to,
    subject: email.subject || 'Votre demande',
    body,
    inReplyTo: email.inReplyTo,
    references: email.references,
    trackingUrl: 'https://bexanova.com/apps/parcelpanel',
    language: 'es',
  });
  // Archive la correction (pour en tirer des règles plus tard).
  await moveFromFolder(client, config.folders.correct, email.uid, config.folders.archive);
  console.log(`  [correction→${to}] ✅ consigne du gérant appliquée et envoyée (archivée dans SAV_Corrections)`);
  return { action: 'send' };
}

export async function processEmail(client, email) {
  const log = (m) => console.log(`  [${email.from}] ${m}`);

  // 0) Filtre expéditeurs à ignorer : sa propre adresse (anti-boucle), notifs, no-reply…
  const self = (config.smtp.user || '').toLowerCase();
  if (email.from === self || config.ignoreSenders.some(s => email.from.includes(s))) {
    log('expéditeur ignoré → SAV_Ignore');
    await moveToFolder(client, email.uid, config.folders.skipped);
    return { intent: 'ignorer', action: 'skip' };
  }

  // 1) Compréhension IA
  const analysis = await analyzeEmail(email);
  log(`intent=${analysis.intent} langue=${analysis.language} sentiment=${analysis.sentiment}`);

  if (analysis.intent === 'ignorer') {
    await moveToFolder(client, email.uid, config.folders.skipped);
    return { ...analysis, action: 'skip' };
  }

  // Vrai email du client (gère les formulaires de contact Shopify via Reply-To).
  const customerEmail = resolveCustomerEmail(email, analysis);

  // 2) Recherche automatique de la commande (email client > n° > email cité > nom)
  let order = null, matchedBy = null;
  if (!NO_ORDER_NEEDED.has(analysis.intent)) {
    const res = await findOrder({
      email: customerEmail,
      orderNumber: analysis.orderNumber,
      customerName: analysis.customerName,
    });
    order = res.order;
    matchedBy = res.matchedBy;
    // 2b) 2e essai avec un email cité dans le corps du mail
    if (!order && analysis.emailInBody && analysis.emailInBody !== email.from) {
      const res2 = await findOrder({ email: analysis.emailInBody });
      order = res2.order; matchedBy = res2.matchedBy;
    }
    log(order ? `commande ${order.orderNumber} trouvée (${matchedBy})` : 'aucune commande trouvée');
  }

  // 3) Infos manquantes à demander (uniquement si vraiment nécessaire)
  const missingInfo = [];
  if (!order && !NO_ORDER_NEEDED.has(analysis.intent)) {
    if (!analysis.orderNumber) missingInfo.push('numéro de commande');
    // On a déjà l'email de l'expéditeur : ne jamais le redemander.
  }

  // 4) Décision auto / brouillon
  const decision = route({ intent: analysis.intent, order });
  if (decision.action === 'skip') {
    await moveToFolder(client, email.uid, config.folders.skipped);
    return { ...analysis, action: 'skip' };
  }

  // 5) Rédaction
  const body = await composeReply({ analysis, order, missingInfo, senderName: email.fromName });

  // 6) Envoi ou mise en attente de validation
  const mail = {
    to: customerEmail,
    subject: email.subject || 'Votre demande',
    body,
    inReplyTo: email.messageId,
    references: email.references,
    trackingUrl: trackingUrlFor(order),
    language: analysis.language,
  };

  if (decision.action === 'send') {
    await sendReply(client, mail);
    await moveToFolder(client, email.uid, config.folders.done);
    log(`✅ répondu automatiquement (${decision.reason})`);
    return { ...analysis, action: 'send', order: order?.orderNumber || null };
  } else {
    mail.ownerNote = buildOwnerNote({ analysis, order, customerEmail, fromName: email.fromName });
    await appendDraft(client, mail);
    await moveToFolder(client, email.uid, config.folders.validate);
    log(`📝 brouillon à valider (${decision.reason})`);
    return { ...analysis, action: 'draft', order: order?.orderNumber || null };
  }
}
