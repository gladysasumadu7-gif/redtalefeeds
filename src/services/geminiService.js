/**
 * geminiService.js
 *
 * Drives the AI shopping chat. Given the conversation, it:
 *   1. Decides whether the user is asking to find/compare a product, and if
 *      so extracts a clean search query.
 *   2. If yes, calls priceService.searchOffers() to get real/mock offers.
 *   3. Asks Gemini to write a short, natural reply presenting those offers
 *      (or just replies conversationally if no product search is needed).
 *
 * Demo mode vs. production mode:
 *   - If GEMINI_API_KEY is NOT set, this runs on a keyword heuristic with no
 *     external call, so the endpoint always works for a demo with zero keys.
 *   - If GEMINI_API_KEY IS set, every Gemini failure (bad model, rate limit,
 *     network error, malformed response) is thrown, not swallowed. We do
 *     NOT fall back to the heuristic in this case — a configured backend
 *     silently substituting fake heuristic replies for a real failure is
 *     worse than a visible error, since the caller (the Expo app's
 *     apiRequest/ApiError) is already built to surface a failed request
 *     properly. Whatever calls handleChatMessage() in server.js should let
 *     that error turn into a non-2xx response (e.g. 502) rather than catch
 *     it and return heuristic content as if it succeeded.
 *
 * IMPORTANT: this calls the Gemini REST API directly with the
 * `X-goog-api-key` header, instead of using the `@google/generative-ai` SDK.
 * The SDK authenticates via a `?key=` query param internally, which this
 * project's API key rejects with a 401 ACCESS_TOKEN_TYPE_UNSUPPORTED error.
 * The header-based auth below is confirmed working for this key. If you
 * ever swap API keys and see 401s return, check this first before assuming
 * the model name changed.
 *
 * Model resolution: there is no static/hardcoded model name and the
 * GEMINI_MODEL env var is intentionally ignored. We fetch the live /models
 * list once per process, filter it down to plausible chat candidates, and
 * try them in order lazily — i.e. only when an actual chat request comes
 * in, not by pre-emptively test-calling every candidate at startup (that
 * burns real quota and can itself trigger rate limits). Whichever candidate
 * first succeeds becomes the "working" model for the rest of the process;
 * if it later gets deprecated out from under us, we advance to the next
 * candidate automatically. A model-list refresh requires a process restart.
 */

const { searchOffers } = require('./priceService');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Model names that technically support generateContent but are never right
// for a text chat/classification use case (text-to-speech, embeddings,
// etc.) — filtered out so we don't waste an attempt on them.
const NON_CHAT_MODEL_PATTERN = /tts|embedding|aqa|image-generation/i;

let modelCandidates = null; // string[], resolved once per process
let workingModelIndex = 0; // index into modelCandidates of the last-known-good model

async function fetchAvailableModels() {
  const key = process.env.GEMINI_API_KEY;
  const response = await fetch(`${GEMINI_API_BASE}/models`, {
    headers: { 'X-goog-api-key': key },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Model list request failed: ${response.status} ${text}`);
  }
  const data = await response.json();
  return (data.models || []).map((m) => ({
    name: m.name.replace('models/', ''),
    supportedGenerationMethods: m.supportedGenerationMethods || [],
  }));
}

async function getModelCandidates() {
  if (modelCandidates) return modelCandidates;

  const available = await fetchAvailableModels();
  modelCandidates = available
    .filter((m) => m.supportedGenerationMethods.includes('generateContent'))
    .filter((m) => !NON_CHAT_MODEL_PATTERN.test(m.name))
    .map((m) => m.name);

  if (modelCandidates.length === 0) {
    throw new Error(
      `No available Gemini model supports generateContent for chat. Models returned: ${available.map((m) => m.name).join(', ') || '(none)'}`
    );
  }
  return modelCandidates;
}

// Matches the class of error that means "this specific model is unusable"
// (removed, deprecated, not found, doesn't support this method) as opposed
// to a transient/unrelated failure (rate limit, network error, bad prompt).
// Only the former should make us advance to the next candidate — the latter
// should bubble up as a real error immediately rather than triggering a
// pointless sweep through every remaining model.
function isModelUnusableError(err) {
  const msg = err.message || '';
  if (/Gemini API error: 404/.test(msg)) return true;
  if (/Gemini API error: 400/.test(msg) && /(not found|not supported|does not support)/i.test(msg)) return true;
  return false;
}

// Calls Gemini's generateContent REST endpoint directly, authenticating via
// the X-goog-api-key header (not the SDK, not the ?key= query param — see
// note at top of file for why).
async function callGemini(modelName, prompt, generationConfig) {
  const key = process.env.GEMINI_API_KEY;
  const response = await fetch(
    `${GEMINI_API_BASE}/models/${modelName}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-goog-api-key': key,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        ...(generationConfig ? { generationConfig } : {}),
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini API error: ${response.status} ${text}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini response had no text content');
  return text.trim();
}

// Runs a prompt against the live model list, starting from the last-known
// working candidate. Advances through the remaining candidates only on
// model-unusable errors; any other error (rate limit, network, etc.) is
// thrown immediately so it surfaces as a real failure instead of masking
// itself as "try the next model."
async function callGeminiResilient(prompt, generationConfig) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const candidates = await getModelCandidates();
  let lastErr;

  for (let i = workingModelIndex; i < candidates.length; i += 1) {
    const modelName = candidates[i];
    try {
      const text = await callGemini(modelName, prompt, generationConfig);
      if (i !== workingModelIndex) {
        console.warn(`[geminiService] Switched to model "${modelName}" (previous candidate(s) unusable).`);
      }
      workingModelIndex = i;
      return text;
    } catch (err) {
      lastErr = err;
      if (!isModelUnusableError(err)) throw err;
      console.warn(`[geminiService] Model "${modelName}" unusable: ${err.message.split('\n')[0]}; trying next candidate.`);
    }
  }

  throw lastErr || new Error('No Gemini model candidates available');
}

// Best-effort JSON extraction: models that are told to "respond only with
// JSON" sometimes still wrap it in markdown or a short preamble. Strip code
// fences, then if the remainder still isn't valid JSON on its own, pull out
// the first {...} block and try that before giving up.
function extractJson(raw) {
  const stripped = raw.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const match = stripped.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Could not extract valid JSON from model response: ${stripped.slice(0, 200)}`);
  }
}

// --- Heuristic (demo mode only, no API key) ---------------------------------

const SEARCH_TRIGGERS = ['find', 'buy', 'looking for', 'search', 'compare', 'price', 'cheapest', 'want a', 'want to buy', 'need a'];

function heuristicWantsSearch(message) {
  const lower = message.toLowerCase();
  return SEARCH_TRIGGERS.some((t) => lower.includes(t));
}

function heuristicExtractQuery(message) {
  // crude: strip common lead-in phrases, keep the rest as the product query
  let q = message.toLowerCase();
  SEARCH_TRIGGERS.forEach((t) => { q = q.replace(t, ''); });
  q = q.replace(/^(a|an|the|me|for|to)\s+/g, '').trim();
  return q || message.trim();
}

function heuristicReply(message, offers) {
  if (!offers) {
    return "I can help you find and compare prices on almost anything — just tell me what you're shopping for (e.g. \"find me a pair of running shoes under $100\").";
  }
  if (offers.length === 0) {
    return "I couldn't find any offers for that — try rephrasing what you're looking for.";
  }
  const best = offers[0];
  return `I found ${offers.length} option${offers.length > 1 ? 's' : ''}. The best price right now is $${best.total.toFixed(2)} from ${best.retailer}. Pick one below and I'll hand it off to a Redtail agent to place the order.`;
}

// --- Gemini-backed path (production mode, API key configured) --------------

async function decideIntent(message, history) {
  const prompt = `You are the intent-classifier for a shopping assistant. Given the latest user message (and brief chat history for context), decide:
1. Does the user want to find/buy/compare a product right now?
2. If yes, what is the concise product search query to use (strip filler words, keep key attributes like size/color/budget)?

Respond ONLY with strict JSON, no markdown, no preamble:
{"wantsSearch": boolean, "query": string}

Chat history (most recent last):
${history.map((h) => `${h.role}: ${h.content}`).join('\n')}

Latest user message: ${message}`;

  // responseMimeType forces valid-JSON output on models that support it,
  // which is what actually fixes models replying with markdown bullets
  // instead of JSON. If a candidate model rejects the param outright, retry
  // that same call once without it rather than treating it as "wrong model."
  let raw;
  try {
    raw = await callGeminiResilient(prompt, { responseMimeType: 'application/json' });
  } catch (err) {
    if (!/responseMimeType|response_mime_type/i.test(err.message)) throw err;
    raw = await callGeminiResilient(prompt);
  }

  const parsed = extractJson(raw);
  return {
    wantsSearch: !!parsed.wantsSearch,
    query: typeof parsed.query === 'string' && parsed.query.trim() ? parsed.query.trim() : message,
  };
}

async function composeReply(message, offers) {
  if (!offers) {
    const prompt = `You are Redtail's friendly AI shopping assistant. Reply conversationally (2-3 sentences max) to the user's message. You cannot place orders yourself — a human agent does that once the user picks an offer.\n\nUser: ${message}`;
    return callGeminiResilient(prompt);
  }

  if (offers.length === 0) {
    return "I couldn't find any offers for that — try rephrasing what you're looking for.";
  }

  const offersSummary = offers
    .slice(0, 5)
    .map((o, i) => `${i + 1}. ${o.retailer} — $${o.total.toFixed(2)} total (item $${o.price.toFixed(2)} + shipping $${o.shipping.toFixed(2)}), ETA ${o.etaDays ?? 'unknown'} days`)
    .join('\n');

  const prompt = `You are Redtail's friendly AI shopping assistant. You just searched for offers for the user's request. Write a short (2-3 sentence) natural reply presenting the results conversationally — mention the best price and retailer, and remind them a human Redtail agent will place the order once they pick one. Do not invent any prices beyond what's given.\n\nUser asked: ${message}\n\nOffers found:\n${offersSummary}`;

  return callGeminiResilient(prompt);
}

/**
 * Main entry point used by the /chat route.
 *
 * Production behavior (GEMINI_API_KEY set): any Gemini failure throws.
 * Callers should let this reject and return a non-2xx response — do not
 * catch it here and substitute heuristic content, or a real outage looks
 * like a successful reply with wrong data.
 *
 * Demo behavior (no GEMINI_API_KEY): always succeeds via the heuristic.
 *
 * @param {string} message - latest user message
 * @param {Array<{role: 'user'|'assistant', content: string}>} history
 * @returns {{reply: string, offers: Array|null}}
 */
async function handleChatMessage(message, history = []) {
  const hasKey = !!process.env.GEMINI_API_KEY;

  const intent = hasKey
    ? await decideIntent(message, history)
    : { wantsSearch: heuristicWantsSearch(message), query: heuristicExtractQuery(message) };

  if (!intent.wantsSearch) {
    const reply = hasKey ? await composeReply(message, null) : heuristicReply(message, null);
    return { reply, offers: null, query: null };
  }

  const offers = await searchOffers(intent.query);
  const reply = hasKey ? await composeReply(message, offers) : heuristicReply(message, offers);
  return { reply, offers, query: intent.query };
}

module.exports = { handleChatMessage };