// Compréhension du mail : intention, langue, et identifiants (email/n° commande/nom).
import { completeJSON } from './llm.js';

// Catégories reconnues (voir cahier des charges).
export const INTENTS = [
  'ou_est_ma_commande', 'rien_recu', 'colis_en_retard', 'modifier_adresse',
  'mauvaise_adresse', 'annulation', 'remboursement', 'echange', 'taille',
  'produit_manquant', 'produit_defectueux', 'colis_perdu', 'livre_non_recu',
  'suivi', 'demande_avant_achat', 'info_produit', 'reclamation', 'guide_non_recu', 'question_prix', 'autre', 'ignorer',
];

const SYSTEM = `Tu es un module d'analyse pour le SAV d'une boutique e-commerce (Bexanova, faja/shapewear, marché ES/FR/EN).
On te donne un email client. Tu renvoies un JSON strict décrivant la demande.
Tu n'inventes RIEN : si une info n'est pas dans l'email, mets null.

TRÈS IMPORTANT : classe selon la DEMANDE RÉELLE exprimée par la cliente dans son DERNIER message (le texte tout en haut), PAS selon l'objet du mail — l'objet est souvent trompeur dans un fil de discussion (ex: objet « Reembolso » alors que la cliente ne fait que confirmer son adresse). Ignore les citations/historique en dessous (lignes commençant par « > » ou « ... a écrit / escribió »).

Champs à renvoyer :
- "language": code ISO ("es", "fr", "en" — la langue dans laquelle répondre au client).
- "intent": une valeur EXACTE parmi: ${INTENTS.join(', ')}.
  * "remboursement" = TOUTE demande liée à un remboursement, un RETOUR de commande (devolución, devolver, quiero devolver, return) ou à récupérer de l'argent — MÊME si la cliente se plaint ou relance à ce sujet. Dès qu'il est question d'argent/retour/reembolso, choisis "remboursement" (PAS "reclamation").
  * "guide_non_recu" = la cliente dit qu'elle n'a pas reçu le livre numérique / eBook / la guía / le guide (offert avec sa commande), ou le réclame. (Prioritaire sur "produit_manquant" quand il s'agit du guide/eBook numérique.)
  * "question_prix" = question sur le prix, une réduction/code promo (ex: « pourquoi la réduction n'a pas été appliquée ? »), le montant facturé, la facture. (Le robot peut répondre en vérifiant la commande — ce n'est PAS une réclamation.)
  * "reclamation" = une plainte générale SANS demande d'argent/retour (mécontentement sur le service, l'attente…).
  * "ignorer" = UNIQUEMENT du spam pur, de la pub commerciale, ou une notification 100% automatique d'un système SANS aucun message d'un vrai humain. ⚠️ Un message issu du FORMULAIRE DE CONTACT SHOPIFY (texte du type « Recibiste un mensaje nuevo desde el formulario de contacto » / « You received a new message from your store's contact form ») contient une VRAIE demande cliente (souvent après « Mensaje: » / « Message: ») → tu NE l'ignores JAMAIS, tu classes selon cette demande. En cas de DOUTE, ne mets PAS "ignorer" : choisis "autre".
- "order_number": le numéro de commande mentionné (chiffres uniquement) ou null.
- "customer_name": nom complet du client s'il est donné dans le corps/signature, sinon null.
- "email_in_body": une adresse email de commande citée dans le texte (différente de l'expéditeur) ou null.
- "summary": résumé en 1 phrase (dans la langue du client) de ce que veut le client.
- "summary_fr": le même résumé, mais EN FRANÇAIS (pour le gérant qui ne lit pas l'espagnol).
- "sentiment": "calme", "inquiet" ou "mecontent".

RÈGLE D'OR SUR "ignorer" : par défaut, NE PAS ignorer. Un vrai message de client — même très court (« hola », « gracias », « vale », « sí »), même un simple remerciement, même une question banale, même s'il vient d'un formulaire de contact Shopify — N'EST JAMAIS "ignorer". Réserve "ignorer" au spam/pub évident et aux notifications purement automatiques (livraison, facturation Shopify sans texte humain). Au moindre doute → "autre" (le robot répondra), surtout PAS "ignorer".`;

export async function analyzeEmail({ from, fromName, subject, text }) {
  const user = `De: ${fromName} <${from}>
Sujet: ${subject}

${text.slice(0, 1200)}`;
  const r = await completeJSON(SYSTEM, user);
  // Normalisation défensive
  if (!INTENTS.includes(r.intent)) r.intent = 'autre';
  if (!['es', 'fr', 'en'].includes(r.language)) r.language = 'es';
  return {
    language: r.language,
    intent: r.intent,
    orderNumber: r.order_number || null,
    customerName: r.customer_name || null,
    emailInBody: (r.email_in_body || '').toLowerCase() || null,
    summary: r.summary || '',
    summaryFr: r.summary_fr || r.summary || '',
    sentiment: r.sentiment || 'calme',
  };
}
