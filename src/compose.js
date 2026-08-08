// Rédaction de la réponse client, en langue naturelle, à partir des SEULES données réelles.
import { completeText } from './llm.js';
import { config } from './config.js';

const SYSTEM = `Tu es un(e) conseiller(ère) SAV chaleureux(se) et professionnel(le) de Bexanova (boutique de faja / shapewear).
Tu écris une réponse email au client, prête à envoyer.

RÈGLES ABSOLUES :
- Réponds STRICTEMENT dans la langue demandée (es/fr/en).
- N'invente JAMAIS une information : statut, date, suivi, remboursement. Utilise UNIQUEMENT les données fournies (section DONNÉES).
- N'annonce JAMAIS une livraison qui n'est pas confirmée par les données.
- Si une donnée manque pour répondre, demande UNIQUEMENT le strict nécessaire (jamais une info déjà connue).
- Ton naturel, humain, rassurant si le client est inquiet. Pas de langage robotique, pas de copier-coller.
- Sois concis (5-10 lignes max). Pas de promesses que les données ne garantissent pas.
- Ne mets PAS d'objet, PAS de "Cc", commence directement par la salutation.
- Termine par la signature fournie, telle quelle.
- N'invente pas de délai précis ; reste factuel ("en cours d'acheminement", etc.).`;

// Prépare un bloc DONNÉES lisible pour le modèle.
function factsBlock(order) {
  if (!order) return 'Aucune commande trouvée dans le système pour ce client.';
  const items = order.items.map(i =>
    `  - ${i.title}${i.variant ? ` (${i.variant})` : ''} x${i.quantity}`).join('\n');
  const track = order.fulfillments.flatMap(f => f.tracking).filter(t => t.number);
  const lastEvents = order.fulfillments.flatMap(f => f.events).slice(-3)
    .map(e => `    • ${e.at || ''} ${e.status || ''} ${e.message || ''}`.trim()).join('\n');
  return [
    `Commande: ${order.orderNumber}`,
    `Date: ${order.date}`,
    `Statut paiement: ${order.financialStatus}`,
    `Statut expédition: ${order.fulfillmentStatus}`,
    order.cancelledAt ? `Annulée le: ${order.cancelledAt}` : null,
    `Client: ${order.customerName || ''}`,
    order.shippingAddress ? `Adresse: ${[order.shippingAddress.address1, order.shippingAddress.zip, order.shippingAddress.city, order.shippingAddress.country].filter(Boolean).join(', ')}` : null,
    `Articles:\n${items}`,
    track.length ? `Suivi: ${track.map(t => `${t.carrier || ''} ${t.number}${t.url ? ` (${t.url})` : ''}`).join(' | ')}` : 'Suivi: non disponible',
    lastEvents ? `Derniers événements transport:\n${lastEvents}` : null,
    order.refunds?.length ? `Remboursements: ${order.refunds.map(r => `${r.amount || ''} ${r.currency || ''} ${r.createdAt}`).join(' | ')}` : null,
  ].filter(Boolean).join('\n');
}

const LANG_NAME = { es: 'espagnol', fr: 'français', en: 'anglais' };

export async function composeReply({ analysis, order, missingInfo }) {
  const langInstr = `Langue de réponse : ${LANG_NAME[analysis.language] || 'espagnol'} (${analysis.language}).`;
  const user = `${langInstr}
Intention détectée : ${analysis.intent}
Sentiment client : ${analysis.sentiment}
Résumé de la demande : ${analysis.summary}
${missingInfo?.length ? `Informations manquantes à demander (uniquement celles-ci) : ${missingInfo.join(', ')}` : ''}

DONNÉES (source de vérité — ne rien ajouter) :
${factsBlock(order)}

SIGNATURE à utiliser à la fin (traduis "L'équipe Bexanova" dans la langue du client si pertinent) :
${config.signature}

Rédige maintenant l'email de réponse.`;
  return completeText(SYSTEM, user, 1200);
}
