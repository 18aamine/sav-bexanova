// Compréhension du mail : intention, langue, et identifiants (email/n° commande/nom).
import { completeJSON } from './llm.js';

// Catégories reconnues (voir cahier des charges).
export const INTENTS = [
  'ou_est_ma_commande', 'rien_recu', 'colis_en_retard', 'modifier_adresse',
  'mauvaise_adresse', 'annulation', 'remboursement', 'echange', 'taille',
  'produit_manquant', 'produit_defectueux', 'colis_perdu', 'livre_non_recu',
  'suivi', 'demande_avant_achat', 'info_produit', 'reclamation', 'autre', 'ignorer',
];

const SYSTEM = `Tu es un module d'analyse pour le SAV d'une boutique e-commerce (Bexanova, faja/shapewear, marché ES/FR/EN).
On te donne un email client. Tu renvoies un JSON strict décrivant la demande.
Tu n'inventes RIEN : si une info n'est pas dans l'email, mets null.

Champs à renvoyer :
- "language": code ISO ("es", "fr", "en" — la langue dans laquelle répondre au client).
- "intent": une valeur EXACTE parmi: ${INTENTS.join(', ')}.
  * "ignorer" = ce n'est pas une demande client (spam, pub, fournisseur, notification automatique).
- "order_number": le numéro de commande mentionné (chiffres uniquement) ou null.
- "customer_name": nom complet du client s'il est donné dans le corps/signature, sinon null.
- "email_in_body": une adresse email de commande citée dans le texte (différente de l'expéditeur) ou null.
- "summary": résumé en 1 phrase (dans la langue du client) de ce que veut le client.
- "sentiment": "calme", "inquiet" ou "mecontent".`;

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
    sentiment: r.sentiment || 'calme',
  };
}
