#!/usr/bin/env node
/**
 * Provision (or update) an agent account.
 *
 * There is no public signup endpoint for agents — this script, run by
 * whoever manages the backend, is the only way to create one. Uses the
 * same Supabase service-role client as the rest of the backend.
 *
 * Usage:
 *   node scripts/create-agent.js --email agent@company.com --name "Ada Agent" --password "correct-horse-battery-staple" [--role admin]
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { supabase } = require('../src/lib/supabase');

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      args[key] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

async function main() {
  const { email, name, password, role } = parseArgs();

  if (!email || !name || !password) {
    console.error('Usage: node scripts/create-agent.js --email <email> --name "<full name>" --password <password> [--role agent|admin]');
    process.exit(1);
  }
  if (password.length < 12) {
    console.error('Password must be at least 12 characters.');
    process.exit(1);
  }
  if (role && !['agent', 'admin'].includes(role)) {
    console.error('--role must be "agent" or "admin"');
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const { data, error } = await supabase
    .from('agents')
    .upsert(
      {
        email: email.toLowerCase().trim(),
        full_name: name,
        password_hash: passwordHash,
        role: role || 'agent',
        active: true,
      },
      { onConflict: 'email' }
    )
    .select('id, email, full_name, role, created_at')
    .single();

  if (error) {
    console.error('Failed to create agent:', error.message);
    process.exit(1);
  }

  console.log('Agent ready:');
  console.log(data);
}

main();
