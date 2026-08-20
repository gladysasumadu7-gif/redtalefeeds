/**
 * priceService.js
 *
 * Product search + price comparison across "online shops".
 *
 * Two providers:
 *  - mock:    deterministic, offline, zero-dependency. Good enough for a demo
 *             and matches the shape the Redtail frontend expects.
 *  - serpapi: real Google Shopping results via SerpAPI (https://serpapi.com).
 *             Only activates if PRICE_PROVIDER=serpapi and SERPAPI_KEY is set.
 *
 * Swap providers with the PRICE_PROVIDER env var. No code changes needed
 * elsewhere — everything downstream (the AI endpoint) just calls
 * searchOffers(query) and gets back ProductOffer[] regardless of provider.
 */

const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');

const RETAILERS = ['Amazon', 'Walmart', 'Target', 'Best Buy', 'eBay', 'Newegg'];

// Simple seeded pseudo-random so the same query returns stable-ish mock results
function seededRandom(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(31, h) + seed.charCodeAt(i) | 0;
  }
  return function () {
    h = Math.imul(h ^ (h >>> 15), h | 1);
    h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
    return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
  };
}

function mockSearch(query) {
  const rand = seededRandom(query.toLowerCase().trim());
  const basePrice = 20 + rand() * 480;
  const numOffers = 3 + Math.floor(rand() * 3); // 3-5 offers

  const shuffled = [...RETAILERS].sort(() => rand() - 0.5).slice(0, numOffers);

  const offers = shuffled.map((retailer) => {
    const variance = 0.85 + rand() * 0.3; // +/-15%
    const price = Math.round(basePrice * variance * 100) / 100;
    const shipping = rand() > 0.5 ? 0 : Math.round(rand() * 15 * 100) / 100;
    const etaDays = 2 + Math.floor(rand() * 6);

    return {
      id: uuidv4(),
      retailer,
      title: `${query} — ${retailer} listing`,
      price,
      currency: 'USD',
      shipping,
      total: Math.round((price + shipping) * 100) / 100,
      etaDays,
      url: `https://example.com/search?retailer=${encodeURIComponent(retailer)}&q=${encodeURIComponent(query)}`,
      imageUrl: null,
      inStock: rand() > 0.1,
      provider: 'mock',
    };
  });

  offers.sort((a, b) => a.total - b.total);
  return offers;
}

async function serpApiSearch(query) {
  const key = process.env.SERPAPI_KEY;
  if (!key) {
    console.warn('[priceService] PRICE_PROVIDER=serpapi but SERPAPI_KEY is missing — falling back to mock');
    return mockSearch(query);
  }

  const url = `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(query)}&api_key=${key}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`SerpAPI responded ${res.status}`);
    const data = await res.json();
    const results = data.shopping_results || [];

    const offers = results.slice(0, 10).map((r) => {
      const price = typeof r.extracted_price === 'number' ? r.extracted_price : parseFloat(String(r.price || '0').replace(/[^0-9.]/g, '')) || 0;
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
    return offers.length ? offers : mockSearch(query);
  } catch (err) {
    console.error('[priceService] serpapi search failed, falling back to mock:', err.message);
    return mockSearch(query);
  }
}

async function searchOffers(query) {
  const provider = (process.env.PRICE_PROVIDER || 'mock').toLowerCase();
  if (provider === 'serpapi') return serpApiSearch(query);
  return mockSearch(query);
}

module.exports = { searchOffers };
