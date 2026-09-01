const express = require('express');
const router = express.Router();
const {
  isChatCapableModel,
  speedRank,
  formatModelLabel,
  getModelStats,
  MIN_SAMPLES_FOR_RECOMMENDATION,
} = require('../services/geminiService');

// Mounted at /api/v1/models in server.js.
router.get('/', async (req, res) => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
  }

  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'X-goog-api-key': key },
    });
    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: 'Failed to fetch models', details: text });
    }
    const data = await response.json();

    // Same filtering geminiService applies for its own candidate list:
    // must support generateContent, and not be a non-chat model (tts,
    // embeddings, etc). Sorted fastest-first.
    const chatModels = (data.models || [])
      .map((m) => ({ id: m.name.replace('models/', ''), methods: m.supportedGenerationMethods || [] }))
      .filter((m) => m.methods.includes('generateContent'))
      .filter((m) => isChatCapableModel(m.id))
      .sort((a, b) => speedRank(a.id) - speedRank(b.id));

    const stats = getModelStats();

    // Recommended = highest success rate among models with enough real
    // traffic to be meaningful; falls back to the fastest model if nothing
    // has enough samples yet.
    let recommendedId = chatModels[0]?.id ?? null;
    let bestRate = -1;
    chatModels.forEach(({ id }) => {
      const s = stats[id];
      if (s && s.attempts >= MIN_SAMPLES_FOR_RECOMMENDATION) {
        const rate = s.successes / s.attempts;
        if (rate > bestRate) {
          bestRate = rate;
          recommendedId = id;
        }
      }
    });

    const models = chatModels.map(({ id }) => {
      const s = stats[id] || { attempts: 0, successes: 0 };
      return {
        id,
        label: formatModelLabel(id),
        recommended: id === recommendedId,
        successRate: s.attempts ? Number((s.successes / s.attempts).toFixed(2)) : null,
        attempts: s.attempts,
      };
    });

    res.json({ models });
  } catch (err) {
    res.status(500).json({ error: 'Request failed', details: err.message });
  }
});

module.exports = router;