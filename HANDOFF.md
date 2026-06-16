# HANDOFF — Mint-class budgeting/accounting/advisory app

**Goal (approved plan):** evolve the working single-tenant accounting engine into a commercial-grade
retail budgeting + accounting + financial-advisory app (Mint-class, agent-augmented) for personal AND
small business, deployable multi-tenant at app.agor.me with Ariel's books as cloud tenant #1.
Plan file: `~/.claude/plans/system-reminder-message-sent-at-sat-enchanted-dragonfly.md`.
(Phase 1 — the single-tenant month-end-close engine, built 2026-06-13 — is COMPLETE & TESTED and is
the foundation this builds on; its details live in git history + the GBrain project page.)

## Locked decisions
1. Both tenancies in parallel (Ariel's instance + multi-tenant SKU)
2. Web app + mobile PWA (Next.js/React, installable, Web Push)
3. SimpleFIN now, Plaid later
4. Auditor auto-acts, escalates to /council on doubt + research agents that file access-requests
5. Hybrid (envelope/zero-based) + per-project budgets
6. Universal receipt ingest + auto-split (PDF/CSV/email/photo + forwarding inbox)
7. Full SMB (AR/AP, payroll, 1099, sales tax)
8. Netlify + Supabase; migrate Ariel's books in as encrypted tenant #1; local Postgres = dev mirror

## Milestones — ALL BUILT, TESTED, COMMITTED (2026-06-15)
- **M7** Web app — **DONE** Multi-tab Mint-class PWA + Web Push (`bin/dashboard.ts`, `src/lib/dashboard-page.ts`, `app-data.ts`, `push.ts`). Verified live in-browser.
- **M8** Universal receipt ingest + auto-split — **DONE** (`src/core/receipts.ts`, `audit.ts`, `buildSplitChargeEntry`, `ClaudeDocumentExtractor`)
- **M9** Autonomous auditor + council + access-requests — **DONE** (`src/core/auditor.ts`, `ClaudeCouncil`)
- **M10** Budgets + realtime guidance + advisory + push — **DONE** (`budgets.ts`, `guidance.ts`, `recommendations.ts`, `push.ts`)
- **M11** Full SMB (AR/AP, payroll, 1099, sales tax) — **DONE** (`src/core/smb.ts`, posting builders, `018_smb_accounts` seed)
- **M12** Cloud multi-tenant — **SCAFFOLDED; deploy queued for Ariel** (`supabase/migrations/0001_rls.sql`, `docs/decisions/0003-cloud-multitenancy.md`, runtimes `bin/advise.ts`/`bin/audit.ts`)

## State (2026-06-15) — build complete
- Repo `arielagor/accounting-agent`, branch `master`. Baseline 149 tests → **187 tests green, tsc --noEmit clean**.
- Local DB: gbrain-pg:5433 db `accounting`, **34 acct_ tables**, 323 raw txns. Migrations 007–012 + seed 018 applied (idempotent).
- New deps: `web-push` (free VAPID push). New scripts: `vapid-keys`, `audit`, `advise`.
- **Verified live:** web app renders + tab-switches in-browser; every API endpoint returns real data; budget write
  round-trips; `npm run advise` generated 13 grounded recommendations on the real books.

## What Ariel can do right now
- `npm run dashboard` → open the web app (token in URL #fragment when bound to 0.0.0.0). 7 tabs: Overview,
  Transactions (inline edit/recategorize), Budgets, Advisor, Receipts, Business, Review (auditor + grant-access).
- `npm run vapid-keys` → paste the 3 lines into `.env`, restart → tap "Alerts" in the app to get phone push.
- `npm run advise` (schedulable) → budget alerts + fresh recommendations. `npm run audit` (CLOSE_MODE≥draft) → auditor pass.
- Install the PWA on the phone (Add to Home Screen) for the realtime budget assistant.

## Conventions (match these)
- TS ESM NodeNext: import sibling `.ts` as `.js`. Money = integer cents (BIGINT). `tenant_id` on every table.
- All postings go through `ledger.postEntry()` (balanced trigger + idempotency). Direction lives ONLY in `posting.ts`.
- `postEntry` opens its own tx → DON'T nest it inside `sql.begin` (porsager `tx` has no `.begin`); sequence
  idempotent steps instead (see `resolve.ts` / `receipts.ts splitCharge`).
- LLM via `spawnClaudeRunner` (ANTHROPIC_API_KEY stripped = $0 Max plan; `--model claude-opus-4-8` fallback;
  `extractJson` first-balanced-object). Cloud serverless is the ONLY sanctioned `ANTHROPIC_API_KEY` path (flagged).
- DB-backed tests: dedicated tenant, skip if no DB, clean before+after. Run `npx tsc --noEmit` before every commit.

## One-way doors queued for Ariel (do NOT do unsupervised)
- Linking real bank/card accounts; flipping CLOSE_MODE to live on real books; creating the Supabase project;
  enabling the cloud ANTHROPIC_API_KEY spend; any deploy to app.agor.me; merging the agor-agents SKU PR;
  granting access-requests; approving aggressive deductions; entity-type changes; any real money movement.

## Next step (when cloud is authorized)
The single-tenant product is complete. The remaining work is the cloud path, all gated on the one-way doors
above. First task when provisioning is authorized: **tenant-scope the 7 reference tables**
(chart/projects/categorization_rules/merchant_rules/allocation_rules/allocation_targets/tax_rates) — add
`tenant_id`, backfill 'ariel', seed-per-tenant at onboarding, and filter the engine reads that join them
(`ledger.accountIdByCode`/`projectIdBySlug`, `categorize`, `allocate`, `tax/rates`, `reports`). Keep the
187 single-tenant tests green throughout. Then create Supabase, apply `sql/` + `supabase/migrations/0001_rls.sql`,
migrate Ariel's rows in as encrypted tenant #1, deploy the Netlify scheduled functions, and ship. Full detail in
`docs/decisions/0003-cloud-multitenancy.md`.
