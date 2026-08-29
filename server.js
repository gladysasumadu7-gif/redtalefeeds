require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./src/routes/auth');
const chatRoutes = require('./src/routes/chat');
const modelRoutes = require('./src/routes/models');
const productRoutes = require('./src/routes/products');
const paymentRoutes = require('./src/routes/payments');
const { requireAuth } = require('./src/middleware/auth');

// Fail fast on missing required config rather than booting into a broken
// state. lib/supabase.js and lib/jwt.js already throw on require() if their
// own vars are missing; this covers everything else.
const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'APP_JWT_SECRET'];
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}
if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REDIRECT_URI) {
  console.warn(
    '[startup] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI are not fully set — ' +
    'Google sign-in will return 501 until these are configured.'
  );
}

const app = express();

// Required for correct client IPs (and therefore correct rate limiting)
// behind a reverse proxy/load balancer (Render, Fly, Railway, etc).
app.set('trust proxy', 1);

app.use(helmet());

// Restrict CORS to known origins in prod. Mobile apps (Expo/React Native)
// don't send a browser Origin header at all, so this only affects browser
// clients (e.g. `expo start --web`) — set ALLOWED_ORIGINS to your web app's
// origin(s), comma-separated. No origin header (native apps, curl, server-
// to-server) is always allowed since CORS is a browser-only concept.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
  })
);

// The webhook route needs the raw request body (Buffer) to verify Paystack's
// HMAC signature, so it must be parsed BEFORE the global express.json().
app.use('/api/v1/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '1mb' }));

// Generous global cap against abuse/DoS; auth + chat get tighter limits
// below since they're the most expensive/sensitive paths.
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const chatLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    geminiConfigured: !!process.env.GEMINI_API_KEY,
    priceProvider: process.env.PRICE_PROVIDER || 'serpapi',
    paystackConfigured: !!process.env.PAYSTACK_SECRET_KEY,
    googleAuthConfigured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI),
  });
});

// Public — this IS the auth flow, and /me does its own requireAuth check.
app.use('/api/v1/auth', authLimiter, authRoutes);

// Everything below this line requires a valid session token. Each is
// mounted at its own specific path (never the bare '/api/v1' prefix) so
// that requireAuth here can never shadow the public webhook route below.
app.use('/api/v1/chat', chatLimiter, requireAuth, chatRoutes);
app.use('/api/v1/models', requireAuth, modelRoutes);
app.use('/api/v1/products', requireAuth, productRoutes);
// payments.js applies requireAuth per-route itself, since /webhook must
// stay public for Paystack to call it.
app.use('/api/v1/payments', paymentRoutes);

// Fallback 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler — never leak stack traces to the client.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`ShopBot backend running on http://localhost:${PORT}`);
  console.log(`  Gemini: ${process.env.GEMINI_API_KEY ? 'configured' : 'NOT configured (using heuristic fallback)'}`);
  console.log(`  Supabase: connected`);
  console.log(`  Google auth: ${process.env.GOOGLE_CLIENT_ID ? 'configured' : 'NOT configured'}`);
});