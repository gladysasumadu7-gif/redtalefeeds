/**
 * Agent-facing customer routes — lets the dashboard pull up "everything
 * about this customer" (profile + their orders), the other half of what
 * an agent needs alongside a single order's detail.
 */

const express = require('express');
const { supabase } = require('../lib/supabase');

const router = express.Router();

// GET /agent/customers?search=  — search by email or name
router.get('/', async (req, res) => {
  const { search } = req.query;
  let query = supabase
    .from('users')
    .select('id, email, full_name, photo_url, kyc_status, created_at')
    .order('created_at', { ascending: false })
    .limit(50);

  if (search) {
    query = query.or(`email.ilike.%${search}%,full_name.ilike.%${search}%`);
  }

  const { data: users, error } = await query;
  if (error) {
    console.error('[agentCustomers] list error:', error);
    return res.status(500).json({ error: 'Failed to load customers' });
  }
  res.json({ customers: users.map(toApiCustomer) });
});

// GET /agent/customers/:id — profile + order history
router.get('/:id', async (req, res) => {
  const { data: user, error } = await supabase
    .from('users')
    .select('id, email, full_name, photo_url, kyc_status, created_at')
    .eq('id', req.params.id)
    .maybeSingle();

  if (error) {
    console.error('[agentCustomers] fetch error:', error);
    return res.status(500).json({ error: 'Failed to load customer' });
  }
  if (!user) return res.status(404).json({ error: 'Customer not found' });

  const { data: orders, error: ordersErr } = await supabase
    .from('orders')
    .select('id, reference, amount, currency, status, paid_at, created_at')
    .eq('user_id', req.params.id)
    .order('created_at', { ascending: false });

  if (ordersErr) {
    console.error('[agentCustomers] orders fetch error:', ordersErr);
    return res.status(500).json({ error: 'Failed to load customer orders' });
  }

  res.json({
    customer: toApiCustomer(user),
    orders: orders.map((o) => ({
      id: o.id,
      reference: o.reference,
      amount: o.amount,
      currency: o.currency,
      status: o.status,
      paidAt: o.paid_at,
      createdAt: o.created_at,
    })),
  });
});

function toApiCustomer(row) {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    photoUrl: row.photo_url,
    kycStatus: row.kyc_status,
    customerSince: row.created_at,
  };
}

module.exports = router;
