// Diagnostic de configuration : teste chaque brique et dit laquelle échoue.
// Lancement : `npm run check`  (ou via GitHub Actions : bouton "Run workflow" > check)
import { config } from './config.js';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { completeText } from './llm.js';

const ok = (m) => console.log(`  ✅ ${m}`);
const ko = (m) => console.log(`  ❌ ${m}`);

async function checkImap() {
  const c = new ImapFlow({
    host: config.imap.host, port: config.imap.port, secure: config.imap.secure,
    auth: { user: config.imap.user, pass: config.imap.pass }, logger: false,
  });
  await c.connect();
  const lock = await c.getMailboxLock(config.imap.inbox);
  try {
    const unseen = await c.search({ seen: false }, { uid: true });
    ok(`IMAP connecté (${config.imap.host}) — ${unseen.length} mail(s) non lu(s)`);
  } finally { lock.release(); await c.logout().catch(() => {}); }
}

async function checkSmtp() {
  const t = nodemailer.createTransport({
    host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
  await t.verify();
  ok(`SMTP prêt (${config.smtp.host})`);
}

async function checkShopify() {
  const { shop, token, apiVersion } = config.shopify;
  const res = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query: '{ shop { name currencyCode } }' }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — jeton ou scopes invalides ?`);
  const data = await res.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  ok(`Shopify OK — boutique "${data.data.shop.name}" (${data.data.shop.currencyCode})`);
}

async function checkLlm() {
  const r = await completeText('Réponds exactement le mot: PONG.', 'ping', 20);
  ok(`IA (${config.llm.provider}) répond : "${r.slice(0, 20)}"`);
}

const checks = [
  ['IMAP', checkImap], ['SMTP', checkSmtp], ['Shopify', checkShopify], ['IA', checkLlm],
];

console.log('=== Diagnostic SAV Bexanova ===');
let failures = 0;
for (const [name, fn] of checks) {
  try {
    await fn();
  } catch (e) {
    const detail = e.message || e.responseText || e.serverResponseCode || e.code || JSON.stringify(e);
    ko(`${name} : ${detail}`);
    failures++;
  }
}
console.log(failures === 0 ? '\n🎉 Tout est bon, prêt à tourner.' : `\n⚠️ ${failures} problème(s) à corriger.`);
process.exit(failures === 0 ? 0 : 1);
