/**
 * requireAuth — protects a route behind a valid session token.
 *
 * Expects `Authorization: Bearer <token>` on the request, issued by
 * POST /api/v1/auth/google/start (see src/routes/auth.js). On success,
 * attaches `req.user = { id, email }` for the route handler to use — every
 * downstream query MUST scope by req.user.id, this middleware only proves
 * *who* is asking, not what they're allowed to see.
 */

const { verifySessionToken } = require('../lib/jwt');
const { supabase } = require('../lib/supabase');

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  let payload;
  try {
    payload = verifySessionToken(token);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session token' });
  }

  // Re-check the user still exists (covers deleted/disabled accounts without
  // needing a token revocation list for the common case).
  const { data: user, error } = await supabase
    .from('users')
    .select('id, email, kyc_status')
    .eq('id', payload.sub)
    .single();

  if (error || !user) {
    return res.status(401).json({ error: 'Account no longer exists' });
  }

  req.user = { id: user.id, email: user.email, kycStatus: user.kyc_status };
  next();
}

module.exports = { requireAuth };