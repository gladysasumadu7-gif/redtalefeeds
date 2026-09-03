/**
 * Agent-facing order routes — everything here sees ACROSS all customers,
 * unlike src/routes/payments.js which is always scoped to req.user.id.
 * Mounted behind requireAgent in server.js.
 */

const express = require('express');
const { supabase } = require('../lib/supabase');

const router = express.Router();

// Statuses the dashboard/state machine understands. Enforced at the app
// layer (not a DB check constraint) since existing rows already predate
// this list and a bad migration is worse than a loose column.
const ORDER_STATUSES = [
  'AGENT_REVIEWING',
  'SOURCING',
  'ORDERED',
  'SHIPPED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLED',
  'REFUNDED',
];

// GET /agent/orders?status=&search=&page=&limit=
router.get('/', async (req, res) => {
  const { status, search } = req.query;
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  let query = supabase
    .from('orders')
    .select(
      'id, reference, amount, currency, customer_email, status, paid_at, created_at, assigned_agent_id, user_id',
      { count: 'exact' }
    )
    .order('created_at', { ascending: false })
    .range(from, to);

  if (status) {
    if (!ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Unknown status. Expected one of: ${ORDER_STATUSES.join(', ')}` });
    }
    query = query.eq('status', status);
  }
  if (search) {
    // Matches on reference or customer email — the two things an agent
    // is handed when a customer messages them about an order.
    query = query.or(`reference.ilike.%${search}%,customer_email.ilike.%${search}%`);
  }

  const { data: orders, error, count } = await query;
  if (error) {
    console.error('[agentOrders] list error:', error);
    return res.status(500).json({ error: 'Failed to load orders' });
  }

  res.json({
    orders: orders.map(toApiOrderSummary),
    page,
    limit,
    total: count,
  });
});

// GET /agent/orders/:id — full detail: order + customer + items + timeline
router.get('/:id', async (req, res) => {
  const order = await fetchFullOrder(req.params.id);
  if (order === null) return res.status(404).json({ error: 'Order not found' });
  if (order === undefined) return res.status(500).json({ error: 'Failed to load order' });
  res.json({ order });
});

// PATCH /agent/orders/:id
// Body: any subset of { status, carrier, trackingNumber, estimatedDelivery,
//   windowClosesAt, agentNote, assignedAgentId, subtotal, shippingFee,
//   serviceFee }. Assign to the calling agent with assignedAgentId: "me".
router.patch('/:id', async (req, res) => {
  const body = req.body || {};
  const update = {};

  if (body.status !== undefined) {
    if (!ORDER_STATUSES.includes(body.status)) {
      return res.status(400).json({ error: `Unknown status. Expected one of: ${ORDER_STATUSES.join(', ')}` });
    }
    update.status = body.status;
  }
  if (body.carrier !== undefined) update.carrier = body.carrier;
  if (body.trackingNumber !== undefined) update.tracking_number = body.trackingNumber;
  if (body.estimatedDelivery !== undefined) update.estimated_delivery = body.estimatedDelivery;
  if (body.windowClosesAt !== undefined) update.window_closes_at = body.windowClosesAt;
  if (body.agentNote !== undefined) update.agent_note = body.agentNote;
  if (body.subtotal !== undefined) update.subtotal = body.subtotal;
  if (body.shippingFee !== undefined) update.shipping_fee = body.shippingFee;
  if (body.serviceFee !== undefined) update.service_fee = body.serviceFee;
  if (body.shippingAddress !== undefined) update.shipping_address = body.shippingAddress;
  if (body.assignedAgentId !== undefined) {
    update.assigned_agent_id = body.assignedAgentId === 'me' ? req.agent.id : body.assignedAgentId;
  }

  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: 'No recognized fields to update' });
  }

  const { data: existing, error: fetchErr } = await supabase
    .from('orders')
    .select('id, status')
    .eq('id', req.params.id)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: 'Failed to load order' });
  if (!existing) return res.status(404).json({ error: 'Order not found' });

  const { error: updateErr } = await supabase.from('orders').update(update).eq('id', req.params.id);
  if (updateErr) {
    console.error('[agentOrders] update error:', updateErr);
    return res.status(500).json({ error: 'Failed to update order' });
  }

  // Auto-log a timeline entry whenever status actually changes, so the
  // customer-facing timeline stays truthful without agents remembering to
  // post one by hand every time.
  if (update.status && update.status !== existing.status) {
    await supabase.from('order_timeline_events').insert({
      order_id: req.params.id,
      status: update.status,
      label: humanizeStatus(update.status),
      created_by_agent_id: req.agent.id,
    });
  }

  const order = await fetchFullOrder(req.params.id);
  if (order === undefined) return res.status(500).json({ error: 'Order updated but failed to reload' });
  res.json({ order });
});

// POST /agent/orders/:id/timeline  { label, note?, status? }
router.post('/:id/timeline', async (req, res) => {
  const { label, note, status } = req.body || {};
  if (!label) return res.status(400).json({ error: 'label is required' });
  if (status && !ORDER_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Unknown status. Expected one of: ${ORDER_STATUSES.join(', ')}` });
  }

  const { data: event, error } = await supabase
    .from('order_timeline_events')
    .insert({ order_id: req.params.id, label, note: note || null, status: status || null, created_by_agent_id: req.agent.id })
    .select('id, status, label, note, occurred_at')
    .single();

  if (error) {
    console.error('[agentOrders] timeline insert error:', error);
    return res.status(500).json({ error: 'Failed to add timeline event' });
  }
  res.status(201).json({ event });
});

// POST /agent/orders/:id/items  { title, retailer?, price, quantity?, imageUrl?, offerUrl? }
// Agents reconcile what was actually sourced here, since checkout only
// ever persists a single offerId (see payments.js) — not a real items list.
router.post('/:id/items', async (req, res) => {
  const { title, retailer, price, quantity, imageUrl, offerUrl } = req.body || {};
  if (!title || price === undefined) {
    return res.status(400).json({ error: 'title and price are required' });
  }

  const { data: item, error } = await supabase
    .from('order_items')
    .insert({
      order_id: req.params.id,
      title,
      retailer: retailer || null,
      price,
      quantity: quantity || 1,
      image_url: imageUrl || null,
      offer_url: offerUrl || null,
    })
    .select('id, title, retailer, price, quantity, image_url, offer_url')
    .single();

  if (error) {
    console.error('[agentOrders] item insert error:', error);
    return res.status(500).json({ error: 'Failed to add item' });
  }
  res.status(201).json({ item });
});

// DELETE /agent/orders/:id/items/:itemId
router.delete('/:id/items/:itemId', async (req, res) => {
  const { error } = await supabase
    .from('order_items')
    .delete()
    .eq('id', req.params.itemId)
    .eq('order_id', req.params.id);

  if (error) {
    console.error('[agentOrders] item delete error:', error);
    return res.status(500).json({ error: 'Failed to delete item' });
  }
  res.sendStatus(204);
});

// --- helpers ---------------------------------------------------------------

async function fetchFullOrder(id) {
  const { data: order, error } = await supabase
    .from('orders')
    .select(
      `id, reference, amount, currency, customer_email, status, metadata, paid_at, created_at,
       subtotal, shipping_fee, service_fee, shipping_address, carrier, tracking_number,
       estimated_delivery, window_closes_at, agent_note, assigned_agent_id, user_id,
       users:user_id ( id, full_name, email, photo_url, kyc_status, created_at )`
    )
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error('[agentOrders] fetch error:', error);
    return undefined;
  }
  if (!order) return null;

  const [{ data: items, error: itemsErr }, { data: timeline, error: timelineErr }, agentRow] = await Promise.all([
    supabase
      .from('order_items')
      .select('id, title, retailer, price, quantity, image_url, offer_url')
      .eq('order_id', id),
    supabase
      .from('order_timeline_events')
      .select('id, status, label, note, occurred_at, created_by_agent_id')
      .eq('order_id', id)
      .order('occurred_at', { ascending: true }),
    order.assigned_agent_id
      ? supabase.from('agents').select('id, full_name, email').eq('id', order.assigned_agent_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  if (itemsErr || timelineErr) {
    console.error('[agentOrders] sub-resource fetch error:', itemsErr || timelineErr);
    return undefined;
  }

  return toApiOrderDetail(order, items || [], timeline || [], agentRow.data);
}

function toApiOrderSummary(row) {
  return {
    id: row.id,
    reference: row.reference,
    amount: row.amount,
    currency: row.currency,
    customerEmail: row.customer_email,
    status: row.status,
    paidAt: row.paid_at,
    createdAt: row.created_at,
    assignedAgentId: row.assigned_agent_id,
  };
}

function toApiOrderDetail(row, items, timeline, agent) {
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    subtotal: row.subtotal,
    shippingFee: row.shipping_fee,
    serviceFee: row.service_fee,
    total: row.amount,
    customer: row.users
      ? {
          id: row.users.id,
          fullName: row.users.full_name,
          email: row.users.email,
          photoUrl: row.users.photo_url,
          kycStatus: row.users.kyc_status,
          customerSince: row.users.created_at,
        }
      : { email: row.customer_email },
    shippingAddress: row.shipping_address,
    carrier: row.carrier,
    trackingNumber: row.tracking_number,
    estimatedDelivery: row.estimated_delivery,
    windowClosesAt: row.window_closes_at,
    agentNote: row.agent_note,
    assignedAgent: agent ? { id: agent.id, fullName: agent.full_name, email: agent.email } : null,
    metadata: row.metadata,
    paidAt: row.paid_at,
    createdAt: row.created_at,
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
      byAgentId: ev.created_by_agent_id,
    })),
  };
}

function humanizeStatus(status) {
  return status
    .toLowerCase()
    .split('_')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

module.exports = router;
module.exports.ORDER_STATUSES = ORDER_STATUSES;
