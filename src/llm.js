// Abstraction du "cerveau" IA. Un seul point de bascule Claude <-> Gemini.
// Pour changer de fournisseur : mettre LLM_PROVIDER=gemini (ou claude) dans les Secrets.
import { config } from './config.js';

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

function complete(opts) {
  return config.llm.provider === 'gemini' ? geminiComplete(opts) : claudeComplete(opts);
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
