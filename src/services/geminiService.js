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
 * Falls back to a keyword heuristic (no external call) if GEMINI_API_KEY is
 * not set, so the endpoint always works for a demo even with zero keys.
 */

const { searchOffers } = require('./priceService');

let genAI = null;
let model = null;

function getModel() {
  if (!process.env.GEMINI_API_KEY) return null;
  if (model) return model;

  // Lazy-require so the package isn't needed at all if no key is configured
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.0-flash' });
  return model;
}

// --- Heuristic fallback (no API key needed) ---------------------------------

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

// --- Gemini-backed path -------------------------------------------------------

async function decideIntent(message, history) {
  const m = getModel();
  const prompt = `You are the intent-classifier for a shopping assistant. Given the latest user message (and brief chat history for context), decide:
1. Does the user want to find/buy/compare a product right now?
2. If yes, what is the concise product search query to use (strip filler words, keep key attributes like size/color/budget)?

Respond ONLY with strict JSON, no markdown, no preamble:
{"wantsSearch": boolean, "query": string}

Chat history (most recent last):
${history.map((h) => `${h.role}: ${h.content}`).join('\n')}

Latest user message: ${message}`;

  try {
    const result = await m.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text);
    return {
      wantsSearch: !!parsed.wantsSearch,
      query: typeof parsed.query === 'string' && parsed.query.trim() ? parsed.query.trim() : message,
    };
  } catch (err) {
    console.error('[geminiService] decideIntent failed, using heuristic:', err.message);
    return { wantsSearch: heuristicWantsSearch(message), query: heuristicExtractQuery(message) };
  }
}

async function composeReply(message, offers) {
  const m = getModel();
  if (!offers) {
    const prompt = `You are Redtail's friendly AI shopping assistant. Reply conversationally (2-3 sentences max) to the user's message. You cannot place orders yourself — a human agent does that once the user picks an offer.\n\nUser: ${message}`;
    try {
      const result = await m.generateContent(prompt);
      return result.response.text().trim();
    } catch (err) {
      console.error('[geminiService] composeReply failed, using heuristic:', err.message);
      return heuristicReply(message, null);
    }
  }

  if (offers.length === 0) {
    return "I couldn't find any offers for that — try rephrasing what you're looking for.";
  }

  const offersSummary = offers
    .slice(0, 5)
    .map((o, i) => `${i + 1}. ${o.retailer} — $${o.total.toFixed(2)} total (item $${o.price.toFixed(2)} + shipping $${o.shipping.toFixed(2)}), ETA ${o.etaDays ?? 'unknown'} days`)
    .join('\n');

  const prompt = `You are Redtail's friendly AI shopping assistant. You just searched for offers for the user's request. Write a short (2-3 sentence) natural reply presenting the results conversationally — mention the best price and retailer, and remind them a human Redtail agent will place the order once they pick one. Do not invent any prices beyond what's given.\n\nUser asked: ${message}\n\nOffers found:\n${offersSummary}`;

  try {
    const result = await m.generateContent(prompt);
    return result.response.text().trim();
  } catch (err) {
    console.error('[geminiService] composeReply failed, using heuristic:', err.message);
    return heuristicReply(message, offers);
  }
}

/**
 * Main entry point used by the /chat route.
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
