#!/bin/sh
set -e

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL is not set." >&2
  echo "Set it to your Supabase direct Postgres connection string and re-run." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCHEMA_FILE="$SCRIPT_DIR/../supabase/schema.sql"

if [ ! -f "$SCHEMA_FILE" ]; then
  echo "ERROR: schema file not found at $SCHEMA_FILE" >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql is not installed in this shell." >&2
  exit 1
fi

echo "Applying $SCHEMA_FILE to $(echo "$DATABASE_URL" | sed -E 's#(postgresql://[^:]+:)[^@]+(@.*)#\1****\2#')"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$SCHEMA_FILE"
echo "Migration complete."