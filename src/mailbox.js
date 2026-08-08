// Lecture/gestion de la boîte via IMAP (imapflow) + envoi via SMTP (nodemailer).
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { config } from './config.js';

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

// Récupère les mails non lus de l'INBOX (les plus anciens d'abord).
export async function fetchUnseen(client) {
  const lock = await client.getMailboxLock(config.imap.inbox);
  const results = [];
  try {
    const uids = await client.search({ seen: false }, { uid: true });
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

// Dépose un brouillon de réponse dans le dossier "À valider" (cas sensibles).
export async function appendDraft(client, { to, subject, body, inReplyTo, references }) {
  if (config.dryRun) return;
  const raw = buildMime({ to, subject, body, inReplyTo, references, draft: true });
  await client.append(config.folders.validate, raw, ['\\Draft']);
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

// Envoie réellement la réponse au client.
export async function sendReply({ to, subject, body, inReplyTo, references }) {
  if (config.dryRun) return { dryRun: true };
  return smtp().sendMail({
    from: `"${config.smtp.fromName}" <${config.smtp.fromAddress || config.smtp.user}>`,
    to,
    subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
    text: body,
    inReplyTo,
    references,
  });
}

// Construit un message MIME minimal pour les brouillons IMAP.
function buildMime({ to, subject, body, inReplyTo, references }) {
  const from = `"${config.smtp.fromName}" <${config.smtp.fromAddress || config.smtp.user}>`;
  const subj = subject.startsWith('Re:') ? subject : `Re: ${subject}`;
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subj}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ];
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${Array.isArray(references) ? references.join(' ') : references}`);
  return headers.join('\r\n') + '\r\n\r\n' + body;
}
