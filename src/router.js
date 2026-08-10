// Politique "hybride par confiance" : décide si la réponse part en AUTO ou en BROUILLON à valider.
import { config } from './config.js';

// Cas sensibles => toujours brouillon à valider (jamais d'envoi auto).
const SENSITIVE = new Set([
  'annulation', 'remboursement', 'echange', 'produit_defectueux',
  'colis_perdu', 'livre_non_recu', 'reclamation',
  'modifier_adresse', 'mauvaise_adresse', 'produit_manquant',
]);

// Cas simples et informatifs => envoi auto possible (si on a les données).
const SAFE = new Set([
  'ou_est_ma_commande', 'colis_en_retard', 'suivi', 'rien_recu',
  'taille', 'demande_avant_achat', 'info_produit', 'guide_non_recu', 'autre',
]);

// Décide l'action finale.
// order: objet Shopify (ou null). intent: catégorie.
// Retourne { action: 'send'|'draft'|'skip', reason }
export function route({ intent, order }) {
  if (intent === 'ignorer') return { action: 'skip', reason: 'non-SAV' };

  // Interrupteur global : si AUTO_SEND=false, tout passe en validation.
  if (!config.autoSend) return { action: 'draft', reason: 'AUTO_SEND désactivé' };

  // Mode 100% auto : tout est envoyé automatiquement (la rédaction reste prudente sur les cas sensibles).
  if (config.autoSendSensitive) {
    return { action: 'send', reason: SENSITIVE.has(intent) ? 'cas sensible (auto, ton prudent)' : 'cas simple' };
  }

  if (SENSITIVE.has(intent)) return { action: 'draft', reason: 'cas sensible' };

  // Garde-fou : "rien reçu" alors que le tracking indique livré => litige, à valider.
  if (intent === 'rien_recu' && isDelivered(order)) {
    return { action: 'draft', reason: 'colis marqué livré mais client dit non reçu' };
  }

  if (SAFE.has(intent)) return { action: 'send', reason: 'cas simple' };

  return { action: 'draft', reason: 'par défaut, prudence' };
}

function isDelivered(order) {
  if (!order) return false;
  const s = (order.fulfillmentStatus || '').toUpperCase();
  if (s.includes('DELIVERED')) return true;
  return (order.fulfillments || []).some(f =>
    (f.status || '').toUpperCase().includes('DELIVERED') ||
    (f.events || []).some(e => (e.status || '').toUpperCase().includes('DELIVERED')));
}
