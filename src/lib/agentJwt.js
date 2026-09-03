/**
 * Signs and verifies agent session tokens.
 *
 * Deliberately a SEPARATE secret from src/lib/jwt.js (customer tokens), so
 * that a customer's session token can never be replayed against an
 * agent-only route (or vice versa) even if someone forgets a middleware
 * somewhere — the signature just won't verify against the wrong secret.
 *
 * Short-lived (12h) since this is an internal tool agents log into from a
 * browser each shift, not a mobile app session meant to persist for weeks.
 */

const jwt = require('jsonwebtoken');

const AGENT_JWT_SECRET = process.env.AGENT_JWT_SECRET;
const TOKEN_TTL = '12h';

function assertConfigured() {
  if (!AGENT_JWT_SECRET) {
    const err = new Error(
      'AGENT_JWT_SECRET is not set — generate one with `openssl rand -hex 32`. ' +
      'The agent dashboard is disabled until this is configured.'
    );
    err.code = 'AGENT_AUTH_NOT_CONFIGURED';
    throw err;
  }
}

function signAgentToken(agent) {
  assertConfigured();
  return jwt.sign(
    { sub: agent.id, email: agent.email, role: agent.role, type: 'agent' },
    AGENT_JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function verifyAgentToken(token) {
  assertConfigured();
  const payload = jwt.verify(token, AGENT_JWT_SECRET);
  if (payload.type !== 'agent') {
    throw new Error('Not an agent token');
  }
  return payload;
}

module.exports = { signAgentToken, verifyAgentToken, isAgentAuthConfigured: () => !!AGENT_JWT_SECRET };
