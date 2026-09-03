const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// Applies supabase/schema.sql, then every *.sql file in supabase/migrations/
// in filename order (e.g. 002_agent_dashboard.sql). Every statement in both
// is written to be idempotent (`create table if not exists`, `add column
// if not exists`, etc.), so re-running this is always safe.

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL is not set.');
    process.exit(1);
  }

  const schemaPath = path.join(__dirname, '..', 'supabase', 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    console.error(`ERROR: schema file not found at ${schemaPath}`);
    process.exit(1);
  }

  const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');
  const migrationFiles = fs.existsSync(migrationsDir)
    ? fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .map((f) => path.join(migrationsDir, f))
    : [];

  const filesToApply = [schemaPath, ...migrationFiles];
  const masked = databaseUrl.replace(/(postgresql:\/\/[^:]+:)[^@]+(@.*)/, '$1****$2');

  const client = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    for (const filePath of filesToApply) {
      console.log(`Applying ${filePath} to ${masked}`);
      const sql = fs.readFileSync(filePath, 'utf8');
      await client.query(sql);
    }
    console.log('Migration complete.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});