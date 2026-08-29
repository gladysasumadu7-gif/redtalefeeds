/**
 * Supabase client for server-side use only.
 *
 * Uses the SERVICE ROLE key, which bypasses Row Level Security — this file
 * must never be imported into anything that ships to the client/app. All
 * authorization happens in src/middleware/auth.js and in the route handlers
 * (every query below is manually scoped to req.user.id).
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set — the backend cannot run without a database. ' +
    'Get these from Supabase dashboard > Project Settings > API.'
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

module.exports = { supabase };