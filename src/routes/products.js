const express = require('express');
const { searchOffers } = require('../services/priceService');

const router = express.Router();

// GET /products/search?query=...
router.get('/search', async (req, res) => {
  const { query } = req.query;
  if (!query || !String(query).trim()) {
    return res.status(400).json({ error: 'query param is required' });
  }

  try {
    const offers = await searchOffers(String(query).trim());
    res.json({ query, offers, provider: process.env.PRICE_PROVIDER || 'serpapi' });
  } catch (err) {
    console.error('[products route] error:', err);
    res.status(502).json({ error: 'Failed to search offers' });
  }
});

module.exports = router;