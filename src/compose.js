// Rédaction de la réponse client, en langue naturelle, à partir des SEULES données réelles.
import { completeText } from './llm.js';
import { config } from './config.js';

const SYSTEM = `Tu es un(e) conseiller(ère) SAV chaleureux(se) et professionnel(le) de Bexanova (boutique de faja / shapewear).
Tu écris une réponse email au client, prête à envoyer.

RÈGLES ABSOLUES :
- Réponds STRICTEMENT dans la langue demandée (es/fr/en). Chaque mot doit être dans cette langue : n'utilise JAMAIS un mot d'une autre langue (ex: pas de "acheminement" ni de mot anglais dans un email espagnol).
- N'écris JAMAIS un code technique interne tel quel (FULFILLED, UNFULFILLED, PAID, IN_TRANSIT, etc.). Exprime toujours le sens en langage naturel dans la langue du client.
- N'invente JAMAIS une information : statut, date, suivi, remboursement, douane, retour à l'expéditeur. Utilise UNIQUEMENT les données fournies (section DONNÉES).
- Ne mentionne un événement de transport (en douane, livré, en cours de livraison, retourné) QUE s'il apparaît explicitement dans "Derniers événements transport". Sinon, reste général ("en cours d'acheminement").
- N'annonce JAMAIS une livraison qui n'est pas confirmée par les données.
- Si une donnée manque pour répondre, demande UNIQUEMENT le strict nécessaire (jamais une info déjà connue).
- Salutation : utilise le PRÉNOM du client fourni ("Nom du client"). Si aucun nom n'est fourni, utilise une salutation neutre et chaleureuse (ex: "Hola" / "Bonjour" / "Hello"). N'invente JAMAIS un prénom.
- Ton naturel, humain, rassurant si le client est inquiet. Pas de langage robotique, pas de copier-coller.
- Sois concis (5-10 lignes max). Pas de promesses que les données ne garantissent pas.
- Ne mets PAS d'objet, PAS de "Cc", commence directement par la salutation.
- Termine par la signature fournie (traduite dans la langue du client).`;

// Traduit les codes de statut Shopify en descriptions neutres (jamais montrées telles quelles au client).
function humanFulfillment(status) {
  const s = (status || '').toUpperCase();
  if (s.includes('DELIVERED')) return 'commande livrée (selon le suivi)';
  if (s.includes('IN_TRANSIT') || s.includes('OUT_FOR_DELIVERY')) return 'commande expédiée, en cours d\'acheminement';
  if (s === 'FULFILLED') return 'commande expédiée';
  if (s === 'PARTIALLY_FULFILLED') return 'commande partiellement expédiée';
  if (s === 'UNFULFILLED' || s === '') return 'commande pas encore expédiée (en préparation)';
  return `état d'expédition : ${status}`;
}
function humanFinancial(status) {
  const s = (status || '').toUpperCase();
  if (s === 'PAID') return 'payée';
  if (s === 'REFUNDED') return 'remboursée';
  if (s === 'PARTIALLY_REFUNDED') return 'partiellement remboursée';
  if (s === 'PENDING') return 'paiement en attente';
  return status || '';
}

// Prépare un bloc DONNÉES lisible pour le modèle (sans codes techniques bruts).
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
    `Paiement: ${humanFinancial(order.financialStatus)}`,
    `Expédition: ${humanFulfillment(order.fulfillmentStatus)}`,
    order.cancelledAt ? `Annulée le: ${order.cancelledAt}` : null,
    order.shippingAddress ? `Adresse: ${[order.shippingAddress.address1, order.shippingAddress.zip, order.shippingAddress.city, order.shippingAddress.country].filter(Boolean).join(', ')}` : null,
    `Articles:\n${items}`,
    track.length ? `Suivi: ${track.map(t => `${t.carrier || ''} ${t.number}${t.url ? ` (${t.url})` : ''}`).join(' | ')}` : 'Suivi: non disponible pour le moment',
    lastEvents ? `Derniers événements transport:\n${lastEvents}` : 'Derniers événements transport: aucun détail disponible',
    order.refunds?.length ? `Remboursements: ${order.refunds.map(r => `${r.amount || ''} ${r.currency || ''} ${r.createdAt}`).join(' | ')}` : null,
  ].filter(Boolean).join('\n');
}

const LANG_NAME = { es: 'espagnol', fr: 'français', en: 'anglais' };

// Extrait un prénom propre pour la salutation (jamais une adresse email).
function cleanName(name) {
  if (!name) return '';
  const n = String(name).trim();
  if (!n || n.includes('@')) return '';
  return n.split(/\s+/)[0]; // prénom uniquement
}

export async function composeReply({ analysis, order, missingInfo, senderName }) {
  const greetName = cleanName(senderName) || cleanName(analysis.customerName);
  const langInstr = `Langue de réponse : ${LANG_NAME[analysis.language] || 'espagnol'} (${analysis.language}).`;
  const user = `${langInstr}
Nom du client (pour la salutation) : ${greetName || '(inconnu — utilise une salutation neutre)'}
Intention détectée : ${analysis.intent}
Sentiment client : ${analysis.sentiment}
Résumé de la demande : ${analysis.summary}
${missingInfo?.length ? `Informations manquantes à demander (uniquement celles-ci) : ${missingInfo.join(', ')}` : ''}

DONNÉES (source de vérité — ne rien ajouter, ne rien inventer) :
${factsBlock(order)}

SIGNATURE à utiliser à la fin (traduite dans la langue du client) :
${config.signature}

Rédige maintenant l'email de réponse.`;
  return completeText(SYSTEM, user, 1200);
}
