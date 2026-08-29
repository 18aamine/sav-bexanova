// Abstraction du "cerveau" IA. Un seul point de bascule Claude <-> Gemini.
// Pour changer de fournisseur : mettre LLM_PROVIDER=gemini (ou claude) dans les Secrets.
import { config } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function claudeComplete({ system, user, maxTokens = 1500, json = false }) {
  const { apiKey, model } = config.llm.claude;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY manquante (LLM_PROVIDER=claude).');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: json ? `${system}\n\nRéponds UNIQUEMENT avec un objet JSON valide, sans texte autour.` : system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content?.map(c => c.text).join('') ?? '';
}

async function geminiComplete({ system, user, maxTokens = 1500, json = false }) {
  const { apiKey, model } = config.llm.gemini;
  if (!apiKey) throw new Error('GEMINI_API_KEY manquante (LLM_PROVIDER=gemini).');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0.4,
        ...(json ? { responseMimeType: 'application/json' } : {}),
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '';
}

// Modèles Groq candidats : si Groq en supprime un (erreur 404), on bascule automatiquement sur le suivant.
function groqCandidates() {
  return [...new Set([
    config.llm.groq.model,
    'llama-3.3-70b-versatile',
    'openai/gpt-oss-20b',
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'llama-3.1-8b-instant',
    'gemma2-9b-it',
  ].filter(Boolean))];
}
let workingGroqModel = null;

// Un appel à un modèle donné, avec retry sur limite de débit (429).
async function groqCall(apiKey, model, { system, user, maxTokens = 1500, json = false }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0.4,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (res.status === 429) {
      const body = await res.text();
      const m = body.match(/try again in ([\d.]+)s/i);
      const waitMs = Math.min((m ? parseFloat(m[1]) * 1000 : (attempt + 1) * 3000) + 500, 12000);
      await sleep(waitMs);
      continue;
    }
    if (res.ok) return { ok: true, data: await res.json() };
    return { ok: false, status: res.status, text: await res.text() };
  }
  return { ok: false, status: 429, text: 'limite de débit persistante' };
}

async function groqComplete(opts) {
  const { apiKey } = config.llm.groq;
  if (!apiKey) throw new Error('GROQ_API_KEY manquante (LLM_PROVIDER=groq).');
  // Le modèle qui marchait est essayé en premier, mais on garde les autres en repli.
  const candidates = workingGroqModel
    ? [...new Set([workingGroqModel, ...groqCandidates()])]
    : groqCandidates();
  let lastErr = '';
  for (const model of candidates) {
    const r = await groqCall(apiKey, model, opts);
    if (r.ok) {
      if (workingGroqModel !== model) { workingGroqModel = model; console.log(`  ℹ️ Modèle Groq actif : ${model}`); }
      return r.data.choices?.[0]?.message?.content ?? '';
    }
    // Modèle inexistant / décommissionné / sans accès → on tente le suivant.
    if (r.status === 404 || /model_not_found|does not exist|decommission|not exist/i.test(r.text || '')) {
      lastErr = `modèle ${model} indisponible`;
      continue;
    }
    throw new Error(`Groq API ${r.status}: ${r.text}`);
  }
  throw new Error(`Groq : aucun modèle disponible (${lastErr}). Vérifie les modèles sur console.groq.com/docs/models.`);
}

function complete(opts) {
  const p = config.llm.provider;
  if (p === 'gemini') return geminiComplete(opts);
  if (p === 'groq') return groqComplete(opts);
  return claudeComplete(opts);
}

export async function completeText(system, user, maxTokens = 1500) {
  return (await complete({ system, user, maxTokens, json: false })).trim();
}

export async function completeJSON(system, user, maxTokens = 1200) {
  const raw = await complete({ system, user, maxTokens, json: true });
  // Robustesse : extrait le premier bloc JSON même si le modèle ajoute du texte.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Réponse IA non-JSON: ${raw.slice(0, 300)}`);
  return JSON.parse(match[0]);
}
