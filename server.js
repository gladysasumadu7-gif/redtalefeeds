require('dotenv').config();

const express = require('express');
const cors = require('cors');

const chatRoutes = require('./src/routes/chat');
const productRoutes = require('./src/routes/products');
const paymentRoutes = require('./src/routes/payments');

const app = express();

// Wide open CORS for the demo — tighten before real launch
app.use(cors());

// The webhook route needs the raw request body (Buffer) to verify Paystack's
// HMAC signature, so it must be parsed BEFORE the global express.json().
app.use('/api/v1/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    geminiConfigured: !!process.env.GEMINI_API_KEY,
    priceProvider: process.env.PRICE_PROVIDER || 'mock',
    paystackConfigured: !!process.env.PAYSTACK_SECRET_KEY,
  });
});

app.use('/api/v1/chat', chatRoutes);
app.use('/api/v1/products', productRoutes);
app.use('/api/v1/payments', paymentRoutes);

// Fallback 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`ShopBot-lite backend running on http://localhost:${PORT}`);
  console.log(`  Gemini: ${process.env.GEMINI_API_KEY ? 'configured' : 'NOT configured (using heuristic fallback)'}`);
  console.log(`  Price provider: ${process.env.PRICE_PROVIDER || 'mock'}`);
});
