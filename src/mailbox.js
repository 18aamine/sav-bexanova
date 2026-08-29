// Lecture/gestion de la boîte via IMAP (imapflow) + envoi via SMTP (nodemailer).
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { readFileSync } from 'node:fs';
import { config } from './config.js';

// Logo de marque (inline, via CID). Facultatif : si le fichier manque, on affiche un texte.
let LOGO = null;
try { LOGO = readFileSync(new URL('../assets/logo.png', import.meta.url)); } catch { /* pas de logo */ }

export async function openMailbox() {
  const client = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: { user: config.imap.user, pass: config.imap.pass },
    logger: false,
  });
  await client.connect();
  return client;
}

// Garantit l'existence des dossiers de classement.
export async function ensureFolders(client) {
  const existing = new Set((await client.list()).map(m => m.path));
  for (const path of Object.values(config.folders)) {
    if (!existing.has(path)) {
      try { await client.mailboxCreate(path); } catch { /* déjà créé / course */ }
    }
  }
}

// Récupère les mails d'un dossier (non lus par défaut ; tous si onlyUnseen=false).
export async function fetchUnseenFrom(client, folder, { onlyUnseen = true } = {}) {
  const lock = await client.getMailboxLock(folder);
  const results = [];
  try {
    const uids = await client.search(onlyUnseen ? { seen: false } : { all: true }, { uid: true });
    const slice = uids.slice(0, config.maxEmailsPerRun);
    for (const uid of slice) {
      const msg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
      if (!msg || !msg.source) continue;
      const parsed = await simpleParser(msg.source);
      results.push({
        uid,
        messageId: parsed.messageId,
        from: parsed.from?.value?.[0]?.address?.toLowerCase() || '',
        fromName: parsed.from?.value?.[0]?.name || '',
        replyTo: parsed.replyTo?.value?.[0]?.address?.toLowerCase() || '',
        to: parsed.to?.value?.[0]?.address?.toLowerCase() || '',
        subject: parsed.subject || '',
        date: parsed.date,
        text: (parsed.text || '').trim(),
        html: parsed.html || '',
        references: parsed.references,
        inReplyTo: parsed.inReplyTo,
      });
    }
  } finally {
    lock.release();
  }
  return results;
}

// Mails non lus de l'INBOX.
export function fetchUnseen(client) {
  return fetchUnseenFrom(client, config.imap.inbox);
}

// Déplace un message depuis un dossier source vers un dossier cible.
export async function moveFromFolder(client, sourceFolder, uid, targetFolder) {
  if (config.dryRun) return;
  const lock = await client.getMailboxLock(sourceFolder);
  try {
    await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
    await client.messageMove(uid, targetFolder, { uid: true });
  } finally {
    lock.release();
  }
}

// Marque un mail comme lu tout de suite (anti-doublon : il ne sera jamais retraité même si le run plante).
export async function markSeen(client, uid) {
  if (config.dryRun) return;
  const lock = await client.getMailboxLock(config.imap.inbox);
  try { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); }
  finally { lock.release(); }
}

// Déplace un message (par UID) vers un dossier de classement, et le marque lu.
export async function moveToFolder(client, uid, folder) {
  if (config.dryRun) return;
  const lock = await client.getMailboxLock(config.imap.inbox);
  try {
    await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
    await client.messageMove(uid, folder, { uid: true });
  } finally {
    lock.release();
  }
}

// ---------- Mise en forme HTML (template de marque) ----------
const TRACK_LABEL = { es: 'Seguir mi pedido', fr: 'Suivre ma commande', en: 'Track my order' };
const SIGN_OFF = {
  es: { close: 'Atentamente,', team: 'El equipo Bexanova', role: 'Atención al cliente' },
  fr: { close: 'Cordialement,', team: 'L\'équipe Bexanova', role: 'Service client' },
  en: { close: 'Best regards,', team: 'The Bexanova team', role: 'Customer care' },
};
const FOOTER_NOTE = {
  es: 'Este mensaje es una respuesta a tu solicitud de atención al cliente.',
  fr: 'Ce message est une réponse à votre demande au service client.',
  en: 'This message is a reply to your customer service request.',
};

function escapeHtml(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Transforme le texte de l'IA en paragraphes HTML (met les n° de commande #1234 en rose).
function bodyToHtml(text) {
  return String(text || '').split(/\n\s*\n/).map(block => {
    const html = escapeHtml(block.trim())
      .replace(/\n/g, '<br>')
      .replace(/(#\d{3,})/g, '<strong style="color:#E5398B;">$1</strong>');
    return `<p style="margin:0 0 16px;">${html}</p>`;
  }).join('');
}

const PINK = '#E5398B';

// Encadré interne en français pour le gérant (uniquement dans les brouillons à valider).
function ownerNoteHtml(note) {
  if (!note) return '';
  const lines = escapeHtml(note).replace(/\n/g, '<br>');
  return `<tr><td style="padding:16px 40px 0 40px;">
    <div style="background:#fff8e1;border:1px solid #ffe08a;border-radius:10px;padding:14px 16px;font-size:13.5px;color:#5a4b17;line-height:1.6;">
      <div style="font-weight:700;color:#b9860b;margin-bottom:6px;">⚠️ NOTE POUR TOI — à SUPPRIMER avant d'envoyer</div>
      ${lines}
    </div>
  </td></tr>`;
}

function buildHtml({ body, trackingUrl, language, ownerNote }) {
  const lang = ['es', 'fr', 'en'].includes(language) ? language : 'es';
  const header = LOGO
    ? `<img src="cid:logobexanova" alt="Bexanova" width="176" style="display:block;width:176px;max-width:60%;height:auto;">`
    : `<div style="font-family:Georgia,'Times New Roman',serif;font-size:34px;color:${PINK};letter-spacing:.5px;">bexanova</div>`;
  const trackBtn = trackingUrl
    ? `<a href="${escapeHtml(trackingUrl)}" style="display:inline-block;margin-bottom:10px;color:${PINK};text-decoration:none;font-size:13px;font-weight:700;">📦 ${TRACK_LABEL[lang]} →</a><br>`
    : '';
  const s = SIGN_OFF[lang];
  return `<div style="margin:0;padding:24px 12px;background:#f4f4f6;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(17,17,26,0.06);">
    <tr><td style="height:5px;background:${PINK};"></td></tr>
    ${ownerNoteHtml(ownerNote)}
    <tr><td align="center" style="padding:32px 40px 8px 40px;">${header}</td></tr>
    <tr><td style="padding:0 40px;"><div style="height:1px;background:#f0f0f2;margin:16px 0 4px;"></div></td></tr>
    <tr><td style="padding:20px 40px 6px 40px;color:#2b2b31;font-size:15.5px;line-height:1.65;">${bodyToHtml(body)}</td></tr>
    <tr><td style="padding:6px 40px 26px 40px;">
      <div style="color:#2b2b31;font-size:15px;margin-bottom:10px;">${s.close}</div>
      <div style="border-left:3px solid ${PINK};padding-left:14px;">
        <div style="font-size:15px;font-weight:700;color:${PINK};">${s.team}</div>
        <div style="font-size:13px;color:#8a8a93;margin-top:2px;">${s.role} · soporte@bexanova.com</div>
      </div>
    </td></tr>
    <tr><td style="background:#faf7f9;padding:20px 40px;text-align:center;">
      ${trackBtn}
      <a href="https://bexanova.com" style="color:${PINK};text-decoration:none;font-size:13px;font-weight:600;letter-spacing:.3px;">bexanova.com</a>
      <div style="font-size:11.5px;color:#adadb5;margin-top:8px;line-height:1.5;">${FOOTER_NOTE[lang]}<br>© 2026 Bexanova · soporte@bexanova.com</div>
    </td></tr>
  </table>
</div>`;
}

// Options communes (texte + HTML + logo inline) pour l'envoi ET le brouillon.
function buildMessage({ to, subject, body, inReplyTo, references, trackingUrl, language, ownerNote }) {
  const lang = ['es', 'fr', 'en'].includes(language) ? language : 'es';
  const s = SIGN_OFF[lang];
  const noteTxt = ownerNote ? `⚠️ NOTE POUR TOI — à SUPPRIMER avant d'envoyer\n${ownerNote}\n----------------------------------------\n\n` : '';
  const opts = {
    from: `"${config.smtp.fromName}" <${config.smtp.fromAddress || config.smtp.user}>`,
    to,
    subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
    text: `${noteTxt}${body}\n\n${s.close}\n${s.team}`, // repli texte brut, avec signature
    html: buildHtml({ body, trackingUrl, language, ownerNote }),
    inReplyTo,
    references,
  };
  if (LOGO) opts.attachments = [{ filename: 'logo.png', content: LOGO, cid: 'logobexanova' }];
  return opts;
}

let transporter;
function smtp() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
    });
  }
  return transporter;
}

// Sauvegarde une copie du message envoyé dans le dossier "Envoyés" (SMTP ne le fait pas).
async function saveToSent(client, rawMessage) {
  const candidates = [config.sentFolder, 'Sent', 'Envoyés', 'INBOX.Sent', 'Sent Items'];
  for (const folder of candidates) {
    try {
      await client.append(folder, rawMessage, ['\\Seen']);
      return true;
    } catch { /* essaie le suivant */ }
  }
  return false;
}

// Envoie réellement la réponse au client + garde une copie dans "Envoyés".
export async function sendReply(client, msg) {
  if (config.dryRun) return { dryRun: true };
  const options = buildMessage(msg);
  const info = await smtp().sendMail(options);
  // Preuve d'envoi : ce que le serveur SMTP a réellement répondu.
  console.log(`  ✉️ SMTP → to=${msg.to} | accepted=${JSON.stringify(info.accepted)} | rejected=${JSON.stringify(info.rejected)} | response="${info.response}"`);
  try {
    const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'crlf' });
    const built = await composer.sendMail(options);
    const ok = await saveToSent(client, built.message);
    if (!ok) console.warn('  (copie dans "Envoyés" impossible : dossier introuvable)');
  } catch (e) { console.warn(`  (copie "Envoyés" échouée : ${e.message})`); }
  return info;
}

// Dépose un brouillon (HTML + logo) dans le dossier "À valider".
export async function appendDraft(client, msg) {
  if (config.dryRun) return;
  const drafter = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'crlf' });
  const info = await drafter.sendMail(buildMessage(msg));
  await client.append(config.folders.validate, info.message, ['\\Draft']);
}
