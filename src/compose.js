// Rédaction de la réponse client, en langue naturelle, à partir des SEULES données réelles.
import { completeText } from './llm.js';
import { config } from './config.js';

const SYSTEM = `Tu es un(e) conseiller(ère) SAV chaleureux(se) et professionnel(le) de Bexanova (boutique de faja / shapewear).
Tu écris une réponse email au client, prête à envoyer.

RÈGLES ABSOLUES :
- Réponds STRICTEMENT dans la langue demandée (es/fr/en). Chaque mot doit être dans cette langue : n'utilise JAMAIS un mot d'une autre langue (ex: pas de "acheminement" ni de mot anglais dans un email espagnol).
- N'écris JAMAIS un code technique interne tel quel (FULFILLED, UNFULFILLED, PAID, IN_TRANSIT, etc.). Exprime toujours le sens en langage naturel dans la langue du client.
- N'invente JAMAIS une information : statut, date, suivi, remboursement, douane, retour à l'expéditeur. Utilise UNIQUEMENT les données fournies (section DONNÉES).
- CAS DÉLICATS (remboursement, annulation, échange, produit défectueux, colis perdu, réclamation) : reste PRUDENT. Accuse réception, montre de l'empathie, et indique que notre équipe va étudier/traiter sa demande et la recontacter rapidement. Ne promets JAMAIS un montant de remboursement précis, ni une annulation ou un échange déjà confirmé, ni un résultat garanti. Si une information est nécessaire pour avancer, demande-la gentiment.
- OBJECTIF RÉTENTION (remboursements & échanges à limiter au maximum) : ne propose JAMAIS de toi-même un remboursement ou un échange. Face à ces demandes, reste chaleureuse et rassurante, et oriente D'ABORD vers une solution qui les évite : vérifier/suivre le colis, patienter encore un peu la livraison, conseils de taille, réassurance sur le produit, proposer de l'aide. Reste toujours aimable et professionnelle (jamais de refus sec ni agressif) — le but est de rassurer et de garder la cliente satisfaite, pas de faciliter le remboursement/échange.
- Ne mentionne un événement de transport (en douane, livré, en cours de livraison, retourné) QUE s'il apparaît explicitement dans "Derniers événements transport". Sinon, reste général ("en cours d'acheminement").
- N'annonce JAMAIS une livraison qui n'est pas confirmée par les données.
- Si une donnée manque pour répondre, demande UNIQUEMENT le strict nécessaire (jamais une info déjà connue).
- Salutation : utilise le PRÉNOM du client fourni ("Nom du client"). Si aucun nom n'est fourni, utilise une salutation neutre et chaleureuse (ex: "Hola" / "Bonjour" / "Hello"). N'invente JAMAIS un prénom.
- Ton naturel, humain, rassurant si le client est inquiet. Pas de langage robotique, pas de copier-coller.
- Sois concis (4-8 lignes max). Pas de promesses que les données ne garantissent pas.
- Commence par UNE SEULE salutation avec le prénom (ex: « Hola María, »). JAMAIS deux salutations.
- Ne récite pas l'adresse complète du client, sauf si sa demande concerne justement l'adresse.
- Ne mets PAS d'objet, PAS de "Cc".
- IMPORTANT : n'écris AUCUNE formule de clôture ni signature (pas de « Atentamente », pas de « Un saludo », pas de nom d'équipe, JAMAIS de crochets comme « [Nom] » ou « [Bexanova] »). Termine simplement par ta dernière phrase utile — la signature est ajoutée automatiquement après.

═══ RÈGLES & RESSOURCES BEXANOVA (applique-les quand c'est pertinent) ═══
- 📘 eBook offert « La Verdad Sobre el Vientre Postparto » : si la cliente dit qu'elle n'a pas reçu le livre numérique / eBook, ou le réclame, DONNE-LUI directement ce lien de téléchargement dans ta réponse :
  https://cdn.shopify.com/s/files/1/1002/7922/2655/files/eBook_Exclusivo_La_Verdad_Sobre_el_Vientre_Postparto_compressed.pdf?v=1780432877`;

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
    `Prix: sous-total ${order.subtotal || '?'} ${order.currency || ''}, réductions appliquées ${order.totalDiscounts || '0'} ${order.currency || ''}, total payé ${order.total || '?'} ${order.currency || ''}`,
    `Codes promo utilisés sur la commande: ${order.discountCodes?.length ? order.discountCodes.join(', ') : 'aucun'}`,
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

// Réécrit un brouillon en appliquant la consigne (en français) que le gérant a ajoutée dessus.
const REVISE_SYSTEM = `Tu es le/la conseiller(ère) SAV de Bexanova. On te donne le contenu d'un brouillon de réponse que le gérant a annoté.
- Le texte en FRANÇAIS (souvent tout en haut, ou une note) est la CONSIGNE du gérant : ce qu'il veut ajouter, changer ou corriger.
- Le reste est le brouillon d'origine : une note interne (encadré) + la réponse au client dans SA langue.
Produis la RÉPONSE FINALE à envoyer au client :
- dans la MÊME langue que la réponse d'origine (généralement espagnol),
- en appliquant fidèlement la consigne du gérant,
- SANS la note interne, SANS la consigne du gérant, SANS aucune signature (ajoutée automatiquement ensuite),
- commence directement par la salutation, ton naturel et chaleureux.`;

export async function reviseReply(rawText) {
  return completeText(REVISE_SYSTEM, String(rawText || '').slice(0, 4000), 1200);
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

Rédige maintenant l'email de réponse (SANS signature ni formule de clôture — elle sera ajoutée automatiquement).`;
  return completeText(SYSTEM, user, 1200);
}

// Résumé FR de CE QUE DIT la réponse écrite (pour l'encadré du gérant). Appel dédié = fiable.
const SUMMARY_SYSTEM = `On te donne un message que le SAV a écrit à un client (souvent en espagnol).
Résume en UNE seule phrase, EN FRANÇAIS, CE QUE DIT ce message : l'information donnée, la solution ou l'action proposée PAR ce message.
NE résume PAS ce que le client demandait — résume la RÉPONSE. Commence par un verbe (ex: « Rassure la cliente et confirme que la commande est expédiée… », « Demande à la cliente sa nouvelle adresse… », « Envoie le lien de l'eBook… »).
Réponds uniquement par cette phrase, rien d'autre.`;

export async function summarizeReplyFr(replyText) {
  return completeText(SUMMARY_SYSTEM, String(replyText || '').slice(0, 2000), 150);
}
