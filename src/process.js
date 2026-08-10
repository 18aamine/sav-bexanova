// Orchestration du traitement d'UN email, de bout en bout.
import { config } from './config.js';
import { analyzeEmail } from './intent.js';
import { findOrder } from './shopify.js';
import { route } from './router.js';
import { composeReply, reviseReply, summarizeReplyFr } from './compose.js';
import { moveToFolder, moveFromFolder, appendDraft, sendReply } from './mailbox.js';

// Intentions qui n'ont pas besoin d'une commande pour répondre.
const NO_ORDER_NEEDED = new Set(['demande_avant_achat', 'info_produit', 'taille', 'guide_non_recu']);

// Après réponse auto, on classe le mail dans le bon dossier d'action pour le gérant.
const REFUND_INTENTS = new Set(['remboursement', 'annulation']);
const AGENT_INTENTS = new Set(['echange', 'produit_defectueux', 'produit_manquant', 'colis_perdu', 'livre_non_recu', 'reclamation', 'modifier_adresse', 'mauvaise_adresse']);
function destinationFolder(intent) {
  if (REFUND_INTENTS.has(intent)) return config.folders.refunds;   // → SAV_Remboursements
  if (AGENT_INTENTS.has(intent)) return config.folders.agent;      // → SAV_Agente
  return config.folders.done;                                      // → SAV_Traite (rien à faire)
}

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
  suivi: 'Suivi', demande_avant_achat: 'Question avant achat', info_produit: 'Info produit', reclamation: 'Réclamation', guide_non_recu: 'Guide/eBook non reçu', autre: 'Autre',
};
function statutFr(s) {
  const u = (s || '').toUpperCase();
  if (u.includes('DELIVERED')) return 'livrée';
  if (u === 'FULFILLED' || u.includes('TRANSIT')) return 'expédiée';
  if (u === 'UNFULFILLED' || u === '') return 'pas encore expédiée';
  return s;
}
function buildOwnerNote({ analysis, order, customerEmail, fromName, replySummaryFr }) {
  return [
    `👤 Client : ${fromName || ''} <${customerEmail}>`,
    `📩 Demande : ${analysis.summaryFr}`,
    `📦 Commande : ${order ? `#${order.orderNumber} (${statutFr(order.fulfillmentStatus)})` : 'aucune commande trouvée'}`,
    `🏷️ Type : ${INTENT_FR[analysis.intent] || analysis.intent}`,
    `🤖 Le robot répond (résumé) : ${replySummaryFr || '(voir la réponse ci-dessous)'}`,
    `✅ Reco : relis, puis effectue l'action (remboursement / annulation / échange) dans Shopify si tu es d'accord.`,
  ].join('\n');
}

// Récupère l'email de la cliente dans le texte (note jaune « Client : ... <email> ») si le champ "À" est perdu.
function customerEmailFromText(text, self) {
  const found = (String(text || '').match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [])
    .map(e => e.toLowerCase())
    .filter(e => e !== self && !e.includes('bexanova.com') && !e.includes('shopify.com'));
  return found[0] || null;
}

// Traite un brouillon annoté par le gérant (dossier SAV_Corriger) : applique la consigne et envoie au client.
export async function processCorrection(client, email) {
  const self = (config.smtp.user || '').toLowerCase();
  // Destinataire : le champ "À" s'il est valide, sinon l'email trouvé dans la note jaune.
  const to = (email.to && email.to !== self && !email.to.includes('bexanova.com') ? email.to : null)
    || customerEmailFromText(email.text, self);
  if (!to) {
    console.log(`  [correction] ⚠️ destinataire client introuvable → SAV_Erreur`);
    await moveFromFolder(client, config.folders.correct, email.uid, config.folders.error);
    return { action: 'error' };
  }
  console.log(`  [correction] destinataire = ${to}`);
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

  // 5) Rédaction de la réponse client
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
    const dest = destinationFolder(analysis.intent);
    await moveToFolder(client, email.uid, dest);
    log(`✅ répondu automatiquement (${decision.reason}) → ${dest}`);
    return { ...analysis, action: 'send', order: order?.orderNumber || null };
  } else {
    const replySummaryFr = await summarizeReplyFr(body); // résumé fiable de la réponse écrite
    mail.ownerNote = buildOwnerNote({ analysis, order, customerEmail, fromName: email.fromName, replySummaryFr });
    await appendDraft(client, mail);
    // Seul le brouillon reste dans SAV_A_valider ; l'original part dans SAV_Traite (moins d'encombrement).
    await moveToFolder(client, email.uid, config.folders.done);
    log(`📝 brouillon à valider (${decision.reason})`);
    return { ...analysis, action: 'draft', order: order?.orderNumber || null };
  }
}
