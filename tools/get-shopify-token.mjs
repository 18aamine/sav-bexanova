// Outil local et sécurisé pour récupérer le jeton d'accès Admin API (OAuth).
// Tout se passe en local (localhost). Ni le secret ni le jeton ne quittent ta machine.
//
// Usage : node tools/get-shopify-token.mjs
// Puis ouvre http://localhost:3456 dans ton navigateur.
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = 3456;
const SHOP = process.env.SHOP || 'psjh08-zr.myshopify.com';
const CLIENT_ID = process.env.CLIENT_ID || 'dfa701cbbb8f5799435f65d663bc8c2f';
const SCOPES = 'read_orders,read_customers,read_fulfillments,read_products';
const REDIRECT = `http://localhost:${PORT}/callback`;

const store = { secret: null, state: null };

const page = (title, body) => `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
body{font-family:-apple-system,system-ui,sans-serif;max-width:620px;margin:40px auto;padding:0 20px;line-height:1.5;color:#111}
h1{font-size:22px} .card{background:#f6f6f7;border:1px solid #e1e1e1;border-radius:12px;padding:20px;margin:16px 0}
input{width:100%;padding:12px;font-size:15px;border:1px solid #bbb;border-radius:8px;box-sizing:border-box}
button{background:#111;color:#fff;border:0;padding:12px 20px;font-size:15px;border-radius:8px;cursor:pointer;margin-top:12px}
code{background:#eee;padding:2px 6px;border-radius:4px;word-break:break-all}
.token{font-size:15px;background:#eafaef;border:1px solid #9ad7ad;padding:16px;border-radius:8px;word-break:break-all;user-select:all}
.muted{color:#666;font-size:14px}</style></head><body>${body}</body></html>`;

const server = http.createServer(async (rq, rs) => {
  const url = new URL(rq.url, `http://localhost:${PORT}`);

  if (url.pathname === '/' && rq.method === 'GET') {
    rs.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return rs.end(page('Récupération du jeton Shopify', `
      <h1>🔑 Récupérer le jeton Shopify</h1>
      <p class="muted">Boutique : <code>${SHOP}</code> — Application : SAV Agent</p>
      <div class="card">
        <form method="POST" action="/start">
          <label><b>Colle ici le "Secret" de ton app Shopify</b><br>
          <span class="muted">(Dev Dashboard → Paramètres → Identifiants → clique sur l'œil 👁 à côté de "Secret" → copie)</span></label>
          <input type="password" name="secret" placeholder="Secret de l'application" required autofocus>
          <button type="submit">Continuer →</button>
        </form>
      </div>
      <p class="muted">Rien n'est envoyé sur Internet : tout reste sur ton Mac. Après avoir cliqué, tu autoriseras l'app sur Shopify, puis le jeton s'affichera ici.</p>`));
  }

  if (url.pathname === '/start' && rq.method === 'POST') {
    let body = '';
    rq.on('data', c => (body += c));
    return rq.on('end', () => {
      const secret = new URLSearchParams(body).get('secret');
      if (!secret) { rs.writeHead(400); return rs.end('Secret manquant'); }
      store.secret = secret.trim();
      store.state = crypto.randomBytes(16).toString('hex');
      const auth = `https://${SHOP}/admin/oauth/authorize?client_id=${CLIENT_ID}` +
        `&scope=${encodeURIComponent(SCOPES)}&redirect_uri=${encodeURIComponent(REDIRECT)}` +
        `&state=${store.state}`;
      rs.writeHead(302, { location: auth });
      rs.end();
    });
  }

  if (url.pathname === '/callback' && rq.method === 'GET') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || state !== store.state) {
      rs.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      return rs.end(page('Erreur', '<h1>❌ Erreur</h1><p>Code ou state invalide. Relance l\'outil.</p>'));
    }
    try {
      const resp = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: CLIENT_ID, client_secret: store.secret, code }),
      });
      const data = await resp.json();
      if (!data.access_token) throw new Error(JSON.stringify(data));
      rs.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      rs.end(page('Jeton récupéré', `
        <h1>✅ Jeton récupéré !</h1>
        <p>Copie ce jeton et colle-le dans le <b>Secret GitHub</b> nommé <code>SHOPIFY_ADMIN_TOKEN</code> :</p>
        <div class="token">${data.access_token}</div>
        <p class="muted">Tu peux maintenant fermer cette page. Le terminal peut être arrêté (Ctrl+C).</p>`));
      console.log('\n✅ Jeton récupéré et affiché dans ton navigateur (non affiché ici). Copie-le dans GitHub.');
    } catch (e) {
      rs.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
      rs.end(page('Erreur', `<h1>❌ Échec de l'échange</h1><p>Vérifie le secret. Détail : <code>${String(e.message).slice(0,300)}</code></p>`));
    }
  }
});

server.listen(PORT, () => {
  console.log(`\n🔑 Outil prêt. Ouvre : http://localhost:${PORT}\n(Boutique ${SHOP})`);
});
