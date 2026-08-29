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

// Cerebras (gratuit, généreux, OpenAI-compatible). Bascule auto entre modèles si l'un n'existe pas / accès requis.
function cerebrasCandidates() {
  return [...new Set([
    config.llm.cerebras.model,
    'llama3.1-8b',
    'llama-3.3-70b',
    'llama-4-scout-17b-16e-instruct',
    'gpt-oss-120b',
    'qwen-3-32b',
  ].filter(Boolean))];
}
let workingCerebrasModel = null;

async function cerebrasCall(apiKey, model, { system, user, maxTokens = 1500, json = false }) {
  const sys = json ? `${system}\n\nRéponds UNIQUEMENT avec un objet JSON valide, sans texte autour.` : system;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0.4,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
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

async function cerebrasComplete(opts) {
  const { apiKey } = config.llm.cerebras;
  if (!apiKey) throw new Error('CEREBRAS_API_KEY manquante.');
  const candidates = workingCerebrasModel
    ? [...new Set([workingCerebrasModel, ...cerebrasCandidates()])]
    : cerebrasCandidates();
  let lastErr = '';
  for (const model of candidates) {
    const r = await cerebrasCall(apiKey, model, opts);
    if (r.ok) {
      if (workingCerebrasModel !== model) { workingCerebrasModel = model; console.log(`  ℹ️ Modèle Cerebras actif : ${model}`); }
      return r.data.choices?.[0]?.message?.content ?? '';
    }
    if (r.status === 404 || /does not exist|not exist|do not have access|not found/i.test(r.text || '')) {
      lastErr = `modèle ${model} indisponible`;
      continue;
    }
    throw new Error(`Cerebras API ${r.status}: ${r.text}`);
  }
  throw new Error(`Cerebras : aucun modèle disponible (${lastErr})`);
}

// OpenRouter (gratuit via modèles « :free », OpenAI-compatible). Bascule auto entre modèles gratuits.
// La liste des modèles gratuits change souvent → on la récupère EN DIRECT depuis OpenRouter (auto-adaptatif).
let openrouterFreeCache = null;
async function fetchOpenrouterFree() {
  if (openrouterFreeCache) return openrouterFreeCache;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models');
    const data = await res.json();
    // Exclut les modèles non conversationnels ou trop spécialisés (audio, image, finance, sécurité…).
    const exclude = /lyria|content-safety|omni|embed|audio|clip|note-preview|guard|image|vision|tts|whisper|rerank|-fin(:|$)|coder|code-|math/i;
    // Ordre de préférence : modèles généralistes solides d'abord.
    const PRIORITY = ['gemma-4', 'glm-5', 'glm', 'minimax-m3', 'minimax', 'qwen', 'llama-4', 'llama-3.3', 'llama', 'mistral', 'deepseek', 'nemotron-super', 'nemotron-ultra', 'gemma'];
    const rank = (id) => { const i = PRIORITY.findIndex(p => id.includes(p)); return i < 0 ? 999 : i; };
    openrouterFreeCache = (data.data || [])
      .filter(m => String(m.pricing?.prompt) === '0' && !exclude.test(m.id || ''))
      .map(m => m.id)
      .sort((a, b) => rank(a) - rank(b));
  } catch { openrouterFreeCache = []; }
  return openrouterFreeCache;
}
async function openrouterCandidates() {
  const live = await fetchOpenrouterFree();
  return [...new Set([config.llm.openrouter.model, ...live].filter(Boolean))];
}
let workingOpenrouterModel = null;

async function openrouterCall(apiKey, model, { system, user, maxTokens = 1500, json = false }) {
  const sys = json ? `${system}\n\nRéponds UNIQUEMENT avec un objet JSON valide, sans texte autour.` : system;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'X-Title': 'Bexanova SAV',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0.4,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
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

async function openrouterComplete(opts) {
  const { apiKey } = config.llm.openrouter;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY manquante.');
  const live = await openrouterCandidates();
  const candidates = workingOpenrouterModel
    ? [...new Set([workingOpenrouterModel, ...live])]
    : live;
  let lastErr = '';
  for (const model of candidates) {
    const r = await openrouterCall(apiKey, model, opts);
    if (r.ok) {
      if (workingOpenrouterModel !== model) { workingOpenrouterModel = model; console.log(`  ℹ️ Modèle OpenRouter actif : ${model}`); }
      const content = r.data.choices?.[0]?.message?.content;
      if (content) return content;
      lastErr = 'réponse vide'; continue; // modèle gratuit parfois indispo → suivant
    }
    if (r.status === 404 || r.status === 400 || /not exist|not found|no endpoints|not a valid model/i.test(r.text || '')) {
      lastErr = `modèle ${model} indisponible`;
      continue;
    }
    throw new Error(`OpenRouter API ${r.status}: ${r.text}`);
  }
  throw new Error(`OpenRouter : aucun modèle gratuit disponible (${lastErr})`);
}

const PROVIDERS = { openrouter: openrouterComplete, cerebras: cerebrasComplete, groq: groqComplete, gemini: geminiComplete, claude: claudeComplete };
function providerHasKey(name) { return !!(config.llm[name] && config.llm[name].apiKey); }

// Essaie chaque IA de la chaîne dans l'ordre ; bascule sur la suivante si l'une est à court/indispo.
async function complete(opts) {
  const chain = config.llm.chain.filter(n => PROVIDERS[n] && providerHasKey(n));
  if (chain.length === 0) throw new Error('Aucune clé IA configurée (CEREBRAS_API_KEY / GROQ_API_KEY / ANTHROPIC_API_KEY).');
  let lastErr;
  for (const name of chain) {
    try {
      return await PROVIDERS[name](opts);
    } catch (e) {
      lastErr = e;
      console.warn(`  ⚠️ IA « ${name} » indisponible → on essaie la suivante (${String(e.message || '').slice(0, 90)})`);
    }
  }
  throw new Error(`Toutes les IA indisponibles — ${lastErr?.message || ''}`);
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
