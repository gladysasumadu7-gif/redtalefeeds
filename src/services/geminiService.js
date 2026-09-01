/**
 * geminiService.js
 *
 * Drives the AI shopping chat. Given the conversation, it:
 *   1. Decides whether the user is asking to find/compare a product, and if
 *      so extracts a clean search query.
 *   2. If yes, calls priceService.searchOffers() to get real offers.
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
 * Model resolution + speed: most model NAME GUESSES fail against this
 * project's key/region — a failed generateContent attempt is its own round
 * trip and is often slower than just asking Gemini what's actually
 * available, so we do NOT guess a list of candidate names. Instead:
 *
 *   1. If GEMINI_MODEL is set in the environment, try that ONE model first,
 *      no guessing. Once you've confirmed (via logs — see the warning
 *      below) which model your key/region actually resolves to, set
 *      GEMINI_MODEL to that exact name in your environment and redeploy.
 *      From then on every cold start skips discovery entirely and goes
 *      straight to that one known-good model.
 *   2. If GEMINI_MODEL is unset, or the one it names turns out to be
 *      unusable, fetch the live /models list ONCE, filter+sort it
 *      (fastest-looking models first), and walk through that list until
 *      one works. That "working" model is cached in-process, so it's a
 *      one-time cost per warm instance, not per request.
 *
 * Generic-400 handling: Gemini frequently returns a 400 with a generic
 * message ("Request contains an invalid argument") that doesn't name which
 * field caused it. Because of that, the optional-field fallbacks below
 * (thinkingConfig, responseMimeType) retry unconditionally on any failure
 * from that call, rather than trying to pattern-match Gemini's error text —
 * pattern-matching was silently never triggering and letting the raw 400
 * escape instead of falling back gracefully.
 *
 * Model selection from the client + success tracking: callers (see
 * src/routes/chat.js) may pass a `modelId` through handleChatMessage that
 * the user picked in the app. When present, it's tried FIRST for that
 * request — see callGeminiResilient. Every attempt (client-picked or
 * server-resolved) is recorded in the in-memory `modelStats` map below, and
 * src/routes/models.js reads that data (via getModelStats) to compute which
 * model to tag as "recommended" for the picker. This is in-memory only —
 * it resets on restart/redeploy and isn't shared across instances, which is
 * fine since it only needs to reflect recent behavior, not be permanent.
 */

const { searchOffers } = require('./priceService');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Model names that technically support generateContent but are never right
// for a text chat/classification use case (text-to-speech, embeddings,
// etc.) — filtered out so we don't waste an attempt on them. Exported as
// isChatCapableModel() so src/routes/models.js can apply the same filter to
// its own raw /models fetch.
const NON_CHAT_MODEL_PATTERN = /tts|embedding|aqa|image-generation/i;

function isChatCapableModel(name) {
  return !NON_CHAT_MODEL_PATTERN.test(name);
}

// Rough speed ranking for sorting the discovered model list — lower is
// faster/preferred. Unknown/other names sort ahead of "pro" but behind
// flash variants. Exported so src/routes/models.js can sort its own list
// the same way.
function speedRank(modelName) {
  if (/flash-lite/i.test(modelName)) return 0;
  if (/flash/i.test(modelName)) return 1;
  if (/pro/i.test(modelName)) return 3;
  return 2;
}

// "gemini-2.0-flash-lite" -> "Gemini 2.0 Flash Lite"
function formatModelLabel(name) {
  return name
    .replace(/^gemini-/, 'Gemini ')
    .split('-')
    .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}

let modelCandidates = null; // string[] once resolved, either [GEMINI_MODEL] or the discovered list
let workingModelIndex = 0;

// name -> { attempts, successes }. Populated by every real call through
// callGeminiResilient, whether the model was client-picked or
// server-resolved. Read by getModelStats() for the "recommended" tag.
const modelStats = new Map();

function recordModelResult(modelName, success) {
  const s = modelStats.get(modelName) || { attempts: 0, successes: 0 };
  s.attempts += 1;
  if (success) s.successes += 1;
  modelStats.set(modelName, s);
}

function getModelStats() {
  return Object.fromEntries(modelStats);
}

// Minimum number of attempts a model needs before its success rate is
// trusted enough to make it "recommended" — avoids one lucky/unlucky call
// swinging the tag. Exported for src/routes/models.js to reuse.
const MIN_SAMPLES_FOR_RECOMMENDATION = 3;

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

async function discoverModelCandidates() {
  const available = await fetchAvailableModels();
  const discovered = available
    .filter((m) => m.supportedGenerationMethods.includes('generateContent'))
    .filter((m) => isChatCapableModel(m.name))
    .map((m) => m.name)
    .sort((a, b) => speedRank(a) - speedRank(b));

  if (discovered.length === 0) {
    throw new Error(
      `No available Gemini model supports generateContent for chat. Models returned: ${available.map((m) => m.name).join(', ') || '(none)'}`
    );
  }
  return discovered;
}

async function getModelCandidates() {
  if (modelCandidates) return modelCandidates;

  const pinned = process.env.GEMINI_MODEL;
  if (pinned) {
    // Try the pinned model alone first — if it works, we never touch
    // /models at all, which is the fastest possible cold-start path.
    modelCandidates = [pinned];
    return modelCandidates;
  }

  modelCandidates = await discoverModelCandidates();
  console.warn(
    `[geminiService] No GEMINI_MODEL pinned. Discovered and will use: ${modelCandidates[0]}. ` +
    `Set GEMINI_MODEL=${modelCandidates[0]} in your environment to skip discovery on future cold starts.`
  );
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
  // Some models can return multiple parts (e.g. a thought-summary part
  // alongside the real answer). Concatenate all non-thought parts rather
  // than trusting parts[0] to be the final answer.
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts
    .filter((p) => !p.thought)
    .map((p) => p.text || '')
    .join('')
    .trim();
  if (!text) throw new Error('Gemini response had no text content');
  return text;
}

// Wraps callGemini with a thinkingConfig disable attempt — this is the
// single biggest latency win available, since "thinking" models otherwise
// spend a large, variable amount of time generating hidden reasoning
// tokens before ever producing the visible reply. Not every model supports
// thinkingConfig, and Gemini's rejection of it usually comes back as a
// generic 400 with no field name — so we retry once without it on ANY
// failure from that call, rather than trying to detect the specific cause.
async function callGeminiFast(modelName, prompt, generationConfig = {}) {
  try {
    return await callGemini(modelName, prompt, {
      ...generationConfig,
      thinkingConfig: { thinkingBudget: 0 },
    });
  } catch (err) {
    console.warn(`[geminiService] Call with thinkingConfig failed (${err.message.split('\n')[0]}); retrying without it.`);
    return callGemini(modelName, prompt, generationConfig);
  }
}

// Runs a prompt against the current candidate list, starting from the
// last-known working candidate. Advances through remaining candidates only
// on model-unusable errors. If the list was just [GEMINI_MODEL] (pinned)
// and that single entry fails as unusable, falls through to a one-time
// live discovery and retries against that list before giving up entirely.
//
// modelOverride (optional): a model id the client picked in the UI. If
// given, it's tried FIRST, ahead of the pinned/discovered candidate list.
// A transient error (rate limit, network) on the override bubbles up
// immediately, same as everywhere else in this file. Only an "unusable"
// error on the override falls through to the normal candidate flow below,
// so a client picking a since-deprecated model never hard-fails the
// request — it just silently gets the server's best default instead.
// Every attempt, override or not, is recorded via recordModelResult.
async function callGeminiResilient(prompt, generationConfig, modelOverride) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  if (modelOverride) {
    try {
      const text = await callGeminiFast(modelOverride, prompt, generationConfig);
      recordModelResult(modelOverride, true);
      return text;
    } catch (err) {
      recordModelResult(modelOverride, false);
      if (!isModelUnusableError(err)) throw err;
      console.warn(`[geminiService] Requested model "${modelOverride}" unusable: ${err.message.split('\n')[0]}; falling back to default candidates.`);
    }
  }

  const candidates = await getModelCandidates();
  const wasPinnedOnly = candidates.length === 1 && candidates[0] === process.env.GEMINI_MODEL;
  let lastErr;

  for (let i = workingModelIndex; i < candidates.length; i += 1) {
    const modelName = candidates[i];
    try {
      const text = await callGeminiFast(modelName, prompt, generationConfig);
      if (i !== workingModelIndex) {
        console.warn(`[geminiService] Switched to model "${modelName}" (previous candidate(s) unusable).`);
      }
      workingModelIndex = i;
      recordModelResult(modelName, true);
      return text;
    } catch (err) {
      lastErr = err;
      recordModelResult(modelName, false);
      if (!isModelUnusableError(err)) throw err;
      console.warn(`[geminiService] Model "${modelName}" unusable: ${err.message.split('\n')[0]}; trying next candidate.`);
    }
  }

  if (wasPinnedOnly) {
    console.warn(`[geminiService] Pinned GEMINI_MODEL="${process.env.GEMINI_MODEL}" is unusable — falling back to live /models discovery.`);
    modelCandidates = await discoverModelCandidates();
    workingModelIndex = 0;
    return callGeminiResilient(prompt, generationConfig, modelOverride); // one retry pass against the discovered list
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

// Signals the user wants to shop but hasn't given us enough to search well
// yet — a specific occasion/recipient/category without any constraint
// (budget, style, use case) to narrow it down.
const VAGUE_TRIGGERS = [
  'gift', 'present', 'surprise',
  "don't know what", 'dont know what', 'not sure what', 'no idea what',
  'something for', 'help me find', 'help me pick', 'help me choose',
  'not sure', 'no idea', "don't know", 'dont know',
];

function heuristicWantsSearch(message) {
  const lower = message.toLowerCase();
  return SEARCH_TRIGGERS.some((t) => lower.includes(t));
}

function heuristicIsVague(message) {
  const lower = message.toLowerCase();
  return VAGUE_TRIGGERS.some((t) => lower.includes(t));
}

function heuristicExtractQuery(message) {
  let q = message.toLowerCase();
  SEARCH_TRIGGERS.forEach((t) => { q = q.replace(t, ''); });
  q = q.replace(/^(a|an|the|me|for|to)\s+/g, '').trim();
  return q || message.trim();
}

function heuristicClarifyingQuestion(message) {
  const lower = message.toLowerCase();
  if (lower.includes('gift') || lower.includes('present') || lower.includes('surprise')) {
    return "I'd love to help you find something great! Who's it for, what are they into, and roughly what's your budget?";
  }
  return "Happy to help you find the right thing! What's it for, and do you have a budget or style in mind?";
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

// Heuristic equivalent of planTurn() below, for demo mode (no API key).
// Order matters: check "vague" before "wants search", since a message like
// "I need a gift" would otherwise match the "need a" search trigger and
// skip straight to a useless search for the word "gift".
function heuristicPlan(message) {
  if (heuristicIsVague(message)) {
    return { action: 'clarify', query: null, reply: heuristicClarifyingQuestion(message) };
  }
  if (heuristicWantsSearch(message)) {
    return { action: 'search', query: heuristicExtractQuery(message), reply: null };
  }
  return { action: 'chat', query: null, reply: heuristicReply(message, null) };
}

// --- Gemini-backed path (production mode, API key configured) --------------

/**
 * Single planning call that decides what to do next AND, for the two
 * branches that don't depend on search results (clarify/chat), writes the
 * actual reply in the same round trip — only "search" needs a second call,
 * since that reply has to reference real offer data we don't have yet.
 *
 * - "search": the user has given enough to search well right now — either
 *   a specific product, or a category plus at least one useful constraint
 *   (budget, recipient, use case, style, etc). `query` is set, `reply` is
 *   null (composeReply writes it after we have results).
 * - "clarify": there's shopping intent but not enough detail yet (e.g. "I
 *   need a gift for my dad", "not sure what to get my new apartment").
 *   `reply` is ONE short, friendly guiding question — never more than one
 *   at a time — picking whichever of budget/recipient/occasion/style/use
 *   case is most useful to ask about next, given what's already been said
 *   in the chat history. `query` is null.
 * - "chat": no shopping intent. `reply` is a normal conversational
 *   response. `query` is null.
 *
 * @param {string} message
 * @param {Array<{role: string, content: string}>} history
 * @param {string|null} modelId - optional client-picked model, see callGeminiResilient
 */
async function planTurn(message, history, modelId) {
  // Enough turns to track preferences gathered across a multi-message
  // discovery conversation (budget mentioned two turns ago, etc.), without
  // sending the whole thread.
  const recentHistory = history.slice(-6);

  const prompt = `You are the planning brain for Redtail's AI shopping assistant. Decide the single best next action given the conversation so far.

Actions:
- "search": you have enough specific detail to run a product search right now (a named product, OR a category plus at least one useful constraint like budget, recipient, occasion, or style). Set "query" to a concise search string (strip filler words, keep key attributes). Leave "reply" null.
- "clarify": the user wants to shop or browse but hasn't given enough detail to search well yet (e.g. "I need a gift for my mom", "not sure what I want", "something for my new apartment"). Ask exactly ONE short, friendly guiding question that narrows things down — pick whichever of budget, recipient, occasion, interests, or style is most useful to ask next given what's already been said. Never ask more than one question at once, and never repeat a question already answered earlier in the history. Put the question in "reply". Set "query" to null.
- "chat": no shopping intent at all (greetings, small talk, unrelated questions). Write a short (1-3 sentence) conversational reply in "reply". Set "query" to null.

Respond with ONLY the final message text inside the JSON fields below — no planning, no drafts, no self-checklist, no markdown, no preamble. Respond ONLY with strict JSON:
{"action": "search" | "clarify" | "chat", "query": string | null, "reply": string | null}

Chat history (most recent last):
${recentHistory.map((h) => `${h.role}: ${h.content}`).join('\n')}

Latest user message: ${message}`;

  const baseConfig = { maxOutputTokens: 500 };
  let raw;
  try {
    raw = await callGeminiResilient(prompt, { ...baseConfig, responseMimeType: 'application/json' }, modelId);
  } catch (err) {
    // Same generic-400 problem as callGeminiFast above — retry
    // unconditionally rather than trying to pattern-match Gemini's error text.
    console.warn(`[geminiService] Call with responseMimeType failed (${err.message.split('\n')[0]}); retrying without it.`);
    raw = await callGeminiResilient(prompt, baseConfig, modelId);
  }

  const parsed = extractJson(raw);
  const action = ['search', 'clarify', 'chat'].includes(parsed.action) ? parsed.action : 'chat';

  if (action === 'search') {
    return {
      action,
      query: typeof parsed.query === 'string' && parsed.query.trim() ? parsed.query.trim() : message,
      reply: null,
    };
  }

  return {
    action,
    query: null,
    reply: typeof parsed.reply === 'string' && parsed.reply.trim()
      ? parsed.reply.trim()
      : "Happy to help — what are you shopping for?",
  };
}

async function composeReply(message, offers, modelId) {
  const NO_LEAK_INSTRUCTION =
    'Respond with ONLY the final message text — no planning, no drafts, no bullet points, no self-checklist, nothing but the reply itself.';

  if (offers.length === 0) {
    return "I couldn't find any offers for that — try rephrasing what you're looking for.";
  }

  const offersSummary = offers
    .slice(0, 5)
    .map((o, i) => `${i + 1}. ${o.retailer} — $${o.total.toFixed(2)} total (item $${o.price.toFixed(2)} + shipping $${o.shipping.toFixed(2)}), ETA ${o.etaDays ?? 'unknown'} days`)
    .join('\n');

  const prompt = `You are Redtail's friendly AI shopping assistant. You just searched for offers for the user's request. Write a short (2-3 sentence) natural reply presenting the results conversationally — mention the best price and retailer, and remind them a human Redtail agent will place the order once they pick one. Do not invent any prices beyond what's given.

${NO_LEAK_INSTRUCTION}

User asked: ${message}

Offers found:
${offersSummary}`;
  return callGeminiResilient(prompt, { maxOutputTokens: 500 }, modelId);
}

/**
 * Main entry point used by the /chat route.
 *
 * Handles three kinds of turns:
 *   - Clear intent ("find me wireless earbuds under $50") -> searches and
 *     presents offers immediately.
 *   - Vague/browsing intent ("I need a gift for my mom", "not sure what I
 *     want") -> asks ONE short guiding question instead of searching, so
 *     the assistant can narrow things down across a few turns before
 *     running a search that's actually useful. As the user answers,
 *     later turns get enough detail to move to "search" on their own —
 *     no special handling needed here, the planner sees the accumulated
 *     history on every call.
 *   - No shopping intent -> ordinary conversational reply.
 *
 * Production behavior (GEMINI_API_KEY set): any Gemini failure throws.
 * Callers should let this reject and return a non-2xx response — do not
 * catch it here and substitute heuristic content, or a real outage looks
 * like a successful reply with wrong data.
 *
 * Demo behavior (no GEMINI_API_KEY): always succeeds via the heuristic.
 * modelId is ignored in this mode since no Gemini call is made.
 *
 * @param {string} message - latest user message
 * @param {Array<{role: 'user'|'assistant', content: string}>} history
 * @param {string|null} modelId - optional model the client picked in the UI.
 *   Tried first; falls back to the server's normal pinned/discovered
 *   candidates if it turns out to be unusable. See callGeminiResilient.
 * @returns {{reply: string, offers: Array|null, query: string|null}}
 */
async function handleChatMessage(message, history = [], modelId = null) {
  const hasKey = !!process.env.GEMINI_API_KEY;

  const plan = hasKey ? await planTurn(message, history, modelId) : heuristicPlan(message);

  if (plan.action !== 'search') {
    // "clarify" and "chat" both just surface plan.reply as-is — the only
    // difference between them is what prompted the model to write it.
    return { reply: plan.reply, offers: null, query: null };
  }

  const offers = await searchOffers(plan.query);
  const reply = hasKey ? await composeReply(message, offers, modelId) : heuristicReply(message, offers);
  return { reply, offers, query: plan.query };
}

module.exports = {
  handleChatMessage,
  isChatCapableModel,
  speedRank,
  formatModelLabel,
  getModelStats,
  MIN_SAMPLES_FOR_RECOMMENDATION,
};