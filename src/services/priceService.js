/**
 * priceService.js
 *
 * Product search + price comparison across online shops.
 * Real Google Shopping results via SerpAPI (https://serpapi.com).
 *
 * Production-ready: No static mock data. Throws on API or configuration
 * errors so callers receive proper non-2xx statuses.
 */

const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');

async function searchOffers(query) {
  const key = process.env.SERPAPI_KEY;
  if (!key) {
    throw new Error('[priceService] SERPAPI_KEY environment variable is not configured');
  }

  const url = `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(query)}&api_key=${key}`;

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[priceService] SerpAPI responded with status ${res.status}: ${text}`);
  }

  const data = await res.json();
  const results = data.shopping_results || [];

  const offers = results.slice(0, 10).map((r) => {
    const price = typeof r.extracted_price === 'number'
      ? r.extracted_price
      : parseFloat(String(r.price || '0').replace(/[^0-9.]/g, '')) || 0;

    return {
      id: uuidv4(),
      retailer: r.source || 'Unknown retailer',
      title: r.title,
      price,
      currency: 'USD',
      shipping: 0,
      total: price,
      etaDays: null,
      url: r.product_link || r.link || null,
      imageUrl: r.thumbnail || null,
      inStock: true,
      provider: 'serpapi',
    };
  });

  offers.sort((a, b) => a.total - b.total);
  return offers;
}

module.exports = { searchOffers };