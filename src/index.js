// Point d'entrée : ouvre la boîte, traite les mails non lus, classe, ferme.
// Conçu pour être lancé par un cron (GitHub Actions) toutes les ~15 min.
import { config } from './config.js';
import { openMailbox, ensureFolders, fetchUnseen, moveToFolder } from './mailbox.js';
import { processEmail } from './process.js';

async function main() {
  const started = Date.now();
  console.log(`\n=== SAV Bexanova — run ${new Date().toISOString()} ===`);
  console.log(`Provider IA: ${config.llm.provider} | AUTO_SEND=${config.autoSend} | DRY_RUN=${config.dryRun}`);

  const client = await openMailbox();
  const stats = { total: 0, send: 0, draft: 0, skip: 0, error: 0 };
  try {
    await ensureFolders(client);
    const emails = await fetchUnseen(client);
    console.log(`${emails.length} email(s) non lu(s) à traiter.`);

    for (const email of emails) {
      stats.total++;
      try {
        const r = await processEmail(client, email);
        stats[r.action] = (stats[r.action] || 0) + 1;
      } catch (err) {
        stats.error++;
        console.error(`  ❌ erreur sur ${email.from}: ${err.message}`);
        // On classe en "Erreur" pour traitement manuel, sans bloquer le reste.
        try { await moveToFolder(client, email.uid, config.folders.error); } catch {}
      }
    }
  } finally {
    await client.logout().catch(() => {});
  }

  console.log(`--- Terminé en ${(Date.now() - started) / 1000}s :`, stats, '---');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
