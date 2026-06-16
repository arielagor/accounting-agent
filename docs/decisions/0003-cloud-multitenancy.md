# 0003 — Cloud multi-tenancy (Netlify + Supabase), tenant #1 = Ariel

**Status:** scaffolded; deployment queued for Ariel (one-way doors + spend).
**Date:** 2026-06-15.

## Context

The single-tenant engine (Phase 1) is complete, tested (187 tests), and running on the
local Postgres (`gbrain-pg:5433` db `accounting`). The product goal is a multi-tenant
SaaS at app.agor.me where Ariel's books are **encrypted cloud tenant #1** and the local
DB becomes a dev mirror. Hosting decision (locked): **Netlify + Supabase**.

## What's built now (verifiable, $0, no provisioning)

- **RLS policy migration** — `supabase/migrations/0001_rls.sql`. Enables Row-Level
  Security + a fail-closed `tenant_isolation` policy on all 37 tenant-scoped `acct_*`
  tables. Lives under `supabase/` so the local migrate runner (which reads `sql/`) never
  applies it — local single-tenant queries keep working unchanged.
- The whole engine already carries `tenant_id` on every transactional table and filters
  every query by it, so it is tenant-correct at the application layer today; RLS is
  defense-in-depth for the shared cloud DB.

## The remaining multi-tenant work (the honest gap)

Seven **reference tables have no `tenant_id`** and are currently global:
`acct_chart`, `acct_projects`, `acct_categorization_rules`, `acct_merchant_rules`,
`acct_allocation_rules`, `acct_allocation_targets`, `acct_tax_rates`
(plus `acct_review_queue`, `acct_llm_decisions`, `acct_usage_metrics`, `acct_balances`,
`acct_journal_lines` which scope via their parent/account).

For each tenant to customize their chart / projects / rules, these must be tenant-scoped:
1. Add `tenant_id text NOT NULL DEFAULT 'ariel'` + backfill.
2. Seed the standard chart/projects/rules per new tenant at onboarding (copy the
   defaults, then let them edit).
3. Update the engine reads that join these tables to filter by tenant:
   `ledger.accountIdByCode` / `projectIdBySlug`, `categorize` (rule tables),
   `allocate` (allocation rules), `tax/rates`, `reports`. Each is a small, localized
   change but touches tested code — do it behind the single-tenant tests staying green.
   `review_queue`/`llm_decisions` should also gain `tenant_id` for clean isolation.

This was deliberately NOT done now: it modifies the tested engine for a cloud that
can't be provisioned/verified in-session. Doing it half-way would risk the working
single-tenant product. It is the first task when cloud provisioning is authorized.

## Runtime model (when deployed)

- **Connection role:** the app connects to Supabase with a NON-superuser role (subject
  to RLS) and runs `SET app.tenant_id = '<tenant>'` per request/transaction. The
  migrate/admin role (BYPASSRLS) is exempt so migrations + the import run.
- **Per-tenant encrypted tokens:** provider access tokens stay AES-256-GCM encrypted via
  the existing `src/lib/token-store.ts`, re-encrypted with the cloud `INTEGRATION_ENC_KEY`
  during import.
- **Scheduled functions (Netlify):** `sync` (nightly read-only pull), `close` (daily
  incremental + monthly), `budget-watch` (alert eval + push), `advise` (recommendation
  gen). Each fans out per active tenant, serialized by a Postgres **advisory lock per
  (tenant, period)** — the cloud analogue of the local node-lock.
- **LLM in cloud:** serverless can't reach Claude Max OAuth, so the auditor/receipt/
  advisor LLM calls there fall back to `ANTHROPIC_API_KEY` (the sanctioned exception for
  processes OAuth can't reach). This is the ONE place cloud paid-API spend is structural
  — flagged; enable only on Ariel's go. The local mirror stays `claude -p` at $0.
- **Auth:** Supabase Auth, one user → one tenant, RLS-enforced. The local dashboard keeps
  its header-token + #fragment dev shortcut.

## One-way doors queued for Ariel (do NOT do unsupervised)

1. **Create the Supabase project** (or authorize reusing an existing one) — a cloud
   resource + potential cost.
2. **Enable the cloud `ANTHROPIC_API_KEY` spend** for the serverless LLM path.
3. **Deploy to Netlify** (app.agor.me) and set its env vars (Netlify CLI/dashboard only).
4. **Merge the agor-agents accounting SKU PR #13** (stays draft, Stripe TEST MODE).

## Migration-in plan (tenant #1)

Once Supabase exists: run `sql/` schema there → run `supabase/migrations/0001_rls.sql`
→ (after the reference-table tenant-scoping above) copy local `acct_*` rows for tenant
`ariel`, re-encrypting `acct_connections.access_token_enc` with the cloud key. The local
DB then continues as the dev mirror. A `bin/migrate-to-supabase.ts` is intentionally
deferred until a real Supabase target exists to test it against (no untested, unverifiable
data-migration code shipped).
