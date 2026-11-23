// Retrieval helpers for the Health Assistant.
// - Query rewriting: Claude turns a Bangla / English / Banglish message into a short English
//   symptom query, so the first-aid knowledge base can be searched even when the patient's
//   wording matches none of its keywords.
// - Corrective retrieval (CRAG-style): the first retrieval is checked; if it found nothing
//   relevant, the query is rewritten and retrieval runs again. If that also fails, nothing
//   is added to the context, so Claude is never fed an unrelated entry.
const config = require('../config');

const BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';

/** One small Claude call. Returns the text, or null when there is no key or the call fails. */
async function ask({ system, user, maxTokens = 120, timeoutMs = 10_000 }) {
  if (!config.anthropicKey) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: config.anthropicModel, max_tokens: maxTokens, system, messages: [{ role: 'user', content: String(user).slice(0, 1000) }] }),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    return (data.content || []).map((p) => p.text || '').join('').trim() || null;
  } catch (e) {
    console.error('Query rewrite failed:', e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const REWRITE_SYSTEM = `Rewrite the patient's message (Bangla, English or Banglish) as a short English search query
of plain symptom words for a first-aid knowledge base, for example "headache, fever" or "burn on hand".
Use at most 8 words, comma-separated. Output only the query, nothing else.`;

/** Query rewriting: patient wording -> short English symptom query (null if unavailable). */
async function rewriteQuery(message) {
  const q = await ask({ system: REWRITE_SYSTEM, user: message, maxTokens: 40 });
  return q ? q.replace(/["\n]/g, ' ').slice(0, 120).trim() : null;
}

/**
 * Corrective retrieval: run `retrieve` on the message; when `isRelevant` rejects the result,
 * rewrite the query and retrieve again. Returns { result, query } where query is the
 * rewritten text if it was used.
 */
async function correctiveRetrieve(message, retrieve, isRelevant = Boolean) {
  const first = retrieve(message);
  if (isRelevant(first)) return { result: first, query: null };
  const rewritten = await rewriteQuery(message);
  if (!rewritten) return { result: null, query: null };
  const second = retrieve(rewritten);
  return isRelevant(second) ? { result: second, query: rewritten } : { result: null, query: rewritten };
}

module.exports = { ask, rewriteQuery, correctiveRetrieve };
