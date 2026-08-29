const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

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

  const sql = fs.readFileSync(schemaPath, 'utf8');
  const masked = databaseUrl.replace(/(postgresql:\/\/[^:]+:)[^@]+(@.*)/, '$1****$2');
  console.log(`Applying ${schemaPath} to ${masked}`);

  const client = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    await client.query(sql);
    console.log('Migration complete.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});