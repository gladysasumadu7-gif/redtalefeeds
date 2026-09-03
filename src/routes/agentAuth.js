/**
 * Agent sign-in, email/password.
 *
 * There is no self-signup endpoint on purpose — agents are internal staff,
 * provisioned with `node scripts/create-agent.js` (see that file). This
 * keeps the agent dashboard from being reachable by anyone who can hit the
 * API, which a public registration endpoint would defeat.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const { supabase } = require('../lib/supabase');
const { signAgentToken, isAgentAuthConfigured } = require('../lib/agentJwt');
const { requireAgent } = require('../middleware/agentAuth');

const router = express.Router();

// POST /agent/auth/login  { email, password }
router.post('/login', async (req, res) => {
  if (!isAgentAuthConfigured()) {
    return res.status(501).json({ error: 'AGENT_JWT_SECRET is not set on the server' });
  }

  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const { data: agent, error } = await supabase
    .from('agents')
    .select('id, email, password_hash, full_name, role, active')
    .eq('email', String(email).toLowerCase().trim())
    .maybeSingle();

  // Same generic error whether the email doesn't exist or the password is
  // wrong — don't let this endpoint be used to enumerate agent emails.
  if (error || !agent || !agent.active) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const passwordMatches = await bcrypt.compare(password, agent.password_hash);
  if (!passwordMatches) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const token = signAgentToken(agent);
  res.json({
    token,
    agent: { id: agent.id, email: agent.email, fullName: agent.full_name, role: agent.role },
  });
});

// GET /agent/auth/me
router.get('/me', requireAgent, (req, res) => {
  res.json({ agent: req.agent });
});

module.exports = router;
