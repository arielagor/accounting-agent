-- 0001_rls.sql — Row-Level Security for the CLOUD (Supabase) deployment ONLY.
--
-- This file lives under supabase/ deliberately: the local migrate runner reads sql/,
-- never supabase/, so RLS is NOT applied to the local single-tenant Postgres (where
-- enabling it would break queries that don't set app.tenant_id). Apply it on Supabase
-- AFTER running the sql/ schema there (see docs/decisions/0003-cloud-multitenancy.md).
--
-- Model: the app connects with a NON-superuser role (subject to RLS) and runs
--   SET app.tenant_id = '<tenant>'
-- at the start of every request/transaction. The policy is FAIL-CLOSED:
-- current_setting('app.tenant_id', true) returns NULL when unset, so an unscoped
-- connection sees ZERO rows. The migration/admin role (BYPASSRLS, e.g. Supabase's
-- service role) is intentionally exempt so migrations + the migrate-in script work.

DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.columns
    WHERE column_name = 'tenant_id' AND table_name LIKE 'acct_%'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))',
      t
    );
  END LOOP;
END $$;

-- NOTE — reference tables (acct_chart, acct_projects, acct_categorization_rules,
-- acct_merchant_rules, acct_allocation_rules, acct_allocation_targets, acct_tax_rates)
-- have NO tenant_id and are NOT covered here. For true per-tenant customization they
-- must first be tenant-scoped (add tenant_id + backfill + filter the engine's reads).
-- Until then they are shared reference data across cloud tenants. This is the defined
-- remaining multi-tenant work — see docs/decisions/0003-cloud-multitenancy.md.
