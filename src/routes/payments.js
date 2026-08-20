const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { initializeTransaction, verifyTransaction, verifyWebhookSignature } = require('../services/paymentService');

const router = express.Router();

// In-memory "orders" so verify has something to attach to — swap for real
// order creation once you wire a DB back in.
const paidOrders = new Map(); // reference -> order

// POST /payments/init  { email, amount, offerId?, quantity? }
router.post('/init', async (req, res) => {
  const { email, amount, offerId, quantity } = req.body || {};

  try {
    const data = await initializeTransaction({
      email,
      amount,
      metadata: { offerId: offerId || null, quantity: quantity || 1 },
    });
    res.json({ authorizationUrl: data.authorization_url, reference: data.reference, accessCode: data.access_code });
  } catch (err) {
    if (err.code === 'PAYSTACK_NOT_CONFIGURED') {
      return res.status(501).json({ error: 'PAYSTACK_SECRET_KEY is not set on the server' });
    }
    console.error('[payments route] init error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST /payments/verify  { reference }
// This is the ONLY place an "order" gets marked paid — never trust a client
// callback alone. Call this after the client's Paystack webview reports
// success, before you consider the order placed.
router.post('/verify', async (req, res) => {
  const { reference } = req.body || {};
  if (!reference) return res.status(400).json({ error: 'reference is required' });

  try {
    const result = await verifyTransaction(reference);

    if (!result.success) {
      return res.status(402).json({ error: 'Payment not successful', status: result.status });
    }

    const order = {
      id: uuidv4(),
      reference: result.reference,
      amount: result.amount,
      currency: result.currency,
      customerEmail: result.customerEmail,
      metadata: result.metadata,
      paidAt: result.paidAt,
      status: 'AGENT_REVIEWING', // matches the ShopBot order state machine's entry state
    };
    paidOrders.set(reference, order);

    res.json({ order });
  } catch (err) {
    if (err.code === 'PAYSTACK_NOT_CONFIGURED') {
      return res.status(501).json({ error: 'PAYSTACK_SECRET_KEY is not set on the server' });
    }
    console.error('[payments route] verify error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST /payments/webhook — Paystack calls this async, independent of the
// client. Requires express.raw() body parsing (wired in server.js) so the
// HMAC check runs against the exact bytes Paystack sent.
router.post('/webhook', (req, res) => {
  const signature = req.headers['x-paystack-signature'];

  try {
    const rawBody = req.body; // Buffer, thanks to express.raw() on this route
    if (!verifyWebhookSignature(rawBody, signature)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(rawBody.toString('utf8'));
    console.log('[payments webhook] verified event:', event.event, event.data && event.data.reference);

    // e.g. if (event.event === 'charge.success') { ...update order... }

    res.sendStatus(200);
  } catch (err) {
    console.error('[payments webhook] error:', err.message);
    res.sendStatus(400);
  }
});

router.get('/orders/:reference', (req, res) => {
  const order = paidOrders.get(req.params.reference);
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json({ order });
});

module.exports = router;
