/**
 * Google sign-in, backend-driven.
 *
 * Contract expected by the app (see the frontend's src/services/authService.ts):
 *
 *   GET /api/v1/auth/google/start?redirect_uri=<app deep link>
 *     -> 302 to Google's consent screen
 *     -> Google redirects back here, to GOOGLE_REDIRECT_URI (a fixed HTTPS
 *        URL registered in the Google Cloud Console against this backend's
 *        own OAuth client)
 *     -> this backend exchanges the code for Google's tokens using
 *        GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET (never exposed to the app),
 *        fetches the user's profile, upserts it into Supabase, mints this
 *        backend's own session token, and finally 302s to the app's
 *        original redirect_uri with `?token=<jwt>&user=<url-encoded JSON>`
 *
 * The Google client ID/secret and the intermediate code exchange never
 * leave this server.
 */

const express = require('express');
const crypto = require('crypto');
const { supabase } = require('../lib/supabase');
const { signSessionToken } = require('../lib/jwt');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
// The fixed HTTPS callback URL registered in Google Cloud Console for this
// backend, e.g. https://api.redtail.app/api/v1/auth/google/callback
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
// Comma-separated list of schemes the app is allowed to ask us to redirect
// back to, e.g. "redtale://". Prevents this endpoint being abused as an
// open redirect to an arbitrary URL.
const ALLOWED_APP_REDIRECT_PREFIXES = (process.env.ALLOWED_APP_REDIRECT_PREFIXES || 'redtale://')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// In-memory state store: state token -> { appRedirectUri, expiresAt }.
// State lives for a few minutes, only long enough for the user to complete
// the Google consent screen. A restart invalidating in-flight logins is an
// acceptable tradeoff for a single-instance deploy; move to Supabase/Redis
// if you scale to multiple instances.
const pendingStates = new Map();
const STATE_TTL_MS = 5 * 60 * 1000;

function isAllowedAppRedirect(uri) {
  return ALLOWED_APP_REDIRECT_PREFIXES.some((prefix) => uri.startsWith(prefix));
}

function assertGoogleConfigured() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    const err = new Error(
      'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI must all be set'
    );
    err.code = 'GOOGLE_NOT_CONFIGURED';
    throw err;
  }
}

// GET /auth/google/start?redirect_uri=redtale://auth-callback
router.get('/google/start', (req, res) => {
  try {
    assertGoogleConfigured();
  } catch (err) {
    return res.status(501).json({ error: err.message });
  }

  const { redirect_uri: appRedirectUri } = req.query;
  if (!appRedirectUri || typeof appRedirectUri !== 'string') {
    return res.status(400).json({ error: 'redirect_uri query param is required' });
  }
  if (!isAllowedAppRedirect(appRedirectUri)) {
    return res.status(400).json({ error: 'redirect_uri is not an allowed app scheme' });
  }

  const state = crypto.randomBytes(24).toString('hex');
  pendingStates.set(state, { appRedirectUri, expiresAt: Date.now() + STATE_TTL_MS });

  const googleUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  googleUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  googleUrl.searchParams.set('redirect_uri', GOOGLE_REDIRECT_URI);
  googleUrl.searchParams.set('response_type', 'code');
  googleUrl.searchParams.set('scope', 'openid email profile');
  googleUrl.searchParams.set('state', state);
  googleUrl.searchParams.set('prompt', 'select_account');

  res.redirect(googleUrl.toString());
});

// GET /auth/google/callback?code=...&state=...  (Google calls this)
router.get('/google/callback', async (req, res) => {
  const { code, state, error: googleError } = req.query;

  const pending = typeof state === 'string' ? pendingStates.get(state) : null;
  if (pending) pendingStates.delete(state); // one-time use

  if (!pending || pending.expiresAt < Date.now()) {
    return res.status(400).send('Sign-in session expired or invalid. Please try again from the app.');
  }

  const { appRedirectUri } = pending;

  function redirectToAppWithError(message) {
    const url = new URL(appRedirectUri);
    url.searchParams.set('error', message);
    return res.redirect(url.toString());
  }

  if (googleError) {
    return redirectToAppWithError(String(googleError));
  }
  if (!code || typeof code !== 'string') {
    return redirectToAppWithError('missing_code');
  }

  try {
    assertGoogleConfigured();

    // Exchange the authorization code for Google tokens.
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('[auth] Google token exchange failed:', tokenData);
      return redirectToAppWithError('token_exchange_failed');
    }

    // Fetch the user's Google profile.
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileRes.json();
    if (!profileRes.ok || !profile.sub || !profile.email) {
      console.error('[auth] Google profile fetch failed:', profile);
      return redirectToAppWithError('profile_fetch_failed');
    }

    // Upsert the user in Supabase, keyed by their stable Google subject id.
    const { data: user, error: upsertError } = await supabase
      .from('users')
      .upsert(
        {
          google_sub: profile.sub,
          email: profile.email,
          full_name: profile.name || profile.email,
          photo_url: profile.picture || null,
        },
        { onConflict: 'google_sub' }
      )
      .select('id, email, full_name, photo_url, kyc_status, created_at')
      .single();

    if (upsertError || !user) {
      console.error('[auth] Supabase upsert failed:', upsertError);
      return redirectToAppWithError('database_error');
    }

    const token = signSessionToken(user);
    const appUser = {
      id: user.id,
      fullName: user.full_name,
      email: user.email,
      photoUrl: user.photo_url || undefined,
      createdAt: user.created_at,
      authProvider: 'google',
      kycStatus: user.kyc_status,
    };

    const finalUrl = new URL(appRedirectUri);
    finalUrl.searchParams.set('token', token);
    finalUrl.searchParams.set('user', JSON.stringify(appUser));
    return res.redirect(finalUrl.toString());
  } catch (err) {
    console.error('[auth] Google callback error:', err);
    return redirectToAppWithError('internal_error');
  }
});

// GET /auth/me — lets the app validate/refresh its view of the current user.
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;