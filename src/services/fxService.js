/**
 * fxService.js
 *
 * USD -> GHS conversion for checkout. Paystack itself does not convert
 * currency for you — the amount sent to /transaction/initialize must
 * already be in the merchant account's supported currency (GHS here), so
 * this runs before every /payments/init call.
 *
 * Rate source: exchangerate-api (open.er-api.com), free, no API key
 * required. Cached in-memory for FX_CACHE_TTL_MS so checkout isn't making a
 * live network call on every single request. If the live lookup fails for
 * any reason (network blip, provider down), falls back to
 * FX_USD_TO_GHS_FALLBACK if set, so checkout doesn't hard-fail on an FX
 * provider outage — set this env var to a reasonable current rate and
 * update it occasionally.
 */

const fetch = require('node-fetch');

const RATE_URL = 'https://open.er-api.com/v6/latest/USD';
const FX_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

let cachedRate = null;
let cachedAt = 0;

async function getUsdToGhsRate() {
  const now = Date.now();
  if (cachedRate && now - cachedAt < FX_CACHE_TTL_MS) {
    return cachedRate;
  }

  try {
    const res = await fetch(RATE_URL);
    if (!res.ok) throw new Error(`FX provider responded with status ${res.status}`);
    const data = await res.json();
    const rate = data && data.rates && data.rates.GHS;
    if (!rate || typeof rate !== 'number') throw new Error('FX provider response missing GHS rate');

    cachedRate = rate;
    cachedAt = now;
    return rate;
  } catch (err) {
    console.error('[fxService] live rate lookup failed:', err.message);

    const fallback = parseFloat(process.env.FX_USD_TO_GHS_FALLBACK);
    if (fallback && fallback > 0) {
      console.warn(`[fxService] using FX_USD_TO_GHS_FALLBACK=${fallback}`);
      return fallback;
    }

    // No cached rate and no fallback configured — checkout genuinely can't
    // proceed without a rate, so surface a clear, actionable error rather
    // than silently charging the wrong amount.
    const configErr = new Error(
      'Currency conversion is unavailable and FX_USD_TO_GHS_FALLBACK is not set on the server'
    );
    configErr.code = 'FX_NOT_CONFIGURED';
    throw configErr;
  }
}

/**
 * @param {number} usdAmount - amount in whole USD (e.g. 24.99)
 * @returns {Promise<number>} amount in whole GHS, rounded to 2 decimal places
 */
async function convertUsdToGhs(usdAmount) {
  if (typeof usdAmount !== 'number' || usdAmount <= 0) {
    throw new Error('usdAmount must be a positive number');
  }
  const rate = await getUsdToGhsRate();
  return Math.round(usdAmount * rate * 100) / 100;
}

module.exports = { convertUsdToGhs, getUsdToGhsRate };
