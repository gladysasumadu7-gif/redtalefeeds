/**
 * requireAgent — protects agent-dashboard routes behind a valid agent
 * session token. Mirrors src/middleware/auth.js exactly, but checks the
 * `agents` table with an agent-signed token, so agent and customer auth
 * never cross over.
 *
 * Attaches req.agent = { id, email, fullName, role }.
 */

const { verifyAgentToken } = require('../lib/agentJwt');
const { supabase } = require('../lib/supabase');

async function requireAgent(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  let payload;
  try {
    payload = verifyAgentToken(token);
  } catch (err) {
    if (err.code === 'AGENT_AUTH_NOT_CONFIGURED') {
      return res.status(501).json({ error: err.message });
    }
    return res.status(401).json({ error: 'Invalid or expired agent session token' });
  }

  const { data: agent, error } = await supabase
    .from('agents')
    .select('id, email, full_name, role, active')
    .eq('id', payload.sub)
    .single();

  if (error || !agent || !agent.active) {
    return res.status(401).json({ error: 'Agent account no longer exists or is deactivated' });
  }

  req.agent = { id: agent.id, email: agent.email, fullName: agent.full_name, role: agent.role };
  next();
}

module.exports = { requireAgent };
