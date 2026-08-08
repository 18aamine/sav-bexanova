// Orchestration du traitement d'UN email, de bout en bout.
import { config } from './config.js';
import { analyzeEmail } from './intent.js';
import { findOrder } from './shopify.js';
import { route } from './router.js';
import { composeReply } from './compose.js';
import { moveToFolder, appendDraft, sendReply } from './mailbox.js';

// Intentions qui n'ont pas besoin d'une commande pour répondre.
const NO_ORDER_NEEDED = new Set(['demande_avant_achat', 'info_produit', 'taille']);

export async function processEmail(client, email) {
  const log = (m) => console.log(`  [${email.from}] ${m}`);

  // 0) Filtre expéditeurs à ignorer (notifs, no-reply…)
  if (config.ignoreSenders.some(s => email.from.includes(s))) {
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

  // 2) Recherche automatique de la commande (email expéditeur > n° > email cité > nom)
  let order = null, matchedBy = null;
  if (!NO_ORDER_NEEDED.has(analysis.intent)) {
    const res = await findOrder({
      email: email.from,
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
    to: email.from,
    subject: email.subject || 'Votre demande',
    body,
    inReplyTo: email.messageId,
    references: email.references,
  };

  if (decision.action === 'send') {
    await sendReply(mail);
    await moveToFolder(client, email.uid, config.folders.done);
    log(`✅ répondu automatiquement (${decision.reason})`);
    return { ...analysis, action: 'send', order: order?.orderNumber || null };
  } else {
    await appendDraft(client, mail);
    await moveToFolder(client, email.uid, config.folders.validate);
    log(`📝 brouillon à valider (${decision.reason})`);
    return { ...analysis, action: 'draft', order: order?.orderNumber || null };
  }
}
