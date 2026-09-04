const express = require('express');
const { initializeTransaction, verifyTransaction, verifyWebhookSignature } = require('../services/paymentService');
const { supabase } = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// POST /payments/init  { amount, offerId?, quantity? }
// email comes from the authenticated user, never from the request body —
// otherwise anyone could initialize a Paystack transaction under someone
// else's email.
router.post('/init', requireAuth, async (req, res) => {
  const { amount, offerId, quantity } = req.body || {};

  try {
    const data = await initializeTransaction({
      email: req.user.email,
      amount,
      metadata: { offerId: offerId || null, quantity: quantity || 1, userId: req.user.id },
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
router.post('/verify', requireAuth, async (req, res) => {
  const { reference } = req.body || {};
  if (!reference) return res.status(400).json({ error: 'reference is required' });

  try {
    const result = await verifyTransaction(reference);

    if (!result.success) {
      return res.status(402).json({ error: 'Payment not successful', status: result.status });
    }

    // Guard against a user verifying a reference that was initialized under
    // a different account's metadata.
    if (result.metadata && result.metadata.userId && result.metadata.userId !== req.user.id) {
      return res.status(403).json({ error: 'This transaction does not belong to your account' });
    }

    const isNewOrder = await isNewReference(result.reference);

    const { data: order, error } = await supabase
      .from('orders')
      .upsert(
        {
          user_id: req.user.id,
          reference: result.reference,
          amount: result.amount,
          currency: result.currency,
          customer_email: result.customerEmail,
          metadata: result.metadata,
          paid_at: result.paidAt,
          status: 'AGENT_REVIEWING', // matches the ShopBot order state machine's entry state
          // No item breakdown exists yet at checkout time (see order_items,
          // populated later by an agent), so subtotal starts equal to the
          // full amount until fees are itemized on the dashboard.
          subtotal: result.amount,
        },
        { onConflict: 'reference' }
      )
      .select('id, reference, amount, currency, customer_email, metadata, paid_at, status, created_at')
      .single();

    if (error) throw error;

    // Seed the customer-visible timeline exactly once, the first time this
    // reference is ever paid — the agent dashboard appends to it from here.
    if (isNewOrder) {
      await supabase.from('order_timeline_events').insert({
        order_id: order.id,
        status: 'AGENT_REVIEWING',
        label: 'Payment confirmed',
      });
    }

    res.json({ order: toApiOrder(order) });
  } catch (err) {
    if (err.code === 'PAYSTACK_NOT_CONFIGURED') {
      return res.status(501).json({ error: 'PAYSTACK_SECRET_KEY is not set on the server' });
    }
    console.error('[payments route] verify error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST /payments/webhook — Paystack calls this async, independent of the
// client and with no user session, so it deliberately has NO requireAuth.
// Requires express.raw() body parsing, wired in server.js BEFORE the global
// express.json() for this exact path, so the HMAC check runs against the
// exact bytes Paystack sent.
router.post('/webhook', async (req, res) => {
  const signature = req.headers['x-paystack-signature'];

  try {
    const rawBody = req.body; // Buffer, thanks to express.raw() on this route
    if (!verifyWebhookSignature(rawBody, signature)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(rawBody.toString('utf8'));
    console.log('[payments webhook] verified event:', event.event, event.data && event.data.reference);

    if (event.event === 'charge.success' && event.data && event.data.reference) {
      // Re-verify directly with Paystack rather than trusting the webhook
      // payload's amount/status fields, then upsert exactly like /verify does.
      const result = await verifyTransaction(event.data.reference);
      if (result.success) {
        const userId = result.metadata && result.metadata.userId;
        if (userId) {
          const isNewOrder = await isNewReference(result.reference);
          const { data: order } = await supabase
            .from('orders')
            .upsert(
              {
                user_id: userId,
                reference: result.reference,
                amount: result.amount,
                currency: result.currency,
                customer_email: result.customerEmail,
                metadata: result.metadata,
                paid_at: result.paidAt,
                status: 'AGENT_REVIEWING',
                subtotal: result.amount,
              },
              { onConflict: 'reference' }
            )
            .select('id')
            .single();
          if (isNewOrder && order) {
            await supabase.from('order_timeline_events').insert({
              order_id: order.id,
              status: 'AGENT_REVIEWING',
              label: 'Payment confirmed',
            });
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('[payments webhook] error:', err.message);
    res.sendStatus(400);
  }
});

// GET /payments/orders — list the authenticated user's own orders
router.get('/orders', requireAuth, async (req, res) => {
  const { data: orders, error } = await supabase
    .from('orders')
    .select('id, reference, amount, currency, customer_email, metadata, paid_at, status, created_at, user_id')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[payments route] list orders error:', error);
    return res.status(500).json({ error: 'Failed to load orders' });
  }
  res.json({ orders: orders.map(toApiOrder) });
});

// GET /payments/orders/id/:id — full detail incl. items + timeline, scoped
// to the owning user. (The existing /orders/:reference route below is keyed
// by Paystack reference, not order id — this one is keyed by order id, for
// the order-detail/tracking screen.)
router.get('/orders/id/:id', requireAuth, async (req, res) => {
  const { data: order, error } = await supabase
    .from('orders')
    .select(
      `id, reference, amount, currency, customer_email, metadata, paid_at, status, created_at,
       subtotal, shipping_fee, service_fee, shipping_address, carrier, tracking_number,
       estimated_delivery, window_closes_at, agent_note, user_id`
    )
    .eq('id', req.params.id)
    .maybeSingle();

  if (error) {
    console.error('[payments route] fetch order by id error:', error);
    return res.status(500).json({ error: 'Failed to load order' });
  }
  if (!order || order.user_id !== req.user.id) {
    return res.status(404).json({ error: 'Not found' });
  }

  const { data: timeline, error: tErr } = await supabase
    .from('order_timeline_events')
    .select('id, status, label, note, occurred_at')
    .eq('order_id', req.params.id)
    .order('occurred_at', { ascending: true });
  if (tErr) {
    console.error('[payments route] fetch order timeline error:', tErr);
    return res.status(500).json({ error: 'Failed to load order timeline' });
  }

  const { data: items, error: itemsErr } = await supabase
    .from('order_items')
    .select('id, title, retailer, price, quantity, image_url, offer_url')
    .eq('order_id', req.params.id);
  if (itemsErr) {
    console.error('[payments route] fetch order items error:', itemsErr);
    return res.status(500).json({ error: 'Failed to load order items' });
  }

  res.json({ order: toApiOrderWithDetail(order, items || [], timeline || []) });
});

router.get('/orders/:reference', requireAuth, async (req, res) => {
  const { data: order, error } = await supabase
    .from('orders')
    .select('id, reference, amount, currency, customer_email, metadata, paid_at, status, created_at, user_id')
    .eq('reference', req.params.reference)
    .maybeSingle();

  if (error) {
    console.error('[payments route] fetch order error:', error);
    return res.status(500).json({ error: 'Failed to load order' });
  }
  if (!order || order.user_id !== req.user.id) {
    return res.status(404).json({ error: 'Not found' });
  }

  res.json({ order: toApiOrder(order) });
});

async function isNewReference(reference) {
  const { data } = await supabase.from('orders').select('id').eq('reference', reference).maybeSingle();
  return !data;
}

function toApiOrder(row) {
  return {
    id: row.id,
    reference: row.reference,
    amount: row.amount,
    currency: row.currency,
    customerEmail: row.customer_email,
    metadata: row.metadata,
    paidAt: row.paid_at,
    status: row.status,
  };
}

function toApiOrderWithDetail(row, items, timeline) {
  return {
    ...toApiOrder(row),
    subtotal: row.subtotal,
    shippingFee: row.shipping_fee,
    serviceFee: row.service_fee,
    total: row.amount,
    shippingAddress: row.shipping_address,
    carrier: row.carrier,
    trackingNumber: row.tracking_number,
    estimatedDelivery: row.estimated_delivery,
    windowClosesAt: row.window_closes_at,
    agentNote: row.agent_note,
    items: items.map((it) => ({
      id: it.id,
      title: it.title,
      retailer: it.retailer,
      price: it.price,
      quantity: it.quantity,
      imageUrl: it.image_url,
      offerUrl: it.offer_url,
    })),
    timeline: timeline.map((ev) => ({
      id: ev.id,
      status: ev.status,
      label: ev.label,
      note: ev.note,
      occurredAt: ev.occurred_at,
    })),
  };
}

module.exports = router;