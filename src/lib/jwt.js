/**
 * Signs and verifies the backend's own session tokens.
 *
 * This is deliberately NOT a Google or Supabase Auth token — it's a token
 * this backend mints itself after it has already verified the user's
 * identity with Google (see src/routes/auth.js). The app only ever holds
 * this token, and sends it as `Authorization: Bearer <token>` on every
 * authenticated request. src/middleware/auth.js verifies it on the way in.
 */

const jwt = require('jsonwebtoken');

const APP_JWT_SECRET = process.env.APP_JWT_SECRET;
const TOKEN_TTL = '30d';

if (!APP_JWT_SECRET) {
  throw new Error(
    'APP_JWT_SECRET must be set — generate one with `openssl rand -hex 32` and keep it secret.'
  );
}

function signSessionToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email },
    APP_JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function verifySessionToken(token) {
  // Throws on invalid/expired tokens — callers should catch and 401.
  return jwt.verify(token, APP_JWT_SECRET);
}

module.exports = { signSessionToken, verifySessionToken };