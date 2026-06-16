#!/usr/bin/env bash
# migrate-to-supabase.sh — mirror the LOCAL accounting DB into the Supabase cloud DB
# as tenant #1 (an exact, id-preserving copy). Re-runnable: it truncates the cloud
# acct_* tables and reloads from local. Reads ACCT_DB_URL (local) + ACCT_CLOUD_DB_URL
# (cloud, Supabase session pooler) from .env. Runs pg_dump|psql INSIDE the gbrain-pg
# Docker container (it has the pg client tools and can reach the pooler).
#
# Why this shape:
#  - Cloud's seeded reference tables (chart/projects/rules) would have DIFFERENT serial
#    ids than local, breaking journal_lines FKs. So we TRUNCATE cloud and copy local
#    verbatim (ids preserved) — cloud becomes an exact replica.
#  - pg_dump emits `set_config('search_path','')`, so the balance CONSTRAINT TRIGGER is
#    dropped before the load and recreated AFTER, schema-qualified (public.*).
#
# Usage: bash scripts/migrate-to-supabase.sh
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER=${PG_CONTAINER:-gbrain-pg}
LOCAL_URL=$(grep '^ACCT_DB_URL=' .env | cut -d= -f2-)
CLOUD=$(grep '^ACCT_CLOUD_DB_URL=' .env | cut -d= -f2-)
LPW=$(echo "$LOCAL_URL" | sed -E 's#^postgresql://[^:]+:([^@]+)@.*#\1#')
[ -n "$CLOUD" ] || { echo "ACCT_CLOUD_DB_URL not set in .env"; exit 1; }

TABLES=$(docker exec -e PGPASSWORD="$LPW" "$CONTAINER" psql -U postgres -d accounting -tAc \
  "SELECT string_agg(quote_ident(tablename), ', ') FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'acct_%' AND tablename<>'acct_migrations'")

TMP=$(mktemp)
docker exec -e PGPASSWORD="$LPW" "$CONTAINER" \
  pg_dump -U postgres -d accounting --data-only --no-owner -t 'acct_*' -T acct_migrations > "$TMP"

{
  echo "BEGIN;"
  echo "TRUNCATE $TABLES RESTART IDENTITY CASCADE;"
  echo "DROP TRIGGER IF EXISTS acct_journal_lines_balanced ON public.acct_journal_lines;"
  cat "$TMP"
  echo "COMMIT;"
  # search_path was blanked by pg_dump; qualify the trigger recreate explicitly.
  echo "DROP TRIGGER IF EXISTS acct_journal_lines_balanced ON public.acct_journal_lines;"
  echo "CREATE CONSTRAINT TRIGGER acct_journal_lines_balanced AFTER INSERT OR UPDATE OR DELETE ON public.acct_journal_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.acct_assert_entry_balanced();"
} | docker exec -i "$CONTAINER" psql "$CLOUD" -v ON_ERROR_STOP=1 -f -

rm -f "$TMP"
echo "migration complete — verify with: npm run verify-cloud (or compare row counts + ledger balance)"
