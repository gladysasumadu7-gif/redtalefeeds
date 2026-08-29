const express = require('express');
const router = express.Router();

// Debug/ops endpoint (lists which Gemini models this API key can use) —
// gated behind auth since it leaks details about the server's AI provider
// config and has no reason to be publicly reachable.
// Mounted at /api/v1/models in server.js, so this is the router's root.
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
    const models = (data.models || []).map((m) => ({
      name: m.name,
      displayName: m.displayName,
      supportedGenerationMethods: m.supportedGenerationMethods,
    }));
    res.json({ models });
  } catch (err) {
    res.status(500).json({ error: 'Request failed', details: err.message });
  }
});

module.exports = router;